// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import {
  listEditionFeedback,
  ReportNotAllowedError,
  resolveEditionFeedback,
  submitEditionFeedback,
  TooManyReportsError,
} from "@/lib/data/edition-feedback";
import { fakeSupabaseClient } from "@/lib/data/supabase-test-client";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers({ "x-request-id": "req-12345678" })) }));

type SessionClient = Awaited<ReturnType<typeof createClient>>;
const publicationId = "6a1b2c3d-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("submitEditionFeedback", () => {
  it("sends an explicit null locator when the reader has no place, so the RPC is still found", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: "id", error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await submitEditionFeedback(publicationId, null, "A clause is missing.");

    expect(fake.rpc).toHaveBeenCalledWith("submit_edition_feedback", {
      p_publication_id: publicationId,
      p_locator: null,
      p_message: "A clause is missing.",
    });
  });

  it("sends the publication, the place and the words, and nothing about who", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: "id", error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await submitEditionFeedback(publicationId, { href: "OEBPS/c1.xhtml", progression: 0.4 }, "A clause is missing.");

    expect(fake.rpc).toHaveBeenCalledWith("submit_edition_feedback", {
      p_publication_id: publicationId,
      p_locator: { href: "OEBPS/c1.xhtml", progression: 0.4 },
      p_message: "A clause is missing.",
    });
  });

  it.each([["EB008"], ["42501"], ["P0002"]])("turns %s into one refusal that says nothing about why", async (code) => {
    const fake = fakeSupabaseClient({ rpc: { data: null, error: { code, message: "x" } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(submitEditionFeedback(publicationId, null, "x")).rejects.toBeInstanceOf(ReportNotAllowedError);
  });

  it("reports rate limiting as its own error", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: null, error: { code: "EB045", message: "too many" } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(submitEditionFeedback(publicationId, null, "x")).rejects.toBeInstanceOf(TooManyReportsError);
  });

  it("never leaks database text from an unexpected failure", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: null, error: { code: "XX000", message: "relation edition_feedback broke" } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(submitEditionFeedback(publicationId, null, "x")).rejects.toThrow("submitEditionFeedback failed.");
  });
});

describe("admin inbox", () => {
  it("authorizes before it builds a client", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
    await expect(listEditionFeedback("new")).rejects.toThrow("NEXT_FORBIDDEN");
    await expect(resolveEditionFeedback("id", "resolved", null)).rejects.toThrow("NEXT_FORBIDDEN");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("lists reports and drops a malformed locator rather than failing the inbox", async () => {
    const fake = fakeSupabaseClient({
      rpc: {
        data: [
          { id: "a", editionId: "e", bookId: "b", languageCode: "ja", bookTitle: "T", publicationId, locator: "nope", message: "m", status: "new", adminNote: null, createdAt: "2026-10-20T00:00:00Z" },
        ],
        error: null,
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    const [item] = await listEditionFeedback("new");
    expect(item).toMatchObject({ id: "a", languageCode: "ja", locator: null });
  });

  it("resolves a report with an optional note", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: null, error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await resolveEditionFeedback("id", "resolved", "Fixed in v2");
    expect(fake.rpc).toHaveBeenCalledWith("admin_resolve_edition_feedback", { p_id: "id", p_status: "resolved", p_note: "Fixed in v2" });
  });
});
