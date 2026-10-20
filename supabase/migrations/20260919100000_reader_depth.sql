-- S5.5 reader depth: private annotations and private full-publication search.
-- Browser clients reach these rows only through the reader-session-aware RPCs below.

alter table public.ebook_publications add column positions_json jsonb;

create function public.reader_locator_is_valid(p_locator jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_locator) = 'object'
    and octet_length(p_locator::text) <= 16384
    and jsonb_typeof(p_locator -> 'href') = 'string'
    and char_length(btrim(p_locator ->> 'href')) > 0
    and jsonb_typeof(p_locator -> 'progression') = 'number'
    and (p_locator ->> 'progression')::numeric between 0 and 1
    and (p_locator -> 'totalProgression' is null
      or jsonb_typeof(p_locator -> 'totalProgression') = 'null'
      or (jsonb_typeof(p_locator -> 'totalProgression') = 'number'
          and (p_locator ->> 'totalProgression')::numeric between 0 and 1))
    and jsonb_typeof(p_locator -> 'locations') = 'object';
$$;

revoke execute on function public.reader_locator_is_valid(jsonb) from public, anon, authenticated;
grant execute on function public.reader_locator_is_valid(jsonb) to service_role;

create table public.reader_annotations (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  publication_id uuid not null references public.ebook_publications(id),
  kind text not null check (kind in ('highlight', 'bookmark')),
  locator_json jsonb not null check (public.reader_locator_is_valid(locator_json)),
  selected_text text,
  color text,
  note_text text,
  label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (kind = 'highlight'
      and selected_text is not null
      and char_length(selected_text) between 1 and 1000
      and jsonb_typeof(locator_json -> 'text') = 'object'
      and jsonb_typeof(locator_json #> '{text,highlight}') = 'string'
      and char_length(locator_json #>> '{text,highlight}') between 1 and 1000
      and locator_json #>> '{text,highlight}' = selected_text
      and color in ('yellow', 'green', 'rose')
      and (note_text is null or char_length(note_text) <= 5000)
      and label is null)
    or
    (kind = 'bookmark'
      and selected_text is null
      and color is null
      and note_text is null
      and label is not null
      and char_length(btrim(label)) between 1 and 120)
  )
);

create index reader_annotations_profile_publication_updated_at_idx
  on public.reader_annotations (profile_id, publication_id, updated_at desc);
create index reader_annotations_profile_publication_kind_idx
  on public.reader_annotations (profile_id, publication_id, kind);

create function public.reader_annotations_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'bookmark' and new.label is not null then
    new.label := btrim(new.label);
  end if;

  if tg_op = 'UPDATE' then
    if new.profile_id is distinct from old.profile_id
       or new.publication_id is distinct from old.publication_id
       or new.kind is distinct from old.kind
       or new.locator_json is distinct from old.locator_json then
      raise exception 'reader annotation immutable fields cannot change' using errcode = 'EB010';
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger reader_annotations_before_write
  before insert or update on public.reader_annotations
  for each row execute function public.reader_annotations_before_write();

alter table public.reader_annotations enable row level security;

-- The same three predicates protect every direct table operation: caller ownership, an active
-- entitlement for this publication's book, and the currently-active published publication/book.
create policy "reader owns entitled current annotations" on public.reader_annotations
  for select to authenticated
  using (
    exists (
      select 1
      from public.profiles p
      join public.ebook_publications pub on pub.id = reader_annotations.publication_id
      join public.ebook_assets asset on asset.id = pub.ebook_asset_id
      join public.editions edition on edition.id = asset.edition_id
      join public.books book on book.id = edition.book_id
      join public.entitlements entitlement
        on entitlement.profile_id = reader_annotations.profile_id
       and entitlement.book_id = book.id
       and entitlement.status = 'active'
      where p.id = reader_annotations.profile_id
        and p.auth_user_id = (select auth.uid())
        and pub.status = 'published'
        and book.active_publication_id = pub.id
        and book.status = 'published'
    )
  );
create policy "reader inserts entitled current annotations" on public.reader_annotations
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.profiles p
      join public.ebook_publications pub on pub.id = reader_annotations.publication_id
      join public.ebook_assets asset on asset.id = pub.ebook_asset_id
      join public.editions edition on edition.id = asset.edition_id
      join public.books book on book.id = edition.book_id
      join public.entitlements entitlement
        on entitlement.profile_id = reader_annotations.profile_id
       and entitlement.book_id = book.id
       and entitlement.status = 'active'
      where p.id = reader_annotations.profile_id
        and p.auth_user_id = (select auth.uid())
        and pub.status = 'published'
        and book.active_publication_id = pub.id
        and book.status = 'published'
    )
  );
