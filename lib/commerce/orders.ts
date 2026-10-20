import "server-only";

import { EmailNotVerifiedError } from "@/lib/access/grant";
import { requireUser } from "@/lib/auth/session";
import { AlreadyOwnedError, NotPurchasableError, PaymentsDisabledError } from "@/lib/commerce/errors";
import { arePaymentsEnabled } from "@/lib/commerce/payment-provider";
import { getServerEnv } from "@/lib/config/server-env";
import type { Locale } from "@/lib/i18n/config";
import { createClient } from "@/lib/supabase/server";

// Paid order creation (S3 spec 4.3). The app gate runs first. create_ebook_order repeats the check
// against commerce_settings, so neither gate alone can open paid checkout. The profile, offer, and
// price are resolved inside the RPC; this wrapper forwards only the book ID.
export async function createEbookOrder(locale: Locale, bookId: string): Promise<{ orderId: string }> {
  await requireUser(locale);
  if (!arePaymentsEnabled(getServerEnv())) throw new PaymentsDisabledError();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_ebook_order", { p_book_id: bookId });

  if (error) {
    if (error.code === "EB005") throw new EmailNotVerifiedError();
    if (error.code === "EB011") throw new PaymentsDisabledError();
    if (error.code === "EB012") throw new NotPurchasableError();
    if (error.code === "EB013") throw new AlreadyOwnedError();
    throw new Error(`createEbookOrder: create_ebook_order failed: ${error.message}`);
  }
  if (typeof data !== "string" || data.length === 0) {
    throw new Error("createEbookOrder: create_ebook_order returned no order id");
  }

  return { orderId: data };
}

// Bundle order creation (S9 spec 5). The same two gates as createEbookOrder, in the same order, and
// the same division of labour: the profile, the live offer, the price, and which member books are
// on the order are all resolved inside create_bundle_order. The bundle price is never prorated for
// books the reader already owns, so this wrapper has nothing to compute either.
export async function createBundleOrder(locale: Locale, bundleId: string): Promise<{ orderId: string }> {
  await requireUser(locale);
  if (!arePaymentsEnabled(getServerEnv())) throw new PaymentsDisabledError();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_bundle_order", { p_bundle_id: bundleId });

  if (error) {
    if (error.code === "EB005") throw new EmailNotVerifiedError();
    if (error.code === "EB011") throw new PaymentsDisabledError();
    // EB027 is the bundle's EB012: unpublished, unpriced, or nothing published left to sell.
    if (error.code === "EB027") throw new NotPurchasableError();
    if (error.code === "EB013") throw new AlreadyOwnedError();
    throw new Error(`createBundleOrder: create_bundle_order failed: ${error.message}`);
  }
  if (typeof data !== "string" || data.length === 0) {
    throw new Error("createBundleOrder: create_bundle_order returned no order id");
  }

  return { orderId: data };
}
