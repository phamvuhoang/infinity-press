-- S7 whole-branch fix C1: the provider on the order itself.
--
-- 20260922140000_commerce_payment_provider.sql put the active provider on the order's payments
-- row, and every surface that asks "is this a manual order?" joins that row. For an admin that
-- works. For a reader it cannot: public.payments carries exactly one RLS policy - "admin reads
-- payments" (20260911100000_mvp_access_admin.sql:430) - and no other policy or grant exists in
-- this schema. A reader's PostgREST embed of payments therefore comes back empty, so
-- CustomerOrderDTO.provider was always null and every manual state on a reader-facing page - the
-- transfer instructions on /status, the decline's link back to /transfer, the awaiting-transfer
-- and awaiting-confirmation labels in both locales - was unreachable code.
--
-- A column grant would not fix it. An admin is also the `authenticated` role and column privileges
-- are per role, not per policy, so withholding external_payment_id from `authenticated` would
-- break the admin order page's payments panel, which reads it through the session client. The
-- provider belongs on the order, where the reader's existing "owner reads own orders" policy
-- already reaches it. No new policy, no privilege change, no change to admin reads.
--
-- The allowed values mirror payments_provider_check exactly (20260922100010), because this column
-- and that one hold the same thing and are written from one value.
alter table public.orders add column payment_provider text;

-- Backfill before the not-null and check constraints - the ordering discipline
-- 20260922110000_order_reference_code.sql established. An order has at most one payments row;
-- acquire_free_ebook makes an order with none at all, and those take the same 'simulator' the
-- default below gives, since a free order is not booked under any payment provider and nothing
-- reads the column for one.
update public.orders o
set payment_provider = coalesce(
  (select pay.provider from public.payments pay where pay.order_id = o.id order by pay.created_at limit 1),
  'simulator'
);

-- The default is what keeps every existing pgTAP fixture, and acquire_free_ebook, on the
-- behaviour they have today; it mirrors commerce_settings.payment_provider's own default and its
-- reasoning. create_ebook_order never relies on it - it writes the column explicitly, from the
-- same read that fills the payments row.
alter table public.orders
  add constraint orders_payment_provider_check
    check (payment_provider in ('disabled', 'simulator', 'manual')),
  alter column payment_provider set default 'simulator',
  alter column payment_provider set not null;

