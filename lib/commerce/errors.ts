// Commerce errors shared by server modules and the webhook handler. This file has no "server-only"
// import, so tests can use the real classes while they mock the modules that throw them.
export class PaymentsDisabledError extends Error {
  constructor() {
    super("Payments are not enabled in this environment.");
    this.name = "PaymentsDisabledError";
  }
}

export class NotPurchasableError extends Error {
  constructor() {
    super("This book cannot be bought right now.");
    this.name = "NotPurchasableError";
  }
}

export class AlreadyOwnedError extends Error {
  constructor() {
    super("The reader already owns this book.");
    this.name = "AlreadyOwnedError";
  }
}

// apply_payment_event refused the event: the order does not exist (P0002), the amount or currency
// does not match it (EB004), or its provider is not the one the order was booked under (EB016).
// The webhook answers 422 instead of 500.
export class PaymentEventRejectedError extends Error {
  constructor() {
    super("The payment event does not match an order.");
    this.name = "PaymentEventRejectedError";
  }
}

// The offer the reader submitted is no longer current: its price moved, or it was withdrawn. No
// order is created; the page shows the refreshed price and the reader presses Buy again.
export class OfferChangedError extends Error {
  constructor() {
    super("The price of this edition changed.");
    this.name = "OfferChangedError";
  }
}

// Manual bank transfer settles VND only. A USD or JPY offer is never turned into a payable order and
// never converted at a made-up rate.
export class CurrencyNotPayableError extends Error {
  constructor() {
    super("This edition cannot be paid for by bank transfer.");
    this.name = "CurrencyNotPayableError";
  }
}

// The work has several editions on sale and the request did not say which one.
export class EditionRequiredError extends Error {
  constructor() {
    super("Choose an edition to buy.");
    this.name = "EditionRequiredError";
  }
}
