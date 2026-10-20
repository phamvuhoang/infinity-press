import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { GiftClaimRejectedError, type ClaimedGiftBook, claimGift } from "@/lib/commerce/gifts";
import { type Locale, isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes, getCommerceRoutes, getLocaleRoutes } from "@/lib/i18n/routes";

// A claim URL is a credential in a link, so it must never be indexed and never be followed into.
// Static metadata: nothing here depends on the token, and reading it to build a title would put it
// in a <head> for no gain. The route stays dynamic regardless, because the body below reads the
// token and the session at request time. Claim URLs are never added to app/sitemap.ts.
export const metadata: Metadata = { robots: { index: false, follow: false } };

type Props = { params: Promise<{ lang: string; token: string }> };

// The recipient's end of a gift (S9 spec 7.3). Everything on this page comes from claim_gift's own
// result: the page never re-queries entitlements, because a second read would be a second answer to
// a question the RPC has already answered under a row lock.
//
// What the page is careful NOT to say: that the list below is "the books this claim granted you".
// claim_gift's same-reader replay branch inner-joins entitlements on status = 'active', so a book
// revoked by an admin after the claim silently drops out of a refreshed result with no marker of
// any kind. A page that promised a grant record would then be quietly lying. It promises what it
// can keep instead - what this gift holds in the reader's library right now - which is exactly true
// on the first claim and exactly true on every refresh after it.
export default async function GiftClaimPage({ params }: Props) {
  const { lang: locale, token } = await params;
  if (!isLocale(locale)) notFound();

  // The exact path this request is on, token included, so sign-in returns the visitor here. The
  // token rides in `next` and in nothing else - no separate parameter, no cookie.
  await requireUser(locale, getCommerceRoutes(locale).giftClaim(token));

  const dictionary = await getDictionary(locale);
  const copy = dictionary.gifts.claim;
  const catalog = getCatalogRoutes(locale);
  const library = getLocaleRoutes(locale).library;

  let books: ClaimedGiftBook[];
  try {
    books = await claimGift(locale, token);
  } catch (error) {
    // Unknown, revoked, claimed by somebody else, or belonging to an unpaid order: one message for
    // all of them. The token IS the authorization, so copy that distinguished them would tell a
    // guesser which kind of wrong their guess was.
    if (!(error instanceof GiftClaimRejectedError)) throw error;
    return (
      <Shell eyebrow={copy.eyebrow} locale={locale} title={copy.refusedTitle}>
        <p className="mt-3 text-[0.9375rem] text-ink-soft">{copy.refusedBody}</p>
        <Button className="mt-8" render={<Link href={library} />} size="lg">
          {copy.library}
        </Button>
      </Shell>
    );
  }

  const added = books.filter((book) => !book.alreadyOwned);
  const alreadyOwned = books.filter((book) => book.alreadyOwned);

  return (
    <Shell eyebrow={copy.eyebrow} locale={locale} title={copy.title}>
      <p className="mt-3 text-[0.9375rem] text-ink-soft">{copy.currentNote}</p>

      {books.length === 0 ? <p className="mt-8 text-[0.9375rem]">{copy.empty}</p> : null}

      <BookGroup books={added} heading={copy.addedTitle} readHref={catalog.read} />
      <BookGroup books={alreadyOwned} heading={copy.ownedTitle} readHref={catalog.read} />

      <Button className="mt-10" render={<Link href={library} />} size="lg">
        {copy.library}
      </Button>
    </Shell>
  );
}

function Shell({
  children,
  eyebrow,
  locale,
  title,
}: {
  children: React.ReactNode;
  eyebrow: string;
  locale: Locale;
  title: string;
}) {
  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader locale={locale} />
      <main className="mx-auto max-w-[40rem] px-4 py-12 sm:px-8 lg:py-16" id="main-content">
        <p className="mb-2 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{eyebrow}</p>
        <h1 className="font-serif text-4xl leading-[1.1] font-normal tracking-[-0.015em]">{title}</h1>
        {children}
      </main>
    </div>
  );
}

// An empty group renders nothing at all: a heading with no list under it reads as a promise the
// page cannot keep.
function BookGroup({
  books,
  heading,
  readHref,
}: {
  books: ClaimedGiftBook[];
  heading: string;
  readHref: (bookId: string) => string;
}) {
  if (books.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium tracking-[0.02em]">{heading}</h2>
      <ul className="mt-3 space-y-2">
        {books.map((book) => (
          <li className="min-w-0 [overflow-wrap:anywhere]" key={book.bookId}>
            <Link className="text-[0.9375rem] underline decoration-sand underline-offset-4 hover:decoration-ink" href={readHref(book.bookId)}>
              {book.title}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
