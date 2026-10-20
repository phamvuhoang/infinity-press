begin;
select plan(155);

-- S12: the audited knowledge admin RPCs, the publish gates, and redirect-safe slug writes
-- (docs/superpowers/specs/2026-09-21-s12-knowledge-hub-design.md sections 7 and 9, plan Task 3).
--
-- 054_s12_knowledge_schema.sql proved no browser role can write a knowledge table. This file
-- proves the only write path is sound: each RPC is admin-only, validates its input, performs one
-- logical mutation, and leaves exactly one correctly named audit row behind; each publish refuses
-- every readiness failure on its own with the codes lib/knowledge/readiness.ts parses; a published
-- slug rename leaves one flattened redirect; and an article keeps its first publish date.

-- Fixtures ------------------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'd5100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's12-admin-rpc-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd5100000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's12-admin-rpc-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'd5100000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name, status) values
  ('d5300000-0000-0000-0000-000000000001', 's12-rpc-author-1', 'S12 RPC Author 1', 'published'),
  ('d5300000-0000-0000-0000-000000000002', 's12-rpc-author-2', 'S12 RPC Author 2', 'published');

insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('d5200000-0000-0000-0000-000000000001', 's12-rpc-book-1', 'vi', 'd5300000-0000-0000-0000-000000000001', 'published'),
  ('d5200000-0000-0000-0000-000000000002', 's12-rpc-book-2', 'vi', 'd5300000-0000-0000-0000-000000000001', 'published'),
  ('d5200000-0000-0000-0000-000000000003', 's12-rpc-book-draft', 'vi', 'd5300000-0000-0000-0000-000000000001', 'draft'),
  ('d5200000-0000-0000-0000-000000000004', 's12-rpc-book-vi-only', 'vi', 'd5300000-0000-0000-0000-000000000001', 'published');

-- The public idea page shows a related book only in a locale the book is localized in.
insert into public.book_localizations (book_id, locale, slug, title) values
  ('d5200000-0000-0000-0000-000000000001', 'vi', 's12-rpc-book-1-vi', 'Sách một'),
  ('d5200000-0000-0000-0000-000000000001', 'en', 's12-rpc-book-1-en', 'Book one'),
  ('d5200000-0000-0000-0000-000000000002', 'vi', 's12-rpc-book-2-vi', 'Sách hai'),
  ('d5200000-0000-0000-0000-000000000002', 'en', 's12-rpc-book-2-en', 'Book two'),
  ('d5200000-0000-0000-0000-000000000003', 'vi', 's12-rpc-book-draft-vi', 'Sách nháp'),
  ('d5200000-0000-0000-0000-000000000004', 'vi', 's12-rpc-book-vi-only-vi', 'Sách chỉ tiếng Việt');

insert into public.topics (id, canonical_slug, name, status) values
  ('d5400000-0000-0000-0000-000000000001', 's12-rpc-topic-1', 'S12 RPC Topic 1', 'published'),
  ('d5400000-0000-0000-0000-000000000002', 's12-rpc-topic-2', 'S12 RPC Topic 2', 'published');

-- Rows created directly, so the refusals below have real ids to call against without any RPC
-- having had to succeed first, and so the readiness gate can see a parent with no localization
-- at all (no RPC can create one: creating is creating the first localization).
insert into public.ideas (id, status) values ('d5500000-0000-0000-0000-0000000000ff', 'draft');
insert into public.articles (id, status, author_id) values
  ('d5600000-0000-0000-0000-0000000000ff', 'draft', 'd5300000-0000-0000-0000-000000000001');

-- Ids minted by gen_random_uuid() inside the create RPCs cannot be hardcoded.
create temporary table t_ids (label text primary key, id uuid);
grant select, insert on t_ids to public;

create temporary table t_blocks (label text primary key, blocks jsonb);
insert into t_blocks values
  ('one', '[{"type":"paragraph","content":[{"text":"Một đoạn."}]}]'::jsonb),
  ('two', '[{"type":"paragraph","content":[{"text":"A."}]},{"type":"paragraph","content":[{"text":"B."}]}]'::jsonb),
  ('too_many', (select jsonb_agg('{"type":"paragraph","content":[{"text":"x"}]}'::jsonb) from generate_series(1, 101)));
grant select on t_blocks to public;

-- Shape ---------------------------------------------------------------------------------------
select has_function('public', 'admin_create_idea', array['text', 'text', 'text', 'text'], 'admin_create_idea exists');
select has_function('public', 'admin_create_article', array['uuid', 'text', 'text', 'text', 'text'], 'admin_create_article exists');
select has_function('public', 'admin_update_article', array['uuid', 'uuid'], 'admin_update_article exists');
select has_function('public', 'admin_save_idea_localization', array['uuid', 'text', 'text', 'text', 'text', 'jsonb'],
  'admin_save_idea_localization exists');
select has_function('public', 'admin_save_article_localization', array['uuid', 'text', 'text', 'text', 'text', 'jsonb'],
  'admin_save_article_localization exists');
select has_function('public', 'admin_save_idea_seo', array['uuid', 'text', 'text', 'text'], 'admin_save_idea_seo exists');
select has_function('public', 'admin_save_article_seo', array['uuid', 'text', 'text', 'text'], 'admin_save_article_seo exists');
select has_function('public', 'admin_set_idea_relations', array['uuid', 'uuid[]', 'uuid[]', 'uuid[]'],
  'admin_set_idea_relations exists');
select has_function('public', 'admin_set_article_relations', array['uuid', 'uuid[]', 'uuid[]', 'uuid[]'],
  'admin_set_article_relations exists');
select has_function('public', 'publish_idea', array['uuid'], 'publish_idea exists');
select has_function('public', 'unpublish_idea', array['uuid'], 'unpublish_idea exists');
select has_function('public', 'publish_article', array['uuid'], 'publish_article exists');
select has_function('public', 'unpublish_article', array['uuid'], 'unpublish_article exists');
select has_function('public', 'idea_readiness_issues', array['uuid'], 'idea_readiness_issues exists');
select has_function('public', 'article_readiness_issues', array['uuid'], 'article_readiness_issues exists');

