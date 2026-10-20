begin;
select plan(175);

-- S12: the knowledge-hub schema - ideas, articles, their localizations, the six explicit relation
-- tables, and who may read or write them
-- (docs/superpowers/specs/2026-09-21-s12-knowledge-hub-design.md section 5).
--
-- Three things are proved here:
--
--   1. Shape. Every table, key, foreign key, cascade, default and constraint the admin RPCs and the
--      public read RPCs of the later S12 migrations rely on.
--   2. Visibility. anon and a signed-in non-admin reader see a published parent, its
--      localizations, and a relation row only when the parent AND the target are both published.
--      An admin reads drafts too. Without the reader, a `using (true)` policy would pass; without
--      the admin, "hidden from everyone" and "hidden from readers only" would look the same.
--   3. No browser write path. anon, a reader and an admin hold SELECT and nothing else, so every
--      mutation must go through the audited admin RPCs (20260927110000). service_role keeps full
--      DML for fixtures and trusted operations.

-- Fixtures ---------------------------------------------------------------------------------------

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'c1200000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 's12-schema-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c1200000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 's12-schema-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'c1200000-0000-4000-8000-000000000002';

insert into public.authors (id, canonical_slug, display_name, status) values
  ('c1210000-0000-4000-8000-000000000001', 's12-schema-author', 'S12 Schema Author', 'published'),
  ('c1210000-0000-4000-8000-000000000002', 's12-schema-author-throwaway', 'S12 Throwaway Author', 'published');

-- B1 published, B2 draft, B3 published and deleted by the cascade assertions below.
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('c1220000-0000-4000-8000-000000000001', 's12-schema-book-1', 'en', 'c1210000-0000-4000-8000-000000000001', 'published'),
  ('c1220000-0000-4000-8000-000000000002', 's12-schema-book-2', 'en', 'c1210000-0000-4000-8000-000000000001', 'draft'),
  ('c1220000-0000-4000-8000-000000000003', 's12-schema-book-3', 'en', 'c1210000-0000-4000-8000-000000000001', 'published');

-- T1 published, T2 draft.
insert into public.topics (id, canonical_slug, name, status) values
  ('c1230000-0000-4000-8000-000000000001', 's12-schema-topic-1', 'S12 Topic 1', 'published'),
  ('c1230000-0000-4000-8000-000000000002', 's12-schema-topic-2', 'S12 Topic 2', 'draft');

-- I1 and I2 published, I3 draft, I4 draft and deleted by the cascade assertions below.
insert into public.ideas (id, status) values
  ('c1240000-0000-4000-8000-000000000001', 'published'),
  ('c1240000-0000-4000-8000-000000000002', 'published'),
  ('c1240000-0000-4000-8000-000000000003', 'draft'),
  ('c1240000-0000-4000-8000-000000000004', 'draft');

insert into public.idea_localizations (idea_id, locale, slug, question, short_answer) values
  ('c1240000-0000-4000-8000-000000000001', 'en', 'shared', 'What is shared?', 'A path segment.'),
  ('c1240000-0000-4000-8000-000000000001', 'vi', 'chia-se', 'Chia sẻ là gì?', 'Một đoạn đường dẫn.'),
  ('c1240000-0000-4000-8000-000000000002', 'en', 's12-idea-two', 'Second idea?', 'Yes.'),
  ('c1240000-0000-4000-8000-000000000003', 'en', 's12-draft-idea', 'Draft idea?', 'Not yet.'),
  ('c1240000-0000-4000-8000-000000000004', 'en', 's12-throwaway-idea', 'Throwaway?', 'Deleted.');

-- A1 published, A2 draft, A3 draft and deleted by the cascade assertions below.
insert into public.articles (id, status, author_id) values
  ('c1250000-0000-4000-8000-000000000001', 'published', 'c1210000-0000-4000-8000-000000000001'),
  ('c1250000-0000-4000-8000-000000000002', 'draft', 'c1210000-0000-4000-8000-000000000001'),
  ('c1250000-0000-4000-8000-000000000003', 'draft', 'c1210000-0000-4000-8000-000000000002');

-- en/shared deliberately repeats the idea's slug: /en/ideas/shared and /en/articles/shared are
-- different public paths, so the uniqueness is per table, never across them.
insert into public.article_localizations (article_id, locale, slug, title, excerpt) values
  ('c1250000-0000-4000-8000-000000000001', 'en', 'shared', 'Shared article', 'An excerpt.'),
  ('c1250000-0000-4000-8000-000000000002', 'en', 's12-draft-article', 'Draft article', 'Not yet.'),
  ('c1250000-0000-4000-8000-000000000003', 'en', 's12-throwaway-article', 'Throwaway', 'Deleted.');

