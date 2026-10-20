-- Correct the locally applied S5.5 migration without rewriting its history.
-- CHECK only rejects false, not NULL, so every security-relevant predicate here is explicitly
-- total (true/false) before it is used as a table constraint.

create or replace function public.reader_locator_is_valid(p_locator jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_locator) is distinct from 'object' then false
    when octet_length(p_locator::text) > 16384 then false
    when jsonb_typeof(p_locator -> 'href') is distinct from 'string' then false
    when char_length(btrim(p_locator ->> 'href')) = 0 then false
    when jsonb_typeof(p_locator -> 'progression') is distinct from 'number' then false
    when not ((p_locator ->> 'progression')::numeric between 0 and 1) then false
    when p_locator ? 'totalProgression'
      and jsonb_typeof(p_locator -> 'totalProgression') <> 'null'
      and (jsonb_typeof(p_locator -> 'totalProgression') is distinct from 'number'
        or not ((p_locator ->> 'totalProgression')::numeric between 0 and 1)) then false
    when jsonb_typeof(p_locator -> 'locations') is distinct from 'object' then false
    else true
  end;
$$;

alter table public.reader_annotations
  add constraint reader_annotations_kind_dependent_check check (
    coalesce(
      (kind = 'highlight'
        and selected_text is not null
        and char_length(selected_text) between 1 and 1000
        and jsonb_typeof(locator_json -> 'text') = 'object'
        and jsonb_typeof(locator_json #> '{text,highlight}') = 'string'
        and char_length(locator_json #>> '{text,highlight}') between 1 and 1000
        and locator_json #>> '{text,highlight}' = selected_text
        and color is not null
        and color in ('yellow', 'green', 'rose')
        and (note_text is null or char_length(note_text) <= 5000)
        and label is null)
      or
      (kind = 'bookmark'
        and selected_text is null
        and color is null
        and note_text is null
        and label is not null
        and char_length(btrim(label)) between 1 and 120),
      false
    )
  ),
  add constraint reader_annotations_locator_context_check check (
    coalesce(
      not (locator_json ? 'text')
      or (
        jsonb_typeof(locator_json -> 'text') = 'object'
        and (not (locator_json -> 'text' ? 'before')
          or (jsonb_typeof(locator_json #> '{text,before}') = 'string'
            and char_length(locator_json #>> '{text,before}') <= 64))
        and (not (locator_json -> 'text' ? 'highlight')
          or (jsonb_typeof(locator_json #> '{text,highlight}') = 'string'
            and char_length(locator_json #>> '{text,highlight}') <= 1000))
        and (not (locator_json -> 'text' ? 'after')
          or (jsonb_typeof(locator_json #> '{text,after}') = 'string'
            and char_length(locator_json #>> '{text,after}') <= 64))
      ),
      false
    )
  );

revoke execute on function public.reader_annotations_before_write() from public, anon, authenticated;
revoke execute on function public.ebook_search_chunks_before_write() from public, anon, authenticated;

create or replace function public.search_reader_publication(
  p_session_id uuid,
  p_publication_id uuid,
  p_query text
)
returns table (chapter_title text, excerpt text, locator_json jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authorized record;
  v_query text := btrim(coalesce(p_query, ''));
  v_normalized_query text;
  v_exact_query tsquery;
  v_normalized_token_query tsquery;
begin
  select * into v_authorized from public.authorize_reader_session(p_session_id, p_publication_id);
  if not found or char_length(v_query) not between 2 and 100
     or v_query !~ '[[:alnum:]]' then
    return;
  end if;
  v_normalized_query := public.catalog_normalize(v_query);
  v_exact_query := plainto_tsquery('simple', v_query);
  v_normalized_token_query := plainto_tsquery('simple', v_normalized_query);
  if numnode(v_exact_query) = 0 or numnode(v_normalized_token_query) = 0 then
    return;
  end if;

  return query
  with matches as (
    select chunk.*, 1 as match_tier, ts_rank_cd(chunk.search_document, v_exact_query) as match_rank
    from public.ebook_search_chunks chunk
    where chunk.publication_id = p_publication_id and chunk.search_document @@ v_exact_query
    union all
    select chunk.*, 2 as match_tier, ts_rank_cd(chunk.normalized_search_document, v_normalized_token_query) as match_rank
    from public.ebook_search_chunks chunk
    where chunk.publication_id = p_publication_id
      and chunk.normalized_search_document @@ v_normalized_token_query
      and not (chunk.search_document @@ v_exact_query)
    union all
    select chunk.*, 3 as match_tier, extensions.word_similarity(v_normalized_query, chunk.normalized_text) as match_rank
    from public.ebook_search_chunks chunk
    where chunk.publication_id = p_publication_id
      and extensions.word_similarity(v_normalized_query, chunk.normalized_text) >= 0.6
      and not (chunk.search_document @@ v_exact_query)
      and not (chunk.normalized_search_document @@ v_normalized_token_query)
  ), bounded as (
    select matches.*, coalesce(
      nullif(strpos(matches.normalized_text, v_normalized_query), 0),
      (select min(nullif(strpos(matches.normalized_text, token), 0))
        from regexp_split_to_table(v_normalized_query, '\s+') as token
        where token <> ''),
      (select nullif(strpos(matches.normalized_text, candidate.word), 0)
        from regexp_split_to_table(matches.normalized_text, '[^[:alnum:]]+') as candidate(word)
        where candidate.word <> ''
        order by extensions.similarity(candidate.word, v_normalized_query) desc, candidate.word
        limit 1),
      1
    ) as matched_start
    from matches
    order by match_tier, match_rank desc, ordinal
    limit 50
  )
  select bounded.chapter_title,
    substring(bounded.plain_text from greatest(1, bounded.matched_start - 100) for 240) as excerpt,
    (bounded.locator_json - 'text') || jsonb_build_object('text', jsonb_strip_nulls(jsonb_build_object(
      'before', nullif(left(bounded.locator_json #>> '{text,before}', 64), ''),
      'highlight', nullif(left(bounded.locator_json #>> '{text,highlight}', 160), ''),
      'after', nullif(left(bounded.locator_json #>> '{text,after}', 64), '')
    ))) as locator_json
  from bounded
  order by bounded.match_tier, bounded.match_rank desc, bounded.ordinal;
end;
$$;

revoke execute on function public.search_reader_publication(uuid, uuid, text) from public, anon;
grant execute on function public.search_reader_publication(uuid, uuid, text) to authenticated;
