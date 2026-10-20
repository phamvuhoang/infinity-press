import { describe, expect, it } from "vitest";

import { heroCropRect } from "@/lib/catalog/hero-crop";

describe("heroCropRect", () => {
  it("fills the source at zoom 1 when the aspects match", () => {
    expect(heroCropRect(1600, 900, 16 / 9, 1, 0.5, 0.5)).toEqual({ x: 0, y: 0, width: 1600, height: 900 });
  });

  it("takes the largest fitting rectangle when the source is wider than the aspect", () => {
    const rect = heroCropRect(2000, 1000, 4 / 5, 1, 0.5, 0.5);
    expect(rect.height).toBe(1000);
    expect(rect.width).toBe(800);
    expect(rect.x).toBe(600);
  });

  it("shrinks around the focal point as zoom rises", () => {
    const rect = heroCropRect(1600, 900, 16 / 9, 2, 0.25, 0.5);
    expect(rect.width).toBe(800);
    expect(rect.x).toBe(0);
  });

  it("keeps the rectangle inside the source for an extreme focal point", () => {
    const rect = heroCropRect(1600, 900, 16 / 9, 2, 1, 1);
    expect(rect.x + rect.width).toBe(1600);
    expect(rect.y + rect.height).toBe(900);
  });

  it("clamps zoom to the supported range", () => {
    expect(heroCropRect(1600, 900, 16 / 9, 0.1, 0.5, 0.5)).toEqual(heroCropRect(1600, 900, 16 / 9, 1, 0.5, 0.5));
    expect(heroCropRect(1600, 900, 16 / 9, 99, 0.5, 0.5)).toEqual(heroCropRect(1600, 900, 16 / 9, 3, 0.5, 0.5));
  });
});
