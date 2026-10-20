import { readFile } from "node:fs/promises";

import { parseServerEnv } from "@/lib/config/server-env-schema";

// Loads .env.local the same way `next build` does, for a bare `npm run check:prerender` - this
// script runs as its own process after the build, so it does not inherit whatever environment
// `next build` read unless the shell already had it exported. Not an error if the file is absent
// (CI exports the environment directly instead). See scripts/ebook.ts for the same pattern.
try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local - fall back to whatever the shell/CI already exported.
}

// The storefront's whole point is to be served from the edge. Five separate request-time reads had
// to be removed to get here (see docs/superpowers/plans/2026-09-23-storefront-static-caching.md),
// and any one of them coming back would silently send `private, no-store` again. This fails the
// build instead.
//
// This guard is also the only net for something unit tests cannot catch: a client component
// calling useSearchParams() outside a <Suspense> boundary silently makes its whole route dynamic,
// and jsdom does not enforce that rule - a component test can pass green while the route it renders
// on is dynamic in the real build.
//
// Two independent questions, deliberately kept apart (Ruling 15 - conflating them once already
// broke CI, because the e2e job's stack starts with an empty catalog and Playwright's `webServer`
// builds before any spec seeds anything):
//
// 1. REGISTRATION (default, always runs, needs no catalog data and no Supabase credentials): did a
//    route silently go fully dynamic? A route with `generateStaticParams` keeps a `dynamicRoutes`
//    manifest entry even when it returns zero slugs - confirmed directly: an empty array and a
//    populated one write byte-for-byte identical entries. The ONLY way that entry disappears is a
//    real request-time read (cookies(), headers(), searchParams) creeping back into the render
//    tree, which is exactly the failure this whole plan exists to prevent. So this check means
//    something with zero rows in the database, which is what makes it safe as the always-on default
//    - including a developer's local `npm run check` with no `.env.local`.
//
// 2. CONTENT (opt-in, `--require-content`): did `generateStaticParams` actually produce a concrete
//    page? This is a data question, not a dynamism one. Ruling 13 only carved bundles out as
//    legitimately-empty; Ruling 16 corrected that reasoning - "zero rows" turns out to be normal for
//    most of this catalog. `CatalogBookCard.series` is nullable and `topics` can be an empty array,
//    so a catalog of standalone books with no series or topic relations is a completely valid
//    product state, and requiring a concrete page there would fail a correct build the moment the
//    last relation was removed. Only "books" (the storefront needs at least one published book to
//    mean anything at all) and the home page (which renders concretely from the locale params alone
//    - it needs no book to produce /vi and /en, so requiring it costs nothing) are safe to always
//    require in this mode.
const REGISTRATION_REQUIRED = [
  "/[lang]/authors/[slug]",
  "/[lang]/books/[slug]",
  "/[lang]/bundles/[slug]",
  "/[lang]/series/[slug]",
  "/[lang]/topics/[slug]",
  // S12 knowledge detail pages: same generateStaticParams pattern (lib/knowledge/static-params.ts).
  "/[lang]/ideas/[slug]",
  "/[lang]/articles/[slug]",
];

// "/[lang]" (home) has no `generateStaticParams` of its own, so unlike the detail routes above it has
// no "registered but empty" middle state - it is either concretely rendered for both locales, or
// fully dynamic with no manifest trace at all. A build with no server environment makes it
// legitimately, deliberately fully dynamic (app/[lang]/layout.tsx and the home page both call
// deferPrerenderWithoutServerEnv()), which looks identical in the manifest to the actual regression
// this check exists to catch. So home's registration is only required when the build had the same
// server environment the app itself checks before deciding to defer (Ruling 17) - it is still one
// of "all six routes" this script knows about, just conditionally required rather than
// unconditionally, the same way the app itself is conditional.
const HOME_ROUTE = "/[lang]";

// The S12 knowledge indexes are built exactly like home: no params of their own, and the page and
// its metadata call deferPrerenderWithoutServerEnv(). So they are required under the same condition.
const ENV_DEPENDENT_ROUTES = [HOME_ROUTE, "/[lang]/ideas", "/[lang]/articles"];

const CONTENT_REQUIRED = [HOME_ROUTE, "/[lang]/books/[slug]"];

type PrerenderManifest = {
  routes: Record<string, unknown>;
  dynamicRoutes: Record<string, { routeRegex: string }>;
};

function hasConcretePath(manifest: PrerenderManifest, route: string): boolean {
  if (route in manifest.routes) return true; // a literal, param-free route (e.g. "/vi")

  const dynamic = manifest.dynamicRoutes[route];
  if (!dynamic) return false;
  const pattern = new RegExp(dynamic.routeRegex);
  return Object.keys(manifest.routes).some((key) => pattern.test(key));
}

async function main() {
  const requireContent = process.argv.includes("--require-content");
  const manifest = JSON.parse(await readFile(".next/prerender-manifest.json", "utf8")) as PrerenderManifest;

  // The same environment the app itself checks (lib/config/build-environment.ts) before deferring
  // home and the root layout's metadata to request time - not lib/config/server-env.ts directly,
  // which is `server-only` and cannot be imported into a plain script.
  let hasServerEnv = true;
  try {
    parseServerEnv(process.env);
  } catch {
    hasServerEnv = false;
  }

  const registered = new Set([...Object.keys(manifest.dynamicRoutes ?? {}), ...Object.keys(manifest.routes ?? {})]);
  const registrationTargets = hasServerEnv ? [...REGISTRATION_REQUIRED, ...ENV_DEPENDENT_ROUTES] : REGISTRATION_REQUIRED;
  const missing = registrationTargets.filter((route) => !registered.has(route));

  const failures: string[] = [];

  if (missing.length > 0) {
    failures.push(
      `These routes must be prerendered but are rendered on demand:\n  ${missing.join("\n  ")}\n\n` +
        "Something in their render tree reads cookies(), headers() or searchParams again.",
    );
  }

  if (!hasServerEnv) {
    console.log(
      `No server environment - skipping the ${ENV_DEPENDENT_ROUTES.join(", ")} registration check, since they ` +
        "legitimately go fully dynamic without one (deferPrerenderWithoutServerEnv()). The detail routes stay checked: " +
        "they register even with zero rows, so losing their entry still means a real regression, not a data gap.",
    );
  }

  if (requireContent) {
    const empty = CONTENT_REQUIRED.filter((route) => !hasConcretePath(manifest, route));
    if (empty.length > 0) {
      failures.push(
        `--require-content: these routes produced no concrete page for any locale:\n  ${empty.join("\n  ")}\n\n` +
          "Either the catalog this build read from is empty (seed a book before building) or the environment " +
          "was missing (this mode needs real credentials, unlike the default registration-only check).",
      );
    }
  }

  if (failures.length > 0) {
    console.error(failures.join("\n\n"));
    process.exit(1);
  }

  console.log(
    requireContent
      ? `Registration and content checks passed (${registrationTargets.length} routes registered, ` +
          `${CONTENT_REQUIRED.length} with a concrete page).`
      : `Registration check passed (${registrationTargets.length} routes still prerenderable). ` +
          "Run with --require-content against a populated catalog to also verify concrete pages exist.",
  );
}

void main();
