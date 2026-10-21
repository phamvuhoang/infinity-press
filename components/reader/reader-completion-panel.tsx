"use client";

import Link from "next/link";

export type ReaderCompletionCopy = {
  finishedTitle: string;
  finishedBody: string;
  goToLibrary: string;
  notes: string;
  highlights: string;
  bookmarks: string;
  relatedBooks: string;
  noRelatedBooks: string;
  rateBook: string;
  askAuthor: string;
};

export function ReaderCompletionPanel({
  copy,
  libraryHref,
  reviewHref,
  askHref,
  relatedBooks,
  onOpenSaved,
  dark = false,
}: {
  copy: ReaderCompletionCopy;
  libraryHref: string;
  reviewHref: string | null;
  askHref: string | null;
  relatedBooks: Array<{ title: string; authorName: string; href: string; coverUrl: string | null }>;
  onOpenSaved: (tab: "bookmarks" | "notes") => void;
  dark?: boolean;
}) {
  const hoverSurface = dark ? "hover:bg-ivory/10" : "hover:bg-surface";
  const linkClass = `inline-flex min-h-11 items-center rounded-md px-3 text-sm outline-none ${hoverSurface} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest`;
  const mutedText = dark ? "text-current opacity-80" : "text-sage-text";
  return (
    <aside className="mx-auto w-full max-w-[42rem] px-4 pb-4" role="status">
      <div className={`rounded-md border border-hairline p-4 text-center ${dark ? "bg-ink-soft text-ivory" : "bg-surface text-ink"}`}>
        <p className="font-serif text-lg">{copy.finishedTitle}</p>
        <p className={`mt-1 text-sm ${mutedText}`}>{copy.finishedBody}</p>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <Link className="inline-flex min-h-11 items-center rounded-md bg-forest px-3 text-sm text-ivory outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest" href={libraryHref}>{copy.goToLibrary}</Link>
          <button className={`min-h-11 rounded-md px-3 text-sm outline-none ${hoverSurface} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest`} onClick={() => onOpenSaved("notes")} type="button">{copy.notes}</button>
          <button className={`min-h-11 rounded-md px-3 text-sm outline-none ${hoverSurface} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest`} onClick={() => onOpenSaved("bookmarks")} type="button">{copy.highlights}</button>
          <button className={`min-h-11 rounded-md px-3 text-sm outline-none ${hoverSurface} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest`} onClick={() => onOpenSaved("bookmarks")} type="button">{copy.bookmarks}</button>
          {reviewHref ? <Link className={linkClass} href={reviewHref}>{copy.rateBook}</Link> : null}
          {askHref ? <Link className={linkClass} href={askHref}>{copy.askAuthor}</Link> : null}
        </div>
        <section aria-label={copy.relatedBooks} className="mt-4 text-left">
          <h2 className="text-sm font-medium">{copy.relatedBooks}</h2>
          {relatedBooks.length === 0 ? <p className={`mt-1 text-sm ${mutedText}`}>{copy.noRelatedBooks}</p> : <ul className="mt-2 grid gap-2 sm:grid-cols-3">{relatedBooks.map((book) => <li key={book.href}><Link className={`block rounded-md p-2 outline-none ${hoverSurface} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest`} href={book.href}><span className="block text-sm font-medium">{book.title}</span><span className={`block text-xs ${mutedText}`}>{book.authorName}</span></Link></li>)}</ul>}
        </section>
      </div>
    </aside>
  );
}
