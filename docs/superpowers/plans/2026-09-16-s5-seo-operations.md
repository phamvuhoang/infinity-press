# S5 SEO and Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the public ebook catalog discoverable, record a private launch funnel, send one durable book-ready email for each entitlement, and give an admin a clear view of launch failures.

**Architecture:** Postgres owns durable analytics events, the notification outbox, leases, deduplication, and alert state. Next.js owns metadata, structured data, safe redirect resolution, browser event intake, email rendering, Resend calls, operational checks, and the admin view. Supabase `pg_cron` and `pg_net` call one secret worker route every five minutes because Vercel Hobby cron cannot meet the payment-event alert window.

**Tech Stack:** Next.js 16 App Router and Proxy, React 19, TypeScript, Supabase Postgres, pgTAP, Zod 4, Vitest, Testing Library, Playwright, Resend HTTP API, Vercel Speed Insights, `node:crypto`

**Spec:** `docs/superpowers/specs/2026-09-16-s5-seo-operations-design.md` (parent: `docs/superpowers/specs/2026-09-13-remaining-mvp-ebook-launch-design.md`, section S5)

## Global Constraints

- Vercel is on the Hobby plan. Do not add Vercel cron. Supabase schedules the worker.
- Resend free tier is the production email provider. Send transactional book-ready and operator-alert messages only.
- Customer routes stay under `/{locale}` for `vi` and `en`. `/admin` stays unprefixed and English-only.
- Every protected page and Server Action calls `requireUser()` or `requireAdmin()` itself. A layout is never the only authorization control.
- Create a service-role client only after an admin gate, a valid worker bearer token, or another trusted server boundary passes.
- Keep `RESEND_API_KEY` and `OPS_WORKER_SECRET` out of browser bundles and logs.
- Analytics rows use explicit columns. Do not add JSON properties, book text, search text, reader locations, email addresses, IP addresses, or raw user-agent strings.
- Analytics and email failures never roll back grants, purchases, publishing, progress, or reader-setting changes.
- Keep EPUB source and processed resources private. Do not change the reader engine or sanitization boundary.
- Stored redirects accept exact public paths only. Reject schemes, hosts, fragments, protocol-relative paths, backslashes, and private destinations.
- Add new migrations after `20260916100000_reader_completion.sql`. Never edit an applied migration.
- Regenerate `lib/supabase/database.types.ts` after the migrations.
- Read the local Next.js 16 guides before changing metadata, sitemap, robots, route handlers, Proxy, or caching. The required guides are listed in the relevant tasks.
- Run database and Playwright tests only against a local Supabase stack. Follow `docs/runbooks/testing-environments.md`.
- Use one supplied `now` value for each operations run so rule results and alert fingerprints are deterministic.
- Preserve request IDs in worker responses and safe server logs.
- Use TDD for every behavior change. First observe the focused test fail for the expected reason. Then implement the smallest passing change.
- Run `npm run check` after each task. Run `npm run check:full`, `npm run db:reset`, and `npm run db:test` before completion.
- Never stage `cmd.txt`, `.env.local`, EPUB files, secrets, tokens, or customer data.

## Decisions This Plan Locks In

1. `analytics_events` is append-only. Browser roles cannot write it directly.
2. A nullable unique `dedupe_key` protects server and trigger events from duplicate inserts.
3. One `notification_outbox` row exists for each entitlement. Existing entitlements are not backfilled.
4. The outbox claims only currently active entitlements. A revoked entitlement stays pending without consuming attempts. Reactivation makes it claimable again.
5. A claim handles at most 25 rows, lasts five minutes, and uses `for update skip locked`.
6. Failed sends retry after 1 minute, 5 minutes, 30 minutes, 2 hours, and 6 hours. The sixth failure is terminal and visible to operations.
7. Resend idempotency uses `book-ready/<outbox-id>`.
8. The production worker is `POST /api/operations/run`. It accepts only `Authorization: Bearer <OPS_WORKER_SECRET>`.
9. Operational rules report stale EPUB work, a completed order with no active or intentionally revoked entitlement, an unprocessed payment event older than five minutes, and an outbox row after its fourth failed attempt.
10. Alerts send when a rule becomes active, its finding fingerprint changes, or it stays active for 24 hours. A resolved rule becomes inactive without a recovery email.
11. Redirect lookup runs before auth in Proxy. It handles `GET` and `HEAD`, drops the old query string, returns `308`, and uses a 60-second process-local cache only as an optimization.
12. Product analytics uses a browser beacon for actual page or reader activity and server inserts for durable business outcomes.
13. Progress milestones use the winning database write. The completion threshold is `0.99`.
14. `change_reader_setting` records that a setting changed. It does not record the setting name or value.
15. Sitemap entries include only published, visible public content. Private route groups set `noindex, nofollow`.

## File Map

