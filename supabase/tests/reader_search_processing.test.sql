begin;
select plan(15);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '98000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'reader-search-worker@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = '98000000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name) values
  ('98100000-0000-0000-0000-000000000001', 'reader-search-a', 'Reader Search A'),
  ('98100000-0000-0000-0000-000000000002', 'reader-search-b', 'Reader Search B');
insert into public.books (id, canonical_key, original_language, primary_author_id) values
  ('98200000-0000-0000-0000-000000000001', 'reader-search-a', 'en', '98100000-0000-0000-0000-000000000001'),
  ('98200000-0000-0000-0000-000000000002', 'reader-search-b', 'en', '98100000-0000-0000-0000-000000000002');
insert into public.editions (id, book_id, language_code, edition_number) values
  ('98300000-0000-0000-0000-000000000001', '98200000-0000-0000-0000-000000000001', 'en', 1),
  ('98300000-0000-0000-0000-000000000002', '98200000-0000-0000-0000-000000000002', 'en', 1);

create function pg_temp.queue_job(p_edition_id uuid, p_tag text)
returns table (job_id uuid, asset_id uuid)
language plpgsql
as $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '98000000-0000-0000-0000-000000000001', true);
  select reservation.asset_id into asset_id from public.admin_reserve_ebook_asset(p_edition_id) reservation;
  select public.admin_finalize_ebook_asset(asset_id, 'checksum-' || p_tag, 'request-' || p_tag) into job_id;
  reset role;
  return next;
end;
$$;

select is(has_function_privilege('anon', 'public.replace_publication_search(uuid, jsonb, jsonb)', 'EXECUTE'), false, 'anon cannot replace a publication search index');
select is(has_function_privilege('authenticated', 'public.replace_publication_search(uuid, jsonb, jsonb)', 'EXECUTE'), false, 'authenticated cannot replace a publication search index');

create temporary table queued_a as select * from pg_temp.queue_job('98300000-0000-0000-0000-000000000001', 'a');
grant select on queued_a to public;
set local role service_role;
create temporary table claimed_a as select * from public.claim_processing_job('worker-a', 60, (select asset_id from queued_a));
reset role;
grant select on claimed_a to public;

-- The last insert is invalid. A publication, its resource rows, positions, and earlier chunks
-- must all roll back together rather than exposing a ready publication with a partial index.
set local role service_role;
select throws_ok(
  $$select public.complete_processing_job(
    (select job_id from queued_a), 'worker-a', 'a/manifest.json', '[]'::jsonb,
    '[{"href":"OEBPS/text/a.xhtml","media_type":"application/xhtml+xml","storage_key":"a.xhtml","byte_size":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","access_class":"paid"}]'::jsonb,
    '[]'::jsonb,
    '[{"href":"OEBPS/text/a.xhtml","chapter_title":"A","ordinal":0,"plain_text":"valid","locator_json":{"href":"OEBPS/text/a.xhtml","progression":0,"locations":{"cssSelector":"p","textOffset":0},"text":{"highlight":"valid"}}},{"href":"OEBPS/text/a.xhtml","chapter_title":"A","ordinal":1,"plain_text":"","locator_json":{"href":"OEBPS/text/a.xhtml","progression":0,"locations":{"cssSelector":"p","textOffset":0},"text":{"highlight":"bad"}}}]'::jsonb,
    '[]'::jsonb
  )$$,
  null,
  null,
  'an invalid final chunk rejects the completion transaction'
);
reset role;
select is((select count(*)::bigint from public.ebook_publications where ebook_asset_id = (select asset_id from queued_a)), 0::bigint, 'invalid completion leaves no publication');
select is((select count(*)::bigint from public.ebook_resources where storage_key = 'a.xhtml'), 0::bigint, 'invalid completion leaves no resource rows');
select is((select count(*)::bigint from public.ebook_search_chunks where plain_text = 'valid'), 0::bigint, 'invalid completion leaves no search rows');
select is((select status from public.processing_jobs where id = (select job_id from queued_a)), 'processing'::public.processing_job_status, 'invalid completion leaves the worker lease intact');

