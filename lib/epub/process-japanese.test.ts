import { describe, expect, it } from "vitest";

import { DEFAULT_PROCESSING_POLICY, processEpub } from "@/lib/epub/process";
import { epubWithVerticalWriting, JAPANESE_CORPUS, japaneseEpub } from "@/scripts/fixtures/create-test-epub";

const policy = DEFAULT_PROCESSING_POLICY;

// Press Task 9: Japanese is a supported content language. These pin what survives processing and what
// the reader will be handed; the sanitizer is NOT loosened for any of it.
describe("Japanese content", () => {
  it("keeps ruby markup, the language and Japanese punctuation through sanitization", async () => {
    const result = await processEpub(japaneseEpub(), policy);
    expect(result.metadata.language).toBe("ja");
    const chapter = result.resources.find((resource) => resource.href === "OEBPS/text/chapter1.xhtml")!;
    expect(chapter.text).toContain(`<ruby>${JAPANESE_CORPUS.rubyBase}`);
    expect(chapter.text).toContain(`<rt>${JAPANESE_CORPUS.rubyReading}</rt>`);
    expect(chapter.text).toContain("<rp>（</rp>");
    expect(chapter.text).toContain(JAPANESE_CORPUS.quote);
  });

  it("builds a Japanese table of contents", async () => {
    const result = await processEpub(japaneseEpub(), policy);
    expect(result.toc.map((entry) => entry.title)).toEqual([JAPANESE_CORPUS.chapter1Heading, JAPANESE_CORPUS.chapter2Heading]);
  });

  it("indexes spaceless Japanese so a fragment can be found", async () => {
    const result = await processEpub(japaneseEpub(), policy);
    const text = result.searchChunks.map((chunk) => chunk.plainText).join("\n");
    expect(text).toContain(JAPANESE_CORPUS.searchFragment);
    expect(text).toContain("返事のない手紙");
  });

  it("keeps positions inside the reading order", async () => {
    const result = await processEpub(japaneseEpub(), policy);
    expect(result.searchChunks.length).toBeGreaterThan(1);
    expect(result.positions.length).toBeGreaterThan(1);
    const hrefs = new Set(result.readingOrder.map((item) => item.href));
    for (const position of result.positions) expect(hrefs.has(position.href)).toBe(true);
  });
});

// Launch supports horizontal layout only. A vertical EPUB is refused with a message an operator can
// act on, instead of being published into a reader that would render it wrongly.
describe("vertical writing", () => {
  it("is refused with UNSUPPORTED_LAYOUT and says how to fix it", async () => {
    await expect(processEpub(epubWithVerticalWriting(), policy)).rejects.toMatchObject({
      code: "UNSUPPORTED_LAYOUT",
      retryable: false,
      message: expect.stringContaining("horizontal"),
    });
  });
});
