begin;
select plan(70);

-- Stand-in for the removed work-level free claim (see create_ebook_order above).
create function public.acquire_free_ebook(p_book_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $f$
declare v_editions uuid[];
begin
  select coalesce(array_agg(distinct e.id), '{}'::uuid[]) into v_editions
  from public.editions e join public.skus s on s.edition_id = e.id and s.active
  join public.offers o on o.sku_id = s.id and o.active and o.price_minor = 0
    and (o.starts_at is null or o.starts_at <= now()) and (o.ends_at is null or o.ends_at > now())
  where e.book_id = p_book_id;
  if cardinality(v_editions) = 0 then
    raise exception 'acquire_free_ebook: no active free offer for book %', p_book_id using errcode = 'EB006';
  end if;
  if cardinality(v_editions) > 1 then
    raise exception 'acquire_free_ebook: book % has several free editions; name one', p_book_id using errcode = 'EB006';
  end if;
  return public.acquire_free_edition(v_editions[1]);
end $f$;
revoke all on function public.acquire_free_ebook(uuid) from public, anon;
grant execute on function public.acquire_free_ebook(uuid) to authenticated;

-- Task 7: acquire_free_ebook, grant_complimentary_entitlement, and apply_payment_event.
-- Numbered 008, not the brief's 007 - that collides with Task 6's 007_publication_transitions.sql.

-- ============================================================================================
-- Fixtures
-- ============================================================================================

-- Auth users: one admin, one verified customer (free-acquisition happy path + reuse for the
-- "customer calling the admin RPC" negative case), one unverified customer (EB005), and nine
-- more "target" customers for the complimentary-grant, cross-source, and payment-event scenarios
-- below - kept separate from each other so each scenario's row counts can be asserted without
-- cross-talk.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '98000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'entitlements-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '98000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'entitlements-customer1@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '98000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'entitlements-customer2-unverified@example.test', '', null, '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '98000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'entitlements-target-comp@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '98000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', 'entitlements-target-success@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '98000000-0000-0000-0000-000000000006', 'authenticated', 'authenticated', 'entitlements-target-outoforder@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '98000000-0000-0000-0000-000000000007', 'authenticated', 'authenticated', 'entitlements-target-failed@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '98000000-0000-0000-0000-000000000008', 'authenticated', 'authenticated', 'entitlements-target-mismatch@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '98000000-0000-0000-0000-000000000009', 'authenticated', 'authenticated', 'entitlements-cross-acquire@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '98000000-0000-0000-0000-000000000010', 'authenticated', 'authenticated', 'entitlements-active-revoked@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '98000000-0000-0000-0000-000000000011', 'authenticated', 'authenticated', 'entitlements-cross-payment@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '98000000-0000-0000-0000-000000000012', 'authenticated', 'authenticated', 'entitlements-reactivate-unverified@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = '98000000-0000-0000-0000-000000000001';

-- Resolved once, up front, as the unrestricted connecting role: "owner reads own profile" RLS
-- means a subquery against public.profiles evaluated later, once a call site has already
-- switched `role authenticated` to a *different* user (e.g. the admin resolving a target
-- reader's profile id as an argument to grant_complimentary_entitlement below), would silently
-- read back no row at all rather than fail loud - it is not evaluated inside the security
-- definer function, only as part of building that call's arguments. This temp table carries no
-- RLS of its own, so every scenario below can read it regardless of which role it later assumes.
create temporary table t_profile_ids as
select
  (select id from public.profiles where auth_user_id = '98000000-0000-0000-0000-000000000001') as admin_id,
  (select id from public.profiles where auth_user_id = '98000000-0000-0000-0000-000000000003') as unverified_id,
  (select id from public.profiles where auth_user_id = '98000000-0000-0000-0000-000000000004') as target_comp_id,
  (select id from public.profiles where auth_user_id = '98000000-0000-0000-0000-000000000009') as cross_acquire_id,
  (select id from public.profiles where auth_user_id = '98000000-0000-0000-0000-000000000010') as active_revoked_id,
  (select id from public.profiles where auth_user_id = '98000000-0000-0000-0000-000000000011') as cross_payment_id,
  (select id from public.profiles where auth_user_id = '98000000-0000-0000-0000-000000000012') as reactivate_unverified_id;
grant select on t_profile_ids to public;

-- Books: one author, and one book per scenario. book_free carries an active free offer;
-- book_no_offer carries only a paid offer (EB006); book_comp needs no offer at all
-- (grant_complimentary_entitlement never touches offers/skus); book_paid carries the paid offer
-- apply_payment_event's fixture orders reference.
insert into public.authors (id, canonical_slug, display_name) values
  ('99000000-0000-0000-0000-000000000001', 'entitlements-author', 'Entitlements Author');

insert into public.books (id, canonical_key, original_language, primary_author_id) values
  ('99000000-0000-0000-0000-000000000010', 'entitlements-book-free', 'en', '99000000-0000-0000-0000-000000000001'),
  ('99000000-0000-0000-0000-000000000011', 'entitlements-book-no-offer', 'en', '99000000-0000-0000-0000-000000000001'),
  ('99000000-0000-0000-0000-000000000012', 'entitlements-book-comp', 'en', '99000000-0000-0000-0000-000000000001'),
  ('99000000-0000-0000-0000-000000000013', 'entitlements-book-paid', 'en', '99000000-0000-0000-0000-000000000001');

insert into public.book_localizations (book_id, locale, slug, title) values
  ('99000000-0000-0000-0000-000000000010', 'en', 'entitlements-book-free', 'Free Book'),
  ('99000000-0000-0000-0000-000000000013', 'en', 'entitlements-book-paid', 'Paid Book');

insert into public.editions (id, book_id, language_code) values
  ('99000000-0000-0000-0000-000000000020', '99000000-0000-0000-0000-000000000010', 'en'),
  ('99000000-0000-0000-0000-000000000021', '99000000-0000-0000-0000-000000000011', 'en'),
  ('99000000-0000-0000-0000-000000000022', '99000000-0000-0000-0000-000000000012', 'en'),
  ('99000000-0000-0000-0000-000000000023', '99000000-0000-0000-0000-000000000013', 'en');

-- A free claim needs a sellable edition: published work, published edition, live publication.
update public.books set status = 'published' where id = '99000000-0000-0000-0000-000000000010';
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
values ('99000000-0000-0000-0000-000000000040', '99000000-0000-0000-0000-000000000020', 'ent/free.epub', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status, epub_language)
values ('99000000-0000-0000-0000-000000000041', '99000000-0000-0000-0000-000000000040', 1, 'ent/free.json', 'published', 'en');
update public.editions set status = 'published', active_publication_id = '99000000-0000-0000-0000-000000000041'
where id = '99000000-0000-0000-0000-000000000020';

insert into public.skus (id, edition_id, sku_code) values
  ('99000000-0000-0000-0000-000000000030', '99000000-0000-0000-0000-000000000020', 'entitlements-book-free-ebook'),
  ('99000000-0000-0000-0000-000000000031', '99000000-0000-0000-0000-000000000021', 'entitlements-book-no-offer-ebook'),
  ('99000000-0000-0000-0000-000000000033', '99000000-0000-0000-0000-000000000023', 'entitlements-book-paid-ebook');

insert into public.offers (sku_id, market_code, currency, price_minor, active) values
  ('99000000-0000-0000-0000-000000000030', 'VN', 'VND', 0, true),
  ('99000000-0000-0000-0000-000000000031', 'VN', 'VND', 100000, true),
  ('99000000-0000-0000-0000-000000000033', 'VN', 'VND', 150000, true);

-- ============================================================================================
-- (1)-(7) Ruling AO: three RPCs, three different grants. Checked directly against the grant
-- (Ruling AS) - grant_complimentary_entitlement's own is_admin() guard raises the same 42501 a
-- missing grant would, so a throws_ok on a live call would look identical whether the grant or
-- the guard rejected it; has_function_privilege proves the grant itself instead.
select is(has_function_privilege('anon', 'public.acquire_free_ebook(uuid)', 'EXECUTE'), false, 'anon holds no EXECUTE on acquire_free_ebook');
select is(has_function_privilege('authenticated', 'public.acquire_free_ebook(uuid)', 'EXECUTE'), true, 'authenticated holds EXECUTE on acquire_free_ebook');
select is(has_function_privilege('anon', 'public.grant_complimentary_entitlement(uuid, uuid, text)', 'EXECUTE'), false, 'anon holds no EXECUTE on grant_complimentary_entitlement');
select is(has_function_privilege('authenticated', 'public.grant_complimentary_entitlement(uuid, uuid, text)', 'EXECUTE'), true, 'authenticated holds EXECUTE on grant_complimentary_entitlement');
select is(has_function_privilege('anon', 'public.apply_payment_event(text, text, uuid, text, text, bigint, text, timestamptz)', 'EXECUTE'), false, 'anon holds no EXECUTE on apply_payment_event');
select is(has_function_privilege('authenticated', 'public.apply_payment_event(text, text, uuid, text, text, bigint, text, timestamptz)', 'EXECUTE'), false, 'authenticated holds no EXECUTE on apply_payment_event - the customer/admin sessions above must be rejected at the grant, not by an internal check');
select is(has_function_privilege('service_role', 'public.apply_payment_event(text, text, uuid, text, text, bigint, text, timestamptz)', 'EXECUTE'), true, 'service_role holds EXECUTE on apply_payment_event');

-- ============================================================================================
-- acquire_free_ebook (spec 6.2)
-- ============================================================================================

set local role authenticated;
select set_config('request.jwt.claim.sub', '98000000-0000-0000-0000-000000000002', true);
create temporary table t_acquire_1 as
select public.acquire_free_ebook('99000000-0000-0000-0000-000000000010') as entitlement_id;
reset role;
grant select on t_acquire_1 to public;

-- (8) A verified customer acquiring an active free offer gets back a real entitlement id.
select isnt((select entitlement_id from t_acquire_1), null, 'acquire_free_ebook returns a new entitlement id');

-- (9) The entitlement is free_order-sourced, with a source_order_id.
select results_eq(
  $$select source_type, status, source_order_id is not null from public.entitlements where id = (select entitlement_id from t_acquire_1)$$,
  $$values ('free_order'::public.entitlement_source, 'active'::public.entitlement_status, true)$$,
  'the entitlement is free_order-sourced and carries a source order'
);

-- (10) The order it points to is a zero-cost, no-payment-required completed snapshot.
select results_eq(
  $$select o.status, o.payment_status, o.total_minor
    from public.orders o
    join public.entitlements e on e.source_order_id = o.id
    where e.id = (select entitlement_id from t_acquire_1)$$,
  $$values ('completed'::public.order_status, 'not_required'::public.payment_status, 0::bigint)$$,
  'spec 6.2: the free order is completed, payment_status not_required, total zero'
);

-- (11) A library item was created alongside the entitlement.
select is(
  (select count(*)::bigint from public.library_items li
   join public.profiles p on p.id = li.profile_id
   where p.auth_user_id = '98000000-0000-0000-0000-000000000002' and li.book_id = '99000000-0000-0000-0000-000000000010'),
  1::bigint,
  'a library item was created for the acquired book'
);

-- (12)-(14) Retrying returns the same entitlement (spec 6.2 point 5) without duplicating the
-- order - entitlements_active_subject_key (the partial unique index), not a hand-rolled
-- check-then-insert, is the mechanism.
set local role authenticated;
select set_config('request.jwt.claim.sub', '98000000-0000-0000-0000-000000000002', true);
create temporary table t_acquire_1_retry as
select public.acquire_free_ebook('99000000-0000-0000-0000-000000000010') as entitlement_id;
reset role;
grant select on t_acquire_1_retry to public;

select is(
  (select entitlement_id from t_acquire_1_retry),
  (select entitlement_id from t_acquire_1),
  'retrying acquire_free_ebook returns the identical entitlement id'
);
select is(
  (select count(*)::bigint from public.orders o
   join public.profiles p on p.id = o.profile_id
   where p.auth_user_id = '98000000-0000-0000-0000-000000000002' and o.total_minor = 0),
  1::bigint,
  'retrying does not create a second free order'
);
select is(
  (select count(*)::bigint from public.entitlements e
   join public.profiles p on p.id = e.profile_id
   where p.auth_user_id = '98000000-0000-0000-0000-000000000002' and e.book_id = '99000000-0000-0000-0000-000000000010'),
  1::bigint,
  'retrying does not create a second entitlement'
);

-- (15) An unverified email is rejected before any offer/order work happens.
set local role authenticated;
select set_config('request.jwt.claim.sub', '98000000-0000-0000-0000-000000000003', true);
select throws_ok(
  $$select public.acquire_free_ebook('99000000-0000-0000-0000-000000000010')$$,
  'EB005',
  null,
  'acquire_free_ebook rejects a caller with no verified email'
);
reset role;

-- (16) A book with no active free offer is rejected distinctly from "no verified email".
set local role authenticated;
select set_config('request.jwt.claim.sub', '98000000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$select public.acquire_free_ebook('99000000-0000-0000-0000-000000000011')$$,
  'EB006',
  null,
  'acquire_free_ebook rejects a book with no active free offer'
);
reset role;

-- ============================================================================================
-- grant_complimentary_entitlement (spec 6.3)
-- ============================================================================================

set local role authenticated;
select set_config('request.jwt.claim.sub', '98000000-0000-0000-0000-000000000001', true);
create temporary table t_grant_1 as
select public.grant_complimentary_entitlement(
  (select target_comp_id from t_profile_ids),
  '99000000-0000-0000-0000-000000000022',
  'launch promo'
) as entitlement_id;
reset role;
grant select on t_grant_1 to public;

-- (17) The grant returns a real entitlement id.
select isnt((select entitlement_id from t_grant_1), null, 'grant_complimentary_entitlement returns an entitlement id');

-- (18) It is admin_grant-sourced, records the acting admin's own profile and the reason, and
-- carries no source_order_id (entitlements_source_consistency forbids one for admin_grant).
select results_eq(
  $$select e.source_type, e.status, e.reason, e.source_order_id is null, e.actor_profile_id = p.id
    from public.entitlements e
    join public.profiles p on p.auth_user_id = '98000000-0000-0000-0000-000000000001'
    where e.id = (select entitlement_id from t_grant_1)$$,
  $$values ('admin_grant'::public.entitlement_source, 'active'::public.entitlement_status, 'launch promo'::text, true, true)$$,
  'the entitlement is admin_grant-sourced, reasoned, actor-attributed, and order-free'
);

-- (19) A library item was created for the target reader.
select is(
  (select count(*)::bigint from public.library_items li
   join public.profiles p on p.id = li.profile_id
   where p.auth_user_id = '98000000-0000-0000-0000-000000000004' and li.book_id = '99000000-0000-0000-0000-000000000012'),
  1::bigint,
  'a library item was created for the complimentary grant'
);

-- (20) The grant and its audit record land in the same transaction - the same statement here.
select results_eq(
  $$select action, entity_type, entity_id, reason
    from public.audit_logs
    where entity_id = (select entitlement_id from t_grant_1)$$,
  $$values ('grant_complimentary_entitlement'::text, 'entitlements'::text, (select entitlement_id from t_grant_1), 'launch promo'::text)$$,
  'the complimentary grant recorded its own audit event'
);

-- (21)-(22) Spec 6.3: no fake order or payment. Assert absence, not just presence of the entitlement.
select is(
  (select count(*)::bigint from public.orders o
   join public.order_items oi on oi.order_id = o.id
   join public.profiles p on p.id = o.profile_id
   where p.auth_user_id = '98000000-0000-0000-0000-000000000004' and oi.book_id = '99000000-0000-0000-0000-000000000012'),
  0::bigint,
  'complimentary access creates no order'
);
select is(
  (select count(*)::bigint from public.payments pay
   join public.orders o on o.id = pay.order_id
   join public.profiles p on p.id = o.profile_id
   where p.auth_user_id = '98000000-0000-0000-0000-000000000004'),
  0::bigint,
  'complimentary access creates no payment'
);

-- (23) A blank reason is rejected before any row is touched.
set local role authenticated;
select set_config('request.jwt.claim.sub', '98000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.grant_complimentary_entitlement(
    (select target_comp_id from t_profile_ids),
    '99000000-0000-0000-0000-000000000022',
    '   '
  )$$,
  '22023',
  'grant_complimentary_entitlement: a reason is required',
  'a blank reason is rejected'
);
reset role;

-- (24) Ruling AS's binding case: an authenticated CUSTOMER (not an admin) calling this admin RPC
-- is rejected by its own is_admin() check - proven with a live call, since this genuinely is the
-- intended behaviour of the internal guard, not a proxy for the grant already proven above.
set local role authenticated;
select set_config('request.jwt.claim.sub', '98000000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$select public.grant_complimentary_entitlement(
    (select target_comp_id from t_profile_ids),
    '99000000-0000-0000-0000-000000000022',
    'a customer trying to self-grant'
  )$$,
  '42501',
  'grant_complimentary_entitlement: caller is not an admin',
  'a non-admin authenticated customer cannot grant complimentary access'
);
reset role;

