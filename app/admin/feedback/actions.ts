"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/admin";
import { fieldErrorsFrom, readOptionalText, type AdminFormState } from "@/lib/catalog/form";
import { resolveEditionFeedback } from "@/lib/data/edition-feedback";
import { getRequestId } from "@/lib/observability/request-id";

// Triage of reader translation reports. A Server Action is a public endpoint: it gates on
// requireAdmin() itself, and the id and status are validated like posted values.
const schema = z.object({
  status: z.enum(["new", "resolved", "dismissed"]),
  note: z.string().trim().max(2000, "Keep the note to 2000 characters.").nullable(),
});

export async function resolveFeedbackAction(id: string, _previous: AdminFormState, formData: FormData): Promise<AdminFormState> {
  await requireAdmin({ next: "/admin/feedback" });
  if (!z.uuid().safeParse(id).success) return { fieldErrors: {}, formError: "Reload the report before triaging it.", savedAt: null };
  const parsed = schema.safeParse({ status: String(formData.get("status") ?? ""), note: readOptionalText(formData, "note") });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error), formError: null, savedAt: null };
  try {
    await resolveEditionFeedback(id, parsed.data.status, parsed.data.note);
  } catch (error) {
    console.error("Resolve edition feedback failed.", { feedbackId: id, requestId: getRequestId(await headers()), error: String(error) });
    return { fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null };
  }
  revalidatePath("/admin/feedback");
  return { fieldErrors: {}, formError: null, savedAt: Date.now() };
}
