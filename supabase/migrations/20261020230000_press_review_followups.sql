-- Review follow-ups (second pass).
--   * One predicate decides whether an edition can be offered: edition_is_sellable. Every catalog,
--     order, free-claim and bundle path uses it, so a blocked edition cannot appear in a selector.
--   * A complimentary grant sits BESIDE a paid or free entitlement (one active row per kind), so
--     revoking the comp never removes what was bought, and revoking the order never removes the comp.
--   * A bundle order whose transfer was reported is no longer cancelled by a later "buy again".
--   * Free claims need a sellable edition and are serialized per reader and edition.
--   * The JSON-LD ISBN is the shown edition's; reader_edition_for_publication cannot be used to probe
--     another reader; rolling back never revives an archived edition.

create function public.edition_is_sellable(p_edition_id uuid)
returns boolean
language sql
stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.editions ed
    join public.books b on b.id = ed.book_id and b.status = 'published'
    join public.ebook_publications pub on pub.id = ed.active_publication_id and pub.status = 'published'
    where ed.id = p_edition_id and ed.status = 'published' and ed.editorial_state <> 'blocked'
  );
$$;
revoke all on function public.edition_is_sellable(uuid) from public, anon;
grant execute on function public.edition_is_sellable(uuid) to authenticated, service_role;

-- ---- catalog -----------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.catalog_resolved_editions(p_language text, p_book_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(book_id uuid, edition_id uuid, language_code text, is_fallback boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with listable as (
    select ble.book_id, ble.language_code, ble.edition_id
    from public.book_language_editions ble
    join public.editions e on e.id = ble.edition_id
    where public.edition_is_sellable(e.id)
      and (p_book_id is null or ble.book_id = p_book_id)
  )
  select b.id,
         coalesce(req.edition_id, dflt.edition_id),
         case when req.edition_id is not null then p_language
              else coalesce(b.default_content_language, (select s.default_content_language from public.platform_settings s)) end,
         req.edition_id is null
  from public.books b
  left join listable req on req.book_id = b.id and req.language_code = p_language
  left join listable dflt on dflt.book_id = b.id
    and dflt.language_code = coalesce(b.default_content_language, (select s.default_content_language from public.platform_settings s))
  where b.status = 'published'
    and (p_book_id is null or b.id = p_book_id)
    and coalesce(req.edition_id, dflt.edition_id) is not null;
$function$;

CREATE OR REPLACE FUNCTION public.catalog_book_editions(p_book_id uuid, p_locale text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'editionId', e.id,
    'languageCode', e.language_code,
    'epubLanguage', pub.epub_language,
    'isDefault', e.id = (select r.edition_id from public.catalog_resolved_editions(p_locale, p_book_id) r),
    'offerId', o.offer_id,
    'priceMinor', o.price_minor,
    'currency', o.currency,
    'listPriceMinor', o.list_price_minor,
    'saleEndsAt', o.sale_ends_at,
    'hasSample', exists (
      select 1 from public.book_samples s
      where s.publication_id = e.active_publication_id and jsonb_array_length(s.allowed_hrefs) > 0)
  ) order by (e.id = (select r.edition_id from public.catalog_resolved_editions(p_locale, p_book_id) r)) desc, e.language_code, e.edition_number), '[]'::jsonb)
  from public.editions e
  join public.ebook_publications pub on pub.id = e.active_publication_id
  left join lateral public.catalog_edition_offer(e.id) o on true
  where e.book_id = p_book_id and public.edition_is_sellable(e.id);
$function$;

