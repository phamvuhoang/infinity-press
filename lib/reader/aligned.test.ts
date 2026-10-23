// @vitest-environment node
import { describe, expect, it } from "vitest";

import { alignedPassageSchema } from "@/lib/reader/aligned";

const passage = (text: string) => ({
  targetPublicationId: "c0000000-0000-0000-0000-000000000001",
  targetEditionId: "e0000000-0000-0000-0000-000000000001",
  targetLanguageCode: "ja",
  targetOrdinal: 0,
  text,
  confidence: 0.9,
});

describe("alignedPassageSchema text bound", () => {
  // Chunks are 1024 code points; an astral character is two UTF-16 units.
  it("accepts a 1024-code-point chunk of astral characters", () => {
    const text = "📖".repeat(1024);
    expect(text.length).toBe(2048);
    expect(alignedPassageSchema.safeParse(passage(text)).success).toBe(true);
  });

  it("refuses 1025 code points", () => {
    expect(alignedPassageSchema.safeParse(passage("📖".repeat(1025))).success).toBe(false);
  });
});
