# S15 Review Reply Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an admin writes or changes the author reply on a published review, the reviewer receives exactly one email per distinct reply text, with the reply and a link to their review page.

**Architecture:** One migration adds `book_reviews.author_reply_notified_text`, a fourth outbox target `notification_outbox.review_id`, the `review_replied` template key, a BEFORE UPDATE trigger on `book_reviews` that queues the row, and a redefined `claim_notification_outbox` that claims a review row only while the review is published with a reply. The existing worker in `lib/email/outbox.ts` gains one template branch that reads the current reply at send time. The admin list shows when the email went out, and the stuck-notification ops rule gains a third loader branch so a jammed reply email is visible.

**Tech Stack:** Next.js 16 App Router, React 19 Server Components and Server Actions, Supabase/Postgres/RLS, TypeScript, Zod, Vitest, pgTAP, Playwright, Resend via the existing mail provider.

**Spec:** `docs/superpowers/specs/2026-10-09-s15-review-reply-email-design.md`

## Spec corrections (2026-10-09)

Decided while planning against the live S13 code; the spec file is updated to match.

- **Trigger timing.** The spec sketched an AFTER trigger that updates its own row. `book_reviews_revision` is a BEFORE UPDATE trigger that bumps `revision` on every update, so a second update would bump it twice and make the admin's open moderation form stale. The trigger is BEFORE UPDATE: it sets `new.author_reply_notified_text` in the same row write, with no nested update.
- **Skip rule.** The spec said the worker marks a no-longer-visible review as sent with `last_error_code = 'skipped_not_visible'`. `complete_notification_outbox` has no error-code argument. Instead `claim_notification_outbox` claims a review row only while the review is `published` and `author_reply is not null`, as it already does for a question row's published idea. The worker's own re-check throws `review_not_visible`, which only fires in the race between claim and send, and the row is not claimed again until the review is visible.
- **One pending email per review.** The spec allowed any number of rows per review. The trigger inserts a new row only when no unsent row exists for the review; the worker reads the reply text at send time, so the latest text goes out. This is what keeps two quick edits from mailing twice.
- **Ops coverage.** The spec said the stuck-outbox finding already covers review rows. The loader reads the outbox in per-target branches, so a review branch is added; the rule name and `operations_alert_state` are unchanged.

## Global Constraints

- Read `node_modules/next/dist/docs/01-app/02-guides/server-actions.md` before touching `app/admin/reviews/actions.ts`.
- `/admin` stays unprefixed. The reviewer's landing page is the existing `/{locale}/library/reviews/[bookId]`; it is not changed.
- Every protected page and Server Action calls `requireUser()` or `requireAdmin()` itself. `lib/data/admin-reviews.ts` already does; keep it.
- The reply text is plain text, 1..1000 characters, `!~* '</?[a-z][^>]*>'` (unchanged S13 constraint). The email renders it through `escapeHtml` from `lib/email/text.ts`.
- Outbox rows carry ids only. `payload` is `{"bookId": uuid}`. Logs carry request ID, outbox ID, template key, and safe codes. Never the reply text or an address.
- Migration: `supabase/migrations/20261009100000_s15_review_reply_outbox.sql` (after `20260928200000`). pgTAP: `supabase/tests/066_s15_review_reply_outbox.sql`. Applied migrations are never edited. After the migration task, regenerate types with `npx supabase gen types typescript --local > lib/supabase/database.types.ts` against a reset local stack.
- `claim_notification_outbox` must be **dropped and recreated** (return type changes) with the live `20260928190000` body verbatim plus the review branch. Grants: revoke from `public, anon, authenticated`; grant to `service_role`.
- Dictionary keys go in both `lib/i18n/dictionaries/en.json` and `vi.json`; `lib/i18n/dictionary.test.ts` enforces parity.
- Docker context is OrbStack (`docker context use orbstack`). Use Node.js 22.14 for Playwright. Database and Playwright suites run only against a local Supabase stack per `docs/runbooks/testing-environments.md`.
- Final gate: `npm run check`, `npm run db:reset && npm run db:test`, `npm run check:full`.

## Review Focus

1. The admin writes a reply on a `pending` review, then publishes it. Exactly one email must go out, at publish. Pinned in Task 1.
2. The reader edits their review after the reply was mailed (status returns to `pending`), and the admin republishes. No second email. Pinned in Task 1.
3. The admin edits the reply twice before the worker runs. One row, and the email carries the second text. Pinned in Task 1 (row count) and Task 3 (text read at send time).
4. The reader deletes their review while a row is unsent. The row must vanish with the review (FK cascade), never be claimed, and never raise a finding. Pinned in Task 1.
5. A reviewer with no verified `customer_identities` row fails delivery with `recipient_unverified` and does not stop the batch. Pinned in Task 3.

## File Structure

| Area | Files and responsibility |
| --- | --- |
| Schema and trigger | `supabase/migrations/20261009100000_s15_review_reply_outbox.sql`, `supabase/tests/066_s15_review_reply_outbox.sql`: column, outbox target, template key, trigger, claim redefinition, `admin_list_reviews.replyEmailedAt`. |
| Email template | `lib/email/review-replied.ts` and `.test.ts`, dictionary `email.reviewReplied` in `en.json` and `vi.json`. |
| Worker | `lib/email/outbox.ts` and `.test.ts`: `ClaimedRow.review_id`, `resolveReviewRepliedDelivery`, dispatch branch. |
| Admin | `lib/data/admin-reviews.ts` (DTO field), `components/admin/reviews/review-row.tsx` and `.test.tsx` (hint and "Emailed" marker). |
| Ops | `lib/ops/types.ts` (`OutboxRow.reviewId`), `lib/ops/checks.ts` and `.test.ts` (summary and repair path), `lib/data/operations.ts` and `.test.ts` (review loader branch). |
| Verification and docs | `e2e/reader-voice.spec.ts` (extend the review journey), `docs/runbooks/reader-voice.md` §3. |

---

### Task 1: Schema, trigger, claim, and admin list

**Files:**
- Create: `supabase/migrations/20261009100000_s15_review_reply_outbox.sql`
- Create: `supabase/tests/066_s15_review_reply_outbox.sql`
- Modify: `lib/supabase/database.types.ts` (regenerate)

**Interfaces:**
- Consumes: `public.book_reviews`, `public.notification_outbox`, `public.claim_notification_outbox(integer, uuid)` as defined by `20260928190000`, `public.admin_list_reviews(text)` as defined by `20260928180000`.
- Produces: `book_reviews.author_reply_notified_text text`; `notification_outbox.review_id uuid`; template key `'review_replied'`; trigger `book_reviews_notify_on_reply`; `claim_notification_outbox` returning the extra column `review_id uuid` after `question_id`; `admin_list_reviews` rows gain `"replyEmailedAt": timestamptz | null`.

