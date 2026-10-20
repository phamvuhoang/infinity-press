# Runbook: SEO and operations

This runbook covers what S5 adds to production: notification email through Resend, the scheduled
operations worker, `/admin/operations`, Vercel Speed Insights, and the public SEO surface.

The worker is `POST /api/operations/run`. Each run delivers up to 25 notification emails from
`notification_outbox`, checks six operational rules, and emails the operator when a finding set is
new, has changed, or has been active for 24 hours.

Since S9 the outbox carries two templates: `book_ready`, addressed to the owner of a new
entitlement, and `gift_claim`, addressed to a gift's recipient and carrying their claim link
([bundles and gifts](bundles-and-gifts.md)). S13 adds a third, `question_answered`, addressed to a
reader whose question was answered by a newly published idea ([reader voice](reader-voice.md)).
`claim_notification_outbox` returns its `question_id` alongside the entitlement and gift ids. The worker's own log lines were renamed with that
change and no longer name book-ready mail: they read `Notification email sent.`,
`Notification delivery failed.`, `Notification lease lost …` and `Notification outbox claim failed.`,
each carrying a `template` field alongside the request ID and the outbox ID. **A saved log search,
dashboard, or alert rule keyed on the old "Book-ready …" wording matches nothing** - re-key it on
`Notification` and filter by `template`. Supabase `pg_cron` calls it every five minutes.
Vercel has no cron configuration for it, because Vercel Hobby cron runs at most once a day.

> **One database.** The cloud Supabase project is also production's database. Do not run
> Playwright, `supabase db reset`, pgTAP, or EPUB `process`/`retry` against it. The SQL in this
> runbook runs in the Supabase SQL editor of the hosted project, and only the statements shown.

Deployment order and the other production variables are in [deployment](deployment.md). Local and
CI test setup is in [testing environments](testing-environments.md).

---

## 1. Required Vercel environment variables

Set these in the Vercel **Production** environment before you deploy S5:

| Variable | Production rule |
| --- | --- |
| `EMAIL_PROVIDER` | Must be `resend`. `test` is rejected outside `APP_ENV=local` or `test`. |
| `RESEND_API_KEY` | A Resend API key with sending access to the verified domain (section 2). |
| `EMAIL_FROM` | A sender on the verified Resend domain, for example `Infinity Books <books@your-domain>`. |
| `OPS_ALERT_EMAIL` | The operator inbox that receives operational alerts. |
| `OPS_WORKER_SECRET` | At least 32 random characters. The same value goes into Supabase Vault (section 3). |

Generate the worker secret locally and do not paste it into chat, tickets, or shell history:

```bash
openssl rand -base64 48 | tr -d '\n' | pbcopy    # macOS; copies the value without printing it
```

None of these variables uses the `NEXT_PUBLIC_` prefix, and none may. Keep `SITE_URL` set to the
production origin: it is the canonical origin for every page and the origin the analytics beacon
accepts.

> **Set all five before the S5 deployment goes live.** The `/[lang]` root layout validates the
> full server environment on every page render. If one production value is missing or invalid,
> every customer-facing route under `/{locale}` fails - there is no page left from which to notice
> the mistake. `/admin` and `/internal` have their own root layouts and do not call this
> validation, so they keep rendering even with a bad S5 value. This is also why you must not remove
> an S5 variable while an S5 deployment is live.

The application does not check that `EMAIL_FROM` belongs to the Resend domain. That check is
section 2.

## 2. Resend domain and sender verification