set local role service_role;
create temporary table publication_a as select public.complete_processing_job(
  (select job_id from queued_a), 'worker-a', 'a/manifest.json', '[]'::jsonb,
  '[{"href":"OEBPS/text/a.xhtml","media_type":"application/xhtml+xml","storage_key":"a.xhtml","byte_size":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","access_class":"paid"}]'::jsonb,
  '[]'::jsonb,
  '[{"href":"OEBPS/text/a.xhtml","chapter_title":"A","ordinal":0,"plain_text":"original A","locator_json":{"href":"OEBPS/text/a.xhtml","progression":0,"locations":{"cssSelector":"p","textOffset":0},"text":{"highlight":"original A"}}}]'::jsonb,
  '[{"href":"OEBPS/text/a.xhtml","progression":0,"locations":{"position":1}}]'::jsonb
) as publication_id;
reset role;
grant select on publication_a to public;
select is((select count(*)::bigint from public.ebook_search_chunks where publication_id = (select publication_id from publication_a)), 1::bigint, 'valid completion persists its private index atomically');
select is((select positions_json from public.ebook_publications where id = (select publication_id from publication_a)), '[{"href":"OEBPS/text/a.xhtml","progression":0,"locations":{"position":1}}]'::jsonb, 'valid completion persists positions atomically');
select is((select count(*)::bigint from public.ebook_resources where publication_id = (select publication_id from publication_a)), 1::bigint, 'valid completion persists its resource with the index');

create temporary table queued_b as select * from pg_temp.queue_job('98300000-0000-0000-0000-000000000002', 'b');
grant select on queued_b to public;
set local role service_role;
create temporary table claimed_b as select * from public.claim_processing_job('worker-b', 60, (select asset_id from queued_b));
create temporary table publication_b as select public.complete_processing_job(
  (select job_id from queued_b), 'worker-b', 'b/manifest.json', '[]'::jsonb,
  '[{"href":"OEBPS/text/b.xhtml","media_type":"application/xhtml+xml","storage_key":"b.xhtml","byte_size":1,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","access_class":"paid"}]'::jsonb,
  '[]'::jsonb,
  '[{"href":"OEBPS/text/b.xhtml","chapter_title":"B","ordinal":0,"plain_text":"original B","locator_json":{"href":"OEBPS/text/b.xhtml","progression":0,"locations":{"cssSelector":"p","textOffset":0},"text":{"highlight":"original B"}}}]'::jsonb,
  '[{"href":"OEBPS/text/b.xhtml","progression":0,"locations":{"position":1}}]'::jsonb
) as publication_id;
reset role;
grant select on publication_b to public;

set local role service_role;
select public.replace_publication_search(
  (select publication_id from publication_a),
  '[{"href":"OEBPS/text/a.xhtml","chapter_title":"A","ordinal":0,"plain_text":"replacement A","locator_json":{"href":"OEBPS/text/a.xhtml","progression":0,"locations":{"cssSelector":"p","textOffset":0},"text":{"highlight":"replacement A"}}}]'::jsonb,
  '[{"href":"OEBPS/text/a.xhtml","progression":0,"locations":{"position":1}}]'::jsonb
);
reset role;
select is((select plain_text from public.ebook_search_chunks where publication_id = (select publication_id from publication_a)), 'replacement A', 'replacement changes publication A only');
select is((select plain_text from public.ebook_search_chunks where publication_id = (select publication_id from publication_b)), 'original B', 'replacement leaves publication B unchanged');
select is((select positions_json from public.ebook_publications where id = (select publication_id from publication_b)), '[{"href":"OEBPS/text/b.xhtml","progression":0,"locations":{"position":1}}]'::jsonb, 'replacement leaves publication B positions unchanged');

-- Completing through a stale worker reference still cannot write a new index or publication.
create temporary table queued_stale as select * from pg_temp.queue_job('98300000-0000-0000-0000-000000000001', 'stale');
grant select on queued_stale to public;
set local role service_role;
create temporary table stale_old_claim as select * from public.claim_processing_job('worker-old', 1, (select asset_id from queued_stale));
update public.processing_jobs set lease_expires_at = now() - interval '1 second' where id = (select job_id from queued_stale);
create temporary table stale_new_claim as select * from public.claim_processing_job('worker-new', 60, (select asset_id from queued_stale));
select throws_ok(
  $$select public.complete_processing_job((select job_id from queued_stale), 'worker-old', 'stale.json', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)$$,
  '42501', null, 'a stale worker lease cannot persist a publication index'
);
reset role;
select is((select count(*)::bigint from public.ebook_publications where ebook_asset_id = (select asset_id from queued_stale)), 0::bigint, 'stale worker completion leaves no publication or index');

select * from finish();
rollback;