create policy "reader updates entitled current annotations" on public.reader_annotations
  for update to authenticated
  using (
    exists (
      select 1 from public.profiles p join public.ebook_publications pub on pub.id = reader_annotations.publication_id
      join public.ebook_assets asset on asset.id = pub.ebook_asset_id join public.editions edition on edition.id = asset.edition_id
      join public.books book on book.id = edition.book_id join public.entitlements entitlement on entitlement.profile_id = reader_annotations.profile_id and entitlement.book_id = book.id and entitlement.status = 'active'
      where p.id = reader_annotations.profile_id and p.auth_user_id = (select auth.uid()) and pub.status = 'published' and book.active_publication_id = pub.id and book.status = 'published'
    )
  ) with check (
    exists (
      select 1 from public.profiles p join public.ebook_publications pub on pub.id = reader_annotations.publication_id
      join public.ebook_assets asset on asset.id = pub.ebook_asset_id join public.editions edition on edition.id = asset.edition_id
      join public.books book on book.id = edition.book_id join public.entitlements entitlement on entitlement.profile_id = reader_annotations.profile_id and entitlement.book_id = book.id and entitlement.status = 'active'
      where p.id = reader_annotations.profile_id and p.auth_user_id = (select auth.uid()) and pub.status = 'published' and book.active_publication_id = pub.id and book.status = 'published'
    )
  );
create policy "reader deletes entitled current annotations" on public.reader_annotations
  for delete to authenticated
  using (
    exists (
      select 1 from public.profiles p join public.ebook_publications pub on pub.id = reader_annotations.publication_id
      join public.ebook_assets asset on asset.id = pub.ebook_asset_id join public.editions edition on edition.id = asset.edition_id
      join public.books book on book.id = edition.book_id join public.entitlements entitlement on entitlement.profile_id = reader_annotations.profile_id and entitlement.book_id = book.id and entitlement.status = 'active'
      where p.id = reader_annotations.profile_id and p.auth_user_id = (select auth.uid()) and pub.status = 'published' and book.active_publication_id = pub.id and book.status = 'published'
    )
  );

