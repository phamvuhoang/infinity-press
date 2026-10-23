import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { SessionEditor } from "@/components/admin/journeys/session-editor";
import type { AdminJourneySessionDTO } from "@/lib/data/admin-journeys";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/admin/journeys/actions", () => ({
  saveSessionAction: vi.fn(),
  saveSessionLocalizationAction: vi.fn(),
  deleteSessionAction: vi.fn(),
}));

afterEach(cleanup);

const journeyId = "6b1b2c3d-0000-4000-8000-000000000001";
const tocHrefs = [
  { href: "text/ch1.xhtml", title: "Chapter 1" },
  { href: "text/ch2.xhtml", title: "Chapter 2" },
  { href: "text/ch2.xhtml#part-b", title: "Chapter 2, part B" },
  { href: "text/ch3.xhtml", title: "Chapter 3" },
];
const session = (position: number): AdminJourneySessionDTO => ({
  id: `6b1b2c3d-0000-4000-8000-00000000010${position}`,
  position,
  startHref: tocHrefs[position - 1].href,
  endHref: null,
  localizations: [],
});

it("renders one row per session", () => {
  render(<SessionEditor journeyId={journeyId} locales={["vi", "en"]} sessions={[1, 2, 3].map(session)} tocHrefs={tocHrefs} />);

  const list = screen.getByRole("list", { name: "Sessions" });
  expect(within(list).getAllByRole("listitem").map((row) => row.getAttribute("aria-label"))).toEqual(["Session 1", "Session 2", "Session 3"]);
});

it("defaults the new session's position to one past the highest", () => {
  render(<SessionEditor journeyId={journeyId} locales={["vi"]} sessions={[1, 2, 3].map(session)} tocHrefs={tocHrefs} />);

  const form = screen.getByRole("form", { name: "Add session" });
  expect(within(form).getByLabelText("Position")).toHaveValue(4);
});

it("starts at position 1 without sessions and lists every toc href in the start picker", () => {
  render(<SessionEditor journeyId={journeyId} locales={["vi"]} sessions={[]} tocHrefs={tocHrefs} />);

  const form = screen.getByRole("form", { name: "Add session" });
  expect(within(form).getByLabelText("Position")).toHaveValue(1);
  const values = within(within(form).getByLabelText("Start")).getAllByRole("option").map((option) => option.getAttribute("value"));
  expect(values.filter(Boolean)).toEqual(tocHrefs.map((entry) => entry.href));
});
