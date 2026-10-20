begin;
select plan(37);

-- Fixtures: one author/book/edition, plus an admin auth user to drive the reserve/finalize
-- RPCs that create the processing_jobs rows this suite claims/completes/fails. Ruling AV:
-- numbered 006, not the brief's 005 - that collides with Task 3's 005_ebook_storage.sql.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '93000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'processing-jobs-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = '93000000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name) values
  ('94000000-0000-0000-0000-000000000001', 'processing-jobs-author', 'Processing Jobs Author');
insert into public.books (id, canonical_key, original_language, primary_author_id) values
  ('94000000-0000-0000-0000-000000000002', 'processing-jobs-book', 'en', '94000000-0000-0000-0000-000000000001');
insert into public.editions (id, book_id, language_code, edition_number) values
  ('94000000-0000-0000-0000-000000000003', '94000000-0000-0000-0000-000000000002', 'en', 1);

-- (1)-(6) Ruling AK: all three RPCs are service-role-only. Checked directly against the
-- grant (Ruling AS) - each function's own lease/existence guards raise 42501/P0002 too, so a
-- throws_ok on a live call would look identical whether the grant or the guard rejected it.
select is(has_function_privilege('anon', 'public.claim_processing_job(text, integer, uuid)', 'EXECUTE'), false, 'anon holds no EXECUTE on claim_processing_job');
select is(has_function_privilege('authenticated', 'public.claim_processing_job(text, integer, uuid)', 'EXECUTE'), false, 'authenticated holds no EXECUTE on claim_processing_job');
select is(has_function_privilege('anon', 'public.complete_processing_job(uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb)', 'EXECUTE'), false, 'anon holds no EXECUTE on complete_processing_job');
select is(has_function_privilege('authenticated', 'public.complete_processing_job(uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb)', 'EXECUTE'), false, 'authenticated holds no EXECUTE on complete_processing_job');
select is(has_function_privilege('anon', 'public.fail_processing_job(uuid, text, text, text)', 'EXECUTE'), false, 'anon holds no EXECUTE on fail_processing_job');
select is(has_function_privilege('authenticated', 'public.fail_processing_job(uuid, text, text, text)', 'EXECUTE'), false, 'authenticated holds no EXECUTE on fail_processing_job');

-- (7) An empty queue has nothing to claim - "no work" is a normal outcome, not an error.
set local role service_role;
select is((select count(*)::bigint from public.claim_processing_job('worker-empty', 60)), 0::bigint, 'claiming an empty queue returns no rows');
reset role;

-- Admin reserves and finalizes the first asset, producing job-1 (queued, version 1).
set local role authenticated;
select set_config('request.jwt.claim.sub', '93000000-0000-0000-0000-000000000001', true);
create temporary table t_reservation_1 as
select * from public.admin_reserve_ebook_asset('94000000-0000-0000-0000-000000000003');
create temporary table t_job_1 as
select public.admin_finalize_ebook_asset((select asset_id from t_reservation_1), 'checksum-one', 'req-job-1') as job_id;
reset role;
-- Temp tables are owned by whichever role created them; later assertions read these from
-- both `service_role` and the default (superuser) session role, so grant broadly rather than
-- fighting cross-role temp-table ownership in what is otherwise a throwaway test transaction.
grant select on t_reservation_1, t_job_1 to public;

-- (8) claim_processing_job(no target) returns exactly job-1, joined with its asset fields.
set local role service_role;
create temporary table t_claim_1 as
select * from public.claim_processing_job('worker-a', 60);
select results_eq(
  $$select job_id, target_id, edition_id, version, source_storage_key, source_checksum, attempt, correlation_id from t_claim_1$$,
  $$select (select job_id from t_job_1), (select asset_id from t_reservation_1),
    '94000000-0000-0000-0000-000000000003'::uuid, 1, (select storage_key from t_reservation_1), 'checksum-one'::text, 1, 'req-job-1'::text$$,
  'claim_processing_job returns the expected checksum with its immutable asset fields'
);
reset role;

