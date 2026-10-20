# Remaining MVP: Ebook-Only Launch Design

**Status:** Approved; revised on 2026-09-19 to add S5.5 Reader Depth and Visual Parity
**Date:** 2026-09-13
**Scope:** GitHub issues #1–#11 (tracker #12), after PR #13 (ebook golden path) and PR #14 (UI design)
**Builds on:** `docs/superpowers/specs/2026-09-11-mvp-foundation-and-spikes-design.md`

## 1. Purpose

Finish the MVP as an **ebook-only launch**: a reader discovers a book, gets or buys it, and reads it,
and operators run the catalog without database edits.

The golden path already proves one book end to end. This spec covers everything between that slice
and a production launch, split into seven delivery stages (S1, S2, S3, S4, S5, S5.5 and S6). Each
stage gets its own implementation plan, written only when its dependencies have merged.

## 2. Decisions

| Topic | Decision |
| --- | --- |
| Scope | Ebook-only. No physical books, shipping, COD, inventory, or fulfillment. |
| Paid books at launch | Production launches with free ebooks and admin-granted access. Paid books show price and sample with a "coming soon" state. |
| Payments | No real provider in this spec. The paid flow is built and tested end to end on the simulator (local/staging). A real provider is a separate post-launch spec. |
| Checkout | Single-book checkout. No cart. One order has one ebook item. |
| Identity | Sign in first. Get and Buy require a verified magic-link session. No guest checkout or guest claim. |
| Public entities | Books, authors, topics, series. Articles, ideas, and collections stay P1. |
| EPUB processing | Operator-run CLI (`npm run ebook`) in production, with stuck-job detection and alerts. |
| Analytics and notifications | Minimal and in-house: an events table, one "book ready" email through an outbox, operational checks with a scheduled alert. |
| Reader depth | P1.1 is pulled into the launch sequence as S5.5: visual parity, highlights, notes, bookmarks, in-book search, stable digital positions and copy/share-limited quotes. Ask Infinity remains P2.1 and is shown only as a disabled future affordance. |
| Delivery approach | One umbrella spec (this file) plus one plan per sub-project, written just in time. |

These decisions supersede the physical-commerce and real-provider parts of issues #3–#11 and the
PRD. S6 rewrites the issues to match.

## 3. Cross-Cutting Architecture

### 3.1 Application

- Next.js 16 App Router and Supabase, as implemented.
- Public pages are Server Components that read published data through `lib/data/*`.
- Every page and Server Action calls `requireUser()` or `requireAdmin()` itself. Layouts never
  authorize.
- Admin mutations that change public data call `revalidatePath` for each affected public route.
- Customer routes stay under `/{locale}` (`vi`, `en`). Admin stays at `/admin` without a locale.

### 3.2 Schema additions

All changes ship as new migrations. Applied migrations are never edited. Each migration updates
`lib/supabase/database.types.ts` and adds pgTAP tests, including cross-user negative cases.

| Addition | Sub-project | Purpose |
| --- | --- | --- |
| `series`, `book_series (book_id, series_id, position)` | S1 | Series membership and order |
| `author_localizations`, `topic_localizations`, `series_localizations` | S1 | Localized `slug`, `name`, `description`, unique `(locale, slug)` |
| `book_localizations` columns: `audience`, `key_ideas jsonb`, `faq jsonb`, `seo_title`, `seo_description` | S1 | Book-page content contract (PRD §5.2) |
| Public `covers` storage bucket | S1 | Cover images. EPUB buckets stay private. |
| `search_catalog(locale, query)` RPC with `unaccent` and `pg_trgm` | S2 | Diacritic-insensitive lexical search |
| `create_ebook_order(offer_id)` and `revoke_order_entitlement(order_id, reason)` RPCs | S3 | Server-authoritative order creation and audited revocation |
| `analytics_events`, `notification_outbox` | S5 | Funnel events and idempotent email |

JSON columns are validated by Zod schemas in `lib/catalog/` before any write.

### 3.3 Book action resolution

One pure function decides what a reader can do with a book:

