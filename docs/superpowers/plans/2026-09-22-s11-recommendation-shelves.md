# S11 Recommendation Shelves Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show deterministic, editorially controllable recommendations on the reader library and public topic/author pages without recommending unavailable, untranslated, seeded, or already-owned books.

**Architecture:** Postgres owns candidate filtering and scoring through one `recommend_books(...)` RPC. A server-only recommendation DAL preserves the RPC order while mapping IDs to the existing `CatalogBookCard` DTO, and one Server Component renders every shelf with the existing `BookCard`. Admin pins are a directed, ordered relation managed through an authenticated, audited RPC; public pages use the cookie-less public client, while the protected library supplies its owned book IDs only after `requireUser()` succeeds.

**Tech Stack:** Next.js 16.3 App Router, React 19 Server Components and Server Actions, Supabase/Postgres/Auth/RLS, TypeScript 6, Zod 4, Vitest 5, pgTAP, Playwright 1.63, Tailwind CSS 4.

**Spec:** `docs/superpowers/specs/2026-09-21-s11-recommendation-design.md`

## Global Constraints

- Read the local Next.js 16 guides before changing framework code. For this plan, use `node_modules/next/dist/docs/01-app/01-getting-started/08-caching.md`, `node_modules/next/dist/docs/01-app/01-getting-started/09-revalidating.md`, `node_modules/next/dist/docs/01-app/02-guides/forms.md`, `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`, and `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/revalidatePath.md`.
- Customer routes stay under `/{locale}` for `vi` and `en`; `/admin` remains unprefixed.
- Every protected page and Server Action calls `requireUser()` or `requireAdmin()` itself. The existing library and book-admin gates must remain in place.
- Never create a service-role client before the admin gate and never expose `SUPABASE_SERVICE_ROLE_KEY` to browser code. This feature needs no service-role client in application code.
- `recommend_books(p_seed_book_ids uuid[], p_exclude_book_ids uuid[], p_locale text, p_limit int)` returns `(book_id uuid, score int, pinned boolean)` and explicitly filters `books.status = 'published'`, an active `ebook_publications.status = 'published'`, and a `book_localizations.locale = p_locale` row.
- The exact computed weights are declared at the top of the function as `series = 100`, `primary author = 50`, and `shared topic = 10 per distinct shared topic`. A candidate receives each series/author weight at most once across all seeds; topics accumulate once per distinct topic across all seeds.
- S9 bundle tables are not present in the current tree. This plan therefore does not reference `bundle_books`; after S9 ships, its integration migration may add a named bundle weight of `5`, applied at most once, without changing the RPC signature or application code.
  - **Superseded during execution:** merging `main` brought S9 onto this branch before S11 landed, so `public.bundle_books` exists and the premise above no longer holds. The bundle weight of `5` was implemented directly in `20260926100000_s11_recommendations.sql` rather than in a separate integration migration, and the RPC signature is unchanged as predicted. Spec §5.1 is updated to match.
- Editorial pin order is meaningful: pinned candidates sort first by the smallest directed `related_books.position` found across the seeds. Computed score, publication date, and `book_id` remain the deterministic tie-breakers after pin position. This is the only ordering that preserves both the spec's drag ordering and its deterministic-output requirement.
- “Publication date” means the active publication's edition `publication_date`, falling back to `books.created_at::date` when that optional field is null.
- Seed books are always excluded by the RPC. `p_exclude_book_ids` adds exclusions; the library passes its complete owned set as both seeds and exclusions.
- An empty result renders no `<section>` and no heading. Every rendered shelf contains at most six cards in the exact RPC order, uses native horizontal scrolling, and adds no recommendation-specific client JavaScript.
- Public topic/author pages keep the current cache behavior. Do not add `use cache`; existing catalog mutations already call `revalidateStorefront()` through `revalidateBookAdmin()`, and the new pin action must do the same.
- Reader-facing copy exists in both dictionaries: library `recommendationsTitle` is `You might like` / `Có thể bạn thích`; catalog entity `recommendationsTitle` is `Related books` / `Sách liên quan`.
- Applied migrations are never edited. Use a new S11 migration after the planned S9 migration range. Reserve pgTAP numbers `042`–`049` for the rebased S9 plan and use `050_s11_recommendations.sql` here.
- Database functions with elevated access use `security definer`, `set search_path = ''`, fully qualified relation names, explicit `REVOKE`/`GRANT`, and never rely on caller-visible catalog RLS for their publication filter.
- Update `lib/supabase/database.types.ts` from a reset local stack after the schema/RPC change; do not hand-maintain generated definitions.
- Keep the existing reader-completion recommendations in `lib/data/library.ts` behaviorally unchanged. Replacing that already-shipped S5.5 surface is outside S11; the new RPC/DAL is deliberately reusable when that migration is separately approved.
- Run database and Playwright tests only against a local Supabase stack. Follow `docs/runbooks/testing-environments.md`, including its scratch-workdir and environment-export warnings.
- Use Node.js 22. Run `npm run check`, `npm run db:test`, and `npm run check:full` for the final gate; reset the local database before trusting pgTAP results.

