// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import {
  CrossBookRollbackError,
  getPublicationOverview,
  getPublicationVersionHistory,
  MissingRejectionReasonError,
  PreviewResourceNotFoundError,
  PublicationNotFoundError,
  PublicationNotReadyError,
  publishPublication,
  PublicationTransitionRejectedError,
  rejectPublication,
  resolvePreviewResourceStorageKey,
  rollbackPublication,
} from "@/lib/data/publications";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }) }));

const assetId = "a0000000-0000-0000-0000-000000000001";
const editionId = "a0000000-0000-0000-0000-000000000002";
const bookId = "a0000000-0000-0000-0000-000000000003";
const publicationId = "a0000000-0000-0000-0000-000000000004";

// Mirrors createBook's/getAdminBook's call shape mocking pattern (lib/data/books.test.ts):
// `.rpc(name, args)` resolves once with {data, error}.
function rpcClient(result: { data: unknown; error: { code?: string; message: string } | null }) {
  return { rpc: vi.fn().mockResolvedValue(result) } as unknown as Awaited<ReturnType<typeof createClient>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("publishPublication / rejectPublication / rollbackPublication", () => {
  it.each([
    ["publishPublication", () => publishPublication(publicationId)],
    ["rejectPublication", () => rejectPublication(publicationId, "not ready")],
    ["rollbackPublication", () => rollbackPublication(bookId, publicationId)],
  ] as const)("%s never constructs a Supabase client when the admin gate denies", async (_name, invoke) => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(invoke()).rejects.toThrow("NEXT_FORBIDDEN");
    expect(createClient).not.toHaveBeenCalled();
  });

  // Fix round 1, Minor #10: pins the RPC name and its exact argument shape, not just that some
  // RPC was called once - the previous version of these assertions would have passed unchanged
  // against a handler that called a different RPC entirely.
  it.each([
    [
      "publishPublication",
      () => publishPublication(publicationId),
      "publish_publication",
      { p_publication_id: publicationId },
    ],
    [
      "rejectPublication",
      () => rejectPublication(publicationId, "not ready"),
      "reject_publication",
      { p_publication_id: publicationId, p_reason: "not ready" },
    ],
    [
      "rollbackPublication",
      () => rollbackPublication(bookId, publicationId),
      "rollback_publication",
      { p_book_id: bookId, p_publication_id: publicationId },
    ],
  ] as const)("%s calls %s through the session client with the expected arguments", async (_name, invoke, rpcName, rpcArgs) => {
    const client = rpcClient({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue(client);

    await invoke();

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith(rpcName, rpcArgs);
  });

  it.each([
    ["P0002", PublicationNotFoundError],
    ["EB002", PublicationTransitionRejectedError],
    ["EB012", PublicationNotReadyError],
  ] as const)("publishPublication maps %s to %s", async (code, ErrorClass) => {
    vi.mocked(createClient).mockResolvedValue(rpcClient({ data: null, error: { code, message: "x" } }));

    await expect(publishPublication(publicationId)).rejects.toBeInstanceOf(ErrorClass);
  });

  it.each([
    ["P0002", PublicationNotFoundError],
    ["EB004", MissingRejectionReasonError],
    ["EB002", PublicationTransitionRejectedError],
  ] as const)("rejectPublication maps %s to %s", async (code, ErrorClass) => {
    vi.mocked(createClient).mockResolvedValue(rpcClient({ data: null, error: { code, message: "x" } }));

    await expect(rejectPublication(publicationId, "not ready")).rejects.toBeInstanceOf(ErrorClass);
  });

  it.each([
    ["P0002", PublicationNotFoundError],
    ["EB003", CrossBookRollbackError],
    ["EB002", PublicationTransitionRejectedError],
  ] as const)("rollbackPublication maps %s to %s", async (code, ErrorClass) => {
    vi.mocked(createClient).mockResolvedValue(rpcClient({ data: null, error: { code, message: "x" } }));

    await expect(rollbackPublication(bookId, publicationId)).rejects.toBeInstanceOf(ErrorClass);
  });

  it("explains a language mismatch in words an admin can act on", async () => {
    vi.mocked(createClient).mockResolvedValue(
      rpcClient({ data: null, error: { code: "EB012", message: "publish_publication: publication is not ready: epub_language_mismatch" } }),
    );
    const error = await publishPublication(publicationId).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PublicationNotReadyError);
    expect((error as PublicationNotReadyError).issues).toEqual(["epub_language_mismatch"]);
    expect((error as Error).message).toMatch(/different language than this edition/);
  });

  it("does not guess an error class for an unrecognized failure", async () => {
    vi.mocked(createClient).mockResolvedValue(rpcClient({ data: null, error: { code: "XXYYY", message: "boom" } }));

    const error = await publishPublication(publicationId).catch((caught: unknown) => caught);

    expect(error).not.toBeInstanceOf(PublicationNotFoundError);
    expect(error).not.toBeInstanceOf(PublicationTransitionRejectedError);
    expect(error).toBeInstanceOf(Error);
  });
});

describe("resolvePreviewResourceStorageKey", () => {
  function resourceQueryClient(result: { data: unknown; error: { message: string } | null }) {
    const maybeSingle = vi.fn().mockResolvedValue(result);
    const eq2 = vi.fn(() => ({ maybeSingle }));
    const eq1 = vi.fn(() => ({ eq: eq2 }));
    const select = vi.fn(() => ({ eq: eq1 }));
    const from = vi.fn(() => ({ select }));
    return { from } as unknown as Awaited<ReturnType<typeof createClient>>;
  }

  // Ruling AM's ordering, pinned the same way lib/data/admin.test.ts pins getAdminSummary: this
  // function is a library boundary with its own contract, not code that trusts the route handler
  // to have gated first.
  it("never constructs a Supabase client when the admin gate denies", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(resolvePreviewResourceStorageKey(publicationId, "OEBPS/text/chapter1.xhtml")).rejects.toThrow(
      "NEXT_FORBIDDEN",
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  it("resolves the storage key and media type scoped to (publicationId, href)", async () => {
    const client = resourceQueryClient({
      data: { storage_key: "k1", media_type: "application/xhtml+xml" },
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(client);

    const result = await resolvePreviewResourceStorageKey(publicationId, "OEBPS/text/chapter1.xhtml");

    expect(result).toEqual({ storageKey: "k1", mediaType: "application/xhtml+xml" });
    expect(client.from).toHaveBeenCalledWith("ebook_resources");
  });

  it("rejects a href/publicationId pair that resolves no row - never guesses a fallback key", async () => {
    vi.mocked(createClient).mockResolvedValue(resourceQueryClient({ data: null, error: null }));

    await expect(
      resolvePreviewResourceStorageKey(publicationId, "not/a/real/resource.xhtml"),
    ).rejects.toBeInstanceOf(PreviewResourceNotFoundError);
  });
});

describe("getPublicationOverview", () => {
  it("never constructs a Supabase client when the admin gate denies", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(getPublicationOverview(assetId)).rejects.toThrow("NEXT_FORBIDDEN");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("projects a queued asset with no publication yet into the 'queued' lifecycle", async () => {
    const assetRow = { id: assetId, edition_id: editionId, version: 1, status: "queued" };
    const editionRow = {
      id: editionId,
      book_id: bookId,
      active_publication_id: null,
      books: { id: bookId, book_localizations: [{ locale: "en", slug: "s", title: "T" }] },
    };

    const client = {
      from: vi.fn((table: string) => {
        if (table === "ebook_assets") {
          return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: assetRow, error: null }) }) }) };
        }
        if (table === "editions") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => ({
                  overrideTypes: async () => ({ data: editionRow, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === "processing_jobs") {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
              }),
            }),
          };
        }
        if (table === "ebook_publications") {
          return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
        }
        throw new Error(`unexpected table ${table}`);
      }),
    } as unknown as Awaited<ReturnType<typeof createClient>>;
    vi.mocked(createClient).mockResolvedValue(client);

    const result = await getPublicationOverview(assetId);

    expect(result.lifecycle).toBe("queued");
    expect(result.publicationId).toBeNull();
    expect(result.resources).toEqual([]);
    expect(result.toc).toEqual([]);
  });
});

