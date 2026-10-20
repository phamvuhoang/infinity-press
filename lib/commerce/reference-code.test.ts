import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ORDER_REFERENCE_ALPHABET, ORDER_REFERENCE_PATTERN, isOrderReference } from "@/lib/commerce/reference-code";

describe("isOrderReference", () => {
  it("accepts a well-formed reference in either case", () => {
    expect(isOrderReference("IB-7K3QX")).toBe(true);
    expect(isOrderReference("ib-7k3qx")).toBe(true);
  });

  it("rejects the ambiguous letters the alphabet excludes", () => {
    for (const code of ["IB-ILOU1", "IB-0OOO0".replace("0O", "OO")]) {
      expect(isOrderReference(code)).toBe(false);
    }
    expect(isOrderReference("IB-IIIII")).toBe(false);
    expect(isOrderReference("IB-LLLLL")).toBe(false);
    expect(isOrderReference("IB-OOOOO")).toBe(false);
    expect(isOrderReference("IB-UUUUU")).toBe(false);
  });

  it("rejects the wrong length, a missing prefix, and an email", () => {
    expect(isOrderReference("IB-7K3Q")).toBe(false);
    expect(isOrderReference("7K3QX")).toBe(false);
    expect(isOrderReference("buyer@example.test")).toBe(false);
  });

  it("anchors the pattern so it cannot match inside a longer string", () => {
    expect(ORDER_REFERENCE_PATTERN.test("prefix IB-7K3QX suffix")).toBe(false);
  });
});

// The alphabet is written out three times: here, in the SQL generator, and in the SQL format
// CHECK. Nothing else compares those copies, so a future edit to one and not the others would
// pass every other test in this file while the database mints codes isOrderReference() rejects -
// exactly the codes Task 10's admin search is built to find. This test reads the migration off
// disk and holds both SQL copies to the same alphabet as the TypeScript module.
describe("the migration's alphabet stays in sync with ORDER_REFERENCE_ALPHABET", () => {
  const migrationPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "supabase",
    "migrations",
    "20260922110000_order_reference_code.sql",
  );
  const migration = readFileSync(migrationPath, "utf8");

  // Expands a regex-style character class ("0-9ABC...") into the literal characters it matches,
  // so a range shorthand and a spelled-out string can be compared for equality.
  function expandCharacterClass(characterClass: string): string {
    let expanded = "";
    for (let i = 0; i < characterClass.length; ) {
      if (characterClass[i + 1] === "-" && i + 2 < characterClass.length) {
        for (
          let code = characterClass.charCodeAt(i);
          code <= characterClass.charCodeAt(i + 2);
          code += 1
        ) {
          expanded += String.fromCharCode(code);
        }
        i += 3;
      } else {
        expanded += characterClass[i];
        i += 1;
      }
    }
    return expanded;
  }

  it("generator function's alphabet literal matches ORDER_REFERENCE_ALPHABET", () => {
    const match = migration.match(/substr\('([0-9A-Z]+)'/);
    if (!match) {
      throw new Error(
        "could not find generate_order_reference's alphabet literal in the migration - " +
          "update this test's regex before trusting its result",
      );
    }
    expect(match[1]).toBe(ORDER_REFERENCE_ALPHABET);
  });

  it("format CHECK constraint's character class matches ORDER_REFERENCE_ALPHABET", () => {
    const match = migration.match(/reference_code ~ '\^IB-\[([^\]]+)\]\{5\}\$'/);
    if (!match) {
      throw new Error(
        "could not find the orders_reference_code_format CHECK in the migration - " +
          "update this test's regex before trusting its result",
      );
    }
    expect(expandCharacterClass(match[1])).toBe(ORDER_REFERENCE_ALPHABET);
  });
});
