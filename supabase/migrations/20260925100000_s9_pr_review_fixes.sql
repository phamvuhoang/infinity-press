-- S9 pull-request review fixes.
--
-- Four findings from the review of PR #28, each fixed here rather than by amending the migration
-- that introduced it: this branch is pushed, so every earlier S9 migration must be treated as
-- applied somewhere.
--
--   1. Resend and reissue reused the previous email's idempotency key.
--   2. The bundle page and create_bundle_order resolved a live offer by different rules.
--   3. create_bundle_order could validate one bundle membership and sell another.
--   4. A zero-price active offer let a bundle publish that no reader could buy.

-- 1. Delivery generation --------------------------------------------------------------------------
--
-- notification_outbox.id identifies a DELIVERY ROW; it does not identify an attempt to deliver a
-- particular message. admin_resend_gift and admin_reissue_gift both rewind that same row, so every
-- send it ever produced carried the idempotency key `gift-claim/<row id>`. The provider keeps an
-- idempotency key for 24 hours and requires a distinct key per distinct request, which made both
-- admin actions fail in the field rather than in a way an operator could see:
--
--   a resend inside that window repeats the key AND the payload, so the provider treats it as a
--   retry of the original request and returns the original message id - the recipient who said the
--   mail never arrived is sent nothing at all;
--
--   a reissue repeats the key with a DIFFERENT payload (a new address, a new claim link), which
--   the provider rejects outright, and the worker then spends the row's six attempts on a request
--   that can never succeed.
--
-- The generation separates the two ideas. An automatic worker retry is the same delivery and keeps
-- the generation it had, so retry dedupe still works exactly as before. An admin resend or reissue
-- is a NEW delivery and increments it, which mints a new key.
alter table public.notification_outbox
  add column delivery_generation integer not null default 0;

comment on column public.notification_outbox.delivery_generation is
  'Bumped by an admin resend or reissue so the next send gets a fresh provider idempotency key. Worker retries never change it.';

-- Carried over verbatim from 20260924150000 but for the added output column, which forces a drop.
drop function public.claim_notification_outbox(integer, uuid);

create function public.claim_notification_outbox(p_limit integer, p_lease_token uuid)
returns table (
  id uuid,
  entitlement_id uuid,
  profile_id uuid,
  gift_id uuid,
  template_key text,
  payload jsonb,
  attempt_count integer,
  delivery_generation integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 25));
  v_lease_expires timestamptz := now() + interval '5 minutes';
begin
  return query
  with candidates as (
    select o.id
    from public.notification_outbox o
    left join public.entitlements e on e.id = o.entitlement_id
    left join public.gifts g on g.id = o.gift_id
    where o.sent_at is null
      and o.available_at <= now()
      and (o.lease_token is null or o.lease_expires_at <= now())
      and o.attempt_count < 6
      and (
        (o.entitlement_id is not null and e.status = 'active')
        or (o.gift_id is not null and g.status = 'sent')
      )
    order by o.available_at, o.created_at, o.id
    limit v_limit
    for update of o skip locked
  )
  update public.notification_outbox o
  set lease_token = p_lease_token,
      lease_expires_at = v_lease_expires
  from candidates
  where o.id = candidates.id
  returning o.id, o.entitlement_id, o.profile_id, o.gift_id, o.template_key, o.payload,
            o.attempt_count, o.delivery_generation;
end;
$$;

