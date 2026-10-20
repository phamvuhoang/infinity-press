import "server-only";

import { notFound } from "next/navigation";

import { requireAdmin } from "@/lib/auth/admin";
import type { CreateEditionInput, CreateOfferInput, EditionInput } from "@/lib/catalog/schemas";
import { createClient } from "@/lib/supabase/server";

// Edition administration (spec section 6). Every function runs requireAdmin() before building a
// client and uses the session client: the RPCs check is_admin() through auth.uid(), which is null
// under the service role. An edition is always named explicitly; nothing here picks "the first".

export class EditionNotFoundError extends Error {
  constructor() {
    super("This edition no longer exists.");
    this.name = "EditionNotFoundError";
  }
}

export class DuplicateEditionError extends Error {
  constructor() {
    super("This work already has an edition with that language and number.");
    this.name = "DuplicateEditionError";
  }
}

export class UnknownLanguageError extends Error {
  constructor() {
    super("Choose a language from the list.");
    this.name = "UnknownLanguageError";
  }
}

export class EditionIdentityLockedError extends Error {
  constructor() {
    super("This edition has orders or readers, so its language cannot change. Create a new edition instead.");
    this.name = "EditionIdentityLockedError";
  }
}

type DatabaseError = { code?: string; message: string };

function failure(operation: string, error: DatabaseError): Error {
  if (error.code === "P0002") return new EditionNotFoundError();
  if (error.code === "23505" && error.message.includes("editions_book_id_language_code_edition_number_key")) {
    return new DuplicateEditionError();
  }
  if (error.code === "23503" && error.message.includes("language")) return new UnknownLanguageError();
  if (error.code === "23514") return new EditionIdentityLockedError();
  return new Error(`${operation} failed.`);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string) {
  if (!uuidPattern.test(value)) throw new EditionNotFoundError();
}

export type AdminOfferDTO = {
  id: string;
  marketCode: string;
  currency: string;
  priceMinor: number;
  active: boolean;
  isDefault: boolean;
  // effectivePriceMinor comes from offer_effective_price_minor, the same function the storefront
  // and checkout use, so the editor's "current price" cannot disagree with them.
  sale: { kind: "percent" | "fixed"; percentOff: number | null; amountOffMinor: number | null; startsAt: string | null; endsAt: string | null } | null;
  effectivePriceMinor: number;
  saleState: "none" | "running" | "scheduled" | "ended";
};

export type AdminEditionDTO = {
  id: string;
  bookId: string;
  languageCode: string;
  editionNumber: number;
  isbn: string | null;
  publicationDate: string | null;
  introduction: string | null;
  contributors: { role: string; name: string }[];
  status: "draft" | "published" | "archived";
  // The work's default edition for this language (book_language_editions).
  isDefault: boolean;
  activePublicationId: string | null;
  // True once an order or entitlement exists: the language and work then never change.
  identityLocked: boolean;
  sku: { id: string; skuCode: string; active: boolean } | null;
  offers: AdminOfferDTO[];
};

export type OfferRow = {
  id: string;
  market_code: string;
  currency: string;
  price_minor: number;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  sale_kind: "percent" | "fixed" | null;
  sale_percent_off: number | null;
  sale_amount_off_minor: number | null;
  sale_starts_at: string | null;
  sale_ends_at: string | null;
  offer_effective_price_minor: number;
};

export const offerColumns =
  "id, market_code, currency, price_minor, active, starts_at, ends_at, sale_kind, sale_percent_off, sale_amount_off_minor, sale_starts_at, sale_ends_at, offer_effective_price_minor";

// Running is read off the database's own answer; only the two not-running states use the clock.
function saleState(offer: OfferRow, now: Date): AdminOfferDTO["saleState"] {
  if (!offer.sale_kind) return "none";
  if (Number(offer.offer_effective_price_minor) < offer.price_minor) return "running";
  return offer.sale_starts_at !== null && new Date(offer.sale_starts_at) > now ? "scheduled" : "ended";
}

export function isOfferLive(offer: Pick<OfferRow, "active" | "starts_at" | "ends_at">, now: Date) {
  return (
    offer.active &&
    (offer.starts_at === null || new Date(offer.starts_at) <= now) &&
    (offer.ends_at === null || new Date(offer.ends_at) > now)
  );
}

export function toOfferDto(offer: OfferRow, isDefault: boolean, now = new Date()): AdminOfferDTO {
  return {
    id: offer.id,
    marketCode: offer.market_code,
    currency: offer.currency,
    priceMinor: offer.price_minor,
    active: offer.active,
    isDefault,
    sale: offer.sale_kind
      ? {
          kind: offer.sale_kind,
          percentOff: offer.sale_percent_off,
          amountOffMinor: offer.sale_amount_off_minor,
          startsAt: offer.sale_starts_at,
          endsAt: offer.sale_ends_at,
        }
      : null,
    effectivePriceMinor: Number(offer.offer_effective_price_minor),
    saleState: saleState(offer, now),
  };
}

type EditionRow = {
  id: string;
  book_id: string;
  language_code: string;
  edition_number: number;
  isbn: string | null;
  publication_date: string | null;
  introduction: string | null;
  contributors: { role: string; name: string }[] | null;
  status: AdminEditionDTO["status"];
  active_publication_id: string | null;
  skus: { id: string; sku_code: string; active: boolean; offers: OfferRow[] }[];
  default_offer: { offer_id: string } | { offer_id: string }[] | null;
};

