begin;
select plan(57);

-- S11: the editorial pin table, its audited admin writer, and the deterministic scoring RPC
-- (docs/superpowers/sdd/2026-09-22-s11-recommendation-shelves).
--
-- Three things are proved here, in this order:
--
--   1. related_books has no browser write path at all. admin_set_related_books is the only way a
--      pin changes, it is admin-only, it rewrites positions to 1..N, it leaves exactly one audit
--      row per successful call, and a rejected call leaves the previous ordered set untouched.
--   2. recommend_books returns only books a reader could actually open in the requested locale -
--      published, with an ACTIVE publication whose status is 'published', and localized. Every
--      candidate below shares the author signal with its seed, so a candidate that is missing
--      from a result is missing because of eligibility, not because it scored zero.
--   3. The score and the order are a contract, not an implementation detail: fixed weights, pins
--      first, and a total order that two identical calls reproduce row for row.
--
-- The fixtures are partitioned into six independent "worlds" (E, S, T, P, M, W), each with its
-- own author, series and topics. A candidate therefore shares a signal only with the seed of its
-- own world, so one world's call can never be polluted by another's books.

-- Fixtures ---------------------------------------------------------------------------------------

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '50000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 's11-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '50000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 's11-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = '50000000-0000-4000-8000-000000000001';

insert into public.authors (id, canonical_slug, display_name, status) values
  ('52000000-0000-4000-8000-000000000001', 's11-author-e', 'S11 Author E', 'published'),
  ('52000000-0000-4000-8000-000000000002', 's11-author-s', 'S11 Author S', 'published'),
  ('52000000-0000-4000-8000-000000000003', 's11-author-x1', 'S11 Author X1', 'published'),
  ('52000000-0000-4000-8000-000000000004', 's11-author-x2', 'S11 Author X2', 'published'),
  ('52000000-0000-4000-8000-000000000005', 's11-author-x3', 'S11 Author X3', 'published'),
  ('52000000-0000-4000-8000-000000000006', 's11-author-x4', 'S11 Author X4', 'published'),
  ('52000000-0000-4000-8000-000000000007', 's11-author-t', 'S11 Author T', 'published'),
  ('52000000-0000-4000-8000-000000000008', 's11-author-p', 'S11 Author P', 'published'),
  ('52000000-0000-4000-8000-000000000009', 's11-author-p2', 'S11 Author P2', 'published'),
  ('52000000-0000-4000-8000-000000000010', 's11-author-p3', 'S11 Author P3', 'published'),
  ('52000000-0000-4000-8000-000000000011', 's11-author-w', 'S11 Author W', 'published'),
  ('52000000-0000-4000-8000-000000000012', 's11-author-m', 'S11 Author M', 'published'),
  ('52000000-0000-4000-8000-000000000013', 's11-author-m2', 'S11 Author M2', 'published'),
  ('52000000-0000-4000-8000-000000000014', 's11-author-p4', 'S11 Author P4', 'published');

insert into public.series (id, canonical_slug, display_name, status) values
  ('53000000-0000-4000-8000-000000000001', 's11-series', 'S11 Series', 'published'),
  ('53000000-0000-4000-8000-000000000002', 's11-series-m', 'S11 Series M', 'published');

insert into public.topics (id, canonical_slug, name, status) values
  ('54000000-0000-4000-8000-000000000001', 's11-topic-1', 'S11 Topic 1', 'published'),
  ('54000000-0000-4000-8000-000000000002', 's11-topic-2', 'S11 Topic 2', 'published'),
  ('54000000-0000-4000-8000-000000000003', 's11-topic-m1', 'S11 Topic M1', 'published'),
  ('54000000-0000-4000-8000-000000000004', 's11-topic-m2', 'S11 Topic M2', 'published');

-- One book plus the whole chain a reader needs to open it: an edition, an ebook asset, a
-- publication, and the books.active_publication_id pointer that publish_publication would set.
-- The nullable arguments are the eligibility knobs: p_locale null means no localization at all,
-- p_publication_status null means no publication row, and p_activate false means the publication
-- exists but was never made active.
create function pg_temp.seed_book(
  p_id uuid,
  p_key text,
  p_author_id uuid,
  p_status public.content_status,
  p_locale text,
  p_publication_status public.publication_status,
  p_activate boolean,
  p_publication_date date
) returns void
language plpgsql
as $$
declare
  v_edition_id uuid := gen_random_uuid();
  v_asset_id uuid := gen_random_uuid();
  v_publication_id uuid := gen_random_uuid();