create temporary table t_functions (name text primary key);
insert into t_functions values
  ('admin_create_idea'), ('admin_create_article'), ('admin_update_article'),
  ('admin_save_idea_localization'), ('admin_save_article_localization'),
  ('admin_save_idea_seo'), ('admin_save_article_seo'),
  ('admin_set_idea_relations'), ('admin_set_article_relations'),
  ('publish_idea'), ('unpublish_idea'), ('publish_article'), ('unpublish_article'),
  ('idea_readiness_issues'), ('article_readiness_issues');

select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in (select name from t_functions)),
  15::bigint,
  'each S12 admin function exists exactly once (no stray overloads)');
select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in (select name from t_functions)
     and (not p.prosecdef or not (p.proconfig @> array['search_path=""']))),
  0::bigint,
  'every S12 admin function is security definer with an empty search_path');
select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace,
   lateral aclexplode(p.proacl) a
   where n.nspname = 'public' and p.proname in (select name from t_functions)
     and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  0::bigint,
  'PUBLIC holds no execute grant on any S12 admin function');
select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in (select name from t_functions)
     and has_function_privilege('anon', p.oid, 'EXECUTE')),
  0::bigint,
  'anon holds no EXECUTE on any S12 admin function');
select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in (select name from t_functions)
     and p.proname not like '%readiness_issues'
     and not has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  0::bigint,
  'authenticated holds EXECUTE on every admin mutation (is_admin() gates inside)');
select is(
  has_function_privilege('authenticated', 'public.idea_readiness_issues(uuid)', 'EXECUTE'),
  false, 'idea_readiness_issues is internal to publish_idea, not browser-callable');
select is(
  has_function_privilege('authenticated', 'public.article_readiness_issues(uuid)', 'EXECUTE'),
  false, 'article_readiness_issues is internal to publish_article, not browser-callable');

select is(
  has_function_privilege('authenticated', 'public.knowledge_check_body_blocks(text, jsonb)', 'EXECUTE')
  or has_function_privilege('anon', 'public.knowledge_check_body_blocks(text, jsonb)', 'EXECUTE'),
  false, 'the body_blocks check is internal to the localization RPCs');
select is(
  has_function_privilege('authenticated', 'public.knowledge_check_id_list(text, text, uuid[])', 'EXECUTE')
  or has_function_privilege('anon', 'public.knowledge_check_id_list(text, text, uuid[])', 'EXECUTE'),
  false, 'the id-list check is internal to the relation RPCs');

-- A signed-in reader reaches none of it --------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd5100000-0000-0000-0000-000000000002', true);
select throws_ok($$select public.admin_create_idea('vi', 'sneaky', 'Q?', 'A.')$$,
  '42501', null, 'a reader cannot create an idea');
select throws_ok($$select public.admin_create_article('d5300000-0000-0000-0000-000000000001', 'vi', 'sneaky', 'T', 'E')$$,
  '42501', null, 'a reader cannot create an article');
select throws_ok($$select public.admin_update_article('d5600000-0000-0000-0000-0000000000ff', 'd5300000-0000-0000-0000-000000000002')$$,
  '42501', null, 'a reader cannot edit article details');
select throws_ok($$select public.admin_save_idea_localization('d5500000-0000-0000-0000-0000000000ff', 'vi', 'sneaky', 'Q?', 'A.', '[]'::jsonb)$$,
  '42501', null, 'a reader cannot localize an idea');
select throws_ok($$select public.admin_save_article_localization('d5600000-0000-0000-0000-0000000000ff', 'vi', 'sneaky', 'T', 'E', '[]'::jsonb)$$,
  '42501', null, 'a reader cannot localize an article');
select throws_ok($$select public.admin_save_idea_seo('d5500000-0000-0000-0000-0000000000ff', 'vi', 'T', 'D')$$,
  '42501', null, 'a reader cannot edit idea SEO');
select throws_ok($$select public.admin_save_article_seo('d5600000-0000-0000-0000-0000000000ff', 'vi', 'T', 'D')$$,
  '42501', null, 'a reader cannot edit article SEO');
select throws_ok($$select public.admin_set_idea_relations('d5500000-0000-0000-0000-0000000000ff', '{}', '{}', '{}')$$,
  '42501', null, 'a reader cannot relate an idea');
select throws_ok($$select public.admin_set_article_relations('d5600000-0000-0000-0000-0000000000ff', '{}', '{}', '{}')$$,
  '42501', null, 'a reader cannot relate an article');
select throws_ok($$select public.publish_idea('d5500000-0000-0000-0000-0000000000ff')$$,
  '42501', null, 'a reader cannot publish an idea');
select throws_ok($$select public.unpublish_idea('d5500000-0000-0000-0000-0000000000ff')$$,
  '42501', null, 'a reader cannot unpublish an idea');
select throws_ok($$select public.publish_article('d5600000-0000-0000-0000-0000000000ff')$$,
  '42501', null, 'a reader cannot publish an article');
select throws_ok($$select public.unpublish_article('d5600000-0000-0000-0000-0000000000ff')$$,
  '42501', null, 'a reader cannot unpublish an article');
reset role;

select is(
  (select count(*) from public.audit_logs a
   where a.entity_type in ('ideas', 'articles')
     and a.entity_id in ('d5500000-0000-0000-0000-0000000000ff', 'd5600000-0000-0000-0000-0000000000ff')),
  0::bigint, 'refused calls leave no audit rows');

-- Idea creation, localization, and SEO --------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd5100000-0000-0000-0000-000000000001', true);

insert into t_ids (label, id)
select 'idea', public.admin_create_idea('vi', 'vi-sao-can-tinh-thuc', 'Vì sao cần tỉnh thức?', 'Vì chú ý là nền tảng.');
insert into t_ids (label, id)
select 'idea2', public.admin_create_idea('en', 'what-is-attention', 'What is attention?', 'A choice.');

select is((select status from public.ideas where id = (select id from t_ids where label = 'idea')),
  'draft'::public.content_status, 'a new idea starts as a draft');
select results_eq(
  $$select locale, slug, question, short_answer, body_blocks from public.idea_localizations
    where idea_id = (select id from t_ids where label = 'idea')$$,
  $$values ('vi'::text, 'vi-sao-can-tinh-thuc'::text, 'Vì sao cần tỉnh thức?'::text, 'Vì chú ý là nền tảng.'::text, '[]'::jsonb)$$,
  'creation seeds the first localization with no blocks');
