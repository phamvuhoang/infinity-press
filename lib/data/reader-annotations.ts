import "server-only";

import {
  parseAnnotationDraft,
  parseAnnotationPatch,
  type AnnotationDraft,
  type AnnotationPatch,
  type ReaderAnnotation,
} from "@/lib/reader/annotations";
import { toPublicationResourceHref } from "@/lib/reader/locator-paths";
import type { AuthorizedReaderContext } from "@/lib/reader/session";
import { createClient } from "@/lib/supabase/server";

type ReaderContext = AuthorizedReaderContext & { sessionId: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ReaderDataDeniedError extends Error {
  constructor() {
    super("Not found.");
    this.name = "ReaderDataDeniedError";
  }
}

export class ReaderDataInvalidError extends Error {
  constructor() {
    super("Invalid reader data.");
    this.name = "ReaderDataInvalidError";
  }
}

export class ReaderDataUnavailableError extends Error {
  constructor(readonly code: string | null = null) {
    super("Reader data is temporarily unavailable.");
    this.name = "ReaderDataUnavailableError";
  }
}

type AnnotationRow = {
  id: string;
  profile_id: string;
  publication_id: string;
  kind: unknown;
  locator_json: unknown;
  selected_text: unknown;
  color: unknown;
  note_text: unknown;
  label: unknown;
  created_at: unknown;
  updated_at: unknown;
};

function firstRow<T>(data: unknown): T | null {
  return Array.isArray(data) ? ((data[0] as T | undefined) ?? null) : ((data as T | null) ?? null);
}

function rpcError(error: { code?: string } | null): Error {
  if (error?.code === "EB010" || error?.code === "22023" || error?.code === "23514") {
    return new ReaderDataInvalidError();
  }
  if (error?.code === "EB008") return new ReaderDataDeniedError();
  if (error?.code === "EB014") return new ReaderDataUnavailableError("positions_unavailable");
  return new ReaderDataUnavailableError(error?.code ?? null);
}

function rowToAnnotation(row: AnnotationRow, context: ReaderContext): ReaderAnnotation {
  if (
    !UUID_PATTERN.test(row.id) ||
    row.profile_id !== context.profileId ||
    row.publication_id !== context.publicationId ||
    typeof row.created_at !== "string" ||
    typeof row.updated_at !== "string"
  ) {
    throw new ReaderDataUnavailableError("invalid_response");
  }

  if (typeof row.locator_json !== "object" || row.locator_json === null) {
    throw new ReaderDataUnavailableError("invalid_response");
  }
  const storedLocator = row.locator_json as Record<string, unknown>;
  if (typeof storedLocator.href !== "string") throw new ReaderDataUnavailableError("invalid_response");

  const locator = storedLocator;

  try {
    const draft = parseAnnotationDraft(
      row.kind === "highlight"
        ? {
            kind: "highlight",
            locator,
            selectedText: row.selected_text,
            color: row.color,
            noteText: row.note_text,
          }
        : { kind: row.kind, locator, label: row.label },
    );
    return {
      ...draft,
      id: row.id,
      publicationId: row.publication_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch {
    throw new ReaderDataUnavailableError("invalid_response");
  }
}

function originalHrefFromStored(context: ReaderContext, href: string): string {
  try {
    return toPublicationResourceHref(context.publicationId, href);
  } catch {
    throw new ReaderDataUnavailableError("invalid_response");
  }
}

async function requireHrefMembership(
  client: Awaited<ReturnType<typeof createClient>>,
  context: ReaderContext,
  href: string,
): Promise<void> {
  const { data, error } = await client.rpc("reader_publication_href_membership", {
    p_session_id: context.sessionId,
    p_publication_id: context.publicationId,
    p_href: href,
  });
  if (error) throw rpcError(error);
  const result = firstRow<{ index_available: boolean; is_member: boolean }>(data);
  if (!result) throw new ReaderDataDeniedError();
  if (!result.index_available) throw new ReaderDataUnavailableError("positions_unavailable");
  if (!result.is_member) throw new ReaderDataInvalidError();
}

async function validateReturnedAnnotation(
  client: Awaited<ReturnType<typeof createClient>>,
  context: ReaderContext,
  row: AnnotationRow,
): Promise<ReaderAnnotation> {
  const annotation = rowToAnnotation(row, context);
  const originalHref = originalHrefFromStored(context, annotation.locator.href);
  await requireHrefMembership(client, context, originalHref);
  return annotation;
}

async function annotationRpc(
  client: Awaited<ReturnType<typeof createClient>>,
  context: ReaderContext,
  operation: "list" | "create" | "update" | "delete",
  annotationId: string | null,
  payload: AnnotationDraft | AnnotationPatch | null,
): Promise<unknown[]> {
  const { data, error } = await client.rpc("reader_annotation_request", {
    p_session_id: context.sessionId,
    p_publication_id: context.publicationId,
    p_operation: operation,
    p_annotation_id: annotationId,
    p_payload: payload,
  });
  if (error) throw rpcError(error);
  if (!Array.isArray(data)) throw new ReaderDataUnavailableError("invalid_response");
  return data;
}

export async function listReaderAnnotations(context: ReaderContext): Promise<ReaderAnnotation[]> {
  const client = await createClient();
  const rows = await annotationRpc(client, context, "list", null, null);
  // The list RPC validates every stored locator against the indexed reading order in the same
  // authorized transaction before returning any rows. Repeating the membership RPC per row here
  // made opening a reader O(annotation count) network round trips without adding a boundary.
  return rows.map((row) => {
    const annotation = rowToAnnotation(row as AnnotationRow, context);
    // Keep the application-boundary shape check: the RPC proves membership, while this rejects a
    // malformed/foreign protected URL before it can become a client DTO.
    originalHrefFromStored(context, annotation.locator.href);
    return annotation;
  });
}

export async function createReaderAnnotation(
  context: ReaderContext,
  value: AnnotationDraft,
): Promise<ReaderAnnotation> {
  let draft: AnnotationDraft;
  let originalHref: string;
  try {
    draft = parseAnnotationDraft(value);
    originalHref = toPublicationResourceHref(context.publicationId, draft.locator.href);
  } catch {
    throw new ReaderDataInvalidError();
  }

  const client = await createClient();
  await requireHrefMembership(client, context, originalHref);
  const rows = await annotationRpc(client, context, "create", null, draft);
  const row = firstRow<AnnotationRow>(rows);
  if (!row) throw new ReaderDataDeniedError();
  return validateReturnedAnnotation(client, context, row);
}

export async function updateReaderAnnotation(
  context: ReaderContext,
  annotationId: string,
  value: AnnotationPatch,
): Promise<ReaderAnnotation> {
  if (!UUID_PATTERN.test(annotationId)) throw new ReaderDataDeniedError();
  let patch: AnnotationPatch;
  try {
    patch = parseAnnotationPatch(value);
  } catch {
    throw new ReaderDataInvalidError();
  }
  const client = await createClient();
  const rows = await annotationRpc(client, context, "update", annotationId, patch);
  const row = firstRow<AnnotationRow>(rows);
  if (!row) throw new ReaderDataDeniedError();
  return validateReturnedAnnotation(client, context, row);
}

export async function deleteReaderAnnotation(context: ReaderContext, annotationId: string): Promise<void> {
  if (!UUID_PATTERN.test(annotationId)) throw new ReaderDataDeniedError();
  const client = await createClient();
  const rows = await annotationRpc(client, context, "delete", annotationId, null);
  if (!firstRow(rows)) throw new ReaderDataDeniedError();
}
