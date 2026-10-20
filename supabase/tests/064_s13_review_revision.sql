begin;
select plan(7);
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

-- Press: every work has an edition, and access (hence a review) is per edition.
insert into public.editions (book_id, language_code)
select b.id, 'vi' from public.books b where not exists (select 1 from public.editions e where e.book_id = b.id);

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


create temporary table seen_review as select id, revision from public.book_reviews where id = 'e1350000-0000-0000-0000-000000000001';
grant select on seen_review to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000011', true);
select public.submit_book_review('e1320000-0000-0000-0000-000000000011', 1, 'Changed after admin opened the page', 'vi');
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000012', true);
select throws_ok($$select public.admin_moderate_review(id, 'published', revision) from seen_review$$, 'EB036', null, 'stale approval refuses the unseen edit');
select is((select status from public.book_reviews where id = 'e1350000-0000-0000-0000-000000000001'), 'pending', 'stale approval keeps the review pending');
select is((select count(*)::int from public.audit_logs where action = 'book_review.moderate'), 0, 'stale approval writes no audit');
select throws_ok($$select public.admin_moderate_review(id, 'published') from seen_review$$, 'EB036', null, 'old clients cannot bypass revision checks');
select lives_ok($$select public.admin_moderate_review(id, 'published', revision) from public.book_reviews where id = 'e1350000-0000-0000-0000-000000000001'$$, 'fresh approval succeeds');
select ok((public.admin_list_reviews('published')->0->>'revision')::bigint > (select revision from seen_review), 'admin list exposes the current revision');
reset role;
-- A signed-in stranger must use the same identity-free public RPC as anon.
insert into auth.users (id, email, raw_user_meta_data) values ('e1300000-0000-0000-0000-000000000013', 's13-stranger-revision@example.test', '{}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000013', true);
select is((select count(*)::int from public.book_reviews), 0, 'strangers cannot correlate published reviews by profile id');
select * from finish();
rollback;
