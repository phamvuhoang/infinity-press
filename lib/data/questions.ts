import "server-only";
import { locales } from "@/lib/i18n/config";

import { headers } from "next/headers";
import { z } from "zod";

import type { Locale } from "@/lib/i18n/config";
import { getRequestId } from "@/lib/observability/request-id";
import type { QuestionInput } from "@/lib/questions/schema";
import { createClient } from "@/lib/supabase/server";

// submit_reader_question raises EB035 at five open questions, and P0002 when the book or idea is
// not published (or the caller has no profile).
const TOO_MANY_OPEN = "EB035";
const TARGET_NOT_FOUND = "P0002";

export class TooManyOpenQuestionsError extends Error {
  constructor() {
    super("The reader already has the maximum number of open questions.");
    this.name = "TooManyOpenQuestionsError";
  }
}

export class QuestionTargetNotFoundError extends Error {
  constructor() {
    super("The book or idea being asked about is not available.");
    this.name = "QuestionTargetNotFoundError";
  }
}

export type MyQuestion = {
  id: string;
  body: string;
  locale: Locale;
  status: "new" | "answered" | "archived";
  createdAt: string;
  target: { kind: "book" | "idea"; title: string };
  answer: { slug: string } | null;
};

const myQuestionsSchema = z.array(
  z.object({
    id: z.string(),
    body: z.string(),
    locale: z.enum(locales),
    status: z.enum(["new", "answered", "archived"]),
    createdAt: z.string(),
    target: z.object({ kind: z.enum(["book", "idea"]), title: z.string() }),
    answer: z.object({ slug: z.string() }).nullable(),
  }),
);

// Both functions are request-only (the session client reads cookies), so the proxy's request ID is
// always available. Callers see a generic message; the database detail is logged once.
async function failure(operation: string, cause: unknown): Promise<Error> {
  console.error("Question call failed.", {
    operation,
    code: (cause as { code?: string } | null)?.code ?? null,
    message: (cause as { message?: string } | null)?.message ?? String(cause),
    requestId: getRequestId(await headers()),
  });
  return new Error(`${operation} failed.`, { cause });
}

export async function submitReaderQuestion(input: QuestionInput, locale: Locale): Promise<string> {
  const { data, error } = await (await createClient()).rpc("submit_reader_question", {
    // The SQL function takes NULL for the unused target; the generated types only say `string`.
    p_book_id: (input.bookId ?? null) as string,
    p_idea_id: (input.ideaId ?? null) as string,
    p_body: input.body,
    p_locale: locale,
  });
  if (error?.code === TOO_MANY_OPEN) throw new TooManyOpenQuestionsError();
  if (error?.code === TARGET_NOT_FOUND) throw new QuestionTargetNotFoundError();
  if (error) throw await failure("submitReaderQuestion", error);
  return z.string().parse(data);
}

export async function getMyReaderQuestions(): Promise<MyQuestion[]> {
  const { data, error } = await (await createClient()).rpc("get_my_reader_questions");
  if (error) throw await failure("getMyReaderQuestions", error);
  return myQuestionsSchema.parse(data ?? []);
}