1. In Resend, open **Domains** and add the sending domain (a subdomain such as `mail.your-domain`
   keeps the root domain's mail reputation separate).
2. Add the DNS records Resend shows (the DKIM `TXT` record, and the SPF `TXT` and `MX` records for
   the return path) at your DNS provider. Do not change existing records for the root domain.
3. Wait until Resend shows the domain as **Verified**. Mail from an unverified domain is rejected,
   and the outbox records it as a failed attempt.
4. Create an API key in **API Keys** with **Sending access** only, restricted to that domain. Put it
   in `RESEND_API_KEY`. Resend shows the key once; if you lose it, create a new one and delete the
   old one.
5. Set `EMAIL_FROM` to an address on exactly that domain. A different domain is rejected by Resend
   on every send.

Each email uses a per-template Resend idempotency key: `book-ready/<outbox-id>` for an
entitlement's message, `gift-claim/<outbox-id>` for a gift's, and `question-answered/<outbox-id>`
for an answered question's. Resend's
**Emails** log shows every accepted message, so after the first grant in production you can
confirm delivery there without reading the customer's inbox.

## 3. Supabase Vault secrets for the production site URL and worker secret

`pg_cron` reads the URL and secret from Vault when each run starts, so no literal value is ever
stored in `cron.job` or `cron.job_run_details`. Create the two secrets once, in the hosted project's
SQL editor. Fill in the `<...>` values in the editor only - never commit or share the filled-in
statement:

```sql
select vault.create_secret('https://<production-origin>', 'ops_site_url', 'Origin the operations worker calls');
select vault.create_secret('<the OPS_WORKER_SECRET value>', 'ops_worker_secret', 'Bearer token for POST /api/operations/run');
```

The origin has no trailing slash and no path. To change a value later, update it in place so the
schedule keeps working:

```sql
select vault.update_secret(
  (select id from vault.secrets where name = 'ops_worker_secret'),
  '<the new value>'
);
```

Check that both exist without printing them:

```sql
select name, updated_at from vault.secrets where name in ('ops_site_url', 'ops_worker_secret');
```

## 4. Idempotent `pg_cron` plus `pg_net` schedule

Run this in the SQL editor after sections 1-3 and after the manual smoke test in section 5 passes.
It is safe to run again: it removes the job named `infinity-books-operations-run` if it exists and
then creates it with the current definition. It contains no URL or secret.

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

begin;

select cron.unschedule(jobid)
from cron.job
where jobname = 'infinity-books-operations-run';

select cron.schedule(
  'infinity-books-operations-run',
  '*/5 * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'ops_site_url')
      || '/api/operations/run',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'ops_worker_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $job$
);

commit;
```

Inspect the schedule and its recent runs:

```sql
select jobid, jobname, schedule, active from cron.job where jobname = 'infinity-books-operations-run';

select status, return_message, start_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'infinity-books-operations-run')
order by start_time desc
limit 5;

-- pg_net stores each HTTP response for a few hours. The body holds counts and a request ID only.
select status_code, left(content, 300) as body, created
from net._http_response
order by created desc
limit 5;
```

`cron.job_run_details` reports `succeeded` once the request is queued; the HTTP result is in
`net._http_response`. A `401` there means Vault and Vercel disagree about the secret (section 8). A
`503` means the deployment has no `OPS_WORKER_SECRET`.

During a Resend outage, `net._http_response` can show a timeout (no status code, a timeout error
message) instead of `200`. pg_net stops waiting after 30 seconds, but the worker route keeps
running server-side: a worst-case run - 25 notification sends and one alert, each at the 10-second
Resend timeout - takes about 260 seconds, and the route allows up to 300 seconds (`maxDuration`,
the Vercel Hobby maximum). A timeout there is therefore not a failed run. Check the Vercel logs for
the run's request ID, or `/admin/operations`, for the actual result. Overlap is safe: the next
five-minute run cannot claim a row that this run still holds under its five-minute lease, a lost
lease makes the late completion a no-op, and the per-template Resend idempotency key
(`book-ready/<outbox id>`, `gift-claim/<outbox id>`, `question-answered/<outbox id>`) stops a retried send from delivering a second
email.

## 5. Manual worker smoke test

Run this from an operator machine. It reads the secret without echoing it, keeps it out of the
process list and shell history, and prints only the status code and the counts:

```bash
SITE_URL='https://<production-origin>'
read -rs OPS_WORKER_SECRET        # paste the secret, then press Enter; nothing is shown
curl -sS -X POST "$SITE_URL/api/operations/run" \
  -H @<(printf 'Authorization: Bearer %s\n' "$OPS_WORKER_SECRET") \
  -o /tmp/ops-run.json -w 'HTTP %{http_code}\n'
