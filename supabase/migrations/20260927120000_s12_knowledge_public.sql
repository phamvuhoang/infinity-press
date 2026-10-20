-- S12: the published knowledge read model and knowledge search
-- (docs/superpowers/specs/2026-09-21-s12-knowledge-hub-design.md sections 7 and 8, plan Task 5).
--
-- Public pages read ideas and articles only through these functions, with the cookie-less public
-- client. Like the catalog reads of 20260915100000, each function filters status and locale
-- itself: an admin caller reads drafts under the RLS policies of 20260927100000, so an explicit
-- filter is the only way an admin sees the same storefront as everyone else.
--
-- A missing localization never falls back to the other locale. Relation arrays keep the editorial
-- position and drop any target that is not published and localized in the requested locale, so a
-- page never links to a 404. Detail functions return ids for books and ideas; lib/data/knowledge.ts
-- maps them to the existing public book cards and to published idea summaries.

-- Internal helpers -----------------------------------------------------------------------------

-- The topics an idea or article may link to in p_locale: published, localized, and with at least
-- one visible book, which is the same gate catalog_entity_page puts on a topic page.
create function public.knowledge_topic_refs(p_kind text, p_entity_id uuid, p_locale text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(jsonb_build_object('slug', tl.slug, 'name', tl.name) order by tl.name, tl.slug),
    '[]'::jsonb
  )
  from public.topics t
  join public.topic_localizations tl on tl.topic_id = t.id and tl.locale = p_locale
  where t.status = 'published'
    and case p_kind
      when 'idea' then exists (
        select 1 from public.idea_topics it where it.idea_id = p_entity_id and it.topic_id = t.id
      )
      when 'article' then exists (
        select 1 from public.article_topics atp where atp.article_id = p_entity_id and atp.topic_id = t.id
      )
      else false
    end
    and public.catalog_has_visible_book('topic', t.id, p_locale);
$$;

-- The byline of an article in p_locale. The name follows catalog_book_cards: the localized name of
-- a published author, otherwise the display name. The slug is set only when the author page
-- exists in this locale (published, localized, and holding a visible book).
create function public.knowledge_article_author(p_author_id uuid, p_locale text)
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
  left join public.author_localizations al
    on al.author_id = a.id and al.locale = p_locale and a.status = 'published'
  where a.id = p_author_id;
$$;

-- Indexes --------------------------------------------------------------------------------------

-- One row per published idea localized in p_locale, ordered by question then id. TypeScript groups
-- the rows by topic: an idea sits under every topic in `topics`, or under Other when it is empty.
create function public.knowledge_idea_index(p_locale text)
returns table (
  idea_id uuid,
  slug text,
  question text,
  short_answer text,
  created_at timestamptz,
  updated_at timestamptz,
  alternate_slug text,
  topics jsonb
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
    (select o.slug from public.idea_localizations o where o.idea_id = i.id and o.locale <> l.locale),
    public.knowledge_topic_refs('idea', i.id, l.locale)
  from public.ideas i
  join public.idea_localizations l on l.idea_id = i.id and l.locale = p_locale
  where i.status = 'published'
  order by l.question, i.id;
$$;

-- One row per published article localized in p_locale, newest first. published_at is set on the
-- first publish and preserved; created_at only covers rows written outside publish_article.
create function public.knowledge_article_index(p_locale text)
returns table (
  article_id uuid,
  slug text,
  title text,
  excerpt text,
  published_at timestamptz,
  updated_at timestamptz,
  alternate_slug text,
  author jsonb
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
    (select o.slug from public.article_localizations o where o.article_id = a.id and o.locale <> l.locale),
    public.knowledge_article_author(a.author_id, l.locale)
  from public.articles a
  join public.article_localizations l on l.article_id = a.id and l.locale = p_locale
  where a.status = 'published'
  order by coalesce(a.published_at, a.created_at) desc, a.id;
$$;

-- Details --------------------------------------------------------------------------------------

-- Null when the slug does not name a published idea localized in p_locale.
create function public.knowledge_idea_page(p_locale text, p_slug text)
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
    'alternateSlug', (
      select o.slug from public.idea_localizations o where o.idea_id = i.id and o.locale <> l.locale
    ),
    'bookIds', coalesce((
      select jsonb_agg(ib.book_id order by ib.position)
      from public.idea_books ib
      join public.books b on b.id = ib.book_id and b.status = 'published'
      join public.book_localizations bl on bl.book_id = b.id and bl.locale = l.locale
      where ib.idea_id = i.id
    ), '[]'::jsonb),
    'relatedIdeaIds', coalesce((
      select jsonb_agg(il.related_idea_id order by il.position)
      from public.idea_links il
      join public.ideas r on r.id = il.related_idea_id and r.status = 'published'
      join public.idea_localizations rl on rl.idea_id = r.id and rl.locale = l.locale
      where il.idea_id = i.id
    ), '[]'::jsonb),
    'topics', public.knowledge_topic_refs('idea', i.id, l.locale)
  )
  from public.idea_localizations l
  join public.ideas i on i.id = l.idea_id
  where l.locale = p_locale and l.slug = p_slug and i.status = 'published';
$$;

-- Null when the slug does not name a published article localized in p_locale.
create function public.knowledge_article_page(p_locale text, p_slug text)
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
    'alternateSlug', (
      select o.slug from public.article_localizations o where o.article_id = a.id and o.locale <> l.locale
    ),
    'author', public.knowledge_article_author(a.author_id, l.locale),
    'bookIds', coalesce((
      select jsonb_agg(ab.book_id order by ab.position)
      from public.article_books ab
      join public.books b on b.id = ab.book_id and b.status = 'published'
      join public.book_localizations bl on bl.book_id = b.id and bl.locale = l.locale
      where ab.article_id = a.id
    ), '[]'::jsonb),
    'ideaIds', coalesce((
      select jsonb_agg(ai.idea_id order by ai.position)
      from public.article_ideas ai
      join public.ideas i on i.id = ai.idea_id and i.status = 'published'
      join public.idea_localizations il on il.idea_id = i.id and il.locale = l.locale
      where ai.article_id = a.id
    ), '[]'::jsonb),
    'topics', public.knowledge_topic_refs('article', a.id, l.locale)
  )
  from public.article_localizations l
  join public.articles a on a.id = l.article_id
  where l.locale = p_locale and l.slug = p_slug and a.status = 'published';
