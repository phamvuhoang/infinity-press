import { escapeHtml, fill, singleLine } from "@/lib/email/text";
import en from "@/lib/i18n/dictionaries/en.json";
import vi from "@/lib/i18n/dictionaries/vi.json";
import type { Locale } from "@/lib/i18n/config";
import { splitGraphemes } from "@/lib/reader/quote";

export type ReviewRepliedEmailInput = {
  locale: Locale;
  recipientName: string | null;
  // The book title in the review's locale, or null when the book has no localization there.
  bookTitle: string | null;
  rating: number;
  reviewBody: string;
  reply: string;
  // Absolute URL of the reviewer's own review page, built at send time.
  reviewUrl: string;
};

// Enough of the reviewer's own words to remember which review this is about, not the whole thing.
const CONTEXT_GRAPHEMES = 120;

const copy: Record<Locale, typeof en.email.reviewReplied> = {
  en: en.email.reviewReplied,
  vi: vi.email.reviewReplied,
};

function context(body: string): string {
  const units = splitGraphemes(body.trim());
  return units.length > CONTEXT_GRAPHEMES ? `${units.slice(0, CONTEXT_GRAPHEMES).join("")}…` : units.join("");
}

export function buildReviewRepliedEmail(input: ReviewRepliedEmailInput): { subject: string; text: string; html: string } {
  const strings = copy[input.locale];
  const name = input.recipientName?.trim() || null;
  const title = input.bookTitle?.trim() || null;

  const values = { name: name ?? "", title: title ?? "", rating: String(input.rating) };
  const subject = singleLine(fill(title ? strings.subjectWithTitle : strings.subjectGeneric, values));
  const greeting = fill(name ? strings.greetingNamed : strings.greetingGeneric, values);
  const intro = fill(title ? strings.introWithTitle : strings.introGeneric, values);
  const yourReview = fill(strings.yourReview, values);
  const excerpt = context(input.reviewBody);
  const reply = input.reply.trim();
  const signOff = strings.signOff.split("\n");

  const text = [
    greeting, "", intro, "",
    yourReview, excerpt, "",
    strings.authorReply, reply, "",
    `${strings.open}: ${input.reviewUrl}`, "",
    ...signOff, "",
  ].join("\n");

  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(intro)}</p>`,
    `<p>${escapeHtml(yourReview)}<br>${escapeHtml(excerpt)}</p>`,
    `<p>${escapeHtml(strings.authorReply)}<br>${escapeHtml(reply)}</p>`,
    `<p><a href="${escapeHtml(input.reviewUrl)}">${escapeHtml(strings.open)}</a></p>`,
    `<p>${signOff.map(escapeHtml).join("<br>")}</p>`,
  ].join("\n");

  return { subject, text, html };
}
