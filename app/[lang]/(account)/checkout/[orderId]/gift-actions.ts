"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { giftCheckoutSchema } from "@/lib/commerce/gift-form";
import { GiftNotConfigurableError, configureGift, removeGift } from "@/lib/commerce/gifts";
import { type Locale, defaultLocale, isLocale, withLocale } from "@/lib/i18n/config";
import { getCommerceRoutes } from "@/lib/i18n/routes";

// The purchaser's two gift operations on their own pending order (S9 spec 7.2). Every runtime
// export is an async function: a non-function export from a "use server" module builds cleanly and
// then crashes the client at request time.
//
// Nothing here returns, logs, or otherwise emits the claim token. configureGift generates it and
// hands it to the database inside the claim path; these actions never see it, and this file has no
// console call at all - the recipient's address and the purchaser's note would be the only things
// there were to log, and neither belongs in a log.

// A field error is reported as a CODE, not as a sentence: the message the reader sees comes from
// their own dictionary in the component, and Zod's messages are English-only.
export type GiftFieldError = "invalidEmail" | "messageTooLong";

export type GiftFormState =
  | { status: "idle" }
  | { status: "saved" }
  | { status: "invalid"; recipientEmail: GiftFieldError | null; message: GiftFieldError | null }
  // Every reason the order refuses a gift right now, collapsed into one: the database answers all
  // of them with one code so that an order id cannot be probed by the error it produces, and the
  // UI must not undo that by splitting it back apart.
  | { status: "unavailable" };

// The gate both actions share: a known locale, the reader's own session, and the path the action
// revalidates on success. It hands the NARROWED locale back, so neither action has to re-assert it.
async function gate(locale: string, orderId: string): Promise<{ locale: Locale; checkout: string }> {
  if (!isLocale(locale)) redirect(withLocale(defaultLocale, "/"));
  const checkout = getCommerceRoutes(locale).checkout(orderId);
  await requireUser(locale, checkout);
  return { locale, checkout };
}

export async function saveGiftAction(
  locale: string,
  orderId: string,
  _previous: GiftFormState,
  formData: FormData,
): Promise<GiftFormState> {
  const { locale: known, checkout } = await gate(locale, orderId);

  const parsed = giftCheckoutSchema.safeParse({
    recipientEmail: String(formData.get("recipientEmail") ?? ""),
    message: String(formData.get("message") ?? ""),
  });
  if (!parsed.success) {
    const fields = new Set(parsed.error.issues.map((issue) => issue.path[0]));
    return {
      status: "invalid",
      recipientEmail: fields.has("recipientEmail") ? "invalidEmail" : null,
      message: fields.has("message") ? "messageTooLong" : null,
    };
  }

  try {
    await configureGift(known, orderId, parsed.data);
  } catch (error) {
    if (error instanceof GiftNotConfigurableError) return { status: "unavailable" };
    throw error;
  }

  revalidatePath(checkout);
  return { status: "saved" };
}

export async function removeGiftAction(
  locale: string,
  orderId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- required by useActionState
  _previous: GiftFormState,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- required by useActionState
  _formData: FormData,
): Promise<GiftFormState> {
  const { locale: known, checkout } = await gate(locale, orderId);

  try {
    await removeGift(known, orderId);
  } catch (error) {
    if (error instanceof GiftNotConfigurableError) return { status: "unavailable" };
    throw error;
  }

  revalidatePath(checkout);
  return { status: "idle" };
}
