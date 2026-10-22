import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import JourneySessionPage from "@/app/[lang]/(account)/journeys/[slug]/sessions/[position]/page";
import { requireUser } from "@/lib/auth/session";
import { getMyJourneyProgress, getPublishedJourney } from "@/lib/data/journeys";
import { getPassageAnchor } from "@/lib/data/library";

vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/data/journeys", () => ({ getPublishedJourney: vi.fn(), getMyJourneyProgress: vi.fn() }));
vi.mock("@/lib/data/library", () => ({ getPassageAnchor: vi.fn() }));
vi.mock("./actions", () => ({ markSessionAction: vi.fn(), completeJourneyAction: vi.fn() }));

const EDITION = "20000000-0000-4000-8000-000000000001";

function journey(sessions: { position: number; href: string }[]) {
  return {
    id: "40000000-0000-4000-8000-000000000001",
    slug: "still-water",
    title: "Still Water",
    summary: "",
    sessionCount: sessions.length,
    bookId: "30000000-0000-4000-8000-000000000001",
    bookSlug: "still-water-book",
    bookTitle: "Still Water Book",
    editionId: EDITION,
    languageCode: "en",
    coverUrl: null,
    sessions: sessions.map(({ position, href }) => ({
      position,
      title: `Session ${position}`,
      guideMd: "",
      questions: [],
      startLocator: { href, type: "application/xhtml+xml", locations: {} },
      endLocator: null,
    })),
  } as unknown as Awaited<ReturnType<typeof getPublishedJourney>>;
}

const params = (position: string) => Promise.resolve({ lang: "en", slug: "still-water", position });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({} as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(getMyJourneyProgress).mockResolvedValue({ completedPositions: [], completed: false, reflection: null });
  vi.mocked(getPassageAnchor).mockResolvedValue(null);
});

afterEach(cleanup);

it("signs the reader in before loading anything", async () => {
  vi.mocked(requireUser).mockRejectedValue(new Error("NEXT_REDIRECT"));
  await expect(JourneySessionPage({ params: params("1") })).rejects.toThrow("NEXT_REDIRECT");
  expect(requireUser).toHaveBeenCalledWith("en", "/en/journeys/still-water/sessions/1");
  expect(getPublishedJourney).not.toHaveBeenCalled();
});

// Review Focus 1: the EPUB was re-uploaded and the session's start document is gone. The page still
// renders, and the reader link is the plain edition URL, opening at the saved position.
it("links to the plain edition URL when the start href is not in the current publication", async () => {
  vi.mocked(getPublishedJourney).mockResolvedValue(journey([{ position: 1, href: "OEBPS/text/removed.xhtml" }]));
  render(await JourneySessionPage({ params: params("1") }));
  expect(screen.getByRole("link", { name: "Open the reader at this passage" })).toHaveAttribute("href", `/en/read/editions/${EDITION}`);
});

it("links to the session's passage when its start href resolves to a chunk", async () => {
  vi.mocked(getPublishedJourney).mockResolvedValue(journey([{ position: 1, href: "OEBPS/text/c1.xhtml" }]));
  vi.mocked(getPassageAnchor).mockResolvedValue(4);
  render(await JourneySessionPage({ params: params("1") }));
  expect(screen.getByRole("link", { name: "Open the reader at this passage" })).toHaveAttribute("href", `/en/read/editions/${EDITION}?anchor=4`);
  expect(getPassageAnchor).toHaveBeenCalledWith("en", EDITION, expect.objectContaining({ href: "OEBPS/text/c1.xhtml" }));
});

it("shows the reflection form only on the last session", async () => {
  vi.mocked(getPublishedJourney).mockResolvedValue(
    journey([
      { position: 1, href: "a.xhtml" },
      { position: 2, href: "b.xhtml" },
    ]),
  );
  render(await JourneySessionPage({ params: params("1") }));
  expect(screen.queryByLabelText("What will you take with you from this journey?")).toBeNull();
  cleanup();
  render(await JourneySessionPage({ params: params("2") }));
  expect(screen.getByLabelText("What will you take with you from this journey?")).toBeInTheDocument();
});

it("is a 404 for a position the journey does not have", async () => {
  vi.mocked(getPublishedJourney).mockResolvedValue(journey([{ position: 1, href: "a.xhtml" }]));
  await expect(JourneySessionPage({ params: params("7") })).rejects.toThrow("NEXT_NOT_FOUND");
  await expect(JourneySessionPage({ params: params("abc") })).rejects.toThrow("NEXT_NOT_FOUND");
});
