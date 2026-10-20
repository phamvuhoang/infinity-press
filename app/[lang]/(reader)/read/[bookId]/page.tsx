import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { getOwnedEditionsOfBook } from "@/lib/data/library";
import { isLocale, withLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";

// The old `/read/{bookId}` deep link, kept for links people already hold (emails, bookmarks). A
// reader is only ever sent to an edition THEY own: one edition redirects, several open a chooser,
// none is a 404. The interface locale never picks the language, so switching it cannot change which
// book someone is reading. Reading itself lives at `/read/editions/{editionId}`.
export default async function LegacyReadBookPage({
  params,
}: {
  params: Promise<{ lang: string; bookId: string }>;
}) {
  const { lang: locale, bookId } = await params;
  if (!isLocale(locale)) notFound();

  await requireUser(locale, withLocale(locale, `/read/${bookId}`));

  // One notFound() for "you own nothing of this" and "no such book" alike, so a stranger cannot
  // tell whether it exists.
  const editions = await getOwnedEditionsOfBook(locale, bookId);
  if (editions.length === 0) notFound();
  if (editions.length === 1) redirect(withLocale(locale, `/read/editions/${editions[0].editionId}`));

  const copy = (await getDictionary(locale)).reader.chooseEdition;
  const languageNames = new Intl.DisplayNames([locale], { type: "language" });

  return (
    <main className="mx-auto max-w-xl px-4 py-16" id="main-content">
      <h1 className="mb-3 font-serif text-3xl">{copy.title}</h1>
      <p className="mb-8 text-ink-soft">{copy.description}</p>
      <ul className="space-y-3">
        {editions.map((edition) => (
          <li key={edition.editionId}>
            <Link
              className="inline-flex min-h-11 items-center text-lg text-forest underline decoration-sand underline-offset-4 hover:text-ink"
              href={withLocale(locale, `/read/editions/${edition.editionId}`)}
              lang={edition.languageCode}
            >
              {languageNames.of(edition.languageCode) ?? edition.languageCode}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
