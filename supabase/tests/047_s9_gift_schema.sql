begin;
select plan(61);

-- S9: the gift schema and the gift-capable notification outbox
-- (docs/superpowers/specs/2026-09-21-s9-bundles-and-gifts-design.md 7.1).
--
-- Three identities, the house pattern from 034_s8_coupon_schema.sql and 043_s9_bundle_schema.sql:
-- the purchaser, a second unrelated reader, and an admin. Without reader B every visibility
-- assertion below would pass even if the safe view selected every row; without the admin the
-- purchaser-scoped assertions could not be told apart from "hidden from everyone".
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's9-gift-purchaser@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's9-gift-reader-b@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 's9-gift-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

-- Resolved as the connecting role: profiles RLS would hide the other readers after a role switch.
create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = 'd1000000-0000-0000-0000-000000000001') as purchaser_id,
  (select id from public.profiles where auth_user_id = 'd1000000-0000-0000-0000-000000000002') as reader_b_id,
  (select id from public.profiles where auth_user_id = 'd1000000-0000-0000-0000-000000000003') as admin_id;
grant select on t_ids to public;

insert into public.user_roles (profile_id, role) select admin_id, 'admin' from t_ids;

insert into public.authors (id, canonical_slug, display_name, status)
values ('d3000000-0000-0000-0000-000000000001', 's9-gift-author', 'S9 Gift Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values ('d2000000-0000-0000-0000-000000000001', 's9-gift-book-1', 'vi', 'd3000000-0000-0000-0000-000000000001', 'published');
insert into public.editions (id, book_id, language_code) values ('d2e00000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-000000000001', 'vi');

-- An ordinary entitlement, which the S5 trigger turns into exactly one book_ready outbox row. It
-- is the control for every outbox assertion below: whatever gifts do, this row must keep behaving
-- exactly as 021_s5_observability_outbox.sql says it does.
insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason, status)
select 'da000000-0000-0000-0000-000000000001', t_ids.purchaser_id, 'd2000000-0000-0000-0000-000000000001',
       'admin_grant', t_ids.admin_id, 'S9 gift fixture', 'active'
from t_ids;

-- Two orders for the purchaser: the gift order, and a second one that exists only so the
-- uniqueness assertions have a legal order to aim at. A third belongs to reader B.
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor)
select ('d8000000-0000-0000-0000-00000000000' || n)::uuid, t_ids.purchaser_id, 'pending', 'pending', 'VN', 'VND', 199000
from t_ids, generate_series(1, 2) as n;
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor)
select 'd8000000-0000-0000-0000-000000000003', t_ids.reader_b_id, 'pending', 'pending', 'VN', 'VND', 99000
from t_ids;

-- 64 lower-case hex characters: the shape hashGiftToken() and Postgres `encode(digest(...),'hex')`
-- both produce. A raw base64url token could never satisfy it.
insert into public.gifts (id, order_id, purchaser_profile_id, recipient_email, message, claim_token_hash, status)
select 'd9000000-0000-0000-0000-000000000001', 'd8000000-0000-0000-0000-000000000001', t_ids.purchaser_id,
       'recipient@example.test', 'Chúc mừng sinh nhật!', repeat('a', 64), 'pending'
from t_ids;

-- A second gift, bought by reader B. Two gifts owned by two different purchasers is what makes the
-- admin assertion below mean anything (with one gift, `count(*) = 1` passes even for a view that
-- shows everyone everything) and what gives the security-barrier probe a row the prober may not
-- see. Its recipient address deliberately does NOT start with 'recipient', so a predicate on that
-- prefix discriminates purely on the other purchaser's data.
insert into public.gifts (id, order_id, purchaser_profile_id, recipient_email, claim_token_hash, status)
select 'd9000000-0000-0000-0000-000000000002', 'd8000000-0000-0000-0000-000000000003', t_ids.reader_b_id,
       'second-recipient@example.test', repeat('c', 64), 'pending'
from t_ids;

