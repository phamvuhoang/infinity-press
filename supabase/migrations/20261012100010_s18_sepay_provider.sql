-- S18: 'sepay' joins 'simulator' and 'manual' as a payment provider.
--
-- Four check constraints name the providers or the entitlement sources, and three functions map a
-- provider to an entitlement source or list the order-backed sources. All seven change here,
-- together, because S7 changed five of them and S9 had to come back for the sixth
-- (revoke_order_entitlement).
--
-- entitlements_source_consistency is the one the plan's first draft missed: its CASE fails closed,
-- so a sepay_payment row is rejected outright until the CASE learns about it. A SePay payment is
-- order-backed exactly like a simulated or manual one.
--
-- No signature, grant, lock order, or error code changes. Each function below is its latest
-- definition, copied whole, with one line added; `create or replace` keeps the existing grants.

alter table public.payments drop constraint payments_provider_check;
alter table public.payments
  add constraint payments_provider_check
  check (provider in ('disabled', 'simulator', 'manual', 'sepay'));

alter table public.orders drop constraint orders_payment_provider_check;
alter table public.orders
  add constraint orders_payment_provider_check
  check (payment_provider in ('disabled', 'simulator', 'manual', 'sepay'));

alter table public.commerce_settings drop constraint commerce_settings_payment_provider_check;
alter table public.commerce_settings
  add constraint commerce_settings_payment_provider_check
  check (payment_provider in ('simulator', 'manual', 'sepay'));

alter table public.entitlements drop constraint entitlements_source_consistency;
alter table public.entitlements
  add constraint entitlements_source_consistency check (
    case source_type
      when 'free_order' then source_order_id is not null
      when 'simulated_payment' then source_order_id is not null
      when 'manual_payment' then source_order_id is not null
      when 'sepay_payment' then source_order_id is not null
      when 'admin_grant' then
        actor_profile_id is not null
        and reason is not null
        and length(trim(reason)) > 0
        and source_order_id is null
      else false
    end
  );

