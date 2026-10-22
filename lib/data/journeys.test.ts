// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getBookCards } from "@/lib/data/catalog";
import {
  completeJourney,
  getMyJourneyProgress,
  getMyJourneys,
  getPublishedJourney,
  JourneyNotAvailableError,
  markJourneySession,
} from "@/lib/data/journeys";
import { fakeSupabaseClient } from "@/lib/data/supabase-test-client";
import { createPublicClient } from "@/lib/supabase/public";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/data/catalog", () => ({ getBookCards: vi.fn() }));
vi.mock("@/lib/supabase/public", () => ({ createPublicClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const JOURNEY_ID = "60000000-0000-4000-8000-000000000001";
const BOOK_ID = "30000000-0000-4000-8000-000000000001";
const EDITION_ID = "40000000-0000-4000-8000-000000000001";

const locator = (href: string) => ({ href, progression: 0, totalProgression: null, locations: {} });

function journeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: JOURNEY_ID,
    slug: "slow-reading",
    book_id: BOOK_ID,
    edition_id: EDITION_ID,
    session_count: 2,
    edition: { language_code: "vi" },
    localizations: [
      { locale: "vi", title: "Đọc chậm", summary: "Hai buổi." },
      { locale: "en", title: "Slow reading", summary: null },
    ],
    // Out of order on purpose: the DTO sorts by position.
    sessions: [
      {
        position: 2,
        start_locator: locator("ch2.xhtml"),
        end_locator: null,
        localizations: [{ locale: "en", title: "Two", guide_md: null, questions: [] }],
      },
      {
        position: 1,
        start_locator: locator("ch1.xhtml"),
        end_locator: locator("ch2.xhtml"),
        localizations: [{ locale: "en", title: "One", guide_md: "Read **slowly**.", questions: ["Why?"] }],
      },
    ],
    ...overrides,
  };
}

const card = {
  bookId: BOOK_ID,
  slug: "the-book",
  title: "The Book",
  cover: { url: "https://cdn.test/covers/b.jpg", alt: "The Book" },
};

function usePublic(result: { data: unknown; error: unknown }) {
  const fake = fakeSupabaseClient({ tables: { reading_journeys: result } });
  vi.mocked(createPublicClient).mockReturnValue(fake.client as ReturnType<typeof createPublicClient>);
  return fake;
}

function useSession(options: Parameters<typeof fakeSupabaseClient>[0]) {
  const fake = fakeSupabaseClient(options);
  vi.mocked(createClient).mockResolvedValue(fake.client as Awaited<ReturnType<typeof createClient>>);
  return fake;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBookCards).mockResolvedValue([card] as unknown as Awaited<ReturnType<typeof getBookCards>>);
});

describe("getPublishedJourney", () => {
  it("returns null when no published journey matches", async () => {
    usePublic({ data: null, error: null });
    await expect(getPublishedJourney("en", "slow-reading")).resolves.toBeNull();
  });

  it("returns null without a query for a malformed slug", async () => {
    const fake = usePublic({ data: journeyRow(), error: null });
    await expect(getPublishedJourney("en", "../x")).resolves.toBeNull();
    expect(fake.from).not.toHaveBeenCalled();
  });

  it("maps rows to the DTO with sessions in position order", async () => {
    usePublic({ data: journeyRow(), error: null });
    await expect(getPublishedJourney("en", "slow-reading")).resolves.toEqual({
      id: JOURNEY_ID,
      slug: "slow-reading",
      title: "Slow reading",
      summary: "",
      sessionCount: 2,
      bookId: BOOK_ID,
      bookSlug: "the-book",
      bookTitle: "The Book",
      editionId: EDITION_ID,
      languageCode: "vi",
      coverUrl: "https://cdn.test/covers/b.jpg",
      sessions: [
        {
          position: 1,
          title: "One",
          guideMd: "Read **slowly**.",
          questions: ["Why?"],
          startLocator: locator("ch1.xhtml"),
          endLocator: locator("ch2.xhtml"),
        },
        { position: 2, title: "Two", guideMd: "", questions: [], startLocator: locator("ch2.xhtml"), endLocator: null },
      ],
    });
  });

  it("falls back to the edition language before English", async () => {
    usePublic({ data: journeyRow(), error: null });
    const journey = await getPublishedJourney("ja", "slow-reading");
    expect(journey?.title).toBe("Đọc chậm");
    expect(journey?.summary).toBe("Hai buổi.");
  });

  it("falls back to English when the edition language has no localization", async () => {
    usePublic({ data: journeyRow({ edition: { language_code: "ja" } }), error: null });
    expect((await getPublishedJourney("ja", "slow-reading"))?.title).toBe("Slow reading");
  });

  it("hides a journey whose book is not in the public catalog", async () => {
    usePublic({ data: journeyRow(), error: null });
    vi.mocked(getBookCards).mockResolvedValue([]);
    await expect(getPublishedJourney("en", "slow-reading")).resolves.toBeNull();
  });
});

describe("journey progress", () => {
  it("reads the caller's completed positions and completion", async () => {
    useSession({
      tables: {
        journey_progress: { data: [{ position: 3 }, { position: 1 }], error: null },
        journey_completions: { data: { reflection: "Good." }, error: null },
      },
    });
    await expect(getMyJourneyProgress(JOURNEY_ID)).resolves.toEqual({
      completedPositions: [1, 3],
      completed: true,
      reflection: "Good.",
    });
  });

  it("lists journeys with progress and skips the journeys query when there is none", async () => {
    const empty = useSession({
      tables: { journey_progress: { data: [], error: null }, journey_completions: { data: [], error: null } },
    });
    await expect(getMyJourneys("en")).resolves.toEqual([]);
    expect(empty.from).not.toHaveBeenCalledWith("reading_journeys");

    useSession({
      tables: {
        journey_progress: { data: [{ journey_id: JOURNEY_ID, position: 2 }], error: null },
        journey_completions: { data: [], error: null },
        reading_journeys: { data: [journeyRow({ sessions: undefined })], error: null },
      },
    });
    const [journey] = await getMyJourneys("en");
    expect(journey).toMatchObject({
      id: JOURNEY_ID,
      title: "Slow reading",
      completedPositions: [2],
      completed: false,
      reflection: null,
    });
  });
});

describe("journey RPCs", () => {
  it("marks a session through the RPC", async () => {
    const fake = useSession({ rpc: { data: null, error: null } });
    await markJourneySession(JOURNEY_ID, 2);
    expect(fake.rpc).toHaveBeenCalledWith("mark_journey_session", { p_journey_id: JOURNEY_ID, p_position: 2 });
  });

  it.each(["P0002", "22023", "EB047"])("throws JourneyNotAvailableError on %s", async (code) => {
    useSession({ rpc: { data: null, error: { code, message: "refused" } } });
    await expect(markJourneySession(JOURNEY_ID, 1)).rejects.toBeInstanceOf(JourneyNotAvailableError);
    await expect(completeJourney(JOURNEY_ID, "x")).rejects.toBeInstanceOf(JourneyNotAvailableError);
  });

  it("does not disguise other database errors as unavailability", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    useSession({ rpc: { data: null, error: { code: "08006", message: "connection lost" } } });
    const error = await completeJourney(JOURNEY_ID, null).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(JourneyNotAvailableError);
    expect(error).toEqual(new Error("completeJourney failed."));
  });
});
