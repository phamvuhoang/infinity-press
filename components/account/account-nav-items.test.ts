import { describe, expect, it } from "vitest";

import { accountNavItems } from "@/components/account/account-nav-items";
import en from "@/lib/i18n/dictionaries/en.json";

describe("accountNavItems", () => {
  it("lists library, orders, and account with the current page marked", () => {
    expect(accountNavItems("en", en, "orders")).toEqual([
      { href: "/en/library", label: en.library.shelfTitle, current: false },
      { href: "/en/account/orders", label: "Orders", current: true },
      { href: "/en/account", label: en.navigation.account, current: false },
    ]);
  });
});
