# Runbook: testing environments

There are three environments and **no dev or staging tier**. One Supabase project and one Vercel
production project serve everything, which is a deliberate pre-go-live choice and the reason several
rules below are stricter than they would otherwise need to be.

| # | App runs | Database | What it is for |
| --- | --- | --- | --- |
| 1 | Local (`npm run dev`) | Local Supabase (Docker) | All automated testing. The only environment where the full suite may run. |
| 2 | Local | **The** cloud Supabase | Reproducing data-shaped problems against real rows. Read-mostly. |
| 3 | Vercel production | **The same** cloud Supabase | Smoke verification only. |

Environments 2 and 3 share one database. **There is no second copy.** Anything you do in
environment 2 happens to production data.

---

## Environment 1 — local app, local Supabase

The default, and the only place the test suites are safe to run.

### Setup

```bash
npm install
supabase start           # applies supabase/templates and prints the local keys
supabase status
cp .env.example .env.local   # then fill in the keys from `supabase status`
npm run dev              # http://127.0.0.1:3000
```

Local sign-in emails land in Mailpit at <http://127.0.0.1:54324>.

### Ports, and a footgun that has cost real time

The default local stack uses **54321** (API), **54322** (Postgres), **54323** (Studio), and
**54324** (Mailpit).

When the browser app uses a dedicated port, also set the scratch Supabase `[auth].site_url` to
that app origin and add its `/auth/callback**` URL to `additional_redirect_urls`, then restart only
that scratch stack. The email templates use Auth's `SiteURL`; setting Playwright's `SITE_URL`
alone does not change it. Otherwise email tests leave the dedicated test server and open port
3000, potentially contacting an unrelated app. Restore temporary scratch Auth settings after
the run. Never alter another project's stack to make these tests pass.

> **Those ports may already belong to a different project on this machine.** On the development
> machine used for this repository they are held by an unrelated stack that must not be stopped or
> reconfigured. When that is the case, run a second stack from a scratch workdir on 55xxx and pass
> `--workdir` to every Supabase command:
>
> ```bash
> supabase start    --workdir .superpowers/scratch/sbworkdir
> supabase db reset --workdir .superpowers/scratch/sbworkdir
> supabase test db  --workdir .superpowers/scratch/sbworkdir
> ```

**`npm run db:reset` and `npm run db:test` carry no `--workdir`.** They target the default 543xx
ports. If another stack owns those ports, **do not use the npm scripts** — call `supabase` directly
with `--workdir`. This is the single most common way to damage an unrelated project from this
repository.

### The suites

| Command | Covers |
| --- | --- |
| `npm run check` | lint, typecheck, unit tests, production build |
| `npm run test:unit` | unit tests alone |
| `supabase test db` | pgTAP — schema, RLS policies, and the security-definer RPCs |
| `npm run test:e2e` | Playwright, against a production build |
| `npm run check:full` | `check` then Playwright |

### Your Node version is not CI's, and the difference has bitten

CI pins **Node 22** (`.github/workflows/ci.yml`). If you run a newer major locally, a green suite here
does **not** predict CI — Node 23+ can `require()` an ES module transparently, and Node 22 cannot.
That difference took out three suites on this repository's first CI run: `sanitize-html` is CommonJS
and depends on an `htmlparser2` that ships as ESM, so under Node 22 those files failed to load at
all — 97 tests reported as "no tests" rather than as failures. It passed locally on Node 26 every
time.

**`nvm use` does not work in every shell here.** It will print `Now using node v22.x` and change
nothing — `node -v` still reports the original version, because the surrounding environment
overrides `PATH`. Always confirm, and if it lied, invoke the binary by absolute path:

```bash
node -v                                            # confirm; do not trust `nvm use`
~/.nvm/versions/node/v22.17.0/bin/node \
  node_modules/vitest/vitest.mjs run <files>       # reproduce CI's Node reliably
```

Use `check:full`, not `check`, for **any change to route authorization** — who may reach a route,
which gate a page calls, what a denied caller receives. The unit suites cover the pure decision
helpers, not the wiring, so deleting a gate leaves them green; only Playwright sees it.