- [ ] **Step 1: Write the failing pgTAP file**

```sql
begin;
select plan(25);

-- S15 review reply email: one outbox row per distinct reply on a published review, queued by a
-- BEFORE UPDATE trigger; claimable only while the review is published with a reply; the admin
-- list reports when the email went out.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e1500000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's15-owner@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e1500000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's15-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
update public.profiles set display_name = 'Minh Anh' where auth_user_id = 'e1500000-0000-0000-0000-000000000001';
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'e1500000-0000-0000-0000-000000000002';

insert into public.authors (id, canonical_slug, display_name, status)
values ('e1530000-0000-0000-0000-000000000001', 's15-author', 'S15 Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values ('e1520000-0000-0000-0000-000000000001', 's15-book', 'vi', 'e1530000-0000-0000-0000-000000000001', 'published');
insert into public.book_localizations (book_id, locale, slug, title)
values ('e1520000-0000-0000-0000-000000000001', 'vi', 's15-book', 'Sách S15');
insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason, status)
select 'e1540000-0000-0000-0000-000000000001', p.id, 'e1520000-0000-0000-0000-000000000001', 'admin_grant', p.id, 'fixture', 'active'
from public.profiles p where p.auth_user_id = 'e1500000-0000-0000-0000-000000000001';

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1500000-0000-0000-0000-000000000001', true);
select public.submit_book_review('e1520000-0000-0000-0000-000000000001', 5, 'Cuốn sách rất hay.', 'vi');
reset role;
update public.book_reviews set id = 'e1550000-0000-0000-0000-000000000001'
where book_id = 'e1520000-0000-0000-0000-000000000001';

create or replace function pg_temp.rows_for_review() returns bigint language sql as $$
  select count(*) from public.notification_outbox where review_id = 'e1550000-0000-0000-0000-000000000001';
$$;
create or replace function pg_temp.current_revision() returns bigint language sql as $$
  select revision from public.book_reviews where id = 'e1550000-0000-0000-0000-000000000001';
$$;

-- Schema -------------------------------------------------------------------------------------------
select has_column('public', 'book_reviews', 'author_reply_notified_text', 'notified-text column exists');
select has_column('public', 'notification_outbox', 'review_id', 'review_id target exists');
select is(has_table_privilege('service_role', 'public.book_reviews', 'select'), true, 'the worker can read reviews');

-- Reply on a pending review: nothing yet ---------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1500000-0000-0000-0000-000000000002', true);
select lives_ok($$select public.admin_reply_review('e1550000-0000-0000-0000-000000000001', 'Cảm ơn bạn đã đọc.')$$, 'admin replies while pending');
select is(pg_temp.rows_for_review(), 0::bigint, 'a reply on a pending review queues nothing');
select is((select author_reply_notified_text from public.book_reviews where id = 'e1550000-0000-0000-0000-000000000001'), null, 'nothing recorded as notified yet');

-- Publishing with a reply present mails once -----------------------------------------------------
select lives_ok($$select public.admin_moderate_review('e1550000-0000-0000-0000-000000000001', 'published', pg_temp.current_revision())$$, 'admin publishes');
select is(pg_temp.rows_for_review(), 1::bigint, 'publish queues exactly one row');
select results_eq(
  $$select o.template_key, o.profile_id, o.payload, o.entitlement_id, o.gift_id, o.question_id
    from public.notification_outbox o where o.review_id = 'e1550000-0000-0000-0000-000000000001'$$,
  $$select 'review_replied', r.profile_id, jsonb_build_object('bookId', r.book_id), null::uuid, null::uuid, null::uuid
    from public.book_reviews r where r.id = 'e1550000-0000-0000-0000-000000000001'$$,
  'the row is addressed to the reviewer with only the book id');
select is((select author_reply_notified_text from public.book_reviews where id = 'e1550000-0000-0000-0000-000000000001'), 'Cảm ơn bạn đã đọc.', 'the queued text is recorded');

-- Same text again: nothing. Different text while a row is unsent: still one row. -----------------
select lives_ok($$select public.admin_reply_review('e1550000-0000-0000-0000-000000000001', 'Cảm ơn bạn đã đọc.')$$, 'same reply saved again');
select is(pg_temp.rows_for_review(), 1::bigint, 'identical text does not queue again');
select lives_ok($$select public.admin_reply_review('e1550000-0000-0000-0000-000000000001', 'Cảm ơn bạn đã đọc kỹ.')$$, 'reply edited before delivery');
select is(pg_temp.rows_for_review(), 1::bigint, 'an unsent row is reused rather than duplicated');
select is((select author_reply_notified_text from public.book_reviews where id = 'e1550000-0000-0000-0000-000000000001'), 'Cảm ơn bạn đã đọc kỹ.', 'the latest text is what is recorded');
reset role;

-- Claim: only while published with a reply --------------------------------------------------------
set local role service_role;
create temporary table t_claim as
select * from public.claim_notification_outbox(25, '00000000-0000-0000-0000-00000000bbbb');
reset role;
select results_eq(
  $$select review_id, template_key from t_claim where review_id = 'e1550000-0000-0000-0000-000000000001'$$,
  $$values ('e1550000-0000-0000-0000-000000000001'::uuid, 'review_replied')$$,
  'the claim returns the review row with its id');
-- Release the lease so the next claim can see the row again.
update public.notification_outbox set lease_token = null, lease_expires_at = null where review_id = 'e1550000-0000-0000-0000-000000000001';

-- A reader edit sends the review back to pending: the row is no longer claimable, and no new row.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1500000-0000-0000-0000-000000000001', true);
select public.submit_book_review('e1520000-0000-0000-0000-000000000001', 4, 'Cuốn sách rất hay, đọc lại vẫn hay.', 'vi');
reset role;
select is(pg_temp.rows_for_review(), 1::bigint, 'a reader edit queues nothing');
set local role service_role;
select is((select count(*) from public.claim_notification_outbox(25, '00000000-0000-0000-0000-00000000cccc') c where c.review_id = 'e1550000-0000-0000-0000-000000000001'), 0::bigint, 'a pending review''s row is not claimed');
reset role;

-- Republish after delivery: no second email -------------------------------------------------------
update public.notification_outbox set sent_at = now(), provider_message_id = 'test/x' where review_id = 'e1550000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1500000-0000-0000-0000-000000000002', true);
select lives_ok($$select public.admin_moderate_review('e1550000-0000-0000-0000-000000000001', 'published', pg_temp.current_revision())$$, 'admin republishes');
select is(pg_temp.rows_for_review(), 1::bigint, 'republishing an already-mailed reply queues nothing');

-- Clearing the reply: nothing. Admin list reports the sent time. ---------------------------------
select lives_ok($$select public.admin_reply_review('e1550000-0000-0000-0000-000000000001', '')$$, 'admin clears the reply');
select is(pg_temp.rows_for_review(), 1::bigint, 'clearing queues nothing');
select isnt(
  (select e ->> 'replyEmailedAt' from jsonb_array_elements(public.admin_list_reviews('published')) e where e ->> 'id' = 'e1550000-0000-0000-0000-000000000001'),
  null, 'the admin list carries the sent time');
reset role;

-- Cascade and target check ------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1500000-0000-0000-0000-000000000001', true);
select public.delete_book_review('e1520000-0000-0000-0000-000000000001');
reset role;
select is((select count(*) from public.notification_outbox where review_id = 'e1550000-0000-0000-0000-000000000001'), 0::bigint, 'deleting the review removes its outbox rows');
select throws_ok(
  $$insert into public.notification_outbox (template_key, profile_id, review_id, entitlement_id)
    values ('review_replied', (select id from public.profiles where auth_user_id = 'e1500000-0000-0000-0000-000000000001'), 'e1550000-0000-0000-0000-000000000001', 'e1540000-0000-0000-0000-000000000001')$$,
  '23514', null, 'a row cannot point at two targets');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `docker context use orbstack && npm run db:reset && npx supabase test db supabase/tests/066_s15_review_reply_outbox.sql`
Expected: FAIL at `has_column ... author_reply_notified_text`.

- [ ] **Step 3: Write the migration**

```sql
-- S15 review reply email (spec 2026-10-09-s15). The reviewer is emailed once per distinct author
-- reply on a published review. Queued by a BEFORE UPDATE trigger so the revision bump happens
-- once; claimable only while the review is published with a reply, as a question row is only
-- claimable while its idea is published.

