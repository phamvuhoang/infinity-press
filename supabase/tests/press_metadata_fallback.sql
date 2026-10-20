begin;
select plan(27);

-- Third review pass: metadata fallback on every entity (spec section 5, A12), the one "visible work"
-- rule, a published-only language default, editorial_state readable by the storefront, and no SePay
-- provider in the database. The platform default metadata locale is 'en' throughout.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'f7100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'mf-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role) select id, 'admin' from public.profiles where auth_user_id = 'f7100000-0000-0000-0000-000000000001';

-- One author (EN copy only), one series (EN copy only), one topic (EN and JA copy), one work with EN
-- and JA copy and a published EN edition, and one work with a Vietnamese edition only.
insert into public.authors (id, canonical_slug, display_name, status) values ('f7200000-0000-0000-0000-000000000001', 'mf-author', 'MF Author', 'published');
insert into public.author_localizations (author_id, locale, slug, name, description) values
  ('f7200000-0000-0000-0000-000000000001', 'en', 'mf-author-en', 'MF Author', 'Wrote classics.');
insert into public.series (id, canonical_slug, display_name, status) values ('f7250000-0000-0000-0000-000000000001', 'mf-series', 'MF Series', 'published');
insert into public.series_localizations (series_id, locale, slug, name) values ('f7250000-0000-0000-0000-000000000001', 'en', 'mf-series-en', 'MF Series');
insert into public.topics (id, canonical_slug, name, status) values ('f7260000-0000-0000-0000-000000000001', 'mf-topic', 'MF Topic', 'published');
insert into public.topic_localizations (topic_id, locale, slug, name) values
  ('f7260000-0000-0000-0000-000000000001', 'en', 'mf-topic-en', 'Courage'),
  ('f7260000-0000-0000-0000-000000000001', 'ja', 'mf-topic-ja', '勇気');

insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('f7300000-0000-0000-0000-000000000001', 'mf-book', 'en', 'f7200000-0000-0000-0000-000000000001', 'published'),
  ('f7300000-0000-0000-0000-000000000002', 'mf-book-vi', 'vi', 'f7200000-0000-0000-0000-000000000001', 'published');
insert into public.book_localizations (book_id, locale, slug, title) values
  ('f7300000-0000-0000-0000-000000000001', 'en', 'mf-book-en', 'MF Book'),
  ('f7300000-0000-0000-0000-000000000001', 'ja', 'mf-book-ja', 'MF 本'),
  ('f7300000-0000-0000-0000-000000000002', 'vi', 'mf-sach-vi', 'Sách MF');
insert into public.book_series (book_id, series_id, position) values ('f7300000-0000-0000-0000-000000000001', 'f7250000-0000-0000-0000-000000000001', 1);
insert into public.book_topics (book_id, topic_id) values ('f7300000-0000-0000-0000-000000000001', 'f7260000-0000-0000-0000-000000000001');

create temporary table t_ed (book uuid, lang text, id uuid default gen_random_uuid());
grant select on t_ed to public;
insert into t_ed (book, lang) values ('f7300000-0000-0000-0000-000000000001', 'en'), ('f7300000-0000-0000-0000-000000000002', 'vi');
insert into public.editions (id, book_id, language_code) select id, book, lang from t_ed;
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) select id, id, 'mf/' || id || '.epub', 1, 'published' from t_ed;
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status, epub_language) select id, id, 1, 'mf/' || id || '.json', 'published', lang from t_ed;
update public.editions e set active_publication_id = t.id, status = 'published' from t_ed t where t.id = e.id;
-- A second, draft English edition of the first work, for the language-default rule.
insert into public.editions (id, book_id, language_code, edition_number, status) values ('f7400000-0000-0000-0000-000000000009', 'f7300000-0000-0000-0000-000000000001', 'en', 2, 'draft');

