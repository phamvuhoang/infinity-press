// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import {
  AssetNotAwaitingUploadError,
  createEpubUpload,
  EditionNotFoundError,
  EmptyEpubFileError,
  EpubTooLargeError,
  finalizeEpubUpload,
  InvalidChecksumError,
  InvalidEpubExtensionError,
  InvalidEpubMimeTypeError,
  MAX_EPUB_SIZE_BYTES,
} from "@/lib/epub/upload";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { headers } from "next/headers";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));

const editionId = "40000000-0000-0000-0000-000000000001";
const bookId = "30000000-0000-0000-0000-000000000001";
const assetId = "50000000-0000-0000-0000-000000000001";
// Bucket-relative (Ruling AU) - storage-js prepends the bucket id itself, so a key stored here
// must not repeat "ebook-source/".
const storageKey = `${editionId}/${assetId}/source.epub`;

const validFile = {
  bookId,
  fileName: "the-golden-book.epub",
  mimeType: "application/epub+zip",
  sizeBytes: 1024,
};

// Mirrors the session client's call shape createEpubUpload needs: a lookup of the edition by
// book_id (`.from("editions").select(...).eq(...).order(...).limit(...).maybeSingle()`) and the
// reservation RPC (`.rpc("admin_reserve_ebook_asset", ...)`), each independently stubbable.
function sessionClient(options: {
  edition?: { data: unknown; error: { message: string } | null };
  reserve?: { data: unknown; error: { code?: string; message: string } | null };
  finalize?: { data: unknown; error: { code?: string; message: string } | null };
}) {
  const editionResult = options.edition ?? { data: { id: editionId }, error: null };
  const maybeSingle = vi.fn().mockResolvedValue(editionResult);
  const limit = vi.fn(() => ({ maybeSingle }));
  const order = vi.fn(() => ({ limit }));
  const eq = vi.fn(() => ({ order }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));

  const rpc = vi.fn((name: string) => {
    if (name === "admin_reserve_ebook_asset") {
      return Promise.resolve(
        options.reserve ?? { data: [{ asset_id: assetId, storage_key: storageKey, version: 1 }], error: null },
      );
    }
    if (name === "admin_finalize_ebook_asset") {
      return Promise.resolve(options.finalize ?? { data: "job-id", error: null });
    }
    throw new Error(`unexpected rpc: ${name}`);
  });

  return { from, rpc } as unknown as Awaited<ReturnType<typeof createClient>>;
}

// Mirrors the service-role client's call shape createEpubUpload needs:
// `.storage.from(bucket).createSignedUploadUrl(path)`.
function adminClient(result: {
  data: { signedUrl: string; token: string; path: string } | null;
  error: { message: string } | null;
}) {
  const createSignedUploadUrl = vi.fn().mockResolvedValue(result);
  return { storage: { from: vi.fn(() => ({ createSignedUploadUrl })) } } as unknown as ReturnType<
    typeof createAdminClient
  >;
}

const signedUploadResult = {
  data: { signedUrl: "https://storage.test/sign", token: "sign-token", path: storageKey },
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue(
    {} as unknown as Awaited<ReturnType<typeof requireAdmin>>,
  );
});