| Path | Responsibility |
| --- | --- |
| `supabase/migrations/20260916110000_s5_observability_outbox.sql` | Analytics table, outbox table, claim/result RPCs, entitlement outbox trigger, grants, indexes |
| `supabase/migrations/20260916120000_s5_event_triggers.sql` | Progress, publication, and EPUB job analytics triggers |
| `supabase/migrations/20260916130000_s5_redirects_and_operations.sql` | Public redirect RPC, alert-state table, grants and indexes |
| `supabase/tests/021_s5_observability_outbox.sql` | Analytics privacy, outbox creation, lease, retry, and concurrency contracts |
| `supabase/tests/022_s5_event_triggers.sql` | Progress, publication, and EPUB event deduplication |
| `supabase/tests/023_s5_redirects_and_operations.sql` | Redirect visibility and alert-state access |
| `lib/supabase/database.types.ts` | Generated database types |
| `lib/config/server-env-schema.ts` | Resend and worker environment validation |
| `lib/config/server-env.test.ts` | Environment validation coverage |
| `lib/analytics/events.ts` | Typed event allowlist and trusted inserts |
| `lib/analytics/events.test.ts` | Event validation, dedupe, and best-effort behavior |
| `lib/analytics/browser.ts` | Same-origin beacon helper and device classification input |
| `components/analytics/analytics-event.tsx` | One-shot client event component |
| `app/api/analytics/events/route.ts` | Same-origin browser event intake |
| `app/api/analytics/events/route.test.ts` | Intake validation and identity tests |
| `lib/email/provider.ts` | Provider-neutral mail contract and safe errors |
| `lib/email/resend.ts` | Resend HTTP adapter |
| `lib/email/resend.test.ts` | Request, idempotency, and error mapping tests |
| `lib/email/book-ready.ts` | Localized book-ready subject, HTML, and text |
| `lib/email/book-ready.test.ts` | Locale and escaping tests |
| `lib/email/outbox.ts` | Claim, resolve, deliver, retry, and complete loop |
| `lib/email/outbox.test.ts` | Lease ownership, continuation, and retry tests |
| `lib/ops/types.ts` | Rule names, findings, groups, and worker result types |
| `lib/data/operations.ts` | Authenticated or service-role operations queries |
| `lib/ops/checks.ts` | Pure operational rule evaluation |
| `lib/ops/checks.test.ts` | Boundary and intentional-revocation tests |
| `lib/ops/alerts.ts` | Fingerprints, state transitions, and alert delivery |
| `lib/ops/alerts.test.ts` | New, changed, overdue, and resolved state tests |
| `lib/ops/worker-auth.ts` | Constant-time bearer validation |
| `lib/ops/worker-auth.test.ts` | Missing, malformed, wrong, and valid token tests |
| `app/api/operations/run/route.ts` | Scheduled outbox and operations worker |
| `app/api/operations/run/route.test.ts` | Auth, safe response, and partial mail failure tests |
| `app/admin/operations/page.tsx` | Live grouped operations view |
| `components/admin/operations-panel.tsx` | Finding groups and repair links |
| `components/admin/admin-nav.tsx` | Operations navigation item |
| `lib/seo/metadata.ts` | Canonical, alternates, Open Graph, and robots builders |
| `lib/seo/metadata.test.ts` | Locale and URL metadata tests |
| `lib/seo/json-ld.ts` | Typed Organization, Book, Offer, Person, and breadcrumb values |
| `lib/seo/json-ld.test.ts` | Published, free, paid, and coming-soon schema tests |
| `components/seo/json-ld.tsx` | Safe script serialization |
| `components/seo/json-ld.test.tsx` | Less-than escaping test |
| `app/opengraph-image.tsx` | Default 1200 by 630 branded image |
| `app/sitemap.ts` | Published localized URLs |
| `app/robots.ts` | Public crawler rules and private exclusions |
| `lib/redirects/resolve.ts` | Exact-path lookup, destination validation, and short cache |
| `lib/redirects/resolve.test.ts` | Safety, cache, and miss tests |
| `proxy.ts` | Redirect resolution before session and route access |
| `app/layout.tsx` | Metadata base and Speed Insights |
| `app/[locale]/(public)/page.tsx` | Home metadata and Organization schema |
| `app/[locale]/(public)/books/page.tsx` | Catalog canonical and locale metadata |
| `app/[locale]/(public)/books/[slug]/page.tsx` | Book metadata, Book schema, breadcrumbs, and view event |
| `components/catalog/entity-page.tsx` | Entity metadata and breadcrumbs |
| `app/[locale]/(account)/layout.tsx` | Private account robots metadata |
| `app/[locale]/(auth)/layout.tsx` | Private auth robots metadata |
| `app/[locale]/(reader)/layout.tsx` | Private reader robots metadata |
| `app/admin/layout.tsx` | Private admin robots metadata |
| `app/[locale]/(account)/library/page.tsx` | `view_library` beacon |
| `app/[locale]/(public)/books/[slug]/actions.ts` | `begin_checkout` server event |
| `lib/commerce/simulator-webhook.ts` | `purchase` and `payment_failed` server events |
| `components/reader/reader-client.tsx` | Reader-open and setting-change events |
| `app/[locale]/(reader)/read/[bookId]/page.tsx` | Reader analytics identifiers |
| `app/[locale]/(public)/books/[slug]/sample/page.tsx` | Sample analytics identifiers |
| `lib/i18n/dictionaries/en.json` | English email and operations copy |
| `lib/i18n/dictionaries/vi.json` | Vietnamese email copy |
| `e2e/seo-operations.spec.ts` | Public SEO, redirect, private robots, and admin operations journeys |
| `docs/runbooks/seo-and-operations.md` | Resend, Vault, scheduler, alerts, Speed Insights, and recovery |
| `docs/runbooks/deployment.md` | Production variables and S5 deployment order |
| `docs/runbooks/testing-environments.md` | Local no-network email setup |
| `docs/runbooks/storefront.md` | Canonical URLs and stored redirect behavior |
| `.env.example` | Documented S5 environment variables |

---

### Task 1: Durable analytics and notification outbox

**Files:**
- Create: `supabase/migrations/20260916110000_s5_observability_outbox.sql`
- Create: `supabase/tests/021_s5_observability_outbox.sql`
- Modify: `lib/supabase/database.types.ts`

**Interfaces:**
- `public.analytics_events` accepts only the approved event names and explicit nullable references.
- `public.notification_outbox` has one row per entitlement.
- `public.claim_notification_outbox(p_limit integer, p_lease_token uuid)` returns claimed rows for active entitlements only.
- `public.complete_notification_outbox(p_id uuid, p_lease_token uuid, p_provider_message_id text)` marks provider acceptance.
- `public.fail_notification_outbox(p_id uuid, p_lease_token uuid, p_error_code text)` records a safe error and computes the next retry.
- All three functions execute only for `service_role`.

- [ ] **Step 1: Write the failing pgTAP contract**

Create `supabase/tests/021_s5_observability_outbox.sql` with fixed UUID fixtures and named pgTAP assertions:

