import { describe, expect, it } from "vitest";

import en from "@/lib/i18n/dictionaries/en.json";
import vi from "@/lib/i18n/dictionaries/vi.json";

function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];

  return Object.entries(value).flatMap(([key, child]) =>
    keyPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("dictionaries", () => {
  it("translate the same keys in every locale", () => {
    expect(keyPaths(vi).sort()).toEqual(keyPaths(en).sort());
  });

  it("contain no empty translations", () => {
    const empty = [en, vi].flatMap((dictionary) =>
      keyPaths(dictionary).filter((path) => {
        const text = path
          .split(".")
          .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], dictionary);
        return typeof text !== "string" || text.trim() === "";
      }),
    );

    expect(empty).toEqual([]);
  });
});