## File Structure

| Area | Files and responsibility |
| --- | --- |
| Database contract | `supabase/migrations/20260925100000_s11_recommendations.sql`, `supabase/tests/050_s11_recommendations.sql`, `lib/supabase/database.types.ts`: directed pins, audited admin write, filtered/scored/deterministic recommendation RPC. |
| Admin editor | `lib/catalog/schemas.ts`, `lib/data/books.ts`, `app/admin/books/[bookId]/editor-actions.ts`, `components/admin/book-editor/related-books-picker.tsx`, `relations-form.tsx`, and their tests: validate, load, order, and save pins. |
| Shared read/render path | `lib/data/recommendations.ts`, `components/catalog/recommendation-shelf.tsx`, their tests, and dictionaries: map ordered IDs to existing cards and render a six-card shelf or nothing. |
| Public placement | `components/catalog/entity-page.tsx` and test: seed from a topic's or author's visible books, exclude the seeds, and render the shared shelf only for those two entity kinds. |
| Library placement | `app/[lang]/(account)/library/page.tsx` and test: seed/exclude the reader's owned IDs after authorization and render the shared shelf. |
| Acceptance/operations | `e2e/recommendations.spec.ts`, `e2e/support/catalog.ts`, `docs/runbooks/catalog-admin.md`: prove topic and library placement and document pin semantics. |

---

### Task 1: Add the recommendation schema and scoring RPC

**Files:**
- Create: `supabase/migrations/20260925100000_s11_recommendations.sql`
- Create: `supabase/tests/050_s11_recommendations.sql`
- Modify: `lib/supabase/database.types.ts`

**Interfaces:**
- Produces table `public.related_books(book_id uuid, related_book_id uuid, position integer)` with primary key `(book_id, related_book_id)`, unique `(book_id, position)`, and `book_id <> related_book_id`.
- Produces `public.admin_set_related_books(p_book_id uuid, p_related_book_ids uuid[]) returns void` for authenticated admins only.
- Produces `public.recommend_books(p_seed_book_ids uuid[], p_exclude_book_ids uuid[], p_locale text, p_limit integer) returns table(book_id uuid, score integer, pinned boolean)` for `anon` and `authenticated`.
- Later tasks consume the generated RPC argument names exactly as written above.

- [ ] **Step 1: Write the failing schema and permission assertions**

  Create `050_s11_recommendations.sql` with `begin`, a fixed plan count, deterministic UUID fixtures, and assertions equivalent to:

  ```sql
  select has_table('public', 'related_books', 'directed editorial relation exists');
  select col_is_pk('public', 'related_books', array['book_id', 'related_book_id'], 'pair is the primary key');
  select has_check('public', 'related_books', 'self relation is rejected');
  select has_function('public', 'admin_set_related_books', array['uuid', 'uuid[]'], 'admin pin writer exists');
  select has_function('public', 'recommend_books', array['uuid[]', 'uuid[]', 'text', 'integer'], 'recommendation RPC exists');
  select throws_ok(
    $$ insert into public.related_books(book_id, related_book_id, position)
       values ('51000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', 1) $$,
    '23514', null, 'a book cannot pin itself'
  );
  ```

  Add an ordinary authenticated reader and an authenticated admin. Assert direct inserts/deletes fail for both, the reader cannot execute `admin_set_related_books`, and the admin can replace `[B,C]` with `[C]` while positions are rewritten to `1..N`.

- [ ] **Step 2: Add failing admin audit and directionality assertions**

  Call the admin RPC as the authenticated admin and assert one immutable audit row per successful call:

  ```sql
  select is(
    (select count(*)::int from public.audit_logs
      where action = 'set_related_books' and entity_id = :'seed_book_id'),
    1,
    'saving editorial pins writes one audit row'
  );
  select is(
    (select metadata->'related_book_ids' from public.audit_logs
      where action = 'set_related_books' and entity_id = :'seed_book_id'),
    to_jsonb(array[:'candidate_b'::uuid, :'candidate_c'::uuid]),
    'audit metadata preserves pin order'
  );
  select isnt(
    (select count(*)::int from public.related_books where book_id = :'candidate_b'),
    1,
    'pinning B under A does not pin A under B'
  );
  ```

  Include rollback-on-error coverage: a self-reference or unknown candidate leaves the previous ordered set unchanged and creates no audit row.

- [ ] **Step 3: Add failing recommendation eligibility assertions**

  Seed published candidates covering each exclusion boundary: a seed, explicit exclusion, draft book, published book with no active publication, active publication whose status is not `published`, book without the requested localization, and one eligible unrelated book. Assert only related eligible candidates appear and no seed/excluded/ineligible ID appears.

  Run the same call after `set local role anon`:

  ```sql
  select results_eq(
    $$ select book_id from public.recommend_books(
         array[:'seed_book_id'::uuid], array[]::uuid[], 'en', 6) $$,
    $$ values (:'eligible_related_id'::uuid) $$,
    'anonymous callers receive only explicitly published, localized, active-publication books'
  );
  ```