```sql
begin;
select plan(30);

select has_table('public', 'analytics_events');
select has_table('public', 'notification_outbox');
select has_function('public', 'claim_notification_outbox', array['integer', 'uuid']);
select has_function('public', 'complete_notification_outbox', array['uuid', 'uuid', 'text']);
select has_function('public', 'fail_notification_outbox', array['uuid', 'uuid', 'text']);

select throws_ok(
  $$insert into public.analytics_events(event_name) values ('raw_reader_location')$$,
  '23514'
);

-- Insert an active entitlement and prove that one book_ready row appears.
-- Insert the same logical grant again and prove the unique entitlement row remains one.
-- Insert a revoked entitlement and prove no row appears.
-- Change revoked to active and prove one row appears.
-- Prove the migration does not backfill an entitlement inserted before the trigger exists.
-- Claim with two lease tokens and prove each outbox row appears in at most one claim.
-- Revoke one entitlement and prove its pending row is not claimable.
-- Complete with a wrong token and prove zero rows change.
-- Complete with the owning token and prove sent_at and provider_message_id are set.
-- Fail five fresh claims and prove available_at follows 1m, 5m, 30m, 2h, and 6h.
-- Fail the sixth claim and prove attempt_count is 6 and the row is no longer claimable.
-- Switch to authenticated and anon roles and prove direct inserts fail.
-- Switch to an admin identity and prove select succeeds but update and delete fail.

select * from finish();
rollback;
```

Use the existing S3 and S4 fixture style for authors, books, profiles, and entitlements. Replace each contract comment with a named pgTAP assertion. Fill reused IDs through `\gset`. Keep the test plan count equal to the final assertion count.

- [ ] **Step 2: Run the focused database test and observe the missing-schema failure**

Run:

```bash
npm run db:reset
supabase test db supabase/tests/021_s5_observability_outbox.sql
```

Expected: pgTAP fails because the tables and functions do not exist.

- [ ] **Step 3: Add the schema and grants**

Create `supabase/migrations/20260916110000_s5_observability_outbox.sql` with these constraints:

```sql
create table public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  event_name text not null check (event_name in (
    'view_book', 'open_sample', 'begin_checkout', 'purchase', 'payment_failed',
    'open_reader', 'progress_25', 'progress_50', 'progress_75', 'progress_100',
    'change_reader_setting', 'view_library', 'book_published',
    'epub_job_started', 'epub_job_completed', 'epub_job_failed'
  )),
  dedupe_key text check (dedupe_key is null or char_length(dedupe_key) between 1 and 200),
  profile_id uuid references public.profiles(id) on delete set null,
  book_id uuid references public.books(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  publication_id uuid references public.ebook_publications(id) on delete set null,
  processing_job_id uuid references public.processing_jobs(id) on delete set null,
  locale text check (locale is null or locale in ('vi', 'en')),
  device_class text check (device_class is null or device_class in ('mobile', 'tablet', 'desktop')),
  occurred_at timestamptz not null default now()
);

create unique index analytics_events_dedupe_key_idx
  on public.analytics_events(dedupe_key)
  where dedupe_key is not null;
create index analytics_events_occurred_at_idx on public.analytics_events(occurred_at desc);
create index analytics_events_event_name_occurred_at_idx
  on public.analytics_events(event_name, occurred_at desc);

alter table public.analytics_events enable row level security;
create policy analytics_events_admin_select on public.analytics_events
  for select to authenticated using (public.is_admin());
grant select on public.analytics_events to authenticated;
grant select, insert on public.analytics_events to service_role;

create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  entitlement_id uuid not null unique references public.entitlements(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  template_key text not null check (template_key = 'book_ready'),
  available_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count between 0 and 6),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 100),
  provider_message_id text check (provider_message_id is null or char_length(provider_message_id) <= 200),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  check ((lease_token is null) = (lease_expires_at is null))
);

create index notification_outbox_claim_idx
  on public.notification_outbox(available_at, created_at)
  where sent_at is null and attempt_count < 6;

alter table public.notification_outbox enable row level security;
create policy notification_outbox_admin_select on public.notification_outbox
  for select to authenticated using (public.is_admin());
grant select on public.notification_outbox to authenticated;
grant select on public.notification_outbox to service_role;
```

Add a `before update or delete` immutability trigger to `analytics_events`. It raises SQLSTATE `55000` for every role except the table owner. Revoke direct update and delete privileges from `anon`, `authenticated`, and `service_role`.

Add a `security definer` entitlement trigger function with `set search_path = ''`. It inserts only after an active insert or a revoked-to-active update. Use `on conflict (entitlement_id) do nothing`. Create the trigger after the function so existing rows stay untouched.

Add all three outbox RPCs with `security definer set search_path = ''`. Revoke execute from `public`, `anon`, and `authenticated`, then grant execute to `service_role`. The claim query joins `public.entitlements` and requires `e.status = 'active'`. Clamp `p_limit` to 1 through 25. Claim rows in `(available_at, created_at, id)` order with `for update of o skip locked`.

Use this retry expression inside `fail_notification_outbox` after incrementing the attempt count:

```sql
case v_attempt
  when 1 then interval '1 minute'
  when 2 then interval '5 minutes'
  when 3 then interval '30 minutes'
  when 4 then interval '2 hours'
  when 5 then interval '6 hours'
  else interval '100 years'
end
```

The completion and failure functions update only when both `id` and `lease_token` match and the lease has not expired. Clear both lease columns on success or failure. Both functions return `boolean`, which makes lost-lease handling explicit in the worker.

- [ ] **Step 4: Run the focused test, regenerate types, and run the full database suite**

Run:

```bash
npm run db:reset
supabase test db supabase/tests/021_s5_observability_outbox.sql
supabase gen types --local --lang typescript > lib/supabase/database.types.ts
npm run db:test
npm run check
```

