import type { ReaderPreferences } from "@/lib/reader/types";

// Per-device reading preferences. They never reach the server: they are a property of the screen
// someone is reading on, not of their account, and syncing them would mean a phone's font size
// following them onto a desktop. No `server-only` import here - this module is for the client.

const STORAGE_KEY = "infinity-books.reader.preferences";

// The settings panel offers pixel sizes because that is what a reader understands; the engine takes
// a multiplier. 16px is the browser default body size and therefore the multiplier's 1.0 point.
export const READER_BASE_FONT_PX = 16;
export const READER_MIN_FONT_PX = 15;
export const READER_MAX_FONT_PX = 26;
export const READER_LINE_HEIGHTS = [1.5, 1.75, 2] as const;
export const READER_WIDTHS = ["narrow", "medium", "wide"] as const;
export const READER_FONT_FAMILIES = ["publisher", "serif", "sans"] as const;
export const READER_THEMES = ["light", "sepia", "dark"] as const;

// `medium` is 50rem, which is the fixed column width the reader used before S4, so a reader who
// never opens the panel sees exactly what they saw before.
export const READER_WIDTH_CLASS: Record<ReaderPreferences["width"], string> = {
  narrow: "max-w-[34rem]",
  medium: "max-w-[50rem]",
  wide: "max-w-[64rem]",
};

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  fontFamily: "publisher",
  fontScale: 1,
  lineHeight: 1.75,
  width: "medium",
  theme: "sepia",
};

export function fontScaleToPx(scale: number): number {
  const px = Math.round(scale * READER_BASE_FONT_PX);
  return Math.min(READER_MAX_FONT_PX, Math.max(READER_MIN_FONT_PX, px));
}

export function pxToFontScale(px: number): number {
  const clamped = Math.min(READER_MAX_FONT_PX, Math.max(READER_MIN_FONT_PX, Math.round(px)));
  return clamped / READER_BASE_FONT_PX;
}

function oneOf<T extends string>(options: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (options as readonly string[]).includes(value) ? (value as T) : fallback;
}

// Never throws, and falls back PER FIELD rather than all-or-nothing. A reader whose stored
// preferences were written by a different build - or corrupted - keeps whatever is still valid
// instead of having the whole set reset. Nothing here is authorization; the worst a hostile value
// can do is be ignored.
export function parseReaderPreferences(value: unknown): ReaderPreferences {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_READER_PREFERENCES };
  const candidate = value as Record<string, unknown>;

  const scale = candidate.fontScale;
  const scaleIsOffered =
    typeof scale === "number" &&
    Number.isFinite(scale) &&
    fontScaleToPx(scale) === Math.round(scale * READER_BASE_FONT_PX);

  const lineHeight = candidate.lineHeight;

  return {
    fontFamily: oneOf(READER_FONT_FAMILIES, candidate.fontFamily, DEFAULT_READER_PREFERENCES.fontFamily),
    fontScale: scaleIsOffered ? scale : DEFAULT_READER_PREFERENCES.fontScale,
    lineHeight:
      typeof lineHeight === "number" && (READER_LINE_HEIGHTS as readonly number[]).includes(lineHeight)
        ? lineHeight
        : DEFAULT_READER_PREFERENCES.lineHeight,
    width: oneOf(READER_WIDTHS, candidate.width, DEFAULT_READER_PREFERENCES.width),
    theme: oneOf(READER_THEMES, candidate.theme, DEFAULT_READER_PREFERENCES.theme),
  };
}

// Both halves are wrapped, like resolveDeviceId in reader-client.tsx: private mode, blocked site
// data, and some embedded browsers throw on access rather than returning null, and losing a font
// size must never cost someone their book.
export function loadReaderPreferences(): ReaderPreferences {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return { ...DEFAULT_READER_PREFERENCES };
    return parseReaderPreferences(JSON.parse(stored));
  } catch {
    return { ...DEFAULT_READER_PREFERENCES };
  }
}

export function saveReaderPreferences(preferences: ReaderPreferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // A reader whose browser refuses storage still gets the preference for this session; it simply
    // does not survive a reload. Nothing else depends on this succeeding.
  }
}
