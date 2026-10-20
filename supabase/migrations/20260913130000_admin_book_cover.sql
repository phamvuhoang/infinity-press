-- The editor needs its current public cover key, but authenticated users must not receive
-- SELECT on media_assets.storage_key. Keep this narrowly scoped read behind an admin check.
create function public.admin_get_book_cover(p_book_id uuid)
returns table (storage_key text, alt_text text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_get_book_cover: caller is not an admin' using errcode = '42501';
  end if;

  return query
  select asset.storage_key, asset.alt_text
  from public.media_assets as asset
  where asset.owner_type = 'book' and asset.kind = 'cover' and asset.owner_id = p_book_id;
end;
$$;

revoke all on function public.admin_get_book_cover(uuid) from public, anon, authenticated, service_role;
grant execute on function public.admin_get_book_cover(uuid) to authenticated;
