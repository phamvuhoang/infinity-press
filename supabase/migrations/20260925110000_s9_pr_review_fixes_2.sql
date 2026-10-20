-- S9 pull-request review, round two.
--
-- Two findings against 20260925100000, which fixed the first review's four. Forward migration
-- again, for the same reason: this branch is pushed.
--
--   1. create_bundle_order could still read two different memberships. The bundle row lock stops
--      admin_set_bundle_members; it does not stop unpublish_book.
--   2. bundle_live_offer was granted to anon and deliberately ignores bundle status, so it read
--      out a DRAFT bundle's price to anyone who could guess a uuid.

-- 1. One membership snapshot, for real -------------------------------------------------------------
--
-- The previous round fixed the race it was shown and missed the one beside it. bundle_order_lines
-- filters on books.status = 'published', and publish_book/unpublish_book lock the BOOK row - never
-- the bundle - so a member can be unpublished between two of the four statements that called it,
-- whatever lock this function holds on the bundle. The order was then counted and ownership-checked
-- against one set of books and written from another: a buyer could clear EB013 against A+B and be
-- sold A alone, having paid the bundle price for both.
--
-- A lock could not have closed this without locking every member book as well, which would put a
-- catalog-wide lock order into a purchase path. Reading the lines once is what the first review
-- asked for, and it removes the class rather than the instance: no second read exists to disagree
-- with the first.
--
-- The composite type exists so the lines can be carried in a plpgsql variable. bundle_order_lines
-- keeps its `returns table` shape - it is still the one definition of what a bundle's lines ARE,
-- and this is only how one caller holds on to them.
create type public.bundle_order_line as (
  line_position integer,
  book_id uuid,
  sku_id uuid,
  title_snapshot text
);

