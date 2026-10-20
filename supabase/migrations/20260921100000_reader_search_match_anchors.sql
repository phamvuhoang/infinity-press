-- Match-centered search anchors; compatible replacement for already-applied search RPCs.
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
  with eligible_chunks as (
    select chunk.*
    from public.ebook_search_chunks chunk
    join public.ebook_resources resource
      on resource.publication_id = chunk.publication_id
     and resource.href = chunk.href
     and resource.media_type = 'application/xhtml+xml'
    join public.ebook_publications publication
      on publication.id = chunk.publication_id
    where chunk.publication_id = p_publication_id
      and exists (
        select 1
        from jsonb_array_elements(coalesce(publication.positions_json, '[]'::jsonb)) position
        where position ->> 'href' = chunk.href
      )
  ), matches as (
    select chunk.*, 1 as match_tier, ts_rank_cd(chunk.search_document, v_exact_query) as match_rank
    from eligible_chunks chunk
    where chunk.search_document @@ v_exact_query
    union all
    select chunk.*, 2 as match_tier, ts_rank_cd(chunk.normalized_search_document, v_normalized_token_query) as match_rank
    from eligible_chunks chunk
    where chunk.normalized_search_document @@ v_normalized_token_query
      and not (chunk.search_document @@ v_exact_query)
    union all
    select chunk.*, 3 as match_tier, extensions.word_similarity(v_normalized_query, chunk.normalized_text) as match_rank
    from eligible_chunks chunk
    where extensions.word_similarity(v_normalized_query, chunk.normalized_text) >= 0.6
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
  ), anchored as (
    -- unaccent can expand characters (ß -> ss). Translate the normalized match position back
    -- to the original Unicode character, keeping the DOM selector's offset in original text.
    select bounded.*, coalesce((
      select min(original_offset)
      from generate_series(1, char_length(bounded.plain_text)) original_offset
      where char_length(public.catalog_normalize(left(bounded.plain_text, original_offset))) >= bounded.matched_start
    ), 1) as original_start
    from bounded
  )
  select anchored.chapter_title,
    substring(anchored.plain_text from greatest(1, anchored.original_start - 100) for 240) as excerpt,
    (anchored.locator_json - 'text' - 'locations') || jsonb_build_object(
      'locations', (anchored.locator_json -> 'locations') ||
        case when anchored.locator_json #>> '{locations,textOffset}' is not null
          then jsonb_build_object('textOffset', (anchored.locator_json #>> '{locations,textOffset}')::integer + anchored.original_start - 1)
          else '{}'::jsonb end,
      'text', jsonb_strip_nulls(jsonb_build_object(
        'before', nullif(substring(anchored.plain_text from greatest(1, anchored.original_start - 64) for least(64, anchored.original_start - 1)), ''),
        'highlight', substring(anchored.plain_text from anchored.original_start for 160),
        'after', nullif(substring(anchored.plain_text from anchored.original_start + 160 for 64), '')
      ))
    ) as locator_json
  from anchored
  order by anchored.match_tier, anchored.match_rank desc, anchored.ordinal;
end;
$$;

revoke execute on function public.search_reader_publication(uuid, uuid, text) from public, anon;
grant execute on function public.search_reader_publication(uuid, uuid, text) to authenticated;
