# S16 Shareable Quote Cards Design

**Status:** Approved
**Date:** 2026-10-09
**Roadmap:** PRD 5.2 book-page evidence, growth (organic sharing)
**Builds on:** S5.5 reader depth (selection toolbar, attributed quote, 300-grapheme rule), S5 SEO and operations (metadata, analytics events, revalidation), S2 public discovery (book DTOs, covers)
**Related:** S12 `book_quote` block (same limit), S15 review reply email, S17 wishlist

## 1. Goal

The reader can already copy or share a quote of at most 300 grapheme clusters with the book title,
author, and canonical URL. The result is a block of text. When it lands in a chat or a feed it has
no image, no link preview, and no way back into the book except the raw URL at the bottom.

S16 makes the shared quote a page. The reader presses the same "Share" button. The platform stores
the quote, mints a short public URL, and the reader shares that URL. Anyone who opens it sees a
designed quote card, the book, and a button to read the sample or buy. Chat apps and social
networks render an Open Graph image of the card. Every shared quote is one more entry point to the
book page.

## 2. What S16 Delivers

| Surface | Who | Result |
| --- | --- | --- |
| Reader selection toolbar | Entitled reader | "Share" now creates a quote card and shares its URL with the attributed text; "Copy" is unchanged |
| `/{locale}/q/[code]` | Anyone | The quote, attribution, cover, "Read a sample" and the book's current action (Get free, Buy, Coming soon); `noindex, follow` |
| `/{locale}/q/[code]/opengraph-image` | Crawlers and chat apps | A 1200×630 PNG of the quote card |
| `/{locale}/library/quotes` | Reader | Their own shared quotes with the share link, the view count, and a delete control |
| `/api/analytics/events` | Operator | `share_quote` (reader shared) and `view_quote` (card opened) events |
| `/admin/books/[bookId]` | Admin | A "Shared quotes" count and a link to a filtered list with a takedown control |

## 3. Out of Scope

- Sharing from the sample reader. The sample has no entitlement and no selection toolbar.
- Quotes longer than 300 grapheme clusters. The S5.5 limit and helper are reused unchanged.
- Images of the quote with the reader's name or avatar. The card names the book and author only.
- Comments, likes, or a public feed of quotes.
- Quotes from ideas and articles. The S12 `book_quote` block already links to the book page.
- Deep-linking the card into the reader at the quoted locator. The card links to the book page.
- Any change to annotation privacy. A shared quote is a new, separate, deliberately public row.

## 4. Decisions

| Topic | Decision |
| --- | --- |
| Public by consent only | A `shared_quotes` row exists only because the reader pressed Share. Highlights and notes stay private. The share sheet names the fact that the quote becomes a public page before the row is created. |
| Code | A 10-character URL-safe code: `gen_random_bytes(8)` as base64url, truncated, so 60 random bits. Not the UUID: the URL is meant to be typed and read aloud. Unique index; a collision retries up to three times. |
| What is stored | The quote text (already truncated by the shared helper), `book_id`, `publication_id`, `profile_id`, `locale`, `created_at`, `status`. Not the locator: the card does not open the reader, and a locator would tie the row to a publication version for no gain. No view counter: views are the `view_quote` analytics rows (see below). |
| Who may share | A profile with an active entitlement for the book, checked inside the RPC with the S13 predicate. The RPC takes the **publication id** from the authorized reader session and derives the book through the asset's edition, so the client never names a book. |
| Text rules | The same `/<\/?[a-z][^>]*>/i` plain-text rule and the 300-grapheme limit, enforced in the route with the shared helper and in a check constraint in SQL (bytes and the tag rule). A quote cannot be empty after trim. |
| Cap | At most 200 active shared quotes per profile, `EB038`. A reader sharing more is asked to delete old ones. Counted under a lock on the profile row. |
| Status | `active` or `removed`. The reader deletes their own; an admin removes for takedown. A removed code returns 404. Rows are not hard-deleted, so a reposted link cannot be reclaimed by a different quote. |
| Rendering the card | A dynamic page, `noindex, follow`. The quote is user-selected text and must not be indexed as the site's content; the `follow` keeps link equity flowing to the book page. The book data comes from the existing public catalog loaders in the card's locale. |
| Open Graph image | A `opengraph-image.tsx` next to the page, using `ImageResponse` like `app/opengraph-image.tsx`. The same brand colours, the quote in the site serif, the title and author, the site name. No cover bitmap in the image: covers are private storage reads and `next/og` cannot embed them without a public URL; the HTML card shows the cover, the image shows the words. |
| Share payload | The reader's share sheet receives the attributed text **plus** the card URL in place of the canonical book URL. Copy keeps the canonical book URL, so a copy never creates a row. |
| Fallback | When the RPC fails (offline, cap reached, revoked), the toolbar falls back to the S5.5 behaviour and shares the attributed text with the canonical URL. Sharing never blocks on the server. |
| View count | The card page sends `view_quote` through the existing browser beacon (anonymous, quota-bounded, deduped by client event id). The owner's count is `count(*)` over those rows, computed in `my_shared_quotes`. Shown only to the owner. Not a public like count. |
| Book availability | A card for an unpublished book 404s, exactly as the book page does. One path, and nothing about the book is revealed. |

