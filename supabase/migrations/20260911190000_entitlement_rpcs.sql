-- Task 7: the three access-acquisition RPCs - acquire_free_ebook, grant_complimentary_entitlement,
-- and apply_payment_event - implementing spec 6.2/6.3/6.4 on top of the entitlements/orders/
-- payments schema Task 6 shipped.
--
-- Renumbering note: named 20260911190000, not the brief's 20260911150000 - that timestamp sorts
-- before 20260911180000_publication_transition_rpcs.sql (Task 6), which already landed. Same
-- hosted-project hazard Ruling P/AV/the publication-transition migration's own header all closed
-- already: a migration timestamped earlier than one already applied is never picked up by a
-- hosted project applying migrations incrementally as they land.
--
-- Custom SQLSTATEs introduced here, continuing the EB0xx series started by Task 6
-- (EB001-EB003 are 20260911180000's stale-version/transition-rejected/cross-book codes):
--   EB004 - simulated payment event amount/currency does not match the order it targets.
--   EB005 - acquire_free_ebook: caller's profile has no verified email yet.
--   EB006 - acquire_free_ebook: the requested book has no active, currently-in-window,
--           zero-price offer.
--   EB007 - grant_complimentary_entitlement: a brand-new grant's target profile has no verified
--           customer identity (spec 6.3 point 1: "an admin selects a verified customer
--           identity"). Ruling BQ: this governs selecting a person for the first time, not
--           reactivation of an existing entitlement for that profile - see the function body.
-- 22023 (invalid_parameter_value) is reused, matching reject_publication's precedent, for a
-- missing/blank complimentary-grant reason.

-- ============================================================================================
-- acquire_free_ebook: Ruling AO's customer-authorization model. Invoked by an ordinary signed-in
-- reader through the user-session client; the profile is derived from auth.uid() - there is no
-- p_profile_id parameter for a caller to substitute another reader's id into - and this function
-- is never gated on is_admin(). EXECUTE goes to authenticated (every signed-in reader may call
-- it), not just admins.
--
-- Idempotency: entitlements_active_subject_key (a partial unique index on
-- (profile_id, book_id) where status = 'active') is the mechanism, used via
-- `insert ... on conflict ... do nothing` rather than a hand-rolled check-then-insert, which
-- would race two concurrent acquisitions for the same reader/book. A reader who already holds an
-- active entitlement for this book (of ANY source - free_order, admin_grant, or
-- simulated_payment) gets that entitlement id back immediately, before any order is created:
-- spec 6.2 point 5 says retrying returns the existing result, not "the existing free_order
-- result specifically".
create function public.acquire_free_ebook(p_book_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_is_verified boolean;
  v_offer_id uuid;
  v_sku_id uuid;
  v_market_code text;
  v_currency text;
  v_order_id uuid;
  v_original_language text;
  v_title_snapshot text;
  v_entitlement_id uuid;
begin
  select p.id into v_profile_id
  from public.profiles p
  where p.auth_user_id = auth.uid();

  if v_profile_id is null then
    raise exception 'acquire_free_ebook: no profile for the current session' using errcode = 'P0002';
  end if;

  -- Any verified identity counts, not just the most recently created one - a profile could in
  -- principle carry more than one customer_identities row, and picking "the latest" would wrongly
  -- reject a caller whose earlier identity is the verified one.
  select exists (
    select 1 from public.customer_identities ci
    where ci.profile_id = v_profile_id and ci.verified_at is not null
  ) into v_is_verified;

  if not v_is_verified then
    raise exception 'acquire_free_ebook: profile % has no verified email', v_profile_id using errcode = 'EB005';
  end if;

  -- Idempotency fast path, ahead of any lock or write: an active entitlement for this
  -- (profile, book) already exists, so acquiring again just hands back what the reader already
  -- has rather than touching orders/offers at all.
  select id into v_entitlement_id
  from public.entitlements
  where profile_id = v_profile_id and book_id = p_book_id and status = 'active';

  if v_entitlement_id is not null then
    return v_entitlement_id;
  end if;

  -- Lock the offer row so a concurrent admin deactivation can't race this acquisition between
  -- the check below and the order/entitlement writes that follow.
  select o.id, o.sku_id, o.market_code, o.currency
  into v_offer_id, v_sku_id, v_market_code, v_currency
  from public.offers o
  join public.skus s on s.id = o.sku_id
  join public.editions e on e.id = s.edition_id
  where e.book_id = p_book_id
    and o.active = true
    and o.price_minor = 0
    and (o.starts_at is null or o.starts_at <= now())
    and (o.ends_at is null or o.ends_at > now())
  order by o.market_code
  limit 1
  for update of o;

  if v_offer_id is null then
    raise exception 'acquire_free_ebook: no active free offer for book %', p_book_id using errcode = 'EB006';
  end if;

  -- Deterministic, not alphabetical: prefer the book's own original_language localization over
  -- whichever locale happens to sort first (which silently favoured 'en' over 'vi' every time).
  select b.original_language into v_original_language
  from public.books b
  where b.id = p_book_id;

  select bl.title into v_title_snapshot
  from public.book_localizations bl
  where bl.book_id = p_book_id
  order by (bl.locale = v_original_language) desc, bl.locale
  limit 1;

  insert into public.orders (profile_id, status, payment_status, market_code, currency, total_minor)
  values (v_profile_id, 'completed', 'not_required', v_market_code, v_currency, 0)
  returning id into v_order_id;

  insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, quantity)
  values (v_order_id, v_sku_id, p_book_id, coalesce(v_title_snapshot, ''), 0, 1);

  insert into public.entitlements (profile_id, book_id, source_type, source_order_id, status)
  values (v_profile_id, p_book_id, 'free_order', v_order_id, 'active')
  on conflict (profile_id, book_id) where status = 'active' do nothing
  returning id into v_entitlement_id;

  if v_entitlement_id is null then
    -- Lost a race to a concurrent acquisition for the same reader/book: the order created above
    -- is a harmless extra snapshot (orders are immutable history, not the access grant itself -
    -- the winning entitlement, not this order, is what matters), and the winner's entitlement is
    -- what gets returned and library-linked below.
    select id into v_entitlement_id
    from public.entitlements
    where profile_id = v_profile_id and book_id = p_book_id and status = 'active';
  end if;

  insert into public.library_items (profile_id, book_id, entitlement_id)
  values (v_profile_id, p_book_id, v_entitlement_id)
  on conflict (profile_id, book_id) do nothing;

  return v_entitlement_id;
end;
$$;

revoke execute on function public.acquire_free_ebook(uuid) from public, anon;
grant execute on function public.acquire_free_ebook(uuid) to authenticated;

-- ============================================================================================
-- grant_complimentary_entitlement: Ruling AO's admin-authorization model, the Ruling W pattern -
-- user-session client, is_admin() gate inside the function, EXECUTE to authenticated only (there
-- is no separate "admin" Postgres role; is_admin() is what actually distinguishes an admin's
-- authenticated session from an ordinary reader's), and the actor recorded from auth.uid() rather
-- than trusted from a parameter.
--
-- No order or payment row is ever created (spec 6.3): entitlements_source_consistency's
-- admin_grant branch requires actor_profile_id and a non-empty reason and forbids
-- source_order_id outright, so there is no path through this function that could construct one.
-- The audit_logs insert is the last statement in the same function body PostgREST wraps as one
-- transaction, so it cannot land without the grant, or vice versa - audit_logs' own
-- update/delete/truncate immutability triggers mean there is no compensating write available if
-- the two were ever split across transactions.
create function public.grant_complimentary_entitlement(p_profile_id uuid, p_book_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
  v_entitlement_id uuid;
begin
  if not public.is_admin() then
    raise exception 'grant_complimentary_entitlement: caller is not an admin' using errcode = '42501';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'grant_complimentary_entitlement: a reason is required' using errcode = '22023';
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  if v_actor_profile_id is null then
    raise exception 'grant_complimentary_entitlement: admin caller has no profile' using errcode = 'P0002';
  end if;

  if not exists (select 1 from public.profiles where id = p_profile_id) then
    raise exception 'grant_complimentary_entitlement: profile % does not exist', p_profile_id using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.books where id = p_book_id) then
    raise exception 'grant_complimentary_entitlement: book % does not exist', p_book_id using errcode = 'P0002';
  end if;

  -- Lock this subject's entitlement row, if any, so a concurrent grant/revoke on the same
  -- (profile, book) can't race this one. Prefers an already-active row over a merely more recent
  -- revoked one: entitlements_active_subject_key allows only one active row per (profile, book),
  -- so reactivating a stale revoked row while an active one exists would violate it outright.
  select id into v_entitlement_id
  from public.entitlements
  where profile_id = p_profile_id and book_id = p_book_id
  order by (status = 'active') desc, granted_at desc
  limit 1
  for update;

  -- Ruling BQ: spec 6.3 point 1 ("an admin selects a verified customer identity") governs
  -- selecting a person to grant access to for the first time - not continuously re-verifying one
  -- who already had it. The entitlement's subject is profile_id, and an email change (which
  -- resets customer_identities.verified_at to null via the existing trigger, pending
  -- reconfirmation) does not change who the profile is. So this check applies only when
  -- v_entitlement_id is still null here - a genuinely new grant - never to a reactivation of an
  -- existing row for the same profile, whatever its current verification state.
  if v_entitlement_id is null and not exists (
    select 1 from public.customer_identities ci
    where ci.profile_id = p_profile_id and ci.verified_at is not null
  ) then
    raise exception 'grant_complimentary_entitlement: profile % has no verified identity', p_profile_id
      using errcode = 'EB007';
  end if;

  if v_entitlement_id is not null then
    -- Reactivates an existing row (spec 6.3 point 3: "grants or reactivates") and converts it to
    -- an admin_grant regardless of its previous source - an admin explicitly granting
    -- complimentary access always records that actor and reason, even over a reader's own prior
    -- free_order or simulated_payment entitlement.
    update public.entitlements
    set status = 'active',
        source_type = 'admin_grant',
        source_order_id = null,
        actor_profile_id = v_actor_profile_id,
        reason = p_reason,
        revoked_at = null,
        granted_at = now()
    where id = v_entitlement_id;
  else
    insert into public.entitlements (profile_id, book_id, source_type, actor_profile_id, reason, status)
    values (p_profile_id, p_book_id, 'admin_grant', v_actor_profile_id, p_reason, 'active')
    returning id into v_entitlement_id;
  end if;

  insert into public.library_items (profile_id, book_id, entitlement_id)
  values (p_profile_id, p_book_id, v_entitlement_id)
  on conflict (profile_id, book_id) do update set entitlement_id = excluded.entitlement_id;

  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, reason, metadata)
  values (
    v_actor_profile_id,
    'grant_complimentary_entitlement',
    'entitlements',
    v_entitlement_id,
    p_reason,
    jsonb_build_object('profile_id', p_profile_id, 'book_id', p_book_id)
  );

  return v_entitlement_id;
end;
$$;

revoke execute on function public.grant_complimentary_entitlement(uuid, uuid, text) from public, anon;
grant execute on function public.grant_complimentary_entitlement(uuid, uuid, text) to authenticated;

-- revoke_complimentary_entitlement: the inverse of the grant flow above. It is deliberately
-- limited to admin_grant rows so this action cannot silently cancel a free-order or payment-backed
-- entitlement. Revocation, library cleanup, and audit recording are one transaction. Repeating an
-- already-completed revocation is idempotent and also cleans up any stale library row.
create function public.revoke_complimentary_entitlement(
  p_profile_id uuid,
  p_entitlement_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
  v_book_id uuid;
  v_status public.entitlement_status;
begin
  if not public.is_admin() then
    raise exception 'revoke_complimentary_entitlement: caller is not an admin' using errcode = '42501';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'revoke_complimentary_entitlement: a reason is required' using errcode = '22023';
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  if v_actor_profile_id is null then
    raise exception 'revoke_complimentary_entitlement: admin caller has no profile' using errcode = 'P0002';
  end if;

  select e.book_id, e.status into v_book_id, v_status
  from public.entitlements e
  where e.id = p_entitlement_id
    and e.profile_id = p_profile_id
    and e.source_type = 'admin_grant'
  for update;

  if v_book_id is null then
    raise exception 'revoke_complimentary_entitlement: complimentary entitlement does not exist'
      using errcode = 'P0002';
  end if;

  if v_status = 'active' then
    update public.entitlements
    set status = 'revoked', revoked_at = now()
    where id = p_entitlement_id;

    insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, reason, metadata)
    values (
      v_actor_profile_id,
      'revoke_complimentary_entitlement',
      'entitlements',
      p_entitlement_id,
      p_reason,
      jsonb_build_object('profile_id', p_profile_id, 'book_id', v_book_id)
    );
  end if;

  delete from public.library_items
  where entitlement_id = p_entitlement_id and profile_id = p_profile_id;

  return p_entitlement_id;
end;
$$;

revoke execute on function public.revoke_complimentary_entitlement(uuid, uuid, text) from public, anon;
grant execute on function public.revoke_complimentary_entitlement(uuid, uuid, text) to authenticated;

-- ============================================================================================
-- apply_payment_event: Ruling AO's third authorization model - reached from a webhook/event
-- handler with no session at all. EXECUTE goes to service_role only; there is no is_admin() gate
-- (auth.uid() is null under service_role - Ruling W's trap - so an is_admin() check here would
-- reject every event, not just unauthorized ones). Its trust boundary is the verified-event
-- contract (lib/commerce/types.ts's VerifiedPaymentEvent, produced by a PaymentProvider that has
-- already checked the request) plus payment_events' unique(provider, provider_event_id)
-- constraint - never a role predicate.
--
-- Replay safety: the event row is inserted FIRST, via `on conflict (provider, provider_event_id)
-- do nothing`. When that insert is a no-op (this exact event was already processed), the function
-- returns the current outcome without evaluating or mutating anything else - this ordering, not a
-- check performed afterwards, is what makes duplicate delivery of the same event safe.
--
-- Out-of-order safety: once an order has left 'pending' (it is 'completed' or 'cancelled'), any
-- further event - regardless of its own status or how it compares to what's already
-- recorded - is a no-op that returns the current outcome. This is deliberately status-blind: a
-- late 'succeeded' event arriving after a 'cancelled' event was already applied must not
-- resurrect the order, and a late 'failed' or 'cancelled' event arriving after a 'succeeded' one
-- was already applied must not revoke the access already granted.
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
returns table (entitlement_id uuid, order_status public.order_status, payment_status public.payment_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.payment_status;
  v_order_status public.order_status;
  v_payment_status public.payment_status;
  v_order_total_minor bigint;
  v_order_currency text;
  v_profile_id uuid;
  v_payment_id uuid;
  v_event_row_id uuid;
  v_book_id uuid;
  v_entitlement_id uuid;
  v_payload_hash text;
begin
  if p_status not in ('succeeded', 'failed', 'cancelled') then
    raise exception 'apply_payment_event: invalid status %', p_status using errcode = '22023';
  end if;
  v_status := p_status::public.payment_status;

  -- Lock the order row before anything else, so two events for the same order can never be
  -- evaluated concurrently against each other. Columns are qualified with the `o` alias because
  -- this function's own OUT parameters are named order_status/payment_status too - left
  -- unqualified, orders.payment_status is ambiguous against the OUT parameter of the same name.
  select o.status, o.payment_status, o.total_minor, o.currency, o.profile_id
  into v_order_status, v_payment_status, v_order_total_minor, v_order_currency, v_profile_id
  from public.orders o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'apply_payment_event: order % does not exist', p_order_id using errcode = 'P0002';
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
    values (v_profile_id, v_book_id, 'simulated_payment', p_order_id, 'active')
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
