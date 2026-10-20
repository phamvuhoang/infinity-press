import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_READER_PREFERENCES,
  READER_MAX_FONT_PX,
  READER_MIN_FONT_PX,
  fontScaleToPx,
  loadReaderPreferences,
  parseReaderPreferences,
  pxToFontScale,
  saveReaderPreferences,
} from "@/lib/reader/preferences";

const STORAGE_KEY = "infinity-books.reader.preferences";

describe("font size mapping", () => {
  it("round-trips every offered size", () => {
    for (let px = READER_MIN_FONT_PX; px <= READER_MAX_FONT_PX; px += 1) {
      expect(fontScaleToPx(pxToFontScale(px))).toBe(px);
    }
  });

  it("clamps a scale from outside the offered range back into it", () => {
    expect(fontScaleToPx(0.1)).toBe(READER_MIN_FONT_PX);
    expect(fontScaleToPx(10)).toBe(READER_MAX_FONT_PX);
  });
});

describe("parseReaderPreferences", () => {
  it("returns the defaults for a value that is not an object", () => {
    expect(parseReaderPreferences(null)).toEqual(DEFAULT_READER_PREFERENCES);
    expect(parseReaderPreferences("nonsense")).toEqual(DEFAULT_READER_PREFERENCES);
  });

  // Per field, not all-or-nothing: a reader who has set a theme should not lose it because a later
  // version of the panel wrote a field this build does not understand.
  it("keeps the fields it understands and defaults the rest", () => {
    expect(parseReaderPreferences({ theme: "dark", fontFamily: "moon", width: "wide" })).toEqual({
      ...DEFAULT_READER_PREFERENCES,
      theme: "dark",
      width: "wide",
    });
  });

  it("refuses a font scale outside the offered range", () => {
    expect(parseReaderPreferences({ fontScale: 99 }).fontScale).toBe(DEFAULT_READER_PREFERENCES.fontScale);
  });

  it("refuses a line height that is not one of the offered values", () => {
    expect(parseReaderPreferences({ lineHeight: 3.9 }).lineHeight).toBe(DEFAULT_READER_PREFERENCES.lineHeight);
    expect(parseReaderPreferences({ lineHeight: 2 }).lineHeight).toBe(2);
  });
});

describe("storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips through localStorage", () => {
    const preferences = { ...DEFAULT_READER_PREFERENCES, theme: "dark" as const, width: "narrow" as const };
    saveReaderPreferences(preferences);
    expect(loadReaderPreferences()).toEqual(preferences);
  });

  it("starts new readers with 16px publisher font, medium spacing and width, and paper theme", () => {
    expect(loadReaderPreferences()).toEqual({
      fontFamily: "publisher",
      fontScale: 1,
      lineHeight: 1.75,
      width: "medium",
      theme: "sepia",
    });
  });

  it("preserves previously saved settings including the former defaults", () => {
    const preferences = {
      fontFamily: "publisher" as const,
      fontScale: 1,
      lineHeight: 1.5,
      width: "medium" as const,
      theme: "light" as const,
    };
    saveReaderPreferences(preferences);
    expect(loadReaderPreferences()).toEqual(preferences);
  });

  it("returns the defaults for a corrupt stored value", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadReaderPreferences()).toEqual(DEFAULT_READER_PREFERENCES);
  });

  // Private mode, blocked site data, and some embedded browsers throw on access rather than
  // returning null. A reader must still get their book.
  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(loadReaderPreferences()).toEqual(DEFAULT_READER_PREFERENCES);
    expect(() => saveReaderPreferences(DEFAULT_READER_PREFERENCES)).not.toThrow();

    vi.restoreAllMocks();
  });
});