alter table public.book_reviews
  add column author_reply_notified_text text;

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
-- revision trigger bumps once. One unsent row per review: the worker reads the reply at send
-- time, so an edit before delivery changes what is sent without a second row.
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
    if not exists (select 1 from public.notification_outbox o where o.review_id = new.id and o.sent_at is null) then
      insert into public.notification_outbox (review_id, profile_id, template_key, payload)
      values (new.id, new.profile_id, 'review_replied', jsonb_build_object('bookId', new.book_id));
    end if;
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
-- the thing to link is visible" rule.
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
        or (o.review_id is not null and r.status = 'published' and r.author_reply is not null)
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
```

- [ ] **Step 4: Run the new test and the S13 outbox tests to verify they pass**

Run: `npm run db:reset && npx supabase test db supabase/tests/066_s15_review_reply_outbox.sql supabase/tests/062_s13_questions_admin_outbox.sql supabase/tests/065_s13_answer_delivery.sql supabase/tests/060_s13_reviews_admin.sql`
Expected: all PASS. If `062` fails on the claim's column list, its `results_eq` selects named columns, so it should not; if it does, the plan has misread it and the test, not the function, is adjusted.

- [ ] **Step 5: Regenerate types and typecheck**

Run: `npx supabase gen types typescript --local > lib/supabase/database.types.ts && npm run typecheck`
Expected: typecheck fails in `lib/email/outbox.ts` only if the `Omit<...>` in `ClaimedRow` is now incomplete; that is fixed in Task 3. If it passes, continue.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261009100000_s15_review_reply_outbox.sql supabase/tests/066_s15_review_reply_outbox.sql lib/supabase/database.types.ts
git commit -m "feat(s15): queue a review_replied email when the author reply changes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Email template and dictionary copy

**Files:**
- Create: `lib/email/review-replied.ts`
- Create: `lib/email/review-replied.test.ts`
- Modify: `lib/i18n/dictionaries/en.json` (inside `"email"`), `lib/i18n/dictionaries/vi.json` (same)

**Interfaces:**
- Consumes: `escapeHtml`, `fill`, `singleLine` from `lib/email/text.ts`; `splitGraphemes` from `lib/reader/quote.ts`.
- Produces: `buildReviewRepliedEmail(input: ReviewRepliedEmailInput): { subject: string; text: string; html: string }` with `ReviewRepliedEmailInput = { locale: Locale; recipientName: string | null; bookTitle: string | null; rating: number; reviewBody: string; reply: string; reviewUrl: string }`.

- [ ] **Step 1: Add the dictionary keys**

In `en.json`, after `"questionAnswered": { ... }` inside `"email"`:

```json
    "reviewReplied": {
      "subjectWithTitle": "The author replied to your review of “{title}”",
      "subjectGeneric": "The author replied to your review",
      "greetingNamed": "Hi {name},",
      "greetingGeneric": "Hi,",
      "intro": "The author replied to the review you wrote on Infinity Books.",
      "yourReview": "Your review ({rating}/5):",
      "authorReply": "The author's reply:",
      "open": "Open your review",
      "signOff": "Happy reading,\nInfinity Books"
    }
```

In `vi.json`, same position:

```json
    "reviewReplied": {
      "subjectWithTitle": "Tác giả đã phản hồi đánh giá của bạn về “{title}”",
      "subjectGeneric": "Tác giả đã phản hồi đánh giá của bạn",
      "greetingNamed": "Chào {name},",
      "greetingGeneric": "Chào bạn,",
      "intro": "Tác giả đã phản hồi đánh giá bạn viết trên Infinity Books.",
      "yourReview": "Đánh giá của bạn ({rating}/5):",
      "authorReply": "Phản hồi từ tác giả:",
      "open": "Mở đánh giá của bạn",
      "signOff": "Chúc bạn đọc vui,\nInfinity Books"
    }
