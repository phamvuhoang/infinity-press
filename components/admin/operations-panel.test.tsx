import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { OperationsPanel } from "@/components/admin/operations-panel";
import { OPS_RULE_NAMES, type OperationsAlertState, type OperationsReport, type OpsFinding } from "@/lib/ops/types";

afterEach(cleanup);

const NOW = new Date("2026-09-18T12:00:00.000Z");

function emptyReport(evaluatedAt = NOW.toISOString()): OperationsReport {
  return {
    evaluatedAt,
    findings: {
      stale_epub_job: [],
      missing_order_entitlement: [],
      unprocessed_payment_event: [],
      stuck_notification: [],
      unreviewed_manual_transfer_claim: [],
      stale_reader_question: [],
    },
  };
}

function finding(overrides: Partial<OpsFinding> & Pick<OpsFinding, "rule" | "id">): OpsFinding {
  return {
    occurredAt: "2026-09-18T11:30:00.000Z",
    summary: "placeholder summary",
    repairPath: "/admin",
    ...overrides,
  };
}

function alertState(overrides: Partial<OperationsAlertState> & Pick<OperationsAlertState, "ruleName">): OperationsAlertState {
  return {
    active: false,
    fingerprint: null,
    firstDetectedAt: null,
    lastEvaluatedAt: "2026-09-18T11:55:00.000Z",
    lastAlertedAt: null,
    resolvedAt: null,
    ...overrides,
  };
}

it("shows a healthy empty state when every rule is clear", () => {
  render(
    <OperationsPanel
      alertStates={OPS_RULE_NAMES.map((ruleName) => alertState({ ruleName }))}
      now={NOW}
      report={emptyReport()}
    />,
  );

  expect(screen.getByRole("status")).toHaveTextContent("All operational checks are clear.");
  expect(screen.queryByRole("heading", { level: 2, name: /EPUB|order|payment|email/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  expect(screen.getByText(/Last scheduler evaluation/i)).toBeInTheDocument();
});

it("shows \"Not yet run\" before the first scheduled worker run, as the migration seeds it", () => {
  render(
    <OperationsPanel
      alertStates={OPS_RULE_NAMES.map((ruleName) => alertState({ ruleName, lastEvaluatedAt: null }))}
      now={NOW}
      report={emptyReport()}
    />,
  );

  expect(screen.getByText("Not yet run")).toBeInTheDocument();
});

it("shows the latest scheduler evaluation when only some rows have been evaluated", () => {
  render(
    <OperationsPanel
      alertStates={[
        alertState({ ruleName: "stale_epub_job", lastEvaluatedAt: "2026-09-18T11:58:00.000Z" }),
        alertState({ ruleName: "missing_order_entitlement", lastEvaluatedAt: null }),
      ]}
      now={NOW}
      report={emptyReport()}
    />,
  );

  expect(screen.queryByText("Not yet run")).not.toBeInTheDocument();
  expect(screen.getByText(/Last scheduler evaluation/i).nextElementSibling).toHaveTextContent(/2026/);
});

it("groups findings by rule with a count, an age, a safe summary, and a repair link inside /admin", () => {
  const report: OperationsReport = {
    evaluatedAt: NOW.toISOString(),
    findings: {
      stale_epub_job: [
        finding({
          id: "job-1",
          rule: "stale_epub_job",
          occurredAt: "2026-09-18T11:00:00.000Z",
          summary: "EPUB processing job has not progressed for more than 30 minutes.",
          repairPath: "/admin/books/book-1#epub",
        }),
      ],
      missing_order_entitlement: [
        finding({
          id: "order-1",
          rule: "missing_order_entitlement",
          occurredAt: "2026-09-18T10:00:00.000Z",
          summary: "Completed order has no active or revoked order entitlement.",
          repairPath: "/admin/orders/order-1",
        }),
      ],
      unprocessed_payment_event: [
        finding({
          id: "event-1",
          rule: "unprocessed_payment_event",
          occurredAt: "2026-09-18T11:50:00.000Z",
          summary: "Payment event has not been processed for more than 5 minutes.",
          repairPath: "/admin/orders/order-2",
        }),
      ],
      stuck_notification: [
        finding({
          id: "outbox-1",
          rule: "stuck_notification",
          occurredAt: "2026-09-17T12:00:00.000Z",
          summary: "Book-ready email has failed at least 4 delivery attempts.",
          repairPath: "/admin/users/user-1",
        }),
      ],
      unreviewed_manual_transfer_claim: [],
      stale_reader_question: [],
    },
  };
  const alertStates: OperationsAlertState[] = [
    alertState({ ruleName: "stale_epub_job", active: true, lastAlertedAt: "2026-09-18T11:05:00.000Z", lastEvaluatedAt: "2026-09-18T11:58:00.000Z" }),
    alertState({ ruleName: "missing_order_entitlement", lastEvaluatedAt: "2026-09-18T11:58:00.000Z" }),
    alertState({ ruleName: "unprocessed_payment_event", lastEvaluatedAt: "2026-09-18T11:58:00.000Z" }),
    alertState({ ruleName: "stuck_notification", lastEvaluatedAt: "2026-09-18T11:58:00.000Z" }),
  ];

  render(<OperationsPanel alertStates={alertStates} now={NOW} report={report} />);

  expect(screen.queryByRole("status")).not.toBeInTheDocument();

  const groups: Array<{ heading: RegExp; summary: string; repairPath: string }> = [
    { heading: /Stale EPUB jobs \(1\)/, summary: "EPUB processing job has not progressed for more than 30 minutes.", repairPath: "/admin/books/book-1#epub" },
    { heading: /Completed orders without an entitlement \(1\)/, summary: "Completed order has no active or revoked order entitlement.", repairPath: "/admin/orders/order-1" },
    { heading: /Unprocessed payment events \(1\)/, summary: "Payment event has not been processed for more than 5 minutes.", repairPath: "/admin/orders/order-2" },
    { heading: /Stuck book-ready emails \(1\)/, summary: "Book-ready email has failed at least 4 delivery attempts.", repairPath: "/admin/users/user-1" },
  ];

  for (const group of groups) {
    const heading = screen.getByRole("heading", { level: 2, name: group.heading });
    const section = heading.closest("section");
    expect(section).not.toBeNull();
    const scoped = within(section as HTMLElement);
    const summaryNode = scoped.getByText(group.summary);
    expect(summaryNode).toBeInTheDocument();
    const row = summaryNode.closest("li");
    expect(row).toHaveTextContent(/ago|Just now/);
    const link = scoped.getByRole("link", { name: "Review" });
    expect(link).toHaveAttribute("href", group.repairPath);
    expect(link.getAttribute("href")).toMatch(/^\/admin\//);
  }

  // Last successful alert time is shown for the one active rule, and not implied for inactive ones.
  expect(screen.getByText("Stale EPUB jobs:")).toBeInTheDocument();
  expect(screen.getByText(/Sep 18, 2026, 6:05 PM/)).toBeInTheDocument();

  // Safety: no customer email, provider payload, or book content ever renders - only what
  // OpsFinding/OperationsAlertState carry.
  expect(screen.queryByText(/@/)).not.toBeInTheDocument();
});
