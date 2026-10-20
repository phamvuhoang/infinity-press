-- S8: the coupon schema (docs/superpowers/specs/2026-09-21-s8-coupons-design.md 5.2).
--
-- No new error codes. The RPCs that raise EB024/EB025 arrive in 20260923120000 and 20260923140000.
--
-- Three tables and four order columns. The order columns are the load-bearing part: an order's
-- money is a snapshot, and after this migration that snapshot is three numbers instead of one,
-- tied together by a CHECK so no writer can leave them disagreeing.
--
-- subtotal_minor ends up NOT NULL with no default, on purpose - an order's money must be stated by
-- whoever creates it, not silently inherited. But a trigger (below) fills it from total_minor when
-- a writer leaves it null, the same way 20260922110000_order_reference_code.sql fills
-- reference_code: every insert gets a value, including the ones acquire_free_ebook makes, without
-- changing that function's body. A trigger keeps the rule in one place for any future
-- order-creating RPC, and it hides no inconsistency - a writer that sets discount_minor without
-- subtotal_minor still fails orders_total_is_subtotal_less_discount below, because the trigger only
-- ever fills subtotal_minor from total_minor, never derives it from a discount. That is also why
-- acquire_free_ebook needs no edit here: its only order is total_minor = 0 with no discount, which
-- is exactly the shape the trigger was built to backfill.
create table public.coupons (
  id uuid primary key default gen_random_uuid(),
  -- Stored upper-case; normalized on write by admin_create_coupon and matched upper-case by
  -- apply_coupon_to_order. The pattern is lib/commerce/coupon.ts's COUPON_CODE_PATTERN.
  code text not null unique check (code ~ '^[A-Z0-9][A-Z0-9-]{1,30}[A-Z0-9]$'),
  kind text not null check (kind in ('percent', 'fixed')),
  percent_off int check (percent_off between 1 and 100),
  amount_off_minor bigint check (amount_off_minor > 0),
  currency text check (currency ~ '^[A-Z]{3}$'),
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  max_redemptions int check (max_redemptions > 0),
  max_redemptions_per_profile int not null default 1 check (max_redemptions_per_profile > 0),
  note text check (note is null or char_length(note) <= 500),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  -- Each kind carries its own evidence and nothing else, so no row can be half a percentage and
  -- half an amount. The else branch fails closed for any kind this CASE does not yet know about,
  -- the way entitlements_source_consistency does.
  constraint coupons_kind_consistency check (
    case kind
      when 'percent' then percent_off is not null and amount_off_minor is null and currency is null
      when 'fixed' then amount_off_minor is not null and currency is not null and percent_off is null
      else false
    end
  ),
  constraint coupons_window_order check (starts_at is null or ends_at is null or starts_at < ends_at)
);

-- No rows for a coupon means it applies to every book (spec 5.2).
create table public.coupon_books (
  coupon_id uuid not null references public.coupons(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  primary key (coupon_id, book_id)
);

-- A reservation, not a tally at payment time (spec 5.3). order_id is UNIQUE, which is what makes
-- "one coupon per order" a schema rule rather than a convention.
create table public.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons(id),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  profile_id uuid not null references public.profiles(id),
  discount_minor bigint not null check (discount_minor >= 0),
  status text not null check (status in ('reserved', 'redeemed')),
  reserved_at timestamptz not null default now(),
  redeemed_at timestamptz,
  constraint coupon_redemptions_redeemed_at_check check (status <> 'redeemed' or redeemed_at is not null)
);

-- The counting index: apply_coupon_to_order counts rows per coupon and per (coupon, profile) under
-- the coupon row lock, on every application.
create index coupon_redemptions_coupon_idx on public.coupon_redemptions (coupon_id, profile_id);

-- ------------------------------------------------------------------------------------------
-- The order snapshot. Backfill before the constraints, the ordering discipline
-- 20260922110000_order_reference_code.sql established: every existing order has no discount, so
-- its subtotal is its total.
alter table public.orders
  add column subtotal_minor bigint,
  add column discount_minor bigint not null default 0,
  add column coupon_id uuid references public.coupons(id),
  add column coupon_code text;

update public.orders set subtotal_minor = total_minor where subtotal_minor is null;

