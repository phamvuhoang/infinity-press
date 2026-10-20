-- Ask-the-author can be switched off per author: some authors decline it, some have passed away.
-- Default on, so every existing author keeps the current behaviour.

alter table public.authors add column accepts_questions boolean not null default true;

-- Public, cookie-less read for the book page, the reader, and the ask page. False for an unknown
-- or unpublished book, so a caller never has to distinguish "no book" from "no questions".
create function public.catalog_book_accepts_questions(p_book_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select a.accepts_questions
    from public.books b
    join public.authors a on a.id = b.primary_author_id
    where b.id = p_book_id and b.status = 'published'), false);
$$;
revoke execute on function public.catalog_book_accepts_questions(uuid) from public;
grant execute on function public.catalog_book_accepts_questions(uuid) to anon, authenticated, service_role;

-- submit_reader_question from 20260928140000_s13_questions.sql, with one change: a book whose
-- author does not take questions is not a target (P0002, the same code as an unpublished book).
create or replace function public.submit_reader_question(p_book_id uuid, p_idea_id uuid, p_body text, p_locale text)
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
  if p_book_id is not null and not public.catalog_book_accepts_questions(p_book_id) then
    raise exception 'submit_reader_question: book % is not published or does not take questions', p_book_id using errcode = 'P0002';
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
