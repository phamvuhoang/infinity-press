begin;
select plan(74);

-- S12: the published knowledge read model and the knowledge branches of search_catalog
-- (docs/superpowers/specs/2026-09-21-s12-knowledge-hub-design.md sections 7 and 8, plan Task 5).
--
-- Every public read filters status and locale itself: an admin reads drafts under RLS, so each
-- assertion that matters is repeated for an admin caller at the end. Relation arrays keep the
-- editorial position and drop targets that are not published or not localized in the locale.

-- Fixtures ------------------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'd5700000-0000-0000-0000-00000000aaaa', 'authenticated', 'authenticated', 's12-public-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'd5700000-0000-0000-0000-00000000aaaa';

-- Author A has a visible book (a public page); author B has none, so its byline has no link.
insert into public.authors (id, canonical_slug, display_name, status) values
  ('d5700000-0000-0000-0000-000000000001', 's12p-author-a', 'Tác Giả S12P', 'published'),
  ('d5700000-0000-0000-0000-000000000002', 's12p-author-b', 'Người Viết S12P', 'published');
insert into public.author_localizations (author_id, locale, slug, name) values
  ('d5700000-0000-0000-0000-000000000001', 'vi', 's12p-tac-gia', 'Tác Giả S12P'),
  ('d5700000-0000-0000-0000-000000000002', 'vi', 's12p-nguoi-viet', 'Người Viết S12P');

insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('d5710000-0000-0000-0000-000000000001', 's12p-book-1', 'vi', 'd5700000-0000-0000-0000-000000000001', 'published'),
  ('d5710000-0000-0000-0000-000000000002', 's12p-book-2', 'vi', 'd5700000-0000-0000-0000-000000000001', 'published'),
  ('d5710000-0000-0000-0000-000000000003', 's12p-book-3', 'vi', 'd5700000-0000-0000-0000-000000000001', 'draft');
insert into public.book_localizations (book_id, locale, slug, title) values
  ('d5710000-0000-0000-0000-000000000001', 'vi', 's12p-nhan-tam', 'Nhân Tâm S12P'),
  ('d5710000-0000-0000-0000-000000000001', 'en', 's12p-people', 'People S12P'),
  ('d5710000-0000-0000-0000-000000000002', 'vi', 's12p-sach-hai', 'Sách Hai S12P'),
  ('d5710000-0000-0000-0000-000000000003', 'vi', 's12p-sach-nhap', 'Sách Nháp S12P');


-- Press: a work is listed only when it has a readable edition, so each published work gets one in its
-- original language with a live publication.
insert into public.editions (book_id, language_code)
select b.id, b.original_language from public.books b
where b.status = 'published' and not exists (select 1 from public.editions e where e.book_id = b.id);
insert into public.ebook_assets (edition_id, source_storage_key, version, status)
select e.id, 'fx/' || e.id || '.epub', 1, 'published'
from public.editions e join public.books b on b.id = e.book_id
where b.status = 'published' and e.active_publication_id is null;
insert into public.ebook_publications (ebook_asset_id, version, manifest_key, status, epub_language)
select a.id, 1, 'fx/' || a.id || '.json', 'published', e.language_code
from public.ebook_assets a join public.editions e on e.id = a.edition_id where a.source_storage_key like 'fx/%';
update public.editions e set status = 'published', active_publication_id = p.id
from public.ebook_publications p join public.ebook_assets a on a.id = p.ebook_asset_id
where a.edition_id = e.id and a.source_storage_key like 'fx/%';

-- t1 is visible in both locales, t2 in vi only, t3 is a draft, t4 is published without a book.
insert into public.topics (id, canonical_slug, name, status) values
  ('d5720000-0000-0000-0000-000000000001', 's12p-topic-1', 'Tâm lý S12P', 'published'),
  ('d5720000-0000-0000-0000-000000000002', 's12p-topic-2', 'Kỷ luật S12P', 'published'),
  ('d5720000-0000-0000-0000-000000000003', 's12p-topic-3', 'Nháp S12P', 'draft'),
  ('d5720000-0000-0000-0000-000000000004', 's12p-topic-4', 'Trống S12P', 'published');