### Running the E2E suite

The suite needs a real local Supabase stack and **refuses to start without one**. If the required
variables are missing it fails at config load — before the web server spawns — naming each variable
and why it is needed. It does not skip.

```bash
eval "$(supabase status -o env)"     # add --workdir … for a scratch stack
export NEXT_PUBLIC_SUPABASE_URL="$API_URL" \
       NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY" \
       SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
       E2E_MAILPIT_URL="$INBUCKET_URL" \
       E2E_DATABASE_URL="$DB_URL"
npm run test:e2e
```

`E2E_DATABASE_URL` is the local Postgres, used through `psql` for the two fixtures no API role can
reach. `e2e/seo-operations.spec.ts` writes one: an outbox row that has already failed four times.
`e2e/bundles-and-gifts.spec.ts` reads the other: a gift's delivery row, because `public.gifts` is
revoked from every API role including `service_role`, so there is no Data API path from an order to
its gift. `e2e/reader-voice.spec.ts` also uses held SQL transactions to test concurrent linking and
publication. Both SQL helpers refuse non-loopback hosts. `psql` must be on the `PATH` (it is on
GitHub's Ubuntu runners).

Expect **90 tests across 24 spec files in the `chromium` project and 4 tests across 2 spec files in
`chromium-manual`, none skipped** after S13 - 94 in 26 files for a bare `npm run test:e2e`. The 13
pixel cases in `reader-depth-visual.spec.ts` are deliberately absent from ordinary discovery and run
only through the pinned command below. If any count changes, say so rather than accepting it.

(The figure here read "66 ordinary tests across 18 spec files" before S9. That was already two tests
and one file behind the tree when S9 began, measured at 68 in 19 for `chromium`; it is restated
above from `npx playwright test --project=<name> --list` rather than carried forward. S11 adds
`recommendations.spec.ts`, which is the single test the `chromium` figure gained. Measured the same
way before S12, the tree held 80 in 21 for `chromium`, so the S11 figure of 71 was already nine
behind the tree it described. S12 adds `knowledge-hub.spec.ts` and its three journeys, which brought `chromium` to 83 in 22. S14
adds `paperback-upsell.spec.ts` and its two journeys, measured the same way: 85 in 23. S13 adds
`reader-voice.spec.ts` with two journeys and three concurrency regressions: 90 in 24.)

> **Export those variables into the shell, not just into `.env.local` — and do it before any build.**
> `NEXT_PUBLIC_*` values are **inlined at build time**, not read at runtime. A production build made
> without them in the environment produces a client bundle where `NEXT_PUBLIC_SUPABASE_URL` is
> `undefined` in the browser, so `createClient()` throws and the failure surfaces as a generic
> "Something went wrong" in the UI — it looks exactly like an application bug.
>
> This was diagnosed the hard way: the repository's own unmodified golden-path spec failed at the
> same step, which is what proved the cause environmental rather than a code defect. The command
> above is safe because it exports before running, and Playwright's `webServer` passes the values
> through to the build it spawns. **A manual `npm run build && npm run start` is where this bites.**
> CI never hits it, because the workflow writes the credentials into `$GITHUB_ENV` before the build
> step.

> **Historical note worth knowing, because it shaped the design.** This suite used to run **7 of 20
> specs and exit 0**: `webServer.env` reaches the spawned server but never the test runner, so the
> admin and mailpit specs skipped themselves while the command reported success. CI never noticed,
> because it writes credentials into `$GITHUB_ENV` before invoking Playwright. That is why the gate
> now *fails* rather than skipping, and why the fake credential defaults were removed — they let a
> server start connected to nothing a fixture could see.

> **Kill any leftover server on port 3000 first.** `playwright.config.ts` sets
> `reuseExistingServer: !process.env.CI`, so if anything is already listening on 3000 the suite
> **attaches to it instead of building your tree**. Your changes are then absent from the run and
> the result is meaningless in whichever direction happens to be convenient — this cost a real
> false pass here, where a reviewer's first run silently tested a previous session's server. CI is
> unaffected, since `reuseExistingServer` is false there.
>
> ```bash
> lsof -ti :3000 | xargs -r kill      # before an E2E run, and after one
> ```

**Browsers.** `playwright.config.ts` pins `workers: 1` — the fixtures create users, grant admin
roles, publish books and move an active-publication pointer against one shared stack with no
teardown, and `fullyParallel: false` alone does not prevent interference because workers still run
separate *files* concurrently.

The default project is plain `chromium`, which needs Playwright's own browser download
(`npx playwright install chromium`). **Nothing in this repository installs a browser as a side
effect** — CI works because its workflow runs that command explicitly. On a machine where the
download is blocked, use the scratch config, which targets the installed Chrome channel:

```bash
npx playwright test --config=.superpowers/scratch/playwright.scratch.config.ts --workers=1
```

Firefox and WebKit exist as projects but only when `E2E_BROWSER_MATRIX=all`, which is set on
main-branch and nightly CI and never on a pull request. The reader-depth Gate 6 commands are:

```bash
E2E_BROWSER_MATRIX=all npm run test:e2e -- \
  e2e/ebook-golden-path.spec.ts e2e/reader-depth.spec.ts
bash scripts/run-reader-visual-container.sh
```

Run them with one worker against an owned local stack. The functional command is the automated
Chromium/Firefox/WebKit matrix. WebKit emulation is not physical Safari evidence, and no desktop
emulation substitutes for mobile Chrome or mobile Safari; record those owner-run checks in
`docs/runbooks/reader-corpus-matrix.md`.

The matrix keeps WebKit's reader journeys but does not treat its local linked publisher-CSS result
as fidelity evidence: blob-frame stylesheet requests omit the auth cookies on the HTTP harness.
Chromium and Firefox retain the computed publisher-CSS assertion. Physical Safari and private-EPUB
fidelity remain owner-run gates in the corpus matrix.

The visual command is intentionally separate. It always runs Chromium from the exact Playwright
1.63.0 Ubuntu Noble **amd64** image digest used by CI, asserts `x86_64`, Chromium 153.0.8010.12,
Node 22.23.2, and the image's serif/sans-serif font family, then compares the 13 committed PNGs.
There is no arm64 baseline/update path. On Apple Silicon, use an amd64-capable runtime such as
OrbStack/Rosetta; Docker Desktop's QEMU path is known to crash this Chromium build.
The app, fixture processor, and Playwright test process remain native; only the browser renderer is
remote. This avoids executing the EPUB worker's native dependencies through QEMU on ARM machines.
Use `--update-snapshots` only for an intentional, reviewed visual change:

```bash
bash scripts/run-reader-visual-container.sh --update-snapshots
bash scripts/run-reader-visual-container.sh
```

### Email and the operations worker in tests

Local and test runs never call Resend. Use the no-network mail adapter and a throwaway worker
secret:

```bash
EMAIL_PROVIDER=test                  # allowed only when APP_ENV is local or test
EMAIL_FROM="Infinity Books <books@example.test>"
OPS_WORKER_SECRET=<any 32+ characters that are not the production value>
```

`playwright.config.ts` gives the web server it starts these values from
`e2e/support/server-env.ts` - the shell's value when one is exported (CI exports its own
`EMAIL_PROVIDER` and `OPS_WORKER_SECRET`), otherwise the default there. Specs read the worker
secret through the same module, so they always present the value the server holds. The test adapter "accepts" every message and
returns `test/<idempotency-key>` as the provider message ID, so a sent book-ready row reads
`provider_message_id = 'test/book-ready/<outbox-id>'`. Without `EMAIL_FROM` the worker skips outbox
delivery, and without `OPS_WORKER_SECRET` it answers every request with `503`. Never put the
production worker secret or a real Resend key in `.env.local`.

