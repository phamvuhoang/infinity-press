// Transient-failure handling for the worker's Storage calls (lib/epub/job-store.ts).
//
// Why this exists: processing one book issues one sequential PUT per derived resource - 830
// of them for a real 23 MiB EPUB - plus the manifest. With no retry, the job's success
// probability is a single request's raised to that power, so one dropped socket anywhere in
// the run discards the whole job and the operator restarts it from resource #0. That is not
// hypothetical: job dc92185d failed on resource #269/830 with a bare `fetch failed`, and the
// identical run afterwards uploaded all 830 without a single error.
//
// `fetch failed` is also all supabase-js gives us: it wraps a thrown `fetch` in a
// StorageUnknownError whose `message` is the undici TypeError's message, parking the real
// errno (ECONNRESET, ETIMEDOUT, ...) two levels down in `originalError.cause`. Flattening
// that chain into the failure message is what makes the next occurrence diagnosable at all,
// since `processing_jobs.error_message` is the only record an operator gets after the fact.

export type StorageRetryPolicy = {
  // Total attempts, not retries: 1 means "no retry".
  attempts: number;
  baseDelayMs: number;
  sleep: (ms: number) => Promise<void>;
};

// 4 attempts with 500ms exponential backoff = at most 3.5s of waiting before a resource is
// given up on. Against the observed failure (isolated, non-repeating) one retry would have
// been enough; the budget stays small on purpose so a genuinely unreachable Storage still
// fails the job promptly rather than after 830 resources x a long backoff ladder.
export const DEFAULT_STORAGE_RETRY: StorageRetryPolicy = {
  attempts: 4,
  baseDelayMs: 500,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function causeOf(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  // StorageUnknownError parks the thrown value on `originalError`; undici's TypeError uses
  // the standard `cause`. Walking both is what gets us from "fetch failed" to the errno.
  const { originalError, cause } = error as { originalError?: unknown; cause?: unknown };
  return originalError ?? cause;
}

function describeLink(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const { name, code, message } = error as { name?: string; code?: string; message?: string };
  const label = code ?? name;
  return label ? `${label}: ${message ?? ""}` : (message ?? String(error));
}

// "fetch failed <- TypeError: fetch failed <- ECONNRESET: read ECONNRESET" - the top-level
// message verbatim (so existing operator-facing strings do not change shape), then every
// wrapped cause. Depth-capped: a cyclic or self-referential cause chain must not hang the
// worker inside its own error path.
export function describeStorageError(error: unknown): string {
  const head = typeof error === "object" && error !== null ? ((error as { message?: string }).message ?? String(error)) : String(error);
  const parts = [head];
  let current = causeOf(error);
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
    parts.push(describeLink(current));
    current = causeOf(current);
  }
  return parts.join(" <- ");
}

// Deliberately conservative: retry only what is known to be transient, never "anything that
// is not a known permanent error". A misclassified permanent failure would be retried 830
// times over in a single job, and every one of those PUTs is a real write attempt.
export function isRetryableStorageError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { status } = error as { status?: unknown };
  // StorageApiError: the request reached Storage and it answered. Only timeouts, throttling
  // and server faults can plausibly differ on a second try.
  if (typeof status === "number") return status === 408 || status === 429 || status >= 500;
  // No status means no HTTP response at all - supabase-js only produces that shape when
  // `fetch` threw, i.e. a transport failure. Require the wrapped cause as proof rather than
  // treating every status-less object as transient.
  return causeOf(error) !== undefined;
}

// Wraps a supabase-js Storage call, which reports failure as a returned `{ error }` rather
// than by throwing. Returns the first non-error result, or the final attempt's result - the
// caller's existing `if (error)` branch stays exactly as it was.
export async function withStorageRetry<T extends { error: unknown }>(
  run: () => Promise<T>,
  policy: StorageRetryPolicy = DEFAULT_STORAGE_RETRY,
): Promise<T> {
  let result = await run();
  for (let attempt = 1; attempt < policy.attempts; attempt++) {
    if (!result.error || !isRetryableStorageError(result.error)) return result;
    await policy.sleep(policy.baseDelayMs * 2 ** (attempt - 1));
    result = await run();
  }
  return result;
}
