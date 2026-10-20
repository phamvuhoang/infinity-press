-- S9: the gift admin surface - search, resend, and reissue
-- (docs/superpowers/specs/2026-09-21-s9-bundles-and-gifts-design.md 7.4).
--
-- Two new error codes, continuing from EB029:
--
--   EB030 - admin_resend_gift / admin_reissue_gift: this gift is not in 'sent', so there is no
--           live delivery to work with. It was never paid for, or it has been revoked; or a 'sent'
--           gift has no outbox row at all, which means an invariant broke. Both functions raise it
--           for both conditions, so an operator gets one answer to "this gift is not in a state I
--           can act on". Unlike the reader-facing codes it may be specific, because the only
--           caller is an admin who has already passed is_admin(); there is no oracle in it.
--   EB031 - admin_reissue_gift: this gift has been claimed. Kept apart from EB030 because the
--           remedy is different and specific: a claimed gift is a real entitlement, and taking it
--           back is revoke_order_entitlement's job, with its own audit row - not a silent hash
--           swap underneath a reader who already has the books in their library.
--
-- What this migration is careful about, and why:
--
--   * The operator never sees the credential. admin_search_gifts returns neither
--     claim_token_hash nor notification_outbox.payload. It returns the claim LOCALE, derived from
--     the stored path, because that locale is what the recipient's message is rendered in
--     (lib/email/outbox.ts readClaimPath) and a reissue that silently switched languages on the
--     recipient would be a regression the operator could not see coming. A locale is 'vi' or 'en';
--     it is not the link.
--   * The audit trail is a support record, not a copy of the gift. Every address that reaches
--     audit_logs goes through public.mask_email first, and no token, hash or claim path reaches it
--     at all. An audit table that accumulated plaintext recipient addresses would quietly become
--     the leak gifts.claim_token_hash and gift_summaries exist to prevent.
--   * Both mutating functions act only on a gift in `sent`, and that is load-bearing rather than
--     tidy. `sent` is the status activate_order_gift sets when an order COMPLETES, and claim_gift
--     gates on gift status alone - it never rechecks payment. A reissue that accepted a `pending`
--     gift would therefore set status = 'sent' and undo the 'infinity' park configure_gift applies
--     to its outbox row, handing the recipient a claimable link for an order nobody ever paid for.
--     The purchaser corrects an unpaid gift at checkout, through configure_gift; there is no link
--     out yet for support to reissue.
--   * Both mutating functions take their locks in one order - gift, then its outbox row - so they
--     can never deadlock against each other, and so the decision each makes is taken against a row
--     no other session is mid-change on. configure_gift and activate_order_gift touch the same two
--     rows in the same order.
--   * Resend and reissue both UPDATE the single outbox row rather than deleting and re-inserting.
--     notification_outbox.gift_id is unique, so "the row" is well defined; replacing it would
--     break the worker's `gift-claim/<row id>` idempotency key and could deliver twice.

-- The audit mask -------------------------------------------------------------------------------

