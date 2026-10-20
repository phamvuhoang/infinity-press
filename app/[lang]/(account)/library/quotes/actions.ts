"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/auth/session";
import { removeMySharedQuote } from "@/lib/data/shared-quotes";
import type { Locale } from "@/lib/i18n/config";
import { getLocaleRoutes } from "@/lib/i18n/routes";

// The owner's one write. requireUser() itself; the RPC removes only the caller's own active row.
export async function removeSharedQuoteAction(locale: Locale, code: string): Promise<void> {
  await requireUser(locale, getLocaleRoutes(locale).myQuotes);
  await removeMySharedQuote(String(code));
  revalidatePath(getLocaleRoutes(locale).myQuotes);
}
