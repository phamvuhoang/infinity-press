begin;
select plan(58);

-- Press Task 4: publishing is per edition. Publishing or rolling back Japanese never touches the
-- English publication, pointer, or progress.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e5100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'ep-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e5100000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'ep-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'e5100000-0000-0000-0000-000000000001';
create temporary table t_p as
select (select id from public.profiles where auth_user_id = 'e5100000-0000-0000-0000-000000000002') as reader_id;
grant select on t_p to public;

insert into public.authors (id, canonical_slug, display_name, status)
values ('e5200000-0000-0000-0000-000000000001', 'ep-author', 'EP Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('e5300000-0000-0000-0000-000000000001', 'ep-book', 'en', 'e5200000-0000-0000-0000-000000000001', 'draft'),
  ('e5300000-0000-0000-0000-000000000002', 'ep-other', 'en', 'e5200000-0000-0000-0000-000000000001', 'draft');
insert into public.editions (id, book_id, language_code, edition_number) values
  ('e5400000-0000-0000-0000-000000000001', 'e5300000-0000-0000-0000-000000000001', 'en', 1),
  ('e5400000-0000-0000-0000-000000000002', 'e5300000-0000-0000-0000-000000000001', 'ja', 1),
  ('e5400000-0000-0000-0000-000000000003', 'e5300000-0000-0000-0000-000000000002', 'en', 1);

-- Assets and publications, all ready_for_preview. epub_language is what the worker read from the EPUB.
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) values
  ('e5500000-0000-0000-0000-000000000001', 'e5400000-0000-0000-0000-000000000001', 'ep/en1.epub', 1, 'ready_for_preview'),
  ('e5500000-0000-0000-0000-000000000002', 'e5400000-0000-0000-0000-000000000001', 'ep/en2.epub', 2, 'ready_for_preview'),
  ('e5500000-0000-0000-0000-000000000003', 'e5400000-0000-0000-0000-000000000002', 'ep/ja1.epub', 1, 'ready_for_preview'),
  ('e5500000-0000-0000-0000-000000000004', 'e5400000-0000-0000-0000-000000000002', 'ep/ja2.epub', 2, 'ready_for_preview'),
  ('e5500000-0000-0000-0000-000000000005', 'e5400000-0000-0000-0000-000000000002', 'ep/ja3.epub', 3, 'ready_for_preview'),
  ('e5500000-0000-0000-0000-000000000006', 'e5400000-0000-0000-0000-000000000003', 'ep/other1.epub', 1, 'ready_for_preview');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status, epub_language) values
  ('e5600000-0000-0000-0000-000000000001', 'e5500000-0000-0000-0000-000000000001', 1, 'ep/en1.json', 'ready_for_preview', 'en'),
  ('e5600000-0000-0000-0000-000000000002', 'e5500000-0000-0000-0000-000000000002', 2, 'ep/en2.json', 'ready_for_preview', 'en-GB'),
  ('e5600000-0000-0000-0000-000000000003', 'e5500000-0000-0000-0000-000000000003', 1, 'ep/ja1.json', 'ready_for_preview', 'ja'),
  ('e5600000-0000-0000-0000-000000000004', 'e5500000-0000-0000-0000-000000000004', 2, 'ep/ja2.json', 'ready_for_preview', 'ja-JP'),
  ('e5600000-0000-0000-0000-000000000005', 'e5500000-0000-0000-0000-000000000005', 3, 'ep/ja3.json', 'ready_for_preview', 'en'),
  ('e5600000-0000-0000-0000-000000000006', 'e5500000-0000-0000-0000-000000000006', 1, 'ep/other1.json', 'ready_for_preview', null);

-- English progress that must survive everything Japanese does.
insert into public.reading_progress (profile_id, publication_id, locator_json, progression, device_id, client_sequence)
select reader_id, 'e5600000-0000-0000-0000-000000000001', '{"href":"a"}'::jsonb, 0.7, 'd', 1 from t_p;

-- Press: a publication goes live only for an editorially approved edition.
update public.editions set editorial_state = 'approved', reviewed_at = now(),
  reviewed_by = (select id from public.profiles order by created_at limit 1);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e5100000-0000-0000-0000-000000000002', true);

