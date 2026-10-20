-- S9: coupons learn about bundles, and a fully discounted order grants every book it holds
-- (docs/superpowers/specs/2026-09-21-s9-bundles-and-gifts-design.md 8).
--
-- No new error codes. Every refusal these functions can make is one they could already make:
-- EB024 about the order, EB025 about an already-used coupon's value, and the uniform 'invalid'
-- rejection value about the code.
--
-- Three things change.
--
--   1. Scope. coupon_bundles (20260924110000) is the bundle counterpart of coupon_books, and spec 8
--      states the resolution as: no scope rows at all applies to everything; only coupon_books rows
--      do NOT apply to a bundle order; coupon_bundles rows apply to those bundles. The rule below
--      is that statement made symmetric - a coupon carrying ONLY coupon_bundles rows does not apply
--      to a single-book order either, for the same reason and by the same branch.
--
--      Scope is decided from orders.bundle_id and never from the order's member books. A coupon
--      scoped to one book that happens to be a member of a bundle must not discount the whole
--      bundle: the operator scoped a book, and a bundle is a different, separately priced subject.
--      That is the defect this migration exists to make impossible, and the reason the check reads
--      one column of the order rather than joining order_items.
--
--   2. The zero-total grant. A 100%-off code completes the order in the same call (S8 spec 4), and
--      until now that meant granting `select oi.book_id ... limit 1` - one arbitrary book of the
--      several a bundle order holds. It now grants every book of the order, using the same
--      set-based loop and the same resolve-by-subject fallback apply_payment_event took in
--      20260924100000, and reports the result through the same order_active_entitlement_ids helper
--      so that "what does this buyer now hold for this order" has exactly one answer in this
--      database. The redemption still flips ONCE per order: a coupon is applied to an order, not to
--      a line.
--
--   3. The return type. entitlement_id uuid becomes entitlement_ids uuid[], which a `returns table`
--      column cannot be renamed or retyped into, so the function is dropped and recreated. Empty -
--      never null - on every path that granted nothing, exactly as those paths returned a null id
--      before.
--
-- Everything else in apply_coupon_to_order is carried over verbatim from the 20260923160000
-- version, which is the one in force: the per-profile advisory lock, the profile-then-order-then-
-- coupon lock order, the EB024 order refusals, the reported-transfer guard, the attempt quota and
-- its record_coupon_failure calls, the uniform rejection value, the discriminating `raise log`, the
-- floored-then-clamped arithmetic, the reservation, and the coupon.applied audit row. Re-emitting a
-- whole body is how this repository changes a function; applied migrations are never edited.
--
-- remove_coupon_from_order is untouched: it returns money and nothing else, and releasing a
-- reservation is the same operation however many books the order holds.

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
  -- Empty, not null, on every path that grants nothing - which is every path but the zero-total
  -- one. `null::uuid` was what the single-book version returned there; an empty array is what the
  -- caller can iterate without a null check.
  v_entitlement_ids uuid[] := array[]::uuid[];
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'apply_coupon_to_order: no profile for the current session' using errcode = 'P0002';
  end if;

  -- Serialize this reader's coupon applications, so the attempt quota below is read and consumed as
  -- one step rather than by a whole burst at once. Held to commit, and taken ahead of every row lock
  -- in this function.
  perform pg_advisory_xact_lock(hashtextextended('apply_coupon_to_order:' || v_profile_id::text, 0));

  -- The order next, so two applications on one order serialize, and so the coupon row lock below is
  -- always taken after it. One lock order everywhere - profile, order, coupon - is what keeps this
  -- function, claim_manual_transfer and create_ebook_order from deadlocking against each other.
  select o.id, o.profile_id, o.status, o.currency, o.subtotal_minor, o.coupon_id, o.bundle_id
  into v_order
  from public.orders o
  where o.id = p_order_id and o.profile_id = v_profile_id
  for update;

  -- Another reader's order is indistinguishable from a missing one.
  if v_order.id is null or v_order.status <> 'pending' or v_order.coupon_id is not null then
    raise exception 'apply_coupon_to_order: order % is not an uncouponed pending order of the caller', p_order_id
      using errcode = 'EB024';
  end if;

  -- A reader who has already told us they transferred has sent a specific amount with a specific
  -- reference; moving the total underneath that report would leave the admin reconciling a payment
  -- against a number nobody ever saw. The code can still be applied before the transfer, which is
  -- when a reader would actually use one.
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

  -- Normalization mirrors lib/commerce/coupon.ts normalizeCouponCode exactly.
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

  -- Scope (spec 8). A coupon with neither kind of scope row applies to everything, which is the S8
  -- rule for coupon_books widened to cover both tables: an operator who scoped nothing scoped
  -- nothing. Once a coupon carries ANY scope row it must name the subject of this order, and which
  -- table is consulted is decided by orders.bundle_id alone:
  --
  --   a bundle order  -> only a coupon_bundles row for THAT bundle
  --   a book order    -> only a coupon_books row for that book
  --
  -- so a book-scoped coupon refuses a bundle order (spec 8, stated), and a bundle-scoped coupon
  -- refuses a single-book order (the same rule from the other side). Neither is ever inferred from
  -- the other: a bundle's member books are not the bundle.
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
      -- A non-bundle order holds exactly one book (create_ebook_order and acquire_free_ebook are
      -- the only writers of one), read by its line position so the choice is not an arbitrary row.
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

  -- Both limits are counted under the coupon row lock taken above, which is what makes "the last
  -- remaining use goes to exactly one of two concurrent readers" true: the second session blocks on
  -- the lock until the first has inserted its reservation, then counts it.
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

  -- The same arithmetic as lib/commerce/coupon.ts computeDiscountMinor: floored, then clamped.
  -- Integer division in Postgres truncates toward zero, which on non-negative operands is floor.
  -- A bundle price is discounted as one number, never per member book (spec 5).
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

  -- Every code that changed an order total is audited (S8 spec 2). actor_profile_id is the reader
  -- here, not an admin: they are the actor. One row per order, whatever the order holds.
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
  -- reader was looking at when the code landed. Nothing reads a cancelled row's amount -
  -- apply_payment_event resolves by (order_id, provider) among pending rows - so the number is
  -- history, not an input.
  update public.payments pay set status = 'cancelled' where pay.order_id = p_order_id and pay.status = 'pending';
  update public.orders o set status = 'completed', payment_status = 'not_required' where o.id = p_order_id;

  -- One entitlement and one library item per book of the order - the same loop apply_payment_event
  -- runs (20260924100000). `distinct` because the grant is per subject and not per line, and the
  -- resolve-by-subject fallback keeps a book the reader already holds a no-op rather than a second
  -- grant or a constraint violation.
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

  -- ONE flip for the order. A coupon is reserved against the order, and coupon_redemptions.order_id
  -- is unique, so this is one row however many books the order held.
  update public.coupon_redemptions r
  set status = 'redeemed', redeemed_at = now()
  where r.order_id = p_order_id;

  -- Reported through the same helper apply_payment_event and confirm_manual_payment report it
  -- through, so "what does this buyer hold for this order" has one answer rather than three.
  v_entitlement_ids := public.order_active_entitlement_ids(p_order_id, v_profile_id);

  return query select v_order.subtotal_minor, v_discount, 0::bigint, 'completed'::public.order_status,
                      v_entitlement_ids, null::text;