-- claim_gift: a claimed gift's entitlement records the provider its order was paid through.
create or replace function public.claim_gift(p_token text)
returns table (book_id uuid, title text, entitlement_id uuid, already_owned boolean)
language plpgsql
security definer
set search_path = ''
as $$
-- This function's OUT parameters are named after the columns it returns - book_id,
-- entitlement_id - and `on conflict (profile_id, book_id)` below has no alias to qualify with, so
-- the default "raise on ambiguity" rule would reject that statement outright. Every value this
-- body reads is a v_-prefixed local or an explicitly qualified column, and the four OUT names are
-- only ever assignment targets (which plpgsql always resolves as variables), so preferring the
-- column here is unambiguous rather than merely quieter.
#variable_conflict use_column
declare
  v_profile_id uuid;
  v_hash text;
  v_gift record;
  v_order record;
  v_source public.entitlement_source;
  v_item record;
  v_entitlement_id uuid;
  v_already boolean;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'claim_gift: no profile for the current session' using errcode = 'P0002';
  end if;

  -- The same expression lib/commerce/gift-token.ts hashGiftToken() produces: SHA-256 of the UTF-8
  -- bytes, lower-case hex. convert_to() rather than a bare cast, so the digest does not depend on
  -- the database's client encoding.
  v_hash := encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');

  select g.* into v_gift from public.gifts g where g.claim_token_hash = v_hash for update;

  -- An unknown token and a spent one are the same refusal. Anything else would let a guesser tell
  -- a wrong token from a right-but-used one, which is most of the way to finding a live one.
  if v_gift.id is null then
    raise exception 'claim_gift: no claimable gift for this token' using errcode = 'EB029';
  end if;

  if v_gift.status = 'claimed' and v_gift.claimed_by_profile_id = v_profile_id then
    -- The same reader again - a refreshed page, a re-followed link. The same answer, and not one
    -- row written. already_owned is derived rather than remembered: an entitlement this claim
    -- created carries source_order_id = the gift's order, and one the reader already held cannot,
    -- because the buyer was granted nothing by that order. So the derivation below reproduces
    -- exactly what the first call reported.
    return query
    select i.book_id, i.title_snapshot, e.id, e.source_order_id is distinct from v_gift.order_id
    from (
      select distinct on (oi.book_id) oi.book_id, oi.title_snapshot
      from public.order_items oi
      where oi.order_id = v_gift.order_id
      order by oi.book_id, oi.position
    ) i
    join public.entitlements e
      on e.profile_id = v_profile_id and e.book_id = i.book_id and e.status = 'active'
    order by i.book_id;
    return;
  end if;

  if v_gift.status <> 'sent' then
    raise exception 'claim_gift: no claimable gift for this token' using errcode = 'EB029';
  end if;

  select o.total_minor, o.payment_provider into v_order
  from public.orders o where o.id = v_gift.order_id;

  -- What the recipient's access is recorded as having come from. A gift order that cost nothing -
  -- a 100% coupon - is a free_order; otherwise it is the source of the provider the order was
  -- actually booked under, the same mapping apply_payment_event makes. The order paid for this
  -- access, so source_order_id always names it, whichever source applies.
  --
  -- Three sites in this file map an order to an entitlement_source, and they are consistent only
  -- by construction - change one and check the other two:
  --   * apply_payment_event's provider mapping (simulator/manual, no zero branch: a zero-total
  --     order never reaches it, because it never produces a payment event);
  --   * apply_coupon_to_order's zero-total branch, which completes the order in-transaction and
  --     grants a non-gift buyer 'free_order' - the only way a gift order reaches total_minor = 0,
  --     and therefore what the 'free_order' branch below has to agree with;
  --   * this mapping, which is the pair of them as seen from the recipient's side.
  v_source := case
    when v_order.total_minor = 0 then 'free_order'::public.entitlement_source
    when v_order.payment_provider = 'simulator' then 'simulated_payment'::public.entitlement_source
    when v_order.payment_provider = 'manual' then 'manual_payment'::public.entitlement_source
    when v_order.payment_provider = 'sepay' then 'sepay_payment'::public.entitlement_source
    else null
  end;
  if v_source is null then
    raise exception 'claim_gift: order % is booked under provider %, which grants nothing',
      v_gift.order_id, v_order.payment_provider using errcode = 'EB015';
  end if;

  -- `distinct on (book_id)` because access is per subject and not per line: a bundle order holding
  -- two lines for one book is one piece of access. Ordered by book_id so the claimed and the
  -- replayed result sets are the same set in the same order.
  for v_item in
    select distinct on (oi.book_id) oi.book_id, oi.title_snapshot
    from public.order_items oi
    where oi.order_id = v_gift.order_id
    order by oi.book_id, oi.position
  loop
    -- Captured BEFORE the insert: after it, "does this reader hold this book" is true either way.
    select e.id into v_entitlement_id
    from public.entitlements e
    where e.profile_id = v_profile_id and e.book_id = v_item.book_id and e.status = 'active';
    v_already := v_entitlement_id is not null;

    if not v_already then
      insert into public.entitlements (profile_id, book_id, source_type, source_order_id, status)
      values (v_profile_id, v_item.book_id, v_source, v_gift.order_id, 'active')
      on conflict (profile_id, book_id) where status = 'active' do nothing
      returning id into v_entitlement_id;

      -- The partial unique index is the arbiter, not the select above: another session could have
      -- granted this book between the two. Resolve by subject, exactly as apply_payment_event does.
      if v_entitlement_id is null then
        select e.id into v_entitlement_id
        from public.entitlements e
        where e.profile_id = v_profile_id and e.book_id = v_item.book_id and e.status = 'active';
      end if;
    end if;

    insert into public.library_items (profile_id, book_id, entitlement_id)
    values (v_profile_id, v_item.book_id, v_entitlement_id)
    on conflict (profile_id, book_id) do nothing;

    book_id := v_item.book_id;
    title := v_item.title_snapshot;
    entitlement_id := v_entitlement_id;
    already_owned := v_already;
    return next;
  end loop;

  update public.gifts g
  set status = 'claimed', claimed_by_profile_id = v_profile_id, claimed_at = now()
  where g.id = v_gift.id;

  -- The claim path existed so the message could be sent and re-sent while the gift was live. It is
  -- not live any more, so the one protected copy of it is dropped rather than left lying in a
  -- table for the rest of the row's life.
  update public.notification_outbox o set payload = null where o.gift_id = v_gift.id;
