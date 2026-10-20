-- S8: a settled order redeems its coupon reservation; a cancelled one releases it (spec 5.3).
--
-- No new error codes, no signature change, and no new refusal: that is the point. Because a code is
-- reserved when it is applied, this function never has to decide whether a coupon is still
-- available - it only moves a row that already exists. A payment event can therefore never fail
-- because of a coupon, which is what keeps "the money arrived but the code ran out" from being a
-- state this system can reach.
--
-- Two additions to the 20260922180000 text, and nothing else, continuing that file's numbering of
-- the standing divergence from the S3 original (20260911190000_entitlement_rpcs.sql:354):
--   6. in the 'succeeded' branch, immediately after the library_items insert: flip this order's
--      coupon reservation, if it has one, to 'redeemed' with redeemed_at = now(), scoped to
--      status = 'reserved' so a replay or an already-redeemed row is left untouched.
--   7. in the final `else` (cancelled) branch, immediately after the orders update: delete this
--      order's coupon reservation, if it has one, releasing the code for reuse.
-- A 'failed' event adds nothing: the order stays pending and the reader may pay again, so the
-- reservation must stay reserved for that retry - touching that branch would be the mistake, not an
-- omission.
--
-- Both additions key strictly on order_id and are no-ops on an order with no coupon, since
-- coupon_redemptions.order_id is unique and an uncoupled order simply has no row to match.
--
-- Everything else - the lock order, the provider guard (EB016), the payments resolution, the
-- payment_events insert, the replay branch, the terminal-order guard, the amount check, and the
-- 'succeeded'/'failed' branches themselves - is the 20260922180000 text unchanged.
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

    -- (6) The order's coupon reservation, if it has one, is redeemed alongside it. Scoped to
    -- status = 'reserved' so this stays a no-op both for an order with no coupon (no row to match)
    -- and for a replayed/out-of-order event that reaches this branch again (already 'redeemed').
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

    -- (7) A cancelled order releases its coupon reservation outright, rather than marking it
    -- something else: the code must be free for the same reader, or another, to use again. A no-op
    -- on an order with no coupon.
    delete from public.coupon_redemptions r where r.order_id = p_order_id;
  end if;

  return query select v_entitlement_id, v_order_status, v_payment_status;
end;
$$;

revoke execute on function public.apply_payment_event(text, text, uuid, text, text, bigint, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_payment_event(text, text, uuid, text, text, bigint, text, timestamptz)
  to service_role;
