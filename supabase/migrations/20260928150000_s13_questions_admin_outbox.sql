-- S13 question answering (spec section 6) and the answer notification (spec section 9).

-- Outbox: third target ----------------------------------------------------------------------------
-- notification_outbox_book_ready_profile_check (gift_id is not null or profile_id is not null) still
-- holds unchanged: a question row always carries the asker's profile.
alter table public.notification_outbox
  add column question_id uuid unique references public.reader_questions(id) on delete cascade;
alter table public.notification_outbox
  drop constraint notification_outbox_template_key_check,
  add constraint notification_outbox_template_key_check
    check (template_key in ('book_ready', 'gift_claim', 'question_answered')),
  drop constraint notification_outbox_target_check,
  add constraint notification_outbox_target_check
    check ((entitlement_id is not null)::int + (gift_id is not null)::int + (question_id is not null)::int = 1);

-- The return type changes, so the function is dropped and recreated (which also drops its grants).
-- Everything else is the live 20260925100000 definition verbatim: the 25-row cap, the 5-minute lease,
-- the 6-attempt cap, the ordering, and the entitlement/gift eligibility. A question row is eligible
-- whenever it is pending; the worker resolves the idea's localized URL at send time.
drop function public.claim_notification_outbox(integer, uuid);
create function public.claim_notification_outbox(p_limit integer, p_lease_token uuid)
returns table (
  id uuid,
  entitlement_id uuid,
  profile_id uuid,
  gift_id uuid,
  question_id uuid,
  template_key text,
  payload jsonb,
  attempt_count integer,
  delivery_generation integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 25));
  v_lease_expires timestamptz := now() + interval '5 minutes';
begin
  return query
  with candidates as (
    select o.id
    from public.notification_outbox o
    left join public.entitlements e on e.id = o.entitlement_id
    left join public.gifts g on g.id = o.gift_id
    where o.sent_at is null
      and o.available_at <= now()
      and (o.lease_token is null or o.lease_expires_at <= now())
      and o.attempt_count < 6
      and (
        (o.entitlement_id is not null and e.status = 'active')
        or (o.gift_id is not null and g.status = 'sent')
        or (o.question_id is not null)
      )
    order by o.available_at, o.created_at, o.id
    limit v_limit
    for update of o skip locked
  )
  update public.notification_outbox o
  set lease_token = p_lease_token,
      lease_expires_at = v_lease_expires
  from candidates
  where o.id = candidates.id
  returning o.id, o.entitlement_id, o.profile_id, o.gift_id, o.question_id, o.template_key, o.payload,
            o.attempt_count, o.delivery_generation;
end;
$$;
revoke execute on function public.claim_notification_outbox(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_notification_outbox(integer, uuid) to service_role;

-- Publish trigger ---------------------------------------------------------------------------------
-- One outbox row per answered, un-notified question when its answering idea becomes published.
-- notified_at stops an unpublish/republish from mailing again. `on conflict do nothing` is needed
-- as well: admin_answer_question clears notified_at on a relink, so a question that was already
-- mailed and is then relinked to a draft idea reaches here again when that idea is published, and
-- question_id is unique. Without it the publish itself would fail with 23505.
create function public.reader_questions_notify_on_publish()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'published' and old.status is distinct from 'published' then
    with due as (
      update public.reader_questions q
      set notified_at = now()
      where q.answer_idea_id = new.id and q.status = 'answered' and q.notified_at is null
      returning q.id, q.profile_id
    )
    insert into public.notification_outbox (question_id, profile_id, template_key, payload)
    select due.id, due.profile_id, 'question_answered', jsonb_build_object('ideaId', new.id)
    from due
    on conflict (question_id) do nothing;
  end if;
  return new;
end;
$$;
create trigger reader_questions_notify_on_publish
  after update of status on public.ideas
  for each row execute function public.reader_questions_notify_on_publish();

-- Admin RPCs --------------------------------------------------------------------------------------
create function public.admin_list_questions(p_status text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when not public.is_admin() then null else coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', q.id, 'body', q.body, 'locale', q.locale, 'status', q.status, 'createdAt', q.created_at,
      'askerName', nullif(btrim(p.display_name), ''),
      'bookId', q.book_id,
      'bookTitle', (select bl.title from public.book_localizations bl where bl.book_id = q.book_id order by bl.locale = q.locale desc limit 1),
      'ideaId', q.idea_id,
      'ideaQuestion', (select il.question from public.idea_localizations il where il.idea_id = q.idea_id order by il.locale = q.locale desc limit 1),
      'answerIdeaId', q.answer_idea_id
    ) order by q.created_at asc, q.id)
    from (select * from public.reader_questions where status = p_status order by created_at, id limit 200) q
    join public.profiles p on p.id = q.profile_id
  ), '[]'::jsonb) end;
