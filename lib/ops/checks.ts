import type {
  OperationsReport,
  OperationsSnapshot,
  OpsFinding,
  OpsRuleName,
} from "@/lib/ops/types";

// Pure rule evaluation (spec S5 10.2). Every boundary is measured against the one supplied `now`,
// so the worker's findings and alert fingerprints are deterministic for a run.

export const STALE_EPUB_JOB_MS = 30 * 60_000;
export const STALE_READER_QUESTION_MS = 7 * 24 * 60 * 60_000;
export const UNPROCESSED_PAYMENT_EVENT_MS = 5 * 60_000;
// attempt_count counts failed sends, so 4 is the row's fourth failure.
export const STUCK_NOTIFICATION_ATTEMPTS = 4;

const SUMMARIES = {
  staleQueued: "EPUB processing job has been queued for more than 30 minutes.",
  staleProcessing: "EPUB processing job has not progressed for more than 30 minutes.",
  expiredLease: "EPUB processing job's worker lease expired before it finished.",
  missingEntitlement: "Completed order has no active or revoked order entitlement.",
  unprocessedEvent: "Payment event has not been processed for more than 5 minutes.",
  // One rule, two kinds of row, so two summaries: the rule reports a stuck BOOK-READY email and a
  // stuck GIFT CLAIM email, and an operator has to know which one they are looking at before they
  // know where to go. RULE_LABELS still calls the rule "Stuck book-ready emails", which is now
  // narrower than what it reports - the label is shared with the alert email and the operations
  // panel, and renaming it is a separate change.
  stuckNotification: "Book-ready email has failed at least 4 delivery attempts.",
  // Names neither the recipient nor the claim link: a finding travels into alerts and logs, and
  // the claim token is the authorization to take the gift.
  stuckGiftNotification: "Gift claim email has failed at least 4 delivery attempts.",
  stuckReviewNotification: "Review reply email has failed at least 4 delivery attempts.",
  unreviewedClaim: "A reader reported a bank transfer that has not been reviewed.",
  // Names neither the asker nor the question text: a finding travels into alerts and logs.
  staleQuestion: "A reader question has waited more than 7 days.",
} as const;

function ms(value: string): number {
  return Date.parse(value);
}

function iso(value: string): string {
  return new Date(value).toISOString();
}

function finding(rule: OpsRuleName, id: string, occurredAt: string, summary: string, repairPath: string): OpsFinding {
  return { id, rule, occurredAt: iso(occurredAt), summary, repairPath };
}

