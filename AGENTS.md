<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Repository guide

## Current scope

Infinity Books Press implements one complete ebook path on Next.js 16 and Supabase.

- An admin creates a book and uploads a private EPUB file.
- The local EPUB worker validates, sanitizes, and processes the file.
- An admin reviews a publication and publishes, rejects, or rolls it back.
- A customer gets access through a free offer, a grant, a manual bank transfer, SePay, or the payment simulator.
- The customer library shows reading progress and opens the protected Readium reader.
- The reader uses short sessions and saves progress through database functions.
- Public and customer pages support Vietnamese and English.
- Email magic links are the main sign-in method. Password pages are an internal fallback.

The payment simulator is for local, test, and staging only. Production rejects this provider.

## Code map

- Put routes, pages, server actions, and HTTP handlers in `app/`.
- Put authorization in `lib/auth/` and access grants in `lib/access/`.
- Put server data access in `lib/data/`.
- Put EPUB parsing, sanitizing, processing, and worker code in `lib/epub/`.
- Put reader contracts, sessions, progress, and the Readium adapter in `lib/reader/`.
- Put database changes in `supabase/migrations/` and database tests in `supabase/tests/`.
- Use `scripts/ebook.ts` for local EPUB processing commands.
- Read `docs/runbooks/` before you test, deploy, or process a real book.
- Read `docs/adr/ADR-005-reader-engine.md` before you change the reader engine.

## Required rules

- Read the relevant local Next.js guide before you change Next.js code.
- Keep customer routes under `/{locale}`. The supported locales are `vi` and `en`.
- Keep `/admin` without a locale prefix.
- Call `requireUser()` or `requireAdmin()` in each protected page and server action.
- Do not use a layout as the only authorization control.
- Create a service-role client only after the admin authorization gate passes.
- Never expose `SUPABASE_SERVICE_ROLE_KEY` to browser code.
- Keep EPUB source files and processed resources in private storage.
- Keep the Readium package behind the `ReaderEngine` interface.
- Treat EPUB sanitization as the content security boundary.
- Do not weaken EPUB sanitization because a Content Security Policy header exists.
- Use the authenticated database functions for entitlements, reader sessions, and progress writes.
- Add a new migration if an environment already applied the old migration.
- Update `lib/supabase/database.types.ts` when the database schema changes.
- Keep code, comments, tests, and runbooks consistent with the implemented behavior.

## Test rules

- Run `npm run check` for lint, types, unit tests, and the production build.
- Run `npm run check:full` after a change to route authorization or the complete customer path.
- Run `npm run db:reset` and `npm run db:test` after a database change.
- Run database and Playwright tests only against a local Supabase stack.
- Export the Supabase and Mailpit variables in the test shell before Playwright runs.
- Read `docs/runbooks/testing-environments.md` for the exact test setup.
- Use Node.js 22 or a newer supported version. CI uses Node.js 22.
- Keep regression tests with each fixed defect.

## Safety rules

- Do not run destructive database commands against the cloud project.
- Do not run Playwright fixtures against the cloud project.
- Do not run EPUB `process` or `retry` commands against cloud data by accident.
- Do not commit `.env.local`, EPUB files, keys, tokens, or customer data.
- Preserve request IDs in server errors and operational logs.