unset OPS_WORKER_SECRET
jq '{requestId, outbox, findings, alertsSent}' /tmp/ops-run.json && rm /tmp/ops-run.json
```

Expected: `HTTP 200` and a body of this shape, with no customer data:

```json
{
  "requestId": "…",
  "outbox": { "claimed": 0, "sent": 0, "failed": 0 },
  "findings": {
    "stale_epub_job": 0,
    "missing_order_entitlement": 0,
    "unprocessed_payment_event": 0,
    "stuck_notification": 0,
    "unreviewed_manual_transfer_claim": 0,
    "stale_reader_question": 0
  },
  "alertsSent": 0
}
```

`401` means the secret is wrong or the header is malformed. `503` means the deployment has no
`OPS_WORKER_SECRET`. `500` means an operational query failed: search the Vercel logs for the
`requestId`. The route never includes the secret, an email address, or provider text in a response
or log.

During a Resend outage a manual run can take up to about 260 seconds before it answers (see the
timeout note in section 4); `curl` waits for it, so do not cancel and re-run in a loop. Leases and
the idempotency key keep an overlapping run safe either way.

Before the first production rollout, rehearse one finding locally: on a local stack, seed a fault
(the Playwright spec `e2e/seo-operations.spec.ts` shows each one), run the worker, see the finding
on `/admin/operations`, fix the row, run the worker again, and see the rule clear.

## 6. Inspect and repair each operations rule

Open `/admin/operations` (admin only). It shows live findings, each with its age and a **Review**
link, plus the last scheduler evaluation and the last successful alert for each active rule. The
page has no repair buttons: repairs happen on the linked pages. A finding clears by itself once the
underlying row is fixed.

| Rule | Reported when | Review link |
| --- | --- | --- |
| Stale EPUB jobs | A `queued` or `processing` job has not changed for more than 30 minutes, or a `processing` job's lease has expired. | `/admin/books/<book-id>#epub` |
| Completed orders without an entitlement | A `completed` order has no order-backed entitlement, active or revoked. | `/admin/orders/<order-id>` |
| Unprocessed payment events | A payment event has had `processed_at` null for more than 5 minutes. | `/admin/orders/<order-id>` |
| Stuck notifications | An unsent `book_ready` or `gift_claim` outbox row has failed at least 4 times and holds no valid lease. `question_answered` rows are not reported (see [reader voice](reader-voice.md) section 5). | `/admin/users/<profile-id>` (book-ready) or `/admin/gifts` (gift claim) |
| Unanswered reader questions (`stale_reader_question`) | A reader question has been `new` for more than 7 days. | `/admin/questions` |

**Stale EPUB jobs.** The EPUB worker runs on an operator machine, not on Vercel, so a queued job
usually means nobody is running it. Run `EBOOK_LEASE_SECONDS=1800 npm run ebook -- process-next`
from the operator machine (see [EPUB processing](epub-processing.md)). A job with an expired lease
is reclaimed by the next `process-next`, or directly with `npm run ebook -- retry --job <job-id>`.
Do not retry `SOURCE_CHECKSUM_MISMATCH` or `STALE_VERSION`; upload a new version instead.

**Completed orders without an entitlement.** A deliberately revoked order is not reported. A
reported order means the order completed without granting access, which the order functions are
built to make impossible, so treat it as a defect and keep the order ID and the request ID from the
logs. If the customer should be able to read now, grant complimentary access on
`/admin/users/<profile-id>` with a reason that names the order. That grant is not order-backed, so
the finding stays until a reviewed SQL fix records the order-backed entitlement.

**Unprocessed payment events.** Production has no payment provider, and the simulator processes an
event in the same transaction that stores it, so this rule protects later providers and catches a
manual or partial ingestion. Open the order, compare the payment and order states, find the request
ID in the Vercel logs, and fix the cause before re-sending the provider's event. Do not set
`processed_at` by hand to silence the rule.

**Stuck notifications.** `/admin/operations` still labels this finding *Stuck book-ready emails*,
which is narrower than what the rule reports - read it as "stuck notification". Look up the row's
last error code. A `book_ready` row is found by the profile it is addressed to:

```sql
select id, template_key, attempt_count, last_error_code, available_at, lease_expires_at
from public.notification_outbox
where profile_id = '<profile-id>' and sent_at is null;
```

A `gift_claim` row has no profile at all, so it is not reachable that way and its review link is not
meaningful. Investigate it from `/admin/gifts` instead: the **Delivery** column on the gift's row
shows the same attempt count and error code, and never shows the claim link. Do not select
`payload` from this table to work around that - it holds the recipient's live claim credential.

| Code | Usual cause | Fix |
| --- | --- | --- |
| `recipient_unverified` | The customer has no verified email. | The customer signs in once with a magic link. |
| `profile_not_found`, `entitlement_inactive` | The profile or access changed after the grant. | Usually nothing: a revoked entitlement's row waits and is sent only if access returns. |
| `resend_http_401`, `resend_http_403`, `resend_http_422` | Bad API key, unverified domain, or `EMAIL_FROM` off the domain. | Section 2. |
| `resend_http_429`, `resend_http_5xx`, `resend_timeout`, `resend_network_error` | Resend was rate limiting or unavailable. | Wait; the row retries by itself on the schedule below. |
| `resend_invalid_response`, `delivery_data_unavailable`, `provider_error` | A read or send failed unexpectedly. | Find the outbox ID in the Vercel logs. |

