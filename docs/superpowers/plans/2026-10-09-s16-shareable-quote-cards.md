# S16 Shareable Quote Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pressing Share in the reader stores the attributed quote as a public card at `/{locale}/q/[code]` with an Open Graph image, and the share sheet receives that URL instead of the bare book URL; the reader manages their cards in the library and an admin can take one down.

**Architecture:** One migration adds `shared_quotes` (writes only through definer RPCs, no direct reads) plus two analytics event names and a `shared_quote_id` column. The reader's existing session-authorized API gains `POST /api/reader/quotes`, which calls `create_shared_quote` with the publication id from the authorized context, so the client never names a book. The toolbar gets one optional callback, `createShareUrl`, and falls back to the S5.5 payload when it fails. The card page is dynamic, `noindex, follow`, reuses the public book card loader and `ViewerBookAction`, and has a sibling `opengraph-image.tsx`. Views are counted from `analytics_events` (`view_quote`, sent by the existing beacon), so no counter column exists.

**Tech Stack:** Next.js 16 App Router (`next/og` ImageResponse, dynamic metadata), React 19, Supabase/Postgres/RLS, TypeScript, Zod, Vitest, pgTAP, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-09-s16-shareable-quote-cards-design.md`

## Spec corrections (2026-10-09)

Decided while planning against the live code; the spec file is updated to match.

- **Error codes.** S13 already uses `EB036` (stale review revision) and `EB037` (answer delivery in progress). S16 uses `EB038` for the cap and `EB039` for every other refusal. S17 moves its cap code to `EB040`.
- **No `view_count` column, no `count_quote_view` RPC.** The card page sends `view_quote` through the existing browser beacon (anonymous, quota-bounded, deduped by client event id). The owner's view count is `count(*)` over `analytics_events` for the quote, computed inside `my_shared_quotes`. One fewer write path, and the S5 rule that a server render is not a view holds.
- **RPC input is the publication, not the book.** `create_shared_quote(p_publication_id, p_quote, p_locale)` derives `book_id` from `ebook_publications`; the route hands it the publication id from `requireReaderRequestContext`, so a client cannot pass a book id it does not hold.
- **No direct table reads.** Every read is a definer RPC (`catalog_shared_quote`, `my_shared_quotes`, `admin_list_shared_quotes`), matching where S13 ended up for reviews. RLS is enabled with no grants.
- **Unpublished book.** The card 404s, exactly as the book page does, instead of rendering the quote without an action. Nothing about the book is revealed either way, and one path is less code.
- **Code length.** 10 base64url characters from `gen_random_bytes(8)` truncated, so 60 random bits, not 64.
- **Admin surface.** `/admin/quotes` lists the newest 200 active cards with a `?book=` filter and a Remove control; the book editor links to the filtered list. No count on the editor page.
- **`share_quote` analytics** is written by the RPC in the same transaction as the row, keyed `share/<quote id>`, not by the browser.

## Global Constraints

- Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/opengraph-image.md` and `node_modules/next/dist/docs/01-app/02-guides/server-actions.md` before Tasks 5 and 6.
- Customer routes stay under `/{locale}` for `vi` and `en`. `/{locale}/q/[code]` is public and lives in the `(public)` route group; `/{locale}/library/quotes` lives in `(account)` so it inherits `noindex`. `/admin/quotes` is unprefixed.
- Every protected page and Server Action calls `requireUser()` or `requireAdmin()` itself. The reader route uses `requireReaderRequestContext`.
- The quote is at most `MAX_BOOK_QUOTE_GRAPHEMES` (300) grapheme clusters, non-empty after trim, and rejects `/<\/?[a-z][^>]*>/i`. SQL guards bytes (`length(btrim(quote)) between 1 and 1200`) and the tag rule; the grapheme rule is enforced in the route with the shared helper.
- A profile holds at most 200 active cards; the 201st is `EB038`. Every other refusal is `EB039`.
- `analytics_events` keeps its no-free-text rule: `share_quote` and `view_quote` carry `shared_quote_id`, `book_id`, `profile_id`, `locale` only.
- Logs carry request IDs and codes, never the quote text.
- Migration: `supabase/migrations/20261009110000_s16_shared_quotes.sql`. pgTAP: `supabase/tests/067_s16_shared_quotes.sql`. Regenerate `lib/supabase/database.types.ts` after the migration against a reset local stack.
- Dictionary keys go in both `en.json` and `vi.json`; `lib/i18n/dictionary.test.ts` enforces parity. New reader copy keys also go in `lib/reader/copy.ts` and the copy literal in `components/reader/reader-client.test.tsx`.
- Docker context is OrbStack. Node 22.14 for Playwright, scratch stack, app on `:3100`.
- Final gate: `npm run check`, `npm run db:reset && npm run db:test`, `npm run check:full`.

## Review Focus

1. A reader shares while offline or after revocation: the share sheet must still open with the S5.5 text and the canonical book URL, and no error toast. Pinned in Task 4.
2. A card whose book is later unpublished, or whose row is removed, must 404 on both the page and the image route, and the code must never be reissued. Pinned in Task 1 (RPC) and Task 5 (page).
3. A quote of exactly 300 graphemes with Vietnamese combining marks must round-trip the route, the SQL byte limit, and the card title cut without splitting a cluster. Pinned in Task 2 and Task 4.
4. A visitor opens a card in the other locale (`/en/q/<vi code>`): the card renders in its own locale and does not redirect, and the card loader must not 404 merely because the path locale differs. Pinned in Task 5.
5. Two concurrent shares from the same reader at the cap must not both succeed; the RPC counts under a row lock on the profile. Pinned in Task 1.

## File Structure

| Area | Files and responsibility |
| --- | --- |
| Schema | `supabase/migrations/20261009110000_s16_shared_quotes.sql`, `supabase/tests/067_s16_shared_quotes.sql`: table, RPCs, analytics names and column. |
| Quote and analytics contracts | `lib/reader/quote.ts` (+ `truncateBookQuote`), `lib/analytics/browser.ts`, `lib/analytics/events.ts`, `app/api/analytics/events/route.ts` and tests. |
| Data access | `lib/data/shared-quotes.ts` and `.test.ts`: reader, public, and admin functions. |
| Reader API and toolbar | `app/api/reader/quotes/route.ts` and `.test.ts`, `components/reader/reader-selection-toolbar.tsx` and `.test.tsx`, `components/reader/reader-client.tsx`, `lib/reader/copy.ts`, dictionaries. |
| Card page | `app/[lang]/(public)/q/[code]/page.tsx`, `page.test.tsx`, `opengraph-image.tsx`, `lib/i18n/routes.ts` (`quoteCard`), dictionaries. |
| Library | `app/[lang]/(account)/library/quotes/page.tsx`, `actions.ts`, `components/account/shared-quote-list.tsx` and test, library page link, dictionaries. |
| Admin | `lib/data/admin-shared-quotes.ts`, `app/admin/quotes/page.tsx`, `actions.ts`, `components/admin/quotes/quote-list.tsx` and test, `components/admin/admin-nav.tsx` and test, book editor link. |
| Verification and docs | `e2e/shareable-quotes.spec.ts`, `e2e/reader-depth.spec.ts` (share assertion), `docs/runbooks/reader-depth.md`. |

---

### Task 1: Schema and RPCs

**Files:**
- Create: `supabase/migrations/20261009110000_s16_shared_quotes.sql`
- Create: `supabase/tests/067_s16_shared_quotes.sql`
- Modify: `lib/supabase/database.types.ts` (regenerate)

**Interfaces:**
- Produces table `public.shared_quotes`.
- Produces `create_shared_quote(p_publication_id uuid, p_quote text, p_locale text) returns jsonb` → `{ id, code }`.
- Produces `remove_shared_quote(p_code text) returns void` (owner), `admin_remove_shared_quote(p_code text) returns void`.
- Produces `catalog_shared_quote(p_code text) returns jsonb | null` → `{ id, code, quote, locale, bookId, createdAt }`.
- Produces `my_shared_quotes() returns jsonb` → array of `{ id, code, quote, locale, bookId, bookTitle, createdAt, viewCount }`.
- Produces `admin_list_shared_quotes(p_book_id uuid) returns jsonb | null` → array of `{ id, code, quote, locale, bookId, bookTitle, ownerEmail, createdAt, viewCount }` (null when not admin; `p_book_id` null lists all).
- `analytics_events.event_name` accepts `share_quote` and `view_quote`; new column `shared_quote_id uuid`.

- [ ] **Step 1: Write the failing pgTAP file**