- [ ] **Step 4: Add failing scoring and deterministic-order assertions**

  Give separate candidates exactly one series, author, one-topic, and two-topic signal, plus an editorially pinned low-score candidate. Assert returned scores are `100`, `50`, `10`, and `20`; two shared topics outrank one; the pin is first regardless of score; and two otherwise tied candidates order by active edition publication date descending then `book_id`.

  Prove repeatability with two materialized calls:

  ```sql
  create temporary table first_call as
    select row_number() over () as ordinal, *
    from public.recommend_books(:'seed_ids'::uuid[], array[]::uuid[], 'en', 100);
  create temporary table second_call as
    select row_number() over () as ordinal, *
    from public.recommend_books(:'seed_ids'::uuid[], array[]::uuid[], 'en', 100);
  select results_eq(
    'select ordinal, book_id, score, pinned from first_call order by ordinal',
    'select ordinal, book_id, score, pinned from second_call order by ordinal',
    'identical inputs return identical ordering'
  );
  ```

  Also assert the lower of two pin positions wins across multiple seeds, `p_limit = 2` returns exactly two rows, empty seeds return zero rows, and null/negative limits return zero rows rather than raising.

- [ ] **Step 5: Run the new pgTAP file and verify it fails for missing objects**

  Run:

  ```bash
  supabase test db supabase/tests/050_s11_recommendations.sql --workdir .superpowers/scratch/sbworkdir
  ```

  Expected: FAIL because `related_books`, `admin_set_related_books`, and `recommend_books` do not exist.

- [ ] **Step 6: Implement the table, RLS, and audited writer**

  In the migration, create the table and ordered writer with these invariants:

  ```sql
  create table public.related_books (
    book_id uuid not null references public.books(id) on delete cascade,
    related_book_id uuid not null references public.books(id) on delete cascade,
    position integer not null check (position > 0),
    primary key (book_id, related_book_id),
    unique (book_id, position),
    check (book_id <> related_book_id)
  );
  alter table public.related_books enable row level security;
  create policy "admin reads related books" on public.related_books
    for select to authenticated using (public.is_admin());
  ```

  Revoke all direct writes from browser roles. `admin_set_related_books` must call `public.is_admin()`, lock the source book, reject a self ID before deleting, delete/insert atomically with `unnest(coalesce(p_related_book_ids, array[]::uuid[])) with ordinality`, and write one `audit_logs` row with the ordered UUID array. Keep `set search_path = ''`, fully qualify every object, and grant execution only to `authenticated`.

- [ ] **Step 7: Implement the scoring function**

  Use a PL/pgSQL function so the weights are visible named constants:

  ```sql
  declare
    v_series_weight constant integer := 100;
    v_author_weight constant integer := 50;
    v_topic_weight constant integer := 10;
  begin
    return query
    with seed_ids as (
      select distinct id from unnest(coalesce(p_seed_book_ids, array[]::uuid[])) as ids(id)
    ),
    excluded_ids as (
      select id from seed_ids
      union
      select distinct id from unnest(coalesce(p_exclude_book_ids, array[]::uuid[])) as ids(id)
    )
    -- eligible_candidates, shared_topics, signal flags, and pin_position CTEs
    select ranked.book_id, ranked.score, ranked.pinned
    from ranked
    where ranked.pinned or ranked.score > 0
    order by ranked.pinned desc,
             ranked.pin_position asc nulls last,
             ranked.score desc,
             ranked.publication_date desc,
             ranked.book_id
    limit greatest(0, least(coalesce(p_limit, 0), 100));
  end;
  ```

  `eligible_candidates` must join the candidate book's active `ebook_publications` row, its `ebook_assets` and `editions` row for the ordering date, and its requested localization. Compute series/author with `exists`, shared-topic contribution with `count(distinct topic_id)`, and pin state/position with `bool_or` plus `min(position)` across every seed. Revoke from `public`; grant only to `anon, authenticated`.

- [ ] **Step 8: Reset, run pgTAP, and regenerate database types**

  Run against the owned local/scratch stack:

  ```bash
  supabase db reset --workdir .superpowers/scratch/sbworkdir
  supabase test db --workdir .superpowers/scratch/sbworkdir
  supabase gen types --local --lang typescript --workdir .superpowers/scratch/sbworkdir > lib/supabase/database.types.ts
  git diff --check
  ```

  Expected: the full pgTAP suite passes; generated types expose both S11 RPCs and the `related_books` table.

- [ ] **Step 9: Commit the database contract**

  ```bash
  git add supabase/migrations/20260925100000_s11_recommendations.sql supabase/tests/050_s11_recommendations.sql lib/supabase/database.types.ts
  git commit -m "feat(recommendations): add deterministic scoring RPC"
  ```

