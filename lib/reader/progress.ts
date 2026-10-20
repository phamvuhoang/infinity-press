import "server-only";

import { getSessionUser } from "@/lib/auth/session";
import { parseReaderLocator } from "@/lib/reader/engine";
import type { ReaderLocator } from "@/lib/reader/types";
import { createClient } from "@/lib/supabase/server";

// Reading-progress persistence: one validated locator per (reader, publication), reconciled so
// that a slow or replayed save can never overwrite a newer one.
//
// Why this goes through a security-definer RPC rather than a table write (carry-forward from the
// platform-baseline Task 6 review): browser roles have NO insert privilege on reading_progress at
// all, and only a column-level UPDATE on rows that already exist. So the very first save of a
// book - the common case - is unwritable through the user-session client by construction. The
// alternative, a service-role write after the server resolves the profile, would mean
// re-implementing the entitlement and publication checks in application code and holding a
// privileged client open across them. save_reading_progress instead derives the profile from
// auth.uid(), rechecks the whole access decision, and performs the reconciliation atomically in
// one statement (20260911210000_reading_progress_rpc.sql).
//
// Ruling AO's shape, as with create_reader_session and acquire_free_ebook: there is deliberately
// no p_profile_id parameter. This is reachable from a Route Handler, so a caller-supplied profile
// id would be a direct IDOR primitive - write your position into someone else's book.

// One opaque denial for every refusal reason, mirroring ReaderAccessDeniedError. "No entitlement",
// "revoked entitlement", "no such publication", "not published", and "superseded version" are
// indistinguishable to the caller, so a request naming a real publication the caller does not own
// looks exactly like one naming a publication that does not exist. The route maps this to the
// same single 404 the other reader handlers use.
export class ProgressDeniedError extends Error {
  constructor() {
    super("This content is not available.");
    this.name = "ProgressDeniedError";
  }
}

// Kept distinct from ProgressDeniedError so the route can answer a malformed body with 400
// instead of either a misleading 404 (which would say "no such publication" about a request that
// never named one wrongly) or a 500 (which would report a client mistake as a server fault).
// It names only which field was unusable - never the value, which came from the request.
export class InvalidProgressInputError extends Error {
  constructor(readonly field: "locator" | "deviceId" | "clientSequence") {
    super(`The progress request's ${field} is not usable.`);
    this.name = "InvalidProgressInputError";
  }
}

// What the database already holds for this (reader, publication), as far as reconciliation cares.
// Deliberately carries no progression: see reconcileProgress.
export type StoredProgress = {
  deviceId: string;
  clientSequence: number;
  updatedAt: string;
};

// A save being considered. `serverTime` is stamped by the server - never read from the request -
// which is what makes the cross-device comparison below trustworthy.
export type IncomingProgress = {
  deviceId: string;
  clientSequence: number;
  serverTime: string;
};

export type ProgressDecision =
  | {
      write: true;
      reason: "no-stored-progress" | "same-device-newer-sequence" | "other-device-later-server-time";
    }
  | { write: false; reason: "same-device-stale-sequence" | "other-device-not-later" };

// The reconciliation rule, stated once.
//
// This is the *specification* that public.save_reading_progress re-derives in SQL, in exactly the
// sense lib/publishing/state.ts is the specification for the publication-transition RPCs: the RPC
// cannot call back into TypeScript, so the rule is written here, unit-tested here, and proven
// against the real database in supabase/tests/010_reading_progress.sql. Those pgTAP cases are
// what fail if the two ever drift apart.
//
// Two orderings, because two devices cannot share one:
//  - Same device: its own client_sequence is a monotonic counter, so a greater sequence is
//    strictly newer. Equal is refused as well as lower - the same sequence is the same position,
//    and a retry of an already-applied save must not restamp updated_at, which would let it win a
//    later cross-device comparison it has no right to.
//  - Different device: two devices number their saves independently, so one's sequence says
//    nothing about the other's. Only the server's clock can order them.
//
// Progression is deliberately not a parameter. A "highest progression wins" rule would look
// sensible and be wrong: a reader who turns back to re-read a chapter, or follows an internal
// link to a footnote, is moving backwards on purpose, and that rule would silently discard the
// move and yank them forward on their next reload.
export function reconcileProgress(
  stored: StoredProgress | null,
  incoming: IncomingProgress,
): ProgressDecision {
  if (!stored) return { write: true, reason: "no-stored-progress" };

  if (stored.deviceId === incoming.deviceId) {
    return incoming.clientSequence > stored.clientSequence
      ? { write: true, reason: "same-device-newer-sequence" }
      : { write: false, reason: "same-device-stale-sequence" };
  }

  return Date.parse(incoming.serverTime) > Date.parse(stored.updatedAt)
    ? { write: true, reason: "other-device-later-server-time" }
    : { write: false, reason: "other-device-not-later" };
}

