// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import { knowledgeBlockSchema } from "@/lib/knowledge/blocks";
import { createKnowledgeImageUpload, KnowledgeImageTargetNotFoundError } from "@/lib/data/knowledge-images";
import { fakeSupabaseClient } from "@/lib/data/supabase-test-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

type SessionClient = Awaited<ReturnType<typeof createClient>>;

const ideaId = "5a1b2c3d-0000-4000-8000-000000000001";
const articleId = "5a1b2c3d-0000-4000-8000-0000000000a0";
const input = { mimeType: "image/png" as const, sizeBytes: 2048 };

function storageClient() {
  const createSignedUploadUrl = vi.fn((path: string) =>
    Promise.resolve({ data: { path, token: "signed-token", signedUrl: "https://x" }, error: null }),
  );
  const from = vi.fn(() => ({ createSignedUploadUrl }));
  return { client: { storage: { from } } as unknown as ReturnType<typeof createAdminClient>, from, createSignedUploadUrl };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("createKnowledgeImageUpload", () => {
  it("never builds a client when the admin gate denies", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(createKnowledgeImageUpload("idea", ideaId, input)).rejects.toThrow("NEXT_FORBIDDEN");

    expect(createClient).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-uuid id", "idea", "../other"],
    ["an unknown kind", "book", ideaId],
  ] as const)("refuses %s before querying", async (_label, kind, id) => {
    await expect(createKnowledgeImageUpload(kind as "idea", id, input)).rejects.toBeInstanceOf(KnowledgeImageTargetNotFoundError);
    expect(createClient).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("never mints a signed upload for an entry the admin session cannot see", async () => {
    const fake = fakeSupabaseClient({ tables: { ideas: { data: null, error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(createKnowledgeImageUpload("idea", ideaId, input)).rejects.toBeInstanceOf(KnowledgeImageTargetNotFoundError);

    expect(fake.from).toHaveBeenCalledWith("ideas");
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("never mints a signed upload when the lookup fails", async () => {
    const fake = fakeSupabaseClient({ tables: { articles: { data: null, error: { message: "boom" } } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(createKnowledgeImageUpload("article", articleId, input)).rejects.toThrow("createKnowledgeImageUpload failed.");
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it.each([
    ["idea", ideaId, "ideas", "image/png", "png"],
    ["article", articleId, "articles", "image/jpeg", "jpg"],
    ["article", articleId, "articles", "image/webp", "webp"],
  ] as const)("signs a %s key under knowledge/%s in the covers bucket", async (kind, id, table, mimeType, extension) => {
    const fake = fakeSupabaseClient({ tables: { [table]: { data: { id }, error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    const storage = storageClient();
    vi.mocked(createAdminClient).mockReturnValue(storage.client);

    const upload = await createKnowledgeImageUpload(kind, id, { mimeType, sizeBytes: 10 });

    expect(fake.from).toHaveBeenCalledWith(table);
    expect(storage.from).toHaveBeenCalledWith("covers");
    expect(upload.storageKey).toMatch(new RegExp(`^knowledge/${table}/${id}/[0-9a-f-]{36}\\.${extension}$`));
    expect(storage.createSignedUploadUrl).toHaveBeenCalledWith(upload.storageKey);
    expect(upload).toEqual({ storageKey: upload.storageKey, path: upload.storageKey, token: "signed-token" });
    // The minted key is one the block schema accepts, so the editor can insert it as-is.
    expect(
      knowledgeBlockSchema.safeParse({ type: "image", storageKey: upload.storageKey, alt: "Alt", width: 10, height: 10 }).success,
    ).toBe(true);
  });

  it("hides storage errors", async () => {
    const fake = fakeSupabaseClient({ tables: { ideas: { data: { id: ideaId }, error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    const createSignedUploadUrl = vi.fn(() => Promise.resolve({ data: null, error: { message: "bucket internals" } }));
    vi.mocked(createAdminClient).mockReturnValue({
      storage: { from: () => ({ createSignedUploadUrl }) },
    } as unknown as ReturnType<typeof createAdminClient>);

    await expect(createKnowledgeImageUpload("idea", ideaId, input)).rejects.toThrow("createKnowledgeImageUpload failed.");
  });
});
