# S4 Reader Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The reader gets typography and theme settings, a table of contents, a chapter title, a real whole-book progress figure, a lost-access state, and a completion state; and anyone can read a book's public sample at `/{locale}/read-sample/[slug]`.

**Architecture:** One migration adds `reading_progress.total_progression` and replaces `save_reading_progress` so it also drives `library_items.state`. The engine boundary gains exactly one member (`getTableOfContents`) and one preference (`width`). `ReaderClient` gains a `mode` prop so the sample reader is the same component with no session and no progress saving. A new base-ui `Dialog` primitive carries both the settings panel and the TOC drawer.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Supabase Postgres, pgTAP, Zod 4, Vitest, Testing Library, Playwright, `@base-ui/react`, `@readium/*` (behind the adapter only)

**Spec:** `docs/superpowers/specs/2026-09-16-s4-reader-completion-design.md` (parent: `docs/superpowers/specs/2026-09-13-remaining-mvp-ebook-launch-design.md`, section S4)

## Global Constraints

- Read the relevant local Next.js guide before changing Next.js code: `node_modules/next/dist/docs/01-app/...`. Read `docs/adr/ADR-005-reader-engine.md` before touching anything under `lib/reader/`.
- **No Readium type may appear in `lib/reader/engine.ts` or `lib/reader/types.ts`.** Only `lib/reader/readium-engine.ts` may name one. This is ADR-005's hard constraint.
- `readium-engine.ts` must keep reaching `@readium/navigator` only through a dynamic `import()`, and `reader-client.tsx` must stay reachable only through `reader-mount.tsx`'s `next/dynamic` + `ssr: false`. Never import the adapter or the client from a Server Component.
- Keep PR #16's viewport contract on every reader layout change: the engine host div has `relative` plus `[&>.readium-navigator-iframe]:inset-0 [&>.readium-navigator-iframe]:h-full [&>.readium-navigator-iframe]:w-full [&>.readium-navigator-iframe]:border-0`.
- The adapter registers **no navigator listeners**. `readium-engine.test.ts`'s "registers no navigator listeners" test is the tripwire; do not add one.
- There is **no 403** on any reader path. 401 means "not signed in"; every other refusal is one indistinguishable 404; 502 is an outage.
- Customer routes stay under `/{locale}` (`vi`, `en`). `/admin` has no locale. Every protected page and Server Action calls `requireUser()` / `requireAdmin()` itself; layouts never authorize.
- `/{locale}/read-sample/...` is **public**. Do not add `read-sample` to `readerPages` in `lib/auth/route-access.ts`.
- Dictionaries: every key added to `lib/i18n/dictionaries/en.json` must be added to `vi.json` too, or `Dictionary` typing breaks. Client components never import a dictionary — the server passes a narrow `copy` prop.
- Touch targets are at least 44px (`min-h-11`). Every control works by keyboard.
- Styling is Tailwind v4 with CSS-variable tokens from `app/globals.css`. Use `--shadow-drawer` (`shadow-drawer`) and `--ease-quiet` (`ease-quiet`) for the panels. `cn()` comes from `@/lib/utils`; note `components/ui/*` import it as `from "cn"`.
- Add new migrations only; never edit an applied one. Name them after `20260915130000`.
- Regenerate types after every migration: `supabase gen types --local --lang typescript > lib/supabase/database.types.ts`.
- Run database and Playwright tests only against a **local** Supabase stack. If another stack owns the default ports, use a scratch `--workdir` stack — see `docs/runbooks/testing-environments.md`.
- Run `npm run check` at the end of every task. Run `npm run db:reset && npm run db:test` after every migration.
- Never stage `cmd.txt`, `.env.local`, `docs/ref/`, or any `.epub`.
- Work on branch `feat/s4-reader-completion` (it already holds the spec commit).

## Decisions This Plan Locks In

1. **`totalProgression` needs no API change.** It is already a field of `ReaderLocator` and therefore already in every progress request body, already validated and clamped by `parseReaderLocator`, and already stored inside `locator_json`. `saveProgress` reads it off the parsed locator. `app/api/reader/progress/route.ts` is not modified.
2. **`save_reading_progress` is dropped and recreated**, not `create or replace`: the argument list changes, so a replace would leave a second overload behind.
3. **`library_items.state` is written only on a winning save**, and never downgraded from `completed`.
4. **`width` never reaches the engine.** It sets the reading column's `max-width` in the component. `toEpubPreferences` ignores it.
5. **`ReaderEngine` gains exactly one member**, `getTableOfContents()`, returning the neutral `ReaderTocEntry[]`.
6. **One `ReaderClient` with `mode: "entitled" | "sample"`.** A unit test asserts sample mode issues neither a session nor a progress request.
7. **The sample page's publication lookup lives in `lib/reader/session.ts`**, not `lib/data/catalog.ts`, because that file already owns the sample trust boundary and the admin client it needs. `getSampleReaderBook` in `lib/data/catalog.ts` calls it.
8. **Render-dependent E2E needs a processed EPUB.** Seeded catalog books have a `manifest_key` pointing at no object, so they cannot render. Task 10 extracts the golden path's EPUB build and processing into `e2e/support/publication.ts` and both specs use it.
9. **Error codes are unchanged.** `save_reading_progress` keeps `EB009` as its single refusal code, including for an out-of-range `p_total_progression`.

## File Map

| Path | Responsibility |
| --- | --- |
| `supabase/migrations/20260916100000_reader_completion.sql` | `total_progression` column, `save_reading_progress` v2 with the library-state write |
| `supabase/tests/020_reader_completion.sql` | Completion, state transitions, refused saves, privileges |
| `supabase/tests/010_reading_progress.sql` | Updated for the new signature; reconciliation table unchanged |
| `lib/reader/progress.ts` | Forwards `locator.totalProgression` as `p_total_progression` |
| `lib/data/library.ts` | Percentage and state from `total_progression`, with a fallback |
| `lib/reader/types.ts` | `ReaderPreferences.width`, `ReaderTocEntry` |
| `lib/reader/preferences.ts` | Defaults, validation, `localStorage` round-trip, px ↔ scale |
| `lib/reader/toc.ts` | `flattenToc`, `chapterTitleFor` |
| `lib/reader/engine.ts` | `getTableOfContents()` on the interface |
| `lib/reader/readium-engine.ts` | `getTableOfContents` implementation; `toEpubPreferences` ignores `width` |
| `components/ui/dialog.tsx` | The repo's first overlay primitive (base-ui) |
| `components/reader/reader-settings-panel.tsx` | Five preference groups |
| `components/reader/reader-toc-drawer.tsx` | The TOC list |
| `components/reader/reader-client.tsx` | `mode`, lost access, re-mint, completion, width, chapter title, panel wiring |
| `components/reader/reader-mount.tsx` | Passes the new props through |
| `lib/reader/session.ts` | `resolveSamplePublicationId(bookId)` |
| `lib/data/catalog.ts` | `getSampleReaderBook(locale, slug)` |
| `app/[locale]/(public)/read-sample/[slug]/page.tsx` | The public sample reader page |
| `app/api/reader/publications/[publicationId]/manifest/route.test.ts` | The one untested reader handler |
| `lib/i18n/dictionaries/{en,vi}.json` | New `reader.*` keys |
| `e2e/support/publication.ts` | EPUB build + process + publish, extracted from the golden path |
| `e2e/reader-completion.spec.ts` | S4 journeys |
| `docs/runbooks/reader-corpus-matrix.md` | New runbook |
| `docs/adr/ADR-005-reader-engine.md`, `docs/runbooks/golden-path-validation.md`, `docs/runbooks/storefront.md` | Updated |

---

### Task 1: Whole-book progression and the library state

**Files:**
- Create: `supabase/migrations/20260916100000_reader_completion.sql`
- Create: `supabase/tests/020_reader_completion.sql`
- Modify: `supabase/tests/010_reading_progress.sql` (calls gain one argument)
- Modify: `lib/supabase/database.types.ts` (regenerated)

**Interfaces:**
- Consumes: `reading_progress`, `library_items`, `entitlements`, `ebook_publications`, `ebook_assets`, `editions`, `books.active_publication_id`, `profiles`, `auth.uid()`.
- Produces:
  - `public.reading_progress.total_progression numeric` (nullable, `check between 0 and 1`).
  - `public.save_reading_progress(p_publication_id uuid, p_locator jsonb, p_progression numeric, p_total_progression numeric, p_device_id text, p_client_sequence bigint)` returning `table (locator_json jsonb, progression numeric, total_progression numeric, device_id text, client_sequence bigint, updated_at timestamptz)`. Single error code `EB009`. Executable by `authenticated` only.

- [ ] **Step 1: Read the function being replaced**

Read `supabase/migrations/20260911210000_reading_progress_rpc.sql` in full. The new version is that
function with three changes and nothing else: one extra parameter, `total_progression` in the insert,
the `on conflict` set list and the return, and the `library_items` update. Do not restate or "tidy"
the reconciliation logic — `supabase/tests/010_reading_progress.sql` proves it, and it must keep
passing untouched.

- [ ] **Step 2: Write the failing pgTAP test**

Create `supabase/tests/020_reader_completion.sql`:

```sql
begin;
select plan(21);

-- S4: whole-book progression and the library state it drives
-- (docs/superpowers/specs/2026-09-16-s4-reader-completion-design.md 4.4).

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '70000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's4-reader-a@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '70000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's4-reader-b@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

-- Resolved as the connecting role: profiles RLS hides other readers' rows after a role switch.
create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = '70000000-0000-0000-0000-000000000001') as a_id,
  (select id from public.profiles where auth_user_id = '70000000-0000-0000-0000-000000000002') as b_id;
grant select on t_ids to public;

insert into public.authors (id, canonical_slug, display_name, status)
values ('71000000-0000-0000-0000-000000000001', 's4-author', 'S4 Author', 'published');

insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values ('72000000-0000-0000-0000-000000000001', 's4-book', 'vi', '71000000-0000-0000-0000-000000000001', 'published');

insert into public.book_localizations (book_id, locale, slug, title)
values ('72000000-0000-0000-0000-000000000001', 'vi', 's4-sach', 'Sách S4');

insert into public.editions (id, book_id, language_code)
values ('73000000-0000-0000-0000-000000000001', '72000000-0000-0000-0000-000000000001', 'vi');

insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
values ('74000000-0000-0000-0000-000000000001', '73000000-0000-0000-0000-000000000001', 's4/1.epub', 1, 'published');

insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status)
values ('75000000-0000-0000-0000-000000000001', '74000000-0000-0000-0000-000000000001', 1, 's4/1/manifest.json', 'published');

update public.books set active_publication_id = '75000000-0000-0000-0000-000000000001'
where id = '72000000-0000-0000-0000-000000000001';

-- Reader A owns the book and has it on their shelf. Reader B owns nothing.
-- admin_grant carries an actor and a reason, like every admin grant elsewhere in these tests.
insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason, status)
select '76000000-0000-0000-0000-000000000001', t_ids.a_id, '72000000-0000-0000-0000-000000000001', 'admin_grant', t_ids.a_id, 'Test fixture', 'active' from t_ids;
insert into public.library_items (profile_id, book_id, entitlement_id)
select t_ids.a_id, '72000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-000000000001' from t_ids;

-- Schema and privileges (1-4)
select has_column('public', 'reading_progress', 'total_progression', 'reading_progress carries whole-book progression');
select col_is_null('public', 'reading_progress', 'total_progression', 'rows written before this migration have none');
select is(has_function_privilege('anon', 'public.save_reading_progress(uuid, jsonb, numeric, numeric, text, bigint)', 'execute'), false, 'anon cannot save progress');
select is(has_table_privilege('authenticated', 'public.library_items', 'update'), false, 'readers cannot change their own library state directly');

-- A first save records both figures and moves the item to reading (5-7)
set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$ select public.save_reading_progress('75000000-0000-0000-0000-000000000001', '{"href":"c1.xhtml","progression":0.5,"totalProgression":0.1,"locations":{}}'::jsonb, 0.5, 0.1, 'device-a', 100) $$,
  'a first save is accepted'
);
reset role;

select results_eq(
  $$ select progression, total_progression from public.reading_progress rp, t_ids where rp.profile_id = t_ids.a_id $$,
  $$ values (0.5::numeric, 0.1::numeric) $$,
  'both the per-resource and whole-book figures are stored'
);
select is(
  (select l.state::text from public.library_items l, t_ids where l.profile_id = t_ids.a_id),
  'reading',
  'a partial read moves the item to reading'
);

-- Crossing 0.99 completes it (8-10).
-- `select lives_ok($$ ... $$)` rather than a bare call: save_reading_progress returns a row set, and
-- emitting it into a pgTAP file's stdout would corrupt the TAP stream. plpgsql's `perform` is not
-- available here either - this file is plain SQL run by psql, not a function body.
set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$ select public.save_reading_progress('75000000-0000-0000-0000-000000000001', '{"href":"c9.xhtml","progression":0.99,"totalProgression":0.995,"locations":{}}'::jsonb, 0.99, 0.995, 'device-a', 200) $$,
  'a save near the end of the book is accepted'
);
reset role;

select is(
  (select l.state::text from public.library_items l, t_ids where l.profile_id = t_ids.a_id),
  'completed',
  'reaching 0.99 of the whole book completes the item'
);
select is(
  (select rp.total_progression from public.reading_progress rp, t_ids where rp.profile_id = t_ids.a_id),
  0.995::numeric,
  'the whole-book figure is updated'
);

-- Paging back does not un-complete it (11-13)
set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$ select public.save_reading_progress('75000000-0000-0000-0000-000000000001', '{"href":"c2.xhtml","progression":0.2,"totalProgression":0.2,"locations":{}}'::jsonb, 0.2, 0.2, 'device-a', 300) $$,
  'paging back is accepted'
);
reset role;

select is(
  (select l.state::text from public.library_items l, t_ids where l.profile_id = t_ids.a_id),
  'completed',
  'a completed book stays completed when the reader pages back'
);
select is(
  (select rp.total_progression from public.reading_progress rp, t_ids where rp.profile_id = t_ids.a_id),
  0.2::numeric,
  'the position itself still moves back'
);

-- A refused save changes nothing (14-16). Sequence 250 is lower than the stored 300 on the same
-- device, so reconciliation refuses it - and the call still succeeds, returning the winning row.
set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$ select public.save_reading_progress('75000000-0000-0000-0000-000000000001', '{"href":"c3.xhtml","progression":0.3,"totalProgression":0.3,"locations":{}}'::jsonb, 0.3, 0.3, 'device-a', 250) $$,
  'a stale save is refused without raising'
);
reset role;

select is(
  (select rp.total_progression from public.reading_progress rp, t_ids where rp.profile_id = t_ids.a_id),
  0.2::numeric,
  'a stale save does not move the whole-book figure'
);
select is(
  (select rp.client_sequence from public.reading_progress rp, t_ids where rp.profile_id = t_ids.a_id),
  300::bigint,
  'a stale save does not win'
);

-- Null and out-of-range whole-book progression (17-18)
set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$ select public.save_reading_progress('75000000-0000-0000-0000-000000000001', '{"href":"c4.xhtml","progression":0.4,"totalProgression":null,"locations":{}}'::jsonb, 0.4, null, 'device-a', 400) $$,
  'a null whole-book progression is accepted - the engine may not report one'
);
select throws_ok(
  $$ select public.save_reading_progress('75000000-0000-0000-0000-000000000001', '{"href":"c5.xhtml","progression":0.5,"totalProgression":1.5,"locations":{}}'::jsonb, 0.5, 1.5, 'device-a', 500) $$,
  'EB009', null, 'a whole-book progression above 1 is refused'
);
reset role;

-- An unentitled reader writes nothing (19-20)
set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$ select public.save_reading_progress('75000000-0000-0000-0000-000000000001', '{"href":"c1.xhtml","progression":0.5,"totalProgression":0.5,"locations":{}}'::jsonb, 0.5, 0.5, 'device-b', 100) $$,
  'EB009', null, 'a reader without an entitlement cannot save'
);
reset role;
select is(
  (select count(*)::int from public.library_items l, t_ids where l.profile_id = t_ids.b_id),
  0,
  'a refused save creates no library row'
);

-- A reader with an entitlement but no library row is not broken by the update (21)
insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason, status)
select '76000000-0000-0000-0000-000000000002', t_ids.b_id, '72000000-0000-0000-0000-000000000001', 'admin_grant', t_ids.a_id, 'Test fixture', 'active' from t_ids;
set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000002', true);
select lives_ok(
  $$ select public.save_reading_progress('75000000-0000-0000-0000-000000000001', '{"href":"c1.xhtml","progression":0.5,"totalProgression":0.5,"locations":{}}'::jsonb, 0.5, 0.5, 'device-b', 100) $$,
  'a save succeeds even when the reader has no library row to update'
);
reset role;

select * from finish();
rollback;
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `supabase test db` (add `--workdir <scratch>` on a scratch stack)
Expected: FAIL in `020_reader_completion.sql`. The first failure is `has_column` reporting that
`reading_progress` has no `total_progression`; the calls below it then fail with
`function public.save_reading_progress(uuid, jsonb, numeric, numeric, unknown, integer) does not
exist`, because only the five-argument form is defined.

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/20260916100000_reader_completion.sql`. Copy the body of
`public.save_reading_progress` from `20260911210000_reading_progress_rpc.sql` verbatim and apply only
the marked changes:

