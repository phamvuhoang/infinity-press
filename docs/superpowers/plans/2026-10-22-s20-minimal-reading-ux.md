# S20-min Reading UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the minimal reading-experience pilot: a 21-session reading journey, a public edition record, whole-book free samples without sign-in, passage deep links, automatic bilingual compare, passage sharing with a question, and a small growth report.

**Architecture:** Every new thing hangs off tables and RPCs that already exist. Journeys are new tables plus two authenticated RPCs. Passage anchors are `ebook_search_chunks` (already produced for every publication, unique on `(publication_id, ordinal)`); deep links, sharing, and compare all address a chunk by `ordinal`. Alignment is a pure function in `lib/epub/align.ts` whose output is stored by one RPC and read by one RPC. Admin writes go through `requireAdmin()` then a service-role client, as `lib/data/admin-knowledge.ts` does; customer writes go through security-definer RPCs that call `reader_edition_for_publication`, as `create_shared_quote` does.

**Tech Stack:** Next.js 16 (App Router, read `node_modules/next/dist/docs/` before touching routes), Supabase (Postgres, RLS, pgTAP), Readium behind `ReaderEngine`, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-22-s20-minimal-reading-ux-design.md`

## Global Constraints

- Customer routes stay under `/{locale}` with locales `vi`, `en`, `ja`; `/admin` has no locale prefix.
- Every protected page and server action calls `requireUser()` or `requireAdmin()`; create a service-role client only after `requireAdmin()` passes.
- Journeys are free: no SKU, no entitlement, no file delivery. Any signed-in user may read every session of a published journey.
- Compare has no manual step: when `alignChunks` cannot pair a resource, that resource has no compare; no admin import UI.
- Share question max 280 characters; `text_kind` ∈ `verbatim | translation | paraphrase`.
- `editions.text_kind` ∈ `literal | adapted | commentary` (nullable); `editions.review_scope` ∈ `full | sample | none` (default `none`).
- New analytics event names (CHECK constraint): `session_completed`, `journey_completed`, `passage_opened`, `passage_shared`, `compare_opened`. `analytics_events` has identifier columns only: never store text, locators, or ordinals in it.
- Thresholds from the growth plan are never hard-coded; `/admin/growth` shows counts with denominators.
- New migrations only (never edit applied ones); update `lib/supabase/database.types.ts` by hand in the same task as each migration; add pgTAP under `supabase/tests/press_*.sql`.
- Keep request IDs in server error logs (`getRequestId`).
- Dictionaries are JSON: `lib/i18n/dictionaries/{vi,en,ja}.json`; every new UI string gets all three.
- Run `npm run db:reset && npm run db:test` after each migration task, `npm run check` after each task, `npm run check:full` at the end.

## Review Focus

1. A journey session whose `start_locator.href` is not a resource of the edition's current active publication (EPUB re-uploaded): the session page must still render and the "open reader" link must fall back to the publication start, not 500. Test added in Task 4.
2. `?anchor=` with a non-integer, negative, or out-of-range ordinal, or on a publication the caller cannot read: open at the saved position silently. Test added in Task 7.
3. Alignment when two publications have different numbers of resources, or a resource pair where one side has zero chunks: `alignChunks` must skip, not throw or mis-pair later resources. Test added in Task 8.
4. A shared passage whose chunk no longer exists (publication superseded): `/q/[code]` still renders the quote and hides "Đọc tiếp từ đây". Test added in Task 9.
5. Wildcard sample `["*"]` must never expose a resource whose `access_class` is not servable to anonymous readers beyond what the manifest resolver already allows for listed hrefs; the sample manifest and resource resolvers must agree. Test added in Task 6.

---

### Task 1: Journey schema, RPCs, events

**Files:**
- Create: `supabase/migrations/20261022100000_s20_reading_journeys.sql`
- Create: `supabase/tests/press_journeys.sql`
- Modify: `lib/supabase/database.types.ts`

**Interfaces:**
- Produces tables: `reading_journeys(id uuid pk, book_id uuid fk books, edition_id uuid fk editions, slug text unique, status content_status default 'draft', session_count int generated/maintained by trigger, created_at, updated_at)`, `journey_localizations(journey_id, locale text fk supported_locales, title text, summary text, pk(journey_id, locale))`, `journey_sessions(id uuid pk, journey_id, position int check 1..60, start_locator jsonb check reader_locator_is_valid, end_locator jsonb null, unique(journey_id, position))`, `journey_session_localizations(session_id, locale, title text, guide_md text, questions jsonb default '[]' check array of ≤3 strings ≤500 chars, pk(session_id, locale))`, `journey_progress(profile_id, journey_id, position, completed_at, pk(profile_id, journey_id, position))`, `journey_completions(profile_id, journey_id, reflection text check ≤2000, completed_at, pk(profile_id, journey_id))`.
- Produces RPCs (security definer, `set search_path = ''`): `mark_journey_session(p_journey_id uuid, p_position int) returns void` and `complete_journey(p_journey_id uuid, p_reflection text) returns void`. Both resolve the profile from `auth.uid()`, require `reading_journeys.status = 'published'`, require the position to exist, and insert `analytics_events` rows `session_completed` (dedupe_key `journey:<id>:<profile>:<position>`) and `journey_completed` (dedupe_key `journey:<id>:<profile>:done`) with `profile_id`, `book_id`. `complete_journey` requires ≥1 completed session (not 17; the 17/21 threshold is a report filter).
- RLS: anonymous and authenticated `select` on `reading_journeys`/`journey_localizations`/`journey_sessions`/`journey_session_localizations` where the journey is `published`; owner-only `select` on `journey_progress` and `journey_completions`; no direct insert/update policies (RPCs only). Service role bypasses for admin.
- Extends `analytics_events_event_name_check` with the five names in Global Constraints (copy the existing list from `20260928110000_s14_click_external_store.sql` and append).

- [ ] **Step 1: Write the failing pgTAP test** `supabase/tests/press_journeys.sql` (`select plan(14)`), fixtures in the style of `press_owner_reads_unpublished.sql`: two auth users (reader, stranger), one published book with one edition, one journey `draft` and one `published` with sessions 1..3. Assertions:
  - tables and RPCs exist (`has_table` ×6, `has_function` ×2);
  - as reader: `select * from reading_journeys` returns only the published one;
  - as reader: `mark_journey_session(published, 2)` succeeds and `journey_progress` has 1 row; calling it again does not duplicate;
  - as reader: `mark_journey_session(draft, 1)` throws;
  - as reader: `mark_journey_session(published, 99)` throws;
  - as reader: `complete_journey(published, 'ok')` succeeds; `analytics_events` has one `session_completed` and one `journey_completed` row for this profile;
  - as stranger: `select count(*) from journey_progress` = 0;
  - as reader: `complete_journey(published, '')` before any session on a fresh journey throws.
- [ ] **Step 2: Run** `npm run db:reset && npm run db:test` → `press_journeys.sql` fails (tables missing).
- [ ] **Step 3: Write the migration** with the objects in Interfaces. Maintain `session_count` with an `after insert or delete on journey_sessions` trigger. Add `updated_at` trigger reusing the project's existing `set_updated_at` function if present (grep `create function public.set_updated_at`); otherwise define `public.journeys_set_updated_at()`.
- [ ] **Step 4: Run** `npm run db:reset && npm run db:test` → all pass.
- [ ] **Step 5: Update `lib/supabase/database.types.ts`**: six tables (Row/Insert/Update/Relationships) and two Functions entries. Run `npm run typecheck`.
- [ ] **Step 6: Commit** `feat(db): reading journeys, progress RPCs, and S20 analytics events`.

---

### Task 2: Journey data layer

**Files:**
- Create: `lib/data/journeys.ts`, `lib/data/journeys.test.ts`
- Create: `lib/data/admin-journeys.ts`, `lib/data/admin-journeys.test.ts`
- Modify: `lib/i18n/routes.ts` (add `journey(slug)`, `journeySession(slug, position)`, `adminJourney(id)` helpers)

**Interfaces:**
- `lib/data/journeys.ts` (server-only, public client for reads, user client for RPCs):
  - `type JourneySummaryDTO = { id: string; slug: string; title: string; summary: string; sessionCount: number; bookId: string; bookSlug: string; bookTitle: string; editionId: string; languageCode: string; coverUrl: string | null }`
  - `type JourneySessionDTO = { position: number; title: string; guideMd: string; questions: string[]; startLocator: ReaderLocator; endLocator: ReaderLocator | null }`
  - `type JourneyProgressDTO = { completedPositions: number[]; completed: boolean; reflection: string | null }`
  - `getPublishedJourney(locale, slug): Promise<(JourneySummaryDTO & { sessions: JourneySessionDTO[] }) | null>` — localization falls back to the journey's edition language then `en`, same rule as `press_metadata_fallback`.
  - `getPublishedJourneysForBook(locale, bookId): Promise<JourneySummaryDTO[]>`
  - `getMyJourneyProgress(journeyId): Promise<JourneyProgressDTO>`; `getMyJourneys(locale): Promise<(JourneySummaryDTO & JourneyProgressDTO)[]>` (journeys where the profile has ≥1 progress row or completion).
  - `markJourneySession(journeyId, position): Promise<void>`; `completeJourney(journeyId, reflection): Promise<void>` — wrap the RPCs, throw `JourneyNotAvailableError` on the RPC's `P0002`/`22023` errcodes.
- `lib/data/admin-journeys.ts` (all functions call `requireAdmin()` first, then `createAdminClient()`):
  - `listAdminJourneys(): Promise<AdminJourneyListItemDTO[]>`; `getAdminJourney(id): Promise<AdminJourneyDTO>` (journey + localizations + sessions with their localizations + the edition's active publication `toc_json` flattened with `flattenToc` for the href picker);
  - `createJourney(input: { bookId; editionId; slug }): Promise<{ journeyId }>`; `updateJourneyLocalization(journeyId, locale, { title, summary })`; `upsertSession(journeyId, { position, startHref, endHref | null })` (builds locators `{ href, progression: 0, totalProgression: null, locations: {} }`); `updateSessionLocalization(sessionId, locale, { title, guideMd, questions })`; `deleteSession(sessionId)`; `setJourneyStatus(journeyId, 'draft'|'published'|'archived')` — publishing requires `session_count ≥ 1` and a localization in the edition's language, else throws `JourneyNotReadyError`.
- Zod schemas for inputs live in the same files (slug `^[a-z0-9-]{3,64}$`).

- [ ] **Step 1: Write failing unit tests** with the Supabase mock pattern used in `lib/data/library.test.ts`:
  - `getPublishedJourney` returns `null` when the RPC/select yields nothing; maps rows to DTO; falls back to edition-language title when the requested locale is missing.
  - `markJourneySession` throws `JourneyNotAvailableError` when the client returns `{ error: { code: 'P0002' } }`.
  - `setJourneyStatus('published')` throws `JourneyNotReadyError` for `session_count = 0`.
  - `upsertSession` builds the start locator exactly `{ href, progression: 0, totalProgression: null, locations: {} }`.
- [ ] **Step 2: Run** `npx vitest run lib/data/journeys.test.ts lib/data/admin-journeys.test.ts` → FAIL (modules missing).
- [ ] **Step 3: Implement both modules and the route helpers.**
- [ ] **Step 4: Run the tests** → PASS. Run `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(journeys): data layer and routes`.

---

### Task 3: Admin journeys

**Files:**
- Create: `app/admin/journeys/page.tsx`, `app/admin/journeys/new/page.tsx`, `app/admin/journeys/[journeyId]/page.tsx`, `app/admin/journeys/actions.ts`
- Create: `components/admin/journeys/journey-form.tsx`, `components/admin/journeys/session-editor.tsx`, `components/admin/journeys/journey-publish-panel.tsx`, tests `components/admin/journeys/session-editor.test.tsx`
- Modify: `components/admin/admin-nav.tsx` (+ `{ href: "/admin/journeys", label: "Journeys" }` after Ideas), `components/admin/admin-nav.test.tsx`
- Create: `e2e/admin-journeys.spec.ts`

**Interfaces:**
- Consumes Task 2 admin functions.
- Server actions in `actions.ts` (each starts with `await requireAdmin({ next })`): `createJourneyAction`, `saveJourneyLocalizationAction`, `saveSessionAction`, `saveSessionLocalizationAction`, `deleteSessionAction`, `setJourneyStatusAction`. Return `{ ok: true } | { ok: false; message }` like `app/admin/ideas` actions via `FormFeedback`.
- `SessionEditor` props: `{ journeyId: string; sessions: AdminSessionDTO[]; tocHrefs: { href: string; title: string }[]; locales: Locale[] }`. The href picker is a `<select>` over `tocHrefs`; position defaults to `max(position)+1`.

- [ ] **Step 1: Write failing component test** `session-editor.test.tsx`: renders one row per session, the "add session" form defaults position to 4 when sessions 1..3 exist, and the start href select lists every `tocHrefs` entry.
- [ ] **Step 2: Run** `npx vitest run components/admin/journeys` → FAIL.
- [ ] **Step 3: Build pages, actions, and components** following `components/admin/knowledge/knowledge-pages.tsx` layout (details form, per-locale localization forms, publish panel with readiness message from `JourneyNotReadyError`).
- [ ] **Step 4: Run** the component test and `npm run check` → PASS.
- [ ] **Step 5: Write Playwright** `e2e/admin-journeys.spec.ts` using the admin sign-in helper from `e2e/support`: create a journey for the seeded book, add sessions 1–3 from the TOC, fill `vi` title/guide, publish, assert status badge "Published".
- [ ] **Step 6: Run** `npx playwright test e2e/admin-journeys.spec.ts` against local Supabase → PASS.
- [ ] **Step 7: Commit** `feat(admin): journey editor`.

---

### Task 4: Public journey pages, session page, library section

**Files:**
- Create: `app/[lang]/(public)/journeys/[slug]/page.tsx`
- Create: `app/[lang]/(account)/journeys/[slug]/sessions/[position]/page.tsx`, `.../actions.ts`
- Create: `components/journeys/journey-session-list.tsx`, `components/journeys/session-complete-form.tsx`, `components/journeys/journey-reflection-form.tsx`, test `components/journeys/journey-session-list.test.tsx`
- Modify: `app/[lang]/(account)/library/page.tsx` (section "Hành trình đọc" above the shelf when `getMyJourneys` is non-empty)
- Modify: `app/[lang]/(public)/books/[slug]/page.tsx` (card linking to each published journey of the book)
- Modify: `lib/i18n/dictionaries/{vi,en,ja}.json` (new key `journeys` with: `eyebrow`, `start`, `continue`, `sessionsDone` `{done}/{total}`, `openReader`, `markDone`, `done`, `reflectionLabel`, `reflectionSubmit`, `completedTitle`, `signInToTrack`, `questionsTitle`)
- Modify: `lib/catalog/static-params.ts` if journey slugs must prerender (they do not: keep the page dynamic with `revalidateTag` on publish; add the tag to `lib/catalog/revalidate.ts`)
- Create: `e2e/reading-journey.spec.ts`

**Interfaces:**
- Public page: `getPublishedJourney`; shows sessions list; "Bắt đầu" links to session 1 (account route → `requireUser` redirect handles sign-in).
- Session page: `requireUser(locale, next)`; loads journey + `getMyJourneyProgress`; "Mở reader tại đoạn này" links to `/read/editions/[editionId]?anchor=` **only after Task 7**; until then links to `/read/editions/[editionId]` with `?href=<start href>` ignored. Final position additionally renders `JourneyReflectionForm`.
- `markSessionAction(journeyId, position)` and `completeJourneyAction(journeyId, reflection)` call Task 2 functions and `revalidatePath` the session page and library.

- [ ] **Step 1: Write failing test** `journey-session-list.test.tsx`: given 21 sessions and `completedPositions=[1,2]`, renders "2/21", marks sessions 1–2 done, and the "continue" link points at position 3.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement pages, components, actions, dictionary keys.** For Review Focus 1: if `startLocator.href` is not in the readable publication's `toc_json` hrefs, render the link to `/read/editions/[editionId]` without a query.
- [ ] **Step 4: Add unit test** in the session page's test (or `journey-session-list.test.tsx`) asserting the fallback href when the locator href is unknown.
- [ ] **Step 5: Run** `npm run check` → PASS.
- [ ] **Step 6: Write Playwright** `e2e/reading-journey.spec.ts`: seed a published journey with 3 sessions via the admin UI helper or SQL fixture in `e2e/support`; sign in as a customer; open `/vi/journeys/<slug>`; mark 1–3; submit reflection; library shows "3/3" and completed state.
- [ ] **Step 7: Run** the spec → PASS. **Commit** `feat(journeys): public journey, session pages, library section`.

---

### Task 5: Edition record and report-at-passage

**Files:**
- Create: `supabase/migrations/20261022110000_s20_edition_record.sql`
- Create: `supabase/tests/press_edition_record.sql`
- Modify: `lib/supabase/database.types.ts`, `lib/catalog/schemas.ts` (`provenanceSchema` + `textKind: z.enum([...]).nullable()`, `reviewScope: z.enum([...])`), `lib/data/admin-editions.ts` (`saveEditionProvenance` passes `p_text_kind`, `p_review_scope`), `app/admin/books/[bookId]/editions/[editionId]/page.tsx` (two selects in the provenance form)
- Modify: `lib/catalog/public-types.ts` (`CatalogEditionOption` + `record: { textSourceNote; translationSource; rightsNote; territoryNote; textKind; reviewScope; reviewedAt; reviewNote } | null`), `lib/data/catalog.ts` (parse the new fields), `components/catalog/book-edition-panel.tsx` (collapsible "Về bản này" block)
- Modify: `components/reader/reader-sidebar.tsx` (menu item "Báo lỗi tại đoạn này" → `routes.reportError(editionId)` + `?href=&progression=` from the current locator), `app/[lang]/(account)/library/report/[editionId]/page.tsx` (prefill the locator from the query), `lib/i18n/dictionaries/*.json` (`catalog.editionRecord.*` labels; `reader.reportHere`)

**Interfaces:**
- Migration: `alter table editions add column text_kind text check (text_kind in ('literal','adapted','commentary')), add column review_scope text not null default 'none' check (review_scope in ('full','sample','none'))`; `create or replace function admin_save_edition_provenance(... existing params ..., p_text_kind text default null, p_review_scope text default 'none')`; `create or replace function catalog_book_page(...)` returning, per edition option, a `record` object with the eight fields (copy the current body from `20261020240000_press_metadata_fallback.sql`, add the fields).
- `ReaderClientProps` gains `reportHref: string | null`; the sidebar appends the current locator as `?href=&progression=`.

- [ ] **Step 1: pgTAP** `press_edition_record.sql` (`plan(5)`): columns exist with checks; invalid `text_kind` rejected; `admin_save_edition_provenance` with `p_review_scope='full'` persists; `catalog_book_page` output contains `record.reviewScope = 'full'` for that edition.
- [ ] **Step 2: Run db tests** → FAIL. **Write migration.** Run → PASS. Update `database.types.ts`.
- [ ] **Step 3: Unit tests**: `lib/catalog/schemas.test.ts` rejects `textKind: 'poem'`; `components/catalog/book-edition-panel.test.tsx` (create if absent) renders "Phạm vi review: Toàn bộ" when `record.reviewScope='full'` and hides the block when `record` is null; `components/reader/reader-sidebar.test.tsx` renders the report link with `href` and `progression` query from a given locator.
- [ ] **Step 4: Run** → FAIL. **Implement.** Run `npm run check` → PASS.
- [ ] **Step 5: Commit** `feat(editions): public edition record, text kind, review scope, report at passage`.

---

### Task 6: Whole-book free sample without sign-in

**Files:**
- Create: `supabase/migrations/20261022120000_s20_sample_full.sql`
- Modify: `lib/reader/session.ts` (`resolveSampleResource`, `resolveSampleManifest`, `resolveSamplePublicationId`), `lib/reader/session.test.ts`
- Modify: `lib/data/admin-editions.ts` (`setSampleFull(publicationId, full: boolean)`), admin edition page (checkbox "Open the whole book as a sample", always enabled; `admin_set_sample_full` refuses a paid edition with 22023 and the form shows that refusal), `components/reader/reader-client.tsx` (sample-mode banner using `copy.signInToTrack` when `sampleFull` prop is true), `app/[lang]/(public)/read-sample/[slug]/page.tsx` (pass `sampleFull`), `lib/data/catalog.ts` (`getSampleReaderBook` returns `sampleFull`)
- Modify: `lib/supabase/database.types.ts`

**Interfaces:**
- Migration: RPC `admin_set_sample_full(p_publication_id uuid, p_full boolean)` (admin-only via existing `is_admin`-style check used by other `admin_*` RPCs): sets `book_samples.allowed_hrefs` to `'["*"]'::jsonb` when true, else restores the worker's default sample hrefs (re-derive from `ebook_resources where access_class = 'sample'`, matching `complete_processing_job` in `20261020120000_press_edition_publishing.sql`).
- `lib/reader/session.ts`: `function sampleAllows(allowed: unknown, href: string): boolean` exported — true when the array contains `"*"` or the exact href. All three resolvers use it. The manifest resolver, when wildcard, lists every resource of the publication (same media-type filtering as today).

- [ ] **Step 1: Failing unit tests** in `session.test.ts`: `sampleAllows(["*"], "OEBPS/c9.xhtml")` true; `resolveSampleResource` serves `chapter9` when `allowed_hrefs=["*"]`; `resolveSampleManifest` lists all resources with wildcard; with `["OEBPS/c1.xhtml"]` behavior is unchanged (existing tests still pass). For Review Focus 5: with wildcard, a resource of `access_class='private_only'` (use whatever class the manifest resolver already excludes) is still excluded by both resolvers — assert both.
- [ ] **Step 2: Run** `npx vitest run lib/reader/session.test.ts` → FAIL. **Implement.** → PASS.
- [ ] **Step 3: Migration + pgTAP** (`press_sample_full.sql`, `plan(3)`): non-admin call rejected; admin true → `allowed_hrefs = '["*"]'`; admin false → restored list non-empty. Run db tests → PASS. Update types.
- [ ] **Step 4: Admin toggle + reader banner + dictionary strings.** Component test: banner renders in sample mode only when `sampleFull`.
- [ ] **Step 5: Extend** `e2e/reader-access.spec.ts` (or new `e2e/sample-full.spec.ts`): toggle on in admin, open `/vi/read-sample/<slug>` signed out, navigate to the last TOC entry successfully; toggle off, same navigation shows the end-of-sample card.
- [ ] **Step 6: Run** `npm run check` and the spec → PASS. **Commit** `feat(sample): whole-book free sample with wildcard allowlist`.

---

### Task 7: Passage deep link `?anchor=`

**Files:**
- Create: `supabase/migrations/20261022130000_s20_chunk_locators.sql`
- Create: `supabase/tests/press_chunk_locators.sql`
- Create: `lib/reader/anchor.ts`, `lib/reader/anchor.test.ts`
- Modify: `app/[lang]/(reader)/read/editions/[editionId]/page.tsx`, `app/[lang]/(public)/read-sample/[slug]/page.tsx`, `lib/data/library.ts` (`getReadableEdition` accepts `anchor?: number` and overrides `initialLocator`), `lib/data/catalog.ts` (`getSampleReaderBook` same), `lib/supabase/database.types.ts`
- Modify: Task 4 session page links to `?anchor=` (compute the session's ordinal with `reader_chunk_for_locator` at render time; omit when null)

**Interfaces:**
- RPCs: `reader_chunk_locator(p_publication_id uuid, p_ordinal int) returns jsonb` — entitled readers only (via `reader_edition_for_publication(profile, publication)`), returns `locator_json` or null; `sample_chunk_locator(p_publication_id uuid, p_ordinal int) returns jsonb` — anonymous OK, returns the locator only when `book_samples` allows the chunk's `href` (wildcard or listed); `reader_chunk_for_locator(p_publication_id uuid, p_href text, p_progression numeric) returns int` — entitled readers; the greatest `ordinal` whose `href` matches and `(locator_json->>'progression')::numeric <= p_progression`, else the first ordinal of that href, else null.
- `lib/reader/anchor.ts`: `parseAnchor(value: string | string[] | undefined): number | null` (non-negative integer ≤ 1_000_000 else null).

- [ ] **Step 1: Unit test** `anchor.test.ts`: `"12"`→12, `"-1"`→null, `"1.5"`→null, `["1","2"]`→null, `undefined`→null.
- [ ] **Step 2: pgTAP** `press_chunk_locators.sql` (`plan(7)`): fixtures with a publication and three chunks (`ordinal` 0,1,2; hrefs `c1`,`c1`,`c2`; progressions 0, 0.5, 0); entitled reader gets ordinal 1's locator; stranger gets null; out-of-range gets null; `sample_chunk_locator` returns `c2` only when allowed; `reader_chunk_for_locator(pub,'c1',0.7)` = 1, `(pub,'c1',0.1)` = 0, `(pub,'zz',0)` null.
- [ ] **Step 3: Run** tests → FAIL. **Write migration and `anchor.ts`.** Run → PASS. Update types.
- [ ] **Step 4: Wire the pages**: parse `searchParams.anchor`; when non-null, call the matching RPC; if it returns a locator, use it as `initialLocator`; else keep the saved one (Review Focus 2). Unit-test in `lib/data/library.test.ts`: `getReadableEdition(..., { anchor: 5 })` uses the RPC locator; RPC null → saved locator.
- [ ] **Step 5: Run** `npm run check` → PASS. **Commit** `feat(reader): open at a passage with ?anchor=`.

---

### Task 8: Automatic bilingual alignment and compare panel

**Files:**
- Create: `lib/epub/align.ts`, `lib/epub/align.test.ts`
- Create: `supabase/migrations/20261022140000_s20_passage_alignments.sql`, `supabase/tests/press_passage_alignments.sql`
- Create: `lib/data/alignments.ts`, `lib/data/alignments.test.ts`
- Create: `app/api/reader/publications/[publicationId]/aligned/route.ts`, `route.test.ts`
- Create: `components/reader/reader-compare-panel.tsx`, `reader-compare-panel.test.tsx`
- Modify: `scripts/ebook.ts` (command `align <bookId>`), `components/reader/reader-client.tsx` (toolbar button "Đối chiếu", shown only when `compareAvailable`), `lib/data/library.ts` (`getReadableEdition` returns `compareAvailable: boolean` = alignment coverage for this publication > 0), admin edition page (coverage % + "Recompute alignment" action), `lib/analytics/browser.ts` + `app/api/analytics/events/route.ts` (`compare_opened` with `bookId`, `publicationId`), `lib/analytics/events.ts`, dictionaries (`reader.compare`, `reader.compareNone`, `reader.compareOpenOther`), `lib/supabase/database.types.ts`

**Interfaces:**
- `lib/epub/align.ts`:
  - `type AlignChunk = { id: string; href: string; ordinal: number; length: number }`
  - `type AlignmentPair = { sourceId: string; targetId: string; confidence: number }`
  - `alignChunks(source: AlignChunk[], target: AlignChunk[]): { pairs: AlignmentPair[]; coverage: number }` — group each side by `href` in order of first appearance (chunks are already in reading order); pair the i-th href group of source with the i-th of target; equal chunk counts → 1:1 with confidence 1; counts differ by ≤10% of the larger → pair each source chunk with the target chunk whose cumulative-length midpoint is nearest, confidence 0.6; otherwise skip the group. Unequal number of href groups → pair only the first `min(n, m)` groups. `coverage` = paired source chunks ÷ all source chunks.
- Migration: `passage_alignments(book_id, source_publication_id, target_publication_id, source_chunk_id fk ebook_search_chunks on delete cascade, target_chunk_id fk, confidence numeric, pk(source_chunk_id, target_publication_id))`; RPC `replace_passage_alignments(p_book_id, p_source_publication_id, p_target_publication_id, p_pairs jsonb)` (service role / admin) deletes then inserts both directions; RPC `reader_aligned_passage(p_publication_id uuid, p_ordinal int) returns jsonb` → `{ targetPublicationId, targetEditionId, targetLanguageCode, targetOrdinal, text, confidence }` or null; entitled on the source and `reader_edition_for_publication` non-null on the target; `alignment_coverage(p_publication_id) returns numeric` (public read, used by admin page and `compareAvailable`).
- `lib/data/alignments.ts`: `computeAlignmentsForBook(bookId): Promise<{ pairs: number; coverage: number }[]>` — service role; for the book's editions with an active published publication, for every ordered pair, load chunks `(id, href, ordinal, char_length(plain_text))`, run `alignChunks`, call the RPC. Exposed to `scripts/ebook.ts align` and to an admin server action `recomputeAlignmentAction(bookId)`; also call it at the end of the publish transition action in `app/admin/publications/[publicationId]` (best-effort, logged with request ID, never blocks publish).
- API route: `GET /api/reader/publications/[publicationId]/aligned?ordinal=` → the RPC result; reuses the reader-session authorization of the sibling `search` route.
- `ReaderComparePanel` props: `{ copy; publicationId; request: ReaderApiClient; currentLocator: ReaderLocator | null; resolveOrdinal: (locator) => Promise<number | null>; onOpenOther: (href: string) => void }` — on open, resolves the ordinal via `reader_chunk_for_locator` (expose through the same route with `?href=&progression=`), fetches the aligned passage, renders `text` with `lang=targetLanguageCode`, and a link to `/read/editions/[targetEditionId]?anchor=[targetOrdinal]`. Sends `compare_opened` once per open.

- [ ] **Step 1: Unit tests** `align.test.ts`: equal counts → 1:1 confidence 1, coverage 1; 10 vs 11 chunks → every source paired, confidence 0.6; 10 vs 15 → group skipped, coverage 0; three href groups vs two → third group skipped, first two paired (Review Focus 3); a group with zero target chunks → skipped without throwing; output is deterministic (same input twice → deep-equal).
- [ ] **Step 2: Run** → FAIL. **Implement `align.ts`.** → PASS.
- [ ] **Step 3: pgTAP** `press_passage_alignments.sql` (`plan(6)`): replace inserts both directions; `reader_aligned_passage` returns the target text for an entitled reader; null for a stranger; null for an unpaired ordinal; `alignment_coverage` = 0.5 when half the chunks are paired; deleting a chunk cascades.
- [ ] **Step 4: Run db tests** → FAIL. **Write migration.** → PASS. Update types.
- [ ] **Step 5: `lib/data/alignments.ts` test**: given two publications with mocked chunk rows, calls `replace_passage_alignments` with the pairs from `alignChunks`; a book with one edition makes no RPC call.
- [ ] **Step 6: Route test** (pattern of the `search` route test): 401 without session; 400 for missing ordinal; 200 with the RPC payload.
- [ ] **Step 7: Panel test**: renders the aligned text and the open-other link with `?anchor=<targetOrdinal>`; renders `copy.compareNone` when the fetch returns null.
- [ ] **Step 8: Implement** data module, route, panel, reader button, admin coverage + recompute, script command, best-effort call after publish, event wiring. Run `npm run check` → PASS.
- [ ] **Step 9: Extend** `e2e/reader-edition-access.spec.ts` or new `e2e/reader-compare.spec.ts`: with the two seeded editions (`vi`, `en`) of the fixture book processed, run `npx tsx scripts/ebook.ts align <bookId>`, sign in as an owner of both, open the `vi` reader, click "Đối chiếu", assert the panel shows text with `lang="en"`.
- [ ] **Step 10: Commit** `feat(reader): automatic passage alignment and compare panel`.

---

### Task 9: Share a passage with a question

**Files:**
- Create: `supabase/migrations/20261022150000_s20_shared_passage.sql`, `supabase/tests/press_shared_passage.sql`
- Modify: `lib/data/shared-quotes.ts` (+ `chunkOrdinal`, `question`, `textKind` in schema; `createSharedQuote(publicationId, input: { quote; locale; question?: string; textKind: TextKind; locator?: ReaderLocator })`), `lib/data/shared-quotes.test.ts`
- Modify: `app/api/reader/quotes/route.ts` (body schema + resolve `chunkOrdinal` via `reader_chunk_for_locator` when `locator` is present), `route.test.ts`
- Modify: `components/reader/reader-selection-toolbar.tsx` (share opens a small dialog: optional question `maxLength=280`, radio `textKind` default `verbatim`), test
- Modify: `app/[lang]/(public)/q/[code]/page.tsx` (+ question, text-kind label, "Đọc tiếp từ đây" → `routes.sample(bookSlug)?edition=<id>&anchor=<ordinal>` when the chunk still exists and the sample allows it; else hidden), `opengraph-image.tsx` (question line)
- Modify: `lib/analytics/events.ts`, `lib/analytics/browser.ts`, `app/api/analytics/events/route.ts` (`passage_opened` browser event `{ sharedQuoteId, bookId }`; `passage_shared` written inside `create_shared_quote` when `p_chunk_ordinal` is not null, dedupe on the quote id), dictionaries (`reader.shareQuestionLabel`, `reader.textKind.verbatim|translation|paraphrase`, `catalog.quoteCard.continueReading`, `catalog.quoteCard.kind.*`), `lib/supabase/database.types.ts`

**Interfaces:**
- Migration: `alter table shared_quotes add column chunk_ordinal int, add column question text check (char_length(question) <= 280), add column text_kind text not null default 'verbatim' check (text_kind in ('verbatim','translation','paraphrase'))`; `create or replace function create_shared_quote(p_publication_id, p_quote, p_locale, p_question text default null, p_text_kind text default 'verbatim', p_chunk_ordinal int default null)` — body copied from `20261021120000_shared_quote_published_book.sql` plus validation and the `passage_shared` event; `catalog_shared_quote` returns the three new fields plus `chunkExists boolean` (`exists(select 1 from ebook_search_chunks where publication_id = sq.publication_id and ordinal = sq.chunk_ordinal)`) and `sampleAllowsChunk boolean`.

- [ ] **Step 1: pgTAP** (`plan(6)`): question of 281 chars rejected; `text_kind='poem'` rejected; create with `p_chunk_ordinal=1` writes `passage_shared`; without ordinal no `passage_shared`; `catalog_shared_quote` reports `chunkExists=false` after the chunk is deleted (Review Focus 4); existing three-arg call still works.
- [ ] **Step 2: Run** → FAIL. **Write migration.** → PASS. Update types.
- [ ] **Step 3: Unit tests**: `shared-quotes.test.ts` passes the new RPC params; route test rejects a 281-char question with 400 and resolves `chunkOrdinal` from a locator; toolbar test shows the question dialog on "share" and submits `textKind`; `q/[code]/page.test.tsx` hides "Đọc tiếp từ đây" when `chunkExists=false` and shows the label "Diễn giải" for `paraphrase`.
- [ ] **Step 4: Run** → FAIL. **Implement.** `npm run check` → PASS.
- [ ] **Step 5: Extend** `e2e/shareable-quotes.spec.ts`: share with a question, open the card signed out, click "Đọc tiếp từ đây", assert the sample reader opens on the shared chapter.
- [ ] **Step 6: Commit** `feat(share): passage cards with a question and text-kind label`.

---

### Task 10: Homepage positioning and `/admin/growth`

**Files:**
- Create: `supabase/migrations/20261022160000_s20_growth_report.sql`, `supabase/tests/press_growth_report.sql`
- Create: `lib/data/growth.ts`, `lib/data/growth.test.ts`, `app/admin/growth/page.tsx`, `components/admin/growth-panel.tsx`, `growth-panel.test.tsx`
- Modify: `components/admin/admin-nav.tsx` (+ Growth), `app/[lang]/(public)/page.tsx` (hero copy; bilingual sample passage block under the featured band when `catalog_home_passage` returns a pair; CTA pair: sample link + first published journey of the featured book), `lib/data/catalog.ts` (`getHomePassage()`), dictionaries (`home.*` new copy below), `e2e/public-home.spec.ts`
- Modify: `lib/seo/metadata.ts` only if the homepage description changes (keep hreflang/canonical logic; add an assertion in `e2e/localized-routing.spec.ts` that `/vi`, `/en`, `/ja` each emit three `hreflang` links and a self canonical)

**Interfaces:**
- Migration RPCs (admin-only, `security definer`): `admin_growth_funnel(p_days int) returns table(book_id, open_sample bigint, open_reader bigint, session_completed_readers bigint, journey_completed bigint)`; `admin_growth_retention(p_days int) returns table(cohort_day date, activated bigint, returned_d7 bigint)` where activated = distinct profiles with first `session_completed` on that day and returned = those with `open_reader` on day +6..+8; `admin_growth_share(p_days int) returns table(shared bigint, opened bigint, continued bigint)` from `passage_shared`, `view_quote`, `passage_opened`; `catalog_home_passage() returns jsonb` — for the featured book, the first `passage_alignments` pair with confidence 1 and both texts 120..400 chars → `{ sourceText, sourceLang, targetText, targetLang, bookSlug, ordinal }`, else null.
- `lib/data/growth.ts`: `getGrowthReport(days: 30 | 90): Promise<{ funnel; retention; share }>` after `requireAdmin()`.
- Homepage copy (dictionary `home.heroTitle` / `home.heroBody` / `home.ctaSample` / `home.ctaJourney` / `home.passageEyebrow`): vi "Một tác phẩm. Nhiều ngôn ngữ. Cùng thảo luận." / en "One classic. Many languages. A shared conversation." / ja "一つの古典。多くの言語。ひとつの対話。"; body (vi) "Sách kinh điển miễn phí, đọc ngay trên trình duyệt. Hành trình 21 buổi và bản đối chiếu song ngữ giúp bạn đọc hết và hiểu."

- [ ] **Step 1: pgTAP** (`plan(5)`): non-admin calls rejected; funnel counts one `open_sample` and one `journey_completed` from fixture events; retention counts a reader with `open_reader` 7 days after first `session_completed`; share counts 1/1/1; `catalog_home_passage` returns null when no alignment, a pair when one qualifies.
- [ ] **Step 2: Run** → FAIL. **Write migration.** → PASS. Update types.
- [ ] **Step 3: Unit tests**: `growth.test.ts` maps rows and formats `returned_d7 / activated` as a ratio string only when `activated > 0`; `growth-panel.test.tsx` renders "0 / 0" denominators without dividing by zero; homepage test (`app/[lang]/(public)/page.test.tsx` if present) renders the passage block only when `getHomePassage` is non-null.
- [ ] **Step 4: Run** → FAIL. **Implement.** `npm run check` → PASS.
- [ ] **Step 5: Playwright**: `public-home.spec.ts` asserts the new hero title per locale; `localized-routing.spec.ts` assertion from Files.
- [ ] **Step 6: Commit** `feat(home,admin): new positioning and growth report`.

---

### Task 11: Runbook and full verification

**Files:**
- Create: `docs/runbooks/reading-journeys.md` (how to create a journey, publish, toggle whole-book sample, run `align`, read `/admin/growth`; local-only test notes; the "no manual alignment" rule and the 70% stop condition from the spec)
- Modify: `docs/runbooks/catalog-admin.md` (edition record fields), `docs/runbooks/storefront.md` (homepage passage block), `AGENTS.md` "Current scope" (one line: reading journeys, passage compare, shared passages)

- [ ] **Step 1: Write the runbook and doc edits.**
- [ ] **Step 2: Run** `npm run db:reset && npm run db:test` → all pass.
- [ ] **Step 3: Run** `npm run check:full` with the Supabase and Mailpit variables exported per `docs/runbooks/testing-environments.md` → all pass. Paste failing output into the task notes if anything fails and fix before continuing.
- [ ] **Step 4: Commit** `docs: reading journeys runbook and scope update`.