```

- [ ] **Step 2: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildReviewRepliedEmail } from "@/lib/email/review-replied";

const base = {
  locale: "vi" as const,
  recipientName: "Minh",
  bookTitle: "Sách S15",
  rating: 5,
  reviewBody: "Cuốn sách rất hay.",
  reply: "Cảm ơn bạn đã đọc.",
  reviewUrl: "https://books.example/vi/library/reviews/b1",
};

describe("buildReviewRepliedEmail", () => {
  it("renders the Vietnamese email with the title in the subject, the context, the reply and the link", () => {
    const mail = buildReviewRepliedEmail(base);
    expect(mail.subject).toBe("Tác giả đã phản hồi đánh giá của bạn về “Sách S15”");
    expect(mail.text).toContain("Chào Minh,");
    expect(mail.text).toContain("Đánh giá của bạn (5/5):\nCuốn sách rất hay.");
    expect(mail.text).toContain("Phản hồi từ tác giả:\nCảm ơn bạn đã đọc.");
    expect(mail.text).toContain("Mở đánh giá của bạn: https://books.example/vi/library/reviews/b1");
    expect(mail.html).toContain('<a href="https://books.example/vi/library/reviews/b1">');
  });

  it("uses the generic subject and greeting without a title or a name", () => {
    const mail = buildReviewRepliedEmail({ ...base, locale: "en", recipientName: "  ", bookTitle: null });
    expect(mail.subject).toBe("The author replied to your review");
    expect(mail.text).toContain("Hi,\n");
  });

  it("cuts the review context at 120 graphemes on a grapheme boundary and marks the cut", () => {
    const body = "ế".repeat(130);
    const mail = buildReviewRepliedEmail({ ...base, reviewBody: body });
    expect(mail.text).toContain(`${"ế".repeat(120)}…`);
    expect(mail.text).not.toContain("ế".repeat(121));
  });

  it("escapes the reply, the body, the title and the name in HTML", () => {
    const mail = buildReviewRepliedEmail({
      ...base,
      recipientName: "<b>Eve</b>",
      bookTitle: "<i>T</i>",
      reviewBody: "<script>x</script>",
      reply: "a < b & c",
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<b>Eve");
    expect(mail.html).toContain("a &lt; b &amp; c");
    expect(mail.html).toContain("&lt;i&gt;T&lt;/i&gt;");
  });

  it("keeps a newline in the title out of the subject header", () => {
    const mail = buildReviewRepliedEmail({ ...base, bookTitle: "A\r\nBcc: x" });
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run lib/email/review-replied.test.ts`
Expected: FAIL, cannot resolve `@/lib/email/review-replied`.

- [ ] **Step 4: Write the template**

```ts
import { escapeHtml, fill, singleLine } from "@/lib/email/text";
import en from "@/lib/i18n/dictionaries/en.json";
import vi from "@/lib/i18n/dictionaries/vi.json";
import type { Locale } from "@/lib/i18n/config";
import { splitGraphemes } from "@/lib/reader/quote";

export type ReviewRepliedEmailInput = {
  locale: Locale;
  recipientName: string | null;
  // The book title in the review's locale, or null when the book has no localization there.
  bookTitle: string | null;
  rating: number;
  reviewBody: string;
  reply: string;
  // Absolute URL of the reviewer's own review page, built at send time.
  reviewUrl: string;
};

// Enough of the reviewer's own words to remember which review this is about, not the whole thing.
const CONTEXT_GRAPHEMES = 120;

const copy: Record<Locale, typeof en.email.reviewReplied> = {
  en: en.email.reviewReplied,
  vi: vi.email.reviewReplied,
};

function context(body: string): string {
  const units = splitGraphemes(body.trim());
  return units.length > CONTEXT_GRAPHEMES ? `${units.slice(0, CONTEXT_GRAPHEMES).join("")}…` : units.join("");
}

export function buildReviewRepliedEmail(input: ReviewRepliedEmailInput): { subject: string; text: string; html: string } {
  const strings = copy[input.locale];
  const name = input.recipientName?.trim() || null;
  const title = input.bookTitle?.trim() || null;

  const values = { name: name ?? "", title: title ?? "", rating: String(input.rating) };
  const subject = singleLine(fill(title ? strings.subjectWithTitle : strings.subjectGeneric, values));
  const greeting = fill(name ? strings.greetingNamed : strings.greetingGeneric, values);
  const yourReview = fill(strings.yourReview, values);
  const excerpt = context(input.reviewBody);
  const reply = input.reply.trim();
  const signOff = strings.signOff.split("\n");

  const text = [
    greeting, "", strings.intro, "",
    yourReview, excerpt, "",
    strings.authorReply, reply, "",
    `${strings.open}: ${input.reviewUrl}`, "",
    ...signOff, "",
  ].join("\n");

  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(strings.intro)}</p>`,
    `<p>${escapeHtml(yourReview)}<br>${escapeHtml(excerpt)}</p>`,
    `<p>${escapeHtml(strings.authorReply)}<br>${escapeHtml(reply)}</p>`,
    `<p><a href="${escapeHtml(input.reviewUrl)}">${escapeHtml(strings.open)}</a></p>`,
    `<p>${signOff.map(escapeHtml).join("<br>")}</p>`,
  ].join("\n");

  return { subject, text, html };
}
```

- [ ] **Step 5: Run the template test and the dictionary parity test**

Run: `npx vitest run lib/email/review-replied.test.ts lib/i18n/dictionary.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/email/review-replied.ts lib/email/review-replied.test.ts lib/i18n/dictionaries/en.json lib/i18n/dictionaries/vi.json
git commit -m "feat(s15): review_replied email template in both locales

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Worker branch

**Files:**
- Modify: `lib/email/outbox.ts`
- Modify: `lib/email/outbox.test.ts`

**Interfaces:**
- Consumes: `claim_notification_outbox` rows with `review_id` (Task 1); `buildReviewRepliedEmail` (Task 2); `getCatalogRoutes(locale).review(bookId)` from `lib/i18n/routes.ts`.
- Produces: a `review_replied` dispatch branch; `DeliveryDataError` codes `review_not_found`, `review_not_visible`, `review_payload_invalid`; idempotency key `review-replied/<outbox id>[/<generation>]`.

- [ ] **Step 1: Extend the test fixture and write the failing tests**

In `lib/email/outbox.test.ts`:

Add to `type Fixture`:
```ts
  // review_id -> the review as the worker selects it.
  reviews?: Record<string, { id: string; book_id: string; profile_id: string; status: string; author_reply: string | null; rating: number; body: string; locale: string } | null>;
```

Add to `resolve()` before the final `throw`:
```ts
    if (table === "book_reviews") {
      return { data: options.fixture.reviews?.[eqValue(calls, "id") as string] ?? null, error: null };
    }
```

The `book_localizations` branch already keys on `book_id/locale` and `books.status`; the review resolver uses the same select shape, so nothing else changes there.

Add `review_id: null` to `outboxRow`, `giftRow` and `questionRow` return objects (the claim now returns the column on every row).

