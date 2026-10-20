"use server";

import { requireAdmin } from "@/lib/auth/admin";
import type { ReadinessIssueCode } from "@/lib/catalog/readiness";
import { revalidateBookAdmin } from "@/lib/catalog/revalidate";
import { BookNotReadyError, publishBook, unpublishBook } from "@/lib/data/books";

export type PublishActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string; issues: ReadinessIssueCode[] };

const generic = "Something went wrong. Try again.";

export async function publishBookAction(bookId: string): Promise<PublishActionResult> {
  await requireAdmin({ next: `/admin/books/${bookId}` });
  try {
    await publishBook(bookId);
  } catch (error) {
    if (error instanceof BookNotReadyError) return { ok: false, error: error.message, issues: error.issues };
    return { ok: false, error: generic, issues: [] };
  }
  revalidateBookAdmin(bookId);
  return { ok: true, message: "Book published." };
}

export async function unpublishBookAction(bookId: string): Promise<PublishActionResult> {
  await requireAdmin({ next: `/admin/books/${bookId}` });
  try {
    await unpublishBook(bookId);
  } catch {
    return { ok: false, error: generic, issues: [] };
  }
  revalidateBookAdmin(bookId);
  return { ok: true, message: "Book unpublished." };
}