insert into public.topic_localizations (topic_id, locale, slug, name) values
  ('d5720000-0000-0000-0000-000000000001', 'vi', 's12p-tam-ly', 'Tâm lý S12P'),
  ('d5720000-0000-0000-0000-000000000001', 'en', 's12p-psychology', 'Psychology S12P'),
  ('d5720000-0000-0000-0000-000000000002', 'vi', 's12p-ky-luat', 'Kỷ luật S12P'),
  ('d5720000-0000-0000-0000-000000000003', 'vi', 's12p-chu-de-nhap', 'Nháp S12P'),
  ('d5720000-0000-0000-0000-000000000004', 'vi', 's12p-trong', 'Trống S12P');
insert into public.book_topics (book_id, topic_id) values
  ('d5710000-0000-0000-0000-000000000001', 'd5720000-0000-0000-0000-000000000001'),
  ('d5710000-0000-0000-0000-000000000001', 'd5720000-0000-0000-0000-000000000002'),
  ('d5710000-0000-0000-0000-000000000001', 'd5720000-0000-0000-0000-000000000003');

insert into public.ideas (id, status, created_at) values
  ('d5730000-0000-0000-0000-000000000001', 'published', '2026-02-01T00:00:00Z'),
  ('d5730000-0000-0000-0000-000000000002', 'published', '2026-02-02T00:00:00Z'),
  ('d5730000-0000-0000-0000-000000000003', 'published', '2026-02-03T00:00:00Z'),
  ('d5730000-0000-0000-0000-000000000004', 'draft', '2026-02-04T00:00:00Z'),
  ('d5730000-0000-0000-0000-000000000005', 'archived', '2026-02-05T00:00:00Z');
insert into public.idea_localizations (idea_id, locale, slug, question, short_answer, body_blocks, seo_title) values
  ('d5730000-0000-0000-0000-000000000001', 'vi', 's12p-thoi-quen', 'Thói quen nhỏ S12P có quan trọng không?',
   'Có, lặp lại mỗi ngày tạo nên khác biệt.', '[{"type":"paragraph","content":[{"text":"bodyonlyzebra"}]}]', 'SEO S12P'),
  ('d5730000-0000-0000-0000-000000000001', 'en', 's12p-small-habits', 'Do small habits matter S12P?', 'Yes.', '[]', null),
  ('d5730000-0000-0000-0000-000000000002', 'vi', 's12p-an-sang', 'Ăn sáng S12P?', 'Nên.', '[]', null),
  ('d5730000-0000-0000-0000-000000000003', 'vi', 's12p-doc-the-nao', 'Bạn đọc S12P thế nào?', 'Chậm.', '[]', null),
  ('d5730000-0000-0000-0000-000000000003', 'en', 's12p-how-to-read', 'How to read S12P?', 'Slowly.', '[]', null),
  ('d5730000-0000-0000-0000-000000000004', 'vi', 's12p-y-tuong-nhap', 'Ý tưởng nháp S12P?', 'Nháp.', '[]', null),
  ('d5730000-0000-0000-0000-000000000005', 'vi', 's12p-y-tuong-luu', 'Ý tưởng lưu trữ S12P?', 'Lưu.', '[]', null);

insert into public.idea_books (idea_id, book_id, position) values
  ('d5730000-0000-0000-0000-000000000001', 'd5710000-0000-0000-0000-000000000002', 1),
  ('d5730000-0000-0000-0000-000000000001', 'd5710000-0000-0000-0000-000000000001', 2),
  ('d5730000-0000-0000-0000-000000000001', 'd5710000-0000-0000-0000-000000000003', 3),
  ('d5730000-0000-0000-0000-000000000003', 'd5710000-0000-0000-0000-000000000001', 1),
  ('d5730000-0000-0000-0000-000000000004', 'd5710000-0000-0000-0000-000000000001', 1),
  ('d5730000-0000-0000-0000-000000000005', 'd5710000-0000-0000-0000-000000000001', 1);
