"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth/admin";
import { adminRemoveSharedQuote } from "@/lib/data/admin-shared-quotes";

// Takedown. A Server Action is a public endpoint: requireAdmin() here, and the RPC re-checks.
export async function removeSharedQuoteAction(
  code: string,
  // The plain form action receives the (empty) FormData last; nothing in it is read.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _formData: FormData,
): Promise<void> {
  await requireAdmin({ next: "/admin/quotes" });
  await adminRemoveSharedQuote(String(code));
  revalidatePath("/admin/quotes");
}
