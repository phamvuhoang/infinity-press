import { escapeHtml, fill, singleLine } from "@/lib/email/text";
import en from "@/lib/i18n/dictionaries/en.json";
import ja from "@/lib/i18n/dictionaries/ja.json";
import vi from "@/lib/i18n/dictionaries/vi.json";
import type { Locale } from "@/lib/i18n/config";

export type QuestionAnsweredEmailInput = {
  locale: Locale;
  recipientName: string | null;
  ideaTitle: string;
  // Absolute URL of the idea page, built at send time from the idea's current localization.
  ideaUrl: string;
};

const copy: Record<Locale, typeof en.email.questionAnswered> = {
  en: en.email.questionAnswered,
  vi: vi.email.questionAnswered,
  ja: ja.email.questionAnswered,
};

export function buildQuestionAnsweredEmail(input: QuestionAnsweredEmailInput): { subject: string; text: string; html: string } {
  const strings = copy[input.locale];
  const name = input.recipientName?.trim() || null;

  const values = { name: name ?? "", title: input.ideaTitle.trim() };
  const subject = singleLine(strings.subject);
  const greeting = fill(name ? strings.greetingNamed : strings.greetingGeneric, values);
  const body = fill(strings.body, values);
  const signOff = strings.signOff.split("\n");

  const text = [greeting, "", body, "", `${strings.read}: ${input.ideaUrl}`, "", ...signOff, ""].join("\n");

  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(body)}</p>`,
    `<p><a href="${escapeHtml(input.ideaUrl)}">${escapeHtml(strings.read)}</a></p>`,
    `<p>${signOff.map(escapeHtml).join("<br>")}</p>`,
  ].join("\n");

  return { subject, text, html };
}