```sql
-- S4: whole-book progression and the library state it drives
-- (docs/superpowers/specs/2026-09-16-s4-reader-completion-design.md 4.4).
--
-- Why a new column rather than redefining `progression`: `progression` is the position WITHIN the
-- current resource, which is what the locator's own `progression` field means and what every
-- existing row holds. The library rendered its percentage and its state from it, so a reader two
-- pages into a long first chapter was shown "90% - Finished". Overloading the column would have
-- left it disagreeing with locator_json.progression in the same row; a second column lets both
-- figures mean exactly one thing.
--
-- Nullable on purpose. Rows written before this migration have no whole-book figure, and
-- ReaderLocator.totalProgression is itself `number | null` - an engine need not report one.
alter table public.reading_progress
  add column total_progression numeric check (total_progression between 0 and 1);

-- The argument list changes, so `create or replace` would leave the five-argument version behind as
-- a second overload rather than replacing anything. lib/reader/progress.ts is the only caller and it
-- changes in the same pull request.
drop function public.save_reading_progress(uuid, jsonb, numeric, text, bigint);

create function public.save_reading_progress(
  p_publication_id uuid,
  p_locator jsonb,
  p_progression numeric,
  p_total_progression numeric,
  p_device_id text,
  p_client_sequence bigint
)
returns table (
  locator_json jsonb,
  progression numeric,
  total_progression numeric,
  device_id text,
  client_sequence bigint,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_book_id uuid;
  v_publication_status public.publication_status;
  v_active_publication_id uuid;
  v_book_status public.content_status;
  -- clock_timestamp(), deliberately, not now(). now() is the TRANSACTION's start time, which is
  -- the wrong clock for ordering independent writes twice over: every save inside one
  -- transaction would carry an identical timestamp, and a transaction that began early but
  -- committed late would stamp a row with a time older than writes that already landed.
  v_now timestamptz := clock_timestamp();
begin
  if p_device_id is null or length(p_device_id) = 0 or length(p_device_id) > 128 then
    raise exception 'save_reading_progress: no progress target available' using errcode = 'EB009';
  end if;

  if p_client_sequence is null or p_client_sequence < 0 then
    raise exception 'save_reading_progress: no progress target available' using errcode = 'EB009';
  end if;

  -- New in S4. Null is legal; a number outside [0, 1] is not, and takes the same single refusal
  -- code as every other unusable input. The column's own check constraint would also catch it, but
  -- as a constraint violation with Postgres text attached rather than as EB009.
  if p_total_progression is not null and (p_total_progression < 0 or p_total_progression > 1) then
    raise exception 'save_reading_progress: no progress target available' using errcode = 'EB009';
  end if;

  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'save_reading_progress: no progress target available' using errcode = 'EB009';
  end if;

  select e.book_id, pub.status
  into v_book_id, v_publication_status
  from public.ebook_publications pub
  join public.ebook_assets a on a.id = pub.ebook_asset_id
  join public.editions e on e.id = a.edition_id
  where pub.id = p_publication_id;

  if v_book_id is null then
    raise exception 'save_reading_progress: no progress target available' using errcode = 'EB009';
  end if;

  select b.active_publication_id, b.status
  into v_active_publication_id, v_book_status
  from public.books b
  where b.id = v_book_id;

  -- All three conditions, matching create_reader_session: a publication can be 'published' while
  -- the book's active pointer has moved elsewhere (a rollback), and Ruling BL makes the book's
  -- own status the condition for it being readable at all.
  if v_publication_status <> 'published'
     or v_active_publication_id is distinct from p_publication_id
     or v_book_status <> 'published' then
    raise exception 'save_reading_progress: no progress target available' using errcode = 'EB009';
  end if;

  if not exists (
    select 1 from public.entitlements en
    where en.profile_id = v_profile_id
      and en.book_id = v_book_id
      and en.status = 'active'
  ) then
    raise exception 'save_reading_progress: no progress target available' using errcode = 'EB009';
  end if;

  -- The reconciliation, atomically. Unchanged from 20260911210000 except that total_progression
  -- rides along in the same statement, so a refused save does not write it either:
  --   same device  -> strictly greater client_sequence wins;
  --   other device -> a strictly later SERVER timestamp wins.
  insert into public.reading_progress as rp
    (profile_id, publication_id, locator_json, progression, total_progression, device_id, client_sequence, updated_at)
  values
    (v_profile_id, p_publication_id, p_locator, p_progression, p_total_progression, p_device_id, p_client_sequence, v_now)
  on conflict (profile_id, publication_id) do update
    set locator_json = excluded.locator_json,
        progression = excluded.progression,
        total_progression = excluded.total_progression,
        device_id = excluded.device_id,
        client_sequence = excluded.client_sequence,
        updated_at = excluded.updated_at
    where (rp.device_id = excluded.device_id and excluded.client_sequence > rp.client_sequence)
       or (rp.device_id <> excluded.device_id and excluded.updated_at > rp.updated_at);

  -- New in S4, and gated on `found` so it happens only when the write above actually won. A
  -- refused save is a stale or replayed one; letting it move the shelf would mean a slow save from
  -- a device left on an early chapter could un-complete a finished book.
  --
  -- This is the only write to library_items.state anywhere. Browser roles have no update privilege
  -- on the table and no policy grants one, so the column is reachable only through this
  -- security-definer function. Until now nothing wrote it at all and lib/data/library.ts derived
  -- the state instead; it now reads the column's source of truth, total_progression.
  --
  -- Never downgrades from 'completed': a reader who finishes a book and then pages back to
  -- re-read a chapter has still finished it.
  if found then
    update public.library_items l
    set state = case
          when l.state = 'completed' then 'completed'
          when coalesce(p_total_progression, 0) >= 0.99 then 'completed'
          else 'reading'
        end
    where l.profile_id = v_profile_id and l.book_id = v_book_id;
  end if;

  -- Always return the EFFECTIVE row, whether or not this call is what wrote it. A refused save
  -- gets back the row that won, so the client can reconcile to the server's actual position.
  return query
    select rp.locator_json, rp.progression, rp.total_progression, rp.device_id, rp.client_sequence, rp.updated_at
    from public.reading_progress rp
    where rp.profile_id = v_profile_id
      and rp.publication_id = p_publication_id;
end;
$$;

revoke execute on function public.save_reading_progress(uuid, jsonb, numeric, numeric, text, bigint)
  from public, anon;
grant execute on function public.save_reading_progress(uuid, jsonb, numeric, numeric, text, bigint)
  to authenticated;
```

- [ ] **Step 5: Update the existing pgTAP file for the new signature**

Every `public.save_reading_progress(...)` call in `supabase/tests/010_reading_progress.sql` gains a
fourth argument. Pass the same value as `p_progression` so the reconciliation cases are unchanged in
meaning:

```sql
-- before: public.save_reading_progress('...'::uuid, '{...}'::jsonb, 0.25, 'device-1', 10)
-- after:  public.save_reading_progress('...'::uuid, '{...}'::jsonb, 0.25, 0.25, 'device-1', 10)
```

Any `results_eq` in that file that selects the function's whole row must also account for the new
`total_progression` column in the returned table. Do not change any expected reconciliation outcome —
if one changes, the migration is wrong, not the test.

- [ ] **Step 6: Apply and run the tests**

Run: `supabase db reset && supabase test db`
Expected: PASS, including `020_reader_completion.sql` (21 tests) and `010_reading_progress.sql`
unchanged in its outcomes.

- [ ] **Step 7: Regenerate types**

Run: `supabase gen types --local --lang typescript > lib/supabase/database.types.ts`
Expected: `reading_progress` gains `total_progression: number | null`, and
`save_reading_progress`'s `Args` gains `p_total_progression: number`.

Note: `npm run check` will now FAIL on `lib/reader/progress.ts`, because it calls the RPC without the
new argument. That is expected and Task 2 fixes it — do not patch it here.

**This task is therefore the one exception to the "run `npm run check` at the end of every task"
global constraint.** Its gate is `supabase test db`, not `npm run check`. Tasks 1 and 2 are one
migration split across two commits for reviewability; the tree is green again at the end of Task 2,
and no task after that may leave it red.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260916100000_reader_completion.sql supabase/tests/020_reader_completion.sql supabase/tests/010_reading_progress.sql lib/supabase/database.types.ts
git commit -m "feat(db): store whole-book progression and complete library items"
```

---

### Task 2: The application reads whole-book progression

**Files:**
- Modify: `lib/reader/progress.ts`
- Modify: `lib/reader/progress.test.ts`
- Modify: `lib/data/library.ts`
- Modify: `lib/data/library.test.ts`

**Interfaces:**
- Consumes: `save_reading_progress` (six arguments, from Task 1); `parseReaderLocator` from `lib/reader/engine.ts`, which already clamps `totalProgression` into `[0, 1]` or leaves it `null`.
- Produces:
  - `ReadingProgressDTO` gains `totalProgression: number | null`.
  - `deriveLibraryState(totalProgression: number | null | undefined): LibraryState` — **signature change**: it now takes one argument, the whole-book progression, and no longer takes `progressPercent`.
  - `LibraryItemDTO.progressPercent` is computed from `total_progression`, falling back to `progression`.

- [ ] **Step 1: Write the failing tests**

Add to `lib/reader/progress.test.ts`, inside the existing `saveProgress` describe block:

```ts
it("forwards the locator's whole-book progression to the RPC", async () => {
  const rpc = vi.fn().mockResolvedValue({
    data: [
      {
        locator_json: { href: "c1.xhtml", progression: 0.5, totalProgression: 0.25, locations: {} },
        progression: 0.5,
        total_progression: 0.25,
        device_id: "device-1",
        client_sequence: 7,
        updated_at: "2026-09-16T00:00:00.000Z",
      },
    ],
    error: null,
  });
  mockClient({ rpc });

  const result = await saveProgress({
    publicationId: "11111111-1111-4111-8111-111111111111",
    locator: { href: "c1.xhtml", progression: 0.5, totalProgression: 0.25, locations: {} },
    deviceId: "device-1",
    clientSequence: 7,
  });

  expect(rpc).toHaveBeenCalledWith(
    "save_reading_progress",
    expect.objectContaining({ p_progression: 0.5, p_total_progression: 0.25 }),
  );
  expect(result.totalProgression).toBe(0.25);
});

