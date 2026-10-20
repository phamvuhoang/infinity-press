import { headers } from "next/headers";

import { ForbiddenPage } from "@/components/forbidden-page";
import { localeHeader, resolveLocale } from "@/lib/i18n/config";

// Rendered by the `forbidden()` interrupt (see lib/auth/admin.ts), reachable from staff routes
// under /internal (e.g. app/internal/[lang]/update-password/page.tsx, app/auth/actions.ts). A
// route that can throw forbidden() has already called an auth gate, so it is dynamic by
// definition - reading the request here does not undermine any prerendering.
export default async function Forbidden() {
  const locale = resolveLocale((await headers()).get(localeHeader));

  return <ForbiddenPage locale={locale} />;
}
