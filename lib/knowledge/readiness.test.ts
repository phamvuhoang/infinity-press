import { describe, expect, it } from "vitest";

import {
  articleReadinessIssueCodes,
  articleReadinessIssueMessage,
  articleReadinessIssueSection,
  checkArticleReadiness,
  checkIdeaReadiness,
  ideaReadinessIssueCodes,
  ideaReadinessIssueMessage,
  ideaReadinessIssueSection,
  parseArticleReadinessError,
  parseIdeaReadinessError,
  type ArticleReadinessSnapshot,
  type IdeaReadinessSnapshot,
} from "@/lib/knowledge/readiness";

const completeIdeaLocalization = {
  locale: "vi",
  slug: "vi-sao-can-tinh-thuc",
  question: "Vì sao cần tỉnh thức?",
  shortAnswer: "Vì chú ý là nền tảng của mọi thay đổi.",
  blockCount: 2,
};

const readyIdea: IdeaReadinessSnapshot = {
  localizations: [completeIdeaLocalization],
  relatedBookLocales: ["vi"],
};

const completeArticleLocalization = {
  slug: "doc-cham",
  title: "Đọc chậm",
  excerpt: "Một cách đọc để nhớ lâu.",
  blockCount: 1,
};

const readyArticle: ArticleReadinessSnapshot = {
  localizations: [completeArticleLocalization],
};

describe("checkIdeaReadiness", () => {
  it("returns no issues for a complete idea", () => {
    expect(checkIdeaReadiness(readyIdea)).toEqual([]);
  });

  it("requires a localization with a nonblank slug, question, and short answer", () => {
    expect(checkIdeaReadiness({ ...readyIdea, localizations: [] })).toEqual([
      "missing_localization",
      "missing_blocks",
    ]);
    for (const blank of [{ slug: " " }, { question: "" }, { shortAnswer: "\t" }]) {
      expect(
        checkIdeaReadiness({ ...readyIdea, localizations: [{ ...completeIdeaLocalization, ...blank }] }),
      ).toEqual(["missing_localization", "missing_blocks"]);
    }
  });

  it("requires at least one block on a complete localization", () => {
    expect(
      checkIdeaReadiness({ ...readyIdea, localizations: [{ ...completeIdeaLocalization, blockCount: 0 }] }),
    ).toEqual(["missing_blocks"]);
  });

  it("accepts an idea when any one locale is complete", () => {
    expect(
      checkIdeaReadiness({
        ...readyIdea,
        localizations: [
          { ...completeIdeaLocalization, slug: "why-awareness", blockCount: 0 },
          completeIdeaLocalization,
        ],
      }),
    ).toEqual([]);
  });

  it("still requires a related book when a locale is complete", () => {
    expect(checkIdeaReadiness({ ...readyIdea, relatedBookLocales: [] })).toEqual(["missing_related_book"]);
  });

  it("requires a visible related book in every locale the idea has", () => {
    const english = { ...completeIdeaLocalization, locale: "en", slug: "why-awareness" };
    expect(checkIdeaReadiness({ ...readyIdea, localizations: [english, completeIdeaLocalization] })).toEqual([
      "missing_related_book",
    ]);
    expect(
      checkIdeaReadiness({
        localizations: [english, completeIdeaLocalization],
        relatedBookLocales: ["vi", "en"],
      }),
    ).toEqual([]);
  });

  it("lists every missing piece in the same order the database reports them", () => {
    expect(checkIdeaReadiness({ localizations: [], relatedBookLocales: [] })).toEqual([
      ...ideaReadinessIssueCodes,
    ]);
    expect(ideaReadinessIssueCodes).toEqual(["missing_localization", "missing_blocks", "missing_related_book"]);
  });

  it("maps every issue to an editor section and a message", () => {
    expect(ideaReadinessIssueSection).toEqual({
      missing_localization: "localizations",
      missing_blocks: "localizations",
      missing_related_book: "relations",
    });
    for (const code of ideaReadinessIssueCodes) {
      expect(ideaReadinessIssueMessage[code]).toMatch(/\S/);
    }
  });
});

describe("checkArticleReadiness", () => {
  it("returns no issues for a complete article", () => {
    expect(checkArticleReadiness(readyArticle)).toEqual([]);
  });

  it("requires a localization with a nonblank slug, title, and excerpt", () => {
    expect(checkArticleReadiness({ localizations: [] })).toEqual(["missing_localization", "missing_blocks"]);
    for (const blank of [{ slug: "" }, { title: "  " }, { excerpt: "" }]) {
      expect(checkArticleReadiness({ localizations: [{ ...completeArticleLocalization, ...blank }] })).toEqual([
        "missing_localization",
        "missing_blocks",
      ]);
    }
  });

  it("requires at least one block on a complete localization", () => {
    expect(checkArticleReadiness({ localizations: [{ ...completeArticleLocalization, blockCount: 0 }] })).toEqual([
      "missing_blocks",
    ]);
  });

  it("accepts an article when any one locale is complete and needs no related book", () => {
    expect(
      checkArticleReadiness({
        localizations: [{ ...completeArticleLocalization, blockCount: 0 }, completeArticleLocalization],
      }),
    ).toEqual([]);
    expect(articleReadinessIssueCodes).toEqual(["missing_localization", "missing_blocks"]);
  });

  it("maps every issue to an editor section and a message", () => {
    expect(articleReadinessIssueSection).toEqual({
      missing_localization: "localizations",
      missing_blocks: "localizations",
    });
    for (const code of articleReadinessIssueCodes) {
      expect(articleReadinessIssueMessage[code]).toMatch(/\S/);
    }
  });
});

describe("parseIdeaReadinessError", () => {
  it("reads the codes out of publish_idea's EB032 message", () => {
    expect(parseIdeaReadinessError("publish_idea: idea is not ready: missing_blocks,missing_related_book")).toEqual([
      "missing_blocks",
      "missing_related_book",
    ]);
  });

  it("ignores unknown codes, other entities, and unrelated messages", () => {
    expect(parseIdeaReadinessError("publish_idea: idea is not ready: missing_blocks,drop_table")).toEqual([
      "missing_blocks",
    ]);
    expect(parseIdeaReadinessError("publish_article: article is not ready: missing_blocks")).toBeNull();
    expect(parseIdeaReadinessError("publish_book: book is not ready: missing_cover")).toBeNull();
    expect(parseIdeaReadinessError("something else")).toBeNull();
  });
});

describe("parseArticleReadinessError", () => {
  it("reads the codes out of publish_article's EB033 message", () => {
    expect(
      parseArticleReadinessError("publish_article: article is not ready: missing_localization,missing_blocks"),
    ).toEqual(["missing_localization", "missing_blocks"]);
  });

  it("ignores codes that do not belong to an article and unrelated messages", () => {
    expect(
      parseArticleReadinessError("publish_article: article is not ready: missing_blocks,missing_related_book"),
    ).toEqual(["missing_blocks"]);
    expect(parseArticleReadinessError("publish_idea: idea is not ready: missing_blocks")).toBeNull();
    expect(parseArticleReadinessError("something else")).toBeNull();
  });
});