insert into public.idea_topics (idea_id, topic_id) values
  ('d5730000-0000-0000-0000-000000000001', 'd5720000-0000-0000-0000-000000000001'),
  ('d5730000-0000-0000-0000-000000000001', 'd5720000-0000-0000-0000-000000000002'),
  ('d5730000-0000-0000-0000-000000000001', 'd5720000-0000-0000-0000-000000000003'),
  ('d5730000-0000-0000-0000-000000000001', 'd5720000-0000-0000-0000-000000000004'),
  ('d5730000-0000-0000-0000-000000000003', 'd5720000-0000-0000-0000-000000000001'),
  ('d5730000-0000-0000-0000-000000000004', 'd5720000-0000-0000-0000-000000000001');
insert into public.idea_links (idea_id, related_idea_id, position) values
  ('d5730000-0000-0000-0000-000000000001', 'd5730000-0000-0000-0000-000000000003', 1),
  ('d5730000-0000-0000-0000-000000000001', 'd5730000-0000-0000-0000-000000000002', 2),
  ('d5730000-0000-0000-0000-000000000001', 'd5730000-0000-0000-0000-000000000004', 3),
  ('d5730000-0000-0000-0000-000000000001', 'd5730000-0000-0000-0000-000000000005', 4);

-- a2 and a3 share a publish date, so their order falls to the id.
insert into public.articles (id, status, author_id, published_at, created_at) values
  ('d5740000-0000-0000-0000-000000000001', 'published', 'd5700000-0000-0000-0000-000000000001', '2026-01-01T00:00:00Z', '2025-12-01T00:00:00Z'),
  ('d5740000-0000-0000-0000-000000000002', 'published', 'd5700000-0000-0000-0000-000000000002', '2026-03-01T00:00:00Z', '2025-12-01T00:00:00Z'),
  ('d5740000-0000-0000-0000-000000000003', 'published', 'd5700000-0000-0000-0000-000000000001', '2026-03-01T00:00:00Z', '2025-12-01T00:00:00Z'),
  ('d5740000-0000-0000-0000-000000000004', 'draft', 'd5700000-0000-0000-0000-000000000001', null, '2025-12-01T00:00:00Z'),
  ('d5740000-0000-0000-0000-000000000005', 'archived', 'd5700000-0000-0000-0000-000000000001', '2026-04-01T00:00:00Z', '2025-12-01T00:00:00Z');
insert into public.article_localizations (article_id, locale, slug, title, excerpt, body_blocks) values
  ('d5740000-0000-0000-0000-000000000001', 'vi', 's12p-doc-sau', 'Đọc sâu S12P', 'Tập trung vào một cuốn sách.',
   '[{"type":"paragraph","content":[{"text":"articlebodyonlyquokka"}]}]'),
  ('d5740000-0000-0000-0000-000000000001', 'en', 's12p-deep-reading', 'Deep reading S12P', 'Focus.', '[]'),
  ('d5740000-0000-0000-0000-000000000002', 'vi', 's12p-bai-hai', 'Bài hai S12P', 'Tóm tắt hai.', '[]'),
  ('d5740000-0000-0000-0000-000000000003', 'vi', 's12p-bai-ba', 'Bài ba S12P', 'Tóm tắt ba.', '[]'),
  ('d5740000-0000-0000-0000-000000000004', 'vi', 's12p-bai-nhap', 'Bài nháp S12P', 'Nháp.', '[]'),
  ('d5740000-0000-0000-0000-000000000005', 'vi', 's12p-bai-luu', 'Bài lưu trữ S12P', 'Lưu.', '[]');