$$;

-- Backlinks ------------------------------------------------------------------------------------

-- The published ideas and articles, localized in p_locale, that reference a published book or
-- topic localized in p_locale. Ideas come first, by question then id, and use their question as
-- title and short answer as excerpt (published_at is null); then articles, newest first, then id.
create function public.knowledge_for_book(p_locale text, p_book_id uuid)
returns table (kind text, slug text, title text, excerpt text, published_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select k.kind, k.slug, k.title, k.excerpt, k.published_at
  from (
    select 1 as grp, 'idea'::text as kind, l.slug, l.question as title, l.short_answer as excerpt,
      null::timestamptz as published_at, i.id
    from public.idea_books ib
    join public.ideas i on i.id = ib.idea_id and i.status = 'published'
    join public.idea_localizations l on l.idea_id = i.id and l.locale = p_locale
    where ib.book_id = p_book_id

    union all

    select 2, 'article'::text, l.slug, l.title, l.excerpt, coalesce(a.published_at, a.created_at), a.id
    from public.article_books ab
    join public.articles a on a.id = ab.article_id and a.status = 'published'
    join public.article_localizations l on l.article_id = a.id and l.locale = p_locale
    where ab.book_id = p_book_id
  ) k
  where exists (
    select 1 from public.books b
    join public.book_localizations bl on bl.book_id = b.id and bl.locale = p_locale
    where b.id = p_book_id and b.status = 'published'
  )
  order by k.grp, case when k.grp = 1 then k.title end, k.published_at desc nulls last, k.id;
$$;

create function public.knowledge_for_topic(p_locale text, p_topic_id uuid)
returns table (kind text, slug text, title text, excerpt text, published_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select k.kind, k.slug, k.title, k.excerpt, k.published_at
  from (
    select 1 as grp, 'idea'::text as kind, l.slug, l.question as title, l.short_answer as excerpt,
      null::timestamptz as published_at, i.id
    from public.idea_topics it
    join public.ideas i on i.id = it.idea_id and i.status = 'published'
    join public.idea_localizations l on l.idea_id = i.id and l.locale = p_locale
    where it.topic_id = p_topic_id

    union all

    select 2, 'article'::text, l.slug, l.title, l.excerpt, coalesce(a.published_at, a.created_at), a.id
    from public.article_topics atp
    join public.articles a on a.id = atp.article_id and a.status = 'published'
    join public.article_localizations l on l.article_id = a.id and l.locale = p_locale
    where atp.topic_id = p_topic_id
  ) k
  where exists (
    select 1 from public.topics t
    join public.topic_localizations tl on tl.topic_id = t.id and tl.locale = p_locale
    where t.id = p_topic_id and t.status = 'published'
  )
  order by k.grp, case when k.grp = 1 then k.title end, k.published_at desc nulls last, k.id;
$$;

-- Search ---------------------------------------------------------------------------------------

-- search_catalog (20260915110000) gains 'idea' and 'article' rows. The book, author, series and
-- topic branches, the query bounds, the per-kind cap of 20 and the final order are unchanged.
-- An idea matches on its question or short answer and is named by its question; an article
-- matches on its title or excerpt and is named by its title. Body blocks are never searched.
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
  if p_locale not in ('vi', 'en') or char_length(v_trimmed) < 2 or char_length(v_trimmed) > 100 then
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
    join public.book_localizations bl on bl.book_id = b.id and bl.locale = p_locale
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

-- Grants ---------------------------------------------------------------------------------------

revoke execute on function public.knowledge_topic_refs(text, uuid, text) from public, anon, authenticated;
revoke execute on function public.knowledge_article_author(uuid, text) from public, anon, authenticated;

revoke execute on function public.knowledge_idea_index(text) from public;
grant execute on function public.knowledge_idea_index(text) to anon, authenticated;
revoke execute on function public.knowledge_idea_page(text, text) from public;
grant execute on function public.knowledge_idea_page(text, text) to anon, authenticated;
revoke execute on function public.knowledge_article_index(text) from public;
grant execute on function public.knowledge_article_index(text) to anon, authenticated;
revoke execute on function public.knowledge_article_page(text, text) from public;
grant execute on function public.knowledge_article_page(text, text) to anon, authenticated;
revoke execute on function public.knowledge_for_book(text, uuid) from public;
grant execute on function public.knowledge_for_book(text, uuid) to anon, authenticated;
revoke execute on function public.knowledge_for_topic(text, uuid) from public;
grant execute on function public.knowledge_for_topic(text, uuid) to anon, authenticated;

revoke execute on function public.search_catalog(text, text) from public;
grant execute on function public.search_catalog(text, text) to anon, authenticated;
