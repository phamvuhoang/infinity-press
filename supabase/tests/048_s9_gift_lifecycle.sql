begin;
select plan(59);

-- S9: the gift lifecycle - configuration, payment completion, and the atomic claim
-- (docs/superpowers/specs/2026-09-21-s9-bundles-and-gifts-design.md 7.2-7.3).
--
-- The three properties this file exists to hold:
--
--   1. A gift is configured by its PURCHASER and by nobody else, only while the order is still
--      pending, and the purchaser can read back what they set without ever seeing the token hash.
--   2. Completing a gift order grants the BUYER nothing. Whatever completes it - a simulator
--      event, a confirmed bank transfer, or a 100% coupon - the entitlement loop is skipped, the
--      reported entitlement array is empty, and the gift becomes claimable instead.
--   3. Claiming is atomic. Exactly one reader ever wins a token, a second attempt by the winner
--      returns the same answer without writing, and every other outcome is one indistinguishable
--      refusal (EB029) so a token cannot be probed.
--
-- The last section stages property 3 with two REAL concurrent sessions over dblink, because the
-- interleaving is the property: two sequential calls exercise the branch but never the lock.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's9-life-purchaser@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's9-life-recipient@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 's9-life-other@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 's9-life-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

-- Resolved as the connecting role, before any role switch: profiles RLS hides the other readers.
create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = 'e1000000-0000-0000-0000-000000000001') as purchaser_id,
  (select id from public.profiles where auth_user_id = 'e1000000-0000-0000-0000-000000000002') as recipient_id,
  (select id from public.profiles where auth_user_id = 'e1000000-0000-0000-0000-000000000003') as other_id,
  (select id from public.profiles where auth_user_id = 'e1000000-0000-0000-0000-000000000004') as admin_id;
grant select on t_ids to public;

insert into public.user_roles (profile_id, role) select admin_id, 'admin' from t_ids;

