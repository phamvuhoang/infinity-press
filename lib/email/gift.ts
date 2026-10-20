import { escapeHtml, fill, singleLine } from "@/lib/email/text";
import en from "@/lib/i18n/dictionaries/en.json";
import vi from "@/lib/i18n/dictionaries/vi.json";
import type { Locale } from "@/lib/i18n/config";

// The gift claim message (S9 spec 7.2-7.3). Everything variable in it - the purchaser's display
// name, their note, and the gifted titles - is reader-supplied text arriving from three different
// tables, so this module escapes on the way into the HTML part and collapses the subject onto one
// line. The claim URL is escaped for the same reason: it is built from a stored path, and a path
// that could close an href attribute must not be allowed to.
//
// The recipient's address is NOT an input here. It is the envelope, chosen by the caller from
// gifts.recipient_email, and it is deliberately absent from the body: a forwarded message should
// not repeat who it was addressed to.

export type GiftClaimEmailInput = {
  locale: Locale;
  // Null when the purchaser has no display name, or only whitespace for one. The message then uses
  // generic copy rather than a blank space where a name should be.
  purchaserName: string | null;
  // The purchaser's optional note, already bounded to 500 characters by gifts_message_check.
  message: string | null;
  // Absolute `/{locale}/gifts/claim/<token>` URL. The one place the raw token appears.
  claimUrl: string;
  // Every distinct book the gift covers, in the order the shop sells them in. Empty renders no
  // list at all rather than an empty heading.
  itemTitles: string[];
};

const copy: Record<Locale, typeof en.email.giftClaim> = {
  en: en.email.giftClaim,
  vi: vi.email.giftClaim,
};

export function buildGiftClaimEmail(input: GiftClaimEmailInput): { subject: string; text: string; html: string } {
  const strings = copy[input.locale];
  const name = input.purchaserName?.trim() || null;
  const message = input.message?.trim() || null;
  const titles = input.itemTitles.map((title) => title.trim()).filter((title) => title.length > 0);

  const values = { name: name ?? "" };
  const subject = singleLine(fill(name ? strings.subjectFromName : strings.subjectGeneric, values));
  const intro = fill(name ? strings.introNamed : strings.introGeneric, values);
  const signOff = strings.signOff.split("\n");

  const text = [
    strings.greeting,
    "",
    intro,
    ...(message ? ["", strings.messageLabel, message] : []),
    ...(titles.length > 0 ? ["", strings.includesLabel, ...titles.map((title) => `- ${title}`)] : []),
    "",
    `${strings.claim}: ${input.claimUrl}`,
    "",
    strings.claimHint,
    "",
    ...signOff,
    "",
  ].join("\n");

  const html = [
    `<p>${escapeHtml(strings.greeting)}</p>`,
    `<p>${escapeHtml(intro)}</p>`,
    ...(message
      ? [
          `<p>${escapeHtml(strings.messageLabel)}</p>`,
          // The note is the one multi-line value, and its line breaks are the purchaser's: kept as
          // <br> between escaped lines, never as raw markup.
          `<blockquote><p>${message.split("\n").map(escapeHtml).join("<br>")}</p></blockquote>`,
        ]
      : []),
    ...(titles.length > 0
      ? [
          `<p>${escapeHtml(strings.includesLabel)}</p>`,
          `<ul>${titles.map((title) => `<li>${escapeHtml(title)}</li>`).join("")}</ul>`,
        ]
      : []),
    `<p><a href="${escapeHtml(input.claimUrl)}">${escapeHtml(strings.claim)}</a></p>`,
    `<p>${escapeHtml(strings.claimHint)}</p>`,
    `<p>${signOff.map(escapeHtml).join("<br>")}</p>`,
  ].join("\n");

  return { subject, text, html };
}