describe("createEpubUpload validation", () => {
  it("rejects a non-.epub extension", async () => {
    await expect(
      createEpubUpload({ ...validFile, fileName: "the-golden-book.pdf" }),
    ).rejects.toBeInstanceOf(InvalidEpubExtensionError);
  });

  it("rejects a MIME type other than application/epub+zip", async () => {
    await expect(
      createEpubUpload({ ...validFile, mimeType: "application/pdf" }),
    ).rejects.toBeInstanceOf(InvalidEpubMimeTypeError);
  });

  it("rejects a zero-byte file", async () => {
    await expect(createEpubUpload({ ...validFile, sizeBytes: 0 })).rejects.toBeInstanceOf(
      EmptyEpubFileError,
    );
  });

  it("rejects a file larger than 100 MiB", async () => {
    expect(MAX_EPUB_SIZE_BYTES).toBe(100 * 1024 * 1024);
    await expect(
      createEpubUpload({ ...validFile, sizeBytes: MAX_EPUB_SIZE_BYTES + 1 }),
    ).rejects.toBeInstanceOf(EpubTooLargeError);
  });

  it("accepts a file at exactly the 100 MiB limit", async () => {
    vi.mocked(createClient).mockResolvedValue(sessionClient({}));
    vi.mocked(createAdminClient).mockReturnValue(adminClient(signedUploadResult));

    await expect(
      createEpubUpload({ ...validFile, sizeBytes: MAX_EPUB_SIZE_BYTES }),
    ).resolves.toMatchObject({ assetId });
  });

  it("never looks up an edition or constructs a client for input that fails validation", async () => {
    await createEpubUpload({ ...validFile, fileName: "not-an-epub.zip" }).catch(() => {});

    expect(createClient).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe("createEpubUpload authorization", () => {
  it("never constructs a client when the admin gate denies", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(createEpubUpload(validFile)).rejects.toThrow("NEXT_FORBIDDEN");
    expect(createClient).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  // Ruling AD: the signed upload token is minted by the service-role client, and only after
  // requireAdmin() has returned - a legitimate service-role use because browser roles have no
  // write access to the private bucket. This pins the ordering: an unauthorized caller must never
  // reach the point where a privileged client for a private bucket gets constructed.
  it("resolves the edition through the session client before minting a token with the service-role client", async () => {
    vi.mocked(createClient).mockResolvedValue(sessionClient({}));
    vi.mocked(createAdminClient).mockReturnValue(adminClient(signedUploadResult));

    await createEpubUpload(validFile);

    expect(requireAdmin).toHaveBeenCalled();
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createAdminClient).toHaveBeenCalledTimes(1);
  });

  // The brief's step order is requireAdmin() first, THEN validate edition/filename/MIME/size -
  // not the reverse. A denied, non-admin caller must see the authorization failure even when its
  // input also happens to be invalid, never a validation error that would leak the acceptance
  // criteria (extension, MIME type, size limit) to someone who was never let in.
  it("surfaces the admin gate's rejection even when the input also fails validation", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(
      createEpubUpload({ ...validFile, fileName: "not-an-epub.zip" }),
    ).rejects.toThrow("NEXT_FORBIDDEN");
  });
});

describe("createEpubUpload reservation", () => {
  it("throws EditionNotFoundError when the book has no edition", async () => {
    vi.mocked(createClient).mockResolvedValue(sessionClient({ edition: { data: null, error: null } }));

    await expect(createEpubUpload(validFile)).rejects.toBeInstanceOf(EditionNotFoundError);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("reserves the asset for the resolved edition and requests a signed upload for its exact storage key", async () => {
    const client = sessionClient({});
    vi.mocked(createClient).mockResolvedValue(client);
    const admin = adminClient(signedUploadResult);
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const result = await createEpubUpload(validFile);

    expect(client.rpc).toHaveBeenCalledWith("admin_reserve_ebook_asset", { p_edition_id: editionId });
    expect(admin.storage.from).toHaveBeenCalledWith("ebook-source");
    const createSignedUploadUrl = admin.storage.from("ebook-source").createSignedUploadUrl;
    expect(createSignedUploadUrl).toHaveBeenCalledWith(storageKey);
    expect(result).toEqual({
      assetId,
      signedUpload: { path: storageKey, token: "sign-token", signedUrl: "https://storage.test/sign" },
    });
  });

  it("never returns a service-role key - only the scoped signed-upload token", async () => {
    vi.mocked(createClient).mockResolvedValue(sessionClient({}));
    vi.mocked(createAdminClient).mockReturnValue(adminClient(signedUploadResult));

    const result = await createEpubUpload(validFile);

    expect(JSON.stringify(result)).not.toMatch(/service.?role/i);
    expect(result.signedUpload).not.toHaveProperty("serviceRoleKey");
  });

  it("surfaces a reservation RPC failure as a generic error, not a raw Postgres message passthrough object", async () => {
    vi.mocked(createClient).mockResolvedValue(
      sessionClient({ reserve: { data: null, error: { message: "connection refused" } } }),
    );

    await expect(createEpubUpload(validFile)).rejects.toThrow(/createEpubUpload/);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe("finalizeEpubUpload", () => {
  beforeEach(() => {
    vi.mocked(headers).mockResolvedValue(new Headers() as never);
  });

  it("never constructs a client when the admin gate denies", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(finalizeEpubUpload(assetId, "a".repeat(64))).rejects.toThrow("NEXT_FORBIDDEN");
    expect(createClient).not.toHaveBeenCalled();
  });

  // Ruling AE: admin_finalize_ebook_asset checks is_admin() through auth.uid(), so it must go
  // through the authenticated user-session client, never service-role.
  it("calls admin_finalize_ebook_asset through the session client with the caller's checksum and a correlation id", async () => {
    const client = sessionClient({});
    vi.mocked(createClient).mockResolvedValue(client);
    vi.mocked(headers).mockResolvedValue(new Headers({ "x-request-id": "req_abc12345" }) as never);

    const result = await finalizeEpubUpload(assetId, "a".repeat(64));

    expect(client.rpc).toHaveBeenCalledWith("admin_finalize_ebook_asset", {
      p_asset_id: assetId,
      p_checksum: "a".repeat(64),
      p_correlation_id: "req_abc12345",
    });
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(result).toEqual({ jobId: "job-id" });
  });

  it("maps a not-awaiting-upload rejection to a typed, retry-safe error", async () => {
    vi.mocked(createClient).mockResolvedValue(
      sessionClient({
        finalize: { data: null, error: { code: "P0002", message: "asset is not awaiting upload" } },
      }),
    );

    await expect(finalizeEpubUpload(assetId, "a".repeat(64))).rejects.toBeInstanceOf(
      AssetNotAwaitingUploadError,
    );
  });

  // Not an integrity gate - just hygiene on an otherwise-unbounded `checksum` parameter that
  // flows straight into a database column, matching the shape every legitimate caller produces
  // (a hex-encoded SHA-256 digest).
  it.each([
    ["too short", "a".repeat(63)],
    ["too long", "a".repeat(65)],
    ["non-hex characters", "g".repeat(64)],
    ["empty", ""],
  ])("rejects a checksum that is %s", async (_label, checksum) => {
    await expect(finalizeEpubUpload(assetId, checksum)).rejects.toBeInstanceOf(InvalidChecksumError);
    expect(createClient).not.toHaveBeenCalled();
  });
});
