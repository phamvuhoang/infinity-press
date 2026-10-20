-- S10 author band. Board 1e sets a portrait on the left and, on the right, a pull quote above the
-- short description. The quote is the author's own words, so it is localized; the portrait is one
-- image per author, stored like a book cover.

alter table public.author_localizations add column quote text;

-- admin_save_entity_localization gains p_quote. Replacing it means dropping the old signature
-- rather than adding an overload: PostgREST resolves by argument names, and two candidates that
-- both accept the original six would be ambiguous.
drop function public.admin_save_entity_localization(text, uuid, text, text, text, text);

create function public.admin_save_entity_localization(
  p_entity_type text,
  p_entity_id uuid,
  p_locale text,
  p_slug text,
  p_name text,
  p_description text,
  p_quote text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base_table text;
  v_localization_table text;
  v_foreign_key text;
  v_path_segment text;
  v_status text;
  v_localization_id uuid;
  v_old_slug text;
  v_actor_profile_id uuid;
  v_quote text;
begin
  if not public.is_admin() then
    raise exception 'admin_save_entity_localization: caller is not an admin' using errcode = '42501';
  end if;

  case p_entity_type
    when 'author' then
      v_base_table := 'authors'; v_localization_table := 'author_localizations'; v_foreign_key := 'author_id'; v_path_segment := 'authors';
    when 'topic' then
      v_base_table := 'topics'; v_localization_table := 'topic_localizations'; v_foreign_key := 'topic_id'; v_path_segment := 'topics';
    when 'series' then
      v_base_table := 'series'; v_localization_table := 'series_localizations'; v_foreign_key := 'series_id'; v_path_segment := 'series';
    else
      raise exception 'admin_save_entity_localization: unknown entity type %', p_entity_type using errcode = '22023';
  end case;

  -- Only authors carry a quote. A quote sent for another type is dropped rather than rejected, so
  -- one shared admin form can post the same field set for every type.
  v_quote := case when p_entity_type = 'author' then nullif(trim(coalesce(p_quote, '')), '') else null end;

  if p_locale not in ('vi', 'en') then
    raise exception 'admin_save_entity_localization: unsupported locale %', p_locale using errcode = '22023';
  end if;

  execute format('select status::text from public.%I where id = $1 for update', v_base_table)
    into v_status using p_entity_id;
  if v_status is null then
    raise exception 'admin_save_entity_localization: % % does not exist', p_entity_type, p_entity_id using errcode = 'P0002';
  end if;

  execute format('select id, slug from public.%I where %I = $1 and locale = $2 for update', v_localization_table, v_foreign_key)
    into v_localization_id, v_old_slug using p_entity_id, p_locale;

  if v_localization_id is null then
    if p_entity_type = 'author' then
      insert into public.author_localizations (author_id, locale, slug, name, description, quote)
      values (p_entity_id, p_locale, p_slug, p_name, p_description, v_quote)
      returning id into v_localization_id;
    else
      execute format(
        'insert into public.%I (%I, locale, slug, name, description) values ($1, $2, $3, $4, $5) returning id',
        v_localization_table, v_foreign_key
      ) into v_localization_id using p_entity_id, p_locale, p_slug, p_name, p_description;
    end if;
  else
    if p_entity_type = 'author' then
      update public.author_localizations
      set slug = p_slug, name = p_name, description = p_description, quote = v_quote
      where id = v_localization_id;
    else
      execute format('update public.%I set slug = $1, name = $2, description = $3 where id = $4', v_localization_table)
        using p_slug, p_name, p_description, v_localization_id;
    end if;

    if v_status = 'published' and v_old_slug <> p_slug then
      perform public.record_slug_redirect(
        format('/%s/%s/%s', p_locale, v_path_segment, v_old_slug),
        format('/%s/%s/%s', p_locale, v_path_segment, p_slug)
      );
    end if;
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'save_' || p_entity_type || '_localization', v_base_table, p_entity_id,
          jsonb_build_object('locale', p_locale, 'slug_from', v_old_slug, 'slug_to', p_slug));

  return v_localization_id;
end;
$$;

