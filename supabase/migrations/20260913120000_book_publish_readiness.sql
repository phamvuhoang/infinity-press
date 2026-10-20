-- Book visibility is a catalog decision. EPUB version transitions may move the active pointer,
-- but only publish_book makes a book and its primary author public.

create function public.book_readiness_issues(p_book_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select array_remove(array[
    case when not exists (
      select 1 from public.book_localizations bl
      where bl.book_id = p_book_id
        and length(trim(bl.title)) > 0
        and length(trim(bl.slug)) > 0
        and length(trim(coalesce(bl.description, ''))) > 0
    ) then 'missing_localization' end,
    case when not exists (
      select 1 from public.books b
      join public.authors a on a.id = b.primary_author_id
      where b.id = p_book_id
    ) then 'missing_author' end,
    case when not exists (
      select 1 from public.media_assets m
      where m.owner_type = 'book' and m.owner_id = p_book_id and m.kind = 'cover'
    ) then 'missing_cover' end,
    case when not exists (
      select 1 from public.offers o
      join public.skus s on s.id = o.sku_id
      join public.editions e on e.id = s.edition_id
      where e.book_id = p_book_id
        and o.active and s.active
        and (o.starts_at is null or o.starts_at <= now())
        and (o.ends_at is null or o.ends_at > now())
    ) then 'missing_offer' end,
    case when not exists (
      select 1 from public.books b
      join public.ebook_publications p on p.id = b.active_publication_id
      where b.id = p_book_id and p.status = 'published'
    ) then 'missing_publication' end
  ], null);
$$;

revoke execute on function public.book_readiness_issues(uuid) from public, anon, authenticated;

create function public.publish_book(p_book_id uuid)
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
    raise exception 'publish_book: caller is not an admin' using errcode = '42501';
  end if;

  perform 1 from public.books where id = p_book_id for update;
  if not found then
    raise exception 'publish_book: book % does not exist', p_book_id using errcode = 'P0002';
  end if;

  v_issues := public.book_readiness_issues(p_book_id);
  if cardinality(v_issues) > 0 then
    raise exception 'publish_book: book is not ready: %', array_to_string(v_issues, ',') using errcode = 'EB010';
  end if;

  update public.books set status = 'published' where id = p_book_id;
  update public.authors set status = 'published'
  where id = (select primary_author_id from public.books where id = p_book_id);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'publish_book', 'books', p_book_id, '{}'::jsonb);
end;
$$;

create function public.unpublish_book(p_book_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'unpublish_book: caller is not an admin' using errcode = '42501';
  end if;

  update public.books set status = 'draft' where id = p_book_id;
  if not found then
    raise exception 'unpublish_book: book % does not exist', p_book_id using errcode = 'P0002';
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'unpublish_book', 'books', p_book_id, '{}'::jsonb);
end;
$$;

revoke execute on function public.publish_book(uuid) from public, anon;
grant execute on function public.publish_book(uuid) to authenticated;
revoke execute on function public.unpublish_book(uuid) from public, anon;
grant execute on function public.unpublish_book(uuid) to authenticated;

