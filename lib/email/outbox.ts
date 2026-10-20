import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { buildBookReadyEmail } from "@/lib/email/book-ready";
import { buildGiftClaimEmail } from "@/lib/email/gift";
import { buildQuestionAnsweredEmail } from "@/lib/email/question-answered";
import { buildReviewRepliedEmail } from "@/lib/email/review-replied";
import { MailProviderError, type MailProvider } from "@/lib/email/provider";
import { type Locale, isLocale, resolveLocale } from "@/lib/i18n/config";
import { getCatalogRoutes, getKnowledgeRoutes, getLocaleRoutes } from "@/lib/i18n/routes";
import { resolveRequestId } from "@/lib/observability/request-id";
import type { Database, Json } from "@/lib/supabase/database.types";

// Notification delivery (spec S5 6.3, 9; S9 7.2). The caller passes a service-role client: the
// outbox RPCs execute as service_role only. Delivery data is resolved after the claim, so a message
// always reflects the current state rather than whatever was true when the row was written.
//
// Four templates, dispatched on template_key, sharing one batch loop:
//
//   * book_ready goes to the entitlement's owner, at their oldest verified address, in their own
//     profile locale, and reflects the current entitlement and public title.
//   * gift_claim goes to gifts.recipient_email - who may have no account at all - in the locale of
//     the claim path the purchaser configured, and carries that path made absolute. The path lives
//     only in the protected notification_outbox.payload, and claim_gift nulls it on claim.
//
//   * question_answered goes to the reader who asked, at their oldest verified address, with an
//     idea link built at SEND time (never stored) from the idea's localization in the locale the
//     question was asked in, falling back to the other locale's page when it has none (S13 spec 9).
//   * review_replied goes to the reviewer, at their oldest verified address, in the locale they
//     reviewed in, and carries the review's CURRENT author reply read at send time (S15). The
//     claim only hands over a row while the review is published with a reply; the re-check here
//     covers the race between claim and send.
//
// Logs carry only the request ID, the outbox ID, the template key, and safe codes - never a
// recipient email, a book title, a gift id, a gift message, a claim path, or provider text.

const MAX_BATCH = 25;
// Column limits enforced by check constraints on notification_outbox. The RPCs do not truncate, and
// an over-long value makes them raise, which would leave the row leased until the lease expires.
const MAX_ERROR_CODE_LENGTH = 100;
const MAX_PROVIDER_MESSAGE_ID_LENGTH = 200;

// The generator types every RPC OUT column as non-null, because Postgres does not describe
// nullability for a function's return columns. The schema is what actually holds: a row points at
// exactly one of an entitlement, a gift, a question or a review (notification_outbox_target_check),
// so these columns are null for one template and set for another. Modeling that here is what makes the
// narrowing below a real check rather than a cast.
type ClaimedRow = Omit<
  Database["public"]["Functions"]["claim_notification_outbox"]["Returns"][number],
  "entitlement_id" | "profile_id" | "gift_id" | "question_id" | "review_id" | "payload"
> & {
  entitlement_id: string | null;
  profile_id: string | null;
  gift_id: string | null;
  question_id: string | null;
  review_id: string | null;
  payload: Json | null;
};

// A book_ready row, narrowed: the two columns resolveBookReadyDelivery needs are known present.
type BookReadyRow = ClaimedRow & { entitlement_id: string; profile_id: string };

// A question_answered row, narrowed: the question, the asker and the payload naming the idea are present.
type QuestionRow = ClaimedRow & { question_id: string; profile_id: string; payload: Json };

// A review_replied row, narrowed: the review, the reviewer and the payload naming the book are present.
type ReviewRow = ClaimedRow & { review_id: string; profile_id: string; payload: Json };

type ReviewRepliedDelivery = {
  to: string;
  locale: Locale;
  recipientName: string | null;
  bookTitle: string | null;
  rating: number;
  reviewBody: string;
  reply: string;
  reviewUrl: string;
};

type Deps = {
  client: SupabaseClient<Database>;
  provider: MailProvider;
  siteUrl: string;
  from: string;
  leaseToken: string;
  limit?: number;
  requestId?: string;
};

export type DeliveryResult = {
  claimed: number;
  sent: number;
  failed: number;
  // Rows whose lease another worker took over before this one could complete or fail them.
  leaseLost: number;
};

class DeliveryDataError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DeliveryDataError";
  }
}