Add a row factory and fixture rows:
```ts
const BOOK_ID = "00000000-0000-4000-8000-0000000000b1";

// A review_replied row, as claim_notification_outbox returns one: the review and the reviewer.
function reviewRow(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `outbox-${n}`,
    entitlement_id: null,
    profile_id: `profile-${n}`,
    gift_id: null,
    question_id: null,
    review_id: `review-${n}`,
    template_key: "review_replied",
    payload: { bookId: BOOK_ID },
    attempt_count: 0,
    delivery_generation: 0,
    ...overrides,
  };
}
```

In `baseFixture()` add:
```ts
    reviews: {
      "review-2": { id: "review-2", book_id: BOOK_ID, profile_id: "profile-2", status: "published", author_reply: "Cảm ơn bạn đã đọc.", rating: 5, body: "Cuốn sách rất hay.", locale: "vi" },
    },
```
and to `titles`: `[`${BOOK_ID}/vi`]: "Sách S15"`.

Add a describe block after the `question_answered` one:
```ts
  describe("review_replied", () => {
    async function runOne(row: unknown, mutate?: (fixture: Fixture) => void) {
      const fixture = baseFixture();
      mutate?.(fixture);
      const { client, rpcCalls } = recordingClient({ claimed: [row], fixture });
      const { provider, sent } = recordingProvider(async () => ({ messageId: "m" }));
      const result = await run(client, provider);
      return { result, rpcCalls, sent };
    }

    it("sends the current reply to the verified address in the review's locale with the review link", async () => {
      const { result, sent } = await runOne(reviewRow(2, { delivery_generation: 1 }));
      expect(result).toEqual({ claimed: 1, sent: 1, failed: 0, leaseLost: 0 });
      expect(sent[0]).toMatchObject({
        to: "minh@example.com",
        subject: "Tác giả đã phản hồi đánh giá của bạn về “Sách S15”",
        idempotencyKey: "review-replied/outbox-2/1",
      });
      expect(sent[0].text).toContain("Cảm ơn bạn đã đọc.");
      expect(sent[0].text).toContain(`https://books.example.com/vi/library/reviews/${BOOK_ID}`);
    });

    it("reads the reply at send time, so an edit before delivery is what goes out", async () => {
      const { sent } = await runOne(reviewRow(2), (f) => {
        f.reviews!["review-2"]!.author_reply = "Cảm ơn bạn đã đọc kỹ.";
      });
      expect(sent[0].text).toContain("Cảm ơn bạn đã đọc kỹ.");
      expect(sent[0].text).not.toContain("Cảm ơn bạn đã đọc.\n");
    });

    it("uses the generic subject when the book has no title in the review's locale", async () => {
      const { sent } = await runOne(reviewRow(2), (f) => void delete f.titles[`${BOOK_ID}/vi`]);
      expect(sent[0].subject).toBe("Tác giả đã phản hồi đánh giá của bạn");
    });

    it.each([
      ["unpublished", { status: "pending" }],
      ["cleared", { author_reply: null }],
    ])("fails with review_not_visible when the review is %s by send time", async (_name, patch) => {
      const { sent, rpcCalls } = await runOne(reviewRow(2), (f) => Object.assign(f.reviews!["review-2"]!, patch));
      expect(sent).toHaveLength(0);
      expect(rpcCalls[1][0]).toBe("fail_notification_outbox");
      expect(rpcCalls[1][1]).toMatchObject({ p_error_code: "review_not_visible" });
    });

    it("fails with review_not_found when the review row is gone", async () => {
      const { sent, rpcCalls } = await runOne(reviewRow(2, { review_id: "review-gone" }));
      expect(sent).toHaveLength(0);
      expect(rpcCalls[1][1]).toMatchObject({ p_error_code: "review_not_found" });
    });

    it("fails with recipient_unverified and continues the batch", async () => {
      const fixture = baseFixture();
      fixture.identities["profile-2"] = null;
      const { client, rpcCalls } = recordingClient({ claimed: [reviewRow(2), outboxRow(1)], fixture });
      const { provider, sent } = recordingProvider(async () => ({ messageId: "m" }));
      const result = await run(client, provider);
      expect(result).toEqual({ claimed: 2, sent: 1, failed: 1, leaseLost: 0 });
      expect(rpcCalls[1][1]).toMatchObject({ p_id: "outbox-2", p_error_code: "recipient_unverified" });
      expect(sent[0].to).toBe("ada@example.com");
    });

    it.each([
      ["null", null],
      ["missing bookId", {}],
      ["non-uuid bookId", { bookId: "nope" }],
    ])("fails with review_payload_invalid for %s", async (_name, payload) => {
      const { sent, rpcCalls } = await runOne(reviewRow(2, { payload }));
      expect(sent).toHaveLength(0);
      expect(rpcCalls[1][1]).toMatchObject({ p_error_code: "review_payload_invalid" });
    });

    it("fails with unsupported_template when profile_id is missing", async () => {
      const { rpcCalls } = await runOne(reviewRow(2, { profile_id: null }));
      expect(rpcCalls[1][1]).toMatchObject({ p_error_code: "unsupported_template" });
    });

    it("fails with delivery_data_unavailable when the review read errors", async () => {
      const { rpcCalls } = await runOne(reviewRow(2), (f) => void (f.failTables = new Set(["book_reviews"])));
      expect(rpcCalls[1][1]).toMatchObject({ p_error_code: "delivery_data_unavailable" });
    });

    it("never logs the reply, the body, or the address", async () => {
      await runOne(reviewRow(2));
      const logged = logSpies.flatMap((spy) => spy.mock.calls.flat()).map((v) => JSON.stringify(v)).join("\n");
      expect(logged).not.toContain("Cảm ơn");
      expect(logged).not.toContain("minh@example.com");
    });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/email/outbox.test.ts -t review_replied`
Expected: FAIL with `unsupported_template` where `review_not_visible` or a send was expected, and a type error on `review_id` in the `Omit` until the implementation lands.

- [ ] **Step 3: Implement the branch**

In `lib/email/outbox.ts`:

Import: `import { buildReviewRepliedEmail } from "@/lib/email/review-replied";` and change the routes import to `import { getCatalogRoutes, getKnowledgeRoutes, getLocaleRoutes } from "@/lib/i18n/routes";`.

Extend the header comment with a fourth bullet:
```ts
//   * review_replied goes to the reviewer, at their oldest verified address, in the locale they
//     reviewed in, and carries the review's CURRENT author reply read at send time (S15). The
//     claim only hands over a row while the review is published with a reply; the re-check here
//     covers the race between claim and send.
```

Widen `ClaimedRow`:
```ts
type ClaimedRow = Omit<
  Database["public"]["Functions"]["claim_notification_outbox"]["Returns"][number],
  "entitlement_id" | "profile_id" | "gift_id" | "question_id" | "review_id" | "payload"