insert into public.authors (id, canonical_slug, display_name, status)
values ('e3000000-0000-0000-0000-000000000001', 's9-life-author', 'S9 Lifecycle Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values
  ('e2000000-0000-0000-0000-000000000001', 's9-life-book-1', 'vi', 'e3000000-0000-0000-0000-000000000001', 'published'),
  ('e2000000-0000-0000-0000-000000000002', 's9-life-book-2', 'vi', 'e3000000-0000-0000-0000-000000000001', 'published');
insert into public.editions (id, book_id, language_code)
values
  ('e4000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'vi'),
  ('e4000000-0000-0000-0000-000000000002', 'e2000000-0000-0000-0000-000000000002', 'vi');
insert into public.skus (id, edition_id, sku_code)
values
  ('e5000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000001', 's9-life-sku-1'),
  ('e5000000-0000-0000-0000-000000000002', 'e4000000-0000-0000-0000-000000000002', 's9-life-sku-2');

-- Seven pending orders. 1, 4, 6 and 7 become gift orders; 2 is the configuration bench; 3 belongs
-- to the other reader; 5 is the non-gift control that must keep behaving exactly as it does today.
--   1  purchaser, simulator, two books, 300000  - the simulator gift order
--   2  purchaser, simulator, one book,  150000  - configure/remove
--   3  other,     simulator, one book,  150000  - not the purchaser's
--   4  purchaser, simulator, two books, 300000  - the 100%-coupon gift order
--   5  purchaser, simulator, one book,  150000  - non-gift control
--   6  purchaser, manual,    one book,  150000  - the manual gift order
--   7  purchaser, simulator, one book,  150000  - non-gift 100%-coupon control
insert into public.orders (id, profile_id, status, payment_status, market_code, currency,
                           subtotal_minor, discount_minor, total_minor, reference_code, payment_provider)
values
  ('e8000000-0000-0000-0000-000000000001', (select purchaser_id from t_ids), 'pending', 'pending', 'VN', 'VND', 300000, 0, 300000, 'IB-G0001', 'simulator'),
  ('e8000000-0000-0000-0000-000000000002', (select purchaser_id from t_ids), 'pending', 'pending', 'VN', 'VND', 150000, 0, 150000, 'IB-G0002', 'simulator'),
  ('e8000000-0000-0000-0000-000000000003', (select other_id     from t_ids), 'pending', 'pending', 'VN', 'VND', 150000, 0, 150000, 'IB-G0003', 'simulator'),
  ('e8000000-0000-0000-0000-000000000004', (select purchaser_id from t_ids), 'pending', 'pending', 'VN', 'VND', 300000, 0, 300000, 'IB-G0004', 'simulator'),
  ('e8000000-0000-0000-0000-000000000005', (select purchaser_id from t_ids), 'pending', 'pending', 'VN', 'VND', 150000, 0, 150000, 'IB-G0005', 'simulator'),
  ('e8000000-0000-0000-0000-000000000006', (select purchaser_id from t_ids), 'pending', 'pending', 'VN', 'VND', 150000, 0, 150000, 'IB-G0006', 'manual'),
  ('e8000000-0000-0000-0000-000000000007', (select purchaser_id from t_ids), 'pending', 'pending', 'VN', 'VND', 150000, 0, 150000, 'IB-G0007', 'simulator');

insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, position)
values
  ('e8000000-0000-0000-0000-000000000001', 'e5000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'Lifecycle One', 300000, 1),
  ('e8000000-0000-0000-0000-000000000001', 'e5000000-0000-0000-0000-000000000002', 'e2000000-0000-0000-0000-000000000002', 'Lifecycle Two', 0, 2),
  ('e8000000-0000-0000-0000-000000000002', 'e5000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'Lifecycle One', 150000, 1),
  ('e8000000-0000-0000-0000-000000000003', 'e5000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'Lifecycle One', 150000, 1),
  ('e8000000-0000-0000-0000-000000000004', 'e5000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'Lifecycle One', 300000, 1),
  ('e8000000-0000-0000-0000-000000000004', 'e5000000-0000-0000-0000-000000000002', 'e2000000-0000-0000-0000-000000000002', 'Lifecycle Two', 0, 2),
  ('e8000000-0000-0000-0000-000000000005', 'e5000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'Lifecycle One', 150000, 1),
  ('e8000000-0000-0000-0000-000000000006', 'e5000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'Lifecycle One', 150000, 1),
  ('e8000000-0000-0000-0000-000000000007', 'e5000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'Lifecycle One', 150000, 1);

insert into public.payments (order_id, provider, status, amount_minor, currency)
select o.id, o.payment_provider, 'pending', o.total_minor, o.currency
from public.orders o where o.reference_code like 'IB-G000%';

-- A 100% code, used by order 4 (a gift) and order 7 (the control).
insert into public.coupons (id, code, kind, percent_off, currency, active, max_redemptions, max_redemptions_per_profile)
values ('e6000000-0000-0000-0000-000000000001', 'LIFEFREE', 'percent', 100, null, true, null, 5);

-- Two fixed token hashes, one per claimable gift. Computed the way claim_gift computes them, so
-- the raw tokens below really are the tokens for these rows.
create temporary table t_tokens as
select
  's9-life-token-one'::text as token_one,
  encode(extensions.digest(convert_to('s9-life-token-one', 'UTF8'), 'sha256'), 'hex') as hash_one,
  's9-life-token-four'::text as token_four,
  encode(extensions.digest(convert_to('s9-life-token-four', 'UTF8'), 'sha256'), 'hex') as hash_four,
  's9-life-token-six'::text as token_six,
  encode(extensions.digest(convert_to('s9-life-token-six', 'UTF8'), 'sha256'), 'hex') as hash_six,
  's9-life-token-two'::text as token_two,
  encode(extensions.digest(convert_to('s9-life-token-two', 'UTF8'), 'sha256'), 'hex') as hash_two;
grant select on t_tokens to public;

-- ==========================================================================================
-- The surface: who may call what (1-6).
-- ==========================================================================================
select ok(has_function_privilege('authenticated', 'public.configure_gift(uuid, text, text, text, text)', 'execute'),
  'a signed-in reader may configure a gift');
select ok(has_function_privilege('authenticated', 'public.remove_gift(uuid)', 'execute'),
  'a signed-in reader may remove a gift');
select ok(has_function_privilege('authenticated', 'public.get_my_order_gift(uuid)', 'execute'),
  'a signed-in reader may read their own order gift');
select ok(has_function_privilege('authenticated', 'public.claim_gift(text)', 'execute'),
  'a signed-in reader may claim a gift');
-- activate_order_gift is internal: it moves money-adjacent state with no authorization of its own,
-- so its only protection is that nothing browser-reachable may execute it.
select ok(not has_function_privilege('authenticated', 'public.activate_order_gift(uuid)', 'execute'),
  'activate_order_gift is not reachable by a signed-in reader');
select ok(not has_function_privilege('anon', 'public.activate_order_gift(uuid)', 'execute'),
  'activate_order_gift is not reachable anonymously');

-- ==========================================================================================
-- configure_gift, remove_gift and the safe read (7-22).
-- ==========================================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-000000000001', true);

select lives_ok(
  $$select public.configure_gift('e8000000-0000-0000-0000-000000000002',
      '  Recipient@Example.TEST ', '  Chuc mung sinh nhat  ',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      '/vi/gifts/claim/token-b')$$,
  'the purchaser configures a gift on their own pending order');

reset role;
select is(
  (select g.recipient_email || '|' || g.message || '|' || g.status
   from public.gifts g where g.order_id = 'e8000000-0000-0000-0000-000000000002'),
  'recipient@example.test|Chuc mung sinh nhat|pending',
  'the address is lower-cased and trimmed, the message trimmed, and the gift starts pending');

select is(
  (select count(*) from public.notification_outbox o
   join public.gifts g on g.id = o.gift_id
   where g.order_id = 'e8000000-0000-0000-0000-000000000002' and o.template_key = 'gift_claim'),
  1::bigint, 'exactly one gift_claim outbox row is written');

select is(
  (select o.payload ->> 'claimPath' from public.notification_outbox o
   join public.gifts g on g.id = o.gift_id
   where g.order_id = 'e8000000-0000-0000-0000-000000000002'),
  '/vi/gifts/claim/token-b', 'the outbox row carries the localized claim path and nothing else');

select is(
  (select count(*) from jsonb_object_keys(
     (select o.payload from public.notification_outbox o
      join public.gifts g on g.id = o.gift_id
      where g.order_id = 'e8000000-0000-0000-0000-000000000002'))),
  1::bigint, 'the payload holds the claim path alone - never the raw token');

-- Not claimable while the order is unpaid: the worker must not mail a claim link for a gift that
-- has not been bought. Both halves say so - the row is parked in the future AND its gift is not
-- yet 'sent' - so neither guard is load-bearing on its own.
select ok(
  (select o.available_at from public.notification_outbox o
   join public.gifts g on g.id = o.gift_id
   where g.order_id = 'e8000000-0000-0000-0000-000000000002') > now(),
  'a pending gift parks its outbox row in the future');
select is(
  (select count(*) from public.claim_notification_outbox(25, gen_random_uuid()) c
   join public.gifts g on g.id = c.gift_id
   where g.order_id = 'e8000000-0000-0000-0000-000000000002'),
  0::bigint, 'the worker cannot claim the outbox row of an unpaid gift');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-000000000001', true);

select results_eq(
  $$select recipient_email, message, status from public.get_my_order_gift('e8000000-0000-0000-0000-000000000002')$$,
  $$values ('recipient@example.test'::text, 'Chuc mung sinh nhat'::text, 'pending'::text)$$,
  'the purchaser reads back exactly the three safe fields');

-- Reconfiguration while pending: a purchaser who corrects the address gets ONE gift, with the new
-- hash and the new path. The old token must stop working, which is what replacing the hash means.
select lives_ok(
  $$select public.configure_gift('e8000000-0000-0000-0000-000000000002',
      'second@example.test', null,
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      '/en/gifts/claim/token-c')$$,
  'a pending gift can be reconfigured');

reset role;
select is(
  (select count(*) from public.gifts g where g.order_id = 'e8000000-0000-0000-0000-000000000002'),
  1::bigint, 'reconfiguring replaces the gift rather than adding one');
select is(
  (select g.recipient_email || '|' || coalesce(g.message, '<none>') || '|' || g.claim_token_hash
   from public.gifts g where g.order_id = 'e8000000-0000-0000-0000-000000000002'),
  'second@example.test|<none>|cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'the new address, the cleared message and the new hash replace the old ones');
select is(
  (select count(*) from public.notification_outbox o
   join public.gifts g on g.id = o.gift_id
   where g.order_id = 'e8000000-0000-0000-0000-000000000002' and o.payload ->> 'claimPath' = '/en/gifts/claim/token-c'),
  1::bigint, 'the single outbox row carries the new claim path');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-000000000001', true);

-- Another reader's order, and an order that does not exist, are the same refusal: a purchaser
-- cannot tell the two apart, so an order id cannot be probed for existence.
select throws_ok(
  $$select public.configure_gift('e8000000-0000-0000-0000-000000000003', 'x@example.test', null,
      'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', '/vi/gifts/claim/x')$$,
  'EB028', null, 'a reader cannot configure a gift on another reader''s order');
select throws_ok(
  $$select public.configure_gift('e8000000-0000-0000-0000-0000000000ff', 'x@example.test', null,
      'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', '/vi/gifts/claim/x')$$,
  'EB028', null, 'a reader cannot configure a gift on an order that does not exist');
-- A reported transfer freezes the order: the reader has already told us what they sent, and
-- turning that order into a gift afterwards would change who the purchase is for.
select lives_ok(
  $$select public.claim_manual_transfer('e8000000-0000-0000-0000-000000000006', 'da chuyen khoan')$$,
  'the purchaser reports a transfer on the manual order');
select throws_ok(
  $$select public.configure_gift('e8000000-0000-0000-0000-000000000006', 'x@example.test', null,
      'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', '/vi/gifts/claim/x')$$,
  'EB028', null, 'a gift cannot be configured on an order whose transfer is already reported');

reset role;
delete from public.manual_transfer_claims where order_id = 'e8000000-0000-0000-0000-000000000006';

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-000000000003', true);
select is(
  (select count(*) from public.get_my_order_gift('e8000000-0000-0000-0000-000000000002')),
  0::bigint, 'another reader reads nothing back for an order that is not theirs');
select throws_ok(
  $$select public.remove_gift('e8000000-0000-0000-0000-000000000002')$$,
  'EB028', null, 'another reader cannot remove the purchaser''s gift');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select public.remove_gift('e8000000-0000-0000-0000-000000000002')$$,
  'the purchaser removes their own unactivated gift');
select throws_ok(
  $$select public.remove_gift('e8000000-0000-0000-0000-000000000002')$$,
  'EB028', null, 'removing a gift that is no longer there is refused, not silently accepted');

reset role;
select is(
  (select count(*) from public.notification_outbox o
   join public.gifts g on g.id = o.gift_id
   where g.purchaser_profile_id = (select purchaser_id from t_ids)),
  0::bigint, 'removing the gift takes its outbox row with it');

-- ==========================================================================================
-- Completing a gift order grants the buyer nothing (23-33).
-- ==========================================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-000000000001', true);
select public.configure_gift('e8000000-0000-0000-0000-000000000001', 'recipient@example.test',
  'For you', (select hash_one from t_tokens), '/vi/gifts/claim/s9-life-token-one');
select public.configure_gift('e8000000-0000-0000-0000-000000000004', 'recipient@example.test',
  null, (select hash_four from t_tokens), '/vi/gifts/claim/s9-life-token-four');
select public.configure_gift('e8000000-0000-0000-0000-000000000006', 'recipient@example.test',
  null, (select hash_six from t_tokens), '/vi/gifts/claim/s9-life-token-six');
-- Order two is configured again and deliberately never paid: it is the gift that is still
-- 'pending' when the refusals below are exercised.
select public.configure_gift('e8000000-0000-0000-0000-000000000002', 'recipient@example.test',
  null, (select hash_two from t_tokens), '/vi/gifts/claim/s9-life-token-two');
reset role;

-- The simulator gift order.
select is(
  (select cardinality(r.entitlement_ids) from public.apply_payment_event(
     'simulator', 'evt-life-1', 'e8000000-0000-0000-0000-000000000001', 'pay-life-1',
     'succeeded', 300000, 'VND', now()) r),
  0, 'a completed gift order reports no entitlement to the buyer');
select is(
  (select count(*) from public.entitlements e
   where e.source_order_id = 'e8000000-0000-0000-0000-000000000001'),
  0::bigint, 'a completed gift order grants the buyer nothing at all');
select is(
  (select o.status::text || '|' || g.status from public.orders o
   join public.gifts g on g.order_id = o.id where o.id = 'e8000000-0000-0000-0000-000000000001'),
  'completed|sent', 'the order completes and the gift becomes claimable');
select ok(
  (select o.available_at from public.notification_outbox o
   join public.gifts g on g.id = o.gift_id
   where g.order_id = 'e8000000-0000-0000-0000-000000000001') <= now(),
  'completing the order releases the gift''s outbox row to the worker');

-- Replay of the same event: the array stays empty for a gift, and nothing moves.
select is(
  (select cardinality(r.entitlement_ids) from public.apply_payment_event(
     'simulator', 'evt-life-1', 'e8000000-0000-0000-0000-000000000001', 'pay-life-1',
     'succeeded', 300000, 'VND', now()) r),
  0, 'replaying the event still reports no entitlement for a gift order');
select is(
  (select count(*) from public.entitlements e
   where e.source_order_id = 'e8000000-0000-0000-0000-000000000001'),
  0::bigint, 'the replay grants nothing');

-- The non-gift control, on the very same code path.
select is(
  (select cardinality(r.entitlement_ids) from public.apply_payment_event(
     'simulator', 'evt-life-5', 'e8000000-0000-0000-0000-000000000005', 'pay-life-5',
     'succeeded', 150000, 'VND', now()) r),
  1, 'an ordinary order still reports the entitlement it granted');
select is(
  (select count(*) from public.entitlements e
   where e.source_order_id = 'e8000000-0000-0000-0000-000000000005' and e.status = 'active'),
  1::bigint, 'an ordinary order still grants the buyer their book');

-- The manual gift order, confirmed by an admin: the same skip, through a different entry point.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-000000000004', true);
select is(
  (select cardinality(r.entitlement_ids) from public.confirm_manual_payment(
     'e8000000-0000-0000-0000-000000000006', 150000, 'REF-LIFE-6', null) r),
  0, 'a confirmed manual gift order reports no entitlement to the buyer');
reset role;
select is(
  (select count(*) from public.entitlements e
   where e.source_order_id = 'e8000000-0000-0000-0000-000000000006'),
  0::bigint, 'a confirmed manual gift order grants the buyer nothing');

-- The 100% coupon: a fully discounted gift order behaves identically (spec 7.2).
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-000000000001', true);
select is(
  (select r.total_minor::text || '|' || r.order_status::text || '|' || cardinality(r.entitlement_ids)::text
   from public.apply_coupon_to_order('e8000000-0000-0000-0000-000000000004', 'LIFEFREE') r),
  '0|completed|0', 'a fully discounted gift order completes and reports no entitlement');
select is(
  (select r.total_minor::text || '|' || r.order_status::text || '|' || cardinality(r.entitlement_ids)::text
   from public.apply_coupon_to_order('e8000000-0000-0000-0000-000000000007', 'LIFEFREE') r),
  '0|completed|1', 'a fully discounted ordinary order still grants its book');
reset role;
select is(
  (select count(*) from public.entitlements e
   where e.source_order_id = 'e8000000-0000-0000-0000-000000000004'),
  0::bigint, 'the fully discounted gift order grants the buyer nothing');
select is(
  (select count(*) from public.coupon_redemptions r
   where r.order_id = 'e8000000-0000-0000-0000-000000000004' and r.status = 'redeemed'),
  1::bigint, 'the coupon is redeemed exactly once for the gift order');

-- ==========================================================================================
-- claim_gift (34-48).
-- ==========================================================================================
-- The other reader already owns book one, through an admin grant that has nothing to do with any
-- order. Claiming gift four must report it as already owned and leave that grant alone.
insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason, status)
select 'ea000000-0000-0000-0000-000000000001', t.other_id, 'e2000000-0000-0000-0000-000000000001',
       'admin_grant', t.admin_id, 'S9 lifecycle fixture', 'active'
from t_ids t;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-000000000002', true);

-- The recipient's own address is s9-life-recipient@example.test, which is NOT the gift's
-- recipient_email: the token is the authorization (spec 7.3), never an address match.
select results_eq(
  $$select book_id, title, already_owned from public.claim_gift('s9-life-token-one') order by book_id$$,
  $$values ('e2000000-0000-0000-0000-000000000001'::uuid, 'Lifecycle One'::text, false),
           ('e2000000-0000-0000-0000-000000000002'::uuid, 'Lifecycle Two'::text, false)$$,
  'the claimant receives every book of the order, none of them already owned');

reset role;
select is(
  (select count(*) from public.entitlements e
   where e.source_order_id = 'e8000000-0000-0000-0000-000000000001'
     and e.profile_id = (select recipient_id from t_ids)
     and e.source_type = 'simulated_payment' and e.status = 'active'),
  2::bigint, 'the claimant holds both books, sourced from the paid order and its provider');
select is(
  (select count(*) from public.library_items l
   where l.profile_id = (select recipient_id from t_ids)
     and l.book_id in ('e2000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000002')),
  2::bigint, 'both books are in the claimant''s library');
select is(
  (select g.status || '|' || (g.claimed_by_profile_id = (select recipient_id from t_ids))::text
          || '|' || (g.claimed_at is not null)::text
   from public.gifts g where g.order_id = 'e8000000-0000-0000-0000-000000000001'),
  'claimed|true|true', 'the gift records who claimed it and when');
select is(
  (select o.payload from public.notification_outbox o
   join public.gifts g on g.id = o.gift_id
   where g.order_id = 'e8000000-0000-0000-0000-000000000001'),
  null, 'the claim clears the outbox payload, so the raw claim path is no longer retained');

-- The same reader again: the same answer, and not one new row.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-000000000002', true);
select results_eq(
  $$select book_id, title, already_owned from public.claim_gift('s9-life-token-one') order by book_id$$,
  $$values ('e2000000-0000-0000-0000-000000000001'::uuid, 'Lifecycle One'::text, false),
           ('e2000000-0000-0000-0000-000000000002'::uuid, 'Lifecycle Two'::text, false)$$,
  'the same reader claiming again gets the same answer');
reset role;
select is(
  (select count(*) from public.entitlements e
   where e.profile_id = (select recipient_id from t_ids)),
  2::bigint, 'the repeat claim writes no second entitlement');

-- Every other outcome is one indistinguishable refusal.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-000000000003', true);
select throws_ok(
  $$select public.claim_gift('s9-life-token-one')$$,
  'EB029', null, 'a second, different reader cannot claim a gift somebody else already took');
select throws_ok(
  $$select public.claim_gift('s9-life-token-that-never-existed')$$,
  'EB029', null, 'an unknown token is refused with the same error');
select throws_ok(
  $$select public.claim_gift('s9-life-token-two')$$,
  'EB029', null, 'a gift whose order was never completed cannot be claimed');

-- Partial ownership, and the free_order source a zero-total order grants under.
select results_eq(
  $$select book_id, already_owned from public.claim_gift('s9-life-token-four') order by book_id$$,
  $$values ('e2000000-0000-0000-0000-000000000001'::uuid, true),
           ('e2000000-0000-0000-0000-000000000002'::uuid, false)$$,
  'a claimant who already owns one member book is told so, and gets the rest');
reset role;
select is(
  (select e.source_type::text from public.entitlements e
   where e.source_order_id = 'e8000000-0000-0000-0000-000000000004'
     and e.profile_id = (select other_id from t_ids)),
  'free_order', 'a gift order that cost nothing grants under free_order');
select is(
  (select e.id from public.entitlements e
   where e.profile_id = (select other_id from t_ids)
     and e.book_id = 'e2000000-0000-0000-0000-000000000001' and e.status = 'active'),
  'ea000000-0000-0000-0000-000000000001'::uuid,
  'the book the claimant already owned keeps the entitlement it already had');

-- A revoked gift is refused like any other non-claimable one.
update public.gifts set status = 'revoked', revoked_at = now(), revoked_reason = 'test'
where order_id = 'e8000000-0000-0000-0000-000000000006';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-000000000003', true);
select throws_ok(
  $$select public.claim_gift('s9-life-token-six')$$,
  'EB029', null, 'a revoked gift cannot be claimed');
reset role;

-- ==========================================================================================
-- Two real concurrent sessions claim one token (49-52).
--
-- Everything above runs in this one transaction, which rolls back. A race cannot: the second
-- session has to SEE the gift the first session is locking, so the fixtures below are committed
-- from a separate connection and deleted from it again at the end. dblink is created here rather
-- than in a migration because it exists for this test alone.
--
-- The interleaving is staged, not hoped for: session one opens a transaction and claims, and is
-- then held open; session two's claim is sent asynchronously and asserted to be BLOCKED; only
-- then does session one commit, and session two's refusal is read back.
-- ==========================================================================================
create extension if not exists dblink with schema extensions;

create function pg_temp.await_idle(p_conn text) returns void language plpgsql as $$
begin
  for i in 1..400 loop
    exit when extensions.dblink_is_busy(p_conn) = 0;
    perform pg_sleep(0.05);
  end loop;
end;
$$;

-- The loser's refusal has to be read back as a value rather than raised, because it arrives in the
-- middle of this transaction. dblink re-raises the remote SQLSTATE, which is the thing under test.
create function pg_temp.result_sqlstate(p_conn text) returns text language plpgsql as $$
declare
  v_count int;
  v_state text;
begin
  select t.n into v_count from extensions.dblink_get_result(p_conn) as t(n int);
  -- The async protocol hands back one result per call and is only finished when a call comes back
  -- empty. Leaving that terminator unread would leave the connection mid-command, and the next
  -- statement on it fails with "another command is already in progress" rather than with anything
  -- about gifts.
  perform 1 from extensions.dblink_get_result(p_conn) as t(n int);
  return 'ok:' || coalesce(v_count::text, 'null');
exception when others then
  v_state := sqlstate;
  begin
    perform 1 from extensions.dblink_get_result(p_conn) as t(n int);
  exception when others then
    null;
  end;
  return v_state;
end;
$$;

-- Catalog writes are audited, and audit_logs refuses every delete and update by design, so an
-- audit row committed here would outlive this file and fail 002_access_admin_rls.sql - which counts
-- the table - on the NEXT run against the same database. session_replication_role suppresses the
-- trigger for the one statement and is restored immediately; it is a session setting, so a
-- connection that dies mid-way takes it with it rather than leaving the audit trail off.
create function pg_temp.uncatalogued(p_conn text, p_sql text) returns void language plpgsql as $$
begin
  perform extensions.dblink_exec(p_conn, 'set session_replication_role = replica');
  begin
    perform extensions.dblink_exec(p_conn, p_sql);
  exception when others then
    perform extensions.dblink_exec(p_conn, 'set session_replication_role = origin');
    raise;
  end;
  perform extensions.dblink_exec(p_conn, 'set session_replication_role = origin');
end;
$$;

select extensions.dblink_connect('race_setup', 'host=db port=5432 dbname=postgres user=postgres password=postgres');
select extensions.dblink_connect('race_one', 'host=db port=5432 dbname=postgres user=postgres password=postgres');
select extensions.dblink_connect('race_two', 'host=db port=5432 dbname=postgres user=postgres password=postgres');

-- Committed fixtures outlive a run that fails before its cleanup, so the run starts by clearing
-- anything a previous one left behind. Without this a single failure makes every later run fail
-- on a duplicate key instead of on whatever actually broke.
select extensions.dblink_exec('race_setup', $stmt$delete from public.library_items where book_id = 'ec200000-0000-0000-0000-000000000001'$stmt$);
select extensions.dblink_exec('race_setup', $stmt$delete from public.entitlements where source_order_id = 'ec800000-0000-0000-0000-000000000001'$stmt$);
select extensions.dblink_exec('race_setup', $stmt$delete from public.gifts where id = 'ec900000-0000-0000-0000-000000000001'$stmt$);
select extensions.dblink_exec('race_setup', $stmt$delete from public.orders where id = 'ec800000-0000-0000-0000-000000000001'$stmt$);
select pg_temp.uncatalogued('race_setup', $stmt$delete from public.skus where id = 'ec500000-0000-0000-0000-000000000001'$stmt$);
select pg_temp.uncatalogued('race_setup', $stmt$delete from public.editions where id = 'ec400000-0000-0000-0000-000000000001'$stmt$);
select pg_temp.uncatalogued('race_setup', $stmt$delete from public.books where id = 'ec200000-0000-0000-0000-000000000001'$stmt$);
select pg_temp.uncatalogued('race_setup', $stmt$delete from public.authors where id = 'ec300000-0000-0000-0000-000000000001'$stmt$);
select extensions.dblink_exec('race_setup', $stmt$delete from auth.users where id in ('ec100000-0000-0000-0000-000000000001', 'ec100000-0000-0000-0000-000000000002', 'ec100000-0000-0000-0000-000000000003')$stmt$);

select extensions.dblink_exec('race_setup', $stmt$
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values
    ('00000000-0000-0000-0000-000000000000', 'ec100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's9-race-buyer@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', 'ec100000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's9-race-one@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', 'ec100000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 's9-race-two@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now())
$stmt$);
select pg_temp.uncatalogued('race_setup', $stmt$
  insert into public.authors (id, canonical_slug, display_name, status)
  values ('ec300000-0000-0000-0000-000000000001', 's9-race-author', 'S9 Race Author', 'published')
$stmt$);
select pg_temp.uncatalogued('race_setup', $stmt$
  insert into public.books (id, canonical_key, original_language, primary_author_id, status)
  values ('ec200000-0000-0000-0000-000000000001', 's9-race-book', 'vi', 'ec300000-0000-0000-0000-000000000001', 'published')
$stmt$);
select pg_temp.uncatalogued('race_setup', $stmt$
  insert into public.editions (id, book_id, language_code)
  values ('ec400000-0000-0000-0000-000000000001', 'ec200000-0000-0000-0000-000000000001', 'vi')
$stmt$);
select pg_temp.uncatalogued('race_setup', $stmt$
  insert into public.skus (id, edition_id, sku_code)
  values ('ec500000-0000-0000-0000-000000000001', 'ec400000-0000-0000-0000-000000000001', 's9-race-sku')
$stmt$);
select extensions.dblink_exec('race_setup', $stmt$
  insert into public.orders (id, profile_id, status, payment_status, market_code, currency,
                             subtotal_minor, discount_minor, total_minor, reference_code, payment_provider)
  select 'ec800000-0000-0000-0000-000000000001', p.id, 'completed', 'succeeded', 'VN', 'VND',
         150000, 0, 150000, 'IB-R0001', 'simulator'
  from public.profiles p where p.auth_user_id = 'ec100000-0000-0000-0000-000000000001'
$stmt$);
select extensions.dblink_exec('race_setup', $stmt$
  insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, position)
  values ('ec800000-0000-0000-0000-000000000001', 'ec500000-0000-0000-0000-000000000001',
          'ec200000-0000-0000-0000-000000000001', 'Race Book', 150000, 1)
$stmt$);
select extensions.dblink_exec('race_setup', $stmt$
  insert into public.gifts (id, order_id, purchaser_profile_id, recipient_email, claim_token_hash, status)
  select 'ec900000-0000-0000-0000-000000000001', 'ec800000-0000-0000-0000-000000000001', p.id,
         's9-race-recipient@example.test',
         encode(extensions.digest(convert_to('s9-race-token', 'UTF8'), 'sha256'), 'hex'), 'sent'
  from public.profiles p where p.auth_user_id = 'ec100000-0000-0000-0000-000000000001'
$stmt$);
select extensions.dblink_exec('race_setup', $stmt$
  insert into public.notification_outbox (gift_id, template_key, payload)
  values ('ec900000-0000-0000-0000-000000000001', 'gift_claim', '{"claimPath": "/vi/gifts/claim/s9-race-token"}'::jsonb)
$stmt$);

-- Session one: an open transaction that has taken the gift row lock and claimed.
select extensions.dblink_exec('race_one', 'begin');
select extensions.dblink_exec('race_one', 'set local role authenticated');
select extensions.dblink_exec('race_one', 'set local "request.jwt.claim.sub" = ''ec100000-0000-0000-0000-000000000002''');
select extensions.dblink_send_query('race_one', 'select count(*)::int from public.claim_gift(''s9-race-token'')');
select pg_temp.await_idle('race_one');
select is(pg_temp.result_sqlstate('race_one'), 'ok:1',
  'the first session claims the single book of the gift and holds its transaction open');

-- Session two, sent while session one still holds the lock.
select extensions.dblink_exec('race_two', 'begin');
select extensions.dblink_exec('race_two', 'set local role authenticated');
select extensions.dblink_exec('race_two', 'set local "request.jwt.claim.sub" = ''ec100000-0000-0000-0000-000000000003''');
select extensions.dblink_send_query('race_two', 'select count(*)::int from public.claim_gift(''s9-race-token'')');
select pg_sleep(1);
select is(extensions.dblink_is_busy('race_two'), 1,
  'the second session is genuinely blocked on the gift row lock, not racing past it');

select extensions.dblink_exec('race_one', 'commit');
select pg_temp.await_idle('race_two');
select is(pg_temp.result_sqlstate('race_two'), 'EB029',
  'the loser is refused with the one uniform claim error');
select extensions.dblink_exec('race_two', 'rollback');

select is(
  (select (g.claimed_by_profile_id = p.id)::text || '|' || g.status || '|' ||
          (select count(*) from public.entitlements e
           where e.source_order_id = 'ec800000-0000-0000-0000-000000000001' and e.status = 'active')::text
   from public.gifts g
   join public.profiles p on p.auth_user_id = 'ec100000-0000-0000-0000-000000000002'
   where g.id = 'ec900000-0000-0000-0000-000000000001'),
  'true|claimed|1',
  'exactly one claimant owns the gift and the single entitlement it sourced');

-- Committed fixtures are committed: this transaction's rollback will not take them with it.
select extensions.dblink_exec('race_setup', $stmt$delete from public.library_items where book_id = 'ec200000-0000-0000-0000-000000000001'$stmt$);
select extensions.dblink_exec('race_setup', $stmt$delete from public.entitlements where source_order_id = 'ec800000-0000-0000-0000-000000000001'$stmt$);
select extensions.dblink_exec('race_setup', $stmt$delete from public.gifts where id = 'ec900000-0000-0000-0000-000000000001'$stmt$);
select extensions.dblink_exec('race_setup', $stmt$delete from public.orders where id = 'ec800000-0000-0000-0000-000000000001'$stmt$);
select pg_temp.uncatalogued('race_setup', $stmt$delete from public.skus where id = 'ec500000-0000-0000-0000-000000000001'$stmt$);
select pg_temp.uncatalogued('race_setup', $stmt$delete from public.editions where id = 'ec400000-0000-0000-0000-000000000001'$stmt$);
select pg_temp.uncatalogued('race_setup', $stmt$delete from public.books where id = 'ec200000-0000-0000-0000-000000000001'$stmt$);
select pg_temp.uncatalogued('race_setup', $stmt$delete from public.authors where id = 'ec300000-0000-0000-0000-000000000001'$stmt$);
select extensions.dblink_exec('race_setup', $stmt$delete from auth.users where id in ('ec100000-0000-0000-0000-000000000001', 'ec100000-0000-0000-0000-000000000002', 'ec100000-0000-0000-0000-000000000003')$stmt$);

select extensions.dblink_disconnect('race_one');
select extensions.dblink_disconnect('race_two');
select extensions.dblink_disconnect('race_setup');

select * from finish();
rollback;