create table public.ebook_search_chunks (
  id uuid primary key default gen_random_uuid(),
  publication_id uuid not null references public.ebook_publications(id) on delete cascade,
  href text not null check (char_length(btrim(href)) > 0),
  chapter_title text,
  ordinal integer not null check (ordinal >= 0),
  plain_text text not null check (char_length(plain_text) between 1 and 1024),
  locator_json jsonb not null check (
    public.reader_locator_is_valid(locator_json)
    and jsonb_typeof(locator_json -> 'text') = 'object'
    and jsonb_typeof(locator_json #> '{text,highlight}') = 'string'
    and char_length(locator_json #>> '{text,highlight}') between 1 and 160
    and (locator_json #> '{text,before}' is null or (jsonb_typeof(locator_json #> '{text,before}') = 'string' and char_length(locator_json #>> '{text,before}') <= 64))
    and (locator_json #> '{text,after}' is null or (jsonb_typeof(locator_json #> '{text,after}') = 'string' and char_length(locator_json #>> '{text,after}') <= 64))
  ),
  normalized_text text not null default '',
  search_document tsvector not null default ''::tsvector,
  normalized_search_document tsvector not null default ''::tsvector,
  unique (publication_id, ordinal)
);

create index ebook_search_chunks_search_document_idx on public.ebook_search_chunks using gin (search_document);
create index ebook_search_chunks_normalized_search_document_idx on public.ebook_search_chunks using gin (normalized_search_document);
create index ebook_search_chunks_normalized_text_trgm_idx on public.ebook_search_chunks using gin (normalized_text extensions.gin_trgm_ops);

create function public.ebook_search_chunks_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.normalized_text := public.catalog_normalize(new.plain_text);
  new.search_document := to_tsvector('simple', new.plain_text);
  new.normalized_search_document := to_tsvector('simple', new.normalized_text);
  return new;
end;
$$;

create trigger ebook_search_chunks_before_write
  before insert or update of plain_text on public.ebook_search_chunks
  for each row execute function public.ebook_search_chunks_before_write();

alter table public.ebook_search_chunks enable row level security;

-- No anon/authenticated table grant or policy: workers write through service_role; readers only
-- see bounded, redacted results from search_reader_publication.
revoke all on public.reader_annotations, public.ebook_search_chunks from anon, authenticated;
grant select, insert, update, delete on public.reader_annotations, public.ebook_search_chunks to service_role;

create function public.reader_annotation_request(
  p_session_id uuid,
  p_publication_id uuid,
  p_operation text,
  p_annotation_id uuid default null,
  p_payload jsonb default null
)
returns setof public.reader_annotations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authorized record;
  v_annotation public.reader_annotations%rowtype;
  v_kind text;
  v_note text;
begin
  select * into v_authorized
  from public.authorize_reader_session(p_session_id, p_publication_id);
  if not found or p_operation not in ('list', 'create', 'update', 'delete') then
    return;
  end if;

  if p_operation = 'list' then
    return query select annotation.* from public.reader_annotations annotation
      where annotation.profile_id = v_authorized.profile_id and annotation.publication_id = p_publication_id
      order by annotation.updated_at desc, annotation.id;
    return;
  end if;

  if p_operation = 'create' then
    v_kind := p_payload ->> 'kind';
    if v_kind not in ('highlight', 'bookmark') then
      raise exception 'invalid annotation payload' using errcode = 'EB010';
    end if;
    insert into public.reader_annotations (profile_id, publication_id, kind, locator_json, selected_text, color, note_text, label)
    values (
      v_authorized.profile_id, p_publication_id, v_kind, p_payload -> 'locator',
      case when v_kind = 'highlight' then p_payload ->> 'selectedText' else null end,
      case when v_kind = 'highlight' then p_payload ->> 'color' else null end,
      case when v_kind = 'highlight' then p_payload ->> 'noteText' else null end,
      case when v_kind = 'bookmark' then p_payload ->> 'label' else null end
    ) returning * into v_annotation;
    return next v_annotation;
    return;
  end if;

  select * into v_annotation from public.reader_annotations annotation
  where annotation.id = p_annotation_id
    and annotation.profile_id = v_authorized.profile_id
    and annotation.publication_id = p_publication_id;
  if not found then
    return;
  end if;

  if p_operation = 'delete' then
    delete from public.reader_annotations annotation where annotation.id = v_annotation.id returning * into v_annotation;
    return next v_annotation;
    return;
  end if;

  if p_payload ->> 'kind' is distinct from v_annotation.kind then
    raise exception 'annotation kind cannot change' using errcode = 'EB010';
  end if;
  if v_annotation.kind = 'highlight' then
    update public.reader_annotations annotation
      set color = case when p_payload ? 'color' then p_payload ->> 'color' else annotation.color end,
          note_text = case when p_payload ? 'noteText' then p_payload ->> 'noteText' else annotation.note_text end
      where annotation.id = v_annotation.id
      returning * into v_annotation;
  else
    if not p_payload ? 'label' then
      raise exception 'bookmark label is required' using errcode = 'EB010';
    end if;
    update public.reader_annotations annotation set label = p_payload ->> 'label'
      where annotation.id = v_annotation.id returning * into v_annotation;
  end if;
  return next v_annotation;
end;
$$;

create function public.search_reader_publication(
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
    select chunk.*, 3 as match_tier, extensions.similarity(chunk.normalized_text, v_normalized_query) as match_rank
    from public.ebook_search_chunks chunk
    where chunk.publication_id = p_publication_id
      and chunk.normalized_text OPERATOR(extensions.%) v_normalized_query
      and not (chunk.search_document @@ v_exact_query)
      and not (chunk.normalized_search_document @@ v_normalized_token_query)
  ), bounded as (
    select matches.*, greatest(1, strpos(lower(matches.plain_text), lower(v_query)) - 100) as excerpt_start
    from matches
    order by match_tier, match_rank desc, ordinal
    limit 50
  )
  select bounded.chapter_title,
    substring(bounded.plain_text from bounded.excerpt_start for 240) as excerpt,
    (bounded.locator_json - 'text') || jsonb_build_object('text', jsonb_strip_nulls(jsonb_build_object(
      'before', nullif(left(bounded.locator_json #>> '{text,before}', 64), ''),
      'highlight', nullif(left(bounded.locator_json #>> '{text,highlight}', 160), ''),
      'after', nullif(left(bounded.locator_json #>> '{text,after}', 64), '')
    ))) as locator_json
  from bounded
  order by bounded.match_tier, bounded.match_rank desc, bounded.ordinal;
end;
$$;

revoke execute on function public.reader_annotation_request(uuid, uuid, text, uuid, jsonb) from public, anon;
grant execute on function public.reader_annotation_request(uuid, uuid, text, uuid, jsonb) to authenticated;
revoke execute on function public.search_reader_publication(uuid, uuid, text) from public, anon;
grant execute on function public.search_reader_publication(uuid, uuid, text) to authenticated;