## 5. Data Model

```
shared_quotes        id uuid pk
                     code text not null unique check (code ~ '^[A-Za-z0-9_-]{10}$')
                     book_id uuid references books(id) on delete cascade
                     publication_id uuid references ebook_publications(id) on delete set null
                     profile_id uuid references profiles(id) on delete cascade
                     quote text not null check (length(btrim(quote)) between 1 and 1200)
                       -- 1200 bytes is the SQL ceiling; the 300-grapheme rule is enforced in the RPC
                     locale text not null check (locale in ('vi','en'))
                     status text not null default 'active' check (status in ('active','removed'))
                     removed_by text check (removed_by is null or removed_by in ('owner','admin'))
                     created_at, updated_at
                     check ((status = 'removed') = (removed_by is not null))
```

Indexes: `shared_quotes (profile_id, created_at desc)`, `shared_quotes (book_id, status)`.

`analytics_events` gains `share_quote` and `view_quote` in its event-name check and a nullable
`shared_quote_id uuid references shared_quotes(id) on delete set null`. The table keeps its
no-free-text rule: the quote text never enters analytics. `share_quote` is written by the create RPC
in the same transaction, keyed `share/<quote id>`.

RLS is enabled and **no role reads the table**: anon and authenticated are revoked, and every read
is a definer RPC, as S13 ended up for reviews. No role has insert, update, or delete; every write is
a definer RPC.

## 6. RPCs

| Function | Caller | Behaviour |
| --- | --- | --- |
| `create_shared_quote(p_publication_id, p_quote, p_locale) returns jsonb` | Reader | Resolves the book through the publication's asset and edition; checks the active-publication, entitlement, text, and cap rules; mints a code; inserts; writes `share_quote`; returns `{ id, code }` |
| `remove_shared_quote(p_code)` | Owner | Sets `removed`, `removed_by = 'owner'` on the caller's own active row; silent no-op otherwise |
| `admin_remove_shared_quote(p_code)` | Admin | Sets `removed`, `removed_by = 'admin'`; writes one `audit_logs` row with the id, never the text |
| `catalog_shared_quote(p_code)` | Anon, authenticated | Public read of one active card of a published book; null otherwise |
| `my_shared_quotes()` | Reader | The caller's active cards with book title and `viewCount` from analytics |
| `admin_list_shared_quotes(p_book_id)` | Admin | Newest 200 active cards, optionally for one book, with owner email and views; null for a non-admin |

Every refusal is one code, `EB038` for the cap and `EB039` for everything else (S13 already holds
`EB036` and `EB037`), so a publication id cannot be probed by the error it produces.

## 7. Client Flow

1. The reader selects text and presses Share.
2. The toolbar calls `buildAttributedQuote` as today, then `POST /api/reader/quotes?publicationId=…`
   with the truncated quote and the reading locale, authorised by the reader session like the
   annotation routes. The publication id comes from the authorized context, never from the body.