select throws_ok($$select public.admin_create_idea('fr', 'pourquoi', 'Q?', 'A.')$$,
  '22023', null, 'creating an idea in a locale outside vi|en is refused');
select throws_ok($$select public.admin_create_idea('vi', 'vi-sao-can-tinh-thuc', 'Q?', 'A.')$$,
  '23505', null, 'creating an idea with a taken (locale, slug) is refused');

-- A second locale inserts; saving the first again updates it in place.
select isnt(
  public.admin_save_idea_localization((select id from t_ids where label = 'idea'), 'en', 'why-awareness',
    'Why awareness?', 'Because attention comes first.', (select blocks from t_blocks where label = 'one')),
  null, 'saving a new locale returns its localization id');
select is(
  public.admin_save_idea_localization((select id from t_ids where label = 'idea'), 'vi', 'vi-sao-tinh-thuc',
    'Vì sao cần tỉnh thức?', 'Vì chú ý là nền tảng.', (select blocks from t_blocks where label = 'two')),
  (select l.id from public.idea_localizations l where l.idea_id = (select id from t_ids where label = 'idea') and l.locale = 'vi'),
  'saving an existing locale updates that localization in place');
select is(
  (select jsonb_array_length(body_blocks) from public.idea_localizations
   where idea_id = (select id from t_ids where label = 'idea') and locale = 'vi'),
  2, 'the saved localization carries the submitted blocks');
select is(
  (select count(*) from public.redirects where source_path = '/vi/ideas/vi-sao-can-tinh-thuc'),
  0::bigint, 'a draft idea slug edit writes no redirect');

select throws_ok(
  $$select public.admin_save_idea_localization((select id from t_ids where label = 'idea'), 'de', 'warum', 'Q?', 'A.', '[]'::jsonb)$$,
  '22023', null, 'localizing an idea in an unsupported locale is refused');
select throws_ok(
  $$select public.admin_save_idea_localization('d5500000-0000-0000-0000-00000000dead', 'vi', 'x', 'Q?', 'A.', '[]'::jsonb)$$,
  'P0002', null, 'localizing an idea that does not exist is refused');
select throws_ok(
  $$select public.admin_save_idea_localization((select id from t_ids where label = 'idea'), 'vi', 'x', 'Q?', 'A.', '{"type":"paragraph"}'::jsonb)$$,
  '22023', null, 'body_blocks must be a JSON array');
select throws_ok(
  $$select public.admin_save_idea_localization((select id from t_ids where label = 'idea'), 'vi', 'x', 'Q?', 'A.', (select blocks from t_blocks where label = 'too_many'))$$,
  '22023', null, 'body_blocks holds at most 100 blocks');
select throws_ok(
  $$select public.admin_save_idea_localization((select id from t_ids where label = 'idea'), 'vi', 'x', '   ', 'A.', '[]'::jsonb)$$,
  '23514', null, 'a blank question is refused by the schema');

-- Direct RPC calls bypass the Server Action, so the database enforces the typed-block contract of
-- lib/knowledge/blocks.ts itself (regression: an admin could store {} or markup through the RPC).
select throws_ok(
  $$select public.admin_save_idea_localization((select id from t_ids where label = 'idea'), 'vi', 'x', 'Q?', 'A.', '[{}]'::jsonb)$$,
  '22023', null, 'a block without a type is refused');
select throws_ok(
  $$select public.admin_save_idea_localization((select id from t_ids where label = 'idea'), 'vi', 'x', 'Q?', 'A.', '[{"type":"html","html":"<p>x</p>"}]'::jsonb)$$,
  '22023', null, 'an unknown block type is refused');
select throws_ok(
  $$select public.admin_save_idea_localization((select id from t_ids where label = 'idea'), 'vi', 'x', 'Q?', 'A.', '[{"type":"paragraph","content":[{"text":"<script>alert(1)</script>"}]}]'::jsonb)$$,
  '22023', null, 'markup in block text is refused');
select throws_ok(
  $$select public.admin_save_idea_localization((select id from t_ids where label = 'idea'), 'vi', 'x', 'Q?', 'A.', '[{"type":"paragraph","content":[{"text":"x","link":{"kind":"external","href":"javascript:alert(1)"}}]}]'::jsonb)$$,
  '22023', null, 'a non-http link is refused');
select throws_ok(
  $$select public.admin_save_idea_localization((select id from t_ids where label = 'idea'), 'vi', 'x', 'Q?', 'A.', '[{"type":"paragraph","content":[{"text":"x"}],"html":"<b>x</b>"}]'::jsonb)$$,
  '22023', null, 'an extra block key is refused');
select throws_ok(
  $$select public.admin_save_idea_localization((select id from t_ids where label = 'idea'), 'vi', 'x', 'Q?', 'A.', '[{"type":"quote","text":"x","attribution":"y","bookId":"d5200000-0000-4000-8000-000000000001"}]'::jsonb)$$,
  '22023', null, 'a quote with two attribution sources is refused');
-- Values Zod refuses must not reach the public DAL through the RPC (regression).
select throws_ok(
  $$select public.admin_save_idea_localization((select id from t_ids where label = 'idea'), 'vi', 'x', 'Q?', 'A.', '[{"type":"book_card","bookId":"d5200000-0000-0000-0000-000000000001"}]'::jsonb)$$,
  '22023', null, 'a uuid without a version and variant is refused like z.uuid()');
select throws_ok(
  $$select public.admin_save_idea_localization((select id from t_ids where label = 'idea'), 'vi', 'x', 'Q?', 'A.', '[{"type":"paragraph","content":[{"text":"x","link":{"kind":"external","href":"http://[::1"}}]}]'::jsonb)$$,
  '22023', null, 'an unparseable link host is refused like URL.canParse');
select throws_ok(
  $$select public.admin_save_idea_localization((select id from t_ids where label = 'idea'), 'vi', 'x', 'Q?', 'A.', '[{"type":"paragraph","content":[{"text":"x","link":{"kind":"external","href":"http://example.com:99999/"}}]}]'::jsonb)$$,
  '22023', null, 'an out-of-range port is refused like URL.canParse');
