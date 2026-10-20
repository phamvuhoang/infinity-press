-- Third review pass.
--
--   * Metadata fallback on every entity (spec section 5, A12). Authors, series, topics, ideas and
--     articles are shown with ONE whole localization: the requested locale's row, else the platform
--     default metadata locale's. A slug resolves only under that chosen row, and every page reports
--     metadataLocale, exactly as books do through catalog_book_metadata. Bundles follow the same rule
--     in lib/data/public-bundles.ts.
--   * A work is visible in a locale when the catalog rule gives it an edition AND a copy; the entity
--     pages, home topics, cards, search and knowledge links all ask that one question.
--   * A language default must be a published, unblocked edition.
--   * The storefront can read editorial_state, so the one sellable rule holds in TypeScript too.
--   * The feedback rate limit is serialized per reader.
--   * The database no longer admits 'sepay' as the payment provider.

create function public.default_metadata_locale()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.default_metadata_locale from public.platform_settings s;
$$;
revoke all on function public.default_metadata_locale() from public;
grant execute on function public.default_metadata_locale() to anon, authenticated, service_role;

-- ---- catalog entities: one copy per published author, series or topic ---------------------------
-- p_entity_id narrows the scan to one entity for the per-row callers (cards, bylines, topic refs);
-- the set-wise callers (pages, search, sitemap) leave it null.
create function public.catalog_entity_copy(p_kind text, p_locale text, p_entity_id uuid default null)
returns table(entity_id uuid, locale text, slug text, name text, description text, quote text)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct on (c.entity_id) c.entity_id, c.locale, c.slug, c.name, c.description, c.quote
  from (
    select a.id as entity_id, l.locale, l.slug, l.name, l.description, l.quote
    from public.author_localizations l
    join public.authors a on a.id = l.author_id and a.status = 'published'
    where p_kind = 'author' and (p_entity_id is null or l.author_id = p_entity_id)
    union all
    select s.id, l.locale, l.slug, l.name, l.description, null
    from public.series_localizations l
    join public.series s on s.id = l.series_id and s.status = 'published'
    where p_kind = 'series' and (p_entity_id is null or l.series_id = p_entity_id)
    union all
    select t.id, l.locale, l.slug, l.name, l.description, null
    from public.topic_localizations l
    join public.topics t on t.id = l.topic_id and t.status = 'published'
    where p_kind = 'topic' and (p_entity_id is null or l.topic_id = p_entity_id)
  ) c
  where c.locale in (p_locale, public.default_metadata_locale())
  order by c.entity_id, (c.locale = p_locale) desc;
$$;
revoke all on function public.catalog_entity_copy(text, text, uuid) from public, anon, authenticated;

-- A work is visible in a locale when the catalog rule shows it there: a readable edition and a copy.
-- Called once per entity per row by cards, bylines, topic refs and search, so it is one indexed
-- query with the resolution rule written out, not a chain of definer functions (none of which the
-- planner can inline: `set search_path` forbids it). The rule itself is catalog_resolved_editions +
-- catalog_book_metadata; press_metadata_fallback.sql pins that the two agree.
create or replace function public.catalog_has_visible_book(p_kind text, p_entity_id uuid, p_locale text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.books b
    where b.status = 'published'
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
      -- a readable edition: the locale's default, else the effective default language's (sellable)
      and exists (
        select 1
        from public.book_language_editions ble
        join public.editions e on e.id = ble.edition_id
        join public.ebook_publications pub on pub.id = e.active_publication_id and pub.status = 'published'
        where ble.book_id = b.id
          and e.status = 'published' and e.editorial_state <> 'blocked'
          and ble.language_code in (p_locale, coalesce(b.default_content_language, (select s.default_content_language from public.platform_settings s)))
      )
      -- a copy: the locale's, the platform default's, or the original language's
      and exists (
        select 1 from public.book_localizations bl
        where bl.book_id = b.id
          and bl.locale in (p_locale, (select s.default_metadata_locale from public.platform_settings s), b.original_language)
      )
  );
