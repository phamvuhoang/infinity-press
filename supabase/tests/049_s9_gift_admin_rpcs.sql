begin;
select plan(80);

-- S9: the gift admin surface - search, resend, and reissue
-- (docs/superpowers/specs/2026-09-21-s9-bundles-and-gifts-design.md 7.4).
--
-- The four properties this file exists to hold:
--
--   1. Only an admin reaches any of it, and what an admin gets back is never the credential: the
--      search returns no claim_token_hash and no outbox payload, so the one read path an operator
--      has to a gift cannot hand them the link they are supporting somebody about.
--   2. Resend is a RETRY, not a re-send to somewhere new. The same recipient, the same token, the
--      same single outbox row - only the delivery state is rewound.
--   3. Reissue RETIRES the old link. The old raw token stops claiming the moment the new hash
--      lands, and the new one claims exactly what the order sold.
--   4. A claimed gift is out of reach of both. It is a real entitlement by then, and the route to
--      withdraw it is revoke_order_entitlement, which still works.
--
-- The audit trail is asserted on, not assumed: exactly one row per mutation, and the recipient
-- address in its metadata is masked. An audit table that accumulated plaintext addresses would
-- quietly become the leak the rest of this feature is built to avoid.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's9-admin-gift-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's9-admin-purchaser@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 's9-admin-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 's9-admin-recipient@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = 'f1000000-0000-0000-0000-000000000001') as admin_id,
  (select id from public.profiles where auth_user_id = 'f1000000-0000-0000-0000-000000000002') as purchaser_id,
  (select id from public.profiles where auth_user_id = 'f1000000-0000-0000-0000-000000000003') as reader_id,
  (select id from public.profiles where auth_user_id = 'f1000000-0000-0000-0000-000000000004') as recipient_id;
grant select on t_ids to public;

insert into public.user_roles (profile_id, role) select admin_id, 'admin' from t_ids;

-- A second identity for the purchaser: the address they bought under before changing it.
insert into public.customer_identities (profile_id, normalized_email, verified_at)
select purchaser_id, 's9-admin-purchaser-old@example.test', now() - interval '1 year' from t_ids;

-- The four raw tokens this file uses. Never stored - only these hashes are - and computed with the
-- same expression claim_gift and lib/commerce/gift-token.ts use.
create temporary table t_tokens as
select
  's9-admin-token-a'   as raw_a,
  's9-admin-token-d'   as raw_d,
  's9-admin-token-new' as raw_new,
  encode(extensions.digest(convert_to('s9-admin-token-a', 'UTF8'), 'sha256'), 'hex') as hash_a,
  encode(extensions.digest(convert_to('s9-admin-token-b', 'UTF8'), 'sha256'), 'hex') as hash_b,
  encode(extensions.digest(convert_to('s9-admin-token-c', 'UTF8'), 'sha256'), 'hex') as hash_c,
  encode(extensions.digest(convert_to('s9-admin-token-d', 'UTF8'), 'sha256'), 'hex') as hash_d,
  encode(extensions.digest(convert_to('s9-admin-token-new', 'UTF8'), 'sha256'), 'hex') as hash_new;
grant select on t_tokens to public;

