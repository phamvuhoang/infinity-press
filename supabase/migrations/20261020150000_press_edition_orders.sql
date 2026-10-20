-- Press edition orders (Task 6).
--
-- Manual QR bank transfer is Press's payment path, in VND only. This migration:
--   * records that on commerce_settings (provider 'manual', payable currencies) without opening
--     sales: payments_enabled stays whatever the release procedure set;
--   * adds create_edition_order, which sells ONE edition through ONE named offer and snapshots
--     edition, language, title, amount and currency on the order item;
--   * turns create_ebook_order(book) into a wrapper that refuses to choose between languages;
--   * fixes claim_manual_transfer's "already owns" check to compare editions, not works.
--
-- Error codes added: EB040 (the submitted offer or amount is no longer current), EB041 (the
-- currency cannot be paid by manual transfer), EB042 (the work has several editions on sale and the
-- caller did not name one).

alter table public.commerce_settings
  add column payable_currencies text[] not null default array['VND']::text[],
  add constraint commerce_settings_payable_currencies_check
    check (cardinality(payable_currencies) > 0 and payable_currencies <@ array['VND', 'USD', 'JPY']::text[]);

alter table public.commerce_settings alter column payment_provider set default 'manual';
update public.commerce_settings set payment_provider = 'manual' where id;

-- order_items written by any path (the legacy book RPC, bundles, tests) carry the edition their SKU
-- belongs to, so a later ownership or "which language" question never has to guess.
create function public.order_items_fill_edition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.edition_id is null then
    select s.edition_id into new.edition_id from public.skus s where s.id = new.sku_id;
  end if;
  if new.language_code is null and new.edition_id is not null then
    select e.language_code into new.language_code from public.editions e where e.id = new.edition_id;
  end if;
  return new;
end;
$$;

create trigger order_items_fill_edition
before insert on public.order_items
for each row execute function public.order_items_fill_edition();

-- The currency gate. Reads the settings row the caller cannot write; callers pass only a code.
create function public.currency_is_payable(p_currency text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p_currency = any (cs.payable_currencies) from public.commerce_settings cs where cs.id), false);
$$;

revoke all on function public.currency_is_payable(text) from public, anon;
grant execute on function public.currency_is_payable(text) to authenticated, service_role;

create function public.create_edition_order(p_edition_id uuid, p_offer_id uuid, p_expected_minor bigint default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
    and b.status = 'published'
    and pub.status = 'published'
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
  where o.profile_id = v_profile_id and oi.edition_id = p_edition_id and o.status = 'pending'
  for update of o;

  -- A pending order for this edition that no longer matches the offer, price, currency or provider is
  -- stale and is cancelled, so the reader always pays what the page shows. A reported transfer keeps
  -- the price the reader transferred (S19 spec 9.1) but not a provider that is gone.
  select coalesce(array_agg(o.id), '{}') into v_stale
  from public.orders o
  join public.order_items oi on oi.order_id = o.id
  where o.profile_id = v_profile_id and oi.edition_id = p_edition_id and o.status = 'pending'
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
  where o.profile_id = v_profile_id and oi.edition_id = p_edition_id and o.status = 'pending'
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
$$;

revoke all on function public.create_edition_order(uuid, uuid, bigint) from public, anon;
grant execute on function public.create_edition_order(uuid, uuid, bigint) to authenticated;

-- The work-level entry stays for the book page until it names an edition (Task 8). It never picks
-- between languages: one edition on sale resolves, several is EB042, none is EB012.
create or replace function public.create_ebook_order(p_book_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_edition_ids uuid[];
  v_offer_id uuid;
begin
  select array_agg(distinct s.edition_id) into v_edition_ids
  from public.offers o
  join public.skus s on s.id = o.sku_id and s.active
  join public.editions ed on ed.id = s.edition_id
  where ed.book_id = p_book_id and ed.status = 'published' and ed.active_publication_id is not null
    and o.active and public.offer_effective_price_minor(o) > 0
    and (o.starts_at is null or o.starts_at <= now())
    and (o.ends_at is null or o.ends_at > now());

  if coalesce(cardinality(v_edition_ids), 0) = 0 then
    raise exception 'create_ebook_order: book % is not purchasable', p_book_id using errcode = 'EB012';
  end if;
  if cardinality(v_edition_ids) > 1 then
    raise exception 'create_ebook_order: book % has several editions on sale; name one', p_book_id using errcode = 'EB042';
  end if;

  select o.id into v_offer_id
  from public.offers o
  join public.skus s on s.id = o.sku_id and s.active
  where s.edition_id = v_edition_ids[1] and o.active and public.offer_effective_price_minor(o) > 0
    and (o.starts_at is null or o.starts_at <= now())
    and (o.ends_at is null or o.ends_at > now())
  order by public.currency_is_payable(o.currency) desc, public.offer_effective_price_minor(o), o.currency
  limit 1;

  return public.create_edition_order(v_edition_ids[1], v_offer_id, null);
end;
$$;

create or replace function public.claim_manual_transfer(p_order_id uuid, p_note text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
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

  -- Per edition: holding the English edition must not stop a reader paying for the Japanese one.
  if exists (
    select 1
    from public.order_items oi
    join public.entitlements e on e.edition_id = oi.edition_id
    where oi.order_id = p_order_id and e.profile_id = v_profile_id and e.status = 'active'
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
$$;

-- A bank statement line settles one order. Two confirmations quoting the same reference are almost
-- always one transfer being applied twice. Case and padding do not make a reference different.
create function public.manual_confirmation_reference_unique()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('manual_ref:' || lower(btrim(new.bank_reference)), 0));
  if exists (
    select 1 from public.manual_payment_confirmations c
    where c.order_id <> new.order_id and lower(btrim(c.bank_reference)) = lower(btrim(new.bank_reference))
  ) then
    raise exception 'manual_payment_confirmations: bank reference already used on another order' using errcode = 'EB043';
  end if;
  return new;
end;
$$;

create trigger manual_confirmation_reference_unique
before insert on public.manual_payment_confirmations
for each row execute function public.manual_confirmation_reference_unique();
