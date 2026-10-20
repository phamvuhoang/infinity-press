import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { AuthorImageForm } from "@/components/admin/author-image-form";

vi.mock("next/navigation", () => ({ useRouter: vi.fn(() => ({ refresh: vi.fn() })) }));
vi.mock("@/app/admin/entities/author-image-actions", () => ({
  createAuthorImageUploadAction: vi.fn(),
  finalizeAuthorImageUploadAction: vi.fn(),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));

const authorId = "5a1b2c3d-0000-4000-8000-000000000001";

afterEach(cleanup);

it("prefills the alt text from the saved portrait", () => {
  render(<AuthorImageForm authorId={authorId} image={{ publicUrl: "https://example.test/a.webp", altText: "Portrait in daylight" }} />);
  expect(screen.getByLabelText("Portrait alt text")).toHaveValue("Portrait in daylight");
  expect(screen.getByRole("img", { name: "Portrait in daylight" })).toBeInTheDocument();
});

it("says so when no portrait is set, and blocks upload until a file and alt text exist", () => {
  render(<AuthorImageForm authorId={authorId} image={null} />);
  expect(screen.getByText("No portrait yet")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Upload portrait" })).toBeDisabled();
});
