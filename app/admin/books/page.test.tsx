import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import AdminBooksPage from "@/app/admin/books/page";
import { requireAdmin } from "@/lib/auth/admin";
import { listAdminBooks } from "@/lib/data/books";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/data/books", () => ({ listAdminBooks: vi.fn() }));

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listAdminBooks).mockResolvedValue([
    {
      id: "4a1b2c3d-0000-4000-8000-000000000001",
      canonicalKey: "the-golden-book",
      title: "The Golden Book",
      authorName: "Jane Austen",
      status: "draft",
      hasActivePublication: false, editions: [],
      readinessIssues: ["missing_cover", "missing_publication"],
    },
  ]);
});

it("lists the searched books with publication and readiness state", async () => {
  render(await AdminBooksPage({ searchParams: Promise.resolve({ q: "golden" }) }));

  expect(requireAdmin).toHaveBeenCalledWith({ next: "/admin/books" });
  expect(listAdminBooks).toHaveBeenCalledWith("golden");
  expect(screen.getByLabelText("Search books")).toHaveValue("golden");
  expect(screen.getByRole("link", { name: /the golden book/i })).toHaveAttribute(
    "href",
    "/admin/books/4a1b2c3d-0000-4000-8000-000000000001",
  );
  expect(screen.getByText("None")).toBeInTheDocument();
  expect(screen.getByText("2 to fix")).toHaveAttribute(
    "title",
    "Upload a cover image.\nPublish an EPUB for at least one edition.",
  );
});

it("explains an empty search result", async () => {
  vi.mocked(listAdminBooks).mockResolvedValue([]);

  render(await AdminBooksPage({ searchParams: Promise.resolve({ q: "missing" }) }));

  expect(screen.getByText("No books match this search.")).toBeInTheDocument();
});

it("uses the first value when q is repeated", async () => {
  render(await AdminBooksPage({ searchParams: Promise.resolve({ q: ["golden", "ignored"] }) }));

  expect(listAdminBooks).toHaveBeenCalledWith("golden");
  expect(screen.getByLabelText("Search books")).toHaveValue("golden");
});