> & {
  entitlement_id: string | null;
  profile_id: string | null;
  gift_id: string | null;
  question_id: string | null;
  review_id: string | null;
  payload: Json | null;
};
```

Add after `QuestionRow`:
```ts
// A review_replied row, narrowed: the review, the reviewer and the payload naming the book are present.
type ReviewRow = ClaimedRow & { review_id: string; profile_id: string; payload: Json };

type ReviewRepliedDelivery = {
  to: string;
  locale: Locale;
  recipientName: string | null;
  bookTitle: string | null;
  rating: number;
  reviewBody: string;
  reply: string;
  reviewUrl: string;
};
```

Add after `asQuestionRow`:
```ts
function asReviewRow(row: ClaimedRow): ReviewRow {
  if (row.review_id === null || row.profile_id === null || row.payload === null) {
    throw new DeliveryDataError("unsupported_template");
  }
  return row as ReviewRow;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readBookId(payload: Json): string {
  const bookId = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, Json>).bookId : null;
  if (typeof bookId !== "string" || !UUID.test(bookId)) throw new DeliveryDataError("review_payload_invalid");
  return bookId;
}
```

Add after `resolveQuestionAnsweredDelivery`:
```ts
async function resolveReviewRepliedDelivery(
  client: SupabaseClient<Database>,
  row: ReviewRow,
  siteUrl: string,
): Promise<ReviewRepliedDelivery> {
  const bookId = readBookId(row.payload);
  const [profile, identity, review] = await Promise.all([
    client.from("profiles").select("display_name").eq("id", row.profile_id).maybeSingle(),
    client
      .from("customer_identities")
      .select("normalized_email")
      .eq("profile_id", row.profile_id)
      .not("verified_at", "is", null)
      .order("verified_at", { ascending: true })
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle(),
    client
      .from("book_reviews")
      .select("id, book_id, profile_id, status, author_reply, rating, body, locale")
      .eq("id", row.review_id)
      .maybeSingle(),
  ]);
  if (profile.error || identity.error || review.error) throw dataUnavailable();
  if (!profile.data) throw new DeliveryDataError("profile_not_found");
  if (!identity.data) throw new DeliveryDataError("recipient_unverified");
  if (!review.data) throw new DeliveryDataError("review_not_found");
  // The claim only hands over a published review with a reply; this catches a reader edit (back
  // to pending) or a cleared reply that landed in between. The row is simply not claimed again
  // until the review is visible, so this costs one attempt and never a wrong email.
  if (review.data.status !== "published" || review.data.author_reply === null) throw new DeliveryDataError("review_not_visible");

  const locale = resolveLocale(review.data.locale);
  const localization = await client
    .from("book_localizations")
    .select("title, books!inner(status)")
    .eq("book_id", bookId)
    .eq("locale", locale)
    .eq("books.status", "published")
    .maybeSingle();
  if (localization.error) throw dataUnavailable();

  return {
    to: identity.data.normalized_email,
    locale,
    recipientName: profile.data.display_name,
    bookTitle: localization.data?.title ?? null,
    rating: review.data.rating,
    reviewBody: review.data.body,
    reply: review.data.author_reply,
    reviewUrl: new URL(getCatalogRoutes(locale).review(bookId), siteUrl).toString(),
  };
}
```

In `buildMessage`, before the final `throw`:
```ts
  if (row.template_key === "review_replied") {
    const delivery = await resolveReviewRepliedDelivery(deps.client, asReviewRow(row), deps.siteUrl);
    return {
      to: delivery.to,
      ...buildReviewRepliedEmail({
        locale: delivery.locale,
        recipientName: delivery.recipientName,
        bookTitle: delivery.bookTitle,
        rating: delivery.rating,
        reviewBody: delivery.reviewBody,
        reply: delivery.reply,
        reviewUrl: delivery.reviewUrl,
      }),
      idempotencyKey: deliveryKey("review-replied", row),
    };
  }
```

- [ ] **Step 4: Run the whole outbox suite and typecheck**

Run: `npx vitest run lib/email/outbox.test.ts && npm run typecheck`
Expected: PASS. The three existing row factories now carry `review_id: null`; if an existing assertion compares a full claimed row by equality, add `review_id: null` there too.

- [ ] **Step 5: Commit**

```bash
git add lib/email/outbox.ts lib/email/outbox.test.ts
git commit -m "feat(s15): deliver review_replied rows from the outbox worker

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Admin surface

**Files:**
- Modify: `lib/data/admin-reviews.ts`
- Modify: `components/admin/reviews/review-row.tsx`
- Modify: `components/admin/reviews/review-row.test.tsx`

**Interfaces:**
- Consumes: `admin_list_reviews` rows with `replyEmailedAt` (Task 1).
- Produces: `AdminReviewDTO.replyEmailedAt: string | null`.

- [ ] **Step 1: Write the failing component tests**

In `review-row.test.tsx`, add `replyEmailedAt: null` to the `review` fixture, then add:

```ts
it("tells the admin the reviewer will be emailed, under the reply field", () => {
  renderRow();
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  expect(screen.getByText("The reviewer is emailed once the review is published and the reply is saved.")).toBeInTheDocument();
});

it("shows when the reply was emailed, and nothing when it was not", () => {
  const { unmount } = renderRow({ authorReply: "Thanks!", replyEmailedAt: "2026-10-09T09:30:00.000Z" });
  expect(screen.getByText(/^Emailed /)).toBeInTheDocument();
  unmount();
  renderRow({ authorReply: "Thanks!" });
  expect(screen.queryByText(/^Emailed /)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run components/admin/reviews/review-row.test.tsx`
Expected: FAIL, hint text and "Emailed" not found; type error on `replyEmailedAt`.

- [ ] **Step 3: Implement**

`lib/data/admin-reviews.ts`, in `adminReviewSchema` after `publishedAt`:
```ts
  // max(sent_at) over the review's review_replied outbox rows; null until the first delivery.
  replyEmailedAt: z.string().nullable(),
```

`components/admin/reviews/review-row.tsx`:

In `ReplyForm`, replace the hint paragraph with:
```tsx
      <p className="text-[0.8125rem] text-sage-text">Plain text. Leave blank and save to remove the reply.</p>
      <p className="text-[0.8125rem] text-sage-text">The reviewer is emailed once the review is published and the reply is saved.</p>
```