```ts
type BookAction = "read" | "get_free" | "buy" | "coming_soon" | "unavailable";

resolveBookAction(input: {
  hasActiveEntitlement: boolean;
  offer: { priceMinor: number; active: boolean } | null;
  hasActivePublication: boolean;
  paymentsEnabled: boolean;
}): BookAction;
```

- `read` when the reader holds an active entitlement and the book has an active publication.
- `unavailable` when there is no active offer or no active publication.
- `get_free` when the active offer's price is 0.
- `buy` when the price is above 0 and `paymentsEnabled` is true.
- `coming_soon` when the price is above 0 and `paymentsEnabled` is false.

`paymentsEnabled` is true only when `PAYMENT_PROVIDER` is not `disabled`. Production uses `disabled`
and already rejects `simulator`. The book page, search results, sample reader, and library all use
this function. The server re-checks the same rules in every action and RPC.

### 3.4 Translation fallback policy

- A public entity URL exists in a locale only when that locale has a localization row.
- Without one, the URL returns 404. No page is rendered from another locale's copy.
- The language switcher links to the entity's URL in the other locale when it exists, and to that
  locale's home otherwise.
- `hreflang` alternates list only existing localizations.

### 3.5 Orders and payments

- Free offers use the existing `acquire_free_ebook` RPC.
- Paid orders are created only by `create_ebook_order`, running as the signed-in user. It re-reads the
  active offer, snapshots title and price into `orders` and `order_items`, and returns the existing
  pending order for the same profile and book instead of creating a second one. It raises an error
  when payments are disabled.
- Payment outcomes enter only through the existing `apply_payment_event` RPC, which deduplicates by
  provider event ID and grants exactly one entitlement.
- A browser redirect never changes order state.
- `PaymentProvider` gains `createSession(order): Promise<{ redirectUrl: string }>` beside the
  existing `verifyEvent`.

## 4. Sub-Projects

Order: S1 → S2 → (S3 and S4 in parallel) → S5 → S5.5 → S6.

### S1. Catalog domain and admin (issue #3)

**Outcome:** operators can create, edit, and publish launch books and their related entities from
the admin.

**Screens** (each page and action calls `requireAdmin()`):

- `/admin/books`: list with search, status, active publication, and readiness badge.
- `/admin/books/[bookId]`: editor with tabs for Details, Localizations, Edition and offer, Cover,
  Relations (author, series with position, topics), and EPUB and publications.
- `/admin/authors`, `/admin/series`, `/admin/topics`: list and editor, with localized copy.
- `/admin/users` and `/admin/users/[profileId]`: find a user by email, view entitlements, and grant
  or revoke with a reason. The grant and revoke actions already exist.
- `/admin/merchandising`: order books in the `home_featured` and `home_shelf` slots.

**Publish readiness.** A pure `checkBookReadiness(book)` returns blocking issues. A book can be
published only when all of the following hold:

- at least one locale has a title, slug, and description;
- a primary author is set;
- a cover exists;
- an active ebook offer exists;
- an active publication exists.

A `publish_book` RPC runs the same checks and changes `books.status`. The editor shows each blocking
issue with a link to the tab that fixes it.

**Slug redirects.** Changing the slug of a published localization inserts a `redirects` row in the
same transaction. Existing rows that pointed at the old path are rewritten to the new path, so a
redirect never chains.

**Audit.** Book, localization, offer, slug, relation, merchandising, and entitlement changes each
write one `audit_logs` row with actor, action, entity, and a before/after summary.

**Out of scope:** physical SKUs, inventory, translation workflow, SEO preview.

**Exit criteria:**

- An operator creates and edits a complete launch book from the admin only.
- A book with any readiness issue cannot be published, through the UI or the RPC.
- A slug rename produces one redirect with no chain.
- A non-admin receives 403 on every S1 page and action (Playwright).

### S2. Public discovery (issue #4)

**Outcome:** a reader can find and evaluate a book on production-quality public pages.

**Routes** (Server Components under `/{locale}`):

- `/`: home (design board 1e). Featured book and shelves come from merchandising slots.
- `/books`: catalog. Filter by topic, author, series, and price (free or paid). Sort by merchandising
  position, newest, or title. Filters live in search params. Filtered views are `noindex`.