begin
  insert into public.books (id, canonical_key, original_language, primary_author_id, status)
  values (p_id, p_key, 'en', p_author_id, p_status);

  insert into public.editions (id, book_id, language_code, publication_date)
  values (v_edition_id, p_id, 'en', p_publication_date);

  if p_locale is not null then
    insert into public.book_localizations (book_id, locale, slug, title)
    values (p_id, p_locale, p_key, 'Title ' || p_key);
  end if;

  if p_publication_status is not null then
    insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
    values (v_asset_id, v_edition_id, 'epub/' || p_key || '.epub', 1, 'published');
    insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status)
    values (v_publication_id, v_asset_id, 1, 'manifest/' || p_key || '.json', p_publication_status);
    if p_activate then
      update public.editions e set active_publication_id = pub.id, status = 'published'
from public.books b, public.ebook_publications pub join public.ebook_assets pa on pa.id = pub.ebook_asset_id
where b.id = e.book_id and pa.edition_id = e.id and pub.id = v_publication_id and (b.id = p_id);
    end if;
  end if;
end;
$$;

-- World E - eligibility. Every candidate shares author E with the seed, so each is worth 50 on
-- signal alone and only its eligibility decides whether it comes back.
select pg_temp.seed_book('51000000-0000-4000-8000-000000000001', 's11-e-seed', '52000000-0000-4000-8000-000000000001', 'published', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000002', 's11-e-eligible', '52000000-0000-4000-8000-000000000001', 'published', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000003', 's11-e-draft', '52000000-0000-4000-8000-000000000001', 'draft', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000004', 's11-e-no-active', '52000000-0000-4000-8000-000000000001', 'published', 'en', 'published', false, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000005', 's11-e-not-published', '52000000-0000-4000-8000-000000000001', 'published', 'en', 'ready_for_preview', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000006', 's11-e-vi-only', '52000000-0000-4000-8000-000000000001', 'published', 'vi', 'published', true, '2025-01-01');

-- World S - scoring. One candidate per signal, plus an editorial pin that carries no signal at
-- all, so "pinned first" cannot be confused with "highest score first".
select pg_temp.seed_book('51000000-0000-4000-8000-000000000010', 's11-s-seed', '52000000-0000-4000-8000-000000000002', 'published', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000011', 's11-s-series', '52000000-0000-4000-8000-000000000003', 'published', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000012', 's11-s-author', '52000000-0000-4000-8000-000000000002', 'published', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000013', 's11-s-topic-1', '52000000-0000-4000-8000-000000000004', 'published', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000014', 's11-s-topic-2', '52000000-0000-4000-8000-000000000005', 'published', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000015', 's11-s-pinned', '52000000-0000-4000-8000-000000000006', 'published', 'en', 'published', true, '2025-01-01');

insert into public.book_series (book_id, series_id, position) values
  ('51000000-0000-4000-8000-000000000010', '53000000-0000-4000-8000-000000000001', 1),
  ('51000000-0000-4000-8000-000000000011', '53000000-0000-4000-8000-000000000001', 2);

insert into public.book_topics (book_id, topic_id) values
  ('51000000-0000-4000-8000-000000000010', '54000000-0000-4000-8000-000000000001'),
  ('51000000-0000-4000-8000-000000000010', '54000000-0000-4000-8000-000000000002'),
  ('51000000-0000-4000-8000-000000000013', '54000000-0000-4000-8000-000000000001'),
  ('51000000-0000-4000-8000-000000000014', '54000000-0000-4000-8000-000000000001'),
  ('51000000-0000-4000-8000-000000000014', '54000000-0000-4000-8000-000000000002');

-- World T - tie-breaks. Five candidates all worth exactly 50 (shared author T), separated only by
-- publication date and then by book_id. The last one has no edition date, so it falls back to the
-- book's creation date, which is set below to a date older than every other candidate's.
--
-- `s11-t-older-b` is seeded SECOND of the three same-date candidates but holds the LOWEST id of
-- the three (…01f), so book_id order and insertion order disagree. An implementation that
-- returned rows in physical order instead of sorting by book_id would therefore be caught.
select pg_temp.seed_book('51000000-0000-4000-8000-000000000020', 's11-t-seed', '52000000-0000-4000-8000-000000000007', 'published', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000021', 's11-t-newer', '52000000-0000-4000-8000-000000000007', 'published', 'en', 'published', true, '2025-01-02');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000022', 's11-t-older-a', '52000000-0000-4000-8000-000000000007', 'published', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-00000000001f', 's11-t-older-b', '52000000-0000-4000-8000-000000000007', 'published', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000024', 's11-t-older-c', '52000000-0000-4000-8000-000000000007', 'published', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000025', 's11-t-no-date', '52000000-0000-4000-8000-000000000007', 'published', 'en', 'published', true, null);
update public.books set created_at = timestamptz '2020-01-01 00:00:00+00'
where id = '51000000-0000-4000-8000-000000000025';

-- World P - pins across two seeds. P_X is pinned third under seed 1 and first under seed 2; P_Y is
-- pinned second under seed 1 only. Nothing in this world carries any signal - the two seeds have
-- different authors from each other too - so only the pin positions can order anything, and only
-- the SMALLEST of P_X's two positions puts it ahead of P_Y.
select pg_temp.seed_book('51000000-0000-4000-8000-000000000030', 's11-p-seed-1', '52000000-0000-4000-8000-000000000008', 'published', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000031', 's11-p-seed-2', '52000000-0000-4000-8000-000000000014', 'published', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000032', 's11-p-x', '52000000-0000-4000-8000-000000000009', 'published', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000033', 's11-p-y', '52000000-0000-4000-8000-000000000010', 'published', 'en', 'published', true, '2025-01-01');

-- World M - "at most once across all seeds". Both seeds are in series M and both hold topic M1;
-- seed 1 also holds topic M2. M_BOTH matches BOTH seeds on the series and on topic M1, and the
-- first seed alone on topic M2, so it is the fixture that separates "weight per candidate" from
-- "weight per matching seed": 100 + 10 + 10 = 120 the right way, 200 + 30 = 230 the wrong way.
-- M_AUTHOR does the same for the author signal - it shares its primary author with both seeds and
-- must still be worth 50, not 100.
select pg_temp.seed_book('51000000-0000-4000-8000-000000000050', 's11-m-seed-1', '52000000-0000-4000-8000-000000000012', 'published', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000051', 's11-m-seed-2', '52000000-0000-4000-8000-000000000012', 'published', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000052', 's11-m-both', '52000000-0000-4000-8000-000000000013', 'published', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000053', 's11-m-author', '52000000-0000-4000-8000-000000000012', 'published', 'en', 'published', true, '2025-01-01');

insert into public.book_series (book_id, series_id, position) values
  ('51000000-0000-4000-8000-000000000050', '53000000-0000-4000-8000-000000000002', 1),
  ('51000000-0000-4000-8000-000000000051', '53000000-0000-4000-8000-000000000002', 2),
  ('51000000-0000-4000-8000-000000000052', '53000000-0000-4000-8000-000000000002', 3);

insert into public.book_topics (book_id, topic_id) values
  ('51000000-0000-4000-8000-000000000050', '54000000-0000-4000-8000-000000000003'),
  ('51000000-0000-4000-8000-000000000050', '54000000-0000-4000-8000-000000000004'),
  ('51000000-0000-4000-8000-000000000051', '54000000-0000-4000-8000-000000000003'),
  ('51000000-0000-4000-8000-000000000052', '54000000-0000-4000-8000-000000000003'),
  ('51000000-0000-4000-8000-000000000052', '54000000-0000-4000-8000-000000000004');

-- World W - the writer. Draft books with no publication: a pin must not carry an unpublishable
-- book into a recommendation, and asserting that needs a pinned book that fails eligibility.
select pg_temp.seed_book('51000000-0000-4000-8000-000000000040', 's11-w-seed', '52000000-0000-4000-8000-000000000011', 'draft', null, null, false, null);
select pg_temp.seed_book('51000000-0000-4000-8000-000000000041', 's11-w-b', '52000000-0000-4000-8000-000000000011', 'draft', null, null, false, null);
select pg_temp.seed_book('51000000-0000-4000-8000-000000000042', 's11-w-c', '52000000-0000-4000-8000-000000000011', 'draft', null, null, false, null);

-- World B - bundle membership, and the published-status gate on every grouping that scores.
--
-- Each candidate here has an author of its own, so the only thing that can move its score is the
-- grouping under test. Three of the four groupings are deliberately unpublished: the public
-- catalog reads join topics and series with status = 'published' (20260915100000), so a draft
-- grouping is invisible on the site, and scoring one would surface a "related book" whose stated
-- relationship a reader cannot see anywhere. s11-b-bundle sits in TWO published bundles with the
-- seed, which is what proves the bundle weight lands at most once per candidate.
insert into public.authors (id, canonical_slug, display_name, status) values
  ('52000000-0000-4000-8000-000000000016', 's11-author-b-seed', 'S11 Author B Seed', 'published'),
  ('52000000-0000-4000-8000-000000000017', 's11-author-b-bundle', 'S11 Author B Bundle', 'published'),
  ('52000000-0000-4000-8000-000000000018', 's11-author-b-dtopic', 'S11 Author B DTopic', 'published'),
  ('52000000-0000-4000-8000-000000000019', 's11-author-b-dseries', 'S11 Author B DSeries', 'published'),
  ('52000000-0000-4000-8000-00000000001a', 's11-author-b-dbundle', 'S11 Author B DBundle', 'published'),
  ('52000000-0000-4000-8000-00000000001b', 's11-author-b-draft', 'S11 Author B Draft', 'published');
insert into public.series (id, canonical_slug, display_name, status) values
  ('53000000-0000-4000-8000-000000000004', 's11-series-draft', 'S11 Series Draft', 'draft');
insert into public.topics (id, canonical_slug, name, status) values
  ('54000000-0000-4000-8000-000000000005', 's11-topic-draft', 'S11 Topic Draft', 'archived');
insert into public.bundles (id, status) values
  ('55000000-0000-4000-8000-000000000001', 'published'),
  ('55000000-0000-4000-8000-000000000002', 'published'),
  ('55000000-0000-4000-8000-000000000003', 'draft');

select pg_temp.seed_book('51000000-0000-4000-8000-000000000080', 's11-b-seed', '52000000-0000-4000-8000-000000000016', 'published', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000081', 's11-b-bundle', '52000000-0000-4000-8000-000000000017', 'published', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000082', 's11-b-dtopic', '52000000-0000-4000-8000-000000000018', 'published', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000083', 's11-b-dseries', '52000000-0000-4000-8000-000000000019', 'published', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000084', 's11-b-dbundle', '52000000-0000-4000-8000-00000000001a', 'published', 'en', 'published', true, '2025-01-01');

-- The draft-seed pair: a caller may pass any id, including one no reader can open. The candidate
-- shares the draft seed's primary author, so an unfiltered seed would hand it back worth 50 and
-- leak the draft's author in the process.
select pg_temp.seed_book('51000000-0000-4000-8000-000000000085', 's11-b-draft-seed', '52000000-0000-4000-8000-00000000001b', 'draft', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000086', 's11-b-draft-mate', '52000000-0000-4000-8000-00000000001b', 'published', 'en', 'published', true, '2025-01-01');

insert into public.bundle_editions (bundle_id, edition_id, position)
select v.bundle_id::uuid, (select e.id from public.editions e where e.book_id = v.book_id::uuid order by e.id limit 1), v.position
from (values
  ('55000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000080', 1),
  ('55000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000081', 2),
  ('55000000-0000-4000-8000-000000000002', '51000000-0000-4000-8000-000000000080', 1),
  ('55000000-0000-4000-8000-000000000002', '51000000-0000-4000-8000-000000000081', 2),
  ('55000000-0000-4000-8000-000000000003', '51000000-0000-4000-8000-000000000080', 1),
  ('55000000-0000-4000-8000-000000000003', '51000000-0000-4000-8000-000000000084', 2)) as v(bundle_id, book_id, position);

insert into public.book_series (book_id, series_id, position) values
  ('51000000-0000-4000-8000-000000000080', '53000000-0000-4000-8000-000000000004', 1),
  ('51000000-0000-4000-8000-000000000083', '53000000-0000-4000-8000-000000000004', 2);

insert into public.book_topics (book_id, topic_id) values
  ('51000000-0000-4000-8000-000000000080', '54000000-0000-4000-8000-000000000005'),
  ('51000000-0000-4000-8000-000000000082', '54000000-0000-4000-8000-000000000005');

-- World Z - the created_at fallback must not depend on the calling session's TimeZone.
-- s11-tz-fallback has no edition publication_date at all, so its ordering position comes
-- entirely from created_at, pinned to 2025-01-01 03:00:00+00 - a moment that lands on
-- 2024-12-31 in Pacific/Honolulu (UTC-10) but on 2025-01-01, the same calendar day as
-- s11-tz-real's edition date, in Pacific/Kiritimati (UTC+14). A fallback cast in the session
-- TimeZone would therefore rank these two candidates in opposite orders depending on who is
-- calling; normalized to UTC first, they must rank the same way regardless.
insert into public.authors (id, canonical_slug, display_name, status) values
  ('52000000-0000-4000-8000-000000000015', 's11-author-z', 'S11 Author Z', 'published');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000070', 's11-tz-seed', '52000000-0000-4000-8000-000000000015', 'published', 'en', 'published', true, '2025-01-01');
select pg_temp.seed_book('51000000-0000-4000-8000-000000000071', 's11-tz-fallback', '52000000-0000-4000-8000-000000000015', 'published', 'en', 'published', true, null);
select pg_temp.seed_book('51000000-0000-4000-8000-000000000072', 's11-tz-real', '52000000-0000-4000-8000-000000000015', 'published', 'en', 'published', true, '2025-01-01');
update public.books set created_at = timestamptz '2025-01-01 03:00:00+00'
where id = '51000000-0000-4000-8000-000000000071';

-- Shape --------------------------------------------------------------------------------------

select has_table('public', 'related_books', 'directed editorial relation exists');
select col_is_pk('public', 'related_books', array['book_id', 'related_book_id'], 'pair is the primary key');
select has_check('public', 'related_books', 'self relation is rejected');
select has_function('public', 'admin_set_related_books', array['uuid', 'uuid[]'], 'admin pin writer exists');
select has_function('public', 'recommend_books', array['uuid[]', 'uuid[]', 'text', 'integer'], 'recommendation RPC exists');

select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('admin_set_related_books', 'recommend_books')
     and (not p.prosecdef or not (p.proconfig @> array['search_path=""']))),
  0::bigint,
  'both S11 functions are security definer with an empty search_path');

select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace,
   lateral aclexplode(p.proacl) a
   where n.nspname = 'public'
     and p.proname in ('admin_set_related_books', 'recommend_books')
     and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  0::bigint,
  'PUBLIC holds no execute grant on either S11 function');

select is(
  has_function_privilege('anon', 'public.admin_set_related_books(uuid, uuid[])', 'EXECUTE'),
  false, 'anon cannot execute the pin writer');
select is(
  has_function_privilege('anon', 'public.recommend_books(uuid[], uuid[], text, integer)', 'EXECUTE'),
  true, 'anon can execute the recommendation RPC');
select is(
  has_function_privilege('authenticated', 'public.recommend_books(uuid[], uuid[], text, integer)', 'EXECUTE'),
  true, 'a signed-in reader can execute the recommendation RPC');

select throws_ok(
  $$ insert into public.related_books(book_id, related_book_id, position)
     values ('51000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', 1) $$,
  '23514', null, 'a book cannot pin itself');

-- No browser role writes the table ---------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '50000000-0000-4000-8000-000000000002', true);
-- What a reader can READ is asserted further down, once there are pins to read. Here there are
-- none, so a count of 0 would prove nothing about the policy.
select throws_ok(
  $$insert into public.related_books(book_id, related_book_id, position)
    values ('51000000-0000-4000-8000-000000000040', '51000000-0000-4000-8000-000000000041', 1)$$,
  '42501', null, 'a reader cannot insert a pin directly');
select throws_ok(
  $$delete from public.related_books$$,
  '42501', null, 'a reader cannot delete pins directly');
select throws_ok(
  $$select public.admin_set_related_books('51000000-0000-4000-8000-000000000040', array['51000000-0000-4000-8000-000000000041']::uuid[])$$,
  '42501', null, 'a reader cannot call the pin writer');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '50000000-0000-4000-8000-000000000001', true);
select throws_ok(
  $$insert into public.related_books(book_id, related_book_id, position)
    values ('51000000-0000-4000-8000-000000000040', '51000000-0000-4000-8000-000000000041', 1)$$,
  '42501', null, 'not even an admin writes the table directly - the RPC is the only path');
reset role;

-- The audited writer -----------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '50000000-0000-4000-8000-000000000001', true);

