import "server-only";

import { headers } from "next/headers";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/admin";
import { getRequestId } from "@/lib/observability/request-id";
import { createClient } from "@/lib/supabase/server";

// Translation error reports (Press spec section 11). A reader reports against the publication they
// are reading and the place in it; the editors read the inbox. Nothing here emails the original
// author.

export class ReportNotAllowedError extends Error {
  constructor() {
    super("This edition cannot be reported from this account.");
    this.name = "ReportNotAllowedError";
  }
}

export class TooManyReportsError extends Error {
  constructor() {
    super("Too many reports. Try again later.");
    this.name = "TooManyReportsError";
  }
}

export type ReportLocator = { href: string; progression?: number };

async function requestId(): Promise<string | null> {
  try {
    return getRequestId(await headers());
  } catch {
    return null;
  }
}

export async function submitEditionFeedback(publicationId: string, locator: ReportLocator | null, message: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("submit_edition_feedback", {
    p_publication_id: publicationId,
    // Always sent: the function has no default, and an omitted key makes PostgREST find no function.
    p_locator: locator,
    p_message: message,
  });
  if (!error) return;
  // EB008 is the reader rule's one refusal; 42501 an anonymous caller; both read as "not yours".
  if (error.code === "EB008" || error.code === "42501" || error.code === "P0002") throw new ReportNotAllowedError();
  if (error.code === "EB045") throw new TooManyReportsError();
  console.error("Edition feedback failed.", { code: error.code, requestId: await requestId() });
  throw new Error("submitEditionFeedback failed.");
}

export type AdminFeedbackStatus = "new" | "resolved" | "dismissed";

const feedbackSchema = z.object({
  id: z.string(),
  editionId: z.string(),
  bookId: z.string(),
  languageCode: z.string(),
  bookTitle: z.string(),
  publicationId: z.string(),
  locator: z.object({ href: z.string().optional(), progression: z.number().optional() }).passthrough().nullable().catch(null),
  message: z.string(),
  status: z.enum(["new", "resolved", "dismissed"]),
  adminNote: z.string().nullable(),
  createdAt: z.string(),
});

export type AdminFeedbackDTO = z.infer<typeof feedbackSchema>;

export async function listEditionFeedback(status: AdminFeedbackStatus): Promise<AdminFeedbackDTO[]> {
  await requireAdmin();
  const { data, error } = await (await createClient()).rpc("admin_list_edition_feedback", { p_status: status });
  if (error) {
    console.error("Feedback list failed.", { code: error.code, requestId: await requestId() });
    throw new Error("listEditionFeedback failed.");
  }
  return z.array(feedbackSchema).parse(data ?? []);
}

export async function resolveEditionFeedback(id: string, status: AdminFeedbackStatus, note: string | null): Promise<void> {
  await requireAdmin();
  const { error } = await (await createClient()).rpc("admin_resolve_edition_feedback", { p_id: id, p_status: status, p_note: note ?? "" });
  if (error) {
    console.error("Feedback resolve failed.", { code: error.code, requestId: await requestId() });
    throw new Error("resolveEditionFeedback failed.");
  }
}