CREATE OR REPLACE FUNCTION public.catalog_resolve_edition(p_book_id uuid, p_language text, p_edition_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(edition_id uuid, language_code text, is_fallback boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select e.id, e.language_code, e.language_code is distinct from p_language
  from public.editions e
  where p_edition_id is not null
    and e.id = p_edition_id and e.book_id = p_book_id
    and public.edition_is_sellable(e.id)
  union all
  select r.edition_id, r.language_code, r.is_fallback
  from public.catalog_resolved_editions(p_language, p_book_id) r
  where p_edition_id is null;
$function$;

CREATE OR REPLACE FUNCTION public.catalog_book_page(p_locale text, p_slug text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'bookId', b.id,
    'description', bl.description,
    'audience', bl.audience,
    'keyIdeas', bl.key_ideas,
    'faq', bl.faq,
    'seoTitle', bl.seo_title,
    'seoDescription', bl.seo_description,
    'metadataLocale', bl.locale,
    'alternateSlugs', coalesce((select jsonb_object_agg(other.locale, other.slug) from public.book_localizations other where other.book_id = b.id and other.locale <> p_locale and exists (select 1 from public.catalog_resolved_editions(other.locale, b.id))), '{}'::jsonb),
    'isbn', coalesce(
      (select e.isbn from public.catalog_resolved_editions(p_locale, b.id) r join public.editions e on e.id = r.edition_id),
      -- A work with nothing on sale has no shown edition; its ISBN is only a lookup aid then.
      (select e.isbn from public.editions e where e.book_id = b.id and e.isbn is not null order by e.language_code = p_locale desc, e.edition_number limit 1)),
    'retailLinks', coalesce((
      select jsonb_agg(jsonb_build_object('id', rl.id, 'retailer', rl.retailer, 'label', rl.label, 'url', rl.url, 'priceMinor', rl.price_minor, 'currency', rl.currency) order by rl.position)
      from public.book_retail_links rl where rl.book_id = b.id and rl.active), '[]'::jsonb),
    'reviewSummary', (
      select case when count(*) = 0 then null
        else jsonb_build_object('count', count(*), 'average', round(avg(r.rating)::numeric, 1)) end
      from public.book_reviews r where r.book_id = b.id and r.status = 'published'),
    'editions', public.catalog_book_editions(b.id, p_locale)
  )
  from public.book_localizations hit
  join public.books b on b.id = hit.book_id and b.status = 'published'
  join lateral public.catalog_book_metadata(b.id, p_locale) bl on true
  where hit.slug = p_slug and hit.id = bl.id
    and hit.locale in (p_locale, (select s.default_metadata_locale from public.platform_settings s), b.original_language)
  limit 1;
$function$;

CREATE OR REPLACE FUNCTION public.create_edition_order(p_edition_id uuid, p_offer_id uuid, p_expected_minor bigint DEFAULT NULL::bigint)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_profile_id uuid;
  v_payments_enabled boolean;
  v_provider text;
  v_sku_id uuid;
  v_book_id uuid;
  v_language text;
  v_market_code text;
  v_currency text;
  v_price_minor bigint;
  v_order_id uuid;
  v_original_language text;
  v_title_snapshot text;
  v_stale uuid[];
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'create_edition_order: no profile for the current session' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.customer_identities ci
    where ci.profile_id = v_profile_id and ci.verified_at is not null
  ) then
    raise exception 'create_edition_order: profile % has no verified email', v_profile_id using errcode = 'EB005';
  end if;

  select cs.payments_enabled, cs.payment_provider into v_payments_enabled, v_provider
  from public.commerce_settings cs where cs.id;
  if not coalesce(v_payments_enabled, false) then
    raise exception 'create_edition_order: payments are disabled' using errcode = 'EB011';
  end if;

  -- One reader, one edition, one open order at a time. English and Japanese of the same work take
  -- different locks, so buying both at once never serializes or collides.
  perform pg_advisory_xact_lock(hashtextextended('create_edition_order:' || v_profile_id::text || ':' || p_edition_id::text, 0));

  if exists (
    select 1 from public.entitlements e
    where e.profile_id = v_profile_id and e.edition_id = p_edition_id and e.status = 'active'
  ) then
    raise exception 'create_edition_order: profile % already owns edition %', v_profile_id, p_edition_id using errcode = 'EB013';
  end if;

  -- The whole chain, in this transaction: the offer belongs to a SKU of THIS edition, the edition
  -- and its work are published with a live publication, and the offer is active, in its window and
  -- priced above zero (a free edition goes through acquire_free_edition, never an order).
  select o.sku_id, ed.book_id, ed.language_code, o.market_code, o.currency, public.offer_effective_price_minor(o)
  into v_sku_id, v_book_id, v_language, v_market_code, v_currency, v_price_minor
  from public.offers o
  join public.skus s on s.id = o.sku_id and s.active
  join public.editions ed on ed.id = s.edition_id
  join public.books b on b.id = ed.book_id
  join public.ebook_publications pub on pub.id = ed.active_publication_id
  where o.id = p_offer_id
    and ed.id = p_edition_id
    and public.edition_is_sellable(ed.id)
    and o.id in (select d.offer_id from public.catalog_edition_offer(p_edition_id) d)
    and o.active
    and (o.starts_at is null or o.starts_at <= now())
    and (o.ends_at is null or o.ends_at > now())
  for update of o;

  if v_sku_id is null or v_price_minor is null or v_price_minor <= 0 then
    raise exception 'create_edition_order: offer % is not purchasable for edition %', p_offer_id, p_edition_id using errcode = 'EB012';
  end if;

  if not public.currency_is_payable(v_currency) then
    raise exception 'create_edition_order: % cannot be paid by manual transfer', v_currency using errcode = 'EB041';
  end if;

  -- The reader saw a price; if it is not the price now, nothing is created and they must look again.
  if p_expected_minor is not null and p_expected_minor <> v_price_minor then
    raise exception 'create_edition_order: the price of offer % changed', p_offer_id using errcode = 'EB040';
  end if;

  perform 1
  from public.orders o
  join public.order_items oi on oi.order_id = o.id
  where o.profile_id = v_profile_id and oi.edition_id = p_edition_id and o.status = 'pending' and o.bundle_id is null
  for update of o;

  -- A pending order for this edition that no longer matches the offer, price, currency or provider is
  -- stale and is cancelled, so the reader always pays what the page shows. A reported transfer keeps
  -- the price the reader transferred (S19 spec 9.1) but not a provider that is gone.
  select coalesce(array_agg(o.id), '{}') into v_stale
  from public.orders o
  join public.order_items oi on oi.order_id = o.id
  where o.profile_id = v_profile_id and oi.edition_id = p_edition_id and o.status = 'pending' and o.bundle_id is null
    and (
      (
        (o.subtotal_minor <> v_price_minor or o.currency <> v_currency or oi.offer_id is distinct from p_offer_id)
        and not exists (select 1 from public.manual_transfer_claims c where c.order_id = o.id)
      )
      or not exists (select 1 from public.payments p2 where p2.order_id = o.id and p2.provider = v_provider)
    );

  update public.payments pay set status = 'cancelled'
  where pay.status = 'pending' and pay.order_id = any (v_stale);

  delete from public.coupon_redemptions r where r.order_id = any (v_stale);

  update public.orders o set status = 'cancelled', payment_status = 'cancelled'
  where o.id = any (v_stale);

  select o.id into v_order_id
  from public.orders o
  join public.order_items oi on oi.order_id = o.id
  where o.profile_id = v_profile_id and oi.edition_id = p_edition_id and o.status = 'pending' and o.bundle_id is null
  order by o.created_at desc
  limit 1;

  if v_order_id is not null then
    return v_order_id;
  end if;

  select b.original_language into v_original_language from public.books b where b.id = v_book_id;
  select bl.title into v_title_snapshot
  from public.book_localizations bl
  where bl.book_id = v_book_id
  order by (bl.locale = v_language) desc, (bl.locale = v_original_language) desc, bl.locale
  limit 1;

  insert into public.orders (profile_id, status, payment_status, market_code, currency, total_minor, subtotal_minor, payment_provider)
  values (v_profile_id, 'pending', 'pending', v_market_code, v_currency, v_price_minor, v_price_minor, v_provider)
  returning id into v_order_id;

  insert into public.order_items (order_id, sku_id, book_id, edition_id, language_code, offer_id, title_snapshot, unit_price_minor, quantity)
  values (v_order_id, v_sku_id, v_book_id, p_edition_id, v_language, p_offer_id, coalesce(v_title_snapshot, ''), v_price_minor, 1);

  insert into public.payments (order_id, provider, status, amount_minor, currency)
  values (v_order_id, v_provider, 'pending', v_price_minor, v_currency);

  return v_order_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.acquire_free_edition(p_edition_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_profile_id uuid;
  v_book_id uuid;
  v_offer_id uuid;
  v_sku_id uuid;
  v_market_code text;
  v_currency text;
  v_order_id uuid;
  v_title_snapshot text;
  v_language text;
  v_entitlement_id uuid;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'acquire_free_edition: no profile for the current session' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.customer_identities ci where ci.profile_id = v_profile_id and ci.verified_at is not null
  ) then
    raise exception 'acquire_free_edition: profile % has no verified email', v_profile_id using errcode = 'EB005';
  end if;

  select e.book_id, e.language_code into v_book_id, v_language from public.editions e where e.id = p_edition_id;
  if v_book_id is null then
    raise exception 'acquire_free_edition: edition % does not exist', p_edition_id using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('acquire_free_edition:' || v_profile_id::text || ':' || p_edition_id::text, 0));

  -- Idempotent: the reader already holds this edition.
  select id into v_entitlement_id
  from public.entitlements
  where profile_id = v_profile_id and edition_id = p_edition_id and status = 'active';
  if v_entitlement_id is not null then
    return v_entitlement_id;
  end if;

  select o.id, o.sku_id, o.market_code, o.currency
  into v_offer_id, v_sku_id, v_market_code, v_currency
  from public.offers o
  join public.skus s on s.id = o.sku_id and s.active
  join public.editions e on e.id = s.edition_id
  left join public.edition_default_offers d on d.offer_id = o.id
  where e.id = p_edition_id
    and public.edition_is_sellable(e.id)
    and o.id in (select d.offer_id from public.catalog_edition_offer(p_edition_id) d)
    and o.active and o.price_minor = 0
    and (o.starts_at is null or o.starts_at <= now())
    and (o.ends_at is null or o.ends_at > now())
  order by (d.offer_id is not null) desc, o.market_code, o.id
  limit 1
  for update of o;

  if v_offer_id is null then
    raise exception 'acquire_free_edition: no active free offer for edition %', p_edition_id using errcode = 'EB006';
  end if;

  -- The order's title is the work's, in the platform default metadata locale when it has one.
  select bl.title into v_title_snapshot
  from public.book_localizations bl
  where bl.book_id = v_book_id
  order by (bl.locale = (select s.default_metadata_locale from public.platform_settings s)) desc, bl.locale
  limit 1;

  insert into public.orders (profile_id, status, payment_status, market_code, currency, total_minor)
  values (v_profile_id, 'completed', 'not_required', v_market_code, v_currency, 0)
  returning id into v_order_id;

  insert into public.order_items (order_id, sku_id, book_id, edition_id, language_code, offer_id, title_snapshot, unit_price_minor, quantity)
  values (v_order_id, v_sku_id, v_book_id, p_edition_id, v_language, v_offer_id, coalesce(v_title_snapshot, ''), 0, 1);

  return public.press_grant_edition_access(v_profile_id, p_edition_id, 'free_order', v_order_id, null, null);