-- Each relation: one row whose parent and target are published, one whose target is a draft, and
-- one whose parent is a draft. Only the first is public.
insert into public.idea_books (idea_id, book_id, position) values
  ('c1240000-0000-4000-8000-000000000001', 'c1220000-0000-4000-8000-000000000001', 1),
  ('c1240000-0000-4000-8000-000000000001', 'c1220000-0000-4000-8000-000000000002', 2),
  ('c1240000-0000-4000-8000-000000000003', 'c1220000-0000-4000-8000-000000000001', 1),
  ('c1240000-0000-4000-8000-000000000004', 'c1220000-0000-4000-8000-000000000003', 1);
insert into public.idea_topics (idea_id, topic_id) values
  ('c1240000-0000-4000-8000-000000000001', 'c1230000-0000-4000-8000-000000000001'),
  ('c1240000-0000-4000-8000-000000000001', 'c1230000-0000-4000-8000-000000000002'),
  ('c1240000-0000-4000-8000-000000000003', 'c1230000-0000-4000-8000-000000000001'),
  ('c1240000-0000-4000-8000-000000000004', 'c1230000-0000-4000-8000-000000000001');
insert into public.idea_links (idea_id, related_idea_id, position) values
  ('c1240000-0000-4000-8000-000000000001', 'c1240000-0000-4000-8000-000000000002', 1),
  ('c1240000-0000-4000-8000-000000000001', 'c1240000-0000-4000-8000-000000000003', 2),
  ('c1240000-0000-4000-8000-000000000003', 'c1240000-0000-4000-8000-000000000001', 1),
  ('c1240000-0000-4000-8000-000000000001', 'c1240000-0000-4000-8000-000000000004', 3);
insert into public.article_books (article_id, book_id, position) values
  ('c1250000-0000-4000-8000-000000000001', 'c1220000-0000-4000-8000-000000000001', 1),
  ('c1250000-0000-4000-8000-000000000001', 'c1220000-0000-4000-8000-000000000002', 2),
  ('c1250000-0000-4000-8000-000000000002', 'c1220000-0000-4000-8000-000000000001', 1),
  ('c1250000-0000-4000-8000-000000000001', 'c1220000-0000-4000-8000-000000000003', 3);
insert into public.article_ideas (article_id, idea_id, position) values
  ('c1250000-0000-4000-8000-000000000001', 'c1240000-0000-4000-8000-000000000001', 1),
  ('c1250000-0000-4000-8000-000000000001', 'c1240000-0000-4000-8000-000000000003', 2),
  ('c1250000-0000-4000-8000-000000000002', 'c1240000-0000-4000-8000-000000000001', 1),
  ('c1250000-0000-4000-8000-000000000003', 'c1240000-0000-4000-8000-000000000001', 1);
insert into public.article_topics (article_id, topic_id) values
  ('c1250000-0000-4000-8000-000000000001', 'c1230000-0000-4000-8000-000000000001'),
  ('c1250000-0000-4000-8000-000000000001', 'c1230000-0000-4000-8000-000000000002'),
  ('c1250000-0000-4000-8000-000000000002', 'c1230000-0000-4000-8000-000000000001'),
  ('c1250000-0000-4000-8000-000000000003', 'c1230000-0000-4000-8000-000000000001');

-- Tables and keys (20) -----------------------------------------------------------------------------
select has_table('public', 'ideas', 'ideas exists');
select has_table('public', 'idea_localizations', 'idea_localizations exists');
select has_table('public', 'articles', 'articles exists');
select has_table('public', 'article_localizations', 'article_localizations exists');
select has_table('public', 'idea_books', 'idea_books exists');
select has_table('public', 'idea_topics', 'idea_topics exists');
select has_table('public', 'idea_links', 'idea_links exists');
select has_table('public', 'article_books', 'article_books exists');
select has_table('public', 'article_ideas', 'article_ideas exists');
select has_table('public', 'article_topics', 'article_topics exists');

