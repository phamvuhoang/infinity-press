-- S9: an order may hold several books (spec 5).
--
-- No new error codes, no new tables, and no change to who may call what. What changes is one
-- assumption that has been baked into the payment core since S3: that an order holds exactly one
-- book, resolved with `select oi.book_id from order_items oi where oi.order_id = p_order_id
-- limit 1`. Bundles and gifts both make orders with several items, so that `limit 1` would grant
-- the buyer one arbitrary book of the several they paid for. This lands on its own, before either
-- feature is built, so that nothing is ever built on top of the single-item assumption.
--
-- Three functions change, and the return type of two of them changes with them:
--
--   apply_payment_event     entitlement_id uuid  ->  entitlement_ids uuid[]
--   confirm_manual_payment  entitlement_id uuid  ->  entitlement_ids uuid[]  (delegates, as before)
--   revoke_order_entitlement       returns uuid  ->  returns uuid[]
--
-- A `returns table` column cannot be renamed or retyped by `create or replace`, so both payment
-- functions are dropped and recreated. confirm_manual_payment is dropped first: it is the caller,
-- and dropping the callee first would leave it referring to a function that does not exist for the
-- rest of this migration. Everything else in these bodies - the replay branch, the terminal-order
-- guard, the provider guard (EB015/EB016), the amount check (EB004), the manual-confirmation rules
-- (EB021/EB022), the S8 coupon flips, and every audit row - is carried over unchanged from
-- 20260923130000_s8_coupon_payment_event.sql and 20260922130000_manual_payment_decisions.sql.
--
-- reject_manual_payment is untouched: it selects apply_payment_event's order_status and
-- payment_status by name, so the new third column reaches it as a column it does not read.

-- ============================================================================================
-- order_active_entitlement_ids: which entitlements does this buyer currently hold for the books of
-- this order?
--
-- Every path below that reports access - apply_payment_event's success, replay and out-of-order
-- branches, and confirm_manual_payment's idempotent branch - answers exactly that question, and
-- answering it differently on any one of them is a defect rather than a variation. It is one
-- function so that it stays one answer, and so that the next task to recreate apply_payment_event
-- does not inherit a copy of it.
--
-- The subject an event grants access to is (profile_id, book_id) - the pair
-- entitlements_active_subject_key uniquely constrains - never source_order_id. A buyer who already
-- holds an active entitlement for one of these books from a DIFFERENT order, an admin_grant or a
-- free_order still resolves here, the way apply_payment_event's success branch resolves it through
-- `on conflict ... do nothing`. A lookup keyed by source_order_id would find nothing for that book
-- and silently drop it from the array.
--
-- `distinct` on the books, because the grant is per subject and not per line: an order carrying two
-- lines for one book is one piece of access, and must be reported once. Ordered by book_id, so the
-- array a caller gets back is stable rather than an insertion order.
--
-- security definer with no grant to anon or authenticated: this is internal, called only by the
-- definer-owned functions below, and it reads entitlements for an arbitrary profile.
create function public.order_active_entitlement_ids(p_order_id uuid, p_profile_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(b.id order by b.book_id), array[]::uuid[])
  from (
    select distinct on (oi.book_id) oi.book_id, e.id
    from public.order_items oi
    join public.entitlements e
      on e.profile_id = p_profile_id
     and e.book_id = oi.book_id
     and e.status = 'active'
    where oi.order_id = p_order_id
  ) b;
$$;

revoke execute on function public.order_active_entitlement_ids(uuid, uuid) from public, anon, authenticated;

-- ============================================================================================
-- apply_payment_event
-- ============================================================================================
drop function public.confirm_manual_payment(uuid, bigint, text, text, boolean);
drop function public.apply_payment_event(text, text, uuid, text, text, bigint, text, timestamptz);

