-- S12: the audited knowledge admin surface (spec sections 7 and 9, plan Task 3).
--
-- New error codes, continuing the EB0xx series (EB030 and EB031 are taken by the S9 gift RPCs of
-- 20260924170000):
--   EB032 - publish_idea: the idea does not meet the publication rules. The message is
--           `publish_idea: idea is not ready: <csv>`.
--   EB033 - publish_article: the article does not meet the publication rules. The message is
--           `publish_article: article is not ready: <csv>`.
-- Both use the shape publish_book raises with EB010, so lib/knowledge/readiness.ts can parse the
-- codes back out and the editor can point at the section that is incomplete.
--
-- 20260927100000 gave browser roles SELECT only on every knowledge table, admins included. These
-- functions are therefore the ONLY browser-reachable way a knowledge row changes. Each one checks
-- is_admin() first (auth.uid() based, so callers use the session client, never service_role),
-- performs one logical mutation, and writes exactly one audit_logs row in the same transaction.
--
-- Content validation is split the same way as for books: lib/knowledge/blocks.ts validates the
-- block shapes (and refuses HTML) before any Server Action calls in; the database enforces what
-- it can state cheaply - locale, slug shape, nonblank copy, body_blocks being an array of at most
-- 100 blocks - so a caller that skips the application layer still cannot store a malformed row.

-- Readiness -------------------------------------------------------------------------------------

