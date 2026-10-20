import "server-only";

import type { CheckoutSessionInput, PaymentProvider, VerifiedPaymentEvent } from "@/lib/commerce/types";
import { getCommerceRoutes } from "@/lib/i18n/routes";

// The manual provider has no external system. A transfer is confirmed by an admin inside the
// application, and confirm_manual_payment synthesizes the payment event itself, so there is no
// inbound HTTP surface to verify and no signature to check.
export class ManualProviderEventError extends Error {
  constructor() {
    super("ManualProvider.verifyEvent: manual payments have no inbound webhook.");
    this.name = "ManualProviderEventError";
  }
}

// The only currency manual QR transfer settles. The checkout, the transfer page and the QR all ask
// this one question, and the database enforces the same list (commerce_settings.payable_currencies).
export const MANUAL_TRANSFER_CURRENCIES: readonly string[] = ["VND"];

// VietQR serves a static image; nothing is sent to it but the public payee details that the page
// already prints beside it.
//
// The amount VietQR expects is in major units, and this passes amountMinor straight through. That
// is correct for VND, which has no minor unit, and silently 100x wrong for any currency that has
// one - a code the reader scans and pays. So the QR exists only for VND, and every other currency
// gets none: the printed bank details are complete without it, which is the property the transfer
// page was built around.
export function buildVietQrImageUrl(input: {
  bankCode: string;
  accountNumber: string;
  accountHolder: string;
  amountMinor: number;
  currency: string;
  reference: string;
}): string | null {
  if (!MANUAL_TRANSFER_CURRENCIES.includes(input.currency)) return null;
  const query = new URLSearchParams({
    amount: String(input.amountMinor),
    addInfo: input.reference,
    accountName: input.accountHolder,
  });
  return `https://img.vietqr.io/image/${input.bankCode}-${input.accountNumber}-compact2.png?${query}`;
}

export class ManualProvider implements PaymentProvider {
  async createSession(input: CheckoutSessionInput): Promise<{ redirectUrl: string }> {
    return { redirectUrl: getCommerceRoutes(input.locale).checkoutTransfer(input.orderId) };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- required by PaymentProvider
  async verifyEvent(_request: Request): Promise<VerifiedPaymentEvent> {
    throw new ManualProviderEventError();
  }
}