- `/books/[slug]`: book detail (board 1g) with the PRD §5.2 content contract, the action from
  `resolveBookAction`, and a sample link to `/read-sample/[slug]` when a sample exists.
- `/authors/[slug]`, `/series/[slug]`, `/topics/[slug]`: boards 1u, 1v, and 1s.
- `/search?q=`: `search_catalog` results. Exact book title and author matches rank first, followed by
  grouped author, series, and topic results. The page has an empty state.

**Data access:** a new `lib/data/catalog.ts` returns DTOs for published entities only. Drafts and
missing localizations return 404.

**Actions:** a signed-out Get or Buy click sends the reader to magic-link sign-in with `next` set to
the book page. S3 implements the actions; S2 renders the correct state.

**Performance and accessibility:** covers render in a fixed 2:3 box with `next/image`. Catalog pages
ship no client JavaScript except the filter form. Touch targets are at least 44px, and every control
works by keyboard. Targets: p75 LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1.

**Exit criteria:**

- Only published entities render, at stable locale-prefixed URLs.
- Search matches with and without Vietnamese diacritics.
- A missing translation returns 404, and the language switcher follows §3.4.
- Playwright: home → book → sign in → return to the same book.

### S3. Get and buy (ebook subset of issues #5, #6, #7)

**Outcome:** a signed-in reader gets a free ebook or buys a paid ebook on the simulator, and reads it
immediately.

**Get free:** a Server Action calls the existing `acquireFreeEbookAction`, then redirects to
`/{locale}/read/[bookId]`. Repeating it returns the same entitlement.

**Buy** (only when `paymentsEnabled`):

1. A Server Action calls `create_ebook_order` and redirects to `/{locale}/checkout/[orderId]`.
2. The checkout page shows the book, the format "Ebook (EPUB, read on the web)", the server-computed
   total, the account email, and a Pay button. It has no shipping fields and is `noindex`.
3. Pay calls `PaymentProvider.createSession(order)`. The simulator returns
   `/{locale}/checkout/[orderId]/simulate`.
4. The simulator page (404 when `APP_ENV` is not `local`, `test`, or `staging`) offers Succeed, Fail,
   Cancel, and Send duplicate. Each posts a simulated event to
   `POST /api/payments/simulator/webhook`, which calls `verifyEvent` and then `apply_payment_event`.
5. `/{locale}/checkout/[orderId]/status` reads order state from the database and shows processing,
   success with Read now, failed with Try again (returns to checkout for the same order), or
   cancelled.

**Coming soon:** in production, paid books show a disabled "coming soon" control. `create_ebook_order`
and the Buy action both refuse to run.

**Order state rules**, implemented in `lib/commerce/order-state.ts` and mirrored by the RPCs:

- `pending` + succeeded event → `completed` with `payment_status = succeeded`, and one entitlement.
- `pending` + failed event → order stays `pending` with `payment_status = failed` (retry allowed).
- `pending` + cancelled event → `cancelled`.
- Any event for a `completed` or `cancelled` order changes nothing and grants nothing new.

The unit tests and the pgTAP tests run the same table of cases.

**Account:** `/{locale}/account/orders` and `/{locale}/account/orders/[orderId]` show only the
reader's own orders.

**Admin:** `/admin/orders` finds orders by email or ID. The order page shows payments, the event
timeline, and the entitlement. "Revoke access" requires a reason, calls `revoke_order_entitlement`,
writes an audit row, and never affects entitlements from other sources.

**Exit criteria:**

- Free and simulated paid acquisition each create exactly one active entitlement, including
  duplicate and out-of-order events.
- A browser redirect never marks an order paid.
- Production configuration cannot create a paid order (unit and pgTAP).
- Playwright: book → sign in → buy → simulate success → Read now → reader renders.

### S4. Reader completion (issue #9)

**Outcome:** the reader meets the PRD P0 reading requirements, and the public sample works.

- **Settings panel** (board 1k): font size 15–26, font (publisher, Lora, sans), line height (1.5,
  1.75, 2.0), width (narrow, medium, wide), theme (light, paper, dark). It calls
  `ReaderEngine.setPreferences` and stores preferences per device in `localStorage`.
- **Table of contents:** a drawer built from the manifest TOC that calls `engine.goTo`. The top bar
  shows the current chapter title and whole-book progress.
