"use server";

import { requireAdmin } from "@/lib/auth/admin";
import type { BundleReadinessIssueCode } from "@/lib/catalog/bundle-readiness";
import {
  fieldErrorsFrom,
  readBoolean,
  readInteger,
  readList,
  readOptionalText,
  readText,
  type AdminFormState,
} from "@/lib/catalog/form";
import { revalidateBundleAdmin } from "@/lib/catalog/revalidate";
import { bundleLocalizationSchema, bundleMembersSchema, bundleOfferSchema } from "@/lib/catalog/schemas";
import {
  BundleNotFoundError,
  BundleNotReadyError,
  DuplicateBundleSlugError,
  publishBundle,
  saveBundleLocalization,
  setBundleMembers,
  setBundleOffer,
  unpublishBundle,
} from "@/lib/data/bundles";
import { type Locale } from "@/lib/i18n/config";

// Each action gates on requireAdmin() for this editor before parsing, never returns raw database
// text, and revalidates the bundle pages only after the write succeeded.

const genericFailure = "Something went wrong saving. Try again.";

const saved = (): AdminFormState => ({ fieldErrors: {}, formError: null, savedAt: Date.now() });
const invalid = (error: Parameters<typeof fieldErrorsFrom>[0]): AdminFormState => ({
  fieldErrors: fieldErrorsFrom(error),
  formError: null,
  savedAt: null,
});

function knownFailure(error: unknown): AdminFormState {
  if (error instanceof DuplicateBundleSlugError) return { fieldErrors: { slug: error.message }, formError: null, savedAt: null };
  if (error instanceof BundleNotFoundError) return { fieldErrors: {}, formError: error.message, savedAt: null };
  return { fieldErrors: {}, formError: genericFailure, savedAt: null };
}

export async function saveBundleLocalizationAction(
  bundleId: string,
  locale: Locale,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/bundles/${bundleId}` });
  // The locale is bound by the server-rendered form, not read from the post: which localization a
  // form edits is not the submitter's to choose.
  const parsed = bundleLocalizationSchema.safeParse({
    locale,
    slug: readText(formData, "slug"),
    title: readText(formData, "title"),
    subtitle: readOptionalText(formData, "subtitle"),
    description: readOptionalText(formData, "description"),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await saveBundleLocalization(bundleId, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateBundleAdmin(bundleId);
  return saved();
}

// The form posts the complete ordered list of member ids; admin_set_bundle_members numbers it.
export async function setBundleMembersAction(
  bundleId: string,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/bundles/${bundleId}` });
  const parsed = bundleMembersSchema.safeParse({ bookIds: readList(formData, "bookIds") });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await setBundleMembers(bundleId, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateBundleAdmin(bundleId);
  return saved();
}

export async function setBundleOfferAction(
  bundleId: string,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/bundles/${bundleId}` });
  const parsed = bundleOfferSchema.safeParse({
    marketCode: readText(formData, "marketCode"),
    currency: readText(formData, "currency"),
    // readInteger maps a blank field to undefined, so a missing price is rejected as missing
    // rather than read as the valid free price 0.
    priceMinor: readInteger(formData, "priceMinor"),
    active: readBoolean(formData, "active"),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await setBundleOffer(bundleId, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateBundleAdmin(bundleId);
  return saved();
}

export type BundlePublishActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string; issues: BundleReadinessIssueCode[] };

const genericPublishFailure = "Something went wrong. Try again.";

export async function publishBundleAction(bundleId: string): Promise<BundlePublishActionResult> {
  await requireAdmin({ next: `/admin/bundles/${bundleId}` });
  try {
    await publishBundle(bundleId);
  } catch (error) {
    // The database is the gate; the editor's own verdict is only a preview of it.
    if (error instanceof BundleNotReadyError) return { ok: false, error: error.message, issues: error.issues };
    return { ok: false, error: genericPublishFailure, issues: [] };
  }
  revalidateBundleAdmin(bundleId);
  return { ok: true, message: "Bundle published." };
}

export async function unpublishBundleAction(bundleId: string): Promise<BundlePublishActionResult> {
  await requireAdmin({ next: `/admin/bundles/${bundleId}` });
  try {
    await unpublishBundle(bundleId);
  } catch {
    return { ok: false, error: genericPublishFailure, issues: [] };
  }
  revalidateBundleAdmin(bundleId);
  return { ok: true, message: "Bundle unpublished." };
}
