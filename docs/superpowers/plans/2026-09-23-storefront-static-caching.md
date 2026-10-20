# Storefront Static Caching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the public catalog pages prerendered and CDN-cacheable so Googlebot and customers get them from the edge instead of a full server render per request.

**Architecture:** Five request-time reads currently force every storefront route to render on demand: `headers()` in the root layout, `cookies()` in `SiteHeader`, `searchParams` on the two detail pages that show an action error, the viewer's own ownership state on the book and bundle pages, and the absence of `generateStaticParams` under `[locale]`. Each task removes exactly one of them; the prerender task turns the result on and adds a build guard, and a final task proves what a crawler actually receives. Nothing about authorization changes — every protected page and action keeps its own `requireUser()` / `requireAdmin()` call, and every Server Action and RPC re-checks entitlement as it does today.

**Tech Stack:** Next.js 16.3.4 (App Router, webpack build), React 19, Supabase (`@supabase/ssr`), Vitest + Testing Library, Tailwind.

**Spec:** This document. The "Diagnosis" section below is the spec the tasks argue from; it records measurements taken against production on 2026-09-23.

## Global Constraints

> **Renamed during execution:** Task 5 renamed the route segment folder `app/[locale]` to `app/[lang]` (and `app/internal/[locale]` to `app/internal/[lang]`). URLs did not change — `/vi/books` is still `/vi/books`. Tasks 1-4 below still say `app/[locale]`, which is what they were executed against; read them as history. Anything forward-looking says `[lang]`. The rename's necessity is unproven: the defect that forced the investigation was a `headers()` read in `app/[lang]/not-found.tsx` or `forbidden.tsx`, either of which alone keeps the whole segment dynamic with no build error. See the comments in those files.


- Next.js 16.3.4. Read the relevant guide under `node_modules/next/dist/docs/` before changing Next.js code (AGENTS.md).
- Customer routes stay under `/{locale}`; supported locales are exactly `vi` and `en`. `/admin` stays without a locale prefix.
- Every protected page and server action keeps calling `requireUser()` or `requireAdmin()`. A layout is never the only authorization control. **No task in this plan may move an authorization check.**
- `SUPABASE_SERVICE_ROLE_KEY` never reaches browser code.
- Public catalog data is read through `createPublicClient()` (`lib/supabase/public.ts`), which is cookie-less and anon-only.
- Run `npm run lint`, `npm run typecheck`, and the unit suite for every task. **Exclude `scripts/ebook.test.ts`** — it loads `.env.local` and calls the cloud database; it is red on every branch and unrelated to this work. Use:
  `npx vitest run --exclude 'scripts/**' --exclude 'e2e/**' --exclude '.worktrees/**' --exclude '**/node_modules/**'`
  A CLI `--exclude` replaces `vitest.config.ts`'s list rather than adding to it, which is why `e2e/**` and `.worktrees/**` have to be restated.
- Commit after every task. Work on a branch, not `main`.

---

## Diagnosis

Measured against `https://www.infinitybooks.vn` on 2026-09-23.

Every storefront response carries:

```
cache-control: private, no-cache, no-store, max-age=0, must-revalidate
x-vercel-cache: MISS
```

`next build` marks all 60+ app routes `ƒ (Dynamic)`. TTFB from Vietnam as Googlebot measured 0.87s warm and 8.4s cold, against 0.40s for the prerendered `/sitemap.xml` off the edge.

Five independent causes. (A)-(D) affect every storefront route; (E) affects the book and bundle pages only — which are the two most valuable pages in the set, so it is not optional.

| # | Cause | Location |
|---|---|---|
| A | `headers()` read for `<html lang>` | `app/layout.tsx:42` |
| B | `cookies()` + `supabase.auth.getUser()` for signed-in nav | `components/site-header.tsx:27-33` via `lib/supabase/server.ts:7` |
| C | `searchParams` read for the `action-error` banner | `app/[locale]/(public)/books/[slug]/page.tsx:64`, `app/[locale]/(public)/bundles/[slug]/page.tsx` |
| D | No `generateStaticParams` under `[locale]` | `app/[locale]/layout.tsx` and every catalog leaf page |
| E | The viewer's own ownership state, read during render | see below |

Cause (E) in full — it was missed in the first draft of this plan and found in review:

- `app/[locale]/(public)/books/[slug]/page.tsx:60` calls `getBookActionState(book)`, which calls `getCurrentProfile()` (`lib/data/catalog.ts:226`) → `getSessionUser()` (`lib/data/profiles.ts:14`) → `createClient()` → `cookies()` (`lib/auth/session.ts:25-30`).
- `lib/data/public-bundles.ts:117` calls `getCurrentProfile()` inside `getPublicBundle()` to compute `ownedMemberCount`. `getPublicBundle()` is called from the bundle page **and from its `generateMetadata`**, so even the metadata read touches the session.
- `app/[locale]/(public)/bundles/[slug]/page.tsx:70` calls `getBundleActionState()`, which reads the profile again (`lib/data/public-bundles.ts:164`).

The home page and the author, series and topic pages have no such read — verified by grep across `app/[locale]/(public)` and `components/catalog`. They become static from tasks 1-3 and 5 alone.

The codebase already has the concept this task generalizes: `lib/seo/json-ld.ts:145-150` deliberately builds the bundle's structured data with `ownedMemberCount: 0`, commented "What an anonymous visitor could do now". The page's HTML should say the same thing, and the browser should correct it for the reader who owns something.

Ruled out by experiment, do not re-investigate:

- `<Analytics />` and `<SpeedInsights />` wrap themselves in `<Suspense>` (`node_modules/@vercel/analytics/dist/next/index.mjs:262`), so their `useSearchParams()` does not deopt the route.
- Removing (A) alone changes nothing in the build output, because (D) still binds. Verified with a probe build.
- `deferPrerenderWithoutServerEnv()` only calls `connection()` when the build lacks server env; on Vercel it does not, and `/robots.txt` and `/sitemap.xml` already prerender.
- `getServerEnv()` is a plain `process.env` read and is not a dynamic API.

### Non-goals

- `/{locale}/books` (the filtered catalog list) and `/{locale}/search` stay dynamic. `CatalogFilterForm` is deliberately a plain GET form that works without JavaScript (`components/catalog/catalog-filter-form.tsx:11`), and `generateMetadata` reads `searchParams` to mark filtered views `noindex`. Converting it to client-side filtering would trade a documented design property and a working `noindex` rule for one URL. The long tail — book, author, series, topic and bundle pages — is where prerendering pays, and those have no filters.
- Cache Components (`cacheComponents: true`, `'use cache'`, `use cache: private`) is the Next 16 idiom for this problem and would let `SiteHeader` keep its server-side session read behind a `<Suspense>` boundary. It is rejected for now because it is a whole-app migration: it turns every session read in `/admin`, `(account)` and `(reader)` into a validation error needing `export const instant = false`, and it does not remove cause (A) anyway. Revisit after this plan lands. See `node_modules/next/dist/docs/01-app/02-guides/authentication-with-cache-components.md`.
- Nothing here changes what data any page shows, or who may see it.

## File Structure

**Created**

- `lib/fonts.ts` — the two `next/font` instances, so more than one root layout can share them.
- `components/site-header-account-nav.tsx` — client island; the signed-in half of the header nav.
- `components/site-header-account-nav.test.tsx` — its test.
- `components/catalog/action-error-banner.tsx` — client island; reads `action-error` from the URL.
- `components/catalog/action-error-banner.test.tsx` — its test.
- `app/admin/forbidden.tsx` — moved from `app/forbidden.tsx`; `forbidden()` is only ever called by the admin gate.
- `lib/catalog/static-params.ts` — the slug lists the catalog leaf pages prerender, shared with the sitemap.
- `lib/catalog/static-params.test.ts` — its test.
- `components/catalog/use-viewer-action.ts` — the hook both viewer islands share.
- `components/catalog/viewer-book-action.tsx` + `.test.tsx` — client island; the book's action control.
- `components/catalog/viewer-bundle-action.tsx` + `.test.tsx` — client island; the bundle's action control and owned-members line.
- `app/api/catalog/books/[bookId]/action-state/route.ts` + `.test.ts` — what the book island fetches.
- `app/api/catalog/bundles/[bundleId]/action-state/route.ts` + `.test.ts` — what the bundle island fetches.
- `scripts/assert-prerendered-routes.ts` — build guard.

**Modified**