type BookReadyDelivery = { to: string; locale: Locale; recipientName: string | null; bookTitle: string | null };
type GiftDelivery = {
  to: string;
  locale: Locale;
  purchaserName: string | null;
  message: string | null;
  claimUrl: string;
  itemTitles: string[];
};
type QuestionAnsweredDelivery = {
  to: string;
  locale: Locale;
  recipientName: string | null;
  ideaTitle: string;
  ideaUrl: string;
};
// What a resolved delivery becomes: an addressed message, ready to hand to the provider.
type Message = { to: string; subject: string; text: string; html: string; idempotencyKey: string };

function dataUnavailable(): DeliveryDataError {
  return new DeliveryDataError("delivery_data_unavailable");
}

// A gift_claim row, narrowed: the gift and the payload a gift delivery needs are known present.
type GiftRow = ClaimedRow & { gift_id: string; payload: Json };

function asBookReadyRow(row: ClaimedRow): BookReadyRow {
  if (row.entitlement_id === null || row.profile_id === null) throw new DeliveryDataError("unsupported_template");
  return row as BookReadyRow;
}

function asGiftRow(row: ClaimedRow): GiftRow {
  if (row.gift_id === null) throw new DeliveryDataError("unsupported_template");
  return row as GiftRow;
}

function asQuestionRow(row: ClaimedRow): QuestionRow {
  if (row.question_id === null || row.profile_id === null || row.payload === null) {
    throw new DeliveryDataError("unsupported_template");
  }
  return row as QuestionRow;
}

function asReviewRow(row: ClaimedRow): ReviewRow {
  if (row.review_id === null || row.profile_id === null || row.payload === null) {
    throw new DeliveryDataError("unsupported_template");
  }
  return row as ReviewRow;
}

function readBookId(payload: Json): string {
  const bookId = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, Json>).bookId : null;
  if (typeof bookId !== "string" || !UUID.test(bookId)) throw new DeliveryDataError("review_payload_invalid");
  return bookId;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readIdeaId(payload: Json): string {
  const ideaId = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, Json>).ideaId : null;
  if (typeof ideaId !== "string" || !UUID.test(ideaId)) throw new DeliveryDataError("question_payload_invalid");
  return ideaId;
}

// The claim path is the only part of the payload this worker reads, and it is read defensively:
// the row is admin-writable by nobody, but a link built from an unvalidated stored value is a link
// that can point anywhere. It must be site-relative and must start with a known locale, because
// that locale is what the message is rendered in.
function readClaimPath(payload: Json): { path: string; locale: Locale } {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new DeliveryDataError("gift_payload_invalid");
  }
  const path = (payload as Record<string, Json>).claimPath;
  // "//host/path" is protocol-relative and would resolve against another origin, so a second
  // slash is rejected rather than merely a missing first one.
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new DeliveryDataError("gift_payload_invalid");
  }
  const locale = path.split("/")[1] ?? "";
  if (!isLocale(locale)) throw new DeliveryDataError("gift_payload_invalid");
  return { path, locale };
}

