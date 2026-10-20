import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

import { BookCard } from "@/components/catalog/book-card";
import { coverPublicUrl } from "@/lib/catalog/covers";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import { isLoopbackUrl } from "@/lib/config/url";
import type { Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes, getKnowledgeRoutes } from "@/lib/i18n/routes";
import type { InlineLink, InlineRun, KnowledgeBlock, KnowledgeIdeaReference } from "@/lib/knowledge/blocks";

// The only renderer for S12 editorial content. A Server Component that turns the typed block union
// into React elements: every string reaches the DOM as an escaped text node, and there is no branch
// that accepts markup. Referenced books and ideas arrive already resolved by the public DAL and
// contain only entities published in this locale; a block whose reference is absent is omitted.

type Props = {
  blocks: KnowledgeBlock[];
  locale: Locale;
  bookCopy: Dictionary["catalog"]["book"];
  booksById: ReadonlyMap<string, CatalogBookCard>;
  ideasById: ReadonlyMap<string, KnowledgeIdeaReference>;
};

function internalHref(link: Extract<InlineLink, { kind: "internal" }>, locale: Locale): string {
  const catalog = getCatalogRoutes(locale);
  const knowledge = getKnowledgeRoutes(locale);
  switch (link.entity) {
    case "book":
      return catalog.book(link.slug);
    case "idea":
      return knowledge.idea(link.slug);
    case "article":
      return knowledge.article(link.slug);
    case "author":
    case "series":
    case "topic":
      return catalog.entity(link.entity, link.slug);
  }
}

const linkClassName = "text-forest underline underline-offset-2 hover:text-ink";

function InlineContent({ runs, locale }: { runs: InlineRun[]; locale: Locale }) {
  return runs.map((run, index) => {
    let node: ReactNode = run.text;
    if (run.marks?.includes("emphasis")) node = <em>{node}</em>;
    if (run.marks?.includes("strong")) node = <strong>{node}</strong>;
    if (run.link?.kind === "internal") {
      node = (
        <Link className={linkClassName} href={internalHref(run.link, locale)}>
          {node}
        </Link>
      );
    } else if (run.link?.kind === "external") {
      node = (
        <a className={linkClassName} href={run.link.href} rel="noopener noreferrer">
          {node}
        </a>
      );
    }
    return <span key={index}>{node}</span>;
  });
}

function BookAttribution({ book, locale, locator }: { book: CatalogBookCard; locale: Locale; locator?: string }) {
  return (
    <figcaption className="mt-3 text-sm text-ink-soft">
      —{" "}
      <Link className={linkClassName} href={getCatalogRoutes(locale).book(book.slug)}>
        {book.title}
      </Link>
      , {book.author.name}
      {locator ? <span> · {locator}</span> : null}
    </figcaption>
  );
}

const quoteClassName = "border-l-2 border-forest pl-5 font-serif text-xl leading-relaxed text-ink";

function renderBlock(block: KnowledgeBlock, props: Props): ReactNode {
  const { locale } = props;
  switch (block.type) {
    case "paragraph":
      return (
        <p className="leading-relaxed text-ink">
          <InlineContent locale={locale} runs={block.content} />
        </p>
      );
    case "heading":
      return block.level === 2 ? (
        <h2 className="font-serif text-2xl text-ink">{block.text}</h2>
      ) : (
        <h3 className="font-serif text-xl text-ink">{block.text}</h3>
      );
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index}>
          <InlineContent locale={locale} runs={item} />
        </li>
      ));
      return block.ordered ? (
        <ol className="list-decimal space-y-2 pl-6 leading-relaxed text-ink">{items}</ol>
      ) : (
        <ul className="list-disc space-y-2 pl-6 leading-relaxed text-ink">{items}</ul>
      );
    }
    case "quote": {
      if (block.bookId !== undefined) {
        // A book-backed quote without its visible, published book would be unattributed.
        const book = props.booksById.get(block.bookId);
        if (!book) return null;
        return (
          <figure>
            <blockquote className={quoteClassName}>
              <p>{block.text}</p>
            </blockquote>
            <BookAttribution book={book} locale={locale} />
          </figure>
        );
      }
      return (
        <figure>
          <blockquote className={quoteClassName}>
            <p>{block.text}</p>
          </blockquote>
          <figcaption className="mt-3 text-sm text-ink-soft">— {block.attribution}</figcaption>
        </figure>
      );
    }
    case "book_quote": {
      const book = props.booksById.get(block.bookId);
      if (!book) return null;
      return (
        <figure>
          <blockquote className={quoteClassName}>
            <p>{block.text}</p>
          </blockquote>
          <BookAttribution book={book} locale={locale} locator={block.locatorLabel} />
        </figure>
      );
    }
    case "image": {
      const src = coverPublicUrl(block.storageKey);
      return (
        <figure>
          <Image
            alt={block.alt}
            className="h-auto w-full"
            height={block.height}
            sizes="(min-width: 768px) 42rem, 100vw"
            src={src}
            unoptimized={isLoopbackUrl(src)}
            width={block.width}
          />
        </figure>
      );
    }
    case "book_card": {
      const book = props.booksById.get(block.bookId);
      if (!book) return null;
      return (
        <div className="max-w-[14rem]">
          <BookCard card={book} copy={props.bookCopy} locale={locale} />
        </div>
      );
    }
    case "idea_card": {
      const idea = props.ideasById.get(block.ideaId);
      if (!idea) return null;
      return (
        <article className="border border-hairline p-5">
          <Link
            className="font-serif text-lg leading-snug text-ink hover:underline"
            href={getKnowledgeRoutes(locale).idea(idea.slug)}
          >
            {idea.question}
          </Link>
          <p className="mt-2 text-sm text-ink-soft">{idea.shortAnswer}</p>
        </article>
      );
    }
  }
  const unreachable: never = block;
  throw new Error(`Unsupported knowledge block: ${JSON.stringify(unreachable)}`);
}

export function BlockRenderer(props: Props) {
  return (
    <div className="flex flex-col gap-6">
      {props.blocks.map((block, index) => {
        const node = renderBlock(block, props);
        return node === null ? null : <div key={index}>{node}</div>;
      })}
    </div>
  );
}