-- Shape -------------------------------------------------------------------------------------------
select has_table('public', 'gifts', 'gifts exists');
select col_is_pk('public', 'gifts', 'id', 'gifts is keyed by id');
select col_is_unique('public', 'gifts', 'order_id', 'an order carries at most one gift');
select col_is_unique('public', 'gifts', 'claim_token_hash', 'a claim token hash identifies one gift');
select col_not_null('public', 'gifts', 'recipient_email', 'a gift always names a recipient address');
select col_not_null('public', 'gifts', 'claim_token_hash', 'a gift always carries a token hash');
select col_is_null('public', 'gifts', 'claimed_by_profile_id', 'an unclaimed gift has no claimant');
select col_is_null('public', 'gifts', 'message', 'the gift message is optional');

-- Column-level rules --------------------------------------------------------------------------------
select throws_ok(
  $$insert into public.gifts (order_id, purchaser_profile_id, recipient_email, claim_token_hash, status)
    select 'd8000000-0000-0000-0000-000000000002', purchaser_id, 'Recipient@Example.test', repeat('b', 64), 'pending' from t_ids$$,
  '23514', null, 'a recipient address that is not normalized lower-case is refused');
select throws_ok(
  $$insert into public.gifts (order_id, purchaser_profile_id, recipient_email, claim_token_hash, status)
    select 'd8000000-0000-0000-0000-000000000002', purchaser_id, '  spaced@example.test  ', repeat('b', 64), 'pending' from t_ids$$,
  '23514', null, 'a recipient address with surrounding whitespace is refused');
select throws_ok(
  $$insert into public.gifts (order_id, purchaser_profile_id, recipient_email, message, claim_token_hash, status)
    select 'd8000000-0000-0000-0000-000000000002', purchaser_id, 'b@example.test', repeat('m', 501), repeat('b', 64), 'pending' from t_ids$$,
  '23514', null, 'a message over 500 characters is refused');
select throws_ok(
  $$insert into public.gifts (order_id, purchaser_profile_id, recipient_email, claim_token_hash, status)
    select 'd8000000-0000-0000-0000-000000000002', purchaser_id, 'b@example.test', 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'pending' from t_ids$$,
  '23514', null, 'a raw base64url token cannot be stored in the hash column');
select throws_ok(
  $$insert into public.gifts (order_id, purchaser_profile_id, recipient_email, claim_token_hash, status)
    select 'd8000000-0000-0000-0000-000000000002', purchaser_id, 'b@example.test', repeat('b', 64), 'delivered' from t_ids$$,
  '23514', null, 'a status outside pending|sent|claimed|revoked is refused');
select throws_ok(
  $$insert into public.gifts (order_id, purchaser_profile_id, recipient_email, claim_token_hash, status)
    select 'd8000000-0000-0000-0000-000000000002', purchaser_id, 'b@example.test', repeat('b', 64), 'claimed' from t_ids$$,
  '23514', null, 'a claimed gift without a claimant and a claim timestamp is refused');
select throws_ok(
  $$insert into public.gifts (order_id, purchaser_profile_id, recipient_email, claim_token_hash, status, claimed_at)
    select 'd8000000-0000-0000-0000-000000000002', purchaser_id, 'b@example.test', repeat('b', 64), 'claimed', now() from t_ids$$,
  '23514', null, 'a claimed gift with a timestamp but no claimant is still refused');
select throws_ok(
  $$insert into public.gifts (order_id, purchaser_profile_id, recipient_email, claim_token_hash, status)
    select 'd8000000-0000-0000-0000-000000000002', purchaser_id, 'b@example.test', repeat('b', 64), 'revoked' from t_ids$$,
  '23514', null, 'a revoked gift without a revoke timestamp is refused');
select throws_ok(
  $$insert into public.gifts (order_id, purchaser_profile_id, recipient_email, claim_token_hash, status, revoked_at, revoked_reason)
    select 'd8000000-0000-0000-0000-000000000002', purchaser_id, 'b@example.test', repeat('b', 64), 'revoked', now(), repeat('r', 501) from t_ids$$,
  '23514', null, 'an over-long revoke reason is refused');
