// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import {
  createBundleCoverUpload,
  CoverBundleNotFoundError,
  finalizeBundleCoverUpload,
  readBundleCover,
} from "@/lib/data/bundle-covers";
import { fakeSupabaseClient } from "@/lib/data/supabase-test-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

type SessionClient = Awaited<ReturnType<typeof createClient>>;

const bundleId = "8a1b2c3d-0000-4000-8000-000000000001";
const input = { fileName: "cover.webp", mimeType: "image/webp" as const, sizeBytes: 2048 };

function storageClient() {
  const createSignedUploadUrl = vi.fn((path: string) =>
    Promise.resolve({ data: { path, token: "signed-token", signedUrl: "https://x" }, error: null }),
  );
  const from = vi.fn(() => ({ createSignedUploadUrl }));
  return { client: { storage: { from } } as unknown as ReturnType<typeof createAdminClient>, from, createSignedUploadUrl };
}

// The service-role read of media_assets, which is the only place storage_key may be selected.
function mediaClient(result: { data: unknown; error: unknown }) {
  const fake = fakeSupabaseClient({ tables: { media_assets: result } });
  return { client: fake.client as unknown as ReturnType<typeof createAdminClient>, from: fake.from };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("createBundleCoverUpload", () => {
  it("never creates a service-role client when the admin gate denies", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(createBundleCoverUpload(bundleId, input)).rejects.toThrow("NEXT_FORBIDDEN");

    expect(createAdminClient).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("refuses a bundle the admin cannot see", async () => {
    const fake = fakeSupabaseClient({ tables: { bundles: { data: null, error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(createBundleCoverUpload(bundleId, input)).rejects.toBeInstanceOf(CoverBundleNotFoundError);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("refuses a bundle id that is not a uuid", async () => {
    await expect(createBundleCoverUpload("not-a-uuid", input)).rejects.toBeInstanceOf(CoverBundleNotFoundError);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("mints a key admin_set_bundle_cover accepts, in the covers bucket", async () => {
    const fake = fakeSupabaseClient({ tables: { bundles: { data: { id: bundleId }, error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    const storage = storageClient();
    vi.mocked(createAdminClient).mockReturnValue(storage.client);

    const upload = await createBundleCoverUpload(bundleId, input);

    expect(storage.from).toHaveBeenCalledWith("covers");
    // The pattern admin_set_bundle_cover validates the key against.
    expect(upload.storageKey).toMatch(new RegExp(`^bundles/${bundleId}/[0-9a-f-]{36}\\.webp$`));
    expect(upload.token).toBe("signed-token");
  });
});

describe("finalizeBundleCoverUpload", () => {
  it("records the cover through admin_set_bundle_cover", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: "media-id", error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await finalizeBundleCoverUpload(bundleId, {
      storageKey: `bundles/${bundleId}/k.webp`,
      altText: "Bìa bộ sách",
      width: 600,
      height: 900,
    });

    expect(fake.rpc).toHaveBeenCalledWith("admin_set_bundle_cover", {
      p_bundle_id: bundleId,
      p_storage_key: `bundles/${bundleId}/k.webp`,
      p_alt_text: "Bìa bộ sách",
      p_width: 600,
      p_height: 900,
    });
  });

  it("reports a bundle or object the database refused as a missing bundle", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: null, error: { code: "P0002", message: "storage object does not exist" } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(
      finalizeBundleCoverUpload(bundleId, { storageKey: `bundles/${bundleId}/k.webp`, altText: "Bìa", width: null, height: null }),
    ).rejects.toBeInstanceOf(CoverBundleNotFoundError);
  });

  it("never leaks raw database text", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: null, error: { code: "22023", message: "storage key does not belong to bundle" } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(
      finalizeBundleCoverUpload(bundleId, { storageKey: "bundles/other/k.webp", altText: "Bìa", width: null, height: null }),
    ).rejects.toThrow("finalizeBundleCoverUpload failed.");
  });

  it("authorizes before building a client", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(
      finalizeBundleCoverUpload(bundleId, { storageKey: `bundles/${bundleId}/k.webp`, altText: "Bìa", width: null, height: null }),
    ).rejects.toThrow("NEXT_FORBIDDEN");

    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("readBundleCover", () => {
  it("reads the storage key with the service role, after the admin gate", async () => {
    const media = mediaClient({ data: { storage_key: `bundles/${bundleId}/k.webp`, alt_text: "Bìa bộ sách" }, error: null });
    vi.mocked(createAdminClient).mockImplementation(() => {
      expect(requireAdmin).toHaveBeenCalled();
      return media.client;
    });

    await expect(readBundleCover(bundleId)).resolves.toEqual({
      storageKey: `bundles/${bundleId}/k.webp`,
      altText: "Bìa bộ sách",
    });
    expect(media.from).toHaveBeenCalledWith("media_assets");
    // The key is private to the server: it is never read through the session client.
    expect(createClient).not.toHaveBeenCalled();
  });

  it("never creates a service-role client when the admin gate denies", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(readBundleCover(bundleId)).rejects.toThrow("NEXT_FORBIDDEN");

    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("returns null when the bundle has no cover", async () => {
    const media = mediaClient({ data: null, error: null });
    vi.mocked(createAdminClient).mockReturnValue(media.client);

    await expect(readBundleCover(bundleId)).resolves.toBeNull();
  });

  it("returns null for a bundle id that is not a uuid", async () => {
    await expect(readBundleCover("not-a-uuid")).resolves.toBeNull();
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