### Reset before you trust a database failure

Two different kinds of stale state produce failures that have nothing to do with your change, and
both have caught people here. **If a database test fails in a way you cannot explain, reset first
and re-run before you debug it.**

```bash
supabase db reset --workdir .superpowers/scratch/sbworkdir   # or without --workdir on a default stack
```

**Stale rows from earlier runs.** The pgTAP suite writes fixture rows, and a stack used for several
runs can accumulate state that later assertions trip over. Observed concretely: `002`, `004` and
`006` failed purely on leftover rows and passed at the full count immediately after a reset, with
nothing in the repository changed.

**Running the E2E suite is one of the ways this happens.** Playwright's fixtures write real rows,
and they are not torn down. A later pgTAP run then fails in a way that looks like a schema or logic
problem: one occurrence had `010` counting eight `reading_progress` rows where it expected one,
along with `002`, `004` and `006` failing, entirely because of an earlier Playwright run. **If you
have run the E2E suite against a stack, reset it before running pgTAP against the same stack.**

> **A trap that fails silently, in the reassuring direction.** `supabase test db --workdir X` runs
> the tests in **`X/supabase/tests`**, not the repository's. If that workdir holds *copies* rather
> than symlinks, you are testing stale SQL — and the failure mode is that mutations you expect to
> break tests quietly pass. This happened here: three guard mutations all "passed" against a stale
> copy of a suite that had not yet gained the tests meant to catch them.
>
> Before trusting any pgTAP result from a scratch workdir, check whether its `supabase/tests` is a
> symlink to the repository or a copy, and refresh it if it is a copy.

