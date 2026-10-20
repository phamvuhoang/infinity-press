import { escapeHtml, fill, singleLine } from "@/lib/email/text";
import en from "@/lib/i18n/dictionaries/en.json";
import ja from "@/lib/i18n/dictionaries/ja.json";
import vi from "@/lib/i18n/dictionaries/vi.json";
import type { Locale } from "@/lib/i18n/config";

export type BookReadyEmailInput = {
  locale: Locale;
  recipientName: string | null;
  // Null when the book has no public localization in `locale`. The message then uses generic copy:
  // it never borrows another locale's title (spec S5 9.1).
  bookTitle: string | null;
  // Absolute `/{locale}/library` URL.
  libraryUrl: string;
};

const copy: Record<Locale, typeof en.email.bookReady> = {
  en: en.email.bookReady,
  vi: vi.email.bookReady,
  ja: ja.email.bookReady,
};

export function buildBookReadyEmail(input: BookReadyEmailInput): { subject: string; text: string; html: string } {
  const strings = copy[input.locale];
  const name = input.recipientName?.trim() || null;
  const title = input.bookTitle?.trim() || null;

  const values = { name: name ?? "", title: title ?? "" };
  const subject = singleLine(fill(title ? strings.subjectWithTitle : strings.subjectGeneric, values));
  const greeting = fill(name ? strings.greetingNamed : strings.greetingGeneric, values);
  const ready = fill(title ? strings.readyWithTitle : strings.readyGeneric, values);
  const signOff = strings.signOff.split("\n");

  const text = [greeting, "", ready, "", `${strings.openLibrary}: ${input.libraryUrl}`, "", ...signOff, ""].join("\n");

  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(ready)}</p>`,
    `<p><a href="${escapeHtml(input.libraryUrl)}">${escapeHtml(strings.openLibrary)}</a></p>`,
    `<p>${signOff.map(escapeHtml).join("<br>")}</p>`,
  ].join("\n");

  return { subject, text, html };
}
