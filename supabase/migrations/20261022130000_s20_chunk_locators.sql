-- Passage deep links (?anchor=<ordinal>). An anchor is an ebook_search_chunks ordinal, which is
-- unique per publication. These three functions are the only way a page turns an anchor into a
-- reader locator or a journey session's start locator into an anchor; ebook_search_chunks stays
-- unreadable to the browser roles. Every refusal is a null, never an error, so a page silently
-- falls back to the reader's saved position.
--
-- locator_json.href is the in-publication href; the app converts it to its reader URL.

-- Entitled readers only: the caller must hold the edition whose readable publication this is.
create function public.reader_chunk_locator(p_publication_id uuid, p_ordinal integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select c.locator_json
  from public.ebook_search_chunks c
  where c.publication_id = p_publication_id
    and c.ordinal = p_ordinal
    and public.reader_edition_for_publication(
      (select pr.id from public.profiles pr where pr.auth_user_id = auth.uid()), p_publication_id) is not null;
$$;
revoke all on function public.reader_chunk_locator(uuid, integer) from public, anon;
grant execute on function public.reader_chunk_locator(uuid, integer) to authenticated, service_role;

-- Anonymous visitors too: the publication must be the live publication of a sellable edition (the
-- catalog's predicate), and the chunk's href must pass the same check as lib/reader/session.ts
-- resolveSampleResource: the whole-book "*" alone, or a listed href whose ebook_resources row is
-- access_class = 'sample', so a drifted allowlist cannot leak a paid chapter's text.
create function public.sample_chunk_locator(p_publication_id uuid, p_ordinal integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select c.locator_json
  from public.ebook_search_chunks c
  join public.ebook_publications pub on pub.id = c.publication_id
  join public.ebook_assets a on a.id = pub.ebook_asset_id
  join public.editions ed on ed.id = a.edition_id and ed.active_publication_id = pub.id
  join public.book_samples s on s.publication_id = pub.id
  where c.publication_id = p_publication_id
    and c.ordinal = p_ordinal
    and public.edition_is_sellable(ed.id)
    and jsonb_typeof(s.allowed_hrefs) = 'array'
    and (s.allowed_hrefs ? '*' or (s.allowed_hrefs ? c.href and exists (
      select 1 from public.ebook_resources r
      where r.publication_id = pub.id and r.href = c.href and r.access_class = 'sample')));
$$;
revoke all on function public.sample_chunk_locator(uuid, integer) from public;
grant execute on function public.sample_chunk_locator(uuid, integer) to anon, authenticated, service_role;

-- Entitled readers only. The chunk a locator falls in: the greatest ordinal of that href starting at
-- or before p_progression, else the href's first chunk, else null (the href is not in this
-- publication, for example after an EPUB re-upload).
create function public.reader_chunk_for_locator(p_publication_id uuid, p_href text, p_progression numeric)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select max(c.ordinal) from public.ebook_search_chunks c
     where c.publication_id = p_publication_id and c.href = p_href
       and (c.locator_json->>'progression')::numeric <= p_progression),
    (select min(c.ordinal) from public.ebook_search_chunks c
     where c.publication_id = p_publication_id and c.href = p_href))
  where public.reader_edition_for_publication(
    (select pr.id from public.profiles pr where pr.auth_user_id = auth.uid()), p_publication_id) is not null;
$$;
revoke all on function public.reader_chunk_for_locator(uuid, text, numeric) from public, anon;
grant execute on function public.reader_chunk_for_locator(uuid, text, numeric) to authenticated, service_role;
