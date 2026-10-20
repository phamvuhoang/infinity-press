-- Infinity Books Press, Task 2: registry-driven locales and content languages.
--
-- Three independent concepts (spec section 5): the UI locale (supported_locales), the language a
-- work or edition is written in (content_languages), and the currency of an offer. The two
-- locale-like registries are separate on purpose: a French original is neither vi, en nor ja.
--
-- Every 'vi'/'en' CHECK on a localization table becomes a foreign key to supported_locales, and
-- every RPC allowlist asks is_supported_locale() instead of naming two codes.

create table public.supported_locales (
  code text primary key check (code ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  native_name text not null check (btrim(native_name) <> ''),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.supported_locales (code, native_name) values
  ('vi', 'Tiếng Việt'), ('en', 'English'), ('ja', '日本語');

create table public.content_languages (
  code text primary key check (code ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  name text not null check (btrim(name) <> '')
);
insert into public.content_languages (code, name) values
  ('vi', 'Vietnamese'), ('en', 'English'), ('ja', 'Japanese'), ('fr', 'French'), ('de', 'German'),
  ('es', 'Spanish'), ('it', 'Italian'), ('pt', 'Portuguese'), ('ru', 'Russian'), ('zh', 'Chinese'),
  ('ko', 'Korean'), ('la', 'Latin'), ('el', 'Greek'), ('nl', 'Dutch');
-- A language already used by a work or edition stays valid after this migration, whatever it is.
insert into public.content_languages (code, name)
select code, code from (
  select original_language as code from public.books
  union select language_code from public.editions
) existing
where code is not null
on conflict do nothing;

create table public.platform_settings (
  singleton boolean primary key default true check (singleton),
  default_ui_locale text not null default 'en' references public.supported_locales (code),
  default_content_language text not null default 'en' references public.content_languages (code),
  default_metadata_locale text not null default 'en' references public.supported_locales (code),
  updated_at timestamptz not null default now()
);
insert into public.platform_settings (singleton) values (true);

-- Admin-entered template for new offers. It prefills; it never changes an existing offer. No row is
-- seeded: an edition without an offer is not for sale (spec section 6).
create table public.edition_pricing_defaults (
  language_code text not null references public.content_languages (code),
  market_code text not null check (market_code ~ '^[A-Z]{2}$'),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  price_minor bigint not null check (price_minor >= 0),
  primary key (language_code, market_code)
);

alter table public.supported_locales enable row level security;
alter table public.content_languages enable row level security;
alter table public.platform_settings enable row level security;
alter table public.edition_pricing_defaults enable row level security;

-- The registries and the settings hold nothing private; the pages need them to pick a locale.
create policy "public reads supported locales" on public.supported_locales
  for select to anon, authenticated using (true);
create policy "public reads content languages" on public.content_languages
  for select to anon, authenticated using (true);
create policy "public reads platform settings" on public.platform_settings
  for select to anon, authenticated using (true);
create policy "admin reads pricing defaults" on public.edition_pricing_defaults
  for select to authenticated using ((select public.is_admin()));
create policy "admin writes pricing defaults" on public.edition_pricing_defaults
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- Writes to the locale registries and settings go through the RPC below (or a migration), never
-- directly from a client role.
revoke insert, update, delete on public.supported_locales, public.content_languages,
  public.platform_settings from anon, authenticated;
revoke all on public.edition_pricing_defaults from anon;

create function public.is_supported_locale(p_locale text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select l.enabled from public.supported_locales l where l.code = p_locale), false);
$$;
revoke all on function public.is_supported_locale(text) from public;
grant execute on function public.is_supported_locale(text) to anon, authenticated, service_role;

create function public.admin_save_platform_settings(
  p_default_ui_locale text,
  p_default_content_language text,
  p_default_metadata_locale text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_save_platform_settings: caller is not an admin' using errcode = '42501';
  end if;
  if not public.is_supported_locale(p_default_ui_locale)
     or not public.is_supported_locale(p_default_metadata_locale) then
    raise exception 'admin_save_platform_settings: unsupported locale' using errcode = '22023';
  end if;
  if not exists (select 1 from public.content_languages where code = p_default_content_language) then
    raise exception 'admin_save_platform_settings: unknown content language %', p_default_content_language using errcode = '22023';
  end if;

  update public.platform_settings
  set default_ui_locale = p_default_ui_locale,
      default_content_language = p_default_content_language,
      default_metadata_locale = p_default_metadata_locale,
      updated_at = now()
  where singleton;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'save_platform_settings', 'platform_settings', null,
          jsonb_build_object(
            'default_ui_locale', p_default_ui_locale,
            'default_content_language', p_default_content_language,
            'default_metadata_locale', p_default_metadata_locale));
end;
$$;
revoke all on function public.admin_save_platform_settings(text, text, text) from public, anon;
grant execute on function public.admin_save_platform_settings(text, text, text) to authenticated, service_role;

-- Locale CHECK -> foreign key. Existing rows are all vi/en, which the seed above contains.
alter table public.analytics_events drop constraint analytics_events_locale_check;
alter table public.analytics_events add constraint analytics_events_locale_fkey
  foreign key (locale) references public.supported_locales (code);
alter table public.article_localizations drop constraint article_localizations_locale_check;
alter table public.article_localizations add constraint article_localizations_locale_fkey
  foreign key (locale) references public.supported_locales (code);
alter table public.author_localizations drop constraint author_localizations_locale_check;
alter table public.author_localizations add constraint author_localizations_locale_fkey
  foreign key (locale) references public.supported_locales (code);
alter table public.book_localizations drop constraint book_localizations_locale_check;
alter table public.book_localizations add constraint book_localizations_locale_fkey
  foreign key (locale) references public.supported_locales (code);
alter table public.book_reviews drop constraint book_reviews_locale_check;
alter table public.book_reviews add constraint book_reviews_locale_fkey
  foreign key (locale) references public.supported_locales (code);
alter table public.bundle_localizations drop constraint bundle_localizations_locale_check;
alter table public.bundle_localizations add constraint bundle_localizations_locale_fkey
  foreign key (locale) references public.supported_locales (code);
alter table public.idea_localizations drop constraint idea_localizations_locale_check;
alter table public.idea_localizations add constraint idea_localizations_locale_fkey
  foreign key (locale) references public.supported_locales (code);
alter table public.profiles drop constraint profiles_locale_check;
alter table public.profiles add constraint profiles_locale_fkey
  foreign key (locale) references public.supported_locales (code);
alter table public.profiles alter column locale set default 'en';
alter table public.reader_questions drop constraint reader_questions_locale_check;
alter table public.reader_questions add constraint reader_questions_locale_fkey
  foreign key (locale) references public.supported_locales (code);
alter table public.series_localizations drop constraint series_localizations_locale_check;
alter table public.series_localizations add constraint series_localizations_locale_fkey
  foreign key (locale) references public.supported_locales (code);
alter table public.shared_quotes drop constraint shared_quotes_locale_check;
alter table public.shared_quotes add constraint shared_quotes_locale_fkey
  foreign key (locale) references public.supported_locales (code);
alter table public.topic_localizations drop constraint topic_localizations_locale_check;
alter table public.topic_localizations add constraint topic_localizations_locale_fkey
  foreign key (locale) references public.supported_locales (code);

-- Content language: a registry FK instead of free text.
alter table public.books add constraint books_original_language_fkey
  foreign key (original_language) references public.content_languages (code);
alter table public.editions add constraint editions_language_code_fkey
  foreign key (language_code) references public.content_languages (code);

-- RPC allowlists: ask the registry instead of naming two locales.
CREATE OR REPLACE FUNCTION public.admin_create_article(p_author_id uuid, p_locale text, p_slug text, p_title text, p_excerpt text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_article_id uuid;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_create_article: caller is not an admin' using errcode = '42501';
  end if;
  if p_locale is null or not public.is_supported_locale(p_locale) then
    raise exception 'admin_create_article: unsupported locale %', p_locale using errcode = '22023';
  end if;
  if not exists (select 1 from public.authors a where a.id = p_author_id) then
    raise exception 'admin_create_article: author % does not exist', p_author_id using errcode = 'P0002';
  end if;

  insert into public.articles (author_id) values (p_author_id) returning id into v_article_id;
  insert into public.article_localizations (article_id, locale, slug, title, excerpt)
  values (v_article_id, p_locale, p_slug, p_title, p_excerpt);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'create_article', 'articles', v_article_id,
          jsonb_build_object('author_id', p_author_id, 'locale', p_locale, 'slug', p_slug));

  return v_article_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_create_bundle(p_locale text, p_slug text, p_title text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_bundle_id uuid;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_create_bundle: caller is not an admin' using errcode = '42501';
  end if;
  if not public.is_supported_locale(p_locale) then
    raise exception 'admin_create_bundle: unsupported locale %', p_locale using errcode = '22023';
  end if;

  insert into public.bundles default values returning id into v_bundle_id;
  insert into public.bundle_localizations (bundle_id, locale, slug, title)
  values (v_bundle_id, p_locale, p_slug, p_title);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'create_bundle', 'bundles', v_bundle_id,
          jsonb_build_object('locale', p_locale, 'slug', p_slug));

  return v_bundle_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_create_idea(p_locale text, p_slug text, p_question text, p_short_answer text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_idea_id uuid;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_create_idea: caller is not an admin' using errcode = '42501';
  end if;
  if p_locale is null or not public.is_supported_locale(p_locale) then
    raise exception 'admin_create_idea: unsupported locale %', p_locale using errcode = '22023';
  end if;

  insert into public.ideas default values returning id into v_idea_id;
  insert into public.idea_localizations (idea_id, locale, slug, question, short_answer)
  values (v_idea_id, p_locale, p_slug, p_question, p_short_answer);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'create_idea', 'ideas', v_idea_id,
          jsonb_build_object('locale', p_locale, 'slug', p_slug));

  return v_idea_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_save_article_localization(p_article_id uuid, p_locale text, p_slug text, p_title text, p_excerpt text, p_body_blocks jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_article_status public.content_status;
  v_localization_id uuid;
  v_old_slug text;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_save_article_localization: caller is not an admin' using errcode = '42501';
  end if;
  if p_locale is null or not public.is_supported_locale(p_locale) then
    raise exception 'admin_save_article_localization: unsupported locale %', p_locale using errcode = '22023';
  end if;
  perform public.knowledge_check_body_blocks('admin_save_article_localization', p_body_blocks);

  select status into v_article_status from public.articles where id = p_article_id for update;
  if v_article_status is null then
    raise exception 'admin_save_article_localization: article % does not exist', p_article_id using errcode = 'P0002';
  end if;

  select id, slug into v_localization_id, v_old_slug
  from public.article_localizations
  where article_id = p_article_id and locale = p_locale
  for update;

  if v_localization_id is null then
    insert into public.article_localizations (article_id, locale, slug, title, excerpt, body_blocks)
    values (p_article_id, p_locale, p_slug, p_title, p_excerpt, p_body_blocks)
    returning id into v_localization_id;
  else
    update public.article_localizations
    set slug = p_slug, title = p_title, excerpt = p_excerpt, body_blocks = p_body_blocks
    where id = v_localization_id;

    if v_article_status = 'published' and v_old_slug <> p_slug then
      perform public.record_slug_redirect(
        format('/%s/articles/%s', p_locale, v_old_slug),
        format('/%s/articles/%s', p_locale, p_slug)
      );
    end if;
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'save_article_localization', 'articles', p_article_id,
          jsonb_build_object('locale', p_locale, 'slug_from', v_old_slug, 'slug_to', p_slug,
                             'block_count', jsonb_array_length(p_body_blocks)));

  return v_localization_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_save_article_seo(p_article_id uuid, p_locale text, p_seo_title text, p_seo_description text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_save_article_seo: caller is not an admin' using errcode = '42501';
  end if;
  if p_locale is null or not public.is_supported_locale(p_locale) then
    raise exception 'admin_save_article_seo: unsupported locale %', p_locale using errcode = '22023';
  end if;

  perform 1 from public.articles where id = p_article_id for update;
  if not found then
    raise exception 'admin_save_article_seo: article % does not exist', p_article_id using errcode = 'P0002';
  end if;

  update public.article_localizations
  set seo_title = nullif(trim(p_seo_title), ''), seo_description = nullif(trim(p_seo_description), '')
  where article_id = p_article_id and locale = p_locale;
  if not found then
    raise exception 'admin_save_article_seo: article % has no % localization', p_article_id, p_locale using errcode = 'P0002';
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'save_article_seo', 'articles', p_article_id, jsonb_build_object('locale', p_locale));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_save_book_localization(p_book_id uuid, p_locale text, p_slug text, p_title text, p_subtitle text, p_short_description text, p_description text, p_audience text, p_key_ideas jsonb, p_faq jsonb, p_seo_title text, p_seo_description text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_book_status public.content_status;
  v_localization_id uuid;
  v_old_slug text;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_save_book_localization: caller is not an admin' using errcode = '42501';
  end if;
  if not public.is_supported_locale(p_locale) then
    raise exception 'admin_save_book_localization: unsupported locale %', p_locale using errcode = '22023';
  end if;

  select status into v_book_status from public.books where id = p_book_id for update;
  if v_book_status is null then
    raise exception 'admin_save_book_localization: book % does not exist', p_book_id using errcode = 'P0002';
  end if;

  select id, slug into v_localization_id, v_old_slug
  from public.book_localizations
  where book_id = p_book_id and locale = p_locale
  for update;

  if v_localization_id is null then
    insert into public.book_localizations (
      book_id, locale, slug, title, subtitle, short_description, description,
      audience, key_ideas, faq, seo_title, seo_description
    )
    values (
      p_book_id, p_locale, p_slug, p_title, p_subtitle, p_short_description, p_description,
      p_audience, coalesce(p_key_ideas, '[]'::jsonb), coalesce(p_faq, '[]'::jsonb), p_seo_title, p_seo_description
    )
    returning id into v_localization_id;
  else
    update public.book_localizations
    set slug = p_slug,
        title = p_title,
        subtitle = p_subtitle,
        short_description = p_short_description,
        description = p_description,
        audience = p_audience,
        key_ideas = coalesce(p_key_ideas, '[]'::jsonb),
        faq = coalesce(p_faq, '[]'::jsonb),
        seo_title = p_seo_title,
        seo_description = p_seo_description
    where id = v_localization_id;

    if v_book_status = 'published' and v_old_slug <> p_slug then
      perform public.record_slug_redirect(
        format('/%s/books/%s', p_locale, v_old_slug),
        format('/%s/books/%s', p_locale, p_slug)
      );
    end if;
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'save_book_localization', 'books', p_book_id,
          jsonb_build_object('locale', p_locale, 'slug_from', v_old_slug, 'slug_to', p_slug));

  return v_localization_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_save_bundle_localization(p_bundle_id uuid, p_locale text, p_slug text, p_title text, p_subtitle text, p_description text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_bundle_status public.content_status;
  v_localization_id uuid;
  v_old_slug text;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_save_bundle_localization: caller is not an admin' using errcode = '42501';
  end if;
  if not public.is_supported_locale(p_locale) then
    raise exception 'admin_save_bundle_localization: unsupported locale %', p_locale using errcode = '22023';
  end if;

  select status into v_bundle_status from public.bundles where id = p_bundle_id for update;
  if v_bundle_status is null then
    raise exception 'admin_save_bundle_localization: bundle % does not exist', p_bundle_id using errcode = 'P0002';
  end if;

  select id, slug into v_localization_id, v_old_slug
  from public.bundle_localizations
  where bundle_id = p_bundle_id and locale = p_locale
  for update;

  if v_localization_id is null then
    insert into public.bundle_localizations (bundle_id, locale, slug, title, subtitle, description)
    values (p_bundle_id, p_locale, p_slug, p_title, p_subtitle, p_description)
    returning id into v_localization_id;
  else
    update public.bundle_localizations
    set slug = p_slug, title = p_title, subtitle = p_subtitle, description = p_description
    where id = v_localization_id;

    -- record_slug_redirect (20260913110000) is what keeps a -> b -> c collapsed to a -> c and
    -- b -> c rather than chained; nothing here needs to know the rename history.
    if v_bundle_status = 'published' and v_old_slug <> p_slug then
      perform public.record_slug_redirect(
        format('/%s/bundles/%s', p_locale, v_old_slug),
        format('/%s/bundles/%s', p_locale, p_slug)
      );
    end if;
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'save_bundle_localization', 'bundles', p_bundle_id,
          jsonb_build_object('locale', p_locale, 'slug_from', v_old_slug, 'slug_to', p_slug));

  return v_localization_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_save_entity_localization(p_entity_type text, p_entity_id uuid, p_locale text, p_slug text, p_name text, p_description text, p_quote text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_base_table text;
  v_localization_table text;
  v_foreign_key text;
  v_path_segment text;
  v_status text;
  v_localization_id uuid;
  v_old_slug text;
  v_actor_profile_id uuid;
  v_quote text;
begin
  if not public.is_admin() then
    raise exception 'admin_save_entity_localization: caller is not an admin' using errcode = '42501';
  end if;

  case p_entity_type
    when 'author' then
      v_base_table := 'authors'; v_localization_table := 'author_localizations'; v_foreign_key := 'author_id'; v_path_segment := 'authors';
    when 'topic' then
      v_base_table := 'topics'; v_localization_table := 'topic_localizations'; v_foreign_key := 'topic_id'; v_path_segment := 'topics';
    when 'series' then
      v_base_table := 'series'; v_localization_table := 'series_localizations'; v_foreign_key := 'series_id'; v_path_segment := 'series';
    else
      raise exception 'admin_save_entity_localization: unknown entity type %', p_entity_type using errcode = '22023';
  end case;

  -- Only authors carry a quote. A quote sent for another type is dropped rather than rejected, so
  -- one shared admin form can post the same field set for every type.
  v_quote := case when p_entity_type = 'author' then nullif(trim(coalesce(p_quote, '')), '') else null end;

  if not public.is_supported_locale(p_locale) then
    raise exception 'admin_save_entity_localization: unsupported locale %', p_locale using errcode = '22023';
  end if;

  execute format('select status::text from public.%I where id = $1 for update', v_base_table)
    into v_status using p_entity_id;
  if v_status is null then
    raise exception 'admin_save_entity_localization: % % does not exist', p_entity_type, p_entity_id using errcode = 'P0002';
  end if;

  execute format('select id, slug from public.%I where %I = $1 and locale = $2 for update', v_localization_table, v_foreign_key)
    into v_localization_id, v_old_slug using p_entity_id, p_locale;

  if v_localization_id is null then
    if p_entity_type = 'author' then
      insert into public.author_localizations (author_id, locale, slug, name, description, quote)
      values (p_entity_id, p_locale, p_slug, p_name, p_description, v_quote)
      returning id into v_localization_id;
    else
      execute format(
        'insert into public.%I (%I, locale, slug, name, description) values ($1, $2, $3, $4, $5) returning id',
        v_localization_table, v_foreign_key
      ) into v_localization_id using p_entity_id, p_locale, p_slug, p_name, p_description;
    end if;
  else
    if p_entity_type = 'author' then
      update public.author_localizations
      set slug = p_slug, name = p_name, description = p_description, quote = v_quote
      where id = v_localization_id;
    else
      execute format('update public.%I set slug = $1, name = $2, description = $3 where id = $4', v_localization_table)
        using p_slug, p_name, p_description, v_localization_id;
    end if;

    if v_status = 'published' and v_old_slug <> p_slug then
      perform public.record_slug_redirect(
        format('/%s/%s/%s', p_locale, v_path_segment, v_old_slug),
        format('/%s/%s/%s', p_locale, v_path_segment, p_slug)
      );
    end if;
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'save_' || p_entity_type || '_localization', v_base_table, p_entity_id,
          jsonb_build_object('locale', p_locale, 'slug_from', v_old_slug, 'slug_to', p_slug));

  return v_localization_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_save_idea_localization(p_idea_id uuid, p_locale text, p_slug text, p_question text, p_short_answer text, p_body_blocks jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_idea_status public.content_status;
  v_localization_id uuid;
  v_old_slug text;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_save_idea_localization: caller is not an admin' using errcode = '42501';
  end if;
  if p_locale is null or not public.is_supported_locale(p_locale) then
    raise exception 'admin_save_idea_localization: unsupported locale %', p_locale using errcode = '22023';
  end if;
  perform public.knowledge_check_body_blocks('admin_save_idea_localization', p_body_blocks);

  select status into v_idea_status from public.ideas where id = p_idea_id for update;
  if v_idea_status is null then
    raise exception 'admin_save_idea_localization: idea % does not exist', p_idea_id using errcode = 'P0002';
  end if;

  select id, slug into v_localization_id, v_old_slug
  from public.idea_localizations
  where idea_id = p_idea_id and locale = p_locale
  for update;

  if v_localization_id is null then
    insert into public.idea_localizations (idea_id, locale, slug, question, short_answer, body_blocks)
    values (p_idea_id, p_locale, p_slug, p_question, p_short_answer, p_body_blocks)
    returning id into v_localization_id;
  else
    update public.idea_localizations
    set slug = p_slug, question = p_question, short_answer = p_short_answer, body_blocks = p_body_blocks
    where id = v_localization_id;

    if v_idea_status = 'published' and v_old_slug <> p_slug then
      perform public.record_slug_redirect(
        format('/%s/ideas/%s', p_locale, v_old_slug),
        format('/%s/ideas/%s', p_locale, p_slug)
      );
    end if;
  end if;

  -- The idea's own updated_at is what the sitemap reports; a content edit is an edit of the idea.
  update public.ideas set updated_at = now() where id = p_idea_id;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'save_idea_localization', 'ideas', p_idea_id,
          jsonb_build_object('locale', p_locale, 'slug_from', v_old_slug, 'slug_to', p_slug,
                             'block_count', jsonb_array_length(p_body_blocks)));

  return v_localization_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_save_idea_seo(p_idea_id uuid, p_locale text, p_seo_title text, p_seo_description text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_save_idea_seo: caller is not an admin' using errcode = '42501';
  end if;
  if p_locale is null or not public.is_supported_locale(p_locale) then
    raise exception 'admin_save_idea_seo: unsupported locale %', p_locale using errcode = '22023';
  end if;

  update public.ideas set updated_at = now() where id = p_idea_id;
  if not found then
    raise exception 'admin_save_idea_seo: idea % does not exist', p_idea_id using errcode = 'P0002';
  end if;

  update public.idea_localizations
  set seo_title = nullif(trim(p_seo_title), ''), seo_description = nullif(trim(p_seo_description), '')
  where idea_id = p_idea_id and locale = p_locale;
  if not found then
    raise exception 'admin_save_idea_seo: idea % has no % localization', p_idea_id, p_locale using errcode = 'P0002';
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'save_idea_seo', 'ideas', p_idea_id, jsonb_build_object('locale', p_locale));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.create_shared_quote(p_publication_id uuid, p_quote text, p_locale text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_profile_id uuid;
  v_book_id uuid;
  v_quote text := btrim(coalesce(p_quote, ''));
  v_code text;
  v_row public.shared_quotes;
  v_try integer := 0;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'create_shared_quote: no profile' using errcode = 'EB039';
  end if;
  if length(v_quote) < 1 or length(v_quote) > 1200 or v_quote ~* '</?[a-z][^>]*>'
     or public.shared_quote_graphemes(v_quote) > 300
     or p_locale is null or not public.is_supported_locale(p_locale) then
    raise exception 'create_shared_quote: invalid input' using errcode = 'EB039';
  end if;
  -- The publication must be the book's active, published one, and the caller must hold the book.
  -- A publication reaches its book through its asset's edition; there is no book_id on it.
  select b.id into v_book_id
  from public.ebook_publications pub
  join public.ebook_assets a on a.id = pub.ebook_asset_id
  join public.editions ed on ed.id = a.edition_id
  join public.books b on b.id = ed.book_id and b.active_publication_id = pub.id and b.status = 'published'
  where pub.id = p_publication_id and pub.status = 'published'
    and exists (select 1 from public.entitlements en
                where en.profile_id = v_profile_id and en.book_id = b.id and en.status = 'active');
  if v_book_id is null then
    raise exception 'create_shared_quote: not entitled' using errcode = 'EB039';
  end if;
  -- Lock the profile so two concurrent shares at the cap cannot both pass the count.
  perform 1 from public.profiles where id = v_profile_id for update;
  if (select count(*) from public.shared_quotes where profile_id = v_profile_id and status = 'active') >= 200 then
    raise exception 'create_shared_quote: cap reached' using errcode = 'EB038';
  end if;
  loop
    v_try := v_try + 1;
    v_code := substr(translate(encode(extensions.gen_random_bytes(8), 'base64'), '+/', '-_'), 1, 10);
    begin
      insert into public.shared_quotes (code, book_id, publication_id, profile_id, quote, locale)
      values (v_code, v_book_id, p_publication_id, v_profile_id, v_quote, p_locale)
      returning * into v_row;
      exit;
    exception when unique_violation then
      if v_try >= 3 then raise exception 'create_shared_quote: code collision' using errcode = 'EB039'; end if;
    end;
  end loop;
  insert into public.analytics_events (event_name, dedupe_key, profile_id, book_id, locale, shared_quote_id)
  values ('share_quote', 'share/' || v_row.id, v_profile_id, v_book_id, p_locale, v_row.id);
  return public.shared_quote_json(v_row);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.search_catalog(p_locale text, p_query text)
 RETURNS TABLE(kind text, slug text, name text, score integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_trimmed text := btrim(coalesce(p_query, ''));
  v_query text;
begin
  if not public.is_supported_locale(p_locale) or char_length(v_trimmed) < 2 or char_length(v_trimmed) > 100 then
    return;
  end if;
  v_query := public.catalog_normalize(v_trimmed);

  return query
  with scored as (
    select
      'book'::text as kind,
      bl.slug,
      bl.title as name,
      greatest(
        public.catalog_match_score(bl.title, v_query),
        -- Only a published author lifts their books, the same gate as catalog_book_cards.
        case
          when a.status = 'published' and public.catalog_normalize(coalesce(al.name, a.display_name)) = v_query then 3
          else 0
        end
      ) as score
    from public.books b
    join public.book_localizations bl on bl.book_id = b.id and bl.locale = p_locale
    join public.authors a on a.id = b.primary_author_id
    left join public.author_localizations al on al.author_id = a.id and al.locale = p_locale
    where b.status = 'published'

    union all

    select 'author'::text, l.slug, l.name, public.catalog_match_score(l.name, v_query)
    from public.author_localizations l
    join public.authors a on a.id = l.author_id
    where l.locale = p_locale
      and a.status = 'published'
      and public.catalog_has_visible_book('author', a.id, p_locale)

    union all

    select 'series'::text, l.slug, l.name, public.catalog_match_score(l.name, v_query)
    from public.series_localizations l
    join public.series s on s.id = l.series_id
    where l.locale = p_locale
      and s.status = 'published'
      and public.catalog_has_visible_book('series', s.id, p_locale)

    union all

    select 'topic'::text, l.slug, l.name, public.catalog_match_score(l.name, v_query)
    from public.topic_localizations l
    join public.topics t on t.id = l.topic_id
    where l.locale = p_locale
      and t.status = 'published'
      and public.catalog_has_visible_book('topic', t.id, p_locale)

    union all

    select
      'idea'::text,
      l.slug,
      l.question,
      greatest(public.catalog_match_score(l.question, v_query), public.catalog_match_score(l.short_answer, v_query))
    from public.idea_localizations l
    join public.ideas i on i.id = l.idea_id
    where l.locale = p_locale
      and i.status = 'published'

    union all

    select
      'article'::text,
      l.slug,
      l.title,
      greatest(public.catalog_match_score(l.title, v_query), public.catalog_match_score(l.excerpt, v_query))
    from public.article_localizations l
    join public.articles a on a.id = l.article_id
    where l.locale = p_locale
      and a.status = 'published'
  ),
  ranked as (
    select
      s.kind,
      s.slug,
      s.name,
      s.score,
      row_number() over (partition by s.kind order by s.score desc, s.name) as kind_rank
    from scored s
    where s.score > 0
  )
  select r.kind, r.slug, r.name, r.score
  from ranked r
  where r.kind_rank <= 20
  order by r.score desc, r.kind, r.name;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.submit_book_review(p_book_id uuid, p_rating integer, p_body text, p_locale text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_profile_id uuid;
  v_reviewer_name text;
  v_row public.book_reviews;
begin
  select p.id, left(nullif(btrim(p.display_name), ''), 80) into v_profile_id, v_reviewer_name
  from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'submit_book_review: no profile for the current session' using errcode = 'P0002';
  end if;
  if v_reviewer_name ~* '</?[a-z][^>]*>' then
    v_reviewer_name := null;
  end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'submit_book_review: rating must be 1..5' using errcode = '22023';
  end if;
  if p_body is null or length(btrim(p_body)) < 1 or length(btrim(p_body)) > 1000 or p_body ~* '</?[a-z][^>]*>' then
    raise exception 'submit_book_review: body must be 1..1000 characters of plain text' using errcode = '22023';
  end if;
  if p_locale is null or not public.is_supported_locale(p_locale) then
    raise exception 'submit_book_review: unsupported locale' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.entitlements en
    where en.profile_id = v_profile_id and en.book_id = p_book_id and en.status = 'active'
  ) then
    raise exception 'submit_book_review: the caller holds no active entitlement for book %', p_book_id using errcode = 'EB034';
  end if;

  insert into public.book_reviews (book_id, profile_id, rating, body, locale, reviewer_name)
  values (p_book_id, v_profile_id, p_rating, btrim(p_body), p_locale, v_reviewer_name)
  on conflict (book_id, profile_id) do update
    set rating = excluded.rating, body = excluded.body, locale = excluded.locale,
        reviewer_name = excluded.reviewer_name,
        status = 'pending', published_at = null
  returning * into v_row;
  return public.book_review_json(v_row);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.submit_reader_question(p_book_id uuid, p_idea_id uuid, p_body text, p_locale text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_profile_id uuid; v_id uuid;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'submit_reader_question: no profile for the current session' using errcode = 'P0002';
  end if;
  if p_book_id is null and p_idea_id is null then
    raise exception 'submit_reader_question: a question needs a book or an idea' using errcode = '22023';
  end if;
  if p_body is null or length(btrim(p_body)) < 1 or length(btrim(p_body)) > 500 or p_body ~* '</?[a-z][^>]*>' then
    raise exception 'submit_reader_question: body must be 1..500 characters of plain text' using errcode = '22023';
  end if;
  if p_locale is null or not public.is_supported_locale(p_locale) then
    raise exception 'submit_reader_question: unsupported locale' using errcode = '22023';
  end if;
  if p_book_id is not null and not public.catalog_book_accepts_questions(p_book_id) then
    raise exception 'submit_reader_question: book % is not published or does not take questions', p_book_id using errcode = 'P0002';
  end if;
  if p_idea_id is not null and not exists (select 1 from public.ideas i where i.id = p_idea_id and i.status = 'published') then
    raise exception 'submit_reader_question: idea % is not published', p_idea_id using errcode = 'P0002';
  end if;
  -- Lock the profile row so two concurrent submits cannot both pass the cap.
  perform 1 from public.profiles where id = v_profile_id for update;
  if (select count(*) from public.reader_questions q where q.profile_id = v_profile_id and q.status = 'new') >= 5 then
    raise exception 'submit_reader_question: the caller already has 5 open questions' using errcode = 'EB035';
  end if;
  insert into public.reader_questions (profile_id, book_id, idea_id, body, locale)
  values (v_profile_id, p_book_id, p_idea_id, btrim(p_body), p_locale)
  returning id into v_id;
  return v_id;
end;
$function$
;

-- Alternate-locale pages: one entry per other localization, not a single 'other' locale.
CREATE OR REPLACE FUNCTION public.catalog_book_page(p_locale text, p_slug text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'bookId', b.id,
    'description', bl.description,
    'audience', bl.audience,
    'keyIdeas', bl.key_ideas,
    'faq', bl.faq,
    'seoTitle', bl.seo_title,
    'seoDescription', bl.seo_description,
    'alternateSlugs', coalesce((select jsonb_object_agg(other.locale, other.slug) from public.book_localizations other where other.book_id = b.id and other.locale <> bl.locale), '{}'::jsonb),
    'isbn', (select e.isbn from public.editions e where e.book_id = b.id and e.isbn is not null order by e.language_code = p_locale desc, e.edition_number limit 1),
    'retailLinks', coalesce((
      select jsonb_agg(jsonb_build_object('id', rl.id, 'retailer', rl.retailer, 'label', rl.label, 'url', rl.url, 'priceMinor', rl.price_minor, 'currency', rl.currency) order by rl.position)
      from public.book_retail_links rl where rl.book_id = b.id and rl.active), '[]'::jsonb),
    'reviewSummary', (
      select case when count(*) = 0 then null
        else jsonb_build_object('count', count(*), 'average', round(avg(r.rating)::numeric, 1)) end
      from public.book_reviews r where r.book_id = b.id and r.status = 'published')
  )
  from public.book_localizations bl
  join public.books b on b.id = bl.book_id
  where bl.locale = p_locale and bl.slug = p_slug and b.status = 'published';
$function$
;

CREATE OR REPLACE FUNCTION public.knowledge_idea_page(p_locale text, p_slug text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'ideaId', i.id,
    'slug', l.slug,
    'question', l.question,
    'shortAnswer', l.short_answer,
    'bodyBlocks', l.body_blocks,
    'seoTitle', l.seo_title,
    'seoDescription', l.seo_description,
    'createdAt', i.created_at,
    'updatedAt', l.updated_at,
    'alternateSlugs', coalesce((
      select jsonb_object_agg(o.locale, o.slug) from public.idea_localizations o where o.idea_id = i.id and o.locale <> l.locale
    ), '{}'::jsonb),
    'bookIds', coalesce((
      select jsonb_agg(ib.book_id order by ib.position)
      from public.idea_books ib
      join public.books b on b.id = ib.book_id and b.status = 'published'
      join public.book_localizations bl on bl.book_id = b.id and bl.locale = l.locale
      where ib.idea_id = i.id
    ), '[]'::jsonb),
    'relatedIdeaIds', coalesce((
      select jsonb_agg(il.related_idea_id order by il.position)
      from public.idea_links il
      join public.ideas r on r.id = il.related_idea_id and r.status = 'published'
      join public.idea_localizations rl on rl.idea_id = r.id and rl.locale = l.locale
      where il.idea_id = i.id
    ), '[]'::jsonb),
    'topics', public.knowledge_topic_refs('idea', i.id, l.locale)
  )
  from public.idea_localizations l
  join public.ideas i on i.id = l.idea_id
  where l.locale = p_locale and l.slug = p_slug and i.status = 'published';
$function$
;

CREATE OR REPLACE FUNCTION public.knowledge_article_page(p_locale text, p_slug text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'articleId', a.id,
    'slug', l.slug,
    'title', l.title,
    'excerpt', l.excerpt,
    'bodyBlocks', l.body_blocks,
    'seoTitle', l.seo_title,
    'seoDescription', l.seo_description,
    'publishedAt', coalesce(a.published_at, a.created_at),
    'updatedAt', l.updated_at,
    'alternateSlugs', coalesce((
      select jsonb_object_agg(o.locale, o.slug) from public.article_localizations o where o.article_id = a.id and o.locale <> l.locale
    ), '{}'::jsonb),
    'author', public.knowledge_article_author(a.author_id, l.locale),
    'bookIds', coalesce((
      select jsonb_agg(ab.book_id order by ab.position)
      from public.article_books ab
      join public.books b on b.id = ab.book_id and b.status = 'published'
      join public.book_localizations bl on bl.book_id = b.id and bl.locale = l.locale
      where ab.article_id = a.id
    ), '[]'::jsonb),
    'ideaIds', coalesce((
      select jsonb_agg(ai.idea_id order by ai.position)
      from public.article_ideas ai
      join public.ideas i on i.id = ai.idea_id and i.status = 'published'
      join public.idea_localizations il on il.idea_id = i.id and il.locale = l.locale
      where ai.article_id = a.id
    ), '[]'::jsonb),
    'topics', public.knowledge_topic_refs('article', a.id, l.locale)
  )
  from public.article_localizations l
  join public.articles a on a.id = l.article_id
  where l.locale = p_locale and l.slug = p_slug and a.status = 'published';
$function$
;

CREATE OR REPLACE FUNCTION public.create_bundle_order(p_bundle_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_profile_id uuid;
  v_market_code text;
  v_currency text;
  v_price_minor bigint;
  v_offer_id uuid;
  v_order_id uuid;
  v_title_snapshot text;
  v_member_count integer;
  v_owned_count integer;
  v_missing_sku_count integer;
  v_bundle_status text;
  v_lines public.bundle_order_line[];
  v_payments_enabled boolean;
  v_provider text;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'create_bundle_order: no profile for the current session' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.customer_identities ci
    where ci.profile_id = v_profile_id and ci.verified_at is not null
  ) then
    raise exception 'create_bundle_order: profile % has no verified email', v_profile_id using errcode = 'EB005';
  end if;

  -- One read for both halves of the settings row, so the gate and the provider can never be taken
  -- from two different moments. Identical to create_ebook_order's: which provider an order is
  -- booked under decides who may confirm it, and this function is granted to `authenticated`, so
  -- the provider comes from commerce_settings and never from the caller.
  select cs.payments_enabled, cs.payment_provider
  into v_payments_enabled, v_provider
  from public.commerce_settings cs where cs.id;

  if not coalesce(v_payments_enabled, false) then
    raise exception 'create_bundle_order: payments are disabled' using errcode = 'EB011';
  end if;

  -- One reader clicking Buy twice must not create two orders. Keyed by (profile, bundle) and
  -- disjoint from create_ebook_order's key by its prefix, so a reader buying a book and a bundle
  -- that contains it at the same moment is not serialized against themselves for no reason.
  perform pg_advisory_xact_lock(hashtextextended('create_bundle_order:' || v_profile_id::text || ':' || p_bundle_id::text, 0));

  -- The bundle row is locked BEFORE anything is read from it, and held for the rest of the
  -- transaction. admin_set_bundle_members takes this same row lock and then replaces the
  -- membership wholesale, so no membership change can commit while this order is being built. It
  -- also serializes against publish_bundle, which is what keeps the status check below and the
  -- price read beneath it a single decision.
  --
  -- This lock is necessary and not sufficient: see the materialization below for what it does not
  -- cover.
  select b.status into v_bundle_status from public.bundles b where b.id = p_bundle_id for update;
  if v_bundle_status is null then
    raise exception 'create_bundle_order: bundle % does not exist', p_bundle_id using errcode = 'P0002';
  end if;
  if v_bundle_status <> 'published' then
    raise exception 'create_bundle_order: bundle % is not purchasable', p_bundle_id using errcode = 'EB027';
  end if;

  -- PR review, finding 2. The offer comes from bundle_live_offer, the single market-resolution
  -- rule this function and the public bundle page now share. It used to pick the first offer by
  -- (market_code, currency) while lib/data/public-bundles.ts showed the cheapest, so a bundle with
  -- two live offers could quote one price on the page and charge another at checkout.
  select l.offer_id, l.market_code, l.currency, l.price_minor
  into v_offer_id, v_market_code, v_currency, v_price_minor
  from public.bundle_live_offer(p_bundle_id) l;

  -- Locked after resolution rather than during it: a set-returning function cannot carry FOR
  -- UPDATE. Re-reading the row under the lock is what makes the price this order is written with
  -- the price that is still on the offer, not one read a moment before someone changed it.
  if v_offer_id is not null then
    select o.market_code, o.currency, o.price_minor
    into v_market_code, v_currency, v_price_minor
    from public.offers o
    where o.id = v_offer_id
      and o.active
      and o.price_minor > 0
      and (o.starts_at is null or o.starts_at <= now())
      and (o.ends_at is null or o.ends_at > now())
    for update;
    if not found then
      v_offer_id := null;
    end if;
  end if;

  if v_offer_id is null then
    raise exception 'create_bundle_order: bundle % is not purchasable', p_bundle_id using errcode = 'EB027';
  end if;

  -- PR review round 2, finding 1. The bundle's order lines are read ONCE, here, and every check
  -- below plus the order_items insert reads that array rather than calling bundle_order_lines
  -- again.
  --
  -- The bundle row lock above is not enough on its own. bundle_order_lines also filters on
  -- books.status = 'published', and unpublish_book locks the BOOK row, not the bundle - so it can
  -- still commit between two of these statements. Under READ COMMITTED that left the order
  -- counted and ownership-checked against one set of books and written from another: the buyer
  -- could clear EB013 against A+B and be sold A alone.
  --
  -- Materializing removes the whole class rather than the one instance of it. Whatever the
  -- catalog does mid-transaction, this order is validated and written from a single snapshot.
  select coalesce(
           array_agg(row(l.line_position, l.book_id, l.sku_id, l.title_snapshot)::public.bundle_order_line
                     order by l.line_position),
           '{}'::public.bundle_order_line[])
  into v_lines
  from public.bundle_order_lines(p_bundle_id) l;

  v_member_count := cardinality(v_lines);
  if v_member_count = 0 then
    raise exception 'create_bundle_order: bundle % has no published member book', p_bundle_id using errcode = 'EB027';
  end if;

  -- order_items.sku_id is not null, so a member with no sku at all cannot be put on an order. That
  -- is a catalog fault rather than a sale: refusing the bundle is the only answer that neither
  -- drops a book the buyer is paying for nor fails on a constraint halfway through.
  select count(*) into v_missing_sku_count from unnest(v_lines) m where m.sku_id is null;
  if v_missing_sku_count > 0 then
    raise exception 'create_bundle_order: bundle % has a member book with no sku', p_bundle_id using errcode = 'EB027';
  end if;

  select count(*) into v_owned_count
  from unnest(v_lines) m
  join public.entitlements e
    on e.profile_id = v_profile_id and e.book_id = m.book_id and e.status = 'active';

  if v_owned_count = v_member_count then
    raise exception 'create_bundle_order: profile % already owns every book of bundle %', v_profile_id, p_bundle_id
      using errcode = 'EB013';
  end if;

  -- Lock the caller's pending orders for this bundle before touching payments or orders, matching
  -- apply_payment_event's orders-then-payments lock order.
  perform 1
  from public.orders o
  where o.profile_id = v_profile_id and o.bundle_id = p_bundle_id and o.status = 'pending'
  for update;

  -- A pending order whose snapshot no longer matches the offer is stale: cancel it so the reader
  -- always pays the price the bundle page shows (spec 4.3, unchanged for bundles). Line for line
  -- the same three staleness conditions create_ebook_order uses, and for the same reasons:
  --
  --   subtotal_minor, NOT total_minor: a coupon lowers the total, and comparing the total to the
  --   offer price would read every discounted pending order as stale and cancel it on the reader's
  --   next visit to the bundle page. The subtotal is the offer price as quoted.
  --
  --   a provider switch makes an order stale the same way a price change does - an order booked
  --   under the other provider is invisible to every surface of the active one, so reusing it
  --   would strand the reader on a checkout page that cannot progress. This is the defect this
  --   function shipped with: it booked every bundle order under 'simulator' regardless of the
  --   setting, so on a manual-provider deployment a bundle could be ordered and never paid for.
  update public.payments pay
  set status = 'cancelled'
  where pay.status = 'pending'
    and pay.order_id in (
      select o.id from public.orders o
      where o.profile_id = v_profile_id and o.bundle_id = p_bundle_id and o.status = 'pending'
        and (
          o.subtotal_minor <> v_price_minor
          or o.currency <> v_currency
          or not exists (
            select 1 from public.payments p2 where p2.order_id = o.id and p2.provider = v_provider
          )
        )
    );

  -- Release any coupon reservation held by the orders about to be cancelled below. Without this, a
  -- stale order's redemption would survive its order - a "reserved" row pointing at a cancelled
  -- order - permanently consuming one use of the code for nothing. A no-op until bundle coupon
  -- scoping lands (20260924160000), and wrong to leave for that task to remember.
  delete from public.coupon_redemptions r
  where r.order_id in (
    select o.id from public.orders o
    where o.profile_id = v_profile_id and o.bundle_id = p_bundle_id and o.status = 'pending'
      and (
        o.subtotal_minor <> v_price_minor
        or o.currency <> v_currency
        or not exists (
          select 1 from public.payments p2 where p2.order_id = o.id and p2.provider = v_provider
        )
      )
  );

  update public.orders o
  set status = 'cancelled', payment_status = 'cancelled'
  where o.profile_id = v_profile_id and o.bundle_id = p_bundle_id and o.status = 'pending'
    and (
      o.subtotal_minor <> v_price_minor
      or o.currency <> v_currency
      or not exists (
        select 1 from public.payments p2 where p2.order_id = o.id and p2.provider = v_provider
      )
    );

  select o.id into v_order_id
  from public.orders o
  where o.profile_id = v_profile_id and o.bundle_id = p_bundle_id and o.status = 'pending'
  order by o.created_at desc
  limit 1;

  if v_order_id is not null then
    return v_order_id;
  end if;

  -- The platform's default metadata locale first, then the rest by code: the order is the shop's
  -- record of the sale, not the buyer's view of it, so it is named the same way whichever locale
  -- the reader bought from.
  select bl.title into v_title_snapshot
  from public.bundle_localizations bl
  where bl.bundle_id = p_bundle_id
  order by (bl.locale = (select s.default_metadata_locale from public.platform_settings s)) desc, bl.locale
  limit 1;

  -- subtotal_minor is set explicitly rather than left to orders_subtotal_minor_trigger, and
  -- payment_provider explicitly rather than left to the column default 'simulator', both matching
  -- create_ebook_order. A default is the right safety net for a writer that forgets; it is not a
  -- decision an order-creating RPC gets to leave to one.
  insert into public.orders (
    profile_id, bundle_id, status, payment_status, market_code, currency,
    total_minor, subtotal_minor, payment_provider, title_snapshot
  )
  values (
    v_profile_id, p_bundle_id, 'pending', 'pending', v_market_code, v_currency,
    v_price_minor, v_price_minor, v_provider, coalesce(v_title_snapshot, '')
  )
  returning id into v_order_id;

  -- The FIRST member carries the price, identified by row_number rather than by `position = 1`:
  -- for a bundle whose members are numbered the way admin_set_bundle_members numbers them these
  -- are the same row, and where a drift has left position 1 unpublished this still puts the price
  -- on a line that exists.
  insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, quantity, position)
  select
    v_order_id,
    m.sku_id,
    m.book_id,
    m.title_snapshot,
    case when row_number() over (order by m.line_position) = 1 then v_price_minor else 0 end,
    1,
    m.line_position
  from unnest(v_lines) m;

  -- The same provider the order is booked under, from commerce_settings and never from the caller.
  -- apply_payment_event resolves this row by (order_id, provider) when events arrive, and refuses
  -- (EB016) an event whose provider is not the order's.
  insert into public.payments (order_id, provider, status, amount_minor, currency)
  values (v_order_id, v_provider, 'pending', v_price_minor, v_currency);

  return v_order_id;
end;
$function$
;


-- catalog_entity_page: alternates for every other locale whose own page would show a visible book.
create or replace function public.catalog_entity_page(p_kind text, p_locale text, p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_name text;
  v_description text;
  v_alternates jsonb := '{}'::jsonb;
  v_quote text;
  v_image_path text;
  v_image_alt text;
begin
  if not public.is_supported_locale(p_locale) then
    return null;
  end if;

  if p_kind = 'author' then
    select a.id, l.name, l.description, l.quote into v_id, v_name, v_description, v_quote
    from public.author_localizations l
    join public.authors a on a.id = l.author_id
    where l.locale = p_locale and l.slug = p_slug and a.status = 'published';
    select coalesce(jsonb_object_agg(l.locale, l.slug), '{}'::jsonb) into v_alternates
    from public.author_localizations l
    where l.author_id = v_id and l.locale <> p_locale
      and public.catalog_has_visible_book(p_kind, v_id, l.locale);
    select asset.storage_key, asset.alt_text into v_image_path, v_image_alt
    from public.media_assets asset
    where asset.owner_type = 'author' and asset.kind = 'author_image' and asset.owner_id = v_id;
  elsif p_kind = 'series' then
    select s.id, l.name, l.description into v_id, v_name, v_description
    from public.series_localizations l
    join public.series s on s.id = l.series_id
    where l.locale = p_locale and l.slug = p_slug and s.status = 'published';
    select coalesce(jsonb_object_agg(l.locale, l.slug), '{}'::jsonb) into v_alternates
    from public.series_localizations l
    where l.series_id = v_id and l.locale <> p_locale
      and public.catalog_has_visible_book(p_kind, v_id, l.locale);
  elsif p_kind = 'topic' then
    select t.id, l.name, l.description into v_id, v_name, v_description
    from public.topic_localizations l
    join public.topics t on t.id = l.topic_id
    where l.locale = p_locale and l.slug = p_slug and t.status = 'published';
    select coalesce(jsonb_object_agg(l.locale, l.slug), '{}'::jsonb) into v_alternates
    from public.topic_localizations l
    where l.topic_id = v_id and l.locale <> p_locale
      and public.catalog_has_visible_book(p_kind, v_id, l.locale);
  else
    return null;
  end if;

  if v_id is null or not public.catalog_has_visible_book(p_kind, v_id, p_locale) then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_id,
    'name', v_name,
    'description', v_description,
    'alternateSlugs', v_alternates,
    'quote', v_quote,
    'imagePath', v_image_path,
    'imageAlt', v_image_alt
  );
end;
$$;