function oneOrNull<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export async function getAdminEdition(bookId: string, editionId: string): Promise<AdminEditionDTO> {
  await requireAdmin();
  if (!uuidPattern.test(bookId) || !uuidPattern.test(editionId)) notFound();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("editions")
    .select(
      `id, book_id, language_code, edition_number, isbn, publication_date, introduction, contributors, status, active_publication_id,
       skus ( id, sku_code, active, offers ( ${offerColumns} ) ),
       default_offer:edition_default_offers ( offer_id )`,
    )
    .eq("id", editionId)
    .eq("book_id", bookId)
    .maybeSingle();
  if (error) throw failure("getAdminEdition", error);
  if (!data) notFound();
  const row = data as unknown as EditionRow;

  const [defaultEdition, entitlements, orderItems] = await Promise.all([
    supabase.from("book_language_editions").select("edition_id").eq("book_id", bookId).eq("language_code", row.language_code).maybeSingle(),
    supabase.from("entitlements").select("id", { count: "exact", head: true }).eq("edition_id", editionId),
    supabase.from("order_items").select("id", { count: "exact", head: true }).eq("edition_id", editionId),
  ]);
  if (defaultEdition.error) throw failure("getAdminEdition: default edition", defaultEdition.error);
  if (entitlements.error) throw failure("getAdminEdition: entitlements", entitlements.error);
  if (orderItems.error) throw failure("getAdminEdition: order items", orderItems.error);

  const sku = row.skus[0] ?? null;
  const defaultOfferId = oneOrNull(row.default_offer)?.offer_id ?? null;
  const now = new Date();

  return {
    id: row.id,
    bookId: row.book_id,
    languageCode: row.language_code,
    editionNumber: row.edition_number,
    isbn: row.isbn,
    publicationDate: row.publication_date,
    introduction: row.introduction,
    contributors: row.contributors ?? [],
    status: row.status,
    isDefault: (defaultEdition.data as { edition_id: string } | null)?.edition_id === row.id,
    activePublicationId: row.active_publication_id,
    identityLocked: (entitlements.count ?? 0) > 0 || (orderItems.count ?? 0) > 0,
    sku: sku ? { id: sku.id, skuCode: sku.sku_code, active: sku.active } : null,
    offers: (sku?.offers ?? []).map((offer) => toOfferDto(offer, offer.id === defaultOfferId, now)),
  };
}

export async function createEdition(bookId: string, input: CreateEditionInput): Promise<{ editionId: string }> {
  await requireAdmin();
  assertUuid(bookId);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_create_edition", {
    p_book_id: bookId,
    p_language_code: input.languageCode,
    p_edition_number: input.editionNumber,
    p_isbn: null,
    p_publication_date: null,
  });
  if (error) throw failure("createEdition", error);
  if (typeof data !== "string" || data.length === 0) throw new Error("createEdition returned no edition id");
  return { editionId: data };
}

export async function updateEdition(editionId: string, input: EditionInput): Promise<void> {
  await requireAdmin();
  assertUuid(editionId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_save_edition", {
    p_edition_id: editionId,
    p_isbn: input.isbn,
    p_edition_number: input.editionNumber,
    p_publication_date: input.publicationDate,
    p_introduction: input.introduction,
    p_contributors: input.contributors,
    p_language_code: input.languageCode,
  });
  if (error) throw failure("updateEdition", error);
}

export async function createOffer(editionId: string, input: CreateOfferInput): Promise<{ offerId: string }> {
  await requireAdmin();
  assertUuid(editionId);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_create_offer", {
    p_edition_id: editionId,
    p_market_code: input.marketCode,
    p_currency: input.currency,
    p_price_minor: input.priceMinor,
  });
  if (error) throw failure("createOffer", error);
  if (typeof data !== "string" || data.length === 0) throw new Error("createOffer returned no offer id");
  return { offerId: data };
}

export async function setDefaultOffer(editionId: string, offerId: string): Promise<void> {
  await requireAdmin();
  assertUuid(editionId);
  assertUuid(offerId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_default_offer", { p_edition_id: editionId, p_offer_id: offerId });
  if (error) throw failure("setDefaultOffer", error);
}

export async function setDefaultEdition(bookId: string, languageCode: string, editionId: string): Promise<void> {
  await requireAdmin();
  assertUuid(bookId);
  assertUuid(editionId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_default_edition", {
    p_book_id: bookId,
    p_language_code: languageCode,
    p_edition_id: editionId,
  });
  if (error) throw failure("setDefaultEdition", error);
}

export type PricingDefaultDTO = { marketCode: string; currency: string; priceMinor: number };

// The admin's templates for a language. They prefill a NEW offer and nothing else: changing a
// default never touches an existing offer.
export async function listPricingDefaults(languageCode: string): Promise<PricingDefaultDTO[]> {
  await requireAdmin();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("edition_pricing_defaults")
    .select("market_code, currency, price_minor")
    .eq("language_code", languageCode)
    .order("market_code");
  if (error) throw failure("listPricingDefaults", error);
  return ((data ?? []) as { market_code: string; currency: string; price_minor: number }[]).map((row) => ({
    marketCode: row.market_code,
    currency: row.currency,
    priceMinor: Number(row.price_minor),
  }));
}
