// @vitest-environment node
import { connection } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { deferPrerenderWithoutServerEnv } from "@/lib/config/build-environment";
import { getServerEnv } from "@/lib/config/server-env";

vi.mock("next/server", () => ({ connection: vi.fn(async () => undefined) }));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

function invalidEnvironment() {
  vi.mocked(getServerEnv).mockImplementation(() => {
    throw new Error("invalid environment");
  });
}

it("waits for a request during a build without the server environment", async () => {
  vi.stubEnv("NEXT_PHASE", "phase-production-build");
  invalidEnvironment();
  await deferPrerenderWithoutServerEnv();
  expect(connection).toHaveBeenCalledOnce();
});

it("lets a build with the server environment prerender", async () => {
  vi.stubEnv("NEXT_PHASE", "phase-production-build");
  vi.mocked(getServerEnv).mockReturnValue({} as ReturnType<typeof getServerEnv>);
  await deferPrerenderWithoutServerEnv();
  expect(connection).not.toHaveBeenCalled();
});

it("does nothing outside the build, so a bad runtime environment still fails loudly", async () => {
  vi.stubEnv("NEXT_PHASE", "phase-production-server");
  invalidEnvironment();
  await deferPrerenderWithoutServerEnv();
  expect(connection).not.toHaveBeenCalled();
  expect(getServerEnv).not.toHaveBeenCalled();
});