select col_is_pk('public', 'ideas', 'id', 'ideas is keyed by id');
select col_is_pk('public', 'idea_localizations', 'id', 'idea_localizations is keyed by id');
select col_is_pk('public', 'articles', 'id', 'articles is keyed by id');
select col_is_pk('public', 'article_localizations', 'id', 'article_localizations is keyed by id');
select col_is_pk('public', 'idea_books', array['idea_id', 'book_id'], 'idea_books is keyed by the pair');
select col_is_pk('public', 'idea_topics', array['idea_id', 'topic_id'], 'idea_topics is keyed by the pair');
select col_is_pk('public', 'idea_links', array['idea_id', 'related_idea_id'], 'idea_links is keyed by the pair');
select col_is_pk('public', 'article_books', array['article_id', 'book_id'], 'article_books is keyed by the pair');
select col_is_pk('public', 'article_ideas', array['article_id', 'idea_id'], 'article_ideas is keyed by the pair');
select col_is_pk('public', 'article_topics', array['article_id', 'topic_id'], 'article_topics is keyed by the pair');

-- Foreign keys (15) --------------------------------------------------------------------------------
select col_is_fk('public', 'articles', 'author_id', 'articles have a real author foreign key');
select fk_ok('public', 'articles', 'author_id', 'public', 'authors', 'id');
select fk_ok('public', 'idea_localizations', 'idea_id', 'public', 'ideas', 'id');
select fk_ok('public', 'article_localizations', 'article_id', 'public', 'articles', 'id');
select fk_ok('public', 'idea_books', 'idea_id', 'public', 'ideas', 'id');
select fk_ok('public', 'idea_books', 'book_id', 'public', 'books', 'id');
select fk_ok('public', 'idea_topics', 'idea_id', 'public', 'ideas', 'id');
select fk_ok('public', 'idea_topics', 'topic_id', 'public', 'topics', 'id');
select fk_ok('public', 'idea_links', 'idea_id', 'public', 'ideas', 'id');
select fk_ok('public', 'idea_links', 'related_idea_id', 'public', 'ideas', 'id');
select fk_ok('public', 'article_books', 'article_id', 'public', 'articles', 'id');
select fk_ok('public', 'article_books', 'book_id', 'public', 'books', 'id');
select fk_ok('public', 'article_ideas', 'article_id', 'public', 'articles', 'id');
select fk_ok('public', 'article_ideas', 'idea_id', 'public', 'ideas', 'id');
select fk_ok('public', 'article_topics', 'topic_id', 'public', 'topics', 'id');

-- Columns and defaults (16) ------------------------------------------------------------------------
select col_type_is('public', 'ideas', 'status', 'content_status', 'ideas.status is the content_status enum');
select col_type_is('public', 'articles', 'status', 'content_status', 'articles.status is the content_status enum');
select col_default_is('public', 'ideas', 'status', 'draft', 'a new idea is a draft');
select col_default_is('public', 'articles', 'status', 'draft', 'a new article is a draft');
select col_not_null('public', 'articles', 'author_id', 'an article always has an author');
select col_type_is('public', 'articles', 'published_at', 'timestamp with time zone', 'articles.published_at is a timestamptz');
select col_is_null('public', 'articles', 'published_at', 'articles.published_at is empty until the first publish');
select is(
  (select published_at from public.articles where id = 'c1250000-0000-4000-8000-000000000001'),
  null::timestamptz,
  'a directly inserted article carries no publish date; publish_article sets it');
select col_type_is('public', 'idea_localizations', 'body_blocks', 'jsonb', 'idea body_blocks is jsonb');
select col_type_is('public', 'article_localizations', 'body_blocks', 'jsonb', 'article body_blocks is jsonb');
select col_default_is('public', 'idea_localizations', 'body_blocks', '[]'::jsonb, 'idea body_blocks defaults to an empty array');
select col_default_is('public', 'article_localizations', 'body_blocks', '[]'::jsonb, 'article body_blocks defaults to an empty array');
select col_is_null('public', 'idea_localizations', 'seo_title', 'idea seo_title is optional');
select col_is_null('public', 'article_localizations', 'seo_description', 'article seo_description is optional');
select has_column('public', 'ideas', 'updated_at', 'ideas carry updated_at');
select has_column('public', 'articles', 'created_at', 'articles carry created_at');

