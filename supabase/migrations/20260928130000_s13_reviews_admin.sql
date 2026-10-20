-- S13 review moderation (spec section 6). Each RPC: is_admin() first, one mutation, one audit row.

create function public.admin_list_reviews(p_status text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when not public.is_admin() then null else coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'bookId', r.book_id,
      'bookTitle', coalesce((select bl.title from public.book_localizations bl where bl.book_id = r.book_id order by bl.locale = r.locale desc limit 1), r.book_id::text),
      'reviewerName', nullif(btrim(p.display_name), ''),
      'rating', r.rating, 'body', r.body, 'locale', r.locale, 'status', r.status,
      'authorReply', r.author_reply, 'createdAt', r.created_at, 'publishedAt', r.published_at
    ) order by r.created_at desc, r.id)
    from (select * from public.book_reviews where status = p_status order by created_at desc limit 200) r
    join public.profiles p on p.id = r.profile_id
  ), '[]'::jsonb) end;
$$;

create function public.admin_moderate_review(p_review_id uuid, p_status text)
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
  where id = p_review_id;
  if not found then
    raise exception 'admin_moderate_review: review % does not exist', p_review_id using errcode = 'P0002';
  end if;
  select pr.id into v_actor from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor, 'book_review.moderate', 'book_reviews', p_review_id, jsonb_build_object('status', p_status));
end;
$$;

create function public.admin_reply_review(p_review_id uuid, p_reply text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; v_reply text := nullif(btrim(coalesce(p_reply, '')), '');
begin
  if not public.is_admin() then
    raise exception 'admin_reply_review: caller is not an admin' using errcode = '42501';
  end if;
  if v_reply is not null and (length(v_reply) > 1000 or v_reply ~* '</?[a-z][^>]*>') then
    raise exception 'admin_reply_review: reply must be 1..1000 characters of plain text' using errcode = '22023';
  end if;
  update public.book_reviews
  set author_reply = v_reply, author_reply_at = case when v_reply is null then null else now() end
  where id = p_review_id;
  if not found then
    raise exception 'admin_reply_review: review % does not exist', p_review_id using errcode = 'P0002';
  end if;
  select pr.id into v_actor from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor, 'book_review.reply', 'book_reviews', p_review_id, jsonb_build_object('cleared', v_reply is null));
end;
$$;

revoke execute on function public.admin_list_reviews(text) from public, anon;
grant execute on function public.admin_list_reviews(text) to authenticated;
revoke execute on function public.admin_moderate_review(uuid, text) from public, anon;
grant execute on function public.admin_moderate_review(uuid, text) to authenticated;
revoke execute on function public.admin_reply_review(uuid, text) from public, anon;
grant execute on function public.admin_reply_review(uuid, text) to authenticated;
