// @vitest-environment node
import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createKnowledgeImageUploadAction } from "@/app/admin/knowledge/image-actions";
import { requireAdmin } from "@/lib/auth/admin";
import { createKnowledgeImageUpload, KnowledgeImageTargetNotFoundError } from "@/lib/data/knowledge-images";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data/knowledge-images", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/data/knowledge-images")>();
  return { ...original, createKnowledgeImageUpload: vi.fn() };
});

const ideaId = "5a1b2c3d-0000-4000-8000-000000000001";
const articleId = "5a1b2c3d-0000-4000-8000-0000000000a0";
const storageKey = `knowledge/ideas/${ideaId}/6c2f1b3a-0000-4000-8000-000000000000.png`;
const png = { fileName: "figure.png", mimeType: "image/png", sizeBytes: 2048 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("createKnowledgeImageUploadAction", () => {
  it("authorizes for the entry's editor before validating or signing", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(createKnowledgeImageUploadAction("article", articleId, png)).rejects.toThrow("NEXT_FORBIDDEN");

    expect(requireAdmin).toHaveBeenCalledWith({ next: `/admin/articles/${articleId}` });
    expect(createKnowledgeImageUpload).not.toHaveBeenCalled();
  });

  it.each(["image/jpeg", "image/png", "image/webp"])("accepts %s up to 5 MB and returns only the reservation", async (mimeType) => {
    vi.mocked(createKnowledgeImageUpload).mockResolvedValue({ storageKey, path: storageKey, token: "token" });

    const result = await createKnowledgeImageUploadAction("idea", ideaId, { fileName: "f", mimeType, sizeBytes: 5 * 1024 * 1024 });

    expect(result).toEqual({ ok: true, storageKey, path: storageKey, token: "token" });
    expect(createKnowledgeImageUpload).toHaveBeenCalledWith("idea", ideaId, { mimeType, sizeBytes: 5 * 1024 * 1024 });
    // Reserving a key changes nothing a page renders; saving the localization does.
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["a GIF", { ...png, mimeType: "image/gif" }, "Upload a JPEG, PNG, or WebP image."],
    ["an SVG", { ...png, mimeType: "image/svg+xml" }, "Upload a JPEG, PNG, or WebP image."],
    ["a file over 5 MB", { ...png, sizeBytes: 5 * 1024 * 1024 + 1 }, "Images must be 5 MB or smaller."],
    ["an empty file", { ...png, sizeBytes: 0 }, "The selected file is empty."],
  ])("refuses %s without signing", async (_label, input, error) => {
    await expect(createKnowledgeImageUploadAction("idea", ideaId, input)).resolves.toEqual({ ok: false, error });
    expect(createKnowledgeImageUpload).not.toHaveBeenCalled();
  });

  it("reports an entry that no longer exists", async () => {
    vi.mocked(createKnowledgeImageUpload).mockRejectedValue(new KnowledgeImageTargetNotFoundError());

    await expect(createKnowledgeImageUploadAction("idea", ideaId, png)).resolves.toEqual({
      ok: false,
      error: "This entry no longer exists.",
    });
  });

  it("hides unexpected errors", async () => {
    vi.mocked(createKnowledgeImageUpload).mockRejectedValue(new Error("storage internals"));

    await expect(createKnowledgeImageUploadAction("idea", ideaId, png)).resolves.toEqual({
      ok: false,
      error: "Something went wrong preparing the upload. Try again.",
    });
  });
});
