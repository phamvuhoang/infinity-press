-- S9: buying a bundle (docs/superpowers/specs/2026-09-21-s9-bundles-and-gifts-design.md 5 and 6.3).
--
-- New error code:
--   EB027 - create_bundle_order: the bundle cannot be bought. It is not published, it has no live
--           offer above 0, or it has no published member book left to sell. One code, because from
--           the storefront's side these are one answer - "not for sale right now" - and the page
--           resolves what it can show from the same three facts before it ever renders a Buy form.
--
-- EB013 keeps its S3 meaning ("the caller already owns this") and EB011/EB005 keep theirs, so the
-- application wrapper maps the same codes to the same errors for a book and for a bundle.
--
-- Three things land here: a public read policy for a published bundle's offer, a narrow read of a
-- published bundle's cover key, and create_bundle_order itself.
--
-- create_bundle_order mirrors create_ebook_order as it stands after 20260923100000, INCLUDING its
-- commerce_settings read: one read of (payments_enabled, payment_provider), the provider written to
-- both orders.payment_provider and payments.provider, and a provider switch treated as staleness
-- exactly as a price change is. A bundle order booked under the wrong provider can never be paid.

-- orders.title_snapshot ------------------------------------------------------------------------
--
-- Spec 5: a bundle order "snapshots the bundle title and price on `orders`". The price already had
-- a home (total_minor); the title did not, because a single-book order's one order_items row was
-- also its name. A bundle order has several lines and none of them is the bundle, so without this
-- column the checkout and receipt views would have to name a three-book order after whichever book
-- sorted first.
--
-- Nullable, and null for every order that existed before this migration and for every single-book
-- order after it: those are still named by their one line. What is snapshotted is the title AS SOLD,
-- so renaming or unpublishing the bundle afterwards never rewrites what the buyer paid for.
alter table public.orders add column title_snapshot text;

-- Public reads of a bundle's price -------------------------------------------------------------
--
-- The S3 policy "public read active in-window offers" (20260911090000) requires
-- `exists (select 1 from public.skus s … where s.id = offers.sku_id …)`, which is FALSE - not
-- unknown, not permissive - for every row where sku_id is null. So since 20260924110000 made
-- bundle offers possible, a bundle's price has been readable by no browser role at all. That fails
-- closed rather than leaking, but the public bundle page reads the price as anon/authenticated and
-- would show a priced bundle with no price.
--
-- Policies are permissive and OR together, so this is an addition rather than a rewrite of that
-- one: each names the rows it was written for, and `offers_exactly_one_product` guarantees the two
-- sets cannot overlap.
--
-- Same three liveness conditions as the sku policy, so "readable" and "on sale" are one fact for a
-- bundle exactly as they are for a book: the storefront never has to re-derive liveness from an
-- `active` flag it was allowed to read.
create policy "public read live offers of published bundles" on public.offers
  for select
  to anon, authenticated
  using (
    active
    and (starts_at is null or starts_at <= now())
    and (ends_at is null or ends_at > now())
    and exists (
      select 1 from public.bundles b
      where b.id = offers.bundle_id
        and b.status = 'published'
    )
  );

-- A published bundle's cover key ---------------------------------------------------------------
--
-- media_assets.storage_key is withheld from anon and authenticated by the column grant in
-- 20260911200000, and that grant is not widened here: an object key is not a public API contract.
-- The published-book path gets around this with catalog_book_cards, which is a definer function
-- returning the key; this is the same idiom at bundle scale, and the same shape as
-- admin_get_book_cover (20260913130000) with a published-bundle check in place of the admin one.
create function public.catalog_bundle_cover(p_bundle_id uuid)
returns table (storage_key text, alt_text text)
language sql
stable
security definer
set search_path = ''
as $$
  select asset.storage_key, asset.alt_text
  from public.media_assets as asset
  join public.bundles b on b.id = asset.owner_id and b.status = 'published'
  where asset.owner_type = 'bundle' and asset.kind = 'cover' and asset.owner_id = p_bundle_id;
$$;

revoke all on function public.catalog_bundle_cover(uuid) from public, anon, authenticated, service_role;
grant execute on function public.catalog_bundle_cover(uuid) to anon, authenticated;

