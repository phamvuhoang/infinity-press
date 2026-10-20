"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Re-renders the status page while a payment is processing, then stops (S3 spec 5.2). The page also
// shows a "Check again" link, so a reader is never stuck when refreshing ends.
export function StatusAutoRefresh({ intervalMs, maxDurationMs }: { intervalMs: number; maxDurationMs: number }) {
  const router = useRouter();

  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - startedAt >= maxDurationMs) {
        window.clearInterval(timer);
        return;
      }
      router.refresh();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [router, intervalMs, maxDurationMs]);

  return null;
}
