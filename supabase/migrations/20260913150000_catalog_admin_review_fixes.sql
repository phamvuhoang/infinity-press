-- Review hardening for catalog creation and publication. Keep stable author identity in the
-- create-book RPC, require localized author copy before publication, and only attach cover keys
-- that Supabase Storage has actually recorded.

drop function public.admin_create_book(text, text, text, text, text, text, text, text, bigint);

create function public.admin_create_book(
  p_canonical_key text,
  p_author_name text,
  p_locale text,
  p_language text,
  p_title text,
  p_slug text,
  p_market text,
  p_currency text,
  p_price_minor bigint,
  p_author_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_author_slug text;
  v_author_id uuid;
  v_author_matches bigint;
  v_book_id uuid;
  v_edition_id uuid;
  v_sku_id uuid;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_create_book: caller is not an admin' using errcode = '42501';
  end if;

  if p_author_id is not null then
    select id into v_author_id from public.authors where id = p_author_id;
    if v_author_id is null then
      raise exception 'admin_create_book: author % does not exist', p_author_id using errcode = 'P0002';
    end if;
  else
    v_author_slug := trim(both '-' from lower(regexp_replace(extensions.unaccent(coalesce(p_author_name, '')), '[^a-zA-Z0-9]+', '-', 'g')));
    if v_author_slug = '' then
      raise exception 'admin_create_book: author name must contain letters or digits' using errcode = '22023';
    end if;

    select count(*), (array_agg(id))[1] into v_author_matches, v_author_id
    from public.authors where lower(trim(display_name)) = lower(trim(p_author_name));
    if v_author_matches > 1 then
      raise exception 'admin_create_book: author name matches multiple authors' using errcode = '22023';
    end if;
    if v_author_id is null then
      select id into v_author_id from public.authors where canonical_slug = v_author_slug;
    end if;
    if v_author_id is null then
      insert into public.authors (canonical_slug, display_name)
      values (v_author_slug, trim(p_author_name))
      returning id into v_author_id;
    end if;
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

revoke execute on function public.admin_create_book(text, text, text, text, text, text, text, text, bigint, uuid) from public, anon;
grant execute on function public.admin_create_book(text, text, text, text, text, text, text, text, bigint, uuid) to authenticated;

create or replace function public.book_readiness_issues(p_book_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select array_remove(array[
    case when not exists (
      select 1 from public.book_localizations bl
      where bl.book_id = p_book_id
        and length(trim(bl.title)) > 0
        and length(trim(bl.slug)) > 0
        and length(trim(coalesce(bl.description, ''))) > 0
    ) then 'missing_localization' end,
    case when not exists (
      select 1 from public.books b
      join public.authors a on a.id = b.primary_author_id
      join public.author_localizations al on al.author_id = a.id
      where b.id = p_book_id
        and length(trim(al.name)) > 0
        and length(trim(al.slug)) > 0
    ) then 'missing_author' end,
    case when not exists (
      select 1 from public.media_assets m
      where m.owner_type = 'book' and m.owner_id = p_book_id and m.kind = 'cover'
    ) then 'missing_cover' end,
    case when not exists (
      select 1 from public.offers o
      join public.skus s on s.id = o.sku_id
      join public.editions e on e.id = s.edition_id
      where e.book_id = p_book_id
        and o.active and s.active
        and (o.starts_at is null or o.starts_at <= now())
        and (o.ends_at is null or o.ends_at > now())
    ) then 'missing_offer' end,
    case when not exists (
      select 1 from public.books b
      join public.ebook_publications p on p.id = b.active_publication_id
      where b.id = p_book_id and p.status = 'published'
    ) then 'missing_publication' end
  ], null);
$$;

create or replace function public.admin_set_book_cover(
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

  if p_storage_key !~ ('^books/' || p_book_id::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$') then
    raise exception 'admin_set_book_cover: storage key does not belong to book %', p_book_id using errcode = '22023';
  end if;
  if not exists (
    select 1 from storage.objects o where o.bucket_id = 'covers' and o.name = p_storage_key
  ) then
    raise exception 'admin_set_book_cover: storage object % does not exist', p_storage_key using errcode = 'P0002';
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
