begin;
select plan(25);

-- S13 review moderation RPCs: is_admin() gate, status transitions, published_at set once,
-- reply clearing, one audit row per call.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e1300000-0000-0000-0000-000000000011', 'authenticated', 'authenticated', 's13-adm-owner@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e1300000-0000-0000-0000-000000000012', 'authenticated', 'authenticated', 's13-adm-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
update public.profiles set display_name = 'Minh Anh' where auth_user_id = 'e1300000-0000-0000-0000-000000000011';
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'e1300000-0000-0000-0000-000000000012';

insert into public.authors (id, canonical_slug, display_name, status)
values ('e1330000-0000-0000-0000-000000000011', 's13-adm-author', 'S13 Adm Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values ('e1320000-0000-0000-0000-000000000011', 's13-adm-book', 'vi', 'e1330000-0000-0000-0000-000000000011', 'published');
insert into public.book_localizations (book_id, locale, slug, title)
values ('e1320000-0000-0000-0000-000000000011', 'vi', 's13-adm-book', 'Sách S13 Admin');

insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason, status)
select 'e1340000-0000-0000-0000-000000000011', p.id, 'e1320000-0000-0000-0000-000000000011', 'admin_grant', p.id, 'fixture', 'active'
from public.profiles p where p.auth_user_id = 'e1300000-0000-0000-0000-000000000011';

-- One pending review submitted by the owner, then pinned to a fixed id.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000011', true);
select public.submit_book_review('e1320000-0000-0000-0000-000000000011', 5, 'Cuốn sách rất hay.', 'vi');
reset role;
update public.book_reviews set id = 'e1350000-0000-0000-0000-000000000001'
where book_id = 'e1320000-0000-0000-0000-000000000011';

-- Reader is refused -------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000011', true);
select throws_ok($$select public.admin_moderate_review('e1350000-0000-0000-0000-000000000001', 'published', (select revision from public.book_reviews where id = 'e1350000-0000-0000-0000-000000000001'))$$, '42501', null, 'a reader cannot moderate');
select throws_ok($$select public.admin_reply_review('e1350000-0000-0000-0000-000000000001', 'x')$$, '42501', null, 'a reader cannot reply');
select is(public.admin_list_reviews('pending'), null, 'a reader gets null from the admin list');

-- Admin ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000012', true);
select is(jsonb_array_length(public.admin_list_reviews('pending')), 1, 'admin lists pending reviews');
select is(public.admin_list_reviews('pending') -> 0 ->> 'bookTitle', 'Sách S13 Admin', 'list carries the localized book title');
select is(public.admin_list_reviews('pending') -> 0 ->> 'reviewerName', 'Minh Anh', 'list carries the reviewer name');
select lives_ok($$select public.admin_moderate_review('e1350000-0000-0000-0000-000000000001', 'published', (select revision from public.book_reviews where id = 'e1350000-0000-0000-0000-000000000001'))$$, 'admin publishes');
select isnt((select published_at from public.book_reviews where id = 'e1350000-0000-0000-0000-000000000001'), null, 'publish sets published_at');
select is(jsonb_array_length(public.admin_list_reviews('published')), 1, 'admin lists published reviews');
-- now() is frozen in this transaction, so backdate published_at to make "set once" observable.
reset role;
update public.book_reviews set published_at = '2000-01-01T00:00:00Z' where id = 'e1350000-0000-0000-0000-000000000001';
set local role authenticated;
select lives_ok($$select public.admin_moderate_review('e1350000-0000-0000-0000-000000000001', 'rejected', (select revision from public.book_reviews where id = 'e1350000-0000-0000-0000-000000000001'))$$, 'admin rejects');
select is((select published_at from public.book_reviews where id = 'e1350000-0000-0000-0000-000000000001'), '2000-01-01T00:00:00Z'::timestamptz, 'rejecting keeps published_at');
select lives_ok($$select public.admin_moderate_review('e1350000-0000-0000-0000-000000000001', 'published', (select revision from public.book_reviews where id = 'e1350000-0000-0000-0000-000000000001'))$$, 'admin republishes');
select is((select published_at from public.book_reviews where id = 'e1350000-0000-0000-0000-000000000001'), '2000-01-01T00:00:00Z'::timestamptz, 'republishing keeps the original published_at');
select throws_ok($$select public.admin_moderate_review('e1350000-0000-0000-0000-000000000001', 'deleted', (select revision from public.book_reviews where id = 'e1350000-0000-0000-0000-000000000001'))$$, '22023', null, 'an unknown status is refused');
select lives_ok($$select public.admin_reply_review('e1350000-0000-0000-0000-000000000001', 'Cảm ơn bạn đã đọc.')$$, 'admin replies');
select is((select author_reply from public.book_reviews where id = 'e1350000-0000-0000-0000-000000000001'), 'Cảm ơn bạn đã đọc.', 'reply stored');
select isnt((select author_reply_at from public.book_reviews where id = 'e1350000-0000-0000-0000-000000000001'), null, 'reply sets author_reply_at');
select lives_ok($$select public.admin_reply_review('e1350000-0000-0000-0000-000000000001', '  ')$$, 'a blank reply clears');
select is((select author_reply from public.book_reviews where id = 'e1350000-0000-0000-0000-000000000001'), null, 'reply cleared');
select is((select author_reply_at from public.book_reviews where id = 'e1350000-0000-0000-0000-000000000001'), null, 'clearing the reply clears author_reply_at');
select throws_ok($$select public.admin_reply_review('e1350000-0000-0000-0000-000000000001', '<i>x</i>')$$, '22023', null, 'html in a reply is refused');
-- now() is frozen inside the test transaction, so assert per-action counts, not created_at order.
select results_eq(
  $$select action, count(*)::int from public.audit_logs where entity_id = 'e1350000-0000-0000-0000-000000000001' group by action order by action$$,
  $$values ('book_review.moderate'::text, 3), ('book_review.reply'::text, 2)$$,
  'one audit row per successful call');
select throws_ok($$select public.admin_moderate_review('e1350000-0000-0000-0000-00000000ffff', 'published', (select revision from public.book_reviews where id = 'e1350000-0000-0000-0000-00000000ffff'))$$, 'P0002', null, 'missing review is P0002 on moderate');
select throws_ok($$select public.admin_reply_review('e1350000-0000-0000-0000-00000000ffff', 'x')$$, 'P0002', null, 'missing review is P0002 on reply');
reset role;

select is(
  (select count(*)::int from public.audit_logs a join public.profiles p on p.id = a.actor_profile_id
   where a.entity_id = 'e1350000-0000-0000-0000-000000000001' and p.auth_user_id = 'e1300000-0000-0000-0000-000000000012'),
  5, 'audit rows name the admin as actor');

select * from finish();
rollback;