select lives_ok(
  format($$select public.admin_save_idea_localization((select id from t_ids where label = 'idea'), 'vi', 'x', 'Q?', 'A.', %L::jsonb)$$,
    jsonb_build_array(jsonb_build_object('type', 'book_quote', 'bookId', 'd5200000-0000-4000-8000-000000000001',
      'text', repeat(U&'\+01F469\200D\+01F4BB', 300)))),
  '300 grapheme clusters of multi-code-point emoji are accepted');
select throws_ok(
  format($$select public.admin_save_idea_localization((select id from t_ids where label = 'idea'), 'vi', 'x', 'Q?', 'A.', %L::jsonb)$$,
    jsonb_build_array(jsonb_build_object('type', 'book_quote', 'bookId', 'd5200000-0000-4000-8000-000000000001',
      'text', repeat(U&'\+01F469\200D\+01F4BB', 301)))),
  '22023', null, '301 grapheme clusters are refused');
select lives_ok(
  $$select public.admin_save_idea_localization((select id from t_ids where label = 'idea'), 'vi', 'vi-sao-tinh-thuc', 'Vì sao cần tỉnh thức?', 'Vì chú ý là nền tảng.', '[
    {"type":"heading","level":2,"text":"Tiêu đề"},
    {"type":"paragraph","content":[{"text":"Có ","marks":["strong"]},{"text":"liên kết","link":{"kind":"internal","entity":"book","slug":"nhan-tam"}},{"text":"ngoài","link":{"kind":"external","href":"https://example.com/a?b=1"}}]},
    {"type":"list","ordered":false,"items":[[{"text":"một"}],[{"text":"hai"}]]},
    {"type":"quote","text":"Trích dẫn","attribution":"Tác giả"},
    {"type":"book_quote","bookId":"d5200000-0000-4000-8000-000000000001","text":"Một câu."},
    {"type":"book_card","bookId":"d5200000-0000-4000-8000-000000000001"},
    {"type":"idea_card","ideaId":"d5500000-0000-4000-8000-0000000000ff"},
    {"type":"image","storageKey":"knowledge/ideas/d5500000-0000-4000-8000-0000000000ff/d5500000-0000-4000-8000-0000000000aa.webp","alt":"Ảnh","width":800,"height":600}
  ]'::jsonb)$$,
  'every block type the editor writes passes the database check');

select lives_ok(
  $$select public.admin_save_idea_seo((select id from t_ids where label = 'idea'), 'vi', '  Tỉnh thức  ', '')$$,
  'an admin saves idea SEO fields');
select results_eq(
  $$select seo_title, seo_description, question from public.idea_localizations
    where idea_id = (select id from t_ids where label = 'idea') and locale = 'vi'$$,
  $$values ('Tỉnh thức'::text, null::text, 'Vì sao cần tỉnh thức?'::text)$$,
  'SEO save trims, stores blank as null, and touches only the SEO fields');
select throws_ok(
  $$select public.admin_save_idea_seo((select id from t_ids where label = 'idea2'), 'vi', 'T', 'D')$$,
  'P0002', null, 'SEO needs an existing localization');
select throws_ok(
  $$select public.admin_save_idea_seo((select id from t_ids where label = 'idea'), 'fr', 'T', 'D')$$,
  '22023', null, 'SEO in an unsupported locale is refused');

-- Idea relations -------------------------------------------------------------------------------
select lives_ok(
  format($$select public.admin_set_idea_relations(%L,
    array['d5200000-0000-0000-0000-000000000002', 'd5200000-0000-0000-0000-000000000001']::uuid[],
    array['d5400000-0000-0000-0000-000000000001', 'd5400000-0000-0000-0000-000000000002']::uuid[],
    array[%L]::uuid[])$$,
    (select id from t_ids where label = 'idea'), (select id from t_ids where label = 'idea2')),
  'an admin sets idea relations');
select results_eq(
  $$select book_id, position from public.idea_books where idea_id = (select id from t_ids where label = 'idea') order by position$$,
  $$values ('d5200000-0000-0000-0000-000000000002'::uuid, 1), ('d5200000-0000-0000-0000-000000000001'::uuid, 2)$$,
  'related books take their positions from the submitted order');
select is(
  (select count(*) from public.idea_topics where idea_id = (select id from t_ids where label = 'idea')),
  2::bigint, 'related topics are stored');
select results_eq(
  $$select related_idea_id, position from public.idea_links where idea_id = (select id from t_ids where label = 'idea')$$,
  $$select id, 1 from t_ids where label = 'idea2'$$,
  'related ideas are stored in order');
select is(
  (select a.metadata from public.audit_logs a
   where a.action = 'set_idea_relations' and a.entity_id = (select id from t_ids where label = 'idea')),
  jsonb_build_object(
    'book_ids', jsonb_build_array('d5200000-0000-0000-0000-000000000002', 'd5200000-0000-0000-0000-000000000001'),
    'topic_ids', jsonb_build_array('d5400000-0000-0000-0000-000000000001', 'd5400000-0000-0000-0000-000000000002'),
    'related_idea_ids', jsonb_build_array((select id from t_ids where label = 'idea2'))),
  'the relations audit row carries every submitted id in order');

select lives_ok(
  format($$select public.admin_set_idea_relations(%L, array['d5200000-0000-0000-0000-000000000001']::uuid[], null, '{}')$$,
    (select id from t_ids where label = 'idea')),
  'relations are replaced wholesale; null means empty');
select results_eq(
  $$select book_id, position from public.idea_books where idea_id = (select id from t_ids where label = 'idea')$$,
  $$values ('d5200000-0000-0000-0000-000000000001'::uuid, 1)$$,
  'the replacement renumbers from 1');
select is(
  (select count(*) from public.idea_topics where idea_id = (select id from t_ids where label = 'idea'))
  + (select count(*) from public.idea_links where idea_id = (select id from t_ids where label = 'idea')),
  0::bigint, 'omitted topics and related ideas are removed');

select throws_ok(
  format($$select public.admin_set_idea_relations(%L,
    array['d5200000-0000-0000-0000-000000000002', 'd5200000-0000-0000-0000-000000000002']::uuid[], '{}', '{}')$$,
    (select id from t_ids where label = 'idea')),
  '22023', null, 'a duplicate related book is refused');
select throws_ok(
  format($$select public.admin_set_idea_relations(%L, '{}',
    array['d5400000-0000-0000-0000-000000000001', 'd5400000-0000-0000-0000-000000000001']::uuid[], '{}')$$,
    (select id from t_ids where label = 'idea')),
  '22023', null, 'a duplicate topic is refused');
