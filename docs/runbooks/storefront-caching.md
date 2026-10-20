# Runbook: storefront static caching

Which storefront routes are prerendered, what breaks that silently, what invalidates a prerendered
page, and how to check cache state in production. `docs/runbooks/storefront.md` owns when a page
*shows content at all* (publish state, localization); this runbook owns whether that page is served
from a prerendered cache or rendered fresh on every request.

This is the permanent home for the diagnosis and bisection that shaped
`docs/superpowers/plans/2026-09-23-storefront-static-caching.md`. That plan document (and its ledger,
`.superpowers/sdd/2026-09-23-storefront-static-caching/progress.md`) are scratch files for one
branch of work and are not expected to survive it. `app/[lang]/layout.tsx`,
`app/[lang]/not-found.tsx`, and `app/[lang]/forbidden.tsx` cite this runbook, not the plan, for
exactly that reason.

## Which routes are prerendered

| Route | Prerendered? | Why |
| --- | --- | --- |
| `/{locale}` (home) | Yes, concrete page per locale, if the build has a server environment | Renders from the locale param alone - no catalog content required to produce a page, just credentials (see below) |
| `/{locale}/books/<slug>` | Registered as prerenderable; a concrete page per published book at build time is *required* by the guard's stronger mode - a catalog with zero books is not a valid product state | Cause (C) and (E) removed — see below |
| `/{locale}/authors/<slug>`, `/{locale}/series/<slug>`, `/{locale}/topics/<slug>`, `/{locale}/bundles/<slug>` | Registered as prerenderable; concrete pages only if the relation exists at build time (0 is a normal, legitimate state for all four) | No per-viewer read; never had a `searchParams` read |
| `/{locale}/books` (filtered catalog list) | **No — deliberately dynamic** | `CatalogFilterForm` is a plain GET form with no JavaScript requirement, and `generateMetadata` reads `searchParams` to mark filtered views `noindex`. Converting it to client-side filtering would trade both properties for one URL. Do not "fix" this. |
| `/{locale}/search` | **No — deliberately dynamic** | Same reasoning as `/books`; reads `q` from `searchParams`. |
| `/sitemap.xml`, `/robots.txt` | Yes, `revalidate = 300` | Only prerender when the build has a server environment (`getServerEnv()`); a build with no Supabase credentials (the CI `web` job) falls back to per-request rendering via `deferPrerenderWithoutServerEnv()` instead of failing. |

**`CatalogBookCard.series` is nullable and `topics` can be an empty array** - a catalog of standalone
books with no series or topic relations is a completely valid product state. Do not "fix" a build
that has zero series or zero topics; that is data, not a defect. The only entity type this repo can
say is never legitimately zero, by the data model itself, is books: a storefront needs at least one
published book to mean anything.

### `npm run check:prerender` — two independent checks, not one

Conflating "did a route go dynamic" with "does the catalog have content" broke CI once already: the
e2e job's Supabase stack starts genuinely empty (`supabase/config.toml` disables seeding on purpose),
and Playwright's `webServer` builds the app before any spec has created anything, so a
content-required check there failed on every clean run for a data reason, not a dynamism one. The
guard now runs two separable checks:

- **`npm run check:prerender`** (default, always safe to run, needs no catalog data and no Supabase
  credentials to mean something): did a route silently go fully dynamic? A route with
  `generateStaticParams` keeps a `dynamicRoutes` manifest entry even when it returns zero slugs - an
  empty array and a populated one write byte-for-byte identical entries - so the only way that entry
  disappears is a real request-time read creeping back into the render tree. This is what
  `npm run check` runs, and it passes with no `.env.local` at all: home's registration is skipped in
  that case, since it is legitimately, deliberately fully dynamic without an environment
  (`deferPrerenderWithoutServerEnv()`), which would otherwise be indistinguishable in the manifest
  from the actual regression this check exists to catch. **What catches an actually credential-less
  production deploy, since this check does not?** The deploy itself: `deferPrerenderWithoutServerEnv()`
  only defers the *build-time* read to request time, it does not supply credentials. If a production
  deployment is genuinely missing them, the first real request to home or the root layout throws
  `getServerEnv()`'s error immediately and visibly (a 500), rather than silently serving a broken
  page - this is a deploy-configuration mistake, not something a build-time manifest check can catch.
