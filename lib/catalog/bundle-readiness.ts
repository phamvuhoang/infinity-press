// The publish gate for a bundle, shared with SQL. publish_bundle (20260924120000) computes the
// same blocking codes in the same order through bundle_readiness_issues(); keep the two in step.
// The editor uses this to show what is missing before an admin tries to publish; the database is
// what enforces it.
//
// Unlike checkBookReadiness this returns a verdict rather than a flat list, because a bundle has
// one issue that is not a refusal. Unpublishing a member book must not unpublish the bundle it is
// in (spec 6.2) - the bundle page simply hides that member - so `unpublished_member` is a warning
// the editor keeps showing on a published bundle. It never blocks: whether enough members are
// published is already decided by `too_few_published_members`, which counts published members and
// so refuses the cases that actually matter.

export const bundleReadinessIssueCodes = [
  "too_few_published_members",
  "missing_localization",
  "missing_cover",
  "missing_offer",
  "unpublished_member",
] as const;

export type BundleReadinessIssueCode = (typeof bundleReadinessIssueCodes)[number];

export type BundleEditorSection = "details" | "localizations" | "cover" | "members" | "offer" | "publish";

export type BundleReadinessSnapshot = {
  members: { published: boolean }[];
  localizations: { title: string; slug: string; description: string | null }[];
  hasCover: boolean;
  hasActiveOffer: boolean;
};

export type BundleReadiness = {
  blocking: BundleReadinessIssueCode[];
  warnings: BundleReadinessIssueCode[];
};

const isFilled = (value: string | null) => value !== null && value.trim().length > 0;

const isCompleteLocalization = (localization: { title: string; slug: string; description: string | null }) =>
  isFilled(localization.title) && isFilled(localization.slug) && isFilled(localization.description);

export function checkBundleReadiness(snapshot: BundleReadinessSnapshot): BundleReadiness {
  const blocking: BundleReadinessIssueCode[] = [];
  if (snapshot.members.filter((member) => member.published).length < 2) blocking.push("too_few_published_members");
  if (!snapshot.localizations.some(isCompleteLocalization)) blocking.push("missing_localization");
  if (!snapshot.hasCover) blocking.push("missing_cover");
  if (!snapshot.hasActiveOffer) blocking.push("missing_offer");
  return {
    blocking,
    warnings: snapshot.members.some((member) => !member.published) ? ["unpublished_member"] : [],
  };
}

export const bundleReadinessIssueSection: Record<BundleReadinessIssueCode, BundleEditorSection> = {
  too_few_published_members: "members",
  missing_localization: "localizations",
  missing_cover: "cover",
  missing_offer: "offer",
  unpublished_member: "members",
};

// Admin UI copy is English-only, like every other /admin surface.
export const bundleReadinessIssueMessage: Record<BundleReadinessIssueCode, string> = {
  too_few_published_members: "Add at least two published books to the bundle.",
  missing_localization: "Add a localization with a title, slug, and description.",
  missing_cover: "Upload a cover image.",
  missing_offer: "Activate the bundle offer.",
  unpublished_member: "A member book is not published, so the bundle page hides it.",
};

// `bundle`, not `book`: publish_book raises the same sentence about a book, and the two errors
// reach the admin through the same Server Action error mapping.
const bundleReadinessErrorPattern = /bundle is not ready: ([a-z_,]+)/;

export function parseBundleReadinessError(message: string): BundleReadinessIssueCode[] | null {
  const match = bundleReadinessErrorPattern.exec(message);
  if (!match) return null;
  return match[1]
    .split(",")
    .filter((code): code is BundleReadinessIssueCode =>
      (bundleReadinessIssueCodes as readonly string[]).includes(code),
    );
}
