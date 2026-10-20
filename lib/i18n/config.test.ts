import { describe, expect, it } from "vitest";

import {
  defaultLocale,
  getInterfaceLocale,
  getPathLocale,
  isLocale,
  localeRegistry,
  locales,
  resolveLocale,
  withLocale,
} from "@/lib/i18n/config";

describe("locale registry", () => {
  it("lists vi, en and ja, each with a native name, Intl tag and direction", () => {
    expect([...locales].sort()).toEqual(["en", "ja", "vi"]);
    expect(localeRegistry.ja).toMatchObject({ nativeName: "日本語", intlTag: "ja-JP", openGraph: "ja_JP", dir: "ltr" });
    expect(localeRegistry.vi.nativeName).toBe("Tiếng Việt");
    expect(localeRegistry.en.intlTag).toBe("en-US");
  });

  it("defaults the interface to English", () => {
    expect(defaultLocale).toBe("en");
  });
});

describe("locale routing", () => {
  it("accepts only supported locales", () => {
    expect(isLocale("vi")).toBe(true);
    expect(isLocale("ja")).toBe(true);
    expect(isLocale("fr")).toBe(false);
  });

  it("prefixes an application path", () => {
    expect(withLocale("ja", "/account")).toBe("/ja/account");
  });

  it.each([
    ["en", "en"],
    ["ja", "ja"],
    ["fr", "en"],
    [null, "en"],
  ])("resolves the submitted locale %j", (value, expected) => {
    expect(resolveLocale(value)).toBe(expected);
  });

  it.each([
    ["/en/library", "en"],
    ["/ja/library", "ja"],
    ["/vi", "vi"],
    ["/internal/ja/sign-in", "ja"],
    ["/admin/books", "en"],
    ["/fr/library", "en"],
    ["/", "en"],
  ])("reads the locale of %s", (pathname, expected) => {
    expect(getPathLocale(pathname)).toBe(expected);
  });

  it.each([
    ["/admin", "en"],
    ["/admin/books/new", "en"],
    ["/vi/account", "vi"],
    ["/ja/account", "ja"],
    ["/internal/vi/sign-in", "vi"],
    ["/administrators", "en"],
    ["/", "en"],
  ])("renders %s in the interface locale %s", (pathname, expected) => {
    expect(getInterfaceLocale(pathname)).toBe(expected);
  });
});
