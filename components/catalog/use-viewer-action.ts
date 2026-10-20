"use client";

import { useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";

// Fetches the viewer's own state for a catalog page and falls back to the anonymous state it was
// given. Failure is not an error state here: the anonymous control is a correct, usable control,
// and every action it can start re-checks entitlement on the server anyway.
//
// Refetches on three things: the url changing, the fallback changing, and the session changing.
// Without the last one, SiteHeaderAccountNav - which subscribes to the same onAuthStateChange to
// flip the header immediately on sign-out - and this control disagree about who the viewer is until
// the next full page load: the header says signed out, the action control keeps showing whatever it
// fetched while still signed in.
export function useViewerAction<T>(url: string, fallback: T): T {
  // Compared by value, not by reference: every caller passes a fresh object literal each render
  // (e.g. `{ action: publicAction, signedIn: false }`), so keying off the fallback's reference
  // would refetch on every render. JSON is safe here - every shape this hook has ever been asked to
  // fetch (ViewerBookActionState, ViewerBundleActionState) is plain and JSON-safe.
  const fallbackKey = JSON.stringify(fallback);
  // Bumped on every auth event (sign in, sign out, token refresh).
  const [authTick, setAuthTick] = useState(0);
  const resetKey = `${url}:${fallbackKey}:${authTick}`;

  const [state, setState] = useState<T>(fallback);
  // React's documented pattern for resetting state when an input changes, without an Effect
  // (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes):
  // adjust state directly during render when resetKey no longer matches what state reflects. The
  // previous fetch's result belongs to the previous url/fallback/session, so it has to be cleared
  // before the new fetch below starts - otherwise a stale answer stays on screen while it is in
  // flight.
  const [resetFor, setResetFor] = useState(resetKey);
  if (resetKey !== resetFor) {
    setResetFor(resetKey);
    setState(fallback);
  }

  useEffect(() => {
    const supabase = createClient();
    let active = true;
    const { data } = supabase.auth.onAuthStateChange(() => {
      if (active) setAuthTick((tick) => tick + 1);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    fetch(url, { signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<T>) : null))
      .then((next) => {
        if (next) setState(next);
      })
      .catch(() => {
        // Aborted, offline, or a 5xx. Keep the fallback already set by the render-time reset above.
      });

    return () => controller.abort();
  }, [url, fallbackKey, authTick]);

  return state;
}