create function public.apply_payment_event(
  p_provider text,
  p_provider_event_id text,
  p_order_id uuid,
  p_external_payment_id text,
  p_status text,
  p_amount_minor bigint,
  p_currency text,
  p_occurred_at timestamptz
)
returns table (entitlement_ids uuid[], order_status public.order_status, payment_status public.payment_status)
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
  -- Empty, not null, and empty is what the 'failed' and 'cancelled' branches return: those paths
  -- granted nothing, exactly as they returned a null entitlement_id before. Only the three paths
  -- that report access - success, replay, and a late event - resolve it.
  v_entitlement_ids uuid[] := array[]::uuid[];
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
    v_entitlement_ids := public.order_active_entitlement_ids(p_order_id, v_profile_id);

    return query select v_entitlement_ids, v_order_status, v_payment_status;
    return;
  end if;

  if v_order_status <> 'pending' then
    -- Out-of-order arrival: the order already left 'pending' (completed or cancelled) via an
    -- earlier-processed event. This new event is recorded (payment_events above) but has no
    -- further effect - it must not resurrect a cancelled order or re-derive a different outcome
    -- for an already-completed one.
    v_entitlement_ids := public.order_active_entitlement_ids(p_order_id, v_profile_id);

    return query select v_entitlement_ids, v_order_status, v_payment_status;
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

    -- One entitlement and one library item per book of the order. `distinct` because the grant is
    -- per subject, not per line: two lines naming the same book are one piece of access, and the
    -- partial unique index would reject the second insert's conflict target twice over anyway.
    -- Each iteration keeps the single-book version's `on conflict ... do nothing` and its
    -- resolve-by-subject fallback, so a buyer who already owns one member book is unaffected by
    -- it and still gets the rest.
    for v_book_id in
      select distinct oi.book_id from public.order_items oi where oi.order_id = p_order_id
    loop
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
    end loop;

    -- S8 (spec 5.3): the order's coupon reservation, if it has one, is redeemed alongside it. Once
    -- per order, outside the loop - a coupon is applied to the order, not to a line - and scoped to
    -- status = 'reserved' so this stays a no-op both for an order with no coupon and for a
    -- replayed event that reaches this branch again.
    update public.coupon_redemptions r
    set status = 'redeemed', redeemed_at = now()
    where r.order_id = p_order_id and r.status = 'reserved';

    v_entitlement_ids := public.order_active_entitlement_ids(p_order_id, v_profile_id);

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

    -- S8 (spec 5.3): a cancelled order releases its coupon reservation outright, rather than
    -- marking it something else: the code must be free for the same reader, or another, to use
    -- again. A no-op on an order with no coupon.
    delete from public.coupon_redemptions r where r.order_id = p_order_id;
  end if;

  return query select v_entitlement_ids, v_order_status, v_payment_status;
end;
$$;