select throws_ok(
  format($$select public.admin_set_idea_relations(%L, '{}', '{}', array[%L, %L]::uuid[])$$,
    (select id from t_ids where label = 'idea'), (select id from t_ids where label = 'idea2'), (select id from t_ids where label = 'idea2')),
  '22023', null, 'a duplicate related idea is refused');
select throws_ok(
  format($$select public.admin_set_idea_relations(%L, '{}', '{}', array[%L]::uuid[])$$,
    (select id from t_ids where label = 'idea'), (select id from t_ids where label = 'idea')),
  '22023', null, 'an idea cannot link to itself');
select throws_ok(
  format($$select public.admin_set_idea_relations(%L, array[null]::uuid[], '{}', '{}')$$,
    (select id from t_ids where label = 'idea')),
  '22023', null, 'a null id is refused');
select throws_ok(
  format($$select public.admin_set_idea_relations(%L, array['d5200000-0000-0000-0000-00000000dead']::uuid[], '{}', '{}')$$,
    (select id from t_ids where label = 'idea')),
  'P0002', null, 'an unknown book is refused');
select throws_ok(
  format($$select public.admin_set_idea_relations(%L, '{}', array['d5400000-0000-0000-0000-00000000dead']::uuid[], '{}')$$,
    (select id from t_ids where label = 'idea')),
  'P0002', null, 'an unknown topic is refused');
select throws_ok(
  format($$select public.admin_set_idea_relations(%L, '{}', '{}', array['d5500000-0000-0000-0000-00000000dead']::uuid[])$$,
    (select id from t_ids where label = 'idea')),
  'P0002', null, 'an unknown related idea is refused');
select throws_ok(
  $$select public.admin_set_idea_relations('d5500000-0000-0000-0000-00000000dead', '{}', '{}', '{}')$$,
  'P0002', null, 'relating an idea that does not exist is refused');
select results_eq(
  $$select book_id, position from public.idea_books where idea_id = (select id from t_ids where label = 'idea')$$,
  $$values ('d5200000-0000-0000-0000-000000000001'::uuid, 1)$$,
  'every refused relation call left the previous relations intact');

-- Idea publish gate -----------------------------------------------------------------------------
-- Each readiness failure on its own. idea3 has a complete localization with blocks but no book;
-- idea4 has a book but its only localization has no blocks; the fixture idea has neither.
insert into t_ids (label, id)
select 'idea3', public.admin_create_idea('vi', 'y-tuong-ba', 'Câu hỏi ba?', 'Trả lời ba.');
select public.admin_save_idea_localization((select id from t_ids where label = 'idea3'), 'vi', 'y-tuong-ba',
  'Câu hỏi ba?', 'Trả lời ba.', (select blocks from t_blocks where label = 'one'));
insert into t_ids (label, id)
select 'idea4', public.admin_create_idea('vi', 'y-tuong-bon', 'Câu hỏi bốn?', 'Trả lời bốn.');
select public.admin_set_idea_relations((select id from t_ids where label = 'idea4'),
  array['d5200000-0000-0000-0000-000000000001']::uuid[], '{}', '{}');
select public.admin_set_idea_relations('d5500000-0000-0000-0000-0000000000ff',
  array['d5200000-0000-0000-0000-000000000001']::uuid[], '{}', '{}');
-- idea5 is complete with blocks, but its only related book is a draft. The public idea page lists
-- published books alone, so a draft book must not satisfy missing_related_book (regression).
insert into t_ids (label, id)
select 'idea5', public.admin_create_idea('vi', 'y-tuong-nam', 'Câu hỏi năm?', 'Trả lời năm.');
select public.admin_save_idea_localization((select id from t_ids where label = 'idea5'), 'vi', 'y-tuong-nam',
  'Câu hỏi năm?', 'Trả lời năm.', (select blocks from t_blocks where label = 'one'));
select public.admin_set_idea_relations((select id from t_ids where label = 'idea5'),
  array['d5200000-0000-0000-0000-000000000003']::uuid[], '{}', '{}');

-- idea6 has only an English localization and its only related book is localized in Vietnamese
-- alone: /en/ideas/... would show no book (regression).
insert into t_ids (label, id)
select 'idea6', public.admin_create_idea('en', 'idea-six', 'Question six?', 'Answer six.');
select public.admin_save_idea_localization((select id from t_ids where label = 'idea6'), 'en', 'idea-six',
  'Question six?', 'Answer six.', (select blocks from t_blocks where label = 'one'));
select public.admin_set_idea_relations((select id from t_ids where label = 'idea6'),
  array['d5200000-0000-0000-0000-000000000004']::uuid[], '{}', '{}');
select throws_ok(
  format('select public.publish_idea(%L)', (select id from t_ids where label = 'idea6')),
  'EB032', 'publish_idea: idea is not ready: missing_related_book',
  'publishing an idea whose related book is not localized in its locale is refused');

select throws_ok(
  format('select public.publish_idea(%L)', (select id from t_ids where label = 'idea3')),
  'EB032', 'publish_idea: idea is not ready: missing_related_book',
  'publishing an idea without a related book is refused');
select throws_ok(
  format('select public.publish_idea(%L)', (select id from t_ids where label = 'idea4')),
  'EB032', 'publish_idea: idea is not ready: missing_blocks',
  'publishing an idea without content blocks is refused');
select throws_ok(
  format('select public.publish_idea(%L)', (select id from t_ids where label = 'idea5')),
  'EB032', 'publish_idea: idea is not ready: missing_related_book',
  'publishing an idea whose only related book is a draft is refused');
select throws_ok(
  $$select public.publish_idea('d5500000-0000-0000-0000-0000000000ff')$$,
  'EB032', 'publish_idea: idea is not ready: missing_localization,missing_blocks',
  'publishing an idea without a localization is refused');
select throws_ok(
  $$select public.publish_idea('d5500000-0000-0000-0000-00000000dead')$$,
  'P0002', null, 'publishing an idea that does not exist is refused');
reset role;

select is(public.idea_readiness_issues((select id from t_ids where label = 'idea2')),
  array['missing_blocks', 'missing_related_book'],
  'idea_readiness_issues lists every failure in the TypeScript order');
