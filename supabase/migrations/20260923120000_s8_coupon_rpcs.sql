-- S8: the reader's two coupon RPCs (docs/superpowers/specs/2026-09-21-s8-coupons-design.md 5.4).
--
-- New error code, continuing the EB0xx series (EB023 is taken by 20260922130000):
--   EB024 - apply_coupon_to_order / remove_coupon_from_order: the order is not the caller's own
--           pending order, already carries a coupon (apply) or carries none (remove), or has a
--           reported bank transfer.
--
-- Why a rejected CODE is returned rather than raised. PostgREST wraps an RPC in one transaction, so
-- a raise rolls back everything the call wrote - including record_coupon_failure, which is the
-- entire mechanism spec 5.5 asks for. The counter would sit at zero forever and the rate limit
-- would be decoration. So a coupon-validity failure comes back as `rejection = 'invalid'` (or
-- 'rate_limited'), the transaction commits, and the counter moves. Every such rejection carries the
-- SAME value: unknown, expired, not yet started, inactive, wrong book, exhausted, per-profile limit
-- reached, and wrong currency are indistinguishable to the caller.
--
-- And the discriminating reason is LOGGED, never returned. This function is granted to
-- `authenticated`, so anything in its result set is readable by any signed-in reader calling it
-- straight through PostgREST with their own JWT - a returned reason column would hand the very
-- oracle this design exists to close back to the guesser, one field to the left of the rejection
-- that was carefully made uniform. Each reason therefore goes out with `raise log`, carrying the
-- order id and the profile id so an operator can line it up with the Server Action's own log entry
-- for the same order, and the caller learns only that the code did not apply.
--
-- Refusals about the ORDER still raise EB024. They are not a code oracle - the caller already knows
-- which order they opened - and there is nothing to count for them.
--
-- The exhausted check sits above every rejection branch on purpose. record_coupon_failure carries
-- no write-suppression guard of its own (unlike its analytics sibling consume_analytics_quota), so
-- it would keep incrementing without bound inside an already-exhausted window. It is safe only
-- because no call to it is reachable once coupon_attempts_exhausted has said yes. Both quota
-- functions read their own now(), which is transaction-stable, and this function is one
-- transaction, so their two judgments can never disagree.
create function public.apply_coupon_to_order(p_order_id uuid, p_code text)
returns table (
  subtotal_minor bigint,
  discount_minor bigint,
  total_minor bigint,
  order_status public.order_status,
  entitlement_id uuid,
  rejection text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_code text;
  v_order record;
  v_coupon record;
  v_discount bigint;
  v_total bigint;
  v_used int;
  v_used_by_profile int;
  v_book_id uuid;
  v_entitlement_id uuid;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'apply_coupon_to_order: no profile for the current session' using errcode = 'P0002';
  end if;

  -- Lock the order first, so two applications on one order serialize, and so the coupon row lock
  -- below is always taken second. One lock order everywhere is what keeps this function and
  -- create_ebook_order from deadlocking against each other.
  select o.id, o.profile_id, o.status, o.currency, o.subtotal_minor, o.coupon_id
  into v_order
  from public.orders o
  where o.id = p_order_id and o.profile_id = v_profile_id
  for update;

  -- Another reader's order is indistinguishable from a missing one.
  if v_order.id is null or v_order.status <> 'pending' or v_order.coupon_id is not null then
    raise exception 'apply_coupon_to_order: order % is not an uncouponed pending order of the caller', p_order_id
      using errcode = 'EB024';
  end if;

  -- A reader who has already told us they transferred has sent a specific amount with a specific
  -- reference; moving the total underneath that report would leave the admin reconciling a payment
  -- against a number nobody ever saw. The code can still be applied before the transfer, which is
  -- when a reader would actually use one.
  if exists (select 1 from public.manual_transfer_claims c where c.order_id = p_order_id) then
    raise exception 'apply_coupon_to_order: order % already has a reported transfer', p_order_id
      using errcode = 'EB024';
  end if;

  if public.coupon_attempts_exhausted(v_profile_id) then
    raise log 'apply_coupon_to_order: order % profile %: too many failed attempts', p_order_id, v_profile_id;
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        null::uuid, 'rate_limited'::text;
    return;
  end if;

  -- Normalization mirrors lib/commerce/coupon.ts normalizeCouponCode exactly.
  v_code := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));

  select c.* into v_coupon
  from public.coupons c
  where c.code = v_code
  for update;

  if v_coupon.id is null then
    raise log 'apply_coupon_to_order: order % profile %: unknown code', p_order_id, v_profile_id;
    perform public.record_coupon_failure(v_profile_id);
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        null::uuid, 'invalid'::text;
    return;
  end if;

  if not v_coupon.active then
    raise log 'apply_coupon_to_order: order % profile %: inactive', p_order_id, v_profile_id;
    perform public.record_coupon_failure(v_profile_id);
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        null::uuid, 'invalid'::text;
    return;
  end if;

  if v_coupon.starts_at is not null and v_coupon.starts_at > now() then
    raise log 'apply_coupon_to_order: order % profile %: not yet started', p_order_id, v_profile_id;
    perform public.record_coupon_failure(v_profile_id);
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        null::uuid, 'invalid'::text;
    return;
  end if;

  if v_coupon.ends_at is not null and v_coupon.ends_at <= now() then
    raise log 'apply_coupon_to_order: order % profile %: expired', p_order_id, v_profile_id;
    perform public.record_coupon_failure(v_profile_id);
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        null::uuid, 'invalid'::text;
    return;
  end if;

  select oi.book_id into v_book_id from public.order_items oi where oi.order_id = p_order_id limit 1;

  -- No coupon_books rows at all means every book (spec 5.2).
  if exists (select 1 from public.coupon_books cb where cb.coupon_id = v_coupon.id)
     and not exists (select 1 from public.coupon_books cb where cb.coupon_id = v_coupon.id and cb.book_id = v_book_id) then
    raise log 'apply_coupon_to_order: order % profile %: wrong book', p_order_id, v_profile_id;
    perform public.record_coupon_failure(v_profile_id);
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        null::uuid, 'invalid'::text;
    return;
  end if;

  if v_coupon.kind = 'fixed' and v_coupon.currency <> v_order.currency then
    raise log 'apply_coupon_to_order: order % profile %: currency mismatch', p_order_id, v_profile_id;
    perform public.record_coupon_failure(v_profile_id);
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        null::uuid, 'invalid'::text;
    return;
  end if;

  -- Both limits are counted under the coupon row lock taken above, which is what makes "the last
  -- remaining use goes to exactly one of two concurrent readers" true: the second session blocks on
  -- the lock until the first has inserted its reservation, then counts it.
  select count(*) into v_used from public.coupon_redemptions r where r.coupon_id = v_coupon.id;
  if v_coupon.max_redemptions is not null and v_used >= v_coupon.max_redemptions then
    raise log 'apply_coupon_to_order: order % profile %: exhausted', p_order_id, v_profile_id;
    perform public.record_coupon_failure(v_profile_id);
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        null::uuid, 'invalid'::text;
    return;
  end if;

  select count(*) into v_used_by_profile
  from public.coupon_redemptions r where r.coupon_id = v_coupon.id and r.profile_id = v_profile_id;
  if v_used_by_profile >= v_coupon.max_redemptions_per_profile then
    raise log 'apply_coupon_to_order: order % profile %: per-profile limit reached', p_order_id, v_profile_id;
    perform public.record_coupon_failure(v_profile_id);
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        null::uuid, 'invalid'::text;
    return;
  end if;

  -- The same arithmetic as lib/commerce/coupon.ts computeDiscountMinor: floored, then clamped.
  -- Integer division in Postgres truncates toward zero, which on non-negative operands is floor.
  v_discount := case v_coupon.kind
    when 'percent' then (v_order.subtotal_minor * v_coupon.percent_off) / 100
    else v_coupon.amount_off_minor
  end;
  v_discount := least(greatest(v_discount, 0), v_order.subtotal_minor);
  v_total := v_order.subtotal_minor - v_discount;

  update public.orders o
  set coupon_id = v_coupon.id, coupon_code = v_coupon.code, discount_minor = v_discount, total_minor = v_total
  where o.id = p_order_id;

  insert into public.coupon_redemptions (coupon_id, order_id, profile_id, discount_minor, status)
  values (v_coupon.id, p_order_id, v_profile_id, v_discount, 'reserved');

  -- Every code that changed an order total is audited (spec 2). actor_profile_id is the reader
  -- here, not an admin: they are the actor.
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, reason, metadata)
  values (v_profile_id, 'coupon.applied', 'orders', p_order_id, null,
          jsonb_build_object('coupon_id', v_coupon.id, 'code', v_coupon.code,
                             'discount_minor', v_discount, 'total_minor', v_total));

  if v_total > 0 then
    update public.payments pay
    set amount_minor = v_total
    where pay.order_id = p_order_id and pay.status = 'pending';

    return query select v_order.subtotal_minor, v_discount, v_total, v_order.status,
                        null::uuid, null::text;
    return;
  end if;

  -- Zero total: the order completes here, in this transaction (spec 4). There is nothing to pay,
  -- so the pending payment is cancelled rather than left waiting for an event that will never come.
  -- Its amount_minor is deliberately left where it was: a cancelled payment is a record of what
  -- WOULD have been charged, and rewriting it to zero would erase the only trace of the sum the
  -- reader was looking at when the code landed. Nothing reads a cancelled row's amount -
  -- apply_payment_event resolves by (order_id, provider) among pending rows - so the number is
  -- history, not an input.
  update public.payments pay set status = 'cancelled' where pay.order_id = p_order_id and pay.status = 'pending';
  update public.orders o set status = 'completed', payment_status = 'not_required' where o.id = p_order_id;

  insert into public.entitlements (profile_id, book_id, source_type, source_order_id, status)
  values (v_profile_id, v_book_id, 'free_order', p_order_id, 'active')
  on conflict (profile_id, book_id) where status = 'active' do nothing
  returning id into v_entitlement_id;

  if v_entitlement_id is null then
    -- The reader already holds an active entitlement for this book, from an admin grant or another
    -- order that landed between this order's creation and now. Resolved by subject, the way
    -- acquire_free_ebook and apply_payment_event both resolve it.
    select e.id into v_entitlement_id
    from public.entitlements e
    where e.profile_id = v_profile_id and e.book_id = v_book_id and e.status = 'active';
  end if;

  insert into public.library_items (profile_id, book_id, entitlement_id)
  values (v_profile_id, v_book_id, v_entitlement_id)
  on conflict (profile_id, book_id) do nothing;

  update public.coupon_redemptions r
  set status = 'redeemed', redeemed_at = now()
  where r.order_id = p_order_id;

  return query select v_order.subtotal_minor, v_discount, 0::bigint, 'completed'::public.order_status,
                      v_entitlement_id, null::text;
