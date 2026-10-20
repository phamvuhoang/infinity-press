import { describe, expect, it } from "vitest";

import {
  getInterfaceLocale,
  getPathLocale,
  isLocale,
  resolveLocale,
  withLocale,
} from "@/lib/i18n/config";

describe("locale routing", () => {
  it("accepts only supported locales", () => {
    expect(isLocale("vi")).toBe(true);
    expect(isLocale("ja")).toBe(false);
  });

  it("prefixes an application path", () => {
    expect(withLocale("vi", "/account")).toBe("/vi/account");
  });

  it.each([
    ["en", "en"],
    ["ja", "vi"],
    [null, "vi"],
  ])("resolves the submitted locale %j", (value, expected) => {
    expect(resolveLocale(value)).toBe(expected);
  });

  it.each([
    ["/en/library", "en"],
    ["/en", "en"],
    ["/internal/en/sign-in", "en"],
    ["/admin/books", "vi"],
    ["/ja/library", "vi"],
    ["/", "vi"],
  ])("reads the locale of %s", (pathname, expected) => {
    expect(getPathLocale(pathname)).toBe(expected);
  });

  it.each([
    ["/admin", "en"],
    ["/admin/books/new", "en"],
    ["/vi/account", "vi"],
    ["/en/account", "en"],
    ["/internal/vi/sign-in", "vi"],
    ["/administrators", "vi"],
    ["/", "vi"],
  ])("renders %s in the interface locale %s", (pathname, expected) => {
    expect(getInterfaceLocale(pathname)).toBe(expected);
  });
});
