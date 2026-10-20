-- S7: the reader's "I have transferred" report (spec 5.5).
--
-- New error code:
--   EB020 - claim_manual_transfer: the order is not the caller's own pending manual order.

create table public.manual_transfer_claims (
  order_id uuid primary key references public.orders(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  claimed_at timestamptz not null default now(),
  note text check (note is null or char_length(note) <= 500)
);

create index manual_transfer_claims_claimed_at_idx on public.manual_transfer_claims (claimed_at);

alter table public.manual_transfer_claims enable row level security;

-- Select only. claim_manual_transfer and reject_manual_payment are the only writers, and both run
-- as the table owner through security definer.
revoke all on public.manual_transfer_claims from public, anon, authenticated, service_role;
grant select on public.manual_transfer_claims to authenticated, service_role;

create policy manual_transfer_claims_owner_select on public.manual_transfer_claims
  for select to authenticated
  using (profile_id in (select p.id from public.profiles p where p.auth_user_id = auth.uid()));

create policy manual_transfer_claims_admin_select on public.manual_transfer_claims
  for select to authenticated
  using (public.is_admin());

-- Reporting a transfer is idempotent: a reader who clicks twice, or reloads the confirmation, must
-- not create a second claim or raise. The primary key does the work; on conflict makes it silent.
create function public.claim_manual_transfer(p_order_id uuid, p_note text)
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
  on conflict (order_id) do nothing;

  select c.claimed_at into v_claimed_at
  from public.manual_transfer_claims c where c.order_id = p_order_id;

  return v_claimed_at;
end;
$$;

revoke execute on function public.claim_manual_transfer(uuid, text) from public, anon;
grant execute on function public.claim_manual_transfer(uuid, text) to authenticated;
