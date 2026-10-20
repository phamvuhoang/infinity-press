import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StatusAutoRefresh } from "@/components/commerce/status-auto-refresh";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

beforeEach(() => {
  vi.useFakeTimers();
  refresh.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("StatusAutoRefresh", () => {
  it("refreshes on an interval and stops after the maximum duration", () => {
    render(<StatusAutoRefresh intervalMs={2000} maxDurationMs={30000} />);

    vi.advanceTimersByTime(2000);
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(28000);
    expect(refresh).toHaveBeenCalledTimes(14);

    vi.advanceTimersByTime(10000);
    expect(refresh).toHaveBeenCalledTimes(14);
  });

  it("stops when unmounted", () => {
    const { unmount } = render(<StatusAutoRefresh intervalMs={2000} maxDurationMs={30000} />);
    unmount();
    vi.advanceTimersByTime(10000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