select lives_ok(
  $$select public.admin_set_related_books('51000000-0000-4000-8000-000000000040',
      array['51000000-0000-4000-8000-000000000041', '51000000-0000-4000-8000-000000000042']::uuid[])$$,
  'an admin saves an ordered set of pins');
select results_eq(
  $$select related_book_id, position from public.related_books
    where book_id = '51000000-0000-4000-8000-000000000040' order by position$$,
  $$values ('51000000-0000-4000-8000-000000000041'::uuid, 1),
           ('51000000-0000-4000-8000-000000000042'::uuid, 2)$$,
  'positions follow the submitted order, contiguous from 1');
select is(
  (select count(*)::int from public.audit_logs
    where action = 'set_related_books' and entity_id = '51000000-0000-4000-8000-000000000040'),
  1,
  'saving editorial pins writes one audit row');
select is(
  (select metadata->'related_book_ids' from public.audit_logs
    where action = 'set_related_books' and entity_id = '51000000-0000-4000-8000-000000000040'),
  to_jsonb(array['51000000-0000-4000-8000-000000000041'::uuid, '51000000-0000-4000-8000-000000000042'::uuid]),
  'audit metadata preserves pin order');
select is(
  (select count(*)::int from public.related_books where book_id = '51000000-0000-4000-8000-000000000041'),
  0,
  'pinning B under A does not pin A under B');

