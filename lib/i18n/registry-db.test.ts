import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { localeRegistry, locales } from "@/lib/i18n/config";

// The TypeScript registry and the database registry must list the same UI locales. This reads the
// seed the migration inserts; a locale added to config.ts without a migration (or the reverse) fails here.
const migration = readFileSync(join(process.cwd(), "supabase/migrations/20261020100000_press_locales.sql"), "utf8");
const seed = /insert into public\.supported_locales \(code, native_name\) values\s*([^;]+);/.exec(migration)?.[1] ?? "";
const seeded = Object.fromEntries([...seed.matchAll(/\('([^']+)',\s*'([^']+)'\)/g)].map((m) => [m[1], m[2]]));

describe("locale registry matches the supported_locales seed", () => {
  it("has the same codes", () => {
    expect(Object.keys(seeded).sort()).toEqual([...locales].sort());
  });

  it.each(locales)("%s has the same native name", (locale) => {
    expect(seeded[locale]).toBe(localeRegistry[locale].nativeName);
  });
});
