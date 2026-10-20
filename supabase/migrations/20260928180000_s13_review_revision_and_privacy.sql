-- A moderator approves the version displayed, never an edit submitted after the page loaded.
-- Public reads expose only catalog_book_reviews; raw rows remain private to the owner/admin.
revoke select on public.book_reviews from anon;
drop policy "public reads published reviews of published books" on public.book_reviews;

alter table public.book_reviews add column revision bigint not null default 1;
create function public.increment_book_review_revision()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.revision := old.revision + 1;
  return new;
end;
$$;
revoke execute on function public.increment_book_review_revision() from public, anon, authenticated;
create trigger book_reviews_revision before update on public.book_reviews
for each row execute function public.increment_book_review_revision();

-- The default fails closed for an older client that has not supplied a revision.
drop function public.admin_moderate_review(uuid, text);
create function public.admin_moderate_review(p_review_id uuid, p_status text, p_expected_revision bigint default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_moderate_review: caller is not an admin' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('pending', 'published', 'rejected') then
    raise exception 'admin_moderate_review: unknown status %', p_status using errcode = '22023';
  end if;
  update public.book_reviews
  set status = p_status,
      published_at = case when p_status = 'published' then coalesce(published_at, now()) else published_at end
  where id = p_review_id and revision = p_expected_revision;
  if not found then
    if exists (select 1 from public.book_reviews where id = p_review_id) then
      raise exception 'The review changed. Reload and read it before moderating.' using errcode = 'EB036';
    end if;
    raise exception 'admin_moderate_review: review % does not exist', p_review_id using errcode = 'P0002';
  end if;
  select pr.id into v_actor from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor, 'book_review.moderate', 'book_reviews', p_review_id, jsonb_build_object('status', p_status));
end;
$$;

create or replace function public.admin_list_reviews(p_status text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when not public.is_admin() then null else coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'bookId', r.book_id, 'revision', r.revision,
      'bookTitle', coalesce((select bl.title from public.book_localizations bl where bl.book_id = r.book_id order by bl.locale = r.locale desc limit 1), r.book_id::text),
      'reviewerName', r.reviewer_name,
      'rating', r.rating, 'body', r.body, 'locale', r.locale, 'status', r.status,
      'authorReply', r.author_reply, 'createdAt', r.created_at, 'publishedAt', r.published_at
    ) order by r.created_at desc, r.id)
    from (select * from public.book_reviews where status = p_status order by created_at desc limit 200) r
  ), '[]'::jsonb) end;
$$;


revoke execute on function public.admin_moderate_review(uuid, text, bigint) from public, anon;
grant execute on function public.admin_moderate_review(uuid, text, bigint) to authenticated;