Retries happen by themselves 1 minute, 5 minutes, 30 minutes, 2 hours, and 6 hours after each
failure. After the sixth failure the row stops and needs section 7.

## 7. Retry an outbox row after fixing the cause

Fix the cause first (section 6); a retry against the same fault only fails again. Then, in the SQL
editor, make the one row claimable again. The statement touches only an unsent row that no worker
is holding:

```sql
update public.notification_outbox
set attempt_count = 0,
    available_at = now(),
    last_error_code = null
where id = '<outbox-id>'
  and sent_at is null
  and (lease_expires_at is null or lease_expires_at <= now());
```

It must report `UPDATE 1`. Note the old `attempt_count` and `last_error_code` in the incident
before you run it, because the statement clears them. Then wait for the next scheduled run or run
section 5, and confirm:

```sql
select sent_at, provider_message_id from public.notification_outbox where id = '<outbox-id>';
```

A retried row cannot be sent twice: it is claimed under a lease, completed at most once, and sent
with the same Resend idempotency key. Never insert a second outbox row for the same entitlement;
the table allows one row per entitlement.

## 8. Rotate the worker secret without missing a run

The route accepts exactly one secret, so the cut-over must fall between two scheduled runs, and a
manual run afterwards covers any gap. A delayed run loses nothing: pending outbox rows stay pending
and every rule is recomputed from the current rows.

1. Generate the new secret (section 1). Do not remove the old value anywhere yet.
2. Update `OPS_WORKER_SECRET` in the Vercel Production environment, then build a production
   deployment **without** assigning the domain: `vercel deploy --prod --skip-domain`. Wait until it
   is Ready. Scheduled runs still hit the old deployment with the old secret.
3. Just after a scheduled run has finished (check `cron.job_run_details`, section 4), promote the
   new deployment with `vercel promote <deployment-url>` and immediately update Vault with
   `vault.update_secret` (section 3). Both steps fit easily inside the five-minute gap.
4. Run the manual smoke test (section 5) with the new secret and expect `HTTP 200`.
5. After the next scheduled run, check that `net._http_response` shows `200`, not `401`.

If step 5 shows `401`, Vault and Vercel disagree: compare `updated_at` in `vault.secrets` with the
Vercel deployment, and fix whichever side still holds the old value.

## 9. Enable Speed Insights on Vercel Hobby

The `/[lang]` root layout already renders `<SpeedInsights />` from `@vercel/speed-insights/next`
with the default sample rate (every page view reports). `/admin` and `/internal` do not render it -
they are internal tools, and measuring them would pollute storefront metrics. Nothing is collected
until the Vercel project enables it:

1. In Vercel, open the project, then **Speed Insights**, and choose **Enable**.
2. Redeploy production so the deployment serves the Speed Insights script.
3. Open a few public pages in a normal browser. Data appears in **Speed Insights** after a short
   delay; an ad blocker in your browser can hide your own visits.

Hobby includes 10,000 data points a month and a seven-day reporting window. Check **Usage** in the
Vercel dashboard weekly while traffic grows. When the month's projected use approaches the limit,
lower the sample rate in `app/[lang]/layout.tsx`, for example `<SpeedInsights sampleRate={0.5} />` to send
half of the page views, and deploy. Speed Insights is not an operational alert; the worker and
`/admin/operations` do not depend on it.

## 10. Rollback

Always stop the schedule **before** you disable email, so no run fires against a half-disabled
system.

1. Unschedule the worker and confirm it is gone:

   ```sql
   select cron.unschedule(jobid) from cron.job where jobname = 'infinity-books-operations-run';
   select count(*) from cron.job where jobname = 'infinity-books-operations-run';   -- expect 0
   ```

2. Disable email. In production, `EMAIL_PROVIDER` cannot be unset or set to `test` - the server
   refuses to start (section 1). Instead revoke the API key in Resend. With the schedule stopped,
   nothing sends; if anything calls the worker by hand, each send fails with a safe code and the
   row waits for retry.
3. If the S5 deployment itself must go, promote the last pre-S5 deployment in Vercel. Leave the S5
   variables in place until that promotion is live.
