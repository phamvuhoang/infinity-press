import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { ReviewForm } from "@/components/account/review-form";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { requireUser } from "@/lib/auth/session";
import { getActiveEntitlementBookIds, getBookCardById } from "@/lib/data/catalog";
import { getCurrentProfile } from "@/lib/data/profiles";
import { getMyBookReview } from "@/lib/data/reviews";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes } from "@/lib/i18n/routes";

import { deleteBookReviewAction, submitBookReviewAction } from "./actions";

const textLink =
  "inline-flex min-h-11 items-center text-forest underline decoration-sand underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-forest";

export default async function ReviewPage({ params }: { params: Promise<{ lang: string; bookId: string }> }) {
  const { lang: locale, bookId } = await params;
  if (!isLocale(locale)) notFound();
  const routes = getCatalogRoutes(locale);
  await requireUser(locale, routes.review(bookId));
  // A non-uuid id would make the RPCs raise 22P02 (a 500); it can name no book.
  if (!z.uuid().safeParse(bookId).success) notFound();

  const [dictionary, card, review, profile] = await Promise.all([
    getDictionary(locale),
    getBookCardById(locale, bookId),
    getMyBookReview(bookId),
    getCurrentProfile(),
  ]);
  if (!card) notFound();
  // Ownership is read through the session client (RLS), keyed by the profile id, not the auth id.
  const owned = profile ? (await getActiveEntitlementBookIds(profile.id)).has(bookId) : false;
  const copy = dictionary.library.reviews;

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader current="library" locale={locale} />
      <main className="mx-auto max-w-[40rem] px-4 py-12 sm:px-8" id="main-content">
        <p className="text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.eyebrow}</p>
        <h1 className="mt-2 font-serif text-3xl">{card.title}</h1>
        {!owned ? (
          <p className="mt-8">
            {copy.notOwned}{" "}
            <Link className={textLink} href={routes.book(card.slug)}>{copy.backToBook}</Link>
          </p>
        ) : null}
        {owned || review ? (
          <ReviewForm
            action={submitBookReviewAction.bind(null, locale, bookId)}
            canEdit={owned}
            copy={copy}
            deleteAction={deleteBookReviewAction.bind(null, locale, bookId)}
            review={review}
          />
        ) : null}
      </main>
      <SiteFooter locale={locale} tagline={dictionary.home.footerTagline} />
    </div>
  );
}
