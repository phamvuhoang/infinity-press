-- S9: the gift lifecycle - configuration, payment completion, and the atomic claim
-- (docs/superpowers/specs/2026-09-21-s9-bundles-and-gifts-design.md 7.2-7.3).
--
-- DEPLOYMENT ORDERING - RESOLVED. This migration had to land together with the gift email
-- template, for the reason 20260924150000's header sets out: until the worker could render a gift
-- message it failed every claimed gift_claim row with `unsupported_template`, and six failures
-- retire a row permanently. lib/email/outbox.ts now delivers gift_claim rows, so the outbox row
-- activate_order_gift brings due below is genuinely sent.
--
-- Two new error codes, continuing from EB027:
--
--   EB028 - configure_gift / remove_gift: this order cannot carry a gift right now. It is not the
--           caller's, it does not exist, it has left 'pending', its transfer has already been
--           reported, or its gift has already been activated. One code for all of them, so an
--           order id cannot be probed for existence by the error it produces.
--   EB029 - claim_gift: this token cannot be claimed. Unknown, already claimed by somebody else,
--           revoked, or belonging to an order that was never paid for. One code for all of them,
--           for the same reason and more sharply: the token IS the authorization, so an error that
--           discriminated between "no such token" and "that token is spent" would be an oracle a
--           guesser could climb.
--
-- The shape of the feature, and why it is arranged this way:
--
--   * A gift is configured on a PENDING order, before any money moves. The raw token never gets
--     here - the application generates it, hashes it, and sends the hash - so this database cannot
--     leak a token it was never given. The one operational copy of the claim PATH lives in
--     notification_outbox.payload, which is admin-readable and writable by nobody, and claim_gift
--     clears it.
--   * Completing a gift order must grant the BUYER nothing. Three functions complete an order -
--     apply_payment_event (simulator and, via confirm_manual_payment, manual) and
--     apply_coupon_to_order's zero-total branch - and all three now ask one shared helper,
--     activate_order_gift, whether this order is a gift. Duplicating "is it a gift, and what does
--     that mean" across them is exactly how the two paths would drift apart.
--   * Claiming is atomic because the gift row is locked with `for update` BEFORE its status is
--     read. Two readers holding the same link is not a hypothetical - a forwarded email is the
--     normal case - so the second one blocks until the first commits, then sees 'claimed' and is
--     refused. supabase/tests/048 stages that with two real concurrent sessions.

