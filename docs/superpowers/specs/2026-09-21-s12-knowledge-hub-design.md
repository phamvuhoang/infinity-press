# S12 Knowledge Hub Design

**Status:** Approved
**Date:** 2026-09-21
**Roadmap:** PRD P1.2 knowledge graph
**Builds on:** S1 catalog admin, S2 public discovery, S5 SEO and operations, S5.5 reader depth (quote rules)
**Related:** S11 recommendation shelves

## 1. Goal

A person searching for a life question, rather than a title, lands on a page that answers the question
and leads to the book that develops it.

S12 adds two editorial entities — ideas and articles — and the relations that connect them to books,
topics, and each other. Both are built on one content infrastructure, because building it twice is the
main cost of splitting them apart.

## 2. What S12 Delivers

| Surface | Who | Result |
| --- | --- | --- |
| `/{locale}/ideas` and `/{locale}/ideas/[slug]` | Reader and crawler | A question, a direct answer, an explanation, related books and related ideas |
| `/{locale}/articles` and `/{locale}/articles/[slug]` | Reader and crawler | Editorial writing linked to books, ideas, and topics |
| `/{locale}/topics/[slug]` and book pages | Reader | Links into the ideas and articles that discuss them |
| `/search` | Reader | Grouped idea and article results alongside books |
| `/admin/ideas` and `/admin/articles` | Editor | A typed block editor, relations, localizations, readiness, and publishing |

## 3. Out of Scope

- An interactive knowledge-graph visualization.
- AI extraction of ideas, summaries, or tags from book text. That is P2.4 enrichment, with human
  approval, and it is not needed for the graph to be useful.
- Semantic search and embeddings. Lexical search is extended instead.
- Comments, reactions, and any social layer on ideas or articles.
- Collections. They remain a separate P1 item.
- The `ja` locale.

## 4. Decisions

| Topic | Decision |
| --- | --- |
| Idea versus topic | A topic is a classification label. An idea is a page that answers one question. They are separate entities with separate URLs. |
| Articles | Built in the same sub-project, sharing the content, localization, slug, relation, and SEO infrastructure with ideas. |
| Rich content | Typed blocks validated by Zod and rendered by a fixed renderer. No stored HTML, anywhere. |
| Relations | Explicit join tables per pair, not one polymorphic table, so foreign keys stay real. |
| Book quotes | Reuse the S5.5 limit of 300 grapheme clusters and its attribution requirement. |
| Missing locale | 404, per the MVP spec's translation fallback policy. |

## 5. Data Model

```
ideas                  id, status, created_at, updated_at
idea_localizations     id, idea_id, locale, slug, question, short_answer,
                       body_blocks jsonb, seo_title, seo_description, updated_at
                       unique (locale, slug), unique (idea_id, locale)

articles               id, status, author_id references authors(id), published_at, created_at
article_localizations  id, article_id, locale, slug, title, excerpt,
                       body_blocks jsonb, seo_title, seo_description, updated_at
                       unique (locale, slug), unique (article_id, locale)
```

Relations, each with `position` where order is editorial:

```
idea_books      (idea_id, book_id, position)
idea_topics     (idea_id, topic_id)
idea_links      (idea_id, related_idea_id, position)   check (idea_id <> related_idea_id)
article_books   (article_id, book_id, position)
article_ideas   (article_id, idea_id, position)
article_topics  (article_id, topic_id)
```

A single polymorphic `knowledge_relations` table was rejected: it cannot carry real foreign keys, and
its RLS and its indexes would both have to be written defensively around a type column.

RLS follows the existing catalog pattern: anonymous and authenticated readers select only rows whose
entity is `published`; writes belong to the admin path.

## 6. Typed Content Blocks

AGENTS.md forbids arbitrary scriptable HTML in editorial content, so `body_blocks` is an array of
typed blocks, never markup.

`lib/knowledge/blocks.ts` defines the Zod schema and the discriminated union:

| Block | Fields |
| --- | --- |
| `paragraph` | Text with inline marks limited to emphasis, strong, and a link to an internal entity or an absolute URL |
| `heading` | Level 2 or 3, text |
| `list` | Ordered or unordered, items of inline text |
| `quote` | Text, and either a free attribution or a `book_id` |
| `book_quote` | `book_id`, quoted text, optional locator label |
| `image` | A `covers`-bucket storage key, alt text, width, height |
| `book_card` | `book_id` |
| `idea_card` | `idea_id` |

