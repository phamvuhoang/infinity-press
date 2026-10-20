// @vitest-environment node
import { describe, expect, it } from "vitest";

import { evaluateOperations } from "@/lib/ops/checks";
import type { OperationsSnapshot, OpsFinding } from "@/lib/ops/types";

const NOW = new Date("2026-09-16T12:00:00.000Z");

function minutesBefore(minutes: number, extraMs = 0): string {
  return new Date(NOW.getTime() - minutes * 60_000 - extraMs).toISOString();
}

function minutesAfter(minutes: number): string {
  return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

function snapshot(partial: Partial<OperationsSnapshot>): OperationsSnapshot {
  return { epubJobs: [], completedOrders: [], paymentEvents: [], outbox: [], manualTransferClaims: [], readerQuestions: [], ...partial };
}

function ids(findings: OpsFinding[]): string[] {
  return findings.map((finding) => finding.id);
}

describe("evaluateOperations", () => {
  it("reports nothing for an empty snapshot and stamps the supplied now", () => {
    const report = evaluateOperations(snapshot({}), NOW);
    expect(report.evaluatedAt).toBe(NOW.toISOString());
    expect(report.findings).toEqual({
      stale_epub_job: [],
      missing_order_entitlement: [],
      unprocessed_payment_event: [],
      stuck_notification: [],
      unreviewed_manual_transfer_claim: [],
      stale_reader_question: [],
    });
  });

  describe("stale_epub_job", () => {
    const job = { bookId: "book-1", leaseExpiresAt: null };

    it("reports a queued or processing job older than 30 minutes", () => {
      const report = evaluateOperations(
        snapshot({
          epubJobs: [
            { ...job, id: "queued-old", status: "queued", updatedAt: minutesBefore(30, 1) },
            { ...job, id: "processing-old", status: "processing", updatedAt: minutesBefore(45), leaseExpiresAt: minutesAfter(5) },
            { ...job, id: "queued-young", status: "queued", updatedAt: minutesBefore(29) },
          ],
        }),
        NOW,
      );
      expect(ids(report.findings.stale_epub_job)).toEqual(["processing-old", "queued-old"]);
    });

    it("does not report a job exactly 30 minutes old until it crosses the boundary", () => {
      const exact = evaluateOperations(
        snapshot({ epubJobs: [{ ...job, id: "exact", status: "queued", updatedAt: minutesBefore(30) }] }),
        NOW,
      );
      expect(exact.findings.stale_epub_job).toEqual([]);

      const crossed = evaluateOperations(
        snapshot({ epubJobs: [{ ...job, id: "exact", status: "queued", updatedAt: minutesBefore(30) }] }),
        new Date(NOW.getTime() + 1),
      );
      expect(ids(crossed.findings.stale_epub_job)).toEqual(["exact"]);
    });

    it("reports a processing job with an expired lease even when it is younger", () => {
      const report = evaluateOperations(
        snapshot({
          epubJobs: [
            { ...job, id: "expired", status: "processing", updatedAt: minutesBefore(10), leaseExpiresAt: minutesBefore(1) },
            { ...job, id: "live", status: "processing", updatedAt: minutesBefore(10), leaseExpiresAt: minutesAfter(1) },
            { ...job, id: "lease-at-now", status: "processing", updatedAt: minutesBefore(10), leaseExpiresAt: NOW.toISOString() },
          ],
        }),
        NOW,
      );
      expect(ids(report.findings.stale_epub_job)).toEqual(["expired"]);
    });

    it("ignores failed and completed jobs however old", () => {
      const report = evaluateOperations(
        snapshot({
          epubJobs: [
            { ...job, id: "failed", status: "failed", updatedAt: minutesBefore(600) },
            { ...job, id: "completed", status: "completed", updatedAt: minutesBefore(600), leaseExpiresAt: minutesBefore(500) },
          ],
        }),
        NOW,
      );
      expect(report.findings.stale_epub_job).toEqual([]);
    });

    it("links to the book editor EPUB section", () => {
      const [finding] = evaluateOperations(
        snapshot({ epubJobs: [{ ...job, id: "job-1", status: "queued", updatedAt: minutesBefore(31) }] }),
        NOW,
      ).findings.stale_epub_job;
      expect(finding).toEqual({
        id: "job-1",
        rule: "stale_epub_job",
        occurredAt: minutesBefore(31),
        summary: expect.any(String),
        repairPath: "/admin/books/book-1#epub",
      });
    });
  });

  describe("missing_order_entitlement", () => {
    it("reports a completed order with no order-backed entitlement", () => {
      const [finding] = evaluateOperations(
        snapshot({ completedOrders: [{ id: "order-1", createdAt: minutesBefore(3), orderEntitlementStatuses: [] }] }),
        NOW,
      ).findings.missing_order_entitlement;
      expect(finding).toEqual({
        id: "order-1",
        rule: "missing_order_entitlement",
        occurredAt: minutesBefore(3),
        summary: expect.any(String),
        repairPath: "/admin/orders/order-1",
      });
    });

    it("an active or a deliberately revoked order-backed entitlement suppresses the finding", () => {
      const report = evaluateOperations(
        snapshot({
          completedOrders: [
            { id: "active", createdAt: minutesBefore(60), orderEntitlementStatuses: ["active"] },
            { id: "revoked", createdAt: minutesBefore(60), orderEntitlementStatuses: ["revoked"] },
            { id: "missing", createdAt: minutesBefore(60), orderEntitlementStatuses: [] },
          ],
        }),
        NOW,
      );
      expect(ids(report.findings.missing_order_entitlement)).toEqual(["missing"]);
    });
  });

  describe("unprocessed_payment_event", () => {
    it("reports an unprocessed event older than 5 minutes, linked to its order", () => {
      const report = evaluateOperations(
        snapshot({
          paymentEvents: [
            { id: "old", orderId: "order-9", receivedAt: minutesBefore(5, 1), processedAt: null },
            { id: "exact", orderId: "order-9", receivedAt: minutesBefore(5), processedAt: null },
            { id: "processed", orderId: "order-9", receivedAt: minutesBefore(60), processedAt: minutesBefore(59) },
          ],
        }),
        NOW,
      );
      expect(report.findings.unprocessed_payment_event).toEqual([
        {
          id: "old",
          rule: "unprocessed_payment_event",
          occurredAt: minutesBefore(5, 1),
          summary: expect.any(String),
          repairPath: "/admin/orders/order-9",
        },
      ]);
    });
  });

  describe("stuck_notification", () => {
    const row = {
      profileId: "profile-7",
      giftId: null,
      orderId: null,
      reviewId: null,
      entitlementStatus: "active" as const,
      leaseExpiresAt: null,
      sentAt: null,
      createdAt: minutesBefore(300),
    };

    it("the fourth failed attempt appears in findings; the third does not", () => {
      const third = evaluateOperations(snapshot({ outbox: [{ ...row, id: "row-1", attemptCount: 3 }] }), NOW);
      expect(third.findings.stuck_notification).toEqual([]);

      const fourth = evaluateOperations(snapshot({ outbox: [{ ...row, id: "row-1", attemptCount: 4 }] }), NOW);
      expect(fourth.findings.stuck_notification).toEqual([
        {
          id: "row-1",
          rule: "stuck_notification",
          occurredAt: minutesBefore(300),
          summary: expect.any(String),
          repairPath: "/admin/users/profile-7",
        },
      ]);

      const terminal = evaluateOperations(snapshot({ outbox: [{ ...row, id: "row-1", attemptCount: 6 }] }), NOW);
      expect(ids(terminal.findings.stuck_notification)).toEqual(["row-1"]);
    });

    it("ignores a row while it holds a valid lease, and a sent row", () => {
      const report = evaluateOperations(
        snapshot({
          outbox: [
            { ...row, id: "leased", attemptCount: 5, leaseExpiresAt: minutesAfter(2) },
            { ...row, id: "lease-expired", attemptCount: 5, leaseExpiresAt: minutesBefore(1) },
            { ...row, id: "lease-at-now", attemptCount: 5, leaseExpiresAt: NOW.toISOString() },
            { ...row, id: "sent", attemptCount: 4, sentAt: minutesBefore(10) },
          ],
        }),
        NOW,
      );
      expect(ids(report.findings.stuck_notification)).toEqual(["lease-at-now", "lease-expired"]);
    });

    it("ignores a row whose entitlement was revoked: it can never be claimed or cleared", () => {
      const report = evaluateOperations(
        snapshot({
          outbox: [
            { ...row, id: "revoked", attemptCount: 4, entitlementStatus: "revoked" },
            { ...row, id: "active", attemptCount: 4 },
          ],
        }),
        NOW,
      );
      expect(ids(report.findings.stuck_notification)).toEqual(["active"]);
    });

    // S9: a gift row has no entitlement and no profile, so before the two-branch read it was
    // invisible here. A jammed gift is a paid purchase the recipient never hears about.
    const giftRow = {
      profileId: null,
      giftId: "gift-1",
      orderId: "order-1",
      reviewId: null,
      entitlementStatus: null,
      leaseExpiresAt: null,
      sentAt: null,
      createdAt: minutesBefore(300),
    };

    it("reports a stuck gift delivery, and points the repair at the admin gift surface", () => {
      const report = evaluateOperations(snapshot({ outbox: [{ ...giftRow, id: "gift-row", attemptCount: 4 }] }), NOW);

      expect(report.findings.stuck_notification).toEqual([
        {
          id: "gift-row",
          rule: "stuck_notification",
          occurredAt: minutesBefore(300),
          summary: expect.any(String),
          repairPath: "/admin/gifts",
        },
      ]);
    });

    it("never names the recipient, the claim link, or a profile page in a gift finding", () => {
      const report = evaluateOperations(snapshot({ outbox: [{ ...giftRow, id: "gift-row", attemptCount: 5 }] }), NOW);
      const [found] = report.findings.stuck_notification;

      expect(found.summary).not.toMatch(/@|claim\/|token/i);
      expect(found.repairPath).not.toMatch(/\/admin\/users|token|claim/);
    });

    it("applies the same attempt floor and lease test to a gift row", () => {
      const report = evaluateOperations(
        snapshot({
          outbox: [
            { ...giftRow, id: "too-few", attemptCount: 3 },
            { ...giftRow, id: "leased", attemptCount: 5, leaseExpiresAt: minutesAfter(2) },
            { ...giftRow, id: "sent", attemptCount: 5, sentAt: minutesBefore(10) },
            { ...giftRow, id: "stuck", attemptCount: 5 },
          ],
        }),
        NOW,
      );

      expect(ids(report.findings.stuck_notification)).toEqual(["stuck"]);
    });

    it("ignores a row that names neither a gift nor a profile", () => {
      const report = evaluateOperations(
        snapshot({
          outbox: [{ ...giftRow, id: "orphan", giftId: null, orderId: null, attemptCount: 5 }],
        }),
        NOW,
      );

      expect(report.findings.stuck_notification).toEqual([]);
    });

    const reviewRow = {
      profileId: "profile-7",
      giftId: null,
      orderId: null,
      reviewId: "review-1",
      entitlementStatus: null,
      leaseExpiresAt: null,
      sentAt: null,
      createdAt: minutesBefore(300),
    };

    it("reports a stuck review-reply delivery and points at the published reviews list", () => {
      const report = evaluateOperations(snapshot({ outbox: [{ ...reviewRow, id: "review-row", attemptCount: 4 }] }), NOW);
      expect(report.findings.stuck_notification).toEqual([
        {
          id: "review-row",
          rule: "stuck_notification",
          occurredAt: minutesBefore(300),
          summary: "Review reply email has failed at least 4 delivery attempts.",
          repairPath: "/admin/reviews?status=published",
        },
      ]);
    });

    it("applies the attempt floor and lease test to a review row", () => {
      const report = evaluateOperations(
        snapshot({
          outbox: [
            { ...reviewRow, id: "three", attemptCount: 3 },
            { ...reviewRow, id: "leased", attemptCount: 5, leaseExpiresAt: minutesAfter(2) },
            { ...reviewRow, id: "due", attemptCount: 4 },
          ],
        }),
        NOW,
      );
      expect(ids(report.findings.stuck_notification)).toEqual(["due"]);
    });
  });

  describe("unreviewed_manual_transfer_claim", () => {
    it("reports every unreviewed claim immediately, with no age threshold", () => {
      const now = "2026-09-22T10:00:00.000Z";
      const report = evaluateOperations(
        snapshot({ manualTransferClaims: [{ orderId: "order-1", claimedAt: now }] }),
        new Date(now),
      );
      expect(report.findings.unreviewed_manual_transfer_claim).toEqual([
        {
          id: "order-1",
          rule: "unreviewed_manual_transfer_claim",
          occurredAt: now,
          summary: "A reader reported a bank transfer that has not been reviewed.",
          repairPath: "/admin/orders/order-1",
        },
      ]);
    });

    it("orders claims oldest first", () => {
      const report = evaluateOperations(
        snapshot({
          manualTransferClaims: [
            { orderId: "newer", claimedAt: "2026-09-22T10:00:00.000Z" },
            { orderId: "older", claimedAt: "2026-09-22T08:00:00.000Z" },
          ],
        }),
        new Date("2026-09-22T11:00:00.000Z"),
      );
      expect(report.findings.unreviewed_manual_transfer_claim.map((f) => f.id)).toEqual(["older", "newer"]);
    });
  });

  describe("stale_reader_question", () => {
    it("reports a new question older than 7 days and nothing younger", () => {
      const now = new Date("2026-10-10T00:00:00Z");
      const report = evaluateOperations(
        snapshot({
          readerQuestions: [
            { id: "q-old", createdAt: "2026-10-01T00:00:00Z" },
            { id: "q-new", createdAt: "2026-10-08T00:00:00Z" },
          ],
        }),
        now,
      );
      expect(report.findings.stale_reader_question).toEqual([
        {
          id: "q-old",
          rule: "stale_reader_question",
          occurredAt: "2026-10-01T00:00:00.000Z",
          summary: "A reader question has waited more than 7 days.",
          repairPath: "/admin/questions",
        },
      ]);
    });

    it("is strictly older than 7 days: exactly 7 days is not yet a finding, 1 ms more is", () => {
      const now = new Date("2026-10-10T00:00:00.000Z");
      const report = evaluateOperations(
        snapshot({
          readerQuestions: [
            { id: "q-exact", createdAt: "2026-10-03T00:00:00.000Z" },
            { id: "q-over", createdAt: "2026-10-02T23:59:59.999Z" },
          ],
        }),
        now,
      );
      expect(ids(report.findings.stale_reader_question)).toEqual(["q-over"]);
    });
  });

  it("sorts findings oldest first, then by ID", () => {
    const report = evaluateOperations(
      snapshot({
        completedOrders: [
          { id: "b-newest", createdAt: minutesBefore(1), orderEntitlementStatuses: [] },
          { id: "z-oldest", createdAt: minutesBefore(90), orderEntitlementStatuses: [] },
          { id: "b-tie", createdAt: minutesBefore(30), orderEntitlementStatuses: [] },
          { id: "a-tie", createdAt: minutesBefore(30), orderEntitlementStatuses: [] },
        ],
      }),
      NOW,
    );
    expect(ids(report.findings.missing_order_entitlement)).toEqual(["z-oldest", "a-tie", "b-tie", "b-newest"]);
  });

  it("findings carry only the ID, rule, time, safe summary, and repair path", () => {
    const report = evaluateOperations(
      snapshot({
        epubJobs: [{ id: "j", bookId: "b", status: "queued", updatedAt: minutesBefore(40), leaseExpiresAt: null }],
        completedOrders: [{ id: "o", createdAt: minutesBefore(40), orderEntitlementStatuses: [] }],
        paymentEvents: [{ id: "e", orderId: "o", receivedAt: minutesBefore(40), processedAt: null }],
        outbox: [{ id: "n", profileId: "p", giftId: null, orderId: null, reviewId: null, entitlementStatus: "active", attemptCount: 4, leaseExpiresAt: null, sentAt: null, createdAt: minutesBefore(40) }],
      }),
      NOW,
    );
    const all = Object.values(report.findings).flat();
    expect(all).toHaveLength(4);
    for (const finding of all) {
      expect(Object.keys(finding).sort()).toEqual(["id", "occurredAt", "repairPath", "rule", "summary"]);
      expect(finding.repairPath.startsWith("/admin/")).toBe(true);
      expect(finding.summary).not.toMatch(/@/);
      expect(finding.summary.length).toBeGreaterThan(0);
    }
  });
});