- **Sample reader** at `/{locale}/read-sample/[slug]`: public, uses the existing `/api/samples/*`
  routes through `ReaderEngine`, saves no progress, and ends with the `resolveBookAction` control.
  Returns 404 when the book has no sample.
- **Lost access:** a 401 or 403 from a manifest, resource, or session request shows a "no longer have
  access" state with a link to the library. An expired session while the entitlement is still active
  is re-created once without interrupting the reader.
- **Completion:** at `totalProgression ≥ 0.99`, `save_reading_progress` moves the library item to
  `completed`, and a completion card links back to the library.
- **Corpus matrix runbook:** a checklist for the owner to run the five private EPUBs on desktop Chrome,
  Safari, Firefox, and mobile. Results feed S6.

**Exit criteria:**

- Settings, TOC, and resume work at 390, 768, and 1440px widths.
- The locator restores after a reload that follows a typography change (Playwright).
- The sample reader cannot fetch any href outside its allowlist (existing route tests plus Playwright).
- Revoking an entitlement shows the lost-access state on the next protected request.

### S5. SEO and operations (issue #10)

**Outcome:** launch pages are discoverable, and operators get a signal for every core-journey
failure.

**SEO:**

- `generateMetadata` on every public route: title, description, canonical, Open Graph image (cover),
  and `hreflang` per §3.4.
- Typed JSON-LD builders in `lib/seo/`: `Book` with `Offer` (only when a price is shown), `Person`,
  `BreadcrumbList`, and `Organization`. Builders use only fields that are visible on the page.
- `app/sitemap.ts` lists published locale URLs only. `app/robots.ts` disallows checkout, account,
  library, read, read-sample, admin, and filtered search. Those surfaces also set `noindex` and remain
  authorization-protected.
- Proxy resolves `redirects` for public paths with a short cache and returns 308.

**Analytics:** `trackEvent(name, props)` writes to `analytics_events` from the server. Event names
follow PRD §6.1 for flows that exist: `view_book`, `open_sample`, `begin_checkout`, `purchase`,
`payment_failed`, `open_reader`, `progress_25`, `progress_50`, `progress_75`, `progress_100`,
`view_library`, `book_published`, `epub_job_started`, `epub_job_completed`, `epub_job_failed`.
Properties are limited to IDs, locale, and device class. A schema test rejects any property holding
book text or a locator. Core Web Vitals come from the hosting platform's speed insights, selected in
the S5 plan.

