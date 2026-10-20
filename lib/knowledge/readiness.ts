// The publish gates for ideas and articles, shared with SQL. publish_idea and publish_article
// (supabase/migrations/20260927110000_s12_knowledge_admin.sql) compute the same codes in the same
// order through idea_readiness_issues() and article_readiness_issues(); keep the two in step. The
// editor uses this to show what is missing before an admin tries to publish; the database is what
// enforces it.
//
// A localization is complete when its slug and its question and short answer (idea) or title and
// excerpt (article) are nonblank. Publishing needs one complete localization in any locale, and
// that same localization must carry at least one content block. The caller counts blocks after
// parsing body_blocks with knowledgeBlocksSchema; SQL counts them with jsonb_array_length, which
// agrees because every admin write is validated by that same schema first.

export const ideaReadinessIssueCodes = ["missing_localization", "missing_blocks", "missing_related_book"] as const;
export const articleReadinessIssueCodes = ["missing_localization", "missing_blocks"] as const;

export type IdeaReadinessIssueCode = (typeof ideaReadinessIssueCodes)[number];
export type ArticleReadinessIssueCode = (typeof articleReadinessIssueCodes)[number];

export type KnowledgeEditorSection = "details" | "localizations" | "relations" | "seo" | "publish";

export type IdeaReadinessSnapshot = {
  localizations: { locale: string; slug: string; question: string; shortAnswer: string; blockCount: number }[];
  // The locales in which some related book is visible: published AND localized. The public idea
  // page lists such books alone, so every localization the page serves needs its locale here.
  relatedBookLocales: string[];
};

export type ArticleReadinessSnapshot = {
  localizations: { slug: string; title: string; excerpt: string; blockCount: number }[];
};

const isFilled = (value: string | null | undefined) => typeof value === "string" && value.trim().length > 0;

// Shared by both entities: the text-complete localizations decide missing_localization, and
// missing_blocks asks whether any of THOSE carries a block - a block on an incomplete
// localization cannot make the entity publishable.
function localizationIssues(textComplete: { blockCount: number }[]) {
  const issues: ("missing_localization" | "missing_blocks")[] = [];
  if (textComplete.length === 0) issues.push("missing_localization");
  if (!textComplete.some((localization) => localization.blockCount > 0)) issues.push("missing_blocks");
  return issues;
}

export function checkIdeaReadiness(snapshot: IdeaReadinessSnapshot): IdeaReadinessIssueCode[] {
  const issues: IdeaReadinessIssueCode[] = localizationIssues(
    snapshot.localizations.filter(
      (localization) =>
        isFilled(localization.slug) && isFilled(localization.question) && isFilled(localization.shortAnswer),
    ),
  );
  if (
    snapshot.relatedBookLocales.length === 0 ||
    snapshot.localizations.some((localization) => !snapshot.relatedBookLocales.includes(localization.locale))
  ) {
    issues.push("missing_related_book");
  }
  return issues;
}

export function checkArticleReadiness(snapshot: ArticleReadinessSnapshot): ArticleReadinessIssueCode[] {
  return localizationIssues(
    snapshot.localizations.filter(
      (localization) => isFilled(localization.slug) && isFilled(localization.title) && isFilled(localization.excerpt),
    ),
  );
}

export const ideaReadinessIssueSection: Record<IdeaReadinessIssueCode, KnowledgeEditorSection> = {
  missing_localization: "localizations",
  missing_blocks: "localizations",
  missing_related_book: "relations",
};

export const articleReadinessIssueSection: Record<ArticleReadinessIssueCode, KnowledgeEditorSection> = {
  missing_localization: "localizations",
  missing_blocks: "localizations",
};

// Admin UI copy is English-only, like every other /admin surface.
export const ideaReadinessIssueMessage: Record<IdeaReadinessIssueCode, string> = {
  missing_localization: "Add a localization with a slug, question, and short answer.",
  missing_blocks: "Add at least one content block to a complete localization.",
  missing_related_book: "Relate a published book that is localized in every locale this idea has.",
};

export const articleReadinessIssueMessage: Record<ArticleReadinessIssueCode, string> = {
  missing_localization: "Add a localization with a slug, title, and excerpt.",
  missing_blocks: "Add at least one content block to a complete localization.",
};

// publish_idea raises EB032 and publish_article EB033 with these sentences. The entity word is part
// of the pattern so one parser never reads the other entity's (or publish_book's) codes.
const ideaReadinessErrorPattern = /idea is not ready: ([a-z_,]+)/;
const articleReadinessErrorPattern = /article is not ready: ([a-z_,]+)/;

function parseCodes<Code extends string>(pattern: RegExp, codes: readonly Code[], message: string): Code[] | null {
  const match = pattern.exec(message);
  if (!match) return null;
  return match[1].split(",").filter((code): code is Code => (codes as readonly string[]).includes(code));
}

export function parseIdeaReadinessError(message: string): IdeaReadinessIssueCode[] | null {
  return parseCodes(ideaReadinessErrorPattern, ideaReadinessIssueCodes, message);
}

export function parseArticleReadinessError(message: string): ArticleReadinessIssueCode[] | null {
  return parseCodes(articleReadinessErrorPattern, articleReadinessIssueCodes, message);
}
