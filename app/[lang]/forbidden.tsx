import { ForbiddenPage } from "@/components/forbidden-page";
import { defaultLocale } from "@/lib/i18n/config";

// Rendered by the `forbidden()` interrupt (see lib/auth/admin.ts). A route that can throw
// forbidden() has already called an auth gate, so it is dynamic by definition when a visitor
// actually reaches it - but this file is still part of the render tree Next has to be able to
// produce while prerendering every OTHER route in the segment, the ones that never throw. It used
// to read the locale from the request header the same way app/[lang]/not-found.tsx did. Having
// EITHER of those two boundary files depend on headers() was enough, on its own, to stop every
// route under /[lang] from prerendering with concrete params - not just the boundary files
// themselves. Measured directly: hardcoding this file alone changed nothing; hardcoding this file
// AND not-found.tsx together produced ● pages with real paths across the storefront. Renaming the
// segment folder to [lang] (see app/[lang]/layout.tsx) was tried first and did NOT fix this - that
// rename's necessity is unproven; this is the actual cause. See
// docs/runbooks/storefront-caching.md ("The bug that cost the longest bisection") for the
// bisection. So this renders the default locale's copy always: a signed-in non-admin on /en who
// gets forbidden sees Vietnamese copy, a small and deliberate price for the whole segment staying
// static. In practice forbidden() only ever fires from requireAdmin(), which no storefront page
// calls, so this file is close to unreachable from a real customer's path.
export default function Forbidden() {
  const locale = defaultLocale;

  return <ForbiddenPage locale={locale} />;
}
