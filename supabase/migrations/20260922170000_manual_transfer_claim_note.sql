-- S7 whole-branch fix I1: a repeat transfer report keeps the reader's new note.
--
-- 20260922120000_manual_transfer_claims.sql made a repeat report a no-op with
-- `on conflict (order_id) do nothing`, which is right about the claim and wrong about the note. A
-- reader reporting a second time - after a decline, or because something about the transfer needs
-- explaining - writes that explanation in the note, and it was silently discarded: the admin read
-- the first report's note, or none, and nothing anywhere recorded that the reader had said more.
--
-- claimed_at deliberately does not move. It is what orders the review queue (claims_claimed_at_idx,
-- oldest report first), so letting a re-report push an order to the back of the queue would punish
-- the reader for telling us more. The latest note, the first report's place in the queue.
--
-- Everything else in this function is the 20260922120000 version unchanged: the profile lookup,
-- the EB020 ownership and pending-manual-order gate, and the claimed_at it returns.
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

  insert into public.manual_transfer_claims (order_id, profile_id, note)
  values (p_order_id, v_profile_id, nullif(btrim(coalesce(p_note, '')), ''))
  on conflict (order_id) do update set note = excluded.note;

  select c.claimed_at into v_claimed_at
  from public.manual_transfer_claims c where c.order_id = p_order_id;

  return v_claimed_at;
end;
$$;
