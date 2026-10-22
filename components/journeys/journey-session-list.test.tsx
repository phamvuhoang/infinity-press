import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { JourneySessionList } from "@/components/journeys/journey-session-list";
import en from "@/lib/i18n/dictionaries/en.json";

afterEach(cleanup);

const sessions = Array.from({ length: 21 }, (_, index) => ({ position: index + 1, title: `Session title ${index + 1}` }));

it("counts done sessions, marks them, and continues at the first open one", () => {
  render(<JourneySessionList completedPositions={[1, 2]} copy={en.journeys} locale="en" sessions={sessions} slug="still-water" />);

  expect(screen.getByText("2/21 sessions done")).toBeInTheDocument();
  const items = screen.getAllByRole("listitem");
  expect(items).toHaveLength(21);
  expect(within(items[0]).getByText("Done")).toBeInTheDocument();
  expect(within(items[1]).getByText("Done")).toBeInTheDocument();
  expect(within(items[2]).queryByText("Done")).toBeNull();
  expect(screen.getByRole("link", { name: "Continue" })).toHaveAttribute("href", "/en/journeys/still-water/sessions/3");
});

it("starts at session 1 when nothing is done", () => {
  render(<JourneySessionList completedPositions={[]} copy={en.journeys} locale="en" sessions={sessions} slug="still-water" />);
  expect(screen.getByRole("link", { name: "Start the journey" })).toHaveAttribute("href", "/en/journeys/still-water/sessions/1");
});

it("renders an empty state and no continue link for a journey with no sessions", () => {
  render(<JourneySessionList completedPositions={[]} copy={en.journeys} locale="en" sessions={[]} slug="still-water" />);
  expect(screen.getByText("This journey has no sessions yet.")).toBeInTheDocument();
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.queryByText(/NaN|Infinity/)).toBeNull();
});

it("hides the continue link once every session is done", () => {
  const three = sessions.slice(0, 3);
  render(<JourneySessionList completedPositions={[1, 2, 3]} copy={en.journeys} locale="en" sessions={three} slug="still-water" />);
  expect(screen.getByText("3/3 sessions done")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Continue" })).toBeNull();
});