---

### Task 2: Add ordered editorial pins to the admin Relations control

**Files:**
- Create: `components/admin/book-editor/related-books-picker.tsx`
- Create: `components/admin/book-editor/related-books-picker.test.tsx`
- Modify: `lib/catalog/schemas.ts`
- Modify: `lib/catalog/schemas.test.ts`
- Modify: `lib/data/books.ts`
- Modify: `lib/data/books.test.ts`
- Modify: `app/admin/books/[bookId]/editor-actions.ts`
- Modify: `app/admin/books/[bookId]/editor-actions.test.ts`
- Modify: `app/admin/books/[bookId]/page.tsx`
- Modify: `app/admin/books/[bookId]/page.test.tsx`

**Interfaces:**
- Produces `relatedBooksSchema` with `{ relatedBookIds: string[] }`, UUID validation, and duplicate rejection.
- Extends `AdminBookDTO` with `relatedBookIds: string[]` in saved position order.
- Produces `setRelatedBooks(bookId: string, relatedBookIds: string[]): Promise<void>`.
- Produces `setRelatedBooksAction(bookId, previousState, formData): Promise<AdminFormState>`.
- `RelatedBooksPicker` is a complete Client Component form: it accepts the Server Action, options, and defaults, and posts repeated hidden `relatedBookIds` fields in the visible order.

- [ ] **Step 1: Write failing schema and DAL tests**

  Add schema cases that accept `[]` and two distinct UUIDs, reject malformed UUIDs, and reject duplicates with a `relatedBookIds` field error. Extend `lib/data/books.test.ts` so `getAdminBook()` maps deliberately unordered embedded rows by numeric `position`:

  ```ts
  expect(book.relatedBookIds).toEqual([RELATED_B, RELATED_A]);
  expect(setRelatedBooks(BOOK_ID, [RELATED_B, RELATED_A])).resolves.toBeUndefined();
  expect(rpc).toHaveBeenCalledWith("admin_set_related_books", {
    p_book_id: BOOK_ID,
    p_related_book_ids: [RELATED_B, RELATED_A],
  });
  ```

  Assert `setRelatedBooks` calls `requireAdmin()` before creating the session client and maps `P0002` to `BookNotFoundError` without exposing raw database text.

- [ ] **Step 2: Run the focused schema/DAL tests and verify they fail**

  Run:

  ```bash
  npx vitest run lib/catalog/schemas.test.ts lib/data/books.test.ts
  ```

  Expected: FAIL because the schema, DTO field, and writer do not exist.

- [ ] **Step 3: Implement the schema and book DAL mapping**

  Add the exact schema and inferred type:

  ```ts
  export const relatedBooksSchema = z.object({
    relatedBookIds: z.array(z.uuid()).refine((ids) => new Set(ids).size === ids.length, {
      message: "Each related book can appear once.",
      path: ["relatedBookIds"],
    }),
  });
  export type RelatedBooksInput = z.infer<typeof relatedBooksSchema>;
  ```

  Add `related:related_books!related_books_book_id_fkey ( related_book_id, position )` to `bookSelect`, sort by `position` in `toDto`, and map only `related_book_id`. Add `setRelatedBooks` beside `setBookRelations`; it calls `requireAdmin()`, validates the source UUID through `assertUuid`, invokes `admin_set_related_books`, and passes failures through the existing safe `failure()` mapper.

- [ ] **Step 4: Write failing Server Action tests**

  Extend the action matrix with a `related books` case. Assert authorization happens before parsing, repeated ordered form fields become the ordered array, malformed/duplicate values do not write or revalidate, known missing-book errors are safe, unknown errors return the generic form error, and success calls the existing storefront-wide revalidation:

  ```ts
  expect(setRelatedBooks).toHaveBeenCalledWith(bookId, [relatedB, relatedA]);
  expect(revalidatePath).toHaveBeenCalledWith("/[lang]", "layout");
  expect(revalidatePath).toHaveBeenCalledWith("/sitemap.xml");
  ```

- [ ] **Step 5: Implement the protected Server Action**

  Add `setRelatedBooksAction` to the existing `"use server"` module:

  ```ts
  export async function setRelatedBooksAction(
    bookId: string,
    _previous: AdminFormState,
    formData: FormData,
  ): Promise<AdminFormState> {
    await requireAdmin({ next: `/admin/books/${bookId}` });
    const parsed = relatedBooksSchema.safeParse({ relatedBookIds: readList(formData, "relatedBookIds") });
    if (!parsed.success) return invalid(parsed.error);
    try {
      await setRelatedBooks(bookId, parsed.data.relatedBookIds);
    } catch (error) {
      return knownFailure(error);
    }
    revalidateBookAdmin(bookId);
    return saved();
  }
  ```