-- Uniqueness (8) --------------------------------------------------------------------------------------
select col_is_unique('public', 'idea_localizations', array['locale', 'slug'], 'idea paths are unique per locale');
select col_is_unique('public', 'article_localizations', array['locale', 'slug'], 'article paths are unique per locale');
select col_is_unique('public', 'idea_localizations', array['idea_id', 'locale'], 'an idea has one localization per locale');
select col_is_unique('public', 'article_localizations', array['article_id', 'locale'], 'an article has one localization per locale');
select col_is_unique('public', 'idea_books', array['idea_id', 'position'], 'idea book positions are unique per idea');
select col_is_unique('public', 'idea_links', array['idea_id', 'position'], 'idea link positions are unique per idea');
select col_is_unique('public', 'article_books', array['article_id', 'position'], 'article book positions are unique per article');
select col_is_unique('public', 'article_ideas', array['article_id', 'position'], 'article idea positions are unique per article');

-- updated_at triggers and reverse-direction indexes (10) -------------------------------------------
select trigger_is('public', 'ideas', 'ideas_touch_updated_at', 'public', 'touch_updated_at', 'ideas touch updated_at');
select trigger_is('public', 'idea_localizations', 'idea_localizations_touch_updated_at', 'public', 'touch_updated_at', 'idea localizations touch updated_at');
select trigger_is('public', 'article_localizations', 'article_localizations_touch_updated_at', 'public', 'touch_updated_at', 'article localizations touch updated_at');
select has_index('public', 'articles', 'articles_author_id_idx', 'author_id', 'articles are indexed by author');
select has_index('public', 'idea_books', 'idea_books_book_id_idx', 'book_id', 'idea_books is indexed for book backlinks');
select has_index('public', 'idea_topics', 'idea_topics_topic_id_idx', 'topic_id', 'idea_topics is indexed for topic backlinks');
select has_index('public', 'idea_links', 'idea_links_related_idea_id_idx', 'related_idea_id', 'idea_links is indexed for incoming links');
select has_index('public', 'article_books', 'article_books_book_id_idx', 'book_id', 'article_books is indexed for book backlinks');
select has_index('public', 'article_ideas', 'article_ideas_idea_id_idx', 'idea_id', 'article_ideas is indexed for idea backlinks');
select has_index('public', 'article_topics', 'article_topics_topic_id_idx', 'topic_id', 'article_topics is indexed for topic backlinks');

-- Localization constraints (13) ----------------------------------------------------------------------
select throws_ok(
  $$insert into public.ideas (status) values ('retired')$$,
  '22P02', null, 'ideas.status is the content_status enum, not free text');
select throws_ok(
  $$insert into public.idea_localizations (idea_id, locale, slug, question, short_answer)
    values ('c1240000-0000-4000-8000-000000000002', 'fr', 's12-fr', 'Q?', 'A.')$$,
  '23503', null, 'an idea locale outside the registry is refused');
select throws_ok(
  $$insert into public.article_localizations (article_id, locale, slug, title, excerpt)
    values ('c1250000-0000-4000-8000-000000000001', 'fr', 's12-fr', 'T', 'E')$$,
  '23503', null, 'an article locale outside the registry is refused');
select throws_ok(
  $$insert into public.idea_localizations (idea_id, locale, slug, question, short_answer)
    values ('c1240000-0000-4000-8000-000000000002', 'vi', 'Not Kebab', 'Q?', 'A.')$$,
  '23514', null, 'an idea slug that is not kebab-case is refused');
select throws_ok(
  $$insert into public.idea_localizations (idea_id, locale, slug, question, short_answer)
    values ('c1240000-0000-4000-8000-000000000002', 'vi', 's12-blank', '   ', 'A.')$$,
  '23514', null, 'a blank idea question is refused');
select throws_ok(
  $$insert into public.article_localizations (article_id, locale, slug, title, excerpt)
    values ('c1250000-0000-4000-8000-000000000001', 'vi', 's12-blank', '  ', 'E')$$,
  '23514', null, 'a blank article title is refused');
select throws_ok(
  $$insert into public.idea_localizations (idea_id, locale, slug, question, short_answer, body_blocks)
    values ('c1240000-0000-4000-8000-000000000002', 'vi', 's12-object', 'Q?', 'A.', '{"type":"paragraph"}'::jsonb)$$,
  '23514', null, 'idea body_blocks must be a JSON array');
select throws_ok(
  $$insert into public.article_localizations (article_id, locale, slug, title, excerpt, body_blocks)
    values ('c1250000-0000-4000-8000-000000000001', 'vi', 's12-string', 'T', 'E', '"<p>html</p>"'::jsonb)$$,
  '23514', null, 'article body_blocks must be a JSON array');
