import "server-only";
import { type Locale } from "@/lib/i18n/config";

import { notFound } from "next/navigation";

import { requireAdmin } from "@/lib/auth/admin";
import {
  checkBundleReadiness,
  parseBundleReadinessError,
  type BundleReadiness,
  type BundleReadinessIssueCode,
} from "@/lib/catalog/bundle-readiness";
import { coverPublicUrl } from "@/lib/catalog/covers";
import type {
  BundleLocalizationInput,
  BundleMembersInput,
  BundleOfferInput,
  CreateBundleInput,
} from "@/lib/catalog/schemas";
import { readBundleCover } from "@/lib/data/bundle-covers";
import { createClient } from "@/lib/supabase/server";

// Every function here runs requireAdmin() before building a client. Reads go through the session
// client under the "admin reads …" policies from 20260924110000; every write goes through one of
// the audited definer RPCs in 20260924120000, because bundles have no browser write grant at all -
// not a missing policy, a missing privilege.

export class BundleNotFoundError extends Error {
  constructor() {
    super("This bundle no longer exists.");
    this.name = "BundleNotFoundError";
  }
}

export class DuplicateBundleSlugError extends Error {
  constructor() {
    super("A bundle with this locale and slug already exists.");
    this.name = "DuplicateBundleSlugError";
  }
}

export class BundleNotReadyError extends Error {
  readonly issues: BundleReadinessIssueCode[];

  constructor(issues: BundleReadinessIssueCode[]) {
    super("This bundle is not ready to publish.");
    this.name = "BundleNotReadyError";
    this.issues = issues;
  }
}

type DatabaseError = { code?: string; message: string };

function failure(operation: string, error: DatabaseError): Error {
  if (error.code === "P0002") return new BundleNotFoundError();
  if (error.code === "23505" && error.message.includes("bundle_localizations_locale_slug_key")) {
    return new DuplicateBundleSlugError();
  }
  return new Error(`${operation} failed.`);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string) {
  if (!uuidPattern.test(value)) throw new BundleNotFoundError();
}

export type AdminBundleLocalizationDTO = {
  id: string;
  locale: Locale;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
};

export type AdminBundleMemberDTO = {
  bookId: string;
  position: number;
  title: string;
  canonicalKey: string;
  published: boolean;
};

export type AdminBundleOfferDTO = {
  id: string;
  marketCode: string;
  currency: string;
  priceMinor: number;
  active: boolean;
};

export type AdminBundleDTO = {
  id: string;
  status: "draft" | "published" | "archived";
  createdAt: string;
  updatedAt: string;
  localizations: AdminBundleLocalizationDTO[];
  members: AdminBundleMemberDTO[];
  // Every offer, not the "current" one. A bundle is priced per (market, currency) and
  // admin_set_bundle_offer upserts on that key, so an editor holding a single offer would strand
  // the rows it is not showing - and the storefront resolves the live offer from all of them.
  offers: AdminBundleOfferDTO[];
  // No storage key: it is server-private (20260913100000), and the editor only needs to show the
  // image and its alt text.
  cover: { altText: string; publicUrl: string } | null;
  readiness: BundleReadiness;
};

export type AdminBundleListItemDTO = {
  id: string;
  title: string;
  status: AdminBundleDTO["status"];
  memberCount: number;
  publishedMemberCount: number;
  readiness: BundleReadiness;
};

type OfferRow = {
  id: string;
  market_code: string;
  currency: string;
  price_minor: number;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
};

type MemberBookRow = {
  id: string;
  canonical_key: string;
  status: string;
  localizations: { locale: string; title: string }[];
};

type BundleRow = {
  id: string;
  status: AdminBundleDTO["status"];
  created_at: string;
  updated_at: string;
  localizations: {
    id: string;
    locale: Locale;
    slug: string;
    title: string;
    subtitle: string | null;
    description: string | null;
  }[];
  // `book` is a to-one embed; PostgREST returns it as an object or a one-element array depending
  // on how it resolves the relationship, so oneOrNull() accepts both.
  members: { position: number; book: MemberBookRow | MemberBookRow[] | null }[];
  offers: OfferRow[];
};

