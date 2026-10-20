// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createReaderAnnotation,
  deleteReaderAnnotation,
  listReaderAnnotations,
  ReaderDataDeniedError,
  ReaderDataInvalidError,
  ReaderDataUnavailableError,
  updateReaderAnnotation,
} from "@/lib/data/reader-annotations";
import type { AuthorizedReaderContext } from "@/lib/reader/session";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const publicationId = "c0000000-0000-4000-8000-000000000001";
const annotationId = "d0000000-0000-4000-8000-000000000001";
const context: AuthorizedReaderContext & { sessionId: string } = {
  sessionId: "e0000000-0000-4000-8000-000000000001",
  profileId: "10000000-0000-4000-8000-000000000001",
  publicationId,
  publicationVersion: 2,
};
const originalHref = "OEBPS/text/chapter.xhtml";
const readerHref = `/api/reader/publications/${publicationId}/resources/${originalHref}`;
const locator = {
  href: readerHref,
  progression: 0.25,
  totalProgression: 0.5,
  locations: { position: 4 },
  text: { before: "before", highlight: "selected", after: "after" },
};
const row = {
  id: annotationId,
  profile_id: context.profileId,
  publication_id: publicationId,
  kind: "highlight",
  locator_json: locator,
  selected_text: "selected",
  color: "yellow",
  note_text: null,
  label: null,
  created_at: "2026-09-20T00:00:00.000Z",
  updated_at: "2026-09-20T00:01:00.000Z",
};

function clientWith(results: Array<{ data: unknown; error: { code?: string; message?: string } | null }>) {
  const rpc = vi.fn().mockImplementation(() => Promise.resolve(results.shift() ?? { data: null, error: null }));
  return { client: { rpc } as unknown as Awaited<ReturnType<typeof createClient>>, rpc };
}

const member = { data: [{ index_available: true, is_member: true }], error: null };

beforeEach(() => vi.resetAllMocks());

describe("reader annotation DAL", () => {
  it("lists only validated owned rows and preserves their protected locator URLs", async () => {
    const fake = clientWith([{ data: [row], error: null }]);
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await expect(listReaderAnnotations(context)).resolves.toEqual([
      {
        id: annotationId,
        publicationId,
        kind: "highlight",
        locator,
        selectedText: "selected",
        color: "yellow",
        noteText: null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    ]);
    expect(fake.rpc).toHaveBeenNthCalledWith(1, "reader_annotation_request", {
      p_session_id: context.sessionId,
      p_publication_id: publicationId,
      p_operation: "list",
      p_annotation_id: null,
      p_payload: null,
    });
    expect(fake.rpc).toHaveBeenCalledTimes(1);
  });

  it("keeps the protected annotation locator and proves its original href belongs to the spine", async () => {
    const fake = clientWith([member, { data: [row], error: null }, member]);
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await createReaderAnnotation(context, {
      kind: "highlight",
      locator,
      selectedText: "selected",
      color: "yellow",
      noteText: null,
    });

    expect(fake.rpc).toHaveBeenNthCalledWith(1, "reader_publication_href_membership", {
      p_session_id: context.sessionId,
      p_publication_id: publicationId,
      p_href: originalHref,
    });
    expect(fake.rpc).toHaveBeenNthCalledWith(2, "reader_annotation_request", {
      p_session_id: context.sessionId,
      p_publication_id: publicationId,
      p_operation: "create",
      p_annotation_id: null,
      p_payload: {
        kind: "highlight",
        locator,
        selectedText: "selected",
        color: "yellow",
        noteText: null,
      },
    });
  });

  it("fails closed when a publication has not been position-indexed", async () => {
    const fake = clientWith([{ data: [{ index_available: false, is_member: false }], error: null }]);
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await expect(
      createReaderAnnotation(context, { kind: "bookmark", locator: { ...locator, text: undefined }, label: "Here" }),
    ).rejects.toBeInstanceOf(ReaderDataUnavailableError);
    expect(fake.rpc).toHaveBeenCalledTimes(1);
  });

  it("rejects a locator outside the indexed reading order", async () => {
    const fake = clientWith([{ data: [{ index_available: true, is_member: false }], error: null }]);
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await expect(
      createReaderAnnotation(context, { kind: "bookmark", locator: { ...locator, text: undefined }, label: "Here" }),
    ).rejects.toBeInstanceOf(ReaderDataInvalidError);
    expect(fake.rpc).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed stored row instead of casting it into a DTO", async () => {
    const fake = clientWith([{ data: [{ ...row, selected_text: "x".repeat(1_001) }], error: null }]);
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await expect(listReaderAnnotations(context)).rejects.toBeInstanceOf(ReaderDataUnavailableError);
  });

  it("classifies a foreign protected href in a stored row as unavailable data", async () => {
    const fake = clientWith([
      {
        data: [
          {
            ...row,
            locator_json: {
              ...locator,
              href: "/api/reader/publications/c0000000-0000-4000-8000-000000000002/resources/OEBPS/text/chapter.xhtml",
            },
          },
        ],
        error: null,
      },
    ]);
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await expect(listReaderAnnotations(context)).rejects.toBeInstanceOf(ReaderDataUnavailableError);
  });

  it("updates through the owner/publication/ID-filtered RPC and validates the returned row", async () => {
    const updated = { ...row, color: "green" };
    const fake = clientWith([{ data: [updated], error: null }, member]);
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await expect(updateReaderAnnotation(context, annotationId, { kind: "highlight", color: "green" })).resolves.toMatchObject({
      id: annotationId,
      color: "green",
    });
    expect(fake.rpc).toHaveBeenNthCalledWith(1, "reader_annotation_request", {
      p_session_id: context.sessionId,
      p_publication_id: publicationId,
      p_operation: "update",
      p_annotation_id: annotationId,
      p_payload: { kind: "highlight", color: "green" },
    });
  });

  it("deletes through the same scoped RPC and treats no row as an opaque denial", async () => {
    const ok = clientWith([{ data: [row], error: null }]);
    vi.mocked(createClient).mockResolvedValue(ok.client);
    await expect(deleteReaderAnnotation(context, annotationId)).resolves.toBeUndefined();

    const missing = clientWith([{ data: [], error: null }]);
    vi.mocked(createClient).mockResolvedValue(missing.client);
    await expect(deleteReaderAnnotation(context, annotationId)).rejects.toBeInstanceOf(ReaderDataDeniedError);
  });

  it("classifies database validation separately and never copies raw Postgres text", async () => {
    const invalid = clientWith([{ data: null, error: { code: "EB010", message: "offending selected text" } }]);
    vi.mocked(createClient).mockResolvedValue(invalid.client);
    const invalidError = await updateReaderAnnotation(context, annotationId, { kind: "highlight", color: "rose" }).catch(
      (error: unknown) => error,
    );
    expect(invalidError).toBeInstanceOf(ReaderDataInvalidError);
    expect((invalidError as Error).message).not.toContain("selected text");

    const unavailable = clientWith([{ data: null, error: { code: "XX000", message: "private row data" } }]);
    vi.mocked(createClient).mockResolvedValue(unavailable.client);
    const unavailableError = await listReaderAnnotations(context).catch((error: unknown) => error);
    expect(unavailableError).toBeInstanceOf(ReaderDataUnavailableError);
    expect((unavailableError as Error).message).not.toContain("private row data");
  });
});
