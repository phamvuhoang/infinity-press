// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import { requireAdmin } from "@/lib/auth/admin";
import AuthorsList from "@/app/admin/authors/page";
import AuthorsNew from "@/app/admin/authors/new/page";
import AuthorsEdit from "@/app/admin/authors/[id]/page";
import SeriesList from "@/app/admin/series/page";
import SeriesNew from "@/app/admin/series/new/page";
import SeriesEdit from "@/app/admin/series/[id]/page";
import TopicsList from "@/app/admin/topics/page";
import TopicsNew from "@/app/admin/topics/new/page";
import TopicsEdit from "@/app/admin/topics/[id]/page";
import AdminBooksPage from "@/app/admin/books/page";
import NewBookPage from "@/app/admin/books/new/page";
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
it.each([
["/admin/authors", () => AuthorsList()],
["/admin/authors/new", () => AuthorsNew()],
["/admin/authors/test-id", () => AuthorsEdit( { params: Promise.resolve({ id: "test-id" }) } )],
["/admin/series", () => SeriesList()],
["/admin/series/new", () => SeriesNew()],
["/admin/series/test-id", () => SeriesEdit( { params: Promise.resolve({ id: "test-id" }) } )],
["/admin/topics", () => TopicsList()],
["/admin/topics/new", () => TopicsNew()],
["/admin/topics/test-id", () => TopicsEdit( { params: Promise.resolve({ id: "test-id" }) } )],
["/admin/books", () => AdminBooksPage({ searchParams: Promise.resolve({}) })],
["/admin/books/new", () => NewBookPage()]
] as const)("protects %s at the page boundary", async (path, page) => {
 vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
 await expect(page()).rejects.toThrow("NEXT_FORBIDDEN");
 expect(requireAdmin).toHaveBeenCalledWith({ next: path });
});
