import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { BookForm } from "@/components/admin/book-form";
import { requireAdmin } from "@/lib/auth/admin";
import { listCatalogEntityOptions } from "@/lib/data/catalog-entities";

export default async function NewBookPage() {
  await requireAdmin({ next: "/admin/books/new" });
  const authorOptions = await listCatalogEntityOptions("author");

  return (
    <div className="max-w-[42.5rem]">
      <AdminPageHeader eyebrow="Catalog" title="New book">
        Creates the book with one localization, edition, ebook SKU, and offer. An existing author with the same name is reused.
      </AdminPageHeader>
      <div className="border-t border-ink pt-8">
        <BookForm authorOptions={authorOptions} />
      </div>
    </div>
  );
}
