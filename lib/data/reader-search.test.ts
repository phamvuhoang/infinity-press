// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReaderDataUnavailableError } from "@/lib/data/reader-annotations";
import { parseReaderSearchQuery, searchReaderPublication } from "@/lib/data/reader-search";
import type { AuthorizedReaderContext } from "@/lib/reader/session";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const publicationId = "c0000000-0000-4000-8000-000000000001";
const context: AuthorizedReaderContext & { sessionId: string } = {
  sessionId: "e0000000-0000-4000-8000-000000000001",
  profileId: "10000000-0000-4000-8000-000000000001",
  publicationId,
  publicationVersion: 2,
};

beforeEach(() => vi.resetAllMocks());

describe("reader search DAL", () => {
  it("trims and bounds search queries by Unicode code point", () => {
    expect(parseReaderSearchQuery("  tiếng Việt  ")).toBe("tiếng Việt");
    expect(() => parseReaderSearchQuery("x")).toThrow();
    expect(() => parseReaderSearchQuery("😀".repeat(101))).toThrow();
  });

  it("returns only bounded DTO fields and projects the locator href", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          chapter_title: "Chapter 1",
          excerpt: "A bounded matching excerpt",
          locator_json: {
            href: "OEBPS/text/chapter.xhtml",
            progression: 0.25,
            totalProgression: 0.5,
            locations: { position: 4 },
            text: { before: "before", highlight: "matching", after: "after" },
          },
          plain_text: "must not cross the DTO",
          rank: 99,
        },
      ],
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    await expect(searchReaderPublication(context, "matching")).resolves.toEqual([
      {
        chapterTitle: "Chapter 1",
        excerpt: "A bounded matching excerpt",
        locator: {
          href: `/api/reader/publications/${publicationId}/resources/OEBPS/text/chapter.xhtml`,
          progression: 0.25,
          totalProgression: 0.5,
          locations: { position: 4 },
          text: { before: "before", highlight: "matching", after: "after" },
        },
      },
    ]);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("search_reader_publication", {
      p_session_id: context.sessionId,
      p_publication_id: publicationId,
      p_query: "matching",
    });
  });

  it.each([
    ["too many results", Array.from({ length: 51 }, () => ({ chapter_title: null, excerpt: "ok", locator_json: null }))],
    [
      "oversized excerpt",
      [{ chapter_title: null, excerpt: "x".repeat(241), locator_json: { href: "OEBPS/x", progression: 0, totalProgression: null, locations: {} } }],
    ],
    [
      "oversized locator quote",
      [{ chapter_title: null, excerpt: "ok", locator_json: { href: "OEBPS/x", progression: 0, totalProgression: null, locations: {}, text: { highlight: "x".repeat(161) } } }],
    ],
    [
      "an external locator href",
      [{ chapter_title: null, excerpt: "ok", locator_json: { href: "https://example.test/chapter.xhtml", progression: 0, totalProgression: null, locations: {}, text: { highlight: "ok" } } }],
    ],
  ])("rejects a stored response with %s", async (_name, data) => {
    vi.mocked(createClient).mockResolvedValue({ rpc: vi.fn().mockResolvedValue({ data, error: null }) } as never);
    await expect(searchReaderPublication(context, "query")).rejects.toBeInstanceOf(ReaderDataUnavailableError);
  });

  it("turns a database failure into a sanitized unavailable error", async () => {
    vi.mocked(createClient).mockResolvedValue({
      rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "XX000", message: "query text and private row" } }),
    } as never);
    const error = await searchReaderPublication(context, "private query").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReaderDataUnavailableError);
    expect((error as Error).message).not.toContain("private query");
  });
});
