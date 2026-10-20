begin;
select plan(30);

-- S15 review reply email: one outbox row per distinct reply on a published review, queued by a
-- BEFORE UPDATE trigger; claimable only while the review is published with a reply; the admin
-- list reports when the email went out.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e1500000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's15-owner@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e1500000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's15-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
update public.profiles set display_name = 'Minh Anh' where auth_user_id = 'e1500000-0000-0000-0000-000000000001';
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'e1500000-0000-0000-0000-000000000002';

insert into public.authors (id, canonical_slug, display_name, status)
values ('e1530000-0000-0000-0000-000000000001', 's15-author', 'S15 Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values ('e1520000-0000-0000-0000-000000000001', 's15-book', 'vi', 'e1530000-0000-0000-0000-000000000001', 'published');
insert into public.book_localizations (book_id, locale, slug, title)
values ('e1520000-0000-0000-0000-000000000001', 'vi', 's15-book', 'Sách S15');
-- Press: every work has an edition, and access (hence a review) is per edition.
insert into public.editions (book_id, language_code)
select b.id, 'vi' from public.books b where not exists (select 1 from public.editions e where e.book_id = b.id);

insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason, status)
select 'e1540000-0000-0000-0000-000000000001', p.id, 'e1520000-0000-0000-0000-000000000001', 'admin_grant', p.id, 'fixture', 'active'
from public.profiles p where p.auth_user_id = 'e1500000-0000-0000-0000-000000000001';

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1500000-0000-0000-0000-000000000001', true);
select public.submit_book_review('e1520000-0000-0000-0000-000000000001', 5, 'Cuốn sách rất hay.', 'vi');
reset role;
update public.book_reviews set id = 'e1550000-0000-0000-0000-000000000001'
where book_id = 'e1520000-0000-0000-0000-000000000001';

create or replace function pg_temp.rows_for_review() returns bigint language sql as $$
  select count(*) from public.notification_outbox where review_id = 'e1550000-0000-0000-0000-000000000001';
$$;
create or replace function pg_temp.current_revision() returns bigint language sql as $$
  select revision from public.book_reviews where id = 'e1550000-0000-0000-0000-000000000001';
$$;

-- Schema -------------------------------------------------------------------------------------------
select has_column('public', 'book_reviews', 'author_reply_notified_text', 'notified-text column exists');
select has_column('public', 'notification_outbox', 'review_id', 'review_id target exists');
select is(has_table_privilege('service_role', 'public.book_reviews', 'select'), true, 'the worker can read reviews');

-- Reply on a pending review: nothing yet ---------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1500000-0000-0000-0000-000000000002', true);
select lives_ok($$select public.admin_reply_review('e1550000-0000-0000-0000-000000000001', 'Cảm ơn bạn đã đọc.')$$, 'admin replies while pending');
select is(pg_temp.rows_for_review(), 0::bigint, 'a reply on a pending review queues nothing');
select is((select author_reply_notified_text from public.book_reviews where id = 'e1550000-0000-0000-0000-000000000001'), null, 'nothing recorded as notified yet');

-- Publishing with a reply present mails once -----------------------------------------------------
select lives_ok($$select public.admin_moderate_review('e1550000-0000-0000-0000-000000000001', 'published', pg_temp.current_revision())$$, 'admin publishes');
select is(pg_temp.rows_for_review(), 1::bigint, 'publish queues exactly one row');
select results_eq(
  $$select o.template_key, o.profile_id, o.payload, o.entitlement_id, o.gift_id, o.question_id
    from public.notification_outbox o where o.review_id = 'e1550000-0000-0000-0000-000000000001'$$,
  $$select 'review_replied', r.profile_id, jsonb_build_object('bookId', r.book_id), null::uuid, null::uuid, null::uuid
    from public.book_reviews r where r.id = 'e1550000-0000-0000-0000-000000000001'$$,
  'the row is addressed to the reviewer with only the book id');
select is((select author_reply_notified_text from public.book_reviews where id = 'e1550000-0000-0000-0000-000000000001'), 'Cảm ơn bạn đã đọc.', 'the queued text is recorded');

-- Same text again: nothing. Different text while a row is unsent: still one row. -----------------
select lives_ok($$select public.admin_reply_review('e1550000-0000-0000-0000-000000000001', 'Cảm ơn bạn đã đọc.')$$, 'same reply saved again');
select is(pg_temp.rows_for_review(), 1::bigint, 'identical text does not queue again');
select lives_ok($$select public.admin_reply_review('e1550000-0000-0000-0000-000000000001', 'Cảm ơn bạn đã đọc kỹ.')$$, 'reply edited before delivery');
select is(pg_temp.rows_for_review(), 1::bigint, 'an unsent row is replaced rather than duplicated');
select is((select author_reply_notified_text from public.book_reviews where id = 'e1550000-0000-0000-0000-000000000001'), 'Cảm ơn bạn đã đọc kỹ.', 'the latest text is what is recorded');
reset role;

-- Claim: only while published with a reply --------------------------------------------------------
set local role service_role;
create temporary table t_claim as
select * from public.claim_notification_outbox(25, '00000000-0000-0000-0000-00000000bbbb');
reset role;
select results_eq(
  $$select review_id, template_key from t_claim where review_id = 'e1550000-0000-0000-0000-000000000001'$$,
  $$values ('e1550000-0000-0000-0000-000000000001'::uuid, 'review_replied')$$,
  'the claim returns the review row with its id');
