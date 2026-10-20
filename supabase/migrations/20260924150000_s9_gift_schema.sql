-- S9: the gift schema and the gift-capable notification outbox
-- (docs/superpowers/specs/2026-09-21-s9-bundles-and-gifts-design.md 7.1).
--
-- A gift is a property of an ORDER, not of a book, so one gift covers a single-book order and a
-- bundle order identically. This migration adds only the schema and the safe read; the lifecycle
-- (configure_gift, claim_gift, the payment and coupon branches) arrives in 20260924160000 and the
-- admin operations in 20260924170000.
--
-- DEPLOYMENT ORDERING - RESOLVED. This migration and 20260924160000 (gift lifecycle) had to land
-- together with the gift email template, because until the worker could render a gift message it
-- failed every claimed gift_claim row with `unsupported_template`, and six such failures retire a
-- row permanently (attempt_count = 6). lib/email/outbox.ts now dispatches on template_key and
-- delivers gift_claim rows for real, so that staging is gone and nothing here is left waiting on it.
-- The attempt cap still applies to genuine delivery failures, which is what it is for.
--
-- The security model this migration exists to enforce:
--
--   * The raw claim token is the authorization to claim a gift. It is never stored here. Only its
--     SHA-256 hash is, and the CHECK on claim_token_hash makes that a schema rule rather than a
--     convention - 64 lower-case hex characters is a shape no base64url token can satisfy, so a
--     writer that confused the two cannot persist the token by accident.
--   * There is exactly ONE protected operational copy of the claim path while a gift is unclaimed:
--     notification_outbox.payload. That table is readable through the Data API by admins only and
--     writable by nobody; claim_gift clears the payload once the gift is claimed. Asynchronous
--     retry and admin resend are impossible without a retrievable copy, which is why it exists.
--   * The purchaser may see their own gift, but never its hash. That is what public.gift_summaries
--     below is for: the hash is not a column of the view, so there is no policy to get wrong.
create table public.gifts (
  id uuid primary key default gen_random_uuid(),
  -- UNIQUE, which is what makes "one gift per order" a schema rule. No cascade: an order is the
  -- record of what was sold, so deleting one out from under its gift is refused.
  order_id uuid not null unique references public.orders(id),
  purchaser_profile_id uuid not null references public.profiles(id),
  -- Normalized lower-case, the same shape lib/commerce/gift-form.ts produces and
  -- customer_identities.normalized_email is matched on, so the admin's recipient search in
  -- 20260924170000 can compare the two directly.
  recipient_email text not null check (
    recipient_email = lower(btrim(recipient_email))
    and char_length(recipient_email) between 3 and 320
  ),
  message text check (message is null or char_length(message) <= 500),
  claim_token_hash text not null unique check (claim_token_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('pending', 'sent', 'claimed', 'revoked')),
  claimed_by_profile_id uuid references public.profiles(id),
  claimed_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason is null or char_length(revoked_reason) <= 500),
  created_at timestamptz not null default now(),
  -- A claimed gift is a real entitlement in the making, so it must always say who claimed it and
  -- when; a revoked one must always say when. Both fail closed for any status this schema does not
  -- yet know about, the way coupon_redemptions_redeemed_at_check does.
  constraint gifts_claimed_consistency check (
    status <> 'claimed' or (claimed_at is not null and claimed_by_profile_id is not null)
  ),
  constraint gifts_revoked_consistency check (status <> 'revoked' or revoked_at is not null)
);

-- The purchaser's own gifts, read by gift_summaries below and by the admin RPCs later.
create index gifts_purchaser_profile_id_idx on public.gifts (purchaser_profile_id);

-- RLS is enabled with no policy and no grant: nobody reaches this table through the Data API at
-- all, not a reader, not an admin, not service_role. Reads go through the view below; writes go
-- through the security-definer RPCs of the following migrations.
alter table public.gifts enable row level security;
revoke all on public.gifts from public, anon, authenticated, service_role;

