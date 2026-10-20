-- S13 reviews (spec sections 5 and 6). Writes go only through definer RPCs; the only reader write
-- gate is an active entitlement for the book. Error codes: EB034 no entitlement.

create table public.book_reviews (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  body text not null check (length(btrim(body)) between 1 and 1000 and body !~* '</?[a-z][^>]*>'),
  locale text not null check (locale in ('vi', 'en')),
  status text not null default 'pending' check (status in ('pending', 'published', 'rejected')),
  author_reply text check (author_reply is null or (length(btrim(author_reply)) between 1 and 1000 and author_reply !~* '</?[a-z][^>]*>')),
  author_reply_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (book_id, profile_id),
  check ((author_reply is null) = (author_reply_at is null))
);
create index book_reviews_public_idx on public.book_reviews (book_id, status, published_at desc);

create trigger book_reviews_touch_updated_at
  before update on public.book_reviews
  for each row execute function public.touch_updated_at();

alter table public.book_reviews enable row level security;
revoke all on public.book_reviews from public, anon, authenticated;
grant select on public.book_reviews to anon, authenticated;

create policy "public reads published reviews of published books" on public.book_reviews
  for select to anon, authenticated
  using (status = 'published' and exists (select 1 from public.books b where b.id = book_reviews.book_id and b.status = 'published'));
create policy "owner reads own reviews" on public.book_reviews
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = book_reviews.profile_id and p.auth_user_id = (select auth.uid())));
create policy "admin reads reviews" on public.book_reviews
  for select to authenticated
  using (public.is_admin());

create function public.book_review_json(r public.book_reviews)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id, 'rating', r.rating, 'body', r.body, 'status', r.status,
    'authorReply', r.author_reply, 'authorReplyAt', r.author_reply_at,
    'publishedAt', r.published_at, 'updatedAt', r.updated_at);
$$;

create function public.submit_book_review(p_book_id uuid, p_rating integer, p_body text, p_locale text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_row public.book_reviews;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'submit_book_review: no profile for the current session' using errcode = 'P0002';
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

  insert into public.book_reviews (book_id, profile_id, rating, body, locale)
  values (p_book_id, v_profile_id, p_rating, btrim(p_body), p_locale)
  on conflict (book_id, profile_id) do update
    set rating = excluded.rating, body = excluded.body, locale = excluded.locale,
        status = 'pending', published_at = null
  returning * into v_row;
  return public.book_review_json(v_row);
end;
$$;

create function public.delete_book_review(p_book_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_profile_id uuid;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  delete from public.book_reviews where book_id = p_book_id and profile_id = v_profile_id;
  if not found then
    raise exception 'delete_book_review: no review for book %', p_book_id using errcode = 'P0002';
  end if;
end;
$$;

create function public.get_my_book_review(p_book_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.book_review_json(r)
  from public.book_reviews r
  join public.profiles p on p.id = r.profile_id
  where r.book_id = p_book_id and p.auth_user_id = auth.uid();
$$;

-- Published reviews of a published book, newest first. The reviewer is a display name only.
create function public.catalog_book_reviews(p_book_id uuid, p_limit integer)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'reviewerName', nullif(btrim(p.display_name), ''),
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
  ) r
  join public.profiles p on p.id = r.profile_id;
$$;

revoke execute on function public.submit_book_review(uuid, integer, text, text) from public, anon;
grant execute on function public.submit_book_review(uuid, integer, text, text) to authenticated;
revoke execute on function public.delete_book_review(uuid) from public, anon;
grant execute on function public.delete_book_review(uuid) to authenticated;
revoke execute on function public.get_my_book_review(uuid) from public, anon;
grant execute on function public.get_my_book_review(uuid) to authenticated;
revoke execute on function public.catalog_book_reviews(uuid, integer) from public;
grant execute on function public.catalog_book_reviews(uuid, integer) to anon, authenticated;
revoke execute on function public.book_review_json(public.book_reviews) from public, anon, authenticated;

-- catalog_book_page: reviewSummary. Body otherwise identical to S14's 20260928100000 version.
create or replace function public.catalog_book_page(p_locale text, p_slug text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'bookId', b.id,
    'description', bl.description,
    'audience', bl.audience,
    'keyIdeas', bl.key_ideas,
    'faq', bl.faq,
    'seoTitle', bl.seo_title,
    'seoDescription', bl.seo_description,
    'alternateSlug', (select other.slug from public.book_localizations other where other.book_id = b.id and other.locale <> bl.locale),
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
$$;
