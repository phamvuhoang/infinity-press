-- S13 review reviewer name snapshot. The public reviewer name was read live from
-- profiles.display_name, which the reader can change after a moderator published the review.
-- submit_book_review now snapshots the name (trimmed, at most 80 characters, null when it contains
-- tag syntax) so a moderator approves exactly the name the public sees; every edit re-takes it and
-- returns the review to pending.

alter table public.book_reviews
  add column reviewer_name text
  check (reviewer_name is null or (length(reviewer_name) between 1 and 80 and reviewer_name !~* '</?[a-z][^>]*>'));

update public.book_reviews r
set reviewer_name = case when s.name ~* '</?[a-z][^>]*>' then null else s.name end
from (
  select p.id, left(nullif(btrim(p.display_name), ''), 80) as name from public.profiles p
) s
where s.id = r.profile_id and r.reviewer_name is null;

-- Body otherwise identical to 20260928120000.
create or replace function public.submit_book_review(p_book_id uuid, p_rating integer, p_body text, p_locale text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
  if p_locale is null or p_locale not in ('vi', 'en') then
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
$$;

-- Published reviews of a published book, newest first. The reviewer is the snapshot name only.
create or replace function public.catalog_book_reviews(p_book_id uuid, p_limit integer)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'reviewerName', r.reviewer_name,
    'rating', r.rating,
    'body', r.body,
    'authorReply', r.author_reply,
    'authorReplyAt', r.author_reply_at,
    'publishedAt', r.published_at
  ) order by r.published_at desc, r.id), '[]'::jsonb)
  from (
    select r.* from public.book_reviews r
    join public.books b on b.id = r.book_id and b.status = 'published'
    where r.book_id = p_book_id and r.status = 'published'
    order by r.published_at desc, r.id
    limit greatest(1, least(coalesce(p_limit, 5), 20))
  ) r;
$$;

-- Body otherwise identical to 20260928130000.
create or replace function public.admin_list_reviews(p_status text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when not public.is_admin() then null else coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'bookId', r.book_id,
      'bookTitle', coalesce((select bl.title from public.book_localizations bl where bl.book_id = r.book_id order by bl.locale = r.locale desc limit 1), r.book_id::text),
      'reviewerName', r.reviewer_name,
      'rating', r.rating, 'body', r.body, 'locale', r.locale, 'status', r.status,
      'authorReply', r.author_reply, 'createdAt', r.created_at, 'publishedAt', r.published_at
    ) order by r.created_at desc, r.id)
    from (select * from public.book_reviews where status = p_status order by created_at desc limit 200) r
  ), '[]'::jsonb) end;
$$;

revoke execute on function public.submit_book_review(uuid, integer, text, text) from public, anon;
grant execute on function public.submit_book_review(uuid, integer, text, text) to authenticated;
revoke execute on function public.catalog_book_reviews(uuid, integer) from public;
grant execute on function public.catalog_book_reviews(uuid, integer) to anon, authenticated;
revoke execute on function public.admin_list_reviews(text) from public, anon;
grant execute on function public.admin_list_reviews(text) to authenticated;
