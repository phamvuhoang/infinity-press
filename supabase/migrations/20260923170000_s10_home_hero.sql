-- S10 home page: an operator-managed hero background image, and the topic strip the home page
-- renders under the featured book. Board 1e places an editorial photograph behind the hero cover;
-- until now no admin surface owned that image.

-- Singleton row. `id` is a constant true so the table can hold at most one hero, and an upsert
-- needs no prior read.
create table public.home_hero (
  id boolean primary key default true check (id),
  desktop_storage_key text not null,
  mobile_storage_key text not null,
  alt_text text not null,
  updated_at timestamptz not null default now()
);

alter table public.home_hero enable row level security;

-- Browsers never read this table directly: the storefront goes through catalog_home_hero and the
-- admin pages go through the admin RPCs. The admin select policy exists so /admin can show the
-- current image without the service role.
create policy "admin reads home hero" on public.home_hero
  for select to authenticated using ((select public.is_admin()));

-- Default privileges did not cover a table created this late, so the select the policy governs
-- needs its own grant. Writes stay with the security-definer RPCs.
grant select on public.home_hero to authenticated;

create trigger home_hero_touch_updated_at before update on public.home_hero
  for each row execute function public.touch_updated_at();

-- Writes ------------------------------------------------------------------------------------------

-- Keys are minted server-side under home/hero/, never accepted from a browser. The pattern check
-- and the storage.objects existence check mirror admin_set_book_cover.
create function public.admin_set_home_hero(p_desktop_key text, p_mobile_key text, p_alt_text text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous jsonb;
  v_actor_profile_id uuid;
  v_key text;
begin
  if not public.is_admin() then
    raise exception 'admin_set_home_hero: caller is not an admin' using errcode = '42501';
  end if;

  foreach v_key in array array[p_desktop_key, p_mobile_key] loop
    if v_key !~ '^home/hero/[0-9a-f-]{36}\.(jpg|png|webp)$' then
      raise exception 'admin_set_home_hero: storage key % is not a hero key', v_key using errcode = '22023';
    end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'covers' and o.name = v_key) then
      raise exception 'admin_set_home_hero: storage object % does not exist', v_key using errcode = 'P0002';
    end if;
  end loop;

  if p_alt_text is null or length(trim(p_alt_text)) = 0 then
    raise exception 'admin_set_home_hero: alt text is required' using errcode = '22023';
  end if;

  select jsonb_build_object('desktop_storage_key', h.desktop_storage_key, 'mobile_storage_key', h.mobile_storage_key)
  into v_previous
  from public.home_hero h
  where h.id
  for update;

  insert into public.home_hero (id, desktop_storage_key, mobile_storage_key, alt_text)
  values (true, p_desktop_key, p_mobile_key, trim(p_alt_text))
  on conflict (id) do update set
    desktop_storage_key = excluded.desktop_storage_key,
    mobile_storage_key = excluded.mobile_storage_key,
    alt_text = excluded.alt_text;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, metadata)
  values (v_actor_profile_id, 'set_home_hero', 'home_hero',
          jsonb_build_object('previous', v_previous, 'desktop_storage_key', p_desktop_key, 'mobile_storage_key', p_mobile_key));
end;
$$;

create function public.admin_clear_home_hero()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_clear_home_hero: caller is not an admin' using errcode = '42501';
  end if;

  delete from public.home_hero where id;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, metadata)
  values (v_actor_profile_id, 'clear_home_hero', 'home_hero', '{}'::jsonb);
end;
$$;

revoke execute on function public.admin_set_home_hero(text, text, text) from public;
grant execute on function public.admin_set_home_hero(text, text, text) to authenticated;
revoke execute on function public.admin_clear_home_hero() from public;
grant execute on function public.admin_clear_home_hero() to authenticated;

-- Public reads ------------------------------------------------------------------------------------

create function public.catalog_home_hero()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'desktopPath', h.desktop_storage_key,
    'mobilePath', h.mobile_storage_key,
    'altText', h.alt_text
  )
  from public.home_hero h
  where h.id;
$$;

-- Topics the home page can offer as entry points: published, localized, and holding at least one
-- published book in the same locale, so every card leads somewhere.
create function public.catalog_home_topics(p_locale text)
returns table (slug text, name text, description text)
language sql
stable
security definer
set search_path = ''
as $$
  select l.slug, l.name, l.description
  from public.topic_localizations l
  join public.topics t on t.id = l.topic_id
  where l.locale = p_locale
    and t.status = 'published'
    and public.catalog_has_visible_book('topic', t.id, p_locale)
  order by l.name;
$$;

revoke execute on function public.catalog_home_hero() from public;
grant execute on function public.catalog_home_hero() to anon, authenticated;
revoke execute on function public.catalog_home_topics(text) from public;
grant execute on function public.catalog_home_topics(text) to anon, authenticated;
