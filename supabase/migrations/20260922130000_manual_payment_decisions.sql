-- S7: the admin's decision on a reported bank transfer (spec 5.6). Confirming is where money
-- becomes access; declining either sends the reader back to transfer again, or ends the order.
--
-- New error codes, continuing the EB0xx series (EB020 is taken by
-- 20260922120000_manual_transfer_claims.sql):
--   EB021 - confirm_manual_payment: the received amount differs from the order total and no
--           override was given.
--   EB022 - confirm/reject_manual_payment: the order is not a pending manual order.
--   EB023 - reject_manual_payment: unknown outcome.

-- One confirmation per order: the primary key is what makes a second confirmation a no-op rather
-- than a second piece of evidence. What is recorded is what actually arrived, which is not
-- necessarily the order total - see confirm_manual_payment below.
create table public.manual_payment_confirmations (
  order_id uuid primary key references public.orders(id) on delete cascade,
  admin_profile_id uuid not null references public.profiles(id),
  received_amount_minor bigint not null check (received_amount_minor >= 0),
  bank_reference text not null check (char_length(btrim(bank_reference)) > 0),
  note text check (note is null or char_length(note) <= 500),
  mismatch_accepted boolean not null default false,
  confirmed_at timestamptz not null default now()
);

-- Declines are a history, not a state: "the money never arrived" can happen more than once on the
-- same order, and the reader is shown the most recent reason. sequence orders them without
-- depending on declined_at ties.
create table public.manual_payment_declines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  sequence integer not null,
  admin_profile_id uuid not null references public.profiles(id),
  reason text not null check (char_length(btrim(reason)) > 0),
  outcome text not null check (outcome in ('not_received', 'cancel')),
  declined_at timestamptz not null default now(),
  unique (order_id, sequence)
);

create index manual_payment_declines_order_idx on public.manual_payment_declines (order_id, sequence desc);

alter table public.manual_payment_confirmations enable row level security;
alter table public.manual_payment_declines enable row level security;

-- Select only, matching manual_transfer_claims. confirm_manual_payment and reject_manual_payment
-- are the only writers and both reach these tables as the owner through security definer.
revoke all on public.manual_payment_confirmations from public, anon, authenticated, service_role;
revoke all on public.manual_payment_declines from public, anon, authenticated, service_role;
grant select on public.manual_payment_confirmations to authenticated, service_role;
grant select on public.manual_payment_declines to authenticated, service_role;

-- A confirmation carries the bank reference and the admin's note, which is internal review
-- evidence; the reader sees the resulting entitlement, not this row.
create policy manual_payment_confirmations_admin_select on public.manual_payment_confirmations
  for select to authenticated using (public.is_admin());

-- A declined reader is shown the most recent reason on their own order page, so the owner reads
-- their own rows; everybody else needs the admin role.
create policy manual_payment_declines_owner_select on public.manual_payment_declines
  for select to authenticated
  using (order_id in (
    select o.id from public.orders o
    join public.profiles p on p.id = o.profile_id
    where p.auth_user_id = auth.uid()
  ));

create policy manual_payment_declines_admin_select on public.manual_payment_declines
  for select to authenticated using (public.is_admin());

-- ============================================================================================
-- confirm_manual_payment. This function grants nothing itself: it synthesizes a payment event and
-- hands it to apply_payment_event, the one function in this system that grants a paid entitlement.
-- The event id is derived from the order, so a second confirmation replays into that function's
-- existing no-op branch instead of granting twice.
--
-- The confirmation records what actually arrived, while the event carries the order total:
-- apply_payment_event raises EB004 on any other amount, and rightly so - the order snapshot is the
-- financial record. A difference is therefore a human decision, made once, and audited.
create function public.confirm_manual_payment(
  p_order_id uuid,
  p_received_amount_minor bigint,
  p_bank_reference text,
  p_note text,
  p_accept_mismatch boolean default false
)
returns table (entitlement_id uuid, order_status public.order_status, payment_status public.payment_status)
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
  v_entitlement_id uuid;
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
  select o.total_minor, o.currency, o.status
  into v_total_minor, v_currency, v_order_status
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
    -- second click is not a second decision. The entitlement is resolved by subject, the way
    -- apply_payment_event resolves it, because the buyer's active entitlement for this book may
    -- have come from an earlier order.
    select o.status, o.payment_status, e.id
    into v_order_status, v_payment_status, v_entitlement_id
    from public.orders o
    join public.order_items oi on oi.order_id = o.id
    left join public.entitlements e
      on e.profile_id = o.profile_id and e.book_id = oi.book_id and e.status = 'active'
    where o.id = p_order_id
    limit 1;

    return query select v_entitlement_id, v_order_status, v_payment_status;
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

