// The publish gate for a work, shared with SQL. publish_book computes the same codes in the same
// order through book_readiness_issues() (20261020120000); keep the two in step. The editor uses
// this to show what is missing before an admin tries to publish; the database is what enforces it.
//
// There is no offer requirement: an edition without an offer is browsable, just not for sale
// (spec section 6). What a single edition needs before its EPUB goes live (the EPUB's language
// matching the edition's) is checked per publication by publication_readiness_issues().

export const readinessIssueCodes = [
  "missing_localization",
  "missing_author",
  "missing_cover",
  "missing_publication",
] as const;

export type ReadinessIssueCode = (typeof readinessIssueCodes)[number];

export type BookEditorSection = "details" | "localizations" | "editions" | "retail" | "cover" | "relations" | "publish";

export type BookReadinessSnapshot = {
  localizations: { title: string; slug: string; description: string | null }[];
  hasAuthor: boolean;
  hasCover: boolean;
  // At least one edition of the work is published with a live EPUB publication.
  hasPublishedEdition: boolean;
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
  if (!snapshot.hasPublishedEdition) issues.push("missing_publication");
  return issues;
}

export const readinessIssueSection: Record<ReadinessIssueCode, BookEditorSection> = {
  missing_localization: "localizations",
  missing_author: "details",
  missing_cover: "cover",
  missing_publication: "editions",
};

// Admin UI copy is English-only, like every other /admin surface.
export const readinessIssueMessage: Record<ReadinessIssueCode, string> = {
  missing_localization: "Add a localization with a title, slug, and description.",
  missing_author: "Set a primary author with localized copy.",
  missing_cover: "Upload a cover image.",
  missing_publication: "Publish an EPUB for at least one edition.",
};

const readinessErrorPattern = /book is not ready: ([a-z_,]+)/;

export function parseReadinessError(message: string): ReadinessIssueCode[] | null {
  const match = readinessErrorPattern.exec(message);
  if (!match) return null;
  return match[1]
    .split(",")
    .filter((code): code is ReadinessIssueCode => (readinessIssueCodes as readonly string[]).includes(code));
}

// Per-publication readiness (publication_readiness_issues, EB012). Shown on the edition page.
export const publicationIssueMessage: Record<string, string> = {
  epub_language_unverified:
    "The EPUB's language was not recorded. Re-process this upload with the current worker so it can be verified.",
  epub_language_mismatch: "The EPUB is written in a different language than this edition declares.",
};

const publicationErrorPattern = /publication is not ready: ([a-z_,]+)/;

export function parsePublicationReadinessError(message: string): string[] | null {
  const match = publicationErrorPattern.exec(message);
  return match ? match[1].split(",").filter((code) => code in publicationIssueMessage) : null;
}