describe("getPublicationVersionHistory", () => {
  it("never constructs a Supabase client when the admin gate denies", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(getPublicationVersionHistory(editionId)).rejects.toThrow("NEXT_FORBIDDEN");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("merges each asset with its publication (if any) into one lifecycle per version", async () => {
    const assetRows = [
      { id: "v2", version: 2, status: "published" },
      { id: "v1", version: 1, status: "superseded" },
    ];
    const publicationRows = [
      { id: "pub-2", status: "published", ebook_asset_id: "v2" },
      { id: "pub-1", status: "superseded", ebook_asset_id: "v1" },
    ];
    const client = {
      from: vi.fn((table: string) => {
        if (table === "ebook_assets") {
          return { select: () => ({ eq: () => ({ order: async () => ({ data: assetRows, error: null }) }) }) };
        }
        if (table === "ebook_publications") {
          return { select: () => ({ in: async () => ({ data: publicationRows, error: null }) }) };
        }
        throw new Error(`unexpected table ${table}`);
      }),
    } as unknown as Awaited<ReturnType<typeof createClient>>;
    vi.mocked(createClient).mockResolvedValue(client);

    const result = await getPublicationVersionHistory(editionId);

    expect(result).toEqual([
      { assetId: "v2", version: 2, publicationId: "pub-2", lifecycle: "published" },
      { assetId: "v1", version: 1, publicationId: "pub-1", lifecycle: "superseded" },
    ]);
  });
});