-- (9) The claim is reflected in processing_jobs and ebook_assets.
select results_eq(
  $$select status, lease_owner from public.processing_jobs where id = (select job_id from t_job_1)$$,
  $$values ('processing'::public.processing_job_status, 'worker-a'::text)$$,
  'job-1 is now processing, leased to worker-a'
);
select is(
  (select status from public.ebook_assets where id = (select asset_id from t_reservation_1)),
  'processing'::public.ebook_asset_status,
  'asset-1 moved to processing alongside its job'
);

-- (10) Two workers cannot hold the same active lease: a second claim (no target, lease not
-- expired) sees nothing eligible.
set local role service_role;
select is((select count(*)::bigint from public.claim_processing_job('worker-b', 60)), 0::bigint, 'a second worker cannot claim job-1 while its lease is still active');
reset role;

-- (11) An expired lease can be reclaimed. Force the lease into the past directly (standing
-- in for real elapsed time), then claim again with a different worker id.
update public.processing_jobs set lease_expires_at = now() - interval '1 minute' where id = (select job_id from t_job_1);
set local role service_role;
create temporary table t_claim_2 as
select * from public.claim_processing_job('worker-c', 60);
select is((select count(*)::bigint from t_claim_2), 1::bigint, 'a different worker reclaims job-1 once its lease has expired');
select is((select attempt from t_claim_2), 2, 'reclaiming bumps the attempt count');
reset role;
select is(
  (select lease_owner from public.processing_jobs where id = (select job_id from t_job_1)),
  'worker-c',
  'the reclaimed lease now belongs to worker-c'
);

-- (12)-(13) Ruling AK's negative test: a caller that does not hold job-1's lease cannot
-- complete or fail it, even though it is service_role and even though it names the right
-- job id.
set local role service_role;
select throws_ok(
  $$select public.complete_processing_job(
    (select job_id from t_job_1), 'worker-a', 'k/manifest.json', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
  )$$,
  '42501',
  format('complete_processing_job: worker %s does not hold the lease for job %s', 'worker-a', (select job_id from t_job_1)),
  'a worker that lost the lease (worker-a) cannot complete job-1'
);
select throws_ok(
  $$select public.fail_processing_job((select job_id from t_job_1), 'worker-a', 'PROCESSING_FAILURE', 'x')$$,
  '42501',
  format('fail_processing_job: worker %s does not hold the lease for job %s', 'worker-a', (select job_id from t_job_1)),
  'a worker that lost the lease (worker-a) cannot fail job-1'
);
reset role;

-- (14) complete_processing_job by the rightful lease holder (worker-c) records the
-- publication, its resources, and its sample allowlist in one call.
set local role service_role;
create temporary table t_complete_1 as
select public.complete_processing_job(
  (select job_id from t_job_1),
  'worker-c',
  (select target_id from t_claim_1) || '/manifest.json',
  '[{"title": "Chapter 1", "href": "OEBPS/text/chapter1.xhtml", "children": []}]'::jsonb,
  '[
    {"href": "OEBPS/text/chapter1.xhtml", "media_type": "application/xhtml+xml", "storage_key": "k1", "byte_size": 10, "sha256": "aaa", "access_class": "paid"},
    {"href": "OEBPS/text/chapter1-sample.xhtml", "media_type": "application/xhtml+xml", "storage_key": "k2", "byte_size": 5, "sha256": "bbb", "access_class": "sample"}
  ]'::jsonb,
  '["OEBPS/text/chapter1-sample.xhtml"]'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb
) as publication_id;
reset role;

select isnt((select publication_id from t_complete_1), null, 'complete_processing_job returns a new publication id');
select results_eq(
  $$select ebook_asset_id, version, manifest_key from public.ebook_publications where id = (select publication_id from t_complete_1)$$,
  $$select (select asset_id from t_reservation_1), 1, (select target_id from t_claim_1) || '/manifest.json'$$,
  'the publication row records the asset, its version, and the manifest key'
);
select is(
  (select count(*)::bigint from public.ebook_resources where publication_id = (select publication_id from t_complete_1)),
  2::bigint,
  'both resources were recorded'
);
select is(
  (select allowed_hrefs from public.book_samples where publication_id = (select publication_id from t_complete_1)),
  '["OEBPS/text/chapter1-sample.xhtml"]'::jsonb,
  'the explicit sample allowlist is recorded verbatim, not re-derived from access_class'
);
select is(
  (select status from public.processing_jobs where id = (select job_id from t_job_1)),
  'completed'::public.processing_job_status,
  'job-1 is completed'
);
select is(
  (select lease_owner from public.processing_jobs where id = (select job_id from t_job_1)) is null,
  true,
  'job-1''s lease is cleared on completion'
);
select is(
  (select status from public.ebook_assets where id = (select asset_id from t_reservation_1)),
  'ready_for_preview'::public.ebook_asset_status,
  'asset-1 is ready_for_preview after completion'
);