end;
$function$;

create or replace function public.bundle_edition_is_sellable(p_edition_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.edition_is_sellable(p_edition_id);
$$;

CREATE OR REPLACE FUNCTION public.create_bundle_order(p_bundle_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_profile_id uuid;
  v_market_code text;
  v_currency text;
  v_price_minor bigint;
  v_offer_id uuid;
  v_order_id uuid;
  v_title_snapshot text;
  v_member_count integer;
  v_owned_count integer;
  v_missing_sku_count integer;
  v_bundle_status text;
  v_lines public.bundle_order_line[];
  v_payments_enabled boolean;
  v_provider text;
  v_stale uuid[];
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'create_bundle_order: no profile for the current session' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.customer_identities ci
    where ci.profile_id = v_profile_id and ci.verified_at is not null
  ) then
    raise exception 'create_bundle_order: profile % has no verified email', v_profile_id using errcode = 'EB005';
  end if;

  select cs.payments_enabled, cs.payment_provider into v_payments_enabled, v_provider
  from public.commerce_settings cs where cs.id;
  if not coalesce(v_payments_enabled, false) then
    raise exception 'create_bundle_order: payments are disabled' using errcode = 'EB011';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('create_bundle_order:' || v_profile_id::text || ':' || p_bundle_id::text, 0));

  -- The bundle row is locked before anything is read from it: admin_set_bundle_members takes the same
  -- lock, so no membership change can commit while this order is being built.
  select b.status into v_bundle_status from public.bundles b where b.id = p_bundle_id for update;
  if v_bundle_status is null then
    raise exception 'create_bundle_order: bundle % does not exist', p_bundle_id using errcode = 'P0002';
  end if;
  if v_bundle_status <> 'published' then
    raise exception 'create_bundle_order: bundle % is not purchasable', p_bundle_id using errcode = 'EB027';
  end if;

  select l.offer_id, l.market_code, l.currency, l.price_minor
  into v_offer_id, v_market_code, v_currency, v_price_minor
  from public.bundle_live_offer(p_bundle_id) l;

  if v_offer_id is not null then
    select o.market_code, o.currency, o.price_minor
    into v_market_code, v_currency, v_price_minor
    from public.offers o
    where o.id = v_offer_id
      and o.active
      and o.price_minor > 0
      and (o.starts_at is null or o.starts_at <= now())
      and (o.ends_at is null or o.ends_at > now())
    for update;
    if not found then
      v_offer_id := null;
    end if;
  end if;

  if v_offer_id is null then
    raise exception 'create_bundle_order: bundle % is not purchasable', p_bundle_id using errcode = 'EB027';
  end if;

  -- One bundle, one currency, and only a currency a transfer can settle. No conversion, no mixing.
  if not public.currency_is_payable(v_currency) then
    raise exception 'create_bundle_order: % cannot be paid by manual transfer', v_currency using errcode = 'EB041';
  end if;

  -- The order lines are read ONCE and everything below validates and writes from that snapshot, so an
  -- edition unpublished mid-transaction cannot leave the buyer sold fewer editions than were counted.
  select coalesce(
           array_agg(row(l.line_position, l.book_id, l.sku_id, l.title_snapshot, l.edition_id, l.language_code)::public.bundle_order_line
                     order by l.line_position),
           '{}'::public.bundle_order_line[])
  into v_lines
  from public.bundle_order_lines(p_bundle_id) l;

  v_member_count := cardinality(v_lines);
  if v_member_count = 0 then
    raise exception 'create_bundle_order: bundle % has no sellable member edition', p_bundle_id using errcode = 'EB027';
  end if;

  select count(*) into v_missing_sku_count from unnest(v_lines) m where m.sku_id is null;
  if v_missing_sku_count > 0 then
    raise exception 'create_bundle_order: bundle % has a member edition with no sku', p_bundle_id using errcode = 'EB027';
  end if;

  -- Ownership is per edition: holding the English edition leaves the Japanese one for sale.
  select count(*) into v_owned_count
  from unnest(v_lines) m
  join public.entitlements e
    on e.profile_id = v_profile_id and e.edition_id = m.edition_id and e.status = 'active';

  if v_owned_count = v_member_count then
    raise exception 'create_bundle_order: profile % already owns every edition of bundle %', v_profile_id, p_bundle_id
      using errcode = 'EB013';
  end if;

  perform 1
  from public.orders o
  where o.profile_id = v_profile_id and o.bundle_id = p_bundle_id and o.status = 'pending'
  for update;

  -- A pending order is stale when its price, currency, provider OR contents no longer match: a bundle
  -- that gained or lost an edition is a different product from the one the reader started buying.
  select coalesce(array_agg(o.id), '{}') into v_stale
  from public.orders o
  where o.profile_id = v_profile_id and o.bundle_id = p_bundle_id and o.status = 'pending'
    and (
      (
        (
          o.subtotal_minor <> v_price_minor
          or o.currency <> v_currency
          or (select array_agg(oi.edition_id order by oi.edition_id) from public.order_items oi where oi.order_id = o.id)
             is distinct from (select array_agg(m.edition_id order by m.edition_id) from unnest(v_lines) m)
        )
        -- A reported transfer keeps the price and contents the reader transferred for (S19 spec 9.1).
        and not exists (select 1 from public.manual_transfer_claims c where c.order_id = o.id)
      )
      or not exists (select 1 from public.payments p2 where p2.order_id = o.id and p2.provider = v_provider)
    );

  update public.payments pay set status = 'cancelled' where pay.status = 'pending' and pay.order_id = any (v_stale);
  delete from public.coupon_redemptions r where r.order_id = any (v_stale);
  update public.orders o set status = 'cancelled', payment_status = 'cancelled' where o.id = any (v_stale);

  select o.id into v_order_id
  from public.orders o
  where o.profile_id = v_profile_id and o.bundle_id = p_bundle_id and o.status = 'pending'
  order by o.created_at desc
  limit 1;

  if v_order_id is not null then
    return v_order_id;
  end if;

  select bl.title into v_title_snapshot
  from public.bundle_localizations bl
  where bl.bundle_id = p_bundle_id
  order by (bl.locale = (select s.default_metadata_locale from public.platform_settings s)) desc, bl.locale
  limit 1;

  insert into public.orders (
    profile_id, bundle_id, status, payment_status, market_code, currency,
    total_minor, subtotal_minor, payment_provider, title_snapshot
  )
  values (
    v_profile_id, p_bundle_id, 'pending', 'pending', v_market_code, v_currency,
    v_price_minor, v_price_minor, v_provider, coalesce(v_title_snapshot, '')
  )
  returning id into v_order_id;

  insert into public.order_items (order_id, sku_id, book_id, edition_id, language_code, title_snapshot, unit_price_minor, quantity, position)
  select
    v_order_id,
    m.sku_id,
    m.book_id,
    m.edition_id,
    m.language_code,
    m.title_snapshot,
    case when row_number() over (order by m.line_position) = 1 then v_price_minor else 0 end,
    1,
    m.line_position
  from unnest(v_lines) m;

  insert into public.payments (order_id, provider, status, amount_minor, currency)
  values (v_order_id, v_provider, 'pending', v_price_minor, v_currency);

  return v_order_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reader_edition_for_publication(p_profile_id uuid, p_publication_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select e.id
  from public.ebook_publications pub
  join public.ebook_assets a on a.id = pub.ebook_asset_id
  join public.editions e on e.id = a.edition_id
  join public.books b on b.id = e.book_id
  where pub.id = p_publication_id
    and pub.status = 'published'
    and e.active_publication_id = pub.id
    and e.status in ('published', 'archived')
    and b.status = 'published'
    -- A signed-in caller can ask only about themselves; the service role (no auth.uid()) can ask about anyone.
    and (auth.uid() is null or p_profile_id = (select pr.id from public.profiles pr where pr.auth_user_id = auth.uid()))
    and exists (
      select 1 from public.entitlements en
      where en.profile_id = p_profile_id and en.edition_id = e.id and en.status = 'active'
    );
$function$;

CREATE OR REPLACE FUNCTION public.rollback_publication(p_book_id uuid, p_publication_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actual_book_id uuid;
  v_edition_id uuid;
  v_status public.publication_status;
  v_previous uuid;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'rollback_publication: caller is not an admin' using errcode = '42501';
  end if;

  perform 1 from public.books where id = p_book_id for update;
  if not found then
    raise exception 'rollback_publication: book % does not exist', p_book_id using errcode = 'P0002';
  end if;

  select e.book_id, e.id into v_actual_book_id, v_edition_id
  from public.ebook_publications p
  join public.ebook_assets a on a.id = p.ebook_asset_id
  join public.editions e on e.id = a.edition_id
  where p.id = p_publication_id;

  if v_actual_book_id is null then
    raise exception 'rollback_publication: publication % does not exist', p_publication_id using errcode = 'P0002';
  end if;
  if v_actual_book_id <> p_book_id then
    raise exception 'rollback_publication: publication % does not belong to book %', p_publication_id, p_book_id
      using errcode = 'EB003';
  end if;

  perform 1 from public.editions where id = v_edition_id for update;
  select p.status into v_status from public.ebook_publications p where p.id = p_publication_id for update;
  if v_status <> 'superseded' then
    raise exception 'rollback_publication: publication % is % and is not eligible for rollback', p_publication_id, v_status
      using errcode = 'EB002';
  end if;

  if exists (select 1 from public.editions e where e.id = v_edition_id and e.status = 'archived') then
    raise exception 'rollback_publication: edition % is archived', v_edition_id using errcode = 'EB012';
  end if;

  -- Rolls back within the publication's own edition: another language's pointer is never involved.
  v_previous := public.press_move_edition_pointer(v_edition_id, p_publication_id);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'rollback_publication', 'ebook_publications', p_publication_id,
          jsonb_build_object('book_id', p_book_id, 'edition_id', v_edition_id, 'previous_active_publication_id', v_previous));
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_default_edition(p_book_id uuid, p_language_code text, p_edition_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_set_default_edition: caller is not an admin' using errcode = '42501';
  end if;
  if exists (select 1 from public.editions e where e.id = p_edition_id and (e.status = 'archived' or e.editorial_state = 'blocked')) then
    raise exception 'admin_set_default_edition: edition % is archived or blocked', p_edition_id using errcode = 'EB012';
  end if;
  -- The composite foreign key rejects an edition of another book or language (23503).
  insert into public.book_language_editions (book_id, language_code, edition_id)
  values (p_book_id, p_language_code, p_edition_id)
  on conflict (book_id, language_code) do update set edition_id = excluded.edition_id;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'set_default_edition', 'books', p_book_id,
          jsonb_build_object('language_code', p_language_code, 'edition_id', p_edition_id));
end;
$function$;

-- ---- entitlements: one active row per KIND (bought/free vs complimentary) ---------------------
drop index public.entitlements_active_edition_key;
create unique index entitlements_active_edition_key on public.entitlements (profile_id, edition_id)
  where status = 'active' and edition_id is not null and source_type <> 'admin_grant';
create unique index entitlements_active_comp_key on public.entitlements (profile_id, edition_id)
  where status = 'active' and edition_id is not null and source_type = 'admin_grant';

CREATE OR REPLACE FUNCTION public.press_grant_edition_access(p_profile_id uuid, p_edition_id uuid, p_source_type entitlement_source, p_source_order_id uuid, p_actor_profile_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_book_id uuid;
  v_entitlement_id uuid;
begin
  select e.book_id into v_book_id from public.editions e where e.id = p_edition_id;
  if v_book_id is null then
    raise exception 'press_grant_edition_access: edition % does not exist', p_edition_id using errcode = 'P0002';
  end if;

  insert into public.entitlements (profile_id, book_id, edition_id, source_type, source_order_id, actor_profile_id, reason, status)
  values (p_profile_id, v_book_id, p_edition_id, p_source_type, p_source_order_id, p_actor_profile_id, p_reason, 'active')
  on conflict (profile_id, edition_id) where status = 'active' and edition_id is not null and source_type <> 'admin_grant' do nothing
  returning id into v_entitlement_id;

  if v_entitlement_id is null then
    -- Lost a race to, or repeated, an earlier grant of the same edition: that one stands.
    select en.id into v_entitlement_id
    from public.entitlements en
    where en.profile_id = p_profile_id and en.edition_id = p_edition_id and en.status = 'active'
      and en.source_type <> 'admin_grant';
  end if;

  insert into public.library_items (profile_id, book_id, edition_id, entitlement_id)
  values (p_profile_id, v_book_id, p_edition_id, v_entitlement_id)
  on conflict (profile_id, edition_id) where edition_id is not null do update set entitlement_id = excluded.entitlement_id
    where not exists (select 1 from public.entitlements x where x.id = public.library_items.entitlement_id and x.status = 'active');

  return v_entitlement_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.grant_complimentary_entitlement(p_profile_id uuid, p_edition_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_profile_id uuid;
  v_entitlement_id uuid;
  v_book_id uuid;
begin
  if not public.is_admin() then
    raise exception 'grant_complimentary_entitlement: caller is not an admin' using errcode = '42501';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'grant_complimentary_entitlement: a reason is required' using errcode = '22023';
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  if v_actor_profile_id is null then
    raise exception 'grant_complimentary_entitlement: admin caller has no profile' using errcode = 'P0002';
  end if;

  if not exists (select 1 from public.profiles where id = p_profile_id) then
    raise exception 'grant_complimentary_entitlement: profile % does not exist', p_profile_id using errcode = 'P0002';
  end if;
  select e.book_id into v_book_id from public.editions e where e.id = p_edition_id;
  if v_book_id is null then
    raise exception 'grant_complimentary_entitlement: edition % does not exist', p_edition_id using errcode = 'P0002';
  end if;

  -- Lock this subject's entitlement row, if any, so a concurrent grant/revoke on the same
  -- (profile, book) can't race this one. Prefers an already-active row over a merely more recent
  -- revoked one: the active-edition unique index allows only one active row per (profile, edition),
  -- so reactivating a stale revoked row while an active one exists would violate it outright.
  select id into v_entitlement_id
  from public.entitlements
  where profile_id = p_profile_id and edition_id = p_edition_id and source_type = 'admin_grant'
  order by (status = 'active') desc, granted_at desc
  limit 1
  for update;

  -- Ruling BQ: spec 6.3 point 1 ("an admin selects a verified customer identity") governs
  -- selecting a person to grant access to for the first time - not continuously re-verifying one
  -- who already had it. The entitlement's subject is profile_id, and an email change (which
  -- resets customer_identities.verified_at to null via the existing trigger, pending
  -- reconfirmation) does not change who the profile is. So this check applies only when
  -- v_entitlement_id is still null here - a genuinely new grant - never to a reactivation of an
  -- existing row for the same profile, whatever its current verification state.
  if v_entitlement_id is null and not exists (
    select 1 from public.customer_identities ci
    where ci.profile_id = p_profile_id and ci.verified_at is not null
  ) then
    raise exception 'grant_complimentary_entitlement: profile % has no verified identity', p_profile_id
      using errcode = 'EB007';
  end if;

  if v_entitlement_id is not null then
    -- Reactivates this reader's earlier complimentary row (spec 6.3 point 3: "grants or reactivates").
    -- A bought or free entitlement is never rewritten: the comp is a separate row beside it, so each
    -- can be revoked on its own source.
    update public.entitlements
    set status = 'active',
        actor_profile_id = v_actor_profile_id,
        reason = p_reason,
        revoked_at = null,
        granted_at = now()
    where id = v_entitlement_id;
  else
    insert into public.entitlements (profile_id, book_id, edition_id, source_type, actor_profile_id, reason, status)
    values (p_profile_id, v_book_id, p_edition_id, 'admin_grant', v_actor_profile_id, p_reason, 'active')
    returning id into v_entitlement_id;
  end if;

  insert into public.library_items (profile_id, book_id, edition_id, entitlement_id)
  values (p_profile_id, v_book_id, p_edition_id, v_entitlement_id)
  on conflict (profile_id, edition_id) where edition_id is not null do update set entitlement_id = excluded.entitlement_id
    where not exists (select 1 from public.entitlements x where x.id = public.library_items.entitlement_id and x.status = 'active');

  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, reason, metadata)
  values (
    v_actor_profile_id,
    'grant_complimentary_entitlement',
    'entitlements',
    v_entitlement_id,
    p_reason,
    jsonb_build_object('profile_id', p_profile_id, 'book_id', v_book_id, 'edition_id', p_edition_id)
  );

  return v_entitlement_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_complimentary_entitlement(p_profile_id uuid, p_entitlement_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_profile_id uuid;
  v_book_id uuid;
  v_edition_id uuid;
  v_status public.entitlement_status;
begin
  if not public.is_admin() then
    raise exception 'revoke_complimentary_entitlement: caller is not an admin' using errcode = '42501';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'revoke_complimentary_entitlement: a reason is required' using errcode = '22023';
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  if v_actor_profile_id is null then
    raise exception 'revoke_complimentary_entitlement: admin caller has no profile' using errcode = 'P0002';
  end if;

  select e.book_id, e.edition_id, e.status into v_book_id, v_edition_id, v_status
  from public.entitlements e
  where e.id = p_entitlement_id
    and e.profile_id = p_profile_id
    and e.source_type = 'admin_grant'
  for update;

  if v_book_id is null then
    raise exception 'revoke_complimentary_entitlement: complimentary entitlement does not exist'
      using errcode = 'P0002';
  end if;

  if v_status = 'active' then
    update public.entitlements
    set status = 'revoked', revoked_at = now()
    where id = p_entitlement_id;

    insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, reason, metadata)
    values (
      v_actor_profile_id,
      'revoke_complimentary_entitlement',
      'entitlements',
      p_entitlement_id,
      p_reason,
      jsonb_build_object('profile_id', p_profile_id, 'book_id', v_book_id, 'edition_id', v_edition_id)
    );
  end if;

  -- The shelf entry follows another active entitlement for the same edition if there is one.
  update public.library_items li
  set entitlement_id = (select x.id from public.entitlements x
                        where x.profile_id = p_profile_id and x.edition_id = v_edition_id and x.status = 'active' limit 1)
  where li.entitlement_id = p_entitlement_id and li.profile_id = p_profile_id
    and exists (select 1 from public.entitlements x where x.profile_id = p_profile_id and x.edition_id = v_edition_id and x.status = 'active');
  delete from public.library_items
  where entitlement_id = p_entitlement_id and profile_id = p_profile_id;

  return p_entitlement_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_order_entitlement(p_order_id uuid, p_reason text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_profile_id uuid;
  v_profile_id uuid;
  v_entitlement_ids uuid[];
  v_revoked_ids uuid[];
begin
  if not public.is_admin() then
    raise exception 'revoke_order_entitlement: caller is not an admin' using errcode = '42501';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'revoke_order_entitlement: a reason is required' using errcode = '22023';
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  if v_actor_profile_id is null then
    raise exception 'revoke_order_entitlement: admin caller has no profile' using errcode = 'P0002';
  end if;

  -- Locked before they are read, so two admins revoking the same order are serialized rather than
  -- both deciding against the same active rows.
  perform 1
  from public.entitlements e
  where e.source_order_id = p_order_id
    and e.source_type in ('free_order', 'simulated_payment', 'manual_payment', 'sepay_payment')
  for update;

  -- Every status, not just 'active': a repeat must return the same array it returned the first
  -- time rather than reporting that the order granted nothing.
  select coalesce(array_agg(e.id order by e.edition_id), array[]::uuid[])
  into v_entitlement_ids
  from public.entitlements e
  where e.source_order_id = p_order_id
    and e.source_type in ('free_order', 'simulated_payment', 'manual_payment', 'sepay_payment');

  if cardinality(v_entitlement_ids) = 0 then
    raise exception 'revoke_order_entitlement: order % granted no entitlement', p_order_id using errcode = 'P0002';
  end if;

  with revoked as (
    update public.entitlements e
    set status = 'revoked', revoked_at = now()
    where e.id = any(v_entitlement_ids) and e.status = 'active'
    returning e.id, e.edition_id
  )
  select coalesce(array_agg(r.id order by r.edition_id), array[]::uuid[])
  into v_revoked_ids
  from revoked r;

  if cardinality(v_revoked_ids) > 0 then
    -- The shelf entry follows another active entitlement for the same edition (a complimentary one).
    update public.library_items li
    set entitlement_id = (select x.id from public.entitlements x
                          where x.profile_id = li.profile_id and x.edition_id = li.edition_id and x.status = 'active' limit 1)
    where li.entitlement_id = any(v_revoked_ids)
      and exists (select 1 from public.entitlements x where x.profile_id = li.profile_id and x.edition_id = li.edition_id and x.status = 'active');
    delete from public.library_items where entitlement_id = any(v_revoked_ids);

    select o.profile_id into v_profile_id from public.orders o where o.id = p_order_id;

    insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, reason, metadata)
    values (
      v_actor_profile_id,
      'revoke_order_entitlement',
      'orders',
      p_order_id,
      p_reason,
      jsonb_build_object(
        'order_id', p_order_id,
        'profile_id', v_profile_id,
        'entitlement_ids', to_jsonb(v_revoked_ids)
      )
    );
  end if;

  return v_entitlement_ids;
end;
$function$;


-- ---- the order's own edition snapshot, not the SKU's current edition ------------------------------
CREATE OR REPLACE FUNCTION public.order_active_entitlement_ids(p_order_id uuid, p_profile_id uuid)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(array_agg(b.id order by b.edition_id), array[]::uuid[])
  from (
    -- The entitlement THIS order granted wins over a complimentary one held beside it.
    select distinct on (oi.edition_id) oi.edition_id, e.id
    from public.order_items oi
    join public.entitlements e
      on e.profile_id = p_profile_id
     and e.edition_id = oi.edition_id
     and e.status = 'active'
    where oi.order_id = p_order_id
    order by oi.edition_id, (e.source_order_id = p_order_id) desc nulls last, e.granted_at
  ) b;
$function$;

CREATE OR REPLACE FUNCTION public.apply_payment_event(p_provider text, p_provider_event_id text, p_order_id uuid, p_external_payment_id text, p_status text, p_amount_minor bigint, p_currency text, p_occurred_at timestamp with time zone)
 RETURNS TABLE(entitlement_ids uuid[], order_status order_status, payment_status payment_status)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_source public.entitlement_source;
  v_status public.payment_status;
  v_order_status public.order_status;
  v_payment_status public.payment_status;
  v_order_total_minor bigint;
  v_order_currency text;
  v_order_provider text;
  v_profile_id uuid;
  v_payment_id uuid;
  v_event_row_id uuid;
  v_book_id uuid;
  v_edition_id uuid;
  v_entitlement_id uuid;
  v_entitlement_ids uuid[] := array[]::uuid[];
  v_payload_hash text;
  -- Whether this order was bought for somebody else. Resolved under the order lock below, so it
  -- cannot change between the branches that consult it.
  v_is_gift boolean;
begin
  v_source := case p_provider
    when 'simulator' then 'simulated_payment'::public.entitlement_source
    when 'manual' then 'manual_payment'::public.entitlement_source
    when 'sepay' then 'sepay_payment'::public.entitlement_source
    else null
  end;
  if v_source is null then
    raise exception 'apply_payment_event: unknown provider %', p_provider using errcode = 'EB015';
  end if;

  if p_status not in ('succeeded', 'failed', 'cancelled') then
    raise exception 'apply_payment_event: invalid status %', p_status using errcode = '22023';
  end if;
  v_status := p_status::public.payment_status;

  select o.status, o.payment_status, o.total_minor, o.currency, o.profile_id, o.payment_provider
  into v_order_status, v_payment_status, v_order_total_minor, v_order_currency, v_profile_id, v_order_provider
  from public.orders o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'apply_payment_event: order % does not exist', p_order_id using errcode = 'P0002';
  end if;

  if p_provider <> v_order_provider then
    raise exception 'apply_payment_event: order % is booked under provider %, not %',
      p_order_id, v_order_provider, p_provider using errcode = 'EB016';
  end if;

  v_is_gift := exists (select 1 from public.gifts g where g.order_id = p_order_id);

  select id into v_payment_id
  from public.payments
  where order_id = p_order_id and provider = p_provider
  order by created_at asc
  limit 1
  for update;

  if v_payment_id is null then
    insert into public.payments (order_id, provider, external_payment_id, status, amount_minor, currency)
    values (p_order_id, p_provider, p_external_payment_id, 'pending', p_amount_minor, p_currency)
    returning id into v_payment_id;
  end if;

  v_payload_hash := md5(
    p_provider || ':' || p_provider_event_id || ':' || p_order_id::text || ':' || p_status || ':' ||
    p_amount_minor::text || ':' || p_currency
  );

  insert into public.payment_events (payment_id, provider, provider_event_id, payload_hash, processed_at)
  values (v_payment_id, p_provider, p_provider_event_id, v_payload_hash, now())
  on conflict (provider, provider_event_id) do nothing
  returning id into v_event_row_id;

  if v_event_row_id is null then
    -- Replay of an event already processed: return the current outcome, touching nothing else.
    -- A gift order granted the buyer nothing the first time and reports nothing now.
    if not v_is_gift then
      v_entitlement_ids := public.order_active_entitlement_ids(p_order_id, v_profile_id);
    end if;

    return query select v_entitlement_ids, v_order_status, v_payment_status;
    return;
  end if;

  if v_order_status <> 'pending' then
    -- Out-of-order arrival: the order already left 'pending' (completed or cancelled) via an
    -- earlier-processed event. This new event is recorded (payment_events above) but has no
    -- further effect - it must not resurrect a cancelled order or re-derive a different outcome
    -- for an already-completed one.
    if not v_is_gift then
      v_entitlement_ids := public.order_active_entitlement_ids(p_order_id, v_profile_id);
    end if;

    return query select v_entitlement_ids, v_order_status, v_payment_status;
    return;
  end if;

  if p_amount_minor <> v_order_total_minor or p_currency <> v_order_currency then
    raise exception 'apply_payment_event: amount/currency mismatch for order %', p_order_id using errcode = 'EB004';
  end if;

  if v_status = 'succeeded' then
    update public.payments
    set status = 'succeeded', external_payment_id = p_external_payment_id
    where id = v_payment_id;
    update public.orders set status = 'completed', payment_status = 'succeeded' where id = p_order_id;

    -- The gift branch (spec 7.2). The order is paid for, so the gift becomes claimable - and the
    -- buyer is granted nothing, because they did not buy it for themselves.
    v_is_gift := public.activate_order_gift(p_order_id);

    if not v_is_gift then
      -- One entitlement and one library item per book of the order. `distinct` because the grant is
      -- per subject, not per line: two lines naming the same book are one piece of access, and the
      -- partial unique index would reject the second insert's conflict target twice over anyway.
      -- Each iteration keeps the single-book version's `on conflict ... do nothing` and its
      -- resolve-by-subject fallback, so a buyer who already owns one member book is unaffected by
      -- it and still gets the rest.
      for v_edition_id in
        select distinct oi.edition_id from public.order_items oi where oi.order_id = p_order_id
      loop
        v_entitlement_id := public.press_grant_edition_access(v_profile_id, v_edition_id, v_source, p_order_id, null, null);
      end loop;

      v_entitlement_ids := public.order_active_entitlement_ids(p_order_id, v_profile_id);
    end if;

    -- S8 (spec 5.3): the order's coupon reservation, if it has one, is redeemed alongside it. Once
    -- per order, outside the loop - a coupon is applied to the order, not to a line - and scoped to
    -- status = 'reserved' so this stays a no-op both for an order with no coupon and for a
    -- replayed event that reaches this branch again. A gift order redeems its coupon too: the sale
    -- happened, whoever ends up reading the book.
    update public.coupon_redemptions r
    set status = 'redeemed', redeemed_at = now()
    where r.order_id = p_order_id and r.status = 'reserved';

    v_order_status := 'completed';
    v_payment_status := 'succeeded';
  elsif v_status = 'failed' then
    update public.payments set status = 'failed' where id = v_payment_id;
    update public.orders set payment_status = 'failed' where id = p_order_id;
    v_payment_status := 'failed';
  else
    update public.payments set status = 'cancelled' where id = v_payment_id;
    update public.orders set status = 'cancelled', payment_status = 'cancelled' where id = p_order_id;
    v_order_status := 'cancelled';
    v_payment_status := 'cancelled';

    -- S8 (spec 5.3): a cancelled order releases its coupon reservation outright, rather than
    -- marking it something else: the code must be free for the same reader, or another, to use
    -- again. A no-op on an order with no coupon.
    delete from public.coupon_redemptions r where r.order_id = p_order_id;
  end if;

  return query select v_entitlement_ids, v_order_status, v_payment_status;
end;
$function$;

CREATE OR REPLACE FUNCTION public.claim_gift(p_token text)
 RETURNS TABLE(book_id uuid, title text, entitlement_id uuid, already_owned boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
-- This function's OUT parameters are named after the columns it returns - book_id,
-- entitlement_id - and `on conflict (profile_id, book_id)` below has no alias to qualify with, so
-- the default "raise on ambiguity" rule would reject that statement outright. Every value this
-- body reads is a v_-prefixed local or an explicitly qualified column, and the four OUT names are
-- only ever assignment targets (which plpgsql always resolves as variables), so preferring the
-- column here is unambiguous rather than merely quieter.
#variable_conflict use_column
declare
  v_profile_id uuid;
  v_hash text;
  v_gift record;
  v_order record;
  v_source public.entitlement_source;
  v_item record;
  v_entitlement_id uuid;
  v_already boolean;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'claim_gift: no profile for the current session' using errcode = 'P0002';
  end if;

  -- The same expression lib/commerce/gift-token.ts hashGiftToken() produces: SHA-256 of the UTF-8
  -- bytes, lower-case hex. convert_to() rather than a bare cast, so the digest does not depend on
  -- the database's client encoding.
  v_hash := encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');

  select g.* into v_gift from public.gifts g where g.claim_token_hash = v_hash for update;

  -- An unknown token and a spent one are the same refusal. Anything else would let a guesser tell
  -- a wrong token from a right-but-used one, which is most of the way to finding a live one.
  if v_gift.id is null then
    raise exception 'claim_gift: no claimable gift for this token' using errcode = 'EB029';
  end if;

  if v_gift.status = 'claimed' and v_gift.claimed_by_profile_id = v_profile_id then
    -- The same reader again - a refreshed page, a re-followed link. The same answer, and not one
    -- row written. already_owned is derived rather than remembered: an entitlement this claim
    -- created carries source_order_id = the gift's order, and one the reader already held cannot,
    -- because the buyer was granted nothing by that order. So the derivation below reproduces
    -- exactly what the first call reported.
    return query
    select i.book_id, i.title_snapshot, e.id, e.source_order_id is distinct from v_gift.order_id
    from (
      select distinct on (s.edition_id) s.edition_id, ed.book_id, oi.title_snapshot
      from public.order_items oi
      join public.skus s on s.id = oi.sku_id
      join public.editions ed on ed.id = s.edition_id
      where oi.order_id = v_gift.order_id
      order by s.edition_id, oi.position
    ) i
    join public.entitlements e
      on e.profile_id = v_profile_id and e.edition_id = i.edition_id and e.status = 'active'
    order by i.book_id, i.edition_id;
    return;
  end if;

  if v_gift.status <> 'sent' then
    raise exception 'claim_gift: no claimable gift for this token' using errcode = 'EB029';
  end if;

  select o.total_minor, o.payment_provider into v_order
  from public.orders o where o.id = v_gift.order_id;

  -- What the recipient's access is recorded as having come from. A gift order that cost nothing -
  -- a 100% coupon - is a free_order; otherwise it is the source of the provider the order was
  -- actually booked under, the same mapping apply_payment_event makes. The order paid for this
  -- access, so source_order_id always names it, whichever source applies.
  --
  -- Three sites in this file map an order to an entitlement_source, and they are consistent only
  -- by construction - change one and check the other two:
  --   * apply_payment_event's provider mapping (simulator/manual, no zero branch: a zero-total
  --     order never reaches it, because it never produces a payment event);
  --   * apply_coupon_to_order's zero-total branch, which completes the order in-transaction and
  --     grants a non-gift buyer 'free_order' - the only way a gift order reaches total_minor = 0,
  --     and therefore what the 'free_order' branch below has to agree with;
  --   * this mapping, which is the pair of them as seen from the recipient's side.
  v_source := case
    when v_order.total_minor = 0 then 'free_order'::public.entitlement_source
    when v_order.payment_provider = 'simulator' then 'simulated_payment'::public.entitlement_source
    when v_order.payment_provider = 'manual' then 'manual_payment'::public.entitlement_source
    when v_order.payment_provider = 'sepay' then 'sepay_payment'::public.entitlement_source
    else null
  end;
  if v_source is null then
    raise exception 'claim_gift: order % is booked under provider %, which grants nothing',
      v_gift.order_id, v_order.payment_provider using errcode = 'EB015';
  end if;

  -- `distinct on (book_id)` because access is per subject and not per line: a bundle order holding
  -- two lines for one book is one piece of access. Ordered by book_id so the claimed and the
  -- replayed result sets are the same set in the same order.
  for v_item in
    select distinct on (oi.edition_id) oi.edition_id, ed.book_id, oi.title_snapshot
    from public.order_items oi
    join public.editions ed on ed.id = oi.edition_id
    where oi.order_id = v_gift.order_id
    order by oi.edition_id, oi.position
  loop
    -- Captured BEFORE the grant: after it, "does this reader hold this edition" is true either way.
    select e.id into v_entitlement_id
    from public.entitlements e
    where e.profile_id = v_profile_id and e.edition_id = v_item.edition_id and e.status = 'active';
    v_already := v_entitlement_id is not null;

    -- The grant primitive is the arbiter of a race; it also links the library item.
    v_entitlement_id := public.press_grant_edition_access(v_profile_id, v_item.edition_id, v_source, v_gift.order_id, null, null);

    book_id := v_item.book_id;
    title := v_item.title_snapshot;
    entitlement_id := v_entitlement_id;
    already_owned := v_already;
    return next;
  end loop;

  update public.gifts g
  set status = 'claimed', claimed_by_profile_id = v_profile_id, claimed_at = now()
  where g.id = v_gift.id;

  -- The claim path existed so the message could be sent and re-sent while the gift was live. It is
  -- not live any more, so the one protected copy of it is dropped rather than left lying in a
  -- table for the rest of the row's life.
  update public.notification_outbox o set payload = null where o.gift_id = v_gift.id;
end;
$function$;


-- ---- changing an approved edition's language withdraws the approval ----------------------------
CREATE OR REPLACE FUNCTION public.admin_save_edition(p_edition_id uuid, p_isbn text, p_edition_number integer, p_publication_date date, p_introduction text, p_contributors jsonb, p_language_code text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_save_edition: caller is not an admin' using errcode = '42501';
  end if;
  if p_contributors is null or jsonb_typeof(p_contributors) <> 'array' then
    raise exception 'admin_save_edition: contributors must be a list' using errcode = '22023';
  end if;

  -- The identity trigger refuses a language change once the edition has orders or entitlements.
  update public.editions
  set isbn = p_isbn,
      edition_number = p_edition_number,
      publication_date = p_publication_date,
      introduction = p_introduction,
      contributors = p_contributors,
      language_code = p_language_code,
      -- Approval was given for a text in a language: changing the language withdraws it.
      editorial_state = case when language_code is distinct from p_language_code and editorial_state = 'approved' then 'unreviewed' else editorial_state end,
      reviewed_by = case when language_code is distinct from p_language_code and editorial_state = 'approved' then null else reviewed_by end,
      reviewed_at = case when language_code is distinct from p_language_code and editorial_state = 'approved' then null else reviewed_at end
  where id = p_edition_id;
  if not found then
    raise exception 'admin_save_edition: edition % does not exist', p_edition_id using errcode = 'P0002';
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'save_edition', 'editions', p_edition_id, jsonb_build_object('language_code', p_language_code));
end;
$function$;