select lives_ok(
  $$select public.admin_set_related_books('51000000-0000-4000-8000-000000000040',
      array['51000000-0000-4000-8000-000000000042']::uuid[])$$,
  'an admin replaces the set with a shorter one');
select results_eq(
  $$select related_book_id, position from public.related_books
    where book_id = '51000000-0000-4000-8000-000000000040' order by position$$,
  $$values ('51000000-0000-4000-8000-000000000042'::uuid, 1)$$,
  'a replacement rewrites positions to 1..N rather than leaving a gap');
select is(
  (select count(*)::int from public.audit_logs
    where action = 'set_related_books' and entity_id = '51000000-0000-4000-8000-000000000040'),
  2,
  'the replacement writes a second audit row');

-- Rejected calls change nothing. pgTAP runs each of these in a subtransaction, so what the
-- assertions after them read is what the function itself left behind.
select throws_ok(
  $$select public.admin_set_related_books('51000000-0000-4000-8000-000000000040',
      array['51000000-0000-4000-8000-000000000042', '51000000-0000-4000-8000-000000000040']::uuid[])$$,
  '22023', null, 'a book cannot be pinned under itself through the RPC');
select throws_ok(
  $$select public.admin_set_related_books('51000000-0000-4000-8000-000000000040',
      array['51000000-0000-4000-8000-000000000042', '51000000-0000-4000-8000-000000000042']::uuid[])$$,
  '22023', null, 'the same book cannot be pinned twice');
