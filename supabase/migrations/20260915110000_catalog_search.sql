-- S2 catalog search. See docs/superpowers/specs/2026-09-15-s2-public-discovery-design.md (4.5).
--
-- The catalog is small, so there is no index. unaccent() is not immutable, so an expression index
-- would need a wrapper anyway. Revisit when search shows up in slow query logs.

create extension if not exists pg_trgm with schema extensions;

-- "Đắc Nhân Tâm" -> "dac nhan tam". Same unaccent call as admin_create_book (20260913150000).
create function public.catalog_normalize(p_value text)
returns text
language sql
stable
set search_path = ''
as $$
  select lower(extensions.unaccent(coalesce(p_value, '')));
$$;

-- p_query must already be normalized. 3 = exact, 2 = prefix, 1 = contains or close, 0 = no match.
create function public.catalog_match_score(p_name text, p_query text)
returns integer
language sql
stable
set search_path = ''
as $$
  select case
    when n.name = p_query then 3
    when starts_with(n.name, p_query) then 2
    when strpos(n.name, p_query) > 0 or extensions.word_similarity(p_query, n.name) >= 0.4 then 1
    else 0
  end
  from (select public.catalog_normalize(p_name) as name) n;
$$;

create function public.search_catalog(p_locale text, p_query text)
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

revoke execute on function public.catalog_normalize(text) from public, anon, authenticated;
revoke execute on function public.catalog_match_score(text, text) from public, anon, authenticated;

revoke execute on function public.search_catalog(text, text) from public;
grant execute on function public.search_catalog(text, text) to anon, authenticated;