- `app/[locale]/layout.tsx` — becomes a root layout: renders `<html lang={locale}>`, owns `metadataBase`, adds `generateStaticParams`.
- `app/admin/layout.tsx`, `app/internal/[locale]/layout.tsx` — become root layouts.
- `components/site-header.tsx` — loses the Supabase read; renders the island.
- `app/[locale]/(public)/books/[slug]/page.tsx`, `app/[locale]/(public)/bundles/[slug]/page.tsx` — stop reading `searchParams`; gain `generateStaticParams`.
- `app/[locale]/(public)/page.tsx`, `authors/[slug]/page.tsx`, `series/[slug]/page.tsx`, `topics/[slug]/page.tsx` — gain `generateStaticParams` / `revalidate`.
- `app/sitemap.ts` — reads its slugs through `lib/catalog/static-params.ts`.
- `lib/data/catalog.ts` — gains a session-free `publicBookAction()`.
- `lib/data/public-bundles.ts` — `getPublicBundle()` loses its session read; ownership moves to `getBundleOwnership()`.
- `components/catalog/book-action-control.tsx` — becomes a client component.
- `proxy.ts` — takes over the `/` → `/vi` redirect.
- `package.json` — `check` runs the build guard.

**Deleted**

- `app/layout.tsx`, `app/page.tsx`, `app/forbidden.tsx`.

---

### Task 1: One root layout per top-level area

Removes cause (A). A root layout cannot read a child segment's `params`, so the only way to put the locale in `<html lang>` without `headers()` is to make `app/[locale]/layout.tsx` itself a root layout. Next.js allows several root layouts as long as `app/layout.tsx` is gone and every top-level path has one.

`/admin` is English-only by design (see the comment in `lib/i18n/config.ts` on `getInterfaceLocale`), so its root layout hardcodes `lang="en"`. `app/auth/` holds only route handlers and actions, so it needs no layout. `app/page.tsx` exists only to redirect `/` → `/vi`; the proxy already runs on that path and can do it without a function invocation.

**Risk:** the metadata files at the app root (`favicon.ico`, `icon.png`, `apple-icon.png`, `opengraph-image.tsx`, `robots.ts`, `sitemap.ts`) must keep working with no `app/layout.tsx`. Step 8 verifies this explicitly. If the icon links disappear from the rendered HTML, stop and revert the commit rather than working around it.

**Files:**
- Create: `lib/fonts.ts`
- Create: `app/admin/forbidden.tsx`
- Modify: `app/[locale]/layout.tsx`
- Modify: `app/admin/layout.tsx`
- Modify: `app/internal/[locale]/layout.tsx`
- Modify: `proxy.ts`
- Delete: `app/layout.tsx`, `app/page.tsx`, `app/forbidden.tsx`
- Test: `app/[locale]/layout.test.tsx`

**Interfaces:**
- Produces: `lib/fonts.ts` exports `lora` and `beVietnamPro` (the `NextFont` objects from `next/font/google`), each with a `.variable` class string.
- Produces: `app/[locale]/layout.tsx` default export `LocaleLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> })` returning an `<html>` element, plus `generateMetadata(): Metadata`.
- Consumes: `resolveLocale`, `isLocale`, `withLocale` from `@/lib/i18n/config`; `getDictionary` from `@/lib/i18n/dictionary`; `getServerEnv` from `@/lib/config/server-env`; `SITE_NAME` from `@/lib/seo/metadata`.

- [ ] **Step 1: Write the failing test**

Create `app/[locale]/layout.test.tsx`. The layout returns an `<html>` element, which Testing Library cannot mount into jsdom, so assert on the returned React element instead of rendering it.

```tsx
import { describe, expect, it, vi } from "vitest";

import LocaleLayout from "@/app/[locale]/layout";

// next/font/google runs at module scope and does not work under vitest; the layout only needs the
// `.variable` class names from it.
vi.mock("@/lib/fonts", () => ({
  lora: { variable: "--font-lora" },
  beVietnamPro: { variable: "--font-be-vietnam-pro" },
}));

describe("LocaleLayout", () => {
  it("names the document language from its own params, not from a request header", async () => {
    const element = (await LocaleLayout({
      children: null,
      params: Promise.resolve({ locale: "en" }),
    })) as React.ReactElement<{ lang: string }>;

    expect(element.type).toBe("html");
    expect(element.props.lang).toBe("en");
  });

  it("names the other locale for the other locale", async () => {
    const element = (await LocaleLayout({
      children: null,
      params: Promise.resolve({ locale: "vi" }),
    })) as React.ReactElement<{ lang: string }>;

    expect(element.props.lang).toBe("vi");
  });

  it("prerenders one page per supported locale", async () => {
    const { generateStaticParams } = await import("@/app/[locale]/layout");
    expect(generateStaticParams()).toEqual([{ locale: "vi" }, { locale: "en" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run 'app/[locale]/layout.test.tsx'`
Expected: FAIL — the current layout returns `children`, not an `<html>` element, and exports no `generateStaticParams`.

- [ ] **Step 3: Extract the fonts**

Create `lib/fonts.ts`. `next/font` must be initialized at module scope; importing the resulting objects into several layouts is supported.

```ts
import { Be_Vietnam_Pro, Lora } from "next/font/google";

// Lora carries headings and reading text; Be Vietnam Pro carries UI. Both ship the Vietnamese
// subset so diacritics render from the same face rather than a fallback. They live here rather
// than in a layout because the app has one root layout per top-level area and they all share
// these two faces.
export const lora = Lora({
  subsets: ["latin", "vietnamese"],
  style: ["normal", "italic"],
  variable: "--font-lora",
});

export const beVietnamPro = Be_Vietnam_Pro({
  subsets: ["latin", "vietnamese"],
  weight: ["400", "500", "600"],
  variable: "--font-be-vietnam-pro",
});
```

- [ ] **Step 4: Promote the locale layout to a root layout**

Replace `app/[locale]/layout.tsx` entirely:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import "../globals.css";

import { getServerEnv } from "@/lib/config/server-env";
import { beVietnamPro, lora } from "@/lib/fonts";
import { isLocale, locales } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { SITE_NAME } from "@/lib/seo/metadata";
import { cn } from "@/lib/utils";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

// This is a root layout, not a nested one: it renders <html> and <body>. The app has one root
// layout per top-level area (/[locale], /admin, /internal) so that each can name its own document
// language from its own params. Reading it from a request header instead would make every route
// under it render on demand.
export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

// SITE_URL is the only public origin (S5 spec 7.1). Read at request time: the build has no runtime
// environment to validate.
export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(getServerEnv().siteUrl),
    title: {
      default: SITE_NAME,
      template: `%s · ${SITE_NAME}`,
    },
    description: "A home for books that stay with you.",
  };
}

