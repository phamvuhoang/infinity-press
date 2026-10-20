import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import type { CheckoutSessionInput, PaymentProvider, VerifiedPaymentEvent } from "@/lib/commerce/types";
import type { ServerEnv } from "@/lib/config/server-env-schema";
import { getCommerceRoutes } from "@/lib/i18n/routes";
import { REQUEST_ID_HEADER } from "@/lib/observability/request-id";

// The single source of truth for "may the simulator run here". `test` is allowed because every
// automated run uses it; `preview` and `production` are refused.
const SIMULATOR_ALLOWED_APP_ENVS = new Set(["local", "staging", "test"]);

export function isSimulatorAllowedEnvironment(appEnv: string): boolean {
  return SIMULATOR_ALLOWED_APP_ENVS.has(appEnv);
}

// The simulate page and the webhook exist only when both hold (S3 spec 8).
export function isSimulatorCheckoutEnabled(env: Pick<ServerEnv, "appEnv" | "paymentProvider">): boolean {
  return env.paymentProvider === "simulator" && isSimulatorAllowedEnvironment(env.appEnv);
}

export const SIMULATOR_ENVIRONMENT_ERROR_MESSAGE =
  "The payment simulator is only available in local, staging, and test environments.";

export const SIMULATOR_SIGNATURE_HEADER = "x-simulator-signature";

export class SimulatorProviderEnvironmentError extends Error {
  constructor() {
    super(SIMULATOR_ENVIRONMENT_ERROR_MESSAGE);
    this.name = "SimulatorProviderEnvironmentError";
  }
}

export class SimulatorSecretMissingError extends Error {
  constructor() {
    super("PAYMENT_SIMULATOR_SECRET is required for the payment simulator.");
    this.name = "SimulatorSecretMissingError";
  }
}

export class InvalidSimulatorSignatureError extends Error {
  constructor() {
    super("SimulatorProvider.verifyEvent: missing or invalid signature");
    this.name = "InvalidSimulatorSignatureError";
  }
}

export class MalformedSimulatedEventError extends Error {
  constructor(reason: string) {
    super(`SimulatorProvider.verifyEvent: malformed simulated event payload (${reason})`);
    this.name = "MalformedSimulatedEventError";
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// HMAC-SHA256 over the exact bytes sent. Staging is publicly reachable, so an unsigned event must
// never reach apply_payment_event (S3 spec 4.6).
export function signSimulatedEvent(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function hasValidSignature(body: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signSimulatedEvent(body, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const SIMULATED_OUTCOMES = ["succeeded", "failed", "cancelled", "duplicate"] as const;
export type SimulatedOutcome = (typeof SIMULATED_OUTCOMES)[number];

export function isSimulatedOutcome(value: string): value is SimulatedOutcome {
  return (SIMULATED_OUTCOMES as readonly string[]).includes(value);
}

export type SimulatedPaymentEvent = Omit<VerifiedPaymentEvent, "provider">;

// Amount and currency always come from the order, never from a form (S3 spec 5.2). "duplicate"
// delivers one succeeded event twice with the same event ID.
export function buildSimulatedEvents(
  order: { id: string; totalMinor: number; currency: string },
  outcome: SimulatedOutcome,
  eventId: string,
  now: Date,
): SimulatedPaymentEvent[] {
  const event: SimulatedPaymentEvent = {
    eventId,
    externalPaymentId: `sim_pay_${order.id}`,
    orderId: order.id,
    status: outcome === "duplicate" ? "succeeded" : outcome,
    amountMinor: order.totalMinor,
    currency: order.currency,
    occurredAt: now.toISOString(),
  };
  return outcome === "duplicate" ? [event, event] : [event];
}

// The same signed request a network delivery would carry, for in-process delivery (S3 spec 4.7).
export function buildSimulatedEventRequest(event: SimulatedPaymentEvent, secret: string, requestId: string): Request {
  const body = JSON.stringify(event);
  return new Request("http://simulator.internal/api/payments/simulator/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SIMULATOR_SIGNATURE_HEADER]: signSimulatedEvent(body, secret),
      [REQUEST_ID_HEADER]: requestId,
    },
    body,
  });
}

type SimulatorEnv = { appEnv: string; simulatorSecret: string | null };

// The MVP's only PaymentProvider. Construction refuses disallowed environments and a missing secret,
// so no code path - a unit test, a route handler, or a Server Action - can build a working simulator
// in production.
export class SimulatorProvider implements PaymentProvider {
  private readonly secret: string;

  constructor(env: SimulatorEnv) {
    if (!isSimulatorAllowedEnvironment(env.appEnv)) {
      throw new SimulatorProviderEnvironmentError();
    }
    if (!env.simulatorSecret) {
      throw new SimulatorSecretMissingError();
    }
    this.secret = env.simulatorSecret;
  }

  async createSession(input: CheckoutSessionInput): Promise<{ redirectUrl: string }> {
    return { redirectUrl: getCommerceRoutes(input.locale).checkoutSimulate(input.orderId) };
  }

  async verifyEvent(request: Request): Promise<VerifiedPaymentEvent> {
    const raw = await request.text();
    if (!hasValidSignature(raw, request.headers.get(SIMULATOR_SIGNATURE_HEADER), this.secret)) {
      throw new InvalidSimulatorSignatureError();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new MalformedSimulatedEventError("json");
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new MalformedSimulatedEventError("json");
    }
    const body = parsed as Partial<Record<keyof VerifiedPaymentEvent, unknown>>;

    if (typeof body.eventId !== "string" || body.eventId.length === 0) {
      throw new MalformedSimulatedEventError("eventId");
    }
    if (typeof body.externalPaymentId !== "string" || body.externalPaymentId.length === 0) {
      throw new MalformedSimulatedEventError("externalPaymentId");
    }
    if (typeof body.orderId !== "string" || !uuidPattern.test(body.orderId)) {
      throw new MalformedSimulatedEventError("orderId");
    }
    if (body.status !== "succeeded" && body.status !== "failed" && body.status !== "cancelled") {
      throw new MalformedSimulatedEventError("status");
    }
    if (typeof body.amountMinor !== "number" || !Number.isInteger(body.amountMinor) || body.amountMinor < 0) {
      throw new MalformedSimulatedEventError("amountMinor");
    }
    if (typeof body.currency !== "string" || body.currency.length === 0) {
      throw new MalformedSimulatedEventError("currency");
    }
    if (typeof body.occurredAt !== "string" || body.occurredAt.length === 0) {
      throw new MalformedSimulatedEventError("occurredAt");
    }

    return {
      provider: "simulator",
      eventId: body.eventId,
      externalPaymentId: body.externalPaymentId,
      orderId: body.orderId,
      status: body.status,
      amountMinor: body.amountMinor,
      currency: body.currency,
      occurredAt: body.occurredAt,
    };
  }
}