-- ============================================================================================
-- reject_manual_payment. 'not_received' says the money never arrived: the order stays pending with
-- a failed payment so the reader can transfer again, and the claim is released so they can report
-- the new transfer. 'cancel' ends the order outright. Neither ever touches an entitlement - an
-- order that was already completed is not pending, so it cannot be declined at all.
create function public.reject_manual_payment(p_order_id uuid, p_reason text, p_outcome text)
returns table (order_status public.order_status, payment_status public.payment_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_id uuid;
  v_reason text;
  v_total_minor bigint;
  v_currency text;
  v_order_status public.order_status;
  v_sequence integer;
  v_event_id text;
  v_result record;
begin
  if not public.is_admin() then
    raise exception 'reject_manual_payment: caller is not an admin' using errcode = '42501';
  end if;

  select pr.id into v_admin_id from public.profiles pr where pr.auth_user_id = auth.uid();

  if p_outcome is null or p_outcome not in ('not_received', 'cancel') then
    raise exception 'reject_manual_payment: unknown outcome %', p_outcome using errcode = 'EB023';
  end if;

  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'reject_manual_payment: a reason is required' using errcode = '22023';
  end if;

  select o.total_minor, o.currency, o.status
  into v_total_minor, v_currency, v_order_status
  from public.orders o
  join public.payments pay on pay.order_id = o.id and pay.provider = 'manual'
  where o.id = p_order_id
  for update of o;

  if v_total_minor is null or v_order_status <> 'pending' then
    raise exception 'reject_manual_payment: order % is not a pending manual order', p_order_id
      using errcode = 'EB022';
  end if;

  select coalesce(max(d.sequence), 0) + 1 into v_sequence
  from public.manual_payment_declines d where d.order_id = p_order_id;

  insert into public.manual_payment_declines (order_id, sequence, admin_profile_id, reason, outcome)
  values (p_order_id, v_sequence, v_admin_id, v_reason, p_outcome);

  -- A cancellation is terminal, so its event id is fixed and replay-safe. "Not received" can
  -- happen repeatedly on the same order, so each one is its own event.
  v_event_id := case p_outcome
    when 'cancel' then 'manual:' || p_order_id::text || ':cancelled'
    else 'manual:' || p_order_id::text || ':not_received:' || v_sequence::text
  end;

  select a.order_status, a.payment_status into v_result
  from public.apply_payment_event(
    'manual',
    v_event_id,
    p_order_id,
    'manual-decline',
    case p_outcome when 'cancel' then 'cancelled' else 'failed' end,
    v_total_minor,
    v_currency,
    now()
  ) a;

  -- The reader must be able to report a fresh transfer after a decline.
  delete from public.manual_transfer_claims where order_id = p_order_id;

  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, reason, metadata)
  values (
    v_admin_id,
    'manual_payment.declined',
    'orders',
    p_order_id,
    v_reason,
    jsonb_build_object('outcome', p_outcome, 'sequence', v_sequence)
  );

  return query select v_result.order_status, v_result.payment_status;
end;
$$;

revoke execute on function public.confirm_manual_payment(uuid, bigint, text, text, boolean) from public, anon;
grant execute on function public.confirm_manual_payment(uuid, bigint, text, text, boolean) to authenticated;
revoke execute on function public.reject_manual_payment(uuid, text, text) from public, anon;
grant execute on function public.reject_manual_payment(uuid, text, text) to authenticated;