insert into public.article_books (article_id, book_id, position) values
  ('d5740000-0000-0000-0000-000000000001', 'd5710000-0000-0000-0000-000000000001', 1),
  ('d5740000-0000-0000-0000-000000000001', 'd5710000-0000-0000-0000-000000000003', 2),
  ('d5740000-0000-0000-0000-000000000001', 'd5710000-0000-0000-0000-000000000002', 3),
  ('d5740000-0000-0000-0000-000000000002', 'd5710000-0000-0000-0000-000000000001', 1),
  ('d5740000-0000-0000-0000-000000000003', 'd5710000-0000-0000-0000-000000000001', 1),
  ('d5740000-0000-0000-0000-000000000004', 'd5710000-0000-0000-0000-000000000001', 1),
  ('d5740000-0000-0000-0000-000000000005', 'd5710000-0000-0000-0000-000000000001', 1);
insert into public.article_ideas (article_id, idea_id, position) values
  ('d5740000-0000-0000-0000-000000000001', 'd5730000-0000-0000-0000-000000000003', 1),
  ('d5740000-0000-0000-0000-000000000001', 'd5730000-0000-0000-0000-000000000004', 2),
  ('d5740000-0000-0000-0000-000000000001', 'd5730000-0000-0000-0000-000000000001', 3),
  ('d5740000-0000-0000-0000-000000000001', 'd5730000-0000-0000-0000-000000000002', 4);
insert into public.article_topics (article_id, topic_id) values
  ('d5740000-0000-0000-0000-000000000001', 'd5720000-0000-0000-0000-000000000001'),
  ('d5740000-0000-0000-0000-000000000001', 'd5720000-0000-0000-0000-000000000003'),
  ('d5740000-0000-0000-0000-000000000004', 'd5720000-0000-0000-0000-000000000001');

-- Shape and grants ---------------------------------------------------------------------------- (1)-(12)
select is(has_function_privilege('anon', 'public.knowledge_idea_index(text)', 'EXECUTE'), true, 'anon can read the idea index');
select is(has_function_privilege('anon', 'public.knowledge_idea_page(text, text)', 'EXECUTE'), true, 'anon can read an idea page');
select is(has_function_privilege('anon', 'public.knowledge_article_index(text)', 'EXECUTE'), true, 'anon can read the article index');
select is(has_function_privilege('anon', 'public.knowledge_article_page(text, text)', 'EXECUTE'), true, 'anon can read an article page');
select is(has_function_privilege('anon', 'public.knowledge_for_book(text, uuid)', 'EXECUTE'), true, 'anon can read book backlinks');
select is(has_function_privilege('anon', 'public.knowledge_for_topic(text, uuid)', 'EXECUTE'), true, 'anon can read topic backlinks');
select is(has_function_privilege('authenticated', 'public.knowledge_idea_page(text, text)', 'EXECUTE'), true, 'authenticated can read an idea page');
select is(has_function_privilege('authenticated', 'public.knowledge_for_topic(text, uuid)', 'EXECUTE'), true, 'authenticated can read topic backlinks');
select is(has_function_privilege('anon', 'public.knowledge_topic_refs(text, uuid, text)', 'EXECUTE'), false, 'the topic ref helper is internal to anon');
select is(has_function_privilege('authenticated', 'public.knowledge_topic_refs(text, uuid, text)', 'EXECUTE'), false, 'the topic ref helper is internal to authenticated');
select is(has_function_privilege('anon', 'public.knowledge_article_author(uuid, text)', 'EXECUTE'), false, 'the author ref helper is internal');
select is(has_function_privilege('anon', 'public.search_catalog(text, text)', 'EXECUTE'), true, 'anon can still search');

set local role anon;

-- Idea index ---------------------------------------------------------------------------------- (13)-(17)
select is(
  (select array_agg(x.slug order by x.n)
   from public.knowledge_idea_index('vi') with ordinality x(idea_id, slug, question, short_answer, created_at, updated_at, alternate_slugs, topics, n)
   where x.slug like 's12p-%'),
  array['s12p-an-sang', 's12p-doc-the-nao', 's12p-thoi-quen'],
  'the vi idea index lists only published vi ideas, ordered by question');
