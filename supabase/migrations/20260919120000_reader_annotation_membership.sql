-- Reader annotation locators are client-facing protected resource URLs. Prove that their decoded
-- path belongs to the exact publication's indexed reading order without granting browser roles
-- access to private publication/resource/index tables.

create function public.reader_percent_decode(p_value text)
returns text
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  v_bytes bytea := ''::bytea;
  v_character text;
  v_index integer := 1;
begin
  while v_index <= char_length(p_value) loop
    v_character := substring(p_value from v_index for 1);
    if v_character = '%' then
      if substring(p_value from v_index + 1 for 2) !~ '^[0-9A-Fa-f]{2}$' then
        return null;
      end if;
      v_bytes := v_bytes || decode(substring(p_value from v_index + 1 for 2), 'hex');
      v_index := v_index + 3;
    else
      if ascii(v_character) < 33 or ascii(v_character) > 126 then
        return null;
      end if;
      v_bytes := v_bytes || convert_to(v_character, 'UTF8');
      v_index := v_index + 1;
    end if;
  end loop;

  begin
    return convert_from(v_bytes, 'UTF8');
  exception when character_not_in_repertoire then
    return null;
  end;
end;
$$;

create function public.reader_publication_path_from_href(p_publication_id uuid, p_href text)
returns text
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  v_prefix text := '/api/reader/publications/' || p_publication_id::text || '/resources/';
  v_path text;
  v_part text;
begin
  if left(p_href, char_length(v_prefix)) <> v_prefix then
    return null;
  end if;

  v_path := public.reader_percent_decode(substring(p_href from char_length(v_prefix) + 1));
  if v_path is null or v_path = '' or v_path like '%\%%' escape '\'
     or v_path like '%?%' or v_path like '%#%' or v_path like '%\%'
     or left(v_path, 1) = '/' or v_path ~ '^[A-Za-z][A-Za-z0-9+.-]*:'
     or v_path ~ '[[:cntrl:] ]' then
    return null;
  end if;

  foreach v_part in array string_to_array(v_path, '/') loop
    if v_part in ('', '.', '..') then
      return null;
    end if;
  end loop;
  return v_path;
end;
$$;

revoke execute on function public.reader_percent_decode(text) from public, anon, authenticated;
revoke execute on function public.reader_publication_path_from_href(uuid, text) from public, anon, authenticated;

create function public.reader_publication_href_membership(
  p_session_id uuid,
  p_publication_id uuid,
  p_href text
)
returns table (index_available boolean, is_member boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authorized record;
  v_positions jsonb;
begin
  select * into v_authorized
  from public.authorize_reader_session(p_session_id, p_publication_id);
  if not found then
    return;
  end if;

  select publication.positions_json into v_positions
  from public.ebook_publications publication
  where publication.id = p_publication_id;

  if jsonb_typeof(v_positions) is distinct from 'array' then
    return query select false, false;
    return;
  end if;

  return query select true, exists (
    select 1
    from jsonb_array_elements(v_positions) as position
    join public.ebook_resources resource
      on resource.publication_id = p_publication_id
     and resource.href = position ->> 'href'
    where position ->> 'href' = p_href
  );
end;
$$;

revoke execute on function public.reader_publication_href_membership(uuid, uuid, text) from public, anon;
grant execute on function public.reader_publication_href_membership(uuid, uuid, text) to authenticated;

create or replace function public.reader_annotation_request(
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
  v_href text;
  v_positions jsonb;
begin
  select * into v_authorized
  from public.authorize_reader_session(p_session_id, p_publication_id);
  if not found or p_operation not in ('list', 'create', 'update', 'delete') then
    return;
  end if;

  select publication.positions_json into v_positions
  from public.ebook_publications publication
  where publication.id = p_publication_id;

  if p_operation = 'list' then
    if exists (
      select 1 from public.reader_annotations annotation
      where annotation.profile_id = v_authorized.profile_id
        and annotation.publication_id = p_publication_id
    ) and jsonb_typeof(v_positions) is distinct from 'array' then
      raise exception 'reader positions are unavailable' using errcode = 'EB014';
    end if;
    if exists (
      select 1 from public.reader_annotations annotation
      where annotation.profile_id = v_authorized.profile_id
        and annotation.publication_id = p_publication_id
        and not exists (
          select 1
          from jsonb_array_elements(v_positions) position
          join public.ebook_resources resource
            on resource.publication_id = p_publication_id
           and resource.href = position ->> 'href'
          where position ->> 'href' = public.reader_publication_path_from_href(
            p_publication_id, annotation.locator_json ->> 'href'
          )
        )
    ) then
      raise exception 'stored annotation locator is not in the reading order' using errcode = 'EB014';
    end if;
    return query select annotation.* from public.reader_annotations annotation
      where annotation.profile_id = v_authorized.profile_id and annotation.publication_id = p_publication_id
      order by annotation.updated_at desc, annotation.id;
    return;
  end if;

  if p_operation = 'create' then
    if jsonb_typeof(v_positions) is distinct from 'array' then
      raise exception 'reader positions are unavailable' using errcode = 'EB014';
    end if;
    v_kind := p_payload ->> 'kind';
    v_href := public.reader_publication_path_from_href(p_publication_id, p_payload #>> '{locator,href}');
    if v_kind not in ('highlight', 'bookmark') or v_href is null then
      raise exception 'invalid annotation payload' using errcode = 'EB010';
    end if;
    if not exists (
      select 1
      from jsonb_array_elements(v_positions) position
      join public.ebook_resources resource
        on resource.publication_id = p_publication_id
       and resource.href = position ->> 'href'
      where position ->> 'href' = v_href
    ) then
      raise exception 'annotation locator is not in the reading order' using errcode = 'EB010';
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

  if jsonb_typeof(v_positions) is distinct from 'array' then
    raise exception 'reader positions are unavailable' using errcode = 'EB014';
  end if;
  v_href := public.reader_publication_path_from_href(p_publication_id, v_annotation.locator_json ->> 'href');
  if v_href is null or not exists (
    select 1
    from jsonb_array_elements(v_positions) position
    join public.ebook_resources resource
      on resource.publication_id = p_publication_id
     and resource.href = position ->> 'href'
    where position ->> 'href' = v_href
  ) then
    raise exception 'stored annotation locator is not in the reading order' using errcode = 'EB014';
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

revoke execute on function public.reader_annotation_request(uuid, uuid, text, uuid, jsonb) from public, anon;
grant execute on function public.reader_annotation_request(uuid, uuid, text, uuid, jsonb) to authenticated;
