// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import { revalidatePath } from "next/cache";
import { CoverBookNotFoundError, createCoverUpload, finalizeCoverUpload } from "@/lib/data/covers";
import { createCoverUploadAction, finalizeCoverUploadAction } from "./cover-actions";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data/covers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/data/covers")>();
  return { ...original, createCoverUpload: vi.fn(), finalizeCoverUpload: vi.fn() };
});

const bookId = "3a1b2c3d-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("cover actions", () => {
  it("authorizes before validating or reserving an upload", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("Forbidden"));

    await expect(createCoverUploadAction(bookId, { fileName: "cover.webp", mimeType: "image/webp", sizeBytes: 1 })).rejects.toThrow("Forbidden");

    expect(createCoverUpload).not.toHaveBeenCalled();
  });

  it("returns the schema error without reserving an invalid upload", async () => {
    const result = await createCoverUploadAction(bookId, { fileName: "cover.gif", mimeType: "image/gif", sizeBytes: 1 });

    expect(result).toEqual({ ok: false, error: "Upload a JPEG, PNG, or WebP image." });
    expect(createCoverUpload).not.toHaveBeenCalled();
  });

  it("returns only the signed upload reservation", async () => {
    vi.mocked(createCoverUpload).mockResolvedValue({ storageKey: `books/${bookId}/cover.webp`, path: "path", token: "token" });

    await expect(createCoverUploadAction(bookId, { fileName: "cover.webp", mimeType: "image/webp", sizeBytes: 1 })).resolves.toEqual({
      ok: true,
      storageKey: `books/${bookId}/cover.webp`,
      path: "path",
      token: "token",
    });
  });

  it("hides unexpected reservation errors", async () => {
    vi.mocked(createCoverUpload).mockRejectedValue(new Error("storage internals"));

    await expect(createCoverUploadAction(bookId, { fileName: "cover.webp", mimeType: "image/webp", sizeBytes: 1 })).resolves.toEqual({
      ok: false,
      error: "Something went wrong saving the cover. Try again.",
    });
  });

  it("validates alt text before finalizing", async () => {
    const result = await finalizeCoverUploadAction(bookId, { storageKey: `books/${bookId}/cover.webp`, altText: "", width: 600, height: 900 });

    expect(result).toEqual({ ok: false, error: "Describe the cover for screen readers." });
    expect(finalizeCoverUpload).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("finalizes and refreshes the admin catalog paths", async () => {
    const input = { storageKey: `books/${bookId}/cover.webp`, altText: "Bìa sách", width: 600, height: 900 };

    await expect(finalizeCoverUploadAction(bookId, input)).resolves.toEqual({ ok: true });

    expect(finalizeCoverUpload).toHaveBeenCalledWith(bookId, input);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/books");
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/books/${bookId}`);
  });

  it("exposes the safe missing-book message", async () => {
    vi.mocked(finalizeCoverUpload).mockRejectedValue(new CoverBookNotFoundError());

    await expect(finalizeCoverUploadAction(bookId, { storageKey: `books/${bookId}/cover.webp`, altText: "Bìa sách", width: null, height: null })).resolves.toEqual({
      ok: false,
      error: "This book no longer exists.",
    });
  });
});