revoke execute on function public.claim_notification_outbox(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_notification_outbox(integer, uuid) to service_role;

-- Resend: one added assignment. Everything else is 20260924170000's function unchanged.
create or replace function public.admin_resend_gift(p_gift_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gift record;
  v_outbox record;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_resend_gift: caller is not an admin' using errcode = '42501';
  end if;

  select g.id, g.status, g.order_id, g.recipient_email into v_gift
  from public.gifts g where g.id = p_gift_id for update;

  if v_gift.id is null then
    raise exception 'admin_resend_gift: gift % does not exist', p_gift_id using errcode = 'P0002';
  end if;
  if v_gift.status <> 'sent' then
    raise exception 'admin_resend_gift: gift % is % and has no delivery to retry', p_gift_id, v_gift.status
      using errcode = 'EB030';
  end if;

  select o.id, o.attempt_count into v_outbox
  from public.notification_outbox o where o.gift_id = p_gift_id for update;

  if v_outbox.id is null then
    raise exception 'admin_resend_gift: gift % has no outbox row', p_gift_id using errcode = 'EB030';
  end if;

  update public.notification_outbox o
  set available_at = now(),
      attempt_count = 0,
      last_error_code = null,
      lease_token = null,
      lease_expires_at = null,
      sent_at = null,
      -- A deliberate second send of the same message, which the provider must not fold into the
      -- first one. See this file's header.
      delivery_generation = o.delivery_generation + 1
  where o.id = v_outbox.id;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'resend_gift', 'gifts', p_gift_id,
          jsonb_build_object(
            'order_id', v_gift.order_id,
            'recipient_email_mask', public.mask_email(v_gift.recipient_email),
            'previous_attempt_count', v_outbox.attempt_count));
end;
$$;

-- Reissue: the same one added assignment, and for the sharper reason - the payload changes here,
-- so a repeated key is not a duplicate send but a provider rejection.
create or replace function public.admin_reissue_gift(
  p_gift_id uuid,
  p_recipient_email text,
  p_token_hash text,
  p_claim_path text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gift record;
  v_outbox_id uuid;
  v_email text;
  v_reason text;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_reissue_gift: caller is not an admin' using errcode = '42501';
  end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'admin_reissue_gift: a reason is required' using errcode = '22023';
  end if;

  v_email := lower(btrim(coalesce(p_recipient_email, '')));
  if v_email = '' then
    raise exception 'admin_reissue_gift: a recipient address is required' using errcode = '22023';
  end if;

  select g.id, g.status, g.order_id, g.recipient_email into v_gift
  from public.gifts g where g.id = p_gift_id for update;

  if v_gift.id is null then
    raise exception 'admin_reissue_gift: gift % does not exist', p_gift_id using errcode = 'P0002';
  end if;
  if v_gift.status = 'claimed' then
    raise exception 'admin_reissue_gift: gift % has been claimed', p_gift_id using errcode = 'EB031';
  end if;
  if v_gift.status <> 'sent' then
    raise exception 'admin_reissue_gift: gift % is % and has no live delivery to reissue', p_gift_id, v_gift.status
      using errcode = 'EB030';
  end if;

  update public.gifts g
  set recipient_email = v_email,
      claim_token_hash = p_token_hash,
      status = 'sent',
      claimed_by_profile_id = null,
      claimed_at = null,
      revoked_at = null,
      revoked_reason = null
  where g.id = p_gift_id;

  select o.id into v_outbox_id
  from public.notification_outbox o where o.gift_id = p_gift_id for update;

  if v_outbox_id is null then
    raise exception 'admin_reissue_gift: gift % has no outbox row', p_gift_id using errcode = 'EB030';
  end if;

  update public.notification_outbox o
  set payload = jsonb_build_object('claimPath', p_claim_path),
      available_at = now(),
      attempt_count = 0,
      last_error_code = null,
      lease_token = null,
      lease_expires_at = null,
      sent_at = null,
      delivery_generation = o.delivery_generation + 1
  where o.id = v_outbox_id;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, reason, metadata)
  values (v_actor_profile_id, 'reissue_gift', 'gifts', p_gift_id, v_reason,
          jsonb_build_object(
            'order_id', v_gift.order_id,
            'previous_status', v_gift.status,
            'previous_recipient_email_mask', public.mask_email(v_gift.recipient_email),
            'recipient_email_mask', public.mask_email(v_email)));
end;
$$;

-- 2. One market-resolution rule ---------------------------------------------------------------------
--
-- A bundle may hold several live offers - admin_set_bundle_offer upserts on (market, currency) -
-- so choosing among them is a rule, and a rule stated twice is a rule that drifts. It did: the
-- public page took the cheapest, create_bundle_order took the first by (market_code, currency).
-- A reader could be shown one price and charged another.
--
-- Cheapest wins, with the market and currency codes breaking a tie so the answer is stable across
-- renders and across the two callers. Price ties are broken by code rather than left to the
-- planner because an unstable answer here is the same defect in a quieter form.
--
-- Bundle status is NOT part of this rule. Readiness has to ask about a draft bundle's offer, and
-- create_bundle_order checks published status itself, under the row lock it already holds.
create function public.bundle_live_offer(p_bundle_id uuid)
returns table (offer_id uuid, market_code text, currency text, price_minor bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.market_code, o.currency, o.price_minor
  from public.offers o
  where o.bundle_id = p_bundle_id
    and o.active
    -- Finding 4: a zero-price offer is not a live offer. admin_set_bundle_offer now refuses to
    -- create one while active, and this is the same statement made where every reader of the rule
    -- can see it.
    and o.price_minor > 0
    and (o.starts_at is null or o.starts_at <= now())
    and (o.ends_at is null or o.ends_at > now())
  order by o.price_minor, o.market_code, o.currency
  limit 1;
$$;

-- The public bundle page calls this as an anonymous or signed-in reader, which is the same
-- information `offers` already exposes for a published bundle.
revoke execute on function public.bundle_live_offer(uuid) from public;
grant execute on function public.bundle_live_offer(uuid) to anon, authenticated, service_role;

-- 3 and 2, in the order function ---------------------------------------------------------------------
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

  -- PR review, finding 3. The bundle row is locked BEFORE anything is read from it, and held for
  -- the rest of the transaction. Everything below - the offer, the member count, the sku check,
  -- the ownership check, the order_items insert - reads bundle membership through
  -- bundle_order_lines, once per statement, under READ COMMITTED. Without this lock an admin
  -- running admin_set_bundle_members (which locks this same row and then replaces the membership
  -- wholesale) could commit between two of those statements, and the order would be validated
  -- against one set of books and written from another. Holding the row lock means no membership
  -- change can commit while this order is being built, so every one of those reads sees the same
  -- set. It also serializes against publish_bundle, which is what keeps the status check below and
  -- the price read beneath it a single decision.
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

-- 4. A publishable bundle is a buyable bundle -------------------------------------------------------
--
-- Readiness asked only whether an active in-window offer existed, admin_set_bundle_offer accepted
-- a price of 0, and create_bundle_order sells only a positive price. So a bundle priced at zero
-- passed the publish gate and then answered `unavailable` on its own page - and with a second,
-- positive offer alongside it the page picked the cheaper zero offer and hid the buy button for a
-- bundle the order RPC would happily have sold.
--
-- Fixed at both ends. The offer writer refuses to make an active offer free, and readiness asks
-- the same question the storefront and the order RPC ask: is there a LIVE offer, which now means
-- a positive one.
create or replace function public.admin_set_bundle_offer(
  p_bundle_id uuid,
  p_market_code text,
  p_currency text,
  p_price_minor bigint,
  p_active boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_offer_id uuid;
  v_previous_price bigint;
  v_active boolean := coalesce(p_active, true);
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_set_bundle_offer: caller is not an admin' using errcode = '42501';
  end if;

  perform 1 from public.bundles where id = p_bundle_id for update;
  if not found then
    raise exception 'admin_set_bundle_offer: bundle % does not exist', p_bundle_id using errcode = 'P0002';
  end if;

  if p_market_code !~ '^[A-Z]{2}$' then
    raise exception 'admin_set_bundle_offer: % is not a market code', p_market_code using errcode = '22023';
  end if;
  if p_currency !~ '^[A-Z]{3}$' then
    raise exception 'admin_set_bundle_offer: % is not a currency code', p_currency using errcode = '22023';
  end if;
  if p_price_minor is null or p_price_minor < 0 then
    raise exception 'admin_set_bundle_offer: a price of 0 or more is required' using errcode = '22023';
  end if;
  -- An inactive zero-price row stays allowed: it is a draft price, not an offer, and nothing
  -- reads it. Only making it live is refused.
  if v_active and p_price_minor = 0 then
    raise exception 'admin_set_bundle_offer: an active bundle offer needs a price above 0' using errcode = '22023';
  end if;

  select id, price_minor into v_offer_id, v_previous_price
  from public.offers
  where bundle_id = p_bundle_id and market_code = p_market_code and currency = p_currency
  for update;

  if v_offer_id is null then
    insert into public.offers (bundle_id, market_code, currency, price_minor, active)
    values (p_bundle_id, p_market_code, p_currency, p_price_minor, v_active)
    returning id into v_offer_id;
  else
    update public.offers
    set price_minor = p_price_minor, active = v_active
    where id = v_offer_id;
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'set_bundle_offer', 'bundles', p_bundle_id,
          jsonb_build_object('market_code', p_market_code, 'currency', p_currency,
                             'price_minor_from', v_previous_price, 'price_minor', p_price_minor,
                             'active', v_active));

  return v_offer_id;
end;
$$;

create or replace function public.bundle_readiness_issues(p_bundle_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select array_remove(array[
    case when (
      select count(*) from public.bundle_books bb
      join public.books b on b.id = bb.book_id
      where bb.bundle_id = p_bundle_id and b.status = 'published'
    ) < 2 then 'too_few_published_members' end,
    case when not exists (
      select 1 from public.bundle_localizations bl
      where bl.bundle_id = p_bundle_id
        and length(trim(bl.title)) > 0
        and length(trim(bl.slug)) > 0
        and length(trim(coalesce(bl.description, ''))) > 0
    ) then 'missing_localization' end,
    case when not exists (
      select 1 from public.media_assets m
      where m.owner_type = 'bundle' and m.owner_id = p_bundle_id and m.kind = 'cover'
    ) then 'missing_cover' end,
    -- The one shared rule, not a second copy of it: readiness now means exactly "the storefront
    -- would find a price here".
    case when not exists (
      select 1 from public.bundle_live_offer(p_bundle_id)
    ) then 'missing_offer' end
  ], null);
$$;

revoke execute on function public.bundle_readiness_issues(uuid) from public, anon, authenticated;
