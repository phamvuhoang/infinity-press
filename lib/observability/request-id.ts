export const REQUEST_ID_HEADER = "x-request-id";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

// Trusts an inbound request ID only when it looks like one, so a caller
// cannot smuggle arbitrary bytes into logs and downstream job payloads
// through this header. Anything else - missing, malformed, too short, too
// long - gets a fresh one instead of being echoed back.
export function resolveRequestId(value: string | null | undefined): string {
  if (value && REQUEST_ID_PATTERN.test(value)) return value;
  return crypto.randomUUID();
}

// Reader used by the Proxy and, downstream, CLI job correlation: pulls
// `x-request-id` off a Headers instance and normalizes it through
// resolveRequestId.
export function getRequestId(headers: Headers): string {
  return resolveRequestId(headers.get(REQUEST_ID_HEADER));
}