**Notifications:** granting an entitlement inserts one `notification_outbox` row ("your book is
ready") in the same transaction, unique per entitlement. A protected worker route sends pending rows
and records attempts. The email provider is selected in the S5 plan.

**Operational checks** in `lib/ops/checks.ts`:

- processing jobs queued or processing for more than 30 minutes, or with an expired lease;
- completed orders without an active entitlement;
- payment events unprocessed after 5 minutes;
- outbox rows with more than 3 failed attempts.

`/admin/operations` lists every non-empty check with a link to the fix. A scheduled, secret-protected
route runs the checks and emails operators when any check is non-empty. The scheduler is selected in
the S5 plan.

**Exit criteria:**

- Automated fixtures validate canonical, `hreflang`, sitemap, robots, redirects, and JSON-LD.
- Private surfaces are `noindex`.
- Each operational check detects its seeded failure and triggers an alert.
- A duplicate entitlement grant produces one email.

### S5.5. Reader depth and visual parity

**Outcome:** the pre-launch reader matches the approved design and includes the complete former
P1.1 Reader Depth scope.

The authoritative design is
`docs/superpowers/specs/2026-09-19-s5-5-reader-depth-visual-parity-design.md`. In summary, S5.5 adds:

- a persistent desktop sidebar with Contents, Bookmarks and Notes, plus a drawer carrying the same
  features on tablet/mobile;
- responsive one-page and two-page reading, stable digital position labels, and visual snapshots at
  390, 768 and 1440px;
- private highlights, notes and named bookmarks anchored with engine-supported locators;
- entitled full-book search over private text extracted from sanitized XHTML;
- copy/share limited to 300 Unicode grapheme clusters with book, author and canonical-URL attribution;
- a richer completion panel; and
- a disabled “Ask Infinity — Coming soon” affordance that sends no content and makes no request.

The sample reader does not gain annotations or full-book search. Ask Infinity, public/social
annotations, bulk export and cross-publication-version annotation migration remain outside S5.5.

**Exit criteria:**

- Highlights, notes and bookmarks survive reload and ordinary typography, theme, width and
  responsive-layout changes.
- Search returns only authorized results and navigates to the matching locator.
- Copy/share enforces the 300-character quote limit and required attribution.
- The desktop reader has a persistent sidebar and two-page spread; tablet/mobile retain every
  feature in a one-page layout and drawer.
- The Ask Infinity affordance is visible, disabled and network-inert.
- Database/RLS, unit, component, end-to-end, accessibility, visual and EPUB-corpus gates in the
  S5.5 design pass.

### S6. Hardening and launch (issues #1, #2, #11)

**Outcome:** every launch gate has evidence and an owner, and production goes live reversibly.

**Launch gates:** `docs/launch/go-no-go.md` restates PRD §6.2 for ebook-only launch. Each gate records
an owner, evidence link, and status.

**Engineering work:**

- Lighthouse and Core Web Vitals checks on the home, book, catalog, and search templates.
- Axe accessibility checks in Playwright on the same templates plus sign-in, library, and reader.
- Visual and interaction regression checks for the S5.5 reader at 390, 768 and 1440px.
- A cross-user RLS sweep and a scan of client bundles for service-role keys.
- Simulator webhook replay, duplicate, and out-of-order tests.
- Rehearsals: database and storage restore, Vercel rollback, publication rollback, and entitlement
  revocation.

**Owner-led work, supported by runbooks:**

- Run the five-EPUB matrix, including S5.5 selection, decoration, search-locator and spread rows.
  ADR-005 moves from Provisional to Accepted, or the epub.js fallback in ADR-005 is triggered.
- Enter launch content: books, authors, series, topics, covers, samples, and merchandising.
- Build the legacy URL redirect inventory.
- UAT sign-off, cutover plan, and first-week monitoring plan.

**Backlog:**

- Rewrite issues #1–#11 to ebook-only scope and link each to its sub-project.
- Close #1 and #2 when their rewritten criteria have evidence. GitHub branch protection is not
  available on the current plan, so "CI blocks merging" is recorded as an accepted risk.
- Open a new post-launch issue for the real payment provider.

**Exit criteria:** every gate in `go-no-go.md` is passed or has a signed, accepted exception, and the
owner approves the cutover.

## 5. Testing and Documentation Rules

These apply to every sub-project plan.

- Use TDD for each task: Vitest for pure logic, pgTAP for every new table, policy, and RPC (with
  cross-user negative cases), and at least one Playwright journey per sub-project.
- Run `npm run check` after every task.
- At each sub-project gate, run `npm run db:reset`, `npm run db:test`, and `npm run check:full`
  against a local Supabase stack only.
- Update runbooks in the same pull request as the behavior they describe.
- Keep regression tests with every fixed defect.

## 6. Out of Scope

- Physical books, shipping, COD, inventory, and fulfillment.
- Real payment provider onboarding and integration.
- Cart, coupons, bundles, and promotions.
- Guest checkout and guest purchase claim.
- Articles, ideas, collections, and the knowledge hub.
- Wishlist.
- Ask Infinity implementation, public/social annotations, annotation export files, and
  cross-publication-version annotation migration.
- Hosted EPUB execution.
- Third-party product analytics, APM, and dashboards.
- The `ja` locale.

## 7. Plan Sequence

| Plan file | Written |
| --- | --- |
| `docs/superpowers/plans/2026-09-13-s1-catalog-admin.md` | Now, after this spec is approved |
| S2 public discovery | After S1 merges |
| S3 get and buy | After S2 merges |
| S4 reader completion | After S2 merges |
| S5 SEO and operations | After S3 and S4 merge |
| `docs/superpowers/plans/2026-09-19-s5-5-reader-depth-visual-parity.md` | After S5 merges and the S5.5 design is reviewed |
| S6 hardening and launch | After S5.5 merges |
