import "server-only";

import { ManualProvider } from "@/lib/commerce/manual";
import { SepayProvider } from "@/lib/commerce/sepay";
import { SimulatorProvider } from "@/lib/commerce/simulator";
import type { PaymentProvider } from "@/lib/commerce/types";
import type { ServerEnv } from "@/lib/config/server-env-schema";

export class PaymentProviderDisabledError extends Error {
  constructor() {
    super("No payment provider is configured.");
    this.name = "PaymentProviderDisabledError";
  }
}

// The app half of the payments gate (S3 spec 4.2). create_ebook_order checks the database half.
export function arePaymentsEnabled(env: Pick<ServerEnv, "paymentProvider">): boolean {
  return env.paymentProvider !== "disabled";
}

// PAYMENT_PROVIDER=disabled has no provider to hand back, so this fails closed instead of returning
// something that silently does nothing.
export function getPaymentProvider(
  env: Pick<ServerEnv, "appEnv" | "paymentProvider" | "simulatorSecret" | "sepay">,
): PaymentProvider {
  if (env.paymentProvider === "simulator") {
    return new SimulatorProvider(env);
  }
  if (env.paymentProvider === "manual") {
    return new ManualProvider();
  }
  // parseServerEnv guarantees the settings exist when the provider is sepay; this is for a caller
  // that hands in an environment it built itself.
  if (env.paymentProvider === "sepay" && env.sepay) {
    return new SepayProvider(env.sepay);
  }
  throw new PaymentProviderDisabledError();
}
