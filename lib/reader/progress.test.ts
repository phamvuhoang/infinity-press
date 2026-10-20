// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getSessionUser } from "@/lib/auth/session";
import {
  ProgressDeniedError,
  reconcileProgress,
  saveProgress,
  type StoredProgress,
} from "@/lib/reader/progress";
import type { ReaderLocator } from "@/lib/reader/types";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const publicationId = "c0000000-0000-0000-0000-000000000001";

// A locator carrying every optional the contract admits - a reserved `position`, a reserved
// `fragment`, an `otherLocations` entry, and the three text fields. "Exact round trip" is only
// meaningful against a locator that has something to lose.
const richLocator: ReaderLocator = {
  href: "OEBPS/text/chapter2.xhtml",
  progression: 0.375,
  totalProgression: 0.62,
  locations: { position: 17, fragment: "sec-3", cfi: "/4/2[chap2]" },
  text: { before: "…the door ", highlight: "opened", after: " onto the garden." },
};

// Mirrors lib/reader/session.test.ts's rpcClient: `.rpc(name, args)` resolves once with
// {data, error}. save_reading_progress is the only thing this module ever asks a client to do.
function rpcClient(result: { data: unknown; error: { code?: string; message: string } | null }) {
  return { rpc: vi.fn().mockResolvedValue(result) } as unknown as Awaited<ReturnType<typeof createClient>>;
}

// The row shape save_reading_progress returns: the EFFECTIVE stored progress, which is not
// always what was submitted. A rejected save returns the row that won, so the client can
// reconcile against it instead of believing a write that never happened.
function storedRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    locator_json: richLocator,
    progression: richLocator.progression,
    total_progression: richLocator.totalProgression,
    device_id: "device-a",
    client_sequence: 7,
    updated_at: "2026-09-12T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  // Ruling CG: resetAllMocks clears implementations, not just call records, and must run before
  // the defaults below.
  vi.resetAllMocks();
  vi.mocked(getSessionUser).mockResolvedValue({ id: "auth-user-1" } as unknown as Awaited<
    ReturnType<typeof getSessionUser>
  >);
});

// ================================================================================================
// The reconciliation rule itself.
//
// This pure function is the *specification* that public.save_reading_progress re-derives in SQL,
// exactly as lib/publishing/state.ts is the specification for the publication-transition RPCs -
// SQL cannot call back into TypeScript, so the rule is stated once here, proven here, and proven
// again against the real database in supabase/tests/010_reading_progress.sql. If those two ever
// disagree, the pgTAP suite is what fails.
// ================================================================================================
describe("reconcileProgress", () => {
  const stored: StoredProgress = {
    deviceId: "device-a",
    clientSequence: 7,
    updatedAt: "2026-09-12T10:00:00.000Z",
  };

  it("writes when there is no stored progress at all", () => {
    expect(
      reconcileProgress(null, {
        deviceId: "device-a",
        clientSequence: 0,
        serverTime: "2026-09-12T10:00:01.000Z",
      }),
    ).toEqual({ write: true, reason: "no-stored-progress" });
  });

  it("writes when the same device reports a greater client sequence", () => {
    expect(
      reconcileProgress(stored, {
        deviceId: "device-a",
        clientSequence: 8,
        serverTime: "2026-09-12T10:00:01.000Z",
      }),
    ).toEqual({ write: true, reason: "same-device-newer-sequence" });
  });

  it("refuses a replayed or out-of-order sequence from the same device", () => {
    // A page-turn request that overtook an earlier one in flight, or a retry of a save the server
    // already applied. Equal is refused too: the same sequence is the same position.
    for (const clientSequence of [7, 6, 0]) {
      expect(
        reconcileProgress(stored, {
          deviceId: "device-a",
          clientSequence,
          serverTime: "2026-09-12T10:00:01.000Z",
        }),
      ).toEqual({ write: false, reason: "same-device-stale-sequence" });
    }
  });

  it("ignores a foreign device's sequence numbering entirely", () => {
    // Two devices number their own saves independently, so device-b's sequence 1 says nothing
    // about device-a's sequence 7. Only the server's own clock can order them, which is why a
    // client-supplied timestamp is never accepted anywhere in this module.
    expect(
      reconcileProgress(stored, {
        deviceId: "device-b",
        clientSequence: 1,
        serverTime: "2026-09-12T10:00:01.000Z",
      }),
    ).toEqual({ write: true, reason: "other-device-later-server-time" });
  });

  it("does not let a stale cross-device write overwrite newer progress", () => {
    // The server timestamp is not later than what is already stored, so the stored row wins even
    // though the device differs.
    expect(
      reconcileProgress(stored, {
        deviceId: "device-b",
        clientSequence: 99,
        serverTime: "2026-09-12T09:59:59.000Z",
      }),
    ).toEqual({ write: false, reason: "other-device-not-later" });

    expect(
      reconcileProgress(stored, {
        deviceId: "device-b",
        clientSequence: 99,
        serverTime: stored.updatedAt,
      }),
    ).toEqual({ write: false, reason: "other-device-not-later" });
  });

  it("lets a LOWER progression win when it carries a later trusted server timestamp", () => {
    // The rule takes no progression argument at all, and that is the point: a reader who turns
    // back to re-read a chapter, or jumps to an earlier bookmark, is making progress backwards on
    // purpose. A "highest progression wins" rule would silently discard that and yank them
    // forward again on their next reload. Proven here by construction - there is no progression
    // parameter for such a rule to consult.
    expect(reconcileProgress.length).toBe(2);

    expect(
      reconcileProgress(stored, {
        deviceId: "device-a",
        clientSequence: 8,
        serverTime: "2026-09-12T10:00:01.000Z",
      }),
    ).toEqual({ write: true, reason: "same-device-newer-sequence" });
  });
});

