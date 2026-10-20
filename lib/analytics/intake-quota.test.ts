// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ANONYMOUS_INTAKE_LIMIT,
  consumeAnalyticsQuota,
  INTAKE_WINDOW_SECONDS,
  PROFILE_INTAKE_LIMIT,
} from "./intake-quota";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const PROFILE_ID = "20000000-0000-4000-8000-000000000001";
const rpc = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createAdminClient).mockReturnValue({ rpc } as unknown as ReturnType<typeof createAdminClient>);
});

describe("consumeAnalyticsQuota", () => {
  it("charges a signed-in caller to its own profile bucket", async () => {
    rpc.mockResolvedValue({ data: true, error: null });

    await expect(consumeAnalyticsQuota(PROFILE_ID)).resolves.toBe("allowed");
    expect(rpc).toHaveBeenCalledExactlyOnceWith("consume_analytics_quota", {
      p_bucket_key: `profile/${PROFILE_ID}`,
      p_limit: PROFILE_INTAKE_LIMIT,
      p_window_seconds: INTAKE_WINDOW_SECONDS,
    });
  });

  it("charges every anonymous caller to the one shared anonymous bucket", async () => {
    rpc.mockResolvedValue({ data: true, error: null });

    await consumeAnalyticsQuota(undefined);
    expect(rpc).toHaveBeenCalledWith("consume_analytics_quota", {
      p_bucket_key: "anonymous",
      p_limit: ANONYMOUS_INTAKE_LIMIT,
      p_window_seconds: INTAKE_WINDOW_SECONDS,
    });
  });

  it("reports an exhausted bucket as limited", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    await expect(consumeAnalyticsQuota(PROFILE_ID)).resolves.toBe("limited");
  });

  it("reports an RPC error or exception as an error, without throwing", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST301", message: "quoted value" } });
    await expect(consumeAnalyticsQuota(PROFILE_ID)).resolves.toEqual({ error: "PGRST301" });

    rpc.mockRejectedValueOnce(new Error("network"));
    await expect(consumeAnalyticsQuota(PROFILE_ID)).resolves.toEqual({ error: "exception" });
  });

  it("keeps the per-profile limit below the shared anonymous one", () => {
    expect(PROFILE_INTAKE_LIMIT).toBeLessThan(ANONYMOUS_INTAKE_LIMIT);
  });
});
