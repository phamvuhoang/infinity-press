// Stable failure taxonomy shared by the EPUB processor (Task 4) and the
// local processing worker (Task 5), and surfaced verbatim to operators via
// the CLI and admin UI (Task 6). `retryable` tells the worker whether
// re-running the same job against the same source bytes can plausibly
// succeed: false for deterministic content/input problems that will fail
// again identically, true for failures caused by something outside the
// input itself.
export type ProcessingFailureCode =
  | "INVALID_EPUB"
  | "SOURCE_CHECKSUM_MISMATCH"
  | "UNSAFE_SCRIPT"
  | "UNSAFE_EXTERNAL_URL"
  | "UNSUPPORTED_MEDIA"
  | "ASSET_TOO_LARGE"
  | "STORAGE_FAILURE"
  | "STALE_VERSION"
  | "PROCESSING_FAILURE";

export type ProcessingFailure = {
  code: ProcessingFailureCode;
  message: string;
  retryable: boolean;
};

// STORAGE_FAILURE is transient infrastructure trouble; PROCESSING_FAILURE is
// the unclassified catch-all, which may equally be transient. Every other
// code describes the input bytes themselves, so retrying without a new
// asset version cannot change the outcome.
const RETRYABLE_FAILURE_CODES: ReadonlySet<ProcessingFailureCode> = new Set([
  "STORAGE_FAILURE",
  "PROCESSING_FAILURE",
]);

export function processingFailure(code: ProcessingFailureCode, message: string): ProcessingFailure {
  return { code, message, retryable: RETRYABLE_FAILURE_CODES.has(code) };
}

// Task 4's brief requires `processEpub()` to reject with a value matching
// `{ code: "INVALID_EPUB" }` (etc.) from its first test - this is not
// speculative surface, it is required on day one. A bare `throw failure`
// would throw a plain object: no stack trace (worst for PROCESSING_FAILURE,
// the unclassified catch-all, which needs one most), no `instanceof`
// narrowing for Task 5's worker or Task 6's CLI to catch it by. This wraps
// `ProcessingFailure` in a real `Error` without replacing it - every
// producer still builds the failure with `processingFailure()` first.
export class ProcessingError extends Error {
  readonly code: ProcessingFailureCode;
  readonly retryable: boolean;

  constructor(readonly failure: ProcessingFailure) {
    super(failure.message);
    this.name = "ProcessingError";
    // Flattened onto the instance (not just `.failure`) so
    // `rejects.toMatchObject({ code })` - Task 4's exact mandated
    // assertion - matches the thrown value directly.
    this.code = failure.code;
    this.retryable = failure.retryable;
  }
}