-- (25)-(26) Reactivation (spec 6.3 point 3): revoke the entitlement directly, then grant again -
-- it comes back active, as the SAME row, not a second one.
update public.entitlements set status = 'revoked', revoked_at = now() where id = (select entitlement_id from t_grant_1);

set local role authenticated;
select set_config('request.jwt.claim.sub', '98000000-0000-0000-0000-000000000001', true);
create temporary table t_grant_1_reactivate as
select public.grant_complimentary_entitlement(
  (select target_comp_id from t_profile_ids),
  '99000000-0000-0000-0000-000000000022',
  'reinstated after a support request'
) as entitlement_id;
reset role;
grant select on t_grant_1_reactivate to public;

select is(
  (select entitlement_id from t_grant_1_reactivate),
  (select entitlement_id from t_grant_1),
  'reactivating a revoked complimentary entitlement updates the same row'
);
select is(
  (select count(*)::bigint from public.entitlements
   where id = (select entitlement_id from t_grant_1) and status = 'active'),
  1::bigint,
  'the reactivated entitlement is active again'
);

-- (27) grant_complimentary_entitlement requires a VERIFIED target identity for a brand-new grant
-- (spec 6.3 point 1) - rejected before touching the target's entitlement/library rows. This
-- target has no existing entitlement row at all for this book, so this is unambiguously the
-- "new grant" case Ruling BQ's check still applies to.
set local role authenticated;
select set_config('request.jwt.claim.sub', '98000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.grant_complimentary_entitlement(
    (select unverified_id from t_profile_ids),
    '99000000-0000-0000-0000-000000000022',
    'attempted grant to an unverified reader'
  )$$,
  'EB007',
  null,
  'a brand-new grant to a target with no verified identity is rejected'
);
reset role;

