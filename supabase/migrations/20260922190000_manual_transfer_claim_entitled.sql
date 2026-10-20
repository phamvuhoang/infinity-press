-- S7 PR fix C2: a reader who already owns the book is never asked to transfer money for it.
--
-- New error code, continuing the EB0xx series (EB016 is taken by 20260922180000):
--   EB017 - claim_manual_transfer: the reader already holds an active entitlement for this book.
--
-- The order's own gate has always been ownership, provider and status - all properties of the
-- order. Ownership of the BOOK is not, and it can change without the order changing at all: an
-- admin grant, a free offer, or a second order for the same book grants an entitlement and leaves
-- this order exactly as it was, pending and manual. The transfer page then still showed the bank
-- account, the reader still reported a transfer, and an admin could still confirm it - at which
-- point apply_payment_event's `on conflict ... do nothing` resolved the entitlement they already
-- had, and the reader had paid a second time for access they held.
--
-- The application refuses this on the transfer page and in the claim action; this is the layer a
-- direct PostgREST call reaches, which is why the check lives here as well and not only there.
--
-- What this deliberately does NOT do is cancel the order (ruling R33). The reader may already have
-- transferred against it, and a cancelled order is a worse place for that money to land than a
-- pending one: there would be no record of their intent and nothing for an admin to confirm
-- against. Cancellation stays an admin act, as it is everywhere else here, and /admin/payments
-- still lists the order until one is made.
--
-- `status = 'active'` and not merely the existence of a row: a revoked entitlement is not
-- ownership, and a reader whose access was revoked must be able to buy the book again.
--
-- Everything else in this function is the 20260922170000 version unchanged: the profile lookup,
-- the EB020 ownership and pending-manual-order gate, the note-preserving upsert, and the
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
