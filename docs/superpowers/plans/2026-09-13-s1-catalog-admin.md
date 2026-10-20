# S1 Catalog Domain and Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operators create, edit, and publish complete launch books, authors, series, topics, covers, merchandising, and complimentary access from `/admin`, with no database edits.

**Architecture:** Two write paths, chosen per operation. Single-row edits (authors, series, topics, book details, edition, SKU, offer) go through the admin's session client under new `is_admin()` RLS write policies, and an audit trigger records each change. Multi-row or state-changing edits (localizations with slug redirects, relations, cover, merchandising, book publish) go through `security definer` RPCs that check `is_admin()` and write their own audit row. Book visibility moves from `publish_publication` to a new `publish_book` RPC guarded by a readiness check shared with TypeScript.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Supabase Postgres/Storage/RLS, pgTAP, Zod 4, Vitest, Playwright

**Spec:** `docs/superpowers/specs/2026-09-13-remaining-mvp-ebook-launch-design.md` (section S1, plus §3.1–§3.2 and §5)

## Global Constraints

- MVP is ebook-only. Do not add physical SKUs, inventory, shipping, or fulfillment.
- Keep `/admin` without a locale prefix. Customer routes stay under `/{locale}`.
- Every admin page and every Server Action calls `requireAdmin()` itself. Layouts never authorize.
- Admin RPCs use the authenticated session client (`createClient()`), never the service-role client, because `is_admin()` resolves through `auth.uid()`.
- Create a service-role client only after `requireAdmin()` passes, and only for Storage signed upload URLs.
- Never expose `SUPABASE_SERVICE_ROLE_KEY` to browser code.
- Never return raw Supabase or Postgres error text to the client. Map known errors to typed errors; everything else becomes a generic message.
- Add new migrations only. Never edit an applied migration. Name them after `20260911210000`.
- Update `lib/supabase/database.types.ts` after every migration.
- Run database and Playwright tests only against a local Supabase stack. If another stack owns ports 543xx, use a scratch `--workdir` stack as described in `docs/runbooks/testing-environments.md` and call `supabase` directly instead of the `db:*` npm scripts.
- Run `npm run check` at the end of every task.
- Keep regression tests with every fixed defect.
- Preserve untracked user files (`cmd.txt`, `docs/ref/`). Never stage them.

## Decisions This Plan Locks In

1. **Book visibility is a catalog decision.** `publish_publication` stops setting `books.status` and `authors.status`. Only `publish_book` makes a book (and its primary author) public, and only when the readiness check passes. An already-published book stays published when a new EPUB version is published.
2. **Readiness codes are shared.** SQL raises `EB010` with a comma-separated list of codes. TypeScript uses the same codes: `missing_localization`, `missing_author`, `missing_cover`, `missing_offer`, `missing_publication`.
3. **The book editor is one page with anchored sections** (Details, Localizations, Edition & offer, Cover, Relations, EPUB, Publish) and a section nav. Every section renders on the server, so existing E2E flows that upload an EPUB straight after creating a book keep working.
4. **New-book form keeps the "Author name" field.** The new `admin_create_book` RPC reuses an existing author whose derived slug matches, and creates one otherwise. `DuplicateAuthorNameError` is removed.
5. **Slug redirects never chain.** One internal SQL helper, `record_slug_redirect(old_path, new_path)`, is used for books, authors, series, and topics.
6. **Merchandising slots** are `home_featured` (at most one book) and `home_shelf` (ordered list), replaced atomically by `admin_set_merchandising`.
7. **Covers** live in a public `covers` bucket at `books/{bookId}/{uuid}.{ext}`, with one cover row per book in `media_assets`. Admin previews use `next/image` with `unoptimized`, so no remote image config is needed in S1.

## File Map

| Path | Responsibility |
| --- | --- |
| `supabase/migrations/20260913100000_catalog_admin_schema.sql` | Series, localization tables, book-page columns, merchandising reshape, covers bucket, admin read/write policies, audit trigger |
| `supabase/migrations/20260913110000_catalog_admin_rpcs.sql` | `admin_create_book`, `record_slug_redirect`, localization RPCs, relations, cover, merchandising RPCs |
| `supabase/migrations/20260913120000_book_publish_readiness.sql` | `book_readiness_issues`, `publish_book`, `unpublish_book`, redefined `publish_publication` |
| `supabase/tests/011_catalog_admin_schema.sql` | Policies, grants, audit trigger |
| `supabase/tests/012_catalog_admin_rpcs.sql` | RPC authorization, redirects, relations, cover, merchandising |
| `supabase/tests/013_book_publish_readiness.sql` | Readiness, publish/unpublish, new `publish_publication` behavior |
| `lib/catalog/readiness.ts` | `checkBookReadiness`, readiness codes, DB error parsing |
| `lib/catalog/schemas.ts` | Zod schemas for every admin form |
| `lib/catalog/form.ts` | `FormData` readers and Zod-to-field-error mapping |
| `lib/catalog/entity-types.ts` | Author/series/topic table and route configuration |
| `lib/data/books.ts` | Book create, list, editor DTO, details/edition/offer/localization/relations/publish writes |
| `lib/data/catalog-entities.ts` | Author/series/topic list, get, create, update, localization save |
| `lib/data/covers.ts` | Cover upload reservation, finalize, public URL |
| `lib/data/merchandising.ts` | Read and replace merchandising slots |
| `lib/data/users.ts` | User lookup and user detail for admins |
| `components/admin/form-feedback.tsx` | Shared field error, form error, and saved message |
| `components/admin/localized-entity-form.tsx` | Base + per-locale forms for authors, series, topics |
| `components/admin/book-editor/*.tsx` | One component per book editor section |
| `components/admin/merchandising-form.tsx` | Slot editor |
| `components/admin/user-entitlements.tsx` | Grant and revoke UI |
| `app/admin/books/page.tsx` | Books list |
| `app/admin/books/[bookId]/page.tsx` | Book editor |
| `app/admin/books/[bookId]/editor-actions.ts` | Book editor Server Actions |
| `app/admin/entities/actions.ts` | Shared Server Actions for authors, series, topics |
| `components/admin/entity-pages.tsx` | Shared list/new/edit page bodies for authors, series, topics |
| `app/admin/{authors,series,topics}/…` | Thin route files that call the shared page bodies |
| `app/admin/merchandising/…` | Merchandising page and action |
| `app/admin/users/…` | User lookup, user detail |
| `e2e/admin-catalog.spec.ts` | Catalog admin journey and 403 sweep |
| `docs/runbooks/catalog-admin.md` | Operator guide for S1 |

---

### Task 1: Catalog admin schema, policies, and audit trigger

**Files:**
- Create: `supabase/migrations/20260913100000_catalog_admin_schema.sql`
- Create: `supabase/tests/011_catalog_admin_schema.sql`
- Modify: `supabase/tests/002_access_admin_rls.sql` (merchandising fixture slot key)
- Modify: `lib/supabase/database.types.ts` (regenerated)

**Interfaces:**
- Consumes: existing `public.is_admin()`, `public.content_status`, `public.audit_logs`.
- Produces for later tasks:
  - Tables `series`, `book_series (book_id pk, series_id, position)`, `author_localizations (author_id)`, `topic_localizations (topic_id)`, `series_localizations (series_id)`; each localization row has `locale`, `slug`, `name`, `description`, unique `(locale, slug)` and `(<entity>_id, locale)`.
  - `book_localizations` columns `audience text`, `key_ideas jsonb` (array), `faq jsonb` (array), `seo_title text`, `seo_description text`, `updated_at`.
  - Direct admin writes allowed: insert/update on `authors`, `series`, `topics`; update of `books (canonical_key, original_language, primary_author_id)`, `editions (language_code, isbn, edition_number, publication_date)`, `skus (active)`, `offers (market_code, currency, price_minor, active, starts_at, ends_at)`.
  - Admin reads on every catalog table plus `profiles`, `entitlements`, `library_items`, `orders`, `order_items`.
  - Public `covers` storage bucket (5 MiB, JPEG/PNG/WebP).
  - `merchandising_slots.slot_key` limited to `home_featured` (one row) and `home_shelf`.
  - Every direct catalog write produces one `audit_logs` row: `action` = `catalog_insert` or `catalog_update`, `entity_type` = table name, `metadata.changes` = changed columns with `from`/`to`.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/011_catalog_admin_schema.sql`:

```sql
begin;
select plan(19);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's1-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's1-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'c1000000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name)
values ('c2000000-0000-0000-0000-000000000001', 's1-author', 'S1 Author'),
       ('c2000000-0000-0000-0000-000000000002', 's1-author-two', 'S1 Author Two');
insert into public.books (id, canonical_key, original_language, primary_author_id)
values ('c3000000-0000-0000-0000-000000000001', 's1-book', 'vi', 'c2000000-0000-0000-0000-000000000001');
insert into public.series (id, canonical_slug, display_name)
values ('c4000000-0000-0000-0000-000000000001', 's1-series', 'S1 Series');

-- (1)-(6) The new structure exists.
select has_table('public', 'series', 'series table exists');
select has_table('public', 'book_series', 'book_series table exists');
select has_table('public', 'author_localizations', 'author_localizations table exists');
select has_table('public', 'topic_localizations', 'topic_localizations table exists');
select has_table('public', 'series_localizations', 'series_localizations table exists');
select has_column('public', 'book_localizations', 'key_ideas', 'book_localizations has key_ideas');

-- (7) Covers are public; EPUB buckets are untouched by this migration.
select is((select public from storage.buckets where id = 'covers'), true, 'covers bucket is public');

-- (8) anon holds no SELECT on the new admin-only tables.
select is(has_table_privilege('anon', 'public.series', 'SELECT'), false, 'anon holds no SELECT on series');

-- (9)-(10) A signed-in non-admin can neither read nor write catalog admin data.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000002', true);
select is((select count(*)::bigint from public.series), 0::bigint, 'non-admin sees no draft series');
select throws_ok(
  $$insert into public.authors (canonical_slug, display_name) values ('reader-author', 'Reader Author')$$,
  '42501',
  null,
  'non-admin cannot insert an author'
);

-- (11)-(12) An admin writes authors and series directly.
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$insert into public.authors (canonical_slug, display_name) values ('s1-new-author', 'S1 New Author')$$,
  'admin inserts an author'
);
select lives_ok(
  $$update public.series set display_name = 'S1 Series Renamed' where id = 'c4000000-0000-0000-0000-000000000001'$$,
  'admin renames a series'
);

-- (13)-(15) The audit trigger records inserts and real changes only.
reset role;
select is(
  (select count(*)::bigint from public.audit_logs where action = 'catalog_insert' and entity_type = 'authors'
     and entity_id = (select id from public.authors where canonical_slug = 's1-new-author')),
  1::bigint,
  'author insert is audited once'
);
select is(
  (select metadata #>> '{changes,display_name,to}' from public.audit_logs where action = 'catalog_update' and entity_id = 'c4000000-0000-0000-0000-000000000001'),
  'S1 Series Renamed',
  'series update audit records the new display name'
);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
update public.series set display_name = 'S1 Series Renamed' where id = 'c4000000-0000-0000-0000-000000000001';
reset role;
select is(
  (select count(*)::bigint from public.audit_logs where action = 'catalog_update' and entity_id = 'c4000000-0000-0000-0000-000000000001'),
  1::bigint,
  'an update that changes nothing writes no audit row'
);

-- (16)-(17) Book status stays RPC-only; the editable book columns are writable.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$update public.books set status = 'published' where id = 'c3000000-0000-0000-0000-000000000001'$$,
  '42501',
  null,
  'admin cannot set books.status directly'
);
select lives_ok(
  $$update public.books set primary_author_id = 'c2000000-0000-0000-0000-000000000002' where id = 'c3000000-0000-0000-0000-000000000001'$$,
  'admin changes the primary author directly'
);

-- (18) Admins can look users up.
select cmp_ok((select count(*)::bigint from public.profiles), '>=', 2::bigint, 'admin reads other users'' profiles');
reset role;

-- (19) Merchandising slot keys are constrained.
select throws_ok(
  $$insert into public.merchandising_slots (slot_key, book_id) values ('home-hero', 'c3000000-0000-0000-0000-000000000001')$$,
  '23514',
  null,
  'an unknown merchandising slot key is rejected'
);

select * from finish();
rollback;
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `supabase test db` (or `supabase test db --workdir <scratch>` when using a scratch stack)
Expected: FAIL in `011_catalog_admin_schema.sql` because `public.series` does not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260913100000_catalog_admin_schema.sql`:

```sql
-- S1 catalog admin schema. See docs/superpowers/specs/2026-09-13-remaining-mvp-ebook-launch-design.md
-- (S1 and section 3.2) and docs/superpowers/plans/2026-09-13-s1-catalog-admin.md.
--
-- Write paths: single-row catalog edits go straight to the tables below under is_admin() write
-- policies and are audited by audit_catalog_row_change(). Multi-row and state-changing edits go
-- through the RPCs in 20260913110000 and 20260913120000, which audit themselves.

create extension if not exists unaccent with schema extensions;

-- Series ---------------------------------------------------------------------------------------