Every write validates through the schema before it reaches the database, and a check constraint keeps
`body_blocks` an array. `components/knowledge/BlockRenderer.tsx` switches over the union and has no
branch that accepts raw HTML, so there is no path by which editorial content becomes script.

A `book_quote` is limited to 300 Unicode grapheme clusters and always renders the book title, the
author, and a link to the book's canonical URL — the same function S5.5 already uses for reader
quotes, imported rather than reimplemented.

## 7. Public Pages

All Server Components under `/{locale}`, following the S2 data-access rule that only published
entities render and a missing localization returns 404.

- **Idea detail** opens with the question as the page heading and the short answer immediately below
  it, then the blocks, then related books, then related ideas, then the topics it belongs to.
- **Idea index** lists published ideas for the locale, grouped by topic.
- **Article detail** shows title, author, published date, excerpt, blocks, and its related books and
  ideas.
- **Article index** is a reverse-chronological list.
- **Topic pages** gain a list of the ideas and articles that reference the topic. **Book pages** gain
  a list of the ideas and articles that reference the book.

Metadata, canonical URLs, and `hreflang` follow S5. Both entity types enter `app/sitemap.ts`. A slug
change on a published localization writes a `redirects` row in the same transaction and rewrites rows
that pointed at the old path, so redirects never chain — the rule S1 already established.

JSON-LD: `Article` for articles, and `Article` for ideas. `FAQPage` is emitted **only** when the idea
page renders a visible question-and-answer section, because structured data must match what a person
sees on the page.

## 8. Search

`search_catalog` is extended to return ideas and articles as their own result groups, matching the
idea question and short answer and the article title and excerpt. Books and authors keep their
existing rank priority; ideas and articles are grouped beneath them. Diacritic-insensitive matching
uses the existing `unaccent` and `pg_trgm` configuration.

Block bodies are not indexed in this sub-project. Titles, questions, answers, and excerpts are what
readers search for, and indexing bodies is a separate relevance problem.

## 9. Admin

`/admin/ideas` and `/admin/articles` list entities with status, locale coverage, and readiness.
Each editor has tabs for Details, Localizations (with the block editor), Relations, and SEO.

`checkIdeaReadiness` and `checkArticleReadiness` follow `checkBookReadiness`: publishing requires at
least one locale with a slug, a question or title, the short answer or excerpt, at least one content
block, and, for an idea, at least one published related book. `publish_idea` and `publish_article` RPCs run the
same checks. Every create, edit, relation change, and publish writes one `audit_logs` row.

## 10. Testing

| Layer | Coverage |
| --- | --- |
| Vitest | The block Zod schema accepts every valid block and rejects unknown types, raw HTML in text fields, an over-length `book_quote`, and a `book_card` without a book; `checkIdeaReadiness` and `checkArticleReadiness`; the renderer emits no `dangerouslySetInnerHTML`; JSON-LD builders, including that `FAQPage` appears only with a visible Q&A section |
| pgTAP | Anonymous readers see only published ideas and articles; `unique (locale, slug)` holds across ideas, articles, and existing entities where they share a path space; publishing is refused when readiness fails; a slug rename writes exactly one redirect and rewrites existing ones; `idea_links` rejects self-links; `search_catalog` returns idea and article groups with and without diacritics |
| Playwright | Search a question → idea page → related book → book page; admin creates, relates, and publishes an idea; a locale without a localization returns 404 and the language switcher points at that locale's home |
| Runbook | `docs/runbooks/knowledge-hub.md`: writing an idea, choosing between an idea and an article, quoting a book within the limit, and relating entities |

## 11. Exit Criteria

- An idea page answers its question above the fold and links to at least one book.
- No editorial content path can store or render HTML; the renderer has no raw-HTML branch.
- A book quote inside editorial content obeys the same 300-cluster limit and attribution as a reader
  quote.
- Canonical, `hreflang`, sitemap entries, redirects, and JSON-LD validate for both new entity types.
- Search returns ideas and articles for a Vietnamese query typed without diacritics.
- `npm run check`, `npm run db:test`, and `npm run check:full` pass against a local Supabase stack.
