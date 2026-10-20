-- S16 shared quote cards (spec 2026-10-09-s16). A row exists only because an entitled reader pressed
-- Share. No role reads the table; every read and write is a definer RPC. Error codes: EB038 cap,
-- EB039 everything else (one code so a publication id cannot be probed by the error it produces).

create table public.shared_quotes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Za-z0-9_-]{10}$'),
  book_id uuid not null references public.books(id) on delete cascade,
  publication_id uuid references public.ebook_publications(id) on delete set null,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  -- Characters here; the 300-grapheme rule is the route's, with the shared helper.
  quote text not null check (length(btrim(quote)) between 1 and 1200 and quote !~* '</?[a-z][^>]*>'),
  locale text not null check (locale in ('vi', 'en')),
  status text not null default 'active' check (status in ('active', 'removed')),
  removed_by text check (removed_by is null or removed_by in ('owner', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'removed') = (removed_by is not null))
);
create index shared_quotes_owner_idx on public.shared_quotes (profile_id, created_at desc);
create index shared_quotes_book_idx on public.shared_quotes (book_id, status);
create trigger shared_quotes_touch_updated_at before update on public.shared_quotes
  for each row execute function public.touch_updated_at();
alter table public.shared_quotes enable row level security;
revoke all on public.shared_quotes from public, anon, authenticated;

-- Analytics: two names, one id column. No text.
alter table public.analytics_events
  add column shared_quote_id uuid references public.shared_quotes(id) on delete set null;
create index analytics_events_shared_quote_idx on public.analytics_events (shared_quote_id)
  where shared_quote_id is not null;
alter table public.analytics_events
  drop constraint analytics_events_event_name_check,
  add constraint analytics_events_event_name_check check (event_name in (
    'view_book', 'open_sample', 'begin_checkout', 'purchase', 'payment_failed',
    'open_reader', 'progress_25', 'progress_50', 'progress_75', 'progress_100',
    'change_reader_setting', 'view_library', 'book_published',
    'epub_job_started', 'epub_job_completed', 'epub_job_failed',
    'click_external_store', 'share_quote', 'view_quote'
  ));

create function public.shared_quote_json(q public.shared_quotes)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', q.id, 'code', q.code, 'quote', q.quote, 'locale', q.locale,
                            'bookId', q.book_id, 'createdAt', q.created_at);
$$;

create function public.create_shared_quote(p_publication_id uuid, p_quote text, p_locale text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
     or p_locale is null or p_locale not in ('vi', 'en') then
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
$$;

create function public.remove_shared_quote(p_code text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.shared_quotes q
  set status = 'removed', removed_by = 'owner'
  from public.profiles p
  where q.code = p_code and q.status = 'active' and q.profile_id = p.id and p.auth_user_id = auth.uid();
end;
$$;

create function public.admin_remove_shared_quote(p_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_remove_shared_quote: caller is not an admin' using errcode = '42501';
  end if;
  update public.shared_quotes set status = 'removed', removed_by = 'admin'
  where code = p_code and status = 'active' returning id into v_id;
  if v_id is null then
    raise exception 'admin_remove_shared_quote: no active card %', p_code using errcode = 'P0002';
  end if;
  select pr.id into v_actor from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor, 'shared_quote.remove', 'shared_quotes', v_id, '{}'::jsonb);
end;
$$;

-- Public: an active card of a published book. Null otherwise, whatever the reason.
create function public.catalog_shared_quote(p_code text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.shared_quote_json(q)
  from public.shared_quotes q
  join public.books b on b.id = q.book_id and b.status = 'published'
  where q.code = p_code and q.status = 'active';
$$;

create function public.my_shared_quotes()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((
    select jsonb_agg(public.shared_quote_json(q) || jsonb_build_object(
      'bookTitle', coalesce((select bl.title from public.book_localizations bl where bl.book_id = q.book_id order by bl.locale = q.locale desc limit 1), q.book_id::text),
      'viewCount', (select count(*) from public.analytics_events e where e.shared_quote_id = q.id and e.event_name = 'view_quote')
    ) order by q.created_at desc, q.id)
    from public.shared_quotes q
    join public.profiles p on p.id = q.profile_id
    where p.auth_user_id = auth.uid() and q.status = 'active'
  ), '[]'::jsonb);
$$;

create function public.admin_list_shared_quotes(p_book_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when not public.is_admin() then null else coalesce((
    select jsonb_agg(public.shared_quote_json(q) || jsonb_build_object(
      'bookTitle', coalesce((select bl.title from public.book_localizations bl where bl.book_id = q.book_id order by bl.locale = q.locale desc limit 1), q.book_id::text),
      'ownerEmail', (select ci.normalized_email from public.customer_identities ci where ci.profile_id = q.profile_id order by ci.created_at limit 1),
      'viewCount', (select count(*) from public.analytics_events e where e.shared_quote_id = q.id and e.event_name = 'view_quote')
    ) order by q.created_at desc, q.id)
    from (select * from public.shared_quotes where status = 'active' and (p_book_id is null or book_id = p_book_id)
          order by created_at desc limit 200) q
  ), '[]'::jsonb) end;
$$;

revoke execute on function public.create_shared_quote(uuid, text, text) from public, anon;
grant execute on function public.create_shared_quote(uuid, text, text) to authenticated;
revoke execute on function public.remove_shared_quote(text) from public, anon;
grant execute on function public.remove_shared_quote(text) to authenticated;
revoke execute on function public.admin_remove_shared_quote(text) from public, anon;
grant execute on function public.admin_remove_shared_quote(text) to authenticated;
revoke execute on function public.my_shared_quotes() from public, anon;
grant execute on function public.my_shared_quotes() to authenticated;
revoke execute on function public.admin_list_shared_quotes(uuid) from public, anon;
grant execute on function public.admin_list_shared_quotes(uuid) to authenticated;
revoke execute on function public.catalog_shared_quote(text) from public;
grant execute on function public.catalog_shared_quote(text) to anon, authenticated;
revoke execute on function public.shared_quote_json(public.shared_quotes) from public, anon, authenticated;
