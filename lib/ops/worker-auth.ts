import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

// Scheduled-worker bearer authentication (spec S5 5.2, 12). Both the supplied and the expected
// secret are hashed with SHA-256 before comparison, so the two buffers timingSafeEqual compares
// are always the same fixed length (32 bytes) regardless of what the caller sent - a differently
// sized guess never short-circuits the comparison or throws on a length mismatch.
const BEARER_PREFIX = "Bearer ";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

// `expectedSecret` is `null` when OPS_WORKER_SECRET is not configured for this environment; every
// request is then unauthorized, never accepted.
export function isAuthorizedWorkerSecret(authorization: string | null, expectedSecret: string | null): boolean {
  if (!expectedSecret) return false;
  if (!authorization || !authorization.startsWith(BEARER_PREFIX)) return false;
  const supplied = authorization.slice(BEARER_PREFIX.length);
  if (!supplied) return false;
  return timingSafeEqual(sha256(supplied), sha256(expectedSecret));
}
