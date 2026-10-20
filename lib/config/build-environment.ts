import "server-only";

import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { connection } from "next/server";

import { getServerEnv } from "@/lib/config/server-env";

// A cached route that reads the server environment is prerendered by `next build`. A build that
// has that environment (a Vercel deployment) prerenders and then revalidates the route as usual. A
// build without it (CI, a local check) cannot, so the route waits for a request instead of failing
// the build or caching an empty result. Outside `next build` this does nothing.
export async function deferPrerenderWithoutServerEnv(): Promise<void> {
  if (process.env.NEXT_PHASE !== PHASE_PRODUCTION_BUILD) return;
  try {
    getServerEnv();
  } catch {
    await connection();
  }
}
