"use client";

import { useEffect, useRef } from "react";

import { type BrowserEventInput, sendAnalyticsEvent } from "@/lib/analytics/browser";

// Sends one browser event once the page it is rendered on is actually visible (S5 spec 8.2). A
// Server Component cannot do this: Next.js renders pages for prefetch and metadata work that no
// one sees. A tab opened in the background waits until it is first shown.
//
// Renders nothing. The props are the event itself, so a page can only describe an event the
// browser schema allows.
export function AnalyticsEvent(props: BrowserEventInput) {
  // Identity of the event this instance has already sent. React Strict Mode runs effects twice on
  // mount, and one page view must stay one event.
  const sentFor = useRef<string | null>(null);
  const key = JSON.stringify(props);

  useEffect(() => {
    if (sentFor.current === key) return;
    const event = JSON.parse(key) as BrowserEventInput;

    function sendOnce() {
      if (sentFor.current === key) return;
      sentFor.current = key;
      sendAnalyticsEvent(event);
    }

    if (document.visibilityState === "visible") {
      sendOnce();
      return;
    }

    function onVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      sendOnce();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [key]);

  return null;
}
