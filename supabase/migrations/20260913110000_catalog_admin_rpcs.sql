-- S1 catalog admin RPCs: every multi-row or redirect-producing catalog write. Each function checks
-- is_admin() first (auth.uid() based, so callers use the session client, never service_role) and
-- writes its own audit_logs row.

-- admin_create_book: replaces admin_create_ebook for the admin form. Unlike admin_create_ebook it
-- reuses an existing author whose canonical_slug matches the derived slug, so a second book by the
-- same author no longer fails. admin_create_ebook stays in place for existing callers and tests.
create function public.admin_create_book(
  p_canonical_key text,
  p_author_name text,
  p_locale text,
  p_language text,
  p_title text,
  p_slug text,
  p_market text,
  p_currency text,
  p_price_minor bigint
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_author_slug text;
  v_author_id uuid;
  v_book_id uuid;
  v_edition_id uuid;
  v_sku_id uuid;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_create_book: caller is not an admin' using errcode = '42501';
  end if;

  v_author_slug := trim(both '-' from lower(regexp_replace(extensions.unaccent(coalesce(p_author_name, '')), '[^a-zA-Z0-9]+', '-', 'g')));
  if v_author_slug = '' then
    raise exception 'admin_create_book: author name must contain letters or digits' using errcode = '22023';
  end if;

  select id into v_author_id from public.authors where canonical_slug = v_author_slug;
  if v_author_id is null then
    insert into public.authors (canonical_slug, display_name)
    values (v_author_slug, trim(p_author_name))
    returning id into v_author_id;
  end if;

  insert into public.books (canonical_key, original_language, primary_author_id)
  values (p_canonical_key, p_language, v_author_id)
  returning id into v_book_id;

  insert into public.book_localizations (book_id, locale, slug, title)
  values (v_book_id, p_locale, p_slug, p_title);

  insert into public.editions (book_id, language_code)
  values (v_book_id, p_language)
  returning id into v_edition_id;

  insert into public.skus (edition_id, sku_code)
  values (v_edition_id, p_canonical_key || '-ebook')
  returning id into v_sku_id;

  insert into public.offers (sku_id, market_code, currency, price_minor)
  values (v_sku_id, p_market, p_currency, p_price_minor);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'create_book', 'books', v_book_id,
          jsonb_build_object('canonical_key', p_canonical_key, 'author_id', v_author_id, 'locale', p_locale, 'slug', p_slug));

  return v_book_id;
end;
$$;