-- (15) not-found: completing/failing a job id that does not exist is rejected distinctly
-- from a lease-ownership failure.
set local role service_role;
select throws_ok(
  $$select public.complete_processing_job('99999999-9999-9999-9999-999999999999', 'worker-x', 'k', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)$$,
  'P0002',
  'complete_processing_job: job 99999999-9999-9999-9999-999999999999 does not exist',
  'completing a nonexistent job is rejected'
);
select throws_ok(
  $$select public.fail_processing_job('99999999-9999-9999-9999-999999999999', 'worker-x', 'PROCESSING_FAILURE', 'x')$$,
  'P0002',
  'fail_processing_job: job 99999999-9999-9999-9999-999999999999 does not exist',
  'failing a nonexistent job is rejected'
);
reset role;

-- Stale-version scenario: a second asset (version 2) is uploaded for the same edition and
-- its job is claimed and completed *while an even newer version 3 does not yet exist* -
-- this is the edition's active output. A third asset (version 3) is then uploaded and its
-- job claimed, but before it completes, we prove that trying to complete the *v2* job again
-- would be stale... instead we exercise the realistic race directly: v2's job is claimed
-- first, v3 is uploaded and completed before v2 finishes, and v2's completion must then be
-- rejected without touching v3's publication.
set local role authenticated;
select set_config('request.jwt.claim.sub', '93000000-0000-0000-0000-000000000001', true);
create temporary table t_reservation_2 as
select * from public.admin_reserve_ebook_asset('94000000-0000-0000-0000-000000000003');
create temporary table t_job_2 as
select public.admin_finalize_ebook_asset((select asset_id from t_reservation_2), 'checksum-two', 'req-job-2') as job_id;
reset role;
grant select on t_reservation_2, t_job_2 to public;

set local role service_role;
create temporary table t_claim_v2 as
select * from public.claim_processing_job('worker-d', 60);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '93000000-0000-0000-0000-000000000001', true);
create temporary table t_reservation_3 as
select * from public.admin_reserve_ebook_asset('94000000-0000-0000-0000-000000000003');
create temporary table t_job_3 as
select public.admin_finalize_ebook_asset((select asset_id from t_reservation_3), 'checksum-three', 'req-job-3') as job_id;
reset role;
grant select on t_reservation_3, t_job_3 to public;

set local role service_role;
create temporary table t_claim_v3 as
select * from public.claim_processing_job('worker-e', 60);
create temporary table t_complete_v3 as
select public.complete_processing_job(
  (select job_id from t_job_3), 'worker-e', 'k3/manifest.json', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
) as publication_id;
reset role;

-- (16) v3's publication - the edition's current active output - exists before v2 attempts
-- to complete.
select isnt((select publication_id from t_complete_v3), null, 'v3 (the newer asset) completes and becomes the active output');

-- (17) v2's completion is now stale: a newer version (v3) already exists for the edition.
set local role service_role;
select throws_ok(
  format(
    $$select public.complete_processing_job('%s', 'worker-d', 'stale/manifest.json', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)$$,
    (select job_id from t_job_2)
  ),
  'EB001',
  format(
    'complete_processing_job: asset %s (version 2) is stale; edition 94000000-0000-0000-0000-000000000003 has version 3',
    (select asset_id from t_reservation_2)
  ),
  'stale asset version rejected before touching the active output'
);
reset role;

-- (18) complete_processing_job only detects and raises - it never mutates state. v2's job
-- is still exactly where claim() left it: processing, leased to worker-d.
select results_eq(
  $$select status, lease_owner from public.processing_jobs where id = (select job_id from t_job_2)$$,
  $$values ('processing'::public.processing_job_status, 'worker-d'::text)$$,
  'v2''s job is untouched by the rejected stale completion'
);

