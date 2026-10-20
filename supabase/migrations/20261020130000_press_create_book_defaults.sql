-- A work created through the admin form gets its first edition as that language's default and its
-- one offer as the default offer, instead of leaving both unset until an admin picks them.

create or replace function public.admin_create_book(p_canonical_key text, p_author_name text, p_locale text, p_language text, p_title text, p_slug text, p_market text, p_currency text, p_price_minor bigint, p_author_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_author_slug text;
  v_author_id uuid;
  v_author_matches bigint;
  v_book_id uuid;
  v_edition_id uuid;
  v_sku_id uuid;
  v_offer_id uuid;
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
  values (v_sku_id, p_market, p_currency, p_price_minor)
  returning id into v_offer_id;
  -- The only edition is its language default; its only offer is the edition's default offer.
  insert into public.book_language_editions (book_id, language_code, edition_id)
  values (v_book_id, p_language, v_edition_id);
  insert into public.edition_default_offers (edition_id, sku_id, offer_id)
  values (v_edition_id, v_sku_id, v_offer_id);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'create_book', 'books', v_book_id,
          jsonb_build_object('canonical_key', p_canonical_key, 'author_id', v_author_id, 'locale', p_locale, 'slug', p_slug));
  return v_book_id;
end;
$function$
;