```sql
begin;
select plan(31);

-- S16 shared quote cards: entitlement-gated creation through the publication, random codes, a
-- per-profile cap, public reads of active cards of published books only, owner and admin removal
-- that never reissues a code, and a share_quote analytics row written with the card.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e1600000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's16-owner@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e1600000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's16-stranger@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e1600000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 's16-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'e1600000-0000-0000-0000-000000000003';

insert into public.authors (id, canonical_slug, display_name, status)
values ('e1630000-0000-0000-0000-000000000001', 's16-author', 'S16 Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values ('e1620000-0000-0000-0000-000000000001', 's16-book', 'vi', 'e1630000-0000-0000-0000-000000000001', 'published');
insert into public.book_localizations (book_id, locale, slug, title)
values ('e1620000-0000-0000-0000-000000000001', 'vi', 's16-book', 'Sách S16');
-- Publication chain as reader_annotations.test.sql seeds it: edition -> asset -> publication.
insert into public.editions (id, book_id, language_code)
values ('e1610000-0000-0000-0000-000000000001', 'e1620000-0000-0000-0000-000000000001', 'vi');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
values ('e1660000-0000-0000-0000-000000000001', 'e1610000-0000-0000-0000-000000000001', 's16/live.epub', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status)
values ('e1640000-0000-0000-0000-000000000001', 'e1660000-0000-0000-0000-000000000001', 1, 's16/live.json', 'published');
update public.books set active_publication_id = 'e1640000-0000-0000-0000-000000000001' where id = 'e1620000-0000-0000-0000-000000000001';
insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason, status)
select 'e1650000-0000-0000-0000-000000000001', p.id, 'e1620000-0000-0000-0000-000000000001', 'admin_grant', p.id, 'fixture', 'active'
from public.profiles p where p.auth_user_id = 'e1600000-0000-0000-0000-000000000001';

-- Privileges --------------------------------------------------------------------------------------
select is(has_table_privilege('anon', 'public.shared_quotes', 'select'), false, 'anon cannot read the table');
select is(has_table_privilege('authenticated', 'public.shared_quotes', 'select'), false, 'authenticated cannot read the table');
select is(has_function_privilege('anon', 'public.catalog_shared_quote(text)', 'execute'), true, 'anon can read a card through the RPC');
select is(has_function_privilege('anon', 'public.create_shared_quote(uuid, text, text)', 'execute'), false, 'anon cannot create');

-- Creation ----------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1600000-0000-0000-0000-000000000002', true);
select throws_ok($$select public.create_shared_quote('e1640000-0000-0000-0000-000000000001', 'Một câu.', 'vi')$$, 'EB039', null, 'a stranger cannot share');
select set_config('request.jwt.claim.sub', 'e1600000-0000-0000-0000-000000000001', true);
select throws_ok($$select public.create_shared_quote('e1640000-0000-0000-0000-000000000001', '   ', 'vi')$$, 'EB039', null, 'an empty quote is refused');
select throws_ok($$select public.create_shared_quote('e1640000-0000-0000-0000-000000000001', '<b>x</b>', 'vi')$$, 'EB039', null, 'html is refused');
select throws_ok($$select public.create_shared_quote('e1640000-0000-0000-0000-000000000001', repeat('x', 1201), 'vi')$$, 'EB039', null, 'an over-long quote is refused');
select throws_ok($$select public.create_shared_quote('e1640000-0000-0000-0000-000000000001', 'x', 'ja')$$, 'EB039', null, 'an unknown locale is refused');
select throws_ok($$select public.create_shared_quote('e1640000-0000-0000-0000-0000000000ff', 'x', 'vi')$$, 'EB039', null, 'an unknown publication is refused with the same code');

create temporary table t_created as
select public.create_shared_quote('e1640000-0000-0000-0000-000000000001', '  Một câu đáng nhớ.  ', 'vi') as card;
select matches((select card ->> 'code' from t_created), '^[A-Za-z0-9_-]{10}$', 'the code is 10 base64url characters');
reset role;
select results_eq(
  $$select q.quote, q.locale, q.status, q.book_id from public.shared_quotes q where q.code = (select card ->> 'code' from t_created)$$,
  $$values ('Một câu đáng nhớ.', 'vi', 'active', 'e1620000-0000-0000-0000-000000000001'::uuid)$$,
  'the row is trimmed, active, and tied to the publication''s book');
select results_eq(
  $$select e.event_name, e.book_id, e.locale, e.shared_quote_id::text from public.analytics_events e where e.dedupe_key = 'share/' || (select card ->> 'id' from t_created)$$,
  $$values ('share_quote', 'e1620000-0000-0000-0000-000000000001'::uuid, 'vi', (select card ->> 'id' from t_created))$$,
  'creation writes one share_quote event carrying ids only');

-- Public read -------------------------------------------------------------------------------------
set local role anon;
select is((select public.catalog_shared_quote((select card ->> 'code' from t_created)) ->> 'quote'), 'Một câu đáng nhớ.', 'anon reads the active card');
select is(public.catalog_shared_quote('nope-nope-'), null, 'an unknown code is null');
reset role;

-- Cap ---------------------------------------------------------------------------------------------
insert into public.shared_quotes (code, book_id, publication_id, profile_id, quote, locale)
select 'cap' || lpad(g::text, 7, '0'), 'e1620000-0000-0000-0000-000000000001', 'e1640000-0000-0000-0000-000000000001', p.id, 'cap ' || g, 'vi'
from generate_series(1, 199) g, public.profiles p where p.auth_user_id = 'e1600000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1600000-0000-0000-0000-000000000001', true);
select throws_ok($$select public.create_shared_quote('e1640000-0000-0000-0000-000000000001', 'one more', 'vi')$$, 'EB038', null, 'the 201st active card is refused');

-- Owner list and removal --------------------------------------------------------------------------
select is(jsonb_array_length(public.my_shared_quotes()), 200, 'the owner lists their cards');
select is((select e ->> 'viewCount' from jsonb_array_elements(public.my_shared_quotes()) e where e ->> 'code' = (select card ->> 'code' from t_created)), '0', 'a fresh card has zero views');
reset role;
insert into public.analytics_events (event_name, shared_quote_id, book_id, locale)
select 'view_quote', (card ->> 'id')::uuid, 'e1620000-0000-0000-0000-000000000001', 'vi' from t_created;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1600000-0000-0000-0000-000000000001', true);
select is((select e ->> 'viewCount' from jsonb_array_elements(public.my_shared_quotes()) e where e ->> 'code' = (select card ->> 'code' from t_created)), '1', 'views come from analytics');
select set_config('request.jwt.claim.sub', 'e1600000-0000-0000-0000-000000000002', true);
select lives_ok($$select public.remove_shared_quote((select card ->> 'code' from t_created))$$, 'a stranger''s removal is a silent no-op');
reset role;
select results_eq($$select status from public.shared_quotes where code = (select card ->> 'code' from t_created)$$, array['active'], 'the stranger changed nothing');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1600000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.remove_shared_quote((select card ->> 'code' from t_created))$$, 'the owner removes');
select is(public.catalog_shared_quote((select card ->> 'code' from t_created)), null, 'a removed card is gone from the public read');
select lives_ok($$select public.create_shared_quote('e1640000-0000-0000-0000-000000000001', 'room again', 'vi')$$, 'removing frees a slot under the cap');
reset role;
select results_eq($$select removed_by from public.shared_quotes where code = (select card ->> 'code' from t_created)$$, array['owner'], 'removal records who removed');

-- Admin -------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1600000-0000-0000-0000-000000000001', true);
select is(public.admin_list_shared_quotes(null), null, 'a reader gets null from the admin list');
select throws_ok($$select public.admin_remove_shared_quote('cap0000001')$$, '42501', null, 'a reader cannot take down');
select set_config('request.jwt.claim.sub', 'e1600000-0000-0000-0000-000000000003', true);
select is(jsonb_array_length(public.admin_list_shared_quotes('e1620000-0000-0000-0000-000000000001')), 200, 'the admin lists active cards for a book');
select lives_ok($$select public.admin_remove_shared_quote('cap0000001')$$, 'the admin takes a card down');
select results_eq(
  $$select action, entity_type, (metadata ? 'quote')::text from public.audit_logs where entity_id = (select id from public.shared_quotes where code = 'cap0000001')$$,
  $$values ('shared_quote.remove'::text, 'shared_quotes'::text, 'false')$$, 'one audit row, no quote text');
reset role;

-- Unpublished book --------------------------------------------------------------------------------
update public.books set status = 'draft' where id = 'e1620000-0000-0000-0000-000000000001';
select is(public.catalog_shared_quote('cap0000002'), null, 'a card of an unpublished book is not readable');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `docker context use orbstack && npm run db:reset && npx supabase test db supabase/tests/067_s16_shared_quotes.sql`
Expected: FAIL at the first privilege check (`relation "public.shared_quotes" does not exist`). If the fixture inserts themselves fail on a column name, copy the publication fixture from `supabase/tests/reader_annotations.test.sql` and re-run before writing the migration.

- [ ] **Step 3: Write the migration**

```sql
-- S16 shared quote cards (spec 2026-10-09-s16). A row exists only because an entitled reader pressed
-- Share. No role reads the table; every read and write is a definer RPC. Error codes: EB038 cap,
-- EB039 everything else (one code so a publication id cannot be probed by the error it produces).

create table public.shared_quotes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Za-z0-9_-]{10}$'),
  book_id uuid not null references public.books(id) on delete cascade,
  publication_id uuid references public.ebook_publications(id) on delete set null,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  -- Bytes here; the 300-grapheme rule is the route's, with the shared helper.
  quote text not null check (length(btrim(quote)) between 1 and 1200 and quote !~* '</?[a-z][^>]*>'),
  locale text not null check (locale in ('vi', 'en')),
  status text not null default 'active' check (status in ('active', 'removed')),
  removed_by text check (removed_by is null or removed_by in ('owner', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'removed') = (removed_by is not null))
);
create index shared_quotes_owner_idx on public.shared_quotes (profile_id, created_at desc);
create index shared_quotes_book_idx on public.shared_quotes (book_id, status);
create trigger shared_quotes_touch_updated_at before update on public.shared_quotes
  for each row execute function public.touch_updated_at();
alter table public.shared_quotes enable row level security;
revoke all on public.shared_quotes from public, anon, authenticated;

-- Analytics: two names, one id column. No text.
alter table public.analytics_events
  add column shared_quote_id uuid references public.shared_quotes(id) on delete set null;
alter table public.analytics_events
  drop constraint analytics_events_event_name_check,
  add constraint analytics_events_event_name_check check (event_name in (
    'view_book', 'open_sample', 'begin_checkout', 'purchase', 'payment_failed',
    'open_reader', 'progress_25', 'progress_50', 'progress_75', 'progress_100',
    'change_reader_setting', 'view_library', 'book_published',
    'epub_job_started', 'epub_job_completed', 'epub_job_failed',
    'click_external_store', 'share_quote', 'view_quote'
  ));

create function public.shared_quote_json(q public.shared_quotes)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', q.id, 'code', q.code, 'quote', q.quote, 'locale', q.locale,
                            'bookId', q.book_id, 'createdAt', q.created_at);
$$;