-- (19) No publication was ever created for the stale asset.
select is(
  (select count(*)::bigint from public.ebook_publications where ebook_asset_id = (select asset_id from t_reservation_2)),
  0::bigint,
  'no publication row exists for the stale v2 asset'
);

-- (20) v3's publication - the active output - is completely unchanged by the rejected v2
-- completion attempt.
select is(
  (select count(*)::bigint from public.ebook_publications where id = (select publication_id from t_complete_v3)),
  1::bigint,
  'v3''s publication row is unchanged - still exactly one row'
);

-- (21) The worker's real recovery path: fail_processing_job actually records STALE_VERSION
-- and clears the lease.
set local role service_role;
select public.fail_processing_job((select job_id from t_job_2), 'worker-d', 'STALE_VERSION', 'a newer asset version exists for this edition');
reset role;
select results_eq(
  $$select status, error_code from public.processing_jobs where id = (select job_id from t_job_2)$$,
  $$values ('failed'::public.processing_job_status, 'STALE_VERSION'::text)$$,
  'v2''s job is recorded as failed with STALE_VERSION only once fail_processing_job is called'
);
select is(
  (select status from public.ebook_assets where id = (select asset_id from t_reservation_2)),
  'failed'::public.ebook_asset_status,
  'the stale asset itself is marked failed'
);

-- (22) v3's active output is still untouched after v2's failure is finally recorded.
select is(
  (select count(*)::bigint from public.ebook_publications where id = (select publication_id from t_complete_v3)),
  1::bigint,
  'v3''s publication row remains unchanged after v2''s failure is recorded'
);

-- Ruling BA: an abandoned 'uploading' reservation must not count as a "newer version" for
-- the stale-version check. Reserve version 4 and finalize it (a legitimate job), then
-- reserve version 5 for the *same* edition but never finalize it - standing in for a closed
-- browser tab, or the local storage-limit interaction docs/runbooks/epub-processing.md
-- documents. Completing the legitimate v4 job must succeed despite the higher-numbered
-- phantom v5 existing.
set local role authenticated;
select set_config('request.jwt.claim.sub', '93000000-0000-0000-0000-000000000001', true);
create temporary table t_reservation_4 as
select * from public.admin_reserve_ebook_asset('94000000-0000-0000-0000-000000000003');
create temporary table t_job_4 as
select public.admin_finalize_ebook_asset((select asset_id from t_reservation_4), 'checksum-four', 'req-job-4') as job_id;
-- Reserved, never finalized - stays 'uploading' forever, exactly like a real abandoned
-- upload. No processing_jobs row is ever created for it.
create temporary table t_reservation_5 as
select * from public.admin_reserve_ebook_asset('94000000-0000-0000-0000-000000000003');
reset role;
grant select on t_reservation_4, t_job_4, t_reservation_5 to public;

-- (23) The phantom v5 reservation is confirmed 'uploading', not 'queued' or later.
select is(
  (select status from public.ebook_assets where id = (select asset_id from t_reservation_5)),
  'uploading'::public.ebook_asset_status,
  'the abandoned v5 reservation sits in uploading, exactly like a real abandoned upload'
);

set local role service_role;
create temporary table t_claim_v4 as
select * from public.claim_processing_job('worker-f', 60);
create temporary table t_complete_v4 as
select public.complete_processing_job(
  (select job_id from t_job_4), 'worker-f', 'k4/manifest.json', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
) as publication_id;
reset role;

-- (24) Completing the legitimate v4 job succeeds - the phantom, never-finalized v5 does not
-- trip the stale-version check.
select isnt(
  (select publication_id from t_complete_v4),
  null,
  'v4 completes successfully despite the higher-numbered, never-finalized v5 reservation'
);
select is(
  (select status from public.processing_jobs where id = (select job_id from t_job_4)),
  'completed'::public.processing_job_status,
  'v4''s job is completed, not rejected as stale'
);

-- (25) The phantom v5 reservation itself is untouched by v4's completion.
select is(
  (select status from public.ebook_assets where id = (select asset_id from t_reservation_5)),
  'uploading'::public.ebook_asset_status,
  'the abandoned v5 reservation remains untouched'
);

select * from finish();
rollback;
