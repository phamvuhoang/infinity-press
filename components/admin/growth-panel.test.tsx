import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { GrowthPanel } from "@/components/admin/growth-panel";

afterEach(cleanup);

const BOOK_ID = "30000000-0000-4000-8000-000000000001";

it("shows every figure against its denominator and never divides by zero", () => {
  render(
    <GrowthPanel
      days={30}
      report={{
        funnel: [{ bookId: BOOK_ID, bookTitle: "Book", openSample: 0, openReader: 0, sessionCompletedReaders: 0, journeyCompleted: 0 }],
        retention: [{ cohortDay: "2026-10-01", activated: 0, returnedD7: 0, rate: null }],
        share: { shared: 0, opened: 0, continued: 0 },
      }}
    />,
  );

  const row = screen.getByRole("rowheader", { name: "Book" }).closest("tr")!;
  expect(within(row).getAllByText("0 / 0")).toHaveLength(3);
  expect(within(screen.getByRole("rowheader", { name: "2026-10-01" }).closest("tr")!).getByText("0 / 0")).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  expect(screen.queryByText(/%/)).toBeNull();
});

it("adds a percentage when the denominator is above 0, and links the two windows", () => {
  render(
    <GrowthPanel
      days={90}
      report={{
        funnel: [{ bookId: BOOK_ID, bookTitle: "Book", openSample: 4, openReader: 2, sessionCompletedReaders: 2, journeyCompleted: 0 }],
        retention: [],
        share: { shared: 4, opened: 1, continued: 0 },
      }}
    />,
  );

  const row = screen.getByRole("rowheader", { name: "Book" }).closest("tr")!;
  expect(within(row).getByText("2 / 4")).toBeInTheDocument();
  expect(within(row).getByText("50%")).toBeInTheDocument();
  expect(screen.getByText("25%")).toBeInTheDocument();
  expect(screen.getByText("No first sessions in this window.")).toBeInTheDocument();
  const windows = screen.getByRole("navigation", { name: "Report window" });
  expect(within(windows).getByRole("link", { name: "30 days" })).toHaveAttribute("href", "/admin/growth?days=30");
  expect(within(windows).getByRole("link", { name: "90 days" })).toHaveAttribute("aria-current", "page");
});