Expected: all commands pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add supabase/migrations/20260916110000_s5_observability_outbox.sql supabase/tests/021_s5_observability_outbox.sql lib/supabase/database.types.ts
git commit -m "feat(s5): add analytics and notification outbox"
```

---

### Task 2: Database-owned product outcome events

**Files:**
- Create: `supabase/migrations/20260916120000_s5_event_triggers.sql`
- Create: `supabase/tests/022_s5_event_triggers.sql`
- Modify: `lib/supabase/database.types.ts`

**Interfaces:**
- Progress trigger emits each crossed milestone once for each profile and publication.
- Audit trigger emits `book_published` once for each `publish_book` audit row.
- Processing-job trigger emits started, completed, and failed events once for each job attempt and state.

- [ ] **Step 1: Write the failing pgTAP test**

Create fixtures for one profile, book, edition, asset, publication, and processing job. Use the existing authenticated RPCs for progress and the existing publish flow where practical. Assert:

```sql
-- A winning save from 0.10 to 0.76 emits 25, 50, and 75 once.
-- A stale or repeated save emits no duplicate milestones.
-- A save at 0.99 emits progress_100 once.
-- One publish_book audit row emits one book_published event keyed by audit ID.
-- queued -> processing emits epub_job_started.
-- processing -> completed emits epub_job_completed.
-- retry attempt 2 -> failed emits a distinct epub_job_failed row.
-- Updating unrelated job columns emits no event.
```

Use dedupe keys in these exact forms:

```text
progress/<profile-id>/<publication-id>/25
progress/<profile-id>/<publication-id>/50
progress/<profile-id>/<publication-id>/75
progress/<profile-id>/<publication-id>/100
publish/<audit-log-id>
epub/<processing-job-id>/<attempt>/started
epub/<processing-job-id>/<attempt>/completed
epub/<processing-job-id>/<attempt>/failed
```

- [ ] **Step 2: Run the focused test and observe zero emitted rows**

```bash
npm run db:reset
supabase test db supabase/tests/022_s5_event_triggers.sql
```

Expected: event count assertions fail.

- [ ] **Step 3: Implement the trigger functions**

Create `20260916120000_s5_event_triggers.sql`. Each function is `security definer set search_path = ''` and inserts with `on conflict (dedupe_key) do nothing`.

For progress, join `ebook_publications -> ebook_assets -> editions` to get `book_id`. Insert from this fixed milestone value set:

```sql
select m.event_name, m.threshold, m.label
from (values
  ('progress_25', 0.25::numeric, '25'),
  ('progress_50', 0.50::numeric, '50'),
  ('progress_75', 0.75::numeric, '75'),
  ('progress_100', 0.99::numeric, '100')
) as m(event_name, threshold, label)
where new.total_progression >= m.threshold
  and coalesce(old.total_progression, 0) < m.threshold;
```

Attach it as `after insert or update of total_progression on public.reading_progress`.

For publication, attach to `public.audit_logs` and require `new.action = 'publish_book'` and `new.entity_type = 'book'`. The existing `entity_id` column is already UUID.

For EPUB jobs, attach to `public.processing_jobs`. Emit only when the status changes to `processing`, `completed`, or `failed`. Map them to `epub_job_started`, `epub_job_completed`, and `epub_job_failed`.

- [ ] **Step 4: Verify and commit**

```bash
npm run db:reset
supabase test db supabase/tests/022_s5_event_triggers.sql
supabase gen types --local --lang typescript > lib/supabase/database.types.ts
npm run db:test
npm run check
git add supabase/migrations/20260916120000_s5_event_triggers.sql supabase/tests/022_s5_event_triggers.sql lib/supabase/database.types.ts
git commit -m "feat(s5): record durable product outcomes"
```

Expected: all commands pass.

---

### Task 3: Server event API and journey instrumentation

**Files:**
- Create: `lib/analytics/events.ts`
- Create: `lib/analytics/events.test.ts`
- Create: `lib/analytics/browser.ts`
- Create: `components/analytics/analytics-event.tsx`
- Create: `app/api/analytics/events/route.ts`
- Create: `app/api/analytics/events/route.test.ts`
- Modify: public book page, library page, book actions, simulator webhook, reader component, reader page, and sample page from the file map

**Interfaces:**

```ts
export const analyticsEventNames = [
  "view_book", "open_sample", "begin_checkout", "purchase", "payment_failed",
  "open_reader", "change_reader_setting", "view_library",
] as const;

export type TrackEventInput = {
  eventName: (typeof analyticsEventNames)[number];
  dedupeKey?: string;
  profileId?: string;
  bookId?: string;
  orderId?: string;
  publicationId?: string;
  locale?: "vi" | "en";
  deviceClass?: "mobile" | "tablet" | "desktop";
};

export async function trackEventBestEffort(input: TrackEventInput): Promise<void>;
export function sendAnalyticsEvent(input: BrowserEventInput): void;
```

- [ ] **Step 1: Write failing unit and route tests**

Test these contracts:

- `trackEventBestEffort` inserts only the named columns and ignores duplicate-key errors.
- It catches and safely logs other insert errors with a request ID.
- The route rejects cross-origin requests, invalid JSON, extra fields, server-only event names, and malformed UUIDs.
- The route derives `profile_id` from the optional session. It never accepts a profile ID from JSON.
- The route classifies the user agent into `mobile`, `tablet`, or `desktop` without storing it.
- An anonymous `view_book` succeeds with `202`.
- The browser helper sends a JSON `Blob` through `navigator.sendBeacon` and falls back to `fetch(..., {keepalive: true})`.

Run:

```bash
npx vitest run lib/analytics/events.test.ts app/api/analytics/events/route.test.ts
```

Expected: module resolution fails.

- [ ] **Step 2: Implement the typed event path**

Use a strict Zod discriminated union in the route. The browser accepts only:

```ts
type BrowserEventInput =
  | { eventName: "view_book" | "open_sample"; bookId: string; locale: "vi" | "en" }
  | { eventName: "open_reader"; bookId: string; publicationId: string; locale: "vi" | "en" }
  | { eventName: "change_reader_setting"; bookId: string; publicationId?: string; locale: "vi" | "en" }
  | { eventName: "view_library"; locale: "vi" | "en" };