select throws_ok(
  $$insert into public.gifts (order_id, purchaser_profile_id, recipient_email, claim_token_hash, status)
    select 'd8000000-0000-0000-0000-000000000001', purchaser_id, 'b@example.test', repeat('b', 64), 'pending' from t_ids$$,
  '23505', null, 'a second gift on the same order is refused');
select throws_ok(
  $$insert into public.gifts (order_id, purchaser_profile_id, recipient_email, claim_token_hash, status)
    select 'd8000000-0000-0000-0000-000000000002', purchaser_id, 'b@example.test', repeat('a', 64), 'pending' from t_ids$$,
  '23505', null, 'two gifts cannot share a claim token hash');
select lives_ok(
  $$update public.gifts set status = 'claimed', claimed_at = now(),
      claimed_by_profile_id = (select reader_b_id from t_ids)
    where id = 'd9000000-0000-0000-0000-000000000001'$$,
  'a claim that names both a claimant and a timestamp is accepted');

-- An order is the record of what was sold, so the gift cannot be orphaned by deleting it.
select throws_ok(
  $$delete from public.orders where id = 'd8000000-0000-0000-0000-000000000001'$$,
  '23503', null, 'an order with a gift cannot be deleted out from under it');

-- Back to the state the visibility and outbox assertions below expect.
update public.gifts set status = 'sent', claimed_at = null, claimed_by_profile_id = null
where id = 'd9000000-0000-0000-0000-000000000001';

-- The safe read: a view that has no hash column at all ----------------------------------------------
select has_view('public', 'gift_summaries', 'gift_summaries exists');
select hasnt_column('public', 'gift_summaries', 'claim_token_hash',
  'the safe view has no claim_token_hash column to leak');
select has_column('public', 'gift_summaries', 'recipient_email',
  'the safe view carries the fields the purchaser needs');

-- Visibility: the purchaser -------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-000000000001', true);
select is(
  (select count(*)::int from public.gift_summaries),
  1,
  'the purchaser reads their own gift and not reader B''s, though both exist');
select is(
  (select recipient_email from public.gift_summaries),
  'recipient@example.test',
  'the purchaser reads back the recipient address they entered');
select throws_ok(
  $$select claim_token_hash from public.gifts$$,
  '42501', null, 'the purchaser holds no privilege on the gifts table, so the hash is unreachable');
select throws_ok(
  $$insert into public.gift_summaries (order_id, purchaser_profile_id, recipient_email, status)
    values ('d8000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'x@example.test', 'pending')$$,
  '42501', null, 'the purchaser cannot write a gift through the safe view');
select throws_ok(
  $$update public.gift_summaries set status = 'claimed'$$,
  '42501', null, 'the purchaser cannot update a gift through the safe view');
reset role;

-- Visibility: an unrelated reader ---------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-000000000002', true);
select is(
  (select count(*)::int from public.gift_summaries),
  1,
  'a second reader sees only their own gift');
select is(
  (select count(*)::int from public.gift_summaries where order_id = 'd8000000-0000-0000-0000-000000000001'),
  0,
  'a second reader never sees the other purchaser''s gift, nor the one addressed to them');
select is(
  (select recipient_email from public.gift_summaries),
  'second-recipient@example.test',
  'the only address a second reader can read is the one on their own gift');
select throws_ok(
  $$select 1 from public.gifts$$,
  '42501', null, 'a second reader holds no select privilege on the gifts table');

-- The security-barrier probe. An ordinary `count(*) = 0` select would pass even against a leaky
-- view, because a leaky view still FILTERS correctly - what it leaks is what the planner learns
-- while filtering. This is the shape that actually discriminates: a caller-supplied qual that
-- raises division by zero for, and only for, a row this caller may not see. Without
-- `security_barrier = true` the planner orders it ahead of the view's own gate (is_admin() carries
-- a hashed subplan and costs more than anything a caller writes), the qual is evaluated against the
-- other purchaser's recipient_email, and the error itself answers the question. With the barrier
-- the gate runs first, that row never reaches the expression, and the caller's own row - whose
-- address does not match the prefix - comes back normally.
select lives_ok(
  $$select 1 from public.gift_summaries
    where (1 / case when recipient_email like 'recipient%' then 0 else 1 end) = 1$$,
  'an error-raising qual over another purchaser''s address raises nothing: the view is a security barrier');