it("sends null when the engine reports no whole-book progression", async () => {
  const rpc = vi.fn().mockResolvedValue({
    data: [
      {
        locator_json: { href: "c1.xhtml", progression: 0.5, totalProgression: null, locations: {} },
        progression: 0.5,
        total_progression: null,
        device_id: "device-1",
        client_sequence: 7,
        updated_at: "2026-09-16T00:00:00.000Z",
      },
    ],
    error: null,
  });
  mockClient({ rpc });

  const result = await saveProgress({
    publicationId: "11111111-1111-4111-8111-111111111111",
    locator: { href: "c1.xhtml", progression: 0.5, totalProgression: null, locations: {} },
    deviceId: "device-1",
    clientSequence: 7,
  });

  expect(rpc).toHaveBeenCalledWith(
    "save_reading_progress",
    expect.objectContaining({ p_total_progression: null }),
  );
  expect(result.totalProgression).toBeNull();
});
```

Use whatever client-mocking helper the file already defines — read the top of
`lib/reader/progress.test.ts` first and follow its existing pattern rather than introducing
`mockClient` if it is spelled differently there.

Replace the `deriveLibraryState` tests in `lib/data/library.test.ts` with:

```ts
describe("deriveLibraryState", () => {
  it("reads a book with no progress row as unread", () => {
    expect(deriveLibraryState(null)).toBe("unread");
    expect(deriveLibraryState(undefined)).toBe("unread");
  });

  it("reads partial whole-book progress as reading", () => {
    expect(deriveLibraryState(0)).toBe("reading");
    expect(deriveLibraryState(0.5)).toBe("reading");
  });

  // The threshold matches save_reading_progress exactly. If the two ever disagree, a reader sees
  // "Finished" on one surface and "In progress" on the other for the same book.
  it("reads 0.99 and above as completed", () => {
    expect(deriveLibraryState(0.99)).toBe("completed");
    expect(deriveLibraryState(1)).toBe("completed");
  });

  it("stops just short of completing at 0.98", () => {
    expect(deriveLibraryState(0.98)).toBe("reading");
  });

  it("ignores a value that is not a finite number", () => {
    expect(deriveLibraryState(Number.NaN)).toBe("unread");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/reader/progress.test.ts lib/data/library.test.ts`
Expected: FAIL — `p_total_progression` is not passed, and `deriveLibraryState` still expects two
arguments.

- [ ] **Step 3: Forward the whole-book progression**

In `lib/reader/progress.ts`, add the field to the DTO:

```ts
export type ReadingProgressDTO = {
  locator: ReaderLocator;
  // Whole-book progression, 0-1, or null when the engine does not report one. Stored in its own
  // column since S4: `progression` below is the position within the current resource, and the
  // library needs the other figure to say how far through the book a reader is.
  totalProgression: number | null;
  deviceId: string;
  clientSequence: number;
  updatedAt: string;
};
```

Add it to `ProgressRow`:

```ts
type ProgressRow = {
  locator_json: unknown;
  progression: number;
  total_progression: number | null;
  device_id: string;
  client_sequence: number | string;
  updated_at: string;
};
```

Pass it to the RPC — it needs no validation of its own, because `parseReaderLocator` has already
clamped it into `[0, 1]` or left it `null`:

```ts
  const { data, error } = await supabase.rpc("save_reading_progress", {
    p_publication_id: input.publicationId,
    p_locator: locator,
    p_progression: locator.progression,
    // Already validated and clamped by parseReaderLocator above, like p_progression. Note that
    // this needs no change to the request body or the route: totalProgression is a field of
    // ReaderLocator, so it has been arriving in every progress request and being stored inside
    // locator_json all along - it was simply thrown away at the RPC boundary.
    p_total_progression: locator.totalProgression,
    p_device_id: input.deviceId,
    p_client_sequence: input.clientSequence,
  });
```

And return it:

```ts
  return {
    locator: parseReaderLocator(row.locator_json),
    totalProgression: row.total_progression,
    deviceId: row.device_id,
    clientSequence: Number(row.client_sequence),
    updatedAt: row.updated_at,
  };
```

- [ ] **Step 4: Read the stored figure in the library**

In `lib/data/library.ts`, replace `deriveLibraryState` and its comment:

```ts
// Ruling CQ, revisited by S4. This used to be derived from the rendered percentage because nothing
// in the application ever wrote `library_items.state`. Since migration 20260916100000,
// save_reading_progress writes it on every winning save, and both surfaces read the same figure:
// reading_progress.total_progression, the reader's position in the WHOLE BOOK.
//
// The 0.99 threshold is duplicated in SQL inside save_reading_progress. That duplication is
// deliberate and is the same arrangement reconcileProgress has with its RPC: SQL cannot call into
// TypeScript, so the rule is stated in both places and supabase/tests/020_reader_completion.sql is
// what proves they agree.
export function deriveLibraryState(totalProgression: number | null | undefined): LibraryState {
  // No progress row at all - the reader has never opened this book.
  if (typeof totalProgression !== "number" || !Number.isFinite(totalProgression)) return "unread";
  return totalProgression >= 0.99 ? "completed" : "reading";
}
```

Select the new column, keeping the fallback for rows written before the migration:

```ts
      ? supabase
          .from("reading_progress")
          .select("publication_id, progression, total_progression")
          .in("publication_id", publicationIds)
```

```ts
  // total_progression is null for rows written before migration 20260916100000. Falling back to
  // `progression` keeps a reader's existing card roughly where it was rather than resetting it to
  // zero; the value corrects itself on their next save.
  const progressByPublication = new Map(
    (
      (progressRows.data ?? []) as {
        publication_id: string;
        progression: number;
        total_progression: number | null;
      }[]
    ).map((row) => [row.publication_id, row.total_progression ?? row.progression]),
  );
```

And in the `flatMap`, rename the local for accuracy and drop the second argument:

```ts
    const totalProgression = activePublicationId
      ? progressByPublication.get(activePublicationId)
      : undefined;
    const progressPercent = toProgressPercent(totalProgression);

    return [
      {
        bookId: row.book_id,
        title: localization.title,
        slug: localization.slug,
        coverAltText: coverByBook.get(row.book_id) ?? null,
        state: deriveLibraryState(totalProgression),
        progressPercent,
        continueReadingUrl: withLocale(locale, `/read/${row.book_id}`),
      },
    ];
```

Also update `LibraryItemDTO.progressPercent`'s comment to say the figure is whole-book progression.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/reader/progress.test.ts lib/data/library.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the checks and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add lib/reader/progress.ts lib/reader/progress.test.ts lib/data/library.ts lib/data/library.test.ts
git commit -m "feat(reader): persist whole-book progression and read it in the library"
```

---

### Task 3: Reader preferences

**Files:**
- Modify: `lib/reader/types.ts`
- Modify: `lib/reader/readium-engine.ts` (`toEpubPreferences` ignores `width`)
- Modify: `lib/reader/readium-engine.test.ts`
- Create: `lib/reader/preferences.ts`
- Create: `lib/reader/preferences.test.ts`

**Interfaces:**
- Consumes: `ReaderPreferences`.
- Produces:
  - `ReaderPreferences` gains `width: "narrow" | "medium" | "wide"`.
  - `DEFAULT_READER_PREFERENCES: ReaderPreferences`
  - `READER_BASE_FONT_PX = 16`, `READER_MIN_FONT_PX = 15`, `READER_MAX_FONT_PX = 26`
  - `READER_LINE_HEIGHTS = [1.5, 1.75, 2] as const`
  - `fontScaleToPx(scale: number): number`, `pxToFontScale(px: number): number`
  - `parseReaderPreferences(value: unknown): ReaderPreferences` — never throws; falls back per field
  - `loadReaderPreferences(): ReaderPreferences`, `saveReaderPreferences(preferences: ReaderPreferences): void` — both safe when storage is unavailable
  - `READER_WIDTH_CLASS: Record<ReaderPreferences["width"], string>`

- [ ] **Step 1: Write the failing test**

Create `lib/reader/preferences.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_READER_PREFERENCES,
  READER_MAX_FONT_PX,
  READER_MIN_FONT_PX,
  fontScaleToPx,
  loadReaderPreferences,
  parseReaderPreferences,
  pxToFontScale,
  saveReaderPreferences,
} from "@/lib/reader/preferences";

const STORAGE_KEY = "infinity-books.reader.preferences";

describe("font size mapping", () => {
  it("round-trips every offered size", () => {
    for (let px = READER_MIN_FONT_PX; px <= READER_MAX_FONT_PX; px += 1) {
      expect(fontScaleToPx(pxToFontScale(px))).toBe(px);
    }
  });

  it("clamps a scale from outside the offered range back into it", () => {
    expect(fontScaleToPx(0.1)).toBe(READER_MIN_FONT_PX);
    expect(fontScaleToPx(10)).toBe(READER_MAX_FONT_PX);
  });
});

describe("parseReaderPreferences", () => {
  it("returns the defaults for a value that is not an object", () => {
    expect(parseReaderPreferences(null)).toEqual(DEFAULT_READER_PREFERENCES);
    expect(parseReaderPreferences("nonsense")).toEqual(DEFAULT_READER_PREFERENCES);
  });

  // Per field, not all-or-nothing: a reader who has set a theme should not lose it because a later
  // version of the panel wrote a field this build does not understand.
  it("keeps the fields it understands and defaults the rest", () => {
    expect(parseReaderPreferences({ theme: "dark", fontFamily: "moon", width: "wide" })).toEqual({
      ...DEFAULT_READER_PREFERENCES,
      theme: "dark",
      width: "wide",
    });
  });

  it("refuses a font scale outside the offered range", () => {
    expect(parseReaderPreferences({ fontScale: 99 }).fontScale).toBe(DEFAULT_READER_PREFERENCES.fontScale);
  });

  it("refuses a line height that is not one of the offered values", () => {
    expect(parseReaderPreferences({ lineHeight: 3.9 }).lineHeight).toBe(DEFAULT_READER_PREFERENCES.lineHeight);
    expect(parseReaderPreferences({ lineHeight: 2 }).lineHeight).toBe(2);
  });
});

describe("storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips through localStorage", () => {
    const preferences = { ...DEFAULT_READER_PREFERENCES, theme: "dark" as const, width: "narrow" as const };
    saveReaderPreferences(preferences);
    expect(loadReaderPreferences()).toEqual(preferences);
  });

  it("returns the defaults when nothing is stored", () => {
    expect(loadReaderPreferences()).toEqual(DEFAULT_READER_PREFERENCES);
  });

  it("returns the defaults for a corrupt stored value", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadReaderPreferences()).toEqual(DEFAULT_READER_PREFERENCES);
  });

  // Private mode, blocked site data, and some embedded browsers throw on access rather than
  // returning null. A reader must still get their book.
  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(loadReaderPreferences()).toEqual(DEFAULT_READER_PREFERENCES);
    expect(() => saveReaderPreferences(DEFAULT_READER_PREFERENCES)).not.toThrow();

    vi.restoreAllMocks();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/reader/preferences.test.ts`
Expected: FAIL — `Cannot find module '@/lib/reader/preferences'`.

- [ ] **Step 3: Add `width` to the preference type**

In `lib/reader/types.ts`:

```ts
export type ReaderPreferences = {
  fontFamily: "publisher" | "serif" | "sans";
  // A multiplier, not a pixel size: this is what a reflowable engine's own font-size preference
  // takes. lib/reader/preferences.ts maps the 15-26px the settings panel offers onto it.
  fontScale: number;
  lineHeight: number;
  // The reading column's width. Deliberately NOT passed to the engine: column width is a property
  // of the container the engine renders into, not of the engine, so the component applies it as a
  // max-width and toEpubPreferences ignores it. The consequence is that changing it resizes the
  // engine's host element and the engine re-paginates - a position-affecting change exactly like a
  // font-size change, and covered by the same locator-restore test.
  width: "narrow" | "medium" | "wide";
  // The stored key is `sepia`; the settings panel labels it "Paper". The label lives in the
  // dictionary, which is where a label belongs - renaming the key would change THEMES,
  // toEpubPreferences and their tests for a word on a button.
  theme: "light" | "sepia" | "dark";
};
```

- [ ] **Step 4: Write the preferences module**

Create `lib/reader/preferences.ts`:

```ts
import type { ReaderPreferences } from "@/lib/reader/types";

// Per-device reading preferences. They never reach the server: they are a property of the screen
// someone is reading on, not of their account, and syncing them would mean a phone's font size
// following them onto a desktop. No `server-only` import here - this module is for the client.

const STORAGE_KEY = "infinity-books.reader.preferences";

// The settings panel offers pixel sizes because that is what a reader understands; the engine takes
// a multiplier. 16px is the browser default body size and therefore the multiplier's 1.0 point.
export const READER_BASE_FONT_PX = 16;
export const READER_MIN_FONT_PX = 15;
export const READER_MAX_FONT_PX = 26;
export const READER_LINE_HEIGHTS = [1.5, 1.75, 2] as const;
export const READER_WIDTHS = ["narrow", "medium", "wide"] as const;
export const READER_FONT_FAMILIES = ["publisher", "serif", "sans"] as const;
export const READER_THEMES = ["light", "sepia", "dark"] as const;

// `medium` is 50rem, which is the fixed column width the reader used before S4, so a reader who
// never opens the panel sees exactly what they saw before.
export const READER_WIDTH_CLASS: Record<ReaderPreferences["width"], string> = {
  narrow: "max-w-[34rem]",
  medium: "max-w-[50rem]",
  wide: "max-w-[64rem]",
};

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  fontFamily: "publisher",
  fontScale: 1,
  lineHeight: 1.5,
  width: "medium",
  theme: "light",
};

export function fontScaleToPx(scale: number): number {
  const px = Math.round(scale * READER_BASE_FONT_PX);
  return Math.min(READER_MAX_FONT_PX, Math.max(READER_MIN_FONT_PX, px));
}

export function pxToFontScale(px: number): number {
  const clamped = Math.min(READER_MAX_FONT_PX, Math.max(READER_MIN_FONT_PX, Math.round(px)));
  return clamped / READER_BASE_FONT_PX;
}

function oneOf<T extends string>(options: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (options as readonly string[]).includes(value) ? (value as T) : fallback;
}

// Never throws, and falls back PER FIELD rather than all-or-nothing. A reader whose stored
// preferences were written by a different build - or corrupted - keeps whatever is still valid
// instead of having the whole set reset. Nothing here is authorization; the worst a hostile value
// can do is be ignored.
export function parseReaderPreferences(value: unknown): ReaderPreferences {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_READER_PREFERENCES };
  const candidate = value as Record<string, unknown>;

  const scale = candidate.fontScale;
  const scaleIsOffered =
    typeof scale === "number" &&
    Number.isFinite(scale) &&
    fontScaleToPx(scale) === Math.round(scale * READER_BASE_FONT_PX);

  const lineHeight = candidate.lineHeight;

  return {
    fontFamily: oneOf(READER_FONT_FAMILIES, candidate.fontFamily, DEFAULT_READER_PREFERENCES.fontFamily),
    fontScale: scaleIsOffered ? scale : DEFAULT_READER_PREFERENCES.fontScale,
    lineHeight:
      typeof lineHeight === "number" && (READER_LINE_HEIGHTS as readonly number[]).includes(lineHeight)
        ? lineHeight
        : DEFAULT_READER_PREFERENCES.lineHeight,
    width: oneOf(READER_WIDTHS, candidate.width, DEFAULT_READER_PREFERENCES.width),
    theme: oneOf(READER_THEMES, candidate.theme, DEFAULT_READER_PREFERENCES.theme),
  };
}

// Both halves are wrapped, like resolveDeviceId in reader-client.tsx: private mode, blocked site
// data, and some embedded browsers throw on access rather than returning null, and losing a font
// size must never cost someone their book.
export function loadReaderPreferences(): ReaderPreferences {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return { ...DEFAULT_READER_PREFERENCES };
    return parseReaderPreferences(JSON.parse(stored));
  } catch {
    return { ...DEFAULT_READER_PREFERENCES };
  }
}

export function saveReaderPreferences(preferences: ReaderPreferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // A reader whose browser refuses storage still gets the preference for this session; it simply
    // does not survive a reload. Nothing else depends on this succeeding.
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run lib/reader/preferences.test.ts`
Expected: PASS.

- [ ] **Step 6: Pin that the engine ignores `width`**

Add to the `setPreferences` describe block in `lib/reader/readium-engine.test.ts`:

```ts
it("does not pass the reading-column width to the engine", async () => {
  const { engine, navigator } = await mountedEngine();

  await engine.setPreferences({
    fontFamily: "publisher",
    fontScale: 1,
    lineHeight: 1.5,
    width: "wide",
    theme: "light",
  });

  // Column width is a property of the container the engine renders into, not of the engine. The
  // component applies it as a max-width; if it ever leaks in here, the adapter has taken on a
  // layout concern that the second engine behind this boundary would have to reimplement.
  expect(navigator.submitPreferences).toHaveBeenCalledWith(
    expect.not.objectContaining({ width: expect.anything() }),
  );
});
```

Use the file's own existing helper for mounting a stubbed engine rather than `mountedEngine()` if it
is named differently — read the top of the file first.

Every other `setPreferences` call in that file, and any `ReaderPreferences` literal anywhere in the
repo, now needs a `width` field. `npm run check` will name each one.

- [ ] **Step 7: Run the checks and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add lib/reader/types.ts lib/reader/preferences.ts lib/reader/preferences.test.ts lib/reader/readium-engine.ts lib/reader/readium-engine.test.ts
git commit -m "feat(reader): add reading-column width and per-device preferences"
```

---

### Task 4: The table of contents crosses the engine boundary

**Files:**
- Modify: `lib/reader/types.ts`
- Modify: `lib/reader/engine.ts`
- Modify: `lib/reader/readium-engine.ts`
- Modify: `lib/reader/readium-engine.test.ts`
- Create: `lib/reader/toc.ts`
- Create: `lib/reader/toc.test.ts`

**Interfaces:**
- Consumes: the manifest's `toc`, whose hrefs are already rewritten to Route Handler URLs by `rewriteTocHrefs` / `filterTocToServable` in `lib/reader/session.ts`, so they live in the same space as `ReaderLocator.href`.
- Produces:
  - `ReaderTocEntry = { title: string; href: string; children: ReaderTocEntry[] }`
  - `ReaderEngine.getTableOfContents(): Promise<ReaderTocEntry[]>`
  - `flattenToc(entries: ReaderTocEntry[]): { title: string; href: string; depth: number }[]`
  - `chapterTitleFor(entries: ReaderTocEntry[], href: string | null | undefined): string | null`

- [ ] **Step 1: Write the failing test**

Create `lib/reader/toc.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { chapterTitleFor, flattenToc } from "@/lib/reader/toc";
import type { ReaderTocEntry } from "@/lib/reader/types";

// Hrefs as the manifest actually carries them: already rewritten to Route Handler URLs, and often
// carrying a fragment that points within a document rather than at a different one.
const toc: ReaderTocEntry[] = [
  { title: "Cover", href: "/api/reader/publications/p1/resources/cover.xhtml", children: [] },
  {
    title: "Part One",
    href: "/api/reader/publications/p1/resources/c1.xhtml",
    children: [
      { title: "A Beginning", href: "/api/reader/publications/p1/resources/c1.xhtml#start", children: [] },
      { title: "An Ending", href: "/api/reader/publications/p1/resources/c2.xhtml", children: [] },
    ],
  },
];

describe("flattenToc", () => {
  it("lists every entry in reading order with its depth", () => {
    expect(flattenToc(toc)).toEqual([
      { title: "Cover", href: "/api/reader/publications/p1/resources/cover.xhtml", depth: 0 },
      { title: "Part One", href: "/api/reader/publications/p1/resources/c1.xhtml", depth: 0 },
      { title: "A Beginning", href: "/api/reader/publications/p1/resources/c1.xhtml#start", depth: 1 },
      { title: "An Ending", href: "/api/reader/publications/p1/resources/c2.xhtml", depth: 1 },
    ]);
  });

  it("returns nothing for an empty table of contents", () => {
    expect(flattenToc([])).toEqual([]);
  });
});

describe("chapterTitleFor", () => {
  it("names the entry whose document the reader is in", () => {
    expect(chapterTitleFor(toc, "/api/reader/publications/p1/resources/c2.xhtml")).toBe("An Ending");
  });

  // The deepest match wins. Both "Part One" and "A Beginning" point at c1.xhtml, and the nested
  // entry is the more precise answer to "where am I".
  it("prefers a nested entry over its ancestor", () => {
    expect(chapterTitleFor(toc, "/api/reader/publications/p1/resources/c1.xhtml")).toBe("A Beginning");
  });

  // A locator carries its own fragment, and TOC hrefs routinely carry one too. Comparing whole
  // strings would match almost nothing in a real publication's nav.
  it("ignores fragments on both sides", () => {
    expect(chapterTitleFor(toc, "/api/reader/publications/p1/resources/c2.xhtml#para-4")).toBe("An Ending");
  });

  // Front matter absent from the nav is common. No title is better than a wrong one.
  it("returns null when the reader is in a document the nav does not name", () => {
    expect(chapterTitleFor(toc, "/api/reader/publications/p1/resources/colophon.xhtml")).toBeNull();
  });

  it("returns null without a locator", () => {
    expect(chapterTitleFor(toc, null)).toBeNull();
    expect(chapterTitleFor([], "/api/reader/publications/p1/resources/c1.xhtml")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/reader/toc.test.ts`
Expected: FAIL — `Cannot find module '@/lib/reader/toc'`.

- [ ] **Step 3: Add the neutral type and the boundary member**

In `lib/reader/types.ts`:

```ts
// One node of a publication's table of contents, in the engine-neutral vocabulary. Every reflowable
// EPUB engine already has this tree: Readium exposes it as `publication.toc` (a `Links` whose items
// carry `title`, `href` and `children`), and epub.js - ADR-005's deferred fallback - exposes
// `book.navigation.toc` with the same three fields. So this is a shared abstraction rather than a
// Readium shape wearing a different name.
//
// `href` is the href as the served manifest carries it, which is a Route Handler URL, not an
// in-publication path. That is the same space ReaderLocator.href lives in, which is what lets
// lib/reader/toc.ts match the two by plain comparison.
export type ReaderTocEntry = {
  title: string;
  href: string;
  children: ReaderTocEntry[];
};
```

In `lib/reader/engine.ts`, add to the interface, after `getNavigationState`:

```ts
  // The publication's table of contents, for a navigation drawer. Read from the manifest the
  // adapter already fetched during mount() - the component never fetches the manifest itself,
  // which would mean parsing a delivery format the adapter owns, twice per open.
  //
  // Returns [] for a publication whose manifest carries no toc, which is legal: the sample manifest
  // filters its toc to the servable set and a sample of a single resource can filter down to
  // nothing.
  getTableOfContents(): Promise<ReaderTocEntry[]>;
```

Import `ReaderTocEntry` alongside the existing type imports in that file.

- [ ] **Step 4: Write the matching helpers**

Create `lib/reader/toc.ts`:

```ts
import type { ReaderTocEntry } from "@/lib/reader/types";

// Matching a reader's position to a chapter title. Pure, and deliberately not in the adapter: this
// is a question about our own manifest's toc and our own locator, and every engine behind the
// boundary would answer it identically.

export type FlatTocEntry = { title: string; href: string; depth: number };

export function flattenToc(entries: ReaderTocEntry[], depth = 0): FlatTocEntry[] {
  return entries.flatMap((entry) => [
    { title: entry.title, href: entry.href, depth },
    ...flattenToc(entry.children, depth + 1),
  ]);
}

// A toc href routinely points WITHIN a document (`chapter1.xhtml#section-2`) rather than at a
// different one, and a locator carries whatever fragment the engine reported. Membership is
// therefore tested on the path alone - the same rule splitTocFragment applies server-side in
// lib/reader/session.ts. Comparing whole strings would drop every fragment-bearing entry, which for
// a real EPUB nav is most of them.
function pathOf(href: string): string {
  const hash = href.indexOf("#");
  return hash === -1 ? href : href.slice(0, hash);
}

// The DEEPEST matching entry wins, which is why this scans to the end rather than returning on the
// first hit: a part and its opening chapter commonly name the same document, and the chapter is the
// more precise answer to "where am I". flattenToc emits parents before children, so the last match
// is the deepest one.
//
// Returns null rather than guessing when the reader is in a document the nav does not name - a
// cover, a colophon, or front matter. No chapter title is better than a wrong one.
export function chapterTitleFor(entries: ReaderTocEntry[], href: string | null | undefined): string | null {
  if (!href) return null;
  const target = pathOf(href);

  let match: string | null = null;
  for (const entry of flattenToc(entries)) {
    if (pathOf(entry.href) === target) match = entry.title;
  }
  return match;
}
```

- [ ] **Step 5: Implement it in the adapter**

In `lib/reader/readium-engine.ts`, add beside the other mapping helpers:

```ts
// Readium's `Links` is an object with an `items` array; each `Link` carries `href`, an optional
// `title`, and optional `children` (another `Links`). Mapped to the neutral tree here so no Readium
// type crosses the boundary.
//
// An untitled link is dropped rather than rendered as a blank row: a nav entry with no label is not
// something a reader can navigate by, and keeping it would put empty buttons in the drawer.
function toReaderTocEntries(links: { items: ReadonlyArray<Link> } | undefined): ReaderTocEntry[] {
  return (links?.items ?? []).flatMap((link) =>
    link.title
      ? [{ title: link.title, href: link.href, children: toReaderTocEntries(link.children) }]
      : toReaderTocEntries(link.children),
  );
}
```

`Link` is already imported as a type in this file; if it is not, add it to the existing type-only
import from `@readium/shared`. Then add the method to the returned object, next to
`getNavigationState`:

```ts
    async getTableOfContents() {
      // Read off the publication the adapter built during mount() - not a second fetch. `active()`
      // is called for its mounted-state check so this throws the same "not mounted" error as every
      // other member rather than quietly answering [].
      active();
      return toReaderTocEntries(publication?.toc);
    },
```

- [ ] **Step 6: Test the adapter mapping**

Add to `lib/reader/readium-engine.test.ts`, following the file's existing mounting helper:

```ts
describe("getTableOfContents", () => {
  it("maps the publication's toc into the neutral tree", async () => {
    const { engine } = await mountedEngine({
      toc: {
        items: [
          {
            href: "/api/reader/publications/p1/resources/c1.xhtml",
            title: "Part One",
            children: {
              items: [
                { href: "/api/reader/publications/p1/resources/c1.xhtml#a", title: "A Beginning", children: undefined },
              ],
            },
          },
        ],
      },
    });

    await expect(engine.getTableOfContents()).resolves.toEqual([
      {
        title: "Part One",
        href: "/api/reader/publications/p1/resources/c1.xhtml",
        children: [
          { title: "A Beginning", href: "/api/reader/publications/p1/resources/c1.xhtml#a", children: [] },
        ],
      },
    ]);
  });

  it("returns nothing for a publication with no toc", async () => {
    const { engine } = await mountedEngine();
    await expect(engine.getTableOfContents()).resolves.toEqual([]);
  });

  it("refuses before the engine is mounted", async () => {
    await expect(createReadiumEngine().getTableOfContents()).rejects.toThrow("The reader engine is not mounted.");
  });
});
```

The file's mounting helper builds a manifest and deserializes it; extend it so a caller can supply a
`toc`, or build the manifest inline in these tests in the same shape the helper uses. Read the
helper first and follow whichever is less invasive.

- [ ] **Step 7: Run the tests and commit**

Run: `npx vitest run lib/reader/toc.test.ts lib/reader/readium-engine.test.ts && npm run check`
Expected: PASS, including the existing "registers no navigator listeners" test.

```bash
git add lib/reader/types.ts lib/reader/engine.ts lib/reader/readium-engine.ts lib/reader/readium-engine.test.ts lib/reader/toc.ts lib/reader/toc.test.ts
git commit -m "feat(reader): expose the table of contents through the engine boundary"
```

---

### Task 5: The dialog primitive and the reader's copy

**Files:**
- Create: `components/ui/dialog.tsx`
- Create: `components/ui/dialog.test.tsx`
- Modify: `lib/i18n/dictionaries/en.json`
- Modify: `lib/i18n/dictionaries/vi.json`

**Interfaces:**
- Consumes: `@base-ui/react/dialog` (`Root`, `Trigger`, `Portal`, `Backdrop`, `Popup`, `Title`, `Close`), `cn` from `"cn"`, `lucide-react` icons.
- Produces:
  - `Dialog`, `DialogTrigger`, `DialogPortal`, `DialogClose`, `DialogTitle`, and `DialogPanel` (backdrop + popup together, with `side?: "right" | "bottom"`).
  - `Dictionary["reader"]` gains: `settings`, `settingsTitle`, `fontSize`, `decreaseFontSize`, `increaseFontSize`, `font`, `fonts.{publisher,serif,sans}`, `lineHeight`, `lineHeights.{tight,normal,loose}`, `width`, `widths.{narrow,medium,wide}`, `theme`, `themes.{light,sepia,dark}`, `contents`, `contentsTitle`, `contentsEmpty`, `close`, `lostAccessSignedOut`, `lostAccessRevoked`, `signIn`, `goToLibrary`, `finishedTitle`, `finishedBody`, `dismiss`, `sampleEndTitle`, `sampleEndBody`, `backToBook`.

- [ ] **Step 1: Write the failing test**

Create `components/ui/dialog.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Dialog, DialogClose, DialogPanel, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

function Example() {
  return (
    <Dialog>
      <DialogTrigger>Open</DialogTrigger>
      <DialogPanel side="right">
        <DialogTitle>Settings</DialogTitle>
        <button type="button">Inside</button>
        <DialogClose>Close</DialogClose>
      </DialogPanel>
    </Dialog>
  );
}

describe("Dialog", () => {
  it("opens from its trigger and names itself", async () => {
    const user = userEvent.setup();
    render(<Example />);

    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open" }));

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  // The whole reason a primitive exists rather than two hand-rolled panels: Escape, focus return
  // and the ARIA wiring are implemented once.
  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Example />);

    const trigger = screen.getByRole("button", { name: "Open" });
    await user.click(trigger);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("closes from its close button", async () => {
    const user = userEvent.setup();
    render(<Example />);

    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run components/ui/dialog.test.tsx`
Expected: FAIL — `Cannot find module '@/components/ui/dialog'`.

If `@testing-library/user-event` is not already a dependency, install it:
`npm install --save-dev @testing-library/user-event`.

- [ ] **Step 3: Write the primitive**

Create `components/ui/dialog.tsx`, in the same shadcn and base-ui style as
`components/ui/select.tsx` (note that file's `import { cn } from "cn"`):

```tsx
"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { cn } from "cn"
import { XIcon } from "lucide-react"

// The first overlay primitive in this repo beyond `select`. It exists because the reader's settings
// panel and table-of-contents drawer both need one, and hand-rolling focus trapping, Escape, scroll
// locking and aria-modal twice is how one of the two ends up subtly wrong.
//
// Tokens: `--shadow-drawer` and `--ease-quiet` were defined on the design boards for exactly this
// surface and are used here rather than an ad-hoc shadow.

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("font-serif text-lg font-normal text-ink", className)}
      {...props}
    />
  )
}

function DialogClose({ className, ...props }: DialogPrimitive.Close.Props) {
  return (
    <DialogPrimitive.Close
      data-slot="dialog-close"
      className={cn(
        "inline-flex min-h-11 items-center justify-center rounded-md px-3 text-sm text-ink outline-none transition-colors duration-150 ease-quiet hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest",
        className
      )}
      {...props}
    />
  )
}

// Backdrop and popup together, because a caller has no reason to want one without the other.
// `side` is the only thing the reader's two panels differ on: the drawer comes from the right on a
// wide screen, and both become a bottom sheet under 640px, which is what keeps every control inside
// thumb reach at 390px.
function DialogPanel({
  className,
  children,
  side = "right",
  ...props
}: DialogPrimitive.Popup.Props & { side?: "right" | "bottom" }) {
  return (
    <DialogPortal>
      <DialogPrimitive.Backdrop
        data-slot="dialog-backdrop"
        className="fixed inset-0 z-40 bg-ink/20 transition-opacity duration-200 ease-quiet data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"
      />
      <DialogPrimitive.Popup
        data-slot="dialog-panel"
        data-side={side}
        className={cn(
          "fixed z-50 flex flex-col gap-5 overflow-y-auto bg-white p-5 text-ink shadow-drawer outline-none transition-transform duration-200 ease-quiet",
          // Bottom sheet on a phone, whichever side was asked for.
          "inset-x-0 bottom-0 max-h-[80dvh] rounded-t-lg data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full",
          side === "right" &&
            "sm:inset-y-0 sm:right-0 sm:left-auto sm:max-h-none sm:w-[22rem] sm:rounded-none sm:data-[ending-style]:translate-x-full sm:data-[ending-style]:translate-y-0 sm:data-[starting-style]:translate-x-full sm:data-[starting-style]:translate-y-0",
          className
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

export { Dialog, DialogClose, DialogPanel, DialogPortal, DialogTitle, DialogTrigger, XIcon }
```

Remove the `XIcon` re-export if the panels end up importing it from `lucide-react` directly; it is
listed here only so the close control has an icon available without a second import style.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run components/ui/dialog.test.tsx`
Expected: PASS.

If base-ui's popup animation attributes differ from the `data-[starting-style]` / `data-[ending-style]`
names used above, read `components/ui/select.tsx`'s own popup classes and copy whatever that file
uses — it is already working against this version of the library.

- [ ] **Step 5: Add the reader's copy**

Add to `lib/i18n/dictionaries/en.json`, inside the existing `"reader"` object:

```json
    "settings": "Reading settings",
    "settingsTitle": "Reading settings",
    "fontSize": "Font size",
    "decreaseFontSize": "Smaller text",
    "increaseFontSize": "Larger text",
    "font": "Font",
    "fonts": { "publisher": "Publisher", "serif": "Lora", "sans": "Sans" },
    "lineHeight": "Line spacing",
    "lineHeights": { "tight": "Tight", "normal": "Normal", "loose": "Loose" },
    "width": "Text width",
    "widths": { "narrow": "Narrow", "medium": "Medium", "wide": "Wide" },
    "theme": "Theme",
    "themes": { "light": "Light", "sepia": "Paper", "dark": "Dark" },
    "contents": "Contents",
    "contentsTitle": "Contents",
    "contentsEmpty": "This book has no table of contents.",
    "close": "Close",
    "lostAccessSignedOut": "You have been signed out. Sign in again to keep reading.",
    "lostAccessRevoked": "You no longer have access to this book.",
    "signIn": "Sign in",
    "goToLibrary": "Go to my library",
    "finishedTitle": "You finished this book.",
    "finishedBody": "It is marked as finished in your library.",
    "dismiss": "Keep reading",
    "sampleEndTitle": "That is the end of the sample.",
    "sampleEndBody": "Get the full book to keep reading.",
    "backToBook": "Back to the book"
```

And the same keys in `lib/i18n/dictionaries/vi.json`:

```json
    "settings": "Cài đặt đọc",
    "settingsTitle": "Cài đặt đọc",
    "fontSize": "Cỡ chữ",
    "decreaseFontSize": "Chữ nhỏ hơn",
    "increaseFontSize": "Chữ lớn hơn",
    "font": "Phông chữ",
    "fonts": { "publisher": "Mặc định của sách", "serif": "Lora", "sans": "Không chân" },
    "lineHeight": "Giãn dòng",
    "lineHeights": { "tight": "Hẹp", "normal": "Vừa", "loose": "Rộng" },
    "width": "Độ rộng cột chữ",
    "widths": { "narrow": "Hẹp", "medium": "Vừa", "wide": "Rộng" },
    "theme": "Giao diện",
    "themes": { "light": "Sáng", "sepia": "Giấy", "dark": "Tối" },
    "contents": "Mục lục",
    "contentsTitle": "Mục lục",
    "contentsEmpty": "Sách này không có mục lục.",
    "close": "Đóng",
    "lostAccessSignedOut": "Bạn đã đăng xuất. Hãy đăng nhập lại để tiếp tục đọc.",
    "lostAccessRevoked": "Bạn không còn quyền đọc sách này.",
    "signIn": "Đăng nhập",
    "goToLibrary": "Tới thư viện của tôi",
    "finishedTitle": "Bạn đã đọc xong cuốn sách này.",
    "finishedBody": "Sách đã được đánh dấu là đã đọc xong trong thư viện của bạn.",
    "dismiss": "Đọc tiếp",
    "sampleEndTitle": "Phần đọc thử đã kết thúc.",
    "sampleEndBody": "Hãy nhận sách đầy đủ để đọc tiếp.",
    "backToBook": "Quay lại trang sách"
```

Both files must agree key for key: `Dictionary` is `typeof en`, so a key missing from `vi.json` is a
type error, and a key only in `vi.json` is silently dead.

- [ ] **Step 6: Run the checks and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add components/ui/dialog.tsx components/ui/dialog.test.tsx lib/i18n/dictionaries/en.json lib/i18n/dictionaries/vi.json package.json package-lock.json
git commit -m "feat(ui): add a dialog primitive and the reader's new copy"
```

---

### Task 6: The settings panel

**Files:**
- Create: `components/reader/reader-settings-panel.tsx`
- Create: `components/reader/reader-settings-panel.test.tsx`

**Interfaces:**
- Consumes: `Dialog`, `DialogPanel`, `DialogTitle`, `DialogTrigger`, `DialogClose`; `DEFAULT_READER_PREFERENCES`, `READER_LINE_HEIGHTS`, `READER_MIN_FONT_PX`, `READER_MAX_FONT_PX`, `fontScaleToPx`, `pxToFontScale` from `lib/reader/preferences.ts`; `ReaderPreferences`.
- Produces:
  - `type ReaderSettingsCopy` — the subset of `Dictionary["reader"]` this panel renders.
  - `ReaderSettingsPanel({ preferences, onChange, copy })` — a Client Component rendering its own trigger button.

- [ ] **Step 1: Write the failing test**

Create `components/reader/reader-settings-panel.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ReaderSettingsPanel } from "@/components/reader/reader-settings-panel";
import { DEFAULT_READER_PREFERENCES } from "@/lib/reader/preferences";

const copy = {
  settings: "Reading settings",
  settingsTitle: "Reading settings",
  fontSize: "Font size",
  decreaseFontSize: "Smaller text",
  increaseFontSize: "Larger text",
  font: "Font",
  fonts: { publisher: "Publisher", serif: "Lora", sans: "Sans" },
  lineHeight: "Line spacing",
  lineHeights: { tight: "Tight", normal: "Normal", loose: "Loose" },
  width: "Text width",
  widths: { narrow: "Narrow", medium: "Medium", wide: "Wide" },
  theme: "Theme",
  themes: { light: "Light", sepia: "Paper", dark: "Dark" },
  close: "Close",
};

async function openPanel() {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<ReaderSettingsPanel copy={copy} onChange={onChange} preferences={DEFAULT_READER_PREFERENCES} />);
  await user.click(screen.getByRole("button", { name: "Reading settings" }));
  return { user, onChange };
}

describe("ReaderSettingsPanel", () => {
  it("reports the current setting for each group", async () => {
    await openPanel();

    expect(screen.getByRole("radio", { name: "Publisher" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Medium" })).toBeChecked();
    expect(screen.getByText("16px")).toBeInTheDocument();
  });

  it("raises the font size by one step", async () => {
    const { user, onChange } = await openPanel();

    await user.click(screen.getByRole("button", { name: "Larger text" }));

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_READER_PREFERENCES, fontScale: 17 / 16 });
  });

  it("lowers the font size by one step", async () => {
    const { user, onChange } = await openPanel();

    await user.click(screen.getByRole("button", { name: "Smaller text" }));

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_READER_PREFERENCES, fontScale: 15 / 16 });
  });

  // The panel is controlled: it renders whatever preferences it is given and never holds its own.
  // So the floor is tested by rendering AT the floor - clicking twice against a fixed prop would
  // only prove the prop did not change.
  it("disables the controls at each end of the offered range", async () => {
    const user = userEvent.setup();

    const { unmount } = render(
      <ReaderSettingsPanel
        copy={copy}
        onChange={vi.fn()}
        preferences={{ ...DEFAULT_READER_PREFERENCES, fontScale: 15 / 16 }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Reading settings" }));
    expect(screen.getByRole("button", { name: "Smaller text" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Larger text" })).toBeEnabled();
    unmount();

    render(
      <ReaderSettingsPanel
        copy={copy}
        onChange={vi.fn()}
        preferences={{ ...DEFAULT_READER_PREFERENCES, fontScale: 26 / 16 }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Reading settings" }));
    expect(screen.getByRole("button", { name: "Larger text" })).toBeDisabled();
  });

  it("changes the theme", async () => {
    const { user, onChange } = await openPanel();

    await user.click(screen.getByRole("radio", { name: "Dark" }));

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_READER_PREFERENCES, theme: "dark" });
  });

  it("changes the reading-column width", async () => {
    const { user, onChange } = await openPanel();

    await user.click(screen.getByRole("radio", { name: "Wide" }));

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_READER_PREFERENCES, width: "wide" });
  });

  it("is operable by keyboard alone", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ReaderSettingsPanel copy={copy} onChange={onChange} preferences={DEFAULT_READER_PREFERENCES} />);

    await user.tab();
    expect(screen.getByRole("button", { name: "Reading settings" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("dialog", { name: "Reading settings" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run components/reader/reader-settings-panel.test.tsx`
Expected: FAIL — `Cannot find module '@/components/reader/reader-settings-panel'`.

- [ ] **Step 3: Write the panel**

Create `components/reader/reader-settings-panel.tsx`:

```tsx
"use client";

import { SettingsIcon } from "lucide-react";

import { Dialog, DialogClose, DialogPanel, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  READER_LINE_HEIGHTS,
  READER_MAX_FONT_PX,
  READER_MIN_FONT_PX,
  fontScaleToPx,
  pxToFontScale,
} from "@/lib/reader/preferences";
import type { ReaderPreferences } from "@/lib/reader/types";

// Board 1k's reading settings. Every change applies immediately - there is no Save button, because
// the only way to judge a font size is to see it on the page you are reading.
//
// The panel is presentational: it reports a new ReaderPreferences and does not store anything
// itself. ReaderClient owns both halves of "apply to the engine" and "write to localStorage", so
// there is one place where a preference change happens.

export type ReaderSettingsCopy = {
  settings: string;
  settingsTitle: string;
  fontSize: string;
  decreaseFontSize: string;
  increaseFontSize: string;
  font: string;
  fonts: { publisher: string; serif: string; sans: string };
  lineHeight: string;
  lineHeights: { tight: string; normal: string; loose: string };
  width: string;
  widths: { narrow: string; medium: string; wide: string };
  theme: string;
  themes: { light: string; sepia: string; dark: string };
  close: string;
};

const groupLabel = "text-xs font-medium tracking-wide text-sage-text uppercase";
const optionBase =
  "min-h-11 flex-1 rounded-md border border-sand px-3 text-sm text-ink transition-colors duration-150 ease-quiet hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest aria-checked:border-forest aria-checked:bg-forest aria-checked:text-ivory";

// A native radiogroup rather than a listbox: these are small, mutually exclusive sets, and arrow-key
// navigation between them is what a screen-reader user expects. `role="radio"` with aria-checked is
// used instead of <input type="radio"> so the whole control is one styled target of at least 44px.
function OptionGroup<T extends string>({
  label,
  options,
  value,
  onSelect,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onSelect: (value: T) => void;
}) {
  return (
    <div className="space-y-2">
      <p className={groupLabel} id={`reader-setting-${label}`}>
        {label}
      </p>
      <div aria-labelledby={`reader-setting-${label}`} className="flex gap-2" role="radiogroup">
        {options.map((option) => (
          <button
            aria-checked={option.value === value}
            className={optionBase}
            key={option.value}
            onClick={() => onSelect(option.value)}
            role="radio"
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ReaderSettingsPanel({
  preferences,
  onChange,
  copy,
}: {
  preferences: ReaderPreferences;
  onChange: (preferences: ReaderPreferences) => void;
  copy: ReaderSettingsCopy;
}) {
  const fontPx = fontScaleToPx(preferences.fontScale);

  // Clamped at both ends, and the control is disabled at the boundary rather than silently doing
  // nothing: a button that looks live and is not reads as a broken reader.
  function stepFont(delta: number) {
    const next = fontPx + delta;
    if (next < READER_MIN_FONT_PX || next > READER_MAX_FONT_PX) return;
    onChange({ ...preferences, fontScale: pxToFontScale(next) });
  }

  return (
    <Dialog>
      <DialogTrigger
        aria-label={copy.settings}
        className="inline-flex size-11 items-center justify-center rounded-md text-ink outline-none transition-colors duration-150 ease-quiet hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
      >
        <SettingsIcon aria-hidden="true" className="size-5" />
      </DialogTrigger>

      <DialogPanel side="right">
        <div className="flex items-center justify-between gap-4">
          <DialogTitle>{copy.settingsTitle}</DialogTitle>
          <DialogClose>{copy.close}</DialogClose>
        </div>

        <div className="space-y-2">
          <p className={groupLabel}>{copy.fontSize}</p>
          <div className="flex items-center gap-2">
            <button
              aria-label={copy.decreaseFontSize}
              className={`${optionBase} flex-none px-4`}
              disabled={fontPx <= READER_MIN_FONT_PX}
              onClick={() => stepFont(-1)}
              type="button"
            >
              A−
            </button>
            <span className="min-w-14 text-center text-sm tabular-nums">{fontPx}px</span>
            <button
              aria-label={copy.increaseFontSize}
              className={`${optionBase} flex-none px-4`}
              disabled={fontPx >= READER_MAX_FONT_PX}
              onClick={() => stepFont(1)}
              type="button"
            >
              A+
            </button>
          </div>
        </div>

        <OptionGroup
          label={copy.font}
          onSelect={(fontFamily) => onChange({ ...preferences, fontFamily })}
          options={[
            { value: "publisher" as const, label: copy.fonts.publisher },
            { value: "serif" as const, label: copy.fonts.serif },
            { value: "sans" as const, label: copy.fonts.sans },
          ]}
          value={preferences.fontFamily}
        />

        <OptionGroup
          label={copy.lineHeight}
          onSelect={(value) => onChange({ ...preferences, lineHeight: Number(value) })}
          options={[
            { value: String(READER_LINE_HEIGHTS[0]), label: copy.lineHeights.tight },
            { value: String(READER_LINE_HEIGHTS[1]), label: copy.lineHeights.normal },
            { value: String(READER_LINE_HEIGHTS[2]), label: copy.lineHeights.loose },
          ]}
          value={String(preferences.lineHeight)}
        />

        <OptionGroup
          label={copy.width}
          onSelect={(width) => onChange({ ...preferences, width })}
          options={[
            { value: "narrow" as const, label: copy.widths.narrow },
            { value: "medium" as const, label: copy.widths.medium },
            { value: "wide" as const, label: copy.widths.wide },
          ]}
          value={preferences.width}
        />

        <OptionGroup
          label={copy.theme}
          onSelect={(theme) => onChange({ ...preferences, theme })}
          options={[
            { value: "light" as const, label: copy.themes.light },
            { value: "sepia" as const, label: copy.themes.sepia },
            { value: "dark" as const, label: copy.themes.dark },
          ]}
          value={preferences.theme}
        />
      </DialogPanel>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run components/reader/reader-settings-panel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the checks and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add components/reader/reader-settings-panel.tsx components/reader/reader-settings-panel.test.tsx
git commit -m "feat(reader): add the reading settings panel"
```

---

### Task 7: The table-of-contents drawer

**Files:**
- Create: `components/reader/reader-toc-drawer.tsx`
- Create: `components/reader/reader-toc-drawer.test.tsx`

**Interfaces:**
- Consumes: the dialog primitive; `flattenToc` from `lib/reader/toc.ts`; `ReaderTocEntry`.
- Produces: `type ReaderTocCopy`, and `ReaderTocDrawer({ entries, currentHref, onNavigate, copy })`.

- [ ] **Step 1: Write the failing test**

Create `components/reader/reader-toc-drawer.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ReaderTocDrawer } from "@/components/reader/reader-toc-drawer";
import type { ReaderTocEntry } from "@/lib/reader/types";

const copy = { contents: "Contents", contentsTitle: "Contents", contentsEmpty: "This book has no table of contents.", close: "Close" };

const entries: ReaderTocEntry[] = [
  {
    title: "Part One",
    href: "/api/reader/publications/p1/resources/c1.xhtml",
    children: [{ title: "A Beginning", href: "/api/reader/publications/p1/resources/c1.xhtml#a", children: [] }],
  },
  { title: "Part Two", href: "/api/reader/publications/p1/resources/c2.xhtml", children: [] },
];

describe("ReaderTocDrawer", () => {
  it("lists every entry, nested ones included", async () => {
    const user = userEvent.setup();
    render(<ReaderTocDrawer copy={copy} currentHref={null} entries={entries} onNavigate={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Contents" }));

    expect(screen.getByRole("button", { name: "Part One" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "A Beginning" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Part Two" })).toBeInTheDocument();
  });

  it("marks the entry the reader is in", async () => {
    const user = userEvent.setup();
    render(
      <ReaderTocDrawer
        copy={copy}
        currentHref="/api/reader/publications/p1/resources/c2.xhtml#para-2"
        entries={entries}
        onNavigate={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Contents" }));

    expect(screen.getByRole("button", { name: "Part Two" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "Part One" })).not.toHaveAttribute("aria-current");
  });

  it("reports the chosen href and closes", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<ReaderTocDrawer copy={copy} currentHref={null} entries={entries} onNavigate={onNavigate} />);

    await user.click(screen.getByRole("button", { name: "Contents" }));
    await user.click(screen.getByRole("button", { name: "Part Two" }));

    expect(onNavigate).toHaveBeenCalledWith("/api/reader/publications/p1/resources/c2.xhtml");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // A sample filtered down to a single resource can legitimately have no nav at all.
  it("says so when there is no table of contents", async () => {
    const user = userEvent.setup();
    render(<ReaderTocDrawer copy={copy} currentHref={null} entries={[]} onNavigate={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Contents" }));

    expect(screen.getByText("This book has no table of contents.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run components/reader/reader-toc-drawer.test.tsx`
Expected: FAIL — `Cannot find module '@/components/reader/reader-toc-drawer'`.

- [ ] **Step 3: Write the drawer**

Create `components/reader/reader-toc-drawer.tsx`:

```tsx
"use client";

import { ListIcon } from "lucide-react";
import { useState } from "react";

import { Dialog, DialogClose, DialogPanel, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { flattenToc } from "@/lib/reader/toc";
import type { ReaderTocEntry } from "@/lib/reader/types";

// The table of contents, from the manifest the engine already holds. Entries are buttons rather
// than links: navigating calls engine.goTo, which is an in-place move within the mounted engine, and
// an <a href> to a Route Handler URL would take the reader out of the reader and straight to a raw
// XHTML resource.

export type ReaderTocCopy = {
  contents: string;
  contentsTitle: string;
  contentsEmpty: string;
  close: string;
};

function pathOf(href: string): string {
  const hash = href.indexOf("#");
  return hash === -1 ? href : href.slice(0, hash);
}

export function ReaderTocDrawer({
  entries,
  currentHref,
  onNavigate,
  copy,
}: {
  entries: ReaderTocEntry[];
  currentHref: string | null;
  onNavigate: (href: string) => void;
  copy: ReaderTocCopy;
}) {
  // Controlled so choosing an entry can close the drawer: a drawer left open over the page the
  // reader just jumped to hides the thing they asked to see.
  const [open, setOpen] = useState(false);
  const flat = flattenToc(entries);
  const currentPath = currentHref ? pathOf(currentHref) : null;

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        aria-label={copy.contents}
        className="inline-flex size-11 items-center justify-center rounded-md text-ink outline-none transition-colors duration-150 ease-quiet hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
      >
        <ListIcon aria-hidden="true" className="size-5" />
      </DialogTrigger>

      <DialogPanel side="right">
        <div className="flex items-center justify-between gap-4">
          <DialogTitle>{copy.contentsTitle}</DialogTitle>
          <DialogClose>{copy.close}</DialogClose>
        </div>

        {flat.length === 0 ? (
          <p className="text-sm text-sage-text">{copy.contentsEmpty}</p>
        ) : (
          <ul className="-mx-2">
            {flat.map((entry) => {
              const current = currentPath !== null && pathOf(entry.href) === currentPath;
              return (
                <li key={`${entry.depth}-${entry.href}-${entry.title}`}>
                  <button
                    // Only on the current entry: aria-current="false" is announced by some screen
                    // readers, so the attribute is omitted rather than set false.
                    {...(current ? { "aria-current": "true" as const } : {})}
                    // `aria-[current=true]`, not `aria-[current]`: Tailwind's arbitrary aria
                    // variant needs a value to match against.
                    className="flex min-h-11 w-full items-center rounded-md px-2 text-left text-sm text-ink transition-colors duration-150 ease-quiet hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest aria-[current=true]:font-medium aria-[current=true]:text-forest"
                    onClick={() => {
                      setOpen(false);
                      onNavigate(entry.href);
                    }}
                    style={{ paddingLeft: `${0.5 + entry.depth * 0.875}rem` }}
                    type="button"
                  >
                    {entry.title}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </DialogPanel>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run components/reader/reader-toc-drawer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the checks and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add components/reader/reader-toc-drawer.tsx components/reader/reader-toc-drawer.test.tsx
git commit -m "feat(reader): add the table of contents drawer"
```

---

### Task 8: The reader client — modes, settings, contents, lost access, completion

**Files:**
- Modify: `components/reader/reader-client.tsx`
- Modify: `components/reader/reader-client.test.tsx`
- Modify: `components/reader/reader-mount.tsx`
- Modify: `app/[locale]/(reader)/read/[bookId]/page.tsx`

**Interfaces:**
- Consumes: `ReaderEngine` (now with `getTableOfContents`), `ReaderManifestError` from `lib/reader/readium-engine.ts`, `loadReaderPreferences`, `saveReaderPreferences`, `READER_WIDTH_CLASS`, `chapterTitleFor`, `ReaderSettingsPanel`, `ReaderTocDrawer`.
- Produces:
  - `ReaderClientProps` gains `mode: "entitled" | "sample"`, `endSlot?: React.ReactNode`, and a widened `copy`.
  - `type ReaderCopy` gains every key added in Task 5 plus `chapterLabel` is **not** added — the chapter title is content, not a label.

- [ ] **Step 1: Write the failing tests**

Add to `components/reader/reader-client.test.tsx`. Keep the existing iframe-sizing test exactly as it
is — it is PR #16's regression test and must keep passing. Extend the file's existing engine stub
with `getTableOfContents: vi.fn().mockResolvedValue([])`.

```tsx
describe("sample mode", () => {
  it("mints no reader session and saves no progress", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderReader({ mode: "sample", manifestUrl: "/api/samples/p1/manifest" });

    await screen.findByRole("region", { name: "Reader" });

    // The whole sample contract in one assertion: a sample reader is anonymous, so a session POST
    // would 401 and a progress POST would 404, and neither should ever be attempted.
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).not.toContain("/api/reader/");
    }
  });
});

describe("lost access", () => {
  it("re-mints the session once and retries after a refusal", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mountRejectsOnceWith(new ReaderManifestError(401));
    renderReader({ mode: "entitled" });

    await screen.findByRole("region", { name: "Reader" });

    const sessionPosts = fetchSpy.mock.calls.filter((call) => String(call[0]).includes("/api/reader/sessions"));
    expect(sessionPosts).toHaveLength(2);
  });

  it("shows the signed-out state when the re-mint does not help", async () => {
    mountAlwaysRejectsWith(new ReaderManifestError(401));
    renderReader({ mode: "entitled" });

    expect(await screen.findByText("You have been signed out. Sign in again to keep reading.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows the revoked state for a 404", async () => {
    mountAlwaysRejectsWith(new ReaderManifestError(404));
    renderReader({ mode: "entitled" });

    expect(await screen.findByText("You no longer have access to this book.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to my library" })).toBeInTheDocument();
  });

  // An outage is not lost access. Telling a reader their entitlement is gone because a storage
  // bucket hiccuped is the worst possible wrong answer here.
  it("keeps the retryable error for a 502", async () => {
    mountAlwaysRejectsWith(new ReaderManifestError(502));
    renderReader({ mode: "entitled" });

    expect(await screen.findByText("This book could not be opened.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("completion", () => {
  it("shows the completion card at the end of the book", async () => {
    renderReader({
      mode: "entitled",
      initialLocator: { href: "c9.xhtml", progression: 1, totalProgression: 0.995, locations: {} },
    });

    expect(await screen.findByText("You finished this book.")).toBeInTheDocument();
  });

  it("shows no completion card partway through", async () => {
    renderReader({
      mode: "entitled",
      initialLocator: { href: "c2.xhtml", progression: 0.5, totalProgression: 0.5, locations: {} },
    });

    await screen.findByRole("region", { name: "Reader" });
    expect(screen.queryByText("You finished this book.")).toBeNull();
  });
});

describe("settings", () => {
  it("applies stored preferences to the engine after mounting", async () => {
    window.localStorage.setItem(
      "infinity-books.reader.preferences",
      JSON.stringify({ fontFamily: "sans", fontScale: 1.25, lineHeight: 2, width: "wide", theme: "dark" }),
    );

    const { engine } = renderReader({ mode: "entitled" });
    await screen.findByRole("region", { name: "Reader" });

    expect(engine.setPreferences).toHaveBeenCalledWith({
      fontFamily: "sans",
      fontScale: 1.25,
      lineHeight: 2,
      width: "wide",
      theme: "dark",
    });
  });
});
```

Write the `renderReader`, `mountRejectsOnceWith` and `mountAlwaysRejectsWith` helpers at the top of
the file, built on the mocking the file already does (`vi.mock("next/navigation")`,
`vi.mock("@/lib/reader/readium-engine")`, `vi.spyOn(globalThis, "fetch")`). `renderReader` returns
the engine stub so assertions can be made against it, and supplies a full `copy` object using the
English strings from Task 5.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run components/reader/reader-client.test.tsx`
Expected: FAIL — `mode` is not a prop, and none of the new states exist.

- [ ] **Step 3: Widen the copy and props**

In `components/reader/reader-client.tsx`:

```ts
export type ReaderCopy = {
  title: string;
  loading: string;
  failed: string;
  retry: string;
  nextPage: string;
  previousPage: string;
  backToLibrary: string;
  saveFailed: string;
  saveRetry: string;
  progressLabel: string;
  settings: string;
  settingsTitle: string;
  fontSize: string;
  decreaseFontSize: string;
  increaseFontSize: string;
  font: string;
  fonts: { publisher: string; serif: string; sans: string };
  lineHeight: string;
  lineHeights: { tight: string; normal: string; loose: string };
  width: string;
  widths: { narrow: string; medium: string; wide: string };
  theme: string;
  themes: { light: string; sepia: string; dark: string };
  contents: string;
  contentsTitle: string;
  contentsEmpty: string;
  close: string;
  lostAccessSignedOut: string;
  lostAccessRevoked: string;
  signIn: string;
  goToLibrary: string;
  finishedTitle: string;
  finishedBody: string;
  dismiss: string;
  // Sample-mode copy. These live on ReaderCopy rather than only on the sample page so that
  // `ReaderCopy` is exactly `Dictionary["reader"]` key for key. That matters: the pages pass
  // `copy={dictionary.reader}` wholesale, and TypeScript's excess-property check rejects an object
  // literal carrying keys the target type does not declare. Listing thirty keys by hand at each
  // call site instead is a transcription error waiting to happen.
  sampleEndTitle: string;
  sampleEndBody: string;
  backToBook: string;
};

export type ReaderClientProps = {
  // "sample" is the public reader: no session is minted, no progress is saved, and the way back is
  // the book page rather than the library. One component rather than two, because the engine
  // lifecycle and PR #16's iframe-sizing contract are exactly the kind of thing that gets fixed in
  // one copy and left broken in the other.
  mode: "entitled" | "sample";
  publicationId: string;
  bookTitle: string;
  manifestUrl: string;
  initialLocator: ReaderLocator | null;
  backHref: string;
  // Where to go when access is gone. In entitled mode this is the library; sign-in is derived from
  // the page and passed in so this component never builds a locale-prefixed URL itself.
  libraryHref: string;
  signInHref: string;
  // Rendered after the last page in sample mode: the book's Get or Buy control, built on the
  // server. A ReactNode because BookActionControl needs bound Server Actions, which cannot cross
  // into a client module.
  endSlot?: React.ReactNode;
  copy: ReaderCopy;
};

type Phase = "loading" | "ready" | "error" | "lost-signed-out" | "lost-revoked";
```

- [ ] **Step 4: Classify failures instead of swallowing them**

Add near the other module-level helpers:

```ts
// 401 and 404 are the only refusals the reader API produces - there is no 403 anywhere on these
// paths, because a distinguishable "exists but forbidden" would be an existence oracle
// (lib/reader/session.ts). 401 means the caller is not signed in; 404 covers a revoked entitlement,
// a superseded publication, and a book that never existed, all deliberately indistinguishable.
// Anything else - 502, a network failure, an engine that could not build its frame pool - is an
// outage, and must NOT be reported as lost access.
function lostAccessPhase(error: unknown): Extract<Phase, "lost-signed-out" | "lost-revoked"> | null {
  const status = error instanceof ReaderManifestError ? error.status : null;
  if (status === 401) return "lost-signed-out";
  if (status === 404) return "lost-revoked";
  return null;
}
```

Import `ReaderManifestError` from `@/lib/reader/readium-engine`. It is a plain class with no Readium
types on it, so importing it here does not pull the navigator into this chunk any earlier than the
adapter already does.

- [ ] **Step 5: Add preferences, the TOC, and the re-mint to the mount effect**

Add state and refs beside the existing ones:

```ts
  const [preferences, setPreferences] = useState<ReaderPreferences>(DEFAULT_READER_PREFERENCES);
  const [toc, setToc] = useState<ReaderTocEntry[]>([]);
  const [currentHref, setCurrentHref] = useState<string | null>(initialLocator?.href ?? null);
  const [completionDismissed, setCompletionDismissed] = useState(false);
  const [totalProgression, setTotalProgression] = useState<number | null>(initialLocator?.totalProgression ?? null);
  // One silent re-mint per mount attempt. A session that merely expired mid-book must recover
  // without interrupting the reader; a second failure is a real loss of access.
  const remintedRef = useRef(false);
```

Load the preferences once on the client, after hydration, so the server and client render the same
first paint:

```ts
  // Read after mount rather than in useState's initializer: localStorage does not exist during the
  // server render, and seeding state from it would make the first client render disagree with the
  // server's.
  useEffect(() => {
    setPreferences(loadReaderPreferences());
  }, []);
```

In the mount effect, replace the session POST and the catch block:

```ts
    void (async () => {
      async function mintSession(): Promise<void> {
        // Sample mode is anonymous by construction: /api/samples/* takes no user gate, and a
        // session POST here would 401 for the visitor this reader exists to serve.
        if (mode === "sample") return;
        const session = await fetch("/api/reader/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ publicationId }),
        });
        if (!session.ok) throw new ReaderManifestError(session.status);
      }

      try {
        await mintSession();
        if (cancelled) return;

        await engine.mount({ container, manifestUrl, initialLocator: locatorRef.current });
        if (cancelled) {
          void engine.destroy();
          return;
        }

        // Applied before `ready`, so the restored locator is resolved against the typography the
        // reader actually uses. Applying them after the first paint would render the opening page
        // at the defaults and then jump, which reads as a bug.
        await engine.setPreferences(preferencesRef.current);

        engineRef.current = engine;
        setToc(await engine.getTableOfContents());
        setNavigation(await engine.getNavigationState());
        setPhase("ready");
      } catch (error) {
        console.error("Reader engine failed to mount", error);
        if (cancelled) return;

        const lost = lostAccessPhase(error);
        if (lost && mode === "entitled" && !remintedRef.current) {
          // The common cause of a refusal mid-book is an expired session, and POST
          // /api/reader/sessions mints a fresh one. Attempted once: a second refusal after a
          // successful re-mint is a genuine loss of access, not an expiry.
          remintedRef.current = true;
          setAttempt((value) => value + 1);
          return;
        }
        setPhase(lost ?? "error");
      }
    })();
```

`preferencesRef` is a ref kept in step with the `preferences` state, so the mount effect does not
list `preferences` in its dependency array — an object identity there would tear down and rebuild the
engine on every preference change, and a preference change must never remount a book:

```ts
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
```

Add a handler that applies and stores a change without remounting:

```ts
  const changePreferences = useCallback((next: ReaderPreferences) => {
    setPreferences(next);
    saveReaderPreferences(next);
    // Not awaited and not guarded on the engine being present: a preference change while the
    // engine is still mounting is applied by the mount effect itself from preferencesRef.
    void engineRef.current?.setPreferences(next);
  }, []);
```

- [ ] **Step 6: Track the chapter and completion, and add TOC navigation**

Extend `move()` so it records the href and whole-book progression alongside the percentage, and add
a `goToHref`:

```ts
      const locator = await engine.getLocator();
      if (engineRef.current !== engine) return;
      setProgressPercent(toPercent(locator));
      setCurrentHref(locator.href);
      setTotalProgression(locator.totalProgression);
      scheduleSave(locator);
```

```ts
  const goToHref = useCallback(
    async (href: string) => {
      const engine = engineRef.current;
      if (!engine) return;

      // A toc href carries the fragment the nav entry pointed at; the rest of the locator is what
      // the engine works out for itself once it lands.
      const result = await engine.goTo({ href, progression: 0, totalProgression: null, locations: {} });
      if (engineRef.current !== engine) return;

      setNavigation({ canGoForward: result.canGoForward, canGoBackward: result.canGoBackward });
      if (!result.moved) return;

      const locator = await engine.getLocator();
      if (engineRef.current !== engine) return;
      setProgressPercent(toPercent(locator));
      setCurrentHref(locator.href);
      setTotalProgression(locator.totalProgression);
      // Sample mode has nothing to save; scheduleSave is a no-op there (see below).
      scheduleSave(locator);
    },
    [scheduleSave],
  );
```

Guard `flush` so sample mode never posts progress — one guard at the single exit rather than at each
of the four call sites:

```ts
      const locator = pendingRef.current;
      // A sample reader has no entitlement and no session, so /api/reader/progress would 404. It
      // also has nothing worth keeping: a sample is a few resources with no place to return to.
      if (!locator || mode === "sample") return true;
```

Derive the completion and chapter title during render:

```ts
  const chapterTitle = chapterTitleFor(toc, currentHref);
  // The same 0.99 threshold save_reading_progress uses, so the card and the library agree about
  // whether this book is finished.
  const finished = mode === "entitled" && typeof totalProgression === "number" && totalProgression >= 0.99;
```

- [ ] **Step 7: Render the new chrome**

In the header, add the chapter title and the two panel buttons, keeping the back link first so
leaving still flushes:

```tsx
      <header className="grid min-h-[3.75rem] grid-cols-[auto_1fr_auto] items-center gap-2 px-4 sm:px-8">
        <a
          className="inline-flex min-h-11 items-center gap-1.5 text-[0.84375rem] font-medium text-ink hover:text-forest"
          href={backHref}
          onClick={(event) => void exitToLibrary(event)}
        >
          <span aria-hidden="true">←</span>
          {copy.backToLibrary}
        </a>

        <div className="min-w-0 text-center">
          <p className="truncate text-[0.84375rem] font-medium">{bookTitle}</p>
          {/* Truncates before the book title does at 390px: which book you are in matters more
              than which chapter when only one line fits. */}
          {chapterTitle ? <p className="truncate text-[0.75rem] text-sage-text">{chapterTitle}</p> : null}
        </div>

        <div className="flex items-center gap-1">
          <span className="hidden text-[0.8125rem] text-sage-text sm:inline">
            {progressPercent}% {copy.progressLabel}
          </span>
          <ReaderTocDrawer
            copy={{ contents: copy.contents, contentsTitle: copy.contentsTitle, contentsEmpty: copy.contentsEmpty, close: copy.close }}
            currentHref={currentHref}
            entries={toc}
            onNavigate={(href) => void goToHref(href)}
          />
          <ReaderSettingsPanel copy={copy} onChange={changePreferences} preferences={preferences} />
        </div>
      </header>
```

Apply the width to the reading column, keeping PR #16's iframe rules untouched:

```tsx
      <div className={`mx-auto flex w-full flex-1 flex-col px-2 sm:px-6 ${READER_WIDTH_CLASS[preferences.width]}`}>
        <div
          aria-busy={phase === "loading"}
          aria-label={copy.title}
          className="relative h-[calc(100dvh-10.5rem)] min-h-[24rem] w-full overflow-hidden [&>.readium-navigator-iframe]:inset-0 [&>.readium-navigator-iframe]:h-full [&>.readium-navigator-iframe]:w-full [&>.readium-navigator-iframe]:border-0"
          ref={containerRef}
          role="region"
        />
      </div>
```

Replace the reading surface with the lost-access state when one is set, so the chrome stays and the
way out is still visible:

```tsx
      {phase === "lost-signed-out" || phase === "lost-revoked" ? (
        <div className="mx-auto flex w-full max-w-[34rem] flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
          <p className="text-sm text-ink" role="alert">
            {phase === "lost-signed-out" ? copy.lostAccessSignedOut : copy.lostAccessRevoked}
          </p>
          <Button
            render={<Link href={phase === "lost-signed-out" ? signInHref : libraryHref} />}
          >
            {phase === "lost-signed-out" ? copy.signIn : copy.goToLibrary}
          </Button>
        </div>
      ) : (
        /* the reading column above */
      )}
```

And add the completion card and the sample end slot above the footer:

```tsx
      {finished && !completionDismissed ? (
        <div className="mx-auto w-full max-w-[34rem] px-4 pb-4">
          <div className="rounded-md border border-hairline bg-surface p-4 text-center" role="status">
            <p className="font-serif text-lg">{copy.finishedTitle}</p>
            <p className="mt-1 text-sm text-sage-text">{copy.finishedBody}</p>
            <div className="mt-3 flex justify-center gap-2">
              <Button render={<Link href={libraryHref} />} size="sm">
                {copy.goToLibrary}
              </Button>
              {/* Dismissing changes nothing in the database - save_reading_progress already
                  recorded the completion. This only puts the page back. */}
              <Button onClick={() => setCompletionDismissed(true)} size="sm" type="button" variant="outline">
                {copy.dismiss}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {mode === "sample" && !navigation.canGoForward && endSlot ? (
        <div className="mx-auto w-full max-w-[34rem] px-4 pb-4">{endSlot}</div>
      ) : null}
```

Import `Link` from `next/link` and the two panels at the top of the file.

- [ ] **Step 8: Pass the new props through**

`components/reader/reader-mount.tsx` forwards `ReaderClientProps` unchanged — confirm it spreads
props rather than listing them, and widen it if it lists them.

In `app/[locale]/(reader)/read/[bookId]/page.tsx`, pass the new props:

```tsx
      <ReaderMount
        backHref={withLocale(locale, "/library")}
        bookTitle={book.title}
        copy={copy}
        initialLocator={book.initialLocator}
        libraryHref={withLocale(locale, "/library")}
        manifestUrl={`/api/reader/publications/${book.publicationId}/manifest`}
        mode="entitled"
        publicationId={book.publicationId}
        signInHref={getCatalogRoutes(locale).signInFor(withLocale(locale, `/read/${book.bookId}`))}
      />
```

The field-by-field `copy={{...}}` spread can now be `copy={copy}`: `dictionary.reader` is exactly
`ReaderCopy` once Task 5's keys are in both dictionaries, and listing thirty keys by hand is a
transcription error waiting to happen.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run components/reader/reader-client.test.tsx`
Expected: PASS, including the original iframe-sizing test.

- [ ] **Step 10: Run the checks and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add components/reader/reader-client.tsx components/reader/reader-client.test.tsx components/reader/reader-mount.tsx "app/[locale]/(reader)/read/[bookId]/page.tsx"
git commit -m "feat(reader): add settings, contents, lost access, and completion"
```

---

### Task 9: The public sample reader

**Files:**
- Modify: `lib/reader/session.ts`
- Modify: `lib/reader/session.test.ts`
- Modify: `lib/data/catalog.ts`
- Modify: `lib/data/catalog.test.ts`
- Create: `app/[locale]/(public)/read-sample/[slug]/page.tsx`
- Modify: `lib/auth/route-access.test.ts`
- Modify: `lib/i18n/routes.ts` (delete the "arrives in S4" comment)
- Create: `app/api/reader/publications/[publicationId]/manifest/route.test.ts`

**Interfaces:**
- Consumes: `getBookPage`, `getBookActionState` from `lib/data/catalog.ts`; `resolveSampleManifest`'s existing servability rules; `BookActionControl`; `getFreeEbookAction` / `buyEbookAction` from `app/[locale]/(public)/books/[slug]/actions.ts`.
- Produces:
  - `resolveSamplePublicationId(bookId: string): Promise<string | null>` in `lib/reader/session.ts`.
  - `getSampleReaderBook(locale: Locale, slug: string): Promise<{ bookId: string; title: string; slug: string; publicationId: string; action: BookAction; signedIn: boolean } | null>` in `lib/data/catalog.ts`.

- [ ] **Step 1: Write the failing tests**

Add to `lib/reader/session.test.ts`, following the file's existing admin-client mocking:

```ts
describe("resolveSamplePublicationId", () => {
  it("returns the book's active publication when it is published and has a sample", async () => {
    mockAdminTables({
      books: { active_publication_id: "pub-1", status: "published" },
      ebook_publications: { id: "pub-1", status: "published" },
      book_samples: { allowed_hrefs: ["OEBPS/c1.xhtml"] },
    });

    await expect(resolveSamplePublicationId("book-1")).resolves.toBe("pub-1");
  });

  // Each of these is a separate reason, and all of them answer null. The page turns null into one
  // notFound(), so a draft book and a missing one are indistinguishable from outside - the same
  // non-disclosure rule the rest of this module enforces.
  it("returns null when the book is not published", async () => {
    mockAdminTables({ books: { active_publication_id: "pub-1", status: "draft" } });
    await expect(resolveSamplePublicationId("book-1")).resolves.toBeNull();
  });

  it("returns null when the book has no active publication", async () => {
    mockAdminTables({ books: { active_publication_id: null, status: "published" } });
    await expect(resolveSamplePublicationId("book-1")).resolves.toBeNull();
  });

  it("returns null when the active publication is not published", async () => {
    mockAdminTables({
      books: { active_publication_id: "pub-1", status: "published" },
      ebook_publications: { id: "pub-1", status: "superseded" },
    });
    await expect(resolveSamplePublicationId("book-1")).resolves.toBeNull();
  });

  it("returns null when the sample allowlist is empty", async () => {
    mockAdminTables({
      books: { active_publication_id: "pub-1", status: "published" },
      ebook_publications: { id: "pub-1", status: "published" },
      book_samples: { allowed_hrefs: [] },
    });
    await expect(resolveSamplePublicationId("book-1")).resolves.toBeNull();
  });

  it("returns null when there is no sample row at all", async () => {
    mockAdminTables({
      books: { active_publication_id: "pub-1", status: "published" },
      ebook_publications: { id: "pub-1", status: "published" },
      book_samples: null,
    });
    await expect(resolveSamplePublicationId("book-1")).resolves.toBeNull();
  });
});
```

Build `mockAdminTables` on whatever `lib/reader/session.test.ts` already uses to stub
`createAdminClient` — read the top of that file and reuse its helper rather than adding a second
mocking style.

Add to `lib/data/catalog.test.ts`:

```ts
describe("getSampleReaderBook", () => {
  it("returns null for a slug with no book page", async () => {
    vi.mocked(getBookPage).mockResolvedValue(null);
    await expect(getSampleReaderBook("en", "nothing")).resolves.toBeNull();
  });

  it("returns null when the book has no sample", async () => {
    vi.mocked(getBookPage).mockResolvedValue(bookPageFixture({ hasSample: false }));
    await expect(getSampleReaderBook("en", "a-book")).resolves.toBeNull();
  });

  it("returns null when no publication can be resolved", async () => {
    vi.mocked(getBookPage).mockResolvedValue(bookPageFixture({ hasSample: true }));
    vi.mocked(resolveSamplePublicationId).mockResolvedValue(null);
    await expect(getSampleReaderBook("en", "a-book")).resolves.toBeNull();
  });

  it("returns the publication and the book's action", async () => {
    vi.mocked(getBookPage).mockResolvedValue(bookPageFixture({ hasSample: true }));
    vi.mocked(resolveSamplePublicationId).mockResolvedValue("pub-1");

    await expect(getSampleReaderBook("en", "a-book")).resolves.toMatchObject({
      publicationId: "pub-1",
      slug: "a-book",
    });
  });
});
```

Add to `lib/auth/route-access.test.ts`, in the existing anonymous-access `it.each` list:

```ts
// The sample reader is the one reading surface with no sign-in wall. Adding "read-sample" to
// readerPages would put one in front of it, and the failure mode is silent: the page would simply
// redirect instead of rendering.
"/vi/read-sample/a-book",
"/en/read-sample/a-book",
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/reader/session.test.ts lib/data/catalog.test.ts lib/auth/route-access.test.ts`
Expected: FAIL — `resolveSamplePublicationId` and `getSampleReaderBook` do not exist. The
route-access cases should already PASS, because anything under `/{locale}` not in `readerPages` is
public; if they fail, someone has added `read-sample` to `readerPages` and must remove it.

- [ ] **Step 3: Resolve the publication behind the sample boundary**

Add to `lib/reader/session.ts`, beside the other sample functions:

```ts
// Which publication a book's public sample is served from.
//
// This lives here rather than in lib/data/catalog.ts for two reasons. It needs the service-role
// client, because ebook_publications and book_samples are admin-only under RLS and the caller is an
// anonymous visitor - the same situation resolveSampleResource is already in. And it must agree
// exactly with resolveSampleManifest about what "has a servable sample" means, which is easiest to
// keep true when the two sit next to each other.
//
// Returns null for every refusal reason rather than throwing, so the page turns all of them into one
// notFound(): a draft book, a rolled-back publication, and a book that never existed are
// indistinguishable from outside, matching the rest of this module.
//
// The public catalog DTOs carry no publication ids by contract (lib/catalog/public-types.ts), and
// this does not change that: the id reaches the browser only inside the sample manifest URL, exactly
// as it already does for an entitled reader.
export async function resolveSamplePublicationId(bookId: string): Promise<string | null> {
  const admin = createAdminClient();

  const { data: book, error: bookError } = await admin
    .from("books")
    .select("active_publication_id, status")
    .eq("id", bookId)
    .maybeSingle();

  if (bookError || !book || book.status !== "published" || !book.active_publication_id) return null;

  const { data: publication, error: publicationError } = await admin
    .from("ebook_publications")
    .select("id, status")
    .eq("id", book.active_publication_id)
    .maybeSingle();

  if (publicationError || !publication || publication.status !== "published") return null;

  // The same allowlist condition catalog_book_cards.has_sample reports, so the book page's sample
  // link and this page agree about which books have one.
  const { data: sample, error: sampleError } = await admin
    .from("book_samples")
    .select("allowed_hrefs")
    .eq("publication_id", publication.id)
    .maybeSingle();

  if (sampleError || !sample) return null;
  const allowed = Array.isArray(sample.allowed_hrefs) ? sample.allowed_hrefs : [];
  return allowed.length > 0 ? publication.id : null;
}
```

- [ ] **Step 4: Add the page's data function**

Add to `lib/data/catalog.ts`:

```ts
// What the public sample reader page needs. Null means notFound(), for every reason: no
// localization in this locale, an unpublished book, no active publication, or no sample.
export async function getSampleReaderBook(
  locale: Locale,
  slug: string,
): Promise<{
  bookId: string;
  title: string;
  slug: string;
  publicationId: string;
  action: BookAction;
  signedIn: boolean;
} | null> {
  const book = await getBookPage(locale, slug);
  if (!book || !book.hasSample) return null;

  const publicationId = await resolveSamplePublicationId(book.bookId);
  if (!publicationId) return null;

  // Reads the optional session, like the book page does: a signed-out visitor is the expected
  // caller here and must not be redirected. It only decides which control the sample ends with.
  const { action, signedIn } = await getBookActionState(book);

  return { bookId: book.bookId, title: book.title, slug: book.slug, publicationId, action, signedIn };
}
```

Import `resolveSamplePublicationId` from `@/lib/reader/session`.

- [ ] **Step 5: Write the page**

Create `app/[locale]/(public)/read-sample/[slug]/page.tsx`:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BookActionControl } from "@/components/catalog/book-action-control";
import type { ReaderCopy } from "@/components/reader/reader-client";
import { ReaderMount } from "@/components/reader/reader-mount";
import { getSampleReaderBook } from "@/lib/data/catalog";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes } from "@/lib/i18n/routes";

import { buyEbookAction, getFreeEbookAction } from "../../books/[slug]/actions";

type Props = { params: Promise<{ locale: string; slug: string }> };

// The sample's CONTENT is public - that is the point of a sample, and /api/samples/* serves it to
// anonymous callers by design. This surface is still noindex: it is a reading application rather
// than a page, and the parent spec lists read-sample among the disallowed paths. The book page is
// what search engines should find.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function ReadSamplePage({ params }: Props) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();

  // No requireUser: this is the one reading surface with no sign-in wall, and lib/auth/route-access
  // leaves /{locale}/read-sample public for the same reason. The sample allowlist in
  // lib/reader/session.ts is the entire trust boundary here.
  const book = await getSampleReaderBook(locale, slug);
  if (!book) notFound();

  const dictionary = await getDictionary(locale);
  const routes = getCatalogRoutes(locale);
  const bookPath = routes.book(book.slug);

  // The one string that differs in sample mode: the way out leads to the book page, not a library
  // this visitor may not have.
  const sampleCopy: ReaderCopy = { ...dictionary.reader, backToLibrary: dictionary.reader.backToBook };

  return (
    <main className="min-h-dvh bg-white" id="main-content">
      <h1 className="sr-only">{book.title}</h1>
      <ReaderMount
        backHref={bookPath}
        bookTitle={book.title}
        // A variable, not an inline literal: `{ ...dictionary.reader, backToLibrary: ... }` written
        // in the JSX is a fresh object literal and would face TypeScript's excess-property check.
        // Assigned to a `ReaderCopy` above, it is checked once, by name.
        copy={sampleCopy}
        // The end-of-sample control, built here because BookActionControl needs bound Server
        // Actions and those cannot be created inside a client module.
        endSlot={
          <div className="rounded-md border border-hairline bg-surface p-4 text-center">
            <p className="font-serif text-lg">{dictionary.reader.sampleEndTitle}</p>
            <p className="mt-1 mb-3 text-sm text-sage-text">{dictionary.reader.sampleEndBody}</p>
            <div className="flex justify-center">
              <BookActionControl
                action={book.action}
                bookId={book.bookId}
                bookPath={bookPath}
                buyAction={buyEbookAction.bind(null, locale, book.bookId, book.slug)}
                copy={dictionary.catalog.actions}
                getFreeAction={getFreeEbookAction.bind(null, locale, book.bookId, book.slug)}
                locale={locale}
                signedIn={book.signedIn}
              />
            </div>
          </div>
        }
        initialLocator={null}
        libraryHref={bookPath}
        manifestUrl={`/api/samples/${book.publicationId}/manifest`}
        mode="sample"
        publicationId={book.publicationId}
        signInHref={routes.signInFor(bookPath)}
      />
    </main>
  );
}
```

Confirm the relative import path to `books/[slug]/actions` resolves from this file's location; use
the `@/app/...` alias if it does not.

Delete the now-stale comment in `lib/i18n/routes.ts`:

```ts
    sample: (slug: string) => withLocale(locale, `/read-sample/${slug}`),
```

- [ ] **Step 6: Test the one untested reader handler**

Create `app/api/reader/publications/[publicationId]/manifest/route.test.ts`. This handler had no test
before S4 and the TOC drawer now depends on the `toc` it returns. Follow the shape of
`app/api/samples/[publicationId]/manifest/route.test.ts` exactly, covering:

- an unauthenticated caller gets 401 and no database access happens;
- a caller with no session id gets 404;
- a `ReaderAccessDeniedError` from `authorizeReaderSession` gets 404 with the single body;
- a `ReaderUnavailableError` gets 502 with `{ error: "Failed to load resource." }`;
- a success returns the manifest with `Content-Type: application/webpub+json`,
  `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, and a `toc` in the body.

- [ ] **Step 7: Run the tests and commit**

Run: `npx vitest run lib/reader/session.test.ts lib/data/catalog.test.ts lib/auth/route-access.test.ts "app/api/reader/publications/[publicationId]/manifest/route.test.ts" && npm run check`
Expected: PASS.

```bash
git add lib/reader/session.ts lib/reader/session.test.ts lib/data/catalog.ts lib/data/catalog.test.ts "app/[locale]/(public)/read-sample" lib/auth/route-access.test.ts lib/i18n/routes.ts "app/api/reader/publications/[publicationId]/manifest/route.test.ts"
git commit -m "feat(reader): add the public sample reader"
```

---

### Task 10: End-to-end journeys

**Files:**
- Create: `e2e/support/publication.ts`
- Modify: `e2e/ebook-golden-path.spec.ts` (imports the extracted helpers)
- Create: `e2e/reader-completion.spec.ts`

**Interfaces:**
- Consumes: `createServiceRoleClient` from `e2e/support/supabase.ts`; the real CLI `npm run ebook -- process --asset <id>`; the EPUB-building code currently inline in `e2e/ebook-golden-path.spec.ts`.
- Produces:
  - `buildFixtureEpub(options): Buffer` — the two-chapter fixture, moved verbatim.
  - `seedProcessedBook(options: { suffix: string; localizations; priceMinor?: number }): Promise<{ bookId: string; publicationId: string; slug: string; title: string }>` — a published book with a real processed EPUB and a sample allowlist.
  - `grantEntitlement(bookId: string, email: string): Promise<void>`.

- [ ] **Step 1: Read the golden path and extract, changing nothing**

Read `e2e/ebook-golden-path.spec.ts` in full. Move the EPUB-building code (the `fflate` fixture
generation, currently around lines 27–140) into `e2e/support/publication.ts` as `buildFixtureEpub`,
**byte for byte** — the two-chapter asymmetry (24 paragraphs versus 12) is a load-bearing
precondition of that spec's paging assertions, and its SVG-free constraint is what keeps the
processor from rejecting the fixture outright.

Then write `seedProcessedBook`, which does with the service role and the CLI what the golden path
does through the admin UI:

```ts
// A published book with a REAL processed publication. Seeded catalog books (e2e/support/catalog.ts)
// cannot render: their manifest_key names an object that was never uploaded, so the reader gets a
// 502 and the sample manifest gets one too. Any test that needs the engine to actually paint needs
// this instead.
//
// This deliberately does NOT drive the admin UI. e2e/ebook-golden-path.spec.ts is the test of that
// path and keeps doing it through the browser; every other spec only needs the artefact.
export async function seedProcessedBook(options: {
  suffix: string;
  localizations: Partial<Record<"vi" | "en", { slug: string; title: string }>>;
  priceMinor?: number;
}): Promise<{ bookId: string; publicationId: string; slug: string; title: string }> {
  // 1. Seed author, book, localizations, edition, sku, offer, cover, media_assets - the same rows
  //    e2e/support/catalog.ts seeds. Reuse seedCatalogBook for this half if its shape allows, and
  //    otherwise repeat only the rows needed here.
  // 2. Upload buildFixtureEpub() to the private `ebook-source` bucket and insert the ebook_assets
  //    row pointing at that key.
  // 3. Insert the processing_jobs row the worker claims.
  // 4. execFileSync("npm", ["run", "ebook", "--", "process", "--asset", assetId], { env: process.env })
  //    - the real command from docs/runbooks/epub-processing.md, exactly as the golden path runs it.
  // 5. Publish the publication and then the book, through the same RPCs the admin UI calls.
  // 6. Read back the publication id and assert book_samples.allowed_hrefs is non-empty, so a
  //    failure here is reported as a seeding failure rather than as a mysteriously empty sample.
}
```

Fill in each numbered step with the real calls by copying them from `ebook-golden-path.spec.ts` and
`docs/runbooks/epub-processing.md`. Do not invent RPC names — read them out of the golden path.

- [ ] **Step 2: Point the golden path at the extracted helper**

Change `e2e/ebook-golden-path.spec.ts` to import `buildFixtureEpub` from `./support/publication`
instead of building the EPUB inline. Change nothing else in that file.

- [ ] **Step 3: Run the golden path to prove the extraction changed nothing**

Export the Supabase and Mailpit variables per `docs/runbooks/testing-environments.md`, then:

Run: `npx playwright test e2e/ebook-golden-path.spec.ts`
Expected: PASS, unchanged. If it fails, the extraction was not verbatim — revert and redo it rather
than adjusting the spec.

- [ ] **Step 4: Write the S4 journeys**

Create `e2e/reader-completion.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

import { seedProcessedBook } from "./support/publication";
import { createServiceRoleClient } from "./support/supabase";
// Sign-in helper: use whatever e2e/ebook-golden-path.spec.ts and e2e/checkout.spec.ts already use
// (magic link through Mailpit). Do not write a second one.

// Ground truth for a position is always the saved locator in reading_progress, never rendered text:
// Readium preloads adjacent chapters, so the DOM lies about which chapter is current. The golden
// path's activeChapterContains() helper is the tool for asking what is actually on screen.

test("a reader sets typography, navigates by contents, and finishes the book", async ({ page }) => {
  // 1. seedProcessedBook + grantEntitlement, sign in, open /en/read/<bookId>.
  // 2. Open the settings panel, raise the font size twice and choose the wide column.
  // 3. Reload. Assert reading_progress.locator_json's href is unchanged - this is the exit
  //    criterion that a typography or WIDTH change does not lose the reader's place.
  // 4. Open the contents drawer, choose chapter 2, and assert the top bar names it.
  // 5. Page to the end and assert, by polling reading_progress, that total_progression >= 0.99
  //    and library_items.state is 'completed'; then assert the completion card is visible and the
  //    library lists the book as finished.
});

test("settings and contents are usable at 390, 768 and 1440", async ({ page }) => {
  // Same seeded book. For each viewport: open each panel, assert its dialog is visible, operate one
  // control, and close it with Escape.
});

test("a revoked entitlement shows the lost-access state", async ({ page }) => {
  // Open the reader, revoke the entitlement with the service role, force a protected request
  // (turn a page), and assert the "You no longer have access to this book." state with its library
  // link. Assert the retryable "This book could not be opened." message is NOT shown.
});

test("the sample reader serves an anonymous visitor and nothing beyond the allowlist", async ({ page, request }) => {
  // 1. seedProcessedBook, then open /en/read-sample/<slug> with no session at all.
  // 2. Assert the reading region appears and NO request to /api/reader/* was made (listen on
  //    page.on("request")).
  // 3. Read book_samples.allowed_hrefs and ebook_resources with the service role; pick a resource
  //    whose access_class is not 'sample' and assert GET /api/samples/<pub>/resources/<href>
  //    returns 404 - not 401, and not 200.
  // 4. Assert the end-of-sample control renders the book's action.
});

test("a book with no sample has no sample page", async ({ page }) => {
  // seedCatalogBook without withSample, then expect /en/read-sample/<slug> to respond 404.
});
```

Replace each comment block with real Playwright code. Follow `e2e/checkout.spec.ts` for sign-in and
service-role assertions, and `e2e/ebook-golden-path.spec.ts` for anything that inspects the engine.

- [ ] **Step 5: Run the suite**

Run: `npx playwright test e2e/reader-completion.spec.ts`
Expected: PASS. Then run the whole suite: `npm run check:full`.

The reader path changed and `read-sample` is a new public route, so `check:full` is required by
AGENTS.md here, not optional.

- [ ] **Step 6: Commit**

```bash
git add e2e/support/publication.ts e2e/ebook-golden-path.spec.ts e2e/reader-completion.spec.ts
git commit -m "test(e2e): cover reader settings, contents, completion, and the sample"
```

---

### Task 11: Documentation

**Files:**
- Create: `docs/runbooks/reader-corpus-matrix.md`
- Modify: `docs/adr/ADR-005-reader-engine.md`
- Modify: `docs/runbooks/golden-path-validation.md`
- Modify: `docs/runbooks/storefront.md`

**Interfaces:**
- Consumes: ADR-005 §"What this decision does not rest on", which is the authoritative list of what the matrix must measure.
- Produces: the runbook S6 needs in order to move ADR-005 out of Provisional.

- [ ] **Step 1: Write the corpus matrix runbook**

Create `docs/runbooks/reader-corpus-matrix.md`. It is owner-run, not automated. It must contain:

- **Why it exists.** ADR-005 is Provisional. Its evidence is automated only: desktop Chrome, one
  generated two-chapter fixture, and a mocked navigator. Every row below is currently unmeasured,
  and Issue #1's exit criteria stay formally open until they are not.
- **What you need.** The five private EPUBs in `fixtures/epub/private/` (never committed; `*.epub` is
  git-ignored repo-wide), a local Supabase stack, and the processing runbook.
- **Setup.** Per `docs/runbooks/epub-processing.md`: create the book in `/admin`, upload the EPUB,
  run `npm run ebook -- process --asset <id>`, preview, publish, grant yourself access.
- **A processor-rejection note.** An EPUB containing any SVG manifest item is rejected **whole** by
  `lib/epub/process.ts`'s media-type allowlist. SVG cover wrappers are common in real EPUBs. A book
  that fails this way has failed for a **processor** reason, not an engine reason — record it as
  such, because it does not count against Readium and must not trigger ADR-005's epub.js fallback.
- **The matrix.** A table with one row per (EPUB × browser) and these columns, taken from ADR-005:
  render fidelity, embedded fonts, images, long-chapter performance, internal links, TOC
  navigation, typography change applied to real content, **width change applied to real content**,
  reload restore, sample boundary, and time to first page. Browsers: desktop Chrome, Safari,
  Firefox, mobile Chrome, mobile Safari.
- **How to judge each column**, in one line each, so two people fill it in the same way.
- **What to do with the result.** All rows pass → S6 moves ADR-005 to Accepted. A blocking WebKit or
  Firefox defect, or repeated render failures → ADR-005's reopeners apply and the epub.js fallback is
  considered. Either way the filled table is linked from `docs/launch/go-no-go.md`.

- [ ] **Step 2: Update ADR-005**

Add `getTableOfContents` to the boundary description, with the two-engine justification (Readium
`publication.toc`; epub.js `book.navigation.toc`), and record the `width` preference as deliberately
outside the boundary. Restate the no-listeners property as a **constraint on future navigation
surfaces** rather than an observation. Point the "untested" section at the new runbook. Do not change
the ADR's status — that is S6's decision and it needs the matrix result first.

- [ ] **Step 3: Update the other two runbooks**

- `docs/runbooks/golden-path-validation.md`: replace its browser-matrix prose with a pointer to
  `reader-corpus-matrix.md` so there is one list of rows, not two that can drift.
- `docs/runbooks/storefront.md`: add `/{locale}/read-sample/<slug>` to the URL table, with its 404
  conditions (no localization in that locale, book not published, no active publication, empty sample
  allowlist) and a note that it is public but `noindex`.

- [ ] **Step 4: Commit**

```bash
git add docs/runbooks/reader-corpus-matrix.md docs/adr/ADR-005-reader-engine.md docs/runbooks/golden-path-validation.md docs/runbooks/storefront.md
git commit -m "docs: add the reader corpus matrix runbook and update ADR-005"
```

---

## Gate: before opening the pull request

- [ ] `npm run db:reset && npm run db:test` on a clean local stack — all pgTAP files pass.
- [ ] `npm run check:full` passes.
- [ ] Confirm by hand, because no test asserts it: the reader route's client bundle still contains no
      Readium code, and `components/ui/dialog.tsx` did not pull base-ui into a route that had none.
      Compare `.next` chunk sizes against `main` if anything looks suspect.
- [ ] Re-read the spec's §9 exit criteria and tick each one against a test that proves it.
- [ ] `git status` is clean apart from intended files — never stage `cmd.txt`, `.env.local`,
      `docs/ref/`, or any `.epub`.