-- The lines a bundle order would carry ---------------------------------------------------------
--
-- create_bundle_order asks this three questions - how many members are there, how many does the
-- buyer already own, and what goes on the order - and all three must be answered about the SAME
-- set. It is one function for the same reason order_active_entitlement_ids (20260924100000) is:
-- so the set cannot drift between the check and the write.
--
-- Published members only (see create_bundle_order below), in bundle_books.position order, each
-- with the sku the line has to name and the book's own original-language title, resolved exactly
-- the way create_ebook_order resolves a single book's title snapshot.
--
-- security definer with no browser grant: it reads books and skus for a bundle without regard to
-- the caller, and only the definer-owned function below calls it.
create function public.bundle_order_lines(p_bundle_id uuid)
returns table (line_position integer, book_id uuid, sku_id uuid, title_snapshot text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    bb.position,
    bb.book_id,
    (
      select sk.id
      from public.skus sk
      join public.editions ed on ed.id = sk.edition_id
      where ed.book_id = bb.book_id
      order by sk.active desc, sk.sku_code
      limit 1
    ),
    coalesce((
      select bl.title
      from public.book_localizations bl
      where bl.book_id = bb.book_id
      order by (bl.locale = b.original_language) desc, bl.locale
      limit 1
    ), '')
  from public.bundle_books bb
  join public.books b on b.id = bb.book_id
  where bb.bundle_id = p_bundle_id
    and b.status = 'published'
  order by bb.position;
$$;

revoke execute on function public.bundle_order_lines(uuid) from public, anon, authenticated, service_role;

-- create_bundle_order ---------------------------------------------------------------------------
--
-- The bundle counterpart of create_ebook_order (20260915120000) and deliberately its mirror image:
-- the profile comes from auth.uid(), the offer, price and titles come from the database, and the
-- caller supplies nothing but a bundle id.
--
-- Two rules are specific to bundles, and both come from spec 5:
--
--   Partial ownership is allowed, at the full price. A reader who owns one of three member books
--   still buys the bundle for what the bundle costs; EB013 fires only when there is nothing left
--   to gain. apply_payment_event's `on conflict … do nothing` already makes granting an
--   already-held book a no-op, so the owned book simply stays owned.
--
--   The price is not spread across the lines. One line carries the whole bundle price and the rest
--   carry zero, so `sum(unit_price_minor)` still equals orders.total_minor while no line ever
--   claims a per-book price that was never quoted - which a refund, a receipt or a future partial
--   revocation would otherwise read as this book's worth.
--
-- Only PUBLISHED member books are sold. Readiness (20260924120000) is a publish-time gate, not an
-- invariant: admin_set_bundle_members can add a draft book to a bundle that is already published.
-- Selling one would hand the buyer an entitlement to a book the storefront refuses to sell on its
-- own page, so the order carries exactly the members the bundle page shows - which is also what
-- makes "you already own all of these" on the page and EB013 here the same statement.
create function public.create_bundle_order(p_bundle_id uuid)
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

  -- The published check and the offer lookup are one statement, so a bundle that is unpublished
  -- between the two can never be sold at a price read before it was.
  select o.id, o.market_code, o.currency, o.price_minor
  into v_offer_id, v_market_code, v_currency, v_price_minor
  from public.offers o
  join public.bundles b on b.id = o.bundle_id
  where o.bundle_id = p_bundle_id
    and b.status = 'published'
    and o.active
    and o.price_minor > 0
    and (o.starts_at is null or o.starts_at <= now())
    and (o.ends_at is null or o.ends_at > now())
  order by o.market_code, o.currency
  limit 1
  for update of o;

  if v_offer_id is null then
    raise exception 'create_bundle_order: bundle % is not purchasable', p_bundle_id using errcode = 'EB027';
  end if;

  select count(*) into v_member_count from public.bundle_order_lines(p_bundle_id);
  if v_member_count = 0 then
    raise exception 'create_bundle_order: bundle % has no published member book', p_bundle_id using errcode = 'EB027';
  end if;

  -- order_items.sku_id is not null, so a member with no sku at all cannot be put on an order. That
  -- is a catalog fault rather than a sale: refusing the bundle is the only answer that neither
  -- drops a book the buyer is paying for nor fails on a constraint halfway through.
  select count(*) into v_missing_sku_count from public.bundle_order_lines(p_bundle_id) where sku_id is null;
  if v_missing_sku_count > 0 then
    raise exception 'create_bundle_order: bundle % has a member book with no sku', p_bundle_id using errcode = 'EB027';
  end if;

  select count(*) into v_owned_count
  from public.bundle_order_lines(p_bundle_id) m
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
  from public.bundle_order_lines(p_bundle_id) m;

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