select is(
  (select array_agg(x.slug order by x.n)
   from public.knowledge_idea_index('en') with ordinality x(idea_id, slug, question, short_answer, created_at, updated_at, alternate_slugs, topics, n)
   where x.slug like 's12p-%'),
  array['s12p-small-habits', 's12p-how-to-read'],
  'the en idea index lists only ideas localized in en');
select is(
  (select topics from public.knowledge_idea_index('vi') where slug = 's12p-thoi-quen'),
  '[{"slug":"s12p-ky-luat","name":"Kỷ luật S12P"},{"slug":"s12p-tam-ly","name":"Tâm lý S12P"}]'::jsonb,
  'an idea carries every visible localized topic, and never a draft or bookless topic');
select is(
  (select topics from public.knowledge_idea_index('vi') where slug = 's12p-an-sang'),
  '[]'::jsonb, 'an idea without topics carries an empty topic list');
select is(
  (select alternate_slugs->>'en' from public.knowledge_idea_index('vi') where slug = 's12p-thoi-quen'),
  's12p-small-habits', 'the index row carries the other-locale slugs');

-- Idea page ----------------------------------------------------------------------------------- (18)-(30)
select is(public.knowledge_idea_page('vi', 's12p-thoi-quen')->>'ideaId', 'd5730000-0000-0000-0000-000000000001', 'a published idea page resolves');
select is(public.knowledge_idea_page('vi', 's12p-thoi-quen')->>'question', 'Thói quen nhỏ S12P có quan trọng không?', 'the page carries the question');
select is(public.knowledge_idea_page('vi', 's12p-thoi-quen')->'bodyBlocks',
  '[{"type":"paragraph","content":[{"text":"bodyonlyzebra"}]}]'::jsonb, 'the page carries the stored blocks');
select is(public.knowledge_idea_page('vi', 's12p-thoi-quen')->'bookIds',
  '["d5710000-0000-0000-0000-000000000002","d5710000-0000-0000-0000-000000000001"]'::jsonb,
  'related books keep their position and drop drafts');
select is(public.knowledge_idea_page('en', 's12p-small-habits')->'bookIds',
  '["d5710000-0000-0000-0000-000000000001"]'::jsonb, 'related books drop books not localized in the locale');
select is(public.knowledge_idea_page('vi', 's12p-thoi-quen')->'relatedIdeaIds',
  '["d5730000-0000-0000-0000-000000000003","d5730000-0000-0000-0000-000000000002"]'::jsonb,
  'related ideas keep their position and drop draft and archived ideas');
select is(public.knowledge_idea_page('en', 's12p-small-habits')->'relatedIdeaIds',
  '["d5730000-0000-0000-0000-000000000003"]'::jsonb, 'related ideas drop ideas not localized in the locale');
select is(public.knowledge_idea_page('vi', 's12p-thoi-quen')->'alternateSlugs'->>'en', 's12p-small-habits', 'an existing alternate is returned');
select is(public.knowledge_idea_page('vi', 's12p-an-sang')->'alternateSlugs', '{}'::jsonb, 'a missing alternate is null');
select is(public.knowledge_idea_page('vi', 's12p-thoi-quen')->>'seoTitle', 'SEO S12P', 'the page carries its SEO override');
select ok((public.knowledge_idea_page('vi', 's12p-thoi-quen')->>'createdAt')::timestamptz = '2026-02-01T00:00:00Z'
  and (public.knowledge_idea_page('vi', 's12p-thoi-quen')->>'updatedAt') is not null,
  'the page carries createdAt and the localization updatedAt');
select ok(public.knowledge_idea_page('vi', 's12p-y-tuong-nhap') is null
  and public.knowledge_idea_page('vi', 's12p-y-tuong-luu') is null, 'draft and archived ideas never resolve');