```

Validate the `Origin` header against `new URL(getServerEnv().siteUrl).origin`. Accept a missing origin only in `APP_ENV=local` or `test`. Return `202` with `{accepted: true}` and never return inserted data.

Use `createAdminClient()` only after the route validates input and origin. Use the normal session client first to derive the optional profile.

- [ ] **Step 3: Add browser events at actual interaction points**

- Render `AnalyticsEvent` after a public book is found, with `view_book`.
- Send `open_sample` after the sample reader becomes ready.
- Send `open_reader` after the entitled reader becomes ready.
- Send `change_reader_setting` from the existing preference-change callback. Send no preference data.
- Render `AnalyticsEvent` after `requireUser()` and the library query complete.
- Add `bookId`, `publicationId`, and `locale` to the reader props. Keep them outside `ReaderEngine`.

- [ ] **Step 4: Add server-owned commerce events**

- After `createEbookOrder` succeeds, write `begin_checkout` with dedupe key `checkout/<order-id>`.
- After a verified simulator event returns completed plus succeeded, write `purchase` with dedupe key `purchase/<order-id>`.
- After a verified simulator event returns failed, write `payment_failed` with dedupe key `payment-failed/<provider-event-id>`.
- Call the best-effort helper after the business mutation. Never change the customer response when analytics fails.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run lib/analytics/events.test.ts app/api/analytics/events/route.test.ts
npm run check
git add lib/analytics components/analytics app/api/analytics app/[locale]/\(public\)/books app/[locale]/\(account\)/library app/[locale]/\(reader\) components/reader lib/commerce/simulator-webhook.ts
git commit -m "feat(s5): instrument the launch funnel"
```

Expected: focused tests and `npm run check` pass.

---

### Task 4: Environment validation and Resend adapter

**Files:**
- Modify: `lib/config/server-env-schema.ts`
- Modify: `lib/config/server-env.test.ts`
- Modify: `.env.example`
- Create: `lib/email/provider.ts`
- Create: `lib/email/resend.ts`
- Create: `lib/email/resend.test.ts`

**Environment contract:**

```text
EMAIL_PROVIDER=resend|test
RESEND_API_KEY=re_...
EMAIL_FROM=Infinity Books <books@example.com>
OPS_ALERT_EMAIL=operator@example.com
OPS_WORKER_SECRET=<at least 32 characters>
```

Production requires `EMAIL_PROVIDER=resend`, a Resend key, a valid sender, an operator email, and a worker secret of at least 32 characters. Local and test allow `EMAIL_PROVIDER=test`. The parsed server environment uses camel-case fields.

- [ ] **Step 1: Write failing environment and adapter tests**

Test production rejection for a missing key, test provider, invalid sender, invalid operator email, and short worker secret. Test local acceptance of the no-network provider.

Test this provider contract:

```ts
export type MailMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
};

export interface MailProvider {
  send(message: MailMessage): Promise<{ messageId: string }>;
}
```

Mock `fetch`. Assert `POST https://api.resend.com/emails`, bearer authorization, JSON fields, and `Idempotency-Key`. Assert that non-2xx responses throw a `MailProviderError` with a safe code such as `resend_http_429`. Do not expose response bodies.

- [ ] **Step 2: Run the tests and observe validation failures**

```bash
npx vitest run lib/config/server-env.test.ts lib/email/resend.test.ts
```

- [ ] **Step 3: Implement the provider without a new Resend SDK dependency**

Use the documented Resend HTTP endpoint through injected `fetch`. The no-network provider returns `test/<idempotency-key>` only in local or test. Export one `getMailProvider(env, fetchImpl = fetch)` factory.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run lib/config/server-env.test.ts lib/email/resend.test.ts
npm run check
git add .env.example lib/config/server-env-schema.ts lib/config/server-env.test.ts lib/email/provider.ts lib/email/resend.ts lib/email/resend.test.ts
git commit -m "feat(s5): add Resend mail provider"
```

---

### Task 5: Localized book-ready delivery

**Files:**
- Create: `lib/email/book-ready.ts`
- Create: `lib/email/book-ready.test.ts`
- Create: `lib/email/outbox.ts`
- Create: `lib/email/outbox.test.ts`
- Modify: `lib/i18n/dictionaries/en.json`
- Modify: `lib/i18n/dictionaries/vi.json`

**Interfaces:**

```ts
export type BookReadyEmailInput = {
  locale: "vi" | "en";
  recipientName: string | null;
  bookTitle: string;
  libraryUrl: string;
};

export function buildBookReadyEmail(input: BookReadyEmailInput): {
  subject: string;
  text: string;
  html: string;
};

export async function deliverNotificationBatch(deps: {
  client: SupabaseClient<Database>;
  provider: MailProvider;
  siteUrl: string;
  from: string;
  leaseToken: string;
  limit?: number;
}): Promise<{ claimed: number; sent: number; failed: number }>;
```

- [ ] **Step 1: Write failing rendering and delivery tests**

Cover English and Vietnamese copy, HTML escaping, absolute localized library links, and an absent display name. In delivery tests, use a recording Supabase client and provider. Prove:

- the batch claims at most 25 rows;
- it resolves the current active entitlement, profile locale, oldest verified email, and localized book title;
- it sends with `book-ready/<outbox-id>`;
- provider acceptance calls the completion RPC with the owning lease token;
- provider or data failure calls the failure RPC with a safe code;
- one failed row does not stop later rows;
- logs contain the request ID and outbox ID, not recipient email or provider response text.

- [ ] **Step 2: Implement escaped templates and delivery**

Put translated sentence templates under `email.bookReady` in both dictionaries. Build text and minimal HTML from the same values. Escape `&`, `<`, `>`, `"`, and `'` in HTML.

