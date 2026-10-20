import { type NextRequest, NextResponse } from "next/server";

import { revalidateStorefront } from "@/lib/catalog/revalidate";
import { getServerEnv } from "@/lib/config/server-env";
import { getRequestId, REQUEST_ID_HEADER } from "@/lib/observability/request-id";
import { isAuthorizedWorkerSecret } from "@/lib/ops/worker-auth";

// Same bearer-secret gate as /api/operations/run (spec S5 5.2, 12), reusing OPS_WORKER_SECRET
// rather than inventing a second one: no session, no requireAdmin(), no browser caller. Every
// storefront-visible write already goes through a path that calls revalidateStorefront() itself
// (every admin Server Action, and the publication review/publish/reject/rollback action -
// docs/runbooks/storefront-caching.md). This route exists for the one path that does not: a write
// that bypasses those Server Actions entirely - a support intervention direct on the database, or
// this app's own E2E fixtures (`e2e/support/catalog.ts`), which seed rows through the service-role
// client for speed and isolation rather than driving the admin UI. Without a way to trigger the
// same invalidation those Server Actions call, a test exercising the storefront's own prerendered
// path would either have to wait out the real revalidate window (not viable in a test) or leave the
// prerendered path unverified. This route makes that trigger callable without weakening or
// bypassing what it triggers - the cache still behaves exactly as revalidate = 300 says everywhere
// else.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = getRequestId(request.headers);
  const env = getServerEnv();

  if (!env.opsWorkerSecret) {
    console.error("Storefront revalidation worker secret is not configured.", { requestId });
    return NextResponse.json(
      { error: "worker_not_configured", requestId },
      { status: 503, headers: { "Cache-Control": "no-store", [REQUEST_ID_HEADER]: requestId } },
    );
  }

  if (!isAuthorizedWorkerSecret(request.headers.get("authorization"), env.opsWorkerSecret)) {
    console.warn("Storefront revalidation request was not authorized.", { requestId });
    return NextResponse.json(
      { error: "unauthorized", requestId },
      { status: 401, headers: { "Cache-Control": "no-store", [REQUEST_ID_HEADER]: requestId } },
    );
  }

  revalidateStorefront();

  return NextResponse.json(
    { requestId },
    { status: 200, headers: { "Cache-Control": "no-store", [REQUEST_ID_HEADER]: requestId } },
  );
}
