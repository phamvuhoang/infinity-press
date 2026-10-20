"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { requireAdmin } from "@/lib/auth/admin";
import { giftCheckoutSchema } from "@/lib/commerce/gift-form";
import {
  GiftAlreadyClaimedError,
  GiftNotFoundError,
  GiftNotSendableError,
  reissueGift,
  resendGift,
} from "@/lib/data/gifts";
import { defaultLocale, isLocale } from "@/lib/i18n/config";
import { getRequestId } from "@/lib/observability/request-id";

// The two support mutations behind /admin/gifts (S9 spec 7.4). Each one calls requireAdmin itself:
// a Server Action is a POST endpoint reachable by anyone who can send the request, so the page
// having rendered the form is not the authorization.
//
// Every runtime export below is an async function; only type exports are safe beside them.

export type GiftActionState = { status: "idle" } | { status: "done"; message: string } | { status: "error"; message: string };

export const initialGiftActionState: GiftActionState = { status: "idle" };

const GIFTS_PATH = "/admin/gifts";
const genericFailure = "Something went wrong. Try again.";

// A named refusal is the operator's instruction and is shown as it stands. Anything else is a
// fault they cannot act on, and its text may carry infrastructure detail - so it is logged against
// the request id and replaced. The log names the gift id, never the recipient address, the token,
// or the claim path.
async function failureMessage(error: unknown, action: string, giftId: string): Promise<string> {
  if (error instanceof GiftNotSendableError || error instanceof GiftAlreadyClaimedError || error instanceof GiftNotFoundError) {
    return error.message;
  }
  console.error(`${action} failed.`, { giftId, requestId: getRequestId(await headers()), error: String(error) });
  return genericFailure;
}

export async function resendGiftAction(
  giftId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- required by useActionState
  _previous: GiftActionState,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- required by useActionState
  _formData: FormData,
): Promise<GiftActionState> {
  await requireAdmin({ next: GIFTS_PATH });

  try {
    await resendGift(giftId);
  } catch (error) {
    return { status: "error", message: await failureMessage(error, "Resend gift", giftId) };
  }

  revalidatePath(GIFTS_PATH);
  return { status: "done", message: "The claim email is queued to go out again to the same address." };
}

export async function reissueGiftAction(
  giftId: string,
  _previous: GiftActionState,
  formData: FormData,
): Promise<GiftActionState> {
  await requireAdmin({ next: GIFTS_PATH });

  // The same shape and normalization the purchaser's own form uses, so an operator correcting an
  // address cannot store one the checkout would have rejected.
  const parsed = giftCheckoutSchema.shape.recipientEmail.safeParse(String(formData.get("recipientEmail") ?? ""));
  if (!parsed.success) {
    return { status: "error", message: "Enter the new recipient's email address." };
  }

  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { status: "error", message: "Enter a reason before reissuing this gift." };

  // The locale the recipient's message is rendered in. Validated rather than trusted: it becomes
  // the first segment of the claim path the worker reads back.
  const rawLocale = String(formData.get("locale") ?? "");
  const locale = isLocale(rawLocale) ? rawLocale : defaultLocale;

  try {
    await reissueGift(giftId, parsed.data, locale, reason);
  } catch (error) {
    return { status: "error", message: await failureMessage(error, "Reissue gift", giftId) };
  }

  revalidatePath(GIFTS_PATH);
  // No link, and no address either: the confirmation is about what happened, not about who it went
  // to. The operator already knows - they just typed it.
  return { status: "done", message: "The old link no longer works. A new claim email is queued." };
}
