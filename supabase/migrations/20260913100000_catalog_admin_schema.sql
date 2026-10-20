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
  public.book_topics
to authenticated;

-- Keep storage_key private: covers use a public bucket, but an object key is not a public API
-- contract and must remain unavailable to browser roles. Admin server code uses service_role
-- after its authorization gate when it needs the key.
grant select (id, owner_type, owner_id, kind, alt_text, width, height, created_at)
  on public.media_assets to authenticated;

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
