# Ebook MVP Platform Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the production-shaped Next.js, Supabase, authentication, locale, schema, RLS, admin-shell, and CI baseline required by the one-book ebook golden path.

**Architecture:** Keep the existing root Next.js application and add locale-prefixed route groups, a server-only data-access layer, and reviewed Supabase migrations. Proxy performs session refresh and optimistic redirects only; authorization is repeated in the DAL, Server Actions, Route Handlers, and RLS policies.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 6, Supabase Auth/Postgres/Storage/RLS, Tailwind CSS 4, shadcn/ui, Zod, Vitest, Playwright, Supabase CLI

**Spec:** `docs/superpowers/specs/2026-09-11-mvp-foundation-and-spikes-design.md`

## Global Constraints

- MVP is ebook-only; do not create physical inventory, shipping, fulfillment, COD, logistics, or PDF-reader code.
- Use npm and preserve the existing root application structure.
- Read the relevant guide under `node_modules/next/dist/docs/` immediately before changing a Next.js API.
- Keep Server Components as the default; use Client Components only for browser interaction.
- Treat Proxy checks as optimistic only; secure authorization belongs near the data source.
- Never expose the Supabase service-role key or any server secret through `NEXT_PUBLIC_*`.
- Keep UI locale, book language, market, and currency independent.
- The primary customer authentication flow is email magic link; password remains an internal fallback only.
- The payment simulator is local/staging-only and production must fail closed if it is enabled.
- Add database changes only through migrations and include RLS tests with negative cross-user cases.
- Preserve the user's untracked `docs/ref/` files and never stage them with this work.

---

### Task 1: Add repeatable quality gates and local Supabase scaffolding

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `supabase/config.toml`
- Create: `playwright.config.ts`
- Create: `e2e/public-home.spec.ts`
- Create: `.github/workflows/ci.yml`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Existing `lint`, `typecheck`, `test`, and `build` npm scripts.
- Produces: `test:unit`, `test:e2e`, `db:reset`, `db:test`, and `check` commands used by every later task.

- [ ] **Step 1: Install validation and browser-test dependencies**

Run:

```bash
npm install zod server-only
npm install -D @playwright/test
```

Expected: `package.json` and `package-lock.json` record stable compatible releases.

- [ ] **Step 2: Initialize local Supabase without importing the reference schema**

Run:

```bash
supabase init
```

Expected: `supabase/config.toml` exists and no migration has been created from `docs/ref/202609100001_infinitybooks_complete_schema.sql`.

- [ ] **Step 3: Add deterministic npm scripts**

Modify `package.json` scripts to include:

```json
{
  "test": "vitest run --passWithNoTests",
  "test:unit": "vitest run",
  "test:e2e": "playwright test",
  "db:reset": "supabase db reset",
  "db:test": "supabase test db",
  "check": "npm run lint && npm run typecheck && npm run test:unit && npm run build"
}
```

- [ ] **Step 4: Configure Playwright against the production build**

Create `playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: "http://127.0.0.1:3000", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npm run build && npm run start",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
```

- [ ] **Step 5: Write the initial public smoke test**

Create `e2e/public-home.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("renders the current public home page", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});
```

- [ ] **Step 6: Run the initial E2E test**

Run: `npm run test:e2e -- e2e/public-home.spec.ts`

Expected: PASS against the existing public home page.

- [ ] **Step 7: Add CI jobs**

Create `.github/workflows/ci.yml` with two jobs:

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]

jobs:
  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test:unit
      - run: npm run build

  database:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - run: supabase start
      - run: supabase db reset
      - run: supabase test db
```

Do not add Playwright to CI until the authenticated golden-path fixture exists in the second plan.

- [ ] **Step 8: Run current non-E2E gates**

Run:

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run build
```

Expected: all four commands pass.

- [ ] **Step 9: Commit the quality baseline**

```bash
git add package.json package-lock.json supabase/config.toml playwright.config.ts e2e/public-home.spec.ts .github/workflows/ci.yml .gitignore
git commit -m "chore: add MVP quality gates"
```

### Task 2: Validate server configuration and isolate privileged Supabase access

**Files:**
- Modify: `.env.example`
- Create: `lib/config/server-env-schema.ts`
- Create: `lib/config/server-env.ts`
- Create: `lib/config/server-env.test.ts`
- Create: `lib/supabase/admin.ts`

**Interfaces:**
- Consumes: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_ENV`, `PAYMENT_PROVIDER`, `READER_SESSION_TTL_SECONDS`.
- Produces: pure `parseServerEnv(values): ServerEnv`, server-only `getServerEnv(): ServerEnv`, and `createAdminClient(): SupabaseClient`.

- [ ] **Step 1: Write environment validation tests**

Create `lib/config/server-env.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseServerEnv } from "@/lib/config/server-env-schema";

