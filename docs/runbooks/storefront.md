# Runbook: storefront

The storefront is every public page under `/vi` and `/en`. It shows only published catalog data.

## Pages

| Page | URL |
| --- | --- |
| Home | `/{locale}` |
| All books | `/{locale}/books` |
| Book | `/{locale}/books/<slug>` |
| Author | `/{locale}/authors/<slug>` |
| Series | `/{locale}/series/<slug>` |
| Topic | `/{locale}/topics/<slug>` |
| Search | `/{locale}/search?q=<words>` |
| Read a sample | `/{locale}/read-sample/<slug>` |

`/{locale}/read-sample/<slug>` is public — no sign-in wall, since a sample is meant to be readable
by an anonymous visitor — but it is `noindex`: it is a reading application, not a page a search
engine should surface, and the book page is what should rank. It 404s when any of these hold: the
locale has no localization for that book, the book is not published, the book has no active
publication, or the sample allowlist (`book_samples.allowed_hrefs`) is empty. All four collapse to
the same 404 by design, so from outside a draft book and one with no sample are indistinguishable.

## When a page shows

- A **book** shows when it is published and has copy in that language.
- An **author**, **series**, or **topic** shows when it is published, has copy in that language, and
  has at least one visible book in that language.
- Anything else returns 404. A page never borrows copy from the other language.

## Common questions

- **"My book shows in Vietnamese but not English."** Add English copy in the book editor.
- **"The author page is 404."** Publish the author, add copy in that language, and check that one
  of their books is published in that language.
- **"The book says Not available yet."** The book has no active EPUB version, or no active offer.
- **"A paid book says Coming soon."** Payments are disabled in this environment. This is expected in
  production.
  Paid checkout also needs `commerce_settings.payments_enabled`. See `docs/runbooks/checkout.md`.
- **"The old book URL is 404 after a slug change."** The slug change stored a redirect, and Proxy
  serves it (see *Redirects* below). If the old URL still 404s, check that it is exactly the stored
  source path - redirects match whole paths, not prefixes.
- **"Search does not find a book."** Search needs at least 2 characters. It ignores accents and
  case. It only finds published books with copy in the page language.

## Search engines (S5)

**Canonical URLs.** Every public page names one canonical URL on `SITE_URL`: the page's own path
with no query string. A catalog filter or sort (`/{locale}/books?topic=…&sort=…`), a search query,
an `?action-error=` code, and a sign-in return path never appear in a canonical URL. A filtered or
sorted catalog view, and every search page, is `noindex, follow` and points its canonical at the
unfiltered route.

**Language alternates.** Fixed pages (home, all books, search) list both `vi` and `en` as
`<link rel="alternate" hreflang>`. A book, author, series, or topic page lists the other language
only when that item has copy in it; otherwise the page names only itself.

**Structured data.** A book page carries one JSON-LD block with `Book` (its author as `Person`,
and an `offers` array: the ebook `Offer` when priced, plus one paperback `Offer` per active retailer link) and a `BreadcrumbList`. The home page carries
`Organization`; author pages carry `Person`; catalog and entity pages carry `BreadcrumbList`. Only
fields the page itself displays are included, and `<` is escaped so catalog text cannot end the
script element.

**Not indexed.** Samples, search, account, checkout, library, reader, sign-in and the other auth
pages, and all of `/admin` send `noindex, nofollow` (search sends `noindex, follow`). The private
route groups set this in their layouts as metadata only; each page still authorizes itself.

**Sitemap.** `/sitemap.xml` lists both home pages, both unfiltered catalog pages, every published
book in each language it has copy in, and each author, series, and topic page that has a visible
book in that language. Nothing private, no search or sample URL, and never a draft. It is cached
for 300 seconds, and every admin catalog change revalidates it at once.

**Robots.** `/robots.txt` allows the storefront, names `SITE_URL/sitemap.xml`, and disallows
`/admin`, `/api`, `/auth`, `/internal`, and for each locale `account`, `checkout`, `library`,
`read/`, `read-sample`, `search`, `sign-in`, `sign-up`, `password-reset`, and `password-update`.
Robots controls crawling only; page metadata is what keeps a page out of the index.

**Redirects.** A slug change stores `old path -> new path` in `redirects`, and re-points any older
redirect at the new path so a chain never forms. Proxy looks the request path up before anything
else, for `GET` and `HEAD` only:

- An exact match on the whole path returns `308` with `Location` set to the stored destination on
  the same origin. The old query string is dropped, because the destination is a canonical path.
- `/api`, `/auth`, `/admin`, `/internal`, `/_next`, metadata images, and static files are never
  looked up.
- A destination that is not a plain same-site path (a scheme, a host, `//`, a backslash, a
  fragment) or that points at a private page is ignored and the request continues normally.
- Lookups are cached per server instance for up to 60 seconds, so a new or changed redirect can take
  a minute to apply everywhere. A failed lookup is logged with the request ID and the page still
  loads.

Checking a page, the sitemap, and robots after a deployment is covered in
[SEO and operations](seo-and-operations.md), section 11.

## Home page

`/admin/merchandising` sets the featured book and the home shelf. A book that is not visible in a
language is left out of that language's home page.

## Data access

Public pages call four read functions: `catalog_book_cards`, `catalog_book_page`,
`catalog_entity_page`, and `search_catalog`. They filter to published rows themselves, so an admin
sees the same storefront as a reader. Public pages never use the service-role key.

## Deploying S2

1. Set `NEXT_PUBLIC_SUPABASE_URL` in the build environment, not only at runtime. `next.config.ts`
   builds `images.remotePatterns` from it at build time. Without it, cover images do not load.
2. Before `supabase db push`, check where `pg_trgm` lives on the target project:

   ```sql
   select extnamespace::regnamespace from pg_extension where extname = 'pg_trgm';
   ```

   No row, or `extensions`, is fine. If it returns `public`, stop. Resolve that first, because the
   search migration creates `pg_trgm` in the `extensions` schema and calls it from there.
3. Do not release S2 to production before S3 and S4. Until S4 ships, the "Read a sample" link
   returns 404. Get and Buy are live since S3. See `docs/runbooks/checkout.md`.
