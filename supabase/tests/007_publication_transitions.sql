begin;
select plan(59);

-- Fixtures: two independent books (A and B), each with its own author/edition, an admin auth
-- user, and a non-admin auth user. Ruling AV/renumbering: numbered 007, not the brief's 006 -
-- that collides with Task 5's 006_processing_jobs.sql.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '95000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'publication-transitions-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '95000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'publication-transitions-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = '95000000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name) values
  ('96000000-0000-0000-0000-000000000001', 'publication-transitions-author-a', 'Publication Transitions Author A'),
  ('96000000-0000-0000-0000-000000000002', 'publication-transitions-author-b', 'Publication Transitions Author B');
insert into public.books (id, canonical_key, original_language, primary_author_id) values
  ('96000000-0000-0000-0000-000000000011', 'publication-transitions-book-a', 'en', '96000000-0000-0000-0000-000000000001'),
  ('96000000-0000-0000-0000-000000000012', 'publication-transitions-book-b', 'en', '96000000-0000-0000-0000-000000000002');
insert into public.editions (id, book_id, language_code, edition_number) values
  ('96000000-0000-0000-0000-000000000021', '96000000-0000-0000-0000-000000000011', 'en', 1),
  ('96000000-0000-0000-0000-000000000022', '96000000-0000-0000-0000-000000000012', 'en', 1);

-- (1)-(6) Ruling R: EXECUTE goes to `authenticated` only, and anon holds none - checked directly
-- against the grant (Ruling AS), never via throws_ok. Each function's own is_admin() guard also
-- raises 42501, which would make a live call rejected for exactly the same SQLSTATE whether the
-- grant or the guard fired - has_function_privilege() is the only check that actually pins the
-- revoke.
select is(has_function_privilege('anon', 'public.publish_publication(uuid)', 'EXECUTE'), false, 'anon holds no EXECUTE on publish_publication');
select is(has_function_privilege('authenticated', 'public.publish_publication(uuid)', 'EXECUTE'), true, 'authenticated holds EXECUTE on publish_publication');
select is(has_function_privilege('anon', 'public.reject_publication(uuid, text)', 'EXECUTE'), false, 'anon holds no EXECUTE on reject_publication');
select is(has_function_privilege('authenticated', 'public.reject_publication(uuid, text)', 'EXECUTE'), true, 'authenticated holds EXECUTE on reject_publication');
select is(has_function_privilege('anon', 'public.rollback_publication(uuid, uuid)', 'EXECUTE'), false, 'anon holds no EXECUTE on rollback_publication');
select is(has_function_privilege('authenticated', 'public.rollback_publication(uuid, uuid)', 'EXECUTE'), true, 'authenticated holds EXECUTE on rollback_publication');

-- (7)-(9) A signed-in non-admin passes the grant but is rejected by each function's own
-- is_admin() check.
set local role authenticated;
select set_config('request.jwt.claim.sub', '95000000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$select public.publish_publication('99999999-9999-9999-9999-999999999999')$$,
  '42501', 'publish_publication: caller is not an admin',
  'authenticated non-admin: publish_publication is rejected'
);
select throws_ok(
  $$select public.reject_publication('99999999-9999-9999-9999-999999999999', 'not ready')$$,
  '42501', 'reject_publication: caller is not an admin',
  'authenticated non-admin: reject_publication is rejected'
);
select throws_ok(
  $$select public.rollback_publication('99999999-9999-9999-9999-999999999999', '99999999-9999-9999-9999-999999999999')$$,
  '42501', 'rollback_publication: caller is not an admin',
  'authenticated non-admin: rollback_publication is rejected'
);
reset role;

