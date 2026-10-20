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