-- The SQL halves of checkIdeaReadiness and checkArticleReadiness. The order of the codes is part of
-- the contract with lib/knowledge/readiness.ts. A localization is complete when its slug and its
-- question/short answer (or title/excerpt) are nonblank; missing_blocks asks whether any COMPLETE
-- localization carries a block, so a block on an incomplete localization never makes an entity
-- publishable. The column checks of 20260927100000 already refuse blank copy, so today every stored
-- localization is complete; the trim tests keep the two implementations literally equal anyway.
-- missing_related_book: the public idea page (knowledge_idea_page) lists a related book only when it
-- is published AND localized in the page's locale, and it serves every localization row. So the idea
-- needs one such book for each of its localizations' locales (and at least one such book at all).
create function public.idea_readiness_issues(p_idea_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  with complete as (
    select l.body_blocks
    from public.idea_localizations l
    where l.idea_id = p_idea_id
      and length(trim(l.slug)) > 0
      and length(trim(l.question)) > 0
      and length(trim(l.short_answer)) > 0
  )
  select array_remove(array[
    case when not exists (select 1 from complete) then 'missing_localization' end,
    case when not exists (
      select 1 from complete c
      where jsonb_typeof(c.body_blocks) = 'array' and jsonb_array_length(c.body_blocks) > 0
    ) then 'missing_blocks' end,
    case when not exists (
      select 1
      from public.idea_books ib
      join public.books b on b.id = ib.book_id and b.status = 'published'
      join public.book_localizations bl on bl.book_id = b.id
      where ib.idea_id = p_idea_id
    ) or exists (
      select 1
      from public.idea_localizations l
      where l.idea_id = p_idea_id
        and not exists (
          select 1
          from public.idea_books ib
          join public.books b on b.id = ib.book_id and b.status = 'published'
          join public.book_localizations bl on bl.book_id = b.id and bl.locale = l.locale
          where ib.idea_id = p_idea_id
        )
    ) then 'missing_related_book' end
  ], null);
$$;

create function public.article_readiness_issues(p_article_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  with complete as (
    select l.body_blocks
    from public.article_localizations l
    where l.article_id = p_article_id
      and length(trim(l.slug)) > 0
      and length(trim(l.title)) > 0
      and length(trim(l.excerpt)) > 0
  )
  select array_remove(array[
    case when not exists (select 1 from complete) then 'missing_localization' end,
    case when not exists (
      select 1 from complete c
      where jsonb_typeof(c.body_blocks) = 'array' and jsonb_array_length(c.body_blocks) > 0
    ) then 'missing_blocks' end
  ], null);
$$;

revoke execute on function public.idea_readiness_issues(uuid) from public, anon, authenticated;
revoke execute on function public.article_readiness_issues(uuid) from public, anon, authenticated;

-- Shared input checks -----------------------------------------------------------------------------

-- Internal helpers for the RPCs below; no browser role may call them. Each raises with the calling
-- RPC's name so the error reads as that RPC's own.
--
-- The RPCs are granted to `authenticated`, so an admin can call them without the Server Action.
-- knowledge_check_body_blocks therefore enforces the same typed-block contract as
-- lib/knowledge/blocks.ts (block types, exact key sets, limits, no markup); keep the two in step.
-- ponytail: two checks are approximations of what Zod/JS decide, tuned to accept anything Zod
-- accepts: graphemes are estimated (ZWJ sequences, combining marks, variation selectors, skin tones,
-- flag pairs, CRLF), and an href is checked by URL shape (host characters, bracketed IPv6, port range),
-- not URL.canParse. A block in the gap is skipped (and logged) by the public DAL's per-block parse
-- in lib/data/knowledge.ts, so it costs that block, never the page.

create function public.knowledge_keys_ok(p_obj jsonb, p_allowed text[], p_required text[])
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if jsonb_typeof(p_obj) <> 'object' then
    return false;
  end if;
  return p_obj ?& p_required
    and not exists (select 1 from jsonb_object_keys(p_obj) as k where k <> all (p_allowed));
end;
$$;

create function public.knowledge_safe_text(p_value jsonb, p_max integer)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    jsonb_typeof(p_value) = 'string'
    and char_length(p_value #>> '{}') <= p_max
    and (p_value #>> '{}') ~ '[^[:space:]]'
    and (p_value #>> '{}') !~* '</?[a-z][^>]*>',
    false);
$$;

create function public.knowledge_uuid_ok(p_value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    jsonb_typeof(p_value) = 'string'
    and (p_value #>> '{}') ~* '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',
    false);
$$;

-- Estimated grapheme clusters, for the 300-grapheme book-quote rule. Postgres cannot segment text, so
-- this drops what Intl.Segmenter folds into the previous cluster and counts a flag pair once. It may
-- undercount (accepting a rare over-limit quote) but must not overcount a text Zod accepts.
create function public.knowledge_grapheme_estimate(p_text text)
returns integer
language sql
immutable
set search_path = ''
as $$
  with t as (
    select regexp_replace(
             regexp_replace(replace(p_text, E'\r\n', E'\n'), '‍.', '', 'g'),
             '[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︀-️︠-︯\U0001F3FB-\U0001F3FF]',
             '', 'g') as v
  ), c as (
    select v, char_length(v) - char_length(regexp_replace(v, '[\U0001F1E6-\U0001F1FF]', '', 'g')) as flags from t
  )
  select char_length(v) - flags + flags / 2 from c;
$$;

create function public.knowledge_inline_ok(p_content jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_run jsonb;
  v_link jsonb;
begin
  if jsonb_typeof(p_content) <> 'array' or jsonb_array_length(p_content) not between 1 and 200 then
    return false;
  end if;
  for v_run in select value from jsonb_array_elements(p_content) loop
    if not public.knowledge_keys_ok(v_run, array['text', 'marks', 'link'], array['text'])
       or not public.knowledge_safe_text(v_run -> 'text', 5000) then
      return false;
    end if;
    if v_run ? 'marks' and not (
      jsonb_typeof(v_run -> 'marks') = 'array'
      and jsonb_array_length(v_run -> 'marks') <= 2
      and not exists (select 1 from jsonb_array_elements(v_run -> 'marks') as m
                      where m not in ('"emphasis"'::jsonb, '"strong"'::jsonb))
      and (select count(distinct m) from jsonb_array_elements(v_run -> 'marks') as m) = jsonb_array_length(v_run -> 'marks')
    ) then
      return false;
    end if;
    if v_run ? 'link' then
      v_link := v_run -> 'link';
      if public.knowledge_keys_ok(v_link, array['kind', 'entity', 'slug'], array['kind', 'entity', 'slug']) then
        if not coalesce(
          v_link ->> 'kind' = 'internal'
          and v_link ->> 'entity' in ('book', 'idea', 'article', 'author', 'series', 'topic')
          and jsonb_typeof(v_link -> 'slug') = 'string'
          and char_length(v_link ->> 'slug') <= 200
          and v_link ->> 'slug' ~ '^[a-z0-9]+(-[a-z0-9]+)*$', false) then
          return false;
        end if;
      elsif public.knowledge_keys_ok(v_link, array['kind', 'href'], array['kind', 'href']) then
        if not coalesce(
          v_link ->> 'kind' = 'external'
          and jsonb_typeof(v_link -> 'href') = 'string'
          and char_length(v_link ->> 'href') <= 2048
          and v_link ->> 'href' ~* '^https?://([^/?#@[:space:][:cntrl:]]*@)?(\[[0-9a-f:.]+\]|[^/?#@:\[\]<>^|\\%[:space:][:cntrl:]]+)(:[0-9]{0,5})?([/?#].*)?$'
          and coalesce(substring(v_link ->> 'href' from '^https?://[^/?#]*:([0-9]+)(?:[/?#]|$)')::integer, 0) <= 65535
          and v_link ->> 'href' !~ '[[:space:][:cntrl:]]', false) then
          return false;
        end if;
      else
        return false;
      end if;
    end if;
  end loop;
  return true;
end;
$$;

create function public.knowledge_block_ok(p_block jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_item jsonb;
begin
  if jsonb_typeof(p_block) <> 'object' or jsonb_typeof(p_block -> 'type') <> 'string' then
    return false;
  end if;
  case p_block ->> 'type'
    when 'paragraph' then
      return public.knowledge_keys_ok(p_block, array['type', 'content'], array['type', 'content'])
        and public.knowledge_inline_ok(p_block -> 'content');
    when 'heading' then
      return public.knowledge_keys_ok(p_block, array['type', 'level', 'text'], array['type', 'level', 'text'])
        and p_block -> 'level' in ('2'::jsonb, '3'::jsonb)
        and public.knowledge_safe_text(p_block -> 'text', 500);
    when 'list' then
      if not public.knowledge_keys_ok(p_block, array['type', 'ordered', 'items'], array['type', 'ordered', 'items'])
         or jsonb_typeof(p_block -> 'ordered') <> 'boolean'
         or jsonb_typeof(p_block -> 'items') <> 'array'
         or jsonb_array_length(p_block -> 'items') not between 1 and 50 then
        return false;
      end if;
      for v_item in select value from jsonb_array_elements(p_block -> 'items') loop
        if not public.knowledge_inline_ok(v_item) then
          return false;
        end if;
      end loop;
      return true;
    when 'quote' then
      -- Exactly one attribution source: free text or a book; a book quote is at most 300 graphemes (estimated).
      return public.knowledge_keys_ok(p_block, array['type', 'text', 'attribution', 'bookId'], array['type', 'text'])
        and public.knowledge_safe_text(p_block -> 'text', 5000)
        and ((p_block ? 'attribution')::int + (p_block ? 'bookId')::int) = 1
        and (not p_block ? 'attribution' or public.knowledge_safe_text(p_block -> 'attribution', 500))
        and (not p_block ? 'bookId'
             or (public.knowledge_uuid_ok(p_block -> 'bookId') and public.knowledge_grapheme_estimate(p_block ->> 'text') <= 300));
    when 'book_quote' then
      return public.knowledge_keys_ok(p_block, array['type', 'bookId', 'text', 'locatorLabel'], array['type', 'bookId', 'text'])
        and public.knowledge_uuid_ok(p_block -> 'bookId')
        and public.knowledge_safe_text(p_block -> 'text', 5000)
        and public.knowledge_grapheme_estimate(p_block ->> 'text') <= 300
        and (not p_block ? 'locatorLabel' or public.knowledge_safe_text(p_block -> 'locatorLabel', 200));
    when 'image' then
      return public.knowledge_keys_ok(p_block, array['type', 'storageKey', 'alt', 'width', 'height'],
                                      array['type', 'storageKey', 'alt', 'width', 'height'])
        and jsonb_typeof(p_block -> 'storageKey') = 'string'
        and p_block ->> 'storageKey' ~ '^knowledge/(ideas|articles)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
        and public.knowledge_safe_text(p_block -> 'alt', 1000)
        and jsonb_typeof(p_block -> 'width') = 'number' and p_block ->> 'width' ~ '^[0-9]+$'
        and jsonb_typeof(p_block -> 'height') = 'number' and p_block ->> 'height' ~ '^[0-9]+$'
        and (p_block ->> 'width')::numeric between 1 and 20000
        and (p_block ->> 'height')::numeric between 1 and 20000;
    when 'book_card' then
      return public.knowledge_keys_ok(p_block, array['type', 'bookId'], array['type', 'bookId'])
        and public.knowledge_uuid_ok(p_block -> 'bookId');
    when 'idea_card' then
      return public.knowledge_keys_ok(p_block, array['type', 'ideaId'], array['type', 'ideaId'])
        and public.knowledge_uuid_ok(p_block -> 'ideaId');
    else
      return false;
  end case;
end;
$$;

create function public.knowledge_check_body_blocks(p_caller text, p_body_blocks jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_block jsonb;
  v_index integer := 0;
begin
  if p_body_blocks is null or jsonb_typeof(p_body_blocks) <> 'array' then
    raise exception '%: body_blocks must be a JSON array', p_caller using errcode = '22023';
  end if;
  if jsonb_array_length(p_body_blocks) > 100 then
    raise exception '%: body_blocks holds at most 100 blocks', p_caller using errcode = '22023';
  end if;
  for v_block in select value from jsonb_array_elements(p_body_blocks) loop
    if not coalesce(public.knowledge_block_ok(v_block), false) then
      raise exception '%: body_blocks[%] is not a valid typed block', p_caller, v_index using errcode = '22023';
    end if;
    v_index := v_index + 1;
  end loop;
end;
$$;

-- A relation list is replaced wholesale, so a duplicate or a null is an operator mistake the
-- primary key would refuse half-way through anyway; saying so up front names it.
create function public.knowledge_check_id_list(p_caller text, p_label text, p_ids uuid[])
returns void
language plpgsql
set search_path = ''
as $$
begin
  if array_position(p_ids, null) is not null then
    raise exception '%: % must not contain null', p_caller, p_label using errcode = '22023';
  end if;
  if (select count(distinct x.id) from unnest(p_ids) as x(id)) <> cardinality(p_ids) then
    raise exception '%: % must not repeat an id', p_caller, p_label using errcode = '22023';
  end if;
end;
$$;

revoke execute on function public.knowledge_keys_ok(jsonb, text[], text[]) from public, anon, authenticated;
revoke execute on function public.knowledge_safe_text(jsonb, integer) from public, anon, authenticated;
revoke execute on function public.knowledge_uuid_ok(jsonb) from public, anon, authenticated;
revoke execute on function public.knowledge_grapheme_estimate(text) from public, anon, authenticated;
revoke execute on function public.knowledge_inline_ok(jsonb) from public, anon, authenticated;
revoke execute on function public.knowledge_block_ok(jsonb) from public, anon, authenticated;
revoke execute on function public.knowledge_check_body_blocks(text, jsonb) from public, anon, authenticated;
revoke execute on function public.knowledge_check_id_list(text, text, uuid[]) from public, anon, authenticated;

-- Creation ------------------------------------------------------------------------------------------

-- An idea has no unlocalized name, so creating one is creating its first localization, with no
-- blocks yet. The editor then takes over: blocks, relations, SEO, publication.
create function public.admin_create_idea(p_locale text, p_slug text, p_question text, p_short_answer text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_idea_id uuid;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_create_idea: caller is not an admin' using errcode = '42501';
  end if;
  if p_locale is null or p_locale not in ('vi', 'en') then
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
$$;

create function public.admin_create_article(
  p_author_id uuid,
  p_locale text,
  p_slug text,
  p_title text,
  p_excerpt text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_article_id uuid;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_create_article: caller is not an admin' using errcode = '42501';
  end if;
  if p_locale is null or p_locale not in ('vi', 'en') then
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
$$;

-- Details -------------------------------------------------------------------------------------------

-- The only unlocalized article detail is its byline. published_at belongs to publish_article and
-- status to publish/unpublish, so neither is editable here.
create function public.admin_update_article(p_article_id uuid, p_author_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous_author_id uuid;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_update_article: caller is not an admin' using errcode = '42501';
  end if;

  select author_id into v_previous_author_id from public.articles where id = p_article_id for update;
  if not found then
    raise exception 'admin_update_article: article % does not exist', p_article_id using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.authors a where a.id = p_author_id) then
    raise exception 'admin_update_article: author % does not exist', p_author_id using errcode = 'P0002';
  end if;

  update public.articles set author_id = p_author_id where id = p_article_id;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'update_article', 'articles', p_article_id,
          jsonb_build_object('author_id_from', v_previous_author_id, 'author_id', p_author_id));
end;
$$;

-- Localizations ---------------------------------------------------------------------------------------

-- The knowledge counterparts of admin_save_bundle_localization, including its redirect rule: a slug a
-- reader could already have followed is preserved, a draft one never existed publicly and is not.
-- record_slug_redirect (20260913110000) is what keeps a -> b -> c collapsed to a -> c and b -> c.
-- The path segment is part of the path, so /vi/ideas/x and /vi/articles/x never interfere.
create function public.admin_save_idea_localization(
  p_idea_id uuid,
  p_locale text,
  p_slug text,
  p_question text,
  p_short_answer text,
  p_body_blocks jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_idea_status public.content_status;
  v_localization_id uuid;
  v_old_slug text;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_save_idea_localization: caller is not an admin' using errcode = '42501';
  end if;
  if p_locale is null or p_locale not in ('vi', 'en') then
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
$$;

create function public.admin_save_article_localization(
  p_article_id uuid,
  p_locale text,
  p_slug text,
  p_title text,
  p_excerpt text,
  p_body_blocks jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_article_status public.content_status;
  v_localization_id uuid;
  v_old_slug text;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_save_article_localization: caller is not an admin' using errcode = '42501';
  end if;
  if p_locale is null or p_locale not in ('vi', 'en') then
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
$$;

-- SEO -------------------------------------------------------------------------------------------------

-- SEO belongs to a localization that already exists; it never creates one, and it touches only the
-- two SEO columns. Blank input is stored as null so metadata falls back to the question or title.
create function public.admin_save_idea_seo(
  p_idea_id uuid,
  p_locale text,
  p_seo_title text,
  p_seo_description text
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
    raise exception 'admin_save_idea_seo: caller is not an admin' using errcode = '42501';
  end if;
  if p_locale is null or p_locale not in ('vi', 'en') then
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
$$;

create function public.admin_save_article_seo(
  p_article_id uuid,
  p_locale text,
  p_seo_title text,
  p_seo_description text
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
    raise exception 'admin_save_article_seo: caller is not an admin' using errcode = '42501';
  end if;
  if p_locale is null or p_locale not in ('vi', 'en') then
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
$$;

-- Relations -------------------------------------------------------------------------------------------

-- The editor posts every relation list in full, and this replaces all of them in one transaction.
-- Positions come from `with ordinality`, so they are contiguous from 1 and agree with the submitted
-- order by construction (the admin_set_bundle_members idiom). A null list means an empty one. Every
-- check runs before the first delete, and any failure rolls the whole call back.
create function public.admin_set_idea_relations(
  p_idea_id uuid,
  p_book_ids uuid[],
  p_topic_ids uuid[],
  p_related_idea_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_book_ids uuid[] := coalesce(p_book_ids, '{}');
  v_topic_ids uuid[] := coalesce(p_topic_ids, '{}');
  v_related_idea_ids uuid[] := coalesce(p_related_idea_ids, '{}');
  v_missing_id uuid;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_set_idea_relations: caller is not an admin' using errcode = '42501';
  end if;

  update public.ideas set updated_at = now() where id = p_idea_id;
  if not found then
    raise exception 'admin_set_idea_relations: idea % does not exist', p_idea_id using errcode = 'P0002';
  end if;

  perform public.knowledge_check_id_list('admin_set_idea_relations', 'book_ids', v_book_ids);
  perform public.knowledge_check_id_list('admin_set_idea_relations', 'topic_ids', v_topic_ids);
  perform public.knowledge_check_id_list('admin_set_idea_relations', 'related_idea_ids', v_related_idea_ids);
  if p_idea_id = any(v_related_idea_ids) then
    raise exception 'admin_set_idea_relations: an idea cannot link to itself' using errcode = '22023';
  end if;

  -- The column aliases are load-bearing: a bare `id` would resolve to the inner table's own id.
  select m.book_id into v_missing_id from unnest(v_book_ids) as m(book_id)
  where not exists (select 1 from public.books b where b.id = m.book_id) limit 1;
  if v_missing_id is not null then
    raise exception 'admin_set_idea_relations: book % does not exist', v_missing_id using errcode = 'P0002';
  end if;
  select m.topic_id into v_missing_id from unnest(v_topic_ids) as m(topic_id)
  where not exists (select 1 from public.topics t where t.id = m.topic_id) limit 1;
  if v_missing_id is not null then
    raise exception 'admin_set_idea_relations: topic % does not exist', v_missing_id using errcode = 'P0002';
  end if;
  select m.related_idea_id into v_missing_id from unnest(v_related_idea_ids) as m(related_idea_id)
  where not exists (select 1 from public.ideas i where i.id = m.related_idea_id) limit 1;
  if v_missing_id is not null then
    raise exception 'admin_set_idea_relations: idea % does not exist', v_missing_id using errcode = 'P0002';
  end if;

  delete from public.idea_books where idea_id = p_idea_id;
  insert into public.idea_books (idea_id, book_id, position)
  select p_idea_id, m.book_id, m.ord from unnest(v_book_ids) with ordinality as m(book_id, ord);

  delete from public.idea_topics where idea_id = p_idea_id;
  insert into public.idea_topics (idea_id, topic_id)
  select p_idea_id, m.topic_id from unnest(v_topic_ids) as m(topic_id);

  delete from public.idea_links where idea_id = p_idea_id;
  insert into public.idea_links (idea_id, related_idea_id, position)
  select p_idea_id, m.related_idea_id, m.ord from unnest(v_related_idea_ids) with ordinality as m(related_idea_id, ord);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'set_idea_relations', 'ideas', p_idea_id,
          jsonb_build_object('book_ids', to_jsonb(v_book_ids), 'topic_ids', to_jsonb(v_topic_ids),
                             'related_idea_ids', to_jsonb(v_related_idea_ids)));
end;
$$;

create function public.admin_set_article_relations(
  p_article_id uuid,
  p_book_ids uuid[],
  p_idea_ids uuid[],
  p_topic_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_book_ids uuid[] := coalesce(p_book_ids, '{}');
  v_idea_ids uuid[] := coalesce(p_idea_ids, '{}');
  v_topic_ids uuid[] := coalesce(p_topic_ids, '{}');
  v_missing_id uuid;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_set_article_relations: caller is not an admin' using errcode = '42501';
  end if;

  perform 1 from public.articles where id = p_article_id for update;
  if not found then
    raise exception 'admin_set_article_relations: article % does not exist', p_article_id using errcode = 'P0002';
  end if;

  perform public.knowledge_check_id_list('admin_set_article_relations', 'book_ids', v_book_ids);
  perform public.knowledge_check_id_list('admin_set_article_relations', 'idea_ids', v_idea_ids);
  perform public.knowledge_check_id_list('admin_set_article_relations', 'topic_ids', v_topic_ids);

  select m.book_id into v_missing_id from unnest(v_book_ids) as m(book_id)
  where not exists (select 1 from public.books b where b.id = m.book_id) limit 1;
  if v_missing_id is not null then
    raise exception 'admin_set_article_relations: book % does not exist', v_missing_id using errcode = 'P0002';
  end if;
  select m.idea_id into v_missing_id from unnest(v_idea_ids) as m(idea_id)
  where not exists (select 1 from public.ideas i where i.id = m.idea_id) limit 1;
  if v_missing_id is not null then
    raise exception 'admin_set_article_relations: idea % does not exist', v_missing_id using errcode = 'P0002';
  end if;
  select m.topic_id into v_missing_id from unnest(v_topic_ids) as m(topic_id)
  where not exists (select 1 from public.topics t where t.id = m.topic_id) limit 1;
  if v_missing_id is not null then
    raise exception 'admin_set_article_relations: topic % does not exist', v_missing_id using errcode = 'P0002';
  end if;

  delete from public.article_books where article_id = p_article_id;
  insert into public.article_books (article_id, book_id, position)
  select p_article_id, m.book_id, m.ord from unnest(v_book_ids) with ordinality as m(book_id, ord);

  delete from public.article_ideas where article_id = p_article_id;
  insert into public.article_ideas (article_id, idea_id, position)
  select p_article_id, m.idea_id, m.ord from unnest(v_idea_ids) with ordinality as m(idea_id, ord);

  delete from public.article_topics where article_id = p_article_id;
  insert into public.article_topics (article_id, topic_id)
  select p_article_id, m.topic_id from unnest(v_topic_ids) as m(topic_id);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'set_article_relations', 'articles', p_article_id,
          jsonb_build_object('book_ids', to_jsonb(v_book_ids), 'idea_ids', to_jsonb(v_idea_ids),
                             'topic_ids', to_jsonb(v_topic_ids)));
end;
$$;

-- Publication -----------------------------------------------------------------------------------------

create function public.publish_idea(p_idea_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_issues text[];
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'publish_idea: caller is not an admin' using errcode = '42501';
  end if;

  perform 1 from public.ideas where id = p_idea_id for update;
  if not found then
    raise exception 'publish_idea: idea % does not exist', p_idea_id using errcode = 'P0002';
  end if;

  v_issues := public.idea_readiness_issues(p_idea_id);
  if cardinality(v_issues) > 0 then
    raise exception 'publish_idea: idea is not ready: %', array_to_string(v_issues, ',') using errcode = 'EB032';
  end if;

  update public.ideas set status = 'published' where id = p_idea_id;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'publish_idea', 'ideas', p_idea_id, '{}'::jsonb);
end;
$$;

create function public.unpublish_idea(p_idea_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'unpublish_idea: caller is not an admin' using errcode = '42501';
  end if;

  update public.ideas set status = 'draft' where id = p_idea_id;
  if not found then
    raise exception 'unpublish_idea: idea % does not exist', p_idea_id using errcode = 'P0002';
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'unpublish_idea', 'ideas', p_idea_id, '{}'::jsonb);
end;
$$;

-- published_at is set on the first successful publish only. Unpublishing and republishing keep it,
-- so the reverse-chronological archive never reorders editorial history.
create function public.publish_article(p_article_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_issues text[];
  v_published_at timestamptz;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'publish_article: caller is not an admin' using errcode = '42501';
  end if;

  perform 1 from public.articles where id = p_article_id for update;
  if not found then
    raise exception 'publish_article: article % does not exist', p_article_id using errcode = 'P0002';
  end if;

  v_issues := public.article_readiness_issues(p_article_id);
  if cardinality(v_issues) > 0 then
    raise exception 'publish_article: article is not ready: %', array_to_string(v_issues, ',') using errcode = 'EB033';
  end if;

  update public.articles
  set status = 'published', published_at = coalesce(published_at, now())
  where id = p_article_id
  returning published_at into v_published_at;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'publish_article', 'articles', p_article_id,
          jsonb_build_object('published_at', v_published_at));
end;
$$;

create function public.unpublish_article(p_article_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'unpublish_article: caller is not an admin' using errcode = '42501';
  end if;

  update public.articles set status = 'draft' where id = p_article_id;
  if not found then
    raise exception 'unpublish_article: article % does not exist', p_article_id using errcode = 'P0002';
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'unpublish_article', 'articles', p_article_id, '{}'::jsonb);
end;
$$;

-- Grants ------------------------------------------------------------------------------------------

revoke execute on function public.admin_create_idea(text, text, text, text) from public, anon;
grant execute on function public.admin_create_idea(text, text, text, text) to authenticated;
revoke execute on function public.admin_create_article(uuid, text, text, text, text) from public, anon;
grant execute on function public.admin_create_article(uuid, text, text, text, text) to authenticated;
revoke execute on function public.admin_update_article(uuid, uuid) from public, anon;
grant execute on function public.admin_update_article(uuid, uuid) to authenticated;
revoke execute on function public.admin_save_idea_localization(uuid, text, text, text, text, jsonb) from public, anon;
grant execute on function public.admin_save_idea_localization(uuid, text, text, text, text, jsonb) to authenticated;
revoke execute on function public.admin_save_article_localization(uuid, text, text, text, text, jsonb) from public, anon;
grant execute on function public.admin_save_article_localization(uuid, text, text, text, text, jsonb) to authenticated;
revoke execute on function public.admin_save_idea_seo(uuid, text, text, text) from public, anon;
grant execute on function public.admin_save_idea_seo(uuid, text, text, text) to authenticated;
revoke execute on function public.admin_save_article_seo(uuid, text, text, text) from public, anon;
grant execute on function public.admin_save_article_seo(uuid, text, text, text) to authenticated;
revoke execute on function public.admin_set_idea_relations(uuid, uuid[], uuid[], uuid[]) from public, anon;
grant execute on function public.admin_set_idea_relations(uuid, uuid[], uuid[], uuid[]) to authenticated;
revoke execute on function public.admin_set_article_relations(uuid, uuid[], uuid[], uuid[]) from public, anon;
grant execute on function public.admin_set_article_relations(uuid, uuid[], uuid[], uuid[]) to authenticated;
revoke execute on function public.publish_idea(uuid) from public, anon;
grant execute on function public.publish_idea(uuid) to authenticated;
revoke execute on function public.unpublish_idea(uuid) from public, anon;
grant execute on function public.unpublish_idea(uuid) to authenticated;
revoke execute on function public.publish_article(uuid) from public, anon;
grant execute on function public.publish_article(uuid) to authenticated;
revoke execute on function public.unpublish_article(uuid) from public, anon;
grant execute on function public.unpublish_article(uuid) to authenticated;
