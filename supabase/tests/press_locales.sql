begin;
select plan(30);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'pl-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'pl-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'd1000000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name)
values ('d2000000-0000-0000-0000-000000000001', 'pl-author', 'PL Author');
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values ('d3000000-0000-0000-0000-000000000001', 'pl-book', 'fr', 'd2000000-0000-0000-0000-000000000001', 'draft');

-- (1)-(3) Registries are seeded.
select results_eq(
  $$select code from public.supported_locales where enabled order by code$$,
  $$values ('en'), ('ja'), ('vi')$$,
  'supported_locales seeds vi, en and ja as enabled'
);
select ok(
  (select count(*) = 4 from public.content_languages where code in ('vi', 'en', 'ja', 'fr')),
  'content_languages covers the UI languages plus other source languages such as French'
);
select is(
  (select original_language from public.books where canonical_key = 'pl-book'),
  'fr',
  'a work in French keeps its true original language rather than being forced to a UI locale'
);

-- (4)-(6) Settings: one row, EN defaults, never a second row.
select results_eq(
  $$select default_ui_locale, default_content_language, default_metadata_locale from public.platform_settings$$,
  $$values ('en', 'en', 'en')$$,
  'platform_settings defaults every language to English'
);
select throws_ok(
  $$insert into public.platform_settings (singleton) values (false)$$,
  '23514',
  null,
  'platform_settings accepts no second row'
);
select is(public.is_supported_locale('ja'), true, 'is_supported_locale accepts ja');

-- (7)-(9) Anonymous visitors read the registries but write nothing.
set local role anon;
select is((select count(*) from public.supported_locales), 3::bigint, 'anon reads supported_locales');
select throws_ok(
  $$insert into public.supported_locales (code, native_name) values ('fr', 'Français')$$,
  '42501',
  null,
  'anon cannot add a locale'
);
select throws_ok(
  $$select count(*) from public.edition_pricing_defaults$$,
  '42501',
  null,
  'anon cannot read pricing defaults'
);
reset role;

-- (10)-(12) The locale CHECKs became a foreign key to the registry.
select lives_ok(
  $$insert into public.book_localizations (book_id, locale, slug, title) values ('d3000000-0000-0000-0000-000000000001', 'ja', 'pl-book-ja', 'PL本')$$,
  'a ja localization is accepted'
);
select throws_ok(
  $$insert into public.book_localizations (book_id, locale, slug, title) values ('d3000000-0000-0000-0000-000000000001', 'xx', 'pl-book-xx', 'PL xx')$$,
  '23503',
  null,
  'an unregistered locale is rejected by the foreign key'
);
select lives_ok(
  $$update public.profiles set locale = 'ja' where auth_user_id = 'd1000000-0000-0000-0000-000000000002'$$,
  'a profile can prefer ja'
);

-- (13)-(14) A disabled locale stays out of is_supported_locale.
update public.supported_locales set enabled = false where code = 'ja';
select is(public.is_supported_locale('ja'), false, 'a disabled locale is not supported for new writes');
update public.supported_locales set enabled = true where code = 'ja';
select is(public.is_supported_locale(null), false, 'null is not a supported locale');

-- (15)-(21) admin RPC allowlists follow the registry.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$select public.admin_save_platform_settings('ja', 'en', 'en')$$,
  '42501',
  null,
  'a non-admin cannot change platform settings'
);
select throws_ok(
  $$select public.admin_save_book_localization('d3000000-0000-0000-0000-000000000001', 'ja', 'x', 'x', null, null, null, null, null, null, null, null)$$,
  '42501',
  null,
  'a non-admin cannot save a ja book localization'
);
select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select public.admin_save_book_localization('d3000000-0000-0000-0000-000000000001', 'ja', 'pl-book-ja', 'PL本2', null, null, null, null, null, null, null, null)$$,
  'admin_save_book_localization accepts ja'
);
select throws_ok(
  $$select public.admin_save_book_localization('d3000000-0000-0000-0000-000000000001', 'xx', 'pl-book-xx', 'x', null, null, null, null, null, null, null, null)$$,
  '22023',
  null,
  'admin_save_book_localization still rejects an unregistered locale'
);
select lives_ok(
  $$select public.admin_save_platform_settings('ja', 'ja', 'en')$$,
  'an admin can change the default UI locale and content language'
);
select throws_ok(
  $$select public.admin_save_platform_settings('xx', 'en', 'en')$$,
  '22023',
  null,
  'platform settings reject an unregistered UI locale'
);
select throws_ok(
  $$select public.admin_save_platform_settings('en', 'xx', 'en')$$,
  '22023',
  null,
  'platform settings reject an unregistered content language'
);
reset role;

-- (22)-(23) The change is audited.
select is(
  (select count(*) from public.audit_logs where action = 'save_platform_settings'),
  1::bigint,
  'a settings change writes one audit row'
);
select is(
  (select metadata->>'default_ui_locale' from public.audit_logs where action = 'save_platform_settings'),
  'ja',
  'the audit row names the new default'
);

-- (24)-(27) Alternates: every other published localization is named, not just one.
insert into public.ideas (id, status) values ('d4000000-0000-0000-0000-000000000001', 'published');
insert into public.idea_localizations (idea_id, locale, slug, question, short_answer)
values
  ('d4000000-0000-0000-0000-000000000001', 'vi', 'pl-y-tuong', 'Câu hỏi?', 'Trả lời ngắn'),
  ('d4000000-0000-0000-0000-000000000001', 'en', 'pl-idea-en', 'Question?', 'Short answer'),
  ('d4000000-0000-0000-0000-000000000001', 'ja', 'pl-idea-ja', '質問？', '短い答え');
select is(
  public.knowledge_idea_page('en', 'pl-idea-en')->'alternateSlugs',
  '{"vi": "pl-y-tuong", "ja": "pl-idea-ja"}'::jsonb,
  'idea page names the alternate slug for every other locale'
);
select is(
  public.knowledge_idea_page('en', 'pl-idea-en')->'alternateSlugs'->'en',
  null,
  'idea page never lists its own locale as an alternate'
);
select is(
  (public.knowledge_idea_page('ja', 'pl-idea-ja')->>'question'),
  '質問？',
  'idea page resolves a ja slug'
);
update public.idea_localizations set slug = 'pl-idea-ja' where idea_id = 'd4000000-0000-0000-0000-000000000001' and locale = 'ja';
select is(
  (public.knowledge_idea_page('ja', 'pl-idea-en')),
  null,
  'a slug from another locale does not resolve in this locale'
);

-- (28)-(30) Edition pricing defaults are admin-only reference data keyed by language and market.
select throws_ok(
  $$insert into public.edition_pricing_defaults (language_code, market_code, currency, price_minor) values ('ja', 'JP', 'jpy', 500)$$,
  '23514',
  null,
  'currency must be an upper-case ISO code'
);
select lives_ok(
  $$insert into public.edition_pricing_defaults (language_code, market_code, currency, price_minor) values ('ja', 'JP', 'JPY', 500)$$,
  'a JPY default is stored in minor units'
);
select throws_ok(
  $$insert into public.edition_pricing_defaults (language_code, market_code, currency, price_minor) values ('ja', 'JP', 'JPY', 600)$$,
  '23505',
  null,
  'language and market identify one default'
);

select * from finish();
rollback;