4. Leave the database alone. Do not drop S5 tables or reset anything: the outbox keeps one row per
   new entitlement, and those rows wait. Before you schedule the worker again, count them - each
   one becomes an email:

   ```sql
   select count(*) from public.notification_outbox where sent_at is null;
   ```

5. Optionally remove the Vault secrets after the schedule is gone:
   `delete from vault.secrets where name in ('ops_site_url', 'ops_worker_secret');`

To re-enable, create a new Resend key, update `RESEND_API_KEY`, redeploy, run section 5, then
section 4.

## 11. Verify the public SEO output

After a deployment, check one published book in each locale:

- The page source has one `<link rel="canonical">` with the production origin and no query string,
  even when you open the page with `?sort=`, `?q=`, or `?action-error=`.
- `<link rel="alternate" hreflang="vi">` and `hreflang="en"` appear only for locales in which that
  page exists.
- One `<script type="application/ld+json">` holds `Book` (with its `offers` array and the author as
  `Person`) and `BreadcrumbList`, and parses as JSON. Google's Rich Results Test is a quick check.
- `/robots.txt` names `https://<production-origin>/sitemap.xml` and disallows the private paths.
- `/sitemap.xml` lists the book in each of its locales and never a draft, sample, search, account,
  checkout, library, reader, admin, auth, or API URL.

**Sitemap refresh after a catalog change.** The sitemap is cached for 300 seconds and every admin
catalog mutation (book editor, cover, publishing a book or version, entities, merchandising) also calls
`revalidatePath('/sitemap.xml')`. After publishing a book, reload `/sitemap.xml`: it should list the
book at once. If it does not, wait five minutes and reload; if it still does not, the book is not
visible in that locale (see [storefront](storefront.md)). A change made directly in SQL does not
revalidate anything, so it can take up to five minutes to appear.

### `/llms.txt`

`/llms.txt` is an optional plain-text index for language-model crawlers (`text/plain; charset=utf-8`).
For each locale it lists the published books, authors, series, topics, ideas, and articles that have a
page in that locale, each with its absolute URL and a one-line description. It reads the same
published-only data as `/sitemap.xml`, so the two cannot disagree. It is cached for 300 seconds and
every admin mutation that revalidates the storefront also revalidates `/llms.txt`; a change made
directly in SQL can take up to five minutes to appear.

- Bundles are intentionally not listed. A bundle title needs one read per bundle, and the sitemap
  already covers bundle pages.
- Google does not use `llms.txt` (PRD 5.1). It is a courtesy for other crawlers and has no effect on
  ranking, so do not spend time tuning it.
- After a deployment, open `/llms.txt`, confirm it returns `200` and lists one published book from
  each locale, and confirm no draft appears.

### Book `offers` in structured data

The `Book` entity's `offers` is an array:

1. The ebook `Offer`, present only when the page shows a price: price and currency from the book's
   offer, `seller` the site `Organization`, and `itemOffered.bookFormat` `https://schema.org/EBook`.
2. One paperback `Offer` per **active** retailer link, in the admin order: `url` is the retailer URL
   with the site's UTM parameters, `seller` is an `Organization` named after the retailer (or the
   label for **Other**), `availability` is `InStock`, and `itemOffered.bookFormat` is
   `https://schema.org/Paperback`. `price` and `priceCurrency` appear only when the link has a list
   price; a link without a price is valid and emits an Offer without them.

