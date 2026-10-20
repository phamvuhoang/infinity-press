import { notFound } from "next/navigation";
import { z } from "zod";

import { AskForm } from "@/components/account/ask-form";
import { MyQuestions } from "@/components/account/my-questions";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { requireUser } from "@/lib/auth/session";
import { getBookAcceptsQuestions, getBookCardById } from "@/lib/data/catalog";
import { getPublishedIdeaById } from "@/lib/data/knowledge";
import { getMyReaderQuestions } from "@/lib/data/questions";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes } from "@/lib/i18n/routes";

import { submitReaderQuestionAction } from "./actions";

// Exactly one of ?book= or ?idea= names what is being asked about. A repeated or malformed value
// (an array, or not a uuid) counts as absent.
const isUuid = (value: unknown): value is string => z.uuid().safeParse(value).success;

export default async function AskPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{ book?: string | string[]; idea?: string | string[] }>;
}) {
  const { lang: locale } = await params;
  if (!isLocale(locale)) notFound();
  const { book, idea } = await searchParams;
  const bookId = isUuid(book) ? book : null;
  const ideaId = isUuid(idea) ? idea : null;
  if ((bookId === null) === (ideaId === null)) notFound();
  const routes = getCatalogRoutes(locale);
  await requireUser(locale, bookId !== null ? routes.ask({ book: bookId }) : routes.ask({ idea: ideaId! }));

  const [dictionary, target, questions] = await Promise.all([
    getDictionary(locale),
    bookId !== null
      ? Promise.all([getBookCardById(locale, bookId), getBookAcceptsQuestions(bookId)]).then(([card, accepts]) =>
          card && accepts ? { kind: "book" as const, id: card.bookId, title: card.title } : null,
        )
      : getPublishedIdeaById(locale, ideaId!).then((row) =>
          row ? { kind: "idea" as const, id: row.ideaId, title: row.question } : null,
        ),
    getMyReaderQuestions(),
  ]);
  if (!target) notFound();
  const copy = dictionary.library.questions;

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader current="library" locale={locale} />
      <main className="mx-auto max-w-[40rem] px-4 py-12 sm:px-8" id="main-content">
        <h1 className="font-serif text-3xl">{copy.title}</h1>
        <AskForm action={submitReaderQuestionAction.bind(null, locale)} copy={copy} target={target} />
        <MyQuestions copy={copy} locale={locale} questions={questions} />
      </main>
      <SiteFooter locale={locale} tagline={dictionary.home.footerTagline} />
    </div>
  );
}