create table public.series (
  id uuid primary key default gen_random_uuid(),
  canonical_slug text not null unique check (canonical_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  display_name text not null check (length(trim(display_name)) > 0),
  status public.content_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A book belongs to at most one series in the MVP, hence book_id as the primary key.
create table public.book_series (
  book_id uuid primary key references public.books(id) on delete cascade,
  series_id uuid not null references public.series(id) on delete cascade,
  position integer not null check (position > 0),
  unique (series_id, position)
);

-- Localized copy for authors, topics, and series ------------------------------------------------

create table public.author_localizations (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.authors(id) on delete cascade,
  locale text not null check (locale in ('vi', 'en')),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null check (length(trim(name)) > 0),
  description text,
  updated_at timestamptz not null default now(),
  unique (locale, slug),
  unique (author_id, locale)
);

create table public.topic_localizations (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references public.topics(id) on delete cascade,
  locale text not null check (locale in ('vi', 'en')),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null check (length(trim(name)) > 0),
  description text,
  updated_at timestamptz not null default now(),
  unique (locale, slug),
  unique (topic_id, locale)
);

create table public.series_localizations (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references public.series(id) on delete cascade,
  locale text not null check (locale in ('vi', 'en')),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null check (length(trim(name)) > 0),
  description text,
  updated_at timestamptz not null default now(),
  unique (locale, slug),
  unique (series_id, locale)
);

-- Book-page content contract (PRD 5.2) --------------------------------------------------------

alter table public.book_localizations
  add column audience text,
  add column key_ideas jsonb not null default '[]'::jsonb check (jsonb_typeof(key_ideas) = 'array'),
  add column faq jsonb not null default '[]'::jsonb check (jsonb_typeof(faq) = 'array'),
  add column seo_title text,
  add column seo_description text,
  add column updated_at timestamptz not null default now();

-- One cover per book. Replacing a cover updates this row (admin_set_book_cover).
create unique index media_assets_one_cover_per_book
  on public.media_assets (owner_id)
  where owner_type = 'book' and kind = 'cover';

-- Merchandising: many books per slot, one featured book. Before pushing to a hosted project,
-- confirm `select distinct slot_key from public.merchandising_slots` returns no other keys.
alter table public.merchandising_slots drop constraint merchandising_slots_slot_key_key;
alter table public.merchandising_slots
  add constraint merchandising_slots_slot_key_check check (slot_key in ('home_featured', 'home_shelf')),
  add constraint merchandising_slots_slot_book_key unique (slot_key, book_id);
create unique index merchandising_slots_one_featured
  on public.merchandising_slots (slot_key)
  where slot_key = 'home_featured';

-- Public cover bucket. Self-healing like 20260911160000: re-running drives it back to this state.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('covers', 'covers', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- updated_at maintenance ------------------------------------------------------------------------

create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger authors_touch_updated_at before update on public.authors
  for each row execute function public.touch_updated_at();
create trigger series_touch_updated_at before update on public.series
  for each row execute function public.touch_updated_at();
create trigger books_touch_updated_at before update on public.books
  for each row execute function public.touch_updated_at();
create trigger book_localizations_touch_updated_at before update on public.book_localizations
  for each row execute function public.touch_updated_at();
create trigger author_localizations_touch_updated_at before update on public.author_localizations
  for each row execute function public.touch_updated_at();
create trigger topic_localizations_touch_updated_at before update on public.topic_localizations
  for each row execute function public.touch_updated_at();
create trigger series_localizations_touch_updated_at before update on public.series_localizations
  for each row execute function public.touch_updated_at();

-- Audit for direct catalog writes ------------------------------------------------------------------

-- Long text values are cut to 200 characters so descriptions don't bloat the audit log.
create function public.audit_value_summary(p_value jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_value) = 'string' and length(p_value #>> '{}') > 200
      then to_jsonb(left(p_value #>> '{}', 200) || '…')
    else p_value
  end;
$$;

create function public.audit_catalog_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_key text;
  v_actor_profile_id uuid;
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;

  if tg_op = 'UPDATE' then
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key <> 'updated_at' and (v_old -> v_key) is distinct from (v_new -> v_key) then
        v_changes := v_changes || jsonb_build_object(
          v_key,
          jsonb_build_object(
            'from', public.audit_value_summary(v_old -> v_key),
            'to', public.audit_value_summary(v_new -> v_key)
          )
        );
      end if;
    end loop;
    if v_changes = '{}'::jsonb then
      return new;
    end if;
  else
    for v_key in select jsonb_object_keys(coalesce(v_new, v_old)) loop
      v_changes := v_changes || jsonb_build_object(v_key, public.audit_value_summary(coalesce(v_new, v_old) -> v_key));
    end loop;
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();

  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (
    v_actor_profile_id,
    'catalog_' || lower(tg_op),
    tg_table_name,
    (coalesce(v_new, v_old) ->> 'id')::uuid,
    jsonb_build_object('changes', v_changes)
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke execute on function public.audit_catalog_row_change() from public, anon, authenticated;

create trigger authors_audit after insert or update on public.authors
  for each row execute function public.audit_catalog_row_change();
create trigger series_audit after insert or update on public.series
  for each row execute function public.audit_catalog_row_change();
create trigger topics_audit after insert or update on public.topics
  for each row execute function public.audit_catalog_row_change();
-- Only the admin-editable book columns. Status and the active publication pointer are changed by
-- RPCs that write their own audit rows.
create trigger books_audit after update of canonical_key, original_language, primary_author_id on public.books
  for each row execute function public.audit_catalog_row_change();
create trigger editions_audit after update on public.editions
  for each row execute function public.audit_catalog_row_change();
create trigger skus_audit after update on public.skus
  for each row execute function public.audit_catalog_row_change();
create trigger offers_audit after update on public.offers
  for each row execute function public.audit_catalog_row_change();

-- RLS ---------------------------------------------------------------------------------------------

alter table public.series enable row level security;
alter table public.book_series enable row level security;
alter table public.author_localizations enable row level security;
alter table public.topic_localizations enable row level security;
alter table public.series_localizations enable row level security;

-- Admin reads. Same (select public.is_admin()) InitPlan idiom as 20260911120000.
create policy "admin reads series" on public.series
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads book series" on public.book_series
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads author localizations" on public.author_localizations
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads topic localizations" on public.topic_localizations
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads series localizations" on public.series_localizations
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads topics" on public.topics
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads book topics" on public.book_topics
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads media assets" on public.media_assets
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads profiles" on public.profiles
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads entitlements" on public.entitlements
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads library items" on public.library_items
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads orders" on public.orders
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads order items" on public.order_items
  for select to authenticated using ((select public.is_admin()));

-- Admin direct writes.
create policy "admin inserts authors" on public.authors
  for insert to authenticated with check ((select public.is_admin()));
create policy "admin updates authors" on public.authors
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admin inserts series" on public.series
  for insert to authenticated with check ((select public.is_admin()));
create policy "admin updates series" on public.series
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admin inserts topics" on public.topics
  for insert to authenticated with check ((select public.is_admin()));
create policy "admin updates topics" on public.topics
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admin updates books" on public.books
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admin updates editions" on public.editions
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admin updates skus" on public.skus
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admin updates offers" on public.offers
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- Privileges -------------------------------------------------------------------------------------

grant select on
  public.series,
  public.book_series,
  public.author_localizations,
  public.topic_localizations,
  public.series_localizations,
  public.topics,
  public.book_topics,
  public.media_assets
to authenticated;

revoke all on
  public.series,
  public.book_series,
  public.author_localizations,
  public.topic_localizations,
  public.series_localizations
from anon;

-- Column-level, not table-level: supabase/tests/001_catalog_publishing_rls.sql pins that
-- authenticated holds no table-level write privilege on the public catalog tables, and column
-- grants also keep id, timestamps, and biography out of browser reach.
grant insert (canonical_slug, display_name, status), update (canonical_slug, display_name, status) on public.authors to authenticated;
grant insert (canonical_slug, display_name, status), update (canonical_slug, display_name, status) on public.series to authenticated;
grant insert (canonical_slug, name, status), update (canonical_slug, name, status) on public.topics to authenticated;
grant update (canonical_key, original_language, primary_author_id) on public.books to authenticated;
grant update (language_code, isbn, edition_number, publication_date) on public.editions to authenticated;
grant update (active) on public.skus to authenticated;
grant update (market_code, currency, price_minor, active, starts_at, ends_at) on public.offers to authenticated;

grant select, insert, update, delete on
  public.series,
  public.book_series,
  public.author_localizations,
  public.topic_localizations,
  public.series_localizations
to service_role;
```

- [ ] **Step 4: Update the merchandising fixture that the new check constraint rejects**

In `supabase/tests/002_access_admin_rls.sql`, change the fixture insert:

```sql
insert into public.merchandising_slots (id, slot_key, book_id)
values ('76000000-0000-0000-0000-000000000001', 'home_featured', '30000000-0000-0000-0000-000000000001');
```

- [ ] **Step 5: Reset, test, and regenerate types**

Run:

```bash
supabase db reset
supabase test db
supabase gen types --local --lang typescript > lib/supabase/database.types.ts
npm run check
```

Add `--workdir <scratch>` to each `supabase` command when using a scratch stack.
Expected: every pgTAP file passes, including 19 assertions in `011`; `npm run check` passes.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260913100000_catalog_admin_schema.sql supabase/tests/011_catalog_admin_schema.sql supabase/tests/002_access_admin_rls.sql lib/supabase/database.types.ts
git commit -m "feat: add catalog admin schema, policies, and audit trigger"
```

### Task 2: Catalog admin RPCs

**Files:**
- Create: `supabase/migrations/20260913110000_catalog_admin_rpcs.sql`
- Create: `supabase/tests/012_catalog_admin_rpcs.sql`
- Modify: `lib/supabase/database.types.ts` (regenerated)

**Interfaces:**
- Consumes: Task 1 tables and `extensions.unaccent`.
- Produces (all `security definer`, `set search_path = ''`, `is_admin()` checked first, EXECUTE granted to `authenticated` only unless noted):
  - `admin_create_book(p_canonical_key text, p_author_name text, p_locale text, p_language text, p_title text, p_slug text, p_market text, p_currency text, p_price_minor bigint) returns uuid` — reuses the author whose `canonical_slug` equals the unaccented, kebab-cased name; otherwise creates it.
  - `record_slug_redirect(p_old_path text, p_new_path text) returns void` — internal; no role may execute it directly.
  - `admin_save_book_localization(p_book_id uuid, p_locale text, p_slug text, p_title text, p_subtitle text, p_short_description text, p_description text, p_audience text, p_key_ideas jsonb, p_faq jsonb, p_seo_title text, p_seo_description text) returns uuid`
  - `admin_save_entity_localization(p_entity_type text, p_entity_id uuid, p_locale text, p_slug text, p_name text, p_description text) returns uuid` — `p_entity_type` is `author`, `topic`, or `series`.
  - `admin_set_book_relations(p_book_id uuid, p_topic_ids uuid[], p_series_id uuid, p_series_position integer) returns void`
  - `admin_set_book_cover(p_book_id uuid, p_storage_key text, p_alt_text text, p_width integer, p_height integer) returns uuid`
  - `admin_set_merchandising(p_slot_key text, p_book_ids uuid[]) returns void`
- Error codes callers map: `42501` not admin, `22023` invalid input, `P0002` missing row, `23505` unique violation (slug or series position taken).
- Public paths used for redirects: `/{locale}/books/{slug}`, `/{locale}/authors/{slug}`, `/{locale}/topics/{slug}`, `/{locale}/series/{slug}`. A redirect is recorded only when the book or entity is `published` and the slug actually changes.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/012_catalog_admin_rpcs.sql`:

```sql
begin;
select plan(31);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's1-rpc-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's1-rpc-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'c1000000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name)
values ('c2000000-0000-0000-0000-000000000001', 's1-author', 'S1 Author');
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values
  ('c3000000-0000-0000-0000-000000000001', 's1-book-a', 'vi', 'c2000000-0000-0000-0000-000000000001', 'draft'),
  ('c3000000-0000-0000-0000-000000000002', 's1-book-b', 'vi', 'c2000000-0000-0000-0000-000000000001', 'published');
insert into public.book_localizations (book_id, locale, slug, title)
values
  ('c3000000-0000-0000-0000-000000000001', 'vi', 'book-a-vi', 'Book A'),
  ('c3000000-0000-0000-0000-000000000002', 'vi', 'book-b-old', 'Book B');
insert into public.redirects (source_path, destination_path)
values ('/vi/books/book-b-older', '/vi/books/book-b-old');
insert into public.topics (id, canonical_slug, name)
values ('c5000000-0000-0000-0000-000000000001', 's1-topic-one', 'Topic One'),
       ('c5000000-0000-0000-0000-000000000002', 's1-topic-two', 'Topic Two');
insert into public.series (id, canonical_slug, display_name, status)
values ('c4000000-0000-0000-0000-000000000001', 's1-series', 'S1 Series', 'published');

-- (1)-(2) Grants.
select is(
  has_function_privilege('anon', 'public.admin_create_book(text, text, text, text, text, text, text, text, bigint)', 'EXECUTE'),
  false,
  'anon holds no EXECUTE on admin_create_book'
);
select is(
  has_function_privilege('authenticated', 'public.record_slug_redirect(text, text)', 'EXECUTE'),
  false,
  'authenticated cannot call record_slug_redirect directly'
);

-- (3) Non-admins are rejected by the function itself.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$select public.admin_create_book('reader-book', 'Reader', 'vi', 'vi', 'Reader Book', 'reader-book', 'VN', 'VND', 0)$$,
  '42501',
  null,
  'non-admin cannot create a book'
);

-- (4)-(6) admin_create_book reuses an existing author by derived slug, and unaccents new names.
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select is(
  -- The RPC call sits in an uncorrelated scalar subquery so it runs exactly once, not once per row.
  (select b.primary_author_id from public.books b
   where b.id = (select public.admin_create_book('s1-new-book', 'S1 Author', 'vi', 'vi', 'New Book', 's1-new-book', 'VN', 'VND', 0))),
  'c2000000-0000-0000-0000-000000000001'::uuid,
  'admin_create_book reuses the existing author'
);
select lives_ok(
  $$select public.admin_create_book('s1-viet-book', 'Phương Bùi', 'vi', 'vi', 'Sách Việt', 's1-viet-book', 'VN', 'VND', 0)$$,
  'admin_create_book accepts a Vietnamese author name'
);
reset role;
select ok(exists(select 1 from public.authors where canonical_slug = 'phuong-bui'), 'Vietnamese author slug is unaccented');

-- (7)-(8) Renaming a draft book's slug records no redirect.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select public.admin_save_book_localization('c3000000-0000-0000-0000-000000000001', 'vi', 'book-a-renamed', 'Book A', null, null, 'About A', null, '[]'::jsonb, '[]'::jsonb, null, null)$$,
  'admin renames a draft book slug'
);
reset role;
select is((select count(*)::bigint from public.redirects where source_path = '/vi/books/book-a-vi'), 0::bigint, 'draft rename records no redirect');

-- (9)-(11) Renaming a published book's slug records a redirect and rewrites the older one.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select public.admin_save_book_localization('c3000000-0000-0000-0000-000000000002', 'vi', 'book-b-new', 'Book B', null, null, 'About B', 'Readers', '[{"title":"T","summary":"S"}]'::jsonb, '[]'::jsonb, null, null)$$,
  'admin renames a published book slug'
);
reset role;
select is((select destination_path from public.redirects where source_path = '/vi/books/book-b-old'), '/vi/books/book-b-new', 'old slug redirects to new slug');
select is((select destination_path from public.redirects where source_path = '/vi/books/book-b-older'), '/vi/books/book-b-new', 'older redirect is rewritten, so nothing chains');

-- (12)-(14) Renaming back removes the redirect that would loop.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select public.admin_save_book_localization('c3000000-0000-0000-0000-000000000002', 'vi', 'book-b-old', 'Book B', null, null, 'About B', 'Readers', '[{"title":"T","summary":"S"}]'::jsonb, '[]'::jsonb, null, null)$$,
  'admin renames the slug back'
);
reset role;
select is((select count(*)::bigint from public.redirects where source_path = '/vi/books/book-b-old'), 0::bigint, 'the current slug is never a redirect source');
select is((select destination_path from public.redirects where source_path = '/vi/books/book-b-new'), '/vi/books/book-b-old', 'the abandoned slug redirects to the restored one');

-- (15) Book-page content is stored.
select is(
  (select key_ideas from public.book_localizations where book_id = 'c3000000-0000-0000-0000-000000000002' and locale = 'vi'),
  '[{"title":"T","summary":"S"}]'::jsonb,
  'key ideas are stored as given'
);

-- (16)-(17) Entity localizations.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select public.admin_save_entity_localization('author', 'c2000000-0000-0000-0000-000000000001', 'en', 'author-en', 'S1 Author', 'Bio')$$,
  'admin saves an author localization'
);
select throws_ok(
  $$select public.admin_save_entity_localization('publisher', 'c2000000-0000-0000-0000-000000000001', 'en', 'x', 'X', null)$$,
  '22023',
  null,
  'unknown entity type is rejected'
);

-- (18)-(22) Relations are replaced as a set.
select lives_ok(
  $$select public.admin_set_book_relations('c3000000-0000-0000-0000-000000000001', array['c5000000-0000-0000-0000-000000000001', 'c5000000-0000-0000-0000-000000000002']::uuid[], 'c4000000-0000-0000-0000-000000000001', 1)$$,
  'admin sets topics and series'
);
select is((select count(*)::bigint from public.book_topics where book_id = 'c3000000-0000-0000-0000-000000000001'), 2::bigint, 'two topics attached');
select lives_ok(
  $$select public.admin_set_book_relations('c3000000-0000-0000-0000-000000000001', array['c5000000-0000-0000-0000-000000000002']::uuid[], null, null)$$,
  'admin replaces relations'
);
select is((select count(*)::bigint from public.book_topics where book_id = 'c3000000-0000-0000-0000-000000000001'), 1::bigint, 'topics replaced');
select is((select count(*)::bigint from public.book_series where book_id = 'c3000000-0000-0000-0000-000000000001'), 0::bigint, 'series membership removed');

-- (23)-(27) Cover: key must belong to the book; replacing keeps one row.
select throws_ok(
  $$select public.admin_set_book_cover('c3000000-0000-0000-0000-000000000001', 'books/c3000000-0000-0000-0000-000000000002/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png', 'Cover', 600, 900)$$,
  '22023',
  null,
  'a cover key under another book is rejected'
);
select lives_ok(
  $$select public.admin_set_book_cover('c3000000-0000-0000-0000-000000000001', 'books/c3000000-0000-0000-0000-000000000001/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png', 'Cover', 600, 900)$$,
  'admin sets a cover'
);
select lives_ok(
  $$select public.admin_set_book_cover('c3000000-0000-0000-0000-000000000001', 'books/c3000000-0000-0000-0000-000000000001/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.webp', 'New cover', 600, 900)$$,
  'admin replaces the cover'
);
reset role;
select is((select count(*)::bigint from public.media_assets where owner_id = 'c3000000-0000-0000-0000-000000000001' and kind = 'cover'), 1::bigint, 'one cover row per book');
select is(
  (select storage_key from public.media_assets where owner_id = 'c3000000-0000-0000-0000-000000000001' and kind = 'cover'),
  'books/c3000000-0000-0000-0000-000000000001/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.webp',
  'the replacement key is stored'
);

-- (28)-(31) Merchandising.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.admin_set_merchandising('home_featured', array['c3000000-0000-0000-0000-000000000001', 'c3000000-0000-0000-0000-000000000002']::uuid[])$$,
  '22023',
  null,
  'home_featured accepts at most one book'
);
select lives_ok(
  $$select public.admin_set_merchandising('home_shelf', array['c3000000-0000-0000-0000-000000000002', 'c3000000-0000-0000-0000-000000000001']::uuid[])$$,
  'admin sets the home shelf'
);
reset role;
select results_eq(
  $$select book_id from public.merchandising_slots where slot_key = 'home_shelf' order by position$$,
  $$values ('c3000000-0000-0000-0000-000000000002'::uuid), ('c3000000-0000-0000-0000-000000000001'::uuid)$$,
  'shelf order follows the submitted order'
);
select is((select count(*)::bigint from public.audit_logs where action = 'set_merchandising'), 1::bigint, 'merchandising change is audited once');

select * from finish();
rollback;
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `supabase test db`
Expected: FAIL in `012_catalog_admin_rpcs.sql` because `public.admin_create_book` does not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260913110000_catalog_admin_rpcs.sql`:

```sql
-- S1 catalog admin RPCs: every multi-row or redirect-producing catalog write. Each function checks
-- is_admin() first (auth.uid() based, so callers use the session client, never service_role) and
-- writes its own audit_logs row.

-- admin_create_book: replaces admin_create_ebook for the admin form. Unlike admin_create_ebook it
-- reuses an existing author whose canonical_slug matches the derived slug, so a second book by the
-- same author no longer fails. admin_create_ebook stays in place for existing callers and tests.
create function public.admin_create_book(
  p_canonical_key text,
  p_author_name text,
  p_locale text,
  p_language text,
  p_title text,
  p_slug text,
  p_market text,
  p_currency text,
  p_price_minor bigint
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_author_slug text;
  v_author_id uuid;
  v_book_id uuid;
  v_edition_id uuid;
  v_sku_id uuid;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_create_book: caller is not an admin' using errcode = '42501';
  end if;

  v_author_slug := trim(both '-' from lower(regexp_replace(extensions.unaccent(coalesce(p_author_name, '')), '[^a-zA-Z0-9]+', '-', 'g')));
  if v_author_slug = '' then
    raise exception 'admin_create_book: author name must contain letters or digits' using errcode = '22023';
  end if;

  select id into v_author_id from public.authors where canonical_slug = v_author_slug;
  if v_author_id is null then
    insert into public.authors (canonical_slug, display_name)
    values (v_author_slug, trim(p_author_name))
    returning id into v_author_id;
  end if;

  insert into public.books (canonical_key, original_language, primary_author_id)
  values (p_canonical_key, p_language, v_author_id)
  returning id into v_book_id;

  insert into public.book_localizations (book_id, locale, slug, title)
  values (v_book_id, p_locale, p_slug, p_title);

  insert into public.editions (book_id, language_code)
  values (v_book_id, p_language)
  returning id into v_edition_id;

  insert into public.skus (edition_id, sku_code)
  values (v_edition_id, p_canonical_key || '-ebook')
  returning id into v_sku_id;

  insert into public.offers (sku_id, market_code, currency, price_minor)
  values (v_sku_id, p_market, p_currency, p_price_minor);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'create_book', 'books', v_book_id,
          jsonb_build_object('canonical_key', p_canonical_key, 'author_id', v_author_id, 'locale', p_locale, 'slug', p_slug));

  return v_book_id;
end;
$$;

-- record_slug_redirect: keeps the redirect map free of chains and loops.
--   1. The new path must never be a redirect source (renaming back to an old slug).
--   2. Anything that pointed at the old path now points straight at the new path.
--   3. The old path points at the new path.
create function public.record_slug_redirect(p_old_path text, p_new_path text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_old_path = p_new_path then
    return;
  end if;

  delete from public.redirects where source_path = p_new_path;
  update public.redirects set destination_path = p_new_path where destination_path = p_old_path;
  insert into public.redirects (source_path, destination_path)
  values (p_old_path, p_new_path)
  on conflict (source_path) do update set destination_path = excluded.destination_path;
end;
$$;

create function public.admin_save_book_localization(
  p_book_id uuid,
  p_locale text,
  p_slug text,
  p_title text,
  p_subtitle text,
  p_short_description text,
  p_description text,
  p_audience text,
  p_key_ideas jsonb,
  p_faq jsonb,
  p_seo_title text,
  p_seo_description text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_book_status public.content_status;
  v_localization_id uuid;
  v_old_slug text;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_save_book_localization: caller is not an admin' using errcode = '42501';
  end if;
  if p_locale not in ('vi', 'en') then
    raise exception 'admin_save_book_localization: unsupported locale %', p_locale using errcode = '22023';
  end if;

  select status into v_book_status from public.books where id = p_book_id for update;
  if v_book_status is null then
    raise exception 'admin_save_book_localization: book % does not exist', p_book_id using errcode = 'P0002';
  end if;

  select id, slug into v_localization_id, v_old_slug
  from public.book_localizations
  where book_id = p_book_id and locale = p_locale
  for update;

  if v_localization_id is null then
    insert into public.book_localizations (
      book_id, locale, slug, title, subtitle, short_description, description,
      audience, key_ideas, faq, seo_title, seo_description
    )
    values (
      p_book_id, p_locale, p_slug, p_title, p_subtitle, p_short_description, p_description,
      p_audience, coalesce(p_key_ideas, '[]'::jsonb), coalesce(p_faq, '[]'::jsonb), p_seo_title, p_seo_description
    )
    returning id into v_localization_id;
  else
    update public.book_localizations
    set slug = p_slug,
        title = p_title,
        subtitle = p_subtitle,
        short_description = p_short_description,
        description = p_description,
        audience = p_audience,
        key_ideas = coalesce(p_key_ideas, '[]'::jsonb),
        faq = coalesce(p_faq, '[]'::jsonb),
        seo_title = p_seo_title,
        seo_description = p_seo_description
    where id = v_localization_id;

    if v_book_status = 'published' and v_old_slug <> p_slug then
      perform public.record_slug_redirect(
        format('/%s/books/%s', p_locale, v_old_slug),
        format('/%s/books/%s', p_locale, p_slug)
      );
    end if;
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'save_book_localization', 'books', p_book_id,
          jsonb_build_object('locale', p_locale, 'slug_from', v_old_slug, 'slug_to', p_slug));

  return v_localization_id;
end;
$$;

create function public.admin_save_entity_localization(
  p_entity_type text,
  p_entity_id uuid,
  p_locale text,
  p_slug text,
  p_name text,
  p_description text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base_table text;
  v_localization_table text;
  v_foreign_key text;
  v_path_segment text;
  v_status text;
  v_localization_id uuid;
  v_old_slug text;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_save_entity_localization: caller is not an admin' using errcode = '42501';
  end if;

  case p_entity_type
    when 'author' then
      v_base_table := 'authors'; v_localization_table := 'author_localizations'; v_foreign_key := 'author_id'; v_path_segment := 'authors';
    when 'topic' then
      v_base_table := 'topics'; v_localization_table := 'topic_localizations'; v_foreign_key := 'topic_id'; v_path_segment := 'topics';
    when 'series' then
      v_base_table := 'series'; v_localization_table := 'series_localizations'; v_foreign_key := 'series_id'; v_path_segment := 'series';
    else
      raise exception 'admin_save_entity_localization: unknown entity type %', p_entity_type using errcode = '22023';
  end case;

  if p_locale not in ('vi', 'en') then
    raise exception 'admin_save_entity_localization: unsupported locale %', p_locale using errcode = '22023';
  end if;

  execute format('select status::text from public.%I where id = $1 for update', v_base_table)
    into v_status using p_entity_id;
  if v_status is null then
    raise exception 'admin_save_entity_localization: % % does not exist', p_entity_type, p_entity_id using errcode = 'P0002';
  end if;

  execute format('select id, slug from public.%I where %I = $1 and locale = $2 for update', v_localization_table, v_foreign_key)
    into v_localization_id, v_old_slug using p_entity_id, p_locale;

  if v_localization_id is null then
    execute format(
      'insert into public.%I (%I, locale, slug, name, description) values ($1, $2, $3, $4, $5) returning id',
      v_localization_table, v_foreign_key
    ) into v_localization_id using p_entity_id, p_locale, p_slug, p_name, p_description;
  else
    execute format('update public.%I set slug = $1, name = $2, description = $3 where id = $4', v_localization_table)
      using p_slug, p_name, p_description, v_localization_id;

    if v_status = 'published' and v_old_slug <> p_slug then
      perform public.record_slug_redirect(
        format('/%s/%s/%s', p_locale, v_path_segment, v_old_slug),
        format('/%s/%s/%s', p_locale, v_path_segment, p_slug)
      );
    end if;
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'save_' || p_entity_type || '_localization', v_base_table, p_entity_id,
          jsonb_build_object('locale', p_locale, 'slug_from', v_old_slug, 'slug_to', p_slug));

  return v_localization_id;
end;
$$;

create function public.admin_set_book_relations(
  p_book_id uuid,
  p_topic_ids uuid[],
  p_series_id uuid,
  p_series_position integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_set_book_relations: caller is not an admin' using errcode = '42501';
  end if;

  perform 1 from public.books where id = p_book_id for update;
  if not found then
    raise exception 'admin_set_book_relations: book % does not exist', p_book_id using errcode = 'P0002';
  end if;

  if p_series_id is not null and (p_series_position is null or p_series_position < 1) then
    raise exception 'admin_set_book_relations: a series position of 1 or more is required' using errcode = '22023';
  end if;

  delete from public.book_topics where book_id = p_book_id;
  insert into public.book_topics (book_id, topic_id)
  select distinct p_book_id, topic_id from unnest(coalesce(p_topic_ids, array[]::uuid[])) as topic_id;

  delete from public.book_series where book_id = p_book_id;
  if p_series_id is not null then
    insert into public.book_series (book_id, series_id, position)
    values (p_book_id, p_series_id, p_series_position);
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'set_book_relations', 'books', p_book_id,
          jsonb_build_object('topic_ids', to_jsonb(coalesce(p_topic_ids, array[]::uuid[])),
                             'series_id', p_series_id, 'series_position', p_series_position));
end;
$$;

create function public.admin_set_book_cover(
  p_book_id uuid,
  p_storage_key text,
  p_alt_text text,
  p_width integer,
  p_height integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_media_id uuid;
  v_previous_key text;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_set_book_cover: caller is not an admin' using errcode = '42501';
  end if;

  perform 1 from public.books where id = p_book_id for update;
  if not found then
    raise exception 'admin_set_book_cover: book % does not exist', p_book_id using errcode = 'P0002';
  end if;

  -- The key is minted server-side (lib/data/covers.ts); this re-checks it so a caller can never
  -- attach another book's object or an arbitrary path.
  if p_storage_key !~ ('^books/' || p_book_id::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$') then
    raise exception 'admin_set_book_cover: storage key does not belong to book %', p_book_id using errcode = '22023';
  end if;
  if p_alt_text is null or length(trim(p_alt_text)) = 0 then
    raise exception 'admin_set_book_cover: alt text is required' using errcode = '22023';
  end if;

  select id, storage_key into v_media_id, v_previous_key
  from public.media_assets
  where owner_type = 'book' and owner_id = p_book_id and kind = 'cover'
  for update;

  if v_media_id is null then
    insert into public.media_assets (owner_type, owner_id, kind, storage_key, alt_text, width, height)
    values ('book', p_book_id, 'cover', p_storage_key, trim(p_alt_text), p_width, p_height)
    returning id into v_media_id;
  else
    update public.media_assets
    set storage_key = p_storage_key, alt_text = trim(p_alt_text), width = p_width, height = p_height
    where id = v_media_id;
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'set_book_cover', 'books', p_book_id,
          jsonb_build_object('previous_storage_key', v_previous_key, 'storage_key', p_storage_key));

  return v_media_id;
end;
$$;

create function public.admin_set_merchandising(p_slot_key text, p_book_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_book_ids uuid[] := coalesce(p_book_ids, array[]::uuid[]);
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_set_merchandising: caller is not an admin' using errcode = '42501';
  end if;
  if p_slot_key not in ('home_featured', 'home_shelf') then
    raise exception 'admin_set_merchandising: unknown slot %', p_slot_key using errcode = '22023';
  end if;
  if p_slot_key = 'home_featured' and cardinality(v_book_ids) > 1 then
    raise exception 'admin_set_merchandising: home_featured holds at most one book' using errcode = '22023';
  end if;
  if cardinality(v_book_ids) <> (select count(distinct b) from unnest(v_book_ids) as b) then
    raise exception 'admin_set_merchandising: a book appears twice' using errcode = '22023';
  end if;
  if cardinality(v_book_ids) <> (select count(*) from public.books where id = any(v_book_ids)) then
    raise exception 'admin_set_merchandising: a book does not exist' using errcode = 'P0002';
  end if;

  delete from public.merchandising_slots where slot_key = p_slot_key;
  insert into public.merchandising_slots (slot_key, book_id, position)
  select p_slot_key, book_id, ordinality::integer
  from unnest(v_book_ids) with ordinality as t(book_id, ordinality);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'set_merchandising', 'merchandising_slots', null,
          jsonb_build_object('slot_key', p_slot_key, 'book_ids', to_jsonb(v_book_ids)));
end;
$$;

-- Grants. EXECUTE to authenticated only: is_admin() can never pass under service_role.
revoke execute on function public.record_slug_redirect(text, text) from public, anon, authenticated;

revoke execute on function public.admin_create_book(text, text, text, text, text, text, text, text, bigint) from public, anon;
grant execute on function public.admin_create_book(text, text, text, text, text, text, text, text, bigint) to authenticated;

revoke execute on function public.admin_save_book_localization(uuid, text, text, text, text, text, text, text, jsonb, jsonb, text, text) from public, anon;
grant execute on function public.admin_save_book_localization(uuid, text, text, text, text, text, text, text, jsonb, jsonb, text, text) to authenticated;

revoke execute on function public.admin_save_entity_localization(text, uuid, text, text, text, text) from public, anon;
grant execute on function public.admin_save_entity_localization(text, uuid, text, text, text, text) to authenticated;

revoke execute on function public.admin_set_book_relations(uuid, uuid[], uuid, integer) from public, anon;
grant execute on function public.admin_set_book_relations(uuid, uuid[], uuid, integer) to authenticated;

revoke execute on function public.admin_set_book_cover(uuid, text, text, integer, integer) from public, anon;
grant execute on function public.admin_set_book_cover(uuid, text, text, integer, integer) to authenticated;

revoke execute on function public.admin_set_merchandising(text, uuid[]) from public, anon;
grant execute on function public.admin_set_merchandising(text, uuid[]) to authenticated;
```

- [ ] **Step 4: Reset, test, and regenerate types**

Run:

```bash
supabase db reset
supabase test db
supabase gen types --local --lang typescript > lib/supabase/database.types.ts
npm run check
```

Expected: `012` passes 31 assertions; every earlier pgTAP file still passes; `npm run check` passes.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260913110000_catalog_admin_rpcs.sql supabase/tests/012_catalog_admin_rpcs.sql lib/supabase/database.types.ts
git commit -m "feat: add catalog admin RPCs with audited slug redirects"
```

### Task 3: Book publish readiness

**Files:**
- Create: `lib/catalog/readiness.ts`
- Create: `lib/catalog/readiness.test.ts`
- Create: `supabase/migrations/20260913120000_book_publish_readiness.sql`
- Create: `supabase/tests/013_book_publish_readiness.sql`
- Modify: `supabase/tests/007_publication_transitions.sql` (assertions 16, 17, and the two "rejecting v4" book-status assertions)
- Modify: `lib/supabase/database.types.ts` (regenerated)

**Interfaces:**
- Consumes: Task 1 `media_assets_one_cover_per_book`; Task 2 cover RPC shape.
- Produces:
  - SQL `book_readiness_issues(p_book_id uuid) returns text[]` (internal, no browser EXECUTE).
  - SQL `publish_book(p_book_id uuid) returns void` — raises `EB010` with message `publish_book: book is not ready: <codes>`; on success sets the book and its primary author to `published` and writes audit action `publish_book`.
  - SQL `unpublish_book(p_book_id uuid) returns void` — sets the book to `draft`, audit action `unpublish_book`.
  - `publish_publication(uuid)` no longer changes `books.status` or `authors.status`.
  - TypeScript, `lib/catalog/readiness.ts`:

```ts
export type ReadinessIssueCode = "missing_localization" | "missing_author" | "missing_cover" | "missing_offer" | "missing_publication";
export type BookEditorSection = "details" | "localizations" | "offer" | "cover" | "relations" | "epub" | "publish";
export type BookReadinessSnapshot = {
  localizations: { title: string; slug: string; description: string | null }[];
  hasAuthor: boolean;
  hasCover: boolean;
  hasActiveOffer: boolean;
  hasPublishedActivePublication: boolean;
};
export function checkBookReadiness(snapshot: BookReadinessSnapshot): ReadinessIssueCode[];
export const readinessIssueSection: Record<ReadinessIssueCode, BookEditorSection>;
export const readinessIssueMessage: Record<ReadinessIssueCode, string>;
export function parseReadinessError(message: string): ReadinessIssueCode[] | null;
```

> **Expected temporary break:** after this task, `e2e/ebook-golden-path.spec.ts` (anonymous-visibility step) and `e2e/admin-publication-transitions.spec.ts` (book status assertion) fail, because publishing a version no longer publishes the book. Task 10 adds the "Publish book" UI and updates both specs. Playwright runs only at the S1 gate (Task 12), so every per-task check here stays green.

- [ ] **Step 1: Write the failing unit test**

Create `lib/catalog/readiness.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  checkBookReadiness,
  parseReadinessError,
  readinessIssueMessage,
  readinessIssueSection,
  type BookReadinessSnapshot,
} from "@/lib/catalog/readiness";

const ready: BookReadinessSnapshot = {
  localizations: [{ title: "Quan sát tỉnh biết", slug: "quan-sat-tinh-biet", description: "Một cuốn sách." }],
  hasAuthor: true,
  hasCover: true,
  hasActiveOffer: true,
  hasPublishedActivePublication: true,
};

describe("checkBookReadiness", () => {
  it("returns no issues for a complete book", () => {
    expect(checkBookReadiness(ready)).toEqual([]);
  });

  it("requires a localization with title, slug, and a non-blank description", () => {
    expect(checkBookReadiness({ ...ready, localizations: [] })).toEqual(["missing_localization"]);
    expect(
      checkBookReadiness({ ...ready, localizations: [{ title: "T", slug: "t", description: "   " }] }),
    ).toEqual(["missing_localization"]);
  });

  it("accepts a book when any one locale is complete", () => {
    expect(
      checkBookReadiness({
        ...ready,
        localizations: [
          { title: "T", slug: "t", description: null },
          { title: "U", slug: "u", description: "Done" },
        ],
      }),
    ).toEqual([]);
  });

  it("lists every missing piece in the same order the database reports them", () => {
    expect(
      checkBookReadiness({
        localizations: [],
        hasAuthor: false,
        hasCover: false,
        hasActiveOffer: false,
        hasPublishedActivePublication: false,
      }),
    ).toEqual(["missing_localization", "missing_author", "missing_cover", "missing_offer", "missing_publication"]);
  });

  it("maps every issue to an editor section and a message", () => {
    for (const code of checkBookReadiness({ ...ready, localizations: [], hasAuthor: false, hasCover: false, hasActiveOffer: false, hasPublishedActivePublication: false })) {
      expect(readinessIssueSection[code]).toBeTruthy();
      expect(readinessIssueMessage[code]).toBeTruthy();
    }
  });
});

describe("parseReadinessError", () => {
  it("reads the codes out of publish_book's EB010 message", () => {
    expect(parseReadinessError("publish_book: book is not ready: missing_cover,missing_offer")).toEqual([
      "missing_cover",
      "missing_offer",
    ]);
  });

  it("ignores unknown codes and unrelated messages", () => {
    expect(parseReadinessError("publish_book: book is not ready: missing_cover,drop_table")).toEqual(["missing_cover"]);
    expect(parseReadinessError("something else")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm test -- lib/catalog/readiness.test.ts`
Expected: FAIL because `@/lib/catalog/readiness` does not exist.

- [ ] **Step 3: Implement the readiness module**

Create `lib/catalog/readiness.ts`:

```ts
// The publish gate for a book, shared with SQL. publish_book (20260913120000) computes the same
// codes in the same order through book_readiness_issues(); keep the two in step. The editor uses
// this to show what is missing before an admin tries to publish; the database is what enforces it.

export const readinessIssueCodes = [
  "missing_localization",
  "missing_author",
  "missing_cover",
  "missing_offer",
  "missing_publication",
] as const;

export type ReadinessIssueCode = (typeof readinessIssueCodes)[number];

export type BookEditorSection = "details" | "localizations" | "offer" | "cover" | "relations" | "epub" | "publish";

export type BookReadinessSnapshot = {
  localizations: { title: string; slug: string; description: string | null }[];
  hasAuthor: boolean;
  hasCover: boolean;
  hasActiveOffer: boolean;
  hasPublishedActivePublication: boolean;
};

const isFilled = (value: string | null) => value !== null && value.trim().length > 0;

export function checkBookReadiness(snapshot: BookReadinessSnapshot): ReadinessIssueCode[] {
  const issues: ReadinessIssueCode[] = [];
  const hasCompleteLocalization = snapshot.localizations.some(
    (localization) => isFilled(localization.title) && isFilled(localization.slug) && isFilled(localization.description),
  );
  if (!hasCompleteLocalization) issues.push("missing_localization");
  if (!snapshot.hasAuthor) issues.push("missing_author");
  if (!snapshot.hasCover) issues.push("missing_cover");
  if (!snapshot.hasActiveOffer) issues.push("missing_offer");
  if (!snapshot.hasPublishedActivePublication) issues.push("missing_publication");
  return issues;
}

export const readinessIssueSection: Record<ReadinessIssueCode, BookEditorSection> = {
  missing_localization: "localizations",
  missing_author: "details",
  missing_cover: "cover",
  missing_offer: "offer",
  missing_publication: "epub",
};

// Admin UI copy is English-only, like every other /admin surface.
export const readinessIssueMessage: Record<ReadinessIssueCode, string> = {
  missing_localization: "Add a localization with a title, slug, and description.",
  missing_author: "Set the primary author.",
  missing_cover: "Upload a cover image.",
  missing_offer: "Activate the ebook offer.",
  missing_publication: "Publish an EPUB version.",
};

const readinessErrorPattern = /book is not ready: ([a-z_,]+)/;

export function parseReadinessError(message: string): ReadinessIssueCode[] | null {
  const match = readinessErrorPattern.exec(message);
  if (!match) return null;
  return match[1]
    .split(",")
    .filter((code): code is ReadinessIssueCode => (readinessIssueCodes as readonly string[]).includes(code));
}
```

- [ ] **Step 4: Run the unit test and verify it passes**

Run: `npm test -- lib/catalog/readiness.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing pgTAP test**

Create `supabase/tests/013_book_publish_readiness.sql`:

```sql
begin;
select plan(14);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's1-pub-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's1-pub-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'c1000000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name)
values ('c2000000-0000-0000-0000-000000000001', 's1-pub-author', 'S1 Pub Author');
insert into public.books (id, canonical_key, original_language, primary_author_id)
values ('c3000000-0000-0000-0000-000000000001', 's1-pub-book', 'vi', 'c2000000-0000-0000-0000-000000000001');
insert into public.book_localizations (book_id, locale, slug, title)
values ('c3000000-0000-0000-0000-000000000001', 'vi', 's1-pub-book', 'S1 Pub Book');
insert into public.editions (id, book_id, language_code)
values ('c6000000-0000-0000-0000-000000000001', 'c3000000-0000-0000-0000-000000000001', 'vi');
insert into public.skus (id, edition_id, sku_code)
values ('c7000000-0000-0000-0000-000000000001', 'c6000000-0000-0000-0000-000000000001', 's1-pub-book-ebook');
insert into public.offers (sku_id, market_code, currency, price_minor)
values ('c7000000-0000-0000-0000-000000000001', 'VN', 'VND', 0);
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
values ('c8000000-0000-0000-0000-000000000001', 'c6000000-0000-0000-0000-000000000001', 's1-pub/source.epub', 1, 'ready_for_preview');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status)
values ('c9000000-0000-0000-0000-000000000001', 'c8000000-0000-0000-0000-000000000001', 1, 's1-pub/manifest.json', 'ready_for_preview');

-- (1) The readiness helper is internal.
select is(
  has_function_privilege('authenticated', 'public.book_readiness_issues(uuid)', 'EXECUTE'),
  false,
  'authenticated cannot call book_readiness_issues directly'
);

-- (2)-(3) Non-admins are rejected; an incomplete book cannot be published.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000002', true);
select throws_ok($$select public.publish_book('c3000000-0000-0000-0000-000000000001')$$, '42501', null, 'non-admin cannot publish a book');
select throws_ok($$select public.unpublish_book('c3000000-0000-0000-0000-000000000001')$$, '42501', null, 'non-admin cannot unpublish a book');
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.publish_book('c3000000-0000-0000-0000-000000000001')$$,
  'EB010',
  'publish_book: book is not ready: missing_localization,missing_cover,missing_publication',
  'an incomplete book reports every missing piece'
);

-- (5)-(8) Publishing an EPUB version moves the pointer but no longer publishes the book or author.
select lives_ok($$select public.publish_publication('c9000000-0000-0000-0000-000000000001')$$, 'admin publishes the EPUB version');
reset role;
select is((select status from public.books where id = 'c3000000-0000-0000-0000-000000000001'), 'draft'::public.content_status, 'publish_publication leaves the book draft');
select is((select active_publication_id from public.books where id = 'c3000000-0000-0000-0000-000000000001'), 'c9000000-0000-0000-0000-000000000001'::uuid, 'publish_publication still moves the active pointer');
select is((select status from public.authors where id = 'c2000000-0000-0000-0000-000000000001'), 'draft'::public.content_status, 'publish_publication leaves the author draft');

-- (9)-(11) A complete book publishes, and the public can see it and its author.
update public.book_localizations set description = 'A complete description.' where book_id = 'c3000000-0000-0000-0000-000000000001';
insert into public.media_assets (owner_type, owner_id, kind, storage_key, alt_text)
values ('book', 'c3000000-0000-0000-0000-000000000001', 'cover', 'books/c3000000-0000-0000-0000-000000000001/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png', 'Cover');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.publish_book('c3000000-0000-0000-0000-000000000001')$$, 'admin publishes a complete book');
set local role anon;
select ok(exists(select 1 from public.books where id = 'c3000000-0000-0000-0000-000000000001'), 'anon sees the published book');
select ok(exists(select 1 from public.authors where id = 'c2000000-0000-0000-0000-000000000001'), 'anon sees the published book''s author');
reset role;

-- (12) Audited once.
select is((select count(*)::bigint from public.audit_logs where action = 'publish_book' and entity_id = 'c3000000-0000-0000-0000-000000000001'), 1::bigint, 'publish_book is audited once');

-- (13)-(14) Unpublishing hides the book again.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.unpublish_book('c3000000-0000-0000-0000-000000000001')$$, 'admin unpublishes the book');
set local role anon;
select ok(not exists(select 1 from public.books where id = 'c3000000-0000-0000-0000-000000000001'), 'anon no longer sees the unpublished book');
reset role;

select * from finish();
rollback;
```

- [ ] **Step 6: Run it and verify it fails**

Run: `supabase test db`
Expected: FAIL in `013_book_publish_readiness.sql` because `public.publish_book` does not exist.

- [ ] **Step 7: Write the migration**

Create `supabase/migrations/20260913120000_book_publish_readiness.sql`:

```sql
-- Book visibility becomes a catalog decision (S1). publish_publication keeps moving the active
-- publication pointer but no longer publishes the book or its author; publish_book does that, and
-- only when book_readiness_issues() is empty. The TypeScript mirror is lib/catalog/readiness.ts:
-- keep the codes and their order identical.

