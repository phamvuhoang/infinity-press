import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getServerEnv } from "@/lib/config/server-env";
import { getArticleIndex, getPublishedIdeas } from "@/lib/data/knowledge";
import type { KnowledgeArticleSummary, KnowledgeIdeaSummary } from "@/lib/knowledge/public-types";
import { knowledgeStaticParams } from "@/lib/knowledge/static-params";

vi.mock("@/lib/data/knowledge", () => ({ getPublishedIdeas: vi.fn(), getArticleIndex: vi.fn() }));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));

function idea(slug: string): KnowledgeIdeaSummary {
  return {
    ideaId: `id-${slug}`,
    slug,
    question: "Q?",
    shortAnswer: "A.",
    createdAt: "2026-09-01T00:00:00+00:00",
    updatedAt: "2026-09-01T00:00:00+00:00",
    alternateSlugs: {},
    metadataLocale: "en",
    topics: [],
  };
}

function article(slug: string): KnowledgeArticleSummary {
  return {
    articleId: `id-${slug}`,
    slug,
    title: "T",
    excerpt: "E",
    publishedAt: "2026-09-01T00:00:00+00:00",
    updatedAt: "2026-09-01T00:00:00+00:00",
    alternateSlugs: {},
    metadataLocale: "en",
    author: { name: "Mai Tran", slug: null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getServerEnv).mockReturnValue({} as ReturnType<typeof getServerEnv>);
});
afterEach(() => vi.unstubAllEnvs());

describe("knowledgeStaticParams", () => {
  it("lists the locale's published idea and article slugs once each", async () => {
    vi.mocked(getPublishedIdeas).mockResolvedValue([idea("why-read"), idea("streaks"), idea("why-read")]);
    vi.mocked(getArticleIndex).mockResolvedValue([article("autumn")]);

    expect(await knowledgeStaticParams("en")).toEqual({ ideas: ["why-read", "streaks"], articles: ["autumn"] });
    expect(getPublishedIdeas).toHaveBeenCalledWith("en");
    expect(getArticleIndex).toHaveBeenCalledWith("en");
  });

  // A page shown under another locale's copy (metadata fallback) is that locale's page.
  it("leaves out an idea or article shown under another locale's copy", async () => {
    vi.mocked(getPublishedIdeas).mockResolvedValue([idea("why-read"), { ...idea("vietnamese-only"), metadataLocale: "vi" }]);
    vi.mocked(getArticleIndex).mockResolvedValue([{ ...article("autumn"), metadataLocale: "vi" }]);

    expect(await knowledgeStaticParams("en")).toEqual({ ideas: ["why-read"], articles: [] });
  });

  it("returns no slugs during a production build with no server environment, without querying", async () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.mocked(getServerEnv).mockImplementation(() => {
      throw new Error("invalid environment");
    });

    expect(await knowledgeStaticParams("vi")).toEqual({ ideas: [], articles: [] });
    expect(getPublishedIdeas).not.toHaveBeenCalled();
    expect(getArticleIndex).not.toHaveBeenCalled();
  });

  it("does not swallow a real query error when the server environment is present", async () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.mocked(getPublishedIdeas).mockRejectedValue(new Error("query failed"));
    vi.mocked(getArticleIndex).mockResolvedValue([]);

    await expect(knowledgeStaticParams("vi")).rejects.toThrow("query failed");
  });
});
