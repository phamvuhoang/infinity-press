-- S20 passage cards: a shared quote can carry the reader's question, says whether its text is the
-- book's own words, and remembers the ebook_search_chunks ordinal it came from so the public card
-- can open the sample reader there ("Đọc tiếp từ đây").

alter table public.shared_quotes
  add column chunk_ordinal integer,
  add column question text check (char_length(question) <= 280),
  add column text_kind text not null default 'verbatim' check (text_kind in ('verbatim', 'translation', 'paraphrase'));

create or replace function public.shared_quote_json(q public.shared_quotes)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', q.id, 'code', q.code, 'quote', q.quote, 'locale', q.locale,
                            'bookId', q.book_id, 'createdAt', q.created_at,
                            'chunkOrdinal', q.chunk_ordinal, 'question', q.question, 'textKind', q.text_kind);
$$;

-- The three-argument form keeps working through the defaults. Dropped first: a create or replace
-- with more arguments would add an overload and make every three-argument call ambiguous.
drop function public.create_shared_quote(uuid, text, text);

-- Body from 20261021120000_shared_quote_published_book.sql, plus the question, the text kind, the
-- chunk ordinal, and the passage_shared event. An ordinal the publication has no chunk for is
-- stored as null (a share without an anchor), so passage_shared counts only real passages.
create function public.create_shared_quote(
  p_publication_id uuid,
  p_quote text,
  p_locale text,
  p_question text default null,
  p_text_kind text default 'verbatim',
  p_chunk_ordinal integer default null
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_profile_id uuid;
  v_book_id uuid;
  v_edition_id uuid;
  v_quote text := btrim(coalesce(p_quote, ''));
  v_question text := nullif(btrim(coalesce(p_question, '')), '');
  v_ordinal integer;
  v_code text;
  v_row public.shared_quotes;
  v_try integer := 0;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'create_shared_quote: no profile' using errcode = 'EB039';
  end if;
  if length(v_quote) < 1 or length(v_quote) > 1200 or v_quote ~* '</?[a-z][^>]*>'
     or public.shared_quote_graphemes(v_quote) > 300
     or p_locale is null or not public.is_supported_locale(p_locale)
     or char_length(v_question) > 280
     or p_text_kind is null or p_text_kind not in ('verbatim', 'translation', 'paraphrase') then
    raise exception 'create_shared_quote: invalid input' using errcode = 'EB039';
  end if;
  -- The publication must be its edition's live, published one, and the caller must hold THAT edition.
  v_edition_id := public.reader_edition_for_publication(v_profile_id, p_publication_id);
  if v_edition_id is null then
    raise exception 'create_shared_quote: not entitled' using errcode = 'EB039';
  end if;
  select ed.book_id into v_book_id from public.editions ed where ed.id = v_edition_id;
  -- An owner keeps reading after "Unpublish book" (20261021100000_owner_reads_unpublished.sql), but a
  -- public share card needs a published book: catalog_shared_quote would 404 it, so no row is made.
  if not exists (select 1 from public.books b where b.id = v_book_id and b.status = 'published') then
    raise exception 'create_shared_quote: book is not published' using errcode = 'EB039';
  end if;
  select c.ordinal into v_ordinal from public.ebook_search_chunks c
  where c.publication_id = p_publication_id and c.ordinal = p_chunk_ordinal;
  -- Lock the profile so two concurrent shares at the cap cannot both pass the count.
  perform 1 from public.profiles where id = v_profile_id for update;
  if (select count(*) from public.shared_quotes where profile_id = v_profile_id and status = 'active') >= 200 then
    raise exception 'create_shared_quote: cap reached' using errcode = 'EB038';
  end if;
  loop
    v_try := v_try + 1;
    v_code := substr(translate(encode(extensions.gen_random_bytes(8), 'base64'), '+/', '-_'), 1, 10);
    begin
      insert into public.shared_quotes (code, book_id, publication_id, profile_id, quote, locale, question, text_kind, chunk_ordinal)
      values (v_code, v_book_id, p_publication_id, v_profile_id, v_quote, p_locale, v_question, p_text_kind, v_ordinal)
      returning * into v_row;
      exit;
    exception when unique_violation then
      if v_try >= 3 then raise exception 'create_shared_quote: code collision' using errcode = 'EB039'; end if;
    end;
  end loop;
  insert into public.analytics_events (event_name, dedupe_key, profile_id, book_id, locale, shared_quote_id)
  values ('share_quote', 'share/' || v_row.id, v_profile_id, v_book_id, p_locale, v_row.id);
  -- Identifier columns only: never the quote or the question.
  if v_ordinal is not null then
    insert into public.analytics_events (event_name, dedupe_key, profile_id, book_id, publication_id, shared_quote_id)
    values ('passage_shared', 'shared_quote:' || v_row.id || ':passage', v_profile_id, v_book_id, p_publication_id, v_row.id);
  end if;
  return public.shared_quote_json(v_row);
end;
$function$;
revoke execute on function public.create_shared_quote(uuid, text, text, text, text, integer) from public, anon;
grant execute on function public.create_shared_quote(uuid, text, text, text, text, integer) to authenticated;

-- Public: an active card of a published book, plus what the card needs to continue reading.
-- chunkExists: the chunk row is still there. sampleAllowsChunk: sample_chunk_locator would serve it,
-- which also requires the shared publication to still be its edition's live one, so a stale ordinal
-- never opens a different passage of a re-uploaded book. languages: the shared edition first, then
-- each sellable edition whose live publication has a passage aligned with this chunk, with the ordinal to
-- open there and whether that edition's sample lets the visitor in.
create or replace function public.catalog_shared_quote(p_code text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.shared_quote_json(q) || jsonb_build_object(
    'editionId', a.edition_id,
    'chunkExists', src.id is not null,
    'sampleAllowsChunk', src.id is not null and public.sample_chunk_locator(q.publication_id, q.chunk_ordinal) is not null,
    'languages', case when src.id is null then '[]'::jsonb else
      jsonb_build_array(jsonb_build_object(
        'editionId', a.edition_id, 'languageCode', ed.language_code, 'ordinal', q.chunk_ordinal,
        'sampleAllows', public.sample_chunk_locator(q.publication_id, q.chunk_ordinal) is not null))
      || coalesce((
        select jsonb_agg(jsonb_build_object(
          'editionId', ted.id, 'languageCode', ted.language_code, 'ordinal', t.ordinal,
          'sampleAllows', public.sample_chunk_locator(t.publication_id, t.ordinal) is not null)
          order by ted.language_code)
        from public.passage_alignments pa
        join public.ebook_search_chunks t on t.id = pa.target_chunk_id
        join public.editions ted on ted.active_publication_id = pa.target_publication_id
        -- edition_is_sellable: an unpublished, archived or blocked edition never appears to a visitor.
        where pa.source_chunk_id = src.id and ted.id <> a.edition_id and public.edition_is_sellable(ted.id)), '[]'::jsonb)
    end)
  from public.shared_quotes q
  join public.books b on b.id = q.book_id and b.status = 'published'
  left join public.ebook_publications pub on pub.id = q.publication_id
  left join public.ebook_assets a on a.id = pub.ebook_asset_id
  left join public.editions ed on ed.id = a.edition_id
  left join public.ebook_search_chunks src on src.publication_id = q.publication_id and src.ordinal = q.chunk_ordinal
  where q.code = p_code and q.status = 'active';
$$;