async function resolveBookReadyDelivery(client: SupabaseClient<Database>, row: BookReadyRow): Promise<BookReadyDelivery> {
  const entitlement = await client
    .from("entitlements")
    .select("id, book_id, profile_id, status")
    .eq("id", row.entitlement_id)
    .maybeSingle();
  if (entitlement.error) throw dataUnavailable();
  // The claim only returns active entitlements; this catches a revoke that lands in between.
  if (!entitlement.data || entitlement.data.status !== "active") throw new DeliveryDataError("entitlement_inactive");

  const [profile, identity] = await Promise.all([
    client.from("profiles").select("display_name, locale").eq("id", row.profile_id).maybeSingle(),
    client
      .from("customer_identities")
      .select("normalized_email")
      .eq("profile_id", row.profile_id)
      .not("verified_at", "is", null)
      .order("verified_at", { ascending: true })
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);
  if (profile.error || identity.error) throw dataUnavailable();
  if (!profile.data) throw new DeliveryDataError("profile_not_found");
  if (!identity.data) throw new DeliveryDataError("recipient_unverified");

  const locale = resolveLocale(profile.data.locale);
  // Only a published book's localization in the profile's own locale. No fallback to another
  // locale's copy: without one, the message uses generic copy.
  const localization = await client
    .from("book_localizations")
    .select("title, books!inner(status)")
    .eq("book_id", entitlement.data.book_id)
    .eq("locale", locale)
    .eq("books.status", "published")
    .maybeSingle();
  if (localization.error) throw dataUnavailable();

  return {
    to: identity.data.normalized_email,
    locale,
    recipientName: profile.data.display_name,
    bookTitle: localization.data?.title ?? null,
  };
}

async function resolveQuestionAnsweredDelivery(
  client: SupabaseClient<Database>,
  row: QuestionRow,
  siteUrl: string,
): Promise<QuestionAnsweredDelivery> {
  const ideaId = readIdeaId(row.payload);
  const [profile, identity, question] = await Promise.all([
    client.from("profiles").select("display_name").eq("id", row.profile_id).maybeSingle(),
    client
      .from("customer_identities")
      .select("normalized_email")
      .eq("profile_id", row.profile_id)
      .not("verified_at", "is", null)
      .order("verified_at", { ascending: true })
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle(),
    client.from("reader_questions").select("locale").eq("id", row.question_id).maybeSingle(),
  ]);
  if (profile.error || identity.error || question.error) throw dataUnavailable();
  if (!profile.data) throw new DeliveryDataError("profile_not_found");
  if (!identity.data) throw new DeliveryDataError("recipient_unverified");
  if (!question.data) throw new DeliveryDataError("question_not_found");

  // The locale the reader asked in (S13 spec 9), not their profile locale: the answer page and the
  // message copy follow the page they actually asked on.
  const locale = resolveLocale(question.data.locale);
  // The inner join on ideas.status keeps an idea unpublished since the answer was written from
  // yielding a link that 404s. A row with nothing to link to fails and is retried by the normal
  // lease cycle rather than sent with a dead link.
  const localizations = await client
    .from("idea_localizations")
    .select("locale, slug, question, ideas!inner(status)")
    .eq("idea_id", ideaId)
    .eq("ideas.status", "published");
  if (localizations.error) throw dataUnavailable();
  const chosen = localizations.data.find((l) => l.locale === locale) ?? localizations.data[0];
  if (!chosen || !isLocale(chosen.locale)) throw new DeliveryDataError("unsupported_locale");

  return {
    to: identity.data.normalized_email,
    locale: chosen.locale,
    recipientName: profile.data.display_name,
    ideaTitle: chosen.question,
    ideaUrl: new URL(getKnowledgeRoutes(chosen.locale).idea(chosen.slug), siteUrl).toString(),
  };
}

async function resolveReviewRepliedDelivery(
  client: SupabaseClient<Database>,
  row: ReviewRow,
  siteUrl: string,
): Promise<ReviewRepliedDelivery> {
  const bookId = readBookId(row.payload);
  const [profile, identity, review] = await Promise.all([
    client.from("profiles").select("display_name").eq("id", row.profile_id).maybeSingle(),
    client
      .from("customer_identities")
      .select("normalized_email")
      .eq("profile_id", row.profile_id)
      .not("verified_at", "is", null)
      .order("verified_at", { ascending: true })
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle(),
    client
      .from("book_reviews")
      .select("id, book_id, profile_id, status, author_reply, rating, body, locale")
      .eq("id", row.review_id)
      .maybeSingle(),
  ]);
  if (profile.error || identity.error || review.error) throw dataUnavailable();
  if (!profile.data) throw new DeliveryDataError("profile_not_found");
  if (!identity.data) throw new DeliveryDataError("recipient_unverified");
  if (!review.data) throw new DeliveryDataError("review_not_found");
  // The claim only hands over a published review with a reply; this catches a reader edit (back
  // to pending) or a cleared reply that landed in between. The row is simply not claimed again
  // until the review is visible, so this costs one attempt and never a wrong email.
  if (review.data.status !== "published" || review.data.author_reply === null) throw new DeliveryDataError("review_not_visible");

  // The review page 404s unless the book is published with a localization in the link's locale,
  // so the link and the copy follow the review's locale when it has one, else the other locale's,
  // as question_answered does. No localization at all fails rather than mailing a dead link; the
  // claim already holds back a hidden book's row, so this only fires in the claim/send race.
  const localizations = await client
    .from("book_localizations")
    .select("locale, title, books!inner(status)")
    .eq("book_id", bookId)
    .eq("books.status", "published");
  if (localizations.error) throw dataUnavailable();
  const reviewLocale = review.data.locale;
  const chosen = localizations.data.find((l) => l.locale === reviewLocale) ?? localizations.data.find((l) => isLocale(l.locale));
  if (!chosen || !isLocale(chosen.locale)) throw new DeliveryDataError("book_not_visible");
  const locale = chosen.locale;

  return {
    to: identity.data.normalized_email,
    locale,
    recipientName: profile.data.display_name,
    bookTitle: chosen.title,
    rating: review.data.rating,
    reviewBody: review.data.body,
    reply: review.data.author_reply,
    reviewUrl: new URL(getCatalogRoutes(locale).review(bookId), siteUrl).toString(),
  };
}

async function resolveGiftDelivery(
  client: SupabaseClient<Database>,
  row: GiftRow,
  siteUrl: string,
): Promise<GiftDelivery> {
  const { path, locale } = readClaimPath(row.payload);

  // Through a definer RPC, not a select on public.gifts: that table is granted to nobody at all,
  // service_role included (20260924150000), because every read of a gift goes through the
  // security-barrier view or a definer function. A plain select here was refused 42501 on every
  // attempt, and because that becomes a per-row DeliveryDataError rather than a thrown run, each
  // gift quietly burned its six attempts and retired undelivered. The RPC returns what this
  // message needs and nothing else - no claim_token_hash, no outbox payload.
  const gift = await client.rpc("gift_delivery_details", { p_gift_id: row.gift_id });
  if (gift.error) throw dataUnavailable();
  const details = gift.data?.[0];
  if (!details) throw new DeliveryDataError("gift_not_found");
  // claim_notification_outbox only claims a gift in `sent`, but the gift can be claimed or revoked
  // between the claim and here - and either way there is nothing left to deliver.
  if (details.status !== "sent") throw new DeliveryDataError("gift_not_sendable");

  const [purchaser, items] = await Promise.all([
    client.from("profiles").select("display_name").eq("id", details.purchaser_profile_id).maybeSingle(),
    // title_snapshot, not the live localization: the gift covers what was sold, under the name it
    // was sold as, and that is the same text claim_gift will report back to the recipient.
    client
      .from("order_items")
      .select("book_id, title_snapshot, position")
      .eq("order_id", details.order_id)
      .order("position", { ascending: true }),
  ]);
  if (purchaser.error || items.error) throw dataUnavailable();

  // One entry per book, not per line: a bundle order may hold two lines for one book, and claim_gift
  // grants access once. Keeping the first line by position keeps the shop's order.
  const seen = new Set<string>();
  const itemTitles: string[] = [];
  for (const item of items.data ?? []) {
    if (seen.has(item.book_id)) continue;
    seen.add(item.book_id);
    itemTitles.push(item.title_snapshot);
  }

  return {
    to: details.recipient_email,
    locale,
    // A purchaser without a profile row costs the message their name, not the gift itself.
    purchaserName: purchaser.data?.display_name ?? null,
    message: details.message,
    claimUrl: new URL(path, siteUrl).toString(),
    itemTitles,
  };
}

// The provider holds an idempotency key for 24 hours and requires a distinct key per distinct
// request. The outbox row id alone is not that: an admin resend and an admin reissue both rewind
// the SAME row, so every send it ever produced repeated one key. A resend inside the window was
// folded into the original request and the recipient got nothing; a reissue, which changes the
// address and the claim link, was rejected outright and then burned the row's six attempts.
//
// notification_outbox.delivery_generation separates a retry from a new delivery. A worker retry
// keeps the generation, so retry dedupe is unchanged. Only those two admin actions increment it.
//
// Generation 0 keys are spelled exactly as before, so a row already in flight when this deployed
// keeps the key its earlier attempts used, and nothing is sent twice across the upgrade.
function deliveryKey(template: string, row: ClaimedRow): string {
  return row.delivery_generation > 0 ? `${template}/${row.id}/${row.delivery_generation}` : `${template}/${row.id}`;
}

// The dispatch. Everything template-specific ends here: the batch loop below knows only that a row
// resolves to a message, or throws a DeliveryDataError carrying a safe code.
async function buildMessage(deps: Deps, row: ClaimedRow): Promise<Message> {
  if (row.template_key === "book_ready") {
    const delivery = await resolveBookReadyDelivery(deps.client, asBookReadyRow(row));
    return {
      to: delivery.to,
      ...buildBookReadyEmail({
        locale: delivery.locale,
        recipientName: delivery.recipientName,
        bookTitle: delivery.bookTitle,
        libraryUrl: new URL(getLocaleRoutes(delivery.locale).library, deps.siteUrl).toString(),
      }),
      idempotencyKey: deliveryKey("book-ready", row),
    };
  }
  if (row.template_key === "gift_claim") {
    const delivery = await resolveGiftDelivery(deps.client, asGiftRow(row), deps.siteUrl);
    return {
      to: delivery.to,
      ...buildGiftClaimEmail({
        locale: delivery.locale,
        purchaserName: delivery.purchaserName,
        message: delivery.message,
        claimUrl: delivery.claimUrl,
        itemTitles: delivery.itemTitles,
      }),
      idempotencyKey: deliveryKey("gift-claim", row),
    };
  }
  if (row.template_key === "question_answered") {
    const delivery = await resolveQuestionAnsweredDelivery(deps.client, asQuestionRow(row), deps.siteUrl);
    return {
      to: delivery.to,
      ...buildQuestionAnsweredEmail({
        locale: delivery.locale,
        recipientName: delivery.recipientName,
        ideaTitle: delivery.ideaTitle,
        ideaUrl: delivery.ideaUrl,
      }),
      idempotencyKey: deliveryKey("question-answered", row),
    };
  }
  if (row.template_key === "review_replied") {
    const delivery = await resolveReviewRepliedDelivery(deps.client, asReviewRow(row), deps.siteUrl);
    return {
      to: delivery.to,
      ...buildReviewRepliedEmail({
        locale: delivery.locale,
        recipientName: delivery.recipientName,
        bookTitle: delivery.bookTitle,
        rating: delivery.rating,
        reviewBody: delivery.reviewBody,
        reply: delivery.reply,
        reviewUrl: delivery.reviewUrl,
      }),
      idempotencyKey: deliveryKey("review-replied", row),
    };
  }
  throw new DeliveryDataError("unsupported_template");
}

function safeErrorCode(error: unknown): string {
  if (error instanceof MailProviderError || error instanceof DeliveryDataError) return error.code;
  return "provider_error";
}

export async function deliverNotificationBatch(deps: Deps): Promise<DeliveryResult> {
  const { client, provider, leaseToken } = deps;
  const requestId = resolveRequestId(deps.requestId);
  const limit = Math.max(1, Math.min(deps.limit ?? MAX_BATCH, MAX_BATCH));
  const result: DeliveryResult = { claimed: 0, sent: 0, failed: 0, leaseLost: 0 };

  const claim = await client.rpc("claim_notification_outbox", { p_limit: limit, p_lease_token: leaseToken });
  if (claim.error) {
    console.error("Notification outbox claim failed.", { requestId, code: claim.error.code ?? null });
    throw new Error("Notification outbox claim failed.");
  }

  const rows = (claim.data ?? []) as ClaimedRow[];
  result.claimed = rows.length;

  // Sequential on purpose: a small batch, and one row's failure must never stop the next one.
  for (const row of rows) {
    const outboxId = row.id;
    const template = row.template_key;
    let messageId: string;
    try {
      const message = await buildMessage(deps, row);
      ({ messageId } = await provider.send({ from: deps.from, ...message }));
    } catch (error) {
      const code = safeErrorCode(error).slice(0, MAX_ERROR_CODE_LENGTH);
      const failure = await client.rpc("fail_notification_outbox", {
        p_id: outboxId,
        p_lease_token: leaseToken,
        p_error_code: code,
      });
      if (failure.error) {
        console.error("Notification failure could not be recorded.", {
          requestId,
          outboxId,
          template,
          code,
          dbCode: failure.error.code ?? null,
        });
        result.failed += 1;
      } else if (failure.data === false) {
        console.warn("Notification lease lost before failure was recorded.", { requestId, outboxId, template, code });
        result.leaseLost += 1;
      } else {
        console.warn("Notification delivery failed.", { requestId, outboxId, template, code });
        result.failed += 1;
      }
      continue;
    }

    const completion = await client.rpc("complete_notification_outbox", {
      p_id: outboxId,
      p_lease_token: leaseToken,
      p_provider_message_id: messageId.slice(0, MAX_PROVIDER_MESSAGE_ID_LENGTH),
    });
    if (completion.error) {
      // The provider accepted the message, but the row stays leased and is retried after the lease
      // expires; the idempotency key keeps that retry from sending a second copy.
      console.error("Notification completion could not be recorded.", {
        requestId,
        outboxId,
        template,
        dbCode: completion.error.code ?? null,
      });
      result.failed += 1;
    } else if (completion.data === false) {
      console.warn("Notification lease lost before completion was recorded.", { requestId, outboxId, template });
      result.leaseLost += 1;
    } else {
      console.info("Notification email sent.", { requestId, outboxId, template });
      result.sent += 1;
    }
  }

  return result;
}
