import "server-only";
import { locales } from "@/lib/i18n/config";

import { headers } from "next/headers";
import { cache } from "react";
import { z } from "zod";

import type { Locale } from "@/lib/i18n/config";
import { getRequestId } from "@/lib/observability/request-id";
import { createPublicClient } from "@/lib/supabase/public";
import { createClient } from "@/lib/supabase/server";

// S16 shared quote cards. Reads and writes go through definer RPCs; the table is granted to nobody.
const CAP_REACHED = "EB038";
const REFUSED = "EB039";
// The only shape a code can have. Anything else is answered without a round trip.
export const SHARED_QUOTE_CODE = /^[A-Za-z0-9_-]{10}$/;

export class SharedQuoteCapError extends Error {
  constructor() {
    super("Too many shared quotes.");
    this.name = "SharedQuoteCapError";
  }
}
export class SharedQuoteRefusedError extends Error {
  constructor() {
    super("The quote could not be shared.");
    this.name = "SharedQuoteRefusedError";
  }
}

const sharedQuoteSchema = z.object({
  id: z.string(),
  code: z.string().regex(SHARED_QUOTE_CODE),
  quote: z.string(),
  locale: z.enum(locales),
  bookId: z.string(),
  createdAt: z.string(),
});
const mySharedQuoteSchema = sharedQuoteSchema.extend({ bookTitle: z.string(), viewCount: z.coerce.number().int() });

export type SharedQuote = z.infer<typeof sharedQuoteSchema>;
export type MySharedQuote = z.infer<typeof mySharedQuoteSchema>;

async function currentRequestId(): Promise<string | null> {
  try {
    return getRequestId(await headers());
  } catch {
    return null;
  }
}

// Logs the code only, never the quote text: a parse failure is reported as invalid_response.
async function failure(operation: string, cause: unknown): Promise<Error> {
  console.error("Shared quote operation failed.", {
    operation,
    code: cause instanceof z.ZodError ? "invalid_response" : ((cause as { code?: string } | null)?.code ?? null),
    requestId: await currentRequestId(),
  });
  return new Error(`${operation} failed.`, { cause });
}

async function parseOrFail<T>(schema: z.ZodType<T>, data: unknown, operation: string): Promise<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw await failure(operation, parsed.error);
  return parsed.data;
}

export async function createSharedQuote(publicationId: string, quote: string, locale: Locale): Promise<SharedQuote> {
  const { data, error } = await (await createClient()).rpc("create_shared_quote", {
    p_publication_id: publicationId,
    p_quote: quote,
    p_locale: locale,
  });
  if (error?.code === CAP_REACHED) throw new SharedQuoteCapError();
  if (error?.code === REFUSED) throw new SharedQuoteRefusedError();
  if (error) throw await failure("createSharedQuote", error);
  return parseOrFail(sharedQuoteSchema, data, "createSharedQuote");
}

// Public, cookie-less. Null for a malformed code and for unknown, removed, and unpublished cards alike.
export const getSharedQuote = cache(async (code: string): Promise<SharedQuote | null> => {
  if (!SHARED_QUOTE_CODE.test(code)) return null;
  const { data, error } = await createPublicClient().rpc("catalog_shared_quote", { p_code: code });
  if (error) throw await failure("getSharedQuote", error);
  if (data == null) return null;
  // A shape drift would otherwise 404 every card without a trace.
  return parseOrFail(sharedQuoteSchema, data, "getSharedQuote");
});

export async function listMySharedQuotes(): Promise<MySharedQuote[]> {
  const { data, error } = await (await createClient()).rpc("my_shared_quotes", {});
  if (error) throw await failure("listMySharedQuotes", error);
  return parseOrFail(z.array(mySharedQuoteSchema), data ?? [], "listMySharedQuotes");
}

export async function removeMySharedQuote(code: string): Promise<void> {
  if (!SHARED_QUOTE_CODE.test(code)) return;
  const { error } = await (await createClient()).rpc("remove_shared_quote", { p_code: code });
  if (error) throw await failure("removeMySharedQuote", error);
}
