# Infinity Books

Infinity Books is a Next.js application for a future online bookstore and reading library. The current release provides localized public pages and Supabase email magic-link sign-in.

## Technology

The application uses these main tools:

- Next.js 16 with the App Router
- React 19
- TypeScript 6 in strict mode
- Tailwind CSS 4
- shadcn/ui
- Supabase Auth with cookie-based server rendering

TypeScript 7 and ESLint 10 are not yet compatible with the lint plug-ins in Next.js 16.3.4. The project uses TypeScript 6.0.3 and ESLint 9.39.5.

## Requirements

Install Node.js 22 or a newer supported release, the Supabase CLI, and Docker. Use npm to install and run the project.

## Local setup

1. Install the dependencies.

```bash
npm install
```

2. Start the local Supabase stack. It applies the email templates in `supabase/templates` and prints the local keys.

```bash
supabase start
supabase status
```

3. Copy the environment template and fill in the keys from `supabase status`.

```bash
cp .env.example .env.local
```

4. Start the development server and open [http://127.0.0.1:3000](http://127.0.0.1:3000). Local sign-in emails appear in Mailpit at [http://127.0.0.1:54324](http://127.0.0.1:54324).

```bash
npm run dev
```

## Environment

The server validates this configuration when it starts. If a value is missing or unsafe, it logs the validation error and fails every request instead of serving pages.

| Variable | Purpose |
| --- | --- |
| `APP_ENV` | `local`, `preview`, `staging`, `production`, or `test`. |
| `SITE_URL` | Public origin used in authentication emails. |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase API URL. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser-safe Supabase key. |
| `SUPABASE_SERVICE_ROLE_KEY` | Privileged server-only key. Never expose it through a `NEXT_PUBLIC_` variable. |
| `PAYMENT_PROVIDER` | `disabled` or `simulator`. Production rejects `simulator`. |
| `PAYMENT_SIMULATOR_SECRET` | Signs simulated payment events. At least 32 characters. Required when `PAYMENT_PROVIDER=simulator`. |
| `READER_SESSION_TTL_SECONDS` | Reader session lifetime, from 60 to 3600 seconds. |
| `E2E_MAILPIT_URL` | Local Mailpit, for the Playwright suite only. Not read by the application. |

URLs must use HTTPS. Plain HTTP is accepted only for `localhost`, `127.0.0.1`, and `[::1]`. Do not commit `.env.local`.

## Hosted Supabase Auth setup

Local configuration lives in `supabase/config.toml`. For each hosted project:

1. Set the Site URL to the environment's `SITE_URL`.
2. Add `https://your-domain/auth/callback**` as a redirect URL.
3. Copy the templates from `supabase/templates` into the Magic Link, Confirm signup, and Reset password email templates.

The templates send token-hash links that start at the Site URL. A link requested on one device also works on another, and a missing redirect URL only loses the requested destination instead of breaking the link. The callback still accepts PKCE codes from the default templates, but those links work only in the browser that requested them.

Row Level Security is a database feature that limits which rows each user can access. Enable and test it before browser code reads application tables.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run check` | Lint, typecheck, unit tests, and production build. |
| `npm run check:full` | Everything in `npm run check`, then the Playwright suite. |
| `npm run test:e2e` | Playwright tests against a production build. |
| `npm run db:reset` | Recreate the local database from migrations. |
| `npm run db:test` | Run pgTAP database tests. |

Run `npm run check:full`, not `npm run check`, for any change to route authorization: who may reach a route, which gate a page calls, or what a denied caller receives. The unit suites cover the pure decision helpers, not the wiring, so removing a gate leaves them green; only the Playwright suite sees it. CI runs the same suite in its own job.

The Playwright suite requires a local Supabase stack and refuses to start without one. `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `E2E_MAILPIT_URL` must all be set **in the shell that runs the tests**, not only in `.env.local`: the config's `webServer.env` reaches the spawned server, never the test runner. A missing variable fails the run at config load with a message naming what to start.

This is deliberate. These specs previously skipped themselves when the environment was absent, so a bare `npm run test:e2e` ran 7 of 20 specs and still exited 0 — a green result that meant most of the suite had not run. The suite now refuses to run a subset of itself.

```bash
supabase start
eval "$(supabase status -o env)"
export NEXT_PUBLIC_SUPABASE_URL="$API_URL" \
       NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY" \
       SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
       E2E_MAILPIT_URL="$MAILPIT_URL"
npm run test:e2e
```

The fixtures refuse to run against a non-loopback Supabase URL, because they create confirmed users and grant the admin role with no teardown.

Chromium runs on every pull request. Firefox and WebKit run only on main-branch pushes and the nightly schedule, and only for the golden-path spec — set `E2E_BROWSER_MATRIX=all` to include them locally, which requires `npx playwright install firefox webkit` first.

The production build uses webpack. Turbopack cannot bind its CSS worker port in the managed development environment used for this repository.

## Routes

Customer routes are prefixed with the interface locale, `vi` or `en`. The interface locale does not determine a book's language, market, or currency.

- `/` redirects to `/vi`.
- `/{locale}` is the public landing page.
- `/{locale}/sign-in` sends an email magic link.
- `/{locale}/account` shows the protected account page.
- `/{locale}/library` and `/{locale}/read/{bookId}` require sign-in and are shells today; the catalog and reading experience arrive in the ebook golden-path plan.
- `/auth/callback` verifies an email link and starts a session.

Password access is an internal fallback. These pages are not linked from customer pages and are excluded from search indexing:

- `/internal/{locale}/sign-in`
- `/internal/{locale}/forgot-password`
- `/internal/{locale}/update-password`

`/admin` has no locale prefix. It requires an admin account (checked in each page and action, not by its layout) and is a shell today: `/admin` shows operational counts, and `/admin/books/new` is a form shell whose mutation arrives in the ebook golden-path plan.

EPUB processing runs as a local CLI in a later phase of the MVP plan.

## Planned database scope

An earlier README described a 106-table schema for the complete Infinity Books product. The migration and seed files from that description are not in this checkout.

The planned domains include:

- Books, authors, editions, topics, series, and localization
- Offers, bundles, inventory, carts, orders, payments, and fulfillment
- Articles, pages, reviews, collections, and merchandising
- Profiles, addresses, roles, consent, and audit records
- E-books, entitlements, reading progress, annotations, and sessions
- Jobs, notifications, newsletters, redirects, and search metadata

This application does not create or deploy that schema. Add database work through reviewed migrations with explicit Row Level Security policies.
