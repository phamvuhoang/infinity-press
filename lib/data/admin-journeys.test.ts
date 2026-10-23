// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import {
  createJourney,
  deleteSession,
  DuplicateJourneySlugError,
  getAdminJourney,
  JourneyEditionMismatchError,
  JourneyNotReadyError,
  setJourneyStatus,
  upsertSession,
} from "@/lib/data/admin-journeys";
import { recordingChain } from "@/lib/data/supabase-test-client";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/data/catalog", () => ({ getBookCards: vi.fn() }));
const { REQUEST_ID } = vi.hoisted(() => ({ REQUEST_ID: "70000000-0000-4000-8000-000000000001" }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers({ "x-request-id": REQUEST_ID })) }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

const JOURNEY_ID = "60000000-0000-4000-8000-000000000001";
const BOOK_ID = "30000000-0000-4000-8000-000000000001";
const EDITION_ID = "40000000-0000-4000-8000-000000000001";
const PUBLICATION_ID = "50000000-0000-4000-8000-000000000001";

// Each table answers its queries from its own queue, in order, and records every builder call.
function useAdmin(tables: Record<string, { data: unknown; error: unknown }[]>) {
  const calls: Record<string, [string, unknown[]][]> = {};
  const from = vi.fn((table: string) => {
    const result = tables[table]?.shift() ?? { data: null, error: null };
    return recordingChain(result, (calls[table] ??= [])).chain;
  });
  vi.mocked(createAdminClient).mockReturnValue({ from } as unknown as ReturnType<typeof createAdminClient>);
  return { calls, from };
}

const argsOf = (calls: [string, unknown[]][] | undefined, method: string) =>
  calls?.find(([name]) => name === method)?.[1];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("setJourneyStatus", () => {
  it("refuses to publish a journey without sessions", async () => {
    const { calls } = useAdmin({
      reading_journeys: [
        { data: { session_count: 0, edition: { language_code: "vi" }, localizations: [{ locale: "vi" }] }, error: null },
      ],
    });
    await expect(setJourneyStatus(JOURNEY_ID, "published")).rejects.toBeInstanceOf(JourneyNotReadyError);
    expect(argsOf(calls.reading_journeys, "update")).toBeUndefined();
  });

  it("refuses to publish without a localization in the edition's language", async () => {
    useAdmin({
      reading_journeys: [
        { data: { session_count: 3, edition: { language_code: "vi" }, localizations: [{ locale: "en" }] }, error: null },
      ],
    });
    await expect(setJourneyStatus(JOURNEY_ID, "published")).rejects.toBeInstanceOf(JourneyNotReadyError);
  });

  it("requires English for an edition whose language is not a UI locale", async () => {
    const ready = (locales: string[]) => ({
      data: { session_count: 2, edition: { language_code: "fr" }, localizations: locales.map((locale) => ({ locale })) },
      error: null,
    });
    useAdmin({ reading_journeys: [ready(["vi"])] });
    await expect(setJourneyStatus(JOURNEY_ID, "published")).rejects.toBeInstanceOf(JourneyNotReadyError);

    const { calls } = useAdmin({ reading_journeys: [ready(["en"]), { data: null, error: null }] });
    await setJourneyStatus(JOURNEY_ID, "published");
    expect(argsOf(calls.reading_journeys, "update")).toEqual([{ status: "published" }]);
  });

  it("logs a database failure with its code and request ID, not its message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    useAdmin({ journey_sessions: [{ data: null, error: { code: "08006", message: "secret detail" } }] });
    await expect(deleteSession(JOURNEY_ID)).rejects.toEqual(new Error("deleteSession failed."));
    expect(log).toHaveBeenCalledWith("Journey admin operation failed.", {
      operation: "deleteSession",
      code: "08006",
      requestId: REQUEST_ID,
    });
  });

  it("publishes a ready journey and authorizes before building the client", async () => {
    const { calls } = useAdmin({
      reading_journeys: [
        { data: { session_count: 1, edition: { language_code: "vi" }, localizations: [{ locale: "vi" }] }, error: null },
        { data: null, error: null },
      ],
    });
    await setJourneyStatus(JOURNEY_ID, "published");
    expect(argsOf(calls.reading_journeys, "update")).toEqual([{ status: "published" }]);
    expect(vi.mocked(requireAdmin).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(createAdminClient).mock.invocationCallOrder[0],
    );
  });
});