-- Ruling BQ: reactivation of an EXISTING entitlement does NOT require the target's identity to be
-- CURRENTLY verified - only a brand-new grant does. Seeds a profile who was verified at signup
-- (so a first-time grant to them would have been fine) with a REVOKED entitlement from an earlier
-- grant, then flips their identity back to unverified directly - standing in for an email change
-- resetting verified_at via the existing trigger, pending reconfirmation. Reactivating that
-- existing row must still succeed: the entitlement's subject is profile_id, and an email change
-- does not change who the profile is.
insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason, status, revoked_at)
values (
  '96000000-0000-0000-0000-000000000003',
  (select reactivate_unverified_id from t_profile_ids),
  '99000000-0000-0000-0000-000000000012',
  'admin_grant',
  (select admin_id from t_profile_ids),
  'an earlier grant, later revoked',
  'revoked',
  now()
);
update public.customer_identities
set verified_at = null
where profile_id = (select reactivate_unverified_id from t_profile_ids);

set local role authenticated;
select set_config('request.jwt.claim.sub', '98000000-0000-0000-0000-000000000001', true);
create temporary table t_grant_reactivate_unverified as
select public.grant_complimentary_entitlement(
  (select reactivate_unverified_id from t_profile_ids),
  '99000000-0000-0000-0000-000000000022',
  'reinstated despite the email change'
) as entitlement_id;
reset role;
grant select on t_grant_reactivate_unverified to public;