select is(public.idea_readiness_issues((select id from t_ids where label = 'idea5')),
  array['missing_related_book'],
  'idea_readiness_issues ignores draft related books');
select is(public.idea_readiness_issues((select id from t_ids where label = 'idea6')),
  array['missing_related_book'],
  'idea_readiness_issues requires a related book localized in every locale the idea has');
select is(public.idea_readiness_issues((select id from t_ids where label = 'idea')), '{}'::text[],
  'a complete idea has no readiness issues');
select is(
  (select count(*) from public.ideas
   where id in ((select id from t_ids where label = 'idea3'), (select id from t_ids where label = 'idea4'),
                'd5500000-0000-0000-0000-0000000000ff')
     and status = 'draft'),
  3::bigint, 'refused publishes leave the ideas as drafts');
select is(
  (select count(*) from public.audit_logs where action = 'publish_idea'),
  0::bigint, 'refused publishes write no audit row');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'd5100000-0000-0000-0000-000000000001', true);
select lives_ok(format('select public.publish_idea(%L)', (select id from t_ids where label = 'idea')),
  'a ready idea publishes');
reset role;
select is((select status from public.ideas where id = (select id from t_ids where label = 'idea')),
  'published'::public.content_status, 'the idea is published');

-- Idea redirects --------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd5100000-0000-0000-0000-000000000001', true);
select public.admin_save_idea_localization((select id from t_ids where label = 'idea'), 'vi', 'tinh-thuc-la-gi',
  'Vì sao cần tỉnh thức?', 'Vì chú ý là nền tảng.', (select blocks from t_blocks where label = 'two'));
reset role;
select results_eq(
  $$select source_path, destination_path from public.redirects where source_path like '/vi/ideas/%'$$,
  $$values ('/vi/ideas/vi-sao-tinh-thuc'::text, '/vi/ideas/tinh-thuc-la-gi'::text)$$,
  'renaming a published idea slug writes exactly one old -> new redirect');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'd5100000-0000-0000-0000-000000000001', true);
select public.admin_save_idea_localization((select id from t_ids where label = 'idea'), 'vi', 'tinh-thuc',
  'Vì sao cần tỉnh thức?', 'Vì chú ý là nền tảng.', (select blocks from t_blocks where label = 'two'));
-- Saving without a slug change writes nothing new.
select public.admin_save_idea_localization((select id from t_ids where label = 'idea'), 'vi', 'tinh-thuc',
  'Vì sao cần tỉnh thức?', 'Vì chú ý là nền tảng!', (select blocks from t_blocks where label = 'two'));
reset role;
select results_eq(
  $$select source_path, destination_path from public.redirects where source_path like '/vi/ideas/%' order by source_path$$,
  $$values ('/vi/ideas/tinh-thuc-la-gi'::text, '/vi/ideas/tinh-thuc'::text),
           ('/vi/ideas/vi-sao-tinh-thuc'::text, '/vi/ideas/tinh-thuc'::text)$$,
  'a second rename points both historic paths straight at the newest path');
select is(
  (select count(*) from public.redirects r
   where r.destination_path like '/%/ideas/%'
     and exists (select 1 from public.redirects s where s.source_path = r.destination_path)),
  0::bigint, 'no idea redirect destination is itself a redirect source');
select is(
  (select count(*) from public.redirects where source_path like '/en/ideas/%'),
  0::bigint, 'the other locale is untouched');

-- Unpublish ------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd5100000-0000-0000-0000-000000000001', true);
select lives_ok(format('select public.unpublish_idea(%L)', (select id from t_ids where label = 'idea')),
  'an admin unpublishes an idea');
select throws_ok($$select public.unpublish_idea('d5500000-0000-0000-0000-00000000dead')$$,
  'P0002', null, 'unpublishing an idea that does not exist is refused');
reset role;
select is((select status from public.ideas where id = (select id from t_ids where label = 'idea')),
  'draft'::public.content_status, 'the unpublished idea is a draft again');

-- Idea audit trail: one correctly named row per successful call -------------------------------
select results_eq(
  $$select action, count(*) from public.audit_logs
    where entity_type = 'ideas' and entity_id = (select id from t_ids where label = 'idea')
    group by action order by action$$,
  $$values ('create_idea'::text, 1::bigint), ('publish_idea', 1), ('save_idea_localization', 7),
           ('save_idea_seo', 1), ('set_idea_relations', 2), ('unpublish_idea', 1)$$,
  'each successful idea call wrote exactly one correctly named audit row');
select is(
  (select count(*) from public.audit_logs
   where entity_type = 'ideas' and entity_id = (select id from t_ids where label = 'idea')
     and actor_profile_id is distinct from (select id from public.profiles where auth_user_id = 'd5100000-0000-0000-0000-000000000001')),
  0::bigint, 'every idea audit row names the acting admin');
select is(
  (select metadata from public.audit_logs
   where action = 'create_idea' and entity_id = (select id from t_ids where label = 'idea')),
  jsonb_build_object('locale', 'vi', 'slug', 'vi-sao-can-tinh-thuc'),
  'the create audit row records the first localization');

-- Articles: creation, details, localization, SEO -------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd5100000-0000-0000-0000-000000000001', true);

insert into t_ids (label, id)
select 'article', public.admin_create_article('d5300000-0000-0000-0000-000000000001', 'en', 'slow-reading',
  'Slow reading', 'A way to read that lasts.');
select results_eq(
  $$select status, author_id, published_at from public.articles where id = (select id from t_ids where label = 'article')$$,
  $$values ('draft'::public.content_status, 'd5300000-0000-0000-0000-000000000001'::uuid, null::timestamptz)$$,
  'a new article is an undated draft with its author');
select results_eq(
  $$select locale, slug, title, excerpt, body_blocks from public.article_localizations
    where article_id = (select id from t_ids where label = 'article')$$,
  $$values ('en'::text, 'slow-reading'::text, 'Slow reading'::text, 'A way to read that lasts.'::text, '[]'::jsonb)$$,
  'creation seeds the first article localization');
select throws_ok($$select public.admin_create_article('d5300000-0000-0000-0000-00000000dead', 'en', 'x', 'T', 'E')$$,
  'P0002', null, 'creating an article for an unknown author is refused');