select throws_ok(
  $$insert into public.idea_localizations (idea_id, locale, slug, question, short_answer)
    values ('c1240000-0000-4000-8000-000000000002', 'en', 'shared', 'Q?', 'A.')$$,
  '23505', null, 'two ideas cannot share a slug in one locale');
select throws_ok(
  $$insert into public.idea_localizations (idea_id, locale, slug, question, short_answer)
    values ('c1240000-0000-4000-8000-000000000001', 'en', 's12-second-en', 'Q?', 'A.')$$,
  '23505', null, 'an idea has at most one localization per locale');
select throws_ok(
  $$insert into public.article_localizations (article_id, locale, slug, title, excerpt)
    values ('c1250000-0000-4000-8000-000000000001', 'en', 's12-second-en', 'T', 'E')$$,
  '23505', null, 'an article has at most one localization per locale');
select lives_ok(
  $$insert into public.idea_localizations (idea_id, locale, slug, question, short_answer)
    values ('c1240000-0000-4000-8000-000000000002', 'vi', 'shared', 'Q?', 'A.')$$,
  'the same slug may be reused in the other locale');
select is(
  (select count(*) from public.idea_localizations il
   join public.article_localizations al on al.locale = il.locale and al.slug = il.slug
   where il.locale = 'en' and il.slug = 'shared'),
  1::bigint,
  'an idea and an article may both own en/shared because their path prefixes differ');

-- Relation constraints (12) ----------------------------------------------------------------------
select throws_ok(
  $$insert into public.idea_links (idea_id, related_idea_id, position)
    values ('c1240000-0000-4000-8000-000000000002', 'c1240000-0000-4000-8000-000000000002', 1)$$,
  '23514', null, 'ideas cannot link to themselves');
select throws_ok(
  $$insert into public.idea_links (idea_id, related_idea_id, position)
    values ('c1240000-0000-4000-8000-000000000001', 'c1240000-0000-4000-8000-000000000002', 9)$$,
  '23505', null, 'an idea links to another idea at most once');
select throws_ok(
  $$insert into public.idea_links (idea_id, related_idea_id, position)
    values ('c1240000-0000-4000-8000-000000000002', 'c1240000-0000-4000-8000-000000000001', 0)$$,
  '23514', null, 'an idea link position must be positive');
select throws_ok(
  $$insert into public.idea_books (idea_id, book_id, position)
    values ('c1240000-0000-4000-8000-000000000002', 'c1220000-0000-4000-8000-000000000001', 0)$$,
  '23514', null, 'an idea book position must be positive');
select throws_ok(
  $$insert into public.idea_books (idea_id, book_id, position)
    values ('c1240000-0000-4000-8000-000000000001', 'c1220000-0000-4000-8000-000000000003', 1)$$,
  '23505', null, 'two books of one idea cannot share a position');
select throws_ok(
  $$insert into public.article_books (article_id, book_id, position)
    values ('c1250000-0000-4000-8000-000000000002', 'c1220000-0000-4000-8000-000000000002', -1)$$,
  '23514', null, 'an article book position must be positive');
select throws_ok(
  $$insert into public.article_ideas (article_id, idea_id, position)
    values ('c1250000-0000-4000-8000-000000000001', 'c1240000-0000-4000-8000-000000000002', 2)$$,
  '23505', null, 'two ideas of one article cannot share a position');
select throws_ok(
  $$insert into public.article_ideas (article_id, idea_id, position)
    values ('c1250000-0000-4000-8000-000000000001', 'c1240000-0000-4000-8000-000000000001', 7)$$,
  '23505', null, 'an article relates to an idea at most once');
select throws_ok(
  $$insert into public.idea_topics (idea_id, topic_id)
    values ('c1240000-0000-4000-8000-000000000001', 'c1230000-0000-4000-8000-000000000001')$$,
  '23505', null, 'an idea is tagged with a topic at most once');
select throws_ok(
  $$insert into public.article_topics (article_id, topic_id)
    values ('c1250000-0000-4000-8000-000000000001', 'c1230000-0000-4000-8000-000000000001')$$,
  '23505', null, 'an article is tagged with a topic at most once');
select throws_ok(
  $$insert into public.idea_books (idea_id, book_id, position)
    values ('c1240000-0000-4000-8000-000000000002', 'c1220000-0000-4000-8000-0000000000ff', 1)$$,
  '23503', null, 'an idea cannot relate to a book that does not exist');