-- (28) Reactivation succeeds despite the target's identity now being unverified - it is not
-- treated as the "new grant" case.
select is(
  (select entitlement_id from t_grant_reactivate_unverified),
  '96000000-0000-0000-0000-000000000003'::uuid,
  'reactivating an existing entitlement succeeds even though the target is no longer verified'
);
-- (29) The reactivated row is genuinely active again, not a silently-ignored no-op.
select is(
  (select status from public.entitlements where id = '96000000-0000-0000-0000-000000000003'),
  'active'::public.entitlement_status,
  'the reactivated entitlement is active again'
);

-- (30)-(31) grant_complimentary_entitlement prefers an already-ACTIVE row over a merely more
-- recently-touched REVOKED one. Two entitlement rows are seeded directly for the same
-- (profile, book): r_revoked's granted_at is forced an hour into the future, so "most recent by
-- granted_at" would wrongly pick it over r_active if the selection weren't active-first - exactly
-- the hazard `order by granted_at desc limit 1` alone has.
insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason, status, granted_at, revoked_at)
values (
  '96000000-0000-0000-0000-000000000001',
  (select active_revoked_id from t_profile_ids),
  '99000000-0000-0000-0000-000000000012',
  'admin_grant',
  (select admin_id from t_profile_ids),
  'an old, already-revoked grant',
  'revoked',
  now() + interval '1 hour',
  now()
);
insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason, status, granted_at)
values (
  '96000000-0000-0000-0000-000000000002',
  (select active_revoked_id from t_profile_ids),
  '99000000-0000-0000-0000-000000000012',
  'admin_grant',
  (select admin_id from t_profile_ids),
  'the currently active grant',
  'active',
  now()
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '98000000-0000-0000-0000-000000000001', true);
create temporary table t_grant_prefer_active as
select public.grant_complimentary_entitlement(
  (select active_revoked_id from t_profile_ids),
  '99000000-0000-0000-0000-000000000022',
  'reinstating correctly'
) as entitlement_id;
reset role;
grant select on t_grant_prefer_active to public;

