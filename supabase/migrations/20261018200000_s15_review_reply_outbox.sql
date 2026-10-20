-- S15 review reply email (spec 2026-10-09-s15). The reviewer is emailed once per distinct author
-- reply on a published review. Queued by a BEFORE UPDATE trigger so the revision bump happens
-- once; claimable only while the review is published with a reply, as a question row is only
-- claimable while its idea is published.

alter table public.book_reviews
  add column author_reply_notified_text text;
-- A reply written before S15 counts as already notified, so a later republish does not mail the
-- reader about a reply that may be months old.
update public.book_reviews set author_reply_notified_text = author_reply where author_reply is not null;

-- Outbox: fourth target. Not unique: a review may be mailed again after its reply changes.
alter table public.notification_outbox
  add column review_id uuid references public.book_reviews(id) on delete cascade;
create index notification_outbox_review_idx on public.notification_outbox (review_id) where review_id is not null;
alter table public.notification_outbox
  drop constraint notification_outbox_template_key_check,
  add constraint notification_outbox_template_key_check
    check (template_key in ('book_ready', 'gift_claim', 'question_answered', 'review_replied')),
  drop constraint notification_outbox_target_check,
  add constraint notification_outbox_target_check
    check ((entitlement_id is not null)::int + (gift_id is not null)::int + (question_id is not null)::int + (review_id is not null)::int = 1);

-- Queue trigger. BEFORE, so author_reply_notified_text rides the same row write and the S13
-- revision trigger bumps once. Each new reply text replaces every waiting row the worker does not
-- hold with one fresh row: a never-claimed row is simply superseded, a failed or exhausted one
-- would retry under the old idempotency key (or never), and leaving it would keep a stuck finding
-- up after the new row is delivered. A leased row may be mid-send with the old text, so it is left
-- alone and the fresh row carries the edit.
--
-- The DELETE is what serializes this against claim_notification_outbox: it row-locks what it
-- removes and re-checks lease_token after waiting on a claim that got there first, while the claim
-- skips (skip locked) a row this transaction holds until it commits.
create function public.book_reviews_notify_on_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'published'
     and new.author_reply is not null
     and new.author_reply is distinct from new.author_reply_notified_text then
    new.author_reply_notified_text := new.author_reply;
    delete from public.notification_outbox o
    where o.review_id = new.id and o.sent_at is null and o.lease_token is null;
    insert into public.notification_outbox (review_id, profile_id, template_key, payload)
    values (new.id, new.profile_id, 'review_replied', jsonb_build_object('bookId', new.book_id));
  end if;
  return new;
end;
$$;
revoke execute on function public.book_reviews_notify_on_reply() from public, anon, authenticated;
create trigger book_reviews_notify_on_reply
  before update of author_reply, author_reply_at, status on public.book_reviews
  for each row execute function public.book_reviews_notify_on_reply();

-- The return type changes, so the function is dropped and recreated. Everything else is the live
-- 20260928190000 definition verbatim; the review branch mirrors the question branch's "only while
-- the thing to link is visible" rule. The review page 404s unless the book is published with a
-- localization, so a hidden book's row waits, uncharged, too.
drop function public.claim_notification_outbox(integer, uuid);
create function public.claim_notification_outbox(p_limit integer, p_lease_token uuid)
returns table (
  id uuid,
  entitlement_id uuid,
  profile_id uuid,
  gift_id uuid,
  question_id uuid,
  review_id uuid,
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
    left join public.book_reviews r on r.id = o.review_id
    where o.sent_at is null
      and o.available_at <= now()
      and (o.lease_token is null or o.lease_expires_at <= now())
      and o.attempt_count < 6
      and (
        (o.entitlement_id is not null and e.status = 'active')
        or (o.gift_id is not null and g.status = 'sent')
        or (o.question_id is not null and q.status = 'answered' and i.status = 'published'
          and o.payload ->> 'ideaId' = q.answer_idea_id::text)
        or (o.review_id is not null and r.status = 'published' and r.author_reply is not null
          and exists (select 1 from public.books b join public.book_localizations bl on bl.book_id = b.id
                      where b.id = r.book_id and b.status = 'published'))
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
  returning o.id, o.entitlement_id, o.profile_id, o.gift_id, o.question_id, o.review_id, o.template_key, o.payload,
            o.attempt_count, o.delivery_generation;
end;
$$;
revoke execute on function public.claim_notification_outbox(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_notification_outbox(integer, uuid) to service_role;

-- Admin list: when the reply email last went out. jsonb return, so create or replace is enough.
create or replace function public.admin_list_reviews(p_status text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when not public.is_admin() then null else coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'bookId', r.book_id, 'revision', r.revision,
      'bookTitle', coalesce((select bl.title from public.book_localizations bl where bl.book_id = r.book_id order by bl.locale = r.locale desc limit 1), r.book_id::text),
      'reviewerName', r.reviewer_name,
      'rating', r.rating, 'body', r.body, 'locale', r.locale, 'status', r.status,
      'authorReply', r.author_reply, 'createdAt', r.created_at, 'publishedAt', r.published_at,
      'replyEmailedAt', (select max(o.sent_at) from public.notification_outbox o where o.review_id = r.id)
    ) order by r.created_at desc, r.id)
    from (select * from public.book_reviews where status = p_status order by created_at desc limit 200) r
  ), '[]'::jsonb) end;
$$;