$$;

create function public.admin_archive_question(p_question_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_archive_question: caller is not an admin' using errcode = '42501';
  end if;
  update public.reader_questions set status = 'archived' where id = p_question_id and status = 'new';
  if not found then
    if exists (select 1 from public.reader_questions where id = p_question_id) then
      raise exception 'admin_archive_question: only a new question can be archived' using errcode = '22023';
    end if;
    raise exception 'admin_archive_question: question % does not exist', p_question_id using errcode = 'P0002';
  end if;
  -- Ids only: the question body never enters audit_logs.
  select pr.id into v_actor from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id)
  values (v_actor, 'reader_question.archive', 'reader_questions', p_question_id);
end;
$$;

-- Links a new or already answered question to an existing idea. A relink clears notified_at, but the
-- outbox row is unique per question, so an asker is mailed at most once whatever the relinks: a
-- question already mailed about its first answer is not mailed again about the second (the
-- reader's question list always shows the current answer).
create function public.admin_answer_question(p_question_id uuid, p_idea_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_answer_question: caller is not an admin' using errcode = '42501';
  end if;
  if not exists (select 1 from public.ideas where id = p_idea_id) then
    raise exception 'admin_answer_question: idea % does not exist', p_idea_id using errcode = 'P0002';
  end if;
  update public.reader_questions
  set status = 'answered', answer_idea_id = p_idea_id, answered_at = coalesce(answered_at, now()), notified_at = null
  where id = p_question_id and status in ('new', 'answered');
  if not found then
    raise exception 'admin_answer_question: question % is missing or archived', p_question_id using errcode = 'P0002';
  end if;
  -- The publish trigger only fires on a status change, so an idea that is already published is
  -- mailed about now.
  if exists (select 1 from public.ideas where id = p_idea_id and status = 'published') then
    insert into public.notification_outbox (question_id, profile_id, template_key, payload)
    select q.id, q.profile_id, 'question_answered', jsonb_build_object('ideaId', p_idea_id)
    from public.reader_questions q where q.id = p_question_id
    on conflict (question_id) do nothing;
    update public.reader_questions set notified_at = now() where id = p_question_id;
  end if;
  select pr.id into v_actor from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor, 'reader_question.answer', 'reader_questions', p_question_id, jsonb_build_object('ideaId', p_idea_id));
end;
$$;

-- Creates the answering idea (admin_create_idea writes its own create_idea audit row), relates it to
-- the question's book or, for an idea question, to the asked idea's books, links the asked idea,
-- and marks the question answered through admin_answer_question (one reader_question.answer row).
-- Only a new question: replacing an answer goes through admin_answer_question.
create function public.admin_answer_question_with_idea(
  p_question_id uuid,
  p_locale text,
  p_slug text,
  p_question text,
  p_short_answer text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_idea_id uuid;
  v_book_id uuid;
  v_asked_idea_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_answer_question_with_idea: caller is not an admin' using errcode = '42501';
  end if;
  select q.book_id, q.idea_id into v_book_id, v_asked_idea_id
  from public.reader_questions q where q.id = p_question_id and q.status = 'new'
  for update;
  if not found then
    raise exception 'admin_answer_question_with_idea: question % is not new', p_question_id using errcode = 'P0002';
  end if;

  v_idea_id := public.admin_create_idea(p_locale, p_slug, p_question, p_short_answer);

  if v_book_id is not null then
    insert into public.idea_books (idea_id, book_id, position) values (v_idea_id, v_book_id, 1);
  elsif v_asked_idea_id is not null then
    insert into public.idea_books (idea_id, book_id, position)
    select v_idea_id, ib.book_id, row_number() over (order by ib.position)
    from public.idea_books ib where ib.idea_id = v_asked_idea_id;
  end if;
  if v_asked_idea_id is not null then
    insert into public.idea_links (idea_id, related_idea_id, position) values (v_idea_id, v_asked_idea_id, 1);
  end if;

  perform public.admin_answer_question(p_question_id, v_idea_id);
  return v_idea_id;
end;
$$;

revoke execute on function public.admin_list_questions(text) from public, anon;
grant execute on function public.admin_list_questions(text) to authenticated;
revoke execute on function public.admin_archive_question(uuid) from public, anon;
grant execute on function public.admin_archive_question(uuid) to authenticated;
revoke execute on function public.admin_answer_question(uuid, uuid) from public, anon;
grant execute on function public.admin_answer_question(uuid, uuid) to authenticated;
revoke execute on function public.admin_answer_question_with_idea(uuid, text, text, text, text) from public, anon;
grant execute on function public.admin_answer_question_with_idea(uuid, text, text, text, text) to authenticated;