select is(
  (select entitlement_id from t_grant_prefer_active),
  '96000000-0000-0000-0000-000000000002'::uuid,
  'the already-active row is reused, not the more-recently-touched revoked one'
);
select is(
  (select count(*)::bigint from public.entitlements
   where profile_id = (select active_revoked_id from t_profile_ids) and book_id = '99000000-0000-0000-0000-000000000012'),
  2::bigint,
  'no third row was created - the revoked row is left exactly as seeded'
);

-- (32)-(34) acquire_free_ebook's cross-source idempotency (the brief's disclosed concern,
-- pinned in the direction someone would break it): a reader who already holds an active
-- entitlement from a DIFFERENT source (here, admin_grant) gets that same entitlement id back
-- from acquire_free_ebook, and no order is fabricated for them. Adding
-- `and source_type = 'free_order'` to the fast-path check would pass every other assertion in
-- this file while creating exactly that orphan zero-price order.
set local role authenticated;
select set_config('request.jwt.claim.sub', '98000000-0000-0000-0000-000000000001', true);
create temporary table t_grant_cross_acquire as
select public.grant_complimentary_entitlement(
  (select cross_acquire_id from t_profile_ids),
  '99000000-0000-0000-0000-000000000020',
  'pre-existing complimentary grant'
) as entitlement_id;
reset role;
grant select on t_grant_cross_acquire to public;

set local role authenticated;
select set_config('request.jwt.claim.sub', '98000000-0000-0000-0000-000000000009', true);
create temporary table t_acquire_cross_source as
select public.acquire_free_ebook('99000000-0000-0000-0000-000000000010') as entitlement_id;
reset role;
grant select on t_acquire_cross_source to public;

select is(
  (select entitlement_id from t_acquire_cross_source),
  (select entitlement_id from t_grant_cross_acquire),
  'acquire_free_ebook returns the existing admin_grant entitlement rather than minting a new one'
);
select is(
  (select count(*)::bigint from public.entitlements
   where profile_id = (select cross_acquire_id from t_profile_ids) and book_id = '99000000-0000-0000-0000-000000000010'),
  1::bigint,
  'still exactly one entitlement row - no second, free_order-sourced row was created'
);
select is(
  (select count(*)::bigint from public.orders
   where profile_id = (select cross_acquire_id from t_profile_ids)),
  0::bigint,
  'no order was fabricated for a reader who already had complimentary access'
);

-- ============================================================================================
-- apply_payment_event (spec 6.4) - Ruling AO's third authorization model, exercised as
-- service_role with no session at all.
-- ============================================================================================

-- Four pending orders, one per scenario below, each for a distinct profile so row counts never
-- cross-contaminate between scenarios.
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor)
select '97000000-0000-0000-0000-000000000001', id, 'pending', 'pending', 'VN', 'VND', 150000
from public.profiles where auth_user_id = '98000000-0000-0000-0000-000000000005';
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor)
select '97000000-0000-0000-0000-000000000002', id, 'pending', 'pending', 'VN', 'VND', 150000
from public.profiles where auth_user_id = '98000000-0000-0000-0000-000000000006';
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor)
select '97000000-0000-0000-0000-000000000003', id, 'pending', 'pending', 'VN', 'VND', 150000
from public.profiles where auth_user_id = '98000000-0000-0000-0000-000000000007';
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor)
select '97000000-0000-0000-0000-000000000004', id, 'pending', 'pending', 'VN', 'VND', 150000
from public.profiles where auth_user_id = '98000000-0000-0000-0000-000000000008';

insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor)
values
  ('97000000-0000-0000-0000-000000000001', '99000000-0000-0000-0000-000000000033', '99000000-0000-0000-0000-000000000013', 'Paid Book', 150000),
  ('97000000-0000-0000-0000-000000000002', '99000000-0000-0000-0000-000000000033', '99000000-0000-0000-0000-000000000013', 'Paid Book', 150000),
  ('97000000-0000-0000-0000-000000000003', '99000000-0000-0000-0000-000000000033', '99000000-0000-0000-0000-000000000013', 'Paid Book', 150000),
  ('97000000-0000-0000-0000-000000000004', '99000000-0000-0000-0000-000000000033', '99000000-0000-0000-0000-000000000013', 'Paid Book', 150000);

-- Scenario A: a successful event grants exactly one entitlement and one payment transition.
set local role service_role;
create temporary table t_pay_success_1 as
select * from public.apply_payment_event(
  'simulator', 'evt-success-1', '97000000-0000-0000-0000-000000000001', 'ext-success-1',
  'succeeded', 150000, 'VND', now()
);
reset role;
grant select on t_pay_success_1 to public;

-- (35) The function reports a granted entitlement and the transitioned statuses.
select results_eq(
  $$select order_status, payment_status, cardinality(entitlement_ids) from t_pay_success_1$$,
  $$values ('completed'::public.order_status, 'succeeded'::public.payment_status, 1)$$,
  'a succeeded event completes the order and grants an entitlement'
);