create function public.create_shared_quote(p_publication_id uuid, p_quote text, p_locale text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_book_id uuid;
  v_quote text := btrim(coalesce(p_quote, ''));
  v_code text;
  v_row public.shared_quotes;
  v_try integer := 0;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'create_shared_quote: no profile' using errcode = 'EB039';
  end if;
  if length(v_quote) < 1 or length(v_quote) > 1200 or v_quote ~* '</?[a-z][^>]*>'
     or p_locale is null or p_locale not in ('vi', 'en') then
    raise exception 'create_shared_quote: invalid input' using errcode = 'EB039';
  end if;
  -- The publication must be the book's active, published one, and the caller must hold the book.
  -- A publication reaches its book through its asset's edition; there is no book_id on it.
  select b.id into v_book_id
  from public.ebook_publications pub
  join public.ebook_assets a on a.id = pub.ebook_asset_id
  join public.editions ed on ed.id = a.edition_id
  join public.books b on b.id = ed.book_id and b.active_publication_id = pub.id and b.status = 'published'
  where pub.id = p_publication_id and pub.status = 'published'
    and exists (select 1 from public.entitlements en
                where en.profile_id = v_profile_id and en.book_id = b.id and en.status = 'active');
  if v_book_id is null then
    raise exception 'create_shared_quote: not entitled' using errcode = 'EB039';
  end if;
  -- Lock the profile so two concurrent shares at the cap cannot both pass the count.
  perform 1 from public.profiles where id = v_profile_id for update;
  if (select count(*) from public.shared_quotes where profile_id = v_profile_id and status = 'active') >= 200 then
    raise exception 'create_shared_quote: cap reached' using errcode = 'EB038';
  end if;
  loop
    v_try := v_try + 1;
    v_code := substr(translate(encode(gen_random_bytes(8), 'base64'), '+/', '-_'), 1, 10);
    begin
      insert into public.shared_quotes (code, book_id, publication_id, profile_id, quote, locale)
      values (v_code, v_book_id, p_publication_id, v_profile_id, v_quote, p_locale)
      returning * into v_row;
      exit;
    exception when unique_violation then
      if v_try >= 3 then raise exception 'create_shared_quote: code collision' using errcode = 'EB039'; end if;
    end;
  end loop;
  insert into public.analytics_events (event_name, dedupe_key, profile_id, book_id, locale, shared_quote_id)
  values ('share_quote', 'share/' || v_row.id, v_profile_id, v_book_id, p_locale, v_row.id);
  return public.shared_quote_json(v_row);
end;
$$;

create function public.remove_shared_quote(p_code text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.shared_quotes q
  set status = 'removed', removed_by = 'owner'
  from public.profiles p
  where q.code = p_code and q.status = 'active' and q.profile_id = p.id and p.auth_user_id = auth.uid();
end;
$$;

create function public.admin_remove_shared_quote(p_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_remove_shared_quote: caller is not an admin' using errcode = '42501';
  end if;
  update public.shared_quotes set status = 'removed', removed_by = 'admin'
  where code = p_code and status = 'active' returning id into v_id;
  if v_id is null then
    raise exception 'admin_remove_shared_quote: no active card %', p_code using errcode = 'P0002';
  end if;
  select pr.id into v_actor from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor, 'shared_quote.remove', 'shared_quotes', v_id, '{}'::jsonb);
end;
$$;

-- Public: an active card of a published book. Null otherwise, whatever the reason.
create function public.catalog_shared_quote(p_code text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.shared_quote_json(q)
  from public.shared_quotes q
  join public.books b on b.id = q.book_id and b.status = 'published'
  where q.code = p_code and q.status = 'active';
$$;

create function public.my_shared_quotes()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((
    select jsonb_agg(public.shared_quote_json(q) || jsonb_build_object(
      'bookTitle', coalesce((select bl.title from public.book_localizations bl where bl.book_id = q.book_id order by bl.locale = q.locale desc limit 1), q.book_id::text),
      'viewCount', (select count(*) from public.analytics_events e where e.shared_quote_id = q.id and e.event_name = 'view_quote')
    ) order by q.created_at desc, q.id)
    from public.shared_quotes q
    join public.profiles p on p.id = q.profile_id
    where p.auth_user_id = auth.uid() and q.status = 'active'
  ), '[]'::jsonb);
$$;

create function public.admin_list_shared_quotes(p_book_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when not public.is_admin() then null else coalesce((
    select jsonb_agg(public.shared_quote_json(q) || jsonb_build_object(
      'bookTitle', coalesce((select bl.title from public.book_localizations bl where bl.book_id = q.book_id order by bl.locale = q.locale desc limit 1), q.book_id::text),
      'ownerEmail', (select ci.normalized_email from public.customer_identities ci where ci.profile_id = q.profile_id order by ci.created_at limit 1),
      'viewCount', (select count(*) from public.analytics_events e where e.shared_quote_id = q.id and e.event_name = 'view_quote')
    ) order by q.created_at desc, q.id)
    from (select * from public.shared_quotes where status = 'active' and (p_book_id is null or book_id = p_book_id)
          order by created_at desc limit 200) q
  ), '[]'::jsonb) end;
$$;

revoke execute on function public.create_shared_quote(uuid, text, text) from public, anon;
grant execute on function public.create_shared_quote(uuid, text, text) to authenticated;
revoke execute on function public.remove_shared_quote(text) from public, anon;
grant execute on function public.remove_shared_quote(text) to authenticated;
revoke execute on function public.admin_remove_shared_quote(text) from public, anon;
grant execute on function public.admin_remove_shared_quote(text) to authenticated;
revoke execute on function public.my_shared_quotes() from public, anon;
grant execute on function public.my_shared_quotes() to authenticated;
revoke execute on function public.admin_list_shared_quotes(uuid) from public, anon;
grant execute on function public.admin_list_shared_quotes(uuid) to authenticated;
revoke execute on function public.catalog_shared_quote(text) from public;
grant execute on function public.catalog_shared_quote(text) to anon, authenticated;
revoke execute on function public.shared_quote_json(public.shared_quotes) from public, anon, authenticated;
```

- [ ] **Step 4: Run the test**

Run: `npm run db:reset && npx supabase test db supabase/tests/067_s16_shared_quotes.sql`
Expected: PASS (31).

- [ ] **Step 5: Regenerate types, typecheck**

Run: `npx supabase gen types typescript --local > lib/supabase/database.types.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261009110000_s16_shared_quotes.sql supabase/tests/067_s16_shared_quotes.sql lib/supabase/database.types.ts
git commit -m "feat(s16): shared_quotes table and RPCs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Quote truncation helper and `view_quote` analytics

**Files:**
- Modify: `lib/reader/quote.ts`, `lib/reader/quote.test.ts`
- Modify: `lib/analytics/browser.ts`, `lib/analytics/events.ts`
- Modify: `app/api/analytics/events/route.ts`, `app/api/analytics/events/route.test.ts`

**Interfaces:**
- Produces `truncateBookQuote(text: string): { quote: string; truncated: boolean }` in `lib/reader/quote.ts`; `buildAttributedQuote` uses it.
- Produces browser event `{ eventName: "view_quote"; sharedQuoteId: string; bookId: string; locale }` and `TrackEventInput.sharedQuoteId`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/reader/quote.test.ts`:
```ts
import { truncateBookQuote } from "@/lib/reader/quote";

it("truncateBookQuote keeps 300 grapheme clusters and reports the cut", () => {
  const cluster = "ế"; // e + circumflex + acute as one grapheme
  expect(truncateBookQuote(cluster.repeat(300))).toEqual({ quote: cluster.repeat(300), truncated: false });
  const cut = truncateBookQuote(cluster.repeat(301));
  expect(cut.truncated).toBe(true);
  expect(Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(cut.quote)).length).toBe(300);
});
```

In `app/api/analytics/events/route.test.ts`, find the existing `click_external_store` acceptance test and add beside it (same helper names the file already uses for posting a body and reading the insert):
```ts
it("accepts an anonymous view_quote with the quote and book ids and nothing else", async () => {
  const response = await post({ eventId: EVENT_ID, eventName: "view_quote", sharedQuoteId: QUOTE_ID, bookId: BOOK_ID, locale: "vi" });
  expect(response.status).toBe(202);
  expect(insert).toHaveBeenCalledWith(expect.objectContaining({ event_name: "view_quote", shared_quote_id: QUOTE_ID, book_id: BOOK_ID }));
});

it("refuses a view_quote carrying the quote text", async () => {
  const response = await post({ eventId: EVENT_ID, eventName: "view_quote", sharedQuoteId: QUOTE_ID, bookId: BOOK_ID, locale: "vi", quote: "x" });
  expect(response.status).toBe(400);
});
```
Define `QUOTE_ID` as any 8-4-4-4-12 hex string next to the file's existing id constants.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run lib/reader/quote.test.ts app/api/analytics/events/route.test.ts`
Expected: FAIL: `truncateBookQuote` is not exported; `view_quote` is a 400.

- [ ] **Step 3: Implement**

`lib/reader/quote.ts`:
```ts
export function truncateBookQuote(text: string): { quote: string; truncated: boolean } {
  const units = splitGraphemes(text);
  return { quote: units.slice(0, MAX_BOOK_QUOTE_GRAPHEMES).join(""), truncated: units.length > MAX_BOOK_QUOTE_GRAPHEMES };
}

export function buildAttributedQuote(input: { selection: string; title: string; author: string; canonicalBookUrl: string }): { text: string; truncated: boolean } {
  const { quote, truncated } = truncateBookQuote(input.selection);
  return { text: `“${quote}”\n— ${input.title}, ${input.author}\n${input.canonicalBookUrl}`, truncated };
}
```

`lib/analytics/browser.ts`, in `BrowserEventInput`:
```ts
  | { eventName: "view_quote"; sharedQuoteId: string; bookId: string; locale: Locale }
```

`lib/analytics/events.ts`: add `"share_quote"`, `"view_quote"` to `analyticsEventNames`; add `sharedQuoteId?: string;` to `TrackEventInput`; in `toRow`: `if (input.sharedQuoteId !== undefined) row.shared_quote_id = input.sharedQuoteId;`.

`app/api/analytics/events/route.ts`, in the discriminated union:
```ts
  z.strictObject({ eventName: z.literal("view_quote"), sharedQuoteId: id, bookId: id, ...common }),
```
Update the comment listing anonymous events to include `view_quote`, and the same comment in `lib/analytics/intake-quota.ts`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/reader lib/analytics app/api/analytics && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/reader/quote.ts lib/reader/quote.test.ts lib/analytics/browser.ts lib/analytics/events.ts lib/analytics/intake-quota.ts app/api/analytics/events/route.ts app/api/analytics/events/route.test.ts
git commit -m "feat(s16): quote truncation helper and view_quote analytics event

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Data access

**Files:**
- Create: `lib/data/shared-quotes.ts`, `lib/data/shared-quotes.test.ts`
- Create: `lib/data/admin-shared-quotes.ts`

**Interfaces:**
- Consumes the RPCs from Task 1.
- Produces:
  - `type SharedQuote = { id: string; code: string; quote: string; locale: Locale; bookId: string; createdAt: string }`
  - `type MySharedQuote = SharedQuote & { bookTitle: string; viewCount: number }`
  - `createSharedQuote(publicationId: string, quote: string, locale: Locale): Promise<SharedQuote>` (throws `SharedQuoteCapError` on `EB038`, `SharedQuoteRefusedError` on `EB039`)
  - `getSharedQuote(code: string): Promise<SharedQuote | null>` (public client, `cache`d)
  - `listMySharedQuotes(): Promise<MySharedQuote[]>`
  - `removeMySharedQuote(code: string): Promise<void>`
  - In `admin-shared-quotes.ts`: `type AdminSharedQuote = MySharedQuote & { ownerEmail: string | null }`, `listAdminSharedQuotes(bookId: string | null): Promise<AdminSharedQuote[]>`, `adminRemoveSharedQuote(code: string): Promise<void>`; both call `requireAdmin()` first.

- [ ] **Step 1: Write the failing test**

`lib/data/shared-quotes.test.ts`, modeled on `lib/data/reviews.test.ts`:
```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSharedQuote, getSharedQuote, listMySharedQuotes, removeMySharedQuote, SharedQuoteCapError, SharedQuoteRefusedError } from "@/lib/data/shared-quotes";
import { createPublicClient } from "@/lib/supabase/public";
import { createClient } from "@/lib/supabase/server";

vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/supabase/public", () => ({ createPublicClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const PUB_ID = "40000000-0000-4000-8000-000000000001";
const card = { id: "90000000-0000-4000-8000-000000000001", code: "AbCdEfGh12", quote: "Một câu.", locale: "vi", bookId: "30000000-0000-4000-8000-000000000001", createdAt: "2026-10-09T00:00:00+00:00" };

function rpcResult(data: unknown, error: { code?: string; message?: string } | null = null) {
  const rpc = vi.fn(async () => ({ data, error }));
  vi.mocked(createClient).mockResolvedValue({ rpc } as unknown as Awaited<ReturnType<typeof createClient>>);
  vi.mocked(createPublicClient).mockReturnValue({ rpc } as unknown as ReturnType<typeof createPublicClient>);
  return rpc;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("shared quote DAL", () => {
  it("creates through the publication and returns the card", async () => {
    const rpc = rpcResult(card);
    expect(await createSharedQuote(PUB_ID, "Một câu.", "vi")).toEqual(card);
    expect(rpc).toHaveBeenCalledWith("create_shared_quote", { p_publication_id: PUB_ID, p_quote: "Một câu.", p_locale: "vi" });
  });

  it("maps EB038 to the cap error and EB039 to the refused error", async () => {
    rpcResult(null, { code: "EB038" });
    await expect(createSharedQuote(PUB_ID, "x", "vi")).rejects.toBeInstanceOf(SharedQuoteCapError);
    rpcResult(null, { code: "EB039" });
    await expect(createSharedQuote(PUB_ID, "x", "vi")).rejects.toBeInstanceOf(SharedQuoteRefusedError);
  });

  it("reads a public card and returns null for an unknown code or an unparseable payload", async () => {
    const rpc = rpcResult(card);
    expect(await getSharedQuote("AbCdEfGh12")).toEqual(card);
    expect(rpc).toHaveBeenCalledWith("catalog_shared_quote", { p_code: "AbCdEfGh12" });
    rpcResult(null);
    expect(await getSharedQuote("nope")).toBeNull();
    rpcResult({ id: 1 });
    expect(await getSharedQuote("bad")).toBeNull();
  });

  it("refuses to look up a malformed code without calling the database", async () => {
    const rpc = rpcResult(card);
    expect(await getSharedQuote("../etc")).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("lists the owner's cards with view counts and removes by code", async () => {
    const rpc = rpcResult([{ ...card, bookTitle: "Sách", viewCount: 3 }]);
    expect(await listMySharedQuotes()).toEqual([{ ...card, bookTitle: "Sách", viewCount: 3 }]);
    rpcResult(null);
    await removeMySharedQuote("AbCdEfGh12");
    expect(rpc).toHaveBeenCalledWith("my_shared_quotes", {});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/data/shared-quotes.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`lib/data/shared-quotes.ts`:
```ts
import "server-only";

import { headers } from "next/headers";
import { cache } from "react";
import { z } from "zod";

import type { Locale } from "@/lib/i18n/config";
import { getRequestId } from "@/lib/observability/request-id";
import { createPublicClient } from "@/lib/supabase/public";
import { createClient } from "@/lib/supabase/server";

// S16 shared quote cards. Reads and writes go through definer RPCs; the table is granted to nobody.
const CAP_REACHED = "EB038";
const REFUSED = "EB039";
// The only shape a code can have. Anything else is answered without a round trip.
export const SHARED_QUOTE_CODE = /^[A-Za-z0-9_-]{10}$/;

export class SharedQuoteCapError extends Error {
  constructor() { super("Too many shared quotes."); this.name = "SharedQuoteCapError"; }
}
export class SharedQuoteRefusedError extends Error {
  constructor() { super("The quote could not be shared."); this.name = "SharedQuoteRefusedError"; }
}

const sharedQuoteSchema = z.object({
  id: z.string(),
  code: z.string().regex(SHARED_QUOTE_CODE),
  quote: z.string(),
  locale: z.enum(["vi", "en"]),
  bookId: z.string(),
  createdAt: z.string(),
});
const mySharedQuoteSchema = sharedQuoteSchema.extend({ bookTitle: z.string(), viewCount: z.coerce.number().int() });

export type SharedQuote = z.infer<typeof sharedQuoteSchema>;
export type MySharedQuote = z.infer<typeof mySharedQuoteSchema>;

function failure(operation: string, cause: unknown, requestId: string | null = null): Error {
  console.error("Shared quote operation failed.", {
    operation,
    code: (cause as { code?: string } | null)?.code ?? null,
    requestId,
  });
  return new Error(`${operation} failed.`, { cause });
}
async function requestFailure(operation: string, cause: unknown): Promise<Error> {
  return failure(operation, cause, getRequestId(await headers()));
}

export async function createSharedQuote(publicationId: string, quote: string, locale: Locale): Promise<SharedQuote> {
  const { data, error } = await (await createClient()).rpc("create_shared_quote", {
    p_publication_id: publicationId, p_quote: quote, p_locale: locale,
  });
  if (error?.code === CAP_REACHED) throw new SharedQuoteCapError();
  if (error?.code === REFUSED) throw new SharedQuoteRefusedError();
  if (error) throw await requestFailure("createSharedQuote", error);
  return sharedQuoteSchema.parse(data);
}

// Public, cookie-less. Null for unknown, removed, malformed, and unpublished alike.
export const getSharedQuote = cache(async (code: string): Promise<SharedQuote | null> => {
  if (!SHARED_QUOTE_CODE.test(code)) return null;
  const { data, error } = await createPublicClient().rpc("catalog_shared_quote", { p_code: code });
  if (error) throw failure("getSharedQuote", error);
  const parsed = sharedQuoteSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
});

export async function listMySharedQuotes(): Promise<MySharedQuote[]> {
  const { data, error } = await (await createClient()).rpc("my_shared_quotes", {});
  if (error) throw await requestFailure("listMySharedQuotes", error);
  return z.array(mySharedQuoteSchema).parse(data ?? []);
}

export async function removeMySharedQuote(code: string): Promise<void> {
  if (!SHARED_QUOTE_CODE.test(code)) return;
  const { error } = await (await createClient()).rpc("remove_shared_quote", { p_code: code });
  if (error) throw await requestFailure("removeMySharedQuote", error);
}
```

`lib/data/admin-shared-quotes.ts`:
```ts
import "server-only";

import { headers } from "next/headers";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/admin";
import { SHARED_QUOTE_CODE } from "@/lib/data/shared-quotes";
import { getRequestId } from "@/lib/observability/request-id";
import { createClient } from "@/lib/supabase/server";

// Admin takedown surface. requireAdmin() first; the RPCs re-check is_admin() themselves.
const adminSharedQuoteSchema = z.object({
  id: z.string(), code: z.string(), quote: z.string(), locale: z.enum(["vi", "en"]), bookId: z.string(),
  createdAt: z.string(), bookTitle: z.string(), ownerEmail: z.string().nullable(), viewCount: z.coerce.number().int(),
});
export type AdminSharedQuote = z.infer<typeof adminSharedQuoteSchema>;

async function failure(operation: string, cause: unknown): Promise<Error> {
  console.error("Shared quote admin operation failed.", {
    operation, code: (cause as { code?: string } | null)?.code ?? null, requestId: getRequestId(await headers()),
  });
  return new Error(`${operation} failed.`, { cause });
}

export async function listAdminSharedQuotes(bookId: string | null): Promise<AdminSharedQuote[]> {
  await requireAdmin();
  const { data, error } = await (await createClient()).rpc("admin_list_shared_quotes", { p_book_id: bookId ?? undefined });
  if (error) throw await failure("listAdminSharedQuotes", error);
  return z.array(adminSharedQuoteSchema).parse(data ?? []);
}

export async function adminRemoveSharedQuote(code: string): Promise<void> {
  await requireAdmin();
  if (!SHARED_QUOTE_CODE.test(code)) return;
  const { error } = await (await createClient()).rpc("admin_remove_shared_quote", { p_code: code });
  if (error && error.code !== "P0002") throw await failure("adminRemoveSharedQuote", error);
}
```
If the generated type for `admin_list_shared_quotes` makes `p_book_id` required and non-nullable, pass `p_book_id: bookId` and cast as the generator demands; the SQL accepts null.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run lib/data/shared-quotes.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/data/shared-quotes.ts lib/data/shared-quotes.test.ts lib/data/admin-shared-quotes.ts
git commit -m "feat(s16): shared quote data access

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Reader route and Share action

**Files:**
- Create: `app/api/reader/quotes/route.ts`, `app/api/reader/quotes/route.test.ts`
- Modify: `components/reader/reader-selection-toolbar.tsx`, `components/reader/reader-selection-toolbar.test.tsx`
- Modify: `components/reader/reader-client.tsx`, `components/reader/reader-client.test.tsx` (copy literal)
- Modify: `lib/reader/copy.ts`, `lib/i18n/dictionaries/en.json`, `vi.json`, `lib/i18n/routes.ts`

**Interfaces:**
- Produces `POST /api/reader/quotes?publicationId=<uuid>` with body `{ quote: string; locale: "vi" | "en" }` → `201 { code, url }` where `url` is the absolute card URL; `400` invalid; `401`/`404` per `readerApiErrorResponse`; `409 { error: "cap" }` on the cap; `502` on refusal or unavailability.
- Produces toolbar prop `createShareUrl?: (quote: string) => Promise<string | null>`.
- Produces `getCatalogRoutes(locale).quoteCard(code)` → `/{locale}/q/{code}`.
- Produces reader copy keys `shareCreated` (vi: "Đã tạo trang trích dẫn công khai. Bạn có thể xoá trong Thư viện.", en: "A public quote page was created. You can remove it from your library.").

- [ ] **Step 1: Add the route helper and copy keys**

`lib/i18n/routes.ts`, in `getCatalogRoutes`:
```ts
    // S16: a shared quote card. Public, noindex, not localized by the viewer's locale: the card
    // renders in the locale the quote was shared in.
    quoteCard: (code: string) => withLocale(locale, `/q/${encodeURIComponent(code)}`),
```
`lib/reader/copy.ts`: add `shareCreated: string;` after `shareUnavailable: string;`. Add the key to the `reader` block of both dictionaries and to the copy literal in `components/reader/reader-client.test.tsx`. Add `shareCreated: "Public quote page created"` to the `copy` constant in `reader-selection-toolbar.test.tsx`.

- [ ] **Step 2: Write the failing route test**

`app/api/reader/quotes/route.test.ts`, modeled on `app/api/reader/annotations/[annotationId]/route.test.ts` (same mocks for `requireReaderRequestContext` and `getServerEnv`):
```ts
// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/reader/quotes/route";
import { createSharedQuote, SharedQuoteCapError, SharedQuoteRefusedError } from "@/lib/data/shared-quotes";
import { requireReaderRequestContext, ReaderRequestUnauthorizedError } from "@/lib/reader/request-context";

vi.mock("@/lib/reader/request-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reader/request-context")>()),
  requireReaderRequestContext: vi.fn(),
}));
vi.mock("@/lib/data/shared-quotes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/shared-quotes")>()),
  createSharedQuote: vi.fn(),
}));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: () => ({ siteUrl: "https://books.example" }) }));