select lives_ok(
  $$insert into public.idea_books (idea_id, book_id, position)
    values ('c1240000-0000-4000-8000-000000000002', 'c1220000-0000-4000-8000-000000000001', 1)$$,
  'the same position may be reused under a different idea');
delete from public.idea_books
where idea_id = 'c1240000-0000-4000-8000-000000000002';

-- Cascades (10) -------------------------------------------------------------------------------------
-- An article's author is a real reference: retiring an author is a status change, never a delete
-- that would leave a byline pointing nowhere.
select throws_ok(
  $$delete from public.authors where id = 'c1210000-0000-4000-8000-000000000002'$$,
  '23503', null, 'an author whose only reference is an article cannot be deleted');
select lives_ok(
  $$delete from public.articles where id = 'c1250000-0000-4000-8000-000000000003'$$,
  'an article can be deleted');
select is(
  (select count(*) from public.article_localizations where article_id = 'c1250000-0000-4000-8000-000000000003')
    + (select count(*) from public.article_ideas where article_id = 'c1250000-0000-4000-8000-000000000003')
    + (select count(*) from public.article_topics where article_id = 'c1250000-0000-4000-8000-000000000003'),
  0::bigint,
  'deleting an article cascades to its localizations and relations');
select lives_ok(
  $$delete from public.authors where id = 'c1210000-0000-4000-8000-000000000002'$$,
  'an author whose articles are gone can be deleted');
select lives_ok(
  $$delete from public.ideas where id = 'c1240000-0000-4000-8000-000000000004'$$,
  'an idea can be deleted');
select is(
  (select count(*) from public.idea_localizations where idea_id = 'c1240000-0000-4000-8000-000000000004')
    + (select count(*) from public.idea_topics where idea_id = 'c1240000-0000-4000-8000-000000000004'),
  0::bigint,
  'deleting an idea cascades to its localizations and topics');
select is(
  (select count(*) from public.idea_links where related_idea_id = 'c1240000-0000-4000-8000-000000000004'),
  0::bigint,
  'deleting an idea removes the links that pointed at it');
select is(
  (select count(*) from public.idea_books where book_id = 'c1220000-0000-4000-8000-000000000003'),
  0::bigint,
  'deleting an idea cascades to its book rows');
select lives_ok(
  $$delete from public.books where id = 'c1220000-0000-4000-8000-000000000003'$$,
  'a book related to knowledge can be deleted');
select is(
  (select count(*) from public.idea_books where book_id = 'c1220000-0000-4000-8000-000000000003')
    + (select count(*) from public.article_books where book_id = 'c1220000-0000-4000-8000-000000000003'),
  0::bigint,
  'deleting a book cascades to its knowledge relation rows');

-- RLS and privileges (31) ----------------------------------------------------------------------------
select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relrowsecurity
     and c.relname in ('ideas', 'idea_localizations', 'articles', 'article_localizations', 'idea_books',
                       'idea_topics', 'idea_links', 'article_books', 'article_ideas', 'article_topics')),
  10::bigint,
  'row level security is enabled on all ten knowledge tables');

select table_privs_are('public', 'ideas', 'anon', array['SELECT'], 'anon may only select ideas');
select table_privs_are('public', 'idea_localizations', 'anon', array['SELECT'], 'anon may only select idea_localizations');
select table_privs_are('public', 'articles', 'anon', array['SELECT'], 'anon may only select articles');
select table_privs_are('public', 'article_localizations', 'anon', array['SELECT'], 'anon may only select article_localizations');
select table_privs_are('public', 'idea_books', 'anon', array['SELECT'], 'anon may only select idea_books');
select table_privs_are('public', 'idea_topics', 'anon', array['SELECT'], 'anon may only select idea_topics');
select table_privs_are('public', 'idea_links', 'anon', array['SELECT'], 'anon may only select idea_links');
select table_privs_are('public', 'article_books', 'anon', array['SELECT'], 'anon may only select article_books');
select table_privs_are('public', 'article_ideas', 'anon', array['SELECT'], 'anon may only select article_ideas');
select table_privs_are('public', 'article_topics', 'anon', array['SELECT'], 'anon may only select article_topics');

