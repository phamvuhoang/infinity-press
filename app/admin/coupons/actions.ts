"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/auth/admin";
import {
  fieldErrorsFrom,
  readBoolean,
  readInteger,
  readList,
  readOptionalInteger,
  readOptionalText,
  readText,
  type AdminFormState,
} from "@/lib/catalog/form";
import { couponSchema } from "@/lib/catalog/schemas";
import { CouponValueLockedError, DuplicateCouponCodeError, createCoupon, updateCoupon } from "@/lib/data/coupons";

const genericFailure = "Something went wrong saving. Try again.";
const duplicateFailure = "That code already exists.";

function parse(formData: FormData) {
  return couponSchema.safeParse({
    code: readText(formData, "code"),
    kind: readText(formData, "kind"),
    percentOff: readOptionalInteger(formData, "percentOff"),
    amountOffMinor: readOptionalInteger(formData, "amountOffMinor"),
    currency: readOptionalText(formData, "currency")?.toUpperCase() ?? null,
    startsAt: readOptionalText(formData, "startsAt"),
    endsAt: readOptionalText(formData, "endsAt"),
    active: readBoolean(formData, "active"),
    maxRedemptions: readOptionalInteger(formData, "maxRedemptions"),
    maxRedemptionsPerProfile: readInteger(formData, "maxRedemptionsPerProfile") ?? 1,
    note: readOptionalText(formData, "note"),
    bookIds: readList(formData, "bookIds"),
    // Read as its own field, never derived from bookIds (S9 spec 8).
    bundleIds: readList(formData, "bundleIds"),
  });
}

export async function createCouponAction(_previous: AdminFormState, formData: FormData): Promise<AdminFormState> {
  await requireAdmin({ next: "/admin/coupons/new" });

  const parsed = parse(formData);
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error), formError: null, savedAt: null };

  let couponId: string;
  try {
    couponId = await createCoupon(parsed.data);
  } catch (error) {
    // The operator retypes a code rather than reading a generic failure and wondering what broke.
    if (error instanceof DuplicateCouponCodeError) {
      return { fieldErrors: { code: duplicateFailure }, formError: null, savedAt: null };
    }
    return { fieldErrors: {}, formError: genericFailure, savedAt: null };
  }

  revalidatePath("/admin/coupons");
  redirect(`/admin/coupons/${couponId}`);
}

export async function updateCouponAction(
  couponId: string,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/coupons/${couponId}` });

  const parsed = parse(formData);
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error), formError: null, savedAt: null };

  try {
    await updateCoupon(couponId, parsed.data);
  } catch (error) {
    if (error instanceof CouponValueLockedError) {
      return { fieldErrors: {}, formError: error.message, savedAt: null };
    }
    return { fieldErrors: {}, formError: genericFailure, savedAt: null };
  }

  revalidatePath("/admin/coupons");
  revalidatePath(`/admin/coupons/${couponId}`);
  return { fieldErrors: {}, formError: null, savedAt: Date.now() };
}
