import { z } from "zod";

import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { QuoteList } from "@/components/admin/quotes/quote-list";
import { requireAdmin } from "@/lib/auth/admin";
import { listAdminSharedQuotes } from "@/lib/data/admin-shared-quotes";

export default async function AdminQuotesPage({ searchParams }: { searchParams: Promise<{ book?: string | string[] }> }) {
  await requireAdmin({ next: "/admin/quotes" });
  const { book: raw } = await searchParams;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const bookId = z.uuid().safeParse(value).success ? (value as string) : null;
  const items = await listAdminSharedQuotes(bookId);
  return (
    <div className="min-w-0 max-w-[72rem] [overflow-wrap:anywhere]">
      <AdminPageHeader eyebrow="Readers" title="Shared quotes">
        Public quote cards readers created from the reader. Remove one to take its page down; the code is never reused. The 200 newest are shown{bookId ? " for this book" : ""}.
      </AdminPageHeader>
      <QuoteList items={items} />
    </div>
  );
}
