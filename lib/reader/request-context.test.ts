// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getSessionUser } from "@/lib/auth/session";
import {
  ReaderRequestNotFoundError,
  ReaderRequestUnauthorizedError,
  requireReaderRequestContext,
} from "@/lib/reader/request-context";
import { authorizeReaderSession, ReaderAccessDeniedError } from "@/lib/reader/session";

vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/reader/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reader/session")>("@/lib/reader/session");
  return { ...actual, authorizeReaderSession: vi.fn() };
});

const publicationId = "c0000000-0000-4000-8000-000000000001";
const context = { profileId: "10000000-0000-4000-8000-000000000001", publicationId, publicationVersion: 2 };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSessionUser).mockResolvedValue({ id: "auth-user" } as never);
  vi.mocked(authorizeReaderSession).mockResolvedValue(context);
});

describe("requireReaderRequestContext", () => {
  it("rejects an anonymous caller before reading or authorizing a reader session", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);

    await expect(
      requireReaderRequestContext(new NextRequest("http://localhost/x", { headers: { "x-reader-session": "s1" } }), publicationId),
    ).rejects.toBeInstanceOf(ReaderRequestUnauthorizedError);
    expect(authorizeReaderSession).not.toHaveBeenCalled();
  });

  it("maps a missing reader-session credential to the opaque not-found error", async () => {
    await expect(requireReaderRequestContext(new NextRequest("http://localhost/x"), publicationId)).rejects.toBeInstanceOf(
      ReaderRequestNotFoundError,
    );
    expect(authorizeReaderSession).not.toHaveBeenCalled();
  });

  it("authorizes the header session against the exact publication and returns it", async () => {
    await expect(
      requireReaderRequestContext(
        new NextRequest("http://localhost/x", { headers: { "x-reader-session": "session-1" } }),
        publicationId,
      ),
    ).resolves.toEqual({ ...context, sessionId: "session-1" });
    expect(authorizeReaderSession).toHaveBeenCalledExactlyOnceWith("session-1", publicationId);
  });

  it("maps every reader-session refusal to the same opaque not-found error", async () => {
    vi.mocked(authorizeReaderSession).mockRejectedValue(new ReaderAccessDeniedError());

    await expect(
      requireReaderRequestContext(
        new NextRequest("http://localhost/x", { headers: { "x-reader-session": "expired" } }),
        publicationId,
      ),
    ).rejects.toBeInstanceOf(ReaderRequestNotFoundError);
  });
});