-- (36) The entitlement is simulated_payment-sourced, pointing at this order.
select results_eq(
  $$select source_type, source_order_id from public.entitlements
    where id in (select unnest(entitlement_ids) from t_pay_success_1)$$,
  $$values ('simulated_payment'::public.entitlement_source, '97000000-0000-0000-0000-000000000001'::uuid)$$,
  'the entitlement is simulated_payment-sourced'
);

-- (37) Exactly one payment row, succeeded.
select is(
  (select count(*)::bigint from public.payments where order_id = '97000000-0000-0000-0000-000000000001' and status = 'succeeded'),
  1::bigint,
  'exactly one succeeded payment transition was recorded'
);

-- (38) Exactly one payment_events row for this event id.
select is(
  (select count(*)::bigint from public.payment_events where provider = 'simulator' and provider_event_id = 'evt-success-1'),
  1::bigint,
  'exactly one payment_events row recorded the event'
);

-- (39) A library item was created for the newly entitled reader.
select is(
  (select count(*)::bigint from public.library_items li
   join public.profiles p on p.id = li.profile_id
   where p.auth_user_id = '98000000-0000-0000-0000-000000000005' and li.book_id = '99000000-0000-0000-0000-000000000013'),
  1::bigint,
  'a library item was created for the successful payment'
);

-- (40)-(43) Duplicate delivery of the SAME event: one payment transition, one entitlement - the
-- brief's binding replay case. apply_payment_event inserts the event row first and returns the
-- existing outcome on conflict, so this must change nothing.
set local role service_role;
create temporary table t_pay_success_1_dup as
select * from public.apply_payment_event(
  'simulator', 'evt-success-1', '97000000-0000-0000-0000-000000000001', 'ext-success-1',
  'succeeded', 150000, 'VND', now()
);
reset role;
grant select on t_pay_success_1_dup to public;

select is(
  (select entitlement_ids from t_pay_success_1_dup),
  (select entitlement_ids from t_pay_success_1),
  'a duplicated success event returns the same entitlement ids'
);
select is(
  (select count(*)::bigint from public.payment_events where provider = 'simulator' and provider_event_id = 'evt-success-1'),
  1::bigint,
  'the duplicated event created no second payment_events row'
);
select is(
  (select count(*)::bigint from public.entitlements where source_order_id = '97000000-0000-0000-0000-000000000001'),
  1::bigint,
  'the duplicated event created no second entitlement'
);
select is(
  (select count(*)::bigint from public.payments where order_id = '97000000-0000-0000-0000-000000000001'),
  1::bigint,
  'the duplicated event created no second payment'
);

-- Scenario B: out-of-order delivery must not resurrect a cancelled order. Cancel first, then
-- apply a later-arriving success event (a different event id, so it is not deduplicated by the
-- unique constraint - the terminal-order check is what has to catch this, not the replay check).
set local role service_role;
select public.apply_payment_event(
  'simulator', 'evt-cancel-2', '97000000-0000-0000-0000-000000000002', 'ext-2',
  'cancelled', 150000, 'VND', now()
);
select public.apply_payment_event(
  'simulator', 'evt-success-2-late', '97000000-0000-0000-0000-000000000002', 'ext-2',
  'succeeded', 150000, 'VND', now()
);
reset role;

-- (44) The order stays cancelled - the late success event did not resurrect it.
select is(
  (select status from public.orders where id = '97000000-0000-0000-0000-000000000002'),
  'cancelled'::public.order_status,
  'a cancelled order is not resurrected by a later out-of-order success event'
);
-- (45) No entitlement was granted from the resurrection attempt.
select is(
  (select count(*)::bigint from public.entitlements where source_order_id = '97000000-0000-0000-0000-000000000002'),
  0::bigint,
  'no entitlement exists for the cancelled order'
);
-- (46) Both events were still recorded (the event ledger is not selectively dropped).
select is(
  (select count(*)::bigint from public.payment_events where provider = 'simulator' and provider_event_id in ('evt-cancel-2', 'evt-success-2-late')),
  2::bigint,
  'both the cancellation and the late success event were recorded'
);

-- Scenario C: a failure never grants access, and leaves the order retryable (still pending).
set local role service_role;
create temporary table t_pay_failed_3 as
select * from public.apply_payment_event(
  'simulator', 'evt-failed-3', '97000000-0000-0000-0000-000000000003', 'ext-3',
  'failed', 150000, 'VND', now()
);
reset role;
grant select on t_pay_failed_3 to public;

-- (47) The function reports no entitlement, failed payment status, order still pending.
select results_eq(
  $$select order_status, payment_status, cardinality(entitlement_ids) from t_pay_failed_3$$,
  $$values ('pending'::public.order_status, 'failed'::public.payment_status, 0)$$,
  'a failed event never grants access and leaves the order retryable'
);
-- (48)-(49) No entitlement or library item exists for the failed order's subject.
select is(
  (select count(*)::bigint from public.entitlements where source_order_id = '97000000-0000-0000-0000-000000000003'),
  0::bigint,
  'no entitlement exists for the failed order'
);
select is(
  (select count(*)::bigint from public.library_items li
   join public.profiles p on p.id = li.profile_id
   where p.auth_user_id = '98000000-0000-0000-0000-000000000007' and li.book_id = '99000000-0000-0000-0000-000000000013'),
  0::bigint,
  'no library item exists for the failed order'
);