select ok(public.knowledge_idea_page('en', 's12p-thoi-quen') is null
  and public.knowledge_idea_page('en', 's12p-an-sang') is null
  and public.knowledge_idea_page('fr', 's12p-thoi-quen') is null
  and public.knowledge_idea_page('vi', 'Not A Slug!') is null
  and public.knowledge_idea_page('vi', null) is null,
  'a slug from the other locale, a missing localization, a bad locale, or a malformed slug returns null');

-- Article index ------------------------------------------------------------------------------- (31)-(35)
select is(
  (select array_agg(x.slug order by x.n)
   from public.knowledge_article_index('vi') with ordinality x(article_id, slug, title, excerpt, published_at, updated_at, alternate_slugs, author, n)
   where x.slug like 's12p-%'),
  array['s12p-bai-hai', 's12p-bai-ba', 's12p-doc-sau'],
  'the vi article index is published_at desc, then id, and hides drafts and archives');
select is(
  (select array_agg(x.slug order by x.n)
   from public.knowledge_article_index('en') with ordinality x(article_id, slug, title, excerpt, published_at, updated_at, alternate_slugs, author, n)
   where x.slug like 's12p-%'),
  array['s12p-deep-reading'], 'the en article index lists only en localizations');
select is((select author from public.knowledge_article_index('vi') where slug = 's12p-doc-sau'),
  '{"name":"Tác Giả S12P","slug":"s12p-tac-gia"}'::jsonb, 'a byline links an author with a public page');
select is((select author from public.knowledge_article_index('vi') where slug = 's12p-bai-hai'),
  '{"name":"Người Viết S12P","slug":null}'::jsonb, 'a byline for an author without a public page has no slug');
select is((select author from public.knowledge_article_index('en') where slug = 's12p-deep-reading'),
  '{"name":"Tác Giả S12P","slug":null}'::jsonb, 'an author without the locale falls back to the display name without a link');

-- Article page -------------------------------------------------------------------------------- (36)-(44)
select is(public.knowledge_article_page('vi', 's12p-doc-sau')->>'articleId', 'd5740000-0000-0000-0000-000000000001', 'a published article page resolves');
select ok((public.knowledge_article_page('vi', 's12p-doc-sau')->>'publishedAt')::timestamptz = '2026-01-01T00:00:00Z',
  'the page carries the preserved publish date');
select ok((public.knowledge_article_page('vi', 's12p-doc-sau')->>'updatedAt') is not null, 'the page carries the localization updatedAt');
select is(public.knowledge_article_page('vi', 's12p-doc-sau')->'author',
  '{"name":"Tác Giả S12P","slug":"s12p-tac-gia"}'::jsonb, 'the page carries the localized author');
select is(public.knowledge_article_page('vi', 's12p-doc-sau')->'bookIds',
  '["d5710000-0000-0000-0000-000000000001","d5710000-0000-0000-0000-000000000002"]'::jsonb,
  'article books keep their position and drop drafts');
select is(public.knowledge_article_page('vi', 's12p-doc-sau')->'ideaIds',
  '["d5730000-0000-0000-0000-000000000003","d5730000-0000-0000-0000-000000000001","d5730000-0000-0000-0000-000000000002"]'::jsonb,
  'article ideas keep their position and drop drafts');
select is(public.knowledge_article_page('en', 's12p-deep-reading')->'ideaIds',
  '["d5730000-0000-0000-0000-000000000003","d5730000-0000-0000-0000-000000000001"]'::jsonb,
  'article ideas drop ideas not localized in the locale');
select is(public.knowledge_article_page('vi', 's12p-doc-sau')->'topics',
  '[{"slug":"s12p-tam-ly","name":"Tâm lý S12P"}]'::jsonb, 'article topics are visible localized refs only');
select ok(public.knowledge_article_page('vi', 's12p-bai-nhap') is null
  and public.knowledge_article_page('vi', 's12p-bai-luu') is null
  and public.knowledge_article_page('en', 's12p-bai-hai') is null
  and public.knowledge_article_page('vi', '../x') is null
  and public.knowledge_article_page('vi', 's12p-doc-sau')->'alternateSlugs'->>'en' = 's12p-deep-reading'
  and public.knowledge_article_page('vi', 's12p-bai-hai')->'alternateSlugs' = '{}'::jsonb,
  'drafts, archives, missing locales and malformed slugs return null; alternates exist only when localized');