describe("upsertSession", () => {
  it("builds the start locator from the href and keeps a null end", async () => {
    const { calls } = useAdmin({ journey_sessions: [{ data: { id: "s1" }, error: null }] });
    await expect(
      upsertSession(JOURNEY_ID, { position: 1, startHref: "text/ch1.xhtml", endHref: null }),
    ).resolves.toEqual({ sessionId: "s1" });
    expect(argsOf(calls.journey_sessions, "upsert")).toEqual([
      {
        journey_id: JOURNEY_ID,
        position: 1,
        start_locator: { href: "text/ch1.xhtml", progression: 0, totalProgression: null, locations: {} },
        end_locator: null,
      },
      { onConflict: "journey_id,position" },
    ]);
  });

  it("rejects a position outside 1-60 before writing", async () => {
    const { from } = useAdmin({});
    await expect(upsertSession(JOURNEY_ID, { position: 61, startHref: "a.xhtml", endHref: null })).rejects.toThrow();
    expect(from).not.toHaveBeenCalled();
  });
});

describe("createJourney", () => {
  it("refuses an edition of a different book", async () => {
    const { calls } = useAdmin({ editions: [{ data: null, error: null }] });
    await expect(
      createJourney({ bookId: BOOK_ID, editionId: EDITION_ID, slug: "slow-reading" }),
    ).rejects.toBeInstanceOf(JourneyEditionMismatchError);
    expect(calls.editions).toContainEqual(["eq", ["book_id", BOOK_ID]]);
    expect(calls.reading_journeys).toBeUndefined();
  });

  it("creates the journey and maps a slug collision", async () => {
    useAdmin({
      editions: [{ data: { id: EDITION_ID }, error: null }],
      reading_journeys: [{ data: { id: JOURNEY_ID }, error: null }],
    });
    await expect(createJourney({ bookId: BOOK_ID, editionId: EDITION_ID, slug: "slow-reading" })).resolves.toEqual({
      journeyId: JOURNEY_ID,
    });

    useAdmin({
      editions: [{ data: { id: EDITION_ID }, error: null }],
      reading_journeys: [{ data: null, error: { code: "23505", message: "reading_journeys_slug_key" } }],
    });
    await expect(
      createJourney({ bookId: BOOK_ID, editionId: EDITION_ID, slug: "slow-reading" }),
    ).rejects.toBeInstanceOf(DuplicateJourneySlugError);
  });

  it("rejects a malformed slug before any query", async () => {
    const { from } = useAdmin({});
    await expect(createJourney({ bookId: BOOK_ID, editionId: EDITION_ID, slug: "No Spaces" })).rejects.toThrow();
    expect(from).not.toHaveBeenCalled();
  });
});

describe("getAdminJourney", () => {
  it("returns the journey, sorted sessions and the active publication's flattened toc", async () => {
    useAdmin({
      reading_journeys: [
        {
          data: {
            id: JOURNEY_ID,
            slug: "slow-reading",
            status: "draft",
            session_count: 2,
            book_id: BOOK_ID,
            edition_id: EDITION_ID,
            edition: { language_code: "vi", active_publication_id: PUBLICATION_ID },
            localizations: [{ locale: "vi", title: "Đọc chậm", summary: null }],
            sessions: [
              {
                id: "s2",
                position: 2,
                start_locator: { href: "b.xhtml", progression: 0, totalProgression: null, locations: {} },
                end_locator: null,
                localizations: [],
              },
              {
                id: "s1",
                position: 1,
                start_locator: { href: "a.xhtml", progression: 0, totalProgression: null, locations: {} },
                end_locator: { href: "b.xhtml", progression: 0, totalProgression: null, locations: {} },
                localizations: [{ locale: "vi", title: "Một", guide_md: null, questions: ["Q?"] }],
              },
            ],
          },
          error: null,
        },
      ],
      ebook_publications: [
        {
          data: {
            toc_json: [{ title: "Part", href: "a.xhtml", children: [{ title: "Ch", href: "b.xhtml", children: [] }] }],
          },
          error: null,
        },
      ],
    });
    const journey = await getAdminJourney(JOURNEY_ID);
    expect(journey.sessions.map((session) => [session.id, session.startHref, session.endHref])).toEqual([
      ["s1", "a.xhtml", "b.xhtml"],
      ["s2", "b.xhtml", null],
    ]);
    expect(journey.sessions[0].localizations).toEqual([{ locale: "vi", title: "Một", guideMd: "", questions: ["Q?"] }]);
    expect(journey.toc).toEqual([
      { title: "Part", href: "a.xhtml", depth: 0 },
      { title: "Ch", href: "b.xhtml", depth: 1 },
    ]);
  });

  it("is notFound for an unknown or malformed id", async () => {
    useAdmin({ reading_journeys: [{ data: null, error: null }] });
    await expect(getAdminJourney(JOURNEY_ID)).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(getAdminJourney("nope")).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
