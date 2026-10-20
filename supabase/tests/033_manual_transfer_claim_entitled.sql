begin;
select plan(6);

-- S7 PR fix C2: claim_manual_transfer refuses an order for a book the reader already owns (EB017).
--
-- An entitlement can arrive from somewhere else at any point after the order was created - an
-- admin grant, a free offer, another order for the same book - and nothing about it touches this
-- order, which stays pending. The reader's pages now send such a reader to "you already own this
-- book" instead of the bank details, and this is the layer a direct PostgREST call reaches.
--
-- The order is NOT cancelled by this refusal, deliberately (ruling R33): the reader may already
-- have transferred against it, and a cancelled order with no record of their intent is a worse
-- place for their money to land than a pending one an admin closes.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's7-claim-owned-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's7-claim-owned-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = 'e1000000-0000-0000-0000-000000000001') as admin_id,
  (select id from public.profiles where auth_user_id = 'e1000000-0000-0000-0000-000000000002') as reader_id;
grant select on t_ids to public;

insert into public.user_roles (profile_id, role) select admin_id, 'admin' from t_ids;

-- The reader's email has to be verified: grant_complimentary_entitlement refuses an unverified
-- identity (EB007), and the grant below is made through that RPC rather than by hand so the
-- entitlement this test blocks on is one the product can actually produce.
update public.customer_identities set verified_at = now()
where profile_id = (select reader_id from t_ids);

insert into public.authors (id, canonical_slug, display_name)
values ('e3000000-0000-0000-0000-000000000001', 's7-claim-owned-author', 'S7 Claim Owned Author');

-- Two books: one the reader is granted, one they are not. The second is the control that keeps
-- this test honest - without it, an EB017 raised for every order would still pass.
insert into public.books (id, canonical_key, original_language, primary_author_id)
select ('e2000000-0000-0000-0000-00000000000' || n)::uuid, 's7-claim-owned-book-' || n, 'vi', 'e3000000-0000-0000-0000-000000000001'
from generate_series(1, 2) as n;
insert into public.editions (id, book_id, language_code)
select ('e4000000-0000-0000-0000-00000000000' || n)::uuid, ('e2000000-0000-0000-0000-00000000000' || n)::uuid, 'vi'
from generate_series(1, 2) as n;
insert into public.skus (id, edition_id, sku_code)
select ('e5000000-0000-0000-0000-00000000000' || n)::uuid, ('e4000000-0000-0000-0000-00000000000' || n)::uuid, 's7-claim-owned-sku-' || n
from generate_series(1, 2) as n;

insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor, payment_provider)
select ('e6000000-0000-0000-0000-00000000000' || n)::uuid, t_ids.reader_id, 'pending', 'pending', 'VN', 'VND', 129000, 'manual'
from t_ids, generate_series(1, 2) as n;

insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, quantity)
select ('e6000000-0000-0000-0000-00000000000' || n)::uuid, ('e5000000-0000-0000-0000-00000000000' || n)::uuid,
       ('e2000000-0000-0000-0000-00000000000' || n)::uuid, 'S7 Claim Owned Book ' || n, 129000, 1
from generate_series(1, 2) as n;

insert into public.payments (order_id, provider, status, amount_minor, currency)
select ('e6000000-0000-0000-0000-00000000000' || n)::uuid, 'manual', 'pending', 129000, 'VND'
from generate_series(1, 2) as n;

-- The admin grants book 1 to the reader, after both orders already exist - exactly the sequence
-- the finding describes.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-000000000001', true);
select public.grant_complimentary_entitlement(
  (select reader_id from t_ids), 'e2000000-0000-0000-0000-000000000001', 'launch giveaway');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-000000000002', true);

-- (1-2) The refusal, and the order it leaves alone.
select throws_ok(
  $$select public.claim_manual_transfer('e6000000-0000-0000-0000-000000000001', 'da chuyen khoan')$$,
  'EB017',
  null,
  'a reader who already owns the book cannot report a transfer for it');
select is(
  (select count(*) from public.manual_transfer_claims where order_id = 'e6000000-0000-0000-0000-000000000001'),
  0::bigint,
  'the refused report wrote no claim');

-- (3) The control: the same reader, the same moment, a book they do not own.
select lives_ok(
  $$select public.claim_manual_transfer('e6000000-0000-0000-0000-000000000002', 'da chuyen khoan')$$,
  'the same reader can still report a transfer for a book they do not own');
reset role;

-- (4) And the order the refusal touched is still pending, so an admin can still record money that
-- did arrive against it (ruling R33: block and inform, never auto-cancel).
select is(
  (select o.status::text from public.orders o where o.id = 'e6000000-0000-0000-0000-000000000001'),
  'pending',
  'the refusal left the order pending rather than cancelling it');

-- (5-6) A revoked entitlement is not ownership: the reader can report again once access is gone,
-- which is what keeps this guard from stranding an order after a refund or a revocation.
-- Revoked through the RPC an admin actually uses, so the row this assertion depends on is one the
-- product produces rather than a hand-set status.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-000000000001', true);
select public.revoke_complimentary_entitlement(
  (select reader_id from t_ids),
  (select e.id from public.entitlements e
   where e.profile_id = (select reader_id from t_ids)
     and e.book_id = 'e2000000-0000-0000-0000-000000000001' and e.status = 'active'),
  'reader changed their mind');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-000000000002', true);
select lives_ok(
  $$select public.claim_manual_transfer('e6000000-0000-0000-0000-000000000001', 'da chuyen khoan')$$,
  'a revoked entitlement is not ownership, so the reader can report again');
select is(
  (select count(*) from public.manual_transfer_claims where order_id = 'e6000000-0000-0000-0000-000000000001'),
  1::bigint,
  'and that report is written');
reset role;

select * from finish();
rollback;