select throws_ok($$select public.admin_create_article('d5300000-0000-0000-0000-000000000001', 'fr', 'x', 'T', 'E')$$,
  '22023', null, 'creating an article in an unsupported locale is refused');

select lives_ok(
  format($$select public.admin_update_article(%L, 'd5300000-0000-0000-0000-000000000002')$$,
    (select id from t_ids where label = 'article')),
  'an admin changes the article author');
select is((select author_id from public.articles where id = (select id from t_ids where label = 'article')),
  'd5300000-0000-0000-0000-000000000002'::uuid, 'the article carries its new author');
select throws_ok(
  format($$select public.admin_update_article(%L, 'd5300000-0000-0000-0000-00000000dead')$$,
    (select id from t_ids where label = 'article')),
  'P0002', null, 'an unknown author is refused');
select throws_ok(
  $$select public.admin_update_article('d5600000-0000-0000-0000-00000000dead', 'd5300000-0000-0000-0000-000000000002')$$,
  'P0002', null, 'editing an article that does not exist is refused');

select isnt(
  public.admin_save_article_localization((select id from t_ids where label = 'article'), 'vi', 'doc-cham',
    'Đọc chậm', 'Một cách đọc để nhớ lâu.', '[]'::jsonb),
  null, 'saving a new article locale returns its localization id');
select is(
  public.admin_save_article_localization((select id from t_ids where label = 'article'), 'en', 'reading-slowly',
    'Slow reading', 'A way to read that lasts.', (select blocks from t_blocks where label = 'one')),
  (select l.id from public.article_localizations l where l.article_id = (select id from t_ids where label = 'article') and l.locale = 'en'),
  'saving an existing article locale updates it in place');
select is(
  (select count(*) from public.redirects where source_path like '/en/articles/%'),
  0::bigint, 'a draft article slug edit writes no redirect');
select throws_ok(
  $$select public.admin_save_article_localization('d5600000-0000-0000-0000-00000000dead', 'vi', 'x', 'T', 'E', '[]'::jsonb)$$,
  'P0002', null, 'localizing an article that does not exist is refused');
select throws_ok(
  format($$select public.admin_save_article_localization(%L, 'vi', 'x', 'T', 'E', '"text"'::jsonb)$$,
    (select id from t_ids where label = 'article')),
  '22023', null, 'article body_blocks must be a JSON array');
select throws_ok(
  format($$select public.admin_save_article_localization(%L, 'xx', 'x', 'T', 'E', '[]'::jsonb)$$,
    (select id from t_ids where label = 'article')),
  '22023', null, 'localizing an article in an unsupported locale is refused');

select lives_ok(
  format($$select public.admin_save_article_seo(%L, 'en', 'Slow reading, explained', 'How to read slowly.')$$,
    (select id from t_ids where label = 'article')),
  'an admin saves article SEO fields');
select results_eq(
  $$select seo_title, seo_description, title from public.article_localizations
    where article_id = (select id from t_ids where label = 'article') and locale = 'en'$$,
  $$values ('Slow reading, explained'::text, 'How to read slowly.'::text, 'Slow reading'::text)$$,
  'article SEO save touches only the SEO fields');
select throws_ok(
  $$select public.admin_save_article_seo('d5600000-0000-0000-0000-0000000000ff', 'en', 'T', 'D')$$,
  'P0002', null, 'article SEO needs an existing localization');

-- Article relations ----------------------------------------------------------------------------
select lives_ok(
  format($$select public.admin_set_article_relations(%L,
    array['d5200000-0000-0000-0000-000000000002', 'd5200000-0000-0000-0000-000000000001']::uuid[],
    array[%L, %L]::uuid[],
    array['d5400000-0000-0000-0000-000000000002']::uuid[])$$,
    (select id from t_ids where label = 'article'), (select id from t_ids where label = 'idea2'), (select id from t_ids where label = 'idea')),
  'an admin sets article relations');
select results_eq(
  $$select book_id, position from public.article_books where article_id = (select id from t_ids where label = 'article') order by position$$,
  $$values ('d5200000-0000-0000-0000-000000000002'::uuid, 1), ('d5200000-0000-0000-0000-000000000001'::uuid, 2)$$,
  'article books take their positions from the submitted order');
select results_eq(
  $$select idea_id, position from public.article_ideas where article_id = (select id from t_ids where label = 'article') order by position$$,
  $$select id, case label when 'idea2' then 1 else 2 end from t_ids where label in ('idea2', 'idea') order by 2$$,
  'article ideas take their positions from the submitted order');
select results_eq(
  $$select topic_id from public.article_topics where article_id = (select id from t_ids where label = 'article')$$,
  $$values ('d5400000-0000-0000-0000-000000000002'::uuid)$$,
  'article topics are stored');
select is(
  (select a.metadata from public.audit_logs a
   where a.action = 'set_article_relations' and a.entity_id = (select id from t_ids where label = 'article')),
  jsonb_build_object(
    'book_ids', jsonb_build_array('d5200000-0000-0000-0000-000000000002', 'd5200000-0000-0000-0000-000000000001'),
    'idea_ids', jsonb_build_array((select id from t_ids where label = 'idea2'), (select id from t_ids where label = 'idea')),
    'topic_ids', jsonb_build_array('d5400000-0000-0000-0000-000000000002')),
  'the article relations audit row carries every submitted id in order');
select throws_ok(
  format($$select public.admin_set_article_relations(%L, '{}', array[%L, %L]::uuid[], '{}')$$,
    (select id from t_ids where label = 'article'), (select id from t_ids where label = 'idea'), (select id from t_ids where label = 'idea')),
  '22023', null, 'a duplicate article idea is refused');
select throws_ok(
  format($$select public.admin_set_article_relations(%L,
    array['d5200000-0000-0000-0000-000000000001', 'd5200000-0000-0000-0000-000000000001']::uuid[], '{}', '{}')$$,
    (select id from t_ids where label = 'article')),
  '22023', null, 'a duplicate article book is refused');
select throws_ok(
  format($$select public.admin_set_article_relations(%L, '{}', array['d5500000-0000-0000-0000-00000000dead']::uuid[], '{}')$$,
    (select id from t_ids where label = 'article')),
  'P0002', null, 'an unknown article idea is refused');