-- create_ebook_order, with one change to the 20260922140000 version and nothing else: the orders
-- insert carries the provider. It comes from v_provider, which is the SAME single commerce_settings
-- read that fills the payments row a few statements later - one statement, one transaction - so an
-- order and its payments row can never name different providers.
create or replace function public.create_ebook_order(p_book_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_sku_id uuid;
  v_market_code text;
  v_currency text;
  v_price_minor bigint;
  v_order_id uuid;
  v_original_language text;
  v_title_snapshot text;
  v_payments_enabled boolean;
  v_provider text;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'create_ebook_order: no profile for the current session' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.customer_identities ci
    where ci.profile_id = v_profile_id and ci.verified_at is not null
  ) then
    raise exception 'create_ebook_order: profile % has no verified email', v_profile_id using errcode = 'EB005';
  end if;

  -- One read for both halves of the settings row, so the gate and the provider can never be taken
  -- from two different moments.
  select cs.payments_enabled, cs.payment_provider
  into v_payments_enabled, v_provider
  from public.commerce_settings cs where cs.id;

  if not coalesce(v_payments_enabled, false) then
    raise exception 'create_ebook_order: payments are disabled' using errcode = 'EB011';
  end if;

  -- One reader clicking Buy twice must not create two orders. The lock is per (profile, book) and
  -- ends with the transaction.
  perform pg_advisory_xact_lock(hashtextextended('create_ebook_order:' || v_profile_id::text || ':' || p_book_id::text, 0));

  if exists (
    select 1 from public.entitlements e
    where e.profile_id = v_profile_id and e.book_id = p_book_id and e.status = 'active'
  ) then
    raise exception 'create_ebook_order: profile % already owns book %', v_profile_id, p_book_id using errcode = 'EB013';
  end if;

  select o.sku_id, o.market_code, o.currency, o.price_minor
  into v_sku_id, v_market_code, v_currency, v_price_minor
  from public.offers o
  join public.skus s on s.id = o.sku_id
  join public.editions ed on ed.id = s.edition_id
  join public.books b on b.id = ed.book_id
  join public.ebook_publications pub on pub.id = b.active_publication_id
  where b.id = p_book_id
    and b.status = 'published'
    and pub.status = 'published'
    and o.active
    and o.price_minor > 0
    and (o.starts_at is null or o.starts_at <= now())
    and (o.ends_at is null or o.ends_at > now())
  order by o.market_code
  limit 1
  for update of o;

  if v_sku_id is null then
    raise exception 'create_ebook_order: book % is not purchasable', p_book_id using errcode = 'EB012';
  end if;

  -- Lock the caller's pending orders for this book before touching payments or orders, matching
  -- apply_payment_event's orders-then-payments lock order.
  perform 1
  from public.orders o
  join public.order_items oi on oi.order_id = o.id
  where o.profile_id = v_profile_id and oi.book_id = p_book_id and o.status = 'pending'
  for update of o;

  -- A pending order whose snapshot no longer matches the offer is stale: cancel it so the reader
  -- always pays the price the book page shows (spec 4.3). A provider switch makes an order stale
  -- the same way, and for the same reason - an order booked under the other provider is invisible
  -- to every surface of the active one, so reusing it would strand the reader on a page that
  -- cannot progress. Both cases go through this one mechanism.
  update public.payments pay
  set status = 'cancelled'
  where pay.status = 'pending'
    and pay.order_id in (
      select o.id from public.orders o
      join public.order_items oi on oi.order_id = o.id
      where o.profile_id = v_profile_id and oi.book_id = p_book_id and o.status = 'pending'
        and (
          o.total_minor <> v_price_minor
          or o.currency <> v_currency
          or not exists (
            select 1 from public.payments p2 where p2.order_id = o.id and p2.provider = v_provider
          )
        )
    );

  update public.orders o
  set status = 'cancelled', payment_status = 'cancelled'
  from public.order_items oi
  where oi.order_id = o.id
    and o.profile_id = v_profile_id and oi.book_id = p_book_id and o.status = 'pending'
    and (
      o.total_minor <> v_price_minor
      or o.currency <> v_currency
      or not exists (
        select 1 from public.payments p2 where p2.order_id = o.id and p2.provider = v_provider
      )
    );

  select o.id into v_order_id
  from public.orders o
  join public.order_items oi on oi.order_id = o.id
  where o.profile_id = v_profile_id and oi.book_id = p_book_id and o.status = 'pending'
  order by o.created_at desc
  limit 1;

  if v_order_id is not null then
    return v_order_id;
  end if;

  select b.original_language into v_original_language from public.books b where b.id = p_book_id;
  select bl.title into v_title_snapshot
  from public.book_localizations bl
  where bl.book_id = p_book_id
  order by (bl.locale = v_original_language) desc, bl.locale
  limit 1;

  insert into public.orders (profile_id, status, payment_status, market_code, currency, total_minor, payment_provider)
  values (v_profile_id, 'pending', 'pending', v_market_code, v_currency, v_price_minor, v_provider)
  returning id into v_order_id;

  insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, quantity)
  values (v_order_id, v_sku_id, p_book_id, coalesce(v_title_snapshot, ''), v_price_minor, 1);

  -- The provider comes from commerce_settings, never from the caller: this function is granted to
  -- `authenticated`, and which provider an order is booked under decides who may confirm it.
  -- apply_payment_event resolves this row by (order_id, provider) when events arrive.
  insert into public.payments (order_id, provider, status, amount_minor, currency)
  values (v_order_id, v_provider, 'pending', v_price_minor, v_currency);

  return v_order_id;
end;
$$;