select table_privs_are('public', 'ideas', 'authenticated', array['SELECT'], 'authenticated may only select ideas');
select table_privs_are('public', 'idea_localizations', 'authenticated', array['SELECT'], 'authenticated may only select idea_localizations');
select table_privs_are('public', 'articles', 'authenticated', array['SELECT'], 'authenticated may only select articles');
select table_privs_are('public', 'article_localizations', 'authenticated', array['SELECT'], 'authenticated may only select article_localizations');
select table_privs_are('public', 'idea_books', 'authenticated', array['SELECT'], 'authenticated may only select idea_books');
select table_privs_are('public', 'idea_topics', 'authenticated', array['SELECT'], 'authenticated may only select idea_topics');
select table_privs_are('public', 'idea_links', 'authenticated', array['SELECT'], 'authenticated may only select idea_links');
select table_privs_are('public', 'article_books', 'authenticated', array['SELECT'], 'authenticated may only select article_books');
select table_privs_are('public', 'article_ideas', 'authenticated', array['SELECT'], 'authenticated may only select article_ideas');
select table_privs_are('public', 'article_topics', 'authenticated', array['SELECT'], 'authenticated may only select article_topics');

select table_privs_are('public', 'ideas', 'service_role', array['SELECT', 'INSERT', 'UPDATE', 'DELETE'], 'service_role holds DML on ideas');
select table_privs_are('public', 'idea_localizations', 'service_role', array['SELECT', 'INSERT', 'UPDATE', 'DELETE'], 'service_role holds DML on idea_localizations');
select table_privs_are('public', 'articles', 'service_role', array['SELECT', 'INSERT', 'UPDATE', 'DELETE'], 'service_role holds DML on articles');
select table_privs_are('public', 'article_localizations', 'service_role', array['SELECT', 'INSERT', 'UPDATE', 'DELETE'], 'service_role holds DML on article_localizations');
select table_privs_are('public', 'idea_books', 'service_role', array['SELECT', 'INSERT', 'UPDATE', 'DELETE'], 'service_role holds DML on idea_books');
select table_privs_are('public', 'idea_topics', 'service_role', array['SELECT', 'INSERT', 'UPDATE', 'DELETE'], 'service_role holds DML on idea_topics');
select table_privs_are('public', 'idea_links', 'service_role', array['SELECT', 'INSERT', 'UPDATE', 'DELETE'], 'service_role holds DML on idea_links');
select table_privs_are('public', 'article_books', 'service_role', array['SELECT', 'INSERT', 'UPDATE', 'DELETE'], 'service_role holds DML on article_books');
select table_privs_are('public', 'article_ideas', 'service_role', array['SELECT', 'INSERT', 'UPDATE', 'DELETE'], 'service_role holds DML on article_ideas');
select table_privs_are('public', 'article_topics', 'service_role', array['SELECT', 'INSERT', 'UPDATE', 'DELETE'], 'service_role holds DML on article_topics');

-- Expected public rows after the cascades above:
--   ideas I1, I2; idea localizations I1 en, I1 vi, I2 en, I2 vi; article A1 and its en row;
--   exactly one relation row per table: I1->B1, I1->T1, I1->I2, A1->B1, A1->I1, A1->T1.

-- Visibility: anonymous (12) -----------------------------------------------------------------------
set local role anon;
select is((select count(*) from public.ideas), 2::bigint, 'anon sees the published ideas only');
select is((select count(*) from public.idea_localizations), 4::bigint, 'anon sees localizations of published ideas only');
select is((select count(*) from public.articles), 1::bigint, 'anon sees the published article only');
select is((select count(*) from public.article_localizations), 1::bigint, 'anon sees localizations of the published article only');
select results_eq(
  $$select book_id from public.idea_books$$,
  $$values ('c1220000-0000-4000-8000-000000000001'::uuid)$$,
  'anon sees an idea book only when the idea and the book are published');
select results_eq(
  $$select topic_id from public.idea_topics$$,
  $$values ('c1230000-0000-4000-8000-000000000001'::uuid)$$,
  'anon sees an idea topic only when the idea and the topic are published');
select results_eq(
  $$select related_idea_id from public.idea_links$$,
  $$values ('c1240000-0000-4000-8000-000000000002'::uuid)$$,
  'anon sees an idea link only when both ideas are published');
select results_eq(
  $$select book_id from public.article_books$$,
  $$values ('c1220000-0000-4000-8000-000000000001'::uuid)$$,
  'anon sees an article book only when the article and the book are published');
