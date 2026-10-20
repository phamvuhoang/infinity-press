// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import { CoverBookNotFoundError, coverExtensionFor, createCoverUpload, finalizeCoverUpload } from "@/lib/data/covers";
import { fakeSupabaseClient } from "@/lib/data/supabase-test-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

type SessionClient = Awaited<ReturnType<typeof createClient>>;
const bookId = "3a1b2c3d-0000-4000-8000-000000000001";
const input = { fileName: "cover.webp", mimeType: "image/webp" as const, sizeBytes: 2048 };

function storageClient() {
  const createSignedUploadUrl = vi.fn((path: string) => Promise.resolve({ data: { path, token: "signed-token", signedUrl: "https://x" }, error: null }));
  const from = vi.fn(() => ({ createSignedUploadUrl }));
  return { client: { storage: { from } } as unknown as ReturnType<typeof createAdminClient>, from, createSignedUploadUrl };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("covers", () => {
  it("maps MIME types to file extensions", () => {
    expect(coverExtensionFor("image/jpeg")).toBe("jpg");
    expect(coverExtensionFor("image/png")).toBe("png");
    expect(coverExtensionFor("image/webp")).toBe("webp");
  });

  it("never creates a service-role client when the admin gate denies", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
    await expect(createCoverUpload(bookId, input)).rejects.toThrow("NEXT_FORBIDDEN");
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("refuses a book the admin cannot see", async () => {
    const fake = fakeSupabaseClient({ tables: { books: { data: null, error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(createCoverUpload(bookId, input)).rejects.toBeInstanceOf(CoverBookNotFoundError);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("mints a signed upload under books/{bookId}/ in the covers bucket", async () => {
    const fake = fakeSupabaseClient({ tables: { books: { data: { id: bookId }, error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    const storage = storageClient();
    vi.mocked(createAdminClient).mockReturnValue(storage.client);

    const upload = await createCoverUpload(bookId, input);

    expect(storage.from).toHaveBeenCalledWith("covers");
    expect(upload.storageKey).toMatch(new RegExp(`^books/${bookId}/[0-9a-f-]{36}\\.webp$`));
    expect(upload.token).toBe("signed-token");
  });

  it("records the cover through admin_set_book_cover", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: "media-id", error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await finalizeCoverUpload(bookId, { storageKey: `books/${bookId}/k.webp`, altText: "Bìa sách", width: 600, height: 900 });

    expect(fake.rpc).toHaveBeenCalledWith("admin_set_book_cover", {
      p_book_id: bookId,
      p_storage_key: `books/${bookId}/k.webp`,
      p_alt_text: "Bìa sách",
      p_width: 600,
      p_height: 900,
    });
  });
});