export type SaveProgressInput = {
  publicationId: string;
  // Unknown, not ReaderLocator: this arrives from a request body and is only a locator once
  // parseReaderLocator has said so.
  locator: unknown;
  deviceId: string;
  clientSequence: number;
};

// What crosses back to the client. Note what is absent: no profile id, no publication row, no
// storage key - a reader's own position and nothing else.
export type ReadingProgressDTO = {
  locator: ReaderLocator;
  // Whole-book progression, 0-1, or null when the engine does not report one. Stored in its own
  // column since S4: `progression` below is the position within the current resource, and the
  // library needs the other figure to say how far through the book a reader is.
  totalProgression: number | null;
  deviceId: string;
  clientSequence: number;
  updatedAt: string;
};

// A device id is an opaque client-generated label used only to tell two of the reader's own
// devices apart during reconciliation. It authorizes nothing, so it needs no format - only a
// bound, so it cannot be used to push an arbitrarily large string into the row.
const MAX_DEVICE_ID_LENGTH = 128;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T) ?? null;
  return (data as T) ?? null;
}

type ProgressRow = {
  locator_json: unknown;
  progression: number;
  total_progression: number | null;
  device_id: string;
  client_sequence: number | string;
  updated_at: string;
};

// Saves one position and returns the EFFECTIVE stored progress - which is not always what was
// submitted. When the caller's save loses reconciliation (a newer one from another device won),
// the winning row comes back instead, so the client can reconcile to it rather than being told
// "saved" and continuing from a position the server does not hold.
export async function saveProgress(input: SaveProgressInput): Promise<ReadingProgressDTO> {
  const user = await getSessionUser();
  if (!user) throw new ProgressDeniedError();

  if (!uuidPattern.test(input.publicationId)) throw new ProgressDeniedError();

  // Routed through the shared guard rather than trusted: locator_json is a jsonb column with no
  // shape or size constraint of its own, so this is the only thing between an untrusted request
  // body and the column. It also applies the PROGRESSION_EPSILON clamp, which is load-bearing -
  // reading_progress.progression is `check (progression between 0 and 1)` and a real engine
  // reports a hair outside that band on the last page, so without the clamp a save would fail at
  // exactly the moment a reader finishes the book.
  let locator: ReaderLocator;
  try {
    locator = parseReaderLocator(input.locator);
  } catch {
    throw new InvalidProgressInputError("locator");
  }

  if (typeof input.deviceId !== "string" || input.deviceId.length === 0) {
    throw new InvalidProgressInputError("deviceId");
  }
  if (input.deviceId.length > MAX_DEVICE_ID_LENGTH) {
    throw new InvalidProgressInputError("deviceId");
  }
  if (!Number.isSafeInteger(input.clientSequence) || input.clientSequence < 0) {
    throw new InvalidProgressInputError("clientSequence");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_reading_progress", {
    p_publication_id: input.publicationId,
    p_locator: locator,
    p_progression: locator.progression,
    // Already validated and clamped by parseReaderLocator above, like p_progression. Note that
    // this needs no change to the request body or the route: totalProgression is a field of
    // ReaderLocator, so it has been arriving in every progress request and being stored inside
    // locator_json all along - it was simply thrown away at the RPC boundary.
    p_total_progression: locator.totalProgression,
    p_device_id: input.deviceId,
    p_client_sequence: input.clientSequence,
  });

  // Every failure collapses to the same denial and no Postgres text is forwarded: the RPC raises
  // one code (EB009) for all of "no entitlement", "not published", and "no such publication"
  // precisely so this layer cannot accidentally tell them apart either.
  if (error) throw new ProgressDeniedError();

  const row = firstRow<ProgressRow>(data);
  if (!row) throw new ProgressDeniedError();

  return {
    // Re-validated on the way out, not merely cast. jsonb has no shape constraint, so a row
    // written by some future path - or edited by hand - can be malformed; failing here is far
    // better than handing the engine a position it cannot honour.
    locator: parseReaderLocator(row.locator_json),
    totalProgression: row.total_progression,
    deviceId: row.device_id,
    // bigint arrives from PostgREST as a string once it exceeds the JS safe range; Number() keeps
    // one type crossing the boundary regardless.
    clientSequence: Number(row.client_sequence),
    updatedAt: row.updated_at,
  };
}
