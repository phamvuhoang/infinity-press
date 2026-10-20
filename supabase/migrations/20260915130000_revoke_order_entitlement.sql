-- S3: revoke the access one order granted (docs/superpowers/specs/2026-09-15-s3-get-and-buy-design.md 4.4).
-- It only finds the entitlement whose source_order_id is this order. An admin_grant never has a
-- source_order_id, so no grant can be revoked here, and another order's entitlement is never touched.
-- The order row is history and does not change.
create function public.revoke_order_entitlement(p_order_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
  v_entitlement_id uuid;
  v_profile_id uuid;
  v_book_id uuid;
  v_status public.entitlement_status;
begin
  if not public.is_admin() then
    raise exception 'revoke_order_entitlement: caller is not an admin' using errcode = '42501';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'revoke_order_entitlement: a reason is required' using errcode = '22023';
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  if v_actor_profile_id is null then
    raise exception 'revoke_order_entitlement: admin caller has no profile' using errcode = 'P0002';
  end if;

  select e.id, e.profile_id, e.book_id, e.status
  into v_entitlement_id, v_profile_id, v_book_id, v_status
  from public.entitlements e
  where e.source_order_id = p_order_id
    and e.source_type in ('free_order', 'simulated_payment')
  order by (e.status = 'active') desc, e.granted_at desc
  limit 1
  for update;

  if v_entitlement_id is null then
    raise exception 'revoke_order_entitlement: order % granted no entitlement', p_order_id using errcode = 'P0002';
  end if;

  if v_status = 'active' then
    update public.entitlements set status = 'revoked', revoked_at = now() where id = v_entitlement_id;

    delete from public.library_items where entitlement_id = v_entitlement_id;

    insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, reason, metadata)
    values (
      v_actor_profile_id,
      'revoke_order_entitlement',
      'entitlements',
      v_entitlement_id,
      p_reason,
      jsonb_build_object('order_id', p_order_id, 'profile_id', v_profile_id, 'book_id', v_book_id)
    );
  end if;

  return v_entitlement_id;
end;
$$;

revoke execute on function public.revoke_order_entitlement(uuid, text) from public, anon;
grant execute on function public.revoke_order_entitlement(uuid, text) to authenticated;