select throws_ok(
  $$select public.admin_set_related_books('51000000-0000-4000-8000-000000000040',
      array['51000000-0000-4000-8000-000000000042', null]::uuid[])$$,
  '22023', 'admin_set_related_books: a pin list cannot contain a null book id',
  'a null entry in the pin list is refused by name, not as a phantom duplicate');
select throws_ok(
  $$select public.admin_set_related_books('51000000-0000-4000-8000-000000000040',
      array['51000000-0000-4000-8000-0000000000ff']::uuid[])$$,
  'P0002', null, 'an unknown candidate is refused');
select throws_ok(
  $$select public.admin_set_related_books('51000000-0000-4000-8000-0000000000ff',
      array['51000000-0000-4000-8000-000000000042']::uuid[])$$,
  'P0002', null, 'an unknown source book is refused');
select results_eq(
  $$select related_book_id, position from public.related_books
    where book_id = '51000000-0000-4000-8000-000000000040' order by position$$,
  $$values ('51000000-0000-4000-8000-000000000042'::uuid, 1)$$,
  'a rejected call leaves the previous ordered set unchanged');
select is(
  (select count(*)::int from public.audit_logs
    where action = 'set_related_books' and entity_id = '51000000-0000-4000-8000-000000000040'),
  2,
  'a rejected call writes no audit row');