-- A published idea and article localized in English only, linked to the first work.
insert into public.ideas (id, status) values ('f7500000-0000-0000-0000-000000000001', 'published');
insert into public.idea_localizations (idea_id, locale, slug, question, short_answer) values
  ('f7500000-0000-0000-0000-000000000001', 'en', 'mf-why-read', 'Why read MF?', 'Because.');
insert into public.idea_books (idea_id, book_id, position) values ('f7500000-0000-0000-0000-000000000001', 'f7300000-0000-0000-0000-000000000001', 1);
insert into public.idea_topics (idea_id, topic_id) values ('f7500000-0000-0000-0000-000000000001', 'f7260000-0000-0000-0000-000000000001');
insert into public.articles (id, status, author_id, published_at) values ('f7600000-0000-0000-0000-000000000001', 'published', 'f7200000-0000-0000-0000-000000000001', now());
insert into public.article_localizations (article_id, locale, slug, title, excerpt) values
  ('f7600000-0000-0000-0000-000000000001', 'en', 'mf-deep-reading', 'Deep reading MF', 'An excerpt.');
insert into public.article_books (article_id, book_id, position) values ('f7600000-0000-0000-0000-000000000001', 'f7300000-0000-0000-0000-000000000001', 1);

-- (1)-(4) An author with English copy only is reached under /ja by its English slug, whole, and says so.
select is(public.catalog_entity_page('author', 'ja', 'mf-author-en') ->> 'metadataLocale', 'en', 'a JA author page with no JA copy shows the EN copy and says so');
select is(public.catalog_entity_page('author', 'ja', 'mf-author-en') ->> 'description', 'Wrote classics.', 'the whole EN row comes along');
select is(public.catalog_entity_page('author', 'ja', 'mf-author-en') -> 'alternateSlugs' ->> 'en', 'mf-author-en', 'the EN slug is named, so the JA page can be canonical to it');
select is(public.catalog_entity_page('author', 'en', 'mf-author-en') ->> 'metadataLocale', 'en', 'the EN page is its own');

-- (5)-(6) A topic with its own JA copy is reached only under its JA slug there.
select is(public.catalog_entity_page('topic', 'ja', 'mf-topic-ja') ->> 'name', '勇気', 'a topic with JA copy shows it');
select is(public.catalog_entity_page('topic', 'ja', 'mf-topic-en'), null, 'and is not a second page under its EN slug');

-- (7)-(8) Series fall back the same way; a Vietnamese visitor with no VI copy gets the EN one.
select is(public.catalog_entity_page('series', 'vi', 'mf-series-en') ->> 'metadataLocale', 'en', 'a series falls back to the EN copy');
select is(public.catalog_entity_page('series', 'vi', 'mf-series-vi'), null, 'a slug that exists in no locale is nothing');

-- (9)-(10) Cards name their author, series and topics by the same copy; the JA card of the first work
-- carries the EN author slug (its only copy) and the JA topic slug (its own).
select is((select author_slug from public.catalog_book_cards('ja') where book_id = 'f7300000-0000-0000-0000-000000000001'), 'mf-author-en', 'the JA card links the author under its EN slug');
select is((select topics -> 0 ->> 'slug' from public.catalog_book_cards('ja') where book_id = 'f7300000-0000-0000-0000-000000000001'), 'mf-topic-ja', 'and the topic under its JA slug');

-- (11)-(12) The home topics and the entity slug list follow the same rule; only own-copy pages are listed.
select is((select name from public.catalog_home_topics('ja') where slug = 'mf-topic-ja'), '勇気', 'home topics show the JA copy');
select is(
  (select array_agg(kind || ':' || slug order by kind, slug) from public.catalog_entity_slugs('ja')),
  array['topic:mf-topic-ja'],
  'the JA sitemap lists the topic (own copy) but not the author or series (shown under EN copy)');

