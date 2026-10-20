# S13 Reader Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reader who owns a book rate and review it (moderated, with an author reply, surfaced on the book page and in Book JSON-LD), and let any signed-in reader ask the author a question that an editor answers by publishing an idea, with the asker emailed when the answer goes live.

**Architecture:** Two new tables, `book_reviews` and `reader_questions`, both written only through security-definer RPCs: reader RPCs gate on the session (and, for reviews, on an active entitlement), admin RPCs gate on `is_admin()` and write one audit row each. Public reads are folded into `catalog_book_page` plus one `catalog_book_reviews` RPC. The review form and the ask form are small authenticated pages with Server Actions, linked from the book page, the library, the reader completion card, and idea pages. Answer delivery reuses `notification_outbox` with a third target column and a new template; the ops worker gains one rule.

**Tech Stack:** Next.js 16.3 App Router, React 19 Server Components and Server Actions, Supabase/Postgres/RLS, TypeScript 6, Zod 4, Vitest 5, pgTAP, Playwright 1.63, Resend via the existing mail provider, Tailwind CSS 4.

**Spec:** `docs/superpowers/specs/2026-10-02-s13-reader-voice-design.md`

## Post-review corrections (2026-10-02)

The following changes supersede the initial task snippets below:

- Migration `20260928180000` restricts public review reads to the RPC and adds a monotonically
  increasing review revision. Moderation takes `p_expected_revision`; stale/missing revisions
  return `EB036`. Admin list, DAL, action and form carry the displayed revision.
- Migration `20260928190000` locks idea → question → outbox when linking an answer, matching the
  publish trigger. Unsent payloads follow relinks; drafts are not claimed. `EB037` refuses relinks
  once an unsent notification has been claimed (`question_delivery_started` persists across retries and operator resets). Sent rows are
  never requeued. Tests cover both concurrent transaction orders.
- Migration `20260928200000` also restores the existing authenticated-only reading-progress
  grant contract exposed by the full pgTAP gate. Baseline tests now isolate CLI credentials, match
  current knowledge readiness copy, and wait for the new manual-payment response.
- A revoked owner can read/delete an existing review, but submit still requires entitlement.
- `/ask` is private in the public redirect destination filter as well as robots and route access.
- Regression coverage: pgTAP `064`–`065`, moderation action/component tests, revoked-owner page
  test, redirect tests, and expanded `reader-voice.spec.ts` (PostgREST privacy, revocation/deletion,
  plus three concurrency cases). Regenerate database types from the owned scratch stack.

## Global Constraints

