-- Serialize linking with publication, and keep unsent notifications aligned with the answer.
-- Sent rows remain immutable: relinking never sends a second answer email.
-- A persistent marker survives worker failures and the documented operator retry reset.
-- Once claimed, a question payload may already be accepted by the provider. Never change it.
alter table public.notification_outbox
  add column question_delivery_started boolean not null default false;
update public.notification_outbox
set question_delivery_started = true
where question_id is not null and (lease_token is not null or attempt_count > 0 or sent_at is not null);

create or replace function public.admin_answer_question(p_question_id uuid, p_idea_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_question public.reader_questions;
  v_outbox public.notification_outbox;
  v_published boolean;
begin
  if not public.is_admin() then
    raise exception 'admin_answer_question: caller is not an admin' using errcode = '42501';
  end if;
  -- Always lock idea -> question -> outbox, matching the publish trigger. In READ COMMITTED,
  -- a linker waiting for publish then sees its committed status; a publisher waiting for the
  -- linker sees the committed question. Neither side can miss the other transaction.
  -- NO KEY UPDATE permits the FK key-share read used by create-answer on the asked idea.
  select status = 'published' into v_published from public.ideas where id = p_idea_id for no key update;
  if not found then
    raise exception 'admin_answer_question: idea % does not exist', p_idea_id using errcode = 'P0002';
  end if;
  select * into v_question from public.reader_questions where id = p_question_id for update;
  if not found or v_question.status not in ('new', 'answered') then
    raise exception 'admin_answer_question: question is missing or archived' using errcode = 'P0002';
  end if;
  select * into v_outbox from public.notification_outbox where question_id = p_question_id for update;
  if v_question.answer_idea_id is distinct from p_idea_id and v_outbox.sent_at is null
      and v_outbox.question_delivery_started then
    -- A lease or previous failed attempt may have reached the provider. Keep the payload
    -- immutable across ambiguous failures, even after fail_notification_outbox clears the lease.
    -- Let the worker recover it with the same idempotency key before changing the answer.
    raise exception 'The answer email is being delivered. Try again after delivery finishes.' using errcode = 'EB037';
  end if;
  if v_question.answer_idea_id is distinct from p_idea_id and v_outbox.sent_at is null then
    update public.notification_outbox
    set payload = jsonb_build_object('ideaId', p_idea_id), available_at = now(),
        attempt_count = 0, last_error_code = null
    where id = v_outbox.id;
  end if;
  update public.reader_questions
  set status = 'answered', answer_idea_id = p_idea_id, answered_at = coalesce(answered_at, now()), notified_at = null
  where id = p_question_id and status in ('new', 'answered');
  if not found then
    raise exception 'admin_answer_question: question % is missing or archived', p_question_id using errcode = 'P0002';
  end if;
  -- The publish trigger only fires on a status change, so an idea that is already published is
  -- mailed about now.
  if v_published then
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


-- A replacement draft waits for publication without consuming the six delivery attempts.
create or replace function public.claim_notification_outbox(p_limit integer, p_lease_token uuid)
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
    left join public.reader_questions q on q.id = o.question_id
    left join public.ideas i on i.id = q.answer_idea_id
    where o.sent_at is null
      and o.available_at <= now()
      and (o.lease_token is null or o.lease_expires_at <= now())
      and o.attempt_count < 6
      and (
        (o.entitlement_id is not null and e.status = 'active')
        or (o.gift_id is not null and g.status = 'sent')
        or (o.question_id is not null and q.status = 'answered' and i.status = 'published'
          and o.payload ->> 'ideaId' = q.answer_idea_id::text)
      )
    order by o.available_at, o.created_at, o.id
    limit v_limit
    for update of o skip locked
  )
  update public.notification_outbox o
  set lease_token = p_lease_token,
      lease_expires_at = v_lease_expires,
      question_delivery_started = o.question_delivery_started or o.question_id is not null
  from candidates
  where o.id = candidates.id
  returning o.id, o.entitlement_id, o.profile_id, o.gift_id, o.question_id, o.template_key, o.payload,
            o.attempt_count, o.delivery_generation;
end;
$$;
revoke execute on function public.claim_notification_outbox(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_notification_outbox(integer, uuid) to service_role;
