import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createCoverUploadAction, finalizeCoverUploadAction } from "@/app/admin/books/[bookId]/cover-actions";
import { createClient } from "@/lib/supabase/client";
import { CoverUploadForm } from "./cover-upload-form";

vi.mock("next/navigation", () => ({ useRouter: vi.fn(() => ({ refresh: vi.fn() })) }));
vi.mock("@/app/admin/books/[bookId]/cover-actions", () => ({ createCoverUploadAction: vi.fn(), finalizeCoverUploadAction: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));

const bookId = "3a1b2c3d-0000-4000-8000-000000000001";
const uploadToSignedUrl = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createClient).mockReturnValue({ storage: { from: vi.fn(() => ({ uploadToSignedUrl })) } } as never);
  uploadToSignedUrl.mockResolvedValue({ error: null });
});

afterEach(cleanup);

it("shows a client validation error without reserving an unsupported cover", async () => {
  render(<CoverUploadForm bookId={bookId} cover={null} />);

  fireEvent.change(screen.getByLabelText("Cover image"), { target: { files: [new File(["cover"], "cover.gif", { type: "image/gif" })] } });

  expect(await screen.findByRole("alert")).toHaveTextContent("Upload a JPEG, PNG, or WebP image.");
  expect(createCoverUploadAction).not.toHaveBeenCalled();
});

it("uploads a selected cover, retains its alt text, and reports a saved status", async () => {
  vi.mocked(createCoverUploadAction).mockResolvedValue({ ok: true, storageKey: `books/${bookId}/cover.webp`, path: "path", token: "token" });
  vi.mocked(finalizeCoverUploadAction).mockResolvedValue({ ok: true });
  render(<CoverUploadForm bookId={bookId} cover={null} />);

  fireEvent.change(screen.getByLabelText("Cover image"), { target: { files: [new File(["cover"], "cover.webp", { type: "image/webp" })] } });
  fireEvent.change(screen.getByLabelText("Cover alt text"), { target: { value: "A green book cover" } });
  fireEvent.click(screen.getByRole("button", { name: "Upload cover" }));

  await waitFor(() => expect(finalizeCoverUploadAction).toHaveBeenCalledWith(bookId, {
    storageKey: `books/${bookId}/cover.webp`,
    altText: "A green book cover",
    width: null,
    height: null,
  }));
  expect(uploadToSignedUrl).toHaveBeenCalledWith("path", "token", expect.any(File));
  expect(await screen.findByTestId("cover-status")).toHaveTextContent("Cover saved.");
  expect(screen.getByLabelText("Cover alt text")).toHaveValue("A green book cover");
});

it("preserves the selected draft after a finalization failure", async () => {
  vi.mocked(createCoverUploadAction).mockResolvedValue({ ok: true, storageKey: `books/${bookId}/cover.webp`, path: "path", token: "token" });
  vi.mocked(finalizeCoverUploadAction).mockResolvedValue({ ok: false, error: "Something went wrong saving the cover. Try again." });
  render(<CoverUploadForm bookId={bookId} cover={null} />);

  fireEvent.change(screen.getByLabelText("Cover image"), { target: { files: [new File(["cover"], "cover.webp", { type: "image/webp" })] } });
  fireEvent.change(screen.getByLabelText("Cover alt text"), { target: { value: "Draft alt text" } });
  fireEvent.click(screen.getByRole("button", { name: "Upload cover" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong saving the cover. Try again.");
  expect(screen.getByLabelText("Cover alt text")).toHaveValue("Draft alt text");
  expect(screen.getByLabelText("Cover image")).toHaveProperty("files", expect.objectContaining({ length: 1 }));
});

it("recovers from a rejected upload reservation without losing the selected draft", async () => {
  vi.mocked(createCoverUploadAction).mockRejectedValue(new Error("network failure"));
  render(<CoverUploadForm bookId={bookId} cover={null} />);

  fireEvent.change(screen.getByLabelText("Cover image"), { target: { files: [new File(["cover"], "cover.webp", { type: "image/webp" })] } });
  fireEvent.change(screen.getByLabelText("Cover alt text"), { target: { value: "Draft alt text" } });
  fireEvent.click(screen.getByRole("button", { name: "Upload cover" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong saving the cover. Try again.");
  expect(screen.getByLabelText("Cover alt text")).toHaveValue("Draft alt text");
  expect(screen.getByLabelText("Cover image")).toHaveProperty("files", expect.objectContaining({ length: 1 }));
  expect(screen.getByRole("button", { name: "Upload cover" })).toBeEnabled();
});