-- Keep the publication lifecycle separate from catalog visibility. Replacing this function keeps
-- its existing authenticated EXECUTE grant.
create or replace function public.publish_publication(p_publication_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_book_id uuid;
  v_asset_id uuid;
  v_status public.publication_status;
  v_previous_active_id uuid;
  v_previous_asset_id uuid;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'publish_publication: caller is not an admin' using errcode = '42501';
  end if;

  select e.book_id into v_book_id
  from public.ebook_publications p
  join public.ebook_assets a on a.id = p.ebook_asset_id
  join public.editions e on e.id = a.edition_id
  where p.id = p_publication_id;

  if v_book_id is null then
    raise exception 'publish_publication: publication % does not exist', p_publication_id using errcode = 'P0002';
  end if;

  select active_publication_id into v_previous_active_id
  from public.books
  where id = v_book_id
  for update;

  select p.status, a.id into v_status, v_asset_id
  from public.ebook_publications p
  join public.ebook_assets a on a.id = p.ebook_asset_id
  where p.id = p_publication_id
  for update of p, a;

  if v_status <> 'ready_for_preview' then
    raise exception 'publish_publication: publication % is % and cannot be published', p_publication_id, v_status
      using errcode = 'EB002';
  end if;

  if v_previous_active_id is not null then
    select p.ebook_asset_id into v_previous_asset_id
    from public.ebook_publications p
    join public.ebook_assets a on a.id = p.ebook_asset_id
    join public.editions e on e.id = a.edition_id
    where p.id = v_previous_active_id
      and e.book_id = v_book_id;

    if v_previous_asset_id is not null then
      update public.ebook_publications set status = 'superseded' where id = v_previous_active_id;
      update public.ebook_assets set status = 'superseded' where id = v_previous_asset_id;
    end if;
  end if;

  update public.ebook_publications set status = 'published' where id = p_publication_id;
  update public.ebook_assets set status = 'published' where id = v_asset_id;
  update public.books set active_publication_id = p_publication_id where id = v_book_id;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (
    v_actor_profile_id,
    'publish_publication',
    'ebook_publications',
    p_publication_id,
    jsonb_build_object('book_id', v_book_id, 'previous_active_publication_id', v_previous_active_id)
  );
end;
$$;

-- A rollback is also an EPUB version transition. It may replace the active publication but never
-- changes the catalog visibility chosen by publish_book.
create or replace function public.rollback_publication(p_book_id uuid, p_publication_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actual_book_id uuid;
  v_asset_id uuid;
  v_status public.publication_status;
  v_current_active_id uuid;
  v_current_active_asset_id uuid;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'rollback_publication: caller is not an admin' using errcode = '42501';
  end if;

  select active_publication_id into v_current_active_id
  from public.books
  where id = p_book_id
  for update;

  if not found then
    raise exception 'rollback_publication: book % does not exist', p_book_id using errcode = 'P0002';
  end if;

  select e.book_id, p.status, a.id
  into v_actual_book_id, v_status, v_asset_id
  from public.ebook_publications p
  join public.ebook_assets a on a.id = p.ebook_asset_id
  join public.editions e on e.id = a.edition_id
  where p.id = p_publication_id
  for update of p, a;

  if v_actual_book_id is null then
    raise exception 'rollback_publication: publication % does not exist', p_publication_id using errcode = 'P0002';
  end if;

  if v_actual_book_id <> p_book_id then
    raise exception 'rollback_publication: publication % does not belong to book %', p_publication_id, p_book_id
      using errcode = 'EB003';
  end if;

  if v_status <> 'superseded' then
    raise exception 'rollback_publication: publication % is % and is not eligible for rollback', p_publication_id, v_status
      using errcode = 'EB002';
  end if;

  if v_current_active_id is not null and v_current_active_id <> p_publication_id then
    select p.ebook_asset_id into v_current_active_asset_id
    from public.ebook_publications p
    join public.ebook_assets a on a.id = p.ebook_asset_id
    join public.editions e on e.id = a.edition_id
    where p.id = v_current_active_id
      and e.book_id = p_book_id;

    if v_current_active_asset_id is not null then
      update public.ebook_publications set status = 'superseded' where id = v_current_active_id;
      update public.ebook_assets set status = 'superseded' where id = v_current_active_asset_id;
    end if;
  end if;

  update public.ebook_publications set status = 'published' where id = p_publication_id;
  update public.ebook_assets set status = 'published' where id = v_asset_id;
  update public.books set active_publication_id = p_publication_id where id = p_book_id;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (
    v_actor_profile_id,
    'rollback_publication',
    'ebook_publications',
    p_publication_id,
    jsonb_build_object('book_id', p_book_id, 'previous_active_publication_id', v_current_active_id)
  );
end;
$$;