insert into public.authors (id, canonical_slug, display_name, status)
values ('f3000000-0000-0000-0000-000000000001', 's9-admin-author', 'S9 Admin Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values
  ('f2000000-0000-0000-0000-000000000001', 's9-admin-book-1', 'vi', 'f3000000-0000-0000-0000-000000000001', 'published'),
  ('f2000000-0000-0000-0000-000000000002', 's9-admin-book-2', 'vi', 'f3000000-0000-0000-0000-000000000001', 'published');
insert into public.editions (id, book_id, language_code)
values
  ('f4000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'vi'),
  ('f4000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000002', 'vi');
insert into public.skus (id, edition_id, sku_code)
values
  ('f5000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', 's9-admin-sku-1'),
  ('f5000000-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-000000000002', 's9-admin-sku-2');

-- Four gift orders, one per gift status. A is the working bench (sent, two books, a jammed
-- delivery); B is already claimed; C never got paid for; D was revoked. C and D are the two states
-- reissue must refuse.
insert into public.orders (id, profile_id, status, payment_status, market_code, currency,
                           subtotal_minor, discount_minor, total_minor, reference_code, payment_provider)
values
  ('f8000000-0000-0000-0000-000000000001', (select purchaser_id from t_ids), 'completed', 'succeeded', 'VN', 'VND', 300000, 0, 300000, 'IB-A0001', 'simulator'),
  ('f8000000-0000-0000-0000-000000000002', (select purchaser_id from t_ids), 'completed', 'succeeded', 'VN', 'VND', 150000, 0, 150000, 'IB-A0002', 'simulator'),
  ('f8000000-0000-0000-0000-000000000003', (select purchaser_id from t_ids), 'pending',   'pending', 'VN', 'VND', 150000, 0, 150000, 'IB-A0003', 'simulator'),
  ('f8000000-0000-0000-0000-000000000004', (select purchaser_id from t_ids), 'completed', 'succeeded', 'VN', 'VND', 150000, 0, 150000, 'IB-A0004', 'simulator');

insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, position)
values
  ('f8000000-0000-0000-0000-000000000001', 'f5000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'Admin One', 300000, 1),
  ('f8000000-0000-0000-0000-000000000001', 'f5000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000002', 'Admin Two', 0, 2),
  ('f8000000-0000-0000-0000-000000000002', 'f5000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'Admin One', 150000, 1),
  ('f8000000-0000-0000-0000-000000000003', 'f5000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'Admin One', 150000, 1),
  ('f8000000-0000-0000-0000-000000000004', 'f5000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'Admin One', 150000, 1);

insert into public.gifts (id, order_id, purchaser_profile_id, recipient_email, message, claim_token_hash,
                          status, claimed_by_profile_id, claimed_at, revoked_at, revoked_reason)
select * from (values
  ('f9000000-0000-0000-0000-000000000001'::uuid, 'f8000000-0000-0000-0000-000000000001'::uuid, (select purchaser_id from t_ids),
   'recipient-a@example.test', 'Chúc mừng sinh nhật', (select hash_a from t_tokens), 'sent',    null::uuid, null::timestamptz, null::timestamptz, null::text),
  ('f9000000-0000-0000-0000-000000000002'::uuid, 'f8000000-0000-0000-0000-000000000002'::uuid, (select purchaser_id from t_ids),
   'recipient-b@example.test', null, (select hash_b from t_tokens), 'claimed', (select recipient_id from t_ids), now(), null, null),
  ('f9000000-0000-0000-0000-000000000003'::uuid, 'f8000000-0000-0000-0000-000000000003'::uuid, (select purchaser_id from t_ids),
   'recipient-c@example.test', null, (select hash_c from t_tokens), 'pending', null, null, null, null),
  ('f9000000-0000-0000-0000-000000000004'::uuid, 'f8000000-0000-0000-0000-000000000004'::uuid, (select purchaser_id from t_ids),
   'recipient-d@example.test', null, (select hash_d from t_tokens), 'revoked', null, null, now(), 'wrong address')
) as g;

-- Gift A's delivery is jammed: five failed attempts, an error code, and a live worker lease. This
-- is exactly the row an operator presses Resend for, and exactly the row lib/data/operations.ts
-- must start reporting.
insert into public.notification_outbox (id, gift_id, template_key, payload, available_at, attempt_count, last_error_code, lease_token, lease_expires_at)
values
  ('fa000000-0000-0000-0000-000000000001', 'f9000000-0000-0000-0000-000000000001', 'gift_claim',
   jsonb_build_object('claimPath', '/vi/gifts/claim/s9-admin-token-a'), now() - interval '1 hour', 5, 'smtp_timeout',
   'fb000000-0000-0000-0000-000000000001', now() + interval '5 minutes'),
  ('fa000000-0000-0000-0000-000000000002', 'f9000000-0000-0000-0000-000000000002', 'gift_claim', null, now() - interval '2 hours', 0, null, null, null),
  ('fa000000-0000-0000-0000-000000000003', 'f9000000-0000-0000-0000-000000000003', 'gift_claim',
   jsonb_build_object('claimPath', '/vi/gifts/claim/s9-admin-token-c'), 'infinity'::timestamptz, 0, null, null, null),
  ('fa000000-0000-0000-0000-000000000004', 'f9000000-0000-0000-0000-000000000004', 'gift_claim',
   jsonb_build_object('claimPath', '/en/gifts/claim/s9-admin-token-d'), now() - interval '3 hours', 2, null, null, null);

-- Gift B is claimed, so its entitlement exists the way claim_gift would have left it. This is what
-- makes the "a claimed gift is revoked through revoke_order_entitlement" assertion real rather
-- than a statement about an empty set.
insert into public.entitlements (profile_id, book_id, source_type, source_order_id, status)
values ((select recipient_id from t_ids), 'f2000000-0000-0000-0000-000000000001', 'simulated_payment', 'f8000000-0000-0000-0000-000000000002', 'active');

-- Nobody but an admin -----------------------------------------------------------------------
select is(
  has_function_privilege('anon', 'public.admin_search_gifts(text)', 'EXECUTE'),
  false, 'anon holds no EXECUTE on admin_search_gifts');
select is(
  has_function_privilege('anon', 'public.admin_resend_gift(uuid)', 'EXECUTE'),
  false, 'anon holds no EXECUTE on admin_resend_gift');
select is(
  has_function_privilege('anon', 'public.admin_reissue_gift(uuid, text, text, text, text)', 'EXECUTE'),
  false, 'anon holds no EXECUTE on admin_reissue_gift');
select is(
  has_function_privilege('authenticated', 'public.mask_email(text)', 'EXECUTE'),
  false, 'the audit mask is internal to these functions, not a browser-callable one');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-0000-0000-000000000003', true);
select throws_ok(
  $$select * from public.admin_search_gifts('IB-A0001')$$,
  '42501', null, 'a signed-in reader cannot search gifts');
select throws_ok(
  $$select public.admin_resend_gift('f9000000-0000-0000-0000-000000000001')$$,
  '42501', null, 'a signed-in reader cannot resend a gift');
select throws_ok(
  $$select public.admin_reissue_gift('f9000000-0000-0000-0000-000000000001', 'thief@example.test',
      '0000000000000000000000000000000000000000000000000000000000000000', '/vi/gifts/claim/x', 'because')$$,
  '42501', null, 'a signed-in reader cannot reissue a gift');
reset role;

-- Search ------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-0000-0000-000000000001', true);

select is(
  (select count(*) from public.admin_search_gifts('IB-A0001')),
  1::bigint, 'an exact order reference finds exactly its gift');
select is(
  (select gift_id from public.admin_search_gifts('IB-A0001')),
  'f9000000-0000-0000-0000-000000000001'::uuid, 'the exact reference finds the right gift');
select is(
  (select count(*) from public.admin_search_gifts('A000')),
  4::bigint, 'a partial order reference finds every matching gift');
select is(
  (select count(*) from public.admin_search_gifts('s9-admin-purchaser')),
  4::bigint, 'a partial purchaser email finds every gift that purchaser bought');
-- A purchaser who changed their address keeps the old identity row. Searching by either finds the
-- gift, and finds it ONCE - customer_identities is unique on the address, not on the profile, so a
-- plain join here would emit every gift twice.
select is(
  (select count(*) from public.admin_search_gifts('s9-admin-purchaser-old')),
  4::bigint, 'a purchaser is found by a previous address, and each gift only once');
select is(
  (select gift_id from public.admin_search_gifts('RECIPIENT-A@example.test')),
  'f9000000-0000-0000-0000-000000000001'::uuid, 'a recipient address finds its gift, case-insensitively');
select is(
  (select count(*) from public.admin_search_gifts('nothing-matches-this')),
  0::bigint, 'a query that matches nothing returns nothing rather than everything');
select is(
  (select count(*) from public.admin_search_gifts('')),
  4::bigint, 'a blank query lists the newest gifts');

-- The credential is not in the result set. Asserted against the whole row rendered as text, so a
-- column added later that carries the hash or the claim path fails this test rather than sliding in.
select ok(
  (select bool_and(r::text not like '%' || t.hash_a || '%' and r::text not like '%s9-admin-token%')
   from public.admin_search_gifts('') r, t_tokens t),
  'no searched row carries a claim token hash or a claim path');

select is(
  (select purchaser_email from public.admin_search_gifts('IB-A0001')),
  's9-admin-purchaser@example.test', 'the search names the purchaser by their verified address');
select is(
  (select item_titles from public.admin_search_gifts('IB-A0001')),
  array['Admin One', 'Admin Two'], 'the search lists what the gift covers, in order');
select is(
  (select item_count from public.admin_search_gifts('IB-A0001')),
  2, 'the search counts what the gift covers');
select is(
  (select status from public.admin_search_gifts('IB-A0002')),
  'claimed', 'the search reports each gift status');
select is(
  (select attempt_count from public.admin_search_gifts('IB-A0001')),
  5, 'the search shows how many delivery attempts have been burned');

-- Resend ------------------------------------------------------------------------------------
select throws_ok(
  $$select public.admin_resend_gift('f9000000-0000-0000-0000-000000000002')$$,
  'EB030', null, 'a claimed gift has nothing to resend');
select throws_ok(
  $$select public.admin_resend_gift('f9000000-0000-0000-0000-000000000003')$$,
  'EB030', null, 'an unpaid gift is not resent - its link was never due');
select throws_ok(
  $$select public.admin_resend_gift('f9000000-0000-0000-0000-000000000004')$$,
  'EB030', null, 'a revoked gift is not resent');
select throws_ok(
  $$select public.admin_resend_gift('f9000000-0000-0000-0000-0000000000ff')$$,
  'P0002', null, 'resending a gift that does not exist is refused');

select public.admin_resend_gift('f9000000-0000-0000-0000-000000000001');

-- Verified as the connecting role: public.gifts is granted to nobody at all, so an assertion made
-- while still wearing `authenticated` would fail on privileges rather than on behaviour.
reset role;

select is(
  (select o.id from public.notification_outbox o where o.gift_id = 'f9000000-0000-0000-0000-000000000001'),
  'fa000000-0000-0000-0000-000000000001'::uuid, 'resend rewinds the one outbox row rather than replacing it');
select is(
  (select count(*) from public.notification_outbox o where o.gift_id = 'f9000000-0000-0000-0000-000000000001'),
  1::bigint, 'resend leaves exactly one outbox row');
select is(
  (select o.attempt_count from public.notification_outbox o where o.gift_id = 'f9000000-0000-0000-0000-000000000001'),
  0, 'resend returns the delivery budget to full');
select is(
  (select o.last_error_code from public.notification_outbox o where o.gift_id = 'f9000000-0000-0000-0000-000000000001'),
  null, 'resend clears the last error');
select ok(
  (select o.lease_token is null and o.lease_expires_at is null and o.sent_at is null
   from public.notification_outbox o where o.gift_id = 'f9000000-0000-0000-0000-000000000001'),
  'resend releases the stale worker lease');
select ok(
  (select o.available_at <= now() from public.notification_outbox o where o.gift_id = 'f9000000-0000-0000-0000-000000000001'),
  'resend makes the row due now');
select is(
  (select o.payload ->> 'claimPath' from public.notification_outbox o where o.gift_id = 'f9000000-0000-0000-0000-000000000001'),
  '/vi/gifts/claim/s9-admin-token-a', 'resend keeps the same claim link - it is a retry, not a new gift');
select is(
  (select g.recipient_email from public.gifts g where g.id = 'f9000000-0000-0000-0000-000000000001'),
  'recipient-a@example.test', 'resend keeps the same recipient');
select is(
  (select g.claim_token_hash from public.gifts g where g.id = 'f9000000-0000-0000-0000-000000000001'),
  (select hash_a from t_tokens), 'resend keeps the same token');

select is(
  (select count(*) from public.audit_logs a where a.action = 'resend_gift'),
  1::bigint, 'resending writes exactly one audit row');
select is(
  (select a.metadata ->> 'recipient_email_mask' from public.audit_logs a where a.action = 'resend_gift'),
  'r***@example.test', 'the resend audit row masks the recipient address');
select ok(
  (select a.metadata::text not like '%recipient-a@example.test%' and a.metadata::text not like '%s9-admin-token%'
   from public.audit_logs a where a.action = 'resend_gift'),
  'the resend audit row carries no full address, token, hash or claim path');

-- Reissue -----------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.admin_reissue_gift('f9000000-0000-0000-0000-000000000001', 'new@example.test',
      '1111111111111111111111111111111111111111111111111111111111111111', '/vi/gifts/claim/x', '   ')$$,
  '22023', null, 'a reissue without a reason is refused');
select throws_ok(
  $$select public.admin_reissue_gift('f9000000-0000-0000-0000-000000000001', '  ',
      '1111111111111111111111111111111111111111111111111111111111111111', '/vi/gifts/claim/x', 'typo')$$,
  '22023', null, 'a reissue without an address is refused');
select throws_ok(
  $$select public.admin_reissue_gift('f9000000-0000-0000-0000-000000000002', 'new@example.test',
      '1111111111111111111111111111111111111111111111111111111111111111', '/vi/gifts/claim/x', 'typo')$$,
  'EB031', null, 'a claimed gift cannot be reissued - it is a real entitlement by then');
select throws_ok(
  $$select public.admin_reissue_gift('f9000000-0000-0000-0000-0000000000ff', 'new@example.test',
      '1111111111111111111111111111111111111111111111111111111111111111', '/vi/gifts/claim/x', 'typo')$$,
  'P0002', null, 'reissuing a gift that does not exist is refused');

select public.admin_reissue_gift(
  'f9000000-0000-0000-0000-000000000001',
  '  Recipient-New@Example.Test  ',
  (select hash_new from t_tokens),
  '/en/gifts/claim/s9-admin-token-new',
  'the purchaser mistyped the address');

reset role;

select is(
  (select g.recipient_email from public.gifts g where g.id = 'f9000000-0000-0000-0000-000000000001'),
  'recipient-new@example.test', 'reissue normalizes the new address the way the schema requires');
select is(
  (select g.status from public.gifts g where g.id = 'f9000000-0000-0000-0000-000000000001'),
  'sent', 'a reissued gift is claimable again');
select is(
  (select g.claim_token_hash from public.gifts g where g.id = 'f9000000-0000-0000-0000-000000000001'),
  (select hash_new from t_tokens), 'reissue replaces the stored hash');
select is(
  (select o.payload ->> 'claimPath' from public.notification_outbox o where o.gift_id = 'f9000000-0000-0000-0000-000000000001'),
  '/en/gifts/claim/s9-admin-token-new', 'reissue replaces the claim link the recipient is mailed');
select is(
  (select o.id from public.notification_outbox o where o.gift_id = 'f9000000-0000-0000-0000-000000000001'),
  'fa000000-0000-0000-0000-000000000001'::uuid, 'reissue rewinds the one outbox row rather than replacing it');
select ok(
  (select o.attempt_count = 0 and o.last_error_code is null and o.lease_token is null
      and o.lease_expires_at is null and o.sent_at is null and o.available_at <= now()
   from public.notification_outbox o where o.gift_id = 'f9000000-0000-0000-0000-000000000001'),
  'reissue starts the delivery budget over and makes the row due now');

select is(
  (select count(*) from public.audit_logs a where a.action = 'reissue_gift'),
  1::bigint, 'reissuing writes exactly one audit row');
select is(
  (select a.reason from public.audit_logs a where a.action = 'reissue_gift'),
  'the purchaser mistyped the address', 'the reissue audit row records why');
select is(
  (select a.metadata ->> 'recipient_email_mask' from public.audit_logs a where a.action = 'reissue_gift'),
  'r***@example.test', 'the reissue audit row masks the new address');
select is(
  (select a.metadata ->> 'previous_recipient_email_mask' from public.audit_logs a where a.action = 'reissue_gift'),
  'r***@example.test', 'the reissue audit row masks the address it replaced');
select ok(
  (select a.metadata::text not like '%recipient-new@example.test%'
      and a.metadata::text not like '%recipient-a@example.test%'
      and a.metadata::text not like '%s9-admin-token%'
      and a.metadata::text not like '%' || (select hash_new from t_tokens) || '%'
   from public.audit_logs a where a.action = 'reissue_gift'),
  'the reissue audit row carries no full address, token, hash or claim path');

-- Only a 'sent' gift is reissued, and that is the invariant rather than a nicety -------------
--
-- 'sent' is what activate_order_gift sets when an order COMPLETES, and claim_gift gates on gift
-- status alone: it never rechecks payment. A reissue that accepted a 'pending' gift would set
-- status = 'sent' and undo the 'infinity' park configure_gift applies to its outbox row, so the
-- recipient could claim entitlements for an order nobody ever paid for. These four assertions are
-- the guard: it refuses, and - just as important - it has written nothing by the time it refuses.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-0000-0000-000000000001', true);

select throws_ok(
  $$select public.admin_reissue_gift('f9000000-0000-0000-0000-000000000003', 'recipient-c2@example.test',
      '2222222222222222222222222222222222222222222222222222222222222222', '/vi/gifts/claim/s9-admin-token-c2', 'unpaid')$$,
  'EB030', null, 'an unpaid gift cannot be reissued - activating it would grant access nobody bought');
select throws_ok(
  $$select public.admin_reissue_gift('f9000000-0000-0000-0000-000000000004', 'recipient-d2@example.test',
      '2222222222222222222222222222222222222222222222222222222222222222', '/vi/gifts/claim/s9-admin-token-d2', 'bounced')$$,
  'EB030', null, 'a revoked gift has no live delivery to reissue');
reset role;

select is(
  (select g.status from public.gifts g where g.id = 'f9000000-0000-0000-0000-000000000003'),
  'pending', 'the refused reissue left the unpaid gift pending');
select is(
  (select g.claim_token_hash from public.gifts g where g.id = 'f9000000-0000-0000-0000-000000000003'),
  (select hash_c from t_tokens), 'the refused reissue replaced no hash');
select is(
  (select o.available_at from public.notification_outbox o where o.gift_id = 'f9000000-0000-0000-0000-000000000003'),
  'infinity'::timestamptz, 'the refused reissue left the unpaid gift''s outbox row parked');
select is(
  (select g.status from public.gifts g where g.id = 'f9000000-0000-0000-0000-000000000004'),
  'revoked', 'the refused reissue left the revoked gift revoked');

reset role;

-- The old link is dead, the new one works -----------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-0000-0000-000000000004', true);

select throws_ok(
  format($$select * from public.claim_gift(%L)$$, (select raw_a from t_tokens)),
  'EB029', null, 'the token the gift was reissued away from no longer claims anything');
select is(
  (select count(*) from public.claim_gift((select raw_new from t_tokens))),
  2::bigint, 'the reissued token claims every book the gift order sold');
reset role;

-- A claimed gift is out of reach of reissue, and is withdrawn the way spec 7.4 says ------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-0000-0000-000000000001', true);

select throws_ok(
  $$select public.admin_reissue_gift('f9000000-0000-0000-0000-000000000001', 'later@example.test',
      '3333333333333333333333333333333333333333333333333333333333333333', '/vi/gifts/claim/y', 'too late')$$,
  'EB031', null, 'a gift claimed since its reissue cannot be reissued again');
select is(
  array_length(public.revoke_order_entitlement('f8000000-0000-0000-0000-000000000002', 'support request'), 1),
  1, 'a claimed gift is withdrawn through revoke_order_entitlement, which still works');
select is(
  (select e.status from public.entitlements e where e.source_order_id = 'f8000000-0000-0000-0000-000000000002'),
  'revoked'::public.entitlement_status, 'that revocation is what actually takes the book back');

reset role;

-- The operational read reaches a gift that PostgREST cannot -----------------------------------
--
-- public.gifts is granted to nobody, service_role included, so a REST select with
-- `gifts!inner(...)` fails at planning time with 42501 however privileged the caller. These cases
-- exercise the GRANT, not just the predicate: that is the gap a mocked Supabase client cannot see,
-- and it is how a stuck gift delivery stayed invisible to every operational rule.

-- Back to a jammed gift: gift A is claimed by now, so gift D - revoked above - is made sendable
-- and jammed instead, which is the exact shape the rule looks for.
update public.gifts set status = 'sent', revoked_at = null, revoked_reason = null
where id = 'f9000000-0000-0000-0000-000000000004';
update public.notification_outbox
set attempt_count = 5, sent_at = null, lease_token = null, lease_expires_at = null
where gift_id = 'f9000000-0000-0000-0000-000000000004';

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(
  (select count(*) from public.stuck_gift_notifications(4, now(), 500)),
  1::bigint, 'the operations worker reads a stuck gift row that no REST select could reach');
select is(
  (select gift_id from public.stuck_gift_notifications(4, now(), 500)),
  'f9000000-0000-0000-0000-000000000004'::uuid, 'it names the gift');
select is(
  (select order_id from public.stuck_gift_notifications(4, now(), 500)),
  'f8000000-0000-0000-0000-000000000004'::uuid, 'it names the order the gift was bought on');
select is(
  (select count(*) from public.stuck_gift_notifications(6, now(), 500)),
  0::bigint, 'the attempt floor is applied');
-- A row under a live lease is being worked on right now, not stuck.
reset role;
-- Both halves together: notification_outbox_check ties the token and its expiry to each other.
update public.notification_outbox
set lease_token = 'fb000000-0000-0000-0000-000000000004', lease_expires_at = now() + interval '5 minutes'
where gift_id = 'f9000000-0000-0000-0000-000000000004';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(
  (select count(*) from public.stuck_gift_notifications(4, now(), 500)),
  0::bigint, 'a row holding a live lease is not reported');
-- A claimed gift's row can never be claimed or cleared, so it is not a delivery fault.
reset role;
update public.notification_outbox set lease_token = null, lease_expires_at = null
where gift_id = 'f9000000-0000-0000-0000-000000000004';
update public.gifts set status = 'claimed', claimed_at = now(),
  claimed_by_profile_id = (select recipient_id from t_ids)
where id = 'f9000000-0000-0000-0000-000000000004';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(
  (select count(*) from public.stuck_gift_notifications(4, now(), 500)),
  0::bigint, 'only a gift still in sent is a delivery fault');
reset role;
update public.gifts set status = 'sent', claimed_at = null, claimed_by_profile_id = null
where id = 'f9000000-0000-0000-0000-000000000004';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select ok(
  (select bool_and(r::text not like '%recipient-%' and r::text not like '%s9-admin-token%')
   from public.stuck_gift_notifications(4, now(), 500) r),
  'the operational read carries no recipient address, token or claim path');
reset role;

-- The mail worker's read, the second call site of the same revocation ------------------------
--
-- resolveGiftDelivery used to select public.gifts directly on this same service_role client. It
-- was refused 42501 every time, and because that becomes a per-row DeliveryDataError rather than a
-- failed run, every gift burned its six attempts on the backoff and retired undelivered - the
-- purchaser paid, the gift went to 'sent', and the recipient was never written to.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(
  (select recipient_email from public.gift_delivery_details('f9000000-0000-0000-0000-000000000004')),
  'recipient-d@example.test', 'the mail worker reads the address it must write to');
select is(
  (select order_id from public.gift_delivery_details('f9000000-0000-0000-0000-000000000004')),
  'f8000000-0000-0000-0000-000000000004'::uuid, 'it reads the order whose lines the message lists');
select is(
  (select status from public.gift_delivery_details('f9000000-0000-0000-0000-000000000004')),
  'sent', 'it reads the status, so a gift claimed since the lease is not delivered');
select is(
  (select count(*) from public.gift_delivery_details('f9000000-0000-0000-0000-0000000000ff')),
  0::bigint, 'a gift that does not exist is an empty result, which the worker fails that row on');
-- The two columns it must never carry: the credential, and the claim path.
select ok(
  (select bool_and(r::text not like '%' || t.hash_new || '%' and r::text not like '%gifts/claim%')
   from public.gift_delivery_details('f9000000-0000-0000-0000-000000000004') r, t_tokens t),
  'the delivery read carries no token hash and no claim path');
reset role;

-- And nobody else reaches either of them.
select is(
  has_function_privilege('anon', 'public.stuck_gift_notifications(integer, timestamptz, integer)', 'EXECUTE'),
  false, 'anon holds no EXECUTE on the operational read');
select is(
  has_function_privilege('anon', 'public.gift_delivery_details(uuid)', 'EXECUTE'),
  false, 'anon holds no EXECUTE on the delivery read');
select is(
  has_function_privilege('authenticated', 'public.gift_delivery_details(uuid)', 'EXECUTE'),
  false, 'a signed-in reader holds no EXECUTE on the delivery read - it is the worker''s alone');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-0000-0000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select throws_ok(
  $$select * from public.stuck_gift_notifications(4, now(), 500)$$,
  '42501', null, 'a signed-in reader cannot read the operational gift rows');
select throws_ok(
  $$select * from public.gift_delivery_details('f9000000-0000-0000-0000-000000000004')$$,
  '42501', null, 'a signed-in reader cannot read a gift''s delivery details');
reset role;

select * from finish();
rollback;