revoke all on function public.admin_save_entity_localization(text, uuid, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_save_entity_localization(text, uuid, text, text, text, text, text) to authenticated;

-- Author portrait -----------------------------------------------------------------------------

-- Same contract as admin_set_book_cover: the key is minted server-side under authors/<id>/, must
-- name an object that exists in the public covers bucket, and replaces the author's one portrait.
create function public.admin_set_author_image(
  p_author_id uuid,
  p_storage_key text,
  p_alt_text text,
  p_width integer,
  p_height integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_media_id uuid;
  v_previous_key text;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_set_author_image: caller is not an admin' using errcode = '42501';
  end if;

  perform 1 from public.authors where id = p_author_id for update;
  if not found then
    raise exception 'admin_set_author_image: author % does not exist', p_author_id using errcode = 'P0002';
  end if;

  if p_storage_key !~ ('^authors/' || p_author_id::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$') then
    raise exception 'admin_set_author_image: storage key does not belong to author %', p_author_id using errcode = '22023';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'covers' and o.name = p_storage_key) then
    raise exception 'admin_set_author_image: storage object % does not exist', p_storage_key using errcode = 'P0002';
  end if;
  if p_alt_text is null or length(trim(p_alt_text)) = 0 then
    raise exception 'admin_set_author_image: alt text is required' using errcode = '22023';
  end if;

  select id, storage_key into v_media_id, v_previous_key
  from public.media_assets
  where owner_type = 'author' and owner_id = p_author_id and kind = 'author_image'
  for update;

  if v_media_id is null then
    insert into public.media_assets (owner_type, owner_id, kind, storage_key, alt_text, width, height)
    values ('author', p_author_id, 'author_image', p_storage_key, trim(p_alt_text), p_width, p_height)
    returning id into v_media_id;
  else
    update public.media_assets
    set storage_key = p_storage_key, alt_text = trim(p_alt_text), width = p_width, height = p_height
    where id = v_media_id;
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'set_author_image', 'authors', p_author_id,
          jsonb_build_object('previous_storage_key', v_previous_key, 'storage_key', p_storage_key));

  return v_media_id;
end;
$$;

-- media_assets.storage_key stays unreadable through the table, so the editor reads its current
-- portrait through this narrow admin function, as it already does for book covers.
create function public.admin_get_author_image(p_author_id uuid)
returns table (storage_key text, alt_text text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_get_author_image: caller is not an admin' using errcode = '42501';
  end if;

  return query
  select asset.storage_key, asset.alt_text
  from public.media_assets as asset
  where asset.owner_type = 'author' and asset.kind = 'author_image' and asset.owner_id = p_author_id;
end;
$$;

revoke all on function public.admin_set_author_image(uuid, text, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_set_author_image(uuid, text, text, integer, integer) to authenticated;
revoke all on function public.admin_get_author_image(uuid) from public, anon, authenticated, service_role;
grant execute on function public.admin_get_author_image(uuid) to authenticated;

-- Public read ---------------------------------------------------------------------------------

-- catalog_entity_page gains the author's quote and portrait. Series and topics keep null for both.
create or replace function public.catalog_entity_page(p_kind text, p_locale text, p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_other_locale text := case p_locale when 'vi' then 'en' when 'en' then 'vi' end;
  v_id uuid;
  v_name text;
  v_description text;
  v_alternate_slug text;
  v_quote text;
  v_image_path text;
  v_image_alt text;
begin
  if v_other_locale is null then
    return null;
  end if;

  if p_kind = 'author' then
    select a.id, l.name, l.description, l.quote into v_id, v_name, v_description, v_quote
    from public.author_localizations l
    join public.authors a on a.id = l.author_id
    where l.locale = p_locale and l.slug = p_slug and a.status = 'published';
    select l.slug into v_alternate_slug
    from public.author_localizations l
    where l.author_id = v_id and l.locale = v_other_locale;
    select asset.storage_key, asset.alt_text into v_image_path, v_image_alt
    from public.media_assets asset
    where asset.owner_type = 'author' and asset.kind = 'author_image' and asset.owner_id = v_id;
  elsif p_kind = 'series' then
    select s.id, l.name, l.description into v_id, v_name, v_description
    from public.series_localizations l
    join public.series s on s.id = l.series_id
    where l.locale = p_locale and l.slug = p_slug and s.status = 'published';
    select l.slug into v_alternate_slug
    from public.series_localizations l
    where l.series_id = v_id and l.locale = v_other_locale;
  elsif p_kind = 'topic' then
    select t.id, l.name, l.description into v_id, v_name, v_description
    from public.topic_localizations l
    join public.topics t on t.id = l.topic_id
    where l.locale = p_locale and l.slug = p_slug and t.status = 'published';
    select l.slug into v_alternate_slug
    from public.topic_localizations l
    where l.topic_id = v_id and l.locale = v_other_locale;
  else
    return null;
  end if;

  if v_id is null or not public.catalog_has_visible_book(p_kind, v_id, p_locale) then
    return null;
  end if;

  -- The other-locale page only exists when it also has a visible book.
  if v_alternate_slug is not null and not public.catalog_has_visible_book(p_kind, v_id, v_other_locale) then
    v_alternate_slug := null;
  end if;

  return jsonb_build_object(
    'id', v_id,
    'name', v_name,
    'description', v_description,
    'alternateSlug', v_alternate_slug,
    'quote', v_quote,
    'imagePath', v_image_path,
    'imageAlt', v_image_alt
  );
end;
$$;
