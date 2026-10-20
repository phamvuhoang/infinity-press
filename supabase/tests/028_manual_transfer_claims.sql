begin;
select plan(17);

-- S7: claim_manual_transfer, the reader's "I have transferred" report (spec 5.5).

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's7-claim-a@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's7-claim-b@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = '91000000-0000-0000-0000-000000000001') as reader_a,
  (select id from public.profiles where auth_user_id = '91000000-0000-0000-0000-000000000002') as reader_b;
grant select on t_ids to public;

-- Captured as the reader inserts it, so "claimed_at did not move" is compared against the value
-- the first report actually wrote rather than against now().
create temporary table t_claim (label text primary key, claimed_at timestamptz not null);
grant select, insert on t_claim to public;

insert into public.authors (id, canonical_slug, display_name) values ('93000000-0000-0000-0000-000000000001', 's7-claim-author', 'S7 Claim Author');
insert into public.books (id, canonical_key, original_language, primary_author_id) values ('92000000-0000-0000-0000-000000000001', 's7-claim-book', 'vi', '93000000-0000-0000-0000-000000000001');
insert into public.editions (id, book_id, language_code) values ('94000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000001', 'vi');
insert into public.skus (id, edition_id, sku_code) values ('95000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000001', 's7-claim-sku');

-- O1 pending manual (claimable), O2 completed (not claimable).
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor, payment_provider)
select o.id::uuid, t_ids.reader_a, o.status::public.order_status, o.pay::public.payment_status, 'VN', 'VND', 129000, 'manual'
from t_ids, (values
  ('96000000-0000-0000-0000-000000000001', 'pending', 'pending'),
  ('96000000-0000-0000-0000-000000000002', 'completed', 'succeeded')
) as o(id, status, pay);

insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, quantity)
select o.id::uuid, '95000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000001', 'S7 Claim Book', 129000, 1
from (values ('96000000-0000-0000-0000-000000000001'), ('96000000-0000-0000-0000-000000000002')) as o(id);

insert into public.payments (order_id, provider, status, amount_minor, currency)
values
  ('96000000-0000-0000-0000-000000000001', 'manual', 'pending', 129000, 'VND'),
  ('96000000-0000-0000-0000-000000000002', 'manual', 'succeeded', 129000, 'VND');

-- Reader A owns O1.
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-0000-0000-000000000001', true);

select lives_ok(
  $$select public.claim_manual_transfer('96000000-0000-0000-0000-000000000001', 'chuyen luc 10h')$$,
  'the owner can report a transfer on a pending manual order');
select is(
  (select count(*) from public.manual_transfer_claims where order_id = '96000000-0000-0000-0000-000000000001'),
  1::bigint, 'reporting once writes one claim');

-- A second report is not a second claim, but it is a second note. A reader who transfers again
-- after a decline, or who simply presses the button again to tell us something, explains it in the
-- note; `on conflict do nothing` threw that away and nobody could see it had happened.
insert into t_claim
select 'first', c.claimed_at from public.manual_transfer_claims c
where c.order_id = '96000000-0000-0000-0000-000000000001';

select lives_ok(
  $$select public.claim_manual_transfer('96000000-0000-0000-0000-000000000001', 'chuyen lai luc 14h')$$,
  'the reader can report again with a new note');
select is(
  (select c.note from public.manual_transfer_claims c where c.order_id = '96000000-0000-0000-0000-000000000001'),
  'chuyen lai luc 14h',
  'a repeat report keeps the note the reader just wrote');
select is(
  (select c.claimed_at from public.manual_transfer_claims c where c.order_id = '96000000-0000-0000-0000-000000000001'),
  (select t.claimed_at from t_claim t where t.label = 'first'),
  'and leaves claimed_at on the first report, so the review queue keeps its order');

select lives_ok(
  $$select public.claim_manual_transfer('96000000-0000-0000-0000-000000000001', null)$$,
  'reporting twice does not raise');
select is(
  (select count(*) from public.manual_transfer_claims where order_id = '96000000-0000-0000-0000-000000000001'),
  1::bigint, 'reporting twice still leaves one claim');
select throws_ok(
  $$select public.claim_manual_transfer('96000000-0000-0000-0000-000000000002', null)$$,
  'EB020', null, 'a completed order cannot be claimed');
select is(
  (select count(*) from public.manual_transfer_claims), 1::bigint,
  'the owner reads their own claim');

-- Reader B owns nothing here.
select set_config('request.jwt.claim.sub', '91000000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$select public.claim_manual_transfer('96000000-0000-0000-0000-000000000001', null)$$,
  'EB020', null, 'another reader cannot claim an order they do not own');
select is(
  (select count(*) from public.manual_transfer_claims), 0::bigint,
  'another reader cannot read the claim either');
-- authenticated has RLS enabled with select-only policies, so an attempt-based test here would
-- pass on RLS default-deny alone whether or not the grant itself is revoked. has_table_privilege
-- proves the grant is absent directly, independent of RLS.
select is(has_table_privilege('authenticated', 'public.manual_transfer_claims', 'insert'), false, 'authenticated cannot insert into manual_transfer_claims');
select is(has_table_privilege('authenticated', 'public.manual_transfer_claims', 'update'), false, 'authenticated cannot update manual_transfer_claims');
select is(has_table_privilege('authenticated', 'public.manual_transfer_claims', 'delete'), false, 'authenticated cannot delete from manual_transfer_claims');

reset role;
-- service_role bypasses RLS (BYPASSRLS), so a direct write attempt here is unambiguous proof of
-- the grant's absence, not RLS default-deny. It reaches the table only through
-- claim_manual_transfer's security definer.
set local role service_role;
select throws_ok(
  $$insert into public.manual_transfer_claims (order_id, profile_id)
    values ('96000000-0000-0000-0000-000000000001', (select reader_b from t_ids))$$,
  '42501', null, 'service_role cannot insert into manual_transfer_claims directly');
select throws_ok(
  $$update public.manual_transfer_claims set note = 'x' where order_id = '96000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'service_role cannot update manual_transfer_claims directly');
select throws_ok(
  $$delete from public.manual_transfer_claims where order_id = '96000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'service_role cannot delete from manual_transfer_claims directly');
reset role;

select * from finish();
rollback;