select results_eq(
  $$select idea_id from public.article_ideas$$,
  $$values ('c1240000-0000-4000-8000-000000000001'::uuid)$$,
  'anon sees an article idea only when the article and the idea are published');
select results_eq(
  $$select topic_id from public.article_topics$$,
  $$values ('c1230000-0000-4000-8000-000000000001'::uuid)$$,
  'anon sees an article topic only when the article and the topic are published');
select throws_ok(
  $$insert into public.ideas (status) values ('published')$$,
  '42501', null, 'anon cannot insert an idea');
select throws_ok(
  $$delete from public.idea_links$$,
  '42501', null, 'anon cannot delete idea links');
reset role;

-- Visibility: a signed-in non-admin reader (12) ----------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1200000-0000-4000-8000-000000000001', true);
select is((select count(*) from public.ideas), 2::bigint, 'a reader sees the published ideas only');
select is((select count(*) from public.idea_localizations), 4::bigint, 'a reader sees localizations of published ideas only');
select is((select count(*) from public.articles), 1::bigint, 'a reader sees the published article only');
select is((select count(*) from public.article_localizations), 1::bigint, 'a reader sees localizations of the published article only');
select is((select count(*) from public.idea_books), 1::bigint, 'a reader sees only the public idea book row');
select is((select count(*) from public.idea_topics), 1::bigint, 'a reader sees only the public idea topic row');
select is((select count(*) from public.idea_links), 1::bigint, 'a reader sees only the public idea link');
select is((select count(*) from public.article_books), 1::bigint, 'a reader sees only the public article book row');
select is((select count(*) from public.article_ideas), 1::bigint, 'a reader sees only the public article idea row');
select is((select count(*) from public.article_topics), 1::bigint, 'a reader sees only the public article topic row');
select throws_ok(
  $$update public.idea_localizations set question = 'Hijacked?'$$,
  '42501', null, 'a reader cannot update idea localizations');
select throws_ok(
  $$insert into public.article_topics (article_id, topic_id)
    values ('c1250000-0000-4000-8000-000000000002', 'c1230000-0000-4000-8000-000000000002')$$,
  '42501', null, 'a reader cannot insert article topics');
reset role;

-- Visibility: an admin (15) -------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1200000-0000-4000-8000-000000000002', true);
select is((select count(*) from public.ideas), 3::bigint, 'an admin reads draft ideas too');
select is((select count(*) from public.idea_localizations), 5::bigint, 'an admin reads draft idea localizations');
select is((select count(*) from public.articles), 2::bigint, 'an admin reads draft articles too');
select is((select count(*) from public.article_localizations), 2::bigint, 'an admin reads draft article localizations');
select is((select count(*) from public.idea_books), 3::bigint, 'an admin reads every idea book row');
select is((select count(*) from public.idea_topics), 3::bigint, 'an admin reads every idea topic row');
select is((select count(*) from public.idea_links), 3::bigint, 'an admin reads every idea link');
select is((select count(*) from public.article_books), 3::bigint, 'an admin reads every article book row');
select is((select count(*) from public.article_ideas), 3::bigint, 'an admin reads every article idea row');
select is((select count(*) from public.article_topics), 3::bigint, 'an admin reads every article topic row');
select throws_ok(
  $$insert into public.ideas (status) values ('draft')$$,
  '42501', null, 'an admin cannot insert an idea through the Data API');
select throws_ok(
  $$update public.articles set status = 'published' where id = 'c1250000-0000-4000-8000-000000000002'$$,
  '42501', null, 'an admin cannot publish an article through the Data API');
select throws_ok(
  $$delete from public.idea_books$$,
  '42501', null, 'an admin cannot delete idea books through the Data API');
select throws_ok(
  $$insert into public.article_ideas (article_id, idea_id, position)
    values ('c1250000-0000-4000-8000-000000000002', 'c1240000-0000-4000-8000-000000000002', 5)$$,
  '42501', null, 'an admin cannot insert article ideas through the Data API');
select throws_ok(
  $$update public.idea_localizations set body_blocks = '[]'::jsonb$$,
  '42501', null, 'an admin cannot edit idea content through the Data API');
reset role;

-- service_role owns the trusted write path (1) ------------------------------------------------------
set local role service_role;
select lives_ok(
  $$insert into public.ideas (id, status) values ('c1240000-0000-4000-8000-000000000005', 'draft')$$,
  'service_role may create an idea');
reset role;

select * from finish();
rollback;
