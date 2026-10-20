import { describe, expect, it, vi } from "vitest";

import SharedQuotesPage from "@/app/[lang]/(account)/library/quotes/page";
import { requireUser } from "@/lib/auth/session";
import { listMySharedQuotes } from "@/lib/data/shared-quotes";

vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("next/navigation", () => ({ notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }) }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/data/shared-quotes", () => ({ listMySharedQuotes: vi.fn() }));
vi.mock("./actions", () => ({ removeSharedQuoteAction: vi.fn() }));

describe("SharedQuotesPage authorization", () => {
  it("never reads the list when the session gate rejects", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("NEXT_REDIRECT /en/sign-in"));
    await expect(SharedQuotesPage({ params: Promise.resolve({ lang: "en" }) })).rejects.toThrow("NEXT_REDIRECT");
    expect(listMySharedQuotes).not.toHaveBeenCalled();
  });
});
