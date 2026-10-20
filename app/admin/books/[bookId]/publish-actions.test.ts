// @vitest-environment node
import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { publishBookAction, unpublishBookAction } from "@/app/admin/books/[bookId]/publish-actions";
import { requireAdmin } from "@/lib/auth/admin";
import { BookNotReadyError, publishBook, unpublishBook } from "@/lib/data/books";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data/books", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/data/books")>();
  return { ...original, publishBook: vi.fn(), unpublishBook: vi.fn() };
});

const bookId = "3a1b2c3d-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe.each([
  { action: publishBookAction, write: publishBook, message: "Book published." },
  { action: unpublishBookAction, write: unpublishBook, message: "Book unpublished." },
])("$message", ({ action, write, message }) => {
  it("authorizes, writes the requested book, and refreshes the editor and catalog", async () => {
    vi.mocked(write).mockImplementation(async () => {
      expect(requireAdmin).toHaveBeenCalledWith({ next: `/admin/books/${bookId}` });
    });
    await expect(action(bookId)).resolves.toEqual({ ok: true, message });
    expect(write).toHaveBeenCalledWith(bookId);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/books");
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/books/${bookId}`);
  });

  it("preserves authorization control flow and never writes for a denied caller", async () => {
    const denied = new Error("Forbidden");
    vi.mocked(requireAdmin).mockRejectedValue(denied);
    await expect(action(bookId)).rejects.toBe(denied);
    expect(write).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("hides unexpected errors and does not revalidate a failed write", async () => {
    vi.mocked(write).mockRejectedValue(new Error("publish_book failed: connection reset"));
    await expect(action(bookId)).resolves.toEqual({ ok: false, error: "Something went wrong. Try again.", issues: [] });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

it("returns database readiness issues to the publisher without revalidating", async () => {
  vi.mocked(publishBook).mockRejectedValue(new BookNotReadyError(["missing_cover"]));
  await expect(publishBookAction(bookId)).resolves.toEqual({
    ok: false,
    error: "This book is not ready to publish.",
    issues: ["missing_cover"],
  });
  expect(revalidatePath).not.toHaveBeenCalled();
});