-- (1)-(2) Only admins publish.
select throws_ok($$select public.publish_publication('e5600000-0000-0000-0000-000000000001')$$, '42501', null, 'a non-admin cannot publish');
select throws_ok($$select public.admin_create_edition('e5300000-0000-0000-0000-000000000001', 'fr', null, null, null)$$, '42501', null, 'a non-admin cannot create an edition');

select set_config('request.jwt.claim.sub', 'e5100000-0000-0000-0000-000000000001', true);

-- (3)-(9) Publish English.
select lives_ok($$select public.publish_publication('e5600000-0000-0000-0000-000000000001')$$, 'English v1 publishes');
select is((select active_publication_id from public.editions where id = 'e5400000-0000-0000-0000-000000000001'), 'e5600000-0000-0000-0000-000000000001'::uuid, 'the English edition points at v1');
select is((select status::text from public.editions where id = 'e5400000-0000-0000-0000-000000000001'), 'published', 'the English edition is published');
select is((select status::text from public.ebook_publications where id = 'e5600000-0000-0000-0000-000000000001'), 'published', 'the publication is published');
select is((select edition_id from public.book_language_editions where book_id = 'e5300000-0000-0000-0000-000000000001' and language_code = 'en'), 'e5400000-0000-0000-0000-000000000001'::uuid, 'the first published edition becomes the language default');
select is((select active_publication_id from public.books where id = 'e5300000-0000-0000-0000-000000000001'), 'e5600000-0000-0000-0000-000000000001'::uuid, 'the transitional book pointer follows the first edition');
select is((select status::text from public.editions where id = 'e5400000-0000-0000-0000-000000000002'), 'draft', 'the Japanese edition is untouched');

-- (10)-(15) Publish Japanese: English is not touched.
select lives_ok($$select public.publish_publication('e5600000-0000-0000-0000-000000000003')$$, 'Japanese v1 publishes');
select is((select status::text from public.ebook_publications where id = 'e5600000-0000-0000-0000-000000000001'), 'published', 'English v1 is still published');
select is((select active_publication_id from public.editions where id = 'e5400000-0000-0000-0000-000000000001'), 'e5600000-0000-0000-0000-000000000001'::uuid, 'the English pointer did not move');
select is((select active_publication_id from public.editions where id = 'e5400000-0000-0000-0000-000000000002'), 'e5600000-0000-0000-0000-000000000003'::uuid, 'the Japanese pointer is set');
select is((select active_publication_id from public.books where id = 'e5300000-0000-0000-0000-000000000001'), 'e5600000-0000-0000-0000-000000000001'::uuid, 'the book pointer still names English, not whichever published last');

-- (16)-(19) A new English version supersedes only English.
select lives_ok($$select public.publish_publication('e5600000-0000-0000-0000-000000000002')$$, 'English v2 publishes (en-GB matches en)');
select is((select status::text from public.ebook_publications where id = 'e5600000-0000-0000-0000-000000000001'), 'superseded', 'English v1 is superseded');
select is((select status::text from public.ebook_publications where id = 'e5600000-0000-0000-0000-000000000003'), 'published', 'Japanese v1 stays published');
select is((select active_publication_id from public.books where id = 'e5300000-0000-0000-0000-000000000001'), 'e5600000-0000-0000-0000-000000000002'::uuid, 'the book pointer follows its own edition forward');

-- (20)-(25) Rolling Japanese forward and back leaves English alone.
select lives_ok($$select public.publish_publication('e5600000-0000-0000-0000-000000000004')$$, 'Japanese v2 publishes (ja-JP matches ja)');
select lives_ok($$select public.rollback_publication('e5300000-0000-0000-0000-000000000001', 'e5600000-0000-0000-0000-000000000003')$$, 'Japanese rolls back to v1');
select is((select active_publication_id from public.editions where id = 'e5400000-0000-0000-0000-000000000002'), 'e5600000-0000-0000-0000-000000000003'::uuid, 'the Japanese pointer is back on v1');
select is((select status::text from public.ebook_publications where id = 'e5600000-0000-0000-0000-000000000004'), 'superseded', 'Japanese v2 is superseded by the rollback');
select is((select active_publication_id from public.editions where id = 'e5400000-0000-0000-0000-000000000001'), 'e5600000-0000-0000-0000-000000000002'::uuid, 'the English pointer is unchanged by Japanese rollback');
select is((select status::text from public.ebook_publications where id = 'e5600000-0000-0000-0000-000000000002'), 'published', 'English v2 is still published');