Resolve delivery data after the claim. If an entitlement is no longer active, release it through `fail_notification_outbox` with `entitlement_inactive`. This race is rare because the claim RPC filters active entitlements. The normal revoked state does not consume attempts because it is never claimed.

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run lib/email/book-ready.test.ts lib/email/outbox.test.ts
npm run check
git add lib/email lib/i18n/dictionaries/en.json lib/i18n/dictionaries/vi.json
git commit -m "feat(s5): deliver book-ready email from the outbox"
```

---

### Task 6: Operational rules and alert state

**Files:**
- Create: `supabase/migrations/20260916130000_s5_redirects_and_operations.sql`
- Create: `supabase/tests/023_s5_redirects_and_operations.sql`
- Modify: `lib/supabase/database.types.ts`
- Create: `lib/ops/types.ts`
- Create: `lib/data/operations.ts`
- Create: `lib/ops/checks.ts`
- Create: `lib/ops/checks.test.ts`
- Create: `lib/ops/alerts.ts`
- Create: `lib/ops/alerts.test.ts`

**Database interface:**

```sql
create table public.operations_alert_state (
  rule_name text primary key check (rule_name in (
    'stale_epub_job', 'missing_order_entitlement',
    'unprocessed_payment_event', 'stuck_notification'
  )),
  active boolean not null default false,
  fingerprint text,
  first_detected_at timestamptz,
  last_evaluated_at timestamptz not null,
  last_alerted_at timestamptz,
  resolved_at timestamptz
);
```

Authenticated admins can select this table. Only `service_role` can insert or update it.

The migration inserts one inactive row for each rule with `last_evaluated_at = now()`. Revoke direct writes from browser roles. Grant service-role writes because the authenticated worker route owns the state transition after its bearer-token gate.

- [ ] **Step 1: Write failing pgTAP and unit tests**

The pgTAP test covers table constraints and role access. The unit tests use fixed timestamps and cover exact boundaries:

- queued or processing EPUB job older than 30 minutes is stale;
- a processing job with an expired lease is stale even when younger;
- exactly 30 minutes old is not stale until it crosses the boundary;
- a completed order with no order-backed entitlement is reported;
- an active or revoked order-backed entitlement suppresses that finding;
- an unprocessed payment event older than 5 minutes is reported;
- an outbox row with at least 4 failures, no active lease, and no sent time is reported;
- findings sort oldest first and contain only IDs, timestamps, safe summaries, and repair paths.

Test alert transitions for inactive, new, unchanged, changed, overdue after 24 hours, and resolved states. Build a fingerprint as SHA-256 of sorted finding IDs joined with a newline.

- [ ] **Step 2: Implement database and query adapters**

Use authenticated reads in `/admin/operations` and service-role reads in the worker. Keep rule evaluation pure:

```ts
export function evaluateOperations(
  snapshot: OperationsSnapshot,
  now: Date,
): OperationsReport;
```

Load source rows in `lib/data/operations.ts`. Do not put service-role creation in that module. Accept a client from the caller.

Repair paths are:

```text
/admin/books/<book-id>#epub
/admin/orders/<order-id>
/admin/orders/<order-id>
/admin/users/<profile-id>
```

- [ ] **Step 3: Implement alert reconciliation**

`reconcileOperationsAlerts` reads all four state rows, compares each fingerprint, sends one concise email when required, then upserts state. If sending fails, do not move `last_alerted_at`. Update `last_evaluated_at` on every successful evaluation. Mark `active=false` and set `resolved_at` when a rule clears.

- [ ] **Step 4: Verify database types and commit**

```bash
npm run db:reset
supabase test db supabase/tests/023_s5_redirects_and_operations.sql
supabase gen types --local --lang typescript > lib/supabase/database.types.ts
npx vitest run lib/ops/checks.test.ts lib/ops/alerts.test.ts
npm run db:test
npm run check
git add supabase/migrations/20260916130000_s5_redirects_and_operations.sql supabase/tests/023_s5_redirects_and_operations.sql lib/supabase/database.types.ts lib/ops lib/data/operations.ts
git commit -m "feat(s5): detect and track operational failures"
```

---

### Task 7: Secret scheduled worker

**Files:**
- Create: `lib/ops/worker-auth.ts`
- Create: `lib/ops/worker-auth.test.ts`
- Create: `app/api/operations/run/route.ts`
- Create: `app/api/operations/run/route.test.ts`

**Response contract:**

```ts
type OperationsRunResponse = {
  requestId: string;
  outbox: { claimed: number; sent: number; failed: number };
  findings: Record<OpsRuleName, number>;
  alertsSent: number;
};
```

- [ ] **Step 1: Write failing authentication and route tests**

Test missing, Basic, wrong, short, and valid bearer values. Hash both supplied and expected values with SHA-256, then compare the fixed-length digests with `timingSafeEqual`.

Test that an invalid request creates no admin client. A valid request drains email first, evaluates rules with one `now`, reconciles alerts, and returns counts without customer data. A failed mail row does not fail the run. A failed operational query returns `500` with `{error: "operations_run_failed", requestId}`.

- [ ] **Step 2: Implement the route**

Set `export const runtime = "nodejs"` and `export const dynamic = "force-dynamic"`. Authenticate before `createAdminClient()`. Use one random lease UUID for the batch. Use the request ID helper in every safe log and response. Add `Cache-Control: no-store`.

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run lib/ops/worker-auth.test.ts app/api/operations/run/route.test.ts
npm run check
git add lib/ops/worker-auth.ts lib/ops/worker-auth.test.ts app/api/operations/run
git commit -m "feat(s5): add the scheduled operations worker"
```

---

### Task 8: Admin operations page

**Files:**
- Create: `app/admin/operations/page.tsx`
- Create: `components/admin/operations-panel.tsx`
- Create: `components/admin/operations-panel.test.tsx`
- Modify: `components/admin/admin-nav.tsx`

- [ ] **Step 1: Write the failing component test**

