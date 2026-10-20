-- Press contract (Task 10): the expand phase is over. Everything below removes the book-scoped
-- shapes the expand phase kept alive for older code, after every caller moved to editions.
--
--   * entitlements, library items, order lines and reviews are edition-scoped, not nullable;
--   * books.active_publication_id and its two-way bridge are gone (the edition owns the live
--     publication);
--   * the book-only order and free-claim entry points are gone;
--   * bundle_books, the derived work-level table, becomes the bundle_works view;
--   * the one-off backfill is dropped (it read the removed pointer).
--
-- A database that still holds a row with no edition stops here with the table named, never silently.

do $$
declare
  v_table text;
  v_count bigint;
begin
  for v_table in select unnest(array['entitlements', 'library_items', 'order_items', 'book_reviews']) loop
    execute format('select count(*) from public.%I where edition_id is null', v_table) into v_count;
    if v_count > 0 then
      raise exception 'press contract: % row(s) in % have no edition; run press_edition_backfill and resolve them first', v_count, v_table
        using errcode = 'EB046';
    end if;
  end loop;
end;
$$;

alter table public.entitlements alter column edition_id set not null;
alter table public.library_items alter column edition_id set not null;
alter table public.order_items alter column edition_id set not null;
alter table public.book_reviews alter column edition_id set not null;
drop index public.book_reviews_profile_book_unmapped_key;

-- ---- the book-only entry points ------------------------------------------------------------------
drop function public.create_ebook_order(uuid);
drop function public.acquire_free_ebook(uuid);
drop function public.press_edition_backfill(boolean);

-- ---- books.active_publication_id and the bridge --------------------------------------------------
drop trigger books_mirror_active_publication_bridge on public.books;
drop function public.books_mirror_active_publication();