$$;

create or replace function public.catalog_entity_page(p_kind text, p_locale text, p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', c.entity_id,
    'name', c.name,
    'description', c.description,
    'quote', c.quote,
    'metadataLocale', c.locale,
    -- Every other locale whose own page would show a visible book; the chosen locale stays in so a
    -- fallback page can name its canonical.
    'alternateSlugs', coalesce((
      select jsonb_object_agg(o.locale, o.slug)
      from (
        select l.locale, l.slug from public.author_localizations l where p_kind = 'author' and l.author_id = c.entity_id
        union all
        select l.locale, l.slug from public.series_localizations l where p_kind = 'series' and l.series_id = c.entity_id
        union all
        select l.locale, l.slug from public.topic_localizations l where p_kind = 'topic' and l.topic_id = c.entity_id
      ) o
      where o.locale <> p_locale and public.catalog_has_visible_book(p_kind, c.entity_id, o.locale)
    ), '{}'::jsonb),
    'imagePath', img.storage_key,
    'imageAlt', img.alt_text
  )
  from public.catalog_entity_copy(p_kind, p_locale) c
  left join lateral (
    select m.storage_key, m.alt_text
    from public.media_assets m
    where p_kind = 'author' and m.owner_type = 'author' and m.kind = 'author_image' and m.owner_id = c.entity_id
    limit 1
  ) img on true
  where public.is_supported_locale(p_locale)
    and c.slug = p_slug
    and public.catalog_has_visible_book(p_kind, c.entity_id, p_locale)
  limit 1;
$$;

create or replace function public.catalog_home_topics(p_locale text)
returns table (slug text, name text, description text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.slug, c.name, c.description
  from public.catalog_entity_copy('topic', p_locale) c
  where public.catalog_has_visible_book('topic', c.entity_id, p_locale)
  order by c.name;
$$;

-- The entity pages a locale prerenders and lists in its sitemap: those with their OWN copy. A page
-- shown under another locale's copy is that locale's page, not a duplicate here.
create function public.catalog_entity_slugs(p_locale text)
returns table(kind text, slug text)
language sql
stable
security definer
set search_path = ''
as $$
  select k.kind, c.slug
  from unnest(array['author', 'series', 'topic']) as k(kind)
  cross join lateral public.catalog_entity_copy(k.kind, p_locale) c
  where c.locale = p_locale and public.catalog_has_visible_book(k.kind, c.entity_id, p_locale)
  order by k.kind, c.slug;
$$;
revoke all on function public.catalog_entity_slugs(text) from public;
grant execute on function public.catalog_entity_slugs(text) to anon, authenticated, service_role;

-- Cards name their author, series and topics by the same copy rule as the entity pages.
create or replace function public.catalog_book_card_rows(p_locale text, p_book_id uuid default null)
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
      select jsonb_agg(jsonb_build_object('slug', tc.slug, 'name', tc.name) order by tc.name)
      from public.book_topics bt
      join lateral public.catalog_entity_copy('topic', p_locale, bt.topic_id) tc on true
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
  left join lateral public.catalog_entity_copy('author', p_locale, a.id) al on true
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
    select sc.slug, sc.name, bs.position
    from public.book_series bs
    join lateral public.catalog_entity_copy('series', p_locale, bs.series_id) sc on true
    where bs.book_id = b.id
  ) series on true
  where b.status = 'published' and (p_book_id is null or b.id = p_book_id)
    and public.is_supported_locale(p_locale);
$$;