-- Backlinks ----------------------------------------------------------------------------------- (45)-(50)
select is(
  (select array_agg(x.kind || ':' || x.slug order by x.n)
   from public.knowledge_for_book('vi', 'd5710000-0000-0000-0000-000000000001') with ordinality x(kind, slug, title, excerpt, published_at, n)),
  array['idea:s12p-doc-the-nao', 'idea:s12p-thoi-quen', 'article:s12p-bai-hai', 'article:s12p-bai-ba', 'article:s12p-doc-sau'],
  'book backlinks: published ideas by question then id, then articles by published_at desc then id');
select is(
  (select array_agg(x.kind || ':' || x.slug order by x.n)
   from public.knowledge_for_book('en', 'd5710000-0000-0000-0000-000000000001') with ordinality x(kind, slug, title, excerpt, published_at, n)),
  array['idea:s12p-small-habits', 'idea:s12p-how-to-read', 'article:s12p-deep-reading'],
  'book backlinks follow the locale');
select is(
  (select row(title, excerpt, published_at)::text from public.knowledge_for_book('vi', 'd5710000-0000-0000-0000-000000000001') where slug = 's12p-thoi-quen'),
  row('Thói quen nhỏ S12P có quan trọng không?', 'Có, lặp lại mỗi ngày tạo nên khác biệt.', null::timestamptz)::text,
  'an idea backlink uses its question and short answer');
select is((select count(*)::bigint from public.knowledge_for_book('vi', 'd5710000-0000-0000-0000-000000000003')), 0::bigint,
  'a draft book has no backlinks');
select is(
  (select array_agg(x.kind || ':' || x.slug order by x.n)
   from public.knowledge_for_topic('vi', 'd5720000-0000-0000-0000-000000000001') with ordinality x(kind, slug, title, excerpt, published_at, n)),
  array['idea:s12p-doc-the-nao', 'idea:s12p-thoi-quen', 'article:s12p-doc-sau'],
  'topic backlinks list only published localized ideas and articles');
select is((select count(*)::bigint from public.knowledge_for_topic('vi', 'd5720000-0000-0000-0000-000000000003')), 0::bigint,
  'a draft topic has no backlinks');

-- Search -------------------------------------------------------------------------------------- (51)-(66)
select is((select score from public.search_catalog('vi', 'thoi quen nho s12p') where kind = 'idea' and slug = 's12p-thoi-quen'), 2,
  'an unaccented query matches an idea question');
select is((select score from public.search_catalog('vi', 'Thói quen nhỏ S12P') where kind = 'idea' and slug = 's12p-thoi-quen'), 2,
  'an accented query matches an idea question');
select is((select score from public.search_catalog('vi', 'lap lai moi ngay') where kind = 'idea' and slug = 's12p-thoi-quen'), 1,
  'the short answer matches too');
select is((select name from public.search_catalog('vi', 'lap lai moi ngay') where kind = 'idea' and slug = 's12p-thoi-quen'),
  'Thói quen nhỏ S12P có quan trọng không?', 'an idea hit is named by its question');
select is((select score from public.search_catalog('vi', 'doc sau s12p') where kind = 'article' and slug = 's12p-doc-sau'), 3,
  'an unaccented query matches an article title exactly');
select is((select score from public.search_catalog('vi', 'Tập trung vào') where kind = 'article' and slug = 's12p-doc-sau'), 2,
  'an accented query matches an article excerpt');
select is((select count(*)::bigint from public.search_catalog('vi', 'bodyonlyzebra')), 0::bigint, 'idea body text is not searched');
select is((select count(*)::bigint from public.search_catalog('vi', 'articlebodyonlyquokka')), 0::bigint, 'article body text is not searched');
select is((select count(*)::bigint from public.search_catalog('vi', 'y tuong nhap s12p') where slug in ('s12p-y-tuong-nhap', 's12p-y-tuong-luu')), 0::bigint,
  'draft and archived ideas never match');