select is(
  (select count(*)::int from public.gift_summaries
   where (1 / case when recipient_email like 'recipient%' then 0 else 1 end) = 1),
  1,
  'the barrier costs the reader nothing: their own row still satisfies the same qual');
reset role;

-- Visibility: an admin, then anon ------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-000000000003', true);
select is(
  (select count(*)::int from public.gift_summaries),
  2,
  'an admin reads every gift through the safe view, across purchasers');
select throws_ok(
  $$select 1 from public.gifts$$,
  '42501', null, 'an admin holds no select privilege on the gifts table either');
reset role;

set local role anon;
select throws_ok(
  $$select 1 from public.gift_summaries$$,
  '42501', null, 'anon cannot read the safe view');
reset role;

-- Grant posture, asserted as the elevated connecting role so every role's grants are visible.
select is_empty(
  $$select grantee, privilege_type from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'gifts'
      and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')$$,
  'no API role holds any privilege on gifts - every read goes through the view or a definer RPC');
select set_eq(
  $$select grantee::text, privilege_type::text from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'gift_summaries'
      and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')$$,
  $$values ('authenticated', 'SELECT')$$,
  'authenticated holds exactly SELECT on gift_summaries, and no other API role holds anything');

-- The outbox, now carrying gifts too -------------------------------------------------------------------
select has_column('public', 'notification_outbox', 'gift_id', 'the outbox can point at a gift');
select has_column('public', 'notification_outbox', 'payload', 'the outbox carries a protected payload');
select col_is_null('public', 'notification_outbox', 'entitlement_id',
  'entitlement_id is nullable now that a gift row has none');
select col_is_null('public', 'notification_outbox', 'profile_id',
  'profile_id is nullable now that a gift row has none');
select col_is_unique('public', 'notification_outbox', 'gift_id', 'a gift has at most one outbox row');

select throws_ok(
  $$insert into public.notification_outbox (template_key) values ('gift_claim')$$,
  '23514', null, 'an outbox row pointing at neither an entitlement nor a gift is refused');
select throws_ok(
  $$insert into public.notification_outbox (entitlement_id, profile_id, gift_id, template_key)
    select 'da000000-0000-0000-0000-000000000001', purchaser_id, 'd9000000-0000-0000-0000-000000000001', 'gift_claim'
    from t_ids$$,
  '23514', null, 'an outbox row pointing at both an entitlement and a gift is refused');
select throws_ok(
  $$insert into public.notification_outbox (gift_id, template_key)
    values ('d9000000-0000-0000-0000-000000000001', 'coupon_expiring')$$,
  '23514', null, 'a template key outside book_ready|gift_claim is refused');
-- profile_id became nullable for gifts only. A book row without a profile has no email address and
-- no locale to render with, so the guarantee the NOT NULL used to give must survive as a check.
select throws_ok(
  $$insert into public.notification_outbox (entitlement_id, template_key)
    values ('da000000-0000-0000-0000-000000000001', 'book_ready')$$,
  '23514', null, 'a book_ready row with no profile is refused, as it was when profile_id was NOT NULL');

insert into public.notification_outbox (gift_id, template_key, payload)
values ('d9000000-0000-0000-0000-000000000001', 'gift_claim', '{"claimPath": "/vi/gifts/claim/token"}'::jsonb);
select is(
  (select payload ->> 'claimPath' from public.notification_outbox where gift_id = 'd9000000-0000-0000-0000-000000000001'),
  '/vi/gifts/claim/token',
  'a gift outbox row carries the claim path in its payload');