- Read the local Next.js 16 guides before changing framework code: `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`, `node_modules/next/dist/docs/01-app/02-guides/forms.md`, `node_modules/next/dist/docs/01-app/01-getting-started/09-revalidating.md`.
- Customer routes stay under `/{locale}` for exactly `vi` and `en`; `/admin` remains unprefixed. The new customer pages live in the `(account)` route group so they inherit `noindex`.
- Every protected page and Server Action calls `requireUser(locale, next)` or `requireAdmin()` itself. A service-role client is created only after `requireAdmin()` passes.
- A review may be created only by a profile with an active entitlement for the book. The RPC checks `exists (select 1 from public.entitlements en where en.profile_id = v_profile_id and en.book_id = p_book_id and en.status = 'active')`; refusal is `EB034`.
- Review `rating` is an integer 1..5; `body` is 1..1000 characters after trim; `author_reply` is 1..1000 characters; a question `body` is 1..500 characters. All three reject HTML-tag syntax with `~* '</?[a-z][^>]*>'` in SQL and `/<\/?[a-z][^>]*>/i` in Zod.
- One review per `(book_id, profile_id)`. Any reader edit sets `status = 'pending'` and `published_at = null` and keeps `author_reply`.
- A question needs at least one of `book_id`, `idea_id`, both referencing published entities. A profile may hold at most 5 questions in `new`; refusal is `EB035`.
- `aggregateRating` and `review` are emitted only from the arrays the page renders, and never when there are zero published reviews.
- Questions are private: only the asker and admins read a row; the answering idea shows nothing about the asker; audit metadata holds ids only.
- Emails go out only when the answering idea becomes `published`, via a trigger on `ideas` that inserts `notification_outbox` rows with `template_key = 'question_answered'` and `payload = { "ideaId": ... }`.
- There are no cache tags. Reader review writes call `revalidateStorefront()` plus `revalidatePath` of the review page and the library; admin writes call `revalidateStorefront()` plus the admin path.
- Migrations begin at `20260928120000` (after S14's `20260928110000`) and use `20260928120000`–`20260928160000`; pgTAP files use `059`–`063`. Applied migrations are never edited. Regenerate `lib/supabase/database.types.ts` with `npx supabase gen types typescript --local > lib/supabase/database.types.ts` after each migration task against a reset local stack.
- Next free custom error codes: `EB034` (no entitlement for review), `EB035` (question cap). Not-found is `P0002`, invalid input `22023`, not admin `42501`.
- Dictionary keys are added to both `lib/i18n/dictionaries/en.json` and `vi.json`; `lib/i18n/dictionary.test.ts` enforces parity. Reader copy keys also go in `lib/reader/copy.ts` and the copy literal in `components/reader/reader-client.test.tsx`.
- Run database and Playwright suites only against local Supabase per `docs/runbooks/testing-environments.md`. Use Node.js 22. The final gate is `npm run check`, `npm run db:test`, and `npm run check:full`.

## Review Focus

1. A reader whose entitlement was revoked after they reviewed must keep their row readable to themselves but must not be able to edit it back to pending; `submit_book_review` re-checks the entitlement on every call. Pinned in Task 1.
2. An admin reply on a review that the reader then edits must survive the edit (`author_reply` kept) while the review itself goes back to pending and off the book page. Pinned in Task 1.
3. A question whose target book is later unpublished must still be answerable and must still email the asker; the trigger does not look at the target. Pinned in Task 9.
4. Republishing an idea (unpublish then publish) must not email the asker twice; `notified_at` is the guard. Pinned in Task 9.
5. A profile with no verified `customer_identities` row must fail `question_answered` delivery with `recipient_unverified`, not throw out of the batch. Pinned in Task 12.

## File Structure

| Area | Files and responsibility |
| --- | --- |
| Reviews schema | `supabase/migrations/20260928120000_s13_reviews.sql`, `supabase/tests/059_s13_reviews.sql`: table, RLS, reader RPCs, public read RPC, `catalog_book_page.reviewSummary`. |
| Reviews admin | `supabase/migrations/20260928130000_s13_reviews_admin.sql`, `supabase/tests/060_s13_reviews_admin.sql`: list, moderate, reply RPCs. |
| Reviews contract and data | `lib/reviews/schema.ts` and test, `lib/data/reviews.ts`, `lib/catalog/public-types.ts`, `lib/data/catalog.ts`. |
| Reviews SEO and page | `lib/seo/json-ld.ts` and test, `components/catalog/book-reviews.tsx` and test, `app/[lang]/(public)/books/[slug]/page.tsx`. |
| Review form | `app/[lang]/(account)/library/reviews/[bookId]/page.tsx`, `actions.ts`, `components/account/review-form.tsx` and test, library page, completion panel, reader page and client props. |
| Reviews admin UI | `lib/data/admin-reviews.ts`, `app/admin/reviews/page.tsx`, `app/admin/reviews/actions.ts`, `components/admin/reviews/*`, admin nav, `lib/data/admin.ts`, `app/admin/page.tsx`. |
| Questions schema | `supabase/migrations/20260928140000_s13_questions.sql`, `supabase/tests/061_s13_questions.sql`: table, RLS, reader RPCs. |
| Questions admin and outbox | `supabase/migrations/20260928150000_s13_questions_admin_outbox.sql`, `supabase/tests/062_s13_questions_admin_outbox.sql`: admin RPCs, outbox column/template/trigger, claim redefinition. |
| Ask page | `lib/questions/schema.ts` and test, `lib/data/questions.ts`, `app/[lang]/(account)/ask/page.tsx`, `actions.ts`, `components/account/ask-form.tsx` and test, idea page link. |
| Questions admin UI | `lib/data/admin-questions.ts`, `app/admin/questions/page.tsx`, `actions.ts`, `components/admin/questions/*`. |
| Email | `lib/email/question-answered.ts` and test, `lib/email/outbox.ts` and test, dictionaries. |
| Ops rule | `supabase/migrations/20260928160000_s13_operations_alert_state_questions.sql`, `supabase/tests/063_s13_operations_alert_state.sql`, `lib/ops/types.ts`, `lib/ops/checks.ts` and test, `lib/data/operations.ts`, `components/admin/operations-panel.tsx`. |
| Verification | `e2e/reader-voice.spec.ts`, `docs/runbooks/reader-voice.md`. |

---

### Task 1: Reviews table, reader RPCs, and public read

**Files:**
- Create: `supabase/migrations/20260928120000_s13_reviews.sql`
- Create: `supabase/tests/059_s13_reviews.sql`
- Modify: `lib/supabase/database.types.ts` (regenerate)

**Interfaces:**
- Produces table `public.book_reviews`.
- Produces `submit_book_review(p_book_id uuid, p_rating integer, p_body text, p_locale text) returns jsonb` (the caller's row as `{ id, rating, body, status, authorReply, authorReplyAt, publishedAt, updatedAt }`).
- Produces `delete_book_review(p_book_id uuid) returns void`.
- Produces `get_my_book_review(p_book_id uuid) returns jsonb` (same shape or null).
- Produces `catalog_book_reviews(p_book_id uuid, p_limit integer) returns jsonb` (array of `{ id, reviewerName, rating, body, authorReply, authorReplyAt, publishedAt }`).
- `catalog_book_page` gains `reviewSummary: { count, average } | null`.

- [ ] **Step 1: Write the failing pgTAP file**

```sql
begin;
select plan(26);

-- S13 reviews: entitlement-gated writes, one row per reader per book, edits return to pending and
-- keep the author's reply, public reads see only published rows of published books.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e1300000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's13-owner@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e1300000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's13-stranger@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
update public.profiles set display_name = 'Minh Anh' where auth_user_id = 'e1300000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name, status)
values ('e1330000-0000-0000-0000-000000000001', 's13-author', 'S13 Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('e1320000-0000-0000-0000-000000000001', 's13-book', 'vi', 'e1330000-0000-0000-0000-000000000001', 'published'),
  ('e1320000-0000-0000-0000-000000000002', 's13-book-draft', 'vi', 'e1330000-0000-0000-0000-000000000001', 'draft');
insert into public.book_localizations (book_id, locale, slug, title) values
  ('e1320000-0000-0000-0000-000000000001', 'vi', 's13-book', 'Sách S13'),
  ('e1320000-0000-0000-0000-000000000002', 'vi', 's13-book-draft', 'Nháp S13');

insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason, status)
select 'e1340000-0000-0000-0000-000000000001', p.id, 'e1320000-0000-0000-0000-000000000001', 'admin_grant', p.id, 'fixture', 'active'
from public.profiles p where p.auth_user_id = 'e1300000-0000-0000-0000-000000000001';

-- Writes ----------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$select public.submit_book_review('e1320000-0000-0000-0000-000000000001', 5, 'Hay', 'vi')$$,
  'EB034', null, 'a reader without an entitlement cannot review');
select is(public.get_my_book_review('e1320000-0000-0000-0000-000000000001'), null, 'no review reads as null');

select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.submit_book_review('e1320000-0000-0000-0000-000000000001', 6, 'Hay', 'vi')$$,
  '22023', null, 'rating above 5 is refused');
select throws_ok(
  $$select public.submit_book_review('e1320000-0000-0000-0000-000000000001', 5, '<b>Hay</b>', 'vi')$$,
  '22023', null, 'html in the body is refused');
select throws_ok(
  $$select public.submit_book_review('e1320000-0000-0000-0000-000000000001', 5, repeat('a', 1001), 'vi')$$,
  '22023', null, 'a 1001-character body is refused');
select is(
  (public.submit_book_review('e1320000-0000-0000-0000-000000000001', 5, '  Cuốn sách rất hay.  ', 'vi')) ->> 'status',
  'pending', 'a new review is pending');
select is(
  (public.get_my_book_review('e1320000-0000-0000-0000-000000000001')) ->> 'body',
  'Cuốn sách rất hay.', 'the body is trimmed');
select throws_ok(
  $$insert into public.book_reviews (book_id, profile_id, rating, body, locale) select 'e1320000-0000-0000-0000-000000000001', id, 5, 'x', 'vi' from public.profiles$$,
  '42501', null, 'no role inserts directly');
reset role;

-- Publish via direct update as a fixture (the admin RPC is Task 2) and add a reply.
update public.book_reviews set status = 'published', published_at = now(), author_reply = 'Cảm ơn bạn', author_reply_at = now()
where book_id = 'e1320000-0000-0000-0000-000000000001';

-- Public read ------------------------------------------------------------------------------------
set local role anon;
select is(jsonb_array_length(public.catalog_book_reviews('e1320000-0000-0000-0000-000000000001', 5)), 1, 'anon sees the published review');
select is(public.catalog_book_reviews('e1320000-0000-0000-0000-000000000001', 5) -> 0 ->> 'reviewerName', 'Minh Anh', 'reviewer display name is shown');
select is(public.catalog_book_reviews('e1320000-0000-0000-0000-000000000001', 5) -> 0 ->> 'authorReply', 'Cảm ơn bạn', 'author reply is shown');
select is(public.catalog_book_page('vi', 's13-book') -> 'reviewSummary' ->> 'count', '1', 'reviewSummary counts published reviews');
select is(public.catalog_book_page('vi', 's13-book') -> 'reviewSummary' ->> 'average', '5.0', 'reviewSummary averages to one decimal');
select results_eq($$select count(*) from public.book_reviews$$, array[1::bigint], 'anon selects only published rows');
reset role;

-- Edit returns to pending, keeps the reply ----------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000001', true);
select is(
  (public.submit_book_review('e1320000-0000-0000-0000-000000000001', 4, 'Đọc lại thấy khác.', 'vi')) ->> 'status',
  'pending', 'an edit returns the review to pending');
select is(
  (public.get_my_book_review('e1320000-0000-0000-0000-000000000001')) ->> 'authorReply',
  'Cảm ơn bạn', 'an edit keeps the author reply');
select is(
  (public.get_my_book_review('e1320000-0000-0000-0000-000000000001')) ->> 'publishedAt',
  null, 'an edit clears published_at');
reset role;
set local role anon;
select is(public.catalog_book_page('vi', 's13-book') -> 'reviewSummary', 'null'::jsonb, 'no published reviews means a null summary');
select is(jsonb_array_length(public.catalog_book_reviews('e1320000-0000-0000-0000-000000000001', 5)), 0, 'a pending review is off the public read');
reset role;

-- Revoked entitlement -------------------------------------------------------------------------
update public.entitlements set status = 'revoked', revoked_at = now() where id = 'e1340000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.submit_book_review('e1320000-0000-0000-0000-000000000001', 3, 'Sửa', 'vi')$$,
  'EB034', null, 'a revoked reader cannot edit');
select isnt(public.get_my_book_review('e1320000-0000-0000-0000-000000000001'), null, 'a revoked reader still reads their own row');
select results_eq($$select count(*) from public.book_reviews$$, array[1::bigint], 'a reader reads own pending row through RLS');
select lives_ok($$select public.delete_book_review('e1320000-0000-0000-0000-000000000001')$$, 'a reader deletes their own review');
select throws_ok($$select public.delete_book_review('e1320000-0000-0000-0000-000000000001')$$, 'P0002', null, 'deleting twice is P0002');
reset role;

-- Draft book: a reader reads nothing public even with an entitlement row ---------------------
select is(public.catalog_book_reviews('e1320000-0000-0000-0000-000000000002', 5), '[]'::jsonb, 'a draft book has no public reviews');
select is(has_function_privilege('anon', 'public.submit_book_review(uuid, integer, text, text)', 'EXECUTE'), false, 'anon cannot submit');
select is(has_function_privilege('anon', 'public.catalog_book_reviews(uuid, integer)', 'EXECUTE'), true, 'anon can read public reviews');

select * from finish();
rollback;
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run db:reset && npm run db:test -- supabase/tests/059_s13_reviews.sql`
Expected: FAIL at `submit_book_review` not existing.

- [ ] **Step 3: Write the migration**

```sql
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
```

If S14 is not yet merged when this task runs, drop the `isbn` and `retailLinks` keys from this body and let whichever sub-project lands second re-add the other's keys.

- [ ] **Step 4: Run and regenerate types**

Run: `npm run db:reset && npm run db:test -- supabase/tests/059_s13_reviews.sql && npx supabase gen types typescript --local > lib/supabase/database.types.ts`
Expected: 26 passing. The `average` assertion expects `'5.0'`; if `jsonb` renders `5.0` as `5`, cast with `to_char(round(avg(r.rating)::numeric, 1), 'FM999.0')::numeric` or assert `'5'` and keep the one-decimal rounding on the TypeScript side.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260928120000_s13_reviews.sql supabase/tests/059_s13_reviews.sql lib/supabase/database.types.ts
git commit -m "feat(s13): book reviews schema, reader RPCs, public read"
```

---

### Task 2: Review admin RPCs

**Files:**
- Create: `supabase/migrations/20260928130000_s13_reviews_admin.sql`
- Create: `supabase/tests/060_s13_reviews_admin.sql`
- Modify: `lib/supabase/database.types.ts` (regenerate)

**Interfaces:**
- Produces `admin_list_reviews(p_status text) returns jsonb`: array of `{ id, bookId, bookTitle, reviewerName, rating, body, locale, status, authorReply, createdAt, publishedAt }`, newest `created_at` first, capped at 200.
- Produces `admin_moderate_review(p_review_id uuid, p_status text) returns void`; `p_status` in `published`, `rejected`, `pending`.
- Produces `admin_reply_review(p_review_id uuid, p_reply text) returns void`; null or blank clears the reply.

- [ ] **Step 1: Write the failing pgTAP file**

Reuse Task 1's fixture block (users, admin role on the first user, book, entitlement, one submitted review via `submit_book_review` as the owner). Then:

```sql
set local role authenticated;
select set_config('request.jwt.claim.sub', '<reader auth id>', true);
select throws_ok($$select public.admin_moderate_review('<review id>', 'published')$$, '42501', null, 'a reader cannot moderate');
select set_config('request.jwt.claim.sub', '<admin auth id>', true);
select is(jsonb_array_length(public.admin_list_reviews('pending')), 1, 'admin lists pending reviews');
select lives_ok($$select public.admin_moderate_review('<review id>', 'published')$$, 'admin publishes');
select isnt((select published_at from public.book_reviews where id = '<review id>'), null, 'publish sets published_at');
select lives_ok($$select public.admin_moderate_review('<review id>', 'rejected')$$, 'admin rejects');
select lives_ok($$select public.admin_moderate_review('<review id>', 'published')$$, 'admin republishes');
select results_eq($$select count(distinct published_at) from public.book_reviews where id = '<review id>'$$, array[1::bigint], 'published_at is set once');
select throws_ok($$select public.admin_moderate_review('<review id>', 'deleted')$$, '22023', null, 'an unknown status is refused');
select lives_ok($$select public.admin_reply_review('<review id>', 'Cảm ơn bạn đã đọc.')$$, 'admin replies');
select lives_ok($$select public.admin_reply_review('<review id>', '  ')$$, 'a blank reply clears');
select is((select author_reply from public.book_reviews where id = '<review id>'), null, 'reply cleared');
select throws_ok($$select public.admin_reply_review('<review id>', '<i>x</i>')$$, '22023', null, 'html in a reply is refused');
select results_eq($$select action from public.audit_logs where entity_id = '<review id>' order by created_at$$,
  array['book_review.moderate', 'book_review.moderate', 'book_review.moderate', 'book_review.reply', 'book_review.reply'], 'one audit row per call');
select throws_ok($$select public.admin_moderate_review('e1340000-0000-0000-0000-00000000ffff', 'published')$$, 'P0002', null, 'missing review is P0002');
reset role;
```

Fetch the review id into a psql variable with `select id from public.book_reviews ... \gset` is not available in pgTAP; instead insert the review with a fixed id by running `submit_book_review` and then `update public.book_reviews set id = 'e1350000-0000-0000-0000-000000000001'`, or query `(select id from public.book_reviews limit 1)` inline inside `$$...$$` strings via `format()`. The 055 file shows the `format()` approach if needed.

- [ ] **Step 2: Write the migration**

```sql
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
```

- [ ] **Step 3: Run, regenerate, commit**

Run: `npm run db:reset && npm run db:test -- supabase/tests/060_s13_reviews_admin.sql && npx supabase gen types typescript --local > lib/supabase/database.types.ts`

```bash
git add supabase/migrations/20260928130000_s13_reviews_admin.sql supabase/tests/060_s13_reviews_admin.sql lib/supabase/database.types.ts
git commit -m "feat(s13): review moderation RPCs"
```

---

### Task 3: Review contract, DAL, and catalog DTO

**Files:**
- Create: `lib/reviews/schema.ts`, `lib/reviews/schema.test.ts`
- Create: `lib/data/reviews.ts`
- Modify: `lib/catalog/public-types.ts`, `lib/data/catalog.ts`
- Modify: every `CatalogBookPage` test fixture (add `reviewSummary: null`)

**Interfaces:**
- Produces `reviewInputSchema = z.object({ rating: z.coerce.number().int().min(1).max(5), body: plainText(1, 1000) })` and `NO_HTML = /<\/?[a-z][^>]*>/i`.
- Produces `CatalogReviewSummary = { count: number; average: number }`, `CatalogBookPage.reviewSummary: CatalogReviewSummary | null`.
- Produces `PublicReview = { id: string; reviewerName: string | null; rating: number; body: string; authorReply: string | null; authorReplyAt: string | null; publishedAt: string }`.
- Produces `MyReview = { id: string; rating: number; body: string; status: "pending" | "published" | "rejected"; authorReply: string | null; authorReplyAt: string | null; publishedAt: string | null; updatedAt: string }`.
- Produces in `lib/data/reviews.ts`: `getBookReviews(bookId, limit = 5): Promise<PublicReview[]>` (public client), `getMyBookReview(bookId): Promise<MyReview | null>`, `submitBookReview(bookId, input, locale): Promise<MyReview>`, `deleteBookReview(bookId): Promise<void>`, and `NotEntitledToReviewError`.

- [ ] **Step 1: Write the failing schema tests**

```ts
import { describe, expect, it } from "vitest";
import { reviewInputSchema } from "@/lib/reviews/schema";

describe("reviewInputSchema", () => {
  it("accepts a rating string from a radio group and a trimmed body", () => {
    expect(reviewInputSchema.parse({ rating: "4", body: "  Hay  " })).toEqual({ rating: 4, body: "Hay" });
  });
  it("rejects out-of-range ratings, empty, over-long, and html bodies", () => {
    expect(reviewInputSchema.safeParse({ rating: "0", body: "x" }).success).toBe(false);
    expect(reviewInputSchema.safeParse({ rating: "5", body: "   " }).success).toBe(false);
    expect(reviewInputSchema.safeParse({ rating: "5", body: "a".repeat(1001) }).success).toBe(false);
    expect(reviewInputSchema.safeParse({ rating: "5", body: "<b>x</b>" }).success).toBe(false);
    expect(reviewInputSchema.safeParse({ rating: "5", body: "3 < 5 and 5 > 3" }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Implement the schema**

```ts
import { z } from "zod";

export const NO_HTML = /<\/?[a-z][^>]*>/i;

export function plainText(min: number, max: number, label: string) {
  return z.string().trim().min(min, { error: `Enter ${label}.` }).max(max, { error: `Keep ${label} under ${max} characters.` }).refine((text) => !NO_HTML.test(text), { error: "HTML is not allowed." });
}

export const reviewInputSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  body: plainText(1, 1000, "your review"),
});
export type ReviewInput = z.infer<typeof reviewInputSchema>;
```

- [ ] **Step 3: DTO and catalog parsing**

`lib/catalog/public-types.ts`: add `CatalogReviewSummary` and `reviewSummary` to `CatalogBookPage`. `lib/data/catalog.ts` `bookPageSchema`: `reviewSummary: z.object({ count: z.number().int(), average: z.coerce.number() }).nullable().catch(null)`. Fix fixtures (`grep -rl "alternateSlug:" --include=*.test.ts* lib app components`).

- [ ] **Step 4: DAL**

`lib/data/reviews.ts` (`import "server-only"`), following `lib/data/library.ts` for `createClient` and `lib/data/catalog.ts` for `createPublicClient` and `failure`:

```ts
const ENTITLEMENT_REQUIRED = "EB034";
export class NotEntitledToReviewError extends Error {}

const publicReviewSchema = z.object({ id: z.string(), reviewerName: z.string().nullable(), rating: z.number().int(), body: z.string(), authorReply: z.string().nullable(), authorReplyAt: z.string().nullable(), publishedAt: z.string() });
const myReviewSchema = z.object({ id: z.string(), rating: z.number().int(), body: z.string(), status: z.enum(["pending", "published", "rejected"]), authorReply: z.string().nullable(), authorReplyAt: z.string().nullable(), publishedAt: z.string().nullable(), updatedAt: z.string() });

export const getBookReviews = cache(async (bookId: string, limit = 5): Promise<PublicReview[]> => {
  const { data, error } = await createPublicClient().rpc("catalog_book_reviews", { p_book_id: bookId, p_limit: limit });
  if (error) throw await failure("getBookReviews", error);
  const parsed = z.array(publicReviewSchema).safeParse(data ?? []);
  return parsed.success ? parsed.data : [];
});

export async function getMyBookReview(bookId: string): Promise<MyReview | null> {
  const { data, error } = await (await createClient()).rpc("get_my_book_review", { p_book_id: bookId });
  if (error) throw await failure("getMyBookReview", error);
  return data === null ? null : myReviewSchema.parse(data);
}

export async function submitBookReview(bookId: string, input: ReviewInput, locale: Locale): Promise<MyReview> {
  const { data, error } = await (await createClient()).rpc("submit_book_review", { p_book_id: bookId, p_rating: input.rating, p_body: input.body, p_locale: locale });
  if (error?.code === ENTITLEMENT_REQUIRED) throw new NotEntitledToReviewError();
  if (error) throw await failure("submitBookReview", error);
  return myReviewSchema.parse(data);
}

export async function deleteBookReview(bookId: string): Promise<void> {
  const { error } = await (await createClient()).rpc("delete_book_review", { p_book_id: bookId });
  if (error && error.code !== "P0002") throw await failure("deleteBookReview", error);
}
```

- [ ] **Step 5: Run and commit**

Run: `npx vitest run lib/reviews lib/data/catalog.test.ts lib/seo && npm run typecheck`

```bash
git add lib/reviews lib/data/reviews.ts lib/catalog/public-types.ts lib/data/catalog.ts lib/seo/json-ld.test.ts
git commit -m "feat(s13): review schema, DAL, and catalog summary DTO"
```

---

### Task 4: Book JSON-LD `aggregateRating` and `review`

**Files:**
- Modify: `lib/seo/json-ld.ts`, `lib/seo/json-ld.test.ts`

**Interfaces:**
- `bookSchema` gains an optional parameter `reviews?: PublicReview[]`. It emits `aggregateRating` from `book.reviewSummary` only when `book.reviewSummary` is non-null and `reviews.length > 0`, and `review[]` from `reviews`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("bookSchema reviews", () => {
  const reviews = [{ id: "r1", reviewerName: "Minh Anh", rating: 5, body: "Rất hay.", authorReply: "Cảm ơn", authorReplyAt: "2026-09-13T00:00:00+00:00", publishedAt: "2026-09-12T00:00:00+00:00" }];
  it("emits aggregateRating and review from the rendered reviews", () => {
    const schema = bookSchema({ siteUrl, locale: "vi", path: "/vi/books/x", paymentsEnabled: true, book: { ...book, reviewSummary: { count: 12, average: 4.6 } }, reviews });
    expect(schema.aggregateRating).toEqual({ "@type": "AggregateRating", ratingValue: 4.6, reviewCount: 12, bestRating: 5, worstRating: 1 });
    expect(schema.review).toEqual([{ "@type": "Review", author: { "@type": "Person", name: "Minh Anh" }, reviewRating: { "@type": "Rating", ratingValue: 5, bestRating: 5, worstRating: 1 }, reviewBody: "Rất hay.", datePublished: "2026-09-12T00:00:00+00:00" }]);
  });
  it("uses the anonymous label when the reviewer has no display name", () => {
    const schema = bookSchema({ siteUrl, locale: "vi", path: "/vi/books/x", paymentsEnabled: true, book: { ...book, reviewSummary: { count: 1, average: 5 } }, reviews: [{ ...reviews[0], reviewerName: null }], anonymousReviewer: "Độc giả" });
    expect((schema.review as { author: { name: string } }[])[0].author.name).toBe("Độc giả");
  });
  it("emits neither when there are no rendered reviews", () => {
    const schema = bookSchema({ siteUrl, locale: "vi", path: "/vi/books/x", paymentsEnabled: true, book: { ...book, reviewSummary: { count: 3, average: 4 } }, reviews: [] });
    expect(schema).not.toHaveProperty("aggregateRating");
    expect(schema).not.toHaveProperty("review");
  });
});
```

- [ ] **Step 2: Implement**

Add `reviews = []` and `anonymousReviewer = "Reader"` to `bookSchema`'s input, and:

```ts
...(book.reviewSummary && reviews.length > 0
  ? {
      aggregateRating: { "@type": "AggregateRating", ratingValue: book.reviewSummary.average, reviewCount: book.reviewSummary.count, bestRating: 5, worstRating: 1 },
      review: reviews.map((review) => ({
        "@type": "Review",
        author: { "@type": "Person", name: review.reviewerName ?? anonymousReviewer },
        reviewRating: { "@type": "Rating", ratingValue: review.rating, bestRating: 5, worstRating: 1 },
        reviewBody: review.body,
        datePublished: review.publishedAt,
      })),
    }
  : {}),
```

- [ ] **Step 3: Run and commit**

Run: `npx vitest run lib/seo`

```bash
git add lib/seo
git commit -m "feat(s13): aggregateRating and review in Book JSON-LD"
```

---

### Task 5: Book page reviews section

**Files:**
- Create: `components/catalog/book-reviews.tsx`, `components/catalog/book-reviews.test.tsx`
- Modify: `app/[lang]/(public)/books/[slug]/page.tsx`
- Modify: `lib/i18n/routes.ts` (`review(bookId)`, `ask(target)` on the catalog routes) and its test
- Modify: dictionaries (`catalog.reviews`)

**Interfaces:**
- Produces `getCatalogRoutes(locale).review(bookId)` → `/{locale}/library/reviews/{bookId}` and `getCatalogRoutes(locale).ask(target: { book: string } | { idea: string })` → `/{locale}/ask?book=…` or `/{locale}/ask?idea=…`.
- Produces `BookReviews({ locale, copy, summary, reviews, reviewHref, askHref })` (server component).
- Dictionary `catalog.reviews`: `{ title, countOne, countOther, average, write, ask, authorReply, anonymousReader, empty }`.

- [ ] **Step 1: Routes test and implementation**

Add to `lib/i18n/routes.test.ts`:

```ts
expect(getCatalogRoutes("vi").review("b1")).toBe("/vi/library/reviews/b1");
expect(getCatalogRoutes("en").ask({ book: "b1" })).toBe("/en/ask?book=b1");
expect(getCatalogRoutes("en").ask({ idea: "i1" })).toBe("/en/ask?idea=i1");
```

Implement in `getCatalogRoutes`:

```ts
review: (bookId: string) => `/${locale}/library/reviews/${bookId}`,
ask: (target: { book: string } | { idea: string }) =>
  "book" in target ? `/${locale}/ask?book=${target.book}` : `/${locale}/ask?idea=${target.idea}`,
```

- [ ] **Step 2: Component test**

```tsx
it("renders the summary, each review with reply, and the two links", () => {
  render(<BookReviews copy={copy} locale="vi" reviewHref="/vi/library/reviews/b1" askHref="/vi/ask?book=b1" summary={{ count: 2, average: 4.5 }}
    reviews={[{ id: "r1", reviewerName: null, rating: 5, body: "Hay", authorReply: "Cảm ơn", authorReplyAt: "2026-09-13T00:00:00Z", publishedAt: "2026-09-12T00:00:00Z" }]} />);
  expect(screen.getByText("4.5")).toBeInTheDocument();
  expect(screen.getByText("2 đánh giá")).toBeInTheDocument();
  expect(screen.getByText("Độc giả")).toBeInTheDocument();
  expect(screen.getByText("Cảm ơn")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Viết đánh giá" })).toHaveAttribute("href", "/vi/library/reviews/b1");
  expect(screen.getByRole("link", { name: "Hỏi tác giả" })).toHaveAttribute("href", "/vi/ask?book=b1");
});
it("renders only the links when there is no summary", () => {
  render(<BookReviews copy={copy} locale="vi" reviewHref="/x" askHref="/y" summary={null} reviews={[]} />);
  expect(screen.queryByText(/đánh giá$/)).toBeNull();
  expect(screen.getAllByRole("link")).toHaveLength(2);
});
```

- [ ] **Step 3: Implement the component**

Stars render as `aria-label={`${rating}/5`}` text `★★★★☆` built from `"★".repeat(rating) + "☆".repeat(5 - rating)`. Each review: name (or `copy.anonymousReader`), `formatDate(publishedAt, locale)`, body in `whitespace-pre-line`, and when `authorReply` a nested `<p>` prefixed by `copy.authorReply`. Count uses `copy.countOne`/`copy.countOther` with `fillTemplate`. Links use `Button` from `components/ui/button` with `render={<Link />}` as the library page does.

Dictionary `en.json` `catalog.reviews`:

```json
"reviews": { "title": "Reader reviews", "countOne": "{count} review", "countOther": "{count} reviews", "average": "Average rating", "write": "Write a review", "ask": "Ask the author", "authorReply": "Reply from the author:", "anonymousReader": "Reader", "empty": "No reviews yet." }
```

`vi.json`:

```json
"reviews": { "title": "Đánh giá từ độc giả", "countOne": "{count} đánh giá", "countOther": "{count} đánh giá", "average": "Điểm trung bình", "write": "Viết đánh giá", "ask": "Hỏi tác giả", "authorReply": "Phản hồi từ tác giả:", "anonymousReader": "Độc giả", "empty": "Chưa có đánh giá." }
```

- [ ] **Step 4: Wire the book page**

In the page, load reviews alongside the dictionary: `const [dictionary, knowledgeLinks, reviews] = await Promise.all([getDictionary(locale), getKnowledgeForBook(locale, book.bookId), getBookReviews(book.bookId, 5)]);`. Pass `reviews` and `anonymousReviewer: dictionary.catalog.reviews.anonymousReader` into `bookSchema`. After the knowledge section render:

```tsx
<section aria-labelledby="book-reviews" className="mt-12">
  <h2 className={sectionTitle} id="book-reviews">{copy.reviews.title}</h2>
  <BookReviews askHref={routes.ask({ book: book.bookId })} copy={copy.reviews} locale={locale} reviewHref={routes.review(book.bookId)} reviews={reviews} summary={book.reviewSummary} />
</section>
```

- [ ] **Step 5: Run and commit**

Run: `npx vitest run components/catalog lib/i18n 'app/[lang]/(public)/books' && npm run typecheck && npm run lint`

```bash
git add components/catalog/book-reviews.tsx components/catalog/book-reviews.test.tsx 'app/[lang]/(public)/books/[slug]/page.tsx' lib/i18n
git commit -m "feat(s13): reviews section on the book page"
```

---

### Task 6: Review page, library link, completion-card links

**Files:**
- Create: `app/[lang]/(account)/library/reviews/[bookId]/page.tsx`, `actions.ts`, `actions.test.ts`
- Create: `components/account/review-form.tsx`, `review-form.test.tsx`
- Modify: `app/[lang]/(account)/library/page.tsx`
- Modify: `components/reader/reader-completion-panel.tsx` and test, `components/reader/reader-client.tsx` (props), `components/reader/reader-mount.tsx` if it re-declares props, `components/reader/reader-client.test.tsx`, `app/[lang]/(reader)/read/[bookId]/page.tsx`, `lib/reader/copy.ts`
- Modify: dictionaries (`library.reviews`, `reader.rateBook`, `reader.askAuthor`)

**Interfaces:**
- Produces `submitBookReviewAction(locale, bookId, previous: ReviewFormState, formData): Promise<ReviewFormState>` and `deleteBookReviewAction(locale, bookId): Promise<void>` where `ReviewFormState = { fieldErrors: Record<string, string>; formError: string | null; savedAt: number | null }` (reuse `AdminFormState` from `lib/catalog/form.ts` under an alias).
- Produces `ReviewForm({ action, deleteAction, review, copy })` (client).
- `ReaderCompletionCopy` gains `rateBook` and `askAuthor`; `ReaderCompletionPanel` gains props `reviewHref: string` and `askHref: string`; `ReaderClientProps` (entitled branch) gains the same two.

- [ ] **Step 1: Write the failing action test**

Mock `@/lib/auth/session` (`requireUser` resolves), `@/lib/data/reviews`, and `next/cache`:

```ts
it("submits a parsed review and revalidates", async () => {
  const form = new FormData(); form.set("rating", "4"); form.set("body", "Hay");
  const state = await submitBookReviewAction("vi", "b1", initialAdminFormState, form);
  expect(submitBookReview).toHaveBeenCalledWith("b1", { rating: 4, body: "Hay" }, "vi");
  expect(revalidatePath).toHaveBeenCalledWith("/[lang]", "layout");
  expect(state.savedAt).not.toBeNull();
});
it("maps NotEntitledToReviewError to a form error", async () => {
  submitBookReview.mockRejectedValueOnce(new NotEntitledToReviewError());
  const form = new FormData(); form.set("rating", "4"); form.set("body", "Hay");
  const state = await submitBookReviewAction("vi", "b1", initialAdminFormState, form);
  expect(state.formError).toBe("not_entitled");
});
```

- [ ] **Step 2: Implement the actions**

```ts
"use server";

export async function submitBookReviewAction(locale: Locale, bookId: string, _previous: AdminFormState, formData: FormData): Promise<AdminFormState> {
  await requireUser(locale, getCatalogRoutes(locale).review(bookId));
  const parsed = reviewInputSchema.safeParse({ rating: readText(formData, "rating"), body: readText(formData, "body") });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error), formError: null, savedAt: null };
  try {
    await submitBookReview(bookId, parsed.data, locale);
  } catch (error) {
    if (error instanceof NotEntitledToReviewError) return { fieldErrors: {}, formError: "not_entitled", savedAt: null };
    return { fieldErrors: {}, formError: "failed", savedAt: null };
  }
  revalidateStorefront();
  revalidatePath(getCatalogRoutes(locale).review(bookId));
  revalidatePath(getLocaleRoutes(locale).library);
  return { fieldErrors: {}, formError: null, savedAt: Date.now() };
}

export async function deleteBookReviewAction(locale: Locale, bookId: string): Promise<void> {
  await requireUser(locale, getCatalogRoutes(locale).review(bookId));
  await deleteBookReview(bookId);
  revalidateStorefront();
  revalidatePath(getCatalogRoutes(locale).review(bookId));
  redirect(getLocaleRoutes(locale).library);
}
```

`formError` holds a key (`not_entitled`, `failed`) that the form maps to dictionary copy, so no English leaks into the customer UI.

- [ ] **Step 3: Form test and component**

Test: renders five radios named `rating` with the current value checked, the body textarea with a `1000` maxLength and a live counter, shows `copy.states[review.status]` and the author reply when present, submits through `useActionState`, and shows `copy.errors.notEntitled` when `state.formError === "not_entitled"`. The Delete button is a separate `<form action={deleteAction}>` with a `confirm`-free design: the button label is `copy.delete` and the library redirect is the confirmation.

Component: `"use client"`, `useActionState(action, initialAdminFormState)`, stars as a `fieldset` of five `<input type="radio" name="rating">` with `<label>` text `★` and `aria-label={`${n}/5`}`, `Textarea` from `components/ui/textarea`, `FieldError`/`FormStatus` equivalents rendered from customer copy (not the admin components, whose text is English), `SubmitButton`.

- [ ] **Step 4: Page**

```tsx
export default async function ReviewPage({ params }: { params: Promise<{ lang: string; bookId: string }> }) {
  const { lang: locale, bookId } = await params;
  if (!isLocale(locale)) notFound();
  const routes = getCatalogRoutes(locale);
  await requireUser(locale, routes.review(bookId));
  const [dictionary, card, review] = await Promise.all([getDictionary(locale), getBookCardById(locale, bookId), getMyBookReview(bookId)]);
  if (!card) notFound();
  const owned = (await getActiveEntitlementBookIds()).includes(bookId);
  const copy = dictionary.library.reviews;
  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader current="library" locale={locale} />
      <main className="mx-auto max-w-[40rem] px-4 py-12 sm:px-8" id="main-content">
        <p className="text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.eyebrow}</p>
        <h1 className="mt-2 font-serif text-3xl">{card.title}</h1>
        {owned ? (
          <ReviewForm action={submitBookReviewAction.bind(null, locale, bookId)} copy={copy} deleteAction={deleteBookReviewAction.bind(null, locale, bookId)} review={review} />
        ) : (
          <p className="mt-8">{copy.notOwned} <Link className={textLink} href={routes.book(card.slug)}>{copy.backToBook}</Link></p>
        )}
      </main>
      <SiteFooter locale={locale} tagline={dictionary.home.footerTagline} />
    </div>
  );
}
```

Check `getActiveEntitlementBookIds` in `lib/data/catalog.ts` for its exact signature (it exists per the survey). Dictionary `library.reviews`: `eyebrow`, `ratingLabel`, `bodyLabel`, `counter` (`{count}/1000`), `save`, `delete`, `notOwned`, `backToBook`, `states.pending`, `states.published`, `states.rejected`, `authorReply`, `errors.notEntitled`, `errors.failed`, `saved`. Vietnamese: "Đánh giá của bạn", "Số sao", "Nhận xét", "{count}/1000", "Lưu đánh giá", "Xoá đánh giá", "Bạn cần sở hữu cuốn sách này để đánh giá.", "Về trang sách", "Đang chờ duyệt", "Đã đăng", "Không được đăng", "Phản hồi từ tác giả", "Bạn cần sở hữu cuốn sách này để đánh giá.", "Không lưu được. Thử lại.", "Đã lưu. Đánh giá sẽ hiện sau khi được duyệt."

- [ ] **Step 5: Library link**

In `app/[lang]/(account)/library/page.tsx`, after the Continue reading link in each item:

```tsx
<Link className="mt-1 block min-h-11 text-sm text-sage-text hover:text-ink" href={getCatalogRoutes(locale).review(item.bookId)}>
  {copy.review}
</Link>
```

Dictionary `library.review`: en `"Review"`, vi `"Đánh giá"`.

- [ ] **Step 6: Completion card**

Panel test: `render(<ReaderCompletionPanel ... reviewHref="/vi/library/reviews/b1" askHref="/vi/ask?book=b1" />)`; expect links named `copy.rateBook` and `copy.askAuthor` with those hrefs. Add to the panel's button row:

```tsx
<Link className={linkClass} href={reviewHref}>{copy.rateBook}</Link>
<Link className={linkClass} href={askHref}>{copy.askAuthor}</Link>
```

where `linkClass` is the existing secondary button class string. Add `rateBook: string; askAuthor: string;` to `ReaderCompletionCopy` and `ReaderCopy`; add `"rateBook": "Rate this book"` / `"Đánh giá sách"` and `"askAuthor": "Ask the author"` / `"Hỏi tác giả"` under `reader` in both dictionaries; add the keys to the copy literal in `reader-client.test.tsx`. Thread `reviewHref` and `askHref` through the entitled branch of `ReaderClientProps`, into `<ReaderCompletionPanel>`, and from the reader page: `reviewHref={getCatalogRoutes(locale).review(book.bookId)}` and `askHref={getCatalogRoutes(locale).ask({ book: book.bookId })}`. Update `reader-mount.tsx` only if it narrows the props type.

- [ ] **Step 7: Run and commit**

Run: `npx vitest run 'app/[lang]/(account)' components/account components/reader lib/i18n && npm run typecheck && npm run lint`

```bash
git add 'app/[lang]/(account)/library' components/account components/reader 'app/[lang]/(reader)' lib/reader/copy.ts lib/i18n
git commit -m "feat(s13): review page, library and completion-card links"
```

---

### Task 7: `/admin/reviews`

**Files:**
- Create: `lib/data/admin-reviews.ts`
- Create: `app/admin/reviews/page.tsx`, `app/admin/reviews/actions.ts`, `actions.test.ts`
- Create: `components/admin/reviews/review-list.tsx`, `review-row.tsx`, `review-row.test.tsx`
- Modify: `components/admin/admin-nav.tsx` and test, `lib/data/admin.ts`, `app/admin/page.tsx`

**Interfaces:**
- Produces `listAdminReviews(status: "pending" | "published" | "rejected"): Promise<AdminReviewDTO[]>`, `moderateReview(id, status)`, `replyReview(id, reply: string | null)`.
- Produces actions `moderateReviewAction(reviewId, status, formData)` (plain form action, returns void, revalidates) and `replyReviewAction(reviewId, previous: AdminFormState, formData): Promise<AdminFormState>`.
- `AdminSummaryDTO` gains `pendingReviewCount` and `newQuestionCount` (the latter reads 0 until Task 8's table exists; implement both counts in Task 11 if preferred, but add the fields here with `pendingReviewCount` live).

- [ ] **Step 1: DAL**

```ts
export async function listAdminReviews(status: AdminReviewStatus): Promise<AdminReviewDTO[]> {
  await requireAdmin();
  const { data, error } = await (await createClient()).rpc("admin_list_reviews", { p_status: status });
  if (error) throw failure("listAdminReviews", error);
  return z.array(adminReviewSchema).parse(data ?? []);
}
export async function moderateReview(reviewId: string, status: AdminReviewStatus): Promise<void> { /* rpc admin_moderate_review */ }
export async function replyReview(reviewId: string, reply: string | null): Promise<void> { /* rpc admin_reply_review */ }
```

- [ ] **Step 2: Actions test**

```ts
it("publishes and revalidates the storefront and the admin list", async () => {
  await moderateReviewAction("r1", "published", new FormData());
  expect(moderateReview).toHaveBeenCalledWith("r1", "published");
  expect(revalidatePath).toHaveBeenCalledWith("/[lang]", "layout");
  expect(revalidatePath).toHaveBeenCalledWith("/admin/reviews");
});
it("rejects an html reply before the DAL", async () => {
  const form = new FormData(); form.set("reply", "<b>x</b>");
  const state = await replyReviewAction("r1", initialAdminFormState, form);
  expect(state.fieldErrors.reply).toBeDefined();
  expect(replyReview).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Actions**

```ts
"use server";
const replySchema = z.object({ reply: plainText(0, 1000, "a reply").nullable() });

export async function moderateReviewAction(reviewId: string, status: AdminReviewStatus, _formData: FormData): Promise<void> {
  await requireAdmin({ next: "/admin/reviews" });
  await moderateReview(reviewId, status);
  revalidateStorefront();
  revalidatePath("/admin/reviews");
}

export async function replyReviewAction(reviewId: string, _previous: AdminFormState, formData: FormData): Promise<AdminFormState> {
  await requireAdmin({ next: "/admin/reviews" });
  const parsed = replySchema.safeParse({ reply: readOptionalText(formData, "reply") });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error), formError: null, savedAt: null };
  try { await replyReview(reviewId, parsed.data.reply); } catch { return { fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null }; }
  revalidateStorefront();
  revalidatePath("/admin/reviews");
  return { fieldErrors: {}, formError: null, savedAt: Date.now() };
}
```

`plainText(0, …)` with `.nullable()`: a blank reply parses to `""`; normalize `""` to `null` before calling the DAL.

- [ ] **Step 4: Page and components**

`app/admin/reviews/page.tsx`: `requireAdmin({ next: "/admin/reviews" })`, read `searchParams.status` (default `pending`, validated against the three values), `listAdminReviews(status)`, `AdminPageHeader eyebrow="Readers" title="Reviews"`, three tab links (`?status=…`), then `<ReviewList reviews status />`. Each `ReviewRow` (client) shows book title (link to `/admin/books/{bookId}`), reviewer, `★` string, body, date, and: for pending → Publish and Reject forms (`<form action={moderateReviewAction.bind(null, id, "published")}>`); for published → Reject; for rejected → Publish; plus a Reply disclosure with a `Textarea name="reply"` and `useActionState(replyReviewAction.bind(null, id))`. Test: the row renders the right buttons per status and the reply form posts.

Admin nav: insert `{ href: "/admin/reviews", label: "Reviews" }` and `{ href: "/admin/questions", label: "Questions" }` after Articles; update `admin-nav.test.tsx` expectations.

`lib/data/admin.ts`: add `supabase.from("book_reviews").select("*", { count: "exact", head: true }).eq("status", "pending")` → `pendingReviewCount`. Dashboard: add `{ label: "Pending reviews", value: summary.pendingReviewCount }` with the error color when `> 0` is not needed; plain.

- [ ] **Step 5: Run and commit**

Run: `npx vitest run app/admin/reviews components/admin lib/data/admin.test.ts && npm run typecheck && npm run lint`

```bash
git add lib/data/admin-reviews.ts app/admin/reviews components/admin/reviews components/admin/admin-nav.tsx components/admin/admin-nav.test.tsx lib/data/admin.ts app/admin/page.tsx
git commit -m "feat(s13): review moderation admin"
```

---

### Task 8: Questions table and reader RPCs

**Files:**
- Create: `supabase/migrations/20260928140000_s13_questions.sql`
- Create: `supabase/tests/061_s13_questions.sql`
- Modify: `lib/supabase/database.types.ts` (regenerate)

**Interfaces:**
- Produces table `public.reader_questions`.
- Produces `submit_reader_question(p_book_id uuid, p_idea_id uuid, p_body text, p_locale text) returns uuid`.
- Produces `get_my_reader_questions() returns jsonb`: array of `{ id, body, locale, status, createdAt, target: { kind: 'book'|'idea', title }, answer: { slug } | null }` newest first, where `answer` is non-null only when the answer idea is published and localized in the question's locale.

- [ ] **Step 1: Write the failing pgTAP file**

Fixtures: two readers, one published book with a vi localization, one draft book, one published idea with a vi localization (insert into `ideas` with `status = 'published'` and `idea_localizations`), one draft idea.

```sql
set local role authenticated;
select set_config('request.jwt.claim.sub', '<reader1>', true);
select throws_ok($$select public.submit_reader_question(null, null, 'Hỏi gì?', 'vi')$$, '22023', null, 'a question needs a target');
select throws_ok($$select public.submit_reader_question('<draft book>', null, 'Hỏi gì?', 'vi')$$, 'P0002', null, 'a draft book is not a target');
select throws_ok($$select public.submit_reader_question(null, '<draft idea>', 'Hỏi gì?', 'vi')$$, 'P0002', null, 'a draft idea is not a target');
select throws_ok($$select public.submit_reader_question('<book>', null, '<a>x</a>', 'vi')$$, '22023', null, 'html is refused');
select throws_ok($$select public.submit_reader_question('<book>', null, repeat('a', 501), 'vi')$$, '22023', null, '501 characters is refused');
select lives_ok($$select public.submit_reader_question('<book>', null, 'Câu 1', 'vi')$$, 'book question');
select lives_ok($$select public.submit_reader_question(null, '<idea>', 'Câu 2', 'vi')$$, 'idea question');
select lives_ok($$select public.submit_reader_question('<book>', '<idea>', 'Câu 3', 'vi')$$, 'both targets');
select lives_ok($$select public.submit_reader_question('<book>', null, 'Câu 4', 'vi')$$, 'fourth');
select lives_ok($$select public.submit_reader_question('<book>', null, 'Câu 5', 'vi')$$, 'fifth');
select throws_ok($$select public.submit_reader_question('<book>', null, 'Câu 6', 'vi')$$, 'EB035', null, 'the sixth open question is refused');
select is(jsonb_array_length(public.get_my_reader_questions()), 5, 'the asker lists five');
select is(public.get_my_reader_questions() -> 0 ->> 'body', 'Câu 5', 'newest first');
select is(public.get_my_reader_questions() -> 0 -> 'target' ->> 'title', 'Sách S13', 'book target title');
select is(public.get_my_reader_questions() -> 0 -> 'answer', 'null'::jsonb, 'no answer yet');
select results_eq($$select count(*) from public.reader_questions$$, array[5::bigint], 'the asker reads own rows through RLS');
select throws_ok($$insert into public.reader_questions (profile_id, book_id, body, locale) select id, '<book>', 'x', 'vi' from public.profiles$$, '42501', null, 'no direct insert');

select set_config('request.jwt.claim.sub', '<reader2>', true);
select results_eq($$select count(*) from public.reader_questions$$, array[0::bigint], 'another reader sees none');
select is(jsonb_array_length(public.get_my_reader_questions()), 0, 'another reader lists none');
reset role;

-- Archiving one frees the cap (status flipped directly as a fixture; the admin RPC is Task 9).
update public.reader_questions set status = 'archived' where body = 'Câu 1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '<reader1>', true);
select lives_ok($$select public.submit_reader_question('<book>', null, 'Câu 6', 'vi')$$, 'the cap counts only new questions');
reset role;
select is(has_function_privilege('anon', 'public.submit_reader_question(uuid, uuid, text, text)', 'EXECUTE'), false, 'anon cannot ask');
```

Plan count accordingly.

- [ ] **Step 2: Write the migration**

```sql
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
```

- [ ] **Step 3: Run, regenerate, commit**

Run: `npm run db:reset && npm run db:test -- supabase/tests/061_s13_questions.sql && npx supabase gen types typescript --local > lib/supabase/database.types.ts`

```bash
git add supabase/migrations/20260928140000_s13_questions.sql supabase/tests/061_s13_questions.sql lib/supabase/database.types.ts
git commit -m "feat(s13): reader questions schema and reader RPCs"
```

---

### Task 9: Question admin RPCs, outbox target, and publish trigger

**Files:**
- Create: `supabase/migrations/20260928150000_s13_questions_admin_outbox.sql`
- Create: `supabase/tests/062_s13_questions_admin_outbox.sql`
- Modify: `lib/supabase/database.types.ts` (regenerate)

**Interfaces:**
- Produces `admin_list_questions(p_status text) returns jsonb`: `{ id, body, locale, status, createdAt, askerName, bookId, bookTitle, ideaId, ideaQuestion, answerIdeaId }`.
- Produces `admin_archive_question(p_question_id uuid)`, `admin_answer_question(p_question_id uuid, p_idea_id uuid)`, `admin_answer_question_with_idea(p_question_id uuid, p_locale text, p_slug text, p_question text, p_short_answer text) returns uuid`.
- `notification_outbox` gains `question_id uuid unique references reader_questions(id) on delete cascade`, template `question_answered`, the three-way target check; `claim_notification_outbox` returns `question_id`.
- Trigger `reader_questions_notify_on_publish` on `public.ideas`.

- [ ] **Step 1: Write the failing pgTAP file**

Fixtures: admin and reader users, a published book, a published idea (`<asked idea>` with `idea_books` to the book), the reader submits `q_book` (book target) and `q_idea` (idea target) through `submit_reader_question`.

```sql
set local role authenticated;
select set_config('request.jwt.claim.sub', '<reader>', true);
select throws_ok($$select public.admin_archive_question('<q_book>')$$, '42501', null, 'a reader cannot archive');
select set_config('request.jwt.claim.sub', '<admin>', true);
select is(jsonb_array_length(public.admin_list_questions('new')), 2, 'admin lists new questions');

-- Answer with a new idea from the book question
select is(
  (select public.admin_answer_question_with_idea('<q_book>', 'vi', 'tra-loi-cau-hoi', 'Câu hỏi?', 'Trả lời ngắn.')) is not null,
  true, 'answering creates an idea');
select results_eq($$select status from public.reader_questions where id = '<q_book>'$$, array['answered'], 'question is answered');
select results_eq(
  $$select count(*) from public.idea_books ib join public.reader_questions q on q.answer_idea_id = ib.idea_id where q.id = '<q_book>' and ib.book_id = '<book>'$$,
  array[1::bigint], 'the new idea relates to the question''s book');
select results_eq($$select action from public.audit_logs where entity_id = '<q_book>'$$, array['reader_question.answer'], 'one answer audit row');
select throws_ok($$select public.admin_archive_question('<q_book>')$$, '22023', null, 'an answered question cannot be archived');

-- Answer the idea question with a new idea: inherits the asked idea's books and links to it
select is((select public.admin_answer_question_with_idea('<q_idea>', 'vi', 'tra-loi-2', 'Hỏi 2?', 'Đáp 2.')) is not null, true, 'second answer');
select results_eq(
  $$select count(*) from public.idea_links il join public.reader_questions q on q.answer_idea_id = il.idea_id where q.id = '<q_idea>' and il.related_idea_id = '<asked idea>'$$,
  array[1::bigint], 'the new idea links to the asked idea');
select results_eq(
  $$select count(*) from public.idea_books ib join public.reader_questions q on q.answer_idea_id = ib.idea_id where q.id = '<q_idea>'$$,
  array[1::bigint], 'the new idea inherits the asked idea''s book');

-- Publishing emails once
select results_eq($$select count(*) from public.notification_outbox where template_key = 'question_answered'$$, array[0::bigint], 'no mail before publish');
reset role;
update public.ideas set status = 'published' where id = (select answer_idea_id from public.reader_questions where id = '<q_book>');
select results_eq($$select count(*) from public.notification_outbox where question_id = '<q_book>'$$, array[1::bigint], 'publish inserts one outbox row');
select results_eq($$select payload ->> 'ideaId' from public.notification_outbox where question_id = '<q_book>'$$,
  array[(select answer_idea_id::text from public.reader_questions where id = '<q_book>')], 'payload carries the idea id');
select isnt((select notified_at from public.reader_questions where id = '<q_book>'), null, 'notified_at is set');
update public.ideas set status = 'draft' where id = (select answer_idea_id from public.reader_questions where id = '<q_book>');
update public.ideas set status = 'published' where id = (select answer_idea_id from public.reader_questions where id = '<q_book>');
select results_eq($$select count(*) from public.notification_outbox where question_id = '<q_book>'$$, array[1::bigint], 'republishing does not insert again');

-- Unpublishing the target book changes nothing about answering
update public.books set status = 'draft' where id = '<book>';
set local role authenticated;
select set_config('request.jwt.claim.sub', '<admin>', true);
select lives_ok($$select public.admin_answer_question('<q_idea>', '<asked idea>')$$, 'relinking an answered question to another idea is allowed');
reset role;

-- Claim returns the row with question_id
select results_eq(
  $$select question_id from public.claim_notification_outbox(25, '00000000-0000-0000-0000-00000000aaaa') where template_key = 'question_answered'$$,
  array['<q_book>'::uuid], 'the claim returns question rows');
select throws_ok(
  $$insert into public.notification_outbox (template_key, profile_id, question_id, entitlement_id) values ('question_answered', (select profile_id from public.reader_questions where id = '<q_book>'), '<q_book>', 'e1340000-0000-0000-0000-000000000001')$$,
  '23514', null, 'a row cannot point at two targets');
```

Note the `claim` must be run as `service_role` or via `set local role postgres`; the test runs as the superuser by default, which can execute it.

- [ ] **Step 2: Write the migration**

```sql
-- S13 question answering (spec section 6) and the answer notification (spec section 9).

-- Outbox: third target --------------------------------------------------------------------------
alter table public.notification_outbox
  add column question_id uuid unique references public.reader_questions(id) on delete cascade;
alter table public.notification_outbox
  drop constraint notification_outbox_template_key_check,
  add constraint notification_outbox_template_key_check check (template_key in ('book_ready', 'gift_claim', 'question_answered')),
  drop constraint notification_outbox_target_check,
  add constraint notification_outbox_target_check
    check ((entitlement_id is not null)::int + (gift_id is not null)::int + (question_id is not null)::int = 1);
-- notification_outbox_book_ready_profile_check (gift_id is not null or profile_id is not null)
-- still holds: a question row always carries the asker's profile.

drop function public.claim_notification_outbox(integer, uuid);
create function public.claim_notification_outbox(p_limit integer, p_lease_token uuid)
returns table (
  id uuid, entitlement_id uuid, profile_id uuid, gift_id uuid, question_id uuid,
  template_key text, payload jsonb, attempt_count integer, delivery_generation integer
)
language plpgsql security definer set search_path = '' as $$
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
  set lease_token = p_lease_token, lease_expires_at = v_lease_expires
  from candidates
  where o.id = candidates.id
  returning o.id, o.entitlement_id, o.profile_id, o.gift_id, o.question_id, o.template_key, o.payload,
            o.attempt_count, o.delivery_generation;
end;
$$;
revoke execute on function public.claim_notification_outbox(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_notification_outbox(integer, uuid) to service_role;

-- Publish trigger ----------------------------------------------------------------------------
create function public.reader_questions_notify_on_publish()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'published' and old.status is distinct from 'published' then
    with due as (
      update public.reader_questions q
      set notified_at = now()
      where q.answer_idea_id = new.id and q.status = 'answered' and q.notified_at is null
      returning q.id, q.profile_id
    )
    insert into public.notification_outbox (question_id, profile_id, template_key, payload)
    select due.id, due.profile_id, 'question_answered', jsonb_build_object('ideaId', new.id) from due;
  end if;
  return new;
end;
$$;
create trigger reader_questions_notify_on_publish
  after update of status on public.ideas
  for each row execute function public.reader_questions_notify_on_publish();

-- Admin RPCs ---------------------------------------------------------------------------------
create function public.admin_list_questions(p_status text)
returns jsonb language sql stable security definer set search_path = '' as $$
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
    from (select * from public.reader_questions where status = p_status order by created_at limit 200) q
    join public.profiles p on p.id = q.profile_id
  ), '[]'::jsonb) end;
$$;

create function public.admin_archive_question(p_question_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;
begin
  if not public.is_admin() then raise exception 'admin_archive_question: caller is not an admin' using errcode = '42501'; end if;
  update public.reader_questions set status = 'archived' where id = p_question_id and status = 'new';
  if not found then
    if exists (select 1 from public.reader_questions where id = p_question_id) then
      raise exception 'admin_archive_question: only a new question can be archived' using errcode = '22023';
    end if;
    raise exception 'admin_archive_question: question % does not exist', p_question_id using errcode = 'P0002';
  end if;
  select pr.id into v_actor from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id)
  values (v_actor, 'reader_question.archive', 'reader_questions', p_question_id);
end;
$$;

create function public.admin_answer_question(p_question_id uuid, p_idea_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;
begin
  if not public.is_admin() then raise exception 'admin_answer_question: caller is not an admin' using errcode = '42501'; end if;
  if not exists (select 1 from public.ideas where id = p_idea_id) then
    raise exception 'admin_answer_question: idea % does not exist', p_idea_id using errcode = 'P0002';
  end if;
  update public.reader_questions
  set status = 'answered', answer_idea_id = p_idea_id, answered_at = coalesce(answered_at, now()), notified_at = null
  where id = p_question_id and status in ('new', 'answered');
  if not found then
    raise exception 'admin_answer_question: question % is missing or archived', p_question_id using errcode = 'P0002';
  end if;
  -- If the idea is already published, notify now rather than waiting for a status change.
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

create function public.admin_answer_question_with_idea(p_question_id uuid, p_locale text, p_slug text, p_question text, p_short_answer text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_idea_id uuid; v_book_id uuid; v_asked_idea_id uuid;
begin
  if not public.is_admin() then raise exception 'admin_answer_question_with_idea: caller is not an admin' using errcode = '42501'; end if;
  select q.book_id, q.idea_id into v_book_id, v_asked_idea_id
  from public.reader_questions q where q.id = p_question_id and q.status = 'new' for update;
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
```

The `idea_links` columns are `(idea_id, related_idea_id, position)` per S12; verify the exact column list in `20260927100000_s12_knowledge_schema.sql` before writing the insert. If `admin_answer_question` is called by `admin_answer_question_with_idea` on a question already in `new`, it writes its own audit row, which is the one the test counts; the create-idea audit row has `entity_id = idea id`, not the question id.

- [ ] **Step 3: Run, regenerate, commit**

Run: `npm run db:reset && npm run db:test -- supabase/tests/062_s13_questions_admin_outbox.sql supabase/tests/0*outbox*.sql && npx supabase gen types typescript --local > lib/supabase/database.types.ts`
Expected: new file passes and the existing outbox/gift pgTAP files still pass (the claim keeps its old behavior for book and gift rows).

```bash
git add supabase/migrations/20260928150000_s13_questions_admin_outbox.sql supabase/tests/062_s13_questions_admin_outbox.sql lib/supabase/database.types.ts
git commit -m "feat(s13): question answering RPCs and answer notification outbox"
```

---

### Task 10: Ask page, question DAL, idea-page link

**Files:**
- Create: `lib/questions/schema.ts`, `schema.test.ts`, `lib/data/questions.ts`
- Create: `app/[lang]/(account)/ask/page.tsx`, `actions.ts`, `actions.test.ts`
- Create: `components/account/ask-form.tsx`, `ask-form.test.tsx`, `components/account/my-questions.tsx`
- Modify: `app/[lang]/(public)/ideas/[slug]/page.tsx`
- Modify: dictionaries (`library.questions`, `knowledge.idea.ask`)

**Interfaces:**
- Produces `questionInputSchema = z.object({ body: plainText(1, 500, "your question"), bookId: z.uuid().optional(), ideaId: z.uuid().optional() }).refine(one of them)`.
- Produces `submitReaderQuestion(input, locale): Promise<string>` (throws `TooManyOpenQuestionsError` on `EB035`, `QuestionTargetNotFoundError` on `P0002`), `getMyReaderQuestions(): Promise<MyQuestion[]>`.
- Produces `submitReaderQuestionAction(locale, previous: AdminFormState, formData): Promise<AdminFormState>`; `formError` keys `too_many`, `target_missing`, `failed`.
- Produces `AskForm({ action, target: { kind, id, title }, copy })` and `MyQuestions({ questions, copy, locale })`.

- [ ] **Step 1: Schema test and implementation**

Tests: accepts `{ body, bookId }`, accepts `{ body, ideaId }`, rejects neither, rejects html, rejects 501 chars. Implementation reuses `plainText` from `lib/reviews/schema.ts`.

- [ ] **Step 2: DAL**

```ts
export async function submitReaderQuestion(input: QuestionInput, locale: Locale): Promise<string> {
  const { data, error } = await (await createClient()).rpc("submit_reader_question", { p_book_id: input.bookId ?? null, p_idea_id: input.ideaId ?? null, p_body: input.body, p_locale: locale });
  if (error?.code === "EB035") throw new TooManyOpenQuestionsError();
  if (error?.code === "P0002") throw new QuestionTargetNotFoundError();
  if (error) throw await failure("submitReaderQuestion", error);
  return z.string().parse(data);
}
export async function getMyReaderQuestions(): Promise<MyQuestion[]> { /* rpc get_my_reader_questions, parse */ }
```

`MyQuestion = { id; body; locale: Locale; status: "new" | "answered" | "archived"; createdAt; target: { kind: "book" | "idea"; title }; answer: { slug } | null }`.

- [ ] **Step 3: Action test and implementation**

```ts
export async function submitReaderQuestionAction(locale: Locale, _previous: AdminFormState, formData: FormData): Promise<AdminFormState> {
  const bookId = readOptionalText(formData, "bookId") ?? undefined;
  const ideaId = readOptionalText(formData, "ideaId") ?? undefined;
  const routes = getCatalogRoutes(locale);
  await requireUser(locale, bookId ? routes.ask({ book: bookId }) : ideaId ? routes.ask({ idea: ideaId }) : getLocaleRoutes(locale).library);
  const parsed = questionInputSchema.safeParse({ body: readText(formData, "body"), bookId, ideaId });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error), formError: null, savedAt: null };
  try {
    await submitReaderQuestion(parsed.data, locale);
  } catch (error) {
    if (error instanceof TooManyOpenQuestionsError) return { fieldErrors: {}, formError: "too_many", savedAt: null };
    if (error instanceof QuestionTargetNotFoundError) return { fieldErrors: {}, formError: "target_missing", savedAt: null };
    return { fieldErrors: {}, formError: "failed", savedAt: null };
  }
  revalidatePath(bookId ? routes.ask({ book: bookId }) : routes.ask({ idea: ideaId! }));
  return { fieldErrors: {}, formError: null, savedAt: Date.now() };
}
```

Tests: happy path calls the DAL with `{ body, bookId }`; `EB035` maps to `too_many`; neither target → field error without calling the DAL.

- [ ] **Step 4: Page**

```tsx
export default async function AskPage({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ book?: string; idea?: string }> }) {
  const { lang: locale } = await params;
  if (!isLocale(locale)) notFound();
  const { book, idea } = await searchParams;
  const hasBook = typeof book === "string" && uuidPattern.test(book);
  const hasIdea = typeof idea === "string" && uuidPattern.test(idea);
  if (hasBook === hasIdea) notFound();
  const routes = getCatalogRoutes(locale);
  await requireUser(locale, hasBook ? routes.ask({ book: book! }) : routes.ask({ idea: idea! }));
  const [dictionary, target, questions] = await Promise.all([
    getDictionary(locale),
    hasBook ? getBookCardById(locale, book!).then((card) => (card ? { kind: "book" as const, id: card.bookId, title: card.title } : null))
            : getPublishedIdeaById(locale, idea!).then((row) => (row ? { kind: "idea" as const, id: row.ideaId, title: row.question } : null)),
    getMyReaderQuestions(),
  ]);
  if (!target) notFound();
  const copy = dictionary.library.questions;
  return (/* SiteHeader, h1 copy.title, target title, <AskForm/>, <MyQuestions/>, SiteFooter */);
}
```

`getPublishedIdeaById(locale, ideaId)` is a new small loader in `lib/data/knowledge.ts` built on `getPublishedIdeas(locale)` (`find` by `ideaId`); `uuidPattern` is the same regex `lib/data/catalog.ts` or `lib/data/books.ts` already uses for `assertUuid`.

`MyQuestions` renders each question with target title, `formatDate(createdAt)`, `copy.states[status]`, and for `answer` a `Link` to `getKnowledgeRoutes(locale).idea(answer.slug)` labelled `copy.readAnswer`.

Dictionary `library.questions` (vi): `title` "Hỏi tác giả", `about` "Về: {title}", `bodyLabel` "Câu hỏi của bạn", `counter` "{count}/500", `send` "Gửi câu hỏi", `sent` "Đã gửi. Nếu tác giả trả lời, bạn sẽ nhận được email.", `mineTitle` "Câu hỏi của bạn", `readAnswer` "Đọc câu trả lời", `states` {"new": "Đang chờ", "answered": "Đã trả lời", "archived": "Đã lưu trữ"}, `errors` {"tooMany": "Bạn đang có 5 câu hỏi chờ trả lời. Hãy đợi tác giả trả lời trước.", "targetMissing": "Nội dung này không còn tồn tại.", "failed": "Không gửi được. Thử lại."}. English equivalents.

- [ ] **Step 5: Idea page link**

After the `<header>` in `app/[lang]/(public)/ideas/[slug]/page.tsx`:

```tsx
<p className="mb-10">
  <Link className={textLink} href={getCatalogRoutes(locale).ask({ idea: idea.ideaId })}>{copy.ask}</Link>
</p>
```

Dictionary `knowledge.idea.ask`: en "Ask the author about this", vi "Hỏi tác giả về điều này".

- [ ] **Step 6: Run and commit**

Run: `npx vitest run lib/questions lib/data 'app/[lang]/(account)/ask' components/account 'app/[lang]/(public)/ideas' lib/i18n && npm run typecheck && npm run lint`

```bash
git add lib/questions lib/data/questions.ts lib/data/knowledge.ts 'app/[lang]/(account)/ask' components/account 'app/[lang]/(public)/ideas' lib/i18n
git commit -m "feat(s13): ask-the-author page and idea link"
```

---

### Task 11: `/admin/questions`

**Files:**
- Create: `lib/data/admin-questions.ts`
- Create: `app/admin/questions/page.tsx`, `actions.ts`, `actions.test.ts`
- Create: `components/admin/questions/question-list.tsx`, `question-row.tsx`, `question-row.test.tsx`, `answer-with-idea-form.tsx`
- Modify: `lib/data/admin.ts` (`newQuestionCount`), `app/admin/page.tsx`

**Interfaces:**
- Produces `listAdminQuestions(status)`, `archiveQuestion(id)`, `answerQuestion(id, ideaId)`, `answerQuestionWithIdea(id, input: IdeaCreateInput): Promise<{ ideaId: string }>`.
- Produces actions `archiveQuestionAction(questionId, formData)`, `answerQuestionAction(questionId, previous, formData)` (field `ideaId`), `answerWithIdeaAction(questionId, previous, formData)` (fields `locale`, `slug`, `question`, `shortAnswer`; on success `redirect` to `/admin/ideas/{ideaId}`).

- [ ] **Step 1: Action tests**

`answerWithIdeaAction` parses with `ideaCreateSchema` from `lib/catalog/schemas.ts`, calls the DAL, calls `revalidateKnowledgeHub("idea", ideaId)` and `revalidatePath("/admin/questions")`, then redirects. `archiveQuestionAction` calls the DAL and revalidates `/admin/questions`. `answerQuestionAction` validates `ideaId` as a UUID.

- [ ] **Step 2: Page and components**

Page: `requireAdmin`, `status` from search params (default `new`), `listAdminQuestions(status)`, published-and-draft idea options from `listAdminKnowledge("idea")` for the "Link to idea" select. `QuestionRow` (client): date, asker, target (link to `/admin/books/{bookId}` or `/admin/ideas/{ideaId}`), body; for `new`: Archive form, a disclosure "Answer with a new idea" holding `AnswerWithIdeaForm` (locale select defaulting to the question's locale, slug, question prefilled with the body, short answer textarea), and a "Link to idea" form with a `NativeSelect name="ideaId"`. For `answered`: a link to `/admin/ideas/{answerIdeaId}`.

Dashboard: `newQuestionCount` from `reader_questions` with `status = 'new'`; stat "New questions".

- [ ] **Step 3: Run and commit**

Run: `npx vitest run app/admin/questions components/admin/questions lib/data/admin.test.ts && npm run typecheck && npm run lint`

```bash
git add lib/data/admin-questions.ts app/admin/questions components/admin/questions lib/data/admin.ts app/admin/page.tsx
git commit -m "feat(s13): reader questions admin inbox"
```

---

### Task 12: `question_answered` email

**Files:**
- Create: `lib/email/question-answered.ts`, `question-answered.test.ts`
- Modify: `lib/email/outbox.ts`, `lib/email/outbox.test.ts`
- Modify: dictionaries (`email.questionAnswered`)

**Interfaces:**
- Produces `buildQuestionAnsweredEmail({ locale, recipientName, ideaTitle, ideaUrl }): { subject; text; html }`.
- `ClaimedRow` gains `question_id: string | null`; `buildMessage` gains the `question_answered` branch; `resolveQuestionAnsweredDelivery(client, row, siteUrl)` returns `{ to, locale, recipientName, ideaTitle, ideaUrl }`.

- [ ] **Step 1: Template test**

```ts
it("renders the Vietnamese answer email with the idea link", () => {
  const mail = buildQuestionAnsweredEmail({ locale: "vi", recipientName: "Minh", ideaTitle: "Tại sao vẫn phải đọc?", ideaUrl: "https://books.example/vi/ideas/tai-sao" });
  expect(mail.subject).toBe("Tác giả đã trả lời câu hỏi của bạn");
  expect(mail.text).toContain("Chào Minh,");
  expect(mail.text).toContain("https://books.example/vi/ideas/tai-sao");
  expect(mail.html).toContain('<a href="https://books.example/vi/ideas/tai-sao">');
});
```

Dictionary `email.questionAnswered` (vi): `subject` "Tác giả đã trả lời câu hỏi của bạn", `greetingNamed` "Chào {name},", `greetingGeneric` "Chào bạn,", `body` "Câu hỏi bạn gửi trên Infinity Books đã được trả lời trong bài: “{title}”.", `read` "Đọc câu trả lời", `signOff` "Chúc bạn đọc vui,\nInfinity Books". English: "The author answered your question", "Hi {name},", "Hi,", "The question you sent on Infinity Books has been answered in: “{title}”.", "Read the answer", "Happy reading,\nInfinity Books".

- [ ] **Step 2: Template**

Mirror `lib/email/book-ready.ts` with `fill`, `singleLine`, `escapeHtml`.

- [ ] **Step 3: Outbox test**

In `lib/email/outbox.test.ts`, following the existing fake-client pattern for a `book_ready` row: a claimed row `{ template_key: "question_answered", question_id: "q1", profile_id: "p1", payload: { ideaId: "i1" } }` resolves the profile (`display_name`, `locale: "vi"`), the verified identity email, and the idea localization (`idea_localizations` where `idea_id = i1` and `locale = vi`, joined to `ideas.status = 'published'`), and sends to that email with the URL `https://site/vi/ideas/<slug>` and `idempotencyKey` `question-answered/<outbox id>/<generation>` (match `deliveryKey`'s format). Second test: no vi localization but an en one → URL under `/en/`. Third: no verified identity → `DeliveryDataError("recipient_unverified")` recorded through `fail_notification_outbox`, batch continues.

- [ ] **Step 4: Outbox implementation**

```ts
type QuestionRow = ClaimedRow & { question_id: string; profile_id: string; payload: Json };

function asQuestionRow(row: ClaimedRow): QuestionRow {
  if (row.question_id === null || row.profile_id === null || row.payload === null) throw new DeliveryDataError("unsupported_template");
  return row as QuestionRow;
}

function readIdeaId(payload: Json): string {
  const ideaId = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, Json>).ideaId : null;
  if (typeof ideaId !== "string" || !/^[0-9a-f-]{36}$/i.test(ideaId)) throw new DeliveryDataError("question_payload_invalid");
  return ideaId;
}

async function resolveQuestionAnsweredDelivery(client: SupabaseClient<Database>, row: QuestionRow, siteUrl: string) {
  const ideaId = readIdeaId(row.payload);
  const [profile, identity] = await Promise.all([/* same two queries as resolveBookReadyDelivery */]);
  if (profile.error || identity.error) throw dataUnavailable();
  if (!profile.data) throw new DeliveryDataError("profile_not_found");
  if (!identity.data) throw new DeliveryDataError("recipient_unverified");
  const locale = resolveLocale(profile.data.locale);
  const localizations = await client.from("idea_localizations").select("locale, slug, question, ideas!inner(status)").eq("idea_id", ideaId).eq("ideas.status", "published");
  if (localizations.error) throw dataUnavailable();
  const chosen = localizations.data.find((l) => l.locale === locale) ?? localizations.data[0];
  if (!chosen || !isLocale(chosen.locale)) throw new DeliveryDataError("unsupported_locale");
  return {
    to: identity.data.normalized_email,
    locale: chosen.locale,
    recipientName: profile.data.display_name,
    ideaTitle: chosen.question,
    ideaUrl: new URL(getKnowledgeRoutes(chosen.locale).idea(chosen.slug), siteUrl).toString(),
  };
}
```

Add the branch to `buildMessage` with `idempotencyKey: deliveryKey("question-answered", row)`. Extend the `ClaimedRow` `Omit`/intersection with `question_id: string | null`. `lib/ops/types.ts` `OutboxRow` and the `loadStuckOutbox` loaders are not changed in this task: a stuck question email is not reported by the `stuck_notification` rule in S13 (recorded as a known gap in the runbook).

- [ ] **Step 5: Run and commit**

Run: `npx vitest run lib/email lib/i18n`

```bash
git add lib/email lib/i18n/dictionaries
git commit -m "feat(s13): question_answered email delivery"
```

---

### Task 13: Ops rule `stale_reader_question`

**Files:**
- Create: `supabase/migrations/20260928160000_s13_operations_alert_state_questions.sql`
- Create: `supabase/tests/063_s13_operations_alert_state.sql`
- Modify: `lib/ops/types.ts`, `lib/ops/checks.ts`, `lib/ops/checks.test.ts`, `lib/data/operations.ts`, `components/admin/operations-panel.tsx` (only if it enumerates rules beyond `RULE_LABELS`)

- [ ] **Step 1: pgTAP**

```sql
begin;
select plan(2);
select lives_ok($$insert into public.operations_alert_state (rule_name) values ('stale_reader_question') on conflict (rule_name) do nothing$$, 'the rule name is accepted');
select results_eq($$select count(*) from public.operations_alert_state where rule_name = 'stale_reader_question'$$, array[1::bigint], 'the row is seeded');
select * from finish();
rollback;
```

- [ ] **Step 2: Migration**

Copy `20260922150000_operations_alert_state_manual_claims.sql`, extend the check list with `'stale_reader_question'`, seed the row.

- [ ] **Step 3: Checks test**

```ts
it("reports a new question older than 7 days and nothing younger", () => {
  const now = new Date("2026-10-10T00:00:00Z");
  const report = evaluateOperations({ ...emptySnapshot, readerQuestions: [
    { id: "q-old", createdAt: "2026-10-01T00:00:00Z" },
    { id: "q-new", createdAt: "2026-10-08T00:00:00Z" },
  ] }, now);
  expect(report.findings.stale_reader_question).toEqual([
    { id: "q-old", rule: "stale_reader_question", occurredAt: "2026-10-01T00:00:00.000Z", summary: "A reader question has waited more than 7 days.", repairPath: "/admin/questions" },
  ]);
});
```

- [ ] **Step 4: Implement**

`lib/ops/types.ts`: add `"stale_reader_question"` to `OPS_RULE_NAMES`, `RULE_LABELS.stale_reader_question = "Unanswered reader questions"`, `ReaderQuestionRow = { id: string; createdAt: string }`, `OperationsSnapshot.readerQuestions: ReaderQuestionRow[]`. `lib/ops/checks.ts`: `export const STALE_READER_QUESTION_MS = 7 * 24 * 60 * 60_000;`, `SUMMARIES.staleQuestion`, a `staleReaderQuestions(snapshot, now)` filter, and the key in `evaluateOperations`. `lib/data/operations.ts`: `loadReaderQuestions(client)` selecting `id, created_at` where `status = 'new'`, ordered oldest first, limited to `MAX_ROWS_PER_RULE`; add to `loadOperationsSnapshot`. Fix every `OperationsSnapshot` literal in tests (`emptySnapshot` helpers) to include `readerQuestions: []`.

- [ ] **Step 5: Run and commit**

Run: `npm run db:reset && npm run db:test -- supabase/tests/063_s13_operations_alert_state.sql && npx vitest run lib/ops lib/data/operations.test.ts app/api/operations && npm run typecheck`

```bash
git add supabase/migrations/20260928160000_s13_operations_alert_state_questions.sql supabase/tests/063_s13_operations_alert_state.sql lib/ops lib/data/operations.ts components/admin/operations-panel.tsx
git commit -m "feat(s13): stale reader question operations rule"
```

---

### Task 14: End-to-end, runbook, and final gates

**Files:**
- Create: `e2e/reader-voice.spec.ts`
- Create: `docs/runbooks/reader-voice.md`
- Modify: `docs/runbooks/seo-and-operations.md` (the new rule and template in the worker section)

- [ ] **Step 1: E2E spec**

```ts
import { expect, test } from "@playwright/test";

import { seedCatalogBook } from "./support/catalog";
import { createReader, signInAs } from "./support/commerce";
import { readLatestLink } from "./support/mailpit";
import { grantEntitlement } from "./support/publication";
import { revalidateStorefront } from "./support/revalidate";

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test("an owner reviews, an admin publishes, and the book page shows the review with aggregateRating", async ({ page, request }) => {
  const suffix = unique();
  const slug = `review-${suffix}`;
  const { bookId } = await seedCatalogBook({ suffix, localizations: { vi: { slug, title: `Review ${suffix}` } } });
  const reader = await createReader(`reviewer-${suffix}`);
  await grantEntitlement(bookId, reader.email);

  await signInAs(page, reader.email, `/vi/library/reviews/${bookId}`);
  await page.getByLabel("5/5").check();
  await page.getByLabel("Nhận xét").fill("Cuốn sách rất hay.");
  await page.getByRole("button", { name: "Lưu đánh giá" }).click();
  await expect(page.getByText("Đang chờ duyệt")).toBeVisible();

  const admin = await createReader(`review-admin-${suffix}`, { admin: true });
  await signInAs(page, admin.email, "/admin/reviews");
  const row = page.getByRole("row", { name: new RegExp(`Review ${suffix}`) });
  await row.getByRole("button", { name: "Publish" }).click();
  await row.getByRole("button", { name: "Reply" }).click();
  await row.getByLabel("Reply").fill("Cảm ơn bạn đã đọc.");
  await row.getByRole("button", { name: "Save reply" }).click();
  await revalidateStorefront(request);

  await page.goto(`/vi/books/${slug}`);
  await expect(page.getByText("Cuốn sách rất hay.")).toBeVisible();
  await expect(page.getByText("Cảm ơn bạn đã đọc.")).toBeVisible();
  const [book] = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent()) ?? "[]");
  expect(book.aggregateRating).toEqual({ "@type": "AggregateRating", ratingValue: 5, reviewCount: 1, bestRating: 5, worstRating: 1 });
  expect(book.review).toHaveLength(1);
});

test("a reader asks from an idea, the admin answers with a new idea, publishing emails the asker", async ({ page, request }) => {
  const suffix = unique();
  const { bookId } = await seedCatalogBook({ suffix, localizations: { vi: { slug: `ask-${suffix}`, title: `Ask ${suffix}` } } });
  // seedPublishedIdea from e2e/support/knowledge.ts: a published vi idea related to the book.
  const { ideaId, slug: ideaSlug } = await seedPublishedIdea({ suffix, bookId, locale: "vi" });
  const reader = await createReader(`asker-${suffix}`);

  await signInAs(page, reader.email, `/vi/ideas/${ideaSlug}`);
  await page.getByRole("link", { name: "Hỏi tác giả về điều này" }).click();
  await page.getByLabel("Câu hỏi của bạn").fill("Làm sao để đọc chậm hơn?");
  await page.getByRole("button", { name: "Gửi câu hỏi" }).click();
  await expect(page.getByText("Đang chờ")).toBeVisible();

  const admin = await createReader(`ask-admin-${suffix}`, { admin: true });
  await signInAs(page, admin.email, "/admin/questions");
  const row = page.getByRole("row", { name: /Làm sao để đọc chậm hơn\?/ });
  await row.getByRole("button", { name: "Answer with a new idea" }).click();
  await row.getByLabel("Slug").fill(`doc-cham-${suffix}`);
  await row.getByLabel("Short answer").fill("Đọc từng đoạn và dừng lại.");
  await row.getByRole("button", { name: "Create idea" }).click();
  await expect(page).toHaveURL(/\/admin\/ideas\//);
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText("published")).toBeVisible();

  const link = await readLatestLink(reader.email);
  expect(link).toContain(`/vi/ideas/doc-cham-${suffix}`);

  await signInAs(page, reader.email, `/vi/ask?idea=${ideaId}`);
  await expect(page.getByRole("link", { name: "Đọc câu trả lời" })).toHaveAttribute("href", `/vi/ideas/doc-cham-${suffix}`);
});
```

Match the admin button labels to the components built in Tasks 7 and 11, and the idea publish control to `components/admin/knowledge/*` (grep for the Publish button's accessible name). `readLatestLink` from `e2e/support/mailpit.ts` returns the first link in the newest message; if the signature differs, adapt. The idea publish in the editor may need the idea's readiness satisfied (one content block): if `publish_idea` refuses, add a paragraph block through the editor first using `paragraphBlock` from `e2e/support/knowledge.ts` and the localization form.

- [ ] **Step 2: Runbook**

`docs/runbooks/reader-voice.md` sections: 1. What readers can do (one review per owned book; questions capped at 5 open). 2. Moderating reviews (pending list, publish/reject, what the reader sees in each state, that an edit returns a review to pending). 3. Replying as the author (the reply is public, 1,000 characters, plain text). 4. Answering questions (new idea vs link to existing; what the asker is emailed and when; that unpublishing does not retract the email). 5. Alerts (`stale_reader_question` after 7 days; a stuck `question_answered` email is not yet reported by `stuck_notification`). 6. Privacy (who can read a question; what audit rows contain). 7. Local testing pointers.

`docs/runbooks/seo-and-operations.md`: in the worker section, add `question_answered` to the template list and `stale_reader_question` to the rule list, and the note that `claim_notification_outbox` now returns `question_id`.

- [ ] **Step 3: Final gates**

```bash
npm run check
npm run db:reset && npm run db:test
npm run check:full
```

Expected: all green on an owned local stack. Paste the summary lines into the PR description.

- [ ] **Step 4: Commit**

```bash
git add e2e/reader-voice.spec.ts docs/runbooks/reader-voice.md docs/runbooks/seo-and-operations.md
git commit -m "test(s13): reader voice acceptance; runbooks"
```