-- 'recipient-a@example.test' -> 'r***@example.test'. Enough for an operator to recognise the
-- address they just typed in a support thread, not enough to be a recipient list. Internal: it is
-- an implementation detail of the two audit rows below, not a browser-callable function.
--
-- A value with no local part to mask (no '@', or '@' first) degrades to '***' rather than leaking
-- whatever it is. gifts_recipient_email_check makes that shape impossible on a stored address, so
-- this is belt-and-braces for a caller-supplied one.
create function public.mask_email(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_email is null or position('@' in p_email) < 2 then '***'
    else left(p_email, 1) || '***@' || split_part(p_email, '@', 2)
  end;
$$;

revoke execute on function public.mask_email(text) from public, anon, authenticated;

-- Search ---------------------------------------------------------------------------------------

-- The operator's one read path to a gift (spec 7.4). Three keys, all partial and all
-- case-insensitive, because support arrives as "something like IB-A00", a purchaser writing in
-- from the address they bought with, or a recipient's address read off a forwarded message.
--
-- A blank query lists the newest gifts rather than refusing, the way /admin/orders does: an
-- operator opening the page cold should see the gifts that are in flight.
--
-- Read through public.gifts directly rather than through public.gift_summaries: the view's gate
-- admits an admin already, but this function has its own is_admin() check and joining the view
-- would add a second, redundant evaluation of it per row inside the barrier.
create function public.admin_search_gifts(p_query text)
returns table (
  gift_id uuid,
  order_id uuid,
  reference_code text,
  purchaser_email text,
  recipient_email text,
  item_titles text[],
  item_count integer,
  status text,
  claim_locale text,
  created_at timestamptz,
  claimed_at timestamptz,
  revoked_at timestamptz,
  attempt_count integer,
  last_error_code text,
  sent_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_query text := btrim(coalesce(p_query, ''));
  v_pattern text := '%' || lower(v_query) || '%';
begin
  if not public.is_admin() then
    raise exception 'admin_search_gifts: caller is not an admin' using errcode = '42501';
  end if;

  return query
  select
    g.id,
    g.order_id,
    o.reference_code,
    ci.normalized_email,
    g.recipient_email,
    coalesce(items.titles, array[]::text[]),
    coalesce(items.count, 0)::integer,
    g.status,
    -- '/vi/gifts/claim/<token>' -> 'vi'. The locale and nothing else: split_part on the second
    -- segment cannot return the token, which is the fourth.
    nullif(split_part(coalesce(ob.payload ->> 'claimPath', ''), '/', 2), '') as claim_locale,
    g.created_at,
    g.claimed_at,
    g.revoked_at,
    ob.attempt_count,
    ob.last_error_code,
    ob.sent_at
  from public.gifts g
  join public.orders o on o.id = g.order_id
  -- Laterally, and capped at one row: customer_identities is unique on the ADDRESS, not on the
  -- profile, so a plain join would emit a gift twice for a purchaser who has two identity rows.
  left join lateral (
    select c.normalized_email
    from public.customer_identities c
    where c.profile_id = g.purchaser_profile_id
    order by c.verified_at desc nulls last, c.created_at
    limit 1
  ) ci on true
  left join public.notification_outbox ob on ob.gift_id = g.id
  -- Distinct titles in line order. Distinct because a bundle order can hold two lines for the
  -- same book, and the operator is being told what the gift covers, not how it was priced -
  -- the same de-duplication lib/email/outbox.ts does for the recipient's message.
  left join lateral (
    select array_agg(t.title order by t.position) as titles, count(*) as count
    from (
      select i.title_snapshot as title, min(i.position) as position
      from public.order_items i
      where i.order_id = g.order_id
      group by i.title_snapshot
    ) t
  ) items on true
  where v_query = ''
     or lower(o.reference_code) like v_pattern
     -- Over every identity the purchaser has, not just the one displayed above: an address they
     -- used to buy with is exactly the address a support thread arrives from.
     or exists (
       select 1 from public.customer_identities c
       where c.profile_id = g.purchaser_profile_id and lower(c.normalized_email) like v_pattern
     )
     or g.recipient_email like v_pattern
  order by g.created_at desc, g.id
  limit 50;
end;
$$;

revoke execute on function public.admin_search_gifts(text) from public, anon;
grant execute on function public.admin_search_gifts(text) to authenticated;

-- Resend ---------------------------------------------------------------------------------------

-- "The recipient says it never arrived." A retry of the SAME delivery: the same address, the same
-- token, the same payload, the same outbox row. Only the delivery state is rewound - the attempt
-- budget, the last error, the stale lease - and the row is made due now.
--
-- Restricted to a 'sent' gift, which is the exact set claim_notification_outbox is willing to
-- claim. Rewinding any other status would produce a row the worker refuses forever: a pending
-- gift's order has not been paid for, and a claimed or revoked one has no link left to send.
create function public.admin_resend_gift(p_gift_id uuid)
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

  -- Gift first, then its outbox row: the same order configure_gift and activate_order_gift use,
  -- which is what keeps the three of them from deadlocking against each other.
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

  -- A 'sent' gift always has one (configure_gift writes it in the same transaction as the gift).
  -- Refused rather than repaired: a missing row means an invariant broke, and inventing one here
  -- would hide that from the operator who is standing right there.
  if v_outbox.id is null then
    raise exception 'admin_resend_gift: gift % has no outbox row', p_gift_id using errcode = 'EB030';
  end if;

  update public.notification_outbox o
  set available_at = now(),
      attempt_count = 0,
      last_error_code = null,
      lease_token = null,
      lease_expires_at = null,
      sent_at = null
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

revoke execute on function public.admin_resend_gift(uuid) from public, anon;
grant execute on function public.admin_resend_gift(uuid) to authenticated;

-- Reissue --------------------------------------------------------------------------------------

-- "It went to the wrong address." Revocation and re-send in one step, because they are one
-- decision: the old link must stop working at the same instant the new one starts, and a gift left
-- 'revoked' between two calls is a window in which the purchaser has paid and nobody can claim.
--
-- Only a `sent` gift, for the reason in this file's header: `sent` means the order completed, and
-- claim_gift trusts that status instead of rechecking payment. A `pending` gift is an unpaid order
-- whose link has never gone out, so there is nothing to reissue and activating one here would
-- grant access that was never bought.
--
-- Replacing claim_token_hash is what retires the old token - claim_gift looks a gift up BY hash,
-- so the old one stops matching any row at all and produces the same EB029 an invented token does.
--
-- The raw token is not a parameter and never could be: the application generates it, hashes it,
-- and sends the hash and the path. This database cannot leak a token it was never given.
--
-- The reason is required and is stored in audit_logs.reason, the column revoke_order_entitlement
-- uses for the same purpose. A reissue moves somebody's paid-for gift to a different person's
-- inbox; it is not an operation that should be possible without saying why.
create function public.admin_reissue_gift(
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

  -- Normalized here as well as in the form, because this function is the boundary
  -- gifts_recipient_email_check defends and the check would otherwise raise a raw 23514.
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

  -- The claim and revocation fields are cleared alongside the address and the hash. Unreachable
  -- while the guard above admits only `sent` - and kept for exactly that reason: if a later status
  -- is ever admitted here, the row it writes is a consistent one rather than a `sent` gift that
  -- still says when it was revoked.
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

  -- The same code resend raises for the same condition: a `sent` gift always has one (configure_gift
  -- writes it in the same transaction as the gift), so a missing row means an invariant broke.
  -- Refused rather than repaired - inventing one here would hide that from the operator.
  if v_outbox_id is null then
    raise exception 'admin_reissue_gift: gift % has no outbox row', p_gift_id using errcode = 'EB030';
  end if;

  -- Due now rather than parked: the gift is 'sent' as of the statement above, which is precisely
  -- the state in which a claim link is allowed to go out.
  update public.notification_outbox o
  set payload = jsonb_build_object('claimPath', p_claim_path),
      available_at = now(),
      attempt_count = 0,
      last_error_code = null,
      lease_token = null,
      lease_expires_at = null,
      sent_at = null
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

revoke execute on function public.admin_reissue_gift(uuid, text, text, text, text) from public, anon;
grant execute on function public.admin_reissue_gift(uuid, text, text, text, text) to authenticated;

-- The operational read ---------------------------------------------------------------------------

-- Stuck gift deliveries, for the operational rules (lib/data/operations.ts, spec S5 10).
--
-- This exists because public.gifts is granted to NOBODY - not authenticated, not service_role
-- (20260924150000 line 65). That revocation is the gift security model, not an oversight: every
-- read of a gift goes through the security-barrier view or through a definer function. A
-- PostgREST select with `gifts!inner(...)` therefore fails at PLANNING time with 42501 whoever
-- asks, which is what this function replaces. Nothing is granted on the table to fix it.
--
-- It is the transport only. The predicate is the same one loadStuckGiftOutbox expressed as
-- filters, and the same one claim_notification_outbox claims by: unsent, past the attempt floor,
-- holding no live lease, and belonging to a gift still in 'sent' - a claimed or revoked gift is
-- not a delivery fault, because its row can never be claimed and so can never be cleared.
--
-- What it returns is deliberately bare: ids and timestamps. No recipient address, no message, no
-- claim_token_hash, and above all no payload - the claim path lives there, and an operational
-- finding travels into alerts and logs.
--
-- Two callers, which is why it is granted to two roles: the scheduled worker holds a service_role
-- key (POST /api/operations/run, after its own bearer-token gate), and /admin/operations evaluates
-- the same rules with the visiting admin's ordinary session client after requireAdmin(). The
-- second branch of the gate below is what keeps the admin path admin-only - a signed-in reader
-- holds no EXECUTE at all, and this refuses them a second time if that ever changes.
create function public.stuck_gift_notifications(
  p_attempt_floor integer,
  p_now timestamptz,
  p_limit integer
)
returns table (
  id uuid,
  gift_id uuid,
  order_id uuid,
  attempt_count integer,
  lease_expires_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (public.is_admin() or auth.role() = 'service_role') then
    raise exception 'stuck_gift_notifications: caller is not an admin or the operations worker'
      using errcode = '42501';
  end if;

  return query
  select o.id, g.id, g.order_id, o.attempt_count, o.lease_expires_at, o.sent_at, o.created_at
  from public.notification_outbox o
  join public.gifts g on g.id = o.gift_id
  where o.sent_at is null
    and o.gift_id is not null
    and g.status = 'sent'
    and o.attempt_count >= p_attempt_floor
    -- A lease is valid while it expires strictly after now - the same test the claim uses.
    and (o.lease_expires_at is null or o.lease_expires_at <= p_now)
  order by o.created_at, o.id
  limit greatest(1, least(coalesce(p_limit, 500), 500));
end;
$$;

revoke execute on function public.stuck_gift_notifications(integer, timestamptz, integer)
  from public, anon;
grant execute on function public.stuck_gift_notifications(integer, timestamptz, integer)
  to authenticated, service_role;

-- The mail worker's read -------------------------------------------------------------------------

-- What the gift_claim email needs about a gift, for lib/email/outbox.ts resolveGiftDelivery.
--
-- The second call site of the same revocation the function above exists for. public.gifts is
-- granted to nobody, service_role included, so the worker's plain select on the table was refused
-- 42501 on every attempt. That did not fail the run - the error became a per-row DeliveryDataError
-- - so each gift row simply burned its six attempts on the backoff and retired with
-- `delivery_data_unavailable`. A purchaser paid, the gift flipped to 'sent', and the recipient was
-- never written to. This restores the read without granting anything on the table.
--
-- Five columns, and the two that are missing are the point: NOT claim_token_hash, which is the
-- credential, and NOT notification_outbox.payload, which holds the claim path. The worker already
-- has the path it needs - it reads it from the payload of the row it claimed - and it has no
-- business being handed a second copy through here.
--
-- One caller, so one grant: the mail worker, which reaches this with a service_role key after
-- claim_notification_outbox has leased it a row. No internal gate, matching
-- claim_notification_outbox itself - the grant is the gate.
create function public.gift_delivery_details(p_gift_id uuid)
returns table (
  order_id uuid,
  purchaser_profile_id uuid,
  recipient_email text,
  message text,
  status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select g.order_id, g.purchaser_profile_id, g.recipient_email, g.message, g.status
  from public.gifts g
  where g.id = p_gift_id;
$$;

revoke execute on function public.gift_delivery_details(uuid) from public, anon, authenticated;
grant execute on function public.gift_delivery_details(uuid) to service_role;
