-- Clean legacy data plus one row the backfill cannot map: an admin grant on a book that has two
-- editions. The upgrade must stop and name that row.
\ir press-legacy-clean.sql
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('f3000000-0000-0000-0000-000000000002', 'legacy-multi', 'en', 'f2000000-0000-0000-0000-000000000001', 'published');
insert into public.editions (id, book_id, language_code) values
  ('f4000000-0000-0000-0000-000000000002', 'f3000000-0000-0000-0000-000000000002', 'en'),
  ('f4000000-0000-0000-0000-000000000003', 'f3000000-0000-0000-0000-000000000002', 'ja');
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'f1000000-0000-0000-0000-000000000001';
insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason)
select 'fa000000-0000-0000-0000-000000000099', id, 'f3000000-0000-0000-0000-000000000002', 'admin_grant', id, 'support grant'
from public.profiles where auth_user_id = 'f1000000-0000-0000-0000-000000000002';