-- ---- knowledge: one copy per published idea or article --------------------------------------------
create function public.knowledge_idea_copy(p_locale text)
returns table(
  idea_id uuid, locale text, slug text, question text, short_answer text, body_blocks jsonb,
  seo_title text, seo_description text, updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct on (l.idea_id)
    l.idea_id, l.locale, l.slug, l.question, l.short_answer, l.body_blocks, l.seo_title, l.seo_description, l.updated_at
  from public.idea_localizations l
  join public.ideas i on i.id = l.idea_id and i.status = 'published'
  where l.locale in (p_locale, public.default_metadata_locale())
  order by l.idea_id, (l.locale = p_locale) desc;
$$;
revoke all on function public.knowledge_idea_copy(text) from public, anon, authenticated;

create function public.knowledge_article_copy(p_locale text)
returns table(
  article_id uuid, locale text, slug text, title text, excerpt text, body_blocks jsonb,
  seo_title text, seo_description text, updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct on (l.article_id)
    l.article_id, l.locale, l.slug, l.title, l.excerpt, l.body_blocks, l.seo_title, l.seo_description, l.updated_at
  from public.article_localizations l
  join public.articles a on a.id = l.article_id and a.status = 'published'
  where l.locale in (p_locale, public.default_metadata_locale())
  order by l.article_id, (l.locale = p_locale) desc;
$$;
revoke all on function public.knowledge_article_copy(text) from public, anon, authenticated;

create or replace function public.knowledge_topic_refs(p_kind text, p_entity_id uuid, p_locale text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(jsonb_build_object('slug', tc.slug, 'name', tc.name) order by tc.name, tc.slug),
    '[]'::jsonb
  )
  from (
    select it.topic_id from public.idea_topics it where p_kind = 'idea' and it.idea_id = p_entity_id
    union
    select atp.topic_id from public.article_topics atp where p_kind = 'article' and atp.article_id = p_entity_id
  ) linked
  join lateral public.catalog_entity_copy('topic', p_locale, linked.topic_id) tc on true
  where public.catalog_has_visible_book('topic', tc.entity_id, p_locale);
$$;

create or replace function public.knowledge_article_author(p_author_id uuid, p_locale text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'name', coalesce(al.name, a.display_name),
    'slug', case
      when al.slug is not null and public.catalog_has_visible_book('author', a.id, p_locale) then al.slug
    end
  )
  from public.authors a
  left join lateral public.catalog_entity_copy('author', p_locale, a.id) al on true
  where a.id = p_author_id;
$$;

-- The index functions gain metadata_locale as a TABLE column: drop, create, grant again.
drop function public.knowledge_idea_index(text);
create function public.knowledge_idea_index(p_locale text)
returns table (
  idea_id uuid, slug text, question text, short_answer text,
  created_at timestamptz, updated_at timestamptz, alternate_slugs jsonb, topics jsonb, metadata_locale text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    i.id,
    l.slug,
    l.question,
    l.short_answer,
    i.created_at,
    l.updated_at,
    coalesce((select jsonb_object_agg(o.locale, o.slug) from public.idea_localizations o
              where o.idea_id = i.id and o.locale <> p_locale), '{}'::jsonb),
    public.knowledge_topic_refs('idea', i.id, p_locale),
    l.locale
  from public.knowledge_idea_copy(p_locale) l
  join public.ideas i on i.id = l.idea_id
  order by l.question, i.id;
$$;
revoke all on function public.knowledge_idea_index(text) from public;
grant execute on function public.knowledge_idea_index(text) to anon, authenticated, service_role;

drop function public.knowledge_article_index(text);
create function public.knowledge_article_index(p_locale text)
returns table (
  article_id uuid, slug text, title text, excerpt text,
  published_at timestamptz, updated_at timestamptz, alternate_slugs jsonb, author jsonb, metadata_locale text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    a.id,
    l.slug,
    l.title,
    l.excerpt,
    coalesce(a.published_at, a.created_at),
    l.updated_at,
    coalesce((select jsonb_object_agg(o.locale, o.slug) from public.article_localizations o
              where o.article_id = a.id and o.locale <> p_locale), '{}'::jsonb),
    public.knowledge_article_author(a.author_id, p_locale),
    l.locale
  from public.knowledge_article_copy(p_locale) l
  join public.articles a on a.id = l.article_id
  order by coalesce(a.published_at, a.created_at) desc, a.id;
$$;
revoke all on function public.knowledge_article_index(text) from public;
grant execute on function public.knowledge_article_index(text) to anon, authenticated, service_role;

create or replace function public.knowledge_idea_page(p_locale text, p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'ideaId', i.id,
    'slug', l.slug,
    'question', l.question,
    'shortAnswer', l.short_answer,
    'bodyBlocks', l.body_blocks,
    'seoTitle', l.seo_title,
    'seoDescription', l.seo_description,
    'createdAt', i.created_at,
    'updatedAt', l.updated_at,
    'metadataLocale', l.locale,
    'alternateSlugs', coalesce((
      select jsonb_object_agg(o.locale, o.slug) from public.idea_localizations o where o.idea_id = i.id and o.locale <> p_locale
    ), '{}'::jsonb),
    'bookIds', coalesce((
      select jsonb_agg(ib.book_id order by ib.position)
      from public.idea_books ib
      join public.books b on b.id = ib.book_id and b.status = 'published'
      where ib.idea_id = i.id
        and exists (select 1 from public.catalog_resolved_editions(p_locale, b.id))
        and exists (select 1 from public.catalog_book_metadata(b.id, p_locale))
    ), '[]'::jsonb),
    'relatedIdeaIds', coalesce((
      select jsonb_agg(il.related_idea_id order by il.position)
      from public.idea_links il
      join public.knowledge_idea_copy(p_locale) rl on rl.idea_id = il.related_idea_id
      where il.idea_id = i.id
    ), '[]'::jsonb),
    'topics', public.knowledge_topic_refs('idea', i.id, p_locale)
  )
  from public.knowledge_idea_copy(p_locale) l
  join public.ideas i on i.id = l.idea_id
  where l.slug = p_slug;
$$;

create or replace function public.knowledge_article_page(p_locale text, p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'articleId', a.id,
    'slug', l.slug,
    'title', l.title,
    'excerpt', l.excerpt,
    'bodyBlocks', l.body_blocks,
    'seoTitle', l.seo_title,
    'seoDescription', l.seo_description,
    'publishedAt', coalesce(a.published_at, a.created_at),
    'updatedAt', l.updated_at,
    'metadataLocale', l.locale,
    'alternateSlugs', coalesce((
      select jsonb_object_agg(o.locale, o.slug) from public.article_localizations o where o.article_id = a.id and o.locale <> p_locale
    ), '{}'::jsonb),
    'author', public.knowledge_article_author(a.author_id, p_locale),
    'bookIds', coalesce((
      select jsonb_agg(ab.book_id order by ab.position)
      from public.article_books ab
      join public.books b on b.id = ab.book_id and b.status = 'published'
      where ab.article_id = a.id
        and exists (select 1 from public.catalog_resolved_editions(p_locale, b.id))
        and exists (select 1 from public.catalog_book_metadata(b.id, p_locale))
    ), '[]'::jsonb),
    'ideaIds', coalesce((
      select jsonb_agg(ai.idea_id order by ai.position)
      from public.article_ideas ai
      join public.knowledge_idea_copy(p_locale) il on il.idea_id = ai.idea_id
      where ai.article_id = a.id
    ), '[]'::jsonb),
    'topics', public.knowledge_topic_refs('article', a.id, p_locale)
  )
  from public.knowledge_article_copy(p_locale) l
  join public.articles a on a.id = l.article_id
  where l.slug = p_slug;
$$;

create or replace function public.knowledge_for_book(p_locale text, p_book_id uuid)
returns table (kind text, slug text, title text, excerpt text, published_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select k.kind, k.slug, k.title, k.excerpt, k.published_at
  from (
    select 1 as grp, 'idea'::text as kind, l.slug, l.question as title, l.short_answer as excerpt,
      null::timestamptz as published_at, l.idea_id as id
    from public.idea_books ib
    join public.knowledge_idea_copy(p_locale) l on l.idea_id = ib.idea_id
    where ib.book_id = p_book_id

    union all

    select 2, 'article'::text, l.slug, l.title, l.excerpt, coalesce(a.published_at, a.created_at), a.id
    from public.article_books ab
    join public.knowledge_article_copy(p_locale) l on l.article_id = ab.article_id
    join public.articles a on a.id = l.article_id
    where ab.book_id = p_book_id
  ) k
  where exists (select 1 from public.catalog_resolved_editions(p_locale, p_book_id))
    and exists (select 1 from public.catalog_book_metadata(p_book_id, p_locale))
  order by k.grp, case when k.grp = 1 then k.title end, k.published_at desc nulls last, k.id;
$$;

create or replace function public.knowledge_for_topic(p_locale text, p_topic_id uuid)
returns table (kind text, slug text, title text, excerpt text, published_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select k.kind, k.slug, k.title, k.excerpt, k.published_at
  from (
    select 1 as grp, 'idea'::text as kind, l.slug, l.question as title, l.short_answer as excerpt,
      null::timestamptz as published_at, l.idea_id as id
    from public.idea_topics it
    join public.knowledge_idea_copy(p_locale) l on l.idea_id = it.idea_id
    where it.topic_id = p_topic_id

    union all

    select 2, 'article'::text, l.slug, l.title, l.excerpt, coalesce(a.published_at, a.created_at), a.id
    from public.article_topics atp
    join public.knowledge_article_copy(p_locale) l on l.article_id = atp.article_id
    join public.articles a on a.id = l.article_id
    where atp.topic_id = p_topic_id
  ) k
  where exists (select 1 from public.catalog_entity_copy('topic', p_locale) tc where tc.entity_id = p_topic_id)
  order by k.grp, case when k.grp = 1 then k.title end, k.published_at desc nulls last, k.id;
$$;

-- ---- search: the same copy the pages show ---------------------------------------------------------
create or replace function public.search_catalog(p_locale text, p_query text)
returns table (kind text, slug text, name text, score integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
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
    join lateral public.catalog_book_metadata(b.id, p_locale) bl on true
    join public.authors a on a.id = b.primary_author_id
    left join lateral public.catalog_entity_copy('author', p_locale, a.id) al on true
    where b.status = 'published'
      and exists (select 1 from public.catalog_resolved_editions(p_locale, b.id))

    union all

    select 'author'::text, c.slug, c.name, public.catalog_match_score(c.name, v_query)
    from public.catalog_entity_copy('author', p_locale) c
    where public.catalog_has_visible_book('author', c.entity_id, p_locale)

    union all

    select 'series'::text, c.slug, c.name, public.catalog_match_score(c.name, v_query)
    from public.catalog_entity_copy('series', p_locale) c
    where public.catalog_has_visible_book('series', c.entity_id, p_locale)

    union all

    select 'topic'::text, c.slug, c.name, public.catalog_match_score(c.name, v_query)
    from public.catalog_entity_copy('topic', p_locale) c
    where public.catalog_has_visible_book('topic', c.entity_id, p_locale)

    union all

    select
      'idea'::text,
      l.slug,
      l.question,
      greatest(public.catalog_match_score(l.question, v_query), public.catalog_match_score(l.short_answer, v_query))
    from public.knowledge_idea_copy(p_locale) l

    union all

    select
      'article'::text,
      l.slug,
      l.title,
      greatest(public.catalog_match_score(l.title, v_query), public.catalog_match_score(l.excerpt, v_query))
    from public.knowledge_article_copy(p_locale) l
  ),
  ranked as (
    select
      s.kind,
      s.slug,
      s.name,
      s.score,
      row_number() over (partition by s.kind order by s.score desc, s.name) as kind_rank
    from scored s
    where s.score > 0
  )
  select r.kind, r.slug, r.name, r.score
  from ranked r
  where r.kind_rank <= 20
  order by r.score desc, r.kind, r.name;
end;
$$;

-- ---- a language default is a published, unblocked edition ----------------------------------------
create or replace function public.admin_set_default_edition(p_book_id uuid, p_language_code text, p_edition_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_set_default_edition: caller is not an admin' using errcode = '42501';
  end if;
  -- A draft, archived or blocked default would hide the work from its language entirely, even
  -- while another edition of that language is live.
  if exists (
    select 1 from public.editions e
    where e.id = p_edition_id and (e.status <> 'published' or e.editorial_state = 'blocked')
  ) then
    raise exception 'admin_set_default_edition: edition % is not a published, unblocked edition', p_edition_id using errcode = 'EB012';
  end if;
  -- The composite foreign key rejects an edition of another book or language (23503).
  insert into public.book_language_editions (book_id, language_code, edition_id)
  values (p_book_id, p_language_code, p_edition_id)
  on conflict (book_id, language_code) do update set edition_id = excluded.edition_id;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'set_default_edition', 'books', p_book_id,
          jsonb_build_object('language_code', p_language_code, 'edition_id', p_edition_id));
end;
$$;

-- ---- the storefront reads editorial_state (not the evidence) -------------------------------------
grant select (editorial_state) on public.editions to anon, authenticated;

-- ---- feedback: the rate limit is counted under a per-reader lock ------------------------------------
create or replace function public.submit_edition_feedback(p_publication_id uuid, p_locator jsonb, p_message text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_edition_id uuid;
  v_id uuid;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'submit_edition_feedback: no profile for the current session' using errcode = 'P0002';
  end if;
  if p_message is null or length(btrim(p_message)) < 1 or length(btrim(p_message)) > 2000 or p_message ~* '</?[a-z][^>]*>' then
    raise exception 'submit_edition_feedback: the message must be 1..2000 characters of plain text' using errcode = '22023';
  end if;
  if p_locator is not null and (jsonb_typeof(p_locator) <> 'object' or length(p_locator::text) > 2000
      or (p_locator ? 'href' and (jsonb_typeof(p_locator -> 'href') <> 'string' or length(p_locator ->> 'href') > 500))) then
    raise exception 'submit_edition_feedback: the location is not valid' using errcode = '22023';
  end if;

  v_edition_id := public.reader_edition_for_publication(v_profile_id, p_publication_id);
  if v_edition_id is null then
    raise exception 'submit_edition_feedback: no readable publication %', p_publication_id using errcode = 'EB008';
  end if;

  -- Concurrent reports from one reader count each other: the limit is checked and the row written
  -- under the same lock.
  perform pg_advisory_xact_lock(hashtextextended('submit_edition_feedback:' || v_profile_id::text, 0));

  if (select count(*) from public.edition_feedback f where f.profile_id = v_profile_id and f.created_at > now() - interval '1 hour') >= 5
     or (select count(*) from public.edition_feedback f where f.profile_id = v_profile_id and f.created_at > now() - interval '1 day') >= 20 then
    raise exception 'submit_edition_feedback: too many reports' using errcode = 'EB045';
  end if;

  insert into public.edition_feedback (edition_id, publication_id, profile_id, locator, message)
  values (v_edition_id, p_publication_id, v_profile_id, p_locator, btrim(p_message))
  returning id into v_id;
  return v_id;
end;
$$;

-- ---- no SePay provider in the database ------------------------------------------------------------
-- Press never pays through SePay (spec section 8). A settings row that still names it stops this
-- migration rather than being rewritten; an operator sets 'manual' first.
alter table public.commerce_settings drop constraint commerce_settings_payment_provider_check;
alter table public.commerce_settings
  add constraint commerce_settings_payment_provider_check
  check (payment_provider in ('simulator', 'manual'));