const base = {
  APP_ENV: "staging",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
  PAYMENT_PROVIDER: "simulator",
  READER_SESSION_TTL_SECONDS: "900",
};

describe("parseServerEnv", () => {
  it("accepts the simulator outside production", () => {
    expect(parseServerEnv(base).paymentProvider).toBe("simulator");
  });

  it("rejects the simulator in production", () => {
    expect(() => parseServerEnv({ ...base, APP_ENV: "production" })).toThrow(
      "Payment simulator cannot run in production",
    );
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- lib/config/server-env.test.ts`

Expected: FAIL because `lib/config/server-env.ts` does not exist.

- [ ] **Step 3: Implement fail-closed server configuration**

Create `lib/config/server-env-schema.ts`:

```ts
import { z } from "zod";

const schema = z.object({
  APP_ENV: z.enum(["local", "preview", "staging", "production", "test"]),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  PAYMENT_PROVIDER: z.enum(["disabled", "simulator"]),
  READER_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(3600),
});

export type ServerEnv = ReturnType<typeof parseServerEnv>;

export function parseServerEnv(values: Record<string, string | undefined>) {
  const parsed = schema.parse(values);
  if (parsed.APP_ENV === "production" && parsed.PAYMENT_PROVIDER === "simulator") {
    throw new Error("Payment simulator cannot run in production");
  }
  return {
    appEnv: parsed.APP_ENV,
    supabaseUrl: parsed.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey: parsed.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    serviceRoleKey: parsed.SUPABASE_SERVICE_ROLE_KEY,
    paymentProvider: parsed.PAYMENT_PROVIDER,
    readerSessionTtlSeconds: parsed.READER_SESSION_TTL_SECONDS,
  } as const;
}
```

Create `lib/config/server-env.ts`:

```ts
import "server-only";
import { parseServerEnv } from "@/lib/config/server-env-schema";

export function getServerEnv() {
  return parseServerEnv(process.env);
}
```

- [ ] **Step 4: Create a server-only privileged client**

Create `lib/supabase/admin.ts`:

```ts
import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getServerEnv } from "@/lib/config/server-env";

export function createAdminClient() {
  const env = getServerEnv();
  return createSupabaseClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
```

- [ ] **Step 5: Document all configuration without real secrets**

Append to `.env.example`:

```dotenv
APP_ENV=local
SUPABASE_SERVICE_ROLE_KEY=your-server-only-service-role-key
PAYMENT_PROVIDER=simulator
READER_SESSION_TTL_SECONDS=900
```

- [ ] **Step 6: Run focused and static verification**

Run:

```bash
npm test -- lib/config/server-env.test.ts
npm run lint
npm run typecheck
```

Expected: all commands pass.

- [ ] **Step 7: Commit server configuration**

```bash
git add .env.example lib/config/server-env-schema.ts lib/config/server-env.ts lib/config/server-env.test.ts lib/supabase/admin.ts
git commit -m "feat: add fail-closed server configuration"
```

### Task 3: Introduce locale-prefixed routes without coupling market or currency

**Files:**
- Create: `lib/i18n/config.ts`
- Create: `lib/i18n/config.test.ts`
- Create: `lib/i18n/dictionaries/vi.json`
- Create: `lib/i18n/dictionaries/en.json`
- Create: `lib/i18n/dictionary.ts`
- Modify: `app/page.tsx`
- Create: `app/[locale]/layout.tsx`
- Create: `app/[locale]/(public)/page.tsx`
- Create: `app/[locale]/(auth)/sign-in/page.tsx`
- Create: `app/[locale]/(account)/account/page.tsx`
- Modify: `proxy.ts`
- Modify: `lib/supabase/proxy.ts`
- Delete after migration: `app/sign-in/page.tsx`
- Delete after migration: `app/account/page.tsx`

**Interfaces:**
- Consumes: Current home, sign-in, account UI, and Supabase session refresh.
- Produces: `Locale = "vi" | "en"`, `isLocale(value)`, `withLocale(locale, path)`, and locale-prefixed public/auth/account routes.

- [ ] **Step 1: Write locale helper tests**

Create `lib/i18n/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isLocale, withLocale } from "@/lib/i18n/config";

describe("locale routing", () => {
  it("accepts only supported locales", () => {
    expect(isLocale("vi")).toBe(true);
    expect(isLocale("ja")).toBe(false);
  });

  it("prefixes an application path", () => {
    expect(withLocale("vi", "/account")).toBe("/vi/account");
  });
});
```

- [ ] **Step 2: Run the locale tests and verify they fail**

Run: `npm test -- lib/i18n/config.test.ts`

Expected: FAIL because the locale module does not exist.

- [ ] **Step 3: Implement locale configuration**

Create `lib/i18n/config.ts`:

```ts
export const locales = ["vi", "en"] as const;
export const defaultLocale = "vi" as const;
export type Locale = (typeof locales)[number];

export function isLocale(value: string): value is Locale {
  return locales.some((locale) => locale === value);
}

export function withLocale(locale: Locale, path: `/${string}`) {
  return `/${locale}${path === "/" ? "" : path}`;
}
```

Create `lib/i18n/dictionary.ts` with explicit dynamic imports and an `isLocale` guard. Add small Vietnamese and English dictionaries for navigation and authentication labels.

- [ ] **Step 4: Move UI routes under `[locale]` and redirect the root**

Change `app/page.tsx` to:

```ts
import { redirect } from "next/navigation";
import { defaultLocale } from "@/lib/i18n/config";

export default function RootPage() {
  redirect(`/${defaultLocale}`);
}
```

Move the current home, sign-in, and account page content to the paths listed above. In every dynamic page/layout, await `params` as required by Next.js 16 and call `notFound()` for unsupported locales.

- [ ] **Step 5: Keep Proxy optimistic and locale-aware**

Update `lib/supabase/proxy.ts` so it extracts the first path segment, redirects authenticated users away from `/{locale}/sign-in`, and redirects unauthenticated users from `/{locale}/account`, `/{locale}/library`, `/{locale}/read/*`, and `/admin/*`. Preserve the original localized path in the `next` parameter. Do not add database role queries to Proxy.

- [ ] **Step 6: Run locale, auth-regression, and E2E tests**

First change `e2e/public-home.spec.ts` to expect `/` to redirect to `/vi`:

```ts
test("redirects the root URL to the Vietnamese home page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/vi$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});
```

Run:

```bash
npm test -- lib/i18n/config.test.ts lib/auth/redirect.test.ts
npm run test:e2e -- e2e/public-home.spec.ts
npm run lint
npm run typecheck
```

Expected: all commands pass and `/` redirects to `/vi`.

- [ ] **Step 7: Commit localized routing**

```bash
git add app lib/i18n lib/supabase/proxy.ts proxy.ts e2e/public-home.spec.ts
git commit -m "feat: add locale-prefixed application routes"
```

### Task 4: Make email magic link the primary customer authentication flow

**Files:**
- Create: `lib/auth/magic-link.ts`
- Create: `lib/auth/magic-link.test.ts`
- Modify: `app/auth/actions.ts`
- Modify: `app/auth/callback/route.ts`
- Modify: `app/[locale]/(auth)/sign-in/page.tsx`
- Modify: `components/auth/auth-card.tsx`
- Modify: `components/auth/auth-message.tsx`

**Interfaces:**
- Consumes: Supabase SSR server client and safe redirect logic.
- Produces: `requestMagicLink(formData): Promise<never>` and localized callback redirects.

- [ ] **Step 1: Write tests for redirect construction**

Create `lib/auth/magic-link.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getMagicLinkRedirect } from "@/lib/auth/magic-link";

describe("getMagicLinkRedirect", () => {
  it("keeps a safe localized destination", () => {
    expect(getMagicLinkRedirect("https://books.test", "/vi/library")).toBe(
      "https://books.test/auth/callback?next=%2Fvi%2Flibrary",
    );
  });

  it("rejects an external destination", () => {
    expect(getMagicLinkRedirect("https://books.test", "https://evil.test")).toBe(
      "https://books.test/auth/callback?next=%2Fvi%2Flibrary",
    );
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- lib/auth/magic-link.test.ts`

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement the redirect helper and action**

Implement `getMagicLinkRedirect(origin, next)` using `getSafeRedirect`, but require the safe result to begin with `/vi/` or `/en/`; otherwise use `/vi/library`.

Add this action to `app/auth/actions.ts`:

```ts
export async function requestMagicLink(formData: FormData) {
  const email = readEmail(formData);
  if (!email.ok) redirect("/vi/sign-in?error=email");

  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin") ?? "http://localhost:3000";
  const next = String(formData.get("next") ?? "/vi/library");
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: email.data.email,
    options: { emailRedirectTo: getMagicLinkRedirect(origin, next) },
  });
  if (error) redirect("/vi/sign-in?error=magic-link");
  redirect("/vi/sign-in?message=check-email");
}
```

Keep the current password actions callable only from an internal fallback page; remove password and sign-up calls to action from the public header.

- [ ] **Step 4: Make the callback locale-safe**

Continue using `exchangeCodeForSession(code)` in `app/auth/callback/route.ts`. Validate `next` through the localized safe-redirect helper before constructing the redirect URL.

- [ ] **Step 5: Update the public sign-in UI**

Render one email field, a hidden localized `next`, and a submit button labeled for magic-link delivery. Show a generic success response that does not disclose whether the email already exists.

- [ ] **Step 6: Run auth tests and static checks**

Run:

```bash
npm test -- lib/auth/validation.test.ts lib/auth/redirect.test.ts lib/auth/magic-link.test.ts
npm run lint
npm run typecheck
npm run build
```

Expected: all commands pass.

- [ ] **Step 7: Commit magic-link authentication**

```bash
git add app/auth app/[locale] components/auth components/site-header.tsx lib/auth
git commit -m "feat: make magic link the primary sign-in flow"
```

### Task 5: Create the normalized ebook MVP catalog and publishing schema

**Files:**
- Create: `supabase/migrations/20260911090000_mvp_catalog_publishing.sql`
- Create: `supabase/tests/001_catalog_publishing.sql`
- Create generated: `lib/supabase/database.types.ts`

**Interfaces:**
- Consumes: A clean local Supabase database.
- Produces: Catalog and publication records for later repositories and admin actions.

- [ ] **Step 1: Write failing pgTAP assertions for the required schema**

Create `supabase/tests/001_catalog_publishing.sql`:

```sql
begin;
select plan(12);
select has_table('public', 'books');
select has_table('public', 'book_localizations');
select has_table('public', 'editions');
select has_table('public', 'skus');
select has_table('public', 'offers');
select has_table('public', 'ebook_assets');
select has_table('public', 'processing_jobs');
select has_table('public', 'ebook_publications');
select has_table('public', 'ebook_resources');
select has_table('public', 'book_samples');
select col_is_pk('public', 'books', 'id');
select has_index('public', 'book_localizations', 'book_localizations_locale_slug_key');
select * from finish();
rollback;
```

- [ ] **Step 2: Run database tests and verify they fail**

Run:

```bash
supabase start
supabase test db
```

Expected: FAIL because the MVP tables do not exist.

- [ ] **Step 3: Create catalog enums and tables**

In `20260911090000_mvp_catalog_publishing.sql`, enable `pgcrypto`, create status enums, and create these exact relationships:

```sql
create extension if not exists pgcrypto;
create type public.content_status as enum ('draft', 'published', 'archived');
create type public.sku_format as enum ('ebook');
create type public.ebook_asset_status as enum ('uploading', 'queued', 'processing', 'ready_for_preview', 'failed', 'published', 'superseded');
create type public.processing_job_status as enum ('queued', 'processing', 'failed', 'completed');
create type public.publication_status as enum ('ready_for_preview', 'published', 'rejected', 'superseded');

create table public.authors (
  id uuid primary key default gen_random_uuid(),
  canonical_slug text not null unique,
  display_name text not null,
  biography text,
  status public.content_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.books (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  original_language text not null,
  primary_author_id uuid not null references public.authors(id),
  status public.content_status not null default 'draft',
  active_publication_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.book_localizations (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  locale text not null check (locale in ('vi', 'en')),
  slug text not null,
  title text not null,
  subtitle text,
  short_description text,
  description text,
  unique(locale, slug),
  unique(book_id, locale)
);
```

Add the remaining catalog tables with these definitions:

```sql
create table public.topics (
  id uuid primary key default gen_random_uuid(),
  canonical_slug text not null unique,
  name text not null,
  description text,
  status public.content_status not null default 'draft'
);

create table public.book_topics (
  book_id uuid not null references public.books(id) on delete cascade,
  topic_id uuid not null references public.topics(id) on delete cascade,
  primary key (book_id, topic_id)
);

create table public.editions (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  language_code text not null,
  isbn text,
  edition_number integer not null default 1 check (edition_number > 0),
  publication_date date,
  unique(book_id, language_code, edition_number)
);

create table public.skus (
  id uuid primary key default gen_random_uuid(),
  edition_id uuid not null references public.editions(id) on delete cascade,
  sku_code text not null unique,
  format public.sku_format not null default 'ebook',
  active boolean not null default true
);

create table public.offers (
  id uuid primary key default gen_random_uuid(),
  sku_id uuid not null references public.skus(id) on delete cascade,
  market_code text not null check (market_code ~ '^[A-Z]{2}$'),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  price_minor bigint not null check (price_minor >= 0),
  active boolean not null default true,
  starts_at timestamptz,
  ends_at timestamptz,
  unique(sku_id, market_code, currency)
);

create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  owner_type text not null check (owner_type in ('book', 'author')),
  owner_id uuid not null,
  kind text not null check (kind in ('cover', 'author_image')),
  storage_key text not null unique,
  alt_text text not null,
  width integer check (width > 0),
  height integer check (height > 0),
  created_at timestamptz not null default now()
);
```

- [ ] **Step 4: Create versioned publishing tables**

Add `ebook_assets`, `processing_jobs`, `ebook_publications`, `ebook_resources`, and `book_samples` with immutable version identity, job leases, error details, and explicit sample membership. Use these exact key fields and constraints:

```sql
create table public.ebook_assets (
  id uuid primary key default gen_random_uuid(),
  edition_id uuid not null references public.editions(id) on delete cascade,
  source_storage_key text not null unique,
  source_checksum text,
  version integer not null check (version > 0),
  status public.ebook_asset_status not null default 'uploading',
  created_at timestamptz not null default now(),
  unique(edition_id, version)
);

create table public.ebook_publications (
  id uuid primary key default gen_random_uuid(),
  ebook_asset_id uuid not null unique references public.ebook_assets(id),
  version integer not null check (version > 0),
  manifest_key text not null unique,
  toc_json jsonb not null default '[]'::jsonb,
  status public.publication_status not null default 'ready_for_preview',
  processed_at timestamptz not null default now()
);

create table public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references public.ebook_assets(id) on delete cascade,
  status public.processing_job_status not null default 'queued',
  attempt integer not null default 0 check (attempt >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  error_code text,
  error_message text,
  correlation_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.ebook_resources (
  id uuid primary key default gen_random_uuid(),
  publication_id uuid not null references public.ebook_publications(id) on delete cascade,
  href text not null,
  media_type text not null,
  storage_key text not null unique,
  byte_size bigint not null check (byte_size >= 0),
  sha256 text not null,
  access_class text not null check (access_class in ('paid', 'sample')),
  unique(publication_id, href)
);

create table public.book_samples (
  id uuid primary key default gen_random_uuid(),
  publication_id uuid not null unique references public.ebook_publications(id) on delete cascade,
  allowed_hrefs jsonb not null check (jsonb_typeof(allowed_hrefs) = 'array')
);

alter table public.books
  add constraint books_active_publication_fk
  foreign key (active_publication_id) references public.ebook_publications(id)
  deferrable initially deferred;

create unique index ebook_assets_edition_version_key
  on public.ebook_assets(edition_id, version);
create unique index ebook_resources_publication_href_key
  on public.ebook_resources(publication_id, href);
create unique index processing_jobs_active_target_key
  on public.processing_jobs(target_id)
  where status in ('queued', 'processing');
```

- [ ] **Step 5: Enable RLS with public published-read policies only**

Enable RLS on every table. Add anonymous/authenticated `SELECT` policies only for published authors/books/localizations and active offers. Do not grant browser insert/update/delete access to publication or processing tables.

- [ ] **Step 6: Reset, test, and generate TypeScript types**

Run:

```bash
supabase db reset
supabase test db
supabase gen types --local --lang typescript > lib/supabase/database.types.ts
npm run typecheck
```

Expected: 12 pgTAP assertions pass and generated types compile.

- [ ] **Step 7: Commit the catalog schema**

```bash
git add supabase/migrations/20260911090000_mvp_catalog_publishing.sql supabase/tests/001_catalog_publishing.sql lib/supabase/database.types.ts
git commit -m "feat: add ebook catalog and publishing schema"
```

### Task 6: Add identity, access, commerce-test, role, and audit schema

**Files:**
- Create: `supabase/migrations/20260911100000_mvp_access_admin.sql`
- Create: `supabase/tests/002_access_rls.sql`
- Regenerate: `lib/supabase/database.types.ts`

**Interfaces:**
- Consumes: Catalog and publishing schema from Task 5 plus `auth.users`.
- Produces: Profiles, entitlements, library/progress, free/simulated commerce, roles, audit, redirects, and merchandising data.

- [ ] **Step 1: Write cross-user RLS tests first**

Create `supabase/tests/002_access_rls.sql` with fixed test identities and executable JWT setup. Use this fixture pattern before the assertions:

```sql
begin;
select plan(8);
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'a@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'b@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.authors (id, canonical_slug, display_name, status)
values ('20000000-0000-0000-0000-000000000001', 'test-author', 'Test Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values
  ('30000000-0000-0000-0000-000000000001', 'book-a', 'vi', '20000000-0000-0000-0000-000000000001', 'published'),
  ('30000000-0000-0000-0000-000000000002', 'book-b', 'vi', '20000000-0000-0000-0000-000000000001', 'published');
insert into public.editions (id, book_id, language_code)
values
  ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'vi'),
  ('40000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', 'vi');
insert into public.ebook_assets (id, edition_id, source_storage_key, source_checksum, version, status)
values
  ('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'a/source.epub', 'sha-a', 1, 'published'),
  ('50000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 'b/source.epub', 'sha-b', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status)
values
  ('60000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 1, 'a/manifest.json', 'published'),
  ('60000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000002', 1, 'b/manifest.json', 'published');
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor)
select '70000000-0000-0000-0000-000000000001', id, 'completed', 'not_required', 'VN', 'VND', 0
from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000001';
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor)
select '70000000-0000-0000-0000-000000000002', id, 'completed', 'not_required', 'VN', 'VND', 0
from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000002';
insert into public.entitlements (profile_id, book_id, source_type, source_order_id, status)
select id, '30000000-0000-0000-0000-000000000001', 'free_order', '70000000-0000-0000-0000-000000000001', 'active'
from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000001';
insert into public.entitlements (profile_id, book_id, source_type, source_order_id, status)
select id, '30000000-0000-0000-0000-000000000002', 'free_order', '70000000-0000-0000-0000-000000000002', 'active'
from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000002';
insert into public.library_items (profile_id, book_id, entitlement_id)
select e.profile_id, e.book_id, e.id from public.entitlements e;
insert into public.reading_progress (profile_id, publication_id, locator_json, progression, device_id, client_sequence)
select p.id,
  case when p.auth_user_id = '10000000-0000-0000-0000-000000000001' then '60000000-0000-0000-0000-000000000001'::uuid else '60000000-0000-0000-0000-000000000002'::uuid end,
  '{}'::jsonb, 0, 'test-device', 1
from public.profiles p;
insert into public.reader_sessions (profile_id, publication_id, publication_version, expires_at)
select rp.profile_id, rp.publication_id, 1, now() + interval '15 minutes' from public.reading_progress rp;
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
select results_eq('select count(*) from public.profiles', array[1::bigint]);
select results_eq('select count(*) from public.entitlements', array[1::bigint]);
select results_eq('select count(*) from public.library_items', array[1::bigint]);
select results_eq('select count(*) from public.reading_progress', array[1::bigint]);
select results_eq('select count(*) from public.orders', array[1::bigint]);
select results_eq('select count(*) from public.reader_sessions', array[1::bigint]);
select is(public.is_admin(), false, 'reader is not an admin');
select results_eq(
  $$ update public.profiles set display_name = 'intrusion' where auth_user_id = '10000000-0000-0000-0000-000000000002' returning display_name $$,
  array[]::text[]
);
select * from finish();
rollback;
```

- [ ] **Step 2: Run the access test and verify it fails**

Run: `supabase test db supabase/tests/002_access_rls.sql`

Expected: FAIL because the access/admin tables do not exist.

- [ ] **Step 3: Create identity and access tables**

Create `profiles` keyed to `auth.users`, `customer_identities` with normalized unique email, `entitlements`, `library_items`, `reading_progress`, and `reader_sessions`. The migration uses these enums and required fields:

```sql
create type public.entitlement_status as enum ('active', 'revoked');
create type public.entitlement_source as enum ('free_order', 'admin_grant', 'simulated_payment');
create type public.library_state as enum ('unread', 'reading', 'completed');
create type public.order_status as enum ('draft', 'pending', 'completed', 'cancelled');
create type public.payment_status as enum ('not_required', 'pending', 'succeeded', 'failed', 'cancelled');

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  display_name text,
  locale text not null default 'vi' check (locale in ('vi', 'en')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.customer_identities (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles(id) on delete cascade,
  normalized_email text not null,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  status public.order_status not null,
  payment_status public.payment_status not null,
  market_code text not null check (market_code ~ '^[A-Z]{2}$'),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  total_minor bigint not null check (total_minor >= 0),
  created_at timestamptz not null default now()
);

create table public.entitlements (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  book_id uuid not null references public.books(id),
  source_type public.entitlement_source not null,
  source_order_id uuid references public.orders(id),
  actor_profile_id uuid references public.profiles(id),
  reason text,
  status public.entitlement_status not null default 'active',
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table public.library_items (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  book_id uuid not null references public.books(id),
  entitlement_id uuid not null references public.entitlements(id),
  state public.library_state not null default 'unread',
  added_at timestamptz not null default now()
);

create table public.reading_progress (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  publication_id uuid not null references public.ebook_publications(id),
  locator_json jsonb not null,
  progression numeric not null check (progression between 0 and 1),
  device_id text not null,
  client_sequence bigint not null check (client_sequence >= 0),
  updated_at timestamptz not null default now()
);

create table public.reader_sessions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  publication_id uuid not null references public.ebook_publications(id),
  publication_version integer not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
```

Use these core uniqueness rules:

```sql
create unique index customer_identities_email_key
  on public.customer_identities(lower(normalized_email));
create unique index entitlements_active_subject_key
  on public.entitlements(profile_id, book_id)
  where status = 'active';
create unique index library_items_profile_book_key
  on public.library_items(profile_id, book_id);
create unique index reading_progress_profile_publication_key
  on public.reading_progress(profile_id, publication_id);
```

Entitlements record `source_type` as `free_order`, `admin_grant`, or `simulated_payment`, plus nullable source order and admin actor references.

- [ ] **Step 4: Create commerce-test and admin tables**

The `orders` table is created with the access tables above because entitlements reference it. Add `order_items`, `payments`, `payment_events`, `user_roles`, `audit_logs`, `redirects`, and `merchandising_slots` with UUID primary keys, explicit foreign keys, integer minor-unit amounts, timestamps, and these fields:

```sql
create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  sku_id uuid not null references public.skus(id),
  book_id uuid not null references public.books(id),
  title_snapshot text not null,
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  quantity integer not null default 1 check (quantity = 1)
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  provider text not null check (provider in ('disabled', 'simulator')),
  external_payment_id text,
  status public.payment_status not null,
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now()
);

create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id),
  provider text not null,
  provider_event_id text not null,
  payload_hash text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique(provider, provider_event_id)
);

create table public.user_roles (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  role text not null check (role in ('reader', 'admin')),
  granted_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid references public.profiles(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.redirects (
  id uuid primary key default gen_random_uuid(),
  source_path text not null unique check (source_path like '/%'),
  destination_path text not null check (destination_path like '/%'),
  created_at timestamptz not null default now(),
  check (source_path <> destination_path)
);

create table public.merchandising_slots (
  id uuid primary key default gen_random_uuid(),
  slot_key text not null unique,
  book_id uuid references public.books(id),
  position integer not null default 0,
  active boolean not null default true
);
```

Order payment status values are `not_required`, `pending`, `succeeded`, `failed`, and `cancelled`. The only MVP provider values are `disabled` and `simulator`.

- [ ] **Step 5: Add profile bootstrap and authorization helpers**

Create a security-definer trigger that inserts a normalized profile and customer identity after an `auth.users` insert. Create `public.is_admin()` using `auth.uid()` and `user_roles`; set a fixed `search_path` and revoke direct execution where appropriate.

- [ ] **Step 6: Apply RLS policies**

- Profiles, entitlements, library, progress, reader sessions, and orders: users select only rows tied to `auth.uid()`.
- Profiles and progress: users may update only owned rows and allowed fields.
- Admin-facing tables: browser access requires `public.is_admin()`.
- Financial, entitlement, audit, role, and publication transitions: no arbitrary browser mutation policy; use trusted server functions/actions.

- [ ] **Step 7: Run all database tests and regenerate types**

Run:

```bash
supabase db reset
supabase test db
supabase gen types --local --lang typescript > lib/supabase/database.types.ts
npm run typecheck
```

Expected: all catalog and cross-user RLS assertions pass.

- [ ] **Step 8: Commit access and admin schema**

```bash
git add supabase/migrations/20260911100000_mvp_access_admin.sql supabase/tests/002_access_rls.sql lib/supabase/database.types.ts
git commit -m "feat: add ebook access and admin schema"
```

### Task 7: Centralize secure session and admin authorization

**Files:**
- Create: `lib/auth/session.ts`
- Create: `lib/auth/session.test.ts`
- Create: `lib/auth/admin.ts`
- Create: `lib/auth/admin.test.ts`
- Create: `lib/data/profiles.ts`
- Create: `lib/data/admin.ts`

**Interfaces:**
- Consumes: Supabase SSR client and generated database types.
- Produces: `getCurrentProfile()`, `requireUser(locale)`, `requireAdmin()`, and safe DTO repositories.

- [ ] **Step 1: Write session and role decision tests**

Test pure helpers rather than mocking Next.js redirects:

```ts
import { describe, expect, it } from "vitest";
import { decideAccess } from "@/lib/auth/session";

describe("decideAccess", () => {
  it("requires sign-in when no user exists", () => {
    expect(decideAccess(null, "reader")).toBe("sign-in");
  });
  it("forbids a reader from admin access", () => {
    expect(decideAccess({ role: "reader" }, "admin")).toBe("forbidden");
  });
  it("allows an admin", () => {
    expect(decideAccess({ role: "admin" }, "admin")).toBe("allow");
  });
});
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npm test -- lib/auth/session.test.ts lib/auth/admin.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement a server-only DAL**

Use `import "server-only"` and React `cache()` for per-render memoization. `getCurrentProfile()` must call `supabase.auth.getUser()`, then select only `id`, `auth_user_id`, `display_name`, and locale. `requireAdmin()` must query the current user's role at the data boundary and must not trust role data supplied by the client.

Carry-forward from the Tasks 1–4 review: any magic-link customer can currently open `/internal/{locale}/update-password` and set a password. Once `requireAdmin()` exists, call it from that page and from the `updatePassword` action so password access stays an internal fallback.

- [ ] **Step 4: Return DTOs rather than raw rows**

`lib/data/profiles.ts` returns `ProfileDTO`. `lib/data/admin.ts` returns `AdminSummaryDTO`; neither exposes auth metadata, service credentials, audit before/after payloads, or private storage keys unless the caller specifically requires them.

- [ ] **Step 5: Run focused, unit, and static checks**

Run:

```bash
npm test -- lib/auth/session.test.ts lib/auth/admin.test.ts
npm run test:unit
npm run lint
npm run typecheck
```

Expected: all commands pass.

- [ ] **Step 6: Commit the authorization DAL**

```bash
git add lib/auth lib/data
git commit -m "feat: centralize secure application authorization"
```

### Task 8: Add application shells, correlation IDs, and the minimum admin route

**Files:**
- Create: `app/[locale]/(account)/library/page.tsx`
- Create: `app/[locale]/(reader)/read/[bookId]/page.tsx`
- Create: `app/admin/layout.tsx`
- Create: `app/admin/page.tsx`
- Create: `app/admin/books/new/page.tsx`
- Create: `app/forbidden.tsx`
- Create: `components/admin/admin-nav.tsx`
- Create: `components/admin/admin-shell.tsx`
- Create: `lib/observability/request-id.ts`
- Create: `lib/observability/request-id.test.ts`
- Modify: `proxy.ts`
- Modify: `lib/supabase/proxy.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `requireUser()`, `requireAdmin()`, locale helpers, and existing design tokens.
- Produces: Protected route shells and `getRequestId(headers): string` for downstream logs/jobs.

- [ ] **Step 1: Write request-ID tests**

Create `lib/observability/request-id.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveRequestId } from "@/lib/observability/request-id";

describe("resolveRequestId", () => {
  it("preserves a valid inbound identifier", () => {
    expect(resolveRequestId("req_1234567890")).toBe("req_1234567890");
  });
  it("replaces invalid input", () => {
    expect(resolveRequestId("bad value")).toMatch(/^[0-9a-f-]{36}$/);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- lib/observability/request-id.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement request-ID propagation in Proxy**

Create `resolveRequestId(value)` that accepts only `[A-Za-z0-9_-]{8,128}` and otherwise returns `crypto.randomUUID()`. In Proxy, set `x-request-id` on the forwarded request and response. Preserve Supabase session-cookie behavior.

In `lib/supabase/proxy.ts`, set the request header before the first `NextResponse.next({ request })`, as `x-infinity-locale` already is. Set the response header on whichever response is finally returned: `setAll` recreates `response`, and redirects are separate objects.

- [ ] **Step 4: Build protected shells with leaf authorization**

- Library and reader pages call `requireUser(locale)` themselves.
- `app/admin/layout.tsx` renders navigation only; each admin page and every future admin action calls `requireAdmin()` independently.
- The new-book route renders a minimal form shell whose mutation is implemented in the golden-path plan.
- `app/forbidden.tsx` gives a safe route back to the localized home page.

- [ ] **Step 5: Document local services and commands**

Update `README.md` with Supabase start/reset/test commands, environment names, the simulator production prohibition, locale routes, and the fact that EPUB processing is local CLI work in the next plan.

- [ ] **Step 6: Run the full baseline verification**

Run:

```bash
npm run lint
npm run typecheck
npm run test:unit
supabase db reset
supabase test db
npm run build
npm run test:e2e -- e2e/public-home.spec.ts
```

Expected: all commands pass. The authenticated/admin shells may require local fixture users for manual inspection, but their authorization decisions are covered by unit and RLS tests.

- [ ] **Step 7: Commit the platform baseline**

```bash
git add app components/admin lib/observability README.md proxy.ts lib/supabase/proxy.ts
git commit -m "feat: add MVP application and admin shells"
```

## Platform Baseline Completion Gate

Before starting the ebook golden-path plan, verify:

- [ ] `npm run check` passes.
- [ ] `supabase db reset && supabase test db` passes from a clean local database.
- [ ] `/` redirects to `/vi` and `/vi` renders.
- [ ] Email magic-link initiation and callback work against local Supabase.
- [ ] Reader and library routes require authentication.
- [ ] Admin pages and future admin actions use secure DAL checks, not layout-only checks.
- [ ] Production configuration rejects `PAYMENT_PROVIDER=simulator`.
- [ ] No physical-commerce or GCP resources were introduced.