select throws_ok(
  $$select public.admin_set_article_relations('d5600000-0000-0000-0000-00000000dead', '{}', '{}', '{}')$$,
  'P0002', null, 'relating an article that does not exist is refused');
select is(
  (select count(*) from public.article_books where article_id = (select id from t_ids where label = 'article'))
  + (select count(*) from public.article_ideas where article_id = (select id from t_ids where label = 'article'))
  + (select count(*) from public.article_topics where article_id = (select id from t_ids where label = 'article')),
  5::bigint, 'every refused article relation call left the previous relations intact');

-- Article publish gate ----------------------------------------------------------------------------
insert into t_ids (label, id)
select 'article2', public.admin_create_article('d5300000-0000-0000-0000-000000000001', 'vi', 'bai-hai', 'Bài hai', 'Tóm tắt.');
select throws_ok(
  format('select public.publish_article(%L)', (select id from t_ids where label = 'article2')),
  'EB033', 'publish_article: article is not ready: missing_blocks',
  'publishing an article without content blocks is refused');
select throws_ok(
  $$select public.publish_article('d5600000-0000-0000-0000-0000000000ff')$$,
  'EB033', 'publish_article: article is not ready: missing_localization,missing_blocks',
  'publishing an article without a localization is refused');
select throws_ok(
  $$select public.publish_article('d5600000-0000-0000-0000-00000000dead')$$,
  'P0002', null, 'publishing an article that does not exist is refused');
reset role;
select is(public.article_readiness_issues((select id from t_ids where label = 'article')), '{}'::text[],
  'an article with one complete localization with a block is ready, needing no book');
select is(
  (select count(*) from public.articles
   where id in ((select id from t_ids where label = 'article2'), 'd5600000-0000-0000-0000-0000000000ff')
     and status = 'draft' and published_at is null),
  2::bigint, 'refused article publishes leave undated drafts');

-- Article publish date survives unpublish and republish -----------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd5100000-0000-0000-0000-000000000001', true);
select lives_ok(format('select public.publish_article(%L)', (select id from t_ids where label = 'article')),
  'a ready article publishes');
reset role;
select results_eq(
  $$select status, published_at from public.articles where id = (select id from t_ids where label = 'article')$$,
  $$values ('published'::public.content_status, now())$$,
  'the first publish dates the article');

-- now() is fixed inside this transaction, so move the first publish into the past to make the
-- clocks of the first publish and the republish differ.
update public.articles set published_at = '2026-01-02 03:04:05+00'
where id = (select id from t_ids where label = 'article');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'd5100000-0000-0000-0000-000000000001', true);
select lives_ok(format('select public.unpublish_article(%L)', (select id from t_ids where label = 'article')),
  'an admin unpublishes an article');
reset role;
select results_eq(
  $$select status, published_at from public.articles where id = (select id from t_ids where label = 'article')$$,
  $$values ('draft'::public.content_status, '2026-01-02 03:04:05+00'::timestamptz)$$,
  'unpublishing keeps the original publish date');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd5100000-0000-0000-0000-000000000001', true);
select lives_ok(format('select public.publish_article(%L)', (select id from t_ids where label = 'article')),
  'an admin republishes an article');
select throws_ok($$select public.unpublish_article('d5600000-0000-0000-0000-00000000dead')$$,
  'P0002', null, 'unpublishing an article that does not exist is refused');
reset role;
select results_eq(
  $$select status, published_at from public.articles where id = (select id from t_ids where label = 'article')$$,
  $$values ('published'::public.content_status, '2026-01-02 03:04:05+00'::timestamptz)$$,
  'republishing keeps the first publish date');

-- Article redirects ---------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd5100000-0000-0000-0000-000000000001', true);
select public.admin_save_article_localization((select id from t_ids where label = 'article'), 'en', 'read-slowly',
  'Slow reading', 'A way to read that lasts.', (select blocks from t_blocks where label = 'one'));
reset role;
select results_eq(
  $$select source_path, destination_path from public.redirects where source_path like '/en/articles/%'$$,
  $$values ('/en/articles/reading-slowly'::text, '/en/articles/read-slowly'::text)$$,
  'renaming a published article slug writes exactly one old -> new redirect');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd5100000-0000-0000-0000-000000000001', true);
select public.admin_save_article_localization((select id from t_ids where label = 'article'), 'en', 'slow-reads',
  'Slow reading', 'A way to read that lasts.', (select blocks from t_blocks where label = 'one'));
reset role;
select results_eq(
  $$select source_path, destination_path from public.redirects where source_path like '/en/articles/%' order by source_path$$,
  $$values ('/en/articles/read-slowly'::text, '/en/articles/slow-reads'::text),
           ('/en/articles/reading-slowly'::text, '/en/articles/slow-reads'::text)$$,
  'a second article rename points both historic paths straight at the newest path');
select is(
  (select count(*) from public.redirects r
   where r.destination_path like '/%/articles/%'
     and exists (select 1 from public.redirects s where s.source_path = r.destination_path)),
  0::bigint, 'no article redirect destination is itself a redirect source');
select is(
  (select count(*) from public.redirects where source_path like '/vi/articles/%'),
  0::bigint, 'the other article locale is untouched');

-- Article audit trail ------------------------------------------------------------------------------
select results_eq(
  $$select action, count(*) from public.audit_logs
    where entity_type = 'articles' and entity_id = (select id from t_ids where label = 'article')
    group by action order by action$$,
  $$values ('create_article'::text, 1::bigint), ('publish_article', 2), ('save_article_localization', 4),
           ('save_article_seo', 1), ('set_article_relations', 1), ('unpublish_article', 1), ('update_article', 1)$$,
  'each successful article call wrote exactly one correctly named audit row');
select is(
  (select metadata from public.audit_logs
   where action = 'update_article' and entity_id = (select id from t_ids where label = 'article')),
  jsonb_build_object('author_id_from', 'd5300000-0000-0000-0000-000000000001', 'author_id', 'd5300000-0000-0000-0000-000000000002'),
  'the details audit row records the author change');
select is(
  (select count(*) from public.audit_logs
   where action = 'publish_article' and entity_id in ((select id from t_ids where label = 'article2'), 'd5600000-0000-0000-0000-0000000000ff')),
  0::bigint, 'refused article publishes write no audit row');

select * from finish();
rollback;
