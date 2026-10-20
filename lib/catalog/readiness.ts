// The publish gate for a book, shared with SQL. publish_book (20260913120000) computes the same
// codes in the same order through book_readiness_issues(); keep the two in step. The editor uses
// this to show what is missing before an admin tries to publish; the database is what enforces it.

export const readinessIssueCodes = [
  "missing_localization",
  "missing_author",
  "missing_cover",
  "missing_offer",
  "missing_publication",
] as const;

export type ReadinessIssueCode = (typeof readinessIssueCodes)[number];

export type BookEditorSection = "details" | "localizations" | "offer" | "retail" | "cover" | "relations" | "epub" | "publish";

export type BookReadinessSnapshot = {
  localizations: { title: string; slug: string; description: string | null }[];
  hasAuthor: boolean;
  hasCover: boolean;
  hasActiveOffer: boolean;
  hasPublishedActivePublication: boolean;
};

const isFilled = (value: string | null) => value !== null && value.trim().length > 0;

export function checkBookReadiness(snapshot: BookReadinessSnapshot): ReadinessIssueCode[] {
  const issues: ReadinessIssueCode[] = [];
  const hasCompleteLocalization = snapshot.localizations.some(
    (localization) => isFilled(localization.title) && isFilled(localization.slug) && isFilled(localization.description),
  );
  if (!hasCompleteLocalization) issues.push("missing_localization");
  if (!snapshot.hasAuthor) issues.push("missing_author");
  if (!snapshot.hasCover) issues.push("missing_cover");
  if (!snapshot.hasActiveOffer) issues.push("missing_offer");
  if (!snapshot.hasPublishedActivePublication) issues.push("missing_publication");
  return issues;
}

export const readinessIssueSection: Record<ReadinessIssueCode, BookEditorSection> = {
  missing_localization: "localizations",
  missing_author: "details",
  missing_cover: "cover",
  missing_offer: "offer",
  missing_publication: "epub",
};

// Admin UI copy is English-only, like every other /admin surface.
export const readinessIssueMessage: Record<ReadinessIssueCode, string> = {
  missing_localization: "Add a localization with a title, slug, and description.",
  missing_author: "Set a primary author with localized copy.",
  missing_cover: "Upload a cover image.",
  missing_offer: "Activate the ebook offer.",
  missing_publication: "Publish an EPUB version.",
};

const readinessErrorPattern = /book is not ready: ([a-z_,]+)/;

export function parseReadinessError(message: string): ReadinessIssueCode[] | null {
  const match = readinessErrorPattern.exec(message);
  if (!match) return null;
  return match[1]
    .split(",")
    .filter((code): code is ReadinessIssueCode => (readinessIssueCodes as readonly string[]).includes(code));
}
