begin;
select plan(13);
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e1300000-0000-0000-0000-000000000031', 'authenticated', 'authenticated', 's13-qa-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e1300000-0000-0000-0000-000000000033', 'authenticated', 'authenticated', 's13-qa-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
update public.profiles set display_name = 'Bạn đọc S13' where auth_user_id = 'e1300000-0000-0000-0000-000000000031';
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'e1300000-0000-0000-0000-000000000033';

insert into public.authors (id, canonical_slug, display_name, status)
values ('e1330000-0000-0000-0000-000000000031', 's13-qa-author', 'S13 QA Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values ('e1320000-0000-0000-0000-000000000031', 's13-qa-book', 'vi', 'e1330000-0000-0000-0000-000000000031', 'published');
insert into public.book_localizations (book_id, locale, slug, title)
values ('e1320000-0000-0000-0000-000000000031', 'vi', 's13-qa-book', 'Sách S13 QA');

-- 31: the asked idea (published, related to the book). 32: an existing draft idea.
insert into public.ideas (id, status) values
  ('e1360000-0000-0000-0000-000000000031', 'published'),
  ('e1360000-0000-0000-0000-000000000032', 'draft');
insert into public.idea_localizations (idea_id, locale, slug, question, short_answer) values
  ('e1360000-0000-0000-0000-000000000031', 'vi', 's13-qa-asked', 'Ý tưởng được hỏi?', 'Trả lời ngắn'),
  ('e1360000-0000-0000-0000-000000000032', 'vi', 's13-qa-draft', 'Ý tưởng nháp?', 'Trả lời ngắn');
insert into public.idea_books (idea_id, book_id, position)
values ('e1360000-0000-0000-0000-000000000031', 'e1320000-0000-0000-0000-000000000031', 1);

-- The reader asks four questions, then each is pinned to a fixed id by its body.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000031', true);
select public.submit_reader_question('e1320000-0000-0000-0000-000000000031', null, 'Hỏi về sách?', 'vi');
select public.submit_reader_question(null, 'e1360000-0000-0000-0000-000000000031', 'Hỏi về ý tưởng?', 'vi');
select public.submit_reader_question('e1320000-0000-0000-0000-000000000031', null, 'Hỏi muộn?', 'vi');
select public.submit_reader_question('e1320000-0000-0000-0000-000000000031', null, 'Hỏi để lưu trữ?', 'vi');
reset role;
update public.reader_questions q set id = v.id::uuid
from (values
  ('Hỏi về sách?', 'e1370000-0000-0000-0000-000000000031'),     -- q_book
  ('Hỏi về ý tưởng?', 'e1370000-0000-0000-0000-000000000032'),  -- q_idea
  ('Hỏi muộn?', 'e1370000-0000-0000-0000-000000000033'),        -- q_late
  ('Hỏi để lưu trữ?', 'e1370000-0000-0000-0000-000000000034')   -- q_arch
) as v(body, id)
where q.body = v.body;


set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000033', true);
select public.admin_answer_question('e1370000-0000-0000-0000-000000000031', 'e1360000-0000-0000-0000-000000000031');
select public.admin_answer_question('e1370000-0000-0000-0000-000000000031', 'e1360000-0000-0000-0000-000000000032');
reset role;
select is((select payload->>'ideaId' from public.notification_outbox where question_id='e1370000-0000-0000-0000-000000000031'), 'e1360000-0000-0000-0000-000000000032', 'unsent email follows the replacement answer');
select is((select count(*)::int from public.claim_notification_outbox(25,'00000000-0000-0000-0000-00000000aaaa')), 0, 'draft replacement is not claimed or charged retry attempts');
update public.ideas set status='published' where id='e1360000-0000-0000-0000-000000000032';
select is((select count(*)::int from public.notification_outbox), 1, 'replacement publish keeps one outbox row');
select is((select payload->>'ideaId' from public.claim_notification_outbox(25,'00000000-0000-0000-0000-00000000aaaa')), 'e1360000-0000-0000-0000-000000000032', 'worker claims the replacement payload');
set local role authenticated;
select throws_ok($$select public.admin_answer_question('e1370000-0000-0000-0000-000000000031', 'e1360000-0000-0000-0000-000000000031')$$, 'EB037', null, 'an in-flight delivery prevents relinking');
reset role;
select is((select answer_idea_id::text from public.reader_questions where id='e1370000-0000-0000-0000-000000000031'), 'e1360000-0000-0000-0000-000000000032', 'refused relink preserves the answer');
-- A provider timeout may mean the message was accepted; fail clears the lease, not ambiguity.
select public.fail_notification_outbox(id,'00000000-0000-0000-0000-00000000aaaa','resend_timeout') from public.notification_outbox;
set local role authenticated;
select throws_ok($$select public.admin_answer_question('e1370000-0000-0000-0000-000000000031', 'e1360000-0000-0000-0000-000000000031')$$, 'EB037', null, 'an attempted notification stays frozen after an ambiguous failure');
reset role;
select is((select payload->>'ideaId' from public.notification_outbox), 'e1360000-0000-0000-0000-000000000032', 'retry retains the attempted payload and idempotency key');
-- The documented recovery procedure may reset retry counters; it must not unlock the payload.
update public.notification_outbox set attempt_count=0, last_error_code=null, available_at=now();
set local role authenticated;
select throws_ok($$select public.admin_answer_question('e1370000-0000-0000-0000-000000000031', 'e1360000-0000-0000-0000-000000000031')$$, 'EB037', null, 'operator retry reset cannot unlock an attempted payload');
reset role;
select public.claim_notification_outbox(25,'00000000-0000-0000-0000-00000000aaaa');
-- Even an expired lease can represent a provider-accepted message awaiting completion.
update public.notification_outbox set lease_expires_at=now()-interval '1 second';
set local role authenticated;
select throws_ok($$select public.admin_answer_question('e1370000-0000-0000-0000-000000000031', 'e1360000-0000-0000-0000-000000000031')$$, 'EB037', null, 'expired leases must be recovered by the worker before relinking');
reset role;
select public.claim_notification_outbox(25,'00000000-0000-0000-0000-00000000bbbb');
select public.complete_notification_outbox(id,'00000000-0000-0000-0000-00000000bbbb','test/s13') from public.notification_outbox;
set local role authenticated;
select lives_ok($$select public.admin_answer_question('e1370000-0000-0000-0000-000000000031', 'e1360000-0000-0000-0000-000000000031')$$, 'sent answers can be relinked without another email');
reset role;
select is((select count(*)::int from public.notification_outbox), 1, 'relink after delivery keeps exactly one email');
select is((select count(*)::int from public.claim_notification_outbox(25,'00000000-0000-0000-0000-00000000cccc')), 0, 'sent notification is never requeued');
select * from finish();
rollback;
