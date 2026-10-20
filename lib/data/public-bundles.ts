import "server-only";
import type { AlternateSlugs } from "@/lib/i18n/alternates";

import { headers } from "next/headers";
import { cache } from "react";

import { type BundleAction, resolveBookAction } from "@/lib/catalog/book-action";
import { coverPublicUrl } from "@/lib/catalog/covers";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import { arePaymentsEnabled } from "@/lib/commerce/payment-provider";
import { getServerEnv } from "@/lib/config/server-env";
import { getActiveEntitlementBookIds, getBookCards } from "@/lib/data/catalog";
import { getCurrentProfile } from "@/lib/data/profiles";
import { isLocale, type Locale } from "@/lib/i18n/config";
import { getRequestId } from "@/lib/observability/request-id";
import { createPublicClient } from "@/lib/supabase/public";

// Public bundle reads (S9 spec 6.3). Bundles have no read RPC of their own: the three public bundle
// tables and a published bundle's offer are readable under RLS (20260924110000, 20260924130000), so
// this reads them with the cookie-less public client and lets the policies do the filtering.
//
// The one exception is the cover, whose storage_key is withheld from every browser role by the
// column grant in 20260911200000 - that comes from catalog_bundle_cover, a definer read scoped to
// published bundles.
//
// getPublicBundle itself never reads the session, so the bundle page can be prerendered. Ownership
// is the one per-reader fact this module has, and it lives in getBundleOwnership below, which comes
// from the session client through getActiveEntitlementBookIds, never from a policy an admin could
// see past.

const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type PublicBundleDTO = {
  bundleId: string;
  slug: string;
  // The other locale's slug, when the bundle is localized there. Null makes the page single-locale:
  // no hreflang alternate, no locale switch.
  alternateSlugs: AlternateSlugs;
  title: string;
  subtitle: string | null;
  description: string | null;
  cover: { url: string; alt: string } | null;
  // Only a live offer of a published bundle reaches this type - the read policy enforces the window
  // and the `active` flag, so there is no inactive offer to represent.
  offer: { priceMinor: number; currency: string } | null;
  // The members the storefront can actually show, in bundle_books.position order. A member that is
  // not a published, locale-localized book is absent, not marked.
  members: CatalogBookCard[];
};

async function currentRequestId(): Promise<string | null> {
  try {
    return getRequestId(await headers());
  } catch {
    return null;
  }
}

// Same contract as lib/data/catalog.ts's failure(): the caller gets a generic message and the
// database detail is logged once, with the request ID.
async function failure(operation: string, cause: unknown): Promise<Error> {
  console.error("Bundle read failed.", {
    operation,
    code: (cause as { code?: string } | null)?.code ?? null,
    message: (cause as { message?: string } | null)?.message ?? String(cause),
    requestId: await currentRequestId(),
  });
  return new Error(`${operation} failed.`, { cause });
}

type BundleRow = {
  id: string;
  localizations: { locale: string; slug: string; title: string; subtitle: string | null; description: string | null }[];
  members: { book_id: string; position: number }[];
};

const bundleSelect = `
  id,
  localizations:bundle_localizations ( locale, slug, title, subtitle, description ),
  members:bundle_books ( book_id, position )
`;

// The RPC applies the rule and returns at most one row; this only shapes it.
function liveOffer(row: { price_minor: number; currency: string } | null): PublicBundleDTO["offer"] {
  return row ? { priceMinor: Number(row.price_minor), currency: row.currency } : null;
}

export const getPublicBundle = cache(async (locale: Locale, slug: string): Promise<PublicBundleDTO | null> => {
  if (!slugPattern.test(slug)) return null;

  const supabase = createPublicClient();
  // The slug identifies the bundle in one locale; everything below is about the bundle, including
  // the OTHER locale's slug, which is why this is resolved first rather than folded into one query
  // with an inner join that would filter the alternate localization away with it.
  const { data: localization, error } = await supabase
    .from("bundle_localizations")
    .select("bundle_id")
    .eq("locale", locale)
    .eq("slug", slug)
    .maybeSingle();

  if (error) throw await failure("getPublicBundle", error);
  if (!localization) return null;

  const bundleId = localization.bundle_id;
  // The price comes from catalog_bundle_live_offer: the one market-resolution rule this page
  // shares with create_bundle_order, behind a published-bundle gate, because the rule itself is
  // status-blind and readable by anyone this function is granted to. A bundle may be priced per (market, currency), so choosing among several
  // live offers is a rule - and while this page stated that rule for itself, it stated it
  // differently from the RPC that actually charges the reader: the page showed the cheapest, the
  // order took the first by market code, and neither filtered the other's way. A page that quotes
  // one price and a checkout that charges another is the defect; sharing the rule is the fix.
  const [{ data: row, error: rowError }, { data: coverRows, error: coverError }, { data: offerRows, error: offerError }, cards] =
    await Promise.all([
      supabase.from("bundles").select(bundleSelect).eq("id", bundleId).maybeSingle(),
      supabase.rpc("catalog_bundle_cover", { p_bundle_id: bundleId }),
      supabase.rpc("catalog_bundle_live_offer", { p_bundle_id: bundleId }),
      getBookCards(locale),
    ]);

  if (rowError) throw await failure("getPublicBundle", rowError);
  if (coverError) throw await failure("getPublicBundle", coverError);
  if (offerError) throw await failure("getPublicBundle", offerError);
  // The bundle was unpublished between the two reads, so it is a 404 rather than a half page.
  if (!row) return null;

  const bundle = row as unknown as BundleRow;
  const current = bundle.localizations.find((candidate) => candidate.locale === locale);
  if (!current) return null;
  const alternateSlugs = Object.fromEntries(
    bundle.localizations.filter((candidate) => candidate.locale !== locale && isLocale(candidate.locale)).map((candidate) => [candidate.locale, candidate.slug]),
  );

  const byBookId = new Map(cards.map((card) => [card.bookId, card]));
  const members = [...bundle.members]
    .sort((a, b) => a.position - b.position)
    .flatMap((member) => {
      const card = byBookId.get(member.book_id);
      return card ? [card] : [];
    });

  const cover = (coverRows ?? [])[0];

  return {
    bundleId: bundle.id,
    slug: current.slug,
    alternateSlugs: alternateSlugs,
    title: current.title,
    subtitle: current.subtitle,
    description: current.description,
    cover: cover ? { url: coverPublicUrl(cover.storage_key), alt: cover.alt_text } : null,
    offer: liveOffer((offerRows ?? [])[0] ?? null),
    members,
  };
});