-- Scenario D: an amount/currency mismatch is rejected before any state changes.
-- (50) The mismatch is rejected outright, as a fresh (never-before-seen) event.
set local role service_role;
select throws_ok(
  $$select public.apply_payment_event(
    'simulator', 'evt-mismatch-4', '97000000-0000-0000-0000-000000000004', 'ext-4',
    'succeeded', 999999, 'VND', now()
  )$$,
  'EB004',
  null,
  'an amount mismatch is rejected'
);
reset role;

-- (51) The mismatched order is completely untouched.
select is(
  (select row(status, payment_status) from public.orders where id = '97000000-0000-0000-0000-000000000004'),
  row('pending'::public.order_status, 'pending'::public.payment_status),
  'the order with a mismatched amount is left exactly as it was'
);
-- (52)-(53) No entitlement, and no payment, exists for the rejected mismatch attempt - the whole
-- statement, including the payment/event rows that would otherwise have been inserted first,
-- rolled back with the exception.
select is(
  (select count(*)::bigint from public.entitlements where source_order_id = '97000000-0000-0000-0000-000000000004'),
  0::bigint,
  'no entitlement exists for the mismatched order'
);
select is(
  (select count(*)::bigint from public.payments where order_id = '97000000-0000-0000-0000-000000000004'),
  0::bigint,
  'no payment row survives the rejected mismatch attempt'
);

-- Scenario E: cross-source replay (Important finding #1). A buyer who already holds an active
-- entitlement from a DIFFERENT source (here, admin_grant) has a pending order succeed for the
-- SAME (profile, book) pair. The success branch's `on conflict ... do nothing` then resolves the
-- existing entitlement by (profile_id, book_id) - not by this order's own id - so a duplicate of
-- this same event must still find and return that entitlement, not null.
set local role authenticated;
select set_config('request.jwt.claim.sub', '98000000-0000-0000-0000-000000000001', true);
create temporary table t_grant_cross_payment as
select public.grant_complimentary_entitlement(
  (select cross_payment_id from t_profile_ids),
  '99000000-0000-0000-0000-000000000023',
  'existing access before a purchase attempt'
) as entitlement_id;
reset role;
grant select on t_grant_cross_payment to public;

insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor)
select '97000000-0000-0000-0000-000000000005', (select cross_payment_id from t_profile_ids), 'pending', 'pending', 'VN', 'VND', 150000;
insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor)
values ('97000000-0000-0000-0000-000000000005', '99000000-0000-0000-0000-000000000033', '99000000-0000-0000-0000-000000000013', 'Paid Book', 150000);

set local role service_role;
create temporary table t_pay_cross_source as
select * from public.apply_payment_event(
  'simulator', 'evt-cross-source-1', '97000000-0000-0000-0000-000000000005', 'ext-cross-1',
  'succeeded', 150000, 'VND', now()
);
reset role;
grant select on t_pay_cross_source to public;

-- (54) The success branch resolves the reader's existing admin_grant entitlement rather than
-- minting a second one - the entitlement returned is the one already granted, not null.
select is(
  (select entitlement_ids from t_pay_cross_source),
  (select array_agg(id) from public.entitlements where source_order_id = '97000000-0000-0000-0000-000000000005'),
  'a succeeded event for a reader holding a complimentary grant returns the order''s own entitlement'
);
-- (55) Still exactly one entitlement row for this (profile, book) - no orphan simulated_payment
-- row was created alongside the pre-existing admin_grant one.
select is(
  (select count(*)::bigint from public.entitlements
   where profile_id = (select cross_payment_id from t_profile_ids) and book_id = '99000000-0000-0000-0000-000000000013'),
  2::bigint,
  'the complimentary grant and the paid entitlement sit side by side after the cross-source success'
);

set local role service_role;
create temporary table t_pay_cross_source_dup as
select * from public.apply_payment_event(
  'simulator', 'evt-cross-source-1', '97000000-0000-0000-0000-000000000005', 'ext-cross-1',
  'succeeded', 150000, 'VND', now()
);
reset role;
grant select on t_pay_cross_source_dup to public;

-- (56)-(57) The regression this scenario exists to catch: BEFORE the fix, the replay branch looked up
-- the entitlement by `source_order_id = p_order_id`, which is null for this cross-source case
-- (the entitlement's source_order_id belongs to no order at all - it's admin_grant), so a
-- duplicate of this exact event returned an empty result even though the reader plainly
-- still has access. It must return the SAME non-empty array as the first call.
select is(
  (select entitlement_ids from t_pay_cross_source_dup),
  (select entitlement_ids from t_pay_cross_source),
  'a duplicate of the cross-source success event still returns the existing entitlement, not nothing'
);
select is(
  (select count(*)::bigint from public.payment_events where provider = 'simulator' and provider_event_id = 'evt-cross-source-1'),
  1::bigint,
  'the duplicated cross-source event created no second payment_events row'
);