- [ ] **Step 6: Write failing picker interaction tests**

  In the picker test, render three options and defaults `[B,A]`. Assert the ordered list is B then A; adding C appends it; removing B deletes its hidden input; drag A after C changes the hidden values to `[C,A]`; and the keyboard-accessible `Move up`/`Move down` buttons produce the same order as drag.

  Submit `RelatedBooksPicker` once with a mocked failed action and assert the local order remains unchanged, then submit successfully and assert `FormStatus` announces `Saved.`. Every drag handle/button needs an accessible name containing the book title.

- [ ] **Step 7: Implement the picker without introducing a recommendation runtime client**

  Make only `related-books-picker.tsx` a Client Component. Its root is the second `<form>` in the Relations section; use `useActionState` and the existing `FormStatus`/`SubmitButton`. Store selected IDs in `useState`, render one hidden input per selected ID, and render available choices in a labeled native select plus `Add book`. Each selected row has `draggable`, `onDragStart`, `onDragOver`, and `onDrop`, plus explicit Move up, Move down, and Remove buttons. Disable boundary move buttons and filter the current book out in the Server Component before options reach the picker.

  Use this option contract:

  ```ts
  export type RelatedBookOption = {
    id: string;
    title: string;
    authorName: string;
    status: "draft" | "published" | "archived";
  };
  ```

  Show status in the option/row label so an admin understands that a draft pin will remain invisible until publication.

- [ ] **Step 8: Wire the picker into the admin page and Relations section**

  Import `listAdminBooks` and load it only after the page's existing `requireAdmin()` gate. Pass all books except `book.id` as options and `book.relatedBookIds` as defaults. Keep the existing `RelationsForm` for topic/series unchanged; render `RelatedBooksPicker` beneath it with a heading `Editorial pins`, bound to `setRelatedBooksAction`, and with submit text `Save editorial pins`.

  Update page tests to mock `listAdminBooks`, assert the authorization rejection performs no data reads, and assert the picker omits the current book while showing candidates.

- [ ] **Step 9: Run focused admin tests and the application gate**

  Run:

  ```bash
  npx vitest run lib/catalog/schemas.test.ts lib/data/books.test.ts 'app/admin/books/[bookId]/editor-actions.test.ts' 'app/admin/books/[bookId]/page.test.tsx' components/admin/book-editor/related-books-picker.test.tsx
  npm run check
  ```

  Expected: all focused tests and `npm run check` pass.

- [ ] **Step 10: Commit the admin editor**

  ```bash
  git add lib/catalog/schemas.ts lib/catalog/schemas.test.ts lib/data/books.ts lib/data/books.test.ts 'app/admin/books/[bookId]/editor-actions.ts' 'app/admin/books/[bookId]/editor-actions.test.ts' 'app/admin/books/[bookId]/page.tsx' 'app/admin/books/[bookId]/page.test.tsx' components/admin/book-editor/related-books-picker.tsx components/admin/book-editor/related-books-picker.test.tsx
  git commit -m "feat(admin): manage ordered recommendation pins"
  ```

---

### Task 3: Build the shared recommendation DAL and shelf

**Files:**
- Create: `lib/data/recommendations.ts`
- Create: `lib/data/recommendations.test.ts`
- Create: `components/catalog/recommendation-shelf.tsx`
- Create: `components/catalog/recommendation-shelf.test.tsx`
- Modify: `lib/i18n/dictionaries/en.json`
- Modify: `lib/i18n/dictionaries/vi.json`

**Interfaces:**
- Produces `getRecommendedBooks(input: { seedBookIds: string[]; excludeBookIds?: string[]; locale: Locale; limit?: number }): Promise<CatalogBookCard[]>`.
- Produces `RecommendationShelf(props: { books: CatalogBookCard[]; heading: string; headingId: string; locale: Locale; copy: Dictionary["catalog"]["book"] }): JSX.Element | null`.
- The DAL returns cards in RPC order and never exposes `score` or `pinned` to browser code.

- [ ] **Step 1: Write failing DAL contract tests**

  Mock `createPublicClient()` and `getBookCards()`. Assert empty seeds return `[]` without either call; a normal call sends exact RPC arguments with default limit six; limits are clamped to `0..6`; missing card IDs are dropped; and card output follows RPC ID order rather than catalog-card order:

  ```ts
  expect(await getRecommendedBooks({
    seedBookIds: [SEED],
    excludeBookIds: [SEED, OWNED_B],
    locale: "en",
  })).toEqual([cardC, cardA]);
  expect(rpc).toHaveBeenCalledWith("recommend_books", {
    p_seed_book_ids: [SEED],
    p_exclude_book_ids: [SEED, OWNED_B],
    p_locale: "en",
    p_limit: 6,
  });
  ```

  Add an RPC-error case that returns the public message `getRecommendedBooks failed.`, retains the database error on `cause`, and logs its code/message with `x-request-id` using the same pattern as `lib/data/catalog.ts`.

- [ ] **Step 2: Run the DAL test and verify the module is missing**

  Run: `npx vitest run lib/data/recommendations.test.ts`.

  Expected: FAIL because `lib/data/recommendations.ts` does not exist.