// ================================================================================================
// saveProgress: validation, the single RPC call, and the DTO.
// ================================================================================================
describe("saveProgress", () => {
  it("round-trips an exact locator, including position, fragment, and text", async () => {
    const client = rpcClient({ data: [storedRow()], error: null });
    vi.mocked(createClient).mockResolvedValue(client);

    const result = await saveProgress({
      publicationId,
      locator: richLocator,
      deviceId: "device-a",
      clientSequence: 7,
    });

    // Not "looks similar" - byte-for-byte the same locator, so a reload genuinely reopens the
    // page the reader left rather than the top of the chapter.
    expect(result.locator).toEqual(richLocator);
    expect(result.deviceId).toBe("device-a");
    expect(result.clientSequence).toBe(7);
    expect(result.updatedAt).toBe("2026-09-12T10:00:00.000Z");
  });

  it("sends the locator through parseReaderLocator, dropping smuggled properties", async () => {
    const client = rpcClient({ data: [storedRow()], error: null });
    vi.mocked(createClient).mockResolvedValue(client);

    await saveProgress({
      publicationId,
      // locator_json is a jsonb column with no shape or size constraint of its own, so the guard
      // is the only thing standing between an untrusted request body and the column.
      locator: { ...richLocator, evil: "x".repeat(5000), profile_id: "someone-else" },
      deviceId: "device-a",
      clientSequence: 7,
    });

    const [, args] = vi.mocked(client.rpc).mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(args.p_locator as object).sort()).toEqual([
      "href",
      "locations",
      "progression",
      "text",
      "totalProgression",
    ]);
  });

  it("clamps a progression a hair outside [0, 1] so the column's CHECK cannot reject it", async () => {
    const client = rpcClient({ data: [storedRow()], error: null });
    vi.mocked(createClient).mockResolvedValue(client);

    await saveProgress({
      publicationId,
      // What a real engine reports on the last page, from IEEE-754 rounding.
      locator: { ...richLocator, progression: 1 + 1e-9 },
      deviceId: "device-a",
      clientSequence: 7,
    });

    const [, args] = vi.mocked(client.rpc).mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_progression).toBe(1);
    expect((args.p_locator as ReaderLocator).progression).toBe(1);
  });

  it("calls save_reading_progress once, through the user-session client, with no profile id", async () => {
    const client = rpcClient({ data: [storedRow()], error: null });
    vi.mocked(createClient).mockResolvedValue(client);

    await saveProgress({ publicationId, locator: richLocator, deviceId: "device-a", clientSequence: 7 });

    expect(client.rpc).toHaveBeenCalledExactlyOnceWith("save_reading_progress", {
      p_publication_id: publicationId,
      p_locator: richLocator,
      p_progression: richLocator.progression,
      p_total_progression: richLocator.totalProgression,
      p_device_id: "device-a",
      p_client_sequence: 7,
    });
    // No p_profile_id parameter exists to substitute another reader's id into - the RPC derives
    // the profile from auth.uid() itself (Ruling AO), the same shape create_reader_session takes.
    const [, args] = vi.mocked(client.rpc).mock.calls[0] as [string, Record<string, unknown>];
    expect(args).not.toHaveProperty("p_profile_id");
  });

  it("refuses an anonymous caller before building any client", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);

    await expect(
      saveProgress({ publicationId, locator: richLocator, deviceId: "device-a", clientSequence: 7 }),
    ).rejects.toBeInstanceOf(ProgressDeniedError);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("maps the RPC's single denial code to one opaque error", async () => {
    const client = rpcClient({ data: null, error: { code: "EB009", message: "no progress target" } });
    vi.mocked(createClient).mockResolvedValue(client);

    // EB009 covers "no entitlement", "not published", "superseded", and "no such publication"
    // alike, so this layer cannot tell them apart either - the same non-disclosure property the
    // reader session's EB008 gives the minting path.
    await expect(
      saveProgress({ publicationId, locator: richLocator, deviceId: "device-a", clientSequence: 7 }),
    ).rejects.toBeInstanceOf(ProgressDeniedError);
  });

  it("rejects a malformed locator before any database call", async () => {
    const client = rpcClient({ data: [storedRow()], error: null });
    vi.mocked(createClient).mockResolvedValue(client);

    await expect(
      saveProgress({
        publicationId,
        locator: { href: "OEBPS/text/chapter2.xhtml" },
        deviceId: "device-a",
        clientSequence: 7,
      }),
    ).rejects.toThrow();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("rejects an unusable device id or client sequence before any database call", async () => {
    const client = rpcClient({ data: [storedRow()], error: null });
    vi.mocked(createClient).mockResolvedValue(client);

    const rejected = [
      { deviceId: "", clientSequence: 7 },
      { deviceId: "x".repeat(200), clientSequence: 7 },
      { deviceId: "device-a", clientSequence: -1 },
      { deviceId: "device-a", clientSequence: 1.5 },
      { deviceId: "device-a", clientSequence: Number.NaN },
    ];

    for (const bad of rejected) {
      await expect(
        saveProgress({ publicationId, locator: richLocator, ...bad }),
      ).rejects.toThrow();
    }
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("returns the winning row when the server refused the write, not the submitted one", async () => {
    // The RPC always returns the EFFECTIVE row. A client whose save lost to a newer one from
    // another device gets that newer position back and can reconcile to it, instead of being
    // told "saved" and continuing from a position the server does not hold.
    const winning = storedRow({
      device_id: "device-b",
      client_sequence: 2,
      updated_at: "2026-09-12T11:00:00.000Z",
      locator_json: { ...richLocator, href: "OEBPS/text/chapter9.xhtml", progression: 0.9 },
    });
    const client = rpcClient({ data: [winning], error: null });
    vi.mocked(createClient).mockResolvedValue(client);

    const result = await saveProgress({
      publicationId,
      locator: richLocator,
      deviceId: "device-a",
      clientSequence: 1,
    });

    expect(result.locator.href).toBe("OEBPS/text/chapter9.xhtml");
    expect(result.deviceId).toBe("device-b");
  });

  it("forwards the locator's whole-book progression to the RPC", async () => {
    const client = rpcClient({
      data: [storedRow({ total_progression: 0.25 })],
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(client);

    const result = await saveProgress({
      publicationId,
      locator: { ...richLocator, totalProgression: 0.25 },
      deviceId: "device-a",
      clientSequence: 7,
    });

    const [, args] = vi.mocked(client.rpc).mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_progression).toBe(richLocator.progression);
    expect(args.p_total_progression).toBe(0.25);
    expect(result.totalProgression).toBe(0.25);
  });

  it("sends null when the engine reports no whole-book progression", async () => {
    const client = rpcClient({
      data: [storedRow({ total_progression: null })],
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(client);

    const result = await saveProgress({
      publicationId,
      locator: { ...richLocator, totalProgression: null },
      deviceId: "device-a",
      clientSequence: 7,
    });

    const [, args] = vi.mocked(client.rpc).mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_total_progression).toBeNull();
    expect(result.totalProgression).toBeNull();
  });

  it("rejects a stored locator that does not satisfy the locator contract", async () => {
    // locator_json is jsonb with no shape constraint, so a row written by some future path (or a
    // hand-edited one) can be malformed. Reading it back through the same guard means a corrupt
    // row fails loudly here rather than reaching the engine as a position it cannot honour.
    const client = rpcClient({ data: [storedRow({ locator_json: { href: "" } })], error: null });
    vi.mocked(createClient).mockResolvedValue(client);

    await expect(
      saveProgress({ publicationId, locator: richLocator, deviceId: "device-a", clientSequence: 7 }),
    ).rejects.toThrow();
  });
});