-- The safe read. A view rather than a policy on the table, because the requirement is about a
-- COLUMN: the purchaser must not see claim_token_hash, and a column that is not in the view cannot
-- be selected, masked wrongly, or exposed by a later policy edit. The view runs with its owner's
-- privileges (it is not security_invoker), so it can read the ungranted table, and it does its own
-- gating in the WHERE clause - the purchaser sees their own rows, an admin sees all of them.
--
-- security_barrier is not optional here, it is the boundary. Without it the planner is free to
-- order a CALLER-supplied qual ahead of the gate below, and it will: is_admin() is a definer
-- function with a hashed subplan, so it costs more than anything a caller writes. A reader could
-- then use an error-raising predicate - `1 / case when recipient_email like 'r%' then 0 end` - as
-- an oracle and read another purchaser's recipient address, message and order id one predicate at
-- a time. The barrier forces this WHERE clause to be evaluated first, so a row the caller may not
-- see never reaches their expression at all. supabase/tests/047 probes exactly that shape.
--
-- Only SELECT is granted. A simple view is auto-updatable in Postgres, so withholding
-- INSERT/UPDATE/DELETE on the view is what keeps "nobody writes through the Data API" true.
create view public.gift_summaries with (security_barrier = true) as
select
  g.id,
  g.order_id,
  g.purchaser_profile_id,
  g.recipient_email,
  g.message,
  g.status,
  g.claimed_by_profile_id,
  g.claimed_at,
  g.revoked_at,
  g.revoked_reason,
  g.created_at
from public.gifts g
where public.is_admin()
   or g.purchaser_profile_id in (select p.id from public.profiles p where p.auth_user_id = auth.uid());

revoke all on public.gift_summaries from public, anon, authenticated, service_role;
grant select on public.gift_summaries to authenticated;

-- ------------------------------------------------------------------------------------------
-- The outbox becomes able to carry a gift as well as an entitlement (spec 7.2).
--
-- Both existing columns become nullable because a gift row has neither: the notification is
-- addressed to a recipient who may not have an account yet, and no entitlement exists until the
-- gift is claimed. The XOR check is what keeps that from degenerating into "a row about nothing" -
-- every row points at exactly one of the two, and the TypeScript worker narrows on template_key
-- knowing the database already guarantees it.
alter table public.notification_outbox
  alter column entitlement_id drop not null,
  alter column profile_id drop not null,
  add column gift_id uuid unique references public.gifts(id) on delete cascade,
  -- The one protected operational copy of the claim path. Never logged, never returned to a
  -- browser, cleared by claim_gift. The table's existing grants already make it admin-readable and
  -- writable by nobody, so this column inherits that posture unchanged.
  add column payload jsonb;

alter table public.notification_outbox
  drop constraint notification_outbox_template_key_check,
  add constraint notification_outbox_template_key_check
    check (template_key in ('book_ready', 'gift_claim')),
  add constraint notification_outbox_target_check
    check ((entitlement_id is not null)::int + (gift_id is not null)::int = 1),
  -- profile_id was NOT NULL before this migration, and dropping that would have quietly lost the
  -- guarantee the book-ready worker depends on: a book row always names the profile whose email
  -- and locale the message is rendered from. Restated as a conditional invariant - only a gift row
  -- is allowed to have no profile.
  add constraint notification_outbox_book_ready_profile_check
    check (gift_id is not null or profile_id is not null);

-- claim_notification_outbox gains gift_id and payload, so its return type changes and the function
-- has to be dropped rather than replaced. Everything else is carried over verbatim from
-- 20260916110000: the 25-row cap, the five-minute lease, `for update of o skip locked`, and the
-- ordering. The one behavioural change is the eligibility clause, which now has two branches:
-- a book row still requires an active entitlement, and a gift row requires gifts.status = 'sent'.
-- Both branches share the same property - an ineligible row stays pending without being claimed or
-- consuming an attempt, and becomes claimable again the moment it becomes eligible.
drop function public.claim_notification_outbox(integer, uuid);

create function public.claim_notification_outbox(p_limit integer, p_lease_token uuid)
returns table (
  id uuid,
  entitlement_id uuid,
  profile_id uuid,
  gift_id uuid,
  template_key text,
  payload jsonb,
  attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 25));
  v_lease_expires timestamptz := now() + interval '5 minutes';
begin
  return query
  with candidates as (
    select o.id
    from public.notification_outbox o
    left join public.entitlements e on e.id = o.entitlement_id
    left join public.gifts g on g.id = o.gift_id
    where o.sent_at is null
      and o.available_at <= now()
      and (o.lease_token is null or o.lease_expires_at <= now())
      and o.attempt_count < 6
      and (
        (o.entitlement_id is not null and e.status = 'active')
        or (o.gift_id is not null and g.status = 'sent')
      )
    order by o.available_at, o.created_at, o.id
    limit v_limit
    for update of o skip locked
  )
  update public.notification_outbox o
  set lease_token = p_lease_token,
      lease_expires_at = v_lease_expires
  from candidates
  where o.id = candidates.id
  returning o.id, o.entitlement_id, o.profile_id, o.gift_id, o.template_key, o.payload, o.attempt_count;
end;
$$;

revoke execute on function public.claim_notification_outbox(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_notification_outbox(integer, uuid) to service_role;