alter table public.orders
  alter column subtotal_minor set not null,
  add constraint orders_subtotal_minor_check check (subtotal_minor >= 0),
  add constraint orders_discount_minor_check check (discount_minor >= 0 and discount_minor <= subtotal_minor),
  add constraint orders_total_is_subtotal_less_discount check (total_minor = subtotal_minor - discount_minor),
  -- The code is snapshotted beside the id because coupons is unreadable through the Data API, so a
  -- reader cannot resolve the id back to the code their own checkout page must show them. It is
  -- also what makes a completed order keep its coupon after the coupon row is edited or retired.
  add constraint orders_coupon_code_consistency check ((coupon_id is null) = (coupon_code is null));

-- The trigger promised above: fills subtotal_minor from total_minor for any insert that leaves it
-- null. It runs before the not-null constraint sees the row, so acquire_free_ebook's unedited
-- insert (total_minor = 0, no subtotal_minor) keeps working, and so would any future order-creating
-- RPC that forgets the column. It only ever copies total_minor - it never invents a discount - so
-- the orders_total_is_subtotal_less_discount CHECK above still fails closed for a writer that sets
-- discount_minor without also setting subtotal_minor.
create function public.orders_subtotal_minor_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.subtotal_minor is null then
    new.subtotal_minor := new.total_minor;
  end if;
  return new;
end;
$$;

create trigger orders_set_subtotal_minor
  before insert on public.orders
  for each row execute function public.orders_subtotal_minor_trigger();

-- ------------------------------------------------------------------------------------------
-- create_ebook_order, with two changes to the 20260922160000 version:
--   1. both staleness comparisons read o.subtotal_minor instead of o.total_minor;
--   2. the cancellation releases any reservation it cancels.
--
-- The first is the whole reason this function is touched at all. A pending order that has a
-- coupon on it has a total BELOW the offer price by construction. Compared on total_minor, a
-- reader who applies a code and then returns to the book page and presses Buy would have their own
-- discounted order cancelled out from under them as "stale" - and, worse, the reservation would be
-- left behind on a cancelled order, consuming a use of the code forever. Compared on
-- subtotal_minor, staleness means what it was always meant to mean: the OFFER moved.
--
-- The orders insert also names subtotal_minor explicitly (equal to the offer price) rather than
-- leaving it to the trigger above: this is the function that prices a paid order, so the value is
-- already in hand as v_price_minor and stating it here is clearer than a reader having to know the
-- trigger exists to see where the number comes from. acquire_free_ebook is not touched - the
-- trigger alone covers its zero-total order.
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
          o.subtotal_minor <> v_price_minor
          or o.currency <> v_currency
          or not exists (
            select 1 from public.payments p2 where p2.order_id = o.id and p2.provider = v_provider
          )
        )
    );

  -- Release any coupon reservation held by the orders about to be cancelled below. Without this, a
  -- stale order's redemption would survive its order - a "reserved" row pointing at a cancelled
  -- order - permanently consuming one use of the code for nothing.
  delete from public.coupon_redemptions r
  where r.order_id in (
    select o.id from public.orders o
    join public.order_items oi on oi.order_id = o.id
    where o.profile_id = v_profile_id and oi.book_id = p_book_id and o.status = 'pending'
      and (
        o.subtotal_minor <> v_price_minor
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
      o.subtotal_minor <> v_price_minor
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

  insert into public.orders (profile_id, status, payment_status, market_code, currency, total_minor, subtotal_minor, payment_provider)
  values (v_profile_id, 'pending', 'pending', v_market_code, v_currency, v_price_minor, v_price_minor, v_provider)
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

-- ------------------------------------------------------------------------------------------
-- RLS. coupons and coupon_books are readable by NOBODY through the Data API - not by a reader,
-- who would be able to enumerate codes, and not by an admin either, who reads them through the
-- admin_list_coupons/admin_get_coupon definer RPCs in 20260923140000 instead. Validation happens
-- inside apply_coupon_to_order, which runs as the owner.
alter table public.coupons enable row level security;
alter table public.coupon_books enable row level security;
alter table public.coupon_redemptions enable row level security;

revoke all on public.coupons from public, anon, authenticated, service_role;
revoke all on public.coupon_books from public, anon, authenticated, service_role;
revoke all on public.coupon_redemptions from public, anon, authenticated, service_role;

-- A redemption carries no code, so reading one enumerates nothing. The owner sees their own; an
-- admin sees all, which is what the admin coupon list's counts are read from.
grant select on public.coupon_redemptions to authenticated;

create policy coupon_redemptions_owner_select on public.coupon_redemptions
  for select to authenticated
  using (profile_id in (select p.id from public.profiles p where p.auth_user_id = auth.uid()));

create policy coupon_redemptions_admin_select on public.coupon_redemptions
  for select to authenticated using (public.is_admin());
