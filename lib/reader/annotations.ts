import type { ReaderLocator } from "@/lib/reader/types";
import { z } from "zod";

import { parseReaderLocator } from "@/lib/reader/engine";

export type HighlightColor = "yellow" | "green" | "rose";

export type AnnotationDraft =
  | {
      kind: "highlight";
      locator: ReaderLocator;
      selectedText: string;
      color: HighlightColor;
      noteText: string | null;
    }
  | { kind: "bookmark"; locator: ReaderLocator; label: string };

export type AnnotationPatch =
  | { kind: "highlight"; color?: HighlightColor; noteText?: string | null }
  | { kind: "bookmark"; label: string };

export type ReaderAnnotation = AnnotationDraft & {
  id: string;
  publicationId: string;
  createdAt: string;
  updatedAt: string;
};

export type ReaderSearchResult = {
  chapterTitle: string | null;
  excerpt: string;
  locator: ReaderLocator;
};

const codePointString = (maximum: number, minimum = 0) =>
  z.string().refine((value) => {
    const length = Array.from(value).length;
    return length >= minimum && length <= maximum;
  });

const locatorTextSchema = z
  .object({
    before: codePointString(64).optional(),
    highlight: codePointString(1_000).optional(),
    after: codePointString(64).optional(),
  })
  .strict();

const boundedLocatorSchema = z
  .object({
    href: z.string().min(1),
    progression: z.number().finite().min(0).max(1),
    totalProgression: z.number().finite().min(0).max(1).nullable(),
    locations: z.record(z.string(), z.union([z.string(), z.number().finite()])),
    text: locatorTextSchema.optional(),
  })
  .strict();

const annotationDraftSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("highlight"),
      locator: z.unknown(),
      selectedText: codePointString(1_000, 1),
      color: z.enum(["yellow", "green", "rose"]),
      noteText: codePointString(5_000).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("bookmark"),
      locator: z.unknown(),
      label: codePointString(120, 1).refine((value) => value.trim().length > 0),
    })
    .strict(),
]);

const annotationPatchSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("highlight"),
      color: z.enum(["yellow", "green", "rose"]).optional(),
      noteText: codePointString(5_000).nullable().optional(),
    })
    .strict()
    .refine((value) => value.color !== undefined || value.noteText !== undefined),
  z
    .object({
      kind: z.literal("bookmark"),
      label: codePointString(120, 1).refine((value) => value.trim().length > 0),
    })
    .strict(),
]);

export function parseBoundedReaderLocator(value: unknown): ReaderLocator {
  const parsed = boundedLocatorSchema.parse(parseReaderLocator(value));
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > 16 * 1_024) {
    throw new Error("Reader locator is too large");
  }
  return parsed;
}

export function parseAnnotationDraft(value: unknown): AnnotationDraft {
  const parsed = annotationDraftSchema.parse(value);
  const locator = parseBoundedReaderLocator(parsed.locator);
  if (parsed.kind === "highlight") {
    if (locator.text?.highlight !== parsed.selectedText) {
      throw new Error("Selected text does not match the locator");
    }
    return { ...parsed, locator };
  }
  return { ...parsed, locator, label: parsed.label.trim() };
}

export function parseAnnotationPatch(value: unknown): AnnotationPatch {
  const parsed = annotationPatchSchema.parse(value);
  return parsed.kind === "bookmark" ? { ...parsed, label: parsed.label.trim() } : parsed;
}
