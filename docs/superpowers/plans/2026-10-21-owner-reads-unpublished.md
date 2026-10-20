# Owners Keep Reading After Unpublish or Rollback (Press) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reader with an active entitlement to an edition can always see it in `/library`, with its cover, and read it, even after the book is unpublished, the edition is rolled back, or the edition loses its active publication.

**Architecture:** One private SQL function picks an edition's readable publication, and the existing single reader rule `reader_edition_for_publication` asks it instead of checking book, edition, and pointer status. Every reader RPC and policy already routes through that rule, so no other SQL gate changes. A new owner-scoped RPC, `my_library_editions`, supplies the titles, covers, language codes, and publication ids that `getLibrary`, `getReadableEdition`, and `getOwnedEditionsOfBook` used to take from the published catalog.

**Tech Stack:** Next.js 16 App Router, Supabase Postgres (plpgsql, RLS, pgTAP), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-21-owner-reads-unpublished-design.md`

**Reference implementation:** `../infinity-books` commits `8c1c9e0..868205a` (same feature, book-scoped). Copy its wording and test shapes where the edition layer does not change them.

## Global Constraints

- Add new migrations only. Never edit an applied migration. Name them `supabase/migrations/20261021100000_owner_reads_unpublished.sql` and `supabase/migrations/20261021110000_my_library_editions.sql`.
- Recreate `reader_edition_for_publication` with `create or replace` and the unchanged signature `(p_profile_id uuid, p_publication_id uuid) returns uuid`, so its grants (`authenticated, service_role`) are kept. Copy its body from its **latest** definition, `supabase/migrations/20261020230000_press_review_followups.sql:551`, and keep the self-only check `(auth.uid() is null or p_profile_id = (select pr.id from public.profiles pr where pr.auth_user_id = auth.uid()))`.
- Do not recreate `create_reader_session`, `authorize_reader_session`, `save_reading_progress`, `submit_edition_feedback`, or the `reader_annotations` policies. They already call `reader_edition_for_publication`.
- Keep the single opaque denial: EB008 from `create_reader_session`, zero rows from `authorize_reader_session`, EB009 from `save_reading_progress`.
- Hand-edit `lib/supabase/database.types.ts` (generated output is unformatted).
- Run DB tests only against a local or scratch stack. Run `docker context use orbstack` first, and use Node 22.
- `docs/runbooks/catalog-admin.md:56` must read: "**Unpublish book** hides the book from the catalog and blocks new purchases. Readers who already own an edition keep it in their library and can still read it."
- New pgTAP files follow the Press naming `supabase/tests/press_*.sql`.

## Review Focus

- Rollback to an older version: owners read the older version, and a session minted for the newer version stops authorizing. Pinned in Task 1 test (g).
- An owner whose entitlement is revoked after unpublish: refused, as before. Pinned in Task 1 test (e).
- A non-owner who knows the publication id of an unpublished book: EB008, no oracle. Pinned in Task 1 test (d) and Task 2 test (c).
- Owning English never opens Japanese of the same unpublished book. Pinned in Task 1 test (i).
- An admin account that also owns an edition: the library shows exactly one card, its own. `my_library_editions` filters on `auth.uid()`, not on RLS. Pinned in Task 2 test (d).
- Sharing a quote from an unpublished book: `create_shared_quote` refuses, and the reader must not crash. `createShareUrl` already resolves to null. Task 4 verifies by hand.

---

### Task 1: The reader rule follows the edition's readable publication

**Files:**
- Create: `supabase/migrations/20261021100000_owner_reads_unpublished.sql`
- Create: `supabase/tests/press_owner_reads_unpublished.sql`
- Modify: `supabase/tests/009_reader_sessions.sql:276-310` (tests 23 and 24), `supabase/tests/010_reading_progress.sql:250-256` (test 19), `supabase/tests/reader_annotations.test.sql:229-232`, `supabase/tests/press_edition_access.sql:67-78`

**Interfaces:**
- Produces: `public.reader_publication_for_edition(p_edition_id uuid) returns uuid`. Callable only by definer functions. Task 2 uses it.
- Keeps: `public.reader_edition_for_publication(p_profile_id uuid, p_publication_id uuid) returns uuid`, same grants.

- [ ] **Step 1: Write the failing pgTAP file `press_owner_reads_unpublished.sql`**

  Model it on `../infinity-books/supabase/tests/072_owner_reads_unpublished.sql`, with the Press fixture shape of `supabase/tests/press_edition_access.sql` (editions carry the pointer; entitlements carry `edition_id`). Fixture: one book, published, with an `en` edition that has v1 and v2 publications (v1 `superseded` with `processed_at = now() - interval '1 day'`, v2 `published` and the edition's `active_publication_id`), a `ja` edition with its own published publication and pointer, a book-level cover in `media_assets`, a `vi` localization, and readers A (active entitlement to the `en` edition), B (none), C (revoked on `en`), and D (admin). Insert entitlements directly with `edition_id` set. Then `update public.books set status = 'draft'`. Grant `select, insert on public.reader_annotations` and `execute on public.reader_locator_is_valid(jsonb)` to `authenticated` inside the transaction, as the Books file does. Assertions:
  - (a) As A, `create_reader_session(en_v2, 900)` returns a row, saved in a temp table. `authorize_reader_session` with it returns one row.
  - (b) As A, `save_reading_progress` on `en_v2` lives, and `reader_annotation_request(session, en_v2, 'list')` lives.
  - (c) As A, a direct `insert into public.reader_annotations` for `en_v2` lives (the RLS policy).
  - (d) As B, `create_reader_session(en_v2, 900)` throws `EB008`, and the same annotation insert throws `42501`.
  - (e) As C, `create_reader_session(en_v2, 900)` throws `EB008`.
  - (f) `update public.editions set active_publication_id = null where id = en`. As A, `create_reader_session(en_v2, 900)` lives (rule step 2), and `create_reader_session(en_v1, 900)` throws `EB008`. Restore the pointer.
  - (g) As D, `rollback_publication(book, en_v1)`. As A, a session on `en_v1` lives, a session on `en_v2` throws `EB008`, and the session from (a) now authorizes zero rows.
  - (h) `has_function_privilege('authenticated', 'public.reader_publication_for_edition(uuid)', 'EXECUTE')` is false, and so is the same check for `anon` and `service_role`.
  - (i) As A, `create_reader_session(ja_pub, 900)` throws `EB008`: the unpublished book does not loosen the per-edition check.
  - (j) `update public.editions set status = 'draft' where id = en`. As A, `create_reader_session(en_v1, 900)` lives (the pointer is on v1 after (g)). Restore `status = 'published'`.

- [ ] **Step 2: Flip the old assertions, keeping each plan count**
  - `009_reader_sessions.sql` test 23 (pointer cleared): `lives_ok`, "an entitled reader still mints a session after the edition's active pointer is cleared". Test 24 (book draft): `lives_ok`, "an entitled reader still mints a session after the book is unpublished". Rewrite the (22)-(25) header comment as the Books file did: rule step 2 keeps a cleared pointer readable, the rollback case lives in `press_owner_reads_unpublished.sql`.
  - `010_reading_progress.sql` test 19: `lives_ok`, "an entitled reader still saves progress after the book is unpublished". The fixture comments at lines 38-41 and 69-71 already describe this behavior.
  - `reader_annotations.test.sql:231`: the list count for the unpublished book equals the count the same session listed before the book was set to draft, with description "an unpublished book can still be annotated by its owner". Read the preceding assertions to pick the right expected count.
  - `press_edition_access.sql:70`: `lives_ok`, "a draft edition with a readable publication stays readable by its owner". Line 76: `lives_ok`, "an unpublished work keeps every owned edition readable".

- [ ] **Step 3: Run and confirm the failures**

  Run: `npm run db:reset && npm run db:test`
  Expected: `press_owner_reads_unpublished` and the five flipped assertions fail. Everything else passes.

- [ ] **Step 4: Write the migration**
  - Add `reader_publication_for_edition(p_edition_id uuid) returns uuid`, `language sql`, `stable`, `security definer`, `set search_path = ''`. Body: `coalesce` of (the edition's `active_publication_id` when that publication is `published`) and (the latest `published` or `superseded` publication of the edition through `ebook_assets.edition_id`, `order by pub.processed_at desc, pub.id desc limit 1`). Revoke EXECUTE from `public, anon, authenticated, service_role`.
  - `create or replace function public.reader_edition_for_publication(...)` with the body from the Global Constraints source, replacing the four lines `pub.status = 'published'`, `e.active_publication_id = pub.id`, `e.status in ('published', 'archived')`, `b.status = 'published'` with `pub.id = public.reader_publication_for_edition(e.id)`. Drop the now-unused `join public.books b`. Keep the self-only check and the entitlement `exists`.
  - Header comment: the rule, the spec path, and the list of callers that inherit it (`create_reader_session`, `authorize_reader_session`, `save_reading_progress`, `submit_edition_feedback`, the four `reader_annotations` policies).

- [ ] **Step 5: Run the tests and confirm they pass**

  Run: `npm run db:reset && npm run db:test`
  Expected: all files pass.

- [ ] **Step 6: Commit**

  ```bash
  git add supabase/migrations/20261021100000_owner_reads_unpublished.sql supabase/tests/
  git commit -m "fix(reader): entitled owners keep reading after unpublish or rollback"
  ```

### Task 2: `my_library_editions` RPC

**Files:**
- Create: `supabase/migrations/20261021110000_my_library_editions.sql`
- Modify: `supabase/tests/press_owner_reads_unpublished.sql` (raise the plan count)
- Modify: `lib/supabase/database.types.ts` (`Functions.my_library_editions`, `Functions.reader_publication_for_edition`)

**Interfaces:**
- Consumes: `reader_publication_for_edition` (Task 1), `catalog_resolved_editions(p_language text, p_book_id uuid)`.
- Produces: `my_library_editions(p_locale text) returns table (book_id uuid, edition_id uuid, language_code text, slug text, title text, author_name text, cover_storage_key text, cover_alt_text text, publication_id uuid, in_catalog boolean)`. Granted to `authenticated` only.

- [ ] **Step 1: Add these assertions to `press_owner_reads_unpublished.sql`** (book still `draft`; after (g) the `en` pointer is on `en_v1`)
  - (a) As A, it returns one row: the `en` edition with `language_code = 'en'`, the fixture cover key, `publication_id = en_v1`, and `in_catalog = false`.
  - (b) For locale `en` with only a `vi` localization, it returns the `vi` title and slug.
  - (c) As B, it returns 0 rows. `has_function_privilege('anon', 'public.my_library_editions(text)', 'EXECUTE')` is false, and so is the check for `service_role`.
  - (d) Give D (admin) an entitlement to the `ja` edition. As D, it returns exactly 1 row, the `ja` edition, never A's.
  - (e) Restore `books.status = 'published'`. As A, `in_catalog` is true for locale `en`.

- [ ] **Step 2:** Run `npm run db:test` and confirm the new assertions fail.

- [ ] **Step 3: Write the migration and patch `database.types.ts`**
  - `language sql`, `stable`, `security definer`, `set search_path = ''`. From `profiles p` (where `p.auth_user_id = auth.uid()`) join `entitlements en` (`status = 'active'`, `edition_id is not null`) join `editions e` join `books b`. Localization: `lateral` over `book_localizations` ordered by `(l.locale = p_locale) desc, (l.locale = (select default_metadata_locale from public.platform_settings)) desc, (l.locale = b.original_language) desc, l.locale`, `limit 1`; a book with no localization is omitted (inner join). Author: `coalesce(al.name, a.display_name)` with the same `author_localizations` join as `catalog_book_card_rows`. Cover: the edition's `media_assets` cover, else the book's, as in `catalog_book_card_rows`. `publication_id`: `public.reader_publication_for_edition(e.id)`. `in_catalog`: `exists (select 1 from public.catalog_resolved_editions(p_locale, b.id))`.
  - `revoke execute ... from public, anon, service_role; grant execute ... to authenticated`.
  - Types: add `my_library_editions: { Args: { p_locale: string }; Returns: { ... }[] }` with the ten columns (`cover_storage_key`, `cover_alt_text`, `publication_id` nullable) and `reader_publication_for_edition: { Args: { p_edition_id: string }; Returns: string }`, both in alphabetical position.

- [ ] **Step 4:** Run `npm run db:reset && npm run db:test` and confirm everything passes.

- [ ] **Step 5:** Commit with the message `feat(library): owner-scoped my_library_editions RPC`.

### Task 3: Library and reader read owned editions

**Files:**
- Modify: `lib/data/library.ts` (`LibraryItemDTO`, `LibraryRow`, `getLibrary`, `getReadableEdition`, `getOwnedEditionsOfBook`)
- Modify: `lib/data/library.test.ts`
- Modify: `lib/reader/session.ts:323-343, 443` (`loadServablePublication`, `resolveEntitledManifest`), `lib/reader/session.test.ts:763` (the `resolveEntitledManifest` describe)
- Modify: `app/[lang]/(account)/library/page.tsx:133-138`, `app/[lang]/(account)/library/page.test.tsx:96-104`
- Modify: `app/[lang]/(reader)/read/editions/[editionId]/page.tsx:71`
- Modify: `components/reader/reader-client.tsx:68, 1002`, `components/reader/reader-completion-panel.tsx:29, 48`, `components/reader/reader-completion-panel.test.tsx`
- Modify: `docs/runbooks/catalog-admin.md:56`

**Interfaces:**
- Consumes: `my_library_editions` (Task 2) and `coverPublicUrl(storageKey)` from `lib/catalog/covers.ts`.
- Keeps the public signatures of `getLibrary(locale)`, `getReadableEdition(locale, editionId)`, and `getOwnedEditionsOfBook(locale, bookId)`. Adds `inCatalog: boolean` to `LibraryItemDTO` and to the `getReadableEdition` result.
- `ReaderClientProps` (entitled mode) and `ReaderCompletionPanel` take `reviewHref: string | null`.

- [ ] **Step 1: Write the failing Vitest cases**
  - `library.test.ts`: extend `fakeClient` with an `rpc` fake that returns the owned rows (copy `fakeClient`/`ownedBook` from `../infinity-books/lib/data/library.test.ts:83-105`, renamed `ownedEdition` with `edition_id` and `language_code`). Then:
    - `getLibrary` lists an edition that `my_library_editions` returns and `getBookCards` does not. `coverUrl` equals `coverPublicUrl(row.cover_storage_key)`; progress is matched on the RPC's `publication_id`; `inCatalog` is copied through.
    - `getLibrary` omits an owned edition whose RPC `publication_id` is null, and one with no RPC row.
    - `getLibrary` asks the RPC with `{ p_locale: "vi" }` for locale `vi`.
    - `getReadableEdition` returns `publicationId` and `inCatalog: false` from the RPC when the book is missing from `getBookCards`; `relatedBooks` is `[]`; `canonicalBookUrl` ends with the owned slug.
    - `getReadableEdition` returns null when the RPC has no row for the edition, and null when the row's `publication_id` is null.
    - `getOwnedEditionsOfBook` returns the caller's editions of the book from the RPC, sorted by language code, and skips a row whose `publication_id` is null. Rewrite the existing three cases on RPC rows; "skips an edition that is not live" becomes "skips an edition with nothing readable".
    - Update the existing fixtures (`libraryRow`, `japaneseRow`, the `getReadableEdition` and admin-scoping cases) to supply RPC rows instead of `books`/`editions` embeds, keeping each assertion's meaning.
  - `session.test.ts` under `resolveEntitledManifest`: add "serves an entitled manifest for a superseded publication"; narrow the `it.each` inside that describe (the one listing `"superseded"`) to `["ready_for_preview", "rejected"]` (copy from Books commit `edf7e1b`). Sample describes stay as they are.
  - `library/page.test.tsx`: the review link renders for an item with `inCatalog: true` and is absent for `inCatalog: false`.
  - `reader-completion-panel.test.tsx`: no review link when `reviewHref` is null.

- [ ] **Step 2:** Run `npx vitest run lib/data/library.test.ts lib/reader/session.test.ts "app/[lang]/(account)/library" components/reader/reader-completion-panel.test.tsx` and confirm the new cases fail.

- [ ] **Step 3: Implement**
  - `library.ts`: add `type OwnedEditionRow = Database["public"]["Functions"]["my_library_editions"]["Returns"][number]`. `getLibrary`: keep `library_items` with `entitlements!inner ( status )`, drop the `books!inner` and `editions` embeds, call `rpc("my_library_editions", { p_locale: locale })` in the same `Promise.all`, join on `edition_id`, drop rows with no RPC row or a null `publication_id`, take title, slug, language code, cover (`coverPublicUrl`), and `inCatalog` from the RPC row. `getReadableEdition`: replace the entitlement read and the `editions` read with the RPC filtered by `edition_id` (`.eq("edition_id", editionId).maybeSingle()`), return null when absent or `publication_id` is null; keep `getBookCards` for `relatedBooks` only and `getBookAcceptsQuestions` as is; `canonicalBookUrl` from the RPC slug in the interface locale; add `inCatalog`. `getOwnedEditionsOfBook`: the RPC filtered by `book_id`, rows with a non-null `publication_id`, sorted by `language_code`. Update the comments that describe the old published-only gates and the `LibraryItemDTO.coverUrl` comment.
  - `session.ts`: `loadServablePublication(admin, publicationId, allowSuperseded = false)`; servable when `published`, or `superseded` with the flag; `resolveEntitledManifest` passes `true`. Update the comment above the function and the denial-model comment at lines 26 and 128 (copy Books `edf7e1b`).
  - `reader-client.tsx`: `reviewHref: string | null` in entitled mode; render `ReaderCompletionPanel` when `finished && !completionDismissed`, passing `reviewHref ?? null`. `reader-completion-panel.tsx`: `reviewHref: string | null`, render the link only when set.
  - `read/editions/[editionId]/page.tsx`: `reviewHref={book.inCatalog ? getCatalogRoutes(locale).review(book.bookId, book.editionId) : null}`.
  - `library/page.tsx`: wrap the review `Link` in `item.inCatalog ? ... : null` with the comment "The review page is catalog-gated: an unpublished book would link to a 404."
  - `docs/runbooks/catalog-admin.md:56`: the Global Constraints text.

- [ ] **Step 4:** Run the Step 2 command and confirm it passes, then `npm run check`.

- [ ] **Step 5:** Commit with the message `fix(library): show and open owned editions after unpublish`.

### Task 4: Full-path verification

**Files:** none new.

- [ ] **Step 1:** Run `npm run check:full` with the Supabase and Mailpit env vars exported and a scratch stack on :3100. Expected: green. Fix any e2e fixture that asserted the old unpublish behavior (grep `e2e/` for `unpublish`).

- [ ] **Step 2:** By hand on the scratch stack: buy an edition, read it, unpublish the book as admin, then as the customer confirm the library card shows its cover and no review link, `/read/editions/<id>` resumes at the saved position, `/read/<bookId>` still redirects to the owned edition, and selecting text then clicking share does not crash. Republish the book and confirm the review link returns.

- [ ] **Step 3:** Commit any fixture fix with the message `test(e2e): unpublish keeps owners reading`.
