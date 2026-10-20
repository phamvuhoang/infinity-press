import type { Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { getLocaleRoutes } from "@/lib/i18n/routes";

export type AccountSection = "library" | "orders" | "account";

// One list for every personal-area page, so adding a page updates every sidebar.
export function accountNavItems(
  locale: Locale,
  dictionary: Pick<Dictionary, "library" | "navigation" | "orders">,
  current: AccountSection,
) {
  const routes = getLocaleRoutes(locale);
  return [
    { href: routes.library, label: dictionary.library.shelfTitle, current: current === "library" },
    { href: routes.orders, label: dictionary.orders.navLabel, current: current === "orders" },
    { href: routes.account, label: dictionary.navigation.account, current: current === "account" },
  ];
}