end;
$$;

revoke execute on function public.apply_coupon_to_order(uuid, text) from public, anon;
grant execute on function public.apply_coupon_to_order(uuid, text) to authenticated;

-- ============================================================================================
-- The admin coupon surface carries bundle scope alongside book scope.
--
-- The two readers gain a bundle_ids column, which a `returns table` cannot grow by replacement, so
-- both are dropped and recreated. The two writers gain a p_bundle_ids argument, which makes a NEW
-- signature rather than replacing the old one - so the eleven-argument versions are dropped
-- explicitly. Left in place they would linger as overloads, and PostgREST resolves an RPC by the
-- argument names a request carries: an editor that stopped sending p_bundle_ids would silently keep
-- hitting the old function and silently keep dropping every bundle scope an operator set.
--
-- Bundle scope is never inferred from a bundle's member books, in either direction. The editor
-- sends two arrays and this surface stores two sets.
-- ============================================================================================

drop function public.admin_list_coupons();
drop function public.admin_get_coupon(uuid);

create function public.admin_list_coupons()
returns table (
  id uuid, code text, kind text, percent_off int, amount_off_minor bigint, currency text,
  starts_at timestamptz, ends_at timestamptz, active boolean, max_redemptions int,
  max_redemptions_per_profile int, note text, created_at timestamptz,
  reserved_count bigint, redeemed_count bigint, book_ids uuid[], bundle_ids uuid[]
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_list_coupons: caller is not an admin' using errcode = '42501';
  end if;

  return query
  select c.id, c.code, c.kind, c.percent_off, c.amount_off_minor, c.currency,
         c.starts_at, c.ends_at, c.active, c.max_redemptions,
         c.max_redemptions_per_profile, c.note, c.created_at,
         coalesce(count(r.id) filter (where r.status = 'reserved'), 0),
         coalesce(count(r.id) filter (where r.status = 'redeemed'), 0),
         coalesce((select array_agg(cb.book_id order by cb.book_id) from public.coupon_books cb where cb.coupon_id = c.id), '{}'::uuid[]),
         coalesce((select array_agg(cbu.bundle_id order by cbu.bundle_id) from public.coupon_bundles cbu where cbu.coupon_id = c.id), '{}'::uuid[])
  from public.coupons c
  left join public.coupon_redemptions r on r.coupon_id = c.id
  group by c.id
  order by c.created_at desc
  limit 200;
end;
$$;

-- Still its own aggregate query rather than a filter over admin_list_coupons, for the reason
-- 20260923140000 records: that function carries `limit 200` ordered by created_at, so the
-- 201st-newest coupon would be invisible to it and the editor would 404 on a coupon that exists.
create function public.admin_get_coupon(p_id uuid)
returns table (
  id uuid, code text, kind text, percent_off int, amount_off_minor bigint, currency text,
  starts_at timestamptz, ends_at timestamptz, active boolean, max_redemptions int,
  max_redemptions_per_profile int, note text, created_at timestamptz,
  reserved_count bigint, redeemed_count bigint, book_ids uuid[], bundle_ids uuid[]
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_get_coupon: caller is not an admin' using errcode = '42501';
  end if;

  return query
  select c.id, c.code, c.kind, c.percent_off, c.amount_off_minor, c.currency,
         c.starts_at, c.ends_at, c.active, c.max_redemptions,
         c.max_redemptions_per_profile, c.note, c.created_at,
         coalesce(count(r.id) filter (where r.status = 'reserved'), 0),
         coalesce(count(r.id) filter (where r.status = 'redeemed'), 0),
         coalesce((select array_agg(cb.book_id order by cb.book_id) from public.coupon_books cb where cb.coupon_id = c.id), '{}'::uuid[]),
         coalesce((select array_agg(cbu.bundle_id order by cbu.bundle_id) from public.coupon_bundles cbu where cbu.coupon_id = c.id), '{}'::uuid[])
  from public.coupons c
  left join public.coupon_redemptions r on r.coupon_id = c.id
  where c.id = p_id
  group by c.id;
end;
$$;

drop function public.admin_create_coupon(text, text, int, bigint, text, timestamptz, timestamptz, int, int, text, uuid[]);

create function public.admin_create_coupon(
  p_code text,
  p_kind text,
  p_percent_off int,
  p_amount_off_minor bigint,
  p_currency text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_max_redemptions int,
  p_max_redemptions_per_profile int,
  p_note text,
  p_book_ids uuid[],
  p_bundle_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_id uuid;
  v_code text;
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_create_coupon: caller is not an admin' using errcode = '42501';
  end if;
  select pr.id into v_admin_id from public.profiles pr where pr.auth_user_id = auth.uid();

  -- The same normalization apply_coupon_to_order applies to what a reader types, so an operator
  -- who pastes " tester-100 " creates the code a reader entering "TESTER-100" will find.
  v_code := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
  if v_code !~ '^[A-Z0-9][A-Z0-9-]{1,30}[A-Z0-9]$' then
    raise exception 'admin_create_coupon: % is not a usable code', p_code using errcode = '22023';
  end if;

  -- coupons_kind_consistency enforces the rest; this raise only turns a constraint violation into
  -- a message the editor can show against the right field.
  if p_kind not in ('percent', 'fixed') then
    raise exception 'admin_create_coupon: unknown kind %', p_kind using errcode = '22023';
  end if;

  insert into public.coupons (code, kind, percent_off, amount_off_minor, currency, starts_at, ends_at,
                              max_redemptions, max_redemptions_per_profile, note, created_by)
  values (v_code, p_kind,
          case p_kind when 'percent' then p_percent_off else null end,
          case p_kind when 'fixed' then p_amount_off_minor else null end,
          case p_kind when 'fixed' then upper(p_currency) else null end,
          p_starts_at, p_ends_at, p_max_redemptions,
          coalesce(p_max_redemptions_per_profile, 1), nullif(btrim(coalesce(p_note, '')), ''), v_admin_id)
  returning id into v_id;

  insert into public.coupon_books (coupon_id, book_id)
  select v_id, b from unnest(coalesce(p_book_ids, '{}'::uuid[])) as b
  on conflict do nothing;

  insert into public.coupon_bundles (coupon_id, bundle_id)
  select v_id, b from unnest(coalesce(p_bundle_ids, '{}'::uuid[])) as b
  on conflict do nothing;

  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, reason, metadata)
  values (v_admin_id, 'coupon.created', 'coupons', v_id, null,
          jsonb_build_object('code', v_code, 'kind', p_kind, 'percent_off', p_percent_off,
                             'amount_off_minor', p_amount_off_minor, 'currency', p_currency,
                             'starts_at', p_starts_at, 'ends_at', p_ends_at,
                             'max_redemptions', p_max_redemptions,
                             'max_redemptions_per_profile', coalesce(p_max_redemptions_per_profile, 1),
                             'active', true,
                             'book_ids', coalesce(p_book_ids, '{}'::uuid[]),
                             'bundle_ids', coalesce(p_bundle_ids, '{}'::uuid[])));

  return v_id;
end;
$$;

drop function public.admin_update_coupon(uuid, text, int, bigint, text, timestamptz, timestamptz, boolean, int, int, text, uuid[]);

-- The code itself is never editable: a reader may already be holding it on a slip of paper, and a
-- renamed code is a different promotion. Kind and value become read-only once the coupon has been
-- reserved or redeemed even once (S8 spec 7.2) - changing the value of a code readers have already
-- committed to would change an order snapshot after the fact. Window, activity, limits, note, and
-- BOTH scopes stay editable throughout, which is what "deactivate", "shorten the window" and "this
-- promotion covers the bundle too" need. EB025 guards the value, never the scope: retargeting a
-- coupon changes what a FUTURE order may use it on and rewrites no snapshot.
create function public.admin_update_coupon(
  p_id uuid,
  p_kind text,
  p_percent_off int,
  p_amount_off_minor bigint,
  p_currency text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_active boolean,
  p_max_redemptions int,
  p_max_redemptions_per_profile int,
  p_note text,
  p_book_ids uuid[],
  p_bundle_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_id uuid;
  v_coupon record;
  v_locked boolean;
  v_changes_value boolean;
begin
  if not public.is_admin() then
    raise exception 'admin_update_coupon: caller is not an admin' using errcode = '42501';
  end if;
  select pr.id into v_admin_id from public.profiles pr where pr.auth_user_id = auth.uid();

  select c.* into v_coupon from public.coupons c where c.id = p_id for update;
  if v_coupon.id is null then
    raise exception 'admin_update_coupon: coupon % does not exist', p_id using errcode = 'P0002';
  end if;

  select exists (select 1 from public.coupon_redemptions r where r.coupon_id = p_id) into v_locked;
  v_changes_value :=
    p_kind is distinct from v_coupon.kind
    or (p_kind = 'percent' and p_percent_off is distinct from v_coupon.percent_off)
    or (p_kind = 'fixed' and (p_amount_off_minor is distinct from v_coupon.amount_off_minor
                              or upper(coalesce(p_currency, '')) is distinct from v_coupon.currency));

  if v_locked and v_changes_value then
    raise exception 'admin_update_coupon: coupon % is already reserved or redeemed', p_id using errcode = 'EB025';
  end if;

  update public.coupons c
  set kind = p_kind,
      percent_off = case p_kind when 'percent' then p_percent_off else null end,
      amount_off_minor = case p_kind when 'fixed' then p_amount_off_minor else null end,
      currency = case p_kind when 'fixed' then upper(p_currency) else null end,
      starts_at = p_starts_at,
      ends_at = p_ends_at,
      active = coalesce(p_active, true),
      max_redemptions = p_max_redemptions,
      max_redemptions_per_profile = coalesce(p_max_redemptions_per_profile, 1),
      note = nullif(btrim(coalesce(p_note, '')), '')
  where c.id = p_id;

  delete from public.coupon_books cb
  where cb.coupon_id = p_id and cb.book_id <> all (coalesce(p_book_ids, '{}'::uuid[]));
  insert into public.coupon_books (coupon_id, book_id)
  select p_id, b from unnest(coalesce(p_book_ids, '{}'::uuid[])) as b
  on conflict do nothing;

  delete from public.coupon_bundles cbu
  where cbu.coupon_id = p_id and cbu.bundle_id <> all (coalesce(p_bundle_ids, '{}'::uuid[]));
  insert into public.coupon_bundles (coupon_id, bundle_id)
  select p_id, b from unnest(coalesce(p_bundle_ids, '{}'::uuid[])) as b
  on conflict do nothing;

  -- The value fields EB025 guards are logged from/to, using the pre-update row already held in
  -- v_coupon: an operator reading this a year later can see what a coupon's value was changed
  -- from and to, not merely that an update happened - the same reason coupon.applied logs
  -- discount_minor rather than just that a code was applied.
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, reason, metadata)
  values (v_admin_id, 'coupon.updated', 'coupons', p_id, null,
          jsonb_build_object(
            'kind_from', v_coupon.kind, 'kind_to', p_kind,
            'percent_off_from', v_coupon.percent_off,
            'percent_off_to', case p_kind when 'percent' then p_percent_off else null end,
            'amount_off_minor_from', v_coupon.amount_off_minor,
            'amount_off_minor_to', case p_kind when 'fixed' then p_amount_off_minor else null end,
            'currency_from', v_coupon.currency,
            'currency_to', case p_kind when 'fixed' then upper(p_currency) else null end,
            'active', coalesce(p_active, true), 'starts_at', p_starts_at, 'ends_at', p_ends_at,
            'max_redemptions', p_max_redemptions,
            'max_redemptions_per_profile', coalesce(p_max_redemptions_per_profile, 1),
            'note', nullif(btrim(coalesce(p_note, '')), ''),
            'book_ids', coalesce(p_book_ids, '{}'::uuid[]),
            'bundle_ids', coalesce(p_bundle_ids, '{}'::uuid[])));
end;
$$;

revoke execute on function public.admin_list_coupons() from public, anon;
grant execute on function public.admin_list_coupons() to authenticated;
revoke execute on function public.admin_get_coupon(uuid) from public, anon;
grant execute on function public.admin_get_coupon(uuid) to authenticated;
revoke execute on function public.admin_create_coupon(text, text, int, bigint, text, timestamptz, timestamptz, int, int, text, uuid[], uuid[]) from public, anon;
grant execute on function public.admin_create_coupon(text, text, int, bigint, text, timestamptz, timestamptz, int, int, text, uuid[], uuid[]) to authenticated;
revoke execute on function public.admin_update_coupon(uuid, text, int, bigint, text, timestamptz, timestamptz, boolean, int, int, text, uuid[], uuid[]) from public, anon;
grant execute on function public.admin_update_coupon(uuid, text, int, bigint, text, timestamptz, timestamptz, boolean, int, int, text, uuid[], uuid[]) to authenticated;
