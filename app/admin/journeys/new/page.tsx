import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { JourneyCreateForm } from "@/components/admin/journeys/journey-form";
import { requireAdmin } from "@/lib/auth/admin";
import { listAdminBooks } from "@/lib/data/books";

export default async function NewJourneyPage() {
  await requireAdmin({ next: "/admin/journeys/new" });
  const books = (await listAdminBooks()).map((book) => ({
    id: book.id,
    title: book.title,
    editions: book.editions.map((edition) => ({
      id: edition.id,
      label: `${edition.languageCode} · edition ${edition.editionNumber}${edition.activePublicationId ? "" : " (no publication)"}`,
    })),
  }));

  return (
    <div className="max-w-[42.5rem]">
      <AdminPageHeader eyebrow="Reading" title="New journey">
        Creates the journey for one edition. Add its text and sessions in the editor, then publish.
      </AdminPageHeader>
      <div className="border-t border-ink pt-8">
        <JourneyCreateForm books={books} />
      </div>
    </div>
  );
}
