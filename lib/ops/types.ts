// Operational rule contract (spec S5 10.1). Shared by the scheduled worker, /admin/operations,
// and alert reconciliation. Nothing here carries an email address, a provider payload, or book
// text: a finding is an ID, a timestamp, a fixed safe summary, and an /admin repair path.

export const OPS_RULE_NAMES = [
  "stale_epub_job",
  "missing_order_entitlement",
  "unprocessed_payment_event",
  "stuck_notification",
  "unreviewed_manual_transfer_claim",
  "stale_reader_question",
] as const;

export type OpsRuleName = (typeof OPS_RULE_NAMES)[number];

// Human-readable titles shared by the operator alert email (lib/ops/alerts.ts) and the
// /admin/operations page (components/admin/operations-panel.tsx), so both name a rule the same
// way.
export const RULE_LABELS: Record<OpsRuleName, string> = {
  stale_epub_job: "Stale EPUB jobs",
  missing_order_entitlement: "Completed orders without an entitlement",
  unprocessed_payment_event: "Unprocessed payment events",
  stuck_notification: "Stuck book-ready emails",
  unreviewed_manual_transfer_claim: "Unreviewed bank transfer reports",
  stale_reader_question: "Unanswered reader questions",
};

export type OpsFinding = {
  // The source row's ID (job, order, payment event, or outbox row): stable across runs, so the
  // rule's fingerprint changes only when the set of affected rows changes.
  id: string;
  rule: OpsRuleName;
  // ISO timestamp of the first relevant moment for the finding.
  occurredAt: string;
  summary: string;
  repairPath: string;
};

export type OperationsReport = {
  evaluatedAt: string;
  findings: Record<OpsRuleName, OpsFinding[]>;
};

// Candidate source rows. Loaders filter server-side to likely candidates; evaluateOperations
// applies the exact rule boundaries against one supplied `now`.
export type EpubJobRow = {
  id: string;
  bookId: string;
  editionId: string;
  status: "queued" | "processing" | "failed" | "completed";
  updatedAt: string;
  leaseExpiresAt: string | null;
};

export type CompletedOrderRow = {
  id: string;
  createdAt: string;
  // Statuses of entitlements whose source_order_id is this order.
  orderEntitlementStatuses: ("active" | "revoked")[];
};

export type PaymentEventRow = {
  id: string;
  orderId: string;
  receivedAt: string;
  processedAt: string | null;
};

// An undelivered notification. notification_outbox_target_check makes every row point at exactly
// one of three things, so exactly one of these is populated: a book-ready row names the profile it
// is addressed to and its entitlement's status, a gift-claim row names the gift and the order it
// was bought on, and has neither a profile nor an entitlement, and a review-reply row names the
// review (and the reviewer's profile).
export type OutboxRow = {
  id: string;
  profileId: string | null;
  // Set on a gift-claim row. Its repair path is the admin gift surface - never a profile page, and
  // never anything carrying the claim token.
  giftId: string | null;
  orderId: string | null;
  // Set on a review-reply row (S15). Its repair path is the published reviews list.
  reviewId: string | null;
  // The row's entitlement status, on a book-ready row. A revoked entitlement's row is never
  // claimed (and so never cleared), so only an active one is a delivery fault.
  entitlementStatus: "active" | "revoked" | null;
  attemptCount: number;
  leaseExpiresAt: string | null;
  sentAt: string | null;
  createdAt: string;
};

// A reader's "I have transferred" report on an order that is still pending review.
export type ManualTransferClaimRow = {
  orderId: string;
  claimedAt: string;
};

// A reader question still in status `new`. The id is the question's, and nothing of its body, the
// asker, or the book travels with it: a finding is an ID, a timestamp and a fixed summary.
export type ReaderQuestionRow = {
  id: string;
  createdAt: string;
};

export type OperationsSnapshot = {
  epubJobs: EpubJobRow[];
  completedOrders: CompletedOrderRow[];
  paymentEvents: PaymentEventRow[];
  outbox: OutboxRow[];
  manualTransferClaims: ManualTransferClaimRow[];
  readerQuestions: ReaderQuestionRow[];
};

export type OperationsAlertState = {
  ruleName: OpsRuleName;
  active: boolean;
  fingerprint: string | null;
  firstDetectedAt: string | null;
  // Null until the first scheduled worker run (the migration seeds each rule unevaluated).
  lastEvaluatedAt: string | null;
  lastAlertedAt: string | null;
  resolvedAt: string | null;
};
