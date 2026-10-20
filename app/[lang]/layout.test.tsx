import { describe, expect, it, vi } from "vitest";

import LocaleLayout from "@/app/[lang]/layout";

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
      params: Promise.resolve({ lang: "en" }),
    })) as React.ReactElement<{ lang: string }>;

    expect(element.type).toBe("html");
    expect(element.props.lang).toBe("en");
  });

  it("names the other locale for the other locale", async () => {
    const element = (await LocaleLayout({
      children: null,
      params: Promise.resolve({ lang: "vi" }),
    })) as React.ReactElement<{ lang: string }>;

    expect(element.props.lang).toBe("vi");
  });

  it("prerenders one page per supported locale", async () => {
    const { generateStaticParams } = await import("@/app/[lang]/layout");
    expect(generateStaticParams()).toEqual([{ lang: "vi" }, { lang: "en" }]);
  });

  // A layout cannot see a notFound() thrown by its own render (not-found.tsx replaces a child of
  // this layout, and can't render if the layout itself failed to). An unsupported locale has to
  // fall back to defaultLocale here instead of throwing, and be rejected by the page below - see
  // "every page under app/[lang] guards its own locale" below for the invariant this rests on.
  it("renders the default locale's document language for an unsupported locale, instead of throwing", async () => {
    const element = (await LocaleLayout({
      children: null,
      params: Promise.resolve({ lang: "fr" }),
    })) as React.ReactElement<{ lang: string }>;

    expect(element.type).toBe("html");
    expect(element.props.lang).toBe("vi");
  });
});