select lives_ok(
  $$select public.admin_set_related_books('51000000-0000-4000-8000-000000000040', array[]::uuid[])$$,
  'an admin clears every pin by saving an empty set');
select is(
  (select count(*)::int from public.related_books where book_id = '51000000-0000-4000-8000-000000000040'),
  0,
  'clearing removes the pins');
reset role;

-- The editorial pins the ordering assertions below need. Written through the RPC as the admin, so
-- the fixtures themselves prove the writer is the only path the rest of the file depends on.
set local role authenticated;
select set_config('request.jwt.claim.sub', '50000000-0000-4000-8000-000000000001', true);
select public.admin_set_related_books('51000000-0000-4000-8000-000000000010',
  array['51000000-0000-4000-8000-000000000015']::uuid[]);
select public.admin_set_related_books('51000000-0000-4000-8000-000000000030',
  array['51000000-0000-4000-8000-000000000041', '51000000-0000-4000-8000-000000000033', '51000000-0000-4000-8000-000000000032']::uuid[]);
select public.admin_set_related_books('51000000-0000-4000-8000-000000000031',
  array['51000000-0000-4000-8000-000000000032']::uuid[]);
reset role;

-- Who can read the pins, now that there are pins to read ----------------------------------------
--
-- The select policy is the only thing standing between a signed-in reader and the whole editorial
-- plan for the catalog, so both directions are asserted against the same non-empty table: a
-- reader sees nothing, and an admin sees exactly what was written. The admin direction is also
-- the path the admin editor uses to load a shelf back through the Data API.

set local role authenticated;
select set_config('request.jwt.claim.sub', '50000000-0000-4000-8000-000000000002', true);
select is(
  (select count(*)::int from public.related_books),
  0, 'a signed-in reader sees no editorial pins even when the table is not empty');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '50000000-0000-4000-8000-000000000001', true);
select results_eq(
  $$select book_id, related_book_id, position from public.related_books
    order by book_id, position$$,
  $$values ('51000000-0000-4000-8000-000000000010'::uuid, '51000000-0000-4000-8000-000000000015'::uuid, 1),
           ('51000000-0000-4000-8000-000000000030'::uuid, '51000000-0000-4000-8000-000000000041'::uuid, 1),
           ('51000000-0000-4000-8000-000000000030'::uuid, '51000000-0000-4000-8000-000000000033'::uuid, 2),
           ('51000000-0000-4000-8000-000000000030'::uuid, '51000000-0000-4000-8000-000000000032'::uuid, 3),
           ('51000000-0000-4000-8000-000000000031'::uuid, '51000000-0000-4000-8000-000000000032'::uuid, 1)$$,
  'an admin reads every editorial pin back through the Data API');
reset role;

-- Eligibility ------------------------------------------------------------------------------------

