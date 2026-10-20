-- S3: paid ebook orders (docs/superpowers/specs/2026-09-15-s3-get-and-buy-design.md 4.2, 4.3).
--
-- New error codes:
--   EB011 - create_ebook_order: payments are disabled in this database (commerce_settings).
--   EB012 - create_ebook_order: the book has no purchasable paid offer (the book is not published,
--           its active publication is not published, or it has no active in-window offer above 0).
--   EB013 - create_ebook_order: the caller already holds an active entitlement for the book.

-- The database half of the payments gate. Postgres cannot see PAYMENT_PROVIDER, so this row is what
-- lets a database test prove that a production database refuses paid orders. The cloud project is
-- shared with production: keep payments_enabled false there.
create table public.commerce_settings (
  id boolean primary key default true check (id),
  payments_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.commerce_settings (id, payments_enabled) values (true, false);

alter table public.commerce_settings enable row level security;
revoke all on public.commerce_settings from public, anon, authenticated;
grant select, update on public.commerce_settings to service_role;

-- create_ebook_order: invoked by a signed-in reader. The profile comes from auth.uid(); the offer,
-- price, and title come from the database, never from the caller.
create function public.create_ebook_order(p_book_id uuid)
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

  if not coalesce((select cs.payments_enabled from public.commerce_settings cs where cs.id), false) then
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
  -- always pays the price the book page shows (spec 4.3).
  update public.payments pay
  set status = 'cancelled'
  where pay.status = 'pending'
    and pay.order_id in (
      select o.id from public.orders o
      join public.order_items oi on oi.order_id = o.id
      where o.profile_id = v_profile_id and oi.book_id = p_book_id and o.status = 'pending'
        and (o.total_minor <> v_price_minor or o.currency <> v_currency)
    );

  update public.orders o
  set status = 'cancelled', payment_status = 'cancelled'
  from public.order_items oi
  where oi.order_id = o.id
    and o.profile_id = v_profile_id and oi.book_id = p_book_id and o.status = 'pending'
    and (o.total_minor <> v_price_minor or o.currency <> v_currency);

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

  insert into public.orders (profile_id, status, payment_status, market_code, currency, total_minor)
  values (v_profile_id, 'pending', 'pending', v_market_code, v_currency, v_price_minor)
  returning id into v_order_id;

  insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, quantity)
  values (v_order_id, v_sku_id, p_book_id, coalesce(v_title_snapshot, ''), v_price_minor, 1);

  -- The simulator is the only provider this MVP wires up. apply_payment_event resolves this row by
  -- (order_id, provider) when events arrive.
  insert into public.payments (order_id, provider, status, amount_minor, currency)
  values (v_order_id, 'simulator', 'pending', v_price_minor, v_currency);

  return v_order_id;
end;
$$;

revoke execute on function public.create_ebook_order(uuid) from public, anon;
grant execute on function public.create_ebook_order(uuid) to authenticated;
