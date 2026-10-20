import "server-only";
import { locales } from "@/lib/i18n/config";

import { headers } from "next/headers";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/admin";
import { SHARED_QUOTE_CODE } from "@/lib/data/shared-quotes";
import { getRequestId } from "@/lib/observability/request-id";
import { createClient } from "@/lib/supabase/server";

// Admin takedown surface. requireAdmin() first; the RPCs re-check is_admin() themselves.
const adminSharedQuoteSchema = z.object({
  id: z.string(),
  code: z.string(),
  quote: z.string(),
  locale: z.enum(locales),
  bookId: z.string(),
  createdAt: z.string(),
  bookTitle: z.string(),
  ownerEmail: z.string().nullable(),
  viewCount: z.coerce.number().int(),
});
export type AdminSharedQuote = z.infer<typeof adminSharedQuoteSchema>;

async function failure(operation: string, cause: unknown): Promise<Error> {
  console.error("Shared quote admin operation failed.", {
    operation,
    code: (cause as { code?: string } | null)?.code ?? null,
    requestId: getRequestId(await headers()),
  });
  return new Error(`${operation} failed.`, { cause });
}

export async function listAdminSharedQuotes(bookId: string | null): Promise<AdminSharedQuote[]> {
  await requireAdmin();
  // The SQL treats a null book as "all books"; the generated type has no nullable arg.
  const { data, error } = await (await createClient()).rpc("admin_list_shared_quotes", { p_book_id: bookId as string });
  if (error) throw await failure("listAdminSharedQuotes", error);
  return z.array(adminSharedQuoteSchema).parse(data ?? []);
}

// P0002 means there is no active card under that code: already removed, which is the goal.
export async function adminRemoveSharedQuote(code: string): Promise<void> {
  await requireAdmin();
  if (!SHARED_QUOTE_CODE.test(code)) return;
  const { error } = await (await createClient()).rpc("admin_remove_shared_quote", { p_code: code });
  if (error && error.code !== "P0002") throw await failure("adminRemoveSharedQuote", error);
}