In `ReviewRow`, inside the `review.authorReply ? (...)` block, after the reply paragraph:
```tsx
            {review.replyEmailedAt ? (
              <span className="mt-1 block text-[0.8125rem] text-sage-text">{`Emailed ${formatDate(review.replyEmailedAt, "en")}`}</span>
            ) : null}
```
Place it inside the same `<p>` as a trailing `<span>`, so the "Author reply" paragraph owns it.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run components/admin/reviews lib/data/admin-reviews.test.ts && npm run typecheck`
Expected: PASS. If `lib/data/admin-reviews.test.ts` parses a fixture row, add `replyEmailedAt: null` there.

- [ ] **Step 5: Commit**

```bash
git add lib/data/admin-reviews.ts components/admin/reviews/review-row.tsx components/admin/reviews/review-row.test.tsx lib/data/admin-reviews.test.ts
git commit -m "feat(s15): show reply email state on the admin review list

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Stuck-notification coverage for review rows

**Files:**
- Modify: `lib/ops/types.ts`
- Modify: `lib/ops/checks.ts`
- Modify: `lib/ops/checks.test.ts`
- Modify: `lib/data/operations.ts`
- Modify: `lib/data/operations.test.ts`

**Interfaces:**
- Consumes: `notification_outbox.review_id` (Task 1).
- Produces: `OutboxRow.reviewId: string | null`; a `stuck_notification` finding for a review row with `repairPath = "/admin/reviews?status=published"`.

- [ ] **Step 1: Write the failing rule test**

In `lib/ops/checks.test.ts`, add `reviewId: null` to the `row` and `giftRow` fixtures in the `stuck_notification` describe, then add:

```ts
    const reviewRow = {
      profileId: "profile-7",
      giftId: null,
      orderId: null,
      reviewId: "review-1",
      entitlementStatus: null,
      leaseExpiresAt: null,
      sentAt: null,
      createdAt: minutesBefore(300),
    };

    it("reports a stuck review-reply delivery and points at the published reviews list", () => {
      const report = evaluateOperations(snapshot({ outbox: [{ ...reviewRow, id: "review-row", attemptCount: 4 }] }), NOW);
      expect(report.findings.stuck_notification).toEqual([
        {
          id: "review-row",
          rule: "stuck_notification",
          occurredAt: minutesBefore(300),
          summary: "Review reply email has failed at least 4 delivery attempts.",
          repairPath: "/admin/reviews?status=published",
        },
      ]);
    });

    it("applies the attempt floor and lease test to a review row", () => {
      const report = evaluateOperations(
        snapshot({
          outbox: [
            { ...reviewRow, id: "three", attemptCount: 3 },
            { ...reviewRow, id: "leased", attemptCount: 5, leaseExpiresAt: minutesAfter(2) },
            { ...reviewRow, id: "due", attemptCount: 4 },
          ],
        }),
        NOW,
      );
      expect(ids(report.findings.stuck_notification)).toEqual(["due"]);
    });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/ops/checks.test.ts`
Expected: FAIL, type error on `reviewId` and an empty findings array.

- [ ] **Step 3: Implement the rule**

`lib/ops/types.ts`, in `OutboxRow` after `orderId`:
```ts
  // Set on a review-reply row (S15). Its repair path is the published reviews list.
  reviewId: string | null;
```
Update the comment above the type: "exactly one of three things" and add the review case.

`lib/ops/checks.ts`, in `SUMMARIES`:
```ts
  stuckReviewNotification: "Review reply email has failed at least 4 delivery attempts.",
```

In `stuckNotifications`, widen the filter and the map:
```ts
    .filter(
      (row) =>
        row.sentAt === null &&
        (row.giftId !== null || row.reviewId !== null || (row.entitlementStatus === "active" && row.profileId !== null)) &&
        row.attemptCount >= STUCK_NOTIFICATION_ATTEMPTS &&
        (row.leaseExpiresAt === null || ms(row.leaseExpiresAt) <= now),
    )
    .map((row) =>
      row.giftId !== null
        ? finding("stuck_notification", row.id, row.createdAt, SUMMARIES.stuckGiftNotification, "/admin/gifts")
        : row.reviewId !== null
          ? // The reply lives on the review row; the published tab is where it is edited or cleared.
            finding("stuck_notification", row.id, row.createdAt, SUMMARIES.stuckReviewNotification, "/admin/reviews?status=published")
          : finding("stuck_notification", row.id, row.createdAt, SUMMARIES.stuckNotification, `/admin/users/${row.profileId}`),
    );
```

- [ ] **Step 4: Run the rule tests**

Run: `npx vitest run lib/ops/checks.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing loader test**

In `lib/data/operations.test.ts`, the recording client answers `notification_outbox` from an `outbox` fixture (see the file's `recordingChain` helper and the `outbox.gift` RPC stub). Add a review fixture row and a test:

```ts
  it("reads stuck review-reply rows in a third branch and merges them oldest first", async () => {
    const { client, from } = clientWith({
      outbox: {
        book: [],
        gift: [],
        review: [
          { id: "r-1", profile_id: "p-1", review_id: "rev-1", attempt_count: 4, lease_expires_at: null, sent_at: null, created_at: minutesBefore(10), book_reviews: { status: "published" } },
        ],
      },
    });
    const snapshot = await loadOperationsSnapshot(client, NOW);
    expect(snapshot.outbox).toEqual([
      { id: "r-1", profileId: "p-1", giftId: null, orderId: null, reviewId: "rev-1", entitlementStatus: null, attemptCount: 4, leaseExpiresAt: null, sentAt: null, createdAt: minutesBefore(10) },
    ]);
    // Two table queries now: the book branch and the review branch.
    expect(from.mock.calls.filter(([table]) => table === "notification_outbox")).toHaveLength(2);
  });
```

Adapt `clientWith` so that a `notification_outbox` query whose recorded calls include `.eq("book_reviews.status", "published")` answers with `outbox.review`, and one with `.eq("entitlements.status", "active")` answers with `outbox.book`. Read the helper first; it already dispatches on recorded filters for the book branch, so the review branch is one more `if`.

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run lib/data/operations.test.ts`
Expected: FAIL, one query instead of two and no `reviewId`.

- [ ] **Step 7: Implement the loader branch**

`lib/data/operations.ts`: add `reviewId: null` to the objects returned by `loadStuckBookOutbox` and `loadStuckGiftOutbox`, then add:

