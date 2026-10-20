import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { ReviewForm } from "@/components/account/review-form";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { requireUser } from "@/lib/auth/session";
import { editionLanguageLabel } from "@/lib/commerce/checkout-view";
import { getBookCardById } from "@/lib/data/catalog";
import { getOwnedEditionsOfBook } from "@/lib/data/library";
import { getCurrentProfile } from "@/lib/data/profiles";
import { getMyBookReview } from "@/lib/data/reviews";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes } from "@/lib/i18n/routes";

import { deleteBookReviewAction, submitBookReviewAction } from "./actions";

const textLink =
  "inline-flex min-h-11 items-center text-forest underline decoration-sand underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-forest";

export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string; bookId: string }>;
  searchParams?: Promise<{ edition?: string | string[] }>;
}) {
  const { lang: locale, bookId } = await params;
  const requested = (await searchParams)?.edition;
  const requestedEdition = typeof requested === "string" && z.uuid().safeParse(requested).success ? requested : undefined;
  if (!isLocale(locale)) notFound();
  const routes = getCatalogRoutes(locale);
  await requireUser(locale, routes.review(bookId));
  // A non-uuid id would make the RPCs raise 22P02 (a 500); it can name no book.
  if (!z.uuid().safeParse(bookId).success) notFound();

  const [dictionary, card, editions] = await Promise.all([
    getDictionary(locale),
    getBookCardById(locale, bookId),
    getOwnedEditionsOfBook(locale, bookId),
  ]);
  if (!card) notFound();
  // A review belongs to ONE edition. A reader holding one needs say nothing; one holding several
  // picks (?edition=), and an edition they do not hold is no choice at all.
  const selected =
    editions.length === 1 ? editions[0] : (editions.find((candidate) => candidate.editionId === requestedEdition) ?? null);
  const mustChoose = editions.length > 1 && selected === null;
  const owned = selected !== null;
  const review = mustChoose ? null : await getMyBookReview(bookId, selected?.editionId);
  const copy = dictionary.library.reviews;
  const languageLabel = selected && editions.length > 1 ? editionLanguageLabel(selected.languageCode) : null;

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader current="library" locale={locale} />
      <main className="mx-auto max-w-[40rem] px-4 py-12 sm:px-8" id="main-content">
        <p className="text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.eyebrow}</p>
        <h1 className="mt-2 font-serif text-3xl">{card.title}</h1>
        {languageLabel ? <p className="mt-1 text-sm text-sage-text">{languageLabel}</p> : null}
        {mustChoose ? (
          <section aria-labelledby="choose-edition" className="mt-8">
            <h2 className="text-sm font-medium" id="choose-edition">{copy.chooseEdition}</h2>
            <ul className="mt-3 space-y-1">
              {editions.map((edition) => (
                <li key={edition.editionId}>
                  <Link className={textLink} href={routes.review(bookId, edition.editionId)}>
                    {editionLanguageLabel(edition.languageCode)}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {!owned && !mustChoose ? (
          <p className="mt-8">
            {copy.notOwned}{" "}
            <Link className={textLink} href={routes.book(card.slug)}>{copy.backToBook}</Link>
          </p>
        ) : null}
        {owned || review ? (
          <ReviewForm
            action={submitBookReviewAction.bind(null, locale, bookId, selected?.editionId)}
            canEdit={owned}
            copy={copy}
            deleteAction={deleteBookReviewAction.bind(null, locale, bookId, selected?.editionId)}
            review={review}
          />
        ) : null}
      </main>
      <SiteFooter locale={locale} tagline={dictionary.home.footerTagline} />
    </div>
  );
}