-- (26)-(28) A rollback names the right book, and only superseded publications are eligible.
select throws_ok($$select public.rollback_publication('e5300000-0000-0000-0000-000000000002', 'e5600000-0000-0000-0000-000000000001')$$, 'EB003', null, 'rollback refuses a publication of another book');
select throws_ok($$select public.rollback_publication('e5300000-0000-0000-0000-000000000001', 'e5600000-0000-0000-0000-000000000002')$$, 'EB002', null, 'a published version is not eligible for rollback');
select throws_ok($$select public.publish_publication('e5600000-0000-0000-0000-000000000003')$$, 'EB002', null, 'a published version cannot be published again');

-- (29)-(31) EPUB language readiness.
select throws_ok($$select public.publish_publication('e5600000-0000-0000-0000-000000000005')$$, 'EB012', null, 'a Japanese edition cannot publish an English EPUB');
select throws_ok($$select public.publish_publication('e5600000-0000-0000-0000-000000000006')$$, 'EB012', null, 'an EPUB whose language was never read cannot be verified');
select is((select public.publication_readiness_issues('e5600000-0000-0000-0000-000000000005')), array['epub_language_mismatch'], 'the issue code names the mismatch');
select is((select public.publication_readiness_issues('e5600000-0000-0000-0000-000000000006')), array['epub_language_unverified'], 'and a missing language is its own code');

-- (32)-(35) Edition administration.
select lives_ok($$select public.admin_create_edition('e5300000-0000-0000-0000-000000000001', 'vi', null, null, null)$$, 'an admin adds a Vietnamese edition');
select is((select count(*) from public.editions where book_id = 'e5300000-0000-0000-0000-000000000001' and language_code = 'vi'), 1::bigint, 'the edition exists once');
select is((select count(*) from public.skus s join public.editions e on e.id = s.edition_id where e.book_id = 'e5300000-0000-0000-0000-000000000001' and e.language_code = 'vi'), 1::bigint, 'and gets its ebook SKU');
select throws_ok($$select public.admin_create_edition('e5300000-0000-0000-0000-000000000001', 'vi', 1, null, null)$$, '23505', null, 'the same book, language and edition number cannot repeat');
select throws_ok($$select public.admin_create_edition('e5300000-0000-0000-0000-000000000001', 'xx', null, null, null)$$, '23503', null, 'the language must be a registered content language');

-- (36)-(39) Saving an edition: credits and ISBN freely; identity only while nobody owns it.
select lives_ok(
  $$select public.admin_save_edition((select id from public.editions where book_id = 'e5300000-0000-0000-0000-000000000001' and language_code = 'vi'), null, 1, null, 'A new translation.', '[{"role":"translator","name":"T. Translator"}]'::jsonb, 'vi')$$,
  'an admin saves introduction and credits');
select is((select contributors->0->>'name' from public.editions where book_id = 'e5300000-0000-0000-0000-000000000001' and language_code = 'vi'), 'T. Translator', 'the credit is stored');
select throws_ok(
  $$select public.admin_save_edition('e5400000-0000-0000-0000-000000000001', null, 1, null, null, '{"role":"x"}'::jsonb, 'en')$$,
  '22023', null, 'contributors must be a list');
select lives_ok(
  $$select public.admin_save_edition((select id from public.editions where book_id = 'e5300000-0000-0000-0000-000000000001' and language_code = 'vi'), '9780000000002', 2, '2026-01-01', null, '[]'::jsonb, 'fr')$$,
  'an unsold edition can still be corrected, language included');

