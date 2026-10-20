# Next.js and Supabase Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the first Infinity Books web application with current stable web packages, Supabase email authentication, and a small shadcn/ui interface.

**Architecture:** Use the Next.js App Router and Server Components for pages. Use Supabase SSR clients for browser, server, and proxy contexts, with Server Actions for authentication mutations.

**Tech Stack:** Next.js, React, TypeScript, Tailwind CSS v4, shadcn/ui, Supabase JS, Supabase SSR, Vitest, Testing Library, ESLint

**Spec:** `docs/superpowers/specs/2026-09-10-nextjs-supabase-foundation-design.md`

## Global Constraints

- Use the current stable releases of Next.js, React, TypeScript, Tailwind CSS, and shadcn/ui.
- Do not use release candidates or canary packages.
- Use npm and commit `package-lock.json`.
- Use the App Router and React Server Components by default.
- Use TypeScript strict mode and the import alias `@/*`.
- Do not commit `.env.local` or a service-role key.
- Do not create or deploy the book catalog schema.
- Preserve the useful schema description in the existing README, but state that its schema files are absent.

---

### Task 1: Application foundation and test runner

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `.nvmrc`
- Create: `next.config.ts`
- Create: `postcss.config.mjs`
- Create: `eslint.config.mjs`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `vitest.setup.ts`
- Create: `app/layout.tsx`
- Create: `app/globals.css`
- Create: `app/page.tsx`
- Create: `public/`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: The repository root and the approved design.
- Produces: The `@/*` import alias, npm scripts, Tailwind theme, and a buildable App Router shell.

- [ ] **Step 1: Record the runtime and package baseline**

Run:

```bash
node --version
npm --version
npm view next version
npm view react version
npm view typescript version
npm view tailwindcss version
npm view shadcn version
```

Expected: Each package command prints a stable version without `canary`, `rc`, `beta`, or `alpha`.

- [ ] **Step 2: Scaffold the official Supabase starter in a temporary directory**

Run:

```bash
work_dir=$(mktemp -d)
npx create-next-app@latest "$work_dir/reference" --example with-supabase --use-npm
```

Expected: The command creates a working reference app outside the repository. Inspect its Supabase clients, proxy, and authentication routes. Do not copy its Git metadata or environment values.

- [ ] **Step 3: Create the application package files**

Create `package.json` with the stable versions found in Step 1 and these scripts:

```json
{
  "name": "infinity-books",
  "private": true,
  "engines": { "node": ">=22.0.0" },
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

Install application and development packages with npm so npm records exact resolved versions in `package-lock.json`:

```bash
npm install next@latest react@latest react-dom@latest @supabase/supabase-js@latest @supabase/ssr@latest class-variance-authority clsx tailwind-merge lucide-react
npm install -D typescript@latest @types/node@latest @types/react@latest @types/react-dom@latest tailwindcss@latest @tailwindcss/postcss@latest shadcn@latest tw-animate-css eslint@latest eslint-config-next@latest vitest@latest jsdom@latest @testing-library/react@latest @testing-library/jest-dom@latest
```

- [ ] **Step 4: Create the minimum application shell**

Create strict TypeScript, Next.js, PostCSS, ESLint, and Vitest configuration. Configure Vitest with `environment: "jsdom"`, `setupFiles: ["./vitest.setup.ts"]`, and the `@` alias to the repository root. Import `@testing-library/jest-dom/vitest` from `vitest.setup.ts`.

Create `app/layout.tsx` with metadata for Infinity Books, an English `html` element, and `app/globals.css`. Create `app/page.tsx` with a plain heading so the first build does not depend on later components.

- [ ] **Step 5: Make sure that the shell works**

Run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Expected: Lint, type checking, and build pass. Vitest exits successfully with no test files, or use `--passWithNoTests` in the test script if the installed Vitest requires it.

- [ ] **Step 6: Commit the foundation**

```bash
git add package.json package-lock.json .nvmrc next.config.ts postcss.config.mjs eslint.config.mjs tsconfig.json vitest.config.ts vitest.setup.ts app .gitignore
git commit -m "chore: scaffold Next.js application"
```

### Task 2: shadcn/ui foundation

**Files:**
- Create: `components.json`
- Create: `lib/utils.ts`
- Create: `components/ui/button.tsx`
- Create: `components/ui/card.tsx`
- Create: `components/ui/input.tsx`
- Create: `components/ui/label.tsx`
- Create: `components/ui/alert.tsx`
- Create: `components/ui/separator.tsx`
- Create: `lib/utils.test.ts`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: Tailwind CSS v4, the `@/*` alias, and the dependencies from Task 1.
- Produces: `cn(...inputs: ClassValue[]): string` and reusable shadcn/ui components.

- [ ] **Step 1: Write the failing class merge test**

Create `lib/utils.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

describe("cn", () => {
  it("keeps the last conflicting Tailwind class", () => {
    expect(cn("px-2", false && "hidden", "px-4")).toBe("px-4");
  });
});
```

- [ ] **Step 2: Run the test and observe the missing module failure**

Run: `npm test -- lib/utils.test.ts`

Expected: FAIL because `@/lib/utils` does not exist.

- [ ] **Step 3: Initialize shadcn/ui and add the selected components**

Run:

```bash
npx shadcn@latest init --defaults
npx shadcn@latest add button card input label alert separator
```

Keep the Tailwind v4 CSS variables and generated `components.json`. If the CLI asks for a base color, use Neutral. Make sure that `lib/utils.ts` exports the tested `cn` function.

- [ ] **Step 4: Run the focused and static tests**

Run:

```bash
npm test -- lib/utils.test.ts
npm run lint
npm run typecheck
```

Expected: All commands pass.

- [ ] **Step 5: Commit the UI foundation**

```bash
git add components.json components lib app/globals.css
git commit -m "feat: add shadcn UI foundation"
```

### Task 3: Environment validation and Supabase clients

**Files:**
- Create: `.env.example`
- Create: `.env.local`
- Create: `lib/supabase/env.ts`
- Create: `lib/supabase/env.test.ts`
- Create: `lib/supabase/client.ts`
- Create: `lib/supabase/server.ts`
- Create: `lib/supabase/proxy.ts`
- Create: `proxy.ts`

**Interfaces:**
- Consumes: `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
- Produces: `getSupabaseEnv()`, browser `createClient()`, async server `createClient()`, and `updateSession(request: NextRequest)`.

- [ ] **Step 1: Write failing environment tests**

Create `lib/supabase/env.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getSupabaseEnv } from "@/lib/supabase/env";

describe("getSupabaseEnv", () => {
  it("returns a valid public configuration", () => {
    expect(getSupabaseEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    })).toEqual({
      url: "https://example.supabase.co",
      publishableKey: "sb_publishable_test",
    });
  });

  it("rejects a missing value", () => {
    expect(() => getSupabaseEnv({})).toThrow("Supabase environment variables are missing or invalid");
  });
});
```

- [ ] **Step 2: Run the test and observe the missing module failure**

Run: `npm test -- lib/supabase/env.test.ts`

Expected: FAIL because `@/lib/supabase/env` does not exist.

- [ ] **Step 3: Implement environment validation**

Create `getSupabaseEnv(values: Record<string, string | undefined>)` in `lib/supabase/env.ts`. Return `{ url, publishableKey }` when both values are nonempty and the URL uses HTTPS. Throw `Supabase environment variables are missing or invalid` for any invalid input.

Create `.env.example` with placeholders. Create ignored `.env.local` with the supplied project URL and publishable key.

- [ ] **Step 4: Create clients from the official SSR pattern**

Create the browser client with `createBrowserClient`. Create the server client with `createServerClient` and the async `cookies()` API. Create `updateSession` with request and response cookie adapters, call `supabase.auth.getUser()`, and protect `/account` routes. Create root `proxy.ts` with a matcher that skips static assets.

Do not log environment values. Do not place the key directly in a TypeScript file.

- [ ] **Step 5: Run focused and static tests**

Run:

```bash
npm test -- lib/supabase/env.test.ts
npm run lint
npm run typecheck
```

Expected: All commands pass.

- [ ] **Step 6: Commit safe Supabase files**

```bash
git add .env.example lib/supabase proxy.ts
git commit -m "feat: configure Supabase SSR clients"
```

Make sure that `.env.local` does not appear in `git status --short`.

### Task 4: Redirect safety and authentication callback

**Files:**
- Create: `lib/auth/redirect.ts`
- Create: `lib/auth/redirect.test.ts`
- Create: `app/auth/callback/route.ts`

**Interfaces:**
- Consumes: A requested redirect string and the server Supabase client.
- Produces: `getSafeRedirect(value: string | null, fallback?: string): string` and `GET(request: NextRequest): Promise<NextResponse>`.

- [ ] **Step 1: Write failing redirect tests**

Create `lib/auth/redirect.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getSafeRedirect } from "@/lib/auth/redirect";

describe("getSafeRedirect", () => {
  it("accepts a local absolute path", () => {
    expect(getSafeRedirect("/account?welcome=1")).toBe("/account?welcome=1");
  });

  it.each(["https://evil.example", "//evil.example", "account"])(
    "rejects unsafe redirect %s",
    (value) => expect(getSafeRedirect(value)).toBe("/account"),
  );
});
```

- [ ] **Step 2: Run the test and observe the missing module failure**

Run: `npm test -- lib/auth/redirect.test.ts`

Expected: FAIL because `@/lib/auth/redirect` does not exist.

- [ ] **Step 3: Implement redirect safety and callback exchange**

Implement `getSafeRedirect` so it accepts a single-slash local path and rejects protocol-relative or external values. In the callback route, read `code` and `next`, call `supabase.auth.exchangeCodeForSession(code)`, and redirect to the safe path. Redirect failures to `/sign-in?error=callback`.

- [ ] **Step 4: Run focused and static tests**

Run:

```bash
npm test -- lib/auth/redirect.test.ts
npm run lint
npm run typecheck
```

Expected: All commands pass.

- [ ] **Step 5: Commit callback behavior**

```bash
git add lib/auth app/auth/callback
git commit -m "feat: add safe Supabase auth callback"
```

### Task 5: Authentication actions and forms

**Files:**
- Create: `lib/auth/validation.ts`
- Create: `lib/auth/validation.test.ts`
- Create: `app/auth/actions.ts`
- Create: `components/auth/auth-message.tsx`
- Create: `components/auth/submit-button.tsx`
- Create: `components/auth/sign-out-button.tsx`
- Create: `app/sign-in/page.tsx`
- Create: `app/sign-up/page.tsx`
- Create: `app/forgot-password/page.tsx`
- Create: `app/update-password/page.tsx`

**Interfaces:**
- Consumes: Supabase server `createClient()`, `FormData`, and shadcn/ui form controls.
- Produces: `readCredentials(formData)`, sign-in, sign-up, sign-out, recovery, and password-update Server Actions.

- [ ] **Step 1: Write failing credential validation tests**

Create `lib/auth/validation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readCredentials, readPasswordUpdate } from "@/lib/auth/validation";

function form(values: Record<string, string>) {
  const data = new FormData();
  Object.entries(values).forEach(([key, value]) => data.set(key, value));
  return data;
}

describe("readCredentials", () => {
  it("normalizes a valid email", () => {
    expect(readCredentials(form({ email: " Reader@Example.com ", password: "bookcase" }))).toEqual({
      ok: true,
      data: { email: "reader@example.com", password: "bookcase" },
    });
  });

  it("rejects a missing email", () => {
    expect(readCredentials(form({ password: "bookcase" }))).toEqual({
      ok: false,
      error: "Enter a valid email address.",
    });
  });

  it("rejects a short password", () => {
    expect(readCredentials(form({ email: "reader@example.com", password: "short" }))).toEqual({
      ok: false,
      error: "Password must contain at least 8 characters.",
    });
  });
});

describe("readPasswordUpdate", () => {
  it("rejects passwords that do not match", () => {
    expect(readPasswordUpdate(form({ password: "bookcase", confirmPassword: "bookshelf" }))).toEqual({
      ok: false,
      error: "Passwords do not match.",
    });
  });
});
```

- [ ] **Step 2: Run the test and observe the missing module failure**

Run: `npm test -- lib/auth/validation.test.ts`

Expected: FAIL because `@/lib/auth/validation` does not exist.

- [ ] **Step 3: Implement minimal validation helpers**

Implement `readCredentials(formData: FormData)` and `readPasswordUpdate(formData: FormData)`. Both helpers return discriminated unions:

```ts
type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };
```

Require a syntactically valid email and an eight-character password. Require matching passwords for password updates.

- [ ] **Step 4: Implement the Server Actions**

Use `signInWithPassword`, `signUp`, `signOut`, `resetPasswordForEmail`, and `updateUser`. Build recovery and confirmation redirects from the request origin. Map failures to short query-string codes and render fixed copy for those codes. Never put a raw Supabase error in a URL.

- [ ] **Step 5: Create accessible authentication forms**

Use labels bound to inputs, correct autocomplete values, required fields, pending submit states, and links between authentication pages. Use the shared card, input, label, button, separator, and alert components.

- [ ] **Step 6: Run authentication tests and build checks**

Run:

```bash
npm test -- lib/auth
npm run lint
npm run typecheck
npm run build
```

Expected: All commands pass and all authentication routes appear in the build output.

- [ ] **Step 7: Commit authentication pages**

```bash
git add lib/auth app/auth/actions.ts app/sign-in app/sign-up app/forgot-password app/update-password components/auth
git commit -m "feat: add Supabase authentication flow"
```

### Task 6: Public home and protected account pages

**Files:**
- Modify: `app/page.tsx`
- Create: `app/account/page.tsx`
- Create: `components/site-header.tsx`
- Modify: `app/layout.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: The server Supabase client, authentication actions, and shadcn/ui components.
- Produces: A public Infinity Books landing page, session-aware navigation, and a protected account page.

- [ ] **Step 1: Write the account page behavior**

Create an async Server Component. Call `supabase.auth.getUser()`. Redirect missing users to `/sign-in?next=/account`. Show the validated email and a sign-out button for an authenticated user.

- [ ] **Step 2: Build the session-aware header**

Call `getUser()` on the server. Show sign-in and sign-up links for guests. Show account and sign-out controls for authenticated users.

- [ ] **Step 3: Build the Infinity Books home page**

Create a responsive hero, a short product statement, and clear authentication calls to action. Use semantic landmarks and the neutral bookshop theme. Do not imply that catalog, checkout, or reader features already work.

- [ ] **Step 4: Make sure that pages build**

Run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Expected: All commands pass. The build includes `/`, `/account`, and all authentication routes.

- [ ] **Step 5: Commit application pages**

```bash
git add app components/site-header.tsx
git commit -m "feat: add Infinity Books application pages"
```

### Task 7: Documentation and final connection checks

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: All commands, routes, and environment names from Tasks 1 through 6.
- Produces: Accurate setup, Supabase dashboard, development, test, and build instructions.

- [ ] **Step 1: Rewrite the README for the application**

Document Node and npm requirements, `npm install`, `.env.local`, `npm run dev`, tests, lint, type checking, and production build. Document these Supabase Auth URLs for local work:

```text
Site URL: http://localhost:3000
Redirect URL: http://localhost:3000/auth/callback
Redirect URL: http://localhost:3000/update-password
```

Keep the old domain list as planned future schema scope. State that the migration and seed files described by the earlier README are not in this checkout.

- [ ] **Step 2: Make a read-only Supabase connection probe**

Run a request to the project REST root with the publishable key loaded from `.env.local`. Do not print the key. Expect an HTTP response from the supplied Supabase project. Treat a database permission response as proof of network connection, not as proof that an application table exists.

- [ ] **Step 3: Run the complete verification suite**

Run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
git diff --check
git status --short
```

Expected: The first five commands pass. Git shows only the planned README change before the documentation commit. `.env.local` remains ignored.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md
git commit -m "docs: add application setup guide"
```

- [ ] **Step 5: Inspect the final repository state**

Run:

```bash
git status --short
git log --oneline -8
```

Expected: The worktree is clean and the log contains the task commits. Record that email delivery and dashboard redirect configuration still need a manual end-to-end test.