create function public.book_readiness_issues(p_book_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select array_remove(array[
    case when not exists (
      select 1 from public.book_localizations bl
      where bl.book_id = p_book_id
        and length(trim(bl.title)) > 0
        and length(trim(bl.slug)) > 0
        and length(trim(coalesce(bl.description, ''))) > 0
    ) then 'missing_localization' end,
    case when not exists (
      select 1 from public.books b
      join public.authors a on a.id = b.primary_author_id
      where b.id = p_book_id
    ) then 'missing_author' end,
    case when not exists (
      select 1 from public.media_assets m
      where m.owner_type = 'book' and m.owner_id = p_book_id and m.kind = 'cover'
    ) then 'missing_cover' end,
    case when not exists (
      select 1 from public.offers o
      join public.skus s on s.id = o.sku_id
      join public.editions e on e.id = s.edition_id
      where e.book_id = p_book_id
        and o.active and s.active
        and (o.starts_at is null or o.starts_at <= now())
        and (o.ends_at is null or o.ends_at > now())
    ) then 'missing_offer' end,
    case when not exists (
      select 1 from public.books b
      join public.ebook_publications p on p.id = b.active_publication_id
      where b.id = p_book_id and p.status = 'published'
    ) then 'missing_publication' end
  ], null);
$$;

revoke execute on function public.book_readiness_issues(uuid) from public, anon, authenticated;

create function public.publish_book(p_book_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_issues text[];
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'publish_book: caller is not an admin' using errcode = '42501';
  end if;

  perform 1 from public.books where id = p_book_id for update;
  if not found then
    raise exception 'publish_book: book % does not exist', p_book_id using errcode = 'P0002';
  end if;

  v_issues := public.book_readiness_issues(p_book_id);
  if cardinality(v_issues) > 0 then
    raise exception 'publish_book: book is not ready: %', array_to_string(v_issues, ',') using errcode = 'EB010';
  end if;

  update public.books set status = 'published' where id = p_book_id;
  -- Publishing a book publishes its byline too (the reason publish_publication used to do this).
  update public.authors set status = 'published'
  where id = (select primary_author_id from public.books where id = p_book_id);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'publish_book', 'books', p_book_id, '{}'::jsonb);
end;
$$;

create function public.unpublish_book(p_book_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'unpublish_book: caller is not an admin' using errcode = '42501';
  end if;

  update public.books set status = 'draft' where id = p_book_id;
  if not found then
    raise exception 'unpublish_book: book % does not exist', p_book_id using errcode = 'P0002';
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'unpublish_book', 'books', p_book_id, '{}'::jsonb);
end;
$$;

revoke execute on function public.publish_book(uuid) from public, anon;
grant execute on function public.publish_book(uuid) to authenticated;
revoke execute on function public.unpublish_book(uuid) from public, anon;
grant execute on function public.unpublish_book(uuid) to authenticated;

-- publish_publication, redefined without the books.status / authors.status side effects that
-- 20260911180000 added (Rulings BL and BO). Everything else is unchanged. `create or replace`
-- keeps the existing EXECUTE grants.
create or replace function public.publish_publication(p_publication_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_book_id uuid;
  v_asset_id uuid;
  v_status public.publication_status;
  v_previous_active_id uuid;
  v_previous_asset_id uuid;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'publish_publication: caller is not an admin' using errcode = '42501';
  end if;

  select e.book_id into v_book_id
  from public.ebook_publications p
  join public.ebook_assets a on a.id = p.ebook_asset_id
  join public.editions e on e.id = a.edition_id
  where p.id = p_publication_id;

  if v_book_id is null then
    raise exception 'publish_publication: publication % does not exist', p_publication_id using errcode = 'P0002';
  end if;

  select active_publication_id into v_previous_active_id
  from public.books
  where id = v_book_id
  for update;

  select p.status, a.id into v_status, v_asset_id
  from public.ebook_publications p
  join public.ebook_assets a on a.id = p.ebook_asset_id
  where p.id = p_publication_id
  for update of p, a;

  if v_status <> 'ready_for_preview' then
    raise exception 'publish_publication: publication % is % and cannot be published', p_publication_id, v_status
      using errcode = 'EB002';
  end if;

  if v_previous_active_id is not null then
    select p.ebook_asset_id into v_previous_asset_id
    from public.ebook_publications p
    join public.ebook_assets a on a.id = p.ebook_asset_id
    join public.editions e on e.id = a.edition_id
    where p.id = v_previous_active_id
      and e.book_id = v_book_id;

    if v_previous_asset_id is not null then
      update public.ebook_publications set status = 'superseded' where id = v_previous_active_id;
      update public.ebook_assets set status = 'superseded' where id = v_previous_asset_id;
    end if;
  end if;

  update public.ebook_publications set status = 'published' where id = p_publication_id;
  update public.ebook_assets set status = 'published' where id = v_asset_id;
  update public.books set active_publication_id = p_publication_id where id = v_book_id;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();

  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (
    v_actor_profile_id,
    'publish_publication',
    'ebook_publications',
    p_publication_id,
    jsonb_build_object('book_id', v_book_id, 'previous_active_publication_id', v_previous_active_id)
  );
end;
$$;
```

- [ ] **Step 8: Update `007_publication_transitions.sql` to the new behavior**

Replace these assertions one-for-one, so `select plan(...)` stays the same.

Replace assertion (16):

```sql
set local role anon;
select ok(
  not exists(select 1 from public.books where id = '96000000-0000-0000-0000-000000000011'),
  'publish_publication alone no longer makes book A public; publish_book does (see 013)'
);
reset role;
```

Replace assertion (17) (the first `set local role anon` block that checks author `96000000-0000-0000-0000-000000000001`):

```sql
select ok(
  not exists(select 1 from public.authors where id = '96000000-0000-0000-0000-000000000001'),
  'publish_publication alone no longer publishes book A''s author'
);
```

Keep assertions (18) and (19) unchanged; they still hold.

Replace the book-status assertion after rejecting v4:

```sql
select is((select status from public.books where id = '96000000-0000-0000-0000-000000000011'), 'draft'::public.content_status, 'rejecting v4 leaves book A''s status unchanged');
```

Replace the anon assertion that follows it:

```sql
set local role anon;
select ok(
  not exists(select 1 from public.books where id = '96000000-0000-0000-0000-000000000011'),
  'anon still cannot see book A, which was never published through publish_book'
);
reset role;
```

Update the explanatory comments above each replaced block to say that book visibility now comes from `publish_book` (migration `20260913120000`).

- [ ] **Step 9: Reset, test, regenerate types, and check**

Run:

```bash
supabase db reset
supabase test db
supabase gen types --local --lang typescript > lib/supabase/database.types.ts
npm run check
```

Expected: `007` and `013` pass with their full plans; every other pgTAP file passes; `npm run check` passes.

- [ ] **Step 10: Commit**

```bash
git add lib/catalog/readiness.ts lib/catalog/readiness.test.ts supabase/migrations/20260913120000_book_publish_readiness.sql supabase/tests/013_book_publish_readiness.sql supabase/tests/007_publication_transitions.sql lib/supabase/database.types.ts
git commit -m "feat: gate book visibility behind publish_book readiness"
```

### Task 4: Admin form schemas and helpers

**Files:**
- Modify: `lib/catalog/schemas.ts`
- Modify: `lib/catalog/schemas.test.ts`
- Create: `lib/catalog/form.ts`
- Create: `lib/catalog/form.test.ts`
- Create: `lib/catalog/entity-types.ts`

**Interfaces:**
- Consumes: existing `createBookSchema` and its `kebabCase` rule.
- Produces:

```ts
// lib/catalog/form.ts
export type FieldErrors = Record<string, string>;
export type AdminFormState = { fieldErrors: FieldErrors; formError: string | null; savedAt: number | null };
export const initialAdminFormState: AdminFormState;
export function readText(formData: FormData, key: string): string;            // trimmed, "" when missing
export function readOptionalText(formData: FormData, key: string): string | null; // blank -> null
export function readInteger(formData: FormData, key: string): number | undefined; // blank -> undefined
export function readOptionalInteger(formData: FormData, key: string): number | null; // blank -> null
export function readBoolean(formData: FormData, key: string): boolean;        // checkbox "on"
export function readList(formData: FormData, key: string): string[];          // getAll, blanks removed
export function fieldErrorsFrom(error: { issues: { path: PropertyKey[]; message: string }[] }): FieldErrors;
export function parseKeyIdeas(text: string): { title: string; summary: string }[]; // "Title | summary" per line
export function formatKeyIdeas(items: { title: string; summary: string }[]): string;
export function parseFaq(text: string): { question: string; answer: string }[];    // "Q: …" / "A: …" blocks
export function formatFaq(items: { question: string; answer: string }[]): string;

// lib/catalog/schemas.ts (new exports)
export const contentStatusSchema;       // "draft" | "published" | "archived"
export const entityBaseSchema;          // { canonicalSlug, name, status }
export const entityLocalizationSchema;  // { locale, slug, name, description }
export const bookLocalizationSchema;    // { locale, slug, title, subtitle, shortDescription, description, audience, keyIdeas, faq, seoTitle, seoDescription }
export const bookDetailsSchema;         // { canonicalKey, originalLanguage, primaryAuthorId }
export const editionSchema;             // { languageCode, isbn, editionNumber, publicationDate }
export const offerSchema;               // { marketCode, currency, priceMinor, active }
export const bookRelationsSchema;       // { topicIds, seriesId, seriesPosition }
export const coverUploadSchema;         // { fileName, mimeType, sizeBytes }
export const coverAltTextSchema;
export const merchandisingSchema;       // { slotKey, bookIds }
export const MAX_COVER_SIZE_BYTES = 5 * 1024 * 1024;
export const COVER_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
// plus the inferred input types: EntityBaseInput, EntityLocalizationInput, BookLocalizationInput,
// BookDetailsInput, EditionInput, OfferInput, BookRelationsInput, CoverUploadInput, MerchandisingInput

// lib/catalog/entity-types.ts
export type CatalogEntityType = "author" | "series" | "topic";
export const catalogEntityTypes: readonly CatalogEntityType[];
export const catalogEntityConfig: Record<CatalogEntityType, CatalogEntityConfig>;
export type CatalogEntityConfig = {
  table: "authors" | "series" | "topics";
  nameColumn: "display_name" | "name";
  localizationTable: "author_localizations" | "series_localizations" | "topic_localizations";
  foreignKey: "author_id" | "series_id" | "topic_id";
  adminPath: "/admin/authors" | "/admin/series" | "/admin/topics";
  singular: string;
  plural: string;
};
```

- [ ] **Step 1: Write the failing tests**

Create `lib/catalog/form.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  fieldErrorsFrom,
  formatFaq,
  formatKeyIdeas,
  parseFaq,
  parseKeyIdeas,
  readBoolean,
  readInteger,
  readList,
  readOptionalInteger,
  readOptionalText,
  readText,
} from "@/lib/catalog/form";

function form(entries: [string, string][]) {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

describe("FormData readers", () => {
  it("trims text and treats blanks as missing", () => {
    const data = form([["title", "  Sách  "], ["subtitle", "   "]]);
    expect(readText(data, "title")).toBe("Sách");
    expect(readText(data, "missing")).toBe("");
    expect(readOptionalText(data, "subtitle")).toBeNull();
  });

  it("reads integers, booleans, and lists", () => {
    const data = form([["price", "1500"], ["blank", ""], ["active", "on"], ["topic", "a"], ["topic", ""], ["topic", "b"]]);
    expect(readInteger(data, "price")).toBe(1500);
    expect(readInteger(data, "blank")).toBeUndefined();
    expect(readOptionalInteger(data, "blank")).toBeNull();
    expect(readBoolean(data, "active")).toBe(true);
    expect(readBoolean(data, "missing")).toBe(false);
    expect(readList(data, "topic")).toEqual(["a", "b"]);
  });
});

describe("fieldErrorsFrom", () => {
  it("keeps the first message per field path", () => {
    const schema = z.object({ name: z.string().min(2, "Too short").max(1, "Too long"), nested: z.object({ slug: z.string().min(1, "Enter a slug.") }) });
    const result = schema.safeParse({ name: "a", nested: { slug: "" } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(fieldErrorsFrom(result.error)).toEqual({ name: "Too short", "nested.slug": "Enter a slug." });
    }
  });
});

describe("key ideas and FAQ text formats", () => {
  it("round-trips key ideas", () => {
    const items = [{ title: "Quan sát", summary: "Nhìn mà không phán xét." }, { title: "Tự do", summary: "" }];
    expect(parseKeyIdeas(formatKeyIdeas(items))).toEqual(items);
    expect(parseKeyIdeas("\n  Title only  \n")).toEqual([{ title: "Title only", summary: "" }]);
  });

  it("round-trips FAQ entries and skips incomplete ones", () => {
    const items = [{ question: "Ebook đọc ở đâu?", answer: "Trên trình duyệt." }];
    expect(parseFaq(formatFaq(items))).toEqual(items);
    expect(parseFaq("Q: No answer\n\nQ: Complete\nA: Yes")).toEqual([{ question: "Complete", answer: "Yes" }]);
  });
});
```

Add these names to the existing `@/lib/catalog/schemas` import at the top of `lib/catalog/schemas.test.ts` (keep one import statement), then append the `describe` block:

```ts
import {
  createBookSchema,
  bookLocalizationSchema,
  bookRelationsSchema,
  coverUploadSchema,
  editionSchema,
  entityLocalizationSchema,
  merchandisingSchema,
  offerSchema,
} from "@/lib/catalog/schemas";

describe("admin catalog schemas", () => {
  it("requires a series position only when a series is chosen", () => {
    expect(bookRelationsSchema.safeParse({ topicIds: [], seriesId: null, seriesPosition: null }).success).toBe(true);
    const missing = bookRelationsSchema.safeParse({
      topicIds: [],
      seriesId: "c4000000-0000-4000-8000-000000000001",
      seriesPosition: null,
    });
    expect(missing.success).toBe(false);
  });

  it("limits the featured slot to one book and rejects duplicates", () => {
    const id = "c3000000-0000-4000-8000-000000000001";
    expect(merchandisingSchema.safeParse({ slotKey: "home_featured", bookIds: [id, "c3000000-0000-4000-8000-000000000002"] }).success).toBe(false);
    expect(merchandisingSchema.safeParse({ slotKey: "home_shelf", bookIds: [id, id] }).success).toBe(false);
    expect(merchandisingSchema.safeParse({ slotKey: "home_shelf", bookIds: [id] }).success).toBe(true);
  });

  it("accepts ISBN-10 and ISBN-13 without dashes", () => {
    const base = { languageCode: "vi", editionNumber: 1, publicationDate: null };
    expect(editionSchema.safeParse({ ...base, isbn: "9786041234567" }).success).toBe(true);
    expect(editionSchema.safeParse({ ...base, isbn: "604123456X" }).success).toBe(true);
    expect(editionSchema.safeParse({ ...base, isbn: "978-604" }).success).toBe(false);
    expect(editionSchema.safeParse({ ...base, isbn: null }).success).toBe(true);
  });

  it("rejects oversized or non-image covers", () => {
    expect(coverUploadSchema.safeParse({ fileName: "c.png", mimeType: "image/png", sizeBytes: 1024 }).success).toBe(true);
    expect(coverUploadSchema.safeParse({ fileName: "c.gif", mimeType: "image/gif", sizeBytes: 1024 }).success).toBe(false);
    expect(coverUploadSchema.safeParse({ fileName: "c.png", mimeType: "image/png", sizeBytes: 6 * 1024 * 1024 }).success).toBe(false);
  });

  it("validates localized copy and offers", () => {
    expect(entityLocalizationSchema.safeParse({ locale: "vi", slug: "phuong-bui", name: "Phương Bùi", description: null }).success).toBe(true);
    expect(entityLocalizationSchema.safeParse({ locale: "ja", slug: "x", name: "X", description: null }).success).toBe(false);
    expect(
      bookLocalizationSchema.safeParse({
        locale: "vi",
        slug: "quan-sat",
        title: "Quan sát",
        subtitle: null,
        shortDescription: null,
        description: "Mô tả",
        audience: null,
        keyIdeas: [{ title: "Ý", summary: "" }],
        faq: [],
        seoTitle: "x".repeat(71),
        seoDescription: null,
      }).success,
    ).toBe(false);
    expect(offerSchema.safeParse({ marketCode: "VN", currency: "VND", priceMinor: -1, active: true }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npm test -- lib/catalog/form.test.ts lib/catalog/schemas.test.ts`
Expected: FAIL because `@/lib/catalog/form` and the new schema exports do not exist.

- [ ] **Step 3: Implement `lib/catalog/form.ts`**

```ts
// Shared helpers for admin Server Actions. A Server Action is a public POST endpoint, so every value
// is read as untrusted text here and validated by a Zod schema in lib/catalog/schemas.ts.

export type FieldErrors = Record<string, string>;

export type AdminFormState = {
  fieldErrors: FieldErrors;
  formError: string | null;
  // Set on success so the form can show "Saved" and reset its dirty state.
  savedAt: number | null;
};

export const initialAdminFormState: AdminFormState = { fieldErrors: {}, formError: null, savedAt: null };

export function readText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function readOptionalText(formData: FormData, key: string): string | null {
  const value = readText(formData, key);
  return value === "" ? null : value;
}

export function readInteger(formData: FormData, key: string): number | undefined {
  const value = readText(formData, key);
  return value === "" ? undefined : Number(value);
}

export function readOptionalInteger(formData: FormData, key: string): number | null {
  return readInteger(formData, key) ?? null;
}

export function readBoolean(formData: FormData, key: string): boolean {
  return formData.get(key) === "on";
}

export function readList(formData: FormData, key: string): string[] {
  return formData
    .getAll(key)
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value !== "");
}

export function fieldErrorsFrom(error: { issues: { path: PropertyKey[]; message: string }[] }): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".");
    if (!(key in errors)) errors[key] = issue.message;
  }
  return errors;
}

// Key ideas are edited as one idea per line: "Title | optional summary".
export function parseKeyIdeas(text: string): { title: string; summary: string }[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const separator = line.indexOf("|");
      if (separator === -1) return { title: line, summary: "" };
      return { title: line.slice(0, separator).trim(), summary: line.slice(separator + 1).trim() };
    });
}

export function formatKeyIdeas(items: { title: string; summary: string }[]): string {
  return items.map((item) => (item.summary ? `${item.title} | ${item.summary}` : item.title)).join("\n");
}

// FAQ entries are edited as blocks separated by a blank line: "Q: question" then "A: answer".
export function parseFaq(text: string): { question: string; answer: string }[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => {
      const question = /^Q:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "";
      const answer = /^A:\s*([\s\S]+)$/m.exec(block)?.[1]?.trim() ?? "";
      return { question, answer };
    })
    .filter((item) => item.question !== "" && item.answer !== "");
}

export function formatFaq(items: { question: string; answer: string }[]): string {
  return items.map((item) => `Q: ${item.question}\nA: ${item.answer}`).join("\n\n");
}
```

- [ ] **Step 4: Add the schemas to `lib/catalog/schemas.ts`**

Append below `createBookSchema` (reusing the file's existing `kebabCase` constant):

```ts
const localeSchema = z.enum(["vi", "en"]);
const nullableText = (max: number) => z.string().trim().max(max).nullable();

export const MAX_COVER_SIZE_BYTES = 5 * 1024 * 1024;
export const COVER_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export const contentStatusSchema = z.enum(["draft", "published", "archived"]);

export const entityBaseSchema = z.object({
  canonicalSlug: kebabCase,
  name: z.string().trim().min(1, "Enter a name.").max(200),
  status: contentStatusSchema,
});

export const entityLocalizationSchema = z.object({
  locale: localeSchema,
  slug: kebabCase,
  name: z.string().trim().min(1, "Enter a name.").max(200),
  description: nullableText(5000),
});

const keyIdeaSchema = z.object({
  title: z.string().trim().min(1, "Each key idea needs a title.").max(200),
  summary: z.string().trim().max(1000),
});

const faqItemSchema = z.object({
  question: z.string().trim().min(1).max(300),
  answer: z.string().trim().min(1).max(2000),
});

export const bookLocalizationSchema = z.object({
  locale: localeSchema,
  slug: kebabCase,
  title: z.string().trim().min(1, "Enter a title.").max(300),
  subtitle: nullableText(300),
  shortDescription: nullableText(500),
  description: nullableText(10000),
  audience: nullableText(2000),
  keyIdeas: z.array(keyIdeaSchema).max(12, "Use at most 12 key ideas."),
  faq: z.array(faqItemSchema).max(20, "Use at most 20 questions."),
  seoTitle: z.string().trim().max(70, "Keep the SEO title to 70 characters.").nullable(),
  seoDescription: z.string().trim().max(160, "Keep the SEO description to 160 characters.").nullable(),
});

export const bookDetailsSchema = z.object({
  canonicalKey: kebabCase,
  originalLanguage: localeSchema,
  primaryAuthorId: z.uuid({ error: "Choose an author." }),
});

export const editionSchema = z.object({
  languageCode: localeSchema,
  isbn: z
    .string()
    .trim()
    .regex(/^(97[89]\d{10}|\d{9}[\dX])$/, "Use a 10 or 13 digit ISBN without dashes.")
    .nullable(),
  editionNumber: z.number({ error: "Enter the edition number." }).int().min(1),
  publicationDate: z.iso.date({ error: "Use a date like 2026-09-13." }).nullable(),
});

export const offerSchema = z.object({
  marketCode: z.string().regex(/^[A-Z]{2}$/, "Use a two-letter uppercase market code, e.g. VN."),
  currency: z.string().regex(/^[A-Z]{3}$/, "Use a three-letter uppercase currency code, e.g. VND."),
  priceMinor: z.number({ error: "Enter a price." }).int().min(0, "Price cannot be negative."),
  active: z.boolean(),
});

export const bookRelationsSchema = z
  .object({
    topicIds: z.array(z.uuid()),
    seriesId: z.uuid().nullable(),
    seriesPosition: z.number().int().min(1, "Positions start at 1.").nullable(),
  })
  .refine((value) => value.seriesId === null || value.seriesPosition !== null, {
    message: "Enter the book's position in the series.",
    path: ["seriesPosition"],
  });

export const coverUploadSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.enum(COVER_MIME_TYPES, { error: "Upload a JPEG, PNG, or WebP image." }),
  sizeBytes: z
    .number()
    .int()
    .positive("The selected file is empty.")
    .max(MAX_COVER_SIZE_BYTES, "Cover images must be 5 MB or smaller."),
});

export const coverAltTextSchema = z.string().trim().min(1, "Describe the cover for screen readers.").max(300);

export const merchandisingSchema = z
  .object({
    slotKey: z.enum(["home_featured", "home_shelf"]),
    bookIds: z.array(z.uuid()),
  })
  .refine((value) => value.slotKey !== "home_featured" || value.bookIds.length <= 1, {
    message: "The featured slot holds one book.",
    path: ["bookIds"],
  })
  .refine((value) => new Set(value.bookIds).size === value.bookIds.length, {
    message: "Each book can appear once.",
    path: ["bookIds"],
  });

export type EntityBaseInput = z.infer<typeof entityBaseSchema>;
export type EntityLocalizationInput = z.infer<typeof entityLocalizationSchema>;
export type BookLocalizationInput = z.infer<typeof bookLocalizationSchema>;
export type BookDetailsInput = z.infer<typeof bookDetailsSchema>;
export type EditionInput = z.infer<typeof editionSchema>;
export type OfferInput = z.infer<typeof offerSchema>;
export type BookRelationsInput = z.infer<typeof bookRelationsSchema>;
export type CoverUploadInput = z.infer<typeof coverUploadSchema>;
export type MerchandisingInput = z.infer<typeof merchandisingSchema>;
```

- [ ] **Step 5: Create `lib/catalog/entity-types.ts`**

```ts
// Authors, series, and topics share one admin shape: a base row with a canonical slug, a name, and
// a status, plus per-locale copy. This table is the only place their differences are written down.

export type CatalogEntityType = "author" | "series" | "topic";

export type CatalogEntityConfig = {
  table: "authors" | "series" | "topics";
  nameColumn: "display_name" | "name";
  localizationTable: "author_localizations" | "series_localizations" | "topic_localizations";
  foreignKey: "author_id" | "series_id" | "topic_id";
  adminPath: "/admin/authors" | "/admin/series" | "/admin/topics";
  singular: string;
  plural: string;
};

export const catalogEntityTypes: readonly CatalogEntityType[] = ["author", "series", "topic"];

export const catalogEntityConfig: Record<CatalogEntityType, CatalogEntityConfig> = {
  author: {
    table: "authors",
    nameColumn: "display_name",
    localizationTable: "author_localizations",
    foreignKey: "author_id",
    adminPath: "/admin/authors",
    singular: "Author",
    plural: "Authors",
  },
  series: {
    table: "series",
    nameColumn: "display_name",
    localizationTable: "series_localizations",
    foreignKey: "series_id",
    adminPath: "/admin/series",
    singular: "Series",
    plural: "Series",
  },
  topic: {
    table: "topics",
    nameColumn: "name",
    localizationTable: "topic_localizations",
    foreignKey: "topic_id",
    adminPath: "/admin/topics",
    singular: "Topic",
    plural: "Topics",
  },
};
```

- [ ] **Step 6: Run the tests and verify they pass**

Run: `npm test -- lib/catalog/form.test.ts lib/catalog/schemas.test.ts`
Expected: PASS.

- [ ] **Step 7: Check and commit**

```bash
npm run check
git add lib/catalog/schemas.ts lib/catalog/schemas.test.ts lib/catalog/form.ts lib/catalog/form.test.ts lib/catalog/entity-types.ts
git commit -m "feat: add catalog admin form schemas and helpers"
```

### Task 5: Books data layer

**Files:**
- Create: `lib/data/supabase-test-client.ts`
- Create: `lib/catalog/covers.ts`
- Create: `lib/catalog/covers.test.ts`
- Replace: `lib/data/books.ts`
- Replace: `lib/data/books.test.ts`
- Modify: `app/admin/books/actions.ts` (drop `DuplicateAuthorNameError`)
- Modify: `app/admin/books/[bookId]/page.tsx` (read the new DTO fields; full rewrite comes in Task 8)

**Interfaces:**
- Consumes: Task 2 RPCs `admin_create_book`, `admin_save_book_localization`, `admin_set_book_relations`; Task 3 `publish_book`, `unpublish_book`, `checkBookReadiness`; Task 4 input types.
- Produces:

```ts
// lib/catalog/covers.ts
export const COVERS_BUCKET = "covers";
export function coverPublicUrl(storageKey: string, supabaseUrl?: string): string;

// lib/data/supabase-test-client.ts (tests only)
export function chainResult(result: { data: unknown; error: unknown }): unknown;
export function fakeSupabaseClient(options: {
  tables?: Record<string, { data: unknown; error: unknown }>;
  rpc?: { data: unknown; error: unknown };
}): { client: unknown; from: Mock; rpc: Mock };

// lib/data/books.ts
export class DuplicateCanonicalKeyError extends Error {}
export class DuplicateSlugError extends Error {}
export class SeriesPositionTakenError extends Error {}
export class BookNotReadyError extends Error { readonly issues: ReadinessIssueCode[] }
export class BookNotFoundError extends Error {}

export type BookLocalizationDTO = {
  id: string; locale: "vi" | "en"; slug: string; title: string; subtitle: string | null;
  shortDescription: string | null; description: string | null; audience: string | null;
  keyIdeas: { title: string; summary: string }[]; faq: { question: string; answer: string }[];
  seoTitle: string | null; seoDescription: string | null;
};
export type AdminBookDTO = {
  id: string; canonicalKey: string; originalLanguage: "vi" | "en"; status: "draft" | "published" | "archived";
  primaryAuthorId: string; authorName: string;
  localization: { locale: string; slug: string; title: string } | null; // first localization, vi before en
  localizations: BookLocalizationDTO[];
  edition: { id: string; languageCode: string; isbn: string | null; editionNumber: number; publicationDate: string | null } | null;
  sku: { id: string; skuCode: string; active: boolean } | null;
  offer: { id: string; marketCode: string; currency: string; priceMinor: number; active: boolean } | null;
  cover: { storageKey: string; altText: string; publicUrl: string } | null;
  topicIds: string[];
  series: { seriesId: string; position: number } | null;
  activePublicationId: string | null;
  readinessIssues: ReadinessIssueCode[];
};
export type AdminBookListItemDTO = {
  id: string; canonicalKey: string; title: string; authorName: string;
  status: AdminBookDTO["status"]; hasActivePublication: boolean; readinessIssues: ReadinessIssueCode[];
};

export async function createBook(input: CreateBookInput): Promise<{ bookId: string }>;
export async function listAdminBooks(search?: string): Promise<AdminBookListItemDTO[]>;
export async function getAdminBook(bookId: string): Promise<AdminBookDTO>;        // notFound() for bad or missing id
export async function updateBookDetails(bookId: string, input: BookDetailsInput): Promise<void>;
export async function saveBookLocalization(bookId: string, input: BookLocalizationInput): Promise<void>;
export async function updateEdition(editionId: string, input: EditionInput): Promise<void>;
export async function updateOffer(offerId: string, input: OfferInput): Promise<void>;
export async function setBookRelations(bookId: string, input: BookRelationsInput): Promise<void>;
export async function publishBook(bookId: string): Promise<void>;
export async function unpublishBook(bookId: string): Promise<void>;
```

- [ ] **Step 1: Add the test helper and the cover URL test**

Create `lib/data/supabase-test-client.ts`:

```ts
import { vi } from "vitest";

// A Supabase query builder stand-in for DAL unit tests: every builder method returns the same
// object, and awaiting it resolves to the configured { data, error }. Tests assert on the calls
// that matter (table, RPC name, arguments) instead of re-describing PostgREST's chain shape.
export function chainResult(result: { data: unknown; error: unknown }): unknown {
  const target = {};
  const proxy: unknown = new Proxy(target, {
    get(_target, property) {
      if (property === "then") {
        return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject);
      }
      return () => proxy;
    },
  });
  return proxy;
}

export function fakeSupabaseClient(options: {
  tables?: Record<string, { data: unknown; error: unknown }>;
  rpc?: { data: unknown; error: unknown };
}) {
  const from = vi.fn((table: string) => chainResult(options.tables?.[table] ?? { data: null, error: null }));
  const rpc = vi.fn(() => Promise.resolve(options.rpc ?? { data: null, error: null }));
  return { client: { from, rpc }, from, rpc };
}
```

Create `lib/catalog/covers.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { coverPublicUrl } from "@/lib/catalog/covers";

describe("coverPublicUrl", () => {
  it("builds the public object URL for the covers bucket", () => {
    expect(coverPublicUrl("books/abc/def.png", "http://127.0.0.1:54321")).toBe(
      "http://127.0.0.1:54321/storage/v1/object/public/covers/books/abc/def.png",
    );
  });

  it("tolerates a trailing slash on the project URL", () => {
    expect(coverPublicUrl("books/abc/def.png", "https://example.supabase.co/")).toBe(
      "https://example.supabase.co/storage/v1/object/public/covers/books/abc/def.png",
    );
  });
});
```

- [ ] **Step 2: Write the failing books DAL tests**

Replace `lib/data/books.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import {
  BookNotReadyError,
  createBook,
  DuplicateCanonicalKeyError,
  DuplicateSlugError,
  getAdminBook,
  listAdminBooks,
  publishBook,
  saveBookLocalization,
  SeriesPositionTakenError,
  setBookRelations,
  updateOffer,
} from "@/lib/data/books";
import { fakeSupabaseClient } from "@/lib/data/supabase-test-client";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

type SessionClient = Awaited<ReturnType<typeof createClient>>;

const bookId = "3a1b2c3d-0000-4000-8000-000000000001";

const createInput = {
  canonicalKey: "the-golden-book",
  authorName: "Phuong Bui",
  locale: "vi" as const,
  language: "en" as const,
  title: "The Golden Book",
  slug: "cuon-sach-vang",
  market: "VN",
  currency: "VND",
  priceMinor: 0,
};