-- Produces one ready_for_preview publication for the given edition, through the real
-- reserve/finalize/claim/complete pipeline (Task 3 and Task 5's RPCs), not a direct insert -
-- this suite's fixtures go through the same path production traffic does.
create function pg_temp.make_ready_publication(p_edition_id uuid, p_admin_id uuid, p_tag text)
returns table (publication_id uuid, asset_id uuid)
language plpgsql
as $$
declare
  v_asset_id uuid;
  v_job_id uuid;
  v_publication_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', p_admin_id::text, true);
  select r.asset_id into v_asset_id from public.admin_reserve_ebook_asset(p_edition_id) r;
  select public.admin_finalize_ebook_asset(v_asset_id, 'checksum-' || p_tag, 'req-' || p_tag) into v_job_id;
  reset role;

  -- Targets the specific job by asset id (p_target_id), not a bare poll for "whatever's oldest" -
  -- two books' fixtures both queue jobs in this same suite, and an untargeted claim could pick up
  -- the wrong one.
  set local role service_role;
  select c.job_id into v_job_id from public.claim_processing_job('worker-' || p_tag, 60, v_asset_id) c;
  -- Fix round 1, Important #4: a non-empty p_resources, not '[]', so every publication this suite
  -- produces gets exactly one ebook_resources row - the aggregate admin-read assertion below was
  -- vacuous for this table in both directions because no fixture ever created one.
  select public.complete_processing_job(
    v_job_id, 'worker-' || p_tag, v_asset_id::text || '/manifest.json', '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'href', 'OEBPS/text/chapter1.xhtml',
      'media_type', 'application/xhtml+xml',
      'storage_key', v_asset_id::text || '/OEBPS/text/chapter1.xhtml',
      'byte_size', 10,
      'sha256', repeat('0', 64),
      'access_class', 'paid'
    )),
    '[]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb
  ) into v_publication_id;
  reset role;

  return query select v_publication_id, v_asset_id;
end;
$$;

