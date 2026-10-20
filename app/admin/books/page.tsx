import Link from "next/link";

import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { ReadinessBadge } from "@/components/admin/readiness-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireAdmin } from "@/lib/auth/admin";
import { listAdminBooks } from "@/lib/data/books";

export default async function AdminBooksPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  await requireAdmin({ next: "/admin/books" });
  const params = await searchParams;
  const q = Array.isArray(params.q) ? params.q[0] : params.q;
  const books = await listAdminBooks(q);

  return (
    <div className="max-w-[64rem] min-w-0">
      <AdminPageHeader eyebrow="Catalog" title="Books">
        <div className="flex flex-wrap items-center gap-3">
          <form className="flex min-w-0 flex-1 gap-2 sm:flex-none" method="get">
            <label className="sr-only" htmlFor="book-search">
              Search books
            </label>
            <Input defaultValue={q ?? ""} id="book-search" name="q" placeholder="Title or canonical key" />
            <Button type="submit" variant="outline">
              Search
            </Button>
          </form>
          <Button render={<Link href="/admin/books/new" />}>New book</Button>
        </div>
      </AdminPageHeader>

      {books.length === 0 ? (
        <p className="text-sage-text">{q ? "No books match this search." : "No books yet."}</p>
      ) : (
        <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[42rem] table-fixed border-t border-ink text-left text-xs sm:text-sm">
            <thead>
              <tr className="border-b border-sand text-[0.6875rem] tracking-[0.08em] text-sage-text uppercase">
                <th className="px-1 py-3 font-medium" scope="col">Title</th>
                <th className="px-1 py-3 font-medium" scope="col">Author</th>
                <th className="px-1 py-3 font-medium" scope="col">Status</th>
                <th className="px-1 py-3 font-medium" scope="col">EPUB</th>
                <th className="px-1 py-3 font-medium" scope="col">Readiness</th>
              </tr>
            </thead>
            <tbody>
              {books.map((book) => (
                <tr className="border-b border-sand" key={book.id}>
                  <td className="min-w-0 wrap-anywhere px-1 py-3">
                    <Link
                      className="inline-flex min-h-11 items-center wrap-anywhere font-medium text-forest underline decoration-sand underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
                      href={`/admin/books/${book.id}`}
                    >
                      {book.title}
                    </Link>
                    <span className="block wrap-anywhere font-mono text-[0.75rem] text-sage-text">{book.canonicalKey}</span>
                  </td>
                  <td className="wrap-anywhere px-1 py-3">{book.authorName}</td>
                  <td className="wrap-anywhere px-1 py-3">{book.status}</td>
                  <td className="wrap-anywhere px-1 py-3">{book.hasActivePublication ? "Active version" : "None"}</td>
                  <td className="px-1 py-3">
                    <ReadinessBadge issues={book.readinessIssues} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