select results_eq(
  $$select book_id from public.recommend_books(
      array['51000000-0000-4000-8000-000000000001']::uuid[], array[]::uuid[], 'en', 6)$$,
  $$values ('51000000-0000-4000-8000-000000000002'::uuid)$$,
  'a draft book, an inactive publication, an unpublished publication, a missing localization and the seed itself are all excluded');

select results_eq(
  $$select book_id from public.recommend_books(
      array['51000000-0000-4000-8000-000000000001']::uuid[], array[]::uuid[], 'vi', 6)$$,
  $$values ('51000000-0000-4000-8000-000000000002'::uuid), ('51000000-0000-4000-8000-000000000006'::uuid)$$,
  'a locale never hides a readable work: the Vietnamese shelf also carries the English-only book, under its English copy');

select is(
  (select count(*)::int from public.recommend_books(
      array['51000000-0000-4000-8000-000000000001']::uuid[],
      array['51000000-0000-4000-8000-000000000002']::uuid[], 'en', 6)),
  0,
  'p_exclude_book_ids removes an otherwise eligible candidate');

-- Seed P1's shelf is pinned [draft W_B, P_Y, P_X]. A pin is an ordering override, never an
-- eligibility override, so the draft book at position 1 is simply absent and the two published
-- pins keep their relative order.
select results_eq(
  $$select book_id from public.recommend_books(
      array['51000000-0000-4000-8000-000000000030']::uuid[], array[]::uuid[], 'en', 6)$$,
  $$values ('51000000-0000-4000-8000-000000000033'::uuid),
           ('51000000-0000-4000-8000-000000000032'::uuid)$$,
  'an editorial pin does not carry a draft book into a recommendation');

set local role anon;
select results_eq(
  $$select book_id from public.recommend_books(
      array['51000000-0000-4000-8000-000000000001']::uuid[], array[]::uuid[], 'en', 6)$$,
  $$values ('51000000-0000-4000-8000-000000000002'::uuid)$$,
  'anonymous callers receive only explicitly published, localized, active-publication books');
reset role;

-- Scoring and order --------------------------------------------------------------------------------

select results_eq(
  $$select book_id, score, pinned from public.recommend_books(
      array['51000000-0000-4000-8000-000000000010']::uuid[], array[]::uuid[], 'en', 100)$$,
  $$values ('51000000-0000-4000-8000-000000000015'::uuid, 0, true),
           ('51000000-0000-4000-8000-000000000011'::uuid, 100, false),
           ('51000000-0000-4000-8000-000000000012'::uuid, 50, false),
           ('51000000-0000-4000-8000-000000000014'::uuid, 20, false),
           ('51000000-0000-4000-8000-000000000013'::uuid, 10, false)$$,
  'series scores 100, the primary author 50, each shared topic 10, and the pin leads on score 0');

select is(
  (select count(*)::int from public.recommend_books(
      array['51000000-0000-4000-8000-000000000010']::uuid[], array[]::uuid[], 'en', 2)),
  2,
  'p_limit caps the number of rows');

select results_eq(
  $$select book_id, score from public.recommend_books(
      array['51000000-0000-4000-8000-000000000050', '51000000-0000-4000-8000-000000000051']::uuid[],
      array[]::uuid[], 'en', 100)$$,
  $$values ('51000000-0000-4000-8000-000000000052'::uuid, 120),
           ('51000000-0000-4000-8000-000000000053'::uuid, 50)$$,
  'series, author and each shared topic are worth their weight once per candidate, however many seeds they match');

select results_eq(
  $$select book_id from public.recommend_books(
      array['51000000-0000-4000-8000-000000000020']::uuid[], array[]::uuid[], 'en', 100)$$,
  $$values ('51000000-0000-4000-8000-000000000021'::uuid),
           ('51000000-0000-4000-8000-00000000001f'::uuid),
           ('51000000-0000-4000-8000-000000000022'::uuid),
           ('51000000-0000-4000-8000-000000000024'::uuid),
           ('51000000-0000-4000-8000-000000000025'::uuid)$$,
  'equal scores order by publication date descending - falling back to the creation date - then by book_id');

-- The created_at fallback is normalized to UTC before the cast, so the tie between
-- s11-tz-fallback and s11-tz-real (and therefore their order) must not move when the calling
-- session's TimeZone changes.
set local TimeZone to 'Pacific/Honolulu';
create temporary table tz_honolulu as
  select row_number() over () as ordinal, book_id, score, pinned
  from public.recommend_books(
    array['51000000-0000-4000-8000-000000000070']::uuid[], array[]::uuid[], 'en', 100);

set local TimeZone to 'Pacific/Kiritimati';
create temporary table tz_kiritimati as
  select row_number() over () as ordinal, book_id, score, pinned
  from public.recommend_books(
    array['51000000-0000-4000-8000-000000000070']::uuid[], array[]::uuid[], 'en', 100);

