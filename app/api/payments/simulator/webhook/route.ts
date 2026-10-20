import { handleSimulatorWebhook } from "@/lib/commerce/simulator-webhook";

// Signed simulator events only. The handler returns 404 outside local, test, and staging.
export async function POST(request: Request) {
  return handleSimulatorWebhook(request);
}