**A migration that was edited after you applied it.** Migrations here are still amended in place
while the branch is unmerged. **Supabase does not re-run a migration whose version it has already
recorded**, so a stack that applied the earlier version keeps the old function bodies and behaves
differently from a fresh one, with no warning. If observed behaviour disagrees with the migration
file you are reading, this is why.

Both apply to local and scratch stacks only. The hosted project has never had any migration applied
to it, so it cannot be in either state — and `db reset` must never be run against it.

### The `server-only` trap in the EPUB CLI

`npm run ebook -- …` runs under bare `tsx`, which does **not** set the `react-server` export
condition. Anything importing `server-only` throws there, so the CLI must never reach
`lib/supabase/admin.ts`, `lib/supabase/server.ts`, or `lib/epub/upload.ts`. It builds its own client
instead. Full explanation in `docs/runbooks/epub-processing.md` under *"Why not
`lib/supabase/admin.ts`?"* — read that before changing anything in that import chain.
`vitest.config.ts` stubs `server-only`, which is why this only ever surfaces when running the CLI.

---

## Environment 2 — local app, cloud Supabase

For reproducing something that depends on real data. Point `.env.local` at the hosted project:

- `NEXT_PUBLIC_SUPABASE_URL` — the hosted HTTPS URL (Supabase Connect panel)
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SERVICE_ROLE_KEY` — from the same panel
- `APP_ENV=local` still, since the app is still running locally
- URLs must be HTTPS; plain HTTP is accepted only for `localhost`, `127.0.0.1`, and `[::1]`

### Rules, in order of how badly they end

**Never run `npm run test:e2e` in this configuration.** The fixtures create confirmed users and
grant the `admin` role, **with no teardown**. Against the shared cloud database that means real
admin accounts in the only production database there is.

**Never run `supabase db reset` or `supabase test db` against the cloud project.** Both are
destructive: `db reset` rebuilds from migrations, and the pgTAP suite writes fixture rows.

**Do not run the EPUB CLI's `process`/`retry` commands** here unless you intend to mutate real jobs
and storage objects.

What this environment is genuinely good for: browsing the running app against real rows, checking a
query plan, and confirming a bug reproduces with production data shapes.

---

## Environment 3 — Vercel production, the same cloud Supabase

Smoke verification only. There is no separate production database to practise on.

### Applying migrations to the hosted project — the first run is unrehearsed

**No migration in this repository has ever been applied to the hosted project.** Treat the first
`db push` as a rehearsal that happens to be live, and do it deliberately.

```bash
supabase link --project-ref <ref>     # ref is in your .env.local's Supabase URL
supabase migration list               # compare local vs remote before doing anything
supabase db push                      # applies pending migrations
supabase migration list               # confirm the remote list now matches
```

- **Take a backup or confirm point-in-time recovery is enabled before the first push.** There are no
  down-migrations here: backing out means restoring, or writing a compensating migration.
- Run `migration list` **before** and after. The before-run is what tells you whether the remote is
  where you think it is.
- **Never `supabase db reset` against a linked production project.** Same command name as the local
  one; it will destroy the database.
- Push from a clean checkout of the branch you intend to ship, not from a worktree with uncommitted
  migrations.

### Configuration that must be right before anything works

- `APP_ENV=production`.
- `PAYMENT_PROVIDER` must **not** be `simulator`. Production fails closed at boot on that
  combination, and the simulator additionally refuses to construct outside `local`/`staging`/`test`.
- Never expose `SUPABASE_SERVICE_ROLE_KEY` — or any server secret — through a `NEXT_PUBLIC_*`
  variable.
- Supabase Auth, per hosted project: set Site URL to the environment's `SITE_URL`, add
  `https://your-domain/auth/callback**` as a redirect URL, and copy the templates from
  `supabase/templates` into the Magic Link, Confirm signup, and Reset password templates. Those
  templates send token-hash links that work across devices; the default PKCE links only work in the
  browser that requested them.