- [ ] **Step 3: Implement the server-only DAL**

  Start with `import "server-only"`. De-duplicate seed/exclusion arrays without reordering, clamp the requested limit with `Math.max(0, Math.min(limit ?? 6, 6))`, and return early for no seeds or limit zero. Fetch cards and RPC rows in parallel, build a `Map` keyed by `bookId`, and preserve the RPC order:

  ```ts
  const byId = new Map(cards.map((card) => [card.bookId, card]));
  return ((data ?? []) as RecommendationRow[])
    .flatMap((row) => byId.get(row.book_id) ?? [])
    .slice(0, boundedLimit);
  ```

  Use `createPublicClient()` even for the library call because the returned DTO is entirely public catalog data; authentication is required by the library page before it supplies owned IDs, not by the recommendation result itself.

- [ ] **Step 4: Write the failing shelf rendering tests**

  Render zero, three, and eight cards. Assert zero produces an empty container with no heading; eight produces exactly six list items; three preserve input link order; the section is named by its heading; the list has horizontal-overflow styling; and every card title is a native keyboard-focusable link.

  ```ts
  expect(screen.queryByRole("heading", { name: "Related books" })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Related books" })).toBeVisible();
  expect(screen.getAllByRole("listitem")).toHaveLength(6);
  expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(expectedTitles);
  ```

- [ ] **Step 5: Implement the Server Component shelf**

  Do not add `"use client"`. Slice to six before rendering. Return `null` when empty. Render a `<section aria-labelledby={headingId}>`, `<h2 id={headingId}>`, and a `<ul>` with `flex`, fixed/shrink-zero card widths, `overflow-x-auto`, and scroll padding. Reuse `BookCard` directly so cover ratio, localized links, price copy, and focus styles stay identical to S2.

- [ ] **Step 6: Add exact bilingual copy**

  Add:

  ```json
  // en.json
  "library": { "recommendationsTitle": "You might like" },
  "catalog": { "entity": { "recommendationsTitle": "Related books" } }

  // vi.json
  "library": { "recommendationsTitle": "Có thể bạn thích" },
  "catalog": { "entity": { "recommendationsTitle": "Sách liên quan" } }
  ```

  Preserve every existing sibling key; these snippets show the new key placement, not replacement objects.

- [ ] **Step 7: Verify and commit the shared layer**

  Run:

  ```bash
  npx vitest run lib/data/recommendations.test.ts components/catalog/recommendation-shelf.test.tsx lib/i18n/dictionary.test.ts
  npm run check
  ```

  Then commit:

  ```bash
  git add lib/data/recommendations.ts lib/data/recommendations.test.ts components/catalog/recommendation-shelf.tsx components/catalog/recommendation-shelf.test.tsx lib/i18n/dictionaries/en.json lib/i18n/dictionaries/vi.json
  git commit -m "feat(catalog): add shared recommendation shelf"
  ```

---

### Task 4: Place recommendations on topic and author pages

**Files:**
- Modify: `components/catalog/entity-page.tsx`
- Create: `components/catalog/entity-page.test.tsx`

**Interfaces:**
- Consumes `CatalogEntityPage.books`, `getRecommendedBooks(...)`, and `RecommendationShelf` from Task 3.
- Topic and author calls use all visible entity book IDs as seeds; the RPC excludes those seeds automatically.
- Series pages remain unchanged and do not call the recommendation DAL.

- [ ] **Step 1: Write failing entity-page placement tests**

  Mock `getEntityPage`, `getRecommendedBooks`, environment/metadata helpers, and dictionary loading. For both `topic` and `author`, assert:

  ```ts
  expect(getRecommendedBooks).toHaveBeenCalledWith({
    seedBookIds: entity.books.map((book) => book.bookId),
    excludeBookIds: [],
    locale: "en",
    limit: 6,
  });
  expect(screen.getByRole("region", { name: "Related books" })).toBeVisible();
  ```

  Assert the main entity grid still contains its own books, the recommendation shelf contains only returned candidates, an empty result has no recommendation heading, and `kind="series"` never calls `getRecommendedBooks` or renders the shelf.

- [ ] **Step 2: Run the new component test and verify placement is absent**

  Run: `npx vitest run components/catalog/entity-page.test.tsx`.

  Expected: FAIL because `EntityPage` does not load or render recommendations.

- [ ] **Step 3: Load recommendations after resolving the entity**

  Keep the existing locale validation and `notFound()` behavior. After `getEntityPage()` succeeds, load the dictionary and recommendations together where possible:

  ```ts
  const seedBookIds = entity.books.map((book) => book.bookId);
  const [dictionary, recommendations] = await Promise.all([
    getDictionary(locale),
    kind === "author" || kind === "topic"
      ? getRecommendedBooks({ seedBookIds, excludeBookIds: [], locale, limit: 6 })
      : Promise.resolve([]),
  ]);
  ```

  Do not move recommendations into metadata generation; metadata keeps loading only the canonical entity page.

