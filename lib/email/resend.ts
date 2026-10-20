import "server-only";

import { MailProviderError, type MailMessage, type MailProvider } from "@/lib/email/provider";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

// Resend has no documented SLA for a hung connection. The scheduled worker (Task 11) polls the
// outbox on a five-minute cadence, so a request must fail fast enough to leave room for retries
// within that window rather than tying up the run.
const RESEND_TIMEOUT_MS = 10_000;

type ResendSuccessResponse = { id: string };

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

// Uses the documented Resend HTTP endpoint directly (AGENTS.md/brief: no new Resend SDK
// dependency). `fetchImpl` is injected so tests never make a real network call.
export function createResendMailProvider(apiKey: string, fetchImpl: typeof fetch = fetch): MailProvider {
  return {
    async send(message: MailMessage): Promise<{ messageId: string }> {
      let response: Response;
      try {
        response = await fetchImpl(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": message.idempotencyKey,
          },
          body: JSON.stringify({
            from: message.from,
            to: message.to,
            subject: message.subject,
            text: message.text,
            html: message.html,
          }),
          signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
        });
      } catch (error) {
        if (isTimeoutError(error)) {
          throw new MailProviderError("resend_timeout", "Resend request timed out");
        }
        // Never surface the underlying error: it can carry request internals, and the caller
        // (spec S5 12) must only ever see a safe code.
        throw new MailProviderError("resend_network_error", "Resend request failed");
      }

      if (!response.ok) {
        throw new MailProviderError(
          `resend_http_${response.status}`,
          "Resend returned a non-2xx response",
        );
      }

      let body: ResendSuccessResponse;
      try {
        body = (await response.json()) as ResendSuccessResponse;
      } catch {
        throw new MailProviderError("resend_invalid_response", "Resend returned an unreadable response");
      }

      if (typeof body.id !== "string" || body.id.length === 0) {
        throw new MailProviderError("resend_invalid_response", "Resend returned no message id");
      }

      return { messageId: body.id };
    },
  };
}
