# S5 SEO and Operations Design

**Status:** Approved
**Date:** 2026-09-16
**Issue:** #10
**Parent spec:** `docs/superpowers/specs/2026-09-13-remaining-mvp-ebook-launch-design.md` (section S5)
**Builds on:** S1 catalog admin (PR #15), S2 public discovery (PR #17), S3 get and buy (PR #18), and S4 reader completion (PR #19)

## 1. Goal

Launch pages are discoverable, product events stay private, and operators can find each core journey failure without direct database work.

S5 adds four connected capabilities:

1. Complete SEO metadata and structured data for public pages.
2. A small first-party analytics store for the launch funnel.
3. One durable book-ready email for each entitlement.
4. An operations page and scheduled alerts for known failure states.

## 2. What S5 Delivers

| Surface | Who | Result |
| --- | --- | --- |
| Public storefront routes | Reader and crawler | Canonical URLs, locale alternates, Open Graph metadata, and JSON-LD |
| `/sitemap.xml` | Crawler | Published locale URLs only |
| `/robots.txt` | Crawler | Storefront access and explicit private-surface exclusions |
| Stored public redirects | Reader and crawler | Exact-path `308` redirects before route rendering |
| Product journeys | Product owner | Approved first-party events without book text or reader locations |
| Entitlement grants | Reader | One localized book-ready email through a durable outbox |
| `/admin/operations` | Admin | Current EPUB, commerce, payment-event, and email failures |
| `POST /api/operations/run` | Supabase scheduler | Outbox delivery, operational rules, and operator alerts |
| Vercel Speed Insights | Product owner | Core Web Vitals from production traffic |

## 3. Out of Scope

- Marketing email, contact lists, campaigns, and unsubscribe management.
- Third-party product analytics, analytics dashboards, attribution, and experiments.
- Application performance monitoring and distributed tracing.
- An SEO preview editor or structured-data preview in the admin.
- Bulk import of legacy redirects. S6 owns the redirect inventory.
- Search-engine submission and search-console ownership. S6 owns launch setup.
- A real payment provider.
- Daily business reports and revenue reporting.
- Changes to EPUB sanitization or the reader engine.

## 4. Decisions and Corrections

### 4.1 Supabase schedules the worker route

Production uses Vercel Hobby. Vercel Hobby cron can run only once each day and does not give minute-level timing.
That limit cannot support the five-minute payment-event rule.

Supabase `pg_cron` runs every five minutes. It uses `pg_net` to call the Next.js worker route.
The project URL and route secret live in Supabase Vault.

The schedule is an operator deployment step. A migration cannot contain an environment URL or secret.
The operations runbook contains idempotent SQL that creates or replaces the schedule.

The worker route owns external effects. SQL owns durable state, leases, and unique constraints.
This boundary keeps Resend calls and email rendering out of database functions.

### 4.2 Resend sends application email

The application uses a small `MailProvider` interface. The production adapter uses Resend.
A no-network adapter is available only when `APP_ENV` is `local` or `test`.
Production startup rejects the no-network adapter.

The database outbox is the source of truth. A Resend idempotency key based on the outbox row ID gives a second duplicate-delivery guard.

### 4.3 Speed Insights supplies Core Web Vitals

The root layout renders `@vercel/speed-insights` with its Next.js adapter.
The Vercel project must enable Speed Insights before launch.

The Hobby plan gives a seven-day reporting window and 10,000 data points each month.
S5 starts with the default sample rate because launch traffic is small.
The operations runbook explains how to reduce the sample rate before the monthly limit becomes a concern.

### 4.4 Deliberate revocation is not an operations failure

S3 keeps an order completed after an admin revokes its entitlement.
Therefore, a completed order without active access is not always broken.

The missing-entitlement rule ignores an order when an order-backed entitlement exists in the `revoked` state.
It reports an order only when no active or deliberately revoked order-backed entitlement exists.

### 4.5 S5 includes `change_reader_setting`

The parent spec lists the launch events but omits `change_reader_setting`.
The S4 design assigns that event to S5, and the reader setting flow now exists.
S5 records the event without the selected setting value.
Only the entitled reader sends the event.
The anonymous sample reader sends no `change_reader_setting`, because the intake requires a session for this event (section 8.2).

### 4.6 Redirect caching is best effort

Next.js 16 does not apply `fetch` cache settings inside Proxy.
Vercel Hobby also provides no shared low-latency key-value store in this project.

The redirect resolver uses a 60-second process-local cache as an optional performance aid.
Correctness does not depend on that cache because a miss reads the database function.
Different function instances can hold different cache entries for at most 60 seconds.

## 5. Architecture

### 5.1 Components

| Component | Responsibility | Dependencies |
| --- | --- | --- |
| `lib/seo/metadata.ts` | Canonical URLs, locale alternates, Open Graph fields, and robots metadata | `SITE_URL`, locale routes, public DTOs |
| `lib/seo/json-ld.ts` | Typed `Organization`, `Book`, `Offer`, `Person`, and `BreadcrumbList` values | Public DTOs only |
| `components/seo/json-ld.tsx` | Safe JSON-LD script serialization | Typed JSON-LD values |
| `app/sitemap.ts` | Published locale URL list | Public catalog reads |
| `app/robots.ts` | Crawler rules and sitemap location | `SITE_URL`, supported locales |
| `resolve_public_redirect` | Exact public redirect lookup | `redirects` table |
| `lib/redirects/resolve.ts` | Safe redirect path validation and optional short cache | Public Supabase client |
| `lib/analytics/events.ts` | Typed event contract and `trackEvent` | `analytics_events` |
| `POST /api/analytics/events` | Same-origin browser event intake with abuse controls | Session (required for `view_library`, `open_reader`, and `change_reader_setting`), `consume_analytics_quota`, `trackEvent` |
| `lib/email/provider.ts` | Provider-neutral email contract | None |
| `lib/email/resend.ts` | Resend delivery adapter | Resend API |
| `lib/email/book-ready.ts` | Localized subject, text, and HTML | Dictionary, catalog data |
| `lib/email/outbox.ts` | Lease, deliver, retry, and complete outbox rows | Service-role client, mail provider |
| `lib/ops/checks.ts` | Typed operational findings | Supabase client and current time |
| `lib/ops/alerts.ts` | Finding fingerprints and alert state | `operations_alert_state`, mail provider |
| `/admin/operations` | Admin view of live findings | Admin session client |
| `POST /api/operations/run` | Scheduled outbox and operations run | Worker secret, service-role client |

Each unit has one purpose. Public metadata does not depend on analytics.
Analytics failure does not block a customer action.
Email failure does not roll back an entitlement.

### 5.2 Scheduled run

Each scheduled request performs these steps:

1. The route compares the bearer token with `OPS_WORKER_SECRET` in constant time.
2. The route claims at most 25 available outbox rows.
3. The route sends each claimed message and records its result.
4. The route runs all operational rules against one supplied `now` value.
5. The route updates the state and fingerprint for each rule.
6. The route sends alerts for new, changed, or overdue findings.
7. The route returns counts and a request ID. It does not return customer data.

If one message fails, the route continues with the remaining claimed rows.
If an operational query fails, the route returns `500` after it records a safe server log with the request ID.

## 6. Database Design

New migrations add the S5 tables, functions, triggers, grants, and indexes.
The same change updates `lib/supabase/database.types.ts`.

### 6.1 `analytics_events`

`analytics_events` is append-only and contains these columns:

| Column | Rule |
| --- | --- |
| `id` | UUID primary key |
| `event_name` | Approved S5 event name |
| `dedupe_key` | Nullable text, unique when present, maximum 200 characters |
| `profile_id` | Nullable profile reference, derived on the server |
| `book_id` | Nullable book reference |
| `order_id` | Nullable order reference |
| `publication_id` | Nullable publication reference |
| `processing_job_id` | Nullable processing-job reference |
| `locale` | Nullable `vi` or `en` |
| `device_class` | Nullable `mobile`, `tablet`, or `desktop` |
| `occurred_at` | Server timestamp |

The table has no general JSON property column.
This structure makes the privacy rule a schema rule rather than an application convention.

Browser roles have no direct insert, update, or delete grant.
Admins can read events through the existing admin model.
Only server code and trusted database triggers create rows.

### 6.2 `notification_outbox`

`notification_outbox` contains these columns:

| Column | Rule |
| --- | --- |
| `id` | UUID primary key |
| `entitlement_id` | Entitlement reference, unique |
| `profile_id` | Profile reference |
| `template_key` | `book_ready` in S5 |
| `available_at` | Earliest delivery time |
| `attempt_count` | Failed delivery count |
| `lease_token` | Nullable opaque claim token |
| `lease_expires_at` | Nullable lease expiry |
| `last_error_code` | Nullable safe provider or application code |
| `provider_message_id` | Nullable Resend message ID |
| `sent_at` | Nullable delivery-acceptance time |
| `created_at` | Creation time |

The table does not store rendered HTML or a copied book title.
The worker resolves the current verified email, profile locale, public title, and public route at delivery time.

An entitlement trigger inserts one row when either condition is true:

- A row is inserted with `status = 'active'`.
- A row changes from `revoked` to `active`.

The trigger uses `on conflict (entitlement_id) do nothing`.
This rule gives one lifetime book-ready message for one entitlement row.
It also makes a duplicate grant safe.

The migration does not create outbox rows for existing active entitlements.
This prevents an email burst when S5 deploys.

### 6.3 Outbox claims and completion

`claim_notification_outbox(p_limit, p_lease_token)` runs as `service_role` only.
It uses `for update skip locked` and claims rows that meet all these conditions:

- `sent_at` is null.
- `available_at <= now()`.
- No active lease exists.
- `attempt_count < 6`.
- The linked entitlement is active.

A revoked entitlement stays pending without consuming delivery attempts.
If an admin reactivates the same entitlement, its existing outbox row becomes claimable again.

The function returns only the data that the worker needs.
It does not return a provider API key.

Success sets `sent_at`, stores the provider message ID, and clears the lease.
Failure clears the lease, increments `attempt_count`, stores a safe error code, and moves `available_at` forward.
The retry delays after the first five failures are 1 minute, 5 minutes, 30 minutes, 2 hours, and 6 hours.
The sixth failure stops automatic delivery attempts and keeps the row visible to operators.

### 6.4 `operations_alert_state`

`operations_alert_state` has one row for each rule name.
It stores these values:

- Active state.
- A hash of the sorted finding IDs.
- First detection time.
- Last evaluation time.
- Last successful alert time.
- Resolution time.

The scheduler sends an alert when one condition is true:

- A rule changes from clear to active.
- The finding hash changes.
- An active rule has no successful alert in the last 24 hours.

The scheduler sets `last_alerted_at` only after Resend accepts the alert.
If Resend fails, the next scheduled run tries again.

### 6.5 Security and immutability

Browser roles cannot write any S5 table directly.
Authenticated admins can read the tables needed by `/admin/operations`.
Only `service_role` can claim or complete outbox rows and update alert state.

`analytics_events` rejects updates and deletes through an immutability trigger.
`notification_outbox` permits only its worker functions to change delivery fields.

## 7. SEO

### 7.1 URL rules

`SITE_URL` is the only public origin.
The root layout sets it as `metadataBase`.

Canonical URLs never contain these values:

- Catalog filters or sort values.
- Search queries.
- Action-error queries.
- Authentication return paths.

Fixed locale pages have both `vi` and `en` alternates.
An entity page has an alternate only when that entity has a localization in the other locale.
No page borrows translated copy from another locale.

### 7.2 Route metadata

| Route | Canonical | Index rule | Open Graph image |
| --- | --- | --- | --- |
| `/{locale}` | Self | Index | Branded default |
| `/{locale}/books` | Unfiltered catalog | Index only when unfiltered | Branded default |
| `/{locale}/books/[slug]` | Self | Index | Book cover, or branded default |
| `/{locale}/{authors,series,topics}/[slug]` | Self | Index | Branded default |
| `/{locale}/search` | Query-free route | No index, follow | Branded default |
| `/{locale}/read-sample/[slug]` | Self | No index, no follow | Book cover, or branded default |
| Account, checkout, library, and reader routes | Self when needed | No index, no follow | None required |
| Admin and authentication routes | None required | No index, no follow | None required |

Book metadata prefers `seo_title` and `seo_description`.
It falls back to the visible title and short description.

### 7.3 JSON-LD

Typed builders produce plain serializable objects.
They accept public DTOs and never query the database.

The builders produce these schema types:

- `Organization` on the home page.
- `Book` on a book page.
- `Offer` inside `Book` only when the page displays a price.
- `Person` on an author page.
- `BreadcrumbList` on catalog, book, author, series, and topic pages.

A free or enabled paid offer uses `https://schema.org/InStock`.
A paid coming-soon offer uses `https://schema.org/OutOfStock` because the site does not accept a preorder.

The JSON-LD component replaces `<` with `\u003c` in serialized output.
This prevents catalog text from ending the script element.

### 7.4 Sitemap

`app/sitemap.ts` includes these pages:

- Both localized home pages.
- Both unfiltered catalog pages.
- Each published localized book page.
- Each localized author, series, and topic page that has at least one visible book.

It does not include search, samples, account, checkout, library, reader, admin, authentication, or API routes.

The sitemap derives entity URLs from the same public catalog view as the storefront.
An admin catalog mutation invalidates `/sitemap.xml` with the storefront paths.

### 7.5 Robots

`app/robots.ts` allows the public storefront and points to `/sitemap.xml`.
It disallows these prefixes:

- `/admin`, `/api`, and `/auth`.
- `/{locale}/account`, `/{locale}/checkout`, `/{locale}/library`, and `/{locale}/read`.
- `/{locale}/read-sample` and `/{locale}/search`.
- Localized sign-in, sign-up, password-reset, and password-update routes.

Metadata remains the authority for `noindex`.
The robots file only controls crawling and does not replace page metadata.

### 7.6 Stored redirects

`resolve_public_redirect(p_source_path text)` is a `security definer` read function.
It returns one relative destination path or null.
It is executable by `anon` and `authenticated`.
It never returns the redirect table or another source path.

Proxy performs redirect lookup before session refresh for eligible requests.
A request is eligible only when all these statements are true:

- The method is `GET` or `HEAD`.
- The path is not under `/api`, `/auth`, `/admin`, or `/_next`.
- The path is not a known static asset.

The destination must start with one `/` and must not start with `//`.
Proxy constructs the destination against the current request origin and returns `308`.
The original query string is not copied because stored redirects identify canonical paths.

## 8. Analytics

### 8.1 Event contract

`trackEvent` is server-only and accepts a discriminated union.
Each event type permits only its required identifier columns, locale, and device class.

The event source and duplicate rule are:

| Event | Source | Duplicate rule |
| --- | --- | --- |
| `view_book` | Browser beacon after the book page becomes visible | Client event UUID |
| `open_sample` | Reader client after a successful sample mount | Client event UUID |
| `begin_checkout` | Buy action after order creation or reuse | Order ID |
| `purchase` | Verified payment result that first completes an order | Order ID |
| `payment_failed` | Applied verified failed event | Provider event ID |
| `open_reader` | Reader client after a successful entitled mount | Client event UUID |
| `progress_25` | Winning progress save first reaches 0.25 | Profile, publication, and milestone |
| `progress_50` | Winning progress save first reaches 0.50 | Profile, publication, and milestone |
| `progress_75` | Winning progress save first reaches 0.75 | Profile, publication, and milestone |
| `progress_100` | Winning progress save first reaches 0.99 | Profile, publication, and milestone |
| `change_reader_setting` | User changes a reader setting | Client event UUID |
| `view_library` | Browser beacon after the library becomes visible | Client event UUID |
| `book_published` | `publish_book` writes its audit row | Audit-log ID |
| `epub_job_started` | Job status changes into `processing` | Job ID, attempt, and state |
| `epub_job_completed` | Job status changes into `completed` | Job ID, attempt, and state |
| `epub_job_failed` | Job status changes into `failed` | Job ID, attempt, and state |

`progress_100` uses the product completion threshold of `0.99`.
This matches S4 and `library_items.state`.

### 8.2 Browser events

Browser events use a small client beacon because a Server Component render is not a real page view.
Next.js can render a page for prefetch or metadata work.

`POST /api/analytics/events` enforces these rules:

- The request origin must match `SITE_URL`.
- The body must be 1,024 bytes or less. The route rejects a larger declared `Content-Length` before it reads the body. It then reads the body as a stream and cancels the stream when the total passes the limit, so a chunked body without a declared length also gets `413`. It returns `400` for invalid UTF-8, invalid JSON, or a client that stops sending mid-body.
- The event name and fields must match the typed browser-event schema.
- The route derives `profile_id` from the session and never accepts a profile ID from the body.
- `view_library`, `open_reader`, and `change_reader_setting` require a signed-in session. Without one, the route returns `401` and writes nothing. Only `view_book` and `open_sample` can be anonymous.
- A per-instance limiter caps each client address before the durable quota. It keys the address with HMAC-SHA256 and a random salt held only in process memory, and it never logs or stores the address. The route skips this limiter when no address header is present.
- A durable quota, `consume_analytics_quota`, runs before the service-role insert. It counts fixed windows in `analytics_intake_quota`, with one `profile/<id>` bucket for each signed-in caller and one shared `anonymous` bucket for anonymous callers. A signed-in caller's `view_book` counts against the caller's profile bucket. The bucket key cannot hold an IP address.
- Either limit returns `429` and writes nothing. If the quota check fails, the route skips the insert, logs the request ID and error code, and returns `503`.
- Every error response includes the request ID. The browser ignores every response, so a refused or failed event does not interrupt the page.

The client computes only a coarse device class from the viewport width.
It does not send the viewport size or user-agent string.

### 8.3 Transaction events

Customer actions remain successful when analytics insertion fails.
The application logs the failure with a request ID and does not expose it to the customer.

State transitions with an atomic database boundary use database triggers:

- Winning progress writes create missing milestone events.
- A `publish_book` audit row creates `book_published` in the same transaction.
- Processing-job state changes create the three EPUB events for the current attempt.

Payment events use deterministic keys after `apply_payment_event` returns.
A replay resolves to the same key and inserts no duplicate analytics row.
A failed payment event records `payment_failed` only when the returned payment state is `failed`.
A successful event records `purchase` only when the returned order and payment states are successful.

## 9. Book-Ready Email

### 9.1 Recipient and locale

The worker selects a currently verified customer identity for the entitlement profile.
If more than one verified identity exists, it uses the oldest verified row for deterministic behavior.

The worker uses `profiles.locale` for the email and library URL.
If that locale has no public book localization, the message uses generic book-ready copy and links to the library.
It never uses another locale's book copy as a translation fallback.

### 9.2 Content

The message contains:

- A localized subject.
- The visible book title when it exists in the profile locale.
- A short statement that access is ready.
- One same-origin link to `/{locale}/library`.
- A plain-text and HTML body.

The HTML renderer escapes all catalog and customer text.
The message contains no EPUB URL, signed resource URL, reader session, order amount, or service token.

### 9.3 Delivery result

Resend acceptance marks the outbox row sent.
The worker stores the Resend message ID for support diagnosis.
Provider rejection, timeout, rate limit, and invalid recipient use stable safe error codes.

A process crash after Resend accepts the message but before the database commit can cause a later retry.
The Resend idempotency key reduces this risk.
The design does not claim strict exactly-once delivery across the external provider boundary.

## 10. Operations

### 10.1 Finding contract

Each operational rule returns a named group of `OpsFinding` values.
Each finding contains these values:

- Stable finding ID.
- Rule name.
- First relevant timestamp.
- Safe summary with no customer email.
- Admin repair URL.

The scheduled worker and `/admin/operations` call the same functions.
The worker supplies a service-role client after secret verification.
The page supplies an authenticated client after `requireAdmin()`.

### 10.2 Rules

#### Stale EPUB jobs

Report a job when one condition is true:

- Its status is `queued` or `processing`, and `updated_at` is more than 30 minutes old.
- Its status is `processing`, and `lease_expires_at` is in the past.

The repair URL points to the book editor EPUB section.

#### Completed orders without an entitlement

Report a completed order when no order-backed entitlement exists in either `active` or `revoked` state.
This rule does not report a deliberate revocation.

The repair URL points to the admin order detail.

#### Unprocessed payment events

Report a payment event when `processed_at` is null for more than five minutes.
The repair URL points to the related admin order detail.

The simulator currently inserts and processes an event in one transaction.
This rule protects later providers and detects manual or partial ingestion faults.

#### Failed notification delivery

Report an unsent outbox row after its fourth failed attempt.
Ignore a row while it has a valid lease.

The repair URL points to the affected admin user page.

### 10.3 Admin page

`/admin/operations` calls `requireAdmin()` in the page.
It groups findings by rule and shows the number, age, summary, and repair link.

The page also shows:

- The last scheduler evaluation time.
- The last successful alert time for each active rule.
- A healthy empty state when all rules are clear.

S5 does not add repair mutations to this page.
Operators use the existing book, order, and user pages.

### 10.4 Operator alert

One email can contain findings from multiple active rules.
It contains counts and admin links, but no customer email or provider payload.

The route sends an alert for a new finding set, a changed finding set, or a 24-hour reminder.
It does not send the same unchanged alert every five minutes.

If Resend is unavailable, the admin page and Vercel logs remain available.
The system cannot send an email that reports a total outage of its own email provider.

## 11. Environment and Deployment

S5 adds these server-only environment variables:

| Variable | Rule |
| --- | --- |
| `EMAIL_PROVIDER` | `resend` in production, `resend` or `test` elsewhere |
| `RESEND_API_KEY` | Required when the provider is `resend` |
| `EMAIL_FROM` | Valid sender address on the configured Resend domain |
| `OPS_ALERT_EMAIL` | Valid operator recipient address |
| `OPS_WORKER_SECRET` | At least 32 random characters |

No S5 secret uses the `NEXT_PUBLIC_` prefix.
Server environment parsing fails at startup when a required production value is absent.

The deployment runbook contains these steps:

1. Add and make sure that the Resend sending domain is valid.
2. Set the Vercel production environment variables.
3. Apply the S5 migration.
4. Put `SITE_URL` and `OPS_WORKER_SECRET` in Supabase Vault.
5. Create the five-minute `pg_cron` schedule.
6. Invoke the worker route once and inspect its safe count response.
7. Enable Vercel Speed Insights.
8. Seed and resolve one local finding before the production rollout.

The runbook also contains SQL to remove or replace the schedule.
It warns the operator not to run local fixtures against the cloud project.

## 12. Security and Error Handling

- Public metadata uses public catalog DTOs only.
- Public JSON-LD contains only fields that the page displays.
- The redirect function exposes one exact destination and no table scan.
- Redirect destinations cannot change the origin.
- The analytics route derives identity from the session and never trusts a profile ID.
- The analytics route requires a session for session-bound events. It bounds the body read and applies a per-instance limiter and a durable quota before it creates the service-role client.
- Analytics cannot store ebook text, titles, slugs, search queries, emails, locators, IP addresses, or user-agent strings.
- The operations route creates a service-role client only after secret verification.
- The operations page calls `requireAdmin()` before it reads operational data.
- Outbox functions execute as `service_role` only.
- Email HTML escapes dynamic text.
- Provider errors are mapped to safe codes before storage or logs.
- Server errors include the existing request ID.
- Customer actions do not fail because analytics or email delivery fails after the business transaction commits.

## 13. Testing

### 13.1 pgTAP

Database tests cover these cases:

- Browser roles cannot insert, update, or delete S5 rows.
- Admins can read the data required by the operations page.
- One new entitlement creates one outbox row in the same transaction.
- A duplicate grant or reactivation creates no second outbox row.
- Existing entitlements receive no migration backfill.
- Two workers cannot claim the same outbox row.
- A completed lease records success once.
- A failed lease increments attempts and schedules the documented delay.
- The fourth failure appears in operational findings.
- A winning progress save creates each crossed milestone once.
- A stale progress save creates no milestone.
- A book publication transition and each EPUB job transition create one event.
- Each seeded operational fault appears in its rule.
- An audited order entitlement revocation does not appear as a missing-entitlement fault.
- A non-admin cannot execute or read privileged operations interfaces.
- The analytics intake quota counts each window, enforces the limit, leaves a refused call's row unchanged, and resets after the window. It stores no IP-like value. Only `service_role` can execute it, and no API role can read or write its table directly.

### 13.2 Vitest

Unit and component tests cover these cases:

- Absolute canonical URL construction and query removal.
- Locale alternates for fixed and localized entity pages.
- Every JSON-LD builder and safe script serialization.
- Sitemap inclusion and exclusion.
- Robots rules for both locales.
- Redirect path acceptance, bypass rules, expiry, and same-origin enforcement.
- Every typed analytics event and every rejected field.
- Browser event origin, body-size, and identity rules.
- A streamed body read that stops at the limit, and the `401`, `429`, and `503` intake responses.
- The hashed per-instance limiter window, its bounded size, and address-header selection.
- Device-class boundaries.
- Localized book-ready text and HTML escaping.
- Resend request mapping and idempotency key.
- Outbox retry scheduling and lease recovery.
- All four operational rules.
- Finding fingerprints, new alerts, changed alerts, resolution, and 24-hour reminders.
- Production environment rejection of the test mail provider.

### 13.3 Route and browser tests

Route tests cover a missing, malformed, and valid worker secret.
They also make sure that a valid run returns only counts and the request ID.

Playwright covers these journeys:

- Public pages render canonical and locale-alternate links.
- A book page renders safe `Book`, `Offer`, and breadcrumb JSON-LD.
- Sitemap and robots contain the expected public and private paths.
- A seeded stored redirect returns `308` to the final path.
- Account, checkout, library, reader, sample, search, authentication, and admin pages are `noindex`.
- Book, sample, checkout, reader, progress, and library actions create the expected event rows without sensitive values.
- A seeded failure appears on `/admin/operations` with the correct repair link.
- A duplicate entitlement grant leaves one outbox row.

The final S5 gate runs these commands against a clean local Supabase stack:

```bash
npm run db:reset
npm run db:test
npm run check:full
```

## 14. Documentation

S5 creates `docs/runbooks/seo-and-operations.md` with these procedures:

- Make sure that canonical URLs, locale alternates, JSON-LD, sitemap, and robots are correct.
- Set up the Resend domain and sender.
- Set up, replace, inspect, and remove the Supabase schedule.
- Run the worker manually without exposing its secret.
- Respond to each operational finding.
- Retry a failed book-ready email safely.
- Enable and read Vercel Speed Insights on Hobby.

S5 also updates:

- `.env.example` with non-secret examples.
- `docs/runbooks/deployment.md` with production variables and deployment order.
- `docs/runbooks/testing-environments.md` with the local no-network mail provider.
- `docs/runbooks/storefront.md` with canonical and redirect behavior.

## 15. Exit Criteria

- Every indexable public page has one canonical URL, correct locale alternates, an Open Graph image, and valid JSON-LD for its visible data.
- Sitemap contains only published localized storefront URLs.
- Robots and page metadata keep private and application surfaces out of search results.
- A stored source path returns one same-origin `308` redirect to its final destination.
- Every approved launch event records once under its documented duplicate rule.
- The analytics schema cannot store book text, reader locations, emails, queries, IP addresses, or user-agent strings.
- Every new entitlement creates one outbox row, and a duplicate grant creates no second row.
- The worker retries delivery safely and records Resend acceptance.
- Each seeded operational fault appears on `/admin/operations` and creates an alert state.
- A new, changed, or overdue finding sends one operator alert. An unchanged finding does not send an alert every five minutes.
- Vercel Speed Insights is enabled and receives production data within the Hobby allowance.
- `npm run db:reset`, `npm run db:test`, and `npm run check:full` pass on a clean local stack.

## 16. References

- Parent roadmap: `docs/superpowers/specs/2026-09-13-remaining-mvp-ebook-launch-design.md`
- S2 design: `docs/superpowers/specs/2026-09-15-s2-public-discovery-design.md`
- S3 design: `docs/superpowers/specs/2026-09-15-s3-get-and-buy-design.md`
- S4 design: `docs/superpowers/specs/2026-09-16-s4-reader-completion-design.md`
- Next.js metadata guide: `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/generate-metadata.md`
- Next.js sitemap guide: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/sitemap.md`
- Next.js robots guide: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/robots.md`
- Next.js Proxy guide: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`
- Vercel Cron limits: <https://vercel.com/docs/cron-jobs/usage-and-pricing>
- Vercel Speed Insights limits: <https://vercel.com/docs/speed-insights/limits-and-pricing>
- Supabase scheduled functions: <https://supabase.com/docs/guides/functions/schedule-functions>
- Resend email API: <https://resend.com/docs/api-reference/emails/send-email>