-- Scenario F: the discriminating ordering test (Important finding #2, round 2). Redelivering
-- evt-success-1 (order ...0001, already 'completed') does NOT actually discriminate: if the
-- replay early-return were deleted outright, execution falls through to the terminal-order guard,
-- which independently finds the order non-pending and returns the recorded outcome anyway - the
-- assertion would stay green even with the regression. The case that only the replay check (not
-- the terminal-order guard) can catch is a redelivery against an order that is STILL 'pending':
-- evt-failed-3 (order ...0003, Scenario C) - a 'failed' event changes only payment_status, never
-- order.status, so the terminal-order guard cannot rescue a missing replay check here. Redelivered
-- with a mismatched amount and a different (arbitrary) status, this succeeds only if the
-- event-insert-first replay check runs before the amount check; without it, execution reaches the
-- amount check unguarded and raises EB004.
--
-- Verified to actually discriminate: deleting the replay early-return (not merely reordering the
-- amount check, which is what round 1's version tried) reproduces an uncaught EB004 here, aborting
-- the pgTAP run - confirmed by hand before this fix was committed.
set local role service_role;
create temporary table t_pay_replay_mismatch as
select * from public.apply_payment_event(
  'simulator', 'evt-failed-3', '97000000-0000-0000-0000-000000000003', 'ext-3',
  'succeeded', 1, 'XXX', now()
);
reset role;
grant select on t_pay_replay_mismatch to public;

-- (58) A redelivery of a processed (but still-pending-order) event id succeeds (does not raise
-- EB004) and returns exactly the outcome already recorded for it, even though this call's own
-- status/amount/currency are all wrong.
select results_eq(
  $$select order_status, payment_status, entitlement_ids from t_pay_replay_mismatch$$,
  $$select order_status, payment_status, entitlement_ids from t_pay_failed_3$$,
  'redelivering a processed event against a still-pending order returns the recorded outcome, not EB004'
);

-- (59) A customer session (not just an admin's) can freely call apply_payment_event through
-- PostgREST's grant system without ever reaching it - re-confirming (5)/(6) above hold even for
-- the admin fixture used throughout this file, not only a plain customer.
select is(has_function_privilege('authenticated', 'public.apply_payment_event(text, text, uuid, text, text, bigint, text, timestamptz)', 'EXECUTE'), false, 'no authenticated session - admin or customer - holds EXECUTE on apply_payment_event');

-- (60) is_admin() itself is never satisfied by an unauthenticated/service-role session (Ruling W) -
-- sanity check underpinning why apply_payment_event could never have used an is_admin() gate.
-- request.jwt.claim.sub is cleared first: `reset role` only resets the role, not GUCs set by
-- earlier scenarios' `set_config(..., true)` calls in this same transaction, so without this the
-- admin fixture's own sub would still be in scope and auth.uid() would resolve non-null.
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select is(public.is_admin(), false, 'is_admin() resolves false under service_role (auth.uid() is null)');
reset role;

-- (61) acquire_free_ebook never checks is_admin() at all - the verified customer fixture used in
-- (8) above, who holds no admin role, is proof by construction (the earlier calls succeeded).
select is(
  (select exists(select 1 from public.user_roles ur join public.profiles p on p.id = ur.profile_id where p.auth_user_id = '98000000-0000-0000-0000-000000000002')),
  false,
  'the customer who successfully acquired the free ebook in (8) holds no admin role'
);

-- Review remediation: complimentary revocation is an admin-only, audited, idempotent transaction
-- that removes the corresponding library row immediately.
select is(has_function_privilege('anon', 'public.revoke_complimentary_entitlement(uuid, uuid, text)', 'EXECUTE'), false, 'anon cannot revoke complimentary access');
select is(has_function_privilege('authenticated', 'public.revoke_complimentary_entitlement(uuid, uuid, text)', 'EXECUTE'), true, 'authenticated sessions may reach the admin-gated revoke RPC');

set local role authenticated;
select set_config('request.jwt.claim.sub', '98000000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$select public.revoke_complimentary_entitlement((select target_comp_id from t_profile_ids), (select entitlement_id from t_grant_1), 'unauthorized')$$,
  '42501',
  'revoke_complimentary_entitlement: caller is not an admin',
  'a non-admin cannot revoke complimentary access'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '98000000-0000-0000-0000-000000000001', true);
create temporary table t_revoke_1 as
select public.revoke_complimentary_entitlement(
  (select target_comp_id from t_profile_ids),
  (select entitlement_id from t_grant_1),
  'campaign ended'
) as entitlement_id;
reset role;
grant select on t_revoke_1 to public;

select is((select entitlement_id from t_revoke_1), (select entitlement_id from t_grant_1), 'revoke returns the affected entitlement id');
select results_eq(
  $$select status, revoked_at is not null from public.entitlements where id = (select entitlement_id from t_grant_1)$$,
  $$values ('revoked'::public.entitlement_status, true)$$,
  'revoke marks the entitlement revoked with a timestamp'
);
select is((select count(*)::bigint from public.library_items where entitlement_id = (select entitlement_id from t_grant_1)), 0::bigint, 'revoke removes the dead library entry');
select results_eq(
  $$select action, reason from public.audit_logs where entity_id = (select entitlement_id from t_grant_1) and action = 'revoke_complimentary_entitlement'$$,
  $$values ('revoke_complimentary_entitlement'::text, 'campaign ended'::text)$$,
  'revoke records one immutable audit event'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '98000000-0000-0000-0000-000000000001', true);
create temporary table t_revoke_1_retry as
select public.revoke_complimentary_entitlement(
  (select target_comp_id from t_profile_ids),
  (select entitlement_id from t_grant_1),
  'duplicate request'
) as entitlement_id;
reset role;
grant select on t_revoke_1_retry to public;

select is((select entitlement_id from t_revoke_1_retry), (select entitlement_id from t_revoke_1), 'repeating revoke is idempotent');
select is((select count(*)::bigint from public.audit_logs where entity_id = (select entitlement_id from t_grant_1) and action = 'revoke_complimentary_entitlement'), 1::bigint, 'repeating revoke does not duplicate the audit event');

select * from finish();
rollback;