export default async function LocaleLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;

  if (!isLocale(locale)) {
    notFound();
  }

  const dictionary = await getDictionary(locale);

  return (
    <html className={cn("font-sans", lora.variable, beVietnamPro.variable)} lang={locale}>
      <body className="min-h-screen antialiased">
        <a
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-ink focus:px-4 focus:py-3 focus:font-medium focus:text-ivory"
          href="#main-content"
        >
          {dictionary.navigation.skipToContent}
        </a>
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
```

- [ ] **Step 5: Give /admin and /internal their own root layouts**

`app/admin/layout.tsx` — keep the existing metadata and `AdminShell`, add the document shell. The English copy is hardcoded because `/admin` is English-only.

```tsx
import type { Metadata } from "next";
import "../globals.css";

import { AdminShell } from "@/components/admin/admin-shell";
import { beVietnamPro, lora } from "@/lib/fonts";
import { cn } from "@/lib/utils";

// Keeps the admin out of search results (S5 spec 7.2).
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// A root layout: /admin has no [locale] segment and is English-only, so it names its own document
// language. Navigation only. This layout does NOT call requireAdmin() - it is never the
// authorization boundary. Every page and action under /admin calls requireAdmin() itself, so
// removing this file would not grant access to anything it currently protects.
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <html className={cn("font-sans", lora.variable, beVietnamPro.variable)} lang="en">
      <body className="min-h-screen antialiased">
        <AdminShell>{children}</AdminShell>
      </body>
    </html>
  );
}
```

`app/internal/[locale]/layout.tsx` — keep its existing `metadata` export and its `isLocale` guard, and wrap its returned `children` the same way, using `lang={locale}` from the params it already awaits. Import `"../../globals.css"` (two levels up from `app/internal/[locale]/`).

- [ ] **Step 6: Move the 403 page under /admin**

`forbidden()` is called from exactly one place, `lib/auth/admin.ts:48`, so the convention file belongs to the admin tree. `git mv app/forbidden.tsx app/admin/forbidden.tsx`, then replace the `headers()` read with the fixed English locale, since the file now only ever renders under `/admin`:

```tsx
import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { withLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";

// Rendered by the `forbidden()` interrupt (see lib/auth/admin.ts), which only fires on /admin.
// /admin is English-only, so a denied visitor reads English here and lands on the English home.
export default async function Forbidden() {
  const dictionary = await getDictionary("en");
  const copy = dictionary.forbidden;
  const home = withLocale("en", "/");
  // ...body unchanged from app/forbidden.tsx...
}
```

Keep the JSX body exactly as it was.

- [ ] **Step 7: Move the `/` redirect into the proxy and delete the old root files**

In `proxy.ts`, immediately after the request id is set and before the stored-redirect lookup, add:

```ts
  // `/` has no page of its own any more: the app has one root layout per top-level area, so there
  // is no layout for a bare `/` page to render under. The proxy already runs on this path.
  if (request.nextUrl.pathname === "/") {
    const home = new URL(`/${defaultLocale}`, request.url);
    const redirect = NextResponse.redirect(home, 307);
    redirect.headers.set(REQUEST_ID_HEADER, requestId);
    return redirect;
  }
```

Import `defaultLocale` from `@/lib/i18n/config`. Then:

```bash
git rm app/layout.tsx app/page.tsx
```

- [ ] **Step 8: Run the tests and the build, and verify the icons survived**

```bash
npx vitest run 'app/[locale]/layout.test.tsx'
npm run lint && npm run typecheck
npx vitest run --exclude 'scripts/**' --exclude 'e2e/**' --exclude '.worktrees/**' --exclude '**/node_modules/**'
npm run build
```

Expected: all pass. The build route table still lists `○ /robots.txt`, `○ /sitemap.xml`, `○ /icon.png`, `○ /apple-icon.png`, `○ /opengraph-image`. Every route is still `ƒ` — that is expected, three causes remain.

Then start the built app and confirm the metadata files still resolve with no root `app/layout.tsx`:

```bash
npm run start &
sleep 5
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://127.0.0.1:3000/favicon.ico
curl -s http://127.0.0.1:3000/vi | grep -o '<link rel="icon"[^>]*>'
curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" http://127.0.0.1:3000/
kill %1
```

Expected: `200 image/vnd.microsoft.icon`; the `<link rel="icon">` tags present; `/` returns `307 -> /vi`.

**If the icon links are gone, stop and revert this commit.** Losing them would undo the favicon work already shipped.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "app: give each top-level area its own root layout

The root layout read the locale from a request header to set <html lang>, which
made every route under it render on demand. A root layout cannot see a child
segment's params, so /[locale], /admin and /internal/[locale] each become their
own root layout and name their own document language. /'s redirect moves to the
proxy and app/forbidden.tsx moves under /admin, the only place forbidden() fires."
```

---

### Task 2: Move the header's session read into a client island

Removes cause (B). `SiteHeader` reads the session only to choose between "Sign in" and the Library/Account/Sign out group. That is presentation, not authorization: `(account)`, `(reader)` and every server action keep their own `requireUser()`. Moving the read to the browser lets the whole header prerender.

The island renders nothing until the session resolves, rather than guessing. A wrong guess would show "Sign in" to a signed-in reader on first paint.

**Files:**
- Create: `components/site-header-account-nav.tsx`
- Create: `components/site-header-account-nav.test.tsx`
- Modify: `components/site-header.tsx`

**Interfaces:**
- Produces: `SiteHeaderAccountNav({ copy, current, locale, navLinkClassName }: { copy: { account: string; library: string; signIn: string; signOut: string }; current?: "library" | "account" | "books" | "search"; locale: Locale; navLinkClassName: string })` — a `'use client'` component.
- Consumes: `createClient` from `@/lib/supabase/client` (browser client, already exists).
- `SiteHeader`'s own props are unchanged: `{ locale, current?, alternates? }`.

- [ ] **Step 1: Write the failing test**

Create `components/site-header-account-nav.test.tsx`:

```tsx
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SiteHeaderAccountNav } from "@/components/site-header-account-nav";
import { createClient } from "@/lib/supabase/client";

vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));
vi.mock("@/components/auth/sign-out-button", () => ({
  SignOutButton: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));

const copy = { account: "Account", library: "Library", signIn: "Sign in", signOut: "Sign out" };

function mockSession(user: { id: string } | null) {
  vi.mocked(createClient).mockReturnValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
    },
  } as unknown as ReturnType<typeof createClient>);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("SiteHeaderAccountNav", () => {
  it("shows nothing before the session resolves, so it never shows the wrong state", () => {
    mockSession(null);
    const { container } = render(<SiteHeaderAccountNav copy={copy} locale="en" navLinkClassName="nav" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers sign in when there is no session", async () => {
    mockSession(null);
    render(<SiteHeaderAccountNav copy={copy} locale="en" navLinkClassName="nav" />);

    expect(await screen.findByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/en/sign-in");
    expect(screen.queryByRole("link", { name: "Library" })).toBeNull();
  });

  it("offers the library, the account and sign out when there is a session", async () => {
    mockSession({ id: "user-1" });
    render(<SiteHeaderAccountNav copy={copy} locale="vi" navLinkClassName="nav" />);

    expect(await screen.findByRole("link", { name: "Library" })).toHaveAttribute("href", "/vi/library");
    expect(screen.getByRole("link", { name: "Account" })).toHaveAttribute("href", "/vi/account");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
  });

  it("marks the current section", async () => {
    mockSession({ id: "user-1" });
    render(<SiteHeaderAccountNav copy={copy} current="library" locale="en" navLinkClassName="nav" />);

    await waitFor(() => expect(screen.getByRole("link", { name: "Library" })).toHaveAttribute("aria-current", "page"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/site-header-account-nav.test.tsx`
Expected: FAIL — `Failed to resolve import "@/components/site-header-account-nav"`.

- [ ] **Step 3: Write the island**

Create `components/site-header-account-nav.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { SignOutButton } from "@/components/auth/sign-out-button";
import type { Locale } from "@/lib/i18n/config";
import { getLocaleRoutes } from "@/lib/i18n/routes";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

// The only part of the header that depends on who is asking. It runs in the browser so the rest of
// the header can be prerendered: a server-side session read marks the whole route dynamic and sends
// `private, no-store`. This is presentation only - /[locale]/(account), /[locale]/(reader) and every
// server action still authorize themselves with requireUser().
export function SiteHeaderAccountNav({
  copy,
  current,
  locale,
  navLinkClassName,
}: {
  copy: { account: string; library: string; signIn: string; signOut: string };
  current?: "library" | "account" | "books" | "search";
  locale: Locale;
  navLinkClassName: string;
}) {
  // `undefined` means "not known yet". Rendering nothing until the session resolves is deliberate:
  // guessing would show a signed-in reader a Sign in link on first paint.
  const [signedIn, setSignedIn] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    const supabase = createClient();
    let active = true;

    supabase.auth.getUser().then(({ data }) => {
      if (active) setSignedIn(Boolean(data.user));
    });

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active) setSignedIn(Boolean(session?.user));
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  if (signedIn === undefined) return null;

  const routes = getLocaleRoutes(locale);

  if (!signedIn) {
    return (
      <Link className={navLinkClassName} href={routes.signIn}>
        {copy.signIn}
      </Link>
    );
  }

  return (
    <>
      <Link
        aria-current={current === "library" ? "page" : undefined}
        className={cn(navLinkClassName, current === "library" && "underline")}
        href={routes.library}
      >
        {copy.library}
      </Link>
      <Link
        aria-current={current === "account" ? "page" : undefined}
        className={cn(navLinkClassName, current === "account" && "underline")}
        href={routes.account}
      >
        {copy.account}
      </Link>
      <SignOutButton className="hidden sm:inline-flex" label={copy.signOut} locale={locale} variant="ghost" />
    </>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run components/site-header-account-nav.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Strip the session read out of SiteHeader**

In `components/site-header.tsx`: delete the `createClient` import and the `import { SignOutButton }` line, add `import { SiteHeaderAccountNav } from "@/components/site-header-account-nav";`, and replace the opening of the component:

```tsx
export async function SiteHeader({
  locale,
  current,
  alternates,
}: {
  locale: Locale;
  current?: "library" | "account" | "books" | "search";
  alternates?: Partial<Record<Locale, string>>;
}) {
  const dictionary = await getDictionary(locale);
  const routes = getLocaleRoutes(locale);
  const copy = dictionary.navigation;
  const otherLocale = locales.find((candidate) => candidate !== locale) ?? locale;
```

Then replace the whole `{user ? (...) : (...)}` block with:

```tsx
          <SiteHeaderAccountNav
            copy={{ account: copy.account, library: copy.library, signIn: copy.signIn, signOut: copy.signOut }}
            current={current}
            locale={locale}
            navLinkClassName={navLink}
          />
```

`getDictionary` is a static JSON import, not a request read, so the header stays prerenderable.

- [ ] **Step 6: Run the whole suite**

```bash
npm run lint && npm run typecheck
npx vitest run --exclude 'scripts/**' --exclude 'e2e/**' --exclude '.worktrees/**' --exclude '**/node_modules/**'
npm run build
```

Expected: all pass. Page tests already stub the header (`vi.mock("@/components/site-header", ...)`), so none of them should need changing. Routes are still `ƒ`.

- [ ] **Step 7: Check the header by hand**

Start the app, sign in, and confirm the Library/Account/Sign out group appears and the language switcher, Books and Search links render immediately on both a signed-out and a signed-in load. Follow `docs/runbooks/testing-environments.md` for the local stack.

- [ ] **Step 8: Commit**

```bash
git add components/site-header.tsx components/site-header-account-nav.tsx components/site-header-account-nav.test.tsx
git commit -m "header: read the session in the browser, not the render

SiteHeader called supabase.auth.getUser() through the cookie-backed server
client on every public page. Reading cookies marks the route dynamic, so every
storefront response carried private, no-store and every render paid an auth
round trip - for anonymous visitors too. The signed-in half of the nav becomes a
client island. Authorization is untouched: the account, reader and action paths
still call requireUser() themselves."
```

---

### Task 3: Read the action error in the browser

Removes cause (C). `books/[slug]` and `bundles/[slug]` read `searchParams` for one thing: a one-line error banner after a failed buy or claim, linked from `getCommerceRoutes().bookActionError()` / `.bundleActionError()`. A client island reading the same query key keeps the behavior and frees the route.

**Files:**
- Create: `components/catalog/action-error-banner.tsx`
- Create: `components/catalog/action-error-banner.test.tsx`
- Modify: `app/[locale]/(public)/books/[slug]/page.tsx`
- Modify: `app/[locale]/(public)/bundles/[slug]/page.tsx`
- Modify: `app/[locale]/(public)/bundles/[slug]/page.test.tsx`

**Interfaces:**
- Produces: `ActionErrorBanner({ messages }: { messages: Record<string, string> })` — a `'use client'` component that reads `action-error` from `useSearchParams()` and renders `<p role="alert">{messages[code]}</p>`, or `null` when the key is absent or unknown.
- The caller passes the already-translated map, so the island imports nothing server-only.

- [ ] **Step 1: Write the failing test**

Create `components/catalog/action-error-banner.test.tsx`:

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActionErrorBanner } from "@/components/catalog/action-error-banner";

const searchParams = { value: new URLSearchParams() };
vi.mock("next/navigation", () => ({ useSearchParams: () => searchParams.value }));

const messages = { "already-owned": "You already own this book.", "offer-gone": "This offer has ended." };

afterEach(cleanup);

describe("ActionErrorBanner", () => {
  it("says nothing when the URL carries no error", () => {
    searchParams.value = new URLSearchParams();
    const { container } = render(<ActionErrorBanner messages={messages} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("announces the error named in the URL", () => {
    searchParams.value = new URLSearchParams({ "action-error": "already-owned" });
    render(<ActionErrorBanner messages={messages} />);
    expect(screen.getByRole("alert")).toHaveTextContent("You already own this book.");
  });

  it("ignores a code it has no message for, rather than rendering an empty alert", () => {
    searchParams.value = new URLSearchParams({ "action-error": "not-a-real-code" });
    const { container } = render(<ActionErrorBanner messages={messages} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/catalog/action-error-banner.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the island**

Create `components/catalog/action-error-banner.tsx`:

```tsx
"use client";

import { useSearchParams } from "next/navigation";

// The banner a failed buy or claim redirects back to (see getCommerceRoutes().bookActionError()).
// It reads the query string in the browser so the page around it can be prerendered: reading
// searchParams on the server marks the whole route dynamic. The caller passes translated copy, so
// an unknown code renders nothing rather than an empty alert.
export function ActionErrorBanner({ messages }: { messages: Record<string, string> }) {
  const code = useSearchParams().get("action-error");
  const message = code ? messages[code] : undefined;
  if (!message) return null;

  return (
    <p className="mt-4 text-sm text-error" role="alert">
      {message}
    </p>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run components/catalog/action-error-banner.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Use it on the book page**

In `app/[locale]/(public)/books/[slug]/page.tsx`:

1. Drop `searchParams` from the `Props` type and from the component signature, and delete the `parseBookActionError` import and the `const actionError = ...` line.
2. Replace the `{actionError ? (...) : null}` block with, wrapped in a boundary because `useSearchParams()` outside one deopts the route:

```tsx
            <Suspense fallback={null}>
              <ActionErrorBanner messages={copy.actionErrors} />
            </Suspense>
```

3. Add `import { Suspense } from "react";` and `import { ActionErrorBanner } from "@/components/catalog/action-error-banner";`.
4. `generateMetadata` for this page does not read `searchParams`; leave it alone.

Do the same in `app/[locale]/(public)/bundles/[slug]/page.tsx` with its own `actionErrors` copy map, and drop the now-unused `searchParams` argument from the calls in `app/[locale]/(public)/bundles/[slug]/page.test.tsx` (the `const searchParams = Promise.resolve({})` fixture and the `{ params, searchParams }` call sites).

- [ ] **Step 6: Run the whole suite**

```bash
npm run lint && npm run typecheck
npx vitest run --exclude 'scripts/**' --exclude 'e2e/**' --exclude '.worktrees/**' --exclude '**/node_modules/**'
npm run build
```

Expected: all pass. Routes still `ƒ` — cause (D) remains.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "catalog: read the action-error code in the browser

The book and bundle pages read searchParams for one thing, the banner a failed
buy or claim redirects back to, and that read marked both routes dynamic. A
client island behind a Suspense boundary reads the same query key and keeps the
behavior."
```

---

### Task 4: Render the anonymous state, correct it in the browser

Removes cause (E). The book and bundle pages currently ask "what can *this reader* do?" while rendering. Everything else on those pages — title, author, description, audience, key ideas, FAQ, member list, related links, JSON-LD — is the same for everyone.

The page renders what an anonymous visitor could do, which is exactly what a crawler should index and what a reader without JavaScript still sees. A client island then asks a route handler for the viewer's real state and swaps the control if it differs. `lib/seo/json-ld.ts:145-150` already takes this position for structured data; this extends it to the HTML.

**The island fetches from a route handler rather than querying Supabase from the browser.** A browser read of `entitlements` would typecheck and pass mocked tests and then fail with 42501 at runtime if the grant is not there, and AGENTS.md requires entitlement reads to go through the authenticated database functions. The route handler reuses the server helpers that already exist.

**Authorization is unchanged.** `BookActionControl`'s own comment already says it "never grants access; the reader route, Server Actions, and RPCs check again". The bound Server Actions keep being created on the server and passed down as props, which works across a client boundary. `/api/**` is already `Disallow`ed in `robots.ts`.

**Files:**
- Create: `lib/catalog/viewer-action.ts` (shared response type)
- Create: `app/api/catalog/books/[bookId]/action-state/route.ts` + `route.test.ts`
- Create: `app/api/catalog/bundles/[bundleId]/action-state/route.ts` + `route.test.ts`
- Create: `components/catalog/use-viewer-action.ts`
- Create: `components/catalog/viewer-book-action.tsx` + `viewer-book-action.test.tsx`
- Create: `components/catalog/viewer-bundle-action.tsx` + `viewer-bundle-action.test.tsx`
- Modify: `components/catalog/book-action-control.tsx` (add `"use client"`)
- Modify: `lib/data/catalog.ts`, `lib/data/public-bundles.ts`
- Modify: `app/[locale]/(public)/books/[slug]/page.tsx`, `app/[locale]/(public)/bundles/[slug]/page.tsx`
- Modify: `app/[locale]/(public)/bundles/[slug]/page.test.tsx`

**Interfaces:**
- Produces: `type ViewerBookActionState = { action: BookAction; signedIn: boolean }` and `type ViewerBundleActionState = { action: BundleAction; signedIn: boolean; ownedMemberCount: number }` in `lib/catalog/viewer-action.ts`.
- Produces: `publicBookAction(card: Pick<CatalogBookCard, "bookId" | "offer" | "hasActivePublication">): BookAction` in `lib/data/catalog.ts` — `getBookActionState` minus the profile read, i.e. `hasActiveEntitlement: false`.
- Produces: `getBundleOwnership(members: CatalogBookCard[]): Promise<number>` in `lib/data/public-bundles.ts` — how many of these the current viewer holds; `0` when signed out.
- Changes: `PublicBundleDTO` loses `ownedMemberCount`. `getPublicBundle()` no longer calls `getCurrentProfile()`.
- Produces: `useViewerAction<T>(url: string, fallback: T): T` in `components/catalog/use-viewer-action.ts`.

- [ ] **Step 1: Write the failing test for the session-free reads**

Add to `lib/data/catalog.test.ts` (create the describe block if the file has none for this):

```ts
describe("publicBookAction", () => {
  it("answers for an anonymous visitor without reading a session", () => {
    expect(
      publicBookAction({ bookId: "book-1", offer: { priceMinor: 129000, currency: "VND" }, hasActivePublication: true }),
    ).toBe("buy");
  });

  it("never answers `read`, because an anonymous visitor owns nothing", () => {
    expect(publicBookAction({ bookId: "book-1", offer: null, hasActivePublication: true })).toBe("unavailable");
  });
});
```

Add to `lib/data/public-bundles.test.ts`:

```ts
it("reads a bundle without touching the session, so the page can be prerendered", async () => {
  // getCurrentProfile is mocked to throw: if the read reaches for a session at all, this fails.
  vi.mocked(getCurrentProfile).mockRejectedValue(new Error("getPublicBundle must not read the session"));

  const bundle = await getPublicBundle("en", "starter-bundle");

  expect(bundle).not.toBeNull();
  expect(bundle).not.toHaveProperty("ownedMemberCount");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run lib/data/catalog.test.ts lib/data/public-bundles.test.ts`
Expected: FAIL — `publicBookAction` is not exported, and `getPublicBundle` still calls `getCurrentProfile`.

- [ ] **Step 3: Split the reads**

In `lib/data/catalog.ts`, add next to `getBookActionState` and have `getBookActionState` keep its current behaviour:

```ts
// What an anonymous visitor could do with this book: the same rule as getBookActionState, minus
// the entitlement the viewer might hold. A page renders this so it can be prerendered; the viewer's
// own state arrives from /api/catalog/books/[bookId]/action-state.
export function publicBookAction(
  card: Pick<CatalogBookCard, "bookId" | "offer" | "hasActivePublication">,
): BookAction {
  return resolveBookAction({
    hasActiveEntitlement: false,
    offer: card.offer ? { priceMinor: card.offer.priceMinor, active: true } : null,
    hasActivePublication: card.hasActivePublication,
    paymentsEnabled: arePaymentsEnabled(getServerEnv()),
  });
}
```

In `lib/data/public-bundles.ts`:

1. Remove `getCurrentProfile()` from the `Promise.all` at line 117 and the `owned`/`ownedMemberCount` computation at line 152.
2. Remove `ownedMemberCount` from `PublicBundleDTO`.
3. Add:

```ts
// How many of a bundle's visible members the current viewer already holds. Zero when signed out.
// Split out of getPublicBundle so that read stays session-free and the bundle page can be
// prerendered; this one is called from the route handler the page's island fetches.
export async function getBundleOwnership(members: CatalogBookCard[]): Promise<number> {
  const profile = await getCurrentProfile();
  if (!profile) return 0;

  const owned = await getActiveEntitlementBookIds(profile.id);
  return members.filter((member) => owned.has(member.bookId)).length;
}
```

4. `getBundleActionState` keeps its signature and its profile read; it is now only called from the route handler.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run lib/data/catalog.test.ts lib/data/public-bundles.test.ts`
Expected: PASS. Other assertions in those files that expect `ownedMemberCount` on the DTO will fail — move them onto `getBundleOwnership` rather than deleting them.

- [ ] **Step 5: Write the failing test for the route handlers**

Create `app/api/catalog/books/[bookId]/action-state/route.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/catalog/books/[bookId]/action-state/route";
import { getBookActionState, getBookCards } from "@/lib/data/catalog";

vi.mock("@/lib/data/catalog", () => ({ getBookActionState: vi.fn(), getBookCards: vi.fn() }));

const BOOK_ID = "e40dae04-b8de-43bd-9545-c56f86b25971";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/catalog/books/[bookId]/action-state", () => {
  it("answers with the viewer's own state", async () => {
    vi.mocked(getBookCards).mockResolvedValue([
      { bookId: BOOK_ID, offer: null, hasActivePublication: true } as never,
    ]);
    vi.mocked(getBookActionState).mockResolvedValue({ action: "read", signedIn: true });

    const response = await GET(new Request("http://t/"), { params: Promise.resolve({ bookId: BOOK_ID }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ action: "read", signedIn: true });
  });

  it("is a 404 for a book the public catalog does not show, rather than an oracle for hidden ids", async () => {
    vi.mocked(getBookCards).mockResolvedValue([]);

    const response = await GET(new Request("http://t/"), { params: Promise.resolve({ bookId: BOOK_ID }) });

    expect(response.status).toBe(404);
    expect(getBookActionState).not.toHaveBeenCalled();
  });

  it("is never cached, because the answer is per viewer", async () => {
    vi.mocked(getBookCards).mockResolvedValue([
      { bookId: BOOK_ID, offer: null, hasActivePublication: true } as never,
    ]);
    vi.mocked(getBookActionState).mockResolvedValue({ action: "buy", signedIn: false });

    const response = await GET(new Request("http://t/"), { params: Promise.resolve({ bookId: BOOK_ID }) });

    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
```

Write the mirror test for the bundle handler, asserting `{ action, signedIn, ownedMemberCount }` and the same 404 and `no-store` rules.

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run 'app/api/catalog'`
Expected: FAIL — modules not found.

- [ ] **Step 7: Write the route handlers**

Create `lib/catalog/viewer-action.ts`:

```ts
import type { BookAction, BundleAction } from "@/lib/catalog/book-action";

// What the catalog pages' client islands fetch. Deliberately narrow: an action name and whether
// there is a session. No profile, no entitlement rows, no ids the caller did not already have.
export type ViewerBookActionState = { action: BookAction; signedIn: boolean };
export type ViewerBundleActionState = { action: BundleAction; signedIn: boolean; ownedMemberCount: number };
```

Create `app/api/catalog/books/[bookId]/action-state/route.ts`:

```ts
import { NextResponse } from "next/server";

import type { ViewerBookActionState } from "@/lib/catalog/viewer-action";
import { getBookActionState, getBookCards } from "@/lib/data/catalog";
import { defaultLocale } from "@/lib/i18n/config";

// The one part of a book page that differs per viewer. The page itself renders what an anonymous
// visitor could do, so it can be prerendered, and this fills in the rest in the browser. It grants
// nothing: the reader route, the Server Actions and the RPCs all check again.
export async function GET(_request: Request, { params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;

  // Resolve the card from the public catalog first. An id the storefront does not show gets a 404
  // from the same read a visitor could do anyway, so this endpoint never confirms a hidden book.
  const cards = await getBookCards(defaultLocale);
  const card = cards.find((candidate) => candidate.bookId === bookId);
  if (!card) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const state: ViewerBookActionState = await getBookActionState(card);
  return NextResponse.json(state, { headers: { "cache-control": "private, no-store" } });
}
```

The bundle handler mirrors it: resolve the bundle by id through the public read, then `getBundleOwnership(bundle.members)` and `getBundleActionState({ publishedMemberCount: bundle.members.length, ownedMemberCount, offer: bundle.offer })`, returning all three fields.

- [ ] **Step 8: Run them to verify they pass**

Run: `npx vitest run 'app/api/catalog'`
Expected: PASS.

- [ ] **Step 9: Write the failing test for the islands**

Create `components/catalog/viewer-book-action.test.tsx`:

```tsx
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ViewerBookAction } from "@/components/catalog/viewer-book-action";

vi.mock("@/components/catalog/book-action-control", () => ({
  BookActionControl: ({ action, signedIn }: { action: string; signedIn: boolean }) => (
    <span data-signed-in={String(signedIn)}>{action}</span>
  ),
}));

const props = {
  bookId: "book-1",
  bookPath: "/en/books/a-book",
  locale: "en" as const,
  copy: {} as never,
  publicAction: "buy" as const,
  getFreeAction: async () => {},
  buyAction: async () => {},
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("ViewerBookAction", () => {
  it("renders the anonymous action first, so the prerendered HTML is what a crawler sees", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<ViewerBookAction {...props} />);

    expect(screen.getByText("buy")).toHaveAttribute("data-signed-in", "false");
  });

  it("swaps in the viewer's own action once it arrives", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ action: "read", signedIn: true }), { status: 200 })),
    );
    render(<ViewerBookAction {...props} />);

    await waitFor(() => expect(screen.getByText("read")).toHaveAttribute("data-signed-in", "true"));
  });

  it("keeps the anonymous action when the fetch fails, rather than blanking the control", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    render(<ViewerBookAction {...props} />);

    await waitFor(() => expect(screen.getByText("buy")).toBeVisible());
  });
});
```

Write the mirror test for `ViewerBundleAction`, adding one case: with `ownedMemberCount` at 2 of 3 members it renders the "you own some" line, and with 0 it renders nothing there.

- [ ] **Step 10: Run them to verify they fail**

Run: `npx vitest run components/catalog/viewer-`
Expected: FAIL — modules not found.

- [ ] **Step 11: Write the hook and the islands**

Create `components/catalog/use-viewer-action.ts`:

```ts
"use client";

import { useEffect, useState } from "react";

// Fetches the viewer's own state for a catalog page and falls back to the anonymous state it was
// given. Failure is not an error state here: the anonymous control is a correct, usable control,
// and every action it can start re-checks entitlement on the server anyway.
export function useViewerAction<T>(url: string, fallback: T): T {
  const [state, setState] = useState<T>(fallback);

  useEffect(() => {
    const controller = new AbortController();

    fetch(url, { signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<T>) : null))
      .then((next) => {
        if (next) setState(next);
      })
      .catch(() => {
        // Aborted, offline, or a 5xx. Keep the anonymous control.
      });

    return () => controller.abort();
  }, [url]);

  return state;
}
```

Create `components/catalog/viewer-book-action.tsx`:

```tsx
"use client";

import { BookActionControl } from "@/components/catalog/book-action-control";
import { useViewerAction } from "@/components/catalog/use-viewer-action";
import type { BookAction } from "@/lib/catalog/book-action";
import type { ViewerBookActionState } from "@/lib/catalog/viewer-action";
import type { Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";

// The book page prerenders `publicAction` - what an anonymous visitor could do - and this corrects
// it for the reader who is signed in or already owns the book. The Server Actions arrive as props,
// created on the server by the page; they re-check everything when invoked.
export function ViewerBookAction({
  bookId,
  bookPath,
  buyAction,
  copy,
  getFreeAction,
  locale,
  publicAction,
}: {
  bookId: string;
  bookPath: string;
  buyAction: () => Promise<void>;
  copy: Dictionary["catalog"]["actions"];
  getFreeAction: () => Promise<void>;
  locale: Locale;
  publicAction: BookAction;
}) {
  const state = useViewerAction<ViewerBookActionState>(`/api/catalog/books/${bookId}/action-state`, {
    action: publicAction,
    signedIn: false,
  });

  return (
    <BookActionControl
      action={state.action}
      bookId={bookId}
      bookPath={bookPath}
      buyAction={buyAction}
      copy={copy}
      getFreeAction={getFreeAction}
      locale={locale}
      signedIn={state.signedIn}
    />
  );
}
```

Add `"use client";` as the first line of `components/catalog/book-action-control.tsx`. It imports only `Link`, `SubmitButton`, `Button`, pure route helpers and types, so nothing server-only crosses the boundary.

Write `ViewerBundleAction` the same way, additionally rendering the owned-members line that currently lives at `app/[locale]/(public)/bundles/[slug]/page.tsx:141-145` from `state.ownedMemberCount`.

- [ ] **Step 12: Run them to verify they pass**

Run: `npx vitest run components/catalog/viewer-`
Expected: PASS.

- [ ] **Step 13: Use the islands on the pages**

In `app/[locale]/(public)/books/[slug]/page.tsx`: drop `getBookActionState` from the import and from the `Promise.all` at line 60, compute `const publicAction = publicBookAction(book);` instead, and render `<ViewerBookAction ... publicAction={publicAction} />` where `<BookActionControl>` is today, passing the same bound Server Actions.

In `app/[locale]/(public)/bundles/[slug]/page.tsx`: drop `getBundleActionState` from the import and the `Promise.all`, and replace both the control and the owned-members paragraph with `<ViewerBundleAction>`. The JSON-LD call is unchanged — `lib/seo/json-ld.ts` already passes `ownedMemberCount: 0`.

Update `app/[locale]/(public)/bundles/[slug]/page.test.tsx`: drop `getBundleActionState` from the module mock and `ownedMemberCount` from the `PublicBundleDTO` fixture.

**Do not let any prose leave the server render.** The title, subtitle, description, audience, key ideas, FAQ, member list and related links must stay in the prerendered HTML — only the action control and the owned-members line move. Step 14 checks this.

- [ ] **Step 14: Verify the HTML a crawler receives still carries the content**

```bash
npm run build && npm run start &
sleep 5
curl -s http://127.0.0.1:3000/vi/books/<a-seeded-slug> > /tmp/book.html
grep -c 'application/ld+json' /tmp/book.html
grep -o '<link rel="canonical"[^>]*>' /tmp/book.html
kill %1
```

Expected: the JSON-LD blocks and the canonical are present, and the book's description, key ideas and FAQ text appear in `/tmp/book.html` — this is raw HTML, before any hydration. If any of that prose is missing, an island took too much with it; fix the island, do not adjust the expectation.

- [ ] **Step 15: Run everything and commit**

```bash
npm run lint && npm run typecheck
npx vitest run --exclude 'scripts/**' --exclude 'e2e/**' --exclude '.worktrees/**' --exclude '**/node_modules/**'
npm run build
```

```bash
git add -A
git commit -m "catalog: render the anonymous action, correct it in the browser

The book page asked getBookActionState() and the bundle page read the profile
inside getPublicBundle() - including from generateMetadata - so both routes read
cookies while rendering and neither could be prerendered. They now render what an
anonymous visitor could do, which is what a crawler should index and what a
reader without JavaScript still gets, and a client island fetches the viewer's
own state from a route handler under the already-disallowed /api.

Authorization is unchanged. The bound Server Actions still come from the server,
and the reader route, the actions and the RPCs re-check entitlement as before."

```

---

### Task 5: Prerender the catalog and guard it

Removes cause (D) and turns the result on. Runs only after tasks 1-4; with any of (A)-(E) still in place the build table below will not appear. After this task the build table should show `○` for the home page and every catalog detail page.

Two different mechanisms keep these pages fresh, and it matters not to confuse them:

- `revalidateStorefront()` (`lib/catalog/revalidate.ts`) calls `revalidatePath("/[lang]", "layout")` on every admin write. **Whether that actually invalidates prerendered child routes such as `/[lang]/books/[slug]` is an assumption this plan does not get to make** — Task 6 tests it. If it does not, that is the real fix, not a shorter `revalidate`.
- `revalidate = 300` is not a schedule. It is stale-while-revalidate on request: the first request after the window expires is served the **old** page while the new one is built in the background, and the request after that gets the new one. See `node_modules/next/dist/docs/01-app/02-guides/incremental-static-regeneration.md`. So "at most 5 minutes stale, plus one request" is the honest description, and it is the floor under the on-demand path, not the mechanism editors rely on.

**Files:**
- Create: `lib/catalog/static-params.ts`
- Create: `lib/catalog/static-params.test.ts`
- Create: `scripts/assert-prerendered-routes.ts`
- Modify: `app/[locale]/(public)/page.tsx`, `books/[slug]/page.tsx`, `authors/[slug]/page.tsx`, `series/[slug]/page.tsx`, `topics/[slug]/page.tsx`, `bundles/[slug]/page.tsx`
- Modify: `app/sitemap.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `catalogStaticParams(locale: Locale): Promise<{ books: string[]; authors: string[]; series: string[]; topics: string[]; bundles: string[] }>` in `lib/catalog/static-params.ts` — the same slug sets the sitemap lists, read through `getBookCards(locale)` and `listPublicBundleSlugs()`.
- Consumes: `getBookCards` from `@/lib/data/catalog`, `listPublicBundleSlugs` from `@/lib/data/public-bundles`.

- [ ] **Step 1: Write the failing test**

Create `lib/catalog/static-params.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogBookCard } from "@/lib/catalog/public-types";
import { catalogStaticParams } from "@/lib/catalog/static-params";
import { getBookCards } from "@/lib/data/catalog";
import { listPublicBundleSlugs } from "@/lib/data/public-bundles";

vi.mock("@/lib/data/catalog", () => ({ getBookCards: vi.fn() }));
vi.mock("@/lib/data/public-bundles", () => ({ listPublicBundleSlugs: vi.fn() }));

function card(overrides: Partial<CatalogBookCard>): CatalogBookCard {
  return {
    bookId: "book-1",
    slug: "a-book",
    title: "A Book",
    subtitle: null,
    shortDescription: null,
    author: { name: "Mai Tran", slug: "mai-tran" },
    cover: null,
    offer: null,
    hasActivePublication: true,
    hasSample: false,
    series: null,
    topics: [],
    featured: false,
    shelfPosition: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("catalogStaticParams", () => {
  it("lists every slug the locale's visible books reach", async () => {
    vi.mocked(getBookCards).mockResolvedValue([
      card({ slug: "one", series: { slug: "a-series", name: "S", position: 1 }, topics: [{ slug: "calm", name: "Calm" }] }),
      card({ slug: "two", author: { name: "Mai Tran", slug: "mai-tran" }, topics: [{ slug: "calm", name: "Calm" }] }),
    ]);
    vi.mocked(listPublicBundleSlugs).mockResolvedValue([
      { locale: "vi", slug: "goi-khoi-dau" },
      { locale: "en", slug: "starter-bundle" },
    ]);

    expect(await catalogStaticParams("vi")).toEqual({
      books: ["one", "two"],
      authors: ["mai-tran"],
      series: ["a-series"],
      topics: ["calm"],
      bundles: ["goi-khoi-dau"],
    });
  });

  it("drops a book with no author slug and never repeats a slug", async () => {
    vi.mocked(getBookCards).mockResolvedValue([
      card({ slug: "one", author: { name: "Anon", slug: null } }),
      card({ slug: "one", author: { name: "Mai Tran", slug: "mai-tran" } }),
    ]);
    vi.mocked(listPublicBundleSlugs).mockResolvedValue([]);

    const params = await catalogStaticParams("en");
    expect(params.books).toEqual(["one"]);
    expect(params.authors).toEqual(["mai-tran"]);
    expect(params.bundles).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/catalog/static-params.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the slug reader**

Create `lib/catalog/static-params.ts`:

```ts
import "server-only";

import { getBookCards } from "@/lib/data/catalog";
import { listPublicBundleSlugs } from "@/lib/data/public-bundles";
import type { Locale } from "@/lib/i18n/config";

// The slugs the catalog prerenders, read exactly the way app/sitemap.ts reads them: from the same
// public card read the storefront uses, so a draft book is invisible here too and a book localized
// in one locale only is prerendered in that locale only. A slug that appears later is still served
// - dynamicParams stays on its default, so Next renders it on demand and caches it from then on.
export async function catalogStaticParams(locale: Locale): Promise<{
  books: string[];
  authors: string[];
  series: string[];
  topics: string[];
  bundles: string[];
}> {
  const [cards, bundles] = await Promise.all([getBookCards(locale), listPublicBundleSlugs()]);

  const unique = (slugs: string[]) => [...new Set(slugs)];

  return {
    books: unique(cards.map((card) => card.slug)),
    authors: unique(cards.flatMap((card) => (card.author.slug ? [card.author.slug] : []))),
    series: unique(cards.flatMap((card) => (card.series ? [card.series.slug] : []))),
    topics: unique(cards.flatMap((card) => card.topics.map((topic) => topic.slug))),
    bundles: unique(bundles.filter((bundle) => bundle.locale === locale).map((bundle) => bundle.slug)),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/catalog/static-params.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add generateStaticParams and revalidate to the catalog pages**

To each of the five detail pages add, next to the existing exports:

`app/[locale]/(public)/books/[slug]/page.tsx`

```tsx
// Prerendered per published book, invalidated on publish by revalidateStorefront() and stale by at
// most 5 minutes otherwise. A slug not listed here is still served: it renders on demand once, then caches.
export const revalidate = 300;

export async function generateStaticParams({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) return [];
  const { books } = await catalogStaticParams(params.locale);
  return books.map((slug) => ({ slug }));
}
```

`app/[locale]/(public)/authors/[slug]/page.tsx`

```tsx
// Prerendered per author with a visible book, invalidated on publish by revalidateStorefront() and
// stale by at most 5 minutes otherwise. A slug not listed here renders on demand once, then caches.
export const revalidate = 300;

export async function generateStaticParams({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) return [];
  const { authors } = await catalogStaticParams(params.locale);
  return authors.map((slug) => ({ slug }));
}
```

`app/[locale]/(public)/series/[slug]/page.tsx`

```tsx
// Prerendered per series with a visible book, invalidated on publish by revalidateStorefront() and
// stale by at most 5 minutes otherwise. A slug not listed here renders on demand once, then caches.
export const revalidate = 300;

export async function generateStaticParams({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) return [];
  const { series } = await catalogStaticParams(params.locale);
  return series.map((slug) => ({ slug }));
}
```

`app/[locale]/(public)/topics/[slug]/page.tsx`

```tsx
// Prerendered per topic with a visible book, invalidated on publish by revalidateStorefront() and
// stale by at most 5 minutes otherwise. A slug not listed here renders on demand once, then caches.
export const revalidate = 300;

export async function generateStaticParams({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) return [];
  const { topics } = await catalogStaticParams(params.locale);
  return topics.map((slug) => ({ slug }));
}
```

`app/[locale]/(public)/bundles/[slug]/page.tsx`

```tsx
// Prerendered per published bundle, invalidated on publish by revalidateStorefront() and stale by at
// most 5 minutes otherwise. A slug not listed here renders on demand once, then caches.
export const revalidate = 300;

export async function generateStaticParams({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) return [];
  const { bundles } = await catalogStaticParams(params.locale);
  return bundles.map((slug) => ({ slug }));
}
```

`app/[locale]/(public)/page.tsx` — the home page has no dynamic segment of its own, so it needs the revalidate window only:

```tsx
// The home shelves come from the same card read as the catalog, refreshed on publish by
// revalidateStorefront() and stale by at most 5 minutes otherwise.
export const revalidate = 300;
```

In each of the five detail pages add `import { catalogStaticParams } from "@/lib/catalog/static-params";` and reuse the file's existing `isLocale` import.

- [ ] **Step 6: Point the sitemap at the same reader**

Replace the body of the loop in `app/sitemap.ts` so the sitemap and the prerender list read the same slugs and cannot drift apart:

```ts
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await deferPrerenderWithoutServerEnv();
  const { siteUrl } = getServerEnv();
  const paths: string[] = [];

  for (const locale of locales) {
    // The same slugs the catalog pages prerender, so a page that exists is listed and a page that
    // is listed exists. Draft and unlocalized entities are invisible to this read.
    const slugs = await catalogStaticParams(locale);
    const { home, books } = getLocaleRoutes(locale);
    const catalog = getCatalogRoutes(locale);

    paths.push(
      home,
      books,
      ...slugs.books.map((slug) => catalog.book(slug)),
      ...slugs.authors.map((slug) => catalog.entity("author", slug)),
      ...slugs.series.map((slug) => catalog.entity("series", slug)),
      ...slugs.topics.map((slug) => catalog.entity("topic", slug)),
      ...slugs.bundles.map((slug) => catalog.bundle(slug)),
    );
  }

  return [...new Set(paths)].map((path) => ({ url: absoluteUrl(siteUrl, path) }));
}
```

Delete the now-unused `CatalogEntityKind`, `getBookCards` and `listPublicBundleSlugs` imports and the local `entity` helper, and add `import { catalogStaticParams } from "@/lib/catalog/static-params";`.

Run `npx vitest run app/sitemap.test.ts`. It should still pass untouched: it mocks `@/lib/data/catalog` and `@/lib/data/public-bundles`, which is what `catalogStaticParams` calls, so the seam it stubs is still the seam under test. If it fails, fix the test rather than reaching for a mock of `catalogStaticParams` — mocking the new module would stop the test covering the mapping from cards to URLs.

While you are here, check whether this fixes the stale sitemap observed on 2026-09-23: production served 18 URLs and omitted a published book that `/vi/books` was linking, with `last-modified` only minutes old. If it is still missing after this change, that is a separate defect in `revalidatePath("/sitemap.xml")` — file it, do not fold it into this plan.

- [ ] **Step 7: Run the build and read the route table**

```bash
npm run build
```

Expected — this is the moment the work pays off:

```
├ ○ /[locale]                         5m
├ ● /[locale]/authors/[slug]          5m
├ ● /[locale]/books/[slug]            5m
├ ● /[locale]/bundles/[slug]          5m
├ ● /[locale]/series/[slug]           5m
├ ● /[locale]/topics/[slug]           5m
├ ƒ /[locale]/books
├ ƒ /[locale]/search
```

`●` means prerendered with `generateStaticParams`; `○` means static. `/[locale]/books` and `/[locale]/search` staying `ƒ` is the documented non-goal.

**If any catalog route is still `ƒ`, do not paper over it.** Find the dynamic read the same way the diagnosis did: comment the suspect out, rebuild, and compare the table.

- [ ] **Step 8: Write the build guard**

Create `scripts/assert-prerendered-routes.ts`. It reads the manifest `next build` writes and fails if a route that must be prerendered is not.

```ts
import { readFile } from "node:fs/promises";

// The storefront's whole point is to be served from the edge. Five separate request-time reads had
// to be removed to get here (see docs/superpowers/plans/2026-09-23-storefront-static-caching.md),
// and any one of them coming back would silently send `private, no-store` again. This fails the
// build instead.
const REQUIRED = [
  "/[locale]",
  "/[locale]/authors/[slug]",
  "/[locale]/books/[slug]",
  "/[locale]/bundles/[slug]",
  "/[locale]/series/[slug]",
  "/[locale]/topics/[slug]",
];

async function main() {
  const manifest = JSON.parse(await readFile(".next/prerender-manifest.json", "utf8")) as {
    dynamicRoutes: Record<string, unknown>;
    routes: Record<string, unknown>;
  };

  const prerendered = new Set([...Object.keys(manifest.dynamicRoutes ?? {}), ...Object.keys(manifest.routes ?? {})]);
  const missing = REQUIRED.filter((route) => !prerendered.has(route));

  if (missing.length > 0) {
    console.error(
      `These routes must be prerendered but are rendered on demand:\n  ${missing.join("\n  ")}\n\n` +
        "Something in their render tree reads cookies(), headers() or searchParams again.",
    );
    process.exit(1);
  }

  console.log(`All ${REQUIRED.length} storefront routes are prerendered.`);
}

void main();
```

Wire it into `package.json`:

```json
"check": "npm run lint && npm run typecheck && npm run test:unit && npm run build && npm run check:prerender",
"check:prerender": "tsx scripts/assert-prerendered-routes.ts",
```

- [ ] **Step 9: Verify the guard actually catches a regression**

Prove it fails before trusting it. Temporarily add `import { cookies } from "next/headers";` and `await cookies();` to the top of `app/[locale]/(public)/books/[slug]/page.tsx`, then:

```bash
npm run build && npm run check:prerender
```

Expected: exit 1, naming `/[locale]/books/[slug]`. Revert the temporary edit and re-run — expected: exit 0.

If the manifest key names do not match `REQUIRED`, print `Object.keys(manifest.dynamicRoutes)` and correct the list to whatever the manifest actually uses. Do not weaken the guard to make it pass.

- [ ] **Step 10: Run everything**

```bash
npm run lint && npm run typecheck
npx vitest run --exclude 'scripts/**' --exclude 'e2e/**' --exclude '.worktrees/**' --exclude '**/node_modules/**'
npm run build && npm run check:prerender
```

Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "catalog: prerender the book and entity pages

With the root layout's header read, the header's session read, the action-error
searchParams read and the per-viewer ownership read all gone, the catalog pages
can finally be prerendered. generateStaticParams lists the same slugs the sitemap does, from
the same public card read, so the two cannot drift. revalidateStorefront()
already invalidates them on publish; revalidate = 300 covers everything else.

scripts/assert-prerendered-routes.ts fails the build if any of those reads comes
back, because the symptom - private, no-store on every response - is otherwise
invisible until someone measures TTFB in production."
```

---

### Task 6: Prove what a crawler receives, and that the pages go stale on cue

The build guard in Task 5 reads a manifest. A manifest cannot tell you that the canonical is right, that the `<html lang>` survived the split into three root layouts, that the description is still in the HTML, or that unpublishing a book stops the page being served. Task 1 rewrote every root layout and Tasks 2-4 moved four things into the browser (the signed-in nav, the action-error banner, the book action and the bundle action), so all of that needs proving rather than assuming.

`e2e/seo-operations.spec.ts:77` already asserts canonical, alternates, Open Graph and safe JSON-LD on a published book page. It runs against a dev server today; this task runs it against a production build, where prerendering actually happens, and adds the cases prerendering makes possible to get wrong.

Run against a **local** Supabase stack only. Never point these fixtures at the cloud project (AGENTS.md). Export the Supabase and Mailpit variables first and read `docs/runbooks/testing-environments.md`; from memory of this repo, use a free port range (613xx has worked), run the app on :3100 rather than :3000, and check `docker context use orbstack` first.

**Files:**
- Modify: `e2e/seo-operations.spec.ts`
- Modify: `playwright.config.ts` (a project that builds and starts rather than running `next dev`)
- Create: `docs/runbooks/storefront-caching.md`

- [ ] **Step 1: Run the existing SEO suite against a production build**

Add a Playwright project whose `webServer` runs `npm run build && npm run start -- --port 3100` instead of `next dev`, and point `seo-operations.spec.ts` at it. Prerendering does not happen under `next dev`, so the current run proves nothing about the shipped behaviour.

Run it and fix whatever it catches before adding anything. Expect the root-layout rewrite from Task 1 to be the thing it catches, if anything is broken.

- [ ] **Step 2: Add the crawler-facing assertions**

In `e2e/seo-operations.spec.ts`, for a seeded book in both `vi` and `en`, fetch the page with `request.get()` — **not** `page.goto()`, so the assertion is against the raw HTML before hydration — and assert:

- `<html lang>` is the locale of the URL.
- `<title>` and `<meta name="description">` are the book's, not the site default.
- `<link rel="canonical">` is the absolute `www` URL of this page.
- `hreflang` `vi`, `en` and `x-default` are present, the `vi` and `en` alternates point at each other, and a book localized in one locale only emits no alternate for the other.
- No `<meta name="robots">` with `noindex`.
- The JSON-LD parses and its `Book` name matches the page.
- The book's description, audience, key ideas and FAQ text appear in the HTML. This is the LLMO-relevant assertion: an answer engine reading the page without running JavaScript still gets the substance. It also fails loudly if a future island takes prose with it.
- The internal links to the author, series and topic pages are in the HTML.

- [ ] **Step 3: Add the freshness matrix**

Each case seeds through the admin path, then re-fetches. These are the cases where a prerendered page can be wrong in a way a dev server never shows:

| Change | Must become true |
|---|---|
| Publish a new book | its detail page answers 200 with correct metadata, and its URL is in `/sitemap.xml` |
| Change an offer price | the visible price **and** the JSON-LD `offers.price` both change, together |
| Unpublish a book | the detail page stops serving an indexable product page |
| Change a slug | the old URL redirects to the new one; the new one answers 200 |
| Add the other locale's translation | both pages' `hreflang` point at each other |

The point of the first row is narrower than it looks: it tests whether `revalidatePath("/[lang]", "layout")` reaches a prerendered `/[lang]/books/[slug]`. If it does not, stop and fix the invalidation — a shorter `revalidate` window would only hide it.

Also check whether this settles the stale sitemap observed on 2026-09-23 (production served 18 URLs and omitted a published book that `/vi/books` was linking, `last-modified` minutes old). **Do not assume the cause.** If the sitemap is still stale here, that is a separate defect with its own investigation; file it.

- [ ] **Step 4: Write the runbook**

`docs/runbooks/storefront-caching.md`: which storefront routes are prerendered and which are deliberately dynamic and why, what invalidates them, how to check cache state in production (the section below), and the five causes from this plan's diagnosis, so the next person who adds a `cookies()` read to a shared component knows what they broke.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: check the storefront HTML a crawler actually receives

The prerender guard reads a manifest, which cannot tell whether the canonical is
right, the lang attribute survived the split into three root layouts, or the
description is still in the HTML after four things moved into the browser. It now
runs against a production build and asserts on the raw response, plus a
freshness matrix for publish, reprice, unpublish, slug change and translation."
```

---

## Verification after deploy

**Do not assert on `s-maxage`.** Vercel consumes and strips that directive before the response reaches a client: `/sitemap.xml` was measured on 2026-09-23 returning `cache-control: public, max-age=0, must-revalidate` with `x-vercel-cache: HIT`, i.e. correctly cached and showing no `s-maxage` at all. An earlier draft of this plan used it as the acceptance criterion, which a correctly cached page would have failed. See https://vercel.com/docs/caching/cache-control-headers.

Check the cache state instead, with a GET so the body is checked too, repeated so the first response can be the one that populates the cache:

```bash
for i in 1 2 3; do
  curl -s -o /tmp/p.html -D - -A Googlebot https://www.infinitybooks.vn/vi/books/quan-sat-tinh-biet \
    | grep -iE "^(cache-control|x-vercel-cache|x-vercel-id|age)"
  echo "---"
done
grep -c 'application/ld+json' /tmp/p.html
```

Expected: `x-vercel-cache: HIT` from the second request on, `x-vercel-id` showing `hnd1` as the function region, and the body still carrying its JSON-LD.

Then publish a book from `/admin` and confirm it appears on `/{locale}/books`, on its own detail URL and in the sitemap without a redeploy.

### Measure the proxy separately

Prerendering does not remove `proxy.ts`. Its matcher covers every storefront path, and on each matched request it may look up a stored redirect (`proxy.ts:14`) and then calls `updateSession()`, which runs `supabase.auth.getUser()` (`lib/supabase/proxy.ts:39-41`) and can write refreshed cookies onto the response. That does not make a page dynamic and does not stop the CDN serving it, but it does put a floor under TTFB that no amount of prerendering removes, and it is the obvious next thing to look at once the pages are cached.

Measure it across all three states rather than guessing:

| Case | What to record |
|---|---|
| Anonymous, no cookies | TTFB, `x-vercel-cache` |
| Signed in, valid session | TTFB, `x-vercel-cache`, whether `Set-Cookie` is present |
| Signed in, expired session | TTFB, whether the refresh writes cookies onto a cached response |

If splitting public paths out of the session refresh looks worthwhile afterwards, it needs its own plan: `decideRouteAccess()` guards the protected routes optimistically and `findPublicRedirect()` serves the stored redirects, and neither behaviour may change.

### On TTFB numbers

A handful of `curl` runs from one machine proves nothing: on 2026-09-23 the static `/sitemap.xml` measured 0.40s and 1.84s minutes apart. Use Vercel Speed Insights or CrUX after a few days for the real number.

### On AI crawlers

`robots.ts` allows the public routes under `User-agent: *`, so there is no evidence a rule needs adding. Before adding one, check the Vercel firewall configuration and real access logs for whether the AI crawlers are reaching the site at all. Allowing a search crawler such as OAI-SearchBot is a separate decision from allowing training crawlers (https://developers.openai.com/api/docs/bots). Treat static rendering, schema and `llms.txt` as good hygiene, not as a guarantee of being cited — Google's own guidance asks for sound SEO fundamentals and worthwhile content, and does not ask for AI-specific schema (https://developers.google.com/search/docs/fundamentals/ai-optimization-guide).

## Rollback

Each task is one commit and reverts cleanly on its own, except that Task 5 depends on 1-4 and Task 6 depends on 5. Reverting Task 1 alone restores `app/layout.tsx`, `app/page.tsx` and `app/forbidden.tsx`; reverting it while Task 5 is in place puts the storefront back to dynamic but leaves the build guard failing, so revert Task 5 first.
