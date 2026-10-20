-- Press edition reviews (Task 7).
--
-- A review says which translation was read: it attaches to the edition the reviewer holds, and a
-- reader who owns English and Japanese can review each. The work-level rating on the book page is
-- the roll-up of its editions' published reviews; every public review names its language.
--
-- The work-level entry points keep their names and gain an optional edition. A reader who holds
-- exactly one edition of the work needs to say nothing; one who holds several must name one (EB042).

alter table public.book_reviews drop constraint book_reviews_book_id_profile_id_key;
create unique index book_reviews_profile_edition_key on public.book_reviews (profile_id, edition_id) where edition_id is not null;
create unique index book_reviews_profile_book_unmapped_key on public.book_reviews (profile_id, book_id) where edition_id is null;

-- Which edition a review call is about. Explicit wins (and must belong to the book); otherwise the
-- reader's only candidate edition, counting held editions and editions they already reviewed (so a
-- reviewer whose access was revoked can still read or delete their review). Null means none.
create function public.press_review_edition(p_profile_id uuid, p_book_id uuid, p_edition_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_candidates uuid[];
begin
  if p_edition_id is not null then
    if not exists (select 1 from public.editions e where e.id = p_edition_id and e.book_id = p_book_id) then
      raise exception 'press_review_edition: edition % is not an edition of book %', p_edition_id, p_book_id using errcode = 'P0002';
    end if;
    return p_edition_id;
  end if;

  select coalesce(array_agg(distinct c.edition_id), '{}') into v_candidates
  from (
    select en.edition_id from public.entitlements en
    where en.profile_id = p_profile_id and en.book_id = p_book_id and en.status = 'active' and en.edition_id is not null
    union
    select r.edition_id from public.book_reviews r
    where r.profile_id = p_profile_id and r.book_id = p_book_id and r.edition_id is not null
  ) c;

  if cardinality(v_candidates) > 1 then
    raise exception 'press_review_edition: book % has several editions for this reader; name one', p_book_id using errcode = 'EB042';
  end if;
  return v_candidates[1];
end;
$$;
revoke all on function public.press_review_edition(uuid, uuid, uuid) from public, anon, authenticated;

drop function public.submit_book_review(uuid, integer, text, text);
create function public.submit_book_review(p_book_id uuid, p_rating integer, p_body text, p_locale text, p_edition_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_reviewer_name text;
  v_edition_id uuid;
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

  v_edition_id := public.press_review_edition(v_profile_id, p_book_id, p_edition_id);
  if v_edition_id is null or not exists (
    select 1 from public.entitlements en
    where en.profile_id = v_profile_id and en.edition_id = v_edition_id and en.status = 'active'
  ) then
    raise exception 'submit_book_review: the caller holds no active entitlement for this edition of book %', p_book_id using errcode = 'EB034';
  end if;

  insert into public.book_reviews (book_id, edition_id, profile_id, rating, body, locale, reviewer_name)
  values (p_book_id, v_edition_id, v_profile_id, p_rating, btrim(p_body), p_locale, v_reviewer_name)
  on conflict (profile_id, edition_id) where edition_id is not null do update
    set rating = excluded.rating, body = excluded.body, locale = excluded.locale,
        reviewer_name = excluded.reviewer_name,
        status = 'pending', published_at = null
  returning * into v_row;
  return public.book_review_json(v_row);
end;
$$;
revoke all on function public.submit_book_review(uuid, integer, text, text, uuid) from public, anon;
grant execute on function public.submit_book_review(uuid, integer, text, text, uuid) to authenticated, service_role;

drop function public.get_my_book_review(uuid);
create function public.get_my_book_review(p_book_id uuid, p_edition_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_edition_id uuid;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    return null;
  end if;
  v_edition_id := public.press_review_edition(v_profile_id, p_book_id, p_edition_id);
  if v_edition_id is null then
    return null;
  end if;
  return (
    select public.book_review_json(r) from public.book_reviews r
    where r.profile_id = v_profile_id and r.edition_id = v_edition_id
  );
end;
$$;
revoke all on function public.get_my_book_review(uuid, uuid) from public, anon;
grant execute on function public.get_my_book_review(uuid, uuid) to authenticated, service_role;

drop function public.delete_book_review(uuid);
create function public.delete_book_review(p_book_id uuid, p_edition_id uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_edition_id uuid;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  v_edition_id := public.press_review_edition(v_profile_id, p_book_id, p_edition_id);
  delete from public.book_reviews where profile_id = v_profile_id and edition_id = v_edition_id;
  if not found then
    raise exception 'delete_book_review: no review for book %', p_book_id using errcode = 'P0002';
  end if;
end;
$$;
revoke all on function public.delete_book_review(uuid, uuid) from public, anon;
grant execute on function public.delete_book_review(uuid, uuid) to authenticated, service_role;

-- Public reviews name the edition they are about. The work still shows the roll-up of its editions.
create or replace function public.catalog_book_reviews(p_book_id uuid, p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'reviewerName', r.reviewer_name,
    'rating', r.rating,
    'body', r.body,
    'authorReply', r.author_reply,
    'authorReplyAt', r.author_reply_at,
    'publishedAt', r.published_at,
    'languageCode', r.language_code
  ) order by r.published_at desc, r.id), '[]'::jsonb)
  from (
    select r.*, e.language_code from public.book_reviews r
    join public.books b on b.id = r.book_id and b.status = 'published'
    left join public.editions e on e.id = r.edition_id
    where r.book_id = p_book_id and r.status = 'published'
    order by r.published_at desc, r.id
    limit greatest(1, least(coalesce(p_limit, 5), 20))
  ) r;
$$;

-- The moderation queue says which edition each review is about.
create or replace function public.admin_list_reviews(p_status text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when not public.is_admin() then null else coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'bookId', r.book_id, 'revision', r.revision,
      'bookTitle', coalesce((select bl.title from public.book_localizations bl where bl.book_id = r.book_id order by bl.locale = r.locale desc limit 1), r.book_id::text),
      'languageCode', (select e.language_code from public.editions e where e.id = r.edition_id),
      'reviewerName', r.reviewer_name,
      'rating', r.rating, 'body', r.body, 'locale', r.locale, 'status', r.status,
      'authorReply', r.author_reply, 'createdAt', r.created_at, 'publishedAt', r.published_at,
      'replyEmailedAt', (select max(o.sent_at) from public.notification_outbox o where o.review_id = r.id)
    ) order by r.created_at desc, r.id)
    from (select * from public.book_reviews where status = p_status order by created_at desc limit 200) r
  ), '[]'::jsonb) end;
$$;