select throws_ok(
  $$insert into public.notification_outbox (gift_id, template_key)
    values ('d9000000-0000-0000-0000-000000000001', 'gift_claim')$$,
  '23505', null, 'a second outbox row for the same gift is refused');

-- Claiming: a sent gift is claimable, and the book_ready row beside it is unaffected ------------------
set local role service_role;
create temporary table t_gift_claim as
select * from public.claim_notification_outbox(10, 'db000000-0000-0000-0000-000000000001');
reset role;
grant select on t_gift_claim to public;

select is(
  (select count(*)::int from t_gift_claim where gift_id = 'd9000000-0000-0000-0000-000000000001'),
  1,
  'a sent gift''s outbox row is claimable');
select is(
  (select payload ->> 'claimPath' from t_gift_claim where gift_id = 'd9000000-0000-0000-0000-000000000001'),
  '/vi/gifts/claim/token',
  'the claim hands the worker the protected payload it needs to build the email');
select results_eq(
  $$select entitlement_id, profile_id from t_gift_claim where gift_id = 'd9000000-0000-0000-0000-000000000001'$$,
  $$values (null::uuid, null::uuid)$$,
  'a gift row carries no entitlement and no profile');
select is(
  (select count(*)::int from t_gift_claim where entitlement_id = 'da000000-0000-0000-0000-000000000001'),
  1,
  'a book_ready row backed by an active entitlement is still claimed alongside it');
select results_eq(
  $$select gift_id, payload from t_gift_claim where entitlement_id = 'da000000-0000-0000-0000-000000000001'$$,
  $$values (null::uuid, null::jsonb)$$,
  'a book_ready row carries no gift and no payload');

-- A gift that has not been activated yet must never be delivered: 'pending' is the state
-- configure_gift leaves behind before the order is paid for.
update public.notification_outbox set lease_token = null, lease_expires_at = null, available_at = now()
where gift_id = 'd9000000-0000-0000-0000-000000000001';
update public.gifts set status = 'pending' where id = 'd9000000-0000-0000-0000-000000000001';

set local role service_role;
create temporary table t_pending_claim as
select * from public.claim_notification_outbox(10, 'db000000-0000-0000-0000-000000000002');
reset role;
grant select on t_pending_claim to public;

select is(
  (select count(*)::int from t_pending_claim where gift_id = 'd9000000-0000-0000-0000-000000000001'),
  0,
  'a pending gift''s outbox row is not claimable');
select is(
  (select lease_token from public.notification_outbox where gift_id = 'd9000000-0000-0000-0000-000000000001'),
  null,
  'the pending gift''s row is left unleased, so it consumes no attempt');

-- A claimed gift is finished: its row is not delivered again either.
update public.gifts set status = 'claimed', claimed_at = now(),
  claimed_by_profile_id = (select reader_b_id from t_ids)
where id = 'd9000000-0000-0000-0000-000000000001';

set local role service_role;
create temporary table t_claimed_claim as
select * from public.claim_notification_outbox(10, 'db000000-0000-0000-0000-000000000003');
reset role;
grant select on t_claimed_claim to public;

select is(
  (select count(*)::int from t_claimed_claim where gift_id = 'd9000000-0000-0000-0000-000000000001'),
  0,
  'a claimed gift''s outbox row is not delivered again');

-- Browser roles still cannot write the outbox, gift rows included.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$insert into public.notification_outbox (gift_id, template_key)
    values ('d9000000-0000-0000-0000-000000000001', 'gift_claim')$$,
  '42501', null, 'a reader cannot write a gift outbox row');
select throws_ok(
  $$update public.notification_outbox set payload = '{}'::jsonb$$,
  '42501', null, 'a reader cannot rewrite an outbox payload');
reset role;

select * from finish();
rollback;