const bundleSelect = `
  id,
  status,
  created_at,
  updated_at,
  localizations:bundle_localizations ( id, locale, slug, title, subtitle, description ),
  members:bundle_books ( position, book:books ( id, canonical_key, status, localizations:book_localizations ( locale, title ) ) ),
  offers ( id, market_code, currency, price_minor, active, starts_at, ends_at )
`;

function oneOrNull<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

const localeOrder: Record<string, number> = { vi: 0, en: 1 };

// The editor's readiness has to mean the same thing publish_bundle and the storefront mean by a
// live offer, which since 20260925100000 includes a positive price: a free active offer passed the
// old publish gate and then produced a bundle page that could not be bought, because
// create_bundle_order sells only a price above 0.
function isOfferLive(offer: OfferRow, now: Date) {
  return (
    offer.active &&
    offer.price_minor > 0 &&
    (offer.starts_at === null || new Date(offer.starts_at) <= now) &&
    (offer.ends_at === null || new Date(offer.ends_at) > now)
  );
}

function sortedLocalizations(row: BundleRow): AdminBundleLocalizationDTO[] {
  return [...row.localizations].sort((a, b) => (localeOrder[a.locale] ?? 9) - (localeOrder[b.locale] ?? 9));
}

// A member's admin label: the Vietnamese title if there is one, else any localized title, else the
// canonical key. The editor lists members for an operator, so a title is worth preferring over an
// identifier, and the key is a guaranteed fallback.
function memberTitle(book: MemberBookRow): string {
  const sorted = [...(book.localizations ?? [])].sort(
    (a, b) => (localeOrder[a.locale] ?? 9) - (localeOrder[b.locale] ?? 9),
  );
  return sorted[0]?.title ?? book.canonical_key;
}

function sortedMembers(row: BundleRow): AdminBundleMemberDTO[] {
  return [...row.members]
    .sort((a, b) => a.position - b.position)
    .flatMap((member) => {
      const book = oneOrNull(member.book);
      if (!book) return [];
      return [
        {
          bookId: book.id,
          position: member.position,
          title: memberTitle(book),
          canonicalKey: book.canonical_key,
          published: book.status === "published",
        },
      ];
    });
}

// One `now` for the whole verdict, so two offers of the same bundle are never judged against two
// different instants.
function readinessOf(
  members: AdminBundleMemberDTO[],
  localizations: AdminBundleLocalizationDTO[],
  offers: OfferRow[],
  hasCover: boolean,
  now: Date,
): BundleReadiness {
  return checkBundleReadiness({
    members: members.map((member) => ({ published: member.published })),
    localizations: localizations.map((localization) => ({
      title: localization.title,
      slug: localization.slug,
      description: localization.description,
    })),
    hasCover,
    hasActiveOffer: offers.some((offer) => isOfferLive(offer, now)),
  });
}

// A bundle an admin opened from a stale link is a 404, not a server error - the same treatment
// getAdminBook gives a missing book.
export async function getAdminBundle(bundleId: string): Promise<AdminBundleDTO> {
  await requireAdmin();
  if (!uuidPattern.test(bundleId)) notFound();

  const supabase = await createClient();
  const [{ data: row, error }, cover] = await Promise.all([
    supabase.from("bundles").select(bundleSelect).eq("id", bundleId).maybeSingle(),
    readBundleCover(bundleId),
  ]);

  if (error) throw failure("getAdminBundle", error);
  if (!row) notFound();

  const bundle = row as unknown as BundleRow;
  const localizations = sortedLocalizations(bundle);
  const members = sortedMembers(bundle);
  const offers = bundle.offers ?? [];
  // One offer per (bundle, market, currency), ordered by that key so the editor's rows are stable
  // across renders.
  const sortedOffers = [...offers].sort(
    (a, b) => a.market_code.localeCompare(b.market_code) || a.currency.localeCompare(b.currency),
  );

  return {
    id: bundle.id,
    status: bundle.status,
    createdAt: bundle.created_at,
    updatedAt: bundle.updated_at,
    localizations,
    members,
    offers: sortedOffers.map((offer) => ({
      id: offer.id,
      marketCode: offer.market_code,
      currency: offer.currency,
      priceMinor: offer.price_minor,
      active: offer.active,
    })),
    cover: cover ? { altText: cover.altText, publicUrl: coverPublicUrl(cover.storageKey) } : null,
    readiness: readinessOf(members, localizations, offers, cover !== null, new Date()),
  };
}