// How many of a bundle's visible members the current viewer already holds. Zero when signed out.
// Split out of getPublicBundle so that read stays session-free and the bundle page can be
// prerendered; this one is called from the route handler the page's island fetches.
export async function getBundleOwnership(members: CatalogBookCard[]): Promise<number> {
  const profile = await getCurrentProfile();
  if (!profile) return 0;

  const owned = await getActiveEntitlementBookIds(profile.id);
  return members.filter((member) => owned.has(member.bookId)).length;
}

// The bundle counterpart of getBookActionState. It takes the counts the caller already resolved
// (getPublicBundle's members plus getBundleOwnership) rather than reading entitlements a second
// time; getCurrentProfile is memoized per render, so the only thing this adds is whether to offer a
// Buy form or a sign-in link. Only the route handler behind the bundle page's island calls it now.
export async function getBundleActionState(bundle: {
  publishedMemberCount: number;
  ownedMemberCount: number;
  offer: PublicBundleDTO["offer"];
}): Promise<{ action: BundleAction; signedIn: boolean }> {
  const profile = await getCurrentProfile();

  const action = resolveBookAction({
    kind: "bundle",
    publishedMemberCount: bundle.publishedMemberCount,
    ownedMemberCount: bundle.ownedMemberCount,
    offer: bundle.offer ? { priceMinor: bundle.offer.priceMinor, active: true } : null,
    paymentsEnabled: arePaymentsEnabled(getServerEnv()),
  });
  return { action, signedIn: profile !== null };
}

// Resolves a bundle by id in ONE locale, for the route handler the bundle page's island fetches
// (which only has the id, not the locale-specific slug). The island sends the locale it rendered
// in - the page only ever renders in a locale the bundle is localized in - so this never needs to
// search the other locale: doing that once produced a bundle whose `members` (and so
// ownedMemberCount's denominator) belonged to a different locale than the one the caller asked for.
export async function getPublicBundleById(locale: Locale, bundleId: string): Promise<PublicBundleDTO | null> {
  const { data, error } = await createPublicClient()
    .from("bundle_localizations")
    .select("slug")
    .eq("locale", locale)
    .eq("bundle_id", bundleId)
    .maybeSingle();
  if (error) throw await failure("getPublicBundleById", error);
  if (!data) return null;

  return getPublicBundle(locale, data.slug);
}

// What an anonymous visitor could do with this bundle: the same rule as getBundleActionState, minus
// the ownership the viewer might hold. A page renders this so it can be prerendered; the viewer's
// own state arrives from /api/catalog/bundles/[bundleId]/action-state. Mirrors publicBookAction in
// lib/data/catalog.ts and the position lib/seo/json-ld.ts already takes for structured data.
export function publicBundleAction(bundle: Pick<PublicBundleDTO, "members" | "offer">): BundleAction {
  return resolveBookAction({
    kind: "bundle",
    publishedMemberCount: bundle.members.length,
    ownedMemberCount: 0,
    offer: bundle.offer ? { priceMinor: bundle.offer.priceMinor, active: true } : null,
    paymentsEnabled: arePaymentsEnabled(getServerEnv()),
  });
}

// Every published, localized bundle URL, for app/sitemap.ts. The read policy already limits this to
// published bundles; a locale this build does not serve is dropped here rather than turned into a
// URL no route can answer.
export async function listPublicBundleSlugs(): Promise<{ locale: Locale; slug: string }[]> {
  const { data, error } = await createPublicClient().from("bundle_localizations").select("locale, slug");
  if (error) throw await failure("listPublicBundleSlugs", error);

  return ((data ?? []) as { locale: string; slug: string }[]).flatMap((row) =>
    isLocale(row.locale) ? [{ locale: row.locale, slug: row.slug }] : [],
  );
}