end;
$$;

-- apply_payment_event: completing an order records the provider as the entitlement source.
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
  v_entitlement_ids uuid[] := array[]::uuid[];
  v_payload_hash text;
  -- Whether this order was bought for somebody else. Resolved under the order lock below, so it
  -- cannot change between the branches that consult it.
  v_is_gift boolean;
begin
  v_source := case p_provider
    when 'simulator' then 'simulated_payment'::public.entitlement_source
    when 'manual' then 'manual_payment'::public.entitlement_source
    when 'sepay' then 'sepay_payment'::public.entitlement_source
    else null
  end;
  if v_source is null then
    raise exception 'apply_payment_event: unknown provider %', p_provider using errcode = 'EB015';
  end if;

  if p_status not in ('succeeded', 'failed', 'cancelled') then
    raise exception 'apply_payment_event: invalid status %', p_status using errcode = '22023';
  end if;
  v_status := p_status::public.payment_status;

  select o.status, o.payment_status, o.total_minor, o.currency, o.profile_id, o.payment_provider
  into v_order_status, v_payment_status, v_order_total_minor, v_order_currency, v_profile_id, v_order_provider
  from public.orders o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'apply_payment_event: order % does not exist', p_order_id using errcode = 'P0002';
  end if;

  if p_provider <> v_order_provider then
    raise exception 'apply_payment_event: order % is booked under provider %, not %',
      p_order_id, v_order_provider, p_provider using errcode = 'EB016';
  end if;

  v_is_gift := exists (select 1 from public.gifts g where g.order_id = p_order_id);

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
    -- A gift order granted the buyer nothing the first time and reports nothing now.
    if not v_is_gift then
      v_entitlement_ids := public.order_active_entitlement_ids(p_order_id, v_profile_id);
    end if;

    return query select v_entitlement_ids, v_order_status, v_payment_status;
    return;
  end if;

  if v_order_status <> 'pending' then
    -- Out-of-order arrival: the order already left 'pending' (completed or cancelled) via an
    -- earlier-processed event. This new event is recorded (payment_events above) but has no
    -- further effect - it must not resurrect a cancelled order or re-derive a different outcome
    -- for an already-completed one.
    if not v_is_gift then
      v_entitlement_ids := public.order_active_entitlement_ids(p_order_id, v_profile_id);
    end if;

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

    -- The gift branch (spec 7.2). The order is paid for, so the gift becomes claimable - and the
    -- buyer is granted nothing, because they did not buy it for themselves.
    v_is_gift := public.activate_order_gift(p_order_id);

    if not v_is_gift then
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

      v_entitlement_ids := public.order_active_entitlement_ids(p_order_id, v_profile_id);
    end if;

    -- S8 (spec 5.3): the order's coupon reservation, if it has one, is redeemed alongside it. Once
    -- per order, outside the loop - a coupon is applied to the order, not to a line - and scoped to
    -- status = 'reserved' so this stays a no-op both for an order with no coupon and for a
    -- replayed event that reaches this branch again. A gift order redeems its coupon too: the sale
    -- happened, whoever ends up reading the book.
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

    -- S8 (spec 5.3): a cancelled order releases its coupon reservation outright, rather than
    -- marking it something else: the code must be free for the same reader, or another, to use
    -- again. A no-op on an order with no coupon.
    delete from public.coupon_redemptions r where r.order_id = p_order_id;
  end if;

  return query select v_entitlement_ids, v_order_status, v_payment_status;
end;
$$;

-- revoke_order_entitlement: sepay_payment is order-backed, like manual_payment.
create or replace function public.revoke_order_entitlement(p_order_id uuid, p_reason text)
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
    and e.source_type in ('free_order', 'simulated_payment', 'manual_payment', 'sepay_payment')
  for update;

  -- Every status, not just 'active': a repeat must return the same array it returned the first
  -- time rather than reporting that the order granted nothing.
  select coalesce(array_agg(e.id order by e.book_id), array[]::uuid[])
  into v_entitlement_ids
  from public.entitlements e
  where e.source_order_id = p_order_id
    and e.source_type in ('free_order', 'simulated_payment', 'manual_payment', 'sepay_payment');

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
