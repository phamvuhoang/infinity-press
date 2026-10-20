-- Press catalog resolution (Task 8).
--
-- Which edition a reader is shown is one rule, evaluated set-wise for lists and per book for a page:
--   1. an explicit edition id, if it is an edition of that work and can be read now;
--   2. otherwise the work's default edition in the requested language;
--   3. otherwise the default edition in the ONE effective default language (the work's override,
--      else the platform's);
--   4. otherwise nothing: the work is not listed, and its page is unavailable.
-- No third language is ever chosen by database order, and an explicit edition that is not valid never
-- falls through to another one. Offers do not take part: a Japanese edition with no buyable offer is
-- shown as Japanese and not yet on sale, not swapped for an English one that has a price.
--
-- Metadata is a separate choice: the requested locale's localization, else the platform default
-- metadata locale, else the work's original language. A whole localization row is used, never a
-- Japanese title over a Vietnamese description.

-- The first published edition of a language becomes that language's default. The admin RPCs already
-- do this; the trigger makes it true for every writer, so a default exists whenever one is obvious
-- and is never guessed by `limit 1`.
create function public.editions_default_language()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'published' and new.active_publication_id is not null then
    insert into public.book_language_editions (book_id, language_code, edition_id)
    values (new.book_id, new.language_code, new.id)
    on conflict (book_id, language_code) do nothing;
  end if;
  return null;
end;
$$;
create trigger editions_default_language
after insert or update of status, active_publication_id on public.editions
for each row execute function public.editions_default_language();

-- Existing rows the triggers could not have seen.
insert into public.book_language_editions (book_id, language_code, edition_id)
select e.book_id, e.language_code, min(e.id::text)::uuid
from public.editions e
where e.status = 'published' and e.active_publication_id is not null
group by e.book_id, e.language_code
on conflict (book_id, language_code) do nothing;

-- The one localization a work is shown with in a locale.
create function public.catalog_book_metadata(p_book_id uuid, p_locale text)
returns setof public.book_localizations
language sql
stable
security definer
set search_path = ''
as $$
  select bl.*
  from public.book_localizations bl
  join public.books b on b.id = bl.book_id
  where bl.book_id = p_book_id
    and bl.locale in (p_locale, (select s.default_metadata_locale from public.platform_settings s), b.original_language)
  order by (bl.locale = p_locale) desc,
           (bl.locale = (select s.default_metadata_locale from public.platform_settings s)) desc,
           bl.locale
  limit 1;
$$;
revoke all on function public.catalog_book_metadata(uuid, text) from public;
grant execute on function public.catalog_book_metadata(uuid, text) to anon, authenticated, service_role;

create function public.catalog_resolved_editions(p_language text, p_book_id uuid default null)
returns table(book_id uuid, edition_id uuid, language_code text, is_fallback boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with listable as (
    select ble.book_id, ble.language_code, ble.edition_id
    from public.book_language_editions ble
    join public.editions e on e.id = ble.edition_id
    join public.ebook_publications pub on pub.id = e.active_publication_id and pub.status = 'published'
    where e.status = 'published'
      and (p_book_id is null or ble.book_id = p_book_id)
  )
  select b.id,
         coalesce(req.edition_id, dflt.edition_id),
         case when req.edition_id is not null then p_language
              else coalesce(b.default_content_language, (select s.default_content_language from public.platform_settings s)) end,
         req.edition_id is null
  from public.books b
  left join listable req on req.book_id = b.id and req.language_code = p_language
  left join listable dflt on dflt.book_id = b.id
    and dflt.language_code = coalesce(b.default_content_language, (select s.default_content_language from public.platform_settings s))
  where b.status = 'published'
    and (p_book_id is null or b.id = p_book_id)
    and coalesce(req.edition_id, dflt.edition_id) is not null;
$$;
revoke all on function public.catalog_resolved_editions(text, uuid) from public;
grant execute on function public.catalog_resolved_editions(text, uuid) to anon, authenticated, service_role;

-- One work: an explicit edition must be a readable edition of that work, or there is no answer.
create function public.catalog_resolve_edition(p_book_id uuid, p_language text, p_edition_id uuid default null)
returns table(edition_id uuid, language_code text, is_fallback boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.language_code, e.language_code is distinct from p_language
  from public.editions e
  join public.books b on b.id = e.book_id and b.status = 'published'
  join public.ebook_publications pub on pub.id = e.active_publication_id and pub.status = 'published'
  where p_edition_id is not null
    and e.id = p_edition_id and e.book_id = p_book_id
    and e.status = 'published'
  union all
  select r.edition_id, r.language_code, r.is_fallback
  from public.catalog_resolved_editions(p_language, p_book_id) r
  where p_edition_id is null;
$$;
revoke all on function public.catalog_resolve_edition(uuid, text, uuid) from public;
grant execute on function public.catalog_resolve_edition(uuid, text, uuid) to anon, authenticated, service_role;

-- The price an edition is sold at: its default offer, if that offer can be bought now. An edition
-- that has no default offer row is sold at its only active offer, when there is exactly one; with
-- several and no chosen default it has no price, and an admin must choose. Never the cheapest.
create function public.catalog_edition_offer(p_edition_id uuid)
returns table(offer_id uuid, price_minor bigint, currency text, list_price_minor bigint, sale_ends_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, eff.price_minor, o.currency,
         case when eff.price_minor < o.price_minor then o.price_minor end,
         case when eff.price_minor < o.price_minor then o.sale_ends_at end
  from public.offers o
  join public.skus sk on sk.id = o.sku_id and sk.edition_id = p_edition_id
  cross join lateral (select public.offer_effective_price_minor(o) as price_minor) eff
  where o.active and sk.active
    and (o.starts_at is null or o.starts_at <= now())
    and (o.ends_at is null or o.ends_at > now())
    and (
      o.id = (select d.offer_id from public.edition_default_offers d where d.edition_id = p_edition_id)
      or (
        not exists (select 1 from public.edition_default_offers d where d.edition_id = p_edition_id)
        and (
          select count(*) from public.offers o2
          join public.skus s2 on s2.id = o2.sku_id
          where s2.edition_id = p_edition_id and o2.active and s2.active
        ) = 1
      )
    );
$$;
revoke all on function public.catalog_edition_offer(uuid) from public;
grant execute on function public.catalog_edition_offer(uuid) to anon, authenticated, service_role;

-- The editions of one work a reader may pick between: every readable edition, with the language the
-- EPUB is actually in, the price of its default offer (null = not on sale yet), and which one is the
-- default for the requested locale.
create function public.catalog_book_editions(p_book_id uuid, p_locale text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'editionId', e.id,
    'languageCode', e.language_code,
    'epubLanguage', pub.epub_language,
    'isDefault', e.id = (select r.edition_id from public.catalog_resolved_editions(p_locale, p_book_id) r),
    'offerId', o.offer_id,
    'priceMinor', o.price_minor,
    'currency', o.currency,
    'listPriceMinor', o.list_price_minor,
    'saleEndsAt', o.sale_ends_at,
    'hasSample', exists (
      select 1 from public.book_samples s
      where s.publication_id = e.active_publication_id and jsonb_array_length(s.allowed_hrefs) > 0)
  ) order by (e.id = (select r.edition_id from public.catalog_resolved_editions(p_locale, p_book_id) r)) desc, e.language_code, e.edition_number), '[]'::jsonb)
  from public.editions e
  join public.books b on b.id = e.book_id and b.status = 'published'
  join public.ebook_publications pub on pub.id = e.active_publication_id and pub.status = 'published'
  left join lateral public.catalog_edition_offer(e.id) o on true
  where e.book_id = p_book_id and e.status = 'published';
$$;
revoke all on function public.catalog_book_editions(uuid, text) from public;
grant execute on function public.catalog_book_editions(uuid, text) to anon, authenticated, service_role;


-- Visible-book check used by entity pages and search: a resolved edition and a metadata row.
CREATE OR REPLACE FUNCTION public.catalog_has_visible_book(p_kind text, p_entity_id uuid, p_locale text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.books b
    join public.catalog_resolved_editions(p_locale) r on r.book_id = b.id
    where b.status = 'published'
      and exists (select 1 from public.catalog_book_metadata(b.id, p_locale))
      and case p_kind
        when 'author' then b.primary_author_id = p_entity_id
        when 'series' then exists (
          select 1 from public.book_series bs where bs.book_id = b.id and bs.series_id = p_entity_id
        )
        when 'topic' then exists (
          select 1 from public.book_topics bt where bt.book_id = b.id and bt.topic_id = p_entity_id
        )
        else false
      end
  );
$function$;

-- Cards: one per work, for the resolved edition, under the resolved metadata row.
drop function public.catalog_book_cards(text);
drop function public.catalog_book_card_by_id(text, uuid);

create function public.catalog_book_card_rows(p_locale text, p_book_id uuid default null)
returns table(
  book_id uuid, slug text, title text, subtitle text, short_description text,
  author_name text, author_slug text, cover_path text, cover_alt text,
  price_minor bigint, currency text, has_active_publication boolean, has_sample boolean,
  series_slug text, series_name text, series_position integer, topics jsonb,
  featured boolean, shelf_position integer, created_at timestamptz,
  list_price_minor bigint, sale_ends_at timestamptz,
  edition_id uuid, language_code text, is_language_fallback boolean, offer_id uuid, metadata_locale text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    b.id,
    bl.slug,
    bl.title,
    bl.subtitle,
    bl.short_description,
    coalesce(al.name, a.display_name),
    al.slug,
    cover.storage_key,
    cover.alt_text,
    offer.price_minor,
    offer.currency,
    true,
    exists (
      select 1 from public.book_samples s
      where s.publication_id = ed.active_publication_id and jsonb_array_length(s.allowed_hrefs) > 0
    ),
    series.slug,
    series.name,
    series.position,
    coalesce((
      select jsonb_agg(jsonb_build_object('slug', tl.slug, 'name', tl.name) order by tl.name)
      from public.book_topics bt
      join public.topics t on t.id = bt.topic_id and t.status = 'published'
      join public.topic_localizations tl on tl.topic_id = t.id and tl.locale = p_locale
      where bt.book_id = b.id
    ), '[]'::jsonb),
    exists (
      select 1 from public.merchandising_slots ms
      where ms.book_id = b.id and ms.slot_key = 'home_featured' and ms.active
    ),
    (
      select ms.position from public.merchandising_slots ms
      where ms.book_id = b.id and ms.slot_key = 'home_shelf' and ms.active
    ),
    b.created_at,
    offer.list_price_minor,
    offer.sale_ends_at,
    r.edition_id,
    r.language_code,
    r.is_fallback,
    offer.offer_id,
    bl.locale
  from public.books b
  join public.catalog_resolved_editions(p_locale, p_book_id) r on r.book_id = b.id
  join public.editions ed on ed.id = r.edition_id
  join lateral public.catalog_book_metadata(b.id, p_locale) bl on true
  join public.authors a on a.id = b.primary_author_id
  left join public.author_localizations al
    on al.author_id = a.id and al.locale = p_locale and a.status = 'published'
  left join lateral (
    -- The edition's own cover, else the work's.
    select m.storage_key, m.alt_text
    from public.media_assets m
    where (m.owner_type = 'edition' and m.owner_id = ed.id and m.kind = 'cover')
       or (m.owner_type = 'book' and m.owner_id = b.id and m.kind = 'cover')
    order by (m.owner_type = 'edition') desc
    limit 1
  ) cover on true
  left join lateral public.catalog_edition_offer(ed.id) offer on true
  left join lateral (
    select sl.slug, sl.name, bs.position
    from public.book_series bs
    join public.series sr on sr.id = bs.series_id and sr.status = 'published'
    join public.series_localizations sl on sl.series_id = sr.id and sl.locale = p_locale
    where bs.book_id = b.id
  ) series on true
  where b.status = 'published' and (p_book_id is null or b.id = p_book_id)
    and public.is_supported_locale(p_locale);
$$;
revoke all on function public.catalog_book_card_rows(text, uuid) from public;

create function public.catalog_book_cards(p_locale text)
returns table(
  book_id uuid, slug text, title text, subtitle text, short_description text,
  author_name text, author_slug text, cover_path text, cover_alt text,
  price_minor bigint, currency text, has_active_publication boolean, has_sample boolean,
  series_slug text, series_name text, series_position integer, topics jsonb,
  featured boolean, shelf_position integer, created_at timestamptz,
  list_price_minor bigint, sale_ends_at timestamptz,
  edition_id uuid, language_code text, is_language_fallback boolean, offer_id uuid, metadata_locale text
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.catalog_book_card_rows(p_locale, null);
$$;
revoke all on function public.catalog_book_cards(text) from public;
grant execute on function public.catalog_book_cards(text) to anon, authenticated, service_role;

create function public.catalog_book_card_by_id(p_locale text, p_book_id uuid)
returns table(
  book_id uuid, slug text, title text, subtitle text, short_description text,
  author_name text, author_slug text, cover_path text, cover_alt text,
  price_minor bigint, currency text, has_active_publication boolean, has_sample boolean,
  series_slug text, series_name text, series_position integer, topics jsonb,
  featured boolean, shelf_position integer, created_at timestamptz,
  list_price_minor bigint, sale_ends_at timestamptz,
  edition_id uuid, language_code text, is_language_fallback boolean, offer_id uuid, metadata_locale text
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.catalog_book_card_rows(p_locale, p_book_id);
$$;
revoke all on function public.catalog_book_card_by_id(text, uuid) from public;
grant execute on function public.catalog_book_card_by_id(text, uuid) to anon, authenticated, service_role;

-- The work page. The slug is looked up under the same metadata choice the cards use: it must be the
-- slug of the localization this work is shown with in this locale, so a work never answers under two
-- addresses in one locale.
create or replace function public.catalog_book_page(p_locale text, p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'bookId', b.id,
    'description', bl.description,
    'audience', bl.audience,
    'keyIdeas', bl.key_ideas,
    'faq', bl.faq,
    'seoTitle', bl.seo_title,
    'seoDescription', bl.seo_description,
    'metadataLocale', bl.locale,
    'alternateSlugs', coalesce((select jsonb_object_agg(other.locale, other.slug) from public.book_localizations other where other.book_id = b.id and other.locale <> p_locale), '{}'::jsonb),
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
$$;

-- Search ranks books of the resolved editions, under the resolved metadata, deterministically.
CREATE OR REPLACE FUNCTION public.search_catalog(p_locale text, p_query text)
 RETURNS TABLE(kind text, slug text, name text, score integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_trimmed text := btrim(coalesce(p_query, ''));
  v_query text;
begin
  if not public.is_supported_locale(p_locale) or char_length(v_trimmed) < 2 or char_length(v_trimmed) > 100 then
    return;
  end if;
  v_query := public.catalog_normalize(v_trimmed);

  return query
  with scored as (
    select
      'book'::text as kind,
      bl.slug,
      bl.title as name,
      greatest(
        public.catalog_match_score(bl.title, v_query),
        -- Only a published author lifts their books, the same gate as catalog_book_cards.
        case
          when a.status = 'published' and public.catalog_normalize(coalesce(al.name, a.display_name)) = v_query then 3
          else 0
        end
      ) as score
    from public.books b
    join public.catalog_resolved_editions(p_locale) r on r.book_id = b.id
    join lateral public.catalog_book_metadata(b.id, p_locale) bl on true
    join public.authors a on a.id = b.primary_author_id
    left join public.author_localizations al on al.author_id = a.id and al.locale = p_locale
    where b.status = 'published'

    union all

    select 'author'::text, l.slug, l.name, public.catalog_match_score(l.name, v_query)
    from public.author_localizations l
    join public.authors a on a.id = l.author_id
    where l.locale = p_locale
      and a.status = 'published'
      and public.catalog_has_visible_book('author', a.id, p_locale)

    union all

    select 'series'::text, l.slug, l.name, public.catalog_match_score(l.name, v_query)
    from public.series_localizations l
    join public.series s on s.id = l.series_id
    where l.locale = p_locale
      and s.status = 'published'
      and public.catalog_has_visible_book('series', s.id, p_locale)

    union all

    select 'topic'::text, l.slug, l.name, public.catalog_match_score(l.name, v_query)
    from public.topic_localizations l
    join public.topics t on t.id = l.topic_id
    where l.locale = p_locale
      and t.status = 'published'
      and public.catalog_has_visible_book('topic', t.id, p_locale)

    union all

    select
      'idea'::text,
      l.slug,
      l.question,
      greatest(public.catalog_match_score(l.question, v_query), public.catalog_match_score(l.short_answer, v_query))
    from public.idea_localizations l
    join public.ideas i on i.id = l.idea_id
    where l.locale = p_locale
      and i.status = 'published'

    union all

    select
      'article'::text,
      l.slug,
      l.title,
      greatest(public.catalog_match_score(l.title, v_query), public.catalog_match_score(l.excerpt, v_query))
    from public.article_localizations l
    join public.articles a on a.id = l.article_id
    where l.locale = p_locale
      and a.status = 'published'
  ),
  ranked as (
    select
      s.kind,
      s.slug,
      s.name,
      s.score,
      row_number() over (partition by s.kind order by s.score desc, s.name, s.slug) as kind_rank
    from scored s
    where s.score > 0
  )
  select r.kind, r.slug, r.name, r.score
  from ranked r
  where r.kind_rank <= 20
  order by r.score desc, r.kind, r.name, r.slug;
end;
$function$;

-- Recommendations draw from the same resolved set.
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
    from public.bundle_books bb
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
          select 1 from public.bundle_books bb
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