- `commerce_settings.payments_enabled` must stay `false` on the cloud project. It is the database half of
  the payments gate, and the cloud database is production's database.
- Local and CI runs with `PAYMENT_PROVIDER=simulator` also need `PAYMENT_SIMULATOR_SECRET` (at least 32
  characters). `playwright.config.ts` supplies a test default; `.env.local` needs its own value.

### Build note

The production build uses **webpack** (`next build --webpack`). Turbopack cannot bind its CSS worker
port in the managed development environment used for this repository.

---

## CI

`.github/workflows/ci.yml` triggers on pull requests, pushes to `main`, and a **nightly schedule**
(`0 3 * * *`). Four jobs:

| Job | Runs on | Covers |
| --- | --- | --- |
| `web` | every trigger | lint, typecheck, unit tests, production build |
| `database` | every trigger | `supabase db reset`, then pgTAP |
| `e2e` | every trigger | the full Playwright suite, Chromium only |
| `e2e-browser-matrix` | pushes to `main` and the nightly schedule — **never a pull request** | the golden-path and reader-depth specs, in Chromium, Firefox and WebKit |

The matrix job is deliberately scoped to `e2e/ebook-golden-path.spec.ts` and
`e2e/reader-depth.spec.ts` rather than the whole suite: it exists to answer whether protected
reading and reader-depth interactions work in these engines, not to re-run unrelated authorization
journeys. It remains off pull requests to keep that slower cross-engine gate on main/nightly.

Note the nightly schedule only begins firing once this workflow is on the default branch; GitHub
runs scheduled workflows from `main`.

Two things to know:

- **It has never executed.** The workflow exists only on this unpushed branch, so the pull request
  that ships this work will be the repository's first-ever CI run.
- **The `web` job builds with no Supabase credentials**, which is intentional and was verified: every
  page route is dynamic, so the build does not need them. `/sitemap.xml` and `/robots.txt` are the
  exception: they are cached routes (`revalidate = 300`) that a build with a server environment
  prerenders. Without one, `deferPrerenderWithoutServerEnv()` (`lib/config/build-environment.ts`)
  makes them render per request instead of failing the build. So the `web` job never exercises
  their prerender-and-revalidate path; only a build that has the environment does - the `e2e` job's
  build, a local build with the variables exported, and every Vercel deployment.

Known risks on that first run: `webServer.timeout` is 180s and must cover a cold
`npm run build && npm run start` on a two-core runner (~35–40s on the development machine — plausible
but untested), and the `e2e-browser-matrix` job has never run anywhere, though it is gated off pull
requests and so cannot block a merge.

---

## Validating a real book

This handbook covers the **environments**. For validating one book end to end with the private
corpus — upload, CLI processing, failure inspection, preview, publish, granting access, sample
denial, progress restore, and capturing evidence — see
**`docs/runbooks/golden-path-validation.md`**. That runbook owns the procedure; this one owns the
environment it runs in.

