-- Automatic bilingual passage alignment (lib/epub/align.ts). A row pairs one ebook_search_chunks
-- row of a publication with its counterpart in another edition's publication of the same work.
-- Rows are computed, never entered by hand: lib/data/alignments.ts writes them through
-- replace_passage_alignments after a publish, from the admin "Recompute alignment" action, and
-- from `ebook align <bookId>`. A resource that cannot be paired has no rows, and so no compare.
create table public.passage_alignments (
  book_id uuid not null references public.books(id) on delete cascade,
  source_publication_id uuid not null references public.ebook_publications(id) on delete cascade,
  target_publication_id uuid not null references public.ebook_publications(id) on delete cascade,
  source_chunk_id uuid not null references public.ebook_search_chunks(id) on delete cascade,
  target_chunk_id uuid not null references public.ebook_search_chunks(id) on delete cascade,
  confidence numeric not null check (confidence > 0 and confidence <= 1),
  primary key (source_chunk_id, target_publication_id)
);
create index passage_alignments_pair_idx on public.passage_alignments (source_publication_id, target_publication_id);
create index passage_alignments_target_chunk_idx on public.passage_alignments (target_chunk_id);

-- Like ebook_search_chunks: no browser role reads the table; the functions below are the only way in.
alter table public.passage_alignments enable row level security;
revoke all on public.passage_alignments from anon, authenticated;

-- Service role only. Replaces the source -> target pairs (p_pairs: [{sourceId, targetId,
-- confidence}], as alignChunks returns them) and writes their reverse, so reader_aligned_passage is
-- one lookup by source chunk either way. A reverse row never overwrites one the other direction's
-- own run wrote: when lib/data/alignments.ts runs target -> source too, that run replaces it. Pairs
-- whose chunks are not in the named publications are dropped.
create function public.replace_passage_alignments(
  p_book_id uuid,
  p_source_publication_id uuid,
  p_target_publication_id uuid,
  p_pairs jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    select count(*) from public.ebook_publications pub
    join public.ebook_assets a on a.id = pub.ebook_asset_id
    join public.editions e on e.id = a.edition_id
    where pub.id in (p_source_publication_id, p_target_publication_id) and e.book_id = p_book_id
  ) <> 2 then
    raise exception 'replace_passage_alignments: publications are not two editions of book %', p_book_id using errcode = '22023';
  end if;

  delete from public.passage_alignments
  where source_publication_id = p_source_publication_id and target_publication_id = p_target_publication_id;

  insert into public.passage_alignments (book_id, source_publication_id, target_publication_id, source_chunk_id, target_chunk_id, confidence)
  select p_book_id, p_source_publication_id, p_target_publication_id, s.id, t.id, p.confidence
  from jsonb_to_recordset(p_pairs) as p("sourceId" uuid, "targetId" uuid, confidence numeric)
  join public.ebook_search_chunks s on s.id = p."sourceId" and s.publication_id = p_source_publication_id
  join public.ebook_search_chunks t on t.id = p."targetId" and t.publication_id = p_target_publication_id
  on conflict (source_chunk_id, target_publication_id) do update
    set target_chunk_id = excluded.target_chunk_id, confidence = excluded.confidence;

  -- Several source chunks can share one target chunk; its reverse takes the most confident, then
  -- the earliest.
  insert into public.passage_alignments (book_id, source_publication_id, target_publication_id, source_chunk_id, target_chunk_id, confidence)
  select distinct on (pa.target_chunk_id)
    p_book_id, p_target_publication_id, p_source_publication_id, pa.target_chunk_id, pa.source_chunk_id, pa.confidence
  from public.passage_alignments pa
  join public.ebook_search_chunks s on s.id = pa.source_chunk_id
  where pa.source_publication_id = p_source_publication_id and pa.target_publication_id = p_target_publication_id
  order by pa.target_chunk_id, pa.confidence desc, s.ordinal
  on conflict (source_chunk_id, target_publication_id) do nothing;
end;
$$;
revoke all on function public.replace_passage_alignments(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_passage_alignments(uuid, uuid, uuid, jsonb) to service_role;

-- The passage aligned with chunk p_ordinal of this publication, or null. The caller must be able
-- to read BOTH editions: the one being read and the one the text comes from. With several other
-- editions, the most confident readable one wins, then by language code.
create function public.reader_aligned_passage(p_publication_id uuid, p_ordinal integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with me as (select pr.id from public.profiles pr where pr.auth_user_id = auth.uid())
  select jsonb_build_object(
    'targetPublicationId', pa.target_publication_id,
    'targetEditionId', ed.id,
    'targetLanguageCode', ed.language_code,
    'targetOrdinal', t.ordinal,
    'text', t.plain_text,
    'confidence', pa.confidence)
  from public.ebook_search_chunks s
  join public.passage_alignments pa on pa.source_chunk_id = s.id
  join public.ebook_search_chunks t on t.id = pa.target_chunk_id
  join public.editions ed on ed.id = public.reader_edition_for_publication((select id from me), pa.target_publication_id)
  where s.publication_id = p_publication_id
    and s.ordinal = p_ordinal
    and public.reader_edition_for_publication((select id from me), p_publication_id) is not null
  order by pa.confidence desc, ed.language_code
  limit 1;
$$;
revoke all on function public.reader_aligned_passage(uuid, integer) from public, anon;
grant execute on function public.reader_aligned_passage(uuid, integer) to authenticated, service_role;

-- The share of this publication's chunks paired with another edition's LIVE publication (its
-- edition's active_publication_id), 0 when it has none. Rows left behind by a superseded target do
-- not count, so the compare button never offers a pairing the panel cannot show. Public: a ratio
-- discloses no text. The reader shows its compare button only when this is above 0.
create function public.alignment_coverage(p_publication_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select count(distinct pa.source_chunk_id) from public.passage_alignments pa
     where pa.source_publication_id = p_publication_id
       and exists (select 1 from public.editions e where e.active_publication_id = pa.target_publication_id))::numeric
      / nullif((select count(*) from public.ebook_search_chunks c where c.publication_id = p_publication_id), 0),
    0);
$$;
revoke all on function public.alignment_coverage(uuid) from public;
grant execute on function public.alignment_coverage(uuid) to anon, authenticated, service_role;

-- Service role only: what lib/data/alignments.ts needs of each chunk, without transferring its text.
create function public.chunk_lengths(p_publication_id uuid)
returns table (id uuid, href text, ordinal integer, length integer)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.href, c.ordinal, char_length(c.plain_text)
  from public.ebook_search_chunks c
  where c.publication_id = p_publication_id
  order by c.ordinal;
$$;
revoke all on function public.chunk_lengths(uuid) from public, anon, authenticated;
grant execute on function public.chunk_lengths(uuid) to service_role;
