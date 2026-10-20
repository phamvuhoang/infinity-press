-- S9: the audited bundle admin surface (spec 6.2, 6.4).
--
-- New error code, continuing the EB0xx series (EB025 is taken by 20260923140000):
--   EB026 - publish_bundle: the bundle does not meet the publication rules. The message is
--           `publish_bundle: bundle is not ready: <csv>`, the same shape publish_book raises with
--           EB010, so lib/catalog/bundle-readiness.ts can parse the codes back out and the editor
--           can point at the section that is incomplete.
--
-- 20260924110000 gave bundles no browser write path at all: no insert, update or delete grant on
-- bundles, bundle_localizations or bundle_books for any browser role, admin or not, and the
-- offers update policy narrowed to sku offers. These functions are therefore the ONLY way a
-- bundle changes. That is deliberate - a bundle has invariants no row policy can express (member
-- positions are contiguous and total, a price is one offer per market, publication has a
-- readiness gate) and every one of them is enforced here, in one place, with one audit row per
-- call.

-- Readiness -------------------------------------------------------------------------------------

-- The SQL half of lib/catalog/bundle-readiness.ts. The order of the codes is part of the contract:
-- the two implementations are compared literally, by
-- supabase/tests/044_s9_bundle_admin_rpcs.sql and lib/catalog/bundle-readiness.test.ts, against
-- the same csv. Only the BLOCKING codes live here; `unpublished_member` is a warning the editor
-- shows and the database has no reason to compute, because unpublishing a member book must never
-- unpublish the bundle it belongs to (spec 6.2).
create function public.bundle_readiness_issues(p_bundle_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select array_remove(array[
    case when (
      select count(*) from public.bundle_books bb
      join public.books b on b.id = bb.book_id
      where bb.bundle_id = p_bundle_id and b.status = 'published'
    ) < 2 then 'too_few_published_members' end,
    case when not exists (
      select 1 from public.bundle_localizations bl
      where bl.bundle_id = p_bundle_id
        and length(trim(bl.title)) > 0
        and length(trim(bl.slug)) > 0
        and length(trim(coalesce(bl.description, ''))) > 0
    ) then 'missing_localization' end,
    case when not exists (
      select 1 from public.media_assets m
      where m.owner_type = 'bundle' and m.owner_id = p_bundle_id and m.kind = 'cover'
    ) then 'missing_cover' end,
    case when not exists (
      select 1 from public.offers o
      where o.bundle_id = p_bundle_id
        and o.active
        and (o.starts_at is null or o.starts_at <= now())
        and (o.ends_at is null or o.ends_at > now())
    ) then 'missing_offer' end
  ], null);
$$;

revoke execute on function public.bundle_readiness_issues(uuid) from public, anon, authenticated;

-- Creation and copy ------------------------------------------------------------------------------

-- A bundle has no canonical key and no unlocalized name, so creating one is creating its first
-- localization. The admin editor then takes over: members, price, cover, publication.
create function public.admin_create_bundle(p_locale text, p_slug text, p_title text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bundle_id uuid;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_create_bundle: caller is not an admin' using errcode = '42501';
  end if;
  if p_locale not in ('vi', 'en') then
    raise exception 'admin_create_bundle: unsupported locale %', p_locale using errcode = '22023';
  end if;

  insert into public.bundles default values returning id into v_bundle_id;
  insert into public.bundle_localizations (bundle_id, locale, slug, title)
  values (v_bundle_id, p_locale, p_slug, p_title);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'create_bundle', 'bundles', v_bundle_id,
          jsonb_build_object('locale', p_locale, 'slug', p_slug));

  return v_bundle_id;
end;
$$;

-- The bundle counterpart of admin_save_book_localization, including its redirect rule: a slug a
-- reader could already have followed is preserved, a draft one never existed publicly and is not.
create function public.admin_save_bundle_localization(
  p_bundle_id uuid,
  p_locale text,
  p_slug text,
  p_title text,
  p_subtitle text,
  p_description text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bundle_status public.content_status;
  v_localization_id uuid;
  v_old_slug text;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_save_bundle_localization: caller is not an admin' using errcode = '42501';
  end if;
  if p_locale not in ('vi', 'en') then
    raise exception 'admin_save_bundle_localization: unsupported locale %', p_locale using errcode = '22023';
  end if;

  select status into v_bundle_status from public.bundles where id = p_bundle_id for update;
  if v_bundle_status is null then
    raise exception 'admin_save_bundle_localization: bundle % does not exist', p_bundle_id using errcode = 'P0002';
  end if;

  select id, slug into v_localization_id, v_old_slug
  from public.bundle_localizations
  where bundle_id = p_bundle_id and locale = p_locale
  for update;

  if v_localization_id is null then
    insert into public.bundle_localizations (bundle_id, locale, slug, title, subtitle, description)
    values (p_bundle_id, p_locale, p_slug, p_title, p_subtitle, p_description)
    returning id into v_localization_id;
  else
    update public.bundle_localizations
    set slug = p_slug, title = p_title, subtitle = p_subtitle, description = p_description
    where id = v_localization_id;

    -- record_slug_redirect (20260913110000) is what keeps a -> b -> c collapsed to a -> c and
    -- b -> c rather than chained; nothing here needs to know the rename history.
    if v_bundle_status = 'published' and v_old_slug <> p_slug then
      perform public.record_slug_redirect(
        format('/%s/bundles/%s', p_locale, v_old_slug),
        format('/%s/bundles/%s', p_locale, p_slug)
      );
    end if;
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'save_bundle_localization', 'bundles', p_bundle_id,
          jsonb_build_object('locale', p_locale, 'slug_from', v_old_slug, 'slug_to', p_slug));

  return v_localization_id;
end;
$$;

-- Membership -------------------------------------------------------------------------------------

-- The editor posts the complete ordered list, and this replaces the membership with it. Positions
-- come from `with ordinality`, so they are contiguous from 1 and agree with the submitted order by
-- construction - the alternative, per-row position updates, can transiently violate the
-- unique (bundle_id, position) index and can leave a gap if one update is dropped.
create function public.admin_set_bundle_members(p_bundle_id uuid, p_book_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
  v_missing_book_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_set_bundle_members: caller is not an admin' using errcode = '42501';
  end if;

  perform 1 from public.bundles where id = p_bundle_id for update;
  if not found then
    raise exception 'admin_set_bundle_members: bundle % does not exist', p_bundle_id using errcode = 'P0002';
  end if;

  if p_book_ids is null or cardinality(p_book_ids) = 0 then
    raise exception 'admin_set_bundle_members: a bundle needs at least one member' using errcode = '22023';
  end if;
  -- Silently deduplicating would drop a book the operator believes they added, and the primary
  -- key would refuse the second copy anyway; saying so names the mistake.
  if (select count(distinct m.book_id) from unnest(p_book_ids) as m(book_id)) <> cardinality(p_book_ids) then
    raise exception 'admin_set_bundle_members: a book can appear in a bundle only once' using errcode = '22023';
  end if;

  -- The column alias is load-bearing: `unnest(p_book_ids) as id` would make the bare `id` in the
  -- inner subquery resolve to books.id, and the check would never find a missing book.
  select m.book_id into v_missing_book_id
  from unnest(p_book_ids) as m(book_id)
  where not exists (select 1 from public.books b where b.id = m.book_id)
  limit 1;
  if v_missing_book_id is not null then
    raise exception 'admin_set_bundle_members: book % does not exist', v_missing_book_id using errcode = 'P0002';
  end if;

  delete from public.bundle_books where bundle_id = p_bundle_id;
  insert into public.bundle_books (bundle_id, book_id, position)
  select p_bundle_id, m.book_id, m.ord
  from unnest(p_book_ids) with ordinality as m(book_id, ord);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'set_bundle_members', 'bundles', p_bundle_id,
          jsonb_build_object('book_ids', p_book_ids));
end;
$$;

-- Price --------------------------------------------------------------------------------------------

-- One offer per (bundle, market, currency), the partial unique index from 20260924110000. Upsert
-- rather than insert, because repricing is the common case and an operator changing a price must
-- not meet a uniqueness error.
create function public.admin_set_bundle_offer(
  p_bundle_id uuid,
  p_market_code text,
  p_currency text,
  p_price_minor bigint,
  p_active boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_offer_id uuid;
  v_previous_price bigint;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_set_bundle_offer: caller is not an admin' using errcode = '42501';
  end if;

  perform 1 from public.bundles where id = p_bundle_id for update;
  if not found then
    raise exception 'admin_set_bundle_offer: bundle % does not exist', p_bundle_id using errcode = 'P0002';
  end if;

  if p_market_code !~ '^[A-Z]{2}$' then
    raise exception 'admin_set_bundle_offer: % is not a market code', p_market_code using errcode = '22023';
  end if;
  if p_currency !~ '^[A-Z]{3}$' then
    raise exception 'admin_set_bundle_offer: % is not a currency code', p_currency using errcode = '22023';
  end if;
  if p_price_minor is null or p_price_minor < 0 then
    raise exception 'admin_set_bundle_offer: a price of 0 or more is required' using errcode = '22023';
  end if;

  select id, price_minor into v_offer_id, v_previous_price
  from public.offers
  where bundle_id = p_bundle_id and market_code = p_market_code and currency = p_currency
  for update;

  if v_offer_id is null then
    insert into public.offers (bundle_id, market_code, currency, price_minor, active)
    values (p_bundle_id, p_market_code, p_currency, p_price_minor, coalesce(p_active, true))
    returning id into v_offer_id;
  else
    update public.offers
    set price_minor = p_price_minor, active = coalesce(p_active, true)
    where id = v_offer_id;
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'set_bundle_offer', 'bundles', p_bundle_id,
          jsonb_build_object('market_code', p_market_code, 'currency', p_currency,
                             'price_minor_from', v_previous_price, 'price_minor', p_price_minor,
                             'active', coalesce(p_active, true)));

  return v_offer_id;
end;
$$;

-- Cover ---------------------------------------------------------------------------------------------

-- The same contract as admin_set_book_cover and admin_set_author_image: the key is minted
-- server-side under this bundle's own prefix, must name an object that really exists in the public
-- covers bucket, and replaces the bundle's one cover. The prefix check is what stops an admin
-- screen - or anything that reaches this function - from pointing one bundle's cover row at
-- another owner's object.
create function public.admin_set_bundle_cover(
  p_bundle_id uuid,
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
    raise exception 'admin_set_bundle_cover: caller is not an admin' using errcode = '42501';
  end if;

  perform 1 from public.bundles where id = p_bundle_id for update;
  if not found then
    raise exception 'admin_set_bundle_cover: bundle % does not exist', p_bundle_id using errcode = 'P0002';
  end if;

  if p_storage_key !~ ('^bundles/' || p_bundle_id::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$') then
    raise exception 'admin_set_bundle_cover: storage key does not belong to bundle %', p_bundle_id using errcode = '22023';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'covers' and o.name = p_storage_key) then
    raise exception 'admin_set_bundle_cover: storage object % does not exist', p_storage_key using errcode = 'P0002';
  end if;
  if p_alt_text is null or length(trim(p_alt_text)) = 0 then
    raise exception 'admin_set_bundle_cover: alt text is required' using errcode = '22023';
  end if;

  select id, storage_key into v_media_id, v_previous_key
  from public.media_assets
  where owner_type = 'bundle' and owner_id = p_bundle_id and kind = 'cover'
  for update;

  if v_media_id is null then
    insert into public.media_assets (owner_type, owner_id, kind, storage_key, alt_text, width, height)
    values ('bundle', p_bundle_id, 'cover', p_storage_key, trim(p_alt_text), p_width, p_height)
    returning id into v_media_id;
  else
    update public.media_assets
    set storage_key = p_storage_key, alt_text = trim(p_alt_text), width = p_width, height = p_height
    where id = v_media_id;
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'set_bundle_cover', 'bundles', p_bundle_id,
          jsonb_build_object('previous_storage_key', v_previous_key, 'storage_key', p_storage_key));

  return v_media_id;
end;
$$;

-- Publication -----------------------------------------------------------------------------------------

create function public.publish_bundle(p_bundle_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_issues text[];
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'publish_bundle: caller is not an admin' using errcode = '42501';
  end if;

  perform 1 from public.bundles where id = p_bundle_id for update;
  if not found then
    raise exception 'publish_bundle: bundle % does not exist', p_bundle_id using errcode = 'P0002';
  end if;

  v_issues := public.bundle_readiness_issues(p_bundle_id);
  if cardinality(v_issues) > 0 then
    raise exception 'publish_bundle: bundle is not ready: %', array_to_string(v_issues, ',') using errcode = 'EB026';
  end if;

  update public.bundles set status = 'published' where id = p_bundle_id;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'publish_bundle', 'bundles', p_bundle_id, '{}'::jsonb);
end;
$$;

-- Unlike publish_book, this touches nothing but the bundle: a bundle owns no other row's
-- visibility, and its member books stay published and keep selling on their own pages.
create function public.unpublish_bundle(p_bundle_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'unpublish_bundle: caller is not an admin' using errcode = '42501';
  end if;

  update public.bundles set status = 'draft' where id = p_bundle_id;
  if not found then
    raise exception 'unpublish_bundle: bundle % does not exist', p_bundle_id using errcode = 'P0002';
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'unpublish_bundle', 'bundles', p_bundle_id, '{}'::jsonb);
end;
$$;

-- Grants ------------------------------------------------------------------------------------------

revoke execute on function public.admin_create_bundle(text, text, text) from public, anon;
grant execute on function public.admin_create_bundle(text, text, text) to authenticated;
revoke execute on function public.admin_save_bundle_localization(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.admin_save_bundle_localization(uuid, text, text, text, text, text) to authenticated;
revoke execute on function public.admin_set_bundle_members(uuid, uuid[]) from public, anon;
grant execute on function public.admin_set_bundle_members(uuid, uuid[]) to authenticated;
revoke execute on function public.admin_set_bundle_offer(uuid, text, text, bigint, boolean) from public, anon;
grant execute on function public.admin_set_bundle_offer(uuid, text, text, bigint, boolean) to authenticated;
revoke execute on function public.admin_set_bundle_cover(uuid, text, text, integer, integer) from public, anon;
grant execute on function public.admin_set_bundle_cover(uuid, text, text, integer, integer) to authenticated;
revoke execute on function public.publish_bundle(uuid) from public, anon;
grant execute on function public.publish_bundle(uuid) to authenticated;
revoke execute on function public.unpublish_bundle(uuid) from public, anon;
grant execute on function public.unpublish_bundle(uuid) to authenticated;