- [ ] **Step 4: Render the shared shelf below the entity's own book grid**

  Add:

  ```tsx
  <RecommendationShelf
    books={recommendations}
    copy={copy.book}
    heading={copy.entity.recommendationsTitle}
    headingId="entity-recommendations"
    locale={locale}
  />
  ```

  Give it normal vertical separation from the existing books section. Let the component return `null`; do not add a wrapper, placeholder, fallback book, or empty heading.

- [ ] **Step 5: Verify public pages and commit**

  Run:

  ```bash
  npx vitest run components/catalog/entity-page.test.tsx lib/data/catalog.test.ts
  npm run check
  ```

  Then commit:

  ```bash
  git add components/catalog/entity-page.tsx components/catalog/entity-page.test.tsx
  git commit -m "feat(storefront): recommend books on topic and author pages"
  ```

---

### Task 5: Place ownership-safe recommendations in the library

**Files:**
- Modify: `app/[lang]/(account)/library/page.tsx`
- Create: `app/[lang]/(account)/library/page.test.tsx`

**Interfaces:**
- Consumes the authenticated `getLibrary(locale)` DTO list and `getRecommendedBooks(...)` from Task 3.
- Passes the exact same owned ID set as `seedBookIds` and `excludeBookIds`.
- Keeps both the page-level `requireUser()` and the DAL-level gate already inside `getLibrary()`.

- [ ] **Step 1: Write the failing protected-page tests**

  Mock `requireUser`, `getLibrary`, and `getRecommendedBooks`. Assert authorization happens before either data call by rejecting `requireUser()` and checking both remain untouched. With two owned items, assert:

  ```ts
  expect(getRecommendedBooks).toHaveBeenCalledWith({
    seedBookIds: [OWNED_A, OWNED_B],
    excludeBookIds: [OWNED_A, OWNED_B],
    locale: "en",
    limit: 6,
  });
  ```

  Render a candidate and assert the region is named `You might like`, the candidate link is present, and neither owned title appears inside that region. Return `[]` and assert no region/heading exists. Return an empty library and assert the empty-library state remains unchanged and the helper's empty-seed fast path yields no shelf.

- [ ] **Step 2: Run the page test and verify recommendation loading is absent**

  Run:

  ```bash
  npx vitest run 'app/[lang]/(account)/library/page.test.tsx'
  ```

  Expected: FAIL because the page does not call the recommendation DAL or render the shelf.

- [ ] **Step 3: Load from owned IDs after the authorization gate**

  Preserve the current page gate and initial `Promise.all` for dictionary/library. Then derive IDs and load recommendations:

  ```ts
  await requireUser(locale, withLocale(locale, "/library"));
  const [dictionary, items] = await Promise.all([getDictionary(locale), getLibrary(locale)]);
  const ownedBookIds = items.map((item) => item.bookId);
  const recommendations = await getRecommendedBooks({
    seedBookIds: ownedBookIds,
    excludeBookIds: ownedBookIds,
    locale,
    limit: 6,
  });
  ```

  Do not move owned IDs into client props other than the existing rendered library items; the recommendation RPC is called server-side.

- [ ] **Step 4: Render the shelf after the existing library content**

  Place `RecommendationShelf` after the current owned shelf or empty-state section, still inside `<main>`:

  ```tsx
  <RecommendationShelf
    books={recommendations}
    copy={dictionary.catalog.book}
    heading={copy.recommendationsTitle}
    headingId="library-recommendations"
    locale={locale}
  />
  ```

  Add spacing only when the shelf exists by putting margin/padding on the shelf component's section, not an unconditional parent wrapper.

- [ ] **Step 5: Verify the library path and commit**

  Run:

  ```bash
  npx vitest run 'app/[lang]/(account)/library/page.test.tsx' lib/data/library.test.ts lib/data/recommendations.test.ts components/catalog/recommendation-shelf.test.tsx
  npm run check
  ```

  Then commit:

  ```bash
  git add 'app/[lang]/(account)/library/page.tsx' 'app/[lang]/(account)/library/page.test.tsx'
  git commit -m "feat(library): recommend unowned books"
  ```

---

### Task 6: Add end-to-end acceptance coverage and operator documentation

**Files:**
- Create: `e2e/recommendations.spec.ts`
- Modify: `e2e/support/catalog.ts`
- Modify: `docs/runbooks/catalog-admin.md`

**Interfaces:**
- Extends `seedCatalogBook(...)` return data with `authorId` and `topicId`; existing callers can ignore the extra fields.
- Produces `sharePrimaryAuthor(sourceAuthorId: string, candidateBookId: string): Promise<void>` in local-only E2E support.
- Reuses `createReader`, `signInAs`, and `grantEntitlement` rather than bypassing the protected customer path.

