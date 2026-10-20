-- S13 reader questions (spec sections 5 and 6). Private to the asker and admins. EB035 = cap.

create table public.reader_questions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  book_id uuid references public.books(id) on delete set null,
  idea_id uuid references public.ideas(id) on delete set null,
  body text not null check (length(btrim(body)) between 1 and 500 and body !~* '</?[a-z][^>]*>'),
  locale text not null check (locale in ('vi', 'en')),
  status text not null default 'new' check (status in ('new', 'answered', 'archived')),
  answer_idea_id uuid references public.ideas(id) on delete set null,
  answered_at timestamptz,
  notified_at timestamptz,
  created_at timestamptz not null default now(),
  check (book_id is not null or idea_id is not null),
  check ((status = 'answered') = (answer_idea_id is not null))
);
create index reader_questions_status_idx on public.reader_questions (status, created_at);
create index reader_questions_unnotified_idx on public.reader_questions (answer_idea_id) where notified_at is null;

alter table public.reader_questions enable row level security;
revoke all on public.reader_questions from public, anon, authenticated;
grant select on public.reader_questions to authenticated;
create policy "asker reads own questions" on public.reader_questions
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = reader_questions.profile_id and p.auth_user_id = (select auth.uid())));
create policy "admin reads questions" on public.reader_questions
  for select to authenticated using (public.is_admin());

create function public.submit_reader_question(p_book_id uuid, p_idea_id uuid, p_body text, p_locale text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_profile_id uuid; v_id uuid;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'submit_reader_question: no profile for the current session' using errcode = 'P0002';
  end if;
  if p_book_id is null and p_idea_id is null then
    raise exception 'submit_reader_question: a question needs a book or an idea' using errcode = '22023';
  end if;
  if p_body is null or length(btrim(p_body)) < 1 or length(btrim(p_body)) > 500 or p_body ~* '</?[a-z][^>]*>' then
    raise exception 'submit_reader_question: body must be 1..500 characters of plain text' using errcode = '22023';
  end if;
  if p_locale is null or p_locale not in ('vi', 'en') then
    raise exception 'submit_reader_question: unsupported locale' using errcode = '22023';
  end if;
  if p_book_id is not null and not exists (select 1 from public.books b where b.id = p_book_id and b.status = 'published') then
    raise exception 'submit_reader_question: book % is not published', p_book_id using errcode = 'P0002';
  end if;
  if p_idea_id is not null and not exists (select 1 from public.ideas i where i.id = p_idea_id and i.status = 'published') then
    raise exception 'submit_reader_question: idea % is not published', p_idea_id using errcode = 'P0002';
  end if;
  -- Lock the profile row so two concurrent submits cannot both pass the cap.
  perform 1 from public.profiles where id = v_profile_id for update;
  if (select count(*) from public.reader_questions q where q.profile_id = v_profile_id and q.status = 'new') >= 5 then
    raise exception 'submit_reader_question: the caller already has 5 open questions' using errcode = 'EB035';
  end if;
  insert into public.reader_questions (profile_id, book_id, idea_id, body, locale)
  values (v_profile_id, p_book_id, p_idea_id, btrim(p_body), p_locale)
  returning id into v_id;
  return v_id;
end;
$$;

create function public.get_my_reader_questions()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', q.id, 'body', q.body, 'locale', q.locale, 'status', q.status, 'createdAt', q.created_at,
    'target', case
      when q.book_id is not null then jsonb_build_object('kind', 'book', 'title',
        coalesce((select bl.title from public.book_localizations bl where bl.book_id = q.book_id order by bl.locale = q.locale desc limit 1), ''))
      else jsonb_build_object('kind', 'idea', 'title',
        coalesce((select il.question from public.idea_localizations il where il.idea_id = q.idea_id order by il.locale = q.locale desc limit 1), ''))
    end,
    'answer', (
      select jsonb_build_object('slug', il.slug)
      from public.ideas i join public.idea_localizations il on il.idea_id = i.id and il.locale = q.locale
      where i.id = q.answer_idea_id and i.status = 'published')
  ) order by q.created_at desc, q.id), '[]'::jsonb)
  from public.reader_questions q
  join public.profiles p on p.id = q.profile_id
  where p.auth_user_id = auth.uid();
$$;

revoke execute on function public.submit_reader_question(uuid, uuid, text, text) from public, anon;
grant execute on function public.submit_reader_question(uuid, uuid, text, text) to authenticated;
revoke execute on function public.get_my_reader_questions() from public, anon;
grant execute on function public.get_my_reader_questions() to authenticated;