-- Book A gets four successive versions: v1/v2 supersede each other so publishing the second can
-- supersede the first; v3 (fix round 1, Important #3) stays ready_for_preview for the rest of the
-- suite, never published, to prove rollback rejects a version that was never live; v4 (fix round
-- 1, catalog-readiness regression) gets rejected after book A has an active EPUB version, to
-- prove rejecting a candidate does not change catalog visibility.
create temporary table t_a1 as select * from pg_temp.make_ready_publication('96000000-0000-0000-0000-000000000021', '95000000-0000-0000-0000-000000000001', 'a1');
create temporary table t_a2 as select * from pg_temp.make_ready_publication('96000000-0000-0000-0000-000000000021', '95000000-0000-0000-0000-000000000001', 'a2');
create temporary table t_a3 as select * from pg_temp.make_ready_publication('96000000-0000-0000-0000-000000000021', '95000000-0000-0000-0000-000000000001', 'a3');
create temporary table t_a4 as select * from pg_temp.make_ready_publication('96000000-0000-0000-0000-000000000021', '95000000-0000-0000-0000-000000000001', 'a4');
-- Book B gets one version, used for the reject path and the cross-book rollback proof.
create temporary table t_b1 as select * from pg_temp.make_ready_publication('96000000-0000-0000-0000-000000000022', '95000000-0000-0000-0000-000000000001', 'b1');
-- Temp tables are owned by whichever role created them (the unrestricted test-runner role);
-- later assertions read these from `authenticated` too, so grant broadly rather than fighting
-- cross-role temp-table ownership in what is otherwise a throwaway test transaction (same idiom
-- as 006_processing_jobs.sql's t_reservation_*/t_job_* grants).
grant select on t_a1, t_a2, t_a3, t_a4, t_b1 to public;

-- (10) Ruling BO, the "before" half: nothing has published anything yet, and `admin_create_ebook`
-- (and this suite's own fixture insert above) creates an author at the 'draft' default, so the
-- "public read published authors" policy must hide book A's author from an anonymous visitor.
-- Asserted as `anon` specifically, not as an unprivileged authenticated role - anon is the role
-- the storefront actually serves, and the policy names both.
set local role anon;
select ok(
  not exists(select 1 from public.authors where id = '96000000-0000-0000-0000-000000000001'),
  'Ruling BO: anon cannot see book A''s author before anything is published'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '95000000-0000-0000-0000-000000000001', true);

-- (11) Admin publishes book A's first version.
select lives_ok(
  $$select public.publish_publication((select publication_id from t_a1))$$,
  'admin: publish_publication succeeds for a ready_for_preview candidate'
);
reset role;

-- (12)-(15) The publish landed: publication published, asset published, book's active pointer
-- moved, and an audit row was recorded.
select is((select status from public.ebook_publications where id = (select publication_id from t_a1)), 'published'::public.publication_status, 'book A v1 publication is now published');
select is((select status from public.ebook_assets where id = (select asset_id from t_a1)), 'published'::public.ebook_asset_status, 'book A v1 asset is now published');
select is((select active_publication_id from public.books where id = '96000000-0000-0000-0000-000000000011'), (select publication_id from t_a1), 'book A''s active pointer now targets v1');
select is(
  (select count(*)::bigint from public.audit_logs where action = 'publish_publication' and entity_id = (select publication_id from t_a1)),
  1::bigint,
  'publishing v1 recorded exactly one audit row'
);

-- (16) Book visibility is now a catalog decision made by publish_book (20260913120000), rather
-- than a side effect of publishing an EPUB version.
set local role anon;
select ok(
  not exists(select 1 from public.books where id = '96000000-0000-0000-0000-000000000011'),
  'publish_publication alone no longer makes book A public; publish_book does (see 013)'
);
reset role;

-- (17) Primary-author visibility is also a publish_book decision (20260913120000).
--
-- (18)-(19) Publishing an EPUB version must not make either book's author public.
set local role anon;
select ok(
  not exists(select 1 from public.authors where id = '96000000-0000-0000-0000-000000000001'),
  'publish_publication alone no longer publishes book A''s author'
);
select ok(
  not exists(select 1 from public.books where id = '96000000-0000-0000-0000-000000000012'),
  'Ruling BO: anon still cannot see book B, which was never published'
);
select ok(
  not exists(select 1 from public.authors where id = '96000000-0000-0000-0000-000000000002'),
  'Ruling BO: anon still cannot see book B''s author, which was never published'
);
reset role;

-- (20)-(23) Ruling BL's other half: rejecting a *different*, still-pending candidate for the same
-- book must not disturb its active EPUB pointer or change its draft catalog visibility. t_a4 is a fresh
-- ready_for_preview version of book A, created alongside t_a1-t_a3 above but untouched until now.
set local role authenticated;
select set_config('request.jwt.claim.sub', '95000000-0000-0000-0000-000000000001', true);
select lives_ok(
  format($$select public.reject_publication('%s', 'needs another pass before it can replace v1')$$, (select publication_id from t_a4)),
  'admin: reject_publication succeeds for book A''s pending v4 candidate'
);
reset role;

select is((select status from public.ebook_publications where id = (select publication_id from t_a4)), 'rejected'::public.publication_status, 'book A v4 publication is now rejected');
select is((select status from public.books where id = '96000000-0000-0000-0000-000000000011'), 'draft'::public.content_status, 'rejecting v4 leaves book A''s status unchanged');

set local role anon;
select ok(
  not exists(select 1 from public.books where id = '96000000-0000-0000-0000-000000000011'),
  'anon still cannot see book A, which was never published through publish_book'
);
reset role;

-- (24) Publishing book A's second version supersedes the first (Ruling: "publishing supersedes
-- the previous active version").
set local role authenticated;
select set_config('request.jwt.claim.sub', '95000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select public.publish_publication((select publication_id from t_a2))$$,
  'admin: publish_publication succeeds for book A''s second version'
);
reset role;

-- (25)-(29) v2 is published and active; v1 - previously active - is superseded, at both the
-- publication and asset level; the book's active pointer now targets v2, not v1.
select is((select status from public.ebook_publications where id = (select publication_id from t_a2)), 'published'::public.publication_status, 'book A v2 publication is now published');
select is((select status from public.ebook_publications where id = (select publication_id from t_a1)), 'superseded'::public.publication_status, 'book A v1 publication is superseded once v2 publishes');
select is((select status from public.ebook_assets where id = (select asset_id from t_a1)), 'superseded'::public.ebook_asset_status, 'book A v1 asset is superseded once v2 publishes');
select is((select status from public.ebook_assets where id = (select asset_id from t_a2)), 'published'::public.ebook_asset_status, 'book A v2 asset is now published');
select is((select active_publication_id from public.books where id = '96000000-0000-0000-0000-000000000011'), (select publication_id from t_a2), 'book A''s active pointer now targets v2');

-- (30) Publishing a publication id that does not exist is rejected distinctly from every status
-- rejection below.
set local role authenticated;
select set_config('request.jwt.claim.sub', '95000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.publish_publication('99999999-9999-9999-9999-999999999999')$$,
  'P0002', 'publish_publication: publication 99999999-9999-9999-9999-999999999999 does not exist',
  'admin: publishing a nonexistent publication is rejected'
);

-- (31) An already-published publication (v2) cannot be published again - only
-- ready_for_preview -> published is accepted.
select throws_ok(
  format($$select public.publish_publication('%s')$$, (select publication_id from t_a2)),
  'EB002',
  format('publish_publication: publication %s is published and cannot be published', (select publication_id from t_a2)),
  'admin: re-publishing an already-published version is rejected'
);
reset role;

-- (32) reject_publication requires a reason.
set local role authenticated;
select set_config('request.jwt.claim.sub', '95000000-0000-0000-0000-000000000001', true);
select throws_ok(
  format($$select public.reject_publication('%s', null)$$, (select publication_id from t_b1)),
  'EB004', 'reject_publication: a reason is required',
  'admin: rejecting without a reason is refused'
);

-- (33) Rejecting book B's ready_for_preview candidate, with a reason, succeeds.
select lives_ok(
  format($$select public.reject_publication('%s', 'quality issues found in preview')$$, (select publication_id from t_b1)),
  'admin: reject_publication succeeds for a ready_for_preview candidate'
);
reset role;

-- (34)-(35) The rejection landed, and its reason was recorded on the audit row (not just the
-- publication's own status, which carries no free-text reason column).
select is((select status from public.ebook_publications where id = (select publication_id from t_b1)), 'rejected'::public.publication_status, 'book B v1 publication is now rejected');
select is(
  (select reason from public.audit_logs where action = 'reject_publication' and entity_id = (select publication_id from t_b1)),
  'quality issues found in preview',
  'the rejection reason was recorded on the audit row'
);

-- (36) Rejecting an already-rejected publication is refused.
set local role authenticated;
select set_config('request.jwt.claim.sub', '95000000-0000-0000-0000-000000000001', true);
select throws_ok(
  format($$select public.reject_publication('%s', 'again')$$, (select publication_id from t_b1)),
  'EB002',
  format('reject_publication: publication %s is rejected and cannot be rejected', (select publication_id from t_b1)),
  'admin: rejecting an already-rejected version is refused'
);

-- (37) Ruling AN, proven by construction: book B's (rejected) publication does not belong to
-- book A. Naming book A's id alongside book B's publication id must be rejected before any
-- status check even runs - a transaction that happens to work on well-formed input proves
-- nothing about this guard, so this deliberately points rollback at the WRONG book.
select throws_ok(
  format(
    $$select public.rollback_publication('96000000-0000-0000-0000-000000000011', '%s')$$,
    (select publication_id from t_b1)
  ),
  'EB003',
  format('rollback_publication: publication %s does not belong to book 96000000-0000-0000-0000-000000000011', (select publication_id from t_b1)),
  'admin: rollback rejects a publication that belongs to a different book, before touching any status'
);
reset role;

-- (38) Ruling AN did not corrupt book A's own state: rolling book A back to its actually-owned,
-- superseded v1 succeeds once the cross-book attempt above is safely rejected.
set local role authenticated;
select set_config('request.jwt.claim.sub', '95000000-0000-0000-0000-000000000001', true);
select lives_ok(
  format($$select public.rollback_publication('96000000-0000-0000-0000-000000000011', '%s')$$, (select publication_id from t_a1)),
  'admin: rollback_publication succeeds for book A''s own superseded v1'
);
reset role;

-- (39)-(43) Rollback moved the active pointer, not the artifacts: v1 is published again, v2 -
-- the version it replaced - is superseded, both at the publication and asset level, and an
-- audit row records it.
select is((select status from public.ebook_publications where id = (select publication_id from t_a1)), 'published'::public.publication_status, 'book A v1 publication is published again after rollback');
select is((select status from public.ebook_publications where id = (select publication_id from t_a2)), 'superseded'::public.publication_status, 'book A v2 publication is superseded after rollback');
select is((select status from public.ebook_assets where id = (select asset_id from t_a1)), 'published'::public.ebook_asset_status, 'book A v1 asset is published again after rollback');
select is((select status from public.ebook_assets where id = (select asset_id from t_a2)), 'superseded'::public.ebook_asset_status, 'book A v2 asset is superseded after rollback');
select is((select active_publication_id from public.books where id = '96000000-0000-0000-0000-000000000011'), (select publication_id from t_a1), 'book A''s active pointer targets v1 again after rollback');

-- (44) Fix round 1, Important #3 (sharper cross-book case): the earlier cross-book rollback
-- attempt used book B's *rejected* t_b1, which fails the status check too - it doesn't prove
-- ownership is checked before status. t_a2 is now genuinely `superseded` (just above) and would
-- otherwise be fully eligible for rollback; naming it alongside book B's id must still be rejected
-- on ownership alone.
set local role authenticated;
select set_config('request.jwt.claim.sub', '95000000-0000-0000-0000-000000000001', true);
select throws_ok(
  format(
    $$select public.rollback_publication('96000000-0000-0000-0000-000000000012', '%s')$$,
    (select publication_id from t_a2)
  ),
  'EB003',
  format('rollback_publication: publication %s does not belong to book 96000000-0000-0000-0000-000000000012', (select publication_id from t_a2)),
  'admin: rollback rejects an otherwise-eligible superseded publication that belongs to a different book'
);
reset role;

-- (45) Fix round 1, Important #3: rollback must also refuse a version that was never published in
-- the first place - the brief's own wording is "a previously published version", and a never-
-- published ready_for_preview candidate is a distinct case from the already-published v1 tested
-- below. t_a3 has sat untouched, still ready_for_preview, since fixture creation.
set local role authenticated;
select set_config('request.jwt.claim.sub', '95000000-0000-0000-0000-000000000001', true);
select throws_ok(
  format($$select public.rollback_publication('96000000-0000-0000-0000-000000000011', '%s')$$, (select publication_id from t_a3)),
  'EB002',
  format('rollback_publication: publication %s is ready_for_preview and is not eligible for rollback', (select publication_id from t_a3)),
  'admin: rollback of a never-published ready_for_preview version is refused'
);
reset role;

-- (46) Rolling back to a publication that is not `superseded` (v1 is `published` again now) is
-- refused.
set local role authenticated;
select set_config('request.jwt.claim.sub', '95000000-0000-0000-0000-000000000001', true);
select throws_ok(
  format($$select public.rollback_publication('96000000-0000-0000-0000-000000000011', '%s')$$, (select publication_id from t_a1)),
  'EB002',
  format('rollback_publication: publication %s is published and is not eligible for rollback', (select publication_id from t_a1)),
  'admin: rollback of a non-superseded publication is refused'
);

-- (47) A nonexistent book id is rejected distinctly.
select throws_ok(
  format($$select public.rollback_publication('99999999-9999-9999-9999-999999999999', '%s')$$, (select publication_id from t_a1)),
  'P0002', 'rollback_publication: book 99999999-9999-9999-9999-999999999999 does not exist',
  'admin: rollback against a nonexistent book is rejected'
);

-- (48) A nonexistent publication id is rejected distinctly.
select throws_ok(
  $$select public.rollback_publication('96000000-0000-0000-0000-000000000011', '99999999-9999-9999-9999-999999999999')$$,
  'P0002', 'rollback_publication: publication 99999999-9999-9999-9999-999999999999 does not exist',
  'admin: rollback of a nonexistent publication is rejected'
);
reset role;

-- (49)-(56) Fix round 1, Important #4: the grant this migration adds (table-level SELECT on the
-- four publishing tables, to `authenticated`) is necessary for the admin-read policies above to
-- work at all, but it is not itself the security boundary - RLS still is. Replaces the single
-- aggregate assertion this suite previously had (one `isnt` over the sum of all four tables, which would
-- have passed even if three of the four policies were `using (false)`) with one positive/negative
-- pair per table, so each policy is proven individually. Every table now has a genuine fixture row
-- (ebook_resources included, since the fixture helper above stopped passing an empty
-- p_resources), so no pair here is vacuous in either direction.
set local role authenticated;
select set_config('request.jwt.claim.sub', '95000000-0000-0000-0000-000000000002', true);
select is((select count(*)::bigint from public.ebook_assets), 0::bigint, 'authenticated non-admin: no ebook_assets rows are visible');
select is((select count(*)::bigint from public.processing_jobs), 0::bigint, 'authenticated non-admin: no processing_jobs rows are visible');
select is((select count(*)::bigint from public.ebook_publications), 0::bigint, 'authenticated non-admin: no ebook_publications rows are visible');
select is((select count(*)::bigint from public.ebook_resources), 0::bigint, 'authenticated non-admin: no ebook_resources rows are visible');

select set_config('request.jwt.claim.sub', '95000000-0000-0000-0000-000000000001', true);
select isnt((select count(*)::bigint from public.ebook_assets), 0::bigint, 'authenticated admin: reads ebook_assets rows this suite created');
select isnt((select count(*)::bigint from public.processing_jobs), 0::bigint, 'authenticated admin: reads processing_jobs rows this suite created');
select isnt((select count(*)::bigint from public.ebook_publications), 0::bigint, 'authenticated admin: reads ebook_publications rows this suite created');
select isnt((select count(*)::bigint from public.ebook_resources), 0::bigint, 'authenticated admin: reads ebook_resources rows this suite created');
reset role;

-- (57)-(59) publish_publication's previous-active ownership guard (20260911180000:114-133)
-- shipped with no test. It re-derives ownership through the p -> a -> e chain before superseding
-- whatever books.active_publication_id names, precisely because that deferrable FK only proves the
-- id exists *somewhere*, never that it belongs to this book.
--
-- A previous fix report claimed this state was unconstructable. That conflated "unreachable in
-- production" (true - this RPC and rollback_publication are the only writers, and both always set
-- a same-book id) with "unconstructable in pgTAP" (false). This suite already writes base tables by
-- hand, and books_active_publication_fk is satisfied by any id that exists in ebook_publications -
-- book B's does - so pointing book A at it needs no deferral and no fixture surgery, just an
-- update.
--
-- t_a3 is still ready_for_preview: (45) only *attempted* a rollback of it, which was refused.
update public.books
   set active_publication_id = (select publication_id from t_b1)
 where id = '96000000-0000-0000-0000-000000000011';

set local role authenticated;
select set_config('request.jwt.claim.sub', '95000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select public.publish_publication((select publication_id from t_a3))$$,
  'admin: publish succeeds even when the book''s active pointer names another book''s publication'
);
reset role;

-- The guard resolved no row for the foreign publication, so it skipped the supersede entirely.
-- Book B's publication keeps the 'rejected' status (33) gave it, rather than being dragged to
-- 'superseded' by a publish of an unrelated book.
select is(
  (select status from public.ebook_publications where id = (select publication_id from t_b1)),
  'rejected'::public.publication_status,
  'ownership guard: publishing book A did not supersede book B''s publication'
);
select isnt(
  (select status from public.ebook_assets where id = (select asset_id from t_b1)),
  'superseded'::public.ebook_asset_status,
  'ownership guard: publishing book A did not supersede book B''s asset'
);

select * from finish();
rollback;