Cover a healthy empty state and all four finding groups. Assert each finding has a time, safe summary, and repair link. Assert no email address, provider response, or book content renders.

- [ ] **Step 2: Implement the page and panel**

The page calls `requireAdmin()` itself, then creates the normal session client and loads the report plus alert state. It never creates a service-role client. Add `export const dynamic = "force-dynamic"`.

Add Operations to the admin navigation. Use existing admin card, badge, empty-state, and focus styles. Each repair link stays inside `/admin`.

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run components/admin/operations-panel.test.tsx
npm run check
git add app/admin/operations components/admin/operations-panel.tsx components/admin/operations-panel.test.tsx components/admin/admin-nav.tsx
git commit -m "feat(s5): add the admin operations view"
```

---

### Task 9: Public metadata and structured data

**Files:**
- Create: `lib/seo/metadata.ts`
- Create: `lib/seo/metadata.test.ts`
- Create: `lib/seo/json-ld.ts`
- Create: `lib/seo/json-ld.test.ts`
- Create: `components/seo/json-ld.tsx`
- Create: `components/seo/json-ld.test.tsx`
- Create: `app/opengraph-image.tsx`
- Modify: root and public pages from the file map

**Read first:**

```text
node_modules/next/dist/docs/01-app/03-api-reference/04-functions/generate-metadata.md
node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/opengraph-image.md
```

- [ ] **Step 1: Write failing metadata and JSON-LD tests**

Test absolute canonical URLs from `SITE_URL`, Vietnamese and English alternates, default Open Graph image, book cover override, and no accidental query strings.

Test these schema rules:

- home emits `Organization`;
- a book emits `Book`, `Person`, `Offer`, and `BreadcrumbList`;
- free uses price `0` with the offer currency;
- paid uses the stored minor-unit price converted for the currency;
- coming soon uses `https://schema.org/OutOfStock`;
- only visible public DTO fields appear;
- the script serializer replaces `<` with `\u003c` before `dangerouslySetInnerHTML`.

- [ ] **Step 2: Implement shared builders**

Set `metadataBase` in the root layout from the validated `SITE_URL`. Builders accept DTOs and locale values. They do not query Supabase. Use the localized canonical slug and alternate slug already returned by catalog data.

Create `app/opengraph-image.tsx` with `ImageResponse`, size `1200 x 630`, and a simple Infinity Books wordmark. Use no remote assets or fonts.

- [ ] **Step 3: Wire public routes**