```ts
// S15: a review-reply row joins book_reviews, which service_role and admins can select directly
// (unlike gifts), so a PostgREST embed is enough. Only a published review with a reply can be
// claimed (claim_notification_outbox filters the same way), so an unpublished one is not a
// delivery fault and is filtered here for the same reason the book branch filters on an active
// entitlement.
async function loadStuckReviewOutbox(client: Client, now: Date): Promise<OutboxRow[]> {
  const { data, error } = await client
    .from("notification_outbox")
    .select("id, profile_id, review_id, attempt_count, lease_expires_at, sent_at, created_at, book_reviews!inner(status, author_reply)")
    .is("sent_at", null)
    .eq("book_reviews.status", "published")
    .not("book_reviews.author_reply", "is", null)
    .gte("attempt_count", STUCK_NOTIFICATION_ATTEMPTS)
    .or(`lease_expires_at.is.null,lease_expires_at.lte.${now.toISOString()}`)
    .order("created_at", { ascending: true })
    .limit(MAX_ROWS_PER_RULE);
  if (error) fail("notification_outbox", error);

  return (data ?? []).flatMap((row) => {
    if (row.review_id === null) return [];
    return [
      {
        id: row.id,
        profileId: row.profile_id,
        giftId: null,
        orderId: null,
        reviewId: row.review_id,
        entitlementStatus: null,
        attemptCount: row.attempt_count,
        leaseExpiresAt: row.lease_expires_at,
        sentAt: row.sent_at,
        createdAt: row.created_at,
      },
    ];
  });
}
```

And in `loadStuckOutbox`:
```ts
  const [books, gifts, reviews] = await Promise.all([
    loadStuckBookOutbox(client, now),
    loadStuckGiftOutbox(client, now),
    loadStuckReviewOutbox(client, now),
  ]);
  return [...books, ...gifts, ...reviews]
```

- [ ] **Step 8: Run loader tests, the ops suite, and typecheck**

Run: `npx vitest run lib/data/operations.test.ts lib/ops && npm run typecheck`
Expected: PASS. If `components/admin/operations-panel.test.tsx` or `lib/ops/alerts.test.ts` build an `OutboxRow` literal, add `reviewId: null` there.

- [ ] **Step 9: Commit**

```bash
git add lib/ops/types.ts lib/ops/checks.ts lib/ops/checks.test.ts lib/data/operations.ts lib/data/operations.test.ts
git commit -m "feat(s15): surface stuck review-reply emails in operations

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: End-to-end journey, runbook, and gates

**Files:**
- Modify: `e2e/reader-voice.spec.ts` (first test)
- Modify: `docs/runbooks/reader-voice.md` §3
- Modify: `docs/superpowers/specs/2026-10-09-s15-review-reply-email-design.md` (status)

**Interfaces:**
- Consumes: `runOperationsWorker(request)` and `check()` already in the spec file; `createServiceRoleClient()` from `e2e/support/supabase`.

- [ ] **Step 1: Extend the review journey**

Change the first test's signature to `async ({ page, request }) =>` and insert, right after `await expect(row).toHaveCount(0);` and before the `page.goto` of the book page:

```ts
  // S15: publishing a review that already carries a reply queues one review_replied row, and the
  // worker delivers it. The reply was saved while pending, so nothing was queued before publish.
  const service = createServiceRoleClient();
  const reviewRows = check(
    await service.from("book_reviews").select("id").eq("book_id", bookId).eq("profile_id", reader.profileId),
  ) as { id: string }[];
  const outboxFor = async () =>
    check(
      await service
        .from("notification_outbox")
        .select("id, template_key, sent_at, provider_message_id, last_error_code")
        .eq("review_id", reviewRows[0].id),
    ) as { id: string; template_key: string; sent_at: string | null; provider_message_id: string | null; last_error_code: string | null }[];
  const [queued] = await outboxFor();
  expect(queued).toMatchObject({ template_key: "review_replied", sent_at: null });
  await expect
    .poll(
      async () => {
        await runOperationsWorker(request);
        return (await outboxFor())[0].sent_at;
      },
      { message: "the review_replied row is delivered", timeout: 60_000, intervals: [500] },
    )
    .not.toBeNull();
  const delivered = await outboxFor();
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({ provider_message_id: `test/review-replied/${queued.id}`, last_error_code: null });

  // The admin list now shows the delivery on the published tab.
  await page.goto("/admin/reviews?status=published");
  await expect(page.getByRole("row", { name: new RegExp(title) }).getByText(/^Emailed /)).toBeVisible();
```

The later `const service = createServiceRoleClient();` in the same test becomes a duplicate declaration: delete that later line and keep the one added above.

- [ ] **Step 2: Run the spec against the scratch stack**

Per `docs/runbooks/testing-environments.md` and the memory notes: OrbStack context, Node 22.14, scratch stack with free ports, app on `:3100`, Supabase and Mailpit variables exported.

Run: `npx playwright test e2e/reader-voice.spec.ts`
Expected: PASS. The provider message id prefix `test/` comes from the no-network adapter in `playwright.config.ts`; if the first assertion fails on the prefix, read `lib/email/provider.ts` for the exact test id format and match it.

- [ ] **Step 3: Update the runbook**

In `docs/runbooks/reader-voice.md` §3, replace the bullet `- The reviewer is **not emailed** about a reply.` with:

```markdown
- The reviewer **is emailed** once per distinct reply text, but only while the review is
  **published**: a reply saved on a pending review is mailed when the review is published, and a
  reply changed before the worker runs replaces the pending email rather than adding one. Clearing
  a reply sends nothing. The Published tab shows *Emailed {date}* under the reply once it went out.
- Delivery uses the same outbox and worker as the other emails. A row that fails four times shows
  up under **Stuck book-ready emails** on `/admin/operations` with the summary "Review reply email
  has failed…" and links to the Published tab.
```

- [ ] **Step 4: Mark the spec approved**

In the spec header change `**Status:** Proposed` to `**Status:** Approved`.

- [ ] **Step 5: Run the full gates**

Run, in order:
```bash
npm run check
npm run db:reset && npm run db:test
npm run check:full
```
Expected: all green. Known pre-existing red: the ebook CLI unit test that loads `.env.local` (see memory); report it as pre-existing if it is the only failure.

- [ ] **Step 6: Commit**

```bash
git add e2e/reader-voice.spec.ts docs/runbooks/reader-voice.md docs/superpowers/specs/2026-10-09-s15-review-reply-email-design.md
git commit -m "test(s15): deliver the review reply email end to end; runbook

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