3. The route calls `create_shared_quote` and returns `{ code, url }`.
4. The toolbar builds the share text with `url` in place of the canonical URL and hands it to the
   Web Share API, or copies it when sharing is unavailable. The "truncated" announcement is unchanged.
5. On any failure in steps 2–3 the toolbar shares the S5.5 payload instead and shows no error.

The share sheet's first line states, from the dictionary, that the quote will be a public page. It
is a label, not a confirmation step: the reader already chose Share.

## 8. Pages

### `/{locale}/q/[code]`

Dynamic. Loads `catalog_shared_quote`, then the public book card by id in the card's locale through
the existing loader. Renders:

- the quote in large serif, with the S5.5 curly quotes;
- title and author, linked to the book page and the author page;
- the cover through the existing cover component;
- `ViewerBookAction` for the book, so a signed-in owner sees "Continue reading" and a visitor sees
  Get free or Buy;
- "Read a sample" when the book has a sample;
- a small "Shared from Infinity Books" line.

Metadata: title `“{first 60 graphemes}…” — {book title}`, description the attribution, Open Graph
image the sibling route, `robots: noindex, follow`, canonical pointing at the book page in the same
locale. The card is not in the sitemap and not in `llms.txt`.

A visitor whose locale differs from the card's is not redirected; the card renders in its own
locale, because the quote text is in that locale.

### `/{locale}/library/quotes`

Authenticated, `requireUser()`. A list of the reader's quotes newest first: text, book, date, view
count, "Copy link", and "Delete". Delete calls `remove_shared_quote` through a server action and
revalidates the page. The library page gains a "Shared quotes" link when the count is above zero.

### Admin

`/admin/quotes` lists the newest 200 active cards with book, excerpt, owner email, views, the
public link, and a "Remove" control; `?book=<id>` filters to one book, and the book editor links
there. Admin actions go through `requireAdmin()` and the admin's own session; the RPCs re-check
`is_admin()`.

## 9. Security and Privacy

- The card never names the reader. The owner's identity is visible only in their own library and
  to admins.
- The quote is bounded at 300 graphemes by the same helper the reader and S12 use, so the card
  cannot become a copy channel.
- Codes are random, not sequential; enumeration yields nothing beyond public cards.
- `view_quote` goes through the analytics beacon's quota, so a card cannot be used to inflate writes.
- Removed cards 404. The code is not reused.
- The analytics beacon carries ids only, as in S14.

## 10. Testing

| Layer | Coverage |
| --- | --- |
| pgTAP `067_s16_shared_quotes.sql` | Entitled reader creates through the publication; a reader without entitlement gets EB039; the 201st active quote gets EB038 and removal frees a slot; HTML-tag text rejected; code is 10 chars; `share_quote` is written with ids only; `catalog_shared_quote` hides removed rows and unpublished books; owner removes own but not another's; `my_shared_quotes` counts views from analytics; admin removal writes audit without text; no role reads the table directly |
| Vitest `lib/reader/quote.test.ts` (extend) | Share payload substitutes the card URL and keeps the attribution lines |
| Vitest `components/reader/reader-selection-toolbar.test.tsx` | Share calls the route, uses the returned URL, and falls back to the canonical URL on failure without an error toast |
| Vitest card page | Metadata is `noindex, follow` with canonical on the book page; the OG route path matches |
| Playwright `shareable-quotes.spec.ts` | Reader shares from the reader, the card opens signed out with cover and Buy, the OG image route returns `image/png`, the owner deletes and the card 404s |
| Visual | The card at 390/768/1440px and the OG image fixture for a long Vietnamese quote with diacritics |

## 11. Exit Criteria

- Share from the reader produces a working public card URL in one tap, and never blocks when the
  server is unavailable.
- The card renders the book's current action for the viewer and links to the book page.
- Link previews in a chat app show the generated image with the quote text.
- A deleted card is unreachable and its code is never reissued.
- `npm run check`, `npm run db:test`, and `npm run check:full` pass against a local Supabase stack.
- `lib/supabase/database.types.ts` reflects the new table, column, and functions.
