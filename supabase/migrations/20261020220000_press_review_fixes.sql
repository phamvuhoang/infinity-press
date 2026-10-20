-- Final-review fixes.
--   1. The offer sold or given away is the one the page shows (the edition's default offer, or its only
--      active offer), never another offer left active.
--   2. A blocked edition stops selling, giving away and being listed (existing owners keep reading).
--   3. Editorial evidence is not readable by the public API: column-level SELECT replaces the
--      table-level grant on editions.
--   4. A reader who owns SOME editions on a bundle order can still report its transfer.
--   5. A single-edition order never cancels or returns a pending bundle order.

-- ---- 3. editions: public columns only ------------------------------------------------------------
revoke select on public.editions from anon, authenticated;
grant select (id, book_id, language_code, isbn, edition_number, publication_date, status,
              active_publication_id, contributors, introduction)
  on public.editions to anon, authenticated;

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
    and ed.status = 'published'
    and ed.editorial_state <> 'blocked'
    and b.status = 'published'
    and pub.status = 'published'
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
    and e.editorial_state <> 'blocked'
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

CREATE OR REPLACE FUNCTION public.claim_manual_transfer(p_order_id uuid, p_note text)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_profile_id uuid;
  v_claimed_at timestamptz;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'claim_manual_transfer: no profile for the current session' using errcode = 'P0002';
  end if;

  perform 1 from public.orders o where o.id = p_order_id and o.profile_id = v_profile_id for update;

  if not exists (
    select 1
    from public.orders o
    join public.payments pay on pay.order_id = o.id and pay.provider = 'manual'
    where o.id = p_order_id and o.profile_id = v_profile_id and o.status = 'pending'
      and public.currency_is_payable(o.currency)
  ) then
    raise exception 'claim_manual_transfer: order % is not a claimable manual order for this reader', p_order_id
      using errcode = 'EB020';
  end if;

  -- Per edition: holding the English edition must not stop a reader paying for the Japanese one, so
  -- only an order whose every edition is already held is refused.
  if not exists (
    select 1
    from public.order_items oi
    where oi.order_id = p_order_id
      and not exists (
        select 1 from public.entitlements e
        where e.edition_id = oi.edition_id and e.profile_id = v_profile_id and e.status = 'active'
      )
  ) then
    raise exception 'claim_manual_transfer: the reader already owns the edition on order %', p_order_id
      using errcode = 'EB017';
  end if;

  insert into public.manual_transfer_claims (order_id, profile_id, note)
  values (p_order_id, v_profile_id, nullif(btrim(coalesce(p_note, '')), ''))
  on conflict (order_id) do update set note = excluded.note;

  select c.claimed_at into v_claimed_at from public.manual_transfer_claims c where c.order_id = p_order_id;
  return v_claimed_at;
end;
$function$;

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
    join public.ebook_publications pub on pub.id = e.active_publication_id and pub.status = 'published'
    where e.status = 'published'
      and e.editorial_state <> 'blocked'
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


create or replace function public.bundle_edition_is_sellable(p_edition_id uuid)
returns boolean
language sql
stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.editions ed
    join public.books b on b.id = ed.book_id
    where ed.id = p_edition_id and ed.status = 'published' and ed.editorial_state <> 'blocked'
      and ed.active_publication_id is not null and b.status = 'published'
  );
$$;
