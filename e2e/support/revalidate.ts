import type { APIRequestContext } from "@playwright/test";

import { serverEnvironmentValue } from "./server-env";

// e2e/support/catalog.ts's fixtures write directly through the service-role client, bypassing every
// admin Server Action - the only thing that normally calls revalidateStorefront() when the
// storefront's data changes. The home page and every catalog detail page are prerendered with
// revalidate = 300 now, so a fixture write is invisible there until that window elapses, which a
// test cannot wait out. Call this after seeding anything the test then expects to see on a
// prerendered page (the home page in particular - a detail page for a brand-new slug renders on
// demand and needs no revalidation, since dynamicParams stays on). Mirrors how a real admin
// mutation refreshes the same pages; it does not shorten or bypass the cache the storefront itself
// relies on.
export async function revalidateStorefront(request: APIRequestContext): Promise<void> {
  const response = await request.post("/api/operations/revalidate-storefront", {
    headers: { authorization: `Bearer ${serverEnvironmentValue("OPS_WORKER_SECRET")}` },
  });
  if (!response.ok()) {
    throw new Error(`revalidateStorefront() fixture call failed: ${response.status()} ${await response.text()}`);
  }
}