create or replace function public.create_bundle_order(p_bundle_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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

  -- One read for both halves of the settings row, so the gate and the provider can never be taken
  -- from two different moments. Identical to create_ebook_order's: which provider an order is
  -- booked under decides who may confirm it, and this function is granted to `authenticated`, so
  -- the provider comes from commerce_settings and never from the caller.
  select cs.payments_enabled, cs.payment_provider
  into v_payments_enabled, v_provider
  from public.commerce_settings cs where cs.id;

  if not coalesce(v_payments_enabled, false) then
    raise exception 'create_bundle_order: payments are disabled' using errcode = 'EB011';
  end if;

  -- One reader clicking Buy twice must not create two orders. Keyed by (profile, bundle) and
  -- disjoint from create_ebook_order's key by its prefix, so a reader buying a book and a bundle
  -- that contains it at the same moment is not serialized against themselves for no reason.
  perform pg_advisory_xact_lock(hashtextextended('create_bundle_order:' || v_profile_id::text || ':' || p_bundle_id::text, 0));

  -- The bundle row is locked BEFORE anything is read from it, and held for the rest of the
  -- transaction. admin_set_bundle_members takes this same row lock and then replaces the
  -- membership wholesale, so no membership change can commit while this order is being built. It
  -- also serializes against publish_bundle, which is what keeps the status check below and the
  -- price read beneath it a single decision.
  --
  -- This lock is necessary and not sufficient: see the materialization below for what it does not
  -- cover.
  select b.status into v_bundle_status from public.bundles b where b.id = p_bundle_id for update;
  if v_bundle_status is null then
    raise exception 'create_bundle_order: bundle % does not exist', p_bundle_id using errcode = 'P0002';
  end if;
  if v_bundle_status <> 'published' then
    raise exception 'create_bundle_order: bundle % is not purchasable', p_bundle_id using errcode = 'EB027';
  end if;

  -- PR review, finding 2. The offer comes from bundle_live_offer, the single market-resolution
  -- rule this function and the public bundle page now share. It used to pick the first offer by
  -- (market_code, currency) while lib/data/public-bundles.ts showed the cheapest, so a bundle with
  -- two live offers could quote one price on the page and charge another at checkout.
  select l.offer_id, l.market_code, l.currency, l.price_minor
  into v_offer_id, v_market_code, v_currency, v_price_minor
  from public.bundle_live_offer(p_bundle_id) l;

  -- Locked after resolution rather than during it: a set-returning function cannot carry FOR
  -- UPDATE. Re-reading the row under the lock is what makes the price this order is written with
  -- the price that is still on the offer, not one read a moment before someone changed it.
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

  -- PR review round 2, finding 1. The bundle's order lines are read ONCE, here, and every check
  -- below plus the order_items insert reads that array rather than calling bundle_order_lines
  -- again.
  --
  -- The bundle row lock above is not enough on its own. bundle_order_lines also filters on
  -- books.status = 'published', and unpublish_book locks the BOOK row, not the bundle - so it can
  -- still commit between two of these statements. Under READ COMMITTED that left the order
  -- counted and ownership-checked against one set of books and written from another: the buyer
  -- could clear EB013 against A+B and be sold A alone.
  --
  -- Materializing removes the whole class rather than the one instance of it. Whatever the
  -- catalog does mid-transaction, this order is validated and written from a single snapshot.
  select coalesce(
           array_agg(row(l.line_position, l.book_id, l.sku_id, l.title_snapshot)::public.bundle_order_line
                     order by l.line_position),
           '{}'::public.bundle_order_line[])
  into v_lines
  from public.bundle_order_lines(p_bundle_id) l;

  v_member_count := cardinality(v_lines);
  if v_member_count = 0 then
    raise exception 'create_bundle_order: bundle % has no published member book', p_bundle_id using errcode = 'EB027';
  end if;

  -- order_items.sku_id is not null, so a member with no sku at all cannot be put on an order. That
  -- is a catalog fault rather than a sale: refusing the bundle is the only answer that neither
  -- drops a book the buyer is paying for nor fails on a constraint halfway through.
  select count(*) into v_missing_sku_count from unnest(v_lines) m where m.sku_id is null;
  if v_missing_sku_count > 0 then
    raise exception 'create_bundle_order: bundle % has a member book with no sku', p_bundle_id using errcode = 'EB027';
  end if;

  select count(*) into v_owned_count
  from unnest(v_lines) m
  join public.entitlements e
    on e.profile_id = v_profile_id and e.book_id = m.book_id and e.status = 'active';

  if v_owned_count = v_member_count then
    raise exception 'create_bundle_order: profile % already owns every book of bundle %', v_profile_id, p_bundle_id
      using errcode = 'EB013';
  end if;

  -- Lock the caller's pending orders for this bundle before touching payments or orders, matching
  -- apply_payment_event's orders-then-payments lock order.
  perform 1
  from public.orders o
  where o.profile_id = v_profile_id and o.bundle_id = p_bundle_id and o.status = 'pending'
  for update;

  -- A pending order whose snapshot no longer matches the offer is stale: cancel it so the reader
  -- always pays the price the bundle page shows (spec 4.3, unchanged for bundles). Line for line
  -- the same three staleness conditions create_ebook_order uses, and for the same reasons:
  --
  --   subtotal_minor, NOT total_minor: a coupon lowers the total, and comparing the total to the
  --   offer price would read every discounted pending order as stale and cancel it on the reader's
  --   next visit to the bundle page. The subtotal is the offer price as quoted.
  --
  --   a provider switch makes an order stale the same way a price change does - an order booked
  --   under the other provider is invisible to every surface of the active one, so reusing it
  --   would strand the reader on a checkout page that cannot progress. This is the defect this
  --   function shipped with: it booked every bundle order under 'simulator' regardless of the
  --   setting, so on a manual-provider deployment a bundle could be ordered and never paid for.
  update public.payments pay
  set status = 'cancelled'
  where pay.status = 'pending'
    and pay.order_id in (
      select o.id from public.orders o
      where o.profile_id = v_profile_id and o.bundle_id = p_bundle_id and o.status = 'pending'
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
  -- order - permanently consuming one use of the code for nothing. A no-op until bundle coupon
  -- scoping lands (20260924160000), and wrong to leave for that task to remember.
  delete from public.coupon_redemptions r
  where r.order_id in (
    select o.id from public.orders o
    where o.profile_id = v_profile_id and o.bundle_id = p_bundle_id and o.status = 'pending'
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
  where o.profile_id = v_profile_id and o.bundle_id = p_bundle_id and o.status = 'pending'
    and (
      o.subtotal_minor <> v_price_minor
      or o.currency <> v_currency
      or not exists (
        select 1 from public.payments p2 where p2.order_id = o.id and p2.provider = v_provider
      )
    );

  select o.id into v_order_id
  from public.orders o
  where o.profile_id = v_profile_id and o.bundle_id = p_bundle_id and o.status = 'pending'
  order by o.created_at desc
  limit 1;

  if v_order_id is not null then
    return v_order_id;
  end if;

  -- Vietnamese first, then English: the order is the shop's record of the sale, not the buyer's
  -- view of it, so it is named the same way whichever locale the reader bought from.
  select bl.title into v_title_snapshot
  from public.bundle_localizations bl
  where bl.bundle_id = p_bundle_id
  order by (bl.locale = 'vi') desc, bl.locale
  limit 1;

  -- subtotal_minor is set explicitly rather than left to orders_subtotal_minor_trigger, and
  -- payment_provider explicitly rather than left to the column default 'simulator', both matching
  -- create_ebook_order. A default is the right safety net for a writer that forgets; it is not a
  -- decision an order-creating RPC gets to leave to one.
  insert into public.orders (
    profile_id, bundle_id, status, payment_status, market_code, currency,
    total_minor, subtotal_minor, payment_provider, title_snapshot
  )
  values (
    v_profile_id, p_bundle_id, 'pending', 'pending', v_market_code, v_currency,
    v_price_minor, v_price_minor, v_provider, coalesce(v_title_snapshot, '')
  )
  returning id into v_order_id;

  -- The FIRST member carries the price, identified by row_number rather than by `position = 1`:
  -- for a bundle whose members are numbered the way admin_set_bundle_members numbers them these
  -- are the same row, and where a drift has left position 1 unpublished this still puts the price
  -- on a line that exists.
  insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, quantity, position)
  select
    v_order_id,
    m.sku_id,
    m.book_id,
    m.title_snapshot,
    case when row_number() over (order by m.line_position) = 1 then v_price_minor else 0 end,
    1,
    m.line_position
  from unnest(v_lines) m;

  -- The same provider the order is booked under, from commerce_settings and never from the caller.
  -- apply_payment_event resolves this row by (order_id, provider) when events arrive, and refuses
  -- (EB016) an event whose provider is not the order's.
  insert into public.payments (order_id, provider, status, amount_minor, currency)
  values (v_order_id, v_provider, 'pending', v_price_minor, v_currency);

  return v_order_id;
end;
$$;



revoke execute on function public.create_bundle_order(uuid) from public, anon;
grant execute on function public.create_bundle_order(uuid) to authenticated;

-- 2. The price rule is internal; the public read is gated ------------------------------------------
--
-- bundle_live_offer is security definer and deliberately does not check bundle status, because
-- readiness has to ask about a DRAFT bundle's offer and create_bundle_order checks published status
-- itself under its own lock. Granting that function to anon published the draft half of it: anyone
-- who knew or guessed a bundle uuid could read an unpublished bundle's offer id, market, currency
-- and price straight out of the RPC, which is exactly what the offers RLS policy exists to prevent.
--
-- Split, rather than adding a status parameter a caller could get wrong. The rule stays internal
-- and ungranted; the public read is its own function, published bundles only, and is what
-- lib/data/public-bundles.ts calls. It is named for the surface it serves, like
-- catalog_bundle_cover.
revoke execute on function public.bundle_live_offer(uuid) from anon, authenticated, service_role;

create function public.catalog_bundle_live_offer(p_bundle_id uuid)
returns table (offer_id uuid, market_code text, currency text, price_minor bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select l.offer_id, l.market_code, l.currency, l.price_minor
  from public.bundles b
  join lateral public.bundle_live_offer(b.id) l on true
  where b.id = p_bundle_id
    and b.status = 'published';
$$;

revoke execute on function public.catalog_bundle_live_offer(uuid) from public;
grant execute on function public.catalog_bundle_live_offer(uuid) to anon, authenticated, service_role;