end;
$$;

-- remove_coupon_from_order. Only ever reachable on a pending order that still has a coupon: a
-- zero-total order completed the moment its code was applied, so there is no window in which a
-- completed order can have its discount taken away.
create function public.remove_coupon_from_order(p_order_id uuid)
returns table (subtotal_minor bigint, discount_minor bigint, total_minor bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_order record;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'remove_coupon_from_order: no profile for the current session' using errcode = 'P0002';
  end if;

  select o.id, o.status, o.subtotal_minor, o.coupon_id
  into v_order
  from public.orders o
  where o.id = p_order_id and o.profile_id = v_profile_id
  for update;

  if v_order.id is null or v_order.status <> 'pending' or v_order.coupon_id is null then
    raise exception 'remove_coupon_from_order: order % is not a couponed pending order of the caller', p_order_id
      using errcode = 'EB024';
  end if;

  if exists (select 1 from public.manual_transfer_claims c where c.order_id = p_order_id) then
    raise exception 'remove_coupon_from_order: order % already has a reported transfer', p_order_id
      using errcode = 'EB024';
  end if;

  update public.orders o
  set coupon_id = null, coupon_code = null, discount_minor = 0, total_minor = v_order.subtotal_minor
  where o.id = p_order_id;

  update public.payments pay
  set amount_minor = v_order.subtotal_minor
  where pay.order_id = p_order_id and pay.status = 'pending';

  -- Releasing the reservation is the point of this function: the use goes back to the code.
  delete from public.coupon_redemptions r where r.order_id = p_order_id;

  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, reason, metadata)
  values (v_profile_id, 'coupon.removed', 'orders', p_order_id, null, jsonb_build_object('coupon_id', v_order.coupon_id));

  return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor;
end;
$$;

revoke execute on function public.apply_coupon_to_order(uuid, text) from public, anon;
grant execute on function public.apply_coupon_to_order(uuid, text) to authenticated;
revoke execute on function public.remove_coupon_from_order(uuid) from public, anon;
grant execute on function public.remove_coupon_from_order(uuid) to authenticated;
