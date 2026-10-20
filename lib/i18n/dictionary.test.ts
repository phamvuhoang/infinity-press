import { describe, expect, it } from "vitest";

import { locales } from "@/lib/i18n/config";
import en from "@/lib/i18n/dictionaries/en.json";
import ja from "@/lib/i18n/dictionaries/ja.json";
import vi from "@/lib/i18n/dictionaries/vi.json";

const dictionaries = { en, ja, vi } as const;

function leaves(value: unknown, prefix = ""): [string, string][] {
  if (typeof value === "string") return [[prefix, value]];
  if (typeof value !== "object" || value === null) return [[prefix, ""]];
  return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key));
}

const tokens = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("dictionaries", () => {
  it("has one dictionary per registered locale", () => {
    expect(Object.keys(dictionaries).sort()).toEqual([...locales].sort());
  });

  it.each(locales)("%s translates exactly the keys English does", (locale) => {
    const paths = (dictionary: unknown) => leaves(dictionary).map(([path]) => path).sort();
    expect(paths(dictionaries[locale])).toEqual(paths(en));
  });

  it.each(locales)("%s has no empty translations", (locale) => {
    expect(leaves(dictionaries[locale]).filter(([, text]) => text.trim() === "")).toEqual([]);
  });

  it.each(locales)("%s keeps every {placeholder} English uses, and adds none", (locale) => {
    const english = new Map(leaves(en));
    const mismatched = leaves(dictionaries[locale])
      .filter(([path, text]) => tokens(text).join() !== tokens(english.get(path) ?? "").join())
      .map(([path]) => path);
    expect(mismatched).toEqual([]);
  });
});
