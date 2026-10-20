import { describe, expect, it } from "vitest";

import { isReaderLocator, parseReaderLocator } from "@/lib/reader/engine";
import type { ReaderLocator } from "@/lib/reader/types";

const validLocator: ReaderLocator = {
  href: "chapter-01.xhtml",
  progression: 0.42,
  totalProgression: 0.1,
  locations: { cfi: "/4/2", position: 17 },
  text: { before: "...", highlight: "excerpt", after: "..." },
};

describe("isReaderLocator", () => {
  it("accepts a well-formed locator", () => {
    expect(isReaderLocator(validLocator)).toBe(true);
  });

  it("accepts a locator with a null totalProgression and no text", () => {
    expect(isReaderLocator({ ...validLocator, totalProgression: null, text: undefined })).toBe(true);
  });

  it("rejects progression well outside the tolerance band", () => {
    expect(isReaderLocator({ ...validLocator, progression: 1.5 })).toBe(false);
  });

  it("rejects a missing href", () => {
    expect(isReaderLocator({ ...validLocator, href: undefined })).toBe(false);
  });

  it("rejects a locations map with a non-primitive value", () => {
    expect(isReaderLocator({ ...validLocator, locations: { cfi: { nested: true } } })).toBe(false);
  });

  it("rejects a non-object value", () => {
    expect(isReaderLocator("not-a-locator")).toBe(false);
    expect(isReaderLocator(null)).toBe(false);
  });
});

describe("isReaderLocator progression epsilon tolerance", () => {
  it("accepts a progression a hair over 1 from floating-point rounding", () => {
    expect(isReaderLocator({ ...validLocator, progression: 1 + 1e-9 })).toBe(true);
  });

  it("accepts a progression a hair under 0 from floating-point rounding", () => {
    expect(isReaderLocator({ ...validLocator, progression: -1e-9 })).toBe(true);
  });

  it("accepts exact boundary values", () => {
    expect(isReaderLocator({ ...validLocator, progression: 0 })).toBe(true);
    expect(isReaderLocator({ ...validLocator, progression: 1 })).toBe(true);
  });

  it("still rejects NaN, Infinity, and values well outside the band", () => {
    expect(isReaderLocator({ ...validLocator, progression: Number.NaN })).toBe(false);
    expect(isReaderLocator({ ...validLocator, progression: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isReaderLocator({ ...validLocator, progression: Number.NEGATIVE_INFINITY })).toBe(false);
    expect(isReaderLocator({ ...validLocator, progression: 5 })).toBe(false);
    expect(isReaderLocator({ ...validLocator, progression: -0.3 })).toBe(false);
  });
});

describe("parseReaderLocator", () => {
  it("round-trips a valid locator through JSON serialization", () => {
    const restored = parseReaderLocator(JSON.parse(JSON.stringify(validLocator)));
    expect(restored).toEqual(validLocator);
  });

  it("throws on an invalid locator", () => {
    expect(() => parseReaderLocator({ href: "chapter-01.xhtml" })).toThrow();
  });

  it("clamps a progression a hair over 1 down to exactly 1", () => {
    expect(parseReaderLocator({ ...validLocator, progression: 1 + 1e-9 }).progression).toBe(1);
  });

  it("clamps a progression a hair under 0 up to exactly 0", () => {
    expect(parseReaderLocator({ ...validLocator, progression: -1e-9 }).progression).toBe(0);
  });

  it("leaves exact boundary values unchanged", () => {
    expect(parseReaderLocator({ ...validLocator, progression: 0 }).progression).toBe(0);
    expect(parseReaderLocator({ ...validLocator, progression: 1 }).progression).toBe(1);
  });

  it("applies the same epsilon clamp to totalProgression, preserving null", () => {
    expect(parseReaderLocator({ ...validLocator, totalProgression: 1 + 1e-9 }).totalProgression).toBe(1);
    expect(parseReaderLocator({ ...validLocator, totalProgression: null }).totalProgression).toBeNull();
  });

  it("drops untrusted extra top-level properties instead of passing them through", () => {
    const restored = parseReaderLocator({
      ...validLocator,
      deviceId: "attacker-controlled",
      payload: "x".repeat(10_000),
    });
    expect(Object.keys(restored).sort()).toEqual(["href", "locations", "progression", "text", "totalProgression"]);
    expect(restored).not.toHaveProperty("deviceId");
    expect(restored).not.toHaveProperty("payload");
  });

  it("omits text entirely rather than passing it through as undefined", () => {
    const restored = parseReaderLocator({ ...validLocator, text: undefined });
    expect(Object.keys(restored).sort()).toEqual(["href", "locations", "progression", "totalProgression"]);
    expect("text" in restored).toBe(false);
  });
});