- Home: canonical, alternates, Open Graph, and Organization schema.
- Catalog: canonical, alternates, and Open Graph.
- Book: localized title and description, canonical, alternates, cover image when present, Book schema, and breadcrumb schema.
- Author, series, and topic: canonical, alternates, Open Graph, and breadcrumbs through the shared entity component.
- Search and filtered catalog: keep `noindex` and add canonical rules that do not preserve search or filter parameters.
- Sample: keep `noindex, nofollow`.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run lib/seo/metadata.test.ts lib/seo/json-ld.test.ts components/seo/json-ld.test.tsx
npm run check
git add lib/seo components/seo app/opengraph-image.tsx app/layout.tsx app/[locale]/\(public\) components/catalog/entity-page.tsx
git commit -m "feat(s5): add public SEO metadata and schema"
```

---

### Task 10: Sitemap, robots, private metadata, and redirects

**Files:**
- Create: `app/sitemap.ts`
- Create: `app/robots.ts`
- Create: private route-group layouts from the file map
- Create: `lib/redirects/resolve.ts`
- Create: `lib/redirects/resolve.test.ts`
- Modify: `proxy.ts`
- Modify: `lib/catalog/revalidate.ts`

**Read first:**

```text
node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/sitemap.md
node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/robots.md
node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md
```

- [ ] **Step 1: Complete the redirect database contract**

In migration `20260916130000_s5_redirects_and_operations.sql`, add:

```sql
create or replace function public.resolve_public_redirect(p_source_path text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select r.destination_path
  from public.redirects r
  where r.source_path = p_source_path
  limit 1
$$;
```

Grant execute to `anon` and `authenticated`. Return no other redirect fields. Extend `023_s5_redirects_and_operations.sql` to prove exact matching, a null miss, and no direct anon table read.

- [ ] **Step 2: Write failing redirect unit tests**

Test exact hits, misses, the 60-second cache, and rejection of unsafe destinations. Valid destinations start with one `/`, contain no `\\`, contain no fragment, do not start with `/admin`, `/api`, or `/auth`, and do not target localized account, checkout, library, reader, search, or auth prefixes.

- [ ] **Step 3: Implement metadata routes and private layouts**

`app/sitemap.ts` returns localized home, catalog, published books, and author, series, and topic URLs only when the entity has a visible book. Deduplicate URLs. Use public catalog functions and `export const revalidate = 300`.

`app/robots.ts` allows `/` and lists the sitemap. Disallow `/admin`, `/api`, `/auth`, and localized account, checkout, library, read, read-sample, search, and auth paths for both locales.

Each private route-group layout exports:

```ts
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};
```

Keep authorization in each page and action.

- [ ] **Step 4: Resolve redirects before auth in Proxy**

For `GET` and `HEAD`, call `resolvePublicRedirect(pathname)` before `updateSession`. On a safe hit, return `NextResponse.redirect(new URL(destinationPath, request.url), 308)`. Creating the destination URL without copying `request.nextUrl.search` drops the original query. Skip static assets and metadata files through the existing matcher.

Use a module-level `Map<string, {value: string | null; expiresAt: number}>`. Limit it to 500 entries by deleting the oldest entry before an insert when full. Cache hits and misses for 60 seconds. Correctness must not depend on cache reuse.

Add `revalidatePath("/sitemap.xml")` to `revalidateStorefront()`.

- [ ] **Step 5: Verify and commit**

```bash
npm run db:reset
supabase test db supabase/tests/023_s5_redirects_and_operations.sql
supabase gen types --local --lang typescript > lib/supabase/database.types.ts
npx vitest run lib/redirects/resolve.test.ts
npm run db:test
npm run check
git add app/sitemap.ts app/robots.ts app/[locale]/\(account\)/layout.tsx app/[locale]/\(auth\)/layout.tsx app/[locale]/\(reader\)/layout.tsx app/admin/layout.tsx lib/redirects proxy.ts lib/catalog/revalidate.ts supabase/migrations/20260916130000_s5_redirects_and_operations.sql supabase/tests/023_s5_redirects_and_operations.sql lib/supabase/database.types.ts
git commit -m "feat(s5): add crawler routes and public redirects"
```

---

### Task 11: Speed Insights, end-to-end proof, and operations runbook

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `app/layout.tsx`
- Create: `e2e/seo-operations.spec.ts`
- Create: `docs/runbooks/seo-and-operations.md`
- Modify: `docs/runbooks/deployment.md`
- Modify: `docs/runbooks/testing-environments.md`
- Modify: `docs/runbooks/storefront.md`

- [ ] **Step 1: Install and render Speed Insights**

Run:

```bash
npm install @vercel/speed-insights
```

Import `SpeedInsights` from `@vercel/speed-insights/next` and render it once in the root layout after the application body content. Use its default sample rate.

- [ ] **Step 2: Write end-to-end launch checks**

Against local Supabase, prove:

- a localized published book has canonical, alternate, Open Graph, Book, Offer, Person, and breadcrumb metadata;
- `/sitemap.xml` contains the published book and excludes draft content and private routes;
- `/robots.txt` names the sitemap and excludes private surfaces;
- an inserted redirect returns `308`, drops the old query, and points to the exact relative destination;
- a signed-out private route remains non-indexable when it reaches an auth surface;
- a non-admin cannot open `/admin/operations`;
- an admin sees seeded stale EPUB, payment, order, and outbox findings with repair links;
- granting a new entitlement creates one outbox row;
- two worker calls cannot send the same claimed row twice with the test provider.

Use only local/test mail. Do not call Resend in Playwright.

- [ ] **Step 3: Write the operations runbook**

`docs/runbooks/seo-and-operations.md` contains these exact sections:

1. Required Vercel environment variables.
2. Resend domain and sender verification.
3. Supabase Vault secrets for the production site URL and worker secret.
4. Idempotent `pg_cron` plus `pg_net` SQL for `*/5 * * * *` and `POST /api/operations/run`.
5. A manual worker smoke test that prints status and counts, not the secret.
6. How to inspect and repair each operations rule.
7. How to retry an outbox row after fixing the cause.
8. How to rotate the worker secret without missing a run.
9. How to enable Speed Insights on Vercel Hobby and watch the 10,000 monthly data-point limit.
10. Rollback steps that unschedule the worker before disabling email.

The scheduler SQL reads the URL and secret from Vault. It contains no literal production value. Use a stable job name and unschedule an existing job with that name before creating its replacement.

Update `deployment.md` with the S5 variables and the order: migrate, configure Resend, configure Vault, deploy, smoke test, schedule, enable Speed Insights. Update `testing-environments.md` with `EMAIL_PROVIDER=test` and a non-production worker secret. Update `storefront.md` with canonical, alternate, sitemap, robots, and exact redirect behavior.

- [ ] **Step 4: Run focused end-to-end tests**

Export the local variables from `docs/runbooks/testing-environments.md`, then run:

```bash
npm run db:reset
npx playwright test e2e/seo-operations.spec.ts
```

Expected: all S5 journeys pass with no external email request.

- [ ] **Step 5: Run the full release gate**

```bash
npm run db:reset
npm run db:test
npm run check
npm run check:full
git status --short
```

Expected:

- All database, unit, build, and Playwright checks pass.
- `git status --short` contains only intended S5 files and the pre-existing untracked `cmd.txt`.
- No `.env.local`, secrets, EPUB files, tokens, or customer data are staged.

- [ ] **Step 6: Review against the design before committing**

Search for unfinished text and privacy regressions:

```bash
rg -n "TODO|FIXME|placeholder|implement later|coming later" docs/superpowers/plans/2026-09-16-s5-seo-operations.md lib app supabase e2e docs/runbooks/seo-and-operations.md
rg -n "reader_location|search_query|user_agent|ip_address|email_address|properties json" lib app supabase
git diff --check
```

Expected: no unfinished implementation markers, no prohibited analytics fields, and no whitespace errors. Review each design section from 5 through 14 and map it to a test or runbook step.

- [ ] **Step 7: Commit the final integration**

```bash
git add package.json package-lock.json app/layout.tsx e2e/seo-operations.spec.ts docs/runbooks/seo-and-operations.md docs/runbooks/deployment.md docs/runbooks/testing-environments.md docs/runbooks/storefront.md
git commit -m "test(s5): verify SEO and operations launch"
```

## Completion Checklist

- [ ] All three S5 migrations apply from a clean local reset.
- [ ] All pgTAP tests pass.
- [ ] The generated database types match the final schema.
- [ ] Public metadata, structured data, sitemap, and robots expose only visible content.
- [ ] Private surfaces are non-indexable.
- [ ] Redirects resolve before auth and cannot escape to unsafe destinations.
- [ ] Every approved analytics event has one tested emission point.
- [ ] Analytics failures do not change customer outcomes.
- [ ] Entitlement grants create one durable outbox row without backfill.
- [ ] Resend delivery is leased, idempotent, localized, and retryable.
- [ ] The worker rejects invalid tokens before service-role creation.
- [ ] The admin operations page uses the admin session, not the service role.
- [ ] All four operational rules and all alert transitions have tests.
- [ ] Supabase owns the five-minute schedule. Vercel has no cron configuration.
- [ ] The runbook covers setup, smoke tests, repair, rotation, and rollback.
- [ ] `npm run check` and `npm run check:full` pass.
- [ ] The final diff contains no secret, private ebook data, or unrelated file.