- **`npm run check:prerender:content`** (opt-in, `--require-content`, needs real credentials and a
  populated catalog): did `generateStaticParams` actually produce a concrete page for `/{locale}` and
  `/{locale}/books/<slug>` — the only two routes safe to always require content for. CI's `e2e` job
  seeds one representative book (`scripts/seed-e2e-prerender-catalog.ts`, via
  `e2e/support/catalog.ts`'s fixture) before Playwright's `webServer` builds, specifically so this
  check means something there. Run it locally, or against a production build, whenever you want to
  verify the catalog itself - not just the mechanism - actually prerenders.

A route silently going dynamic has no manifest entry at all in either mode, which is what both
actually detect.

**A manifest entry is necessary but not sufficient.** It cannot tell you the canonical URL is right,
that `<html lang>` matches the visitor's locale, or that a book's description is still in the raw
HTML after an island took the interactive parts client-side. `e2e/seo-operations.spec.ts` asserts on
the raw response (`request.get()`, never `page.goto()`) for exactly that reason — see "How to test
this locally" below.

## What invalidates a prerendered page

`revalidateStorefront()` (`lib/catalog/revalidate.ts`) is the one function that invalidates the
storefront:

```ts
export function revalidateStorefront() {
  revalidatePath("/[lang]", "layout");
  revalidatePath("/sitemap.xml");
}
```

`revalidateBookAdmin(bookId)` and `revalidateBundleAdmin(bundleId)` both call it, and both are called
from every admin mutation that changes what a public page shows: publish, unpublish, slug rename,
price change, localization edit, cover replace. There is no separate per-page invalidation — one
call refreshes home, every book/entity/bundle page, the filtered list, and search together. The
local EPUB worker (`lib/epub/worker.ts`, `scripts/ebook.ts`) is not one of those callers: it only
ever moves a publication to `ready_for_preview` and never sets `books.active_publication_id` or
touches `books.status` — that happens exclusively in the admin's publication review/publish/reject/
rollback Server Action (`app/admin/publications/[publicationId]/actions.ts`), which does call
`revalidateStorefront()`. So there is no gap on that path: every way a publication actually becomes
visible already revalidates.

**A write that bypasses every admin Server Action does not refresh a prerendered page — nothing
short of the revalidate window elapsing will.** This is a real, deliberate property of a prerendered
storefront, not a bug, but it bit the E2E suite once already: `e2e/support/catalog.ts`'s fixtures
write through the service-role client directly, for speed and test isolation, which is exactly such
a bypass. `POST /api/operations/revalidate-storefront` exists for this - bearer-authenticated with
`OPS_WORKER_SECRET`, identically to `/api/operations/run` - and `e2e/support/revalidate.ts` calls it
after any fixture write a test then expects to see on a prerendered page (the home page in
particular; a detail page for a brand-new slug renders on demand and needs no revalidation, since
`dynamicParams` stays on). Call it after seeding, not instead of seeding realistically: this route
does not shorten or bypass `revalidate = 300` anywhere else, it only performs the same invalidation
a real admin action performs.

**`revalidatePath()`'s first argument is a route pattern typed as a plain string, not a reference to
a file.** Renaming the segment folder from `app/[locale]` to `app/[lang]` (Task 5 of the caching
plan) left `revalidatePath("/[locale]", "layout")` behind as dead code — a string literal that no
type checker or test catches. Every admin publish would have silently stopped invalidating the
storefront if the rename had not been caught by hand. **If you rename a route segment folder, grep
for the old segment name in every `revalidatePath()` / `revalidateTag()` call before you consider the
rename done.**

## The five causes that made every storefront route dynamic

Measured against production on 2026-09-23, before this plan's work: every storefront response
carried `cache-control: private, no-cache, no-store, max-age=0, must-revalidate` and
`next build` marked all 60+ app routes `ƒ (Dynamic)`. Five independent request-time reads, found by
grepping the render tree:

| # | Cause | Where it lived | Fix |
| --- | --- | --- | --- |
| A | `headers()` read for `<html lang>` | `app/layout.tsx` (single shared root layout) | Split into one root layout per top-level area (`/[lang]`, `/admin`, `/internal`), each reading its own segment's `params` instead of a request header |
| B | `cookies()` + `supabase.auth.getUser()` for the signed-in nav | `components/site-header.tsx` via `lib/supabase/server.ts` | Moved to a client island, `components/site-header-account-nav.tsx`, that resolves the session in the browser after the page has already rendered |
| C | `searchParams` read for the `action-error` banner | book and bundle detail pages | Moved to a client island, `components/catalog/action-error-banner.tsx`, that reads the URL in the browser |
| D | No `generateStaticParams` under the locale segment | the locale layout and every catalog leaf page | Added, sourced from `lib/catalog/static-params.ts` |
| E | The viewer's own ownership/entitlement state, read during render | `getBookActionState()` / `getBundleActionState()`, both of which called `getCurrentProfile()` → `cookies()` | Split into a public, session-free render (`publicBookAction()` / the public bundle read) plus a client island (`ViewerBookAction` / `ViewerBundleAction`) that fetches `/api/catalog/{books,bundles}/<id>/action-state?locale=<locale>` and corrects the page after the fact |

(A)–(D) affected every storefront route. (E) affected only the book and bundle pages — the two most
valuable pages in the set, so it was not optional to fix.

Each viewer-correction island sends the locale it rendered in; the route handler resolves the
entity in that locale only rather than searching every locale for whichever answers first. This is
deliberate (an earlier version searched cross-locale and produced a book showing "You own 2 of 1"
under partial localization) and it means **a bundle that exists but is not localized in the
requested locale 404s from its action-state route** — this is the same rule the public catalog read
already enforces, not a special case the route invented. `e2e/seo-operations.spec.ts` seeds a
vi-only bundle and asserts the `en` action-state request 404s while `vi` answers 200.

## The bug that cost the longest bisection: `not-found.tsx` / `forbidden.tsx`

**A `headers()` read in EITHER `app/[lang]/not-found.tsx` OR `app/[lang]/forbidden.tsx` keeps the
entire `[lang]` segment dynamic — silently, with no build error.** Both files are part of the render
tree Next has to be able to produce while prerendering every route in the segment, not just the ones
that actually 404 or get denied. Having either one depend on a request-time API was enough on its
own to stop the whole segment from prerendering with concrete params.

**Either file alone is enough**, which is what made this expensive to find: testing them one at a
time gives two misleading negatives. Hardcoding only `not-found.tsx` changes nothing; hardcoding
only `forbidden.tsx` changes nothing; only hardcoding *both together* produces concrete prerendered
pages. An earlier experiment that hardcoded one file and saw no improvement was read as ruling out
that file as a cause — it did not; it just hadn't cleared the other one yet.

Both files now hardcode `defaultLocale` (`vi`) instead of reading the locale from a request header:
a 404 or a forbidden page always renders Vietnamese copy, even for an English visitor. This is a
small, deliberate cost. `forbidden()` only ever fires from `requireAdmin()`, which no storefront page
calls, so `forbidden.tsx` is close to unreachable from a real customer's path anyway.

**Do not "fix" this by restoring a `headers()` read in either file.** That will silently undo
prerendering for every route under `/[lang]`, with no build error to tell you it happened — the only
way to notice is `npm run check:prerender` failing, or measuring `next build`'s route table by hand.

A route segment rename (`app/[locale]` → `app/[lang]`, kept in `app/[lang]/layout.tsx` and
`app/internal/[lang]/layout.tsx`) was tried first as a fix for this and **did not work** — the actual
cause is the two files above. The rename's necessity is unproven; it is kept because reverting it
would be pure churn with no user-visible effect, and because it caught the `revalidatePath()` string
literal bug described above. URLs did not change: `/vi/books` is still `/vi/books`.

## Checking cache state in production

**Do not assert on `s-maxage`.** Vercel consumes and strips that directive before the response
reaches a client — `/sitemap.xml` was measured on 2026-09-23 returning
`cache-control: public, max-age=0, must-revalidate` with `x-vercel-cache: HIT`, i.e. correctly cached
and showing no `s-maxage` at all. See
<https://vercel.com/docs/caching/cache-control-headers>.

Check the cache state instead, with a GET so the body is checked too, repeated so the first response
can be the one that populates the cache:

```bash
for i in 1 2 3; do
  curl -s -o /tmp/p.html -D - -A Googlebot "$SITE_URL/en/books/<a-published-book-slug>" \
    | grep -iE "^(cache-control|x-vercel-cache|x-vercel-id|age)"
  echo "---"
done
grep -c 'application/ld+json' /tmp/p.html
```

Expected: `x-vercel-cache: HIT` from the second request on, `x-vercel-id` showing `hnd1` as the
function region, and the body still carrying its JSON-LD.

Then publish a book from `/admin` and confirm it appears on `/{locale}/books`, on its own detail URL
and in the sitemap without a redeploy.

### The proxy is not removed by prerendering

`proxy.ts`'s matcher covers every storefront path. On each matched request it may look up a stored
redirect (`lib/redirects/resolve.ts`) and then calls `updateSession()`, which runs
`supabase.auth.getUser()` and can write refreshed cookies onto the response. That does not make a
page dynamic and does not stop the CDN serving it, but it does put a floor under TTFB that no amount
of prerendering removes.

**The stored-redirect lookup caches negatively.** `lib/redirects/resolve.ts`'s
`REDIRECT_CACHE_TTL_MS` (60 seconds) caches a miss per exact source path, process-local. If a path is
requested (and 404s, or serves its old content) *before* a redirect for it is created, that miss is
cached for up to a minute — the redirect will exist in the database but not yet be honored. This is
by design (the cache's own comment: correctness never depends on it, only latency does) but it is
easy to trip over in a test or a manual check: don't probe a URL immediately before renaming the
slug that URL belongs to.

## How to test this locally

Prerendering does not happen under `next dev` — `npm run dev` never triggers `generateStaticParams`
or writes a concrete page. `playwright.config.ts`'s default `webServer` already runs
`npm run build && npm run start` (not `next dev`) for exactly this reason; `npm run test:e2e` and
`npm run check:full` exercise the production build, not a dev server. If you are adding an assertion
about prerendered HTML, put it in `e2e/seo-operations.spec.ts` and fetch with `request.get()`, never
`page.goto()` — the point is what a crawler or answer engine gets without running JavaScript.
`page.goto()` hydrates the page, which can paper over server HTML that never had the content at all.

Run only against a **local** Supabase stack (AGENTS.md; never the cloud project). See
`docs/runbooks/testing-environments.md` for exporting the Supabase and Mailpit variables before the
build, and for the free scratch port range (613xx has worked on this machine; 54–59xxx are typically
held by another stack).