export async function listAdminBundles(): Promise<AdminBundleListItemDTO[]> {
  await requireAdmin();

  const supabase = await createClient();
  const [{ data: rows, error }, { data: covers, error: coverError }] = await Promise.all([
    supabase.from("bundles").select(bundleSelect).order("updated_at", { ascending: false }),
    // The list needs only the presence of a cover for readiness. storage_key stays unavailable to
    // browser roles by design, so it is not selected here; the editor reads it with the service
    // role through lib/data/bundle-covers.ts.
    supabase.from("media_assets").select("owner_id").eq("owner_type", "bundle").eq("kind", "cover"),
  ]);

  if (error) throw failure("listAdminBundles", error);
  if (coverError) throw failure("listAdminBundles: covers", coverError);

  const withCover = new Set(((covers ?? []) as { owner_id: string }[]).map((cover) => cover.owner_id));
  const now = new Date();

  return ((rows ?? []) as unknown as BundleRow[]).map((row) => {
    const localizations = sortedLocalizations(row);
    const members = sortedMembers(row);
    return {
      id: row.id,
      title: localizations[0]?.title ?? row.id,
      status: row.status,
      memberCount: members.length,
      publishedMemberCount: members.filter((member) => member.published).length,
      readiness: readinessOf(members, localizations, row.offers ?? [], withCover.has(row.id), now),
    };
  });
}

export async function createBundle(input: CreateBundleInput): Promise<{ bundleId: string }> {
  await requireAdmin();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_create_bundle", {
    p_locale: input.locale,
    p_slug: input.slug,
    p_title: input.title,
  });

  if (error) throw failure("createBundle", error);
  if (typeof data !== "string" || data.length === 0) throw new Error("createBundle: admin_create_bundle returned no bundle id");
  return { bundleId: data };
}

export async function saveBundleLocalization(bundleId: string, input: BundleLocalizationInput): Promise<void> {
  await requireAdmin();
  assertUuid(bundleId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_save_bundle_localization", {
    p_bundle_id: bundleId,
    p_locale: input.locale,
    p_slug: input.slug,
    p_title: input.title,
    p_subtitle: input.subtitle,
    p_description: input.description,
  });

  if (error) throw failure("saveBundleLocalization", error);
}

// The submitted list IS the order: admin_set_bundle_members numbers it with `with ordinality`.
export async function setBundleMembers(bundleId: string, input: BundleMembersInput): Promise<void> {
  await requireAdmin();
  assertUuid(bundleId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_bundle_members", {
    p_bundle_id: bundleId,
    p_book_ids: input.bookIds,
  });

  if (error) throw failure("setBundleMembers", error);
}

export async function setBundleOffer(bundleId: string, input: BundleOfferInput): Promise<void> {
  await requireAdmin();
  assertUuid(bundleId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_bundle_offer", {
    p_bundle_id: bundleId,
    p_market_code: input.marketCode,
    p_currency: input.currency,
    p_price_minor: input.priceMinor,
    p_active: input.active,
  });

  if (error) throw failure("setBundleOffer", error);
}

export async function publishBundle(bundleId: string): Promise<void> {
  await requireAdmin();
  assertUuid(bundleId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("publish_bundle", { p_bundle_id: bundleId });
  if (!error) return;
  if (error.code === "EB026") throw new BundleNotReadyError(parseBundleReadinessError(error.message) ?? []);
  throw failure("publishBundle", error);
}

export async function unpublishBundle(bundleId: string): Promise<void> {
  await requireAdmin();
  assertUuid(bundleId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("unpublish_bundle", { p_bundle_id: bundleId });
  if (error) throw failure("unpublishBundle", error);
}