-- (13)-(14) A work is visible in a locale when the catalog rule shows it there: the Vietnamese-only
-- work has no English edition, so its author is not reachable through it in English. The written-out
-- rule in catalog_has_visible_book agrees with catalog_resolved_editions on every work in every locale.
select is(public.catalog_has_visible_book('author', 'f7200000-0000-0000-0000-000000000001', 'en'), true, 'the author is visible in EN through the EN work');
update public.books set status = 'draft' where id = 'f7300000-0000-0000-0000-000000000001';
select is(public.catalog_has_visible_book('author', 'f7200000-0000-0000-0000-000000000001', 'en'), false, 'and not through a work with no EN or default-language edition');
update public.books set status = 'published' where id = 'f7300000-0000-0000-0000-000000000001';
select is(
  (select count(*) from public.books b cross join (values ('en'), ('ja'), ('vi')) l(locale)
   where b.primary_author_id = 'f7200000-0000-0000-0000-000000000001'
     and (exists (select 1 from public.catalog_resolved_editions(l.locale, b.id)) and exists (select 1 from public.catalog_book_metadata(b.id, l.locale)))
       <> public.catalog_has_visible_book('author', b.primary_author_id, l.locale)
     and not exists (select 1 from public.books o where o.primary_author_id = b.primary_author_id and o.id <> b.id
                     and exists (select 1 from public.catalog_resolved_editions(l.locale, o.id)) and exists (select 1 from public.catalog_book_metadata(o.id, l.locale)))),
  0::bigint,
  'catalog_has_visible_book agrees with the resolver and the metadata rule in every locale');

-- (15)-(16) Search finds the copy the pages show: the work has no VI copy, so a Vietnamese search
-- matches its EN title and names its EN slug.
select is((select slug from public.search_catalog('vi', 'MF Book') where kind = 'book'), 'mf-book-en', 'VI search finds a work shown under its EN copy');
select is((select slug from public.search_catalog('ja', 'MF Author') where kind = 'author'), 'mf-author-en', 'and an author shown under EN copy');

-- (17)-(21) Knowledge: an idea and an article localized in English only are shown under /ja whole.
select is(public.knowledge_idea_page('ja', 'mf-why-read') ->> 'metadataLocale', 'en', 'a JA idea page with no JA copy shows the EN copy and says so');
select is(public.knowledge_idea_page('ja', 'mf-why-read') -> 'topics' -> 0 ->> 'slug', 'mf-topic-ja', 'its topics use the JA copy where there is one');
select is(public.knowledge_article_page('ja', 'mf-deep-reading') ->> 'metadataLocale', 'en', 'a JA article page falls back the same way');
select is((select metadata_locale from public.knowledge_idea_index('ja') where slug = 'mf-why-read'), 'en', 'the JA index carries the copy locale, so the sitemap can leave the page out');
select is((select kind || ':' || slug from public.knowledge_for_book('ja', 'f7300000-0000-0000-0000-000000000001') limit 1), 'idea:mf-why-read', 'JA book backlinks reach the EN-only idea');

-- (22)-(23) A language default must be a published edition.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f7100000-0000-0000-0000-000000000001', true);
select throws_ok($$select public.admin_set_default_edition('f7300000-0000-0000-0000-000000000001', 'en', 'f7400000-0000-0000-0000-000000000009')$$, 'EB012', null, 'a draft edition cannot be made the language default');
select lives_ok($$select public.admin_set_default_edition('f7300000-0000-0000-0000-000000000001', 'en', (select id from t_ed where lang = 'en'))$$, 'the published edition can');
reset role;

-- (24) The storefront reads editorial_state, not the evidence.
set local role anon;
select lives_ok($$select editorial_state from public.editions limit 1$$, 'anon reads editorial_state');
select throws_ok($$select review_note from public.editions limit 1$$, '42501', null, 'anon still cannot read the editorial evidence');
reset role;

-- (26) The database no longer admits SePay as the payment provider.
select throws_ok($$update public.commerce_settings set payment_provider = 'sepay'$$, '23514', null, 'commerce_settings refuses sepay');

select * from finish();
rollback;
