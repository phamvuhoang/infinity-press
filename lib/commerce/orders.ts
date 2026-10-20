import "server-only";

import { EmailNotVerifiedError } from "@/lib/access/grant";
import { requireUser } from "@/lib/auth/session";
import {
  AlreadyOwnedError,
  CurrencyNotPayableError,
  EditionRequiredError,
  NotPurchasableError,
  OfferChangedError,
  PaymentsDisabledError,
} from "@/lib/commerce/errors";
import { arePaymentsEnabled } from "@/lib/commerce/payment-provider";
import { getServerEnv } from "@/lib/config/server-env";
import type { Locale } from "@/lib/i18n/config";
import { createClient } from "@/lib/supabase/server";

// The error codes the order RPCs share. EB040 is only raised by create_edition_order.
function orderError(operation: string, rpc: string, error: { code?: string; message: string }): Error {
  if (error.code === "EB005") return new EmailNotVerifiedError();
  if (error.code === "EB011") return new PaymentsDisabledError();
  if (error.code === "EB012") return new NotPurchasableError();
  if (error.code === "EB013") return new AlreadyOwnedError();
  if (error.code === "EB040") return new OfferChangedError();
  if (error.code === "EB041") return new CurrencyNotPayableError();
  if (error.code === "EB042") return new EditionRequiredError();
  return new Error(`${operation}: ${rpc} failed: ${error.message}`);
}

// Paid order creation for ONE edition (Press spec 8). The app gate runs first; create_edition_order
// repeats it against commerce_settings and validates the whole chain - edition, offer, price,
// currency - inside one transaction. The profile is resolved there from the session; the reader never
// supplies one. expectedMinor is the price the reader was shown: a different current price is
// OfferChangedError rather than a surprise charge.
export async function createEditionOrder(
  locale: Locale,
  editionId: string,
  offerId: string,
  expectedMinor?: number,
): Promise<{ orderId: string }> {
  await requireUser(locale);
  if (!arePaymentsEnabled(getServerEnv())) throw new PaymentsDisabledError();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_edition_order", {
    p_edition_id: editionId,
    p_offer_id: offerId,
    ...(expectedMinor === undefined ? {} : { p_expected_minor: expectedMinor }),
  });

  if (error) throw orderError("createEditionOrder", "create_edition_order", error);
  if (typeof data !== "string" || data.length === 0) {
    throw new Error("createEditionOrder: create_edition_order returned no order id");
  }

  return { orderId: data };
}

// The work-level entry the book page still uses. create_ebook_order resolves to the one edition on
// sale and refuses (EditionRequiredError) when a work has several; it never picks a language.
export async function createEbookOrder(locale: Locale, bookId: string): Promise<{ orderId: string }> {
  await requireUser(locale);
  if (!arePaymentsEnabled(getServerEnv())) throw new PaymentsDisabledError();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_ebook_order", { p_book_id: bookId });

  if (error) throw orderError("createEbookOrder", "create_ebook_order", error);
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