const PUB = "40000000-0000-4000-8000-000000000001";
const context = { profileId: "p1", publicationId: PUB, publicationVersion: 1, sessionId: "s1" };

function post(body: unknown, publicationId = PUB) {
  return POST(new NextRequest(`http://localhost/api/reader/quotes?publicationId=${publicationId}`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireReaderRequestContext).mockResolvedValue(context);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/reader/quotes", () => {
  it("creates the card with the authorized publication and returns the absolute card URL", async () => {
    vi.mocked(createSharedQuote).mockResolvedValue({ id: "q1", code: "AbCdEfGh12", quote: "x", locale: "vi", bookId: "b1", createdAt: "" });
    const response = await post({ quote: "Một câu.", locale: "vi" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ code: "AbCdEfGh12", url: "https://books.example/vi/q/AbCdEfGh12" });
    expect(createSharedQuote).toHaveBeenCalledWith(PUB, "Một câu.", "vi");
  });

  it("truncates to 300 graphemes before the database sees it", async () => {
    vi.mocked(createSharedQuote).mockResolvedValue({ id: "q1", code: "AbCdEfGh12", quote: "x", locale: "vi", bookId: "b1", createdAt: "" });
    await post({ quote: "ế".repeat(301), locale: "vi" });
    expect(vi.mocked(createSharedQuote).mock.calls[0][1]).toBe("ế".repeat(300));
  });

  it.each([
    ["empty", { quote: "  ", locale: "vi" }],
    ["html", { quote: "<b>x</b>", locale: "vi" }],
    ["bad locale", { quote: "x", locale: "ja" }],
    ["extra key", { quote: "x", locale: "vi", bookId: "b1" }],
  ])("returns 400 for %s", async (_name, body) => {
    expect((await post(body)).status).toBe(400);
    expect(createSharedQuote).not.toHaveBeenCalled();
  });

  it("returns 409 at the cap and 502 when refused", async () => {
    vi.mocked(createSharedQuote).mockRejectedValueOnce(new SharedQuoteCapError());
    expect((await post({ quote: "x", locale: "vi" })).status).toBe(409);
    vi.mocked(createSharedQuote).mockRejectedValueOnce(new SharedQuoteRefusedError());
    expect((await post({ quote: "x", locale: "vi" })).status).toBe(502);
  });

  it("returns 401 without a session and never calls the database", async () => {
    vi.mocked(requireReaderRequestContext).mockRejectedValue(new ReaderRequestUnauthorizedError());
    expect((await post({ quote: "x", locale: "vi" })).status).toBe(401);
    expect(createSharedQuote).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run app/api/reader/quotes/route.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement the route**

`app/api/reader/quotes/route.ts`:
```ts
import { type NextRequest } from "next/server";
import { z } from "zod";

import { getServerEnv } from "@/lib/config/server-env";
import { createSharedQuote, SharedQuoteCapError, SharedQuoteRefusedError } from "@/lib/data/shared-quotes";
import { isLocale } from "@/lib/i18n/config";
import { getCatalogRoutes } from "@/lib/i18n/routes";
import { getRequestId } from "@/lib/observability/request-id";
import { truncateBookQuote } from "@/lib/reader/quote";
import { requireReaderRequestContext } from "@/lib/reader/request-context";
import { readerApiErrorResponse, readerJsonResponse } from "@/lib/reader/route-response";

// S16: Share from the reader. The publication comes from the authorized reader session, never from
// the body, so the client cannot name a book it does not hold. The body is the selection and the
// locale the reader is reading in; the quote is cut to the shared 300-grapheme limit here, and the
// RPC checks entitlement, the cap, and the text rules again.
const bodySchema = z.strictObject({
  quote: z.string().trim().min(1).regex(/^(?!.*<\/?[a-z][^>]*>)/is),
  locale: z.string().refine(isLocale),
});

export async function POST(request: NextRequest) {
  const requestId = getRequestId(request.headers);
  const publicationId = request.nextUrl.searchParams.get("publicationId") ?? "";
  try {
    const context = await requireReaderRequestContext(request, publicationId);
    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(await request.json());
    } catch {
      return readerJsonResponse(requestId, 400, { error: "Invalid request." });
    }
    const { quote } = truncateBookQuote(body.quote);
    const locale = body.locale as "vi" | "en";
    try {
      const card = await createSharedQuote(context.publicationId, quote, locale);
      const url = new URL(getCatalogRoutes(locale).quoteCard(card.code), getServerEnv().siteUrl).toString();
      return readerJsonResponse(requestId, 201, { code: card.code, url });
    } catch (error) {
      if (error instanceof SharedQuoteCapError) return readerJsonResponse(requestId, 409, { error: "cap" });
      if (error instanceof SharedQuoteRefusedError) return readerJsonResponse(requestId, 502, { error: "Reader request failed.", requestId });
      throw error;
    }
  } catch (error) {
    const handled = readerApiErrorResponse(error, requestId, "quote");
    if (handled) return handled;
    console.error("Reader quote request failed.", { requestId });
    return readerJsonResponse(requestId, 502, { error: "Reader request failed.", requestId });
  }
}
```
In `lib/reader/route-response.ts` widen the area union: `type ReaderApiArea = "annotation" | "search" | "quote";`.

- [ ] **Step 5: Run the route test**

Run: `npx vitest run app/api/reader/quotes/route.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing toolbar tests**

Append to `components/reader/reader-selection-toolbar.test.tsx`:
```ts
  it("shares the card URL in place of the book URL when createShareUrl resolves", async () => {
    const user = userEvent.setup();
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    const createShareUrl = vi.fn().mockResolvedValue("https://example.test/vi/q/AbCdEfGh12");
    render(<ReaderSelectionToolbar copy={copy} selection={selection} book={{ title: "Book", author: "Author", canonicalBookUrl: "https://example.test/book" }} viewport={{ width: 100, height: 100 }} createShareUrl={createShareUrl} />);
    await user.click(screen.getByRole("button", { name: "Share" }));
    expect(createShareUrl).toHaveBeenCalledWith("Selected text");
    expect(share).toHaveBeenCalledWith({ text: "“Selected text”\n— Book, Author\nhttps://example.test/vi/q/AbCdEfGh12" });
    expect(screen.getByRole("status")).toHaveTextContent("Public quote page created");
  });

  it("falls back to the book URL, silently, when createShareUrl fails or returns null", async () => {
    const user = userEvent.setup();
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    render(<ReaderSelectionToolbar copy={copy} selection={selection} book={{ title: "Book", author: "Author", canonicalBookUrl: "https://example.test/book" }} viewport={{ width: 100, height: 100 }} createShareUrl={vi.fn().mockRejectedValue(new Error("offline"))} />);
    await user.click(screen.getByRole("button", { name: "Share" }));
    expect(share).toHaveBeenCalledWith({ text: "“Selected text”\n— Book, Author\nhttps://example.test/book" });
    expect(screen.getByRole("status")).not.toHaveTextContent("failed");
  });

  it("never calls createShareUrl for Copy", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const createShareUrl = vi.fn();
    render(<ReaderSelectionToolbar copy={copy} selection={selection} book={{ title: "Book", author: "Author", canonicalBookUrl: "https://example.test/book" }} viewport={{ width: 100, height: 100 }} createShareUrl={createShareUrl} />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(createShareUrl).not.toHaveBeenCalled();
  });
```

- [ ] **Step 7: Run to verify they fail**

Run: `npx vitest run components/reader/reader-selection-toolbar.test.tsx`
Expected: FAIL, `createShareUrl` never called and share text carries the book URL.

- [ ] **Step 8: Implement the toolbar and wire the client**

`reader-selection-toolbar.tsx`: add `shareCreated: string` to `ReaderSelectionToolbarCopy`; add prop `createShareUrl?: (quote: string) => Promise<string | null>`; replace the copy/share block of `run` with:
```ts
    if (action.action === "copy" || action.action === "share") {
      if (quote.truncated) setMessage(copy.quoteTruncated);
      // Share mints a public card first (S16). Any failure - offline, cap, revoked - falls back to
      // the S5.5 payload with the book URL, and says nothing: sharing never blocks on the server.
      let text = quote.text;
      let created = false;
      if (action.action === "share" && createShareUrl) {
        const url = await createShareUrl(truncateBookQuote(selection.text).quote).catch(() => null);
        if (url) { text = buildAttributedQuote({ selection: selection.text, ...book, canonicalBookUrl: url }).text; created = true; }
      }
      const note = [quote.truncated ? copy.quoteTruncated : "", created ? copy.shareCreated : ""].filter(Boolean).join(" ");
      try {
        if (action.action === "share" && typeof navigator.share === "function") { await navigator.share({ text }); setMessage(note); return; }
        await navigator.clipboard.writeText(text);
        setMessage(action.action === "share" ? [note, copy.shareUnavailable].filter(Boolean).join(" ") : [quote.truncated ? copy.quoteTruncated : "", copy.copied].filter(Boolean).join(" "));
      } catch (error) {
        if (action.action === "share" && error instanceof DOMException && error.name === "AbortError") setMessage(copy.shareCancelled);
        else setMessage(copy.copyFailed);
      }
    }
```
Import `truncateBookQuote` alongside `buildAttributedQuote`.

`reader-client.tsx`: next to the `request` callback add
```ts
  // S16: the toolbar hands back the selection; this mints the card through the reader session.
  const createShareUrl = useCallback(async (quote: string): Promise<string | null> => {
    const result = await request<{ url: string }>(`/api/reader/quotes?publicationId=${publicationId}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quote, locale }),
    });
    return typeof result.url === "string" ? result.url : null;
  }, [locale, publicationId, request]);
```
and pass `createShareUrl={createShareUrl}` to `<ReaderSelectionToolbar>`. `locale` and `publicationId` are existing props of the client.

- [ ] **Step 9: Run the reader suites and typecheck**

Run: `npx vitest run components/reader lib/reader && npm run typecheck && npx vitest run lib/i18n/dictionary.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add app/api/reader/quotes components/reader/reader-selection-toolbar.tsx components/reader/reader-selection-toolbar.test.tsx components/reader/reader-client.tsx components/reader/reader-client.test.tsx lib/reader/copy.ts lib/reader/route-response.ts lib/i18n/routes.ts lib/i18n/dictionaries/en.json lib/i18n/dictionaries/vi.json
git commit -m "feat(s16): Share mints a public quote card from the reader

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Card page and Open Graph image

**Files:**
- Create: `app/[lang]/(public)/q/[code]/page.tsx`, `page.test.tsx`, `opengraph-image.tsx`
- Modify: `lib/i18n/dictionaries/en.json`, `vi.json` (`catalog.quoteCard`)

**Interfaces:**
- Consumes `getSharedQuote` (Task 3), `getBookCardById`, `publicBookAction`, `ViewerBookAction`, `buyEbookAction`/`getFreeEbookAction` from the book page module, `AnalyticsEvent` with `view_quote` (Task 2).
- Dictionary `catalog.quoteCard`: `{ "eyebrow": "A quote from", "sharedFrom": "Shared from Infinity Books", "readSample": "Read a sample", "openBook": "About the book" }` and vi `{ "eyebrow": "Trích dẫn từ", "sharedFrom": "Chia sẻ từ Infinity Books", "readSample": "Đọc thử", "openBook": "Về cuốn sách" }`.

- [ ] **Step 1: Write the failing page test**

`app/[lang]/(public)/q/[code]/page.test.tsx`, modeled on the book page test's mocks:
```tsx
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import QuoteCardPage, { generateMetadata } from "@/app/[lang]/(public)/q/[code]/page";
import { getBookCardById } from "@/lib/data/catalog";
import { getSharedQuote } from "@/lib/data/shared-quotes";

const viewer = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("@/components/catalog/viewer-book-action", () => ({
  ViewerBookAction: (props: Record<string, unknown>) => { viewer.props = props; return <p data-testid="viewer-action" />; },
}));
const analytics = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("@/components/analytics/analytics-event", () => ({ AnalyticsEvent: (props: Record<string, unknown>) => { analytics.props = props; return null; } }));
vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("@/app/[lang]/(public)/books/[slug]/actions", () => ({ buyEbookAction: vi.fn(), getFreeEbookAction: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }) }));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: () => ({ siteUrl: "https://books.example" }) }));
vi.mock("@/lib/data/catalog", () => ({ getBookCardById: vi.fn(), publicBookAction: vi.fn(() => ({ kind: "buy" })) }));
vi.mock("@/lib/data/shared-quotes", () => ({ getSharedQuote: vi.fn() }));

const card = { id: "90000000-0000-4000-8000-000000000001", code: "AbCdEfGh12", quote: "Một câu đáng nhớ.", locale: "vi" as const, bookId: "30000000-0000-4000-8000-000000000001", createdAt: "2026-10-09T00:00:00+00:00" };
const book = { bookId: card.bookId, slug: "sach-s16", title: "Sách S16", subtitle: null, shortDescription: null, author: { name: "Tác giả", slug: "tac-gia" }, cover: null, offer: { priceMinor: 99000, currency: "VND" }, hasActivePublication: true, hasSample: true, series: null, topics: [], featured: false, shelfPosition: null, createdAt: "" };

beforeEach(() => { vi.resetAllMocks(); vi.mocked(getSharedQuote).mockResolvedValue(card); vi.mocked(getBookCardById).mockResolvedValue(book); });
afterEach(cleanup);

describe("quote card page", () => {
  it("renders the quote, attribution links, the viewer action, the sample link, and the view event", async () => {
    render(await QuoteCardPage({ params: Promise.resolve({ lang: "en", code: "AbCdEfGh12" }) }));
    expect(screen.getByText("“Một câu đáng nhớ.”")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sách S16" })).toHaveAttribute("href", "/vi/books/sach-s16");
    expect(screen.getByRole("link", { name: "Đọc thử" })).toHaveAttribute("href", "/vi/read-sample/sach-s16");
    expect(viewer.props).toMatchObject({ bookId: card.bookId, locale: "vi" });
    expect(analytics.props).toEqual({ eventName: "view_quote", sharedQuoteId: card.id, bookId: card.bookId, locale: "vi" });
    // The card loads the book in ITS locale, not the path's.
    expect(getBookCardById).toHaveBeenCalledWith("vi", card.bookId);
  });

  it("404s when the card or the book is missing", async () => {
    vi.mocked(getSharedQuote).mockResolvedValue(null);
    await expect(QuoteCardPage({ params: Promise.resolve({ lang: "vi", code: "AbCdEfGh12" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    vi.mocked(getSharedQuote).mockResolvedValue(card);
    vi.mocked(getBookCardById).mockResolvedValue(null);
    await expect(QuoteCardPage({ params: Promise.resolve({ lang: "vi", code: "AbCdEfGh12" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("is noindex,follow with the canonical on the book page and the sibling OG image", async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ lang: "vi", code: "AbCdEfGh12" }) });
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe("https://books.example/vi/books/sach-s16");
    expect(metadata.title).toBe("“Một câu đáng nhớ.” — Sách S16");
    expect(JSON.stringify(metadata.openGraph)).toContain("/vi/q/AbCdEfGh12/opengraph-image");
  });

  it("cuts a long quote in the title at 60 graphemes", async () => {
    vi.mocked(getSharedQuote).mockResolvedValue({ ...card, quote: "ế".repeat(80) });
    const metadata = await generateMetadata({ params: Promise.resolve({ lang: "vi", code: "AbCdEfGh12" }) });
    expect(metadata.title).toBe(`“${"ế".repeat(60)}…” — Sách S16`);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run "app/[lang]/(public)/q"`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the page**

`app/[lang]/(public)/q/[code]/page.tsx`:
```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { buyEbookAction, getFreeEbookAction } from "@/app/[lang]/(public)/books/[slug]/actions";
import { AnalyticsEvent } from "@/components/analytics/analytics-event";
import { CoverImage } from "@/components/catalog/cover-image";
import { ViewerBookAction } from "@/components/catalog/viewer-book-action";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getServerEnv } from "@/lib/config/server-env";
import { getBookCardById, publicBookAction } from "@/lib/data/catalog";
import { getSharedQuote } from "@/lib/data/shared-quotes";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes } from "@/lib/i18n/routes";
import { splitGraphemes } from "@/lib/reader/quote";
import { absoluteUrl, SITE_NAME } from "@/lib/seo/metadata";

// S16 quote card. Dynamic: a removed card must 404 at once, and the card is one reader's choice,
// not catalog content, so it is never prerendered, never in the sitemap, and noindex. `follow` is
// kept so the link to the book page carries weight; the canonical points there too.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ lang: string; code: string }> };

const TITLE_GRAPHEMES = 60;

async function load(code: string) {
  const card = await getSharedQuote(code);
  if (!card) return null;
  // The card's own locale, not the path's: the quote is in that language and so is the book copy.
  const book = await getBookCardById(card.locale, card.bookId);
  return book ? { card, book } : null;
}

function titleFor(quote: string, bookTitle: string): string {
  const units = splitGraphemes(quote);
  const cut = units.length > TITLE_GRAPHEMES ? `${units.slice(0, TITLE_GRAPHEMES).join("")}…` : quote;
  return `“${cut}” — ${bookTitle}`;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang, code } = await params;
  if (!isLocale(lang)) return {};
  const loaded = await load(code);
  if (!loaded) return {};
  const { card, book } = loaded;
  const { siteUrl } = getServerEnv();
  const routes = getCatalogRoutes(card.locale);
  const title = titleFor(card.quote, book.title);
  const description = `${book.title}, ${book.author.name}`;
  return {
    title,
    description,
    robots: { index: false, follow: true },
    alternates: { canonical: absoluteUrl(siteUrl, routes.book(book.slug)) },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      title,
      description,
      url: absoluteUrl(siteUrl, routes.quoteCard(card.code)),
      images: [{ url: absoluteUrl(siteUrl, `${routes.quoteCard(card.code)}/opengraph-image`), width: 1200, height: 630, alt: title }],
    },
  };
}

export default async function QuoteCardPage({ params }: Props) {
  const { lang, code } = await params;
  if (!isLocale(lang)) notFound();
  const loaded = await load(code);
  if (!loaded) notFound();
  const { card, book } = loaded;
  const locale = card.locale;
  const dictionary = await getDictionary(locale);
  const copy = dictionary.catalog;
  const routes = getCatalogRoutes(locale);
  const bookPath = routes.book(book.slug);

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader current="books" locale={locale} />
      <main className="mx-auto max-w-[48rem] px-4 py-12 sm:px-8 lg:py-20" id="main-content">
        <AnalyticsEvent bookId={book.bookId} eventName="view_quote" locale={locale} sharedQuoteId={card.id} />
        <p className="text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.quoteCard.eyebrow}</p>
        <blockquote className="mt-6 font-serif text-3xl leading-[1.3] sm:text-4xl">{`“${card.quote}”`}</blockquote>
        <div className="mt-10 grid gap-8 border-t border-hairline pt-8 sm:grid-cols-[8rem_1fr] sm:items-start">
          <div className="w-32">
            <CoverImage card={book} size="md" sizes="8rem" />
          </div>
          <div>
            <p className="font-serif text-xl">
              <Link className="underline decoration-sand underline-offset-4" href={bookPath}>{book.title}</Link>
            </p>
            <p className="mt-1 text-[0.9375rem] text-ink-soft">
              {book.author.slug ? <Link className="underline decoration-sand underline-offset-4" href={routes.entity("author", book.author.slug)}>{book.author.name}</Link> : book.author.name}
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <ViewerBookAction
                bookId={book.bookId}
                bookPath={bookPath}
                buyAction={buyEbookAction.bind(null, locale, book.bookId, book.slug)}
                copy={copy.actions}
                getFreeAction={getFreeEbookAction.bind(null, locale, book.bookId, book.slug)}
                locale={locale}
                publicAction={publicBookAction(book)}
              />
              {book.hasSample ? <Link className="inline-flex min-h-11 items-center underline decoration-sand underline-offset-4" href={routes.sample(book.slug)}>{copy.quoteCard.readSample}</Link> : null}
            </div>
            <p className="mt-8 text-xs text-sage-text">{copy.quoteCard.sharedFrom}</p>
          </div>
        </div>
      </main>
      <SiteFooter locale={locale} tagline={dictionary.home.footerTagline} />
    </div>
  );
}
```
`publicBookAction` takes `Pick<CatalogBookCard, "bookId" | "offer" | "hasActivePublication">`, so the card from `getBookCardById` is enough.

- [ ] **Step 4: Implement the image**

`app/[lang]/(public)/q/[code]/opengraph-image.tsx`:
```tsx
import { ImageResponse } from "next/og";
import { notFound } from "next/navigation";

import { getBookCardById } from "@/lib/data/catalog";
import { getSharedQuote } from "@/lib/data/shared-quotes";
import { SITE_NAME } from "@/lib/seo/metadata";

// The card as a link preview. Reads uncached data, so it is generated per request and 404s with
// the page. Same palette as app/opengraph-image.tsx; the built-in font, so nothing is fetched. No
// cover: covers are private-storage reads with no public URL for next/og to embed.
export const alt = SITE_NAME;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const card = await getSharedQuote(code);
  const book = card ? await getBookCardById(card.locale, card.bookId) : null;
  if (!card || !book) notFound();
  const long = card.quote.length > 160;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "72px 96px", background: "#f7f4ed", color: "#202421" }}>
        <div style={{ display: "flex", width: 96, height: 6, background: "#34473e" }} />
        <div style={{ display: "flex", fontSize: long ? 40 : 56, lineHeight: 1.25, letterSpacing: "-0.01em" }}>{`“${card.quote}”`}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", fontSize: 32 }}>{`${book.title} — ${book.author.name}`}</div>
          <div style={{ display: "flex", fontSize: 24, color: "#6b6f66" }}>{SITE_NAME}</div>
        </div>
      </div>
    ),
    size,
  );
}
```

- [ ] **Step 5: Add dictionary keys, run tests, typecheck, build**

Add `catalog.quoteCard` to both dictionaries (strings in the Interfaces block).

Run: `npx vitest run "app/[lang]/(public)/q" lib/i18n/dictionary.test.ts && npm run typecheck && npm run build`
Expected: PASS; the build lists `/[lang]/q/[code]` as dynamic (`ƒ`). If the build complains that `force-dynamic` conflicts with the `(public)` group's static params, keep `force-dynamic` and do not add `generateStaticParams`.

- [ ] **Step 6: Commit**

```bash
git add "app/[lang]/(public)/q" lib/i18n/dictionaries/en.json lib/i18n/dictionaries/vi.json
git commit -m "feat(s16): public quote card page with Open Graph image

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Library management page

**Files:**
- Create: `app/[lang]/(account)/library/quotes/page.tsx`, `actions.ts`
- Create: `components/account/shared-quote-list.tsx`, `shared-quote-list.test.tsx`
- Modify: `app/[lang]/(account)/library/page.tsx` (link), `lib/i18n/routes.ts` (`myQuotes`), dictionaries (`library.quotes`)

**Interfaces:**
- Consumes `listMySharedQuotes`, `removeMySharedQuote` (Task 3), `getCatalogRoutes(locale).quoteCard` (Task 4).
- Produces `getLocaleRoutes(locale).myQuotes` → `/{locale}/library/quotes`; `removeSharedQuoteAction(locale: Locale, code: string): Promise<void>`.
- Dictionary `library.quotes`: en `{ "eyebrow": "Your library", "title": "Shared quotes", "description": "Quotes you shared from your books. Each one is a public page until you remove it.", "empty": "You have not shared a quote yet. Select text in the reader and press Share.", "copyLink": "Copy link", "copied": "Copied", "remove": "Remove", "views": "{count} views", "link": "Shared quotes" }`; vi `{ "eyebrow": "Thư viện của bạn", "title": "Trích dẫn đã chia sẻ", "description": "Những trích dẫn bạn đã chia sẻ từ sách của mình. Mỗi trích dẫn là một trang công khai cho đến khi bạn xoá.", "empty": "Bạn chưa chia sẻ trích dẫn nào. Chọn đoạn văn trong trình đọc và bấm Chia sẻ.", "copyLink": "Sao chép liên kết", "copied": "Đã sao chép", "remove": "Xoá", "views": "{count} lượt xem", "link": "Trích dẫn đã chia sẻ" }`.

- [ ] **Step 1: Write the failing component test**

`components/account/shared-quote-list.test.tsx`:
```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SharedQuoteList } from "./shared-quote-list";

afterEach(cleanup);
const copy = { empty: "None yet", copyLink: "Copy link", copied: "Copied", remove: "Remove", views: "{count} views" };
const item = { id: "q1", code: "AbCdEfGh12", quote: "Một câu.", locale: "vi" as const, bookId: "b1", bookTitle: "Sách", createdAt: "2026-10-09T00:00:00Z", viewCount: 3 };

describe("SharedQuoteList", () => {
  it("renders the empty state", () => {
    render(<SharedQuoteList copy={copy} items={[]} locale="vi" removeAction={vi.fn()} siteUrl="https://books.example" />);
    expect(screen.getByText("None yet")).toBeInTheDocument();
  });

  it("lists a quote with its book, views, the card link, and a remove form bound to the code", async () => {
    const removeAction = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<SharedQuoteList copy={copy} items={[item]} locale="vi" removeAction={removeAction} siteUrl="https://books.example" />);
    expect(screen.getByText("“Một câu.”")).toBeInTheDocument();
    expect(screen.getByText("Sách")).toBeInTheDocument();
    expect(screen.getByText("3 views")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /AbCdEfGh12/ })).toHaveAttribute("href", "/vi/q/AbCdEfGh12");
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith("https://books.example/vi/q/AbCdEfGh12");
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run components/account/shared-quote-list.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`components/account/shared-quote-list.tsx`:
```tsx
"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { MySharedQuote } from "@/lib/data/shared-quotes";
import type { Locale } from "@/lib/i18n/config";
import { fillTemplate } from "@/lib/i18n/format";
import { getCatalogRoutes } from "@/lib/i18n/routes";

type Copy = { empty: string; copyLink: string; copied: string; remove: string; views: string };

export function SharedQuoteList({ copy, items, locale, removeAction, siteUrl }: {
  copy: Copy;
  items: MySharedQuote[];
  locale: Locale;
  removeAction: (code: string) => Promise<void>;
  siteUrl: string;
}) {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  if (items.length === 0) return <p className="text-ink-soft">{copy.empty}</p>;
  return (
    <ul className="divide-y divide-hairline">
      {items.map((item) => {
        // The card's own locale, which may differ from the page's.
        const path = getCatalogRoutes(item.locale).quoteCard(item.code);
        const url = new URL(path, siteUrl).toString();
        return (
          <li className="space-y-3 py-6" key={item.id}>
            <blockquote className="font-serif text-xl">{`“${item.quote}”`}</blockquote>
            <p className="text-[0.9375rem] text-ink-soft">
              {item.bookTitle} · {fillTemplate(copy.views, { count: item.viewCount })}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link className="inline-flex min-h-11 items-center underline decoration-sand underline-offset-4" href={path}>{path}</Link>
              <Button onClick={() => { void navigator.clipboard.writeText(url).then(() => setCopiedCode(item.code)).catch(() => undefined); }} size="sm" type="button" variant="outline">
                {copiedCode === item.code ? copy.copied : copy.copyLink}
              </Button>
              <form action={() => removeAction(item.code)}>
                <Button size="sm" type="submit" variant="ghost">{copy.remove}</Button>
              </form>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
```
`locale` is accepted for symmetry with the other account components and the test; if lint flags it unused, drop it from props and the test.

`app/[lang]/(account)/library/quotes/actions.ts`:
```ts
"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/auth/session";
import { removeMySharedQuote } from "@/lib/data/shared-quotes";
import type { Locale } from "@/lib/i18n/config";
import { getLocaleRoutes } from "@/lib/i18n/routes";

// The owner's one write. requireUser() itself; the RPC removes only the caller's own active row.
export async function removeSharedQuoteAction(locale: Locale, code: string): Promise<void> {
  await requireUser(locale, getLocaleRoutes(locale).myQuotes);
  await removeMySharedQuote(String(code));
  revalidatePath(getLocaleRoutes(locale).myQuotes);
}
```

`app/[lang]/(account)/library/quotes/page.tsx`:
```tsx
import { notFound } from "next/navigation";

import { AccountNav } from "@/components/account/account-nav";
import { accountNavItems } from "@/components/account/account-nav-items";
import { SharedQuoteList } from "@/components/account/shared-quote-list";
import { SiteHeader } from "@/components/site-header";
import { requireUser } from "@/lib/auth/session";
import { getServerEnv } from "@/lib/config/server-env";
import { listMySharedQuotes } from "@/lib/data/shared-quotes";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getLocaleRoutes } from "@/lib/i18n/routes";

import { removeSharedQuoteAction } from "./actions";

export default async function SharedQuotesPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang: locale } = await params;
  if (!isLocale(locale)) notFound();
  await requireUser(locale, getLocaleRoutes(locale).myQuotes);
  const [dictionary, items] = await Promise.all([getDictionary(locale), listMySharedQuotes()]);
  const copy = dictionary.library.quotes;
  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader current="library" locale={locale} />
      <div className="mx-auto grid max-w-[90rem] gap-10 px-4 py-10 sm:px-8 lg:grid-cols-[12.5rem_1fr] lg:gap-16 lg:px-16 lg:py-12">
        <AccountNav items={accountNavItems(locale, dictionary, "library")} label={dictionary.navigation.library} />
        <main className="min-w-0 max-w-[40rem]" id="main-content">
          <p className="mb-1.5 text-[0.8125rem] text-sage-text">{copy.eyebrow}</p>
          <h1 className="mb-3 font-serif text-4xl leading-[1.1] font-normal">{copy.title}</h1>
          <p className="mb-8 text-[0.9375rem] text-ink-soft">{copy.description}</p>
          <SharedQuoteList copy={copy} items={items} locale={locale} removeAction={removeSharedQuoteAction.bind(null, locale)} siteUrl={getServerEnv().siteUrl} />
        </main>
      </div>
    </div>
  );
}
```

`lib/i18n/routes.ts`, in `getLocaleRoutes`: `myQuotes: withLocale(locale, "/library/quotes"),`.

`app/[lang]/(account)/library/page.tsx`: below the description paragraph add
```tsx
          <p className="mb-10 -mt-6"><Link className="inline-flex min-h-11 items-center underline decoration-sand underline-offset-4" href={getLocaleRoutes(locale).myQuotes}>{copy.quotes.link}</Link></p>
```
with `getLocaleRoutes` imported. Add `quotes` to the library dictionary block in both locales.

- [ ] **Step 4: Run tests, typecheck**

Run: `npx vitest run components/account "app/[lang]/(account)/library" lib/i18n/dictionary.test.ts && npm run typecheck`
Expected: PASS. If `library/page.test.tsx` asserts exact link counts, update it for the new link.

- [ ] **Step 5: Commit**

```bash
git add "app/[lang]/(account)/library/quotes" "app/[lang]/(account)/library/page.tsx" components/account/shared-quote-list.tsx components/account/shared-quote-list.test.tsx lib/i18n/routes.ts lib/i18n/dictionaries/en.json lib/i18n/dictionaries/vi.json
git commit -m "feat(s16): manage shared quotes from the library

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Admin takedown

**Files:**
- Create: `app/admin/quotes/page.tsx`, `actions.ts`
- Create: `components/admin/quotes/quote-list.tsx`, `quote-list.test.tsx`
- Modify: `components/admin/admin-nav.tsx`, `admin-nav.test.tsx`, `app/admin/books/[bookId]/page.tsx`

**Interfaces:**
- Consumes `listAdminSharedQuotes`, `adminRemoveSharedQuote` (Task 3).
- Produces `removeSharedQuoteAction(code: string, _formData: FormData): Promise<void>` in `app/admin/quotes/actions.ts`.

- [ ] **Step 1: Write the failing tests**

`components/admin/quotes/quote-list.test.tsx`:
```tsx
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { removeSharedQuoteAction } from "@/app/admin/quotes/actions";
import { QuoteList } from "./quote-list";

vi.mock("@/app/admin/quotes/actions", () => ({ removeSharedQuoteAction: vi.fn() }));
afterEach(cleanup);

const item = { id: "q1", code: "AbCdEfGh12", quote: "Một câu.", locale: "vi" as const, bookId: "b1", createdAt: "2026-10-09T00:00:00.000Z", bookTitle: "Sách", ownerEmail: "o@example.test", viewCount: 2 };

it("renders a row per card with the book link, owner, views, the public link, and a Remove form", async () => {
  render(<QuoteList items={[item]} />);
  const row = screen.getByRole("row", { name: /Sách/ });
  expect(within(row).getByRole("link", { name: "Sách" })).toHaveAttribute("href", "/admin/books/b1");
  expect(within(row).getByText("o@example.test")).toBeInTheDocument();
  expect(within(row).getByRole("link", { name: "AbCdEfGh12" })).toHaveAttribute("href", "/vi/q/AbCdEfGh12");
  fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(removeSharedQuoteAction).toHaveBeenCalled());
  expect(vi.mocked(removeSharedQuoteAction).mock.calls[0][0]).toBe("AbCdEfGh12");
});

it("says so when there is nothing", () => {
  render(<QuoteList items={[]} />);
  expect(screen.getByText("No shared quotes.")).toBeInTheDocument();
});
```

In `components/admin/admin-nav.test.tsx`, extend the ordering assertion so the slice after "Articles" is `["Articles", "Reviews", "Questions", "Quotes"]` and add `expect(within(nav).getByRole("link", { name: "Quotes" })).toHaveAttribute("href", "/admin/quotes");`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run components/admin/quotes components/admin/admin-nav.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`app/admin/quotes/actions.ts`:
```ts
"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth/admin";
import { adminRemoveSharedQuote } from "@/lib/data/admin-shared-quotes";

// Takedown. A Server Action is a public endpoint: requireAdmin() here, and the RPC re-checks.
export async function removeSharedQuoteAction(code: string, _formData: FormData): Promise<void> {
  await requireAdmin({ next: "/admin/quotes" });
  await adminRemoveSharedQuote(String(code));
  revalidatePath("/admin/quotes");
}
```
Add the `eslint-disable-next-line @typescript-eslint/no-unused-vars` comment above `_formData` as `app/admin/questions/actions.ts` does.

`components/admin/quotes/quote-list.tsx`:
```tsx
"use client";

import Link from "next/link";

import { removeSharedQuoteAction } from "@/app/admin/quotes/actions";
import { SubmitButton } from "@/components/auth/submit-button";
import type { AdminSharedQuote } from "@/lib/data/admin-shared-quotes";
import { formatDate } from "@/lib/i18n/format";
import { getCatalogRoutes } from "@/lib/i18n/routes";

export function QuoteList({ items }: { items: AdminSharedQuote[] }) {
  if (items.length === 0) return <p className="text-sage-text">No shared quotes.</p>;
  return (
    <div aria-label="Shared quotes" className="max-w-full overflow-x-auto" role="region" tabIndex={0}>
      <table className="w-full min-w-[56rem] text-left text-sm">
        <caption className="sr-only">Shared quotes</caption>
        <thead>
          <tr className="border-b border-sand text-sage-text">
            <th className="py-2 pr-3 font-medium" scope="col">Book</th>
            <th className="py-2 pr-3 font-medium" scope="col">Quote</th>
            <th className="py-2 pr-3 font-medium" scope="col">Owner</th>
            <th className="py-2 pr-3 font-medium" scope="col">Views</th>
            <th className="py-2 pr-3 font-medium" scope="col">Card</th>
            <th className="py-2 pr-3 font-medium" scope="col">Date</th>
            <th className="py-2 font-medium" scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr className="border-b border-sand align-top" key={item.id}>
              <th className="py-3 pr-3 font-normal" scope="row">
                <Link className="font-medium text-forest underline decoration-sand underline-offset-4" href={`/admin/books/${item.bookId}`}>{item.bookTitle}</Link>
              </th>
              <td className="max-w-[24rem] py-3 pr-3 whitespace-pre-wrap">{item.quote}</td>
              <td className="py-3 pr-3">{item.ownerEmail ?? "—"}</td>
              <td className="py-3 pr-3">{item.viewCount}</td>
              <td className="py-3 pr-3">
                <Link className="underline decoration-sand underline-offset-4" href={getCatalogRoutes(item.locale).quoteCard(item.code)}>{item.code}</Link>
              </td>
              <td className="py-3 pr-3 whitespace-nowrap">{formatDate(item.createdAt, "en")}</td>
              <td className="py-3">
                <form action={removeSharedQuoteAction.bind(null, item.code)}>
                  <SubmitButton className="min-h-11" pendingLabel="Removing…" size="sm" variant="outline">Remove</SubmitButton>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

`app/admin/quotes/page.tsx`:
```tsx
import { z } from "zod";

import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { QuoteList } from "@/components/admin/quotes/quote-list";
import { requireAdmin } from "@/lib/auth/admin";
import { listAdminSharedQuotes } from "@/lib/data/admin-shared-quotes";

export default async function AdminQuotesPage({ searchParams }: { searchParams: Promise<{ book?: string | string[] }> }) {
  await requireAdmin({ next: "/admin/quotes" });
  const { book: raw } = await searchParams;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const bookId = z.uuid().safeParse(value).success ? (value as string) : null;
  const items = await listAdminSharedQuotes(bookId);
  return (
    <div className="min-w-0 max-w-[72rem] [overflow-wrap:anywhere]">
      <AdminPageHeader eyebrow="Readers" title="Shared quotes">
        Public quote cards readers created from the reader. Remove one to take its page down; the code is never reused. The 200 newest are shown{bookId ? " for this book" : ""}.
      </AdminPageHeader>
      <QuoteList items={items} />
    </div>
  );
}
```

`components/admin/admin-nav.tsx`: add `{ href: "/admin/quotes", label: "Quotes" }` after Questions.

`app/admin/books/[bookId]/page.tsx`: in the "Relations" `AdminSection`, or as its own line under the header, add
```tsx
        <p className="text-sm"><Link className="underline decoration-sand underline-offset-4" href={`/admin/quotes?book=${book.id}`}>Shared quotes from this book</Link></p>
```
with `Link` imported from `next/link`.

- [ ] **Step 4: Run tests, typecheck**

Run: `npx vitest run components/admin app/admin && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/admin/quotes components/admin/quotes components/admin/admin-nav.tsx components/admin/admin-nav.test.tsx "app/admin/books/[bookId]/page.tsx"
git commit -m "feat(s16): admin takedown for shared quotes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: End-to-end journey, docs, and gates

**Files:**
- Create: `e2e/shareable-quotes.spec.ts`
- Modify: `e2e/reader-depth.spec.ts` (share assertion), `docs/runbooks/reader-depth.md`, the S16 spec status

- [ ] **Step 1: Update the reader-depth share assertion**

In `e2e/reader-depth.spec.ts`, the test "limits attributed copy/share…" asserts `__readerShared === copied`. Replace the two share assertions with:
```ts
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const shared = await page.evaluate(() => (window as typeof window & { __readerShared?: string }).__readerShared ?? "");
    // S16: Share carries the public card URL; the quote and attribution lines are unchanged.
    expect(shared.split("\n").slice(0, -1)).toEqual(copied.split("\n").slice(0, -1));
    expect(shared.split("\n").at(-1)).toMatch(/\/en\/q\/[A-Za-z0-9_-]{10}$/);

    await page.evaluate(() => Object.defineProperty(navigator, "share", { configurable: true, value: undefined }));
    await page.getByRole("button", { name: "Share", exact: true }).click();
    expect(await page.evaluate(() => (window as typeof window & { __readerCopied?: string }).__readerCopied)).toMatch(/\/en\/q\/[A-Za-z0-9_-]{10}$/);
```

- [ ] **Step 2: Write the new spec**

`e2e/shareable-quotes.spec.ts`:
```ts
import { expect, test, type Page } from "@playwright/test";

import { createReader, signInAs } from "./support/commerce";
import { READER_DEPTH_SELECTION, grantEntitlement, seedProcessedBook } from "./support/publication";
import { selectKnownPassage, waitForReaderReady } from "./support/reader-depth";
import { createServiceRoleClient } from "./support/supabase";

// S16 acceptance (spec 10, 11): Share mints a public card; the card renders signed out with the
// book's action and an Open Graph image; the owner removes it and the card and image 404.
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function shareFromReader(page: Page, bookId: string): Promise<string> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async ({ text }: { text?: string }) => { (window as typeof window & { __shared?: string }).__shared = text; },
    });
  });
  await waitForReaderReady(page);
  await selectKnownPassage(page, READER_DEPTH_SELECTION);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __shared?: string }).__shared ?? "")).toMatch(/\/en\/q\//);
  const shared = await page.evaluate(() => (window as typeof window & { __shared?: string }).__shared ?? "");
  const url = shared.split("\n").at(-1)!;
  expect(url).toMatch(new RegExp(`/en/q/[A-Za-z0-9_-]{10}$`));
  return url;
}

test("a reader shares a quote, anyone opens the card, and the owner removes it", async ({ page, browser, request }) => {
  test.setTimeout(240_000);
  const suffix = unique();
  const book = await seedProcessedBook({ suffix, localizations: { en: { slug: `quote-${suffix}`, title: `Quote ${suffix}` } }, readerDepthFixture: true });
  const reader = await createReader("quote-owner");
  await grantEntitlement(book.bookId, reader.email);
  await signInAs(page, reader.email, `/en/read/${book.bookId}`);
  const cardUrl = await shareFromReader(page, book.bookId);
  const path = new URL(cardUrl).pathname;

  // Signed out: the quote, the book, Buy, and the sample link.
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(path);
  await expect(visitor.getByText(READER_DEPTH_SELECTION.slice(0, 20), { exact: false })).toBeVisible();
  await expect(visitor.getByRole("link", { name: book.title })).toHaveAttribute("href", `/en/books/${book.slug}`);
  await expect(visitor.getByRole("button", { name: /Buy ebook|Get free/ })).toBeVisible();
  const robots = await visitor.locator('meta[name="robots"]').getAttribute("content");
  expect(robots).toMatch(/noindex/);
  expect(robots).toMatch(/follow/);
  expect(await visitor.locator('link[rel="canonical"]').getAttribute("href")).toContain(`/en/books/${book.slug}`);

  const image = await request.get(`${path}/opengraph-image`);
  expect(image.status()).toBe(200);
  expect(image.headers()["content-type"]).toContain("image/png");

  // The row carries no locator and the share event carries ids only.
  const service = createServiceRoleClient();
  const code = path.split("/").at(-1)!;
  const rows = await service.from("shared_quotes").select("id, book_id, status").eq("code", code);
  expect(rows.data).toHaveLength(1);
  const events = await service.from("analytics_events").select("event_name").eq("shared_quote_id", rows.data![0].id);
  expect(events.data!.map((e) => e.event_name)).toContain("share_quote");

  // Owner's library lists it with the link; removing it 404s the card and the image.
  await page.goto("/en/library/quotes");
  await expect(page.getByRole("link", { name: path })).toBeVisible();
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("You have not shared a quote yet", { exact: false })).toBeVisible();
  expect((await request.get(path)).status()).toBe(404);
  expect((await request.get(`${path}/opengraph-image`)).status()).toBe(404);
  await visitor.context().close();
});

test("an admin takes a card down", async ({ page }) => {
  test.setTimeout(240_000);
  const suffix = unique();
  const book = await seedProcessedBook({ suffix, localizations: { en: { slug: `quote-adm-${suffix}`, title: `Quote Adm ${suffix}` } }, readerDepthFixture: true });
  const reader = await createReader("quote-owner-2");
  await grantEntitlement(book.bookId, reader.email);
  await signInAs(page, reader.email, `/en/read/${book.bookId}`);
  const cardUrl = await shareFromReader(page, book.bookId);
  const code = new URL(cardUrl).pathname.split("/").at(-1)!;

  const admin = await createReader("quote-admin", { admin: true });
  await signInAs(page, admin.email, `/admin/quotes?book=${book.bookId}`);
  const row = page.getByRole("row", { name: new RegExp(book.title) });
  await expect(row.getByRole("link", { name: code })).toBeVisible();
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(row).toHaveCount(0);
  const audit = await createServiceRoleClient().from("audit_logs").select("action").eq("action", "shared_quote.remove");
  expect(audit.data!.length).toBeGreaterThan(0);
});
```
`READER_DEPTH_SELECTION` is the known selectable passage the reader-depth spec uses; if `selectKnownPassage` needs a different constant for the fixture book, use the one `e2e/reader-depth.spec.ts` uses for its highlight test.

- [ ] **Step 3: Run the specs**

Run: `npx playwright test e2e/shareable-quotes.spec.ts e2e/reader-depth.spec.ts`
Expected: PASS.

- [ ] **Step 4: Runbook and spec status**

In `docs/runbooks/reader-depth.md`, add a section:
```markdown
## Shared quote cards (S16)

Share in the reader creates a public page at `/{locale}/q/{code}` with the quote, the book, its
action, and an Open Graph image. The quote is the same 300-grapheme attributed text as Copy; only
the URL differs. If the server refuses (offline, 200-card cap, revoked access) the reader still
gets the Copy text with the book URL and sees no error.

- Readers manage their cards at `/{locale}/library/quotes` (copy link, remove).
- Admins take a card down at `/admin/quotes` (filter by book from the book editor). Removal writes
  an `audit_logs` row with the card id; the code is never reused.
- Cards are `noindex, follow`, not in the sitemap or `llms.txt`, and 404 when removed or when the
  book is unpublished. Views are the `view_quote` analytics rows for the card.
```
Set the S16 spec `**Status:** Approved`.

- [ ] **Step 5: Full gates**

```bash
npm run check
npm run db:reset && npm run db:test
npm run check:full
```
Expected: green, with the known pre-existing ebook CLI unit test exception noted if it is the only failure.

- [ ] **Step 6: Commit**

```bash
git add e2e/shareable-quotes.spec.ts e2e/reader-depth.spec.ts docs/runbooks/reader-depth.md docs/superpowers/specs/2026-10-09-s16-shareable-quote-cards-design.md
git commit -m "test(s16): shareable quote cards end to end; runbook

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