-- ============================================================================================
-- activate_order_gift: does this order carry a gift, and if it does, make it claimable.
--
-- Internal. Not granted to anon or authenticated, and it takes no authorization decision of its
-- own: its callers have already locked the order and decided that it completed. It exists so that
-- the three completion paths share ONE answer to "is this a gift, and what happens to it now"
-- rather than three copies of a status machine.
--
-- Returns true whenever the order carries a gift at all - not only when this call moved it. A
-- replayed payment event reaches its caller with the gift already 'sent', and the buyer must be
-- granted nothing on the replay just as they were on the first pass; a function that returned
-- false there would hand the buyer the books on the second delivery of the same webhook.
--
-- A 'revoked' gift also returns true. The purchase was a gift, the admin took the link back, and
-- the remedy is the admin's reissue - never a silent fallback that grants the purchaser books
-- they bought for somebody else.
create function public.activate_order_gift(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gift_id uuid;
begin
  update public.gifts g
  set status = 'sent'
  where g.order_id = p_order_id and g.status = 'pending'
  returning g.id into v_gift_id;

  if v_gift_id is not null then
    -- configure_gift parked this row in the future so the worker could not mail a claim link for
    -- an unpaid gift. The order is paid now, so it becomes due.
    update public.notification_outbox o
    set available_at = now()
    where o.gift_id = v_gift_id;

    return true;
  end if;

  return exists (select 1 from public.gifts g where g.order_id = p_order_id);
end;
$$;

revoke execute on function public.activate_order_gift(uuid) from public, anon, authenticated;

-- ============================================================================================
-- configure_gift: the purchaser turns their own pending order into a gift, or corrects one.
--
-- p_token_hash is the SHA-256 hash and never the token; gifts_claim_token_hash_check makes that a
-- schema rule rather than a convention. p_claim_path is the localized relative path the recipient
-- will be sent, built by lib/i18n/routes.ts - relative, so the operational copy below cannot pin
-- the link to a stale origin.
--
-- An upsert rather than an insert, because correcting a mistyped address is the ordinary case and
-- must leave ONE gift and ONE outbox row. Replacing the hash is what retires the old token: the
-- address was wrong, so the link that went with it must stop working.
create function public.configure_gift(
  p_order_id uuid,
  p_recipient_email text,
  p_message text,
  p_token_hash text,
  p_claim_path text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_order_status public.order_status;
  v_gift_status text;
  v_gift_id uuid;
  v_email text;
  v_message text;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'configure_gift: no profile for the current session' using errcode = 'P0002';
  end if;

  -- Locked before anything is read off it, so a payment event arriving for this order is
  -- serialized against this decision rather than evaluated beside it. Another reader's order is
  -- indistinguishable from a missing one.
  select o.status into v_order_status
  from public.orders o
  where o.id = p_order_id and o.profile_id = v_profile_id
  for update;

  if v_order_status is null or v_order_status <> 'pending' then
    raise exception 'configure_gift: order % is not a pending order of the caller', p_order_id
      using errcode = 'EB028';
  end if;

  -- The same guard apply_coupon_to_order makes, for the same reason: a reader who has told us they
  -- transferred a specific amount for a specific purchase must not have that purchase turned into
  -- somebody else's underneath the report.
  if exists (select 1 from public.manual_transfer_claims c where c.order_id = p_order_id) then
    raise exception 'configure_gift: order % already has a reported transfer', p_order_id
      using errcode = 'EB028';
  end if;

  -- An activated gift is past the point of editing: its link is already out, and rewriting the
  -- hash underneath a recipient who is holding the old one would strand them.
  select g.id, g.status into v_gift_id, v_gift_status
  from public.gifts g where g.order_id = p_order_id for update;

  if v_gift_id is not null and v_gift_status <> 'pending' then
    raise exception 'configure_gift: order % already has a % gift', p_order_id, v_gift_status
      using errcode = 'EB028';
  end if;

  -- Normalized here as well as in lib/commerce/gift-form.ts, because this function is the boundary
  -- gifts_recipient_email_check defends and the check would otherwise raise a raw 23514.
  v_email := lower(btrim(coalesce(p_recipient_email, '')));
  v_message := nullif(btrim(coalesce(p_message, '')), '');

  insert into public.gifts (order_id, purchaser_profile_id, recipient_email, message, claim_token_hash, status)
  values (p_order_id, v_profile_id, v_email, v_message, p_token_hash, 'pending')
  on conflict (order_id) do update
  set recipient_email = excluded.recipient_email,
      message = excluded.message,
      claim_token_hash = excluded.claim_token_hash
  returning id into v_gift_id;

  -- One row per gift (notification_outbox_gift_id_key), parked in the future: the order has not
  -- been paid for, and a claim link must not be mailed for a purchase that may never complete.
  -- activate_order_gift brings it due. The attempt counter is reset alongside the payload so a
  -- corrected address starts its delivery budget over rather than inheriting the failures of the
  -- address it replaced.
  insert into public.notification_outbox (gift_id, template_key, payload, available_at)
  values (v_gift_id, 'gift_claim', jsonb_build_object('claimPath', p_claim_path), 'infinity'::timestamptz)
  on conflict (gift_id) do update
  set payload = excluded.payload,
      available_at = 'infinity'::timestamptz,
      attempt_count = 0,
      last_error_code = null,
      lease_token = null,
      lease_expires_at = null;
end;
$$;

revoke execute on function public.configure_gift(uuid, text, text, text, text) from public, anon;
grant execute on function public.configure_gift(uuid, text, text, text, text) to authenticated;

-- ============================================================================================
-- remove_gift: the purchaser changes their mind before paying.
--
-- Only ever an UNACTIVATED gift on a pending order. Once the order is paid the gift is the thing
-- that was bought, and withdrawing it is an admin revocation with an audit trail, not a checkbox.
-- The outbox row goes with it through notification_outbox_gift_id_fkey's on delete cascade.
create function public.remove_gift(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_order_status public.order_status;
  v_gift_id uuid;
  v_gift_status text;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'remove_gift: no profile for the current session' using errcode = 'P0002';
  end if;

  select o.status into v_order_status
  from public.orders o
  where o.id = p_order_id and o.profile_id = v_profile_id
  for update;

  if v_order_status is null or v_order_status <> 'pending' then
    raise exception 'remove_gift: order % is not a pending order of the caller', p_order_id
      using errcode = 'EB028';
  end if;

  select g.id, g.status into v_gift_id, v_gift_status
  from public.gifts g where g.order_id = p_order_id for update;

  -- Refused rather than treated as done: a reader who presses remove on an order with no gift has
  -- a stale page in front of them, and the caller needs to reload rather than believe it worked.
  if v_gift_id is null or v_gift_status <> 'pending' then
    raise exception 'remove_gift: order % has no removable gift', p_order_id using errcode = 'EB028';
  end if;

  delete from public.gifts g where g.id = v_gift_id;
end;
$$;

revoke execute on function public.remove_gift(uuid) from public, anon;
grant execute on function public.remove_gift(uuid) to authenticated;

-- ============================================================================================
-- get_my_order_gift: what the purchaser set, and nothing else.
--
-- Three columns. Not the hash, which is a credential; not the claim path, which is the link
-- itself and lives only in the protected outbox payload; not the claimant, which is the
-- recipient's business. Read through public.gift_summaries rather than public.gifts, so this
-- database keeps exactly one read path to a gift row and one place where that path is gated.
--
-- The join on orders is not redundant with the view's own gate. The view also admits an admin, and
-- this function is the CHECKOUT read - it answers "what did I, the purchaser, set on my order",
-- so it is scoped to the caller's own order however privileged the caller happens to be.
create function public.get_my_order_gift(p_order_id uuid)
returns table (recipient_email text, message text, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'get_my_order_gift: no profile for the current session' using errcode = 'P0002';
  end if;

  return query
  select g.recipient_email, g.message, g.status
  from public.gift_summaries g
  join public.orders o on o.id = g.order_id
  where g.order_id = p_order_id and o.profile_id = v_profile_id;
end;
$$;

revoke execute on function public.get_my_order_gift(uuid) from public, anon;
grant execute on function public.get_my_order_gift(uuid) to authenticated;

-- ============================================================================================
-- claim_gift: the recipient turns a link into access, once.
--
-- The recipient's account email is deliberately NOT compared against gifts.recipient_email (spec
-- 7.3): the token is the authorization, and an address match would strand a recipient whose
-- account uses a different address from the one the purchaser typed. The address is kept for the
-- admin's reissue flow and for support.
--
-- `for update` on the gift row is the whole concurrency story, and it precedes the status read for
-- the reason the S8 order lock precedes its checks: a status read taken before the lock is a
-- decision made against a row another session is already changing.
create function public.claim_gift(p_token text)
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

revoke execute on function public.claim_gift(text) from public, anon;
grant execute on function public.claim_gift(text) to authenticated;

-- ============================================================================================
-- apply_payment_event, recreated so that completing a GIFT order grants the buyer nothing.
--
-- Re-emitting the whole body is how this repository changes a function: applied migrations are
-- never edited and Postgres has no partial patch for one. Everything is carried over verbatim from
-- 20260924100000_s9_multi_item_orders.sql, which is the version in force - the provider-to-source
-- mapping and its EB015 refusal, the status validation, the order row lock, the P0002 missing
-- order, the EB016 provider guard and its placement ahead of the payments resolution, the
-- payments resolve-or-create, the payload hash, the unique payment_events insert that makes
-- replay safe, the replay branch, the out-of-order/terminal-order branch, the EB004 amount and
-- currency check, the entitlement/library loop with its resolve-by-subject fallback, the S8
-- coupon redemption flip on success, the S8 reservation release on cancellation, and the reporting
-- of every access array through order_active_entitlement_ids.
--
-- Exactly two things change, and both are the same rule seen from two places:
--
--   1. v_is_gift, resolved once under the order lock. On the SUCCESS path it is the return value of
--      activate_order_gift, which also moves the gift to 'sent' and releases its outbox row; on the
--      reporting paths it is a plain existence test, because a replay and a late event must not
--      write anything at all.
--   2. Where v_is_gift is true, the entitlement/library loop is skipped and entitlement_ids is the
--      empty array. It is deliberately NOT order_active_entitlement_ids: that helper answers "what
--      does this buyer hold for these books", and for a gift the honest answer to "what did this
--      order grant the buyer" is nothing - a buyer who happens to own one of the books already
--      must not have it reported as something this purchase gave them.
--
-- The return type is unchanged, so this could have been a `create or replace`. It is a drop and
-- recreate because confirm_manual_payment depends on it by name and the pair is easier to reason
-- about recreated together - but confirm_manual_payment itself is untouched below: it delegates,
-- so it inherits the gift branch without knowing it exists.
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
  v_entitlement_ids uuid[] := array[]::uuid[];
  v_payload_hash text;
  -- Whether this order was bought for somebody else. Resolved under the order lock below, so it
  -- cannot change between the branches that consult it.
  v_is_gift boolean;
begin
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

revoke execute on function public.apply_payment_event(text, text, uuid, text, text, bigint, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_payment_event(text, text, uuid, text, text, bigint, text, timestamptz)
  to service_role;

-- confirm_manual_payment's idempotent branch reports what the buyer holds for the order. For a
-- gift order that is nothing, for the same reason apply_payment_event's replay branch reports
-- nothing: the purchase granted the buyer no access, so a second click on confirm must not start
-- claiming it did. Recreated for that one change; everything else is carried over verbatim from
-- 20260924100000.
drop function public.confirm_manual_payment(uuid, bigint, text, text, boolean);

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

  select pr.id into v_admin_id from public.profiles pr where pr.auth_user_id = auth.uid();

  v_reference := btrim(coalesce(p_bank_reference, ''));
  if v_reference = '' then
    raise exception 'confirm_manual_payment: a bank reference is required' using errcode = '22023';
  end if;
  v_note := nullif(btrim(coalesce(p_note, '')), '');

  if p_received_amount_minor is null then
    raise exception 'confirm_manual_payment: a received amount is required' using errcode = '22023';
  end if;

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
    delete from public.manual_transfer_claims where order_id = p_order_id;

    if exists (select 1 from public.gifts g where g.order_id = p_order_id) then
      v_entitlement_ids := array[]::uuid[];
    else
      v_entitlement_ids := public.order_active_entitlement_ids(p_order_id, v_profile_id);
    end if;

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
-- apply_coupon_to_order, recreated so that a fully discounted GIFT order behaves identically to a
-- paid one (spec 7.2): the buyer is granted nothing and the gift becomes claimable.
--
-- Everything is carried over verbatim from 20260924140000_s9_bundle_coupons.sql, which is the
-- version in force: the per-profile advisory lock, the profile-then-order-then-coupon lock order,
-- the EB024 order refusals, the reported-transfer guard, the attempt quota and its
-- record_coupon_failure calls, the uniform 'invalid' rejection value, the discriminating
-- `raise log`, the coupon_books/coupon_bundles scope rule decided from orders.bundle_id, the
-- currency check, both redemption limits counted under the coupon row lock, the floored-then-
-- clamped arithmetic, the reservation, the coupon.applied audit row, the positive-total return,
-- the cancelled pending payment, and the single redemption flip.
--
-- One thing changes: in the zero-total branch, activate_order_gift decides whether the entitlement
-- loop runs at all. The flip below it still happens exactly once, on both branches - the sale
-- happened either way, so the code was used either way.
drop function public.apply_coupon_to_order(uuid, text);

create function public.apply_coupon_to_order(p_order_id uuid, p_code text)
returns table (
  subtotal_minor bigint,
  discount_minor bigint,
  total_minor bigint,
  order_status public.order_status,
  entitlement_ids uuid[],
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
  v_has_scope boolean;
  v_in_scope boolean;
  v_entitlement_ids uuid[] := array[]::uuid[];
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'apply_coupon_to_order: no profile for the current session' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('apply_coupon_to_order:' || v_profile_id::text, 0));

  select o.id, o.profile_id, o.status, o.currency, o.subtotal_minor, o.coupon_id, o.bundle_id
  into v_order
  from public.orders o
  where o.id = p_order_id and o.profile_id = v_profile_id
  for update;

  if v_order.id is null or v_order.status <> 'pending' or v_order.coupon_id is not null then
    raise exception 'apply_coupon_to_order: order % is not an uncouponed pending order of the caller', p_order_id
      using errcode = 'EB024';
  end if;

  if exists (select 1 from public.manual_transfer_claims c where c.order_id = p_order_id) then
    raise exception 'apply_coupon_to_order: order % already has a reported transfer', p_order_id
      using errcode = 'EB024';
  end if;

  if public.coupon_attempts_exhausted(v_profile_id) then
    raise log 'apply_coupon_to_order: order % profile %: too many failed attempts', p_order_id, v_profile_id;
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        v_entitlement_ids, 'rate_limited'::text;
    return;
  end if;

  v_code := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));

  select c.* into v_coupon
  from public.coupons c
  where c.code = v_code
  for update;

  if v_coupon.id is null then
    raise log 'apply_coupon_to_order: order % profile %: unknown code', p_order_id, v_profile_id;
    perform public.record_coupon_failure(v_profile_id);
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        v_entitlement_ids, 'invalid'::text;
    return;
  end if;

  if not v_coupon.active then
    raise log 'apply_coupon_to_order: order % profile %: inactive', p_order_id, v_profile_id;
    perform public.record_coupon_failure(v_profile_id);
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        v_entitlement_ids, 'invalid'::text;
    return;
  end if;

  if v_coupon.starts_at is not null and v_coupon.starts_at > now() then
    raise log 'apply_coupon_to_order: order % profile %: not yet started', p_order_id, v_profile_id;
    perform public.record_coupon_failure(v_profile_id);
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        v_entitlement_ids, 'invalid'::text;
    return;
  end if;

  if v_coupon.ends_at is not null and v_coupon.ends_at <= now() then
    raise log 'apply_coupon_to_order: order % profile %: expired', p_order_id, v_profile_id;
    perform public.record_coupon_failure(v_profile_id);
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        v_entitlement_ids, 'invalid'::text;
    return;
  end if;

  v_has_scope :=
    exists (select 1 from public.coupon_books cb where cb.coupon_id = v_coupon.id)
    or exists (select 1 from public.coupon_bundles cbu where cbu.coupon_id = v_coupon.id);

  if v_has_scope then
    if v_order.bundle_id is not null then
      v_in_scope := exists (
        select 1 from public.coupon_bundles cbu
        where cbu.coupon_id = v_coupon.id and cbu.bundle_id = v_order.bundle_id
      );
    else
      select oi.book_id into v_book_id
      from public.order_items oi
      where oi.order_id = p_order_id
      order by oi.position
      limit 1;

      v_in_scope := exists (
        select 1 from public.coupon_books cb
        where cb.coupon_id = v_coupon.id and cb.book_id = v_book_id
      );
    end if;

    if not v_in_scope then
      raise log 'apply_coupon_to_order: order % profile %: out of scope', p_order_id, v_profile_id;
      perform public.record_coupon_failure(v_profile_id);
      return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                          v_entitlement_ids, 'invalid'::text;
      return;
    end if;
  end if;

  if v_coupon.kind = 'fixed' and v_coupon.currency <> v_order.currency then
    raise log 'apply_coupon_to_order: order % profile %: currency mismatch', p_order_id, v_profile_id;
    perform public.record_coupon_failure(v_profile_id);
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        v_entitlement_ids, 'invalid'::text;
    return;
  end if;

  select count(*) into v_used from public.coupon_redemptions r where r.coupon_id = v_coupon.id;
  if v_coupon.max_redemptions is not null and v_used >= v_coupon.max_redemptions then
    raise log 'apply_coupon_to_order: order % profile %: exhausted', p_order_id, v_profile_id;
    perform public.record_coupon_failure(v_profile_id);
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        v_entitlement_ids, 'invalid'::text;
    return;
  end if;

  select count(*) into v_used_by_profile
  from public.coupon_redemptions r where r.coupon_id = v_coupon.id and r.profile_id = v_profile_id;
  if v_used_by_profile >= v_coupon.max_redemptions_per_profile then
    raise log 'apply_coupon_to_order: order % profile %: per-profile limit reached', p_order_id, v_profile_id;
    perform public.record_coupon_failure(v_profile_id);
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        v_entitlement_ids, 'invalid'::text;
    return;
  end if;

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

  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, reason, metadata)
  values (v_profile_id, 'coupon.applied', 'orders', p_order_id, null,
          jsonb_build_object('coupon_id', v_coupon.id, 'code', v_coupon.code,
                             'discount_minor', v_discount, 'total_minor', v_total));

  if v_total > 0 then
    update public.payments pay
    set amount_minor = v_total
    where pay.order_id = p_order_id and pay.status = 'pending';

    return query select v_order.subtotal_minor, v_discount, v_total, v_order.status,
                        v_entitlement_ids, null::text;
    return;
  end if;

  -- Zero total: the order completes here, in this transaction (S8 spec 4). There is nothing to pay,
  -- so the pending payment is cancelled rather than left waiting for an event that will never come.
  -- Its amount_minor is deliberately left where it was: a cancelled payment is a record of what
  -- WOULD have been charged, and rewriting it to zero would erase the only trace of the sum the
  -- reader was looking at when the code landed.
  update public.payments pay set status = 'cancelled' where pay.order_id = p_order_id and pay.status = 'pending';
  update public.orders o set status = 'completed', payment_status = 'not_required' where o.id = p_order_id;

  -- The gift branch, the same one apply_payment_event takes and through the same helper (spec
  -- 7.2): a fully discounted gift order makes the gift claimable and grants the buyer nothing.
  if not public.activate_order_gift(p_order_id) then
    -- One entitlement and one library item per book of the order - the same loop
    -- apply_payment_event runs. `distinct` because the grant is per subject and not per line, and
    -- the resolve-by-subject fallback keeps a book the reader already holds a no-op rather than a
    -- second grant or a constraint violation.
    for v_book_id in
      select distinct oi.book_id from public.order_items oi where oi.order_id = p_order_id
    loop
      insert into public.entitlements (profile_id, book_id, source_type, source_order_id, status)
      values (v_profile_id, v_book_id, 'free_order', p_order_id, 'active')
      on conflict (profile_id, book_id) where status = 'active' do nothing
      returning id into v_entitlement_id;

      if v_entitlement_id is null then
        select e.id into v_entitlement_id
        from public.entitlements e
        where e.profile_id = v_profile_id and e.book_id = v_book_id and e.status = 'active';
      end if;

      insert into public.library_items (profile_id, book_id, entitlement_id)
      values (v_profile_id, v_book_id, v_entitlement_id)
      on conflict (profile_id, book_id) do nothing;
    end loop;

    -- Reported through the same helper apply_payment_event and confirm_manual_payment report it
    -- through, so "what does this buyer hold for this order" has one answer rather than three.
    v_entitlement_ids := public.order_active_entitlement_ids(p_order_id, v_profile_id);
  end if;

  -- ONE flip for the order, on both branches. A coupon is reserved against the order, and
  -- coupon_redemptions.order_id is unique, so this is one row however many books the order held.
  update public.coupon_redemptions r
  set status = 'redeemed', redeemed_at = now()
  where r.order_id = p_order_id;

  return query select v_order.subtotal_minor, v_discount, 0::bigint, 'completed'::public.order_status,
                      v_entitlement_ids, null::text;
end;
$$;

revoke execute on function public.apply_coupon_to_order(uuid, text) from public, anon;
grant execute on function public.apply_coupon_to_order(uuid, text) to authenticated;