create or replace function public.press_move_edition_pointer(p_edition_id uuid, p_publication_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_book_id uuid;
  v_language text;
  v_previous uuid;
  v_asset_id uuid;
begin
  select e.book_id, e.language_code, e.active_publication_id
  into v_book_id, v_language, v_previous
  from public.editions e where e.id = p_edition_id for update;

  select p.ebook_asset_id into v_asset_id from public.ebook_publications p where p.id = p_publication_id;

  -- Only THIS edition's previous publication is superseded.
  if v_previous is not null and v_previous <> p_publication_id then
    update public.ebook_assets set status = 'superseded'
    where id = (select ebook_asset_id from public.ebook_publications where id = v_previous);
    update public.ebook_publications set status = 'superseded' where id = v_previous;
  end if;

  update public.ebook_publications set status = 'published' where id = p_publication_id;
  update public.ebook_assets set status = 'published' where id = v_asset_id;
  update public.editions set active_publication_id = p_publication_id, status = 'published' where id = p_edition_id;

  -- The first published edition of a language is that language's default; later ones are reached
  -- explicitly until an admin changes the default.
  insert into public.book_language_editions (book_id, language_code, edition_id)
  values (v_book_id, v_language, p_edition_id)
  on conflict (book_id, language_code) do nothing;

  return v_previous;
end;
$$;

alter table public.books drop constraint books_active_publication_fk;
alter table public.books drop column active_publication_id;

-- ---- bundle_books -> bundle_works -----------------------------------------------------------------
drop trigger bundle_editions_mirror_books on public.bundle_editions;
drop function public.bundle_books_rebuild();
drop policy "public read published bundle membership" on public.bundle_books;
drop table public.bundle_books;

-- The works a bundle contains, derived from its editions. A view, so it can never disagree with them.
create view public.bundle_works with (security_invoker = false) as
select be.bundle_id, ed.book_id, min(be.position) as position
from public.bundle_editions be
join public.editions ed on ed.id = be.edition_id
group by be.bundle_id, ed.book_id;
revoke all on public.bundle_works from public, anon, authenticated;
grant select on public.bundle_works to service_role;

CREATE OR REPLACE FUNCTION public.recommend_books(p_seed_book_ids uuid[], p_exclude_book_ids uuid[], p_locale text, p_limit integer)
 RETURNS TABLE(book_id uuid, score integer, pinned boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_series_weight constant integer := 100;
  v_author_weight constant integer := 50;
  v_topic_weight constant integer := 10;
  v_bundle_weight constant integer := 5;
begin
  return query
  with requested_seed_ids as (
    select distinct id from unnest(coalesce(p_seed_book_ids, array[]::uuid[])) as ids(id)
  ),
  seed_ids as (
    select r.id
    from requested_seed_ids r
    join public.books b on b.id = r.id and b.status = 'published'
  ),
  excluded_ids as (
    select id from requested_seed_ids
    union
    select distinct id from unnest(coalesce(p_exclude_book_ids, array[]::uuid[])) as ids(id)
  ),
  seed_series as (
    select distinct bs.series_id
    from public.book_series bs
    join public.series sr on sr.id = bs.series_id and sr.status = 'published'
    join seed_ids s on s.id = bs.book_id
  ),
  seed_authors as (
    select distinct b.primary_author_id
    from public.books b
    join seed_ids s on s.id = b.id
  ),
  seed_topics as (
    select distinct bt.topic_id
    from public.book_topics bt
    join public.topics t on t.id = bt.topic_id and t.status = 'published'
    join seed_ids s on s.id = bt.book_id
  ),
  seed_bundles as (
    select distinct bb.bundle_id
    from public.bundle_works bb
    join public.bundles bu on bu.id = bb.bundle_id and bu.status = 'published'
    join seed_ids s on s.id = bb.book_id
  ),
  -- One row per pinned candidate carrying the SMALLEST position it holds across every seed. With
  -- several seeds the same book can be pinned in more than one place; the editor's strongest
  -- placement is the one that should decide where it lands.
  seed_pins as (
    select rb.related_book_id, min(rb.position) as pin_position
    from public.related_books rb
    join seed_ids s on s.id = rb.book_id
    group by rb.related_book_id
  ),
  -- The eligibility gate, evaluated here rather than left to the caller's RLS: a published book with
  -- an edition RESOLVED for the requested locale (the locale's default edition, else the effective
  -- default language's, with a live publication) and a localization to show it under (the
  -- requested locale, else the platform default, else the original). The ordering date comes from
  -- the resolved edition; a book whose edition has no publication_date falls back to when the book
  -- row was created, normalized to UTC so two sessions order tied candidates the same way.
  eligible_candidates as (
    select
      b.id as candidate_id,
      b.primary_author_id,
      coalesce(ed.publication_date, (b.created_at at time zone 'UTC')::date) as publication_date
    from public.books b
    join public.catalog_resolved_editions(p_locale) r on r.book_id = b.id
    join public.editions ed on ed.id = r.edition_id
    where b.status = 'published'
      and exists (select 1 from public.catalog_book_metadata(b.id, p_locale))
      and not exists (select 1 from excluded_ids x where x.id = b.id)
  ),
  ranked as (
    select
      c.candidate_id,
      c.publication_date,
      p.pin_position,
      (
        (case when exists (
          select 1 from public.book_series bs
          join public.series sr on sr.id = bs.series_id and sr.status = 'published'
          join seed_series ss on ss.series_id = bs.series_id
          where bs.book_id = c.candidate_id
        ) then v_series_weight else 0 end)
        + (case when exists (
          select 1 from seed_authors sa where sa.primary_author_id = c.primary_author_id
        ) then v_author_weight else 0 end)
        + (
          select count(distinct bt.topic_id) from public.book_topics bt
          join public.topics t on t.id = bt.topic_id and t.status = 'published'
          join seed_topics st on st.topic_id = bt.topic_id
          where bt.book_id = c.candidate_id
        ) * v_topic_weight
        + (case when exists (
          select 1 from public.bundle_works bb
          join public.bundles bu on bu.id = bb.bundle_id and bu.status = 'published'
          join seed_bundles sb on sb.bundle_id = bb.bundle_id
          where bb.book_id = c.candidate_id
        ) then v_bundle_weight else 0 end)
      )::integer as candidate_score
    from eligible_candidates c
    left join seed_pins p on p.related_book_id = c.candidate_id
  )
  -- A pin is an ordering override, so a pinned book is returned even when it shares no signal at
  -- all and scores 0. An unpinned book that shares nothing is not a recommendation.
  select r.candidate_id, r.candidate_score, r.pin_position is not null
  from ranked r
  where r.pin_position is not null or r.candidate_score > 0
  order by (r.pin_position is not null) desc,
           r.pin_position asc nulls last,
           r.candidate_score desc,
           r.publication_date desc,
           r.candidate_id
  -- A null or negative limit asks for nothing and gets nothing rather than an error, because a
  -- shelf with no room is a rendering decision, not a bug. The upper clamp keeps a caller from
  -- turning a shelf query into a full catalog scan.
  limit greatest(0, least(coalesce(p_limit, 0), 100));
end;
$function$;

-- A page names, as hreflang alternates, only the locales where the work really resolves to a readable
-- edition: a localization for a locale that cannot show the work is not an alternate.
CREATE OR REPLACE FUNCTION public.catalog_book_page(p_locale text, p_slug text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'bookId', b.id,
    'description', bl.description,
    'audience', bl.audience,
    'keyIdeas', bl.key_ideas,
    'faq', bl.faq,
    'seoTitle', bl.seo_title,
    'seoDescription', bl.seo_description,
    'metadataLocale', bl.locale,
    'alternateSlugs', coalesce((select jsonb_object_agg(other.locale, other.slug) from public.book_localizations other where other.book_id = b.id and other.locale <> p_locale and exists (select 1 from public.catalog_resolved_editions(other.locale, b.id))), '{}'::jsonb),
    'isbn', (select e.isbn from public.editions e where e.book_id = b.id and e.isbn is not null order by e.language_code = p_locale desc, e.edition_number limit 1),
    'retailLinks', coalesce((
      select jsonb_agg(jsonb_build_object('id', rl.id, 'retailer', rl.retailer, 'label', rl.label, 'url', rl.url, 'priceMinor', rl.price_minor, 'currency', rl.currency) order by rl.position)
      from public.book_retail_links rl where rl.book_id = b.id and rl.active), '[]'::jsonb),
    'reviewSummary', (
      select case when count(*) = 0 then null
        else jsonb_build_object('count', count(*), 'average', round(avg(r.rating)::numeric, 1)) end
      from public.book_reviews r where r.book_id = b.id and r.status = 'published'),
    'editions', public.catalog_book_editions(b.id, p_locale)
  )
  from public.book_localizations hit
  join public.books b on b.id = hit.book_id and b.status = 'published'
  join lateral public.catalog_book_metadata(b.id, p_locale) bl on true
  where hit.slug = p_slug and hit.id = bl.id
    and hit.locale in (p_locale, (select s.default_metadata_locale from public.platform_settings s), b.original_language)
  limit 1;
$function$;
