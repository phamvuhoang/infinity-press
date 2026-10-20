-- S8: the operator's coupon surface (spec 7.2).
--
-- New error code, continuing the EB0xx series (EB024 is taken by 20260923120000):
--   EB025 - admin_update_coupon: the kind or value of a coupon that already has a reservation or a
--           redemption cannot change.
--
-- Why these are RPCs and not table policies. coupons has no select policy at all and no grants:
-- that is what makes a code impossible to enumerate through PostgREST, by a reader and by an admin
-- alike. The admin screens read through these definer functions instead, which return exactly the
-- columns those screens render.

create function public.admin_list_coupons()
returns table (
  id uuid, code text, kind text, percent_off int, amount_off_minor bigint, currency text,
  starts_at timestamptz, ends_at timestamptz, active boolean, max_redemptions int,
  max_redemptions_per_profile int, note text, created_at timestamptz,
  reserved_count bigint, redeemed_count bigint, book_ids uuid[]
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
         coalesce((select array_agg(cb.book_id order by cb.book_id) from public.coupon_books cb where cb.coupon_id = c.id), '{}'::uuid[])
  from public.coupons c
  left join public.coupon_redemptions r on r.coupon_id = c.id
  group by c.id
  order by c.created_at desc
  limit 200;
end;
$$;

-- admin_get_coupon repeats admin_list_coupons's aggregate query with a `where c.id = p_id` instead
-- of filtering that function's own result (controller ruling: the brief's `select * from
-- admin_list_coupons() where id = p_id` was wrong, because admin_list_coupons carries `limit 200`
-- and orders by created_at desc - the 201st-newest coupon would be invisible to it, and the editor
-- would 404 on a coupon that still exists). The duplication is deliberate: the alternative is an
-- editor that silently cannot open an old coupon.
create function public.admin_get_coupon(p_id uuid)
returns table (
  id uuid, code text, kind text, percent_off int, amount_off_minor bigint, currency text,
  starts_at timestamptz, ends_at timestamptz, active boolean, max_redemptions int,
  max_redemptions_per_profile int, note text, created_at timestamptz,
  reserved_count bigint, redeemed_count bigint, book_ids uuid[]
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
         coalesce((select array_agg(cb.book_id order by cb.book_id) from public.coupon_books cb where cb.coupon_id = c.id), '{}'::uuid[])
  from public.coupons c
  left join public.coupon_redemptions r on r.coupon_id = c.id
  where c.id = p_id
  group by c.id;
end;
$$;

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
  p_book_ids uuid[]
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

  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, reason, metadata)
  values (v_admin_id, 'coupon.created', 'coupons', v_id, null,
          jsonb_build_object('code', v_code, 'kind', p_kind, 'percent_off', p_percent_off,
                             'amount_off_minor', p_amount_off_minor, 'currency', p_currency,
                             'starts_at', p_starts_at, 'ends_at', p_ends_at,
                             'max_redemptions', p_max_redemptions,
                             'max_redemptions_per_profile', coalesce(p_max_redemptions_per_profile, 1),
                             'active', true,
                             'book_ids', coalesce(p_book_ids, '{}'::uuid[])));

  return v_id;
end;
$$;

-- The code itself is never editable: a reader may already be holding it on a slip of paper, and a
-- renamed code is a different promotion. Kind and value become read-only once the coupon has been
-- reserved or redeemed even once (spec 7.2) - changing the value of a code readers have already
-- committed to would change an order snapshot after the fact. Window, activity, limits, note, and
-- book scope stay editable throughout, which is what "deactivate" and "shorten the window" need.
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
  p_book_ids uuid[]
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

  -- The value fields EB025 guards are logged from/to, using the pre-update row already held in
  -- v_coupon: an operator reading this a year later can see what a coupon's value was changed
  -- from and to, not merely that an update happened - the same reason coupon.applied
  -- (20260923120000) logs discount_minor rather than just that a code was applied.
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
            'book_ids', coalesce(p_book_ids, '{}'::uuid[])));
end;
$$;

revoke execute on function public.admin_list_coupons() from public, anon;
grant execute on function public.admin_list_coupons() to authenticated;
revoke execute on function public.admin_get_coupon(uuid) from public, anon;
grant execute on function public.admin_get_coupon(uuid) to authenticated;
revoke execute on function public.admin_create_coupon(text, text, int, bigint, text, timestamptz, timestamptz, int, int, text, uuid[]) from public, anon;
grant execute on function public.admin_create_coupon(text, text, int, bigint, text, timestamptz, timestamptz, int, int, text, uuid[]) to authenticated;
revoke execute on function public.admin_update_coupon(uuid, text, int, bigint, text, timestamptz, timestamptz, boolean, int, int, text, uuid[]) from public, anon;
grant execute on function public.admin_update_coupon(uuid, text, int, bigint, text, timestamptz, timestamptz, boolean, int, int, text, uuid[]) to authenticated;
