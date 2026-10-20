-- S8 PR fix C1: claim_manual_transfer locks the order it is reporting against.
--
-- No new error codes. Every refusal this function can raise is the one it raised before.
--
-- The defect. apply_coupon_to_order and remove_coupon_from_order both take `for update` on the
-- order, then refuse with EB024 if a manual_transfer_claims row already exists - the guard that
-- keeps a reported transfer's amount from moving underneath the reader who reported it. That guard
-- was only half a guard, because claim_manual_transfer took no lock at all: it read the order
-- through a plain `exists` and inserted its claim. Under READ COMMITTED the two never met.
--
--   1. The coupon RPC locks the order.
--   2. It looks for a claim and finds none.
--   3. The reader presses "I have transferred" in another tab. That transaction reads the order
--      without blocking - nothing it touches is locked - and inserts the claim.
--   4. The coupon RPC rewrites orders.total_minor and payments.amount_minor.
--   5. Both transactions commit.
--
-- The reader has now reported a transfer of one amount against an order that says another, and an
-- admin reconciles a real bank line against a number nobody ever saw. That is money, so it is the
-- one interleaving here worth a lock.
--
-- The fix is a single `for update` on the order, taken before any of this function's own checks.
-- It makes the lock order the same in all three functions - order, then payment, claim or
-- redemption - which is what rules the reverse deadlock out. And because READ COMMITTED gives each
-- statement a fresh snapshot, a claim that waited on the coupon RPC's lock goes on to read the
-- order the coupon RPC left behind, not the one it was queued against.
--
-- So exactly two outcomes survive, and both are consistent:
--   - the coupon RPC commits first, and the claim is written against the new total; or
--   - the claim commits first, and the coupon RPC refuses with EB024.
--
-- The lock is taken on the caller's own order, which means an order that does not exist, or belongs
-- to someone else, locks nothing and falls through to EB020 exactly as before. Nothing about what
-- this function accepts or refuses changes; only what it is willing to do at the same time as
-- something else.
--
-- Everything else is the 20260922190000 version unchanged: the profile lookup, the EB020
-- pending-manual-order gate, the EB017 already-owned gate, the note-preserving upsert, and the
-- claimed_at it returns.
create or replace function public.claim_manual_transfer(p_order_id uuid, p_note text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_claimed_at timestamptz;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'claim_manual_transfer: no profile for the current session' using errcode = 'P0002';
  end if;

  -- Taken first, and before every check below, so this function serializes against the two coupon
  -- RPCs on the one row all three of them care about.
  perform 1
  from public.orders o
  where o.id = p_order_id and o.profile_id = v_profile_id
  for update;

  if not exists (
    select 1
    from public.orders o
    join public.payments pay on pay.order_id = o.id and pay.provider = 'manual'
    where o.id = p_order_id and o.profile_id = v_profile_id and o.status = 'pending'
  ) then
    raise exception 'claim_manual_transfer: order % is not a claimable manual order for this reader', p_order_id
      using errcode = 'EB020';
  end if;

  -- Checked after EB020, so a reader asking about an order that is not theirs still learns nothing
  -- about what they do or do not own.
  if exists (
    select 1
    from public.order_items oi
    join public.entitlements e on e.book_id = oi.book_id
    where oi.order_id = p_order_id and e.profile_id = v_profile_id and e.status = 'active'
  ) then
    raise exception 'claim_manual_transfer: the reader already owns the book on order %', p_order_id
      using errcode = 'EB017';
  end if;

  insert into public.manual_transfer_claims (order_id, profile_id, note)
  values (p_order_id, v_profile_id, nullif(btrim(coalesce(p_note, '')), ''))
  on conflict (order_id) do update set note = excluded.note;

  select c.claimed_at into v_claimed_at
  from public.manual_transfer_claims c where c.order_id = p_order_id;

  return v_claimed_at;
end;
$$;