-- record_slug_redirect: keeps the redirect map free of chains and loops.
--   1. The new path must never be a redirect source (renaming back to an old slug).
--   2. Anything that pointed at the old path now points straight at the new path.
--   3. The old path points at the new path.
create function public.record_slug_redirect(p_old_path text, p_new_path text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_old_path = p_new_path then
    return;
  end if;

  delete from public.redirects where source_path = p_new_path;
  update public.redirects set destination_path = p_new_path where destination_path = p_old_path;
  insert into public.redirects (source_path, destination_path)
  values (p_old_path, p_new_path)
  on conflict (source_path) do update set destination_path = excluded.destination_path;
end;
$$;

create function public.admin_save_book_localization(
  p_book_id uuid,
  p_locale text,
  p_slug text,
  p_title text,
  p_subtitle text,
  p_short_description text,
  p_description text,
  p_audience text,
  p_key_ideas jsonb,
  p_faq jsonb,
  p_seo_title text,
  p_seo_description text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_book_status public.content_status;
  v_localization_id uuid;
  v_old_slug text;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_save_book_localization: caller is not an admin' using errcode = '42501';
  end if;
  if p_locale not in ('vi', 'en') then
    raise exception 'admin_save_book_localization: unsupported locale %', p_locale using errcode = '22023';
  end if;

  select status into v_book_status from public.books where id = p_book_id for update;
  if v_book_status is null then
    raise exception 'admin_save_book_localization: book % does not exist', p_book_id using errcode = 'P0002';
  end if;

  select id, slug into v_localization_id, v_old_slug
  from public.book_localizations
  where book_id = p_book_id and locale = p_locale
  for update;

  if v_localization_id is null then
    insert into public.book_localizations (
      book_id, locale, slug, title, subtitle, short_description, description,
      audience, key_ideas, faq, seo_title, seo_description
    )
    values (
      p_book_id, p_locale, p_slug, p_title, p_subtitle, p_short_description, p_description,
      p_audience, coalesce(p_key_ideas, '[]'::jsonb), coalesce(p_faq, '[]'::jsonb), p_seo_title, p_seo_description
    )
    returning id into v_localization_id;
  else
    update public.book_localizations
    set slug = p_slug,
        title = p_title,
        subtitle = p_subtitle,
        short_description = p_short_description,
        description = p_description,
        audience = p_audience,
        key_ideas = coalesce(p_key_ideas, '[]'::jsonb),
        faq = coalesce(p_faq, '[]'::jsonb),
        seo_title = p_seo_title,
        seo_description = p_seo_description
    where id = v_localization_id;

    if v_book_status = 'published' and v_old_slug <> p_slug then
      perform public.record_slug_redirect(
        format('/%s/books/%s', p_locale, v_old_slug),
        format('/%s/books/%s', p_locale, p_slug)
      );
    end if;
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'save_book_localization', 'books', p_book_id,
          jsonb_build_object('locale', p_locale, 'slug_from', v_old_slug, 'slug_to', p_slug));

  return v_localization_id;
end;
$$;

create function public.admin_save_entity_localization(
  p_entity_type text,
  p_entity_id uuid,
  p_locale text,
  p_slug text,
  p_name text,
  p_description text
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
    execute format(
      'insert into public.%I (%I, locale, slug, name, description) values ($1, $2, $3, $4, $5) returning id',
      v_localization_table, v_foreign_key
    ) into v_localization_id using p_entity_id, p_locale, p_slug, p_name, p_description;
  else
    execute format('update public.%I set slug = $1, name = $2, description = $3 where id = $4', v_localization_table)
      using p_slug, p_name, p_description, v_localization_id;

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

create function public.admin_set_book_relations(
  p_book_id uuid,
  p_topic_ids uuid[],
  p_series_id uuid,
  p_series_position integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_set_book_relations: caller is not an admin' using errcode = '42501';
  end if;

  perform 1 from public.books where id = p_book_id for update;
  if not found then
    raise exception 'admin_set_book_relations: book % does not exist', p_book_id using errcode = 'P0002';
  end if;

  if p_series_id is not null and (p_series_position is null or p_series_position < 1) then
    raise exception 'admin_set_book_relations: a series position of 1 or more is required' using errcode = '22023';
  end if;

  delete from public.book_topics where book_id = p_book_id;
  insert into public.book_topics (book_id, topic_id)
  select distinct p_book_id, topic_id from unnest(coalesce(p_topic_ids, array[]::uuid[])) as topic_id;

  delete from public.book_series where book_id = p_book_id;
  if p_series_id is not null then
    insert into public.book_series (book_id, series_id, position)
    values (p_book_id, p_series_id, p_series_position);
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'set_book_relations', 'books', p_book_id,
          jsonb_build_object('topic_ids', to_jsonb(coalesce(p_topic_ids, array[]::uuid[])),
                             'series_id', p_series_id, 'series_position', p_series_position));
end;
$$;

create function public.admin_set_book_cover(
  p_book_id uuid,
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
    raise exception 'admin_set_book_cover: caller is not an admin' using errcode = '42501';
  end if;

  perform 1 from public.books where id = p_book_id for update;
  if not found then
    raise exception 'admin_set_book_cover: book % does not exist', p_book_id using errcode = 'P0002';
  end if;

  -- The key is minted server-side (lib/data/covers.ts); this re-checks it so a caller can never
  -- attach another book's object or an arbitrary path.
  if p_storage_key !~ ('^books/' || p_book_id::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$') then
    raise exception 'admin_set_book_cover: storage key does not belong to book %', p_book_id using errcode = '22023';
  end if;
  if p_alt_text is null or length(trim(p_alt_text)) = 0 then
    raise exception 'admin_set_book_cover: alt text is required' using errcode = '22023';
  end if;

  select id, storage_key into v_media_id, v_previous_key
  from public.media_assets
  where owner_type = 'book' and owner_id = p_book_id and kind = 'cover'
  for update;

  if v_media_id is null then
    insert into public.media_assets (owner_type, owner_id, kind, storage_key, alt_text, width, height)
    values ('book', p_book_id, 'cover', p_storage_key, trim(p_alt_text), p_width, p_height)
    returning id into v_media_id;
  else
    update public.media_assets
    set storage_key = p_storage_key, alt_text = trim(p_alt_text), width = p_width, height = p_height
    where id = v_media_id;
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'set_book_cover', 'books', p_book_id,
          jsonb_build_object('previous_storage_key', v_previous_key, 'storage_key', p_storage_key));

  return v_media_id;
end;
$$;

create function public.admin_set_merchandising(p_slot_key text, p_book_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_book_ids uuid[] := coalesce(p_book_ids, array[]::uuid[]);
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_set_merchandising: caller is not an admin' using errcode = '42501';
  end if;
  if p_slot_key not in ('home_featured', 'home_shelf') then
    raise exception 'admin_set_merchandising: unknown slot %', p_slot_key using errcode = '22023';
  end if;
  if p_slot_key = 'home_featured' and cardinality(v_book_ids) > 1 then
    raise exception 'admin_set_merchandising: home_featured holds at most one book' using errcode = '22023';
  end if;
  if cardinality(v_book_ids) <> (select count(distinct b) from unnest(v_book_ids) as b) then
    raise exception 'admin_set_merchandising: a book appears twice' using errcode = '22023';
  end if;
  if cardinality(v_book_ids) <> (select count(*) from public.books where id = any(v_book_ids)) then
    raise exception 'admin_set_merchandising: a book does not exist' using errcode = 'P0002';
  end if;

  delete from public.merchandising_slots where slot_key = p_slot_key;
  insert into public.merchandising_slots (slot_key, book_id, position)
  select p_slot_key, book_id, ordinality::integer
  from unnest(v_book_ids) with ordinality as t(book_id, ordinality);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'set_merchandising', 'merchandising_slots', null,
          jsonb_build_object('slot_key', p_slot_key, 'book_ids', to_jsonb(v_book_ids)));
end;
$$;

-- Grants. EXECUTE to authenticated only: is_admin() can never pass under service_role.
revoke execute on function public.record_slug_redirect(text, text) from public, anon, authenticated;

revoke execute on function public.admin_create_book(text, text, text, text, text, text, text, text, bigint) from public, anon;
grant execute on function public.admin_create_book(text, text, text, text, text, text, text, text, bigint) to authenticated;

revoke execute on function public.admin_save_book_localization(uuid, text, text, text, text, text, text, text, jsonb, jsonb, text, text) from public, anon;
grant execute on function public.admin_save_book_localization(uuid, text, text, text, text, text, text, text, jsonb, jsonb, text, text) to authenticated;

revoke execute on function public.admin_save_entity_localization(text, uuid, text, text, text, text) from public, anon;
grant execute on function public.admin_save_entity_localization(text, uuid, text, text, text, text) to authenticated;

revoke execute on function public.admin_set_book_relations(uuid, uuid[], uuid, integer) from public, anon;
grant execute on function public.admin_set_book_relations(uuid, uuid[], uuid, integer) to authenticated;

revoke execute on function public.admin_set_book_cover(uuid, text, text, integer, integer) from public, anon;
grant execute on function public.admin_set_book_cover(uuid, text, text, integer, integer) to authenticated;

revoke execute on function public.admin_set_merchandising(text, uuid[]) from public, anon;
grant execute on function public.admin_set_merchandising(text, uuid[]) to authenticated;