function oldestFirst(findings: OpsFinding[]): OpsFinding[] {
  return findings.sort((a, b) => ms(a.occurredAt) - ms(b.occurredAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function staleEpubJobs(snapshot: OperationsSnapshot, now: number): OpsFinding[] {
  const findings: OpsFinding[] = [];
  for (const job of snapshot.epubJobs) {
    if (job.status !== "queued" && job.status !== "processing") continue;
    const tooOld = now - ms(job.updatedAt) > STALE_EPUB_JOB_MS;
    const leaseExpired = job.status === "processing" && job.leaseExpiresAt !== null && ms(job.leaseExpiresAt) < now;
    if (!tooOld && !leaseExpired) continue;
    const summary = tooOld
      ? job.status === "queued"
        ? SUMMARIES.staleQueued
        : SUMMARIES.staleProcessing
      : SUMMARIES.expiredLease;
    findings.push(finding("stale_epub_job", job.id, job.updatedAt, summary, `/admin/books/${job.bookId}/editions/${job.editionId}#epub`));
  }
  return findings;
}

function missingOrderEntitlements(snapshot: OperationsSnapshot): OpsFinding[] {
  return snapshot.completedOrders
    .filter((order) => !order.orderEntitlementStatuses.some((status) => status === "active" || status === "revoked"))
    .map((order) =>
      finding("missing_order_entitlement", order.id, order.createdAt, SUMMARIES.missingEntitlement, `/admin/orders/${order.id}`),
    );
}

function unprocessedPaymentEvents(snapshot: OperationsSnapshot, now: number): OpsFinding[] {
  return snapshot.paymentEvents
    .filter((event) => event.processedAt === null && now - ms(event.receivedAt) > UNPROCESSED_PAYMENT_EVENT_MS)
    .map((event) =>
      finding("unprocessed_payment_event", event.id, event.receivedAt, SUMMARIES.unprocessedEvent, `/admin/orders/${event.orderId}`),
    );
}

function stuckNotifications(snapshot: OperationsSnapshot, now: number): OpsFinding[] {
  return snapshot.outbox
    .filter(
      (row) =>
        row.sentAt === null &&
        // A revoked entitlement's row is never claimed, so it can never be sent or cleared;
        // reporting it would raise a 24-hour reminder forever. The loader applies the gift
        // analogue - only a gift still in `sent` - to the gift branch, and only a published
        // review with a reply to the review branch.
        (row.giftId !== null || row.reviewId !== null || (row.entitlementStatus === "active" && row.profileId !== null)) &&
        row.attemptCount >= STUCK_NOTIFICATION_ATTEMPTS &&
        // A lease is valid while it expires strictly after now - the same test the claim uses.
        (row.leaseExpiresAt === null || ms(row.leaseExpiresAt) <= now),
    )
    .map((row) =>
      row.giftId !== null
        ? // The repair is a resend or a reissue on /admin/gifts. Never a profile page - a gift row
          // has no profile at all - and never a path carrying the claim token.
          finding("stuck_notification", row.id, row.createdAt, SUMMARIES.stuckGiftNotification, "/admin/gifts")
        : row.reviewId !== null
          ? // The reply lives on the review row; the published tab is where it is edited or cleared.
            finding("stuck_notification", row.id, row.createdAt, SUMMARIES.stuckReviewNotification, "/admin/reviews?status=published")
          : finding("stuck_notification", row.id, row.createdAt, SUMMARIES.stuckNotification, `/admin/users/${row.profileId}`),
    );
}

// No threshold: an unreviewed claim is a finding from the moment it is made. The loader only
// returns claims whose order is still pending, so confirming or declining clears the finding.
function unreviewedManualTransferClaims(snapshot: OperationsSnapshot): OpsFinding[] {
  return snapshot.manualTransferClaims.map((claim) =>
    finding(
      "unreviewed_manual_transfer_claim",
      claim.orderId,
      claim.claimedAt,
      SUMMARIES.unreviewedClaim,
      `/admin/orders/${claim.orderId}`,
    ),
  );
}

// The loader returns only questions still `new`; this applies the exact boundary, strictly older.
function staleReaderQuestions(snapshot: OperationsSnapshot, now: number): OpsFinding[] {
  return snapshot.readerQuestions
    .filter((question) => now - ms(question.createdAt) > STALE_READER_QUESTION_MS)
    .map((question) =>
      finding("stale_reader_question", question.id, question.createdAt, SUMMARIES.staleQuestion, "/admin/questions"),
    );
}

export function evaluateOperations(snapshot: OperationsSnapshot, now: Date): OperationsReport {
  const at = now.getTime();
  return {
    evaluatedAt: now.toISOString(),
    findings: {
      stale_epub_job: oldestFirst(staleEpubJobs(snapshot, at)),
      missing_order_entitlement: oldestFirst(missingOrderEntitlements(snapshot)),
      unprocessed_payment_event: oldestFirst(unprocessedPaymentEvents(snapshot, at)),
      stuck_notification: oldestFirst(stuckNotifications(snapshot, at)),
      unreviewed_manual_transfer_claim: oldestFirst(unreviewedManualTransferClaims(snapshot)),
      stale_reader_question: oldestFirst(staleReaderQuestions(snapshot, at)),
    },
  };
}