A book with retail links but no priced ebook offer has only paperback Offers, so the first paperback
Offer is then `offers[0]`, not `offers[1]`. Inactive links appear neither on the page nor in `offers`. After any change to this shape, or after a
catalog change that you want to confirm, paste a book page URL into the
[Schema.org validator](https://validator.schema.org/) and check that the Offers parse without errors.

## 12. Analytics intake controls

`POST /api/analytics/events` is public: the browser posts `view_book`, `open_sample`,
`click_external_store`, `open_reader`, `change_reader_setting`, and `view_library` to it, and the route writes each event
with a service-role client. A matching `Origin` stops other websites, not scripts. Before the insert,
the route applies these checks in order:

> **Deployment order.** Apply migration `20260916140000_s5_analytics_intake_quota.sql` before you
> deploy the code that calls `consume_analytics_quota`. Without the migration, every browser event
> returns `503`, and the log shows `Analytics intake quota check failed.` with code `PGRST202`
> (function not found). This does not affect pages, but no browser events are recorded.

1. **Origin.** It must equal `SITE_URL`.
2. **Body size.** A declared `Content-Length` over 1,024 bytes is refused. The body is read in
   chunks, and the read stops at 1,024 bytes, so a chunked body without a length also gets `413`.
   Invalid UTF-8, invalid JSON, or a client that stops sending mid-body returns `400`.
3. **Schema.** The body must match the strict browser-event schema, or the route returns `400`.
4. **Session.** `view_library`, `open_reader`, and `change_reader_setting` need a signed-in session.
   Without one, the route returns `401` and writes nothing. Only `view_book`, `open_sample`, and
   `click_external_store` can be anonymous. The sample reader sends no `change_reader_setting`.
5. **Per-instance limit.** Each server instance allows 60 events a minute per client address. The
   route reads the address from `x-real-ip`, or from the first `x-forwarded-for` entry, and keys it
   by HMAC-SHA256 with a random salt held only in memory. The route never logs or stores the address.
   The map holds at most 5,000 clients and evicts the oldest first. If no address header exists, the
   route skips this check. Over the limit, the route returns `429`.
6. **Durable quota.** The route calls `public.consume_analytics_quota`. This function runs as
   `service_role` only and counts events in fixed 60-second windows in
   `public.analytics_intake_quota`. Buckets belong to the caller, not the event. A signed-in caller
   uses its own `profile/<id>` bucket and gets 60 events a minute. That bucket also counts that
   caller's `view_book`, `open_sample`, and `click_external_store`. All anonymous callers share one `anonymous` bucket that
   allows 600 events a minute. After a window's first refused event, the function stops writing that
   bucket's row until the window ends, so a flood does not keep updating the row. A check constraint allows only these two key shapes, so the table cannot store an IP
   address. Over quota, the route returns `429` and writes nothing. If the quota call fails, the
   route skips the insert, logs `Analytics intake quota check failed.` with the request ID and error
   code, and returns `503`. The browser ignores every response, so a refused or failed event never
   affects the page.

**Change a limit.** The limits are constants in the code. The quota function takes the limit as an
argument, so a change needs no migration.

- `PROFILE_INTAKE_LIMIT`, `ANONYMOUS_INTAKE_LIMIT`, and `INTAKE_WINDOW_SECONDS` are in
  `lib/analytics/intake-quota.ts`.
- `CLIENT_INTAKE_LIMIT`, `CLIENT_INTAKE_WINDOW_MS`, and `CLIENT_INTAKE_MAX_ENTRIES` are in
  `lib/analytics/intake-limiter.ts`.

Keep the per-client limit well below the anonymous limit. Otherwise, one client can use the shared
anonymous bucket and block all other anonymous events. Change a constant, run `npm run check`, and
deploy.

To see whether a limit refuses real traffic, run this query in the hosted SQL editor. It reads only
the counters:

```sql
select bucket_key = 'anonymous' as anonymous, window_start, event_count
from public.analytics_intake_quota
order by window_start desc
limit 20;
```

The table keeps one row per bucket. In the current window, a count of limit + 1 means the route
refused at least one event. The response depends on the cause:

- **Normal traffic.** If `anonymous` reaches 601 during normal traffic, the limit is too low. Raise
  `ANONYMOUS_INTAKE_LIMIT`.
- **Attack or scripted flood.** A saturated `anonymous` bucket means someone is using up the
  shared bucket, so real anonymous visitors' `view_book`, `open_sample`, and `click_external_store` events are dropped. Do
  not raise the limit, because that only lets more junk rows in. Turn on the Vercel Firewall rule
  below, or tighten it, so the flood stops before it reaches the function. Signed-in visitors'
  events use their own profile buckets and keep recording.

**Edge rate limit (recommended).** Add a Vercel Firewall rate-limit rule for this path if the
current plan includes custom rate-limit rules. This rule stops abusive traffic before it runs a
function. The route handles only `POST`, so the rule matches on the path only. Vercel counts per
region. Start with `log` to measure traffic, then switch to `rate_limit`:

```bash
vercel firewall rules add "Analytics intake rate limit" \
  --condition '{"type":"path","op":"eq","value":"/api/analytics/events"}' \
  --action rate_limit \
  --rate-limit-window 60 \
  --rate-limit-requests 120 \
  --rate-limit-keys ip \
  --rate-limit-action log \
  --yes
```

Review the results under **Firewall** in the Vercel dashboard. Then set `--rate-limit-action
rate_limit` to return `429`. The rule does not replace the database quota. The quota is the control
that limits the size of `analytics_events`.