reset TimeZone;

select results_eq(
  'select ordinal, book_id, score, pinned from tz_honolulu order by ordinal',
  'select ordinal, book_id, score, pinned from tz_kiritimati order by ordinal',
  'a candidate whose date comes from created_at orders the same way regardless of the calling session''s TimeZone');
select results_eq(
  'select book_id from tz_kiritimati order by ordinal',
  $$values ('51000000-0000-4000-8000-000000000071'::uuid), ('51000000-0000-4000-8000-000000000072'::uuid)$$,
  'tied on every scored signal and on the UTC-normalized date, the lower book_id sorts first');

select results_eq(
  $$select book_id from public.recommend_books(
      array['51000000-0000-4000-8000-000000000030', '51000000-0000-4000-8000-000000000031']::uuid[],
      array[]::uuid[], 'en', 100)$$,
  $$values ('51000000-0000-4000-8000-000000000032'::uuid),
           ('51000000-0000-4000-8000-000000000033'::uuid)$$,
  'the lowest pin position across every seed decides the order of two pinned books');

select is(
  (select count(*)::int from public.recommend_books(array[]::uuid[], array[]::uuid[], 'en', 6)),
  0, 'no seeds means no recommendations');
select is(
  (select count(*)::int from public.recommend_books(null::uuid[], null::uuid[], 'en', 6)),
  0, 'null seed and exclusion arrays are treated as empty rather than raising');
select is(
  (select count(*)::int from public.recommend_books(
      array['51000000-0000-4000-8000-000000000010']::uuid[], array[]::uuid[], 'en', null)),
  0, 'a null limit returns nothing rather than raising');
select is(
  (select count(*)::int from public.recommend_books(
      array['51000000-0000-4000-8000-000000000010']::uuid[], array[]::uuid[], 'en', -5)),
  0, 'a negative limit returns nothing rather than raising');

-- Repeatability: the same inputs produce the same rows in the same positions.
create temporary table first_call as
  select row_number() over () as ordinal, *
  from public.recommend_books(
    array['51000000-0000-4000-8000-000000000010', '51000000-0000-4000-8000-000000000020']::uuid[],
    array[]::uuid[], 'en', 100);
create temporary table second_call as
  select row_number() over () as ordinal, *
  from public.recommend_books(
    array['51000000-0000-4000-8000-000000000010', '51000000-0000-4000-8000-000000000020']::uuid[],
    array[]::uuid[], 'en', 100);
select isnt_empty('select 1 from first_call', 'the repeatability fixture returns rows to compare');
select results_eq(
  'select ordinal, book_id, score, pinned from first_call order by ordinal',
  'select ordinal, book_id, score, pinned from second_call order by ordinal',
  'identical inputs return identical ordering');


-- Bundle membership, and the published gate on scoring groupings ---------------------------------

-- One call settles World B: the bundle mate is the ONLY row, so the draft topic, the draft series
-- and the draft bundle each contributed nothing, and its score is the bundle weight exactly once
-- even though it shares two published bundles with the seed.
select results_eq(
  $$select book_id, score, pinned from public.recommend_books(
      array['51000000-0000-4000-8000-000000000080']::uuid[], array[]::uuid[], 'en', 6)$$,
  $$values ('51000000-0000-4000-8000-000000000081'::uuid, 5, false)$$,
  'a shared published bundle scores 5 once, and no draft grouping scores at all');

-- Each absence again on its own, so a regression names the grouping that leaked rather than just
-- failing the combined row set above.
select is(
  (select count(*)::int from public.recommend_books(
     array['51000000-0000-4000-8000-000000000080']::uuid[], array[]::uuid[], 'en', 6) r
   where r.book_id = '51000000-0000-4000-8000-000000000082'),
  0, 'a topic that is not published scores nothing');
select is(
  (select count(*)::int from public.recommend_books(
     array['51000000-0000-4000-8000-000000000080']::uuid[], array[]::uuid[], 'en', 6) r
   where r.book_id = '51000000-0000-4000-8000-000000000083'),
  0, 'a series that is not published scores nothing');
select is(
  (select count(*)::int from public.recommend_books(
     array['51000000-0000-4000-8000-000000000080']::uuid[], array[]::uuid[], 'en', 6) r
   where r.book_id = '51000000-0000-4000-8000-000000000084'),
  0, 'a bundle that is not published scores nothing');

-- An unpublished seed contributes no signals, so nothing it is grouped with can be inferred from
-- the result. Its published author-mate would score 50 if seeds were taken at face value.
select is_empty(
  $$select book_id from public.recommend_books(
      array['51000000-0000-4000-8000-000000000085']::uuid[], array[]::uuid[], 'en', 6)$$,
  'a seed that is not published contributes no signal');

select * from finish();
rollback;