const localizationInput = {
  locale: "vi" as const,
  slug: "cuon-sach-vang",
  title: "The Golden Book",
  subtitle: null,
  shortDescription: null,
  description: "Mô tả",
  audience: null,
  keyIdeas: [{ title: "Quan sát", summary: "" }],
  faq: [],
  seoTitle: null,
  seoDescription: null,
};

const editorRow = {
  id: bookId,
  canonical_key: "the-golden-book",
  original_language: "en",
  status: "draft",
  primary_author_id: "4a1b2c3d-0000-4000-8000-000000000001",
  active_publication_id: null,
  author: { display_name: "Phuong Bui" },
  localizations: [
    {
      id: "5a1b2c3d-0000-4000-8000-000000000002",
      locale: "en",
      slug: "golden",
      title: "Golden",
      subtitle: null,
      short_description: null,
      description: null,
      audience: null,
      key_ideas: [],
      faq: [],
      seo_title: null,
      seo_description: null,
    },
    {
      id: "5a1b2c3d-0000-4000-8000-000000000001",
      locale: "vi",
      slug: "cuon-sach-vang",
      title: "Cuốn sách vàng",
      subtitle: null,
      short_description: null,
      description: "Mô tả",
      audience: null,
      key_ideas: [{ title: "Quan sát", summary: "" }],
      faq: [],
      seo_title: null,
      seo_description: null,
    },
  ],
  editions: [
    {
      id: "6a1b2c3d-0000-4000-8000-000000000001",
      language_code: "en",
      isbn: null,
      edition_number: 1,
      publication_date: null,
      skus: [
        {
          id: "7a1b2c3d-0000-4000-8000-000000000001",
          sku_code: "the-golden-book-ebook",
          active: true,
          offers: [
            { id: "8a1b2c3d-0000-4000-8000-000000000001", market_code: "VN", currency: "VND", price_minor: 0, active: true, starts_at: null, ends_at: null },
          ],
        },
      ],
    },
  ],
  topics: [{ topic_id: "9a1b2c3d-0000-4000-8000-000000000001" }],
  series: { series_id: "aa1b2c3d-0000-4000-8000-000000000001", position: 2 },
  active_publication: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("admin gate ordering", () => {
  it.each([
    ["createBook", () => createBook(createInput)],
    ["getAdminBook", () => getAdminBook(bookId)],
    ["updateOffer", () => updateOffer("8a1b2c3d-0000-4000-8000-000000000001", { marketCode: "VN", currency: "VND", priceMinor: 0, active: true })],
    ["publishBook", () => publishBook(bookId)],
  ])("%s never builds a client when the admin gate denies", async (_name, call) => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
    await expect(call()).rejects.toThrow("NEXT_FORBIDDEN");
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("createBook", () => {
  it("calls admin_create_book with the validated fields", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: bookId, error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(createBook(createInput)).resolves.toEqual({ bookId });
    expect(fake.rpc).toHaveBeenCalledWith("admin_create_book", {
      p_canonical_key: "the-golden-book",
      p_author_name: "Phuong Bui",
      p_locale: "vi",
      p_language: "en",
      p_title: "The Golden Book",
      p_slug: "cuon-sach-vang",
      p_market: "VN",
      p_currency: "VND",
      p_price_minor: 0,
    });
  });

  it.each([
    ["books_canonical_key_key", DuplicateCanonicalKeyError],
    ["book_localizations_locale_slug_key", DuplicateSlugError],
  ] as const)("maps a %s violation to its typed error", async (constraint, ErrorClass) => {
    const fake = fakeSupabaseClient({
      rpc: { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "${constraint}"` } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(createBook(createInput)).rejects.toBeInstanceOf(ErrorClass);
  });
});

describe("getAdminBook", () => {
  it("builds the editor DTO, orders vi first, and computes readiness", async () => {
    const fake = fakeSupabaseClient({
      tables: { books: { data: editorRow, error: null }, media_assets: { data: null, error: null } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    const book = await getAdminBook(bookId);

    expect(book.localizations.map((localization) => localization.locale)).toEqual(["vi", "en"]);
    expect(book.localization).toEqual({ locale: "vi", slug: "cuon-sach-vang", title: "Cuốn sách vàng" });
    expect(book.offer).toEqual({ id: "8a1b2c3d-0000-4000-8000-000000000001", marketCode: "VN", currency: "VND", priceMinor: 0, active: true });
    expect(book.topicIds).toEqual(["9a1b2c3d-0000-4000-8000-000000000001"]);
    expect(book.series).toEqual({ seriesId: "aa1b2c3d-0000-4000-8000-000000000001", position: 2 });
    expect(book.cover).toBeNull();
    expect(book.readinessIssues).toEqual(["missing_cover", "missing_publication"]);
  });
});

describe("listAdminBooks", () => {
  it("filters by title or canonical key and reports readiness", async () => {
    const fake = fakeSupabaseClient({
      tables: {
        books: { data: [editorRow, { ...editorRow, id: "3a1b2c3d-0000-4000-8000-000000000002", canonical_key: "other", localizations: [] }], error: null },
        media_assets: { data: [{ owner_id: bookId }], error: null },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    const books = await listAdminBooks("vàng");

    expect(books).toHaveLength(1);
    expect(books[0]).toMatchObject({ id: bookId, title: "Cuốn sách vàng", readinessIssues: ["missing_publication"] });
  });
});

describe("saveBookLocalization", () => {
  it("sends key ideas and FAQ as JSON arrays", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: "5a1b2c3d-0000-4000-8000-000000000001", error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await saveBookLocalization(bookId, localizationInput);

    expect(fake.rpc).toHaveBeenCalledWith("admin_save_book_localization", expect.objectContaining({
      p_book_id: bookId,
      p_key_ideas: [{ title: "Quan sát", summary: "" }],
      p_faq: [],
    }));
  });

  it("maps a slug collision to DuplicateSlugError", async () => {
    const fake = fakeSupabaseClient({
      rpc: { data: null, error: { code: "23505", message: 'violates unique constraint "book_localizations_locale_slug_key"' } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(saveBookLocalization(bookId, localizationInput)).rejects.toBeInstanceOf(DuplicateSlugError);
  });
});

describe("setBookRelations", () => {
  it("maps a taken series position to SeriesPositionTakenError", async () => {
    const fake = fakeSupabaseClient({
      rpc: { data: null, error: { code: "23505", message: 'violates unique constraint "book_series_series_id_position_key"' } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(
      setBookRelations(bookId, { topicIds: [], seriesId: "aa1b2c3d-0000-4000-8000-000000000001", seriesPosition: 1 }),
    ).rejects.toBeInstanceOf(SeriesPositionTakenError);
  });
});

describe("publishBook", () => {
  it("turns EB010 into BookNotReadyError with the issue codes", async () => {
    const fake = fakeSupabaseClient({
      rpc: { data: null, error: { code: "EB010", message: "publish_book: book is not ready: missing_cover,missing_offer" } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    const error = await publishBook(bookId).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BookNotReadyError);
    expect((error as BookNotReadyError).issues).toEqual(["missing_cover", "missing_offer"]);
  });
});
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `npm test -- lib/data/books.test.ts lib/catalog/covers.test.ts`
Expected: FAIL because the new exports and `@/lib/catalog/covers` do not exist.

- [ ] **Step 4: Implement `lib/catalog/covers.ts`**

```ts
export const COVERS_BUCKET = "covers";

// Covers live in the only public bucket (20260913100000), so their URL is a stable, unsigned
// object URL. EPUB buckets stay private and never go through this helper.
export function coverPublicUrl(storageKey: string, supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""): string {
  const base = supabaseUrl.replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/${COVERS_BUCKET}/${storageKey}`;
}
```

- [ ] **Step 5: Replace `lib/data/books.ts`**

```ts
import "server-only";

import { notFound } from "next/navigation";

import { requireAdmin } from "@/lib/auth/admin";
import { coverPublicUrl } from "@/lib/catalog/covers";
import { checkBookReadiness, parseReadinessError, type ReadinessIssueCode } from "@/lib/catalog/readiness";
import type {
  BookDetailsInput,
  BookLocalizationInput,
  BookRelationsInput,
  CreateBookInput,
  EditionInput,
  OfferInput,
} from "@/lib/catalog/schemas";
import { createClient } from "@/lib/supabase/server";

// Every function here runs requireAdmin() before building a client, then uses the session client:
// the catalog RPCs check is_admin() through auth.uid(), which is null under the service role, and
// direct writes rely on the is_admin() RLS policies from 20260913100000.

export class DuplicateCanonicalKeyError extends Error {
  constructor() {
    super("A book with this canonical key already exists.");
    this.name = "DuplicateCanonicalKeyError";
  }
}

export class DuplicateSlugError extends Error {
  constructor() {
    super("A book with this locale and slug already exists.");
    this.name = "DuplicateSlugError";
  }
}

export class SeriesPositionTakenError extends Error {
  constructor() {
    super("Another book already holds this position in the series.");
    this.name = "SeriesPositionTakenError";
  }
}

export class BookNotReadyError extends Error {
  readonly issues: ReadinessIssueCode[];

  constructor(issues: ReadinessIssueCode[]) {
    super("This book is not ready to publish.");
    this.name = "BookNotReadyError";
    this.issues = issues;
  }
}

export class BookNotFoundError extends Error {
  constructor() {
    super("This book no longer exists.");
    this.name = "BookNotFoundError";
  }
}

type DatabaseError = { code?: string; message: string };

// A unique_violation names its constraint only in the message; map the constraints an admin can
// actually cause to typed errors and keep everything else generic and server-side.
function mapUniqueViolation(error: DatabaseError): Error | null {
  if (error.code !== "23505") return null;
  if (error.message.includes("books_canonical_key_key")) return new DuplicateCanonicalKeyError();
  if (error.message.includes("book_localizations_locale_slug_key")) return new DuplicateSlugError();
  if (error.message.includes("book_series_series_id_position_key")) return new SeriesPositionTakenError();
  return null;
}

function failure(operation: string, error: DatabaseError): Error {
  return mapUniqueViolation(error) ?? new Error(`${operation} failed: ${error.message}`);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string) {
  if (!uuidPattern.test(value)) throw new BookNotFoundError();
}

export async function createBook(input: CreateBookInput): Promise<{ bookId: string }> {
  await requireAdmin();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_create_book", {
    p_canonical_key: input.canonicalKey,
    p_author_name: input.authorName,
    p_locale: input.locale,
    p_language: input.language,
    p_title: input.title,
    p_slug: input.slug,
    p_market: input.market,
    p_currency: input.currency,
    p_price_minor: input.priceMinor,
  });

  if (error) throw failure("createBook: admin_create_book", error);
  if (typeof data !== "string" || data.length === 0) {
    throw new Error("createBook: admin_create_book returned no book id");
  }
  return { bookId: data };
}

export type BookLocalizationDTO = {
  id: string;
  locale: "vi" | "en";
  slug: string;
  title: string;
  subtitle: string | null;
  shortDescription: string | null;
  description: string | null;
  audience: string | null;
  keyIdeas: { title: string; summary: string }[];
  faq: { question: string; answer: string }[];
  seoTitle: string | null;
  seoDescription: string | null;
};

export type AdminBookDTO = {
  id: string;
  canonicalKey: string;
  originalLanguage: "vi" | "en";
  status: "draft" | "published" | "archived";
  primaryAuthorId: string;
  authorName: string;
  localization: { locale: string; slug: string; title: string } | null;
  localizations: BookLocalizationDTO[];
  edition: { id: string; languageCode: string; isbn: string | null; editionNumber: number; publicationDate: string | null } | null;
  sku: { id: string; skuCode: string; active: boolean } | null;
  offer: { id: string; marketCode: string; currency: string; priceMinor: number; active: boolean } | null;
  cover: { storageKey: string; altText: string; publicUrl: string } | null;
  topicIds: string[];
  series: { seriesId: string; position: number } | null;
  activePublicationId: string | null;
  readinessIssues: ReadinessIssueCode[];
};

export type AdminBookListItemDTO = {
  id: string;
  canonicalKey: string;
  title: string;
  authorName: string;
  status: AdminBookDTO["status"];
  hasActivePublication: boolean;
  readinessIssues: ReadinessIssueCode[];
};

type OfferRow = {
  id: string;
  market_code: string;
  currency: string;
  price_minor: number;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
};

type LocalizationRow = {
  id: string;
  locale: "vi" | "en";
  slug: string;
  title: string;
  subtitle: string | null;
  short_description: string | null;
  description: string | null;
  audience: string | null;
  key_ideas: { title: string; summary: string }[];
  faq: { question: string; answer: string }[];
  seo_title: string | null;
  seo_description: string | null;
};

type BookRow = {
  id: string;
  canonical_key: string;
  original_language: "vi" | "en";
  status: AdminBookDTO["status"];
  primary_author_id: string;
  active_publication_id: string | null;
  author: { display_name: string } | null;
  localizations: LocalizationRow[];
  editions: {
    id: string;
    language_code: string;
    isbn: string | null;
    edition_number: number;
    publication_date: string | null;
    skus: { id: string; sku_code: string; active: boolean; offers: OfferRow[] }[];
  }[];
  topics: { topic_id: string }[];
  // One-to-one embeds arrive as an object or a one-element array depending on how PostgREST
  // resolves the relationship; oneOrNull() accepts both.
  series: { series_id: string; position: number } | { series_id: string; position: number }[] | null;
  active_publication: { status: string } | { status: string }[] | null;
};

const bookSelect = `
  id,
  canonical_key,
  original_language,
  status,
  primary_author_id,
  active_publication_id,
  author:authors ( display_name ),
  localizations:book_localizations ( id, locale, slug, title, subtitle, short_description, description, audience, key_ideas, faq, seo_title, seo_description ),
  editions ( id, language_code, isbn, edition_number, publication_date, skus ( id, sku_code, active, offers ( id, market_code, currency, price_minor, active, starts_at, ends_at ) ) ),
  topics:book_topics ( topic_id ),
  series:book_series ( series_id, position ),
  active_publication:ebook_publications!books_active_publication_fk ( status )
`;

function oneOrNull<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

function isOfferLive(offer: OfferRow, now: Date) {
  return (
    offer.active &&
    (offer.starts_at === null || new Date(offer.starts_at) <= now) &&
    (offer.ends_at === null || new Date(offer.ends_at) > now)
  );
}

const localeOrder: Record<string, number> = { vi: 0, en: 1 };

function toDto(row: BookRow, cover: { storage_key: string; alt_text: string } | null): AdminBookDTO {
  const localizations = [...row.localizations]
    .sort((a, b) => (localeOrder[a.locale] ?? 9) - (localeOrder[b.locale] ?? 9))
    .map((localization) => ({
      id: localization.id,
      locale: localization.locale,
      slug: localization.slug,
      title: localization.title,
      subtitle: localization.subtitle,
      shortDescription: localization.short_description,
      description: localization.description,
      audience: localization.audience,
      keyIdeas: localization.key_ideas ?? [],
      faq: localization.faq ?? [],
      seoTitle: localization.seo_title,
      seoDescription: localization.seo_description,
    }));

  // The ebook-only MVP creates one edition, one SKU, and one offer per book (admin_create_book).
  const edition = row.editions[0] ?? null;
  const sku = edition?.skus[0] ?? null;
  const offer = sku?.offers[0] ?? null;
  const series = oneOrNull(row.series);
  const activePublication = oneOrNull(row.active_publication);
  const now = new Date();

  const readinessIssues = checkBookReadiness({
    localizations,
    hasAuthor: row.author !== null,
    hasCover: cover !== null,
    hasActiveOffer: Boolean(sku?.active && sku.offers.some((candidate) => isOfferLive(candidate, now))),
    hasPublishedActivePublication: activePublication?.status === "published",
  });

  return {
    id: row.id,
    canonicalKey: row.canonical_key,
    originalLanguage: row.original_language,
    status: row.status,
    primaryAuthorId: row.primary_author_id,
    authorName: row.author?.display_name ?? "",
    localization: localizations[0]
      ? { locale: localizations[0].locale, slug: localizations[0].slug, title: localizations[0].title }
      : null,
    localizations,
    edition: edition
      ? {
          id: edition.id,
          languageCode: edition.language_code,
          isbn: edition.isbn,
          editionNumber: edition.edition_number,
          publicationDate: edition.publication_date,
        }
      : null,
    sku: sku ? { id: sku.id, skuCode: sku.sku_code, active: sku.active } : null,
    offer: offer
      ? { id: offer.id, marketCode: offer.market_code, currency: offer.currency, priceMinor: offer.price_minor, active: offer.active }
      : null,
    cover: cover
      ? { storageKey: cover.storage_key, altText: cover.alt_text, publicUrl: coverPublicUrl(cover.storage_key) }
      : null,
    topicIds: row.topics.map((topic) => topic.topic_id),
    series: series ? { seriesId: series.series_id, position: series.position } : null,
    activePublicationId: row.active_publication_id,
    readinessIssues,
  };
}

export async function getAdminBook(bookId: string): Promise<AdminBookDTO> {
  await requireAdmin();
  if (!uuidPattern.test(bookId)) notFound();

  const supabase = await createClient();
  const [{ data: row, error }, { data: cover, error: coverError }] = await Promise.all([
    supabase.from("books").select(bookSelect).eq("id", bookId).maybeSingle(),
    supabase
      .from("media_assets")
      .select("storage_key, alt_text")
      .eq("owner_type", "book")
      .eq("kind", "cover")
      .eq("owner_id", bookId)
      .maybeSingle(),
  ]);

  if (error) throw new Error(`getAdminBook: failed to load book ${bookId}: ${error.message}`);
  if (coverError) throw new Error(`getAdminBook: failed to load cover for ${bookId}: ${coverError.message}`);
  if (!row) notFound();

  return toDto(row as unknown as BookRow, cover as { storage_key: string; alt_text: string } | null);
}

export async function listAdminBooks(search?: string): Promise<AdminBookListItemDTO[]> {
  await requireAdmin();

  const supabase = await createClient();
  const [{ data: rows, error }, { data: covers, error: coverError }] = await Promise.all([
    supabase.from("books").select(bookSelect).order("updated_at", { ascending: false }),
    supabase.from("media_assets").select("owner_id, storage_key, alt_text").eq("owner_type", "book").eq("kind", "cover"),
  ]);

  if (error) throw new Error(`listAdminBooks: ${error.message}`);
  if (coverError) throw new Error(`listAdminBooks: covers: ${coverError.message}`);

  const coverByBook = new Map(
    ((covers ?? []) as { owner_id: string; storage_key?: string; alt_text?: string }[]).map((cover) => [
      cover.owner_id,
      { storage_key: cover.storage_key ?? "", alt_text: cover.alt_text ?? "" },
    ]),
  );
  const needle = search?.trim().toLocaleLowerCase("vi") ?? "";

  return ((rows ?? []) as unknown as BookRow[])
    .map((row) => toDto(row, coverByBook.get(row.id) ?? null))
    .filter(
      (book) =>
        needle === "" ||
        book.canonicalKey.includes(needle) ||
        book.localizations.some((localization) => localization.title.toLocaleLowerCase("vi").includes(needle)),
    )
    .map((book) => ({
      id: book.id,
      canonicalKey: book.canonicalKey,
      title: book.localization?.title ?? book.canonicalKey,
      authorName: book.authorName,
      status: book.status,
      hasActivePublication: book.activePublicationId !== null,
      readinessIssues: book.readinessIssues,
    }));
}

export async function updateBookDetails(bookId: string, input: BookDetailsInput): Promise<void> {
  await requireAdmin();
  assertUuid(bookId);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("books")
    .update({
      canonical_key: input.canonicalKey,
      original_language: input.originalLanguage,
      primary_author_id: input.primaryAuthorId,
    })
    .eq("id", bookId)
    .select("id");

  if (error) throw failure("updateBookDetails", error);
  if (!data || data.length === 0) throw new BookNotFoundError();
}

export async function saveBookLocalization(bookId: string, input: BookLocalizationInput): Promise<void> {
  await requireAdmin();
  assertUuid(bookId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_save_book_localization", {
    p_book_id: bookId,
    p_locale: input.locale,
    p_slug: input.slug,
    p_title: input.title,
    p_subtitle: input.subtitle,
    p_short_description: input.shortDescription,
    p_description: input.description,
    p_audience: input.audience,
    p_key_ideas: input.keyIdeas,
    p_faq: input.faq,
    p_seo_title: input.seoTitle,
    p_seo_description: input.seoDescription,
  });

  if (error) throw failure("saveBookLocalization", error);
}

export async function updateEdition(editionId: string, input: EditionInput): Promise<void> {
  await requireAdmin();
  assertUuid(editionId);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("editions")
    .update({
      language_code: input.languageCode,
      isbn: input.isbn,
      edition_number: input.editionNumber,
      publication_date: input.publicationDate,
    })
    .eq("id", editionId)
    .select("id");

  if (error) throw failure("updateEdition", error);
  if (!data || data.length === 0) throw new BookNotFoundError();
}

export async function updateOffer(offerId: string, input: OfferInput): Promise<void> {
  await requireAdmin();
  assertUuid(offerId);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("offers")
    .update({
      market_code: input.marketCode,
      currency: input.currency,
      price_minor: input.priceMinor,
      active: input.active,
    })
    .eq("id", offerId)
    .select("id");

  if (error) throw failure("updateOffer", error);
  if (!data || data.length === 0) throw new BookNotFoundError();
}

export async function setBookRelations(bookId: string, input: BookRelationsInput): Promise<void> {
  await requireAdmin();
  assertUuid(bookId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_book_relations", {
    p_book_id: bookId,
    p_topic_ids: input.topicIds,
    p_series_id: input.seriesId,
    p_series_position: input.seriesPosition,
  });

  if (error) throw failure("setBookRelations", error);
}

export async function publishBook(bookId: string): Promise<void> {
  await requireAdmin();
  assertUuid(bookId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("publish_book", { p_book_id: bookId });
  if (!error) return;
  if (error.code === "EB010") throw new BookNotReadyError(parseReadinessError(error.message) ?? []);
  throw failure("publishBook", error);
}

export async function unpublishBook(bookId: string): Promise<void> {
  await requireAdmin();
  assertUuid(bookId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("unpublish_book", { p_book_id: bookId });
  if (error) throw failure("unpublishBook", error);
}
```

If `npm run typecheck` rejects an RPC name or argument, the generated types are stale: regenerate them (Task 1, Step 5) rather than casting.

- [ ] **Step 6: Update the create-book action and the book page for the new DTO**

In `app/admin/books/actions.ts`, remove `DuplicateAuthorNameError` from the import list and delete its `if (error instanceof DuplicateAuthorNameError)` branch. Leave the canonical-key and slug branches unchanged.

In `app/admin/books/[bookId]/page.tsx`, the page still compiles because `localization`, `edition`, `sku`, and `offer` keep their old fields (the new ones are additive). No change is required beyond confirming `npm run typecheck` passes; Task 8 replaces this page.

- [ ] **Step 7: Run the tests and verify they pass**

Run: `npm test -- lib/data/books.test.ts lib/catalog/covers.test.ts app/admin`
Expected: PASS.

- [ ] **Step 8: Check and commit**

```bash
npm run check
git add lib/data/supabase-test-client.ts lib/catalog/covers.ts lib/catalog/covers.test.ts lib/data/books.ts lib/data/books.test.ts app/admin/books/actions.ts
git commit -m "feat: add the admin books data layer with readiness"
```

### Task 6: Authors, series, and topics admin

**Files:**
- Create: `lib/catalog/entity-guards.ts`
- Create: `lib/data/catalog-entities.ts`
- Create: `lib/data/catalog-entities.test.ts`
- Create: `components/ui/native-select.tsx`
- Create: `components/admin/form-feedback.tsx`
- Create: `components/admin/localized-entity-form.tsx`
- Create: `components/admin/entity-pages.tsx`
- Create: `app/admin/entities/actions.ts`
- Create: `app/admin/entities/actions.test.ts`
- Create: `app/admin/authors/page.tsx`, `app/admin/authors/new/page.tsx`, `app/admin/authors/[id]/page.tsx`
- Create: `app/admin/series/page.tsx`, `app/admin/series/new/page.tsx`, `app/admin/series/[id]/page.tsx`
- Create: `app/admin/topics/page.tsx`, `app/admin/topics/new/page.tsx`, `app/admin/topics/[id]/page.tsx`
- Modify: `components/admin/admin-nav.tsx`

**Interfaces:**
- Consumes: Task 1 write policies; Task 2 `admin_save_entity_localization`; Task 4 `entityBaseSchema`, `entityLocalizationSchema`, `AdminFormState`, `catalogEntityConfig`.
- Produces:

```ts
// lib/catalog/entity-guards.ts
export function isCatalogEntityType(value: unknown): value is CatalogEntityType;

// lib/data/catalog-entities.ts
export class DuplicateEntitySlugError extends Error {}   // localized slug taken in that locale
export class DuplicateCanonicalSlugError extends Error {} // canonical slug taken
export class EntityNotReadyError extends Error {}         // publish with no localization
export type CatalogEntityListItemDTO = { id: string; canonicalSlug: string; name: string; status: "draft" | "published" | "archived"; locales: ("vi" | "en")[] };
export type CatalogEntityDTO = CatalogEntityListItemDTO & {
  type: CatalogEntityType;
  localizations: { locale: "vi" | "en"; slug: string; name: string; description: string | null }[];
};
export async function listCatalogEntities(type: CatalogEntityType): Promise<CatalogEntityListItemDTO[]>;
export async function listCatalogEntityOptions(type: CatalogEntityType): Promise<{ id: string; name: string }[]>;
export async function getCatalogEntity(type: CatalogEntityType, id: string): Promise<CatalogEntityDTO>; // notFound()
export async function createCatalogEntity(type: CatalogEntityType, input: Pick<EntityBaseInput, "canonicalSlug" | "name">): Promise<{ id: string }>;
export async function updateCatalogEntity(type: CatalogEntityType, id: string, input: EntityBaseInput): Promise<void>;
export async function saveCatalogEntityLocalization(type: CatalogEntityType, id: string, input: EntityLocalizationInput): Promise<void>;

// app/admin/entities/actions.ts ("use server")
export async function createEntityAction(type: CatalogEntityType, previous: AdminFormState, formData: FormData): Promise<AdminFormState>;
export async function updateEntityAction(type: CatalogEntityType, id: string, previous: AdminFormState, formData: FormData): Promise<AdminFormState>;
export async function saveEntityLocalizationAction(type: CatalogEntityType, id: string, locale: "vi" | "en", previous: AdminFormState, formData: FormData): Promise<AdminFormState>;

// components/admin/form-feedback.tsx
export function FieldError({ message }: { message?: string }): JSX.Element | null;
export function FormStatus({ state }: { state: AdminFormState }): JSX.Element | null; // "Saved." has data-testid="form-saved"

// components/ui/native-select.tsx
export function NativeSelect(props: React.ComponentProps<"select">): JSX.Element;
```

- Form field names used by every entity form: `canonicalSlug`, `name`, `status`; localization forms: `slug`, `name`, `description`.
- Visible labels (used by Playwright): "Canonical slug", "Name", "Status", "Slug ({locale})", "Name ({locale})", "Description ({locale})"; buttons "Create {singular}", "Save", "Save {locale} copy".

- [ ] **Step 1: Write the failing DAL test**

Create `lib/data/catalog-entities.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import {
  createCatalogEntity,
  DuplicateCanonicalSlugError,
  DuplicateEntitySlugError,
  EntityNotReadyError,
  getCatalogEntity,
  listCatalogEntities,
  saveCatalogEntityLocalization,
  updateCatalogEntity,
} from "@/lib/data/catalog-entities";
import { fakeSupabaseClient } from "@/lib/data/supabase-test-client";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

type SessionClient = Awaited<ReturnType<typeof createClient>>;
const id = "4a1b2c3d-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("catalog entities", () => {
  it("never builds a client when the admin gate denies", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
    await expect(listCatalogEntities("author")).rejects.toThrow("NEXT_FORBIDDEN");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("reads the right table and name column, and lists localized locales", async () => {
    const fake = fakeSupabaseClient({
      tables: {
        topics: {
          data: [{ id, canonical_slug: "tinh-biet", name: "Tỉnh biết", status: "draft", localizations: [{ locale: "vi", slug: "tinh-biet", name: "Tỉnh biết", description: null }] }],
          error: null,
        },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    const topics = await listCatalogEntities("topic");

    expect(fake.from).toHaveBeenCalledWith("topics");
    expect(topics).toEqual([{ id, canonicalSlug: "tinh-biet", name: "Tỉnh biết", status: "draft", locales: ["vi"] }]);
  });

  it("creates new entities as drafts", async () => {
    const fake = fakeSupabaseClient({ tables: { series: { data: { id }, error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(createCatalogEntity("series", { canonicalSlug: "thay", name: "Thấy" })).resolves.toEqual({ id });
    expect(fake.from).toHaveBeenCalledWith("series");
  });

  it("maps a canonical slug collision", async () => {
    const fake = fakeSupabaseClient({
      tables: { authors: { data: null, error: { code: "23505", message: 'violates unique constraint "authors_canonical_slug_key"' } } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(createCatalogEntity("author", { canonicalSlug: "phuong-bui", name: "Phương Bùi" })).rejects.toBeInstanceOf(DuplicateCanonicalSlugError);
  });

  it("refuses to publish an entity with no localized copy", async () => {
    const fake = fakeSupabaseClient({
      tables: { authors: { data: { id, canonical_slug: "a", display_name: "A", status: "draft", localizations: [] }, error: null } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(
      updateCatalogEntity("author", id, { canonicalSlug: "a", name: "A", status: "published" }),
    ).rejects.toBeInstanceOf(EntityNotReadyError);
  });

  it("maps a localized slug collision", async () => {
    const fake = fakeSupabaseClient({
      rpc: { data: null, error: { code: "23505", message: 'violates unique constraint "author_localizations_locale_slug_key"' } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(
      saveCatalogEntityLocalization("author", id, { locale: "vi", slug: "phuong-bui", name: "Phương Bùi", description: null }),
    ).rejects.toBeInstanceOf(DuplicateEntitySlugError);
    expect(fake.rpc).toHaveBeenCalledWith("admin_save_entity_localization", {
      p_entity_type: "author",
      p_entity_id: id,
      p_locale: "vi",
      p_slug: "phuong-bui",
      p_name: "Phương Bùi",
      p_description: null,
    });
  });

  it("returns localizations in vi, en order", async () => {
    const fake = fakeSupabaseClient({
      tables: {
        series: {
          data: {
            id,
            canonical_slug: "thay",
            display_name: "Thấy",
            status: "draft",
            localizations: [
              { locale: "en", slug: "see", name: "See", description: null },
              { locale: "vi", slug: "thay", name: "Thấy", description: null },
            ],
          },
          error: null,
        },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    const series = await getCatalogEntity("series", id);
    expect(series.localizations.map((localization) => localization.locale)).toEqual(["vi", "en"]);
  });
});
```

Create `app/admin/entities/actions.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createEntityAction, saveEntityLocalizationAction } from "@/app/admin/entities/actions";
import { requireAdmin } from "@/lib/auth/admin";
import { initialAdminFormState } from "@/lib/catalog/form";
import { createCatalogEntity, DuplicateEntitySlugError, saveCatalogEntityLocalization } from "@/lib/data/catalog-entities";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("NEXT_REDIRECT"); }) }));
vi.mock("@/lib/data/catalog-entities", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/data/catalog-entities")>();
  return { ...original, createCatalogEntity: vi.fn(), saveCatalogEntityLocalization: vi.fn() };
});

function form(entries: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("entity actions", () => {
  it("rejects an entity type that is not author, series, or topic", async () => {
    const result = await createEntityAction("publisher" as never, initialAdminFormState, form({ canonicalSlug: "x", name: "X" }));
    expect(result.formError).toBe("Unknown catalog type.");
    expect(createCatalogEntity).not.toHaveBeenCalled();
  });

  it("returns field errors instead of calling the data layer", async () => {
    const result = await createEntityAction("author", initialAdminFormState, form({ canonicalSlug: "Not A Slug", name: "" }));
    expect(result.fieldErrors.canonicalSlug).toBeTruthy();
    expect(result.fieldErrors.name).toBe("Enter a name.");
    expect(createCatalogEntity).not.toHaveBeenCalled();
  });

  it("maps a localized slug collision to the slug field", async () => {
    vi.mocked(saveCatalogEntityLocalization).mockRejectedValue(new DuplicateEntitySlugError());
    const result = await saveEntityLocalizationAction(
      "author",
      "4a1b2c3d-0000-4000-8000-000000000001",
      "vi",
      initialAdminFormState,
      form({ slug: "phuong-bui", name: "Phương Bùi", description: "" }),
    );
    expect(result.fieldErrors.slug).toBe("This slug is already used in this language.");
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npm test -- lib/data/catalog-entities.test.ts app/admin/entities/actions.test.ts`
Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement the guard and the data layer**

Create `lib/catalog/entity-guards.ts`:

```ts
import { catalogEntityTypes, type CatalogEntityType } from "@/lib/catalog/entity-types";

export function isCatalogEntityType(value: unknown): value is CatalogEntityType {
  return typeof value === "string" && (catalogEntityTypes as readonly string[]).includes(value);
}
```

Create `lib/data/catalog-entities.ts`:

```ts
import "server-only";

import { notFound } from "next/navigation";

import { requireAdmin } from "@/lib/auth/admin";
import { catalogEntityConfig, type CatalogEntityType } from "@/lib/catalog/entity-types";
import type { EntityBaseInput, EntityLocalizationInput } from "@/lib/catalog/schemas";
import { createClient } from "@/lib/supabase/server";

export class DuplicateEntitySlugError extends Error {
  constructor() {
    super("This slug is already used in this language.");
    this.name = "DuplicateEntitySlugError";
  }
}

export class DuplicateCanonicalSlugError extends Error {
  constructor() {
    super("This canonical slug is already used.");
    this.name = "DuplicateCanonicalSlugError";
  }
}

export class EntityNotReadyError extends Error {
  constructor() {
    super("Add copy in at least one language before publishing.");
    this.name = "EntityNotReadyError";
  }
}

type Status = "draft" | "published" | "archived";
type Locale = "vi" | "en";

export type CatalogEntityListItemDTO = {
  id: string;
  canonicalSlug: string;
  name: string;
  status: Status;
  locales: Locale[];
};

export type CatalogEntityDTO = CatalogEntityListItemDTO & {
  type: CatalogEntityType;
  localizations: { locale: Locale; slug: string; name: string; description: string | null }[];
};

type EntityRow = {
  id: string;
  canonical_slug: string;
  status: Status;
  display_name?: string;
  name?: string;
  localizations: { locale: Locale; slug: string; name: string; description: string | null }[];
};

const localeOrder: Record<Locale, number> = { vi: 0, en: 1 };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function selectFor(type: CatalogEntityType) {
  const config = catalogEntityConfig[type];
  return `id, canonical_slug, ${config.nameColumn}, status, localizations:${config.localizationTable} ( locale, slug, name, description )`;
}

function toDto(type: CatalogEntityType, row: EntityRow): CatalogEntityDTO {
  const localizations = [...row.localizations].sort((a, b) => localeOrder[a.locale] - localeOrder[b.locale]);
  return {
    type,
    id: row.id,
    canonicalSlug: row.canonical_slug,
    name: row[catalogEntityConfig[type].nameColumn] ?? "",
    status: row.status,
    locales: localizations.map((localization) => localization.locale),
    localizations,
  };
}

function mapWriteError(operation: string, error: { code?: string; message: string }): Error {
  if (error.code === "23505" && error.message.includes("_locale_slug_key")) return new DuplicateEntitySlugError();
  if (error.code === "23505" && error.message.includes("_canonical_slug_key")) return new DuplicateCanonicalSlugError();
  return new Error(`${operation} failed: ${error.message}`);
}

export async function listCatalogEntities(type: CatalogEntityType): Promise<CatalogEntityListItemDTO[]> {
  await requireAdmin();
  const config = catalogEntityConfig[type];
  const supabase = await createClient();
  const { data, error } = await supabase.from(config.table).select(selectFor(type)).order(config.nameColumn);
  if (error) throw new Error(`listCatalogEntities(${type}) failed: ${error.message}`);

  return ((data ?? []) as unknown as EntityRow[]).map((row) => {
    const { type: _type, localizations: _localizations, ...item } = toDto(type, row);
    return item;
  });
}

export async function listCatalogEntityOptions(type: CatalogEntityType): Promise<{ id: string; name: string }[]> {
  const entities = await listCatalogEntities(type);
  return entities.map((entity) => ({ id: entity.id, name: entity.name }));
}

export async function getCatalogEntity(type: CatalogEntityType, id: string): Promise<CatalogEntityDTO> {
  await requireAdmin();
  if (!uuidPattern.test(id)) notFound();

  const config = catalogEntityConfig[type];
  const supabase = await createClient();
  const { data, error } = await supabase.from(config.table).select(selectFor(type)).eq("id", id).maybeSingle();
  if (error) throw new Error(`getCatalogEntity(${type}) failed: ${error.message}`);
  if (!data) notFound();

  return toDto(type, data as unknown as EntityRow);
}

export async function createCatalogEntity(
  type: CatalogEntityType,
  input: Pick<EntityBaseInput, "canonicalSlug" | "name">,
): Promise<{ id: string }> {
  await requireAdmin();
  const config = catalogEntityConfig[type];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from(config.table)
    .insert({ canonical_slug: input.canonicalSlug, [config.nameColumn]: input.name, status: "draft" })
    .select("id")
    .single();

  if (error) throw mapWriteError(`createCatalogEntity(${type})`, error);
  return { id: (data as { id: string }).id };
}

export async function updateCatalogEntity(type: CatalogEntityType, id: string, input: EntityBaseInput): Promise<void> {
  const current = await getCatalogEntity(type, id);
  if (input.status === "published" && current.localizations.length === 0) {
    throw new EntityNotReadyError();
  }

  const config = catalogEntityConfig[type];
  const supabase = await createClient();
  const { error } = await supabase
    .from(config.table)
    .update({ canonical_slug: input.canonicalSlug, [config.nameColumn]: input.name, status: input.status })
    .eq("id", id);

  if (error) throw mapWriteError(`updateCatalogEntity(${type})`, error);
}

export async function saveCatalogEntityLocalization(
  type: CatalogEntityType,
  id: string,
  input: EntityLocalizationInput,
): Promise<void> {
  await requireAdmin();
  if (!uuidPattern.test(id)) notFound();

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_save_entity_localization", {
    p_entity_type: type,
    p_entity_id: id,
    p_locale: input.locale,
    p_slug: input.slug,
    p_name: input.name,
    p_description: input.description,
  });

  if (error) throw mapWriteError(`saveCatalogEntityLocalization(${type})`, error);
}
```

If ESLint flags the unused `_type`/`_localizations` destructuring, replace that `map` body with an explicit object literal of the five list fields.

- [ ] **Step 4: Implement the actions**

Create `app/admin/entities/actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/auth/admin";
import { isCatalogEntityType } from "@/lib/catalog/entity-guards";
import { catalogEntityConfig, type CatalogEntityType } from "@/lib/catalog/entity-types";
import { fieldErrorsFrom, readOptionalText, readText, type AdminFormState } from "@/lib/catalog/form";
import { entityBaseSchema, entityLocalizationSchema } from "@/lib/catalog/schemas";
import {
  createCatalogEntity,
  DuplicateCanonicalSlugError,
  DuplicateEntitySlugError,
  EntityNotReadyError,
  saveCatalogEntityLocalization,
  updateCatalogEntity,
} from "@/lib/data/catalog-entities";

// Every runtime export of a "use server" module must be an async function.

const unknownType: AdminFormState = { fieldErrors: {}, formError: "Unknown catalog type.", savedAt: null };
const genericFailure = "Something went wrong saving. Try again.";

export async function createEntityAction(
  type: CatalogEntityType,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  if (!isCatalogEntityType(type)) return unknownType;
  const config = catalogEntityConfig[type];
  await requireAdmin({ next: `${config.adminPath}/new` });

  const parsed = entityBaseSchema
    .pick({ canonicalSlug: true, name: true })
    .safeParse({ canonicalSlug: readText(formData, "canonicalSlug"), name: readText(formData, "name") });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error), formError: null, savedAt: null };

  let id: string;
  try {
    ({ id } = await createCatalogEntity(type, parsed.data));
  } catch (error) {
    if (error instanceof DuplicateCanonicalSlugError) {
      return { fieldErrors: { canonicalSlug: error.message }, formError: null, savedAt: null };
    }
    return { fieldErrors: {}, formError: genericFailure, savedAt: null };
  }

  revalidatePath(config.adminPath);
  redirect(`${config.adminPath}/${id}`);
}

export async function updateEntityAction(
  type: CatalogEntityType,
  id: string,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  if (!isCatalogEntityType(type)) return unknownType;
  const config = catalogEntityConfig[type];
  await requireAdmin({ next: `${config.adminPath}/${id}` });

  const parsed = entityBaseSchema.safeParse({
    canonicalSlug: readText(formData, "canonicalSlug"),
    name: readText(formData, "name"),
    status: readText(formData, "status"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error), formError: null, savedAt: null };

  try {
    await updateCatalogEntity(type, id, parsed.data);
  } catch (error) {
    if (error instanceof DuplicateCanonicalSlugError) {
      return { fieldErrors: { canonicalSlug: error.message }, formError: null, savedAt: null };
    }
    if (error instanceof EntityNotReadyError) {
      return { fieldErrors: { status: error.message }, formError: null, savedAt: null };
    }
    return { fieldErrors: {}, formError: genericFailure, savedAt: null };
  }

  revalidatePath(config.adminPath);
  revalidatePath(`${config.adminPath}/${id}`);
  return { fieldErrors: {}, formError: null, savedAt: Date.now() };
}

export async function saveEntityLocalizationAction(
  type: CatalogEntityType,
  id: string,
  locale: "vi" | "en",
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  if (!isCatalogEntityType(type)) return unknownType;
  const config = catalogEntityConfig[type];
  await requireAdmin({ next: `${config.adminPath}/${id}` });

  const parsed = entityLocalizationSchema.safeParse({
    locale,
    slug: readText(formData, "slug"),
    name: readText(formData, "name"),
    description: readOptionalText(formData, "description"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error), formError: null, savedAt: null };

  try {
    await saveCatalogEntityLocalization(type, id, parsed.data);
  } catch (error) {
    if (error instanceof DuplicateEntitySlugError) {
      return { fieldErrors: { slug: error.message }, formError: null, savedAt: null };
    }
    return { fieldErrors: {}, formError: genericFailure, savedAt: null };
  }

  revalidatePath(`${config.adminPath}/${id}`);
  return { fieldErrors: {}, formError: null, savedAt: Date.now() };
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npm test -- lib/data/catalog-entities.test.ts app/admin/entities/actions.test.ts`
Expected: PASS.

- [ ] **Step 6: Build the shared form pieces**

Create `components/ui/native-select.tsx`:

```tsx
import * as React from "react";
import { cn } from "cn";

// A native <select> styled like Input. Used where a form posts a plain value and tests select by
// label; the Base UI Select stays for richer pickers.
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "min-h-11 w-full rounded-sm border border-sand bg-white px-3.5 py-2.5 text-base text-ink outline-none focus-visible:border-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest disabled:opacity-50 aria-invalid:border-error md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { NativeSelect };
```

Create `components/admin/form-feedback.tsx`:

```tsx
import type { AdminFormState } from "@/lib/catalog/form";

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="text-[0.8125rem] text-error" role="alert">
      {message}
    </p>
  );
}

export function FormStatus({ state }: { state: AdminFormState }) {
  if (state.formError) {
    return (
      <p className="text-[0.8125rem] text-error" role="alert">
        {state.formError}
      </p>
    );
  }
  if (state.savedAt) {
    return (
      <p className="text-[0.8125rem] text-success" data-testid="form-saved" key={state.savedAt} role="status">
        Saved.
      </p>
    );
  }
  return null;
}
```

Create `components/admin/localized-entity-form.tsx`:

```tsx
"use client";

import { useActionState } from "react";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";

type FormAction = (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;

export function EntityBaseForm({
  action,
  defaults,
  showStatus,
  submitLabel,
}: {
  action: FormAction;
  defaults: { canonicalSlug: string; name: string; status: string };
  showStatus: boolean;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);

  return (
    <form action={formAction} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="canonicalSlug">Canonical slug</Label>
        <Input defaultValue={defaults.canonicalSlug} id="canonicalSlug" name="canonicalSlug" required />
        <FieldError message={state.fieldErrors.canonicalSlug} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input defaultValue={defaults.name} id="name" name="name" required />
        <FieldError message={state.fieldErrors.name} />
      </div>
      {showStatus ? (
        <div className="space-y-2">
          <Label htmlFor="status">Status</Label>
          <NativeSelect defaultValue={defaults.status} id="status" name="status">
            <option value="draft">Draft</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </NativeSelect>
          <FieldError message={state.fieldErrors.status} />
        </div>
      ) : null}
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
    </form>
  );
}

export function EntityLocalizationForm({
  action,
  locale,
  defaults,
}: {
  action: FormAction;
  locale: "vi" | "en";
  defaults: { slug: string; name: string; description: string | null } | null;
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);
  const suffix = `(${locale})`;

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`slug-${locale}`}>Slug {suffix}</Label>
          <Input defaultValue={defaults?.slug ?? ""} id={`slug-${locale}`} name="slug" required />
          <FieldError message={state.fieldErrors.slug} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`name-${locale}`}>Name {suffix}</Label>
          <Input defaultValue={defaults?.name ?? ""} id={`name-${locale}`} name="name" required />
          <FieldError message={state.fieldErrors.name} />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`description-${locale}`}>Description {suffix}</Label>
        <Textarea defaultValue={defaults?.description ?? ""} id={`description-${locale}`} name="description" rows={5} />
        <FieldError message={state.fieldErrors.description} />
      </div>
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">{`Save ${locale} copy`}</SubmitButton>
    </form>
  );
}
```

`SubmitButton` renders a full-width button; that is fine inside these admin columns.

- [ ] **Step 7: Build the shared page bodies**

Create `components/admin/entity-pages.tsx`:

```tsx
import Link from "next/link";

import { AdminPageHeader, AdminSection } from "@/components/admin/admin-page-header";
import { EntityBaseForm, EntityLocalizationForm } from "@/components/admin/localized-entity-form";
import { Button } from "@/components/ui/button";
import { createEntityAction, saveEntityLocalizationAction, updateEntityAction } from "@/app/admin/entities/actions";
import { catalogEntityConfig, type CatalogEntityType } from "@/lib/catalog/entity-types";
import { getCatalogEntity, listCatalogEntities } from "@/lib/data/catalog-entities";

// Page bodies only. Each route file under app/admin/{authors,series,topics} calls requireAdmin()
// itself before rendering one of these; the data functions below call it again.

export async function EntityListPage({ type }: { type: CatalogEntityType }) {
  const config = catalogEntityConfig[type];
  const entities = await listCatalogEntities(type);

  return (
    <div className="max-w-[56rem]">
      <AdminPageHeader eyebrow="Catalog" title={config.plural}>
        <Button render={<Link href={`${config.adminPath}/new`} />}>{`New ${config.singular.toLowerCase()}`}</Button>
      </AdminPageHeader>
      {entities.length === 0 ? (
        <p className="text-sage-text">{`No ${config.plural.toLowerCase()} yet.`}</p>
      ) : (
        <table className="w-full border-t border-ink text-left text-sm">
          <thead>
            <tr className="border-b border-sand text-[0.6875rem] tracking-[0.08em] text-sage-text uppercase">
              <th className="py-3 font-medium">Name</th>
              <th className="py-3 font-medium">Slug</th>
              <th className="py-3 font-medium">Languages</th>
              <th className="py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {entities.map((entity) => (
              <tr className="border-b border-sand" key={entity.id}>
                <td className="py-3">
                  <Link className="font-medium text-forest underline decoration-sand underline-offset-4" href={`${config.adminPath}/${entity.id}`}>
                    {entity.name}
                  </Link>
                </td>
                <td className="py-3 font-mono text-[0.8125rem]">{entity.canonicalSlug}</td>
                <td className="py-3">{entity.locales.join(", ") || "—"}</td>
                <td className="py-3">{entity.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function EntityNewPage({ type }: { type: CatalogEntityType }) {
  const config = catalogEntityConfig[type];
  return (
    <div className="max-w-[42.5rem]">
      <AdminPageHeader eyebrow="Catalog" title={`New ${config.singular.toLowerCase()}`}>
        New entries start as drafts. Add copy in each language, then publish.
      </AdminPageHeader>
      <div className="border-t border-ink pt-8">
        <EntityBaseForm
          action={createEntityAction.bind(null, type)}
          defaults={{ canonicalSlug: "", name: "", status: "draft" }}
          showStatus={false}
          submitLabel={`Create ${config.singular.toLowerCase()}`}
        />
      </div>
    </div>
  );
}

export async function EntityEditPage({ type, id }: { type: CatalogEntityType; id: string }) {
  const config = catalogEntityConfig[type];
  const entity = await getCatalogEntity(type, id);

  return (
    <div className="max-w-[42.5rem]">
      <AdminPageHeader eyebrow={config.singular} title={entity.name}>
        <p>
          {entity.canonicalSlug} &middot; {entity.status}
        </p>
      </AdminPageHeader>
      <div className="space-y-12">
        <AdminSection title="Details">
          <EntityBaseForm
            action={updateEntityAction.bind(null, type, id)}
            defaults={{ canonicalSlug: entity.canonicalSlug, name: entity.name, status: entity.status }}
            showStatus
            submitLabel="Save"
          />
        </AdminSection>
        {(["vi", "en"] as const).map((locale) => (
          <AdminSection key={locale} title={locale === "vi" ? "Vietnamese copy" : "English copy"}>
            <EntityLocalizationForm
              action={saveEntityLocalizationAction.bind(null, type, id, locale)}
              defaults={entity.localizations.find((localization) => localization.locale === locale) ?? null}
              locale={locale}
            />
          </AdminSection>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Add the nine route files**

`app/admin/authors/page.tsx`:

```tsx
import { EntityListPage } from "@/components/admin/entity-pages";
import { requireAdmin } from "@/lib/auth/admin";

export default async function AuthorsPage() {
  await requireAdmin({ next: "/admin/authors" });
  return <EntityListPage type="author" />;
}
```

`app/admin/authors/new/page.tsx`:

```tsx
import { EntityNewPage } from "@/components/admin/entity-pages";
import { requireAdmin } from "@/lib/auth/admin";

export default async function NewAuthorPage() {
  await requireAdmin({ next: "/admin/authors/new" });
  return <EntityNewPage type="author" />;
}
```

`app/admin/authors/[id]/page.tsx`:

```tsx
import { EntityEditPage } from "@/components/admin/entity-pages";
import { requireAdmin } from "@/lib/auth/admin";

export default async function AuthorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdmin({ next: `/admin/authors/${id}` });
  return <EntityEditPage id={id} type="author" />;
}
```

`app/admin/series/page.tsx`:

```tsx
import { EntityListPage } from "@/components/admin/entity-pages";
import { requireAdmin } from "@/lib/auth/admin";

export default async function SeriesListPage() {
  await requireAdmin({ next: "/admin/series" });
  return <EntityListPage type="series" />;
}
```

`app/admin/series/new/page.tsx`:

```tsx
import { EntityNewPage } from "@/components/admin/entity-pages";
import { requireAdmin } from "@/lib/auth/admin";

export default async function NewSeriesPage() {
  await requireAdmin({ next: "/admin/series/new" });
  return <EntityNewPage type="series" />;
}
```

`app/admin/series/[id]/page.tsx`:

```tsx
import { EntityEditPage } from "@/components/admin/entity-pages";
import { requireAdmin } from "@/lib/auth/admin";

export default async function SeriesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdmin({ next: `/admin/series/${id}` });
  return <EntityEditPage id={id} type="series" />;
}
```

`app/admin/topics/page.tsx`:

```tsx
import { EntityListPage } from "@/components/admin/entity-pages";
import { requireAdmin } from "@/lib/auth/admin";

export default async function TopicsPage() {
  await requireAdmin({ next: "/admin/topics" });
  return <EntityListPage type="topic" />;
}
```

`app/admin/topics/new/page.tsx`:

```tsx
import { EntityNewPage } from "@/components/admin/entity-pages";
import { requireAdmin } from "@/lib/auth/admin";

export default async function NewTopicPage() {
  await requireAdmin({ next: "/admin/topics/new" });
  return <EntityNewPage type="topic" />;
}
```

`app/admin/topics/[id]/page.tsx`:

```tsx
import { EntityEditPage } from "@/components/admin/entity-pages";
import { requireAdmin } from "@/lib/auth/admin";

export default async function TopicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdmin({ next: `/admin/topics/${id}` });
  return <EntityEditPage id={id} type="topic" />;
}
```

- [ ] **Step 9: Extend the admin navigation**

Replace `components/admin/admin-nav.tsx`:

```tsx
import Link from "next/link";

// Navigation only - rendered inside app/admin/layout.tsx, which is never the
// authorization boundary. Every linked page calls requireAdmin() itself.
const links = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/books", label: "Books" },
  { href: "/admin/authors", label: "Authors" },
  { href: "/admin/series", label: "Series" },
  { href: "/admin/topics", label: "Topics" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/merchandising", label: "Merchandising" },
] as const;

export function AdminNav() {
  return (
    <nav aria-label="Admin navigation" className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm font-medium">
      {links.map((link) => (
        <Link
          className="inline-flex min-h-11 items-center text-ink underline-offset-[6px] hover:underline"
          href={link.href}
          key={link.href}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
```

`/admin/books`, `/admin/users`, and `/admin/merchandising` return 404 until Tasks 7, 11, and 12 add them.

- [ ] **Step 10: Check manually, then commit**

Run `npm run dev` against a local stack, sign in as an admin through `/internal/en/sign-in`, create an author, save its Vietnamese copy, and publish it.
Expected: the author list shows `vi` and `published`, and `audit_logs` has one `catalog_insert`, one `save_author_localization`, and one `catalog_update` row for it.

```bash
npm run check
git add lib/catalog/entity-guards.ts lib/data/catalog-entities.ts lib/data/catalog-entities.test.ts components/ui/native-select.tsx components/admin/form-feedback.tsx components/admin/localized-entity-form.tsx components/admin/entity-pages.tsx components/admin/admin-nav.tsx app/admin/entities app/admin/authors app/admin/series app/admin/topics
git commit -m "feat: add author, series, and topic admin"
```

### Task 7: Books list and author picker on the new-book form

**Files:**
- Create: `app/admin/books/page.tsx`
- Create: `components/admin/readiness-badge.tsx`
- Modify: `app/admin/books/new/page.tsx`
- Modify: `components/admin/book-form.tsx`

**Interfaces:**
- Consumes: Task 5 `listAdminBooks`, `AdminBookListItemDTO`; Task 6 `listCatalogEntityOptions`; Task 3 `readinessIssueMessage`.
- Produces:
  - `/admin/books?q=` list page. Table columns: Title (link to `/admin/books/{id}`), Author, Status, EPUB, Readiness.
  - `ReadinessBadge({ issues }: { issues: ReadinessIssueCode[] })` — shows "Ready to publish" or "{n} to fix", with the issue messages as a tooltip `title`.
  - `BookForm({ authorOptions }: { authorOptions: { id: string; name: string }[] })` — the "Author name" input gets `list="author-options"` and a `<datalist>` of existing names. Field names and labels are unchanged.

- [ ] **Step 1: Add the readiness badge**

Create `components/admin/readiness-badge.tsx`:

```tsx
import { readinessIssueMessage, type ReadinessIssueCode } from "@/lib/catalog/readiness";

export function ReadinessBadge({ issues }: { issues: ReadinessIssueCode[] }) {
  if (issues.length === 0) {
    return (
      <span className="rounded-full border border-success px-2.5 py-0.5 text-[0.6875rem] font-medium tracking-[0.06em] text-success uppercase">
        Ready to publish
      </span>
    );
  }
  return (
    <span
      className="rounded-full border border-sand px-2.5 py-0.5 text-[0.6875rem] font-medium tracking-[0.06em] text-ink uppercase"
      title={issues.map((issue) => readinessIssueMessage[issue]).join("\n")}
    >
      {issues.length} to fix
    </span>
  );
}
```

- [ ] **Step 2: Add the books list page**

Create `app/admin/books/page.tsx`:

```tsx
import Link from "next/link";

import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { ReadinessBadge } from "@/components/admin/readiness-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireAdmin } from "@/lib/auth/admin";
import { listAdminBooks } from "@/lib/data/books";

export default async function AdminBooksPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireAdmin({ next: "/admin/books" });
  const { q } = await searchParams;
  const books = await listAdminBooks(q);

  return (
    <div className="max-w-[64rem]">
      <AdminPageHeader eyebrow="Catalog" title="Books">
        <div className="flex flex-wrap items-center gap-3">
          <form className="flex gap-2" method="get">
            <label className="sr-only" htmlFor="book-search">
              Search books
            </label>
            <Input defaultValue={q ?? ""} id="book-search" name="q" placeholder="Title or canonical key" />
            <Button type="submit" variant="outline">
              Search
            </Button>
          </form>
          <Button render={<Link href="/admin/books/new" />}>New book</Button>
        </div>
      </AdminPageHeader>

      {books.length === 0 ? (
        <p className="text-sage-text">{q ? "No books match this search." : "No books yet."}</p>
      ) : (
        <table className="w-full border-t border-ink text-left text-sm">
          <thead>
            <tr className="border-b border-sand text-[0.6875rem] tracking-[0.08em] text-sage-text uppercase">
              <th className="py-3 font-medium">Title</th>
              <th className="py-3 font-medium">Author</th>
              <th className="py-3 font-medium">Status</th>
              <th className="py-3 font-medium">EPUB</th>
              <th className="py-3 font-medium">Readiness</th>
            </tr>
          </thead>
          <tbody>
            {books.map((book) => (
              <tr className="border-b border-sand" key={book.id}>
                <td className="py-3">
                  <Link className="font-medium text-forest underline decoration-sand underline-offset-4" href={`/admin/books/${book.id}`}>
                    {book.title}
                  </Link>
                  <span className="block font-mono text-[0.75rem] text-sage-text">{book.canonicalKey}</span>
                </td>
                <td className="py-3">{book.authorName}</td>
                <td className="py-3">{book.status}</td>
                <td className="py-3">{book.hasActivePublication ? "Active version" : "None"}</td>
                <td className="py-3">
                  <ReadinessBadge issues={book.readinessIssues} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Offer existing authors on the new-book form**

In `components/admin/book-form.tsx`, change the component signature and the author field:

```tsx
export function BookForm({ authorOptions }: { authorOptions: { id: string; name: string }[] }) {
  const [state, formAction] = useActionState(createBookAction, initialFormState);
```

```tsx
      <div className="space-y-2">
        <Label htmlFor="authorName">Author name</Label>
        <Input id="authorName" list="author-options" name="authorName" placeholder="Phương Bùi" required />
        <datalist id="author-options">
          {authorOptions.map((author) => (
            <option key={author.id} value={author.name} />
          ))}
        </datalist>
        <p className="text-[0.8125rem] text-sage-text">
          Pick an existing author to add another book for them, or type a new name.
        </p>
        <FieldError message={state.fieldErrors.authorName} />
      </div>
```

Replace `app/admin/books/new/page.tsx`:

```tsx
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { BookForm } from "@/components/admin/book-form";
import { requireAdmin } from "@/lib/auth/admin";
import { listCatalogEntityOptions } from "@/lib/data/catalog-entities";

export default async function NewBookPage() {
  await requireAdmin({ next: "/admin/books/new" });
  const authorOptions = await listCatalogEntityOptions("author");

  return (
    <div className="max-w-[42.5rem]">
      <AdminPageHeader eyebrow="Catalog" title="New book">
        Creates the book with one localization, edition, ebook SKU, and offer. An existing author with the same name is reused.
      </AdminPageHeader>
      <div className="border-t border-ink pt-8">
        <BookForm authorOptions={authorOptions} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Check manually**

With `npm run dev` on a local stack: create two books with the same author name from `/admin/books/new`, then open `/admin/books` and search for one title.
Expected: both books exist under one author row, the search narrows the table, and each row shows a readiness badge.

- [ ] **Step 5: Check and commit**

```bash
npm run check
git add app/admin/books/page.tsx app/admin/books/new/page.tsx components/admin/book-form.tsx components/admin/readiness-badge.tsx
git commit -m "feat: add the admin books list and author picker"
```

### Task 8: Book editor sections

**Files:**
- Create: `lib/catalog/revalidate.ts`
- Create: `app/admin/books/[bookId]/editor-actions.ts`
- Create: `app/admin/books/[bookId]/editor-actions.test.ts`
- Create: `components/admin/book-editor/details-form.tsx`
- Create: `components/admin/book-editor/localization-form.tsx`
- Create: `components/admin/book-editor/edition-offer-forms.tsx`
- Create: `components/admin/book-editor/relations-form.tsx`
- Create: `components/admin/book-editor/section-nav.tsx`
- Modify: `components/admin/admin-page-header.tsx` (`AdminSection` accepts `id`)
- Replace: `app/admin/books/[bookId]/page.tsx`

**Interfaces:**
- Consumes: Task 4 schemas and form helpers; Task 5 `getAdminBook` and write functions; Task 6 `listCatalogEntityOptions`, `FieldError`, `FormStatus`, `NativeSelect`.
- Produces:

```ts
// lib/catalog/revalidate.ts
export function revalidateBookAdmin(bookId: string): void; // /admin/books and /admin/books/{id}; S2 adds public paths here

// app/admin/books/[bookId]/editor-actions.ts ("use server")
export async function updateBookDetailsAction(bookId: string, previous: AdminFormState, formData: FormData): Promise<AdminFormState>;
export async function saveBookLocalizationAction(bookId: string, locale: "vi" | "en", previous: AdminFormState, formData: FormData): Promise<AdminFormState>;
export async function updateEditionAction(bookId: string, editionId: string, previous: AdminFormState, formData: FormData): Promise<AdminFormState>;
export async function updateOfferAction(bookId: string, offerId: string, previous: AdminFormState, formData: FormData): Promise<AdminFormState>;
export async function setBookRelationsAction(bookId: string, previous: AdminFormState, formData: FormData): Promise<AdminFormState>;

// components/admin/book-editor/section-nav.tsx
export type EditorSectionLink = { id: BookEditorSection; label: string };
export function SectionNav({ sections }: { sections: EditorSectionLink[] }): JSX.Element;
```

- Form field names: details `canonicalKey`, `originalLanguage`, `primaryAuthorId`; localization `slug`, `title`, `subtitle`, `shortDescription`, `description`, `audience`, `keyIdeas`, `faq`, `seoTitle`, `seoDescription`; edition `languageCode`, `isbn`, `editionNumber`, `publicationDate`; offer `marketCode`, `currency`, `priceMinor`, `active`; relations `topicIds` (checkboxes), `seriesId`, `seriesPosition`.
- Section element ids: `details`, `localizations`, `offer`, `relations`, `epub` (Task 9 adds `cover`, Task 10 adds `publish`).
- Labels Playwright uses: "Primary author", "Title (vi)", "Slug (vi)", "Description (vi)", "Key ideas (vi)", "Price (minor units)", "Offer is active", "Series position"; buttons "Save details", "Save vi copy", "Save en copy", "Save edition", "Save offer", "Save relations".
- The page header keeps `{authorName} · {canonicalKey} · {status}` and `Price: {priceMinor} {currency} ({marketCode})`, which `e2e/admin-create-book.spec.ts` asserts.

- [ ] **Step 1: Write the failing action tests**

Create `app/admin/books/[bookId]/editor-actions.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  saveBookLocalizationAction,
  setBookRelationsAction,
  updateOfferAction,
} from "@/app/admin/books/[bookId]/editor-actions";
import { requireAdmin } from "@/lib/auth/admin";
import { initialAdminFormState } from "@/lib/catalog/form";
import { DuplicateSlugError, saveBookLocalization, SeriesPositionTakenError, setBookRelations, updateOffer } from "@/lib/data/books";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data/books", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/data/books")>();
  return { ...original, saveBookLocalization: vi.fn(), setBookRelations: vi.fn(), updateOffer: vi.fn() };
});

const bookId = "3a1b2c3d-0000-4000-8000-000000000001";
const offerId = "8a1b2c3d-0000-4000-8000-000000000001";

function form(entries: [string, string][]) {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("book editor actions", () => {
  it("parses key ideas and FAQ text before saving a localization", async () => {
    const result = await saveBookLocalizationAction(
      bookId,
      "vi",
      initialAdminFormState,
      form([
        ["slug", "quan-sat"],
        ["title", "Quan sát"],
        ["description", "Mô tả"],
        ["keyIdeas", "Quan sát | Nhìn mà không phán xét\nTự do"],
        ["faq", "Q: Đọc ở đâu?\nA: Trên web."],
      ]),
    );

    expect(result.savedAt).not.toBeNull();
    expect(saveBookLocalization).toHaveBeenCalledWith(bookId, expect.objectContaining({
      locale: "vi",
      subtitle: null,
      keyIdeas: [{ title: "Quan sát", summary: "Nhìn mà không phán xét" }, { title: "Tự do", summary: "" }],
      faq: [{ question: "Đọc ở đâu?", answer: "Trên web." }],
    }));
  });

  it("puts a slug collision on the slug field", async () => {
    vi.mocked(saveBookLocalization).mockRejectedValue(new DuplicateSlugError());
    const result = await saveBookLocalizationAction(bookId, "vi", initialAdminFormState, form([["slug", "taken"], ["title", "T"]]));
    expect(result.fieldErrors.slug).toBe("A book with this locale and slug already exists.");
  });

  it("reads an unchecked active box as false", async () => {
    await updateOfferAction(bookId, offerId, initialAdminFormState, form([["marketCode", "VN"], ["currency", "VND"], ["priceMinor", "0"]]));
    expect(updateOffer).toHaveBeenCalledWith(offerId, { marketCode: "VN", currency: "VND", priceMinor: 0, active: false });
  });

  it("requires a position when a series is chosen and maps a taken position", async () => {
    const seriesId = "aa1b2c3d-0000-4000-8000-000000000001";
    const missing = await setBookRelationsAction(bookId, initialAdminFormState, form([["seriesId", seriesId]]));
    expect(missing.fieldErrors.seriesPosition).toBe("Enter the book's position in the series.");
    expect(setBookRelations).not.toHaveBeenCalled();

    vi.mocked(setBookRelations).mockRejectedValue(new SeriesPositionTakenError());
    const taken = await setBookRelationsAction(bookId, initialAdminFormState, form([["seriesId", seriesId], ["seriesPosition", "1"]]));
    expect(taken.fieldErrors.seriesPosition).toBe("Another book already holds this position in the series.");
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npm test -- "app/admin/books/[bookId]/editor-actions.test.ts"`
Expected: FAIL because `editor-actions` does not exist.

- [ ] **Step 3: Implement revalidation and the actions**

Create `lib/catalog/revalidate.ts`:

```ts
import { revalidatePath } from "next/cache";

// Every page that shows a book's catalog data. S2 adds the public book, catalog, and home paths here
// so admin saves refresh the storefront too.
export function revalidateBookAdmin(bookId: string) {
  revalidatePath("/admin/books");
  revalidatePath(`/admin/books/${bookId}`);
}
```

Create `app/admin/books/[bookId]/editor-actions.ts`:

```ts
"use server";

import { requireAdmin } from "@/lib/auth/admin";
import {
  fieldErrorsFrom,
  parseFaq,
  parseKeyIdeas,
  readBoolean,
  readInteger,
  readList,
  readOptionalInteger,
  readOptionalText,
  readText,
  type AdminFormState,
} from "@/lib/catalog/form";
import { revalidateBookAdmin } from "@/lib/catalog/revalidate";
import {
  bookDetailsSchema,
  bookLocalizationSchema,
  bookRelationsSchema,
  editionSchema,
  offerSchema,
} from "@/lib/catalog/schemas";
import {
  BookNotFoundError,
  DuplicateCanonicalKeyError,
  DuplicateSlugError,
  saveBookLocalization,
  SeriesPositionTakenError,
  setBookRelations,
  updateBookDetails,
  updateEdition,
  updateOffer,
} from "@/lib/data/books";

// Every runtime export of a "use server" module must be an async function. Each action calls
// requireAdmin() before parsing, never returns raw database text, and revalidates the book pages.

const saved = (): AdminFormState => ({ fieldErrors: {}, formError: null, savedAt: Date.now() });
const invalid = (error: Parameters<typeof fieldErrorsFrom>[0]): AdminFormState => ({
  fieldErrors: fieldErrorsFrom(error),
  formError: null,
  savedAt: null,
});

function knownFailure(error: unknown): AdminFormState {
  if (error instanceof DuplicateCanonicalKeyError) return { fieldErrors: { canonicalKey: error.message }, formError: null, savedAt: null };
  if (error instanceof DuplicateSlugError) return { fieldErrors: { slug: error.message }, formError: null, savedAt: null };
  if (error instanceof SeriesPositionTakenError) return { fieldErrors: { seriesPosition: error.message }, formError: null, savedAt: null };
  if (error instanceof BookNotFoundError) return { fieldErrors: {}, formError: error.message, savedAt: null };
  return { fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null };
}

export async function updateBookDetailsAction(bookId: string, _previous: AdminFormState, formData: FormData): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/books/${bookId}` });
  const parsed = bookDetailsSchema.safeParse({
    canonicalKey: readText(formData, "canonicalKey"),
    originalLanguage: readText(formData, "originalLanguage"),
    primaryAuthorId: readText(formData, "primaryAuthorId"),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await updateBookDetails(bookId, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateBookAdmin(bookId);
  return saved();
}

export async function saveBookLocalizationAction(
  bookId: string,
  locale: "vi" | "en",
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/books/${bookId}` });
  const parsed = bookLocalizationSchema.safeParse({
    locale,
    slug: readText(formData, "slug"),
    title: readText(formData, "title"),
    subtitle: readOptionalText(formData, "subtitle"),
    shortDescription: readOptionalText(formData, "shortDescription"),
    description: readOptionalText(formData, "description"),
    audience: readOptionalText(formData, "audience"),
    keyIdeas: parseKeyIdeas(readText(formData, "keyIdeas")),
    faq: parseFaq(readText(formData, "faq")),
    seoTitle: readOptionalText(formData, "seoTitle"),
    seoDescription: readOptionalText(formData, "seoDescription"),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await saveBookLocalization(bookId, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateBookAdmin(bookId);
  return saved();
}

export async function updateEditionAction(
  bookId: string,
  editionId: string,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/books/${bookId}` });
  const parsed = editionSchema.safeParse({
    languageCode: readText(formData, "languageCode"),
    isbn: readOptionalText(formData, "isbn"),
    editionNumber: readInteger(formData, "editionNumber"),
    publicationDate: readOptionalText(formData, "publicationDate"),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await updateEdition(editionId, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateBookAdmin(bookId);
  return saved();
}

export async function updateOfferAction(
  bookId: string,
  offerId: string,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/books/${bookId}` });
  const parsed = offerSchema.safeParse({
    marketCode: readText(formData, "marketCode"),
    currency: readText(formData, "currency"),
    priceMinor: readInteger(formData, "priceMinor"),
    active: readBoolean(formData, "active"),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await updateOffer(offerId, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateBookAdmin(bookId);
  return saved();
}

export async function setBookRelationsAction(bookId: string, _previous: AdminFormState, formData: FormData): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/books/${bookId}` });
  const seriesId = readOptionalText(formData, "seriesId");
  const parsed = bookRelationsSchema.safeParse({
    topicIds: readList(formData, "topicIds"),
    seriesId,
    seriesPosition: seriesId === null ? null : readOptionalInteger(formData, "seriesPosition"),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await setBookRelations(bookId, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateBookAdmin(bookId);
  return saved();
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npm test -- "app/admin/books/[bookId]/editor-actions.test.ts"`
Expected: PASS.

- [ ] **Step 5: Let `AdminSection` carry an anchor id**

In `components/admin/admin-page-header.tsx`, replace `AdminSection`:

```tsx
// A titled section separated by an Ink rule rather than boxed in a card (board 1a, principle 2).
export function AdminSection({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section className="scroll-mt-24 border-t border-ink pt-6" id={id}>
      <h2 className="mb-5 font-serif text-2xl font-normal">{title}</h2>
      {children}
    </section>
  );
}
```

- [ ] **Step 6: Build the section components**

Create `components/admin/book-editor/section-nav.tsx`:

```tsx
import type { BookEditorSection } from "@/lib/catalog/readiness";

export type EditorSectionLink = { id: BookEditorSection; label: string };

export function SectionNav({ sections }: { sections: EditorSectionLink[] }) {
  return (
    <nav aria-label="Book editor sections" className="mb-10 flex flex-wrap gap-x-5 gap-y-1 border-b border-sand pb-3 text-sm">
      {sections.map((section) => (
        <a className="inline-flex min-h-11 items-center text-forest hover:text-ink" href={`#${section.id}`} key={section.id}>
          {section.label}
        </a>
      ))}
    </nav>
  );
}
```

Create `components/admin/book-editor/details-form.tsx`:

```tsx
"use client";

import { useActionState } from "react";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";

export function DetailsForm({
  action,
  authors,
  defaults,
}: {
  action: (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;
  authors: { id: string; name: string }[];
  defaults: { canonicalKey: string; originalLanguage: string; primaryAuthorId: string };
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);

  return (
    <form action={formAction} className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="details-canonicalKey">Canonical key</Label>
          <Input defaultValue={defaults.canonicalKey} id="details-canonicalKey" name="canonicalKey" required />
          <FieldError message={state.fieldErrors.canonicalKey} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="details-originalLanguage">Book language</Label>
          <NativeSelect defaultValue={defaults.originalLanguage} id="details-originalLanguage" name="originalLanguage">
            <option value="vi">Vietnamese (vi)</option>
            <option value="en">English (en)</option>
          </NativeSelect>
          <FieldError message={state.fieldErrors.originalLanguage} />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="details-primaryAuthorId">Primary author</Label>
        <NativeSelect defaultValue={defaults.primaryAuthorId} id="details-primaryAuthorId" name="primaryAuthorId">
          {authors.map((author) => (
            <option key={author.id} value={author.id}>
              {author.name}
            </option>
          ))}
        </NativeSelect>
        <FieldError message={state.fieldErrors.primaryAuthorId} />
      </div>
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">Save details</SubmitButton>
    </form>
  );
}
```

Create `components/admin/book-editor/localization-form.tsx`:

```tsx
"use client";

import { useActionState } from "react";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatFaq, formatKeyIdeas, initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";
import type { BookLocalizationDTO } from "@/lib/data/books";

type TextField = { name: string; label: string; multiline?: boolean; hint?: string; value: string };

export function LocalizationForm({
  action,
  locale,
  localization,
}: {
  action: (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;
  locale: "vi" | "en";
  localization: BookLocalizationDTO | null;
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);
  const fields: TextField[] = [
    { name: "title", label: "Title", value: localization?.title ?? "" },
    { name: "slug", label: "Slug", value: localization?.slug ?? "" },
    { name: "subtitle", label: "Subtitle", value: localization?.subtitle ?? "" },
    { name: "shortDescription", label: "Short description", multiline: true, value: localization?.shortDescription ?? "" },
    { name: "description", label: "Description", multiline: true, value: localization?.description ?? "" },
    { name: "audience", label: "Who it is for", multiline: true, value: localization?.audience ?? "" },
    {
      name: "keyIdeas",
      label: "Key ideas",
      multiline: true,
      hint: "One idea per line: Title | short summary",
      value: formatKeyIdeas(localization?.keyIdeas ?? []),
    },
    {
      name: "faq",
      label: "FAQ",
      multiline: true,
      hint: "Blocks separated by a blank line: Q: question, then A: answer",
      value: formatFaq(localization?.faq ?? []),
    },
    { name: "seoTitle", label: "SEO title", hint: "Up to 70 characters", value: localization?.seoTitle ?? "" },
    { name: "seoDescription", label: "SEO description", multiline: true, hint: "Up to 160 characters", value: localization?.seoDescription ?? "" },
  ];

  return (
    <form action={formAction} className="space-y-5">
      {fields.map((field) => {
        const id = `${field.name}-${locale}`;
        return (
          <div className="space-y-2" key={field.name}>
            <Label htmlFor={id}>{`${field.label} (${locale})`}</Label>
            {field.multiline ? (
              <Textarea defaultValue={field.value} id={id} name={field.name} rows={field.name === "description" ? 8 : 4} />
            ) : (
              <Input defaultValue={field.value} id={id} name={field.name} required={field.name === "title" || field.name === "slug"} />
            )}
            {field.hint ? <p className="text-[0.8125rem] text-sage-text">{field.hint}</p> : null}
            <FieldError message={state.fieldErrors[field.name] ?? state.fieldErrors[`${field.name}.0.title`]} />
          </div>
        );
      })}
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">{`Save ${locale} copy`}</SubmitButton>
    </form>
  );
}
```

Create `components/admin/book-editor/edition-offer-forms.tsx`:

```tsx
"use client";

import { useActionState } from "react";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";
import type { AdminBookDTO } from "@/lib/data/books";

type FormAction = (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;

export function EditionForm({ action, edition }: { action: FormAction; edition: NonNullable<AdminBookDTO["edition"]> }) {
  const [state, formAction] = useActionState(action, initialAdminFormState);

  return (
    <form action={formAction} className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="edition-languageCode">Edition language</Label>
          <NativeSelect defaultValue={edition.languageCode} id="edition-languageCode" name="languageCode">
            <option value="vi">Vietnamese (vi)</option>
            <option value="en">English (en)</option>
          </NativeSelect>
          <FieldError message={state.fieldErrors.languageCode} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="edition-isbn">ISBN</Label>
          <Input defaultValue={edition.isbn ?? ""} id="edition-isbn" name="isbn" />
          <FieldError message={state.fieldErrors.isbn} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="edition-editionNumber">Edition number</Label>
          <Input defaultValue={edition.editionNumber} id="edition-editionNumber" min={1} name="editionNumber" type="number" />
          <FieldError message={state.fieldErrors.editionNumber} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="edition-publicationDate">Publication date</Label>
          <Input defaultValue={edition.publicationDate ?? ""} id="edition-publicationDate" name="publicationDate" type="date" />
          <FieldError message={state.fieldErrors.publicationDate} />
        </div>
      </div>
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">Save edition</SubmitButton>
    </form>
  );
}

export function OfferForm({ action, offer }: { action: FormAction; offer: NonNullable<AdminBookDTO["offer"]> }) {
  const [state, formAction] = useActionState(action, initialAdminFormState);

  return (
    <form action={formAction} className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="offer-marketCode">Market</Label>
          <Input defaultValue={offer.marketCode} id="offer-marketCode" maxLength={2} name="marketCode" />
          <FieldError message={state.fieldErrors.marketCode} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="offer-currency">Currency</Label>
          <Input defaultValue={offer.currency} id="offer-currency" maxLength={3} name="currency" />
          <FieldError message={state.fieldErrors.currency} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="offer-priceMinor">Price (minor units)</Label>
          <Input defaultValue={offer.priceMinor} id="offer-priceMinor" min={0} name="priceMinor" type="number" />
          <FieldError message={state.fieldErrors.priceMinor} />
        </div>
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm" htmlFor="offer-active">
        <input className="size-4 accent-forest" defaultChecked={offer.active} id="offer-active" name="active" type="checkbox" />
        Offer is active
      </label>
      <p className="text-[0.8125rem] text-sage-text">A price of 0 makes the ebook free. Paid prices show as coming soon until payments launch.</p>
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">Save offer</SubmitButton>
    </form>
  );
}
```

Create `components/admin/book-editor/relations-form.tsx`:

```tsx
"use client";

import { useActionState } from "react";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";

export function RelationsForm({
  action,
  topics,
  series,
  defaults,
}: {
  action: (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;
  topics: { id: string; name: string }[];
  series: { id: string; name: string }[];
  defaults: { topicIds: string[]; seriesId: string | null; seriesPosition: number | null };
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);

  return (
    <form action={formAction} className="space-y-6">
      <fieldset className="space-y-2">
        <legend className="mb-2 text-[0.8125rem] font-medium">Topics</legend>
        {topics.length === 0 ? <p className="text-sm text-sage-text">No topics yet. Create them under Topics.</p> : null}
        <div className="grid gap-x-6 sm:grid-cols-2">
          {topics.map((topic) => (
            <label className="flex min-h-11 items-center gap-3 text-sm" key={topic.id}>
              <input className="size-4 accent-forest" defaultChecked={defaults.topicIds.includes(topic.id)} name="topicIds" type="checkbox" value={topic.id} />
              {topic.name}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-5 sm:grid-cols-[1fr_10rem]">
        <div className="space-y-2">
          <Label htmlFor="relations-seriesId">Series</Label>
          <NativeSelect defaultValue={defaults.seriesId ?? ""} id="relations-seriesId" name="seriesId">
            <option value="">Not in a series</option>
            {series.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-2">
          <Label htmlFor="relations-seriesPosition">Series position</Label>
          <Input defaultValue={defaults.seriesPosition ?? ""} id="relations-seriesPosition" min={1} name="seriesPosition" type="number" />
          <FieldError message={state.fieldErrors.seriesPosition} />
        </div>
      </div>
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">Save relations</SubmitButton>
    </form>
  );
}
```

- [ ] **Step 7: Replace the book page**

Replace `app/admin/books/[bookId]/page.tsx`:

```tsx
import {
  saveBookLocalizationAction,
  setBookRelationsAction,
  updateBookDetailsAction,
  updateEditionAction,
  updateOfferAction,
} from "@/app/admin/books/[bookId]/editor-actions";
import { AdminPageHeader, AdminSection } from "@/components/admin/admin-page-header";
import { DetailsForm } from "@/components/admin/book-editor/details-form";
import { EditionForm, OfferForm } from "@/components/admin/book-editor/edition-offer-forms";
import { LocalizationForm } from "@/components/admin/book-editor/localization-form";
import { RelationsForm } from "@/components/admin/book-editor/relations-form";
import { SectionNav, type EditorSectionLink } from "@/components/admin/book-editor/section-nav";
import { EpubUploadForm } from "@/components/admin/epub-upload-form";
import { ReadinessBadge } from "@/components/admin/readiness-badge";
import { requireAdmin } from "@/lib/auth/admin";
import { getAdminBook } from "@/lib/data/books";
import { listCatalogEntityOptions } from "@/lib/data/catalog-entities";

const sections: EditorSectionLink[] = [
  { id: "details", label: "Details" },
  { id: "localizations", label: "Localizations" },
  { id: "offer", label: "Edition & offer" },
  { id: "relations", label: "Relations" },
  { id: "epub", label: "EPUB" },
];

export default async function AdminBookPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;
  await requireAdmin({ next: `/admin/books/${bookId}` });

  const [book, authors, topics, series] = await Promise.all([
    getAdminBook(bookId),
    listCatalogEntityOptions("author"),
    listCatalogEntityOptions("topic"),
    listCatalogEntityOptions("series"),
  ]);

  return (
    <div className="max-w-[48rem]">
      <AdminPageHeader eyebrow="Book" title={book.localization?.title ?? book.canonicalKey}>
        <p>
          {book.authorName} &middot; {book.canonicalKey} &middot; {book.status}
        </p>
        {book.offer ? (
          <p>
            Price: {book.offer.priceMinor} {book.offer.currency} ({book.offer.marketCode})
          </p>
        ) : null}
        <div className="mt-3">
          <ReadinessBadge issues={book.readinessIssues} />
        </div>
      </AdminPageHeader>

      <SectionNav sections={sections} />

      <div className="space-y-12">
        <AdminSection id="details" title="Details">
          <DetailsForm
            action={updateBookDetailsAction.bind(null, book.id)}
            authors={authors}
            defaults={{ canonicalKey: book.canonicalKey, originalLanguage: book.originalLanguage, primaryAuthorId: book.primaryAuthorId }}
          />
        </AdminSection>

        <AdminSection id="localizations" title="Localizations">
          <div className="space-y-12">
            {(["vi", "en"] as const).map((locale) => (
              <div key={locale}>
                <h3 className="mb-4 text-[0.6875rem] font-medium tracking-[0.08em] text-sage-text uppercase">
                  {locale === "vi" ? "Vietnamese" : "English"}
                </h3>
                <LocalizationForm
                  action={saveBookLocalizationAction.bind(null, book.id, locale)}
                  locale={locale}
                  localization={book.localizations.find((localization) => localization.locale === locale) ?? null}
                />
              </div>
            ))}
          </div>
        </AdminSection>

        <AdminSection id="offer" title="Edition & offer">
          <div className="space-y-10">
            {book.edition ? <EditionForm action={updateEditionAction.bind(null, book.id, book.edition.id)} edition={book.edition} /> : null}
            {book.offer ? (
              <OfferForm action={updateOfferAction.bind(null, book.id, book.offer.id)} offer={book.offer} />
            ) : (
              <p className="text-sm text-sage-text">No offer recorded.</p>
            )}
          </div>
        </AdminSection>

        <AdminSection id="relations" title="Relations">
          <RelationsForm
            action={setBookRelationsAction.bind(null, book.id)}
            defaults={{ topicIds: book.topicIds, seriesId: book.series?.seriesId ?? null, seriesPosition: book.series?.position ?? null }}
            series={series}
            topics={topics}
          />
        </AdminSection>

        <AdminSection id="epub" title="EPUB">
          <p className="mb-4 text-sm text-sage-text">
            {book.activePublicationId ? "An EPUB version is published for this book." : "No EPUB version is published yet."}
          </p>
          {book.edition ? (
            <EpubUploadForm bookId={book.id} />
          ) : (
            <p className="text-sm text-sage-text">This book has no edition yet, so it cannot accept an EPUB upload.</p>
          )}
        </AdminSection>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Keep `e2e/admin-create-book.spec.ts` unambiguous**

The author name now also appears as an `<option>` in the "Primary author" select, so a bare `getByText("E2E Author")` can match twice under Playwright strict mode. In the first test, replace:

```ts
  await expect(page.getByText("E2E Author")).toBeVisible();
```

with:

```ts
  await expect(page.getByText(new RegExp(`^E2E Author ${unique} ·`))).toBeVisible();
```

- [ ] **Step 9: Check manually**

With `npm run dev` on a local stack, open a book and save each section once.
Expected: each form shows "Saved."; reloading shows the saved values; key ideas and FAQ round-trip in the textareas; saving a Vietnamese slug already used by another book shows the slug error; `audit_logs` has a row per save.

- [ ] **Step 10: Check and commit**

```bash
npm run check
git add lib/catalog/revalidate.ts "app/admin/books/[bookId]" components/admin/book-editor components/admin/admin-page-header.tsx e2e/admin-create-book.spec.ts
git commit -m "feat: add the book editor sections"
```

### Task 9: Cover upload

**Files:**
- Create: `lib/data/covers.ts`
- Create: `lib/data/covers.test.ts`
- Create: `app/admin/books/[bookId]/cover-actions.ts`
- Create: `components/admin/book-editor/cover-upload-form.tsx`
- Modify: `app/admin/books/[bookId]/page.tsx` (add the Cover section and nav entry)

**Interfaces:**
- Consumes: Task 1 `covers` bucket; Task 2 `admin_set_book_cover`; Task 4 `coverUploadSchema`, `coverAltTextSchema`; Task 5 `coverPublicUrl`, `COVERS_BUCKET`, `AdminBookDTO.cover`; Task 8 `revalidateBookAdmin`.
- Produces:

```ts
// lib/data/covers.ts
export class CoverBookNotFoundError extends Error {}
export function coverExtensionFor(mimeType: CoverUploadInput["mimeType"]): "jpg" | "png" | "webp";
export async function createCoverUpload(bookId: string, input: CoverUploadInput): Promise<{ storageKey: string; path: string; token: string }>;
export async function finalizeCoverUpload(bookId: string, input: { storageKey: string; altText: string; width: number | null; height: number | null }): Promise<void>;

// app/admin/books/[bookId]/cover-actions.ts ("use server")
export type CoverActionResult<T> = ({ ok: true } & T) | { ok: false; error: string };
export async function createCoverUploadAction(bookId: string, input: { fileName: string; mimeType: string; sizeBytes: number }): Promise<CoverActionResult<{ storageKey: string; path: string; token: string }>>;
export async function finalizeCoverUploadAction(bookId: string, input: { storageKey: string; altText: string; width: number | null; height: number | null }): Promise<CoverActionResult<object>>;
```

- UI labels: "Cover image", "Cover alt text"; button "Upload cover"; success status (`data-testid="cover-status"`): "Cover saved."

- [ ] **Step 1: Write the failing test**

Create `lib/data/covers.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import { CoverBookNotFoundError, coverExtensionFor, createCoverUpload, finalizeCoverUpload } from "@/lib/data/covers";
import { fakeSupabaseClient } from "@/lib/data/supabase-test-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

type SessionClient = Awaited<ReturnType<typeof createClient>>;
const bookId = "3a1b2c3d-0000-4000-8000-000000000001";
const input = { fileName: "cover.webp", mimeType: "image/webp" as const, sizeBytes: 2048 };

function storageClient() {
  const createSignedUploadUrl = vi.fn((path: string) => Promise.resolve({ data: { path, token: "signed-token", signedUrl: "https://x" }, error: null }));
  const from = vi.fn(() => ({ createSignedUploadUrl }));
  return { client: { storage: { from } } as unknown as ReturnType<typeof createAdminClient>, from, createSignedUploadUrl };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("covers", () => {
  it("maps MIME types to file extensions", () => {
    expect(coverExtensionFor("image/jpeg")).toBe("jpg");
    expect(coverExtensionFor("image/png")).toBe("png");
    expect(coverExtensionFor("image/webp")).toBe("webp");
  });

  it("never creates a service-role client when the admin gate denies", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
    await expect(createCoverUpload(bookId, input)).rejects.toThrow("NEXT_FORBIDDEN");
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("refuses a book the admin cannot see", async () => {
    const fake = fakeSupabaseClient({ tables: { books: { data: null, error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(createCoverUpload(bookId, input)).rejects.toBeInstanceOf(CoverBookNotFoundError);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("mints a signed upload under books/{bookId}/ in the covers bucket", async () => {
    const fake = fakeSupabaseClient({ tables: { books: { data: { id: bookId }, error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    const storage = storageClient();
    vi.mocked(createAdminClient).mockReturnValue(storage.client);

    const upload = await createCoverUpload(bookId, input);

    expect(storage.from).toHaveBeenCalledWith("covers");
    expect(upload.storageKey).toMatch(new RegExp(`^books/${bookId}/[0-9a-f-]{36}\\.webp$`));
    expect(upload.token).toBe("signed-token");
  });

  it("records the cover through admin_set_book_cover", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: "media-id", error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await finalizeCoverUpload(bookId, { storageKey: `books/${bookId}/k.webp`, altText: "Bìa sách", width: 600, height: 900 });

    expect(fake.rpc).toHaveBeenCalledWith("admin_set_book_cover", {
      p_book_id: bookId,
      p_storage_key: `books/${bookId}/k.webp`,
      p_alt_text: "Bìa sách",
      p_width: 600,
      p_height: 900,
    });
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm test -- lib/data/covers.test.ts`
Expected: FAIL because `@/lib/data/covers` does not exist.

- [ ] **Step 3: Implement `lib/data/covers.ts`**

```ts
import "server-only";

import { requireAdmin } from "@/lib/auth/admin";
import { COVERS_BUCKET } from "@/lib/catalog/covers";
import type { CoverUploadInput } from "@/lib/catalog/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export class CoverBookNotFoundError extends Error {
  constructor() {
    super("This book no longer exists.");
    this.name = "CoverBookNotFoundError";
  }
}

const extensions: Record<CoverUploadInput["mimeType"], "jpg" | "png" | "webp"> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function coverExtensionFor(mimeType: CoverUploadInput["mimeType"]) {
  return extensions[mimeType];
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same shape as lib/epub/upload.ts: the storage key is minted here, never taken from the client,
// and the service-role client is created only after requireAdmin() and a visible-book check, and
// only to sign the upload (browser roles have no write policy on storage.objects).
export async function createCoverUpload(
  bookId: string,
  input: CoverUploadInput,
): Promise<{ storageKey: string; path: string; token: string }> {
  await requireAdmin();
  if (!uuidPattern.test(bookId)) throw new CoverBookNotFoundError();

  const supabase = await createClient();
  const { data: book, error } = await supabase.from("books").select("id").eq("id", bookId).maybeSingle();
  if (error) throw new Error(`createCoverUpload: failed to load book: ${error.message}`);
  if (!book) throw new CoverBookNotFoundError();

  const storageKey = `books/${bookId}/${crypto.randomUUID()}.${coverExtensionFor(input.mimeType)}`;
  const admin = createAdminClient();
  const { data: signed, error: signedError } = await admin.storage.from(COVERS_BUCKET).createSignedUploadUrl(storageKey);
  if (signedError || !signed) {
    throw new Error(`createCoverUpload: failed to sign upload: ${signedError?.message ?? "no data"}`);
  }

  return { storageKey, path: signed.path, token: signed.token };
}

// Records (or replaces) the book's cover row. admin_set_book_cover re-checks that the key sits
// under this book, so a tampered key cannot attach another object.
export async function finalizeCoverUpload(
  bookId: string,
  input: { storageKey: string; altText: string; width: number | null; height: number | null },
): Promise<void> {
  await requireAdmin();
  if (!uuidPattern.test(bookId)) throw new CoverBookNotFoundError();

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_book_cover", {
    p_book_id: bookId,
    p_storage_key: input.storageKey,
    p_alt_text: input.altText,
    p_width: input.width,
    p_height: input.height,
  });
  if (error) throw new Error(`finalizeCoverUpload failed: ${error.message}`);
}
```

- [ ] **Step 4: Run it and verify it passes**

Run: `npm test -- lib/data/covers.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the cover actions**

Create `app/admin/books/[bookId]/cover-actions.ts`:

```ts
"use server";

import { requireAdmin } from "@/lib/auth/admin";
import { revalidateBookAdmin } from "@/lib/catalog/revalidate";
import { coverAltTextSchema, coverUploadSchema } from "@/lib/catalog/schemas";
import { CoverBookNotFoundError, createCoverUpload, finalizeCoverUpload } from "@/lib/data/covers";

export type CoverActionResult<T> = ({ ok: true } & T) | { ok: false; error: string };

const generic = "Something went wrong saving the cover. Try again.";

export async function createCoverUploadAction(
  bookId: string,
  input: { fileName: string; mimeType: string; sizeBytes: number },
): Promise<CoverActionResult<{ storageKey: string; path: string; token: string }>> {
  await requireAdmin({ next: `/admin/books/${bookId}` });

  const parsed = coverUploadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Choose a cover image." };

  try {
    return { ok: true, ...(await createCoverUpload(bookId, parsed.data)) };
  } catch (error) {
    return { ok: false, error: error instanceof CoverBookNotFoundError ? error.message : generic };
  }
}

export async function finalizeCoverUploadAction(
  bookId: string,
  input: { storageKey: string; altText: string; width: number | null; height: number | null },
): Promise<CoverActionResult<object>> {
  await requireAdmin({ next: `/admin/books/${bookId}` });

  const altText = coverAltTextSchema.safeParse(input.altText);
  if (!altText.success) return { ok: false, error: altText.error.issues[0]?.message ?? "Describe the cover." };

  try {
    await finalizeCoverUpload(bookId, { ...input, altText: altText.data });
  } catch (error) {
    return { ok: false, error: error instanceof CoverBookNotFoundError ? error.message : generic };
  }

  revalidateBookAdmin(bookId);
  return { ok: true };
}
```

- [ ] **Step 6: Add the upload form**

Create `components/admin/book-editor/cover-upload-form.tsx`:

```tsx
"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { type ChangeEvent, useState } from "react";

import { createCoverUploadAction, finalizeCoverUploadAction } from "@/app/admin/books/[bookId]/cover-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { COVERS_BUCKET } from "@/lib/catalog/covers";
import { COVER_MIME_TYPES, MAX_COVER_SIZE_BYTES } from "@/lib/catalog/schemas";
import { createClient } from "@/lib/supabase/client";

async function imageSize(file: File): Promise<{ width: number | null; height: number | null }> {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { width: null, height: null };
  }
}

// Client checks are a convenience; createCoverUploadAction and admin_set_book_cover enforce them.
function validate(file: File): string | null {
  if (!(COVER_MIME_TYPES as readonly string[]).includes(file.type)) return "Upload a JPEG, PNG, or WebP image.";
  if (file.size === 0) return "The selected file is empty.";
  if (file.size > MAX_COVER_SIZE_BYTES) return "Cover images must be 5 MB or smaller.";
  return null;
}

export function CoverUploadForm({
  bookId,
  cover,
}: {
  bookId: string;
  cover: { publicUrl: string; altText: string } | null;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [altText, setAltText] = useState(cover?.altText ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "saved"; text: string } | null>(null);

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    setFile(selected);
    setMessage(selected ? (validate(selected) ? { kind: "error", text: validate(selected) as string } : null) : null);
  }

  async function upload() {
    if (!file || validate(file)) return;
    setBusy(true);
    setMessage(null);

    const reservation = await createCoverUploadAction(bookId, { fileName: file.name, mimeType: file.type, sizeBytes: file.size });
    if (!reservation.ok) {
      setBusy(false);
      setMessage({ kind: "error", text: reservation.error });
      return;
    }

    const supabase = createClient();
    const [{ error: uploadError }, size] = await Promise.all([
      supabase.storage.from(COVERS_BUCKET).uploadToSignedUrl(reservation.path, reservation.token, file),
      imageSize(file),
    ]);
    if (uploadError) {
      setBusy(false);
      setMessage({ kind: "error", text: "Upload to storage failed. You can retry." });
      return;
    }

    const finalized = await finalizeCoverUploadAction(bookId, { storageKey: reservation.storageKey, altText, ...size });
    setBusy(false);
    if (!finalized.ok) {
      setMessage({ kind: "error", text: finalized.error });
      return;
    }
    setMessage({ kind: "saved", text: "Cover saved." });
    router.refresh();
  }

  return (
    <div className="grid gap-6 sm:grid-cols-[8rem_1fr]">
      <div className="aspect-[2/3] w-32 overflow-hidden bg-surface">
        {cover ? (
          <Image alt={cover.altText} className="h-full w-full object-cover" height={192} src={cover.publicUrl} unoptimized width={128} />
        ) : (
          <p className="p-3 text-[0.75rem] text-sage-text">No cover yet</p>
        )}
      </div>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="cover-file">Cover image</Label>
          <Input accept={COVER_MIME_TYPES.join(",")} disabled={busy} id="cover-file" onChange={onFileChange} type="file" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="cover-alt">Cover alt text</Label>
          <Input disabled={busy} id="cover-alt" onChange={(event) => setAltText(event.target.value)} value={altText} />
        </div>
        <Button disabled={!file || busy || altText.trim() === "" || Boolean(file && validate(file))} onClick={() => void upload()} type="button">
          {busy ? "Uploading…" : "Upload cover"}
        </Button>
        {message ? (
          <p
            className={message.kind === "error" ? "text-[0.8125rem] text-error" : "text-[0.8125rem] text-success"}
            data-testid="cover-status"
            role={message.kind === "error" ? "alert" : "status"}
          >
            {message.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Add the Cover section to the editor**

In `app/admin/books/[bookId]/page.tsx`:

1. Import the form: `import { CoverUploadForm } from "@/components/admin/book-editor/cover-upload-form";`
2. Insert `{ id: "cover", label: "Cover" },` into `sections` after the `offer` entry.
3. Insert this section between the "Edition & offer" and "Relations" sections:

```tsx
        <AdminSection id="cover" title="Cover">
          <CoverUploadForm bookId={book.id} cover={book.cover ? { publicUrl: book.cover.publicUrl, altText: book.cover.altText } : null} />
        </AdminSection>
```

- [ ] **Step 8: Check manually**

With `npm run dev` on a local stack, upload a PNG cover with alt text, then replace it with a WebP.
Expected: "Cover saved." each time; the preview shows the new image after refresh; `media_assets` holds one cover row for the book; the readiness badge no longer lists the cover.

- [ ] **Step 9: Check and commit**

```bash
npm run check
git add lib/data/covers.ts lib/data/covers.test.ts "app/admin/books/[bookId]/cover-actions.ts" "app/admin/books/[bookId]/page.tsx" components/admin/book-editor/cover-upload-form.tsx
git commit -m "feat: add book cover upload"
```

### Task 10: Publish panel and golden-path update

**Files:**
- Create: `app/admin/books/[bookId]/publish-actions.ts`
- Create: `app/admin/books/[bookId]/publish-actions.test.ts`
- Create: `components/admin/book-editor/publish-panel.tsx`
- Modify: `app/admin/books/[bookId]/page.tsx` (add the Publish section and nav entry)
- Modify: `e2e/ebook-golden-path.spec.ts` (complete the book and publish it before the anonymous checks)
- Modify: `e2e/admin-publication-transitions.spec.ts` (book stays draft after a version publish)
- Modify: `docs/runbooks/golden-path-validation.md` (Step 4)

**Interfaces:**
- Consumes: Task 3 readiness codes, messages, and sections; Task 5 `publishBook`, `unpublishBook`, `BookNotReadyError`; Task 8 `revalidateBookAdmin`.
- Produces:

```ts
// app/admin/books/[bookId]/publish-actions.ts ("use server")
export type PublishActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string; issues: ReadinessIssueCode[] };
export async function publishBookAction(bookId: string): Promise<PublishActionResult>;
export async function unpublishBookAction(bookId: string): Promise<PublishActionResult>;

// components/admin/book-editor/publish-panel.tsx
export function PublishPanel(props: { bookId: string; status: "draft" | "published" | "archived"; issues: ReadinessIssueCode[] }): JSX.Element;
```

- Buttons "Publish book" and "Unpublish book"; both ask `window.confirm` first. Result message has `data-testid="book-publish-message"`: "Book published." or "Book unpublished."

- [ ] **Step 1: Write the failing action test**

Create `app/admin/books/[bookId]/publish-actions.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { publishBookAction } from "@/app/admin/books/[bookId]/publish-actions";
import { requireAdmin } from "@/lib/auth/admin";
import { BookNotReadyError, publishBook } from "@/lib/data/books";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data/books", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/data/books")>();
  return { ...original, publishBook: vi.fn(), unpublishBook: vi.fn() };
});

const bookId = "3a1b2c3d-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("publishBookAction", () => {
  it("reports success", async () => {
    vi.mocked(publishBook).mockResolvedValue();
    await expect(publishBookAction(bookId)).resolves.toEqual({ ok: true, message: "Book published." });
  });

  it("returns the readiness issues when the database refuses", async () => {
    vi.mocked(publishBook).mockRejectedValue(new BookNotReadyError(["missing_cover"]));
    await expect(publishBookAction(bookId)).resolves.toEqual({
      ok: false,
      error: "This book is not ready to publish.",
      issues: ["missing_cover"],
    });
  });

  it("hides unexpected errors", async () => {
    vi.mocked(publishBook).mockRejectedValue(new Error("publish_book failed: connection reset"));
    const result = await publishBookAction(bookId);
    expect(result).toEqual({ ok: false, error: "Something went wrong. Try again.", issues: [] });
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm test -- "app/admin/books/[bookId]/publish-actions.test.ts"`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the actions**

Create `app/admin/books/[bookId]/publish-actions.ts`:

```ts
"use server";

import { requireAdmin } from "@/lib/auth/admin";
import type { ReadinessIssueCode } from "@/lib/catalog/readiness";
import { revalidateBookAdmin } from "@/lib/catalog/revalidate";
import { BookNotReadyError, publishBook, unpublishBook } from "@/lib/data/books";

export type PublishActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string; issues: ReadinessIssueCode[] };

const generic = "Something went wrong. Try again.";

export async function publishBookAction(bookId: string): Promise<PublishActionResult> {
  await requireAdmin({ next: `/admin/books/${bookId}` });
  try {
    await publishBook(bookId);
  } catch (error) {
    if (error instanceof BookNotReadyError) return { ok: false, error: error.message, issues: error.issues };
    return { ok: false, error: generic, issues: [] };
  }
  revalidateBookAdmin(bookId);
  return { ok: true, message: "Book published." };
}

export async function unpublishBookAction(bookId: string): Promise<PublishActionResult> {
  await requireAdmin({ next: `/admin/books/${bookId}` });
  try {
    await unpublishBook(bookId);
  } catch {
    return { ok: false, error: generic, issues: [] };
  }
  revalidateBookAdmin(bookId);
  return { ok: true, message: "Book unpublished." };
}
```

- [ ] **Step 4: Run it and verify it passes**

Run: `npm test -- "app/admin/books/[bookId]/publish-actions.test.ts"`
Expected: PASS.

- [ ] **Step 5: Build the panel**

Create `components/admin/book-editor/publish-panel.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { publishBookAction, unpublishBookAction } from "@/app/admin/books/[bookId]/publish-actions";
import { Button } from "@/components/ui/button";
import {
  readinessIssueMessage,
  readinessIssueSection,
  type ReadinessIssueCode,
} from "@/lib/catalog/readiness";

export function PublishPanel({
  bookId,
  status,
  issues,
}: {
  bookId: string;
  status: "draft" | "published" | "archived";
  issues: ReadinessIssueCode[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<ReadinessIssueCode[] | null>(null);
  const shownIssues = serverIssues ?? issues;

  function run(kind: "publish" | "unpublish") {
    const question =
      kind === "publish"
        ? "Publish this book? It becomes visible on the storefront."
        : "Unpublish this book? It disappears from the storefront and readers can no longer open it.";
    if (!window.confirm(question)) return;

    setMessage(null);
    startTransition(async () => {
      const result = kind === "publish" ? await publishBookAction(bookId) : await unpublishBookAction(bookId);
      if (result.ok) {
        setServerIssues(null);
        setMessage(result.message);
        router.refresh();
      } else {
        setServerIssues(result.issues.length > 0 ? result.issues : null);
        setMessage(result.error);
      }
    });
  }

  return (
    <div className="space-y-5">
      <p className="text-sm">
        Status: <span className="font-medium">{status}</span>
      </p>
      {shownIssues.length > 0 ? (
        <div>
          <p className="mb-2 text-sm">Before publishing:</p>
          <ul className="space-y-1 border-l border-sand pl-4 text-sm">
            {shownIssues.map((issue) => (
              <li key={issue}>
                <a className="text-forest underline decoration-sand underline-offset-4" href={`#${readinessIssueSection[issue]}`}>
                  {readinessIssueMessage[issue]}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-success">Everything required for publishing is in place.</p>
      )}
      <div className="flex flex-wrap gap-3">
        {status === "published" ? (
          <Button disabled={isPending} onClick={() => run("unpublish")} type="button" variant="outline">
            Unpublish book
          </Button>
        ) : (
          <Button disabled={isPending || issues.length > 0} onClick={() => run("publish")} type="button">
            Publish book
          </Button>
        )}
      </div>
      {message ? (
        <p className="border-l-2 border-forest bg-surface px-4 py-3 text-sm" data-testid="book-publish-message" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 6: Add the Publish section to the editor**

In `app/admin/books/[bookId]/page.tsx`:

1. Import: `import { PublishPanel } from "@/components/admin/book-editor/publish-panel";`
2. Append `{ id: "publish", label: "Publish" },` to `sections`.
3. Add after the EPUB section:

```tsx
        <AdminSection id="publish" title="Publish">
          <PublishPanel bookId={book.id} issues={book.readinessIssues} status={book.status} />
        </AdminSection>
```

- [ ] **Step 7: Update the golden-path E2E**

In `e2e/ebook-golden-path.spec.ts`, add near the other module-level constants:

```ts
// A 1x1 PNG, enough for the cover upload to satisfy the publish readiness check.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);
```

Insert this block immediately after the `publicationId` lookup and before the `// ---- Ruling CB: anonymous public visibility` comment:

```ts
  // ---- complete the catalog record -> publish the book -----------------------------------------
  // Since migration 20260913120000, publishing an EPUB version moves the active pointer only. The
  // book becomes public through "Publish book", which requires a description and a cover.
  const anonBeforePublish = createAnonClient();
  const { data: stillHidden } = await anonBeforePublish.from("books").select("id").eq("id", bookId).maybeSingle();
  expect(stillHidden, "publishing a version alone does not make the book public").toBeNull();

  await page.goto(`/admin/books/${bookId}`);
  await page.getByLabel("Description (vi)").fill("A lighthouse keeper's story, generated for the golden path.");
  await page.getByRole("button", { name: "Save vi copy" }).click();
  await expect(page.locator("#localizations").getByTestId("form-saved")).toBeVisible();

  await page.getByLabel("Cover image").setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: ONE_PIXEL_PNG });
  await page.getByLabel("Cover alt text").fill(`Cover of ${bookTitle}`);
  await page.getByRole("button", { name: "Upload cover" }).click();
  await expect(page.getByTestId("cover-status")).toHaveText("Cover saved.");

  await page.reload();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Publish book" }).click();
  await expect(page.getByTestId("book-publish-message")).toHaveText("Book published.");
```

In the comment block under `// ---- Ruling CB: anonymous public visibility`, replace the sentence that says the existing publish spec asserts `books.status` with: "Book visibility now comes from `publish_book` (migration 20260913120000); this read proves that the explicit publish made the book and its author visible to anonymous visitors."

Also update `e2e/admin-publication-transitions.spec.ts`. At the end of "an admin previews a ready-for-preview version and publishes it", replace the Ruling BL comment and assertion:

```ts
  // Since migration 20260913120000, publishing a version moves the active pointer only; the book
  // stays draft until an admin publishes the book itself (covered by e2e/admin-catalog.spec.ts).
  expect(bookRow.status).toBe("draft");
```

- [ ] **Step 8: Update the runbook**

In `docs/runbooks/golden-path-validation.md`, replace the paragraph after item 4 of "Step 4 — preview and publish" ("Publishing also flips `books.status`…") with:

```markdown
Publishing a version makes it the book's active EPUB but does **not** make the book public. On
`/admin/books/<book-id>`:

5. Fill the Vietnamese (or English) description and save that copy.
6. Upload a cover image with alt text.
7. In **Publish**, confirm the checklist is empty, then **Publish book** and confirm the dialog.

`publish_book` refuses a book with no complete localization, author, cover, active offer, or
published EPUB version, and it publishes the primary author with the book. Unpublishing hides the
book again and blocks new reader sessions for it — see Step 6.
```

- [ ] **Step 9: Check manually**

With `npm run dev` on a local stack: open a draft book with no cover.
Expected: "Publish book" is disabled and the checklist links to the Cover section. After completing every item, publishing shows "Book published." and the status reads `published`; "Unpublish book" returns it to `draft`.

- [ ] **Step 10: Check and commit**

```bash
npm run check
git add "app/admin/books/[bookId]/publish-actions.ts" "app/admin/books/[bookId]/publish-actions.test.ts" "app/admin/books/[bookId]/page.tsx" components/admin/book-editor/publish-panel.tsx e2e/ebook-golden-path.spec.ts e2e/admin-publication-transitions.spec.ts docs/runbooks/golden-path-validation.md
git commit -m "feat: publish books from the editor with a readiness checklist"
```

### Task 11: User lookup and complimentary access

**Files:**
- Create: `lib/data/users.ts`
- Create: `lib/data/users.test.ts`
- Create: `app/admin/users/page.tsx`
- Create: `app/admin/users/[profileId]/page.tsx`
- Create: `components/admin/user-entitlements.tsx`
- Modify: `app/admin/users/[profileId]/entitlements/actions.ts` (revalidate and redirect to the new page)
- Modify: `app/admin/users/[profileId]/entitlements/actions.test.ts` (expected path)

**Interfaces:**
- Consumes: Task 1 admin read policies on `profiles`, `entitlements`, `customer_identities`, `user_roles`; existing `grantComplimentaryEntitlementAction(profileId, bookId, reason)` and `revokeComplimentaryEntitlementAction(profileId, entitlementId, reason)` returning `EntitlementActionResult`; Task 5 `listAdminBooks`.
- Produces:

```ts
// lib/data/users.ts
export type AdminUserSearchResultDTO = { profileId: string; email: string; displayName: string | null; verified: boolean };
export type AdminUserEntitlementDTO = {
  id: string; bookId: string; bookTitle: string;
  sourceType: "free_order" | "admin_grant" | "simulated_payment";
  status: "active" | "revoked"; reason: string | null; grantedAt: string; revokedAt: string | null;
};
export type AdminUserDTO = {
  profileId: string; email: string | null; displayName: string | null; verified: boolean; isAdmin: boolean;
  entitlements: AdminUserEntitlementDTO[];
};
export function normalizeEmailQuery(query: string): string; // trimmed, lowercased, % and _ escaped
export async function searchUsers(query: string): Promise<AdminUserSearchResultDTO[]>; // [] for queries under 3 characters
export async function getAdminUser(profileId: string): Promise<AdminUserDTO>;         // notFound()
```

- UI: `/admin/users?q=` search (label "Email"), `/admin/users/{profileId}` detail. Grant form labels "Book", "Reason"; button "Grant access". Each revocable row (active `admin_grant`) has a "Revoke" button that asks for a reason with `window.prompt`. Result message `data-testid="entitlement-message"`.

- [ ] **Step 1: Write the failing test**

Create `lib/data/users.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import { fakeSupabaseClient } from "@/lib/data/supabase-test-client";
import { getAdminUser, normalizeEmailQuery, searchUsers } from "@/lib/data/users";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

type SessionClient = Awaited<ReturnType<typeof createClient>>;
const profileId = "b1b2c3d4-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("users", () => {
  it("escapes LIKE wildcards in the email query", () => {
    expect(normalizeEmailQuery("  An_Nguyen%@Example.test ")).toBe("an\\_nguyen\\%@example.test");
  });

  it("does not query for very short searches", async () => {
    await expect(searchUsers("ab")).resolves.toEqual([]);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("maps identities to search results", async () => {
    const fake = fakeSupabaseClient({
      tables: {
        customer_identities: {
          data: [{ profile_id: profileId, normalized_email: "an@example.test", verified_at: "2026-09-01T00:00:00Z", profile: { display_name: "An" } }],
          error: null,
        },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(searchUsers("an@ex")).resolves.toEqual([
      { profileId, email: "an@example.test", displayName: "An", verified: true },
    ]);
  });

  it("builds the user detail with book titles, vi first", async () => {
    const fake = fakeSupabaseClient({
      tables: {
        profiles: { data: { id: profileId, display_name: null }, error: null },
        customer_identities: { data: { normalized_email: "an@example.test", verified_at: null }, error: null },
        user_roles: { data: null, error: null },
        entitlements: {
          data: [
            {
              id: "e1b2c3d4-0000-4000-8000-000000000001",
              book_id: "3a1b2c3d-0000-4000-8000-000000000001",
              source_type: "admin_grant",
              status: "active",
              reason: "Launch reviewer",
              granted_at: "2026-09-10T00:00:00Z",
              revoked_at: null,
              book: { canonical_key: "quan-sat", localizations: [{ locale: "en", title: "Observe" }, { locale: "vi", title: "Quan sát" }] },
            },
          ],
          error: null,
        },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    const user = await getAdminUser(profileId);

    expect(user).toMatchObject({ profileId, email: "an@example.test", verified: false, isAdmin: false });
    expect(user.entitlements[0]).toMatchObject({ bookTitle: "Quan sát", sourceType: "admin_grant", status: "active" });
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm test -- lib/data/users.test.ts`
Expected: FAIL because `@/lib/data/users` does not exist.

- [ ] **Step 3: Implement `lib/data/users.ts`**

```ts
import "server-only";

import { notFound } from "next/navigation";

import { requireAdmin } from "@/lib/auth/admin";
import { createClient } from "@/lib/supabase/server";

export type AdminUserSearchResultDTO = { profileId: string; email: string; displayName: string | null; verified: boolean };

export type AdminUserEntitlementDTO = {
  id: string;
  bookId: string;
  bookTitle: string;
  sourceType: "free_order" | "admin_grant" | "simulated_payment";
  status: "active" | "revoked";
  reason: string | null;
  grantedAt: string;
  revokedAt: string | null;
};

export type AdminUserDTO = {
  profileId: string;
  email: string | null;
  displayName: string | null;
  verified: boolean;
  isAdmin: boolean;
  entitlements: AdminUserEntitlementDTO[];
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeEmailQuery(query: string): string {
  return query.trim().toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`);
}

type IdentityRow = {
  profile_id: string;
  normalized_email: string;
  verified_at: string | null;
  profile: { display_name: string | null } | null;
};

// Reads go through the session client under the admin read policies from 20260913100000.
export async function searchUsers(query: string): Promise<AdminUserSearchResultDTO[]> {
  await requireAdmin();
  const needle = normalizeEmailQuery(query);
  if (needle.replace(/\\/g, "").length < 3) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("customer_identities")
    .select("profile_id, normalized_email, verified_at, profile:profiles ( display_name )")
    .ilike("normalized_email", `%${needle}%`)
    .order("normalized_email")
    .limit(25);
  if (error) throw new Error(`searchUsers failed: ${error.message}`);

  return ((data ?? []) as unknown as IdentityRow[])
    .filter((row) => row.profile_id !== null)
    .map((row) => ({
      profileId: row.profile_id,
      email: row.normalized_email,
      displayName: row.profile?.display_name ?? null,
      verified: row.verified_at !== null,
    }));
}

type EntitlementRow = {
  id: string;
  book_id: string;
  source_type: AdminUserEntitlementDTO["sourceType"];
  status: AdminUserEntitlementDTO["status"];
  reason: string | null;
  granted_at: string;
  revoked_at: string | null;
  book: { canonical_key: string; localizations: { locale: string; title: string }[] } | null;
};

function bookTitle(book: EntitlementRow["book"]): string {
  if (!book) return "Unknown book";
  const localized = book.localizations.find((row) => row.locale === "vi") ?? book.localizations[0];
  return localized?.title ?? book.canonical_key;
}

export async function getAdminUser(profileId: string): Promise<AdminUserDTO> {
  await requireAdmin();
  if (!uuidPattern.test(profileId)) notFound();

  const supabase = await createClient();
  const [profile, identity, role, entitlements] = await Promise.all([
    supabase.from("profiles").select("id, display_name").eq("id", profileId).maybeSingle(),
    supabase.from("customer_identities").select("normalized_email, verified_at").eq("profile_id", profileId).maybeSingle(),
    supabase.from("user_roles").select("role").eq("profile_id", profileId).maybeSingle(),
    supabase
      .from("entitlements")
      .select("id, book_id, source_type, status, reason, granted_at, revoked_at, book:books ( canonical_key, localizations:book_localizations ( locale, title ) )")
      .eq("profile_id", profileId)
      .order("granted_at", { ascending: false }),
  ]);

  for (const result of [profile, identity, role, entitlements]) {
    if (result.error) throw new Error(`getAdminUser failed: ${result.error.message}`);
  }
  if (!profile.data) notFound();

  const identityRow = identity.data as { normalized_email: string; verified_at: string | null } | null;
  const profileRow = profile.data as { id: string; display_name: string | null };

  return {
    profileId: profileRow.id,
    email: identityRow?.normalized_email ?? null,
    displayName: profileRow.display_name,
    verified: Boolean(identityRow?.verified_at),
    isAdmin: (role.data as { role: string } | null)?.role === "admin",
    entitlements: ((entitlements.data ?? []) as unknown as EntitlementRow[]).map((row) => ({
      id: row.id,
      bookId: row.book_id,
      bookTitle: bookTitle(row.book),
      sourceType: row.source_type,
      status: row.status,
      reason: row.reason,
      grantedAt: row.granted_at,
      revokedAt: row.revoked_at,
    })),
  };
}
```

- [ ] **Step 4: Run it and verify it passes**

Run: `npm test -- lib/data/users.test.ts`
Expected: PASS.

- [ ] **Step 5: Point the entitlement actions at the new page**

In `app/admin/users/[profileId]/entitlements/actions.ts`, change every occurrence of `` `/admin/users/${profileId}/entitlements` `` (both `requireAdmin({ next })` and `revalidatePath`) to `` `/admin/users/${profileId}` ``.

In `app/admin/users/[profileId]/entitlements/actions.test.ts`, change the expectation on line 48:

```ts
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith(`/admin/users/${profileId}`);
```

Run: `npm test -- "app/admin/users"`
Expected: PASS.

- [ ] **Step 6: Build the grant/revoke component**

Create `components/admin/user-entitlements.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  grantComplimentaryEntitlementAction,
  revokeComplimentaryEntitlementAction,
} from "@/app/admin/users/[profileId]/entitlements/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { AdminUserEntitlementDTO } from "@/lib/data/users";

export function UserEntitlements({
  profileId,
  entitlements,
  books,
}: {
  profileId: string;
  entitlements: AdminUserEntitlementDTO[];
  books: { id: string; title: string }[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [bookId, setBookId] = useState(books[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  function grant() {
    setMessage(null);
    startTransition(async () => {
      const result = await grantComplimentaryEntitlementAction(profileId, bookId, reason);
      setMessage(result.ok ? "Access granted." : result.error);
      if (result.ok) {
        setReason("");
        router.refresh();
      }
    });
  }

  function revoke(entitlement: AdminUserEntitlementDTO) {
    const revokeReason = window.prompt(`Why revoke access to "${entitlement.bookTitle}"?`);
    if (revokeReason === null) return;
    setMessage(null);
    startTransition(async () => {
      const result = await revokeComplimentaryEntitlementAction(profileId, entitlement.id, revokeReason);
      setMessage(result.ok ? "Access revoked." : result.error);
      if (result.ok) router.refresh();
    });
  }

  return (
    <div className="space-y-8">
      {entitlements.length === 0 ? (
        <p className="text-sm text-sage-text">No entitlements.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-sand text-[0.6875rem] tracking-[0.08em] text-sage-text uppercase">
              <th className="py-2 font-medium">Book</th>
              <th className="py-2 font-medium">Source</th>
              <th className="py-2 font-medium">Status</th>
              <th className="py-2 font-medium">Reason</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {entitlements.map((entitlement) => (
              <tr className="border-b border-sand" key={entitlement.id}>
                <td className="py-2">{entitlement.bookTitle}</td>
                <td className="py-2">{entitlement.sourceType}</td>
                <td className="py-2">{entitlement.status}</td>
                <td className="py-2">{entitlement.reason ?? "—"}</td>
                <td className="py-2 text-right">
                  {entitlement.status === "active" && entitlement.sourceType === "admin_grant" ? (
                    <Button disabled={isPending} onClick={() => revoke(entitlement)} size="sm" type="button" variant="outline">
                      Revoke
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="space-y-4 border-t border-sand pt-6">
        <h3 className="text-[0.6875rem] font-medium tracking-[0.08em] text-sage-text uppercase">Grant complimentary access</h3>
        <div className="space-y-2">
          <Label htmlFor="grant-book">Book</Label>
          <NativeSelect id="grant-book" onChange={(event) => setBookId(event.target.value)} value={bookId}>
            {books.map((book) => (
              <option key={book.id} value={book.id}>
                {book.title}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-2">
          <Label htmlFor="grant-reason">Reason</Label>
          <Textarea id="grant-reason" onChange={(event) => setReason(event.target.value)} rows={2} value={reason} />
        </div>
        <Button disabled={isPending || bookId === "" || reason.trim() === ""} onClick={grant} type="button">
          Grant access
        </Button>
      </div>

      {message ? (
        <p className="border-l-2 border-forest bg-surface px-4 py-3 text-sm" data-testid="entitlement-message" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 7: Add the pages**

Create `app/admin/users/page.tsx`:

```tsx
import Link from "next/link";

import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requireAdmin } from "@/lib/auth/admin";
import { searchUsers } from "@/lib/data/users";

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireAdmin({ next: "/admin/users" });
  const { q } = await searchParams;
  const users = q ? await searchUsers(q) : [];

  return (
    <div className="max-w-[48rem]">
      <AdminPageHeader eyebrow="Access" title="Users">
        Find a reader by email to review or grant access.
      </AdminPageHeader>
      <form className="mb-8 flex items-end gap-3" method="get">
        <div className="flex-1 space-y-2">
          <Label htmlFor="user-search">Email</Label>
          <Input defaultValue={q ?? ""} id="user-search" name="q" type="search" />
        </div>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      {q && users.length === 0 ? <p className="text-sage-text">No users match this email. Use at least 3 characters.</p> : null}
      <ul className="border-t border-ink">
        {users.map((user) => (
          <li className="border-b border-sand py-3" key={user.profileId}>
            <Link className="font-medium text-forest underline decoration-sand underline-offset-4" href={`/admin/users/${user.profileId}`}>
              {user.email}
            </Link>
            <span className="ml-3 text-sm text-sage-text">
              {user.displayName ?? "No display name"} &middot; {user.verified ? "verified" : "unverified"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

Create `app/admin/users/[profileId]/page.tsx`:

```tsx
import { AdminPageHeader, AdminSection } from "@/components/admin/admin-page-header";
import { UserEntitlements } from "@/components/admin/user-entitlements";
import { requireAdmin } from "@/lib/auth/admin";
import { listAdminBooks } from "@/lib/data/books";
import { getAdminUser } from "@/lib/data/users";

export default async function AdminUserPage({ params }: { params: Promise<{ profileId: string }> }) {
  const { profileId } = await params;
  await requireAdmin({ next: `/admin/users/${profileId}` });

  const [user, books] = await Promise.all([getAdminUser(profileId), listAdminBooks()]);

  return (
    <div className="max-w-[56rem]">
      <AdminPageHeader eyebrow="User" title={user.email ?? user.profileId}>
        <p>
          {user.displayName ?? "No display name"} &middot; {user.verified ? "verified email" : "unverified email"}
          {user.isAdmin ? " · admin" : ""}
        </p>
      </AdminPageHeader>
      <AdminSection title="Entitlements">
        <UserEntitlements
          books={books.map((book) => ({ id: book.id, title: book.title }))}
          entitlements={user.entitlements}
          profileId={user.profileId}
        />
      </AdminSection>
    </div>
  );
}
```

- [ ] **Step 8: Check manually**

With `npm run dev` on a local stack: sign in once as a reader through a magic link (so the identity is verified), then as an admin search part of that email, grant a book with a reason, and revoke it.
Expected: the grant row appears as `admin_grant · active`; revoking asks for a reason and marks it `revoked`; searching "ab" shows the 3-character hint.

- [ ] **Step 9: Check and commit**

```bash
npm run check
git add lib/data/users.ts lib/data/users.test.ts app/admin/users components/admin/user-entitlements.tsx
git commit -m "feat: add admin user lookup and complimentary access"
```

### Task 12: Homepage merchandising

**Files:**
- Create: `lib/data/merchandising.ts`
- Create: `lib/data/merchandising.test.ts`
- Create: `app/admin/merchandising/page.tsx`
- Create: `app/admin/merchandising/actions.ts`
- Create: `app/admin/merchandising/actions.test.ts`
- Create: `components/admin/merchandising-form.tsx`

**Interfaces:**
- Consumes: Task 2 `admin_set_merchandising`; Task 4 `merchandisingSchema`, `readList`, `fieldErrorsFrom`; Task 5 `listAdminBooks`; Task 6 `FieldError`, `FormStatus`, `NativeSelect`.
- Produces:

```ts
// lib/data/merchandising.ts
export type MerchandisingDTO = { featuredBookId: string | null; shelfBookIds: string[] };
export async function getMerchandising(): Promise<MerchandisingDTO>;
export async function setMerchandising(input: MerchandisingInput): Promise<void>;

// app/admin/merchandising/actions.ts ("use server")
export async function saveMerchandisingAction(slotKey: "home_featured" | "home_shelf", previous: AdminFormState, formData: FormData): Promise<AdminFormState>;

// components/admin/merchandising-form.tsx
export function FeaturedBookForm(props: { action: FormAction; books: { id: string; title: string }[]; featuredBookId: string | null }): JSX.Element;
export function ShelfForm(props: { action: FormAction; books: { id: string; title: string }[]; shelfBookIds: string[] }): JSX.Element;
```

- Form field name `bookIds` (in submitted order). Labels: "Featured book", "Add a book to the shelf"; buttons "Save featured book", "Add", "Move up", "Move down", "Remove", "Save shelf".
- S2 reads the same slots for the home page; only `published` books are shown there, so an unpublished book in a slot simply does not render.

- [ ] **Step 1: Write the failing tests**

Create `lib/data/merchandising.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import { getMerchandising, setMerchandising } from "@/lib/data/merchandising";
import { fakeSupabaseClient } from "@/lib/data/supabase-test-client";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

type SessionClient = Awaited<ReturnType<typeof createClient>>;
const a = "3a1b2c3d-0000-4000-8000-000000000001";
const b = "3a1b2c3d-0000-4000-8000-000000000002";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("merchandising", () => {
  it("splits rows into the featured book and the ordered shelf", async () => {
    const fake = fakeSupabaseClient({
      tables: {
        merchandising_slots: {
          data: [
            { slot_key: "home_shelf", book_id: b, position: 1 },
            { slot_key: "home_featured", book_id: a, position: 1 },
            { slot_key: "home_shelf", book_id: a, position: 2 },
          ],
          error: null,
        },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(getMerchandising()).resolves.toEqual({ featuredBookId: a, shelfBookIds: [b, a] });
  });

  it("replaces a slot through the RPC", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: null, error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await setMerchandising({ slotKey: "home_shelf", bookIds: [b, a] });

    expect(fake.rpc).toHaveBeenCalledWith("admin_set_merchandising", { p_slot_key: "home_shelf", p_book_ids: [b, a] });
  });
});
```

Create `app/admin/merchandising/actions.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { saveMerchandisingAction } from "@/app/admin/merchandising/actions";
import { requireAdmin } from "@/lib/auth/admin";
import { initialAdminFormState } from "@/lib/catalog/form";
import { setMerchandising } from "@/lib/data/merchandising";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data/merchandising", () => ({ setMerchandising: vi.fn() }));

const a = "3a1b2c3d-0000-4000-8000-000000000001";

function form(ids: string[]) {
  const data = new FormData();
  for (const id of ids) data.append("bookIds", id);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("saveMerchandisingAction", () => {
  it("rejects duplicate shelf entries", async () => {
    const result = await saveMerchandisingAction("home_shelf", initialAdminFormState, form([a, a]));
    expect(result.fieldErrors.bookIds).toBe("Each book can appear once.");
    expect(setMerchandising).not.toHaveBeenCalled();
  });

  it("saves the submitted order", async () => {
    const result = await saveMerchandisingAction("home_shelf", initialAdminFormState, form([a]));
    expect(result.savedAt).not.toBeNull();
    expect(setMerchandising).toHaveBeenCalledWith({ slotKey: "home_shelf", bookIds: [a] });
  });

  it("treats an empty featured selection as clearing the slot", async () => {
    await saveMerchandisingAction("home_featured", initialAdminFormState, form([""]));
    expect(setMerchandising).toHaveBeenCalledWith({ slotKey: "home_featured", bookIds: [] });
  });
});
```

- [ ] **Step 2: Run them and verify they fail**

Run: `npm test -- lib/data/merchandising.test.ts app/admin/merchandising/actions.test.ts`
Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement the data layer**

Create `lib/data/merchandising.ts`:

```ts
import "server-only";

import { requireAdmin } from "@/lib/auth/admin";
import type { MerchandisingInput } from "@/lib/catalog/schemas";
import { createClient } from "@/lib/supabase/server";

export type MerchandisingDTO = { featuredBookId: string | null; shelfBookIds: string[] };

type SlotRow = { slot_key: "home_featured" | "home_shelf"; book_id: string; position: number };

export async function getMerchandising(): Promise<MerchandisingDTO> {
  await requireAdmin();
  const supabase = await createClient();
  const { data, error } = await supabase.from("merchandising_slots").select("slot_key, book_id, position").order("position");
  if (error) throw new Error(`getMerchandising failed: ${error.message}`);

  const rows = ((data ?? []) as SlotRow[]).slice().sort((left, right) => left.position - right.position);
  return {
    featuredBookId: rows.find((row) => row.slot_key === "home_featured")?.book_id ?? null,
    shelfBookIds: rows.filter((row) => row.slot_key === "home_shelf").map((row) => row.book_id),
  };
}

export async function setMerchandising(input: MerchandisingInput): Promise<void> {
  await requireAdmin();
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_merchandising", { p_slot_key: input.slotKey, p_book_ids: input.bookIds });
  if (error) throw new Error(`setMerchandising failed: ${error.message}`);
}
```

- [ ] **Step 4: Implement the action**

Create `app/admin/merchandising/actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth/admin";
import { fieldErrorsFrom, readList, type AdminFormState } from "@/lib/catalog/form";
import { merchandisingSchema } from "@/lib/catalog/schemas";
import { setMerchandising } from "@/lib/data/merchandising";

export async function saveMerchandisingAction(
  slotKey: "home_featured" | "home_shelf",
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: "/admin/merchandising" });

  const parsed = merchandisingSchema.safeParse({ slotKey, bookIds: readList(formData, "bookIds") });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error), formError: null, savedAt: null };

  try {
    await setMerchandising(parsed.data);
  } catch {
    return { fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null };
  }

  // S2 adds the public home paths here.
  revalidatePath("/admin/merchandising");
  return { fieldErrors: {}, formError: null, savedAt: Date.now() };
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npm test -- lib/data/merchandising.test.ts app/admin/merchandising/actions.test.ts`
Expected: PASS.

- [ ] **Step 6: Build the forms and page**

Create `components/admin/merchandising-form.tsx`:

```tsx
"use client";

import { useActionState, useState } from "react";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";

type FormAction = (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;
type BookOption = { id: string; title: string };

export function FeaturedBookForm({ action, books, featuredBookId }: { action: FormAction; books: BookOption[]; featuredBookId: string | null }) {
  const [state, formAction] = useActionState(action, initialAdminFormState);

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="featured-book">Featured book</Label>
        <NativeSelect defaultValue={featuredBookId ?? ""} id="featured-book" name="bookIds">
          <option value="">No featured book</option>
          {books.map((book) => (
            <option key={book.id} value={book.id}>
              {book.title}
            </option>
          ))}
        </NativeSelect>
        <FieldError message={state.fieldErrors.bookIds} />
      </div>
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">Save featured book</SubmitButton>
    </form>
  );
}

export function ShelfForm({ action, books, shelfBookIds }: { action: FormAction; books: BookOption[]; shelfBookIds: string[] }) {
  const [state, formAction] = useActionState(action, initialAdminFormState);
  const [ids, setIds] = useState(shelfBookIds);
  const [candidate, setCandidate] = useState("");
  const titleFor = (id: string) => books.find((book) => book.id === id)?.title ?? "Unknown book";
  const available = books.filter((book) => !ids.includes(book.id));

  function move(index: number, offset: -1 | 1) {
    setIds((current) => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(index + offset, 0, item);
      return next;
    });
  }

  return (
    <form action={formAction} className="space-y-5">
      {ids.map((id) => (
        <input key={id} name="bookIds" type="hidden" value={id} />
      ))}
      {ids.length === 0 ? <p className="text-sm text-sage-text">The shelf is empty.</p> : null}
      <ol className="border-t border-sand">
        {ids.map((id, index) => (
          <li className="flex flex-wrap items-center gap-2 border-b border-sand py-2" key={id}>
            <span className="w-6 text-sm text-sage-text">{index + 1}</span>
            <span className="flex-1 text-sm">{titleFor(id)}</span>
            <Button disabled={index === 0} onClick={() => move(index, -1)} size="sm" type="button" variant="ghost">
              Move up
            </Button>
            <Button disabled={index === ids.length - 1} onClick={() => move(index, 1)} size="sm" type="button" variant="ghost">
              Move down
            </Button>
            <Button onClick={() => setIds((current) => current.filter((value) => value !== id))} size="sm" type="button" variant="ghost">
              Remove
            </Button>
          </li>
        ))}
      </ol>
      <div className="flex items-end gap-3">
        <div className="flex-1 space-y-2">
          <Label htmlFor="shelf-candidate">Add a book to the shelf</Label>
          <NativeSelect id="shelf-candidate" onChange={(event) => setCandidate(event.target.value)} value={candidate}>
            <option value="">Choose a book</option>
            {available.map((book) => (
              <option key={book.id} value={book.id}>
                {book.title}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button
          disabled={candidate === ""}
          onClick={() => {
            setIds((current) => [...current, candidate]);
            setCandidate("");
          }}
          type="button"
          variant="outline"
        >
          Add
        </Button>
      </div>
      <FieldError message={state.fieldErrors.bookIds} />
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">Save shelf</SubmitButton>
    </form>
  );
}
```

Create `app/admin/merchandising/page.tsx`:

```tsx
import { saveMerchandisingAction } from "@/app/admin/merchandising/actions";
import { AdminPageHeader, AdminSection } from "@/components/admin/admin-page-header";
import { FeaturedBookForm, ShelfForm } from "@/components/admin/merchandising-form";
import { requireAdmin } from "@/lib/auth/admin";
import { listAdminBooks } from "@/lib/data/books";
import { getMerchandising } from "@/lib/data/merchandising";

export default async function MerchandisingPage() {
  await requireAdmin({ next: "/admin/merchandising" });
  const [merchandising, books] = await Promise.all([getMerchandising(), listAdminBooks()]);
  const options = books.map((book) => ({ id: book.id, title: `${book.title}${book.status === "published" ? "" : " (not published)"}` }));

  return (
    <div className="max-w-[42.5rem]">
      <AdminPageHeader eyebrow="Storefront" title="Merchandising">
        Choose what the home page features. Books that are not published are skipped on the storefront.
      </AdminPageHeader>
      <div className="space-y-12">
        <AdminSection title="Featured book">
          <FeaturedBookForm action={saveMerchandisingAction.bind(null, "home_featured")} books={options} featuredBookId={merchandising.featuredBookId} />
        </AdminSection>
        <AdminSection title="Home shelf">
          <ShelfForm action={saveMerchandisingAction.bind(null, "home_shelf")} books={options} shelfBookIds={merchandising.shelfBookIds} />
        </AdminSection>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Check manually**

With `npm run dev` on a local stack: set a featured book, add three books to the shelf, move the last one up, and save.
Expected: "Saved." for each form; reloading shows the same featured book and shelf order; `merchandising_slots` positions match.

- [ ] **Step 8: Check and commit**

```bash
npm run check
git add lib/data/merchandising.ts lib/data/merchandising.test.ts app/admin/merchandising components/admin/merchandising-form.tsx
git commit -m "feat: add homepage merchandising admin"
```

### Task 13: Catalog admin E2E, runbook, and S1 gate

**Files:**
- Create: `e2e/admin-catalog.spec.ts`
- Create: `docs/runbooks/catalog-admin.md`
- Modify: `docs/runbooks/deployment.md` (pre-push checks for the S1 migrations)

**Interfaces:**
- Consumes: every earlier task; existing E2E helpers `createServiceRoleClient()` and `createAnonClient()` from `e2e/support/supabase.ts`.
- Produces: the S1 exit evidence named in the spec: a complete book built from the admin, publish blocked until ready, a single-step slug redirect, and a 403 on every S1 page for a non-admin.

- [ ] **Step 1: Write the E2E spec**

Create `e2e/admin-catalog.spec.ts`:

```ts
import { type Page, expect, test } from "@playwright/test";

import { createAnonClient, createServiceRoleClient } from "./support/supabase";

// S1 exit criteria (docs/superpowers/specs/2026-09-13-remaining-mvp-ebook-launch-design.md):
// an operator builds and publishes a complete book from the admin, publishing is blocked until the
// book is ready, a slug rename leaves one redirect, and non-admins get 403 on every S1 page.

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);

function unique() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createUser({ admin: isAdmin }: { admin: boolean }) {
  const email = `catalog-${isAdmin ? "admin" : "reader"}-${unique()}@example.test`;
  const password = "catalog-admin-password-1";
  const service = createServiceRoleClient();
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;

  if (isAdmin) {
    const { data: profile, error: profileError } = await service.from("profiles").select("id").eq("auth_user_id", data.user.id).single();
    if (profileError) throw profileError;
    const { error: roleError } = await service.from("user_roles").insert({ profile_id: profile.id, role: "admin" });
    if (roleError) throw roleError;
  }
  return { email, password };
}

async function signInAsAdmin(page: Page, email: string, password: string, next: string) {
  await page.goto(`/internal/en/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page).toHaveURL(new RegExp(`${next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
}

// Same approach as e2e/internal-password.spec.ts: a non-admin cannot use the password fallback, so
// the admin API mints the magic-link token hash and /auth/callback verifies it.
async function signInReaderWithMagicLink(page: Page, email: string) {
  const service = createServiceRoleClient();
  const { data, error } = await service.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw error;
  const params = new URLSearchParams({ token_hash: data.properties.hashed_token, type: "email", next: "/en/account", locale: "en" });
  await page.goto(`/auth/callback?${params}`);
  await expect(page).toHaveURL(/\/en\/account$/);
}

// The EPUB pipeline has its own coverage (admin-epub-upload, golden path). Here a published
// version is seeded directly so this spec stays about catalog work.
async function seedPublishedPublication(bookId: string) {
  const service = createServiceRoleClient();
  const suffix = unique();
  const { data: edition, error: editionError } = await service.from("editions").select("id").eq("book_id", bookId).single();
  if (editionError) throw editionError;

  const { data: asset, error: assetError } = await service
    .from("ebook_assets")
    .insert({ edition_id: edition.id, source_storage_key: `${edition.id}/catalog-${suffix}/source.epub`, version: 1, status: "published" })
    .select("id")
    .single();
  if (assetError) throw assetError;

  const { data: publication, error: publicationError } = await service
    .from("ebook_publications")
    .insert({ ebook_asset_id: asset.id, version: 1, manifest_key: `${asset.id}/manifest.json`, status: "published" })
    .select("id")
    .single();
  if (publicationError) throw publicationError;

  const { error: pointerError } = await service.from("books").update({ active_publication_id: publication.id }).eq("id", bookId);
  if (pointerError) throw pointerError;
}

test("an admin builds, publishes, and renames a complete book from the admin", async ({ page }) => {
  test.slow();
  const suffix = unique();
  const authorName = `E2E Tác Giả ${suffix}`;
  const topicName = `E2E Topic ${suffix}`;
  const seriesName = `E2E Series ${suffix}`;
  const oldSlug = `e2e-catalog-${suffix}`;
  const newSlug = `e2e-catalog-renamed-${suffix}`;
  const service = createServiceRoleClient();

  const { email, password } = await createUser({ admin: true });
  await signInAsAdmin(page, email, password, "/admin/authors/new");

  // ---- author with Vietnamese copy ----
  await page.getByLabel("Canonical slug").fill(`e2e-author-${suffix}`);
  await page.getByLabel("Name", { exact: true }).fill(authorName);
  await page.getByRole("button", { name: "Create author" }).click();
  await expect(page).toHaveURL(/\/admin\/authors\/[0-9a-f-]{36}$/);
  await page.getByLabel("Slug (vi)").fill(`e2e-tac-gia-${suffix}`);
  await page.getByLabel("Name (vi)").fill(authorName);
  await page.getByRole("button", { name: "Save vi copy" }).click();
  await expect(page.getByTestId("form-saved")).toBeVisible();

  // ---- topic and series ----
  await page.goto("/admin/topics/new");
  await page.getByLabel("Canonical slug").fill(`e2e-topic-${suffix}`);
  await page.getByLabel("Name", { exact: true }).fill(topicName);
  await page.getByRole("button", { name: "Create topic" }).click();
  await expect(page).toHaveURL(/\/admin\/topics\/[0-9a-f-]{36}$/);

  await page.goto("/admin/series/new");
  await page.getByLabel("Canonical slug").fill(`e2e-series-${suffix}`);
  await page.getByLabel("Name", { exact: true }).fill(seriesName);
  await page.getByRole("button", { name: "Create series" }).click();
  await expect(page).toHaveURL(/\/admin\/series\/[0-9a-f-]{36}$/);

  // ---- book, reusing the author by name ----
  await page.goto("/admin/books/new");
  await page.getByLabel("Canonical key").fill(`e2e-catalog-book-${suffix}`);
  await page.getByLabel("Author name").fill(authorName);
  await page.getByLabel("Title").fill(`E2E Catalog Book ${suffix}`);
  await page.getByLabel("Slug").fill(oldSlug);
  await page.getByLabel("Market").fill("VN");
  await page.getByLabel("Currency").fill("VND");
  await page.getByLabel("Price (minor units)").fill("0");
  await page.getByRole("button", { name: "Create book" }).click();
  await expect(page).toHaveURL(/\/admin\/books\/[0-9a-f-]{36}$/);
  const bookId = page.url().split("/").pop() as string;

  const { count: authorCount } = await service.from("authors").select("id", { count: "exact", head: true }).eq("display_name", authorName);
  expect(authorCount, "the existing author is reused, not duplicated").toBe(1);

  // ---- publishing is blocked until the book is ready ----
  await expect(page.getByRole("button", { name: "Publish book" })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Upload a cover image." })).toBeVisible();

  // ---- relations ----
  await page.getByLabel(topicName).check();
  await page.getByLabel("Series", { exact: true }).selectOption({ label: seriesName });
  await page.getByLabel("Series position").fill("1");
  await page.getByRole("button", { name: "Save relations" }).click();
  await expect(page.locator("#relations").getByTestId("form-saved")).toBeVisible();

  // ---- description, cover, EPUB version ----
  await page.getByLabel("Description (vi)").fill("Generated description for the catalog admin journey.");
  await page.getByLabel("Key ideas (vi)").fill("Quan sát | Nhìn mà không phán xét");
  await page.getByRole("button", { name: "Save vi copy" }).click();
  await expect(page.locator("#localizations").getByTestId("form-saved")).toBeVisible();

  await page.getByLabel("Cover image").setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: ONE_PIXEL_PNG });
  await page.getByLabel("Cover alt text").fill("Generated cover");
  await page.getByRole("button", { name: "Upload cover" }).click();
  await expect(page.getByTestId("cover-status")).toHaveText("Cover saved.");

  await seedPublishedPublication(bookId);
  await page.reload();

  // ---- publish ----
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Publish book" }).click();
  await expect(page.getByTestId("book-publish-message")).toHaveText("Book published.");

  const anon = createAnonClient();
  const { data: visible } = await anon.from("books").select("id").eq("id", bookId).maybeSingle();
  expect(visible, "the published book is public").not.toBeNull();

  // ---- slug rename leaves exactly one redirect ----
  await page.reload();
  await page.getByLabel("Slug (vi)").fill(newSlug);
  await page.getByRole("button", { name: "Save vi copy" }).click();
  await expect(page.locator("#localizations").getByTestId("form-saved")).toBeVisible();

  const { data: redirects, error: redirectError } = await service
    .from("redirects")
    .select("source_path, destination_path")
    .in("source_path", [`/vi/books/${oldSlug}`, `/vi/books/${newSlug}`]);
  if (redirectError) throw redirectError;
  expect(redirects).toEqual([{ source_path: `/vi/books/${oldSlug}`, destination_path: `/vi/books/${newSlug}` }]);

  // ---- audited ----
  const { count: publishAudits } = await service
    .from("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("action", "publish_book")
    .eq("entity_id", bookId);
  expect(publishAudits).toBe(1);
});

test("a signed-in non-admin gets 403 on every catalog admin page", async ({ page }) => {
  const { email } = await createUser({ admin: false });
  await signInReaderWithMagicLink(page, email);

  const paths = [
    "/admin/books",
    "/admin/books/new",
    "/admin/authors",
    "/admin/authors/new",
    "/admin/series",
    "/admin/series/new",
    "/admin/topics",
    "/admin/topics/new",
    "/admin/users",
    "/admin/merchandising",
  ];

  for (const path of paths) {
    const response = await page.goto(path);
    expect(response?.status(), `${path} answers 403`).toBe(403);
    await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
  }
});

test("an anonymous visitor is sent to sign-in from the catalog admin", async ({ page }) => {
  await page.goto("/admin/books");
  await expect(page).toHaveURL(/sign-in\?next=%2Fadmin%2Fbooks/);
});
```

- [ ] **Step 2: Write the operator runbook**

Create `docs/runbooks/catalog-admin.md`:

```markdown
# Runbook: catalog admin

Everything here happens under `/admin` and requires an admin account. Every change is recorded in
`audit_logs`.

## Build a book

1. **Authors, series, topics.** Create them first under their own menus. Each starts as a draft.
   Add Vietnamese and/or English copy, then set the status to **Published**. An entry with no copy
   cannot be published.
2. **New book** (`/admin/books/new`). Type the author's name. An existing author with the same name
   is reused; a new name creates a new author.
3. **Book editor** (`/admin/books/<id>`), top to bottom:
   - **Details:** canonical key, book language, primary author.
   - **Localizations:** title, slug, description, audience, key ideas (`Title | summary`, one per
     line), FAQ (`Q:` / `A:` blocks separated by a blank line), SEO title and description.
   - **Edition & offer:** ISBN without dashes, publication date, price in minor units. A price of 0
     is a free ebook. A paid price shows as "coming soon" until payments launch.
   - **Cover:** JPEG, PNG, or WebP up to 5 MB, with alt text. Uploading again replaces the cover.
   - **Relations:** topics, and the series with the book's position.
   - **EPUB:** upload, then process with the CLI (`docs/runbooks/epub-processing.md`) and publish
     the version on its publication page.
   - **Publish:** the checklist lists anything missing. **Publish book** makes the book and its
     primary author public.

## Rules worth knowing

- Publishing an EPUB version does **not** publish the book. Only **Publish book** does.
- **Unpublish book** hides the book from the storefront and stops new reader sessions for it,
  including for readers who already own it.
- Changing the slug of a **published** book, author, series, or topic creates a permanent redirect
  from the old URL. Renaming back removes the loop automatically. Draft renames create nothing.
- One book can be in one series, and each series position holds one book.

## Merchandising

`/admin/merchandising` sets one featured book and an ordered home shelf. Unpublished books can be
placed but are not shown on the storefront.

## Complimentary access

`/admin/users`: search at least 3 characters of an email, open the user, choose a book, and give a
reason. Only admin grants can be revoked here, and revoking also asks for a reason. The user must
have verified their email at least once before a first grant.
```

- [ ] **Step 3: Add the pre-push checks to the deployment runbook**

Append to `docs/runbooks/deployment.md`:

```markdown
## S1 catalog admin migrations (20260913100000–20260913120000)

Before `supabase db push` to the hosted project:

1. Run `select distinct slot_key from public.merchandising_slots;`. Any key other than
   `home_featured` or `home_shelf` makes the migration fail; rename or delete those rows first.
2. Books that are already `published` stay published. From this release on, a newly published EPUB
   version no longer publishes its book; operators use **Publish book** in the book editor.
3. After the push, confirm the `covers` bucket exists and is public, and that `ebook-source` and
   `ebook-derived` are still private.
```

- [ ] **Step 4: Run the S1 gate against a local stack**

Run (add `--workdir <scratch>` to the `supabase` commands, and use a scratch Playwright config on another port, when the default ports or port 3000 are taken — see `docs/runbooks/testing-environments.md`):

```bash
supabase db reset
supabase test db
supabase gen types --local --lang typescript > lib/supabase/database.types.ts
git diff --exit-code lib/supabase/database.types.ts
eval "$(supabase status -o env)"
export NEXT_PUBLIC_SUPABASE_URL="$API_URL" NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" E2E_MAILPIT_URL="$MAILPIT_URL"
npm run check:full
```

Expected:
- every pgTAP file passes, including `007`, `011`, `012`, and `013`;
- the regenerated types match the committed file;
- `npm run check` passes;
- Playwright runs every spec with none skipped: the previous 21 tests plus the 3 in `admin-catalog.spec.ts`, including the updated golden path.

If a pgTAP file fails after running Playwright against the same stack, reset and rerun before debugging (stale fixture rows).

- [ ] **Step 5: Commit**

```bash
git add e2e/admin-catalog.spec.ts docs/runbooks/catalog-admin.md docs/runbooks/deployment.md
git commit -m "test: cover the catalog admin journey and document it"
```

## S1 Completion Gate

- [ ] An operator creates and edits a complete launch book (localizations, edition, offer, cover, relations) from the admin only.
- [ ] Authors, series, and topics have localized copy and cannot be published without it.
- [ ] A book with any readiness issue cannot be published through the UI or the `publish_book` RPC.
- [ ] Publishing an EPUB version no longer publishes the book; `publish_book` does.
- [ ] A published slug rename produces one redirect with no chain.
- [ ] Merchandising and complimentary grant/revoke work from the admin.
- [ ] Every S1 page answers 403 to a signed-in non-admin; every S1 action and RPC calls the admin check itself.
- [ ] Every catalog change writes an audit row.
- [ ] `supabase test db`, `npm run check:full`, and the regenerated types all pass on a clean local stack.