- [ ] **Step 1: Extend the local-only catalog fixture helper**

  Return the inserted author/topic IDs from `seedCatalogBook`. Add:

  ```ts
  export async function sharePrimaryAuthor(authorId: string, candidateBookId: string): Promise<void> {
    const service = createServiceRoleClient();
    check(await service.from("books").update({ primary_author_id: authorId }).eq("id", candidateBookId));
  }
  ```

  Keep the existing local-loopback guard provided by `createServiceRoleClient`; do not add cleanup that could target the cloud project.

- [ ] **Step 2: Write the failing Playwright journey**

  Seed published English books A and B with active publications and localizations. Make B share A's primary author while leaving B out of A's topic. Create/sign in a reader, grant only A, and assert:

  ```ts
  await page.goto("/en/library");
  const libraryRecommendations = page.getByRole("region", { name: "You might like" });
  await expect(libraryRecommendations.getByRole("link", { name: titleB })).toBeVisible();
  await expect(libraryRecommendations.getByRole("link", { name: titleA })).toHaveCount(0);

  await page.goto(`/en/topics/${topicSlugA}`);
  const topicRecommendations = page.getByRole("region", { name: "Related books" });
  await expect(topicRecommendations.getByRole("link", { name: titleB })).toBeVisible();
  await expect(topicRecommendations.getByRole("link", { name: titleA })).toHaveCount(0);
  ```

  This single fixture proves the required signed-in library exclusion and public topic placement without depending on editorial pins.

- [ ] **Step 3: Run the focused Playwright spec against local Supabase**

  Export the exact variables from `docs/runbooks/testing-environments.md`, then run:

  ```bash
  npm run test:e2e -- e2e/recommendations.spec.ts
  ```

  Expected before page integration: FAIL because neither recommendation region exists. Expected after Tasks 1–5: PASS.

- [ ] **Step 4: Document operator pin behavior**

  In `docs/runbooks/catalog-admin.md`, add a Recommendation pins section that states:

  - Open `/admin/books/{bookId}` and use Relations → Editorial pins.
  - Add, remove, drag, or use Move up/Move down, then save.
  - Pins are directed and ordered; pinning B under A does not pin A under B.
  - Pins beat computed scores but still appear only when the target is published, has a published active publication, and has copy in the visitor's locale.
  - Removing all pins does not force an empty shelf: computed series/author/topic signals may remain; if no signal remains, the shelf and heading disappear.
  - Relation saves revalidate the storefront; verify both `vi` and `en` when both localizations exist.

- [ ] **Step 5: Run the complete database and application gates**

  On Node 22 and the owned local stack, reset after any prior Playwright fixture writes. If this repository owns the default 543xx stack, run the required npm commands exactly:

  ```bash
  npm run db:reset
  npm run db:test
  npm run check
  npm run check:full
  git diff --check
  ```

  If another project owns 543xx, use the runbook's scratch-stack equivalents instead of the first two destructive npm scripts:

  ```bash
  supabase db reset --workdir .superpowers/scratch/sbworkdir
  supabase test db --workdir .superpowers/scratch/sbworkdir
  npm run check
  npm run check:full
  git diff --check
  ```

  Expected: every command passes. Confirm the ordinary Playwright test count increases by the number of tests in `e2e/recommendations.spec.ts`; do not accept a silently skipped file.

- [ ] **Step 6: Commit acceptance coverage and documentation**

  ```bash
  git add e2e/recommendations.spec.ts e2e/support/catalog.ts docs/runbooks/catalog-admin.md
  git commit -m "test(recommendations): cover library and topic shelves"
  ```

## Self-Review Results

- **Spec coverage:** The database task covers publication/localization/seed/exclusion safety, declared weights, pins, deterministic ties, anonymous callers, and audit behavior. Tasks 3–5 cover the shared six-card/no-empty-heading shelf, bilingual copy, topic/author placement, and owned-book exclusion. Task 6 covers both required Playwright surfaces and every final verification command.
- **Resolved ambiguity:** Pin drag order is enforced with `position` inside the pinned group before computed tie-breakers; otherwise the required admin ordering would have no observable effect. Exact weights and publication-date fallback are fixed above so pgTAP can assert them.
- **Dependency check:** S9 is optional and absent, so no missing `bundle_books` reference can break this migration. The stable RPC signature leaves bundle scoring additive after S9. (Superseded: S9 arrived with the `main` merge and the bundle weight is now scored in this same migration.)
- **Type consistency:** SQL and TypeScript use `p_seed_book_ids`, `p_exclude_book_ids`, `p_locale`, `p_limit`; the public result uses `book_id`, `score`, `pinned`; UI uses `CatalogBookCard[]`; admin form and RPC both preserve `relatedBookIds` order.
- **Scope check:** No behavioral history, embeddings, homepage merchandising, book-page placement, completion-panel migration, or A/B testing is introduced.
- **Placeholder scan:** The plan contains no deferred implementation markers; every in-scope behavior has a file, interface, test, implementation step, verification command, and commit boundary.
