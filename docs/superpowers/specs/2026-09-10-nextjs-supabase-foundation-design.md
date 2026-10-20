# Next.js and Supabase foundation

## Goal

Create the first web application for Infinity Books. Use the current stable releases of Next.js, React, TypeScript, Tailwind CSS, and shadcn/ui. Connect the application to the supplied Supabase project and include a complete email and password authentication flow.

## Starting point

The repository contains a README and a `.gitignore` file. It does not contain application code or the database files that the README describes. This work creates a new application in the repository root and does not create the book catalog schema.

## Selected approach

Use the official Supabase `with-supabase` starter as the reference implementation. Create the application in the repository root, then align every package with its current stable release. Initialize shadcn/ui with Tailwind CSS v4 and add only the components that the first pages use.

This approach follows the current Supabase patterns for Next.js. It also gives the application one maintained authentication pattern for browser code, server code, and session cookies.

## Application structure

Use the Next.js App Router and React Server Components by default. A Server Component runs on the server and sends rendered output to the browser. Use Client Components only for interactive forms and controls.

Keep these main areas:

- `app/` contains routes, layouts, loading states, and route handlers.
- `components/` contains application components and generated shadcn/ui components.
- `lib/supabase/` contains browser, server, and proxy clients.
- `lib/` contains shared utilities.
- `proxy.ts` refreshes authentication cookies before protected routes load.

The public home page introduces Infinity Books and links to authentication. The account page is protected and displays the authenticated user identity. Authentication routes cover sign-up, sign-in, sign-out, forgot-password, password update, and the email callback.

## Supabase connection

Use `@supabase/supabase-js` for the API client. Use `@supabase/ssr` for cookie-based authentication in server rendering.

Set these local variables in `.env.local`:

```text
NEXT_PUBLIC_SUPABASE_URL=https://hovmnfwnqkxsnoztguni.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<provided publishable key>
```

Do not commit `.env.local`. Commit `.env.example` with placeholders and descriptions. The publishable key is safe for browser use, but Row Level Security must protect all exposed data.

Do not add a service-role key. This initial application does not require privileged database access.

## Authentication flow

The browser submits forms through Server Actions. A Server Action is a server function that a form can call directly. The action validates required input, calls Supabase Auth, and returns a safe error to the page.

Supabase sends email confirmation and password recovery links to the callback route. The callback exchanges its code for a session, then sends the user to the requested safe local route. The proxy refreshes expired sessions and sends unauthenticated account requests to sign-in.

Use `getUser()` for server authorization because Supabase validates that result with the Auth server. Do not trust cookie data alone for access decisions.

## User interface

Use Tailwind CSS v4 for tokens and layout. Use shadcn/ui components for buttons, cards, labels, inputs, alerts, and separators. Keep generated component source in the repository so the application does not depend on a hosted component service at runtime.

Use accessible labels, visible focus states, clear form errors, and pending button states. The initial visual theme uses neutral bookshop colors and responsive layouts. This work does not include catalog, checkout, or reader interfaces.

## Error handling

Show a short error near the form that caused it. Do not expose stack traces, credentials, or raw internal failures. Send an authenticated user away from guest-only pages and send an unauthenticated user away from protected pages.

If Supabase is unavailable, keep the public page available. Authentication pages show a useful connection error after a user submits a form.

## Package and runtime policy

Resolve current stable package versions during implementation and record exact resolved versions in `package-lock.json`. Use npm because the repository has no existing package manager. Define a supported Node.js version in `package.json` and an `.nvmrc` file when the selected Next.js release requires it.

Do not use release candidates or canary packages. TypeScript uses strict mode and the import alias `@/*`.

## Documentation

Update the README with installation, environment, development, test, build, and Supabase Auth redirect instructions. Keep its useful schema description, but state that the described schema files are not present instead of claiming that they exist.

Document the required Supabase dashboard URLs for local authentication. Do not make remote dashboard changes without separate authority and credentials.

## Tests and acceptance

Add focused tests for validation and redirect safety when those rules live in independent functions. Make sure that the following commands succeed:

```text
npm run lint
npm run typecheck
npm test
npm run build
```

Make sure that the home and authentication routes compile. Make a read-only connection probe to the supplied Supabase project when the available API permits it. Authentication email delivery and dashboard redirect configuration require a manual end-to-end test.

## Excluded work

This work does not create or deploy the 106-table schema described in the old README. It does not add social login, payments, storage buckets, book catalog pages, checkout, or deployment configuration. These features need separate designs and database requirements.
