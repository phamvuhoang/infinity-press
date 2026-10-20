# S2 Public Discovery Design

**Status:** Draft for review
**Date:** 2026-09-15
**Issue:** #4
**Parent spec:** `docs/superpowers/specs/2026-09-13-remaining-mvp-ebook-launch-design.md` (section S2)
**Builds on:** S1 catalog admin (PR #15)

## 1. Goal

A reader can find a book and decide if they want it.

Today the storefront has one marketing page. S1 gave operators a full catalog. S2 shows that
catalog to readers.

## 2. What S2 Delivers

All routes live under `/{locale}`. All are Server Components.

| Route | Board | What it shows |
| --- | --- | --- |
| `/` | 1e | Hero, featured book, and home shelf from merchandising |
| `/books` | — | All published books, with filters and sort |
| `/books/[slug]` | 1g | Full book page and the book action |
| `/authors/[slug]` | 1u | Author copy and their books |
| `/series/[slug]` | 1v | Series copy and its books in order |
| `/topics/[slug]` | 1s | Topic copy and its books |
| `/search?q=` | — | Grouped search results |

## 3. Out of Scope

- The Get and Buy actions. S3 builds them.
- The sample reader page. S4 builds it. S2 only links to it.
- Canonical URLs, `hreflang` tags, Open Graph, JSON-LD, sitemap, and robots. S5 builds them.
- Slug redirects in the proxy. S5 builds them. Until then, an old slug returns 404.
- Pagination. The launch catalog is small.
- Lighthouse and axe checks. S6 runs them.

## 4. Key Decisions

### 4.1 Public reads go through read-only RPCs

Anonymous visitors cannot read most catalog tables today. Localizations, series, topics, and
merchandising are admin-only. Cover storage keys are hidden by a column grant.

S2 adds a small set of `security definer` read functions. Each one:

- filters to `published` rows **explicitly**;
- returns only rows that have a localization in the requested locale;
- returns only the fields a public page shows;
- is granted to `anon` and `authenticated`.

**Why not new RLS policies?** Admins already have "read everything" policies. A public page
rendered for an admin would show drafts. Explicit filters in one function fix this in one place.
One function call also replaces many nested PostgREST queries.

The functions:

| Function | Returns |
| --- | --- |
| `catalog_book_cards(p_locale)` | One row per visible book: slug, title, author, cover, price, topics, series, merchandising position, `has_sample` |
| `catalog_book_page(p_locale, p_slug)` | One `jsonb` object with the full book page, or `null` |
| `catalog_entity_page(p_kind, p_locale, p_slug)` | One `jsonb` object for an author, series, or topic, or `null` |
| `search_catalog(p_locale, p_query)` | Ranked matches for books, authors, series, and topics |

Pages call these functions with a Supabase client that has **no cookies**. The client runs as
`anon`. So a public page never depends on who is signed in, except for the book action.

### 4.2 What "visible" means

- A **book** is visible when `books.status = 'published'` and it has a localization in the locale.
- An **author** is visible when the author is published, has a localization in the locale, and has
  at least one visible book.
- A **series** or **topic** is visible under the same rule as an author.
- A book that is visible but has no active publication shows the `unavailable` action.

An author, series, or topic with no visible books returns 404. This avoids empty pages. It also
covers an author left published after their only book was unpublished.

### 4.3 Filtering happens in TypeScript

`/books` loads all cards for the locale once. A pure function filters and sorts them.

- Filters: `topic`, `author`, `series` (all localized slugs), and `price` (`free` or `paid`).
- Sort: `featured` (default), `newest`, or `title`.
- `featured` puts home shelf books first, in shelf order. The rest follow, newest first.
- `newest` uses `books.created_at`. The schema stores no publish date.
- `title` uses `Intl.Collator` for the page locale.
- Unknown filter values are ignored. They never cause an error.

This is simple and fully unit-tested. Revisit it when the catalog passes about 500 books.

### 4.4 Book action

`resolveBookAction` lives in `lib/catalog/book-action.ts`. It follows parent spec §3.3 exactly.

- `hasActiveEntitlement` comes from the signed-in reader's own entitlements, filtered by
  their profile ID. (Admins can read all entitlements, so the filter is required.)
- `paymentsEnabled` is `PAYMENT_PROVIDER !== "disabled"`.

The book page renders one control for the result:

| Action | Signed out | Signed in |
| --- | --- | --- |
| `read` | — | Link to `/{locale}/read/[bookId]` |
| `get_free` | Link to sign-in, `next` = book page | Disabled "Get free" button |
| `buy` | Link to sign-in, `next` = book page | Disabled "Buy" button |
| `coming_soon` | Disabled "Coming soon" button | Same |
| `unavailable` | "Not available" text | Same |

The signed-in Get and Buy buttons stay disabled until S3 wires them. A signed-out reader never
sees `read`, because they hold no entitlement.

### 4.5 Search

`search_catalog` uses `unaccent` (already installed) and `pg_trgm` (added in S2).

- Text is normalized with `lower(unaccent(text))`. So "Đắc Nhân Tâm" matches "dac nhan tam".
- The query must be 2 to 100 characters after trimming. Otherwise the result is empty.
- Each row gets a score:
  - `3`: the normalized name equals the query.
  - `2`: the name starts with the query.
  - `1`: the name contains the query, or trigram word similarity is at least `0.4`.
- A book also scores `3` when its author's name equals the query.
- The function returns at most 20 rows per kind.

The page shows books first, sorted by score and then title. Then it shows grouped authors, series,
and topics. An empty or short query shows a helpful empty state.

No search index is added. The catalog is small, and `unaccent` is not immutable.

### 4.6 Translation fallback

This follows parent spec §3.4.

- A missing localization returns 404. No page borrows another locale's copy.
- Each page knows the entity's slug in the other locale, if it exists.
- The language switcher links to that URL. Otherwise it links to the other locale's home.

`SiteHeader` gets an optional `alternates` prop for this.

### 4.7 Covers

- Covers render with `next/image` inside a fixed 2:3 box.
- `next.config.ts` allows the Supabase public `covers` path in `images.remotePatterns`.
- Next.js refuses to optimize images from loopback hosts. So the image is `unoptimized` when the
  Supabase URL is local.
- A book without a cover row falls back to the existing typographic `BookCover`.

### 4.8 Metadata

S2 sets only a page `title` and `description`. Filtered `/books` views and every `/search` page set
`robots: { index: false }`. S5 adds everything else.

### 4.9 Freshness

Public pages read cookies in `SiteHeader`, so they render per request. Admin saves still call
`revalidatePath("/[locale]", "layout")`, so a future cached page stays correct.

## 5. Page Content

### Home (`/`)

- Keep the hero and the three principles band.
- The hero cover shows the featured book when one is set. It links to the book page.
- A "Home shelf" section lists shelf books in order. It is hidden when the shelf is empty.
- Add a "Browse all books" link to `/books`.

### Book page (`/books/[slug]`)

In reading order:

1. Cover, title, subtitle, and author link.
2. Price and the book action control.
3. A "Read a sample" link to `/{locale}/read-sample/[slug]`, only when `has_sample` is true.
4. Short description and description.
5. "Who it is for" (audience), when set.
6. Key ideas list, when set.
7. Series link with position ("Book 2 in …"), when set.
8. Topic links, when set.
9. FAQ as a `<details>` list, when set.

Empty sections are not rendered.

### Author, series, and topic pages

Name, description, and a grid of book cards. Series books sort by position. Author and topic books
sort newest first.

### Catalog page (`/books`)

A plain HTML `GET` form with four selects, a sort select, and an "Apply" button. It needs no client
JavaScript. A "Clear" link resets filters. An empty result shows a message and the Clear link.

## 6. Accessibility and Performance

- Touch targets are at least 44px (`min-h-11`).
- Every control works by keyboard. Links are real `<a>` elements. Filters are a real form.
- Each page has one `h1`.
- Covers have alt text from `media_assets.alt_text`.
- Targets from the parent spec: p75 LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1. S6 measures them.

## 7. Security

- No service-role client is used on public pages.
- The read functions never return drafts, even to admins.
- They never return EPUB storage keys, publication IDs for paid content, or entitlement data.
- The cover object path is returned. The `covers` bucket is already public.
- The sign-in `next` value is the book page path. `getSafeRedirect` already allows it.

## 8. Testing

- **pgTAP:**
  - Draft books, draft authors, draft series, and draft topics never appear, including for an
    admin caller.
  - A book without a localization in the locale does not appear.
  - `has_sample` is true only with a sample for the active publication.
  - Search matches with and without Vietnamese diacritics, including `đ`.
  - Search ranks an exact title above a partial match.
  - `anon` can execute the four functions. It still cannot select the source tables.
- **Vitest:** `resolveBookAction` (every row of the table), price formatting, filter parsing,
  filter and sort, search result grouping, the data layer, and the book action control.
- **Playwright:** home → book → Get free → sign in by magic link → back on the same book page.
  Also: a missing translation returns 404, and the switcher follows §4.6.

## 9. Exit Criteria

- Only published entities render, at stable locale-prefixed URLs.
- Search matches with and without Vietnamese diacritics.
- A missing translation returns 404, and the language switcher follows §4.6.
- Playwright: home → book → sign in → return to the same book.
- `supabase test db` and `npm run check:full` pass on a clean local stack.