-- (40)-(43) The default edition is explicit and must match.
select lives_ok($$select public.admin_set_default_edition('e5300000-0000-0000-0000-000000000001', 'ja', 'e5400000-0000-0000-0000-000000000002')$$, 'an admin names the default Japanese edition');
select throws_ok($$select public.admin_set_default_edition('e5300000-0000-0000-0000-000000000001', 'ja', 'e5400000-0000-0000-0000-000000000001')$$, '23503', null, 'an English edition cannot be the Japanese default');
select throws_ok($$select public.admin_set_default_edition('e5300000-0000-0000-0000-000000000002', 'en', 'e5400000-0000-0000-0000-000000000001')$$, '23503', null, 'another work''s edition cannot be the default');
select is((select count(*) from public.book_language_editions where book_id = 'e5300000-0000-0000-0000-000000000001' and language_code = 'ja'), 1::bigint, 'one default per language');

-- (44)-(48) Offers: a price is required, then it can be made the default.
select throws_ok($$select public.admin_create_offer('e5400000-0000-0000-0000-000000000002', 'JP', 'JPY', null)$$, '22023', null, 'an unset price never becomes a free offer');
select lives_ok($$select public.admin_create_offer('e5400000-0000-0000-0000-000000000002', 'JP', 'JPY', 500)$$, 'an admin creates a JPY offer in minor units');
select is((select price_minor from public.offers o join public.skus s on s.id = o.sku_id where s.edition_id = 'e5400000-0000-0000-0000-000000000002' and o.currency = 'JPY'), 500::bigint, 'the price is stored as given: 500 JPY is 500');
select is((select count(*) from public.edition_default_offers where edition_id = 'e5400000-0000-0000-0000-000000000002'), 1::bigint, 'the first offer becomes the default');
select lives_ok($$select public.admin_create_offer('e5400000-0000-0000-0000-000000000001', 'US', 'USD', 500)$$, 'the English edition gets its own offer');
select throws_ok($$select public.admin_set_default_offer('e5400000-0000-0000-0000-000000000002', (select o.id from public.offers o join public.skus s on s.id = o.sku_id where s.edition_id = 'e5400000-0000-0000-0000-000000000001' limit 1))$$, 'P0002', null, 'another edition''s offer cannot be the default');

-- (a)-(c) A new work's first edition is its language default, with its one offer as the default offer.
select lives_ok($$select public.admin_create_book('ep-created', 'EP Author', 'en', 'ja', 'Created', 'ep-created', 'JP', 'JPY', 500)$$, 'an admin creates a work with a Japanese first edition');
select is((select count(*) from public.book_language_editions bl join public.books b on b.id = bl.book_id where b.canonical_key = 'ep-created' and bl.language_code = 'ja'), 1::bigint, 'the first edition is the Japanese default');
select is((select count(*) from public.edition_default_offers d join public.editions e on e.id = d.edition_id join public.books b on b.id = e.book_id where b.canonical_key = 'ep-created'), 1::bigint, 'and its offer is the default offer');

reset role;

select is((select count(*) from public.reading_progress where publication_id = 'e5600000-0000-0000-0000-000000000001'), 1::bigint, 'English reading progress is untouched by everything above');

-- (49)-(52) Work readiness no longer asks for an offer, but does ask for a published edition.
select is((select public.book_readiness_issues('e5300000-0000-0000-0000-000000000002')), array['missing_localization', 'missing_author', 'missing_cover', 'missing_publication'], 'a work lacking copy, author, cover and a published edition is listed, but never for lacking an offer');
select is((select 'missing_offer' = any (public.book_readiness_issues('e5300000-0000-0000-0000-000000000001'))), false, 'the offer requirement is gone');
select is((select 'missing_publication' = any (public.book_readiness_issues('e5300000-0000-0000-0000-000000000001'))), false, 'a published edition satisfies the publication requirement');
select is((select 'missing_publication' = any (public.book_readiness_issues('e5300000-0000-0000-0000-000000000002'))), true, 'a work with only an unpublished edition still lacks a publication');

select * from finish();
rollback;
