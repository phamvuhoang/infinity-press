import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { BookForm } from "@/components/admin/book-form";
import { requireAdmin } from "@/lib/auth/admin";
import { listCatalogEntityOptions } from "@/lib/data/catalog-entities";
import { listContentLanguages } from "@/lib/i18n/settings";

export default async function NewBookPage() {
  await requireAdmin({ next: "/admin/books/new" });
  const [authorOptions, languages] = await Promise.all([listCatalogEntityOptions("author"), listContentLanguages()]);

  return (
    <div className="max-w-[42.5rem]">
      <AdminPageHeader eyebrow="Catalog" title="New book">
        Creates the book with one localization, edition, ebook SKU, and offer. An existing author with the same name is reused.
      </AdminPageHeader>
      <div className="border-t border-ink pt-8">
        <BookForm authorOptions={authorOptions} languages={languages} />
      </div>
    </div>
  );
}