select is((select count(*)::bigint from public.search_catalog('vi', 'bai nhap s12p') where slug in ('s12p-bai-nhap', 's12p-bai-luu')), 0::bigint,
  'draft and archived articles never match');
select is((select count(*)::bigint from public.search_catalog('vi', 'deep reading s12p') where kind = 'article'), 0::bigint,
  'an en-only title does not match in vi');
select is((select count(*)::bigint from public.search_catalog('en', 'deep reading s12p') where kind = 'article'), 1::bigint,
  'the en localization matches in en');

-- Existing kinds keep their behavior and scores.
select is((select score from public.search_catalog('vi', 'nhan tam s12p') where kind = 'book' and slug = 's12p-nhan-tam'), 3,
  'an exact book title still scores 3');
select is((select score from public.search_catalog('vi', 'tac gia s12p') where kind = 'book' and slug = 's12p-sach-hai'), 3,
  'an exact author name still lifts their book to 3');
select is((select score from public.search_catalog('vi', 'tac gia s12p') where kind = 'author' and slug = 's12p-tac-gia'), 3,
  'the author is still returned');
select is((select score from public.search_catalog('vi', 'ky luat s12p') where kind = 'topic' and slug = 's12p-ky-luat'), 3,
  'a published topic still matches');

reset role;

-- Per-kind cap ---------------------------------------------------------------------------------- (67)-(70)
insert into public.ideas (id, status)
select ('d5750000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'published' from generate_series(1, 25) n;
insert into public.idea_localizations (idea_id, locale, slug, question, short_answer)
select ('d5750000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'vi', 's12p-cap-idea-' || n, 'Capcap S12P idea ' || n, 'Cap.'
from generate_series(1, 25) n;
insert into public.articles (id, status, author_id, published_at)
select ('d5760000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'published', 'd5700000-0000-0000-0000-000000000001', now()
from generate_series(1, 25) n;
insert into public.article_localizations (article_id, locale, slug, title, excerpt)
select ('d5760000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'vi', 's12p-cap-article-' || n, 'Capcap S12P article ' || n, 'Cap.'
from generate_series(1, 25) n;

set local role anon;
select is((select count(*)::bigint from public.search_catalog('vi', 'capcap s12p idea') where kind = 'idea'), 20::bigint, 'ideas cap at 20');
select is((select count(*)::bigint from public.search_catalog('vi', 'capcap s12p article') where kind = 'article'), 20::bigint, 'articles cap at 20');
select is((select count(*)::bigint from public.search_catalog('vi', 'capcap s12p') where kind in ('idea', 'article')), 40::bigint,
  'each knowledge kind is capped on its own');
select is(
  (select array_agg(distinct kind order by kind) from public.search_catalog('vi', 's12p')),
  array['article', 'author', 'book', 'idea', 'topic'], 'search returns the knowledge kinds beside the catalog kinds');
reset role;

-- An admin caller still gets the public view -------------------------------------------------- (71)-(74)
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd5700000-0000-0000-0000-00000000aaaa', true);
select ok(public.knowledge_idea_page('vi', 's12p-y-tuong-nhap') is null, 'an admin reading an idea page does not get a draft');
select ok(public.knowledge_article_page('vi', 's12p-bai-nhap') is null, 'an admin reading an article page does not get a draft');
select is((select count(*)::bigint from public.knowledge_idea_index('vi') where slug in ('s12p-y-tuong-nhap', 's12p-y-tuong-luu')), 0::bigint,
  'an admin reading the idea index does not get drafts');
select is((select count(*)::bigint from public.search_catalog('vi', 'y tuong nhap s12p') where kind = 'idea' and slug = 's12p-y-tuong-nhap'), 0::bigint,
  'an admin search does not return draft ideas');
reset role;

select * from finish();
rollback;