---

## Other runbooks with local test procedures

Each of these owns the procedure for its own area and defers to this handbook for the environment
it runs in. None relaxes a rule above.

- **`docs/runbooks/golden-path-validation.md`** - one real book, end to end (section above).
- **`docs/runbooks/knowledge-hub.md`** - ideas and articles: writing, relating, publishing, and the
  local-only commands for the S12 pgTAP, unit, and `e2e/knowledge-hub.spec.ts` suites.

---

## Known gaps to close before go-live

Not testing instructions — things a tester will notice and should not file twice.

- **An EPUB containing any SVG image is rejected outright.** The processor's supported profile
  excludes `image/svg+xml`, and a single SVG manifest item fails the whole book — including the SVG
  cover wrappers many real EPUBs use. This is a processor-profile limit, not a reader or storage
  problem, and it is the most likely reason a book that "should work" does not. When evaluating a
  set of real books, **record which contain SVG before interpreting any failure**, or a profile
  rejection will be misread as an engine failure.
- **There is no public catalog.** No book listing or detail page exists — only a marketing page. The
  RLS policies that would expose published books to anonymous visitors are correct and tested, but
  nothing renders them. "Published" currently means visible to an anonymous SQL client, not to a
  reader.
- **S1 provides public covers in the `covers` bucket.** Source EPUBs and derived resources remain
  private. The catalog admin can upload and replace covers; public catalog pages still belong to S2.
- **The generated database types enforce nothing for application code.** Neither `createClient()` nor
  `createAdminClient()` is parameterized with the `Database` generic, so `.rpc()` accepts any string
  and `.from(...).select(...)` is unchecked. Only the EPUB CLI's client is typed. A schema change
  that breaks a query will not fail `typecheck`.
- **No reaper or rate limit for `reader_sessions` rows.**
- **The reader engine decision is provisional.** ADR-005 selects Readium on automated generated-
  fixture evidence; the five-private-EPUB × five-browser/device matrix has not been run. Automated
  Chromium, Firefox, and WebKit results do not substitute for private-corpus fidelity or physical
  desktop/mobile Safari and mobile Chrome checks.
- **S1 provides complimentary grant/revoke screens under `/admin/users`.** Free acquisition and
  simulated payments still have no customer checkout UI. The reader golden-path test grants via
  the authenticated admin RPC; `admin-users.spec.ts` verifies granting and revoking through the UI.
- **`library_items.state` is now written and read by nothing.** The library card derives its state
  from reading progress instead, so the column is inert; dropping it is a schema decision left for
  whoever next touches that table.
- **The manual-provider project holds two specs, not one.** `chromium-manual` is the only project
  pointed at the `PAYMENT_PROVIDER=manual` web server on port 3100, and
  `playwright.config.ts`'s `manualSpecs` list is what admits a file to it and excludes it from every
  other project. S9 added `e2e/bundle-purchase.spec.ts` beside `e2e/manual-payment.spec.ts`, because
  the bundle golden path ends at an admin confirming a bank transfer. A new spec whose journey needs
  that provider must be added to that list; a spec left off it runs against the simulator server.
- **The SePay project is a third web server.** `chromium-sepay` is the only project pointed at the
  `PAYMENT_PROVIDER=sepay` server on port 3200 (override with `E2E_SEPAY_SERVER_URL` when another
  dev server holds it), and `playwright.config.ts`'s `sepaySpecs` list admits a file to it. It starts
  with sandbox credentials from `e2e/support/server-env.ts` and never contacts SePay: the spec
  intercepts the browser's POST and posts the notification itself.
- **CI has two risks on its first run**, which will be the pull request that ships this work.
  `webServer.timeout` is 180s and must cover a cold `npm run build && npm run start` on a two-core
  runner (~35–40s here, so the margin is plausible but untested), and the `e2e-browser-matrix` job
  has never executed anywhere — it is correctly gated off pull requests, so it cannot block a merge,
  but its first run will be unattended.