revoke execute on function public.apply_payment_event(text, text, uuid, text, text, bigint, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_payment_event(text, text, uuid, text, text, bigint, text, timestamptz)
  to service_role;

-- ============================================================================================
-- confirm_manual_payment. Unchanged but for the return type and the idempotent branch's lookup,
-- which now resolves the same array by the same query the function it delegates to uses.
-- ============================================================================================
create function public.confirm_manual_payment(
  p_order_id uuid,
  p_received_amount_minor bigint,
  p_bank_reference text,
  p_note text,
  p_accept_mismatch boolean default false
)
returns table (entitlement_ids uuid[], order_status public.order_status, payment_status public.payment_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_id uuid;
  v_total_minor bigint;
  v_currency text;
  v_order_status public.order_status;
  v_payment_status public.payment_status;
  v_profile_id uuid;
  v_entitlement_ids uuid[];
  v_reference text;
  v_note text;
  v_mismatch boolean;
begin
  if not public.is_admin() then
    raise exception 'confirm_manual_payment: caller is not an admin' using errcode = '42501';
  end if;

  -- is_admin() joins profiles, so a true result already proves the caller has one.
  select pr.id into v_admin_id from public.profiles pr where pr.auth_user_id = auth.uid();

  v_reference := btrim(coalesce(p_bank_reference, ''));
  if v_reference = '' then
    raise exception 'confirm_manual_payment: a bank reference is required' using errcode = '22023';
  end if;
  v_note := nullif(btrim(coalesce(p_note, '')), '');

  -- Rejected explicitly rather than left to the not-null constraint below: a null amount would
  -- make the mismatch comparison null, and "not null" is a three-valued-logic accident, not a
  -- decision an admin gets to make about money.
  if p_received_amount_minor is null then
    raise exception 'confirm_manual_payment: a received amount is required' using errcode = '22023';
  end if;

  -- Locks the order for the whole decision, so two admins clicking at once are serialized rather
  -- than both evaluating a pending order. The payments join is what makes this a *manual* order:
  -- a simulator order must not be confirmable by hand.
  select o.total_minor, o.currency, o.status, o.profile_id
  into v_total_minor, v_currency, v_order_status, v_profile_id
  from public.orders o
  join public.payments pay on pay.order_id = o.id and pay.provider = 'manual'
  where o.id = p_order_id
  for update of o;

  if v_total_minor is null then
    raise exception 'confirm_manual_payment: order % is not a manual order', p_order_id
      using errcode = 'EB022';
  end if;

  if v_order_status = 'completed' then
    -- Self-healing, and the reason this delete is not left to the success path below: a claim that
    -- somehow survives into a completed order would sit in the review queue forever, and the
    -- admin's natural remedy - pressing confirm again - lands here.
    --
    -- It sits inside this branch rather than above it so that it runs only where releasing the
    -- claim is the intended outcome. Hoisted above the EB021 and EB022 raises it would still be
    -- harmless, because an exception leaving a plpgsql function undoes that function's writes
    -- unconditionally - but then the refusal paths would be correct only by virtue of that
    -- rollback. Here they are correct by construction, which is the property worth having on the
    -- path where money becomes access.
    delete from public.manual_transfer_claims where order_id = p_order_id;

    -- Already confirmed: idempotent, not an error, and deliberately short of the audit row - a
    -- second click is not a second decision. The entitlements come from the same helper
    -- apply_payment_event's own branches use, because the buyer's active entitlement for a book
    -- may have come from an earlier order or a grant.
    v_entitlement_ids := public.order_active_entitlement_ids(p_order_id, v_profile_id);

    select o.status, o.payment_status into v_order_status, v_payment_status
    from public.orders o where o.id = p_order_id;

    return query select v_entitlement_ids, v_order_status, v_payment_status;
    return;
  end if;

  if v_order_status <> 'pending' then
    raise exception 'confirm_manual_payment: order % is %, not pending', p_order_id, v_order_status
      using errcode = 'EB022';
  end if;

  v_mismatch := p_received_amount_minor <> v_total_minor;
  -- Raised before the first write in this function, so a refused mismatch leaves nothing behind
  -- rather than relying on the caller's transaction to undo a partial one.
  if v_mismatch and not coalesce(p_accept_mismatch, false) then
    raise exception 'confirm_manual_payment: received % but the order total is %',
      p_received_amount_minor, v_total_minor using errcode = 'EB021';
  end if;

  insert into public.manual_payment_confirmations
    (order_id, admin_profile_id, received_amount_minor, bank_reference, note, mismatch_accepted)
  values
    (p_order_id, v_admin_id, p_received_amount_minor, v_reference, v_note, v_mismatch)
  on conflict (order_id) do nothing;

  return query
  select *
  from public.apply_payment_event(
    'manual',
    'manual:' || p_order_id::text || ':confirmed',
    p_order_id,
    v_reference,
    'succeeded',
    v_total_minor,
    v_currency,
    now()
  );

  -- The order has left the review queue.
  delete from public.manual_transfer_claims where order_id = p_order_id;

  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, reason, metadata)
  values (
    v_admin_id,
    'manual_payment.confirmed',
    'orders',
    p_order_id,
    v_note,
    jsonb_build_object(
      'received_amount_minor', p_received_amount_minor,
      'order_total_minor', v_total_minor,
      'currency', v_currency,
      'bank_reference', v_reference,
      'mismatch_accepted', v_mismatch
    )
  );
end;
$$;

revoke execute on function public.confirm_manual_payment(uuid, bigint, text, text, boolean) from public, anon;
grant execute on function public.confirm_manual_payment(uuid, bigint, text, text, boolean) to authenticated;

-- ============================================================================================
-- revoke_order_entitlement. One order, one decision, one audit row - however many books it held.
--
-- Two things change beyond the return type. The revocation is now set-based over every
-- order-backed entitlement of the order rather than the one row `limit 1` happened to pick, and
-- the audit row is written against the ORDER (entity_type 'orders', entity_id the order id) with
-- the revoked ids in its metadata, because one row per entitlement would make a three-book
-- revocation look like three separate admin decisions when it was one.
--
-- 'manual_payment' joins the order-backed source types here. It was missing since S7 -
-- entitlements_source_consistency (20260922100010) has required an order for a manual_payment row
-- since the day that source existed, so a confirmed bank transfer was simply unrevokable, raising
-- P0002 as though the order had granted nothing. The set this function acts on is "sources that
-- carry a source_order_id", and manual_payment is one.
--
-- The already-revoked rows stay in the returned array and an all-revoked order writes no second
-- audit row, so repeating a revocation remains the no-op it has always been.
-- ============================================================================================
drop function public.revoke_order_entitlement(uuid, text);

create function public.revoke_order_entitlement(p_order_id uuid, p_reason text)
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
  v_profile_id uuid;
  v_entitlement_ids uuid[];
  v_revoked_ids uuid[];
begin
  if not public.is_admin() then
    raise exception 'revoke_order_entitlement: caller is not an admin' using errcode = '42501';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'revoke_order_entitlement: a reason is required' using errcode = '22023';
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  if v_actor_profile_id is null then
    raise exception 'revoke_order_entitlement: admin caller has no profile' using errcode = 'P0002';
  end if;

  -- Locked before they are read, so two admins revoking the same order are serialized rather than
  -- both deciding against the same active rows.
  perform 1
  from public.entitlements e
  where e.source_order_id = p_order_id
    and e.source_type in ('free_order', 'simulated_payment', 'manual_payment')
  for update;

  -- Every status, not just 'active': a repeat must return the same array it returned the first
  -- time rather than reporting that the order granted nothing.
  select coalesce(array_agg(e.id order by e.book_id), array[]::uuid[])
  into v_entitlement_ids
  from public.entitlements e
  where e.source_order_id = p_order_id
    and e.source_type in ('free_order', 'simulated_payment', 'manual_payment');

  if cardinality(v_entitlement_ids) = 0 then
    raise exception 'revoke_order_entitlement: order % granted no entitlement', p_order_id using errcode = 'P0002';
  end if;

  with revoked as (
    update public.entitlements e
    set status = 'revoked', revoked_at = now()
    where e.id = any(v_entitlement_ids) and e.status = 'active'
    returning e.id, e.book_id
  )
  select coalesce(array_agg(r.id order by r.book_id), array[]::uuid[])
  into v_revoked_ids
  from revoked r;

  if cardinality(v_revoked_ids) > 0 then
    delete from public.library_items where entitlement_id = any(v_revoked_ids);

    select o.profile_id into v_profile_id from public.orders o where o.id = p_order_id;

    insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, reason, metadata)
    values (
      v_actor_profile_id,
      'revoke_order_entitlement',
      'orders',
      p_order_id,
      p_reason,
      jsonb_build_object(
        'order_id', p_order_id,
        'profile_id', v_profile_id,
        'entitlement_ids', to_jsonb(v_revoked_ids)
      )
    );
  end if;

  return v_entitlement_ids;
end;
$$;

revoke execute on function public.revoke_order_entitlement(uuid, text) from public, anon;
grant execute on function public.revoke_order_entitlement(uuid, text) to authenticated;