-- Release the lease so the next claim can see the row again.
update public.notification_outbox set lease_token = null, lease_expires_at = null where review_id = 'e1550000-0000-0000-0000-000000000001';

-- A hidden book makes the review page 404, so its row waits, uncharged, until the book is back.
update public.books set status = 'draft' where id = 'e1520000-0000-0000-0000-000000000001';
set local role service_role;
select is((select count(*) from public.claim_notification_outbox(25, '00000000-0000-0000-0000-00000000dddd') c where c.review_id = 'e1550000-0000-0000-0000-000000000001'), 0::bigint, 'a row for a hidden book is not claimed');
reset role;
update public.notification_outbox set lease_token = null, lease_expires_at = null where review_id = 'e1550000-0000-0000-0000-000000000001';
update public.books set status = 'published' where id = 'e1520000-0000-0000-0000-000000000001';

-- A reader edit sends the review back to pending: the row is no longer claimable, and no new row.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1500000-0000-0000-0000-000000000001', true);
select public.submit_book_review('e1520000-0000-0000-0000-000000000001', 4, 'Cuốn sách rất hay, đọc lại vẫn hay.', 'vi');
reset role;
select is(pg_temp.rows_for_review(), 1::bigint, 'a reader edit queues nothing');
set local role service_role;
select is((select count(*) from public.claim_notification_outbox(25, '00000000-0000-0000-0000-00000000cccc') c where c.review_id = 'e1550000-0000-0000-0000-000000000001'), 0::bigint, 'a pending review''s row is not claimed');
reset role;

-- Republish after delivery: no second email -------------------------------------------------------
update public.notification_outbox set sent_at = now(), provider_message_id = 'test/x' where review_id = 'e1550000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1500000-0000-0000-0000-000000000002', true);
select lives_ok($$select public.admin_moderate_review('e1550000-0000-0000-0000-000000000001', 'published', pg_temp.current_revision())$$, 'admin republishes');
select is(pg_temp.rows_for_review(), 1::bigint, 'republishing an already-mailed reply queues nothing');

-- Clearing the reply: nothing. Admin list reports the sent time. ---------------------------------
select lives_ok($$select public.admin_reply_review('e1550000-0000-0000-0000-000000000001', '')$$, 'admin clears the reply');
select is(pg_temp.rows_for_review(), 1::bigint, 'clearing queues nothing');
select isnt(
  (select e ->> 'replyEmailedAt' from jsonb_array_elements(public.admin_list_reviews('published')) e where e ->> 'id' = 'e1550000-0000-0000-0000-000000000001'),
  null, 'the admin list carries the sent time');
reset role;

-- Only a row never handed to the worker is reused. A leased row may already be mid-send with the
-- old text, and an exhausted row is never claimed again; either way a new row carries the edit.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1500000-0000-0000-0000-000000000002', true);
select public.admin_reply_review('e1550000-0000-0000-0000-000000000001', 'Phản hồi mới.');
reset role;
select is(pg_temp.rows_for_review(), 2::bigint, 'a new reply after delivery queues a second row');
update public.notification_outbox set lease_token = gen_random_uuid(), lease_expires_at = now() + interval '5 minutes'
where review_id = 'e1550000-0000-0000-0000-000000000001' and sent_at is null;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1500000-0000-0000-0000-000000000002', true);
select public.admin_reply_review('e1550000-0000-0000-0000-000000000001', 'Phản hồi mới hơn.');
reset role;
select is(pg_temp.rows_for_review(), 3::bigint, 'an edit while a row is in flight queues a fresh row');
update public.notification_outbox set lease_token = null, lease_expires_at = null, attempt_count = 6
where review_id = 'e1550000-0000-0000-0000-000000000001' and sent_at is null;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1500000-0000-0000-0000-000000000002', true);
select public.admin_reply_review('e1550000-0000-0000-0000-000000000001', 'Lần nữa.');
reset role;
select is(
  (select count(*) from public.notification_outbox where review_id = 'e1550000-0000-0000-0000-000000000001' and sent_at is null and attempt_count = 0),
  1::bigint, 'an edit after the rows are exhausted queues a claimable row');
select is(pg_temp.rows_for_review(), 2::bigint, 'the exhausted rows are replaced, so no stuck finding outlives the edit');

-- Cascade and target check ------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1500000-0000-0000-0000-000000000001', true);
select public.delete_book_review('e1520000-0000-0000-0000-000000000001');
reset role;
select is((select count(*) from public.notification_outbox where review_id = 'e1550000-0000-0000-0000-000000000001'), 0::bigint, 'deleting the review removes its outbox rows');
select throws_ok(
  $$insert into public.notification_outbox (template_key, profile_id, review_id, entitlement_id)
    values ('review_replied', (select id from public.profiles where auth_user_id = 'e1500000-0000-0000-0000-000000000001'), 'e1550000-0000-0000-0000-000000000001', 'e1540000-0000-0000-0000-000000000001')$$,
  '23514', null, 'a row cannot point at two targets');

select * from finish();
rollback;
