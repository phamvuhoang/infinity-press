// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { submitReportAction, type ReportState } from "@/app/[lang]/(account)/library/report/[editionId]/actions";
import { requireUser } from "@/lib/auth/session";
import { ReportNotAllowedError, submitEditionFeedback, TooManyReportsError } from "@/lib/data/edition-feedback";
import { getReadableEdition } from "@/lib/data/library";

vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers({ "x-request-id": "req-12345678" })) }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/data/library", () => ({ getReadableEdition: vi.fn() }));
vi.mock("@/lib/data/edition-feedback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/edition-feedback")>()),
  submitEditionFeedback: vi.fn(),
}));

const editionId = "50000000-0000-4000-8000-000000000001";
const publicationId = "60000000-0000-4000-8000-000000000001";
const idle: ReportState = { status: "idle", error: null };

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.mocked(requireUser).mockResolvedValue({} as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(getReadableEdition).mockResolvedValue({ publicationId } as Awaited<ReturnType<typeof getReadableEdition>>);
});

describe("submitReportAction", () => {
  it("gates on sign-in before anything else", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(submitReportAction("en", editionId, idle, form({ message: "x" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(submitEditionFeedback).not.toHaveBeenCalled();
  });

  it("files the report against the publication the READER holds, not one the browser names", async () => {
    const state = await submitReportAction("en", editionId, idle, form({ message: "  A clause is missing. ", href: "OEBPS/c1.xhtml", progression: "0.4", publicationId: "forged" }));
    expect(state).toEqual({ status: "sent", error: null });
    expect(submitEditionFeedback).toHaveBeenCalledWith(publicationId, { href: "OEBPS/c1.xhtml", progression: 0.4 }, "A clause is missing.");
  });

  it("sends the report without a place when the place is malformed", async () => {
    await submitReportAction("en", editionId, idle, form({ message: "ok", href: "OEBPS/c1.xhtml", progression: "7" }));
    expect(submitEditionFeedback).toHaveBeenCalledWith(publicationId, null, "ok");
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["a".repeat(2001), "tooLong"],
    ["<b>x</b>", "markup"],
  ] as const)("refuses %j as %s without filing anything", async (message, key) => {
    const state = await submitReportAction("en", editionId, idle, form({ message }));
    expect(state).toEqual({ status: "error", error: key });
    expect(submitEditionFeedback).not.toHaveBeenCalled();
  });

  it("says not-allowed for an edition the reader does not hold", async () => {
    vi.mocked(getReadableEdition).mockResolvedValue(null);
    expect(await submitReportAction("en", editionId, idle, form({ message: "x" }))).toEqual({ status: "error", error: "notAllowed" });
    expect(submitEditionFeedback).not.toHaveBeenCalled();
  });

  it("maps the database refusals to keys", async () => {
    vi.mocked(submitEditionFeedback).mockRejectedValueOnce(new ReportNotAllowedError());
    expect((await submitReportAction("en", editionId, idle, form({ message: "x" }))).error).toBe("notAllowed");
    vi.mocked(submitEditionFeedback).mockRejectedValueOnce(new TooManyReportsError());
    expect((await submitReportAction("en", editionId, idle, form({ message: "x" }))).error).toBe("tooMany");
    vi.mocked(submitEditionFeedback).mockRejectedValueOnce(new Error("boom"));
    expect((await submitReportAction("en", editionId, idle, form({ message: "x" }))).error).toBe("failed");
  });

  it("refuses an unsupported locale", async () => {
    expect((await submitReportAction("fr", editionId, idle, form({ message: "x" }))).error).toBe("failed");
  });
});
