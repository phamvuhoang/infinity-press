-- S7 PR fix C1: an event may only be applied under the provider its order was booked under.
--
-- New error code, continuing the EB0xx series (EB015 is taken by 20260922100010, and EB020-EB023
-- by the manual-transfer migrations):
--   EB016 - apply_payment_event: the event's provider disagrees with orders.payment_provider.
--
-- What this file changes, and why:
--
--   * The order lock now also reads o.payment_provider (and v_order_provider is declared for it).
--   * An event whose p_provider differs from it raises EB016, before any payments row is resolved
--     or created, before the payment_events insert, and before any state is derived.
--
-- Nothing else. That minimality is the property this function's reviews keep checking, so the full
-- standing divergence from the S3 original (20260911190000_entitlement_rpcs.sql:354) is listed here
-- rather than counted loosely. There are FIVE, and the two above are the fourth and fifth:
--
--   1. the v_source declaration and the provider->entitlement_source map, with its EB015 raise
--      (20260922100010)
--   2. the entitlement insert taking v_source where S3 wrote the 'simulated_payment' literal
--      (20260922100010)
--   3. the revoke/grant block re-stated after the replacement. Its text matches S3's exactly and
--      `create or replace` preserves privileges, so it changes nothing; it is carried because
--      20260922100010 states it, and dropping it now would be a silent change to a grant
--   4. the o.payment_provider read in the order lock (this file)
--   5. the EB016 raise (this file)
--
-- The lock order, the payment_events insert that makes duplicate delivery safe,
-- the replay branch, the terminal-order guard, the amount check, and all three outcome branches are
-- the 20260922100010 text unchanged.
--
-- Why it matters. This function resolves its payments row by (order_id, provider) and creates one
-- when none exists. Ruling R31 concluded no reachable caller could pass a provider the order was
-- not booked under; it traced only the manual-provider callers, which are circular, and missed the
-- simulator webhook. A simulator event delivered for an order booked as 'manual' found no matching
-- payments row, created a SECOND one, and granted an entitlement whose source_type said
-- 'simulated_payment' while orders.payment_provider said 'manual' - two providers on one order,
-- with the reader's pages reading one and the admin's the other. The application now refuses a
-- mismatched order on every provider-specific surface, and this is the backstop under them: a
-- surface added later inherits the guarantee without knowing about it.
--
-- What it must not break, and does not: orders predating orders.payment_provider carry the column's
-- 'simulator' default and their events are simulator events, which agree; a free order has no
-- payments row and never receives an event at all.
create or replace function public.apply_payment_event(
  p_provider text,
  p_provider_event_id text,
  p_order_id uuid,
  p_external_payment_id text,
  p_status text,
  p_amount_minor bigint,
  p_currency text,
  p_occurred_at timestamptz
)
returns table (entitlement_id uuid, order_status public.order_status, payment_status public.payment_status)
language plpgsql
security definer
set search_path = ''
as $$
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
  v_entitlement_id uuid;
  v_payload_hash text;
begin
  -- Resolved before anything else, so an event from a provider this database has no source mapping
  -- for is refused before any row is locked or written - never defaulted to some other provider's
  -- source type. This stays ahead of the EB016 comparison below: a provider this database does not
  -- know at all is not a mismatch with the order, it is not a provider.
  v_source := case p_provider
    when 'simulator' then 'simulated_payment'::public.entitlement_source
    when 'manual' then 'manual_payment'::public.entitlement_source
    else null
  end;
  if v_source is null then
    raise exception 'apply_payment_event: unknown provider %', p_provider using errcode = 'EB015';
  end if;

  if p_status not in ('succeeded', 'failed', 'cancelled') then
    raise exception 'apply_payment_event: invalid status %', p_status using errcode = '22023';
  end if;
  v_status := p_status::public.payment_status;

  -- Lock the order row before anything else, so two events for the same order can never be
  -- evaluated concurrently against each other. Columns are qualified with the `o` alias because
  -- this function's own OUT parameters are named order_status/payment_status too - left
  -- unqualified, orders.payment_status is ambiguous against the OUT parameter of the same name.
  select o.status, o.payment_status, o.total_minor, o.currency, o.profile_id, o.payment_provider
  into v_order_status, v_payment_status, v_order_total_minor, v_order_currency, v_profile_id, v_order_provider
  from public.orders o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'apply_payment_event: order % does not exist', p_order_id using errcode = 'P0002';
  end if;

  -- The provider guard. It sits here and not lower down for one reason: the payments resolution
  -- below CREATES a row for an (order_id, provider) pair that has none, so any check made after it
  -- would be checking a row this event had already brought into existence.
  if p_provider <> v_order_provider then
    raise exception 'apply_payment_event: order % is booked under provider %, not %',
      p_order_id, v_order_provider, p_provider using errcode = 'EB016';
  end if;

  -- Resolved once, up front, and reused for every entitlement lookup below (replay, out-of-order,
  -- and success). The subject an event grants access to is (profile_id, book_id) - the same pair
  -- entitlements_active_subject_key uniquely constrains - never source_order_id: a buyer who
  -- already holds an active entitlement from a DIFFERENT order (another simulated_payment, a
  -- free_order, or an admin_grant) still resolves by subject in the success branch's own
  -- `on conflict ... do nothing` fallback, so a lookup keyed by source_order_id = p_order_id would
  -- find nothing for that order and wrongly report entitlement_id = null on replay.
  select oi.book_id into v_book_id from public.order_items oi where oi.order_id = p_order_id limit 1;

  -- Resolve (or, on the first event for this order/provider pair, create) the payments row the
  -- event contract's externalPaymentId/orderId map onto. payment_events.payment_id is not null,
  -- so it must exist before the event row below can be inserted; this happens even on a replay
  -- of an already-processed event, which is a harmless no-op (the row already exists, so this
  -- resolves it rather than creating a duplicate).
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
    select e.id into v_entitlement_id
    from public.entitlements e
    where e.profile_id = v_profile_id and e.book_id = v_book_id and e.status = 'active';

    return query select v_entitlement_id, v_order_status, v_payment_status;
    return;
  end if;

  if v_order_status <> 'pending' then
    -- Out-of-order arrival: the order already left 'pending' (completed or cancelled) via an
    -- earlier-processed event. This new event is recorded (payment_events above) but has no
    -- further effect - it must not resurrect a cancelled order or re-derive a different outcome
    -- for an already-completed one.
    select e.id into v_entitlement_id
    from public.entitlements e
    where e.profile_id = v_profile_id and e.book_id = v_book_id and e.status = 'active';

    return query select v_entitlement_id, v_order_status, v_payment_status;
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

    insert into public.entitlements (profile_id, book_id, source_type, source_order_id, status)
    values (v_profile_id, v_book_id, v_source, p_order_id, 'active')
    on conflict (profile_id, book_id) where status = 'active' do nothing
    returning id into v_entitlement_id;

    if v_entitlement_id is null then
      select id into v_entitlement_id
      from public.entitlements
      where profile_id = v_profile_id and book_id = v_book_id and status = 'active';
    end if;

    insert into public.library_items (profile_id, book_id, entitlement_id)
    values (v_profile_id, v_book_id, v_entitlement_id)
    on conflict (profile_id, book_id) do nothing;

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
  end if;

  return query select v_entitlement_id, v_order_status, v_payment_status;
end;
$$;

revoke execute on function public.apply_payment_event(text, text, uuid, text, text, bigint, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_payment_event(text, text, uuid, text, text, bigint, text, timestamptz)
  to service_role;
