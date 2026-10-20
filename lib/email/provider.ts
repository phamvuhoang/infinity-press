import "server-only";

import type { ServerEnv } from "@/lib/config/server-env-schema";
import { createResendMailProvider } from "@/lib/email/resend";

export type MailMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
};

export interface MailProvider {
  send(message: MailMessage): Promise<{ messageId: string }>;
}

// Safe codes only (spec S5 12): never carry a Resend response body or the API key.
export class MailProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MailProviderError";
    this.code = code;
  }
}

// The no-network provider exists only so local development and automated tests can exercise the
// send path without a Resend account. It must never be reachable outside those two environments
// (spec S5 4.2), even if an operator sets EMAIL_PROVIDER=test in a shared environment by mistake -
// parseServerEnv already rejects that combination before this factory ever runs.
const NO_NETWORK_ALLOWED_APP_ENVS = new Set(["local", "test"]);

function createNoNetworkMailProvider(): MailProvider {
  return {
    async send(message: MailMessage): Promise<{ messageId: string }> {
      return { messageId: `test/${message.idempotencyKey}` };
    },
  };
}

type MailProviderEnv = Pick<ServerEnv, "appEnv" | "emailProvider" | "resendApiKey">;

export function getMailProvider(env: MailProviderEnv, fetchImpl: typeof fetch = fetch): MailProvider {
  if (env.emailProvider === "resend" && env.resendApiKey) {
    return createResendMailProvider(env.resendApiKey, fetchImpl);
  }

  if (env.emailProvider === "test" && NO_NETWORK_ALLOWED_APP_ENVS.has(env.appEnv)) {
    return createNoNetworkMailProvider();
  }

  throw new MailProviderError("mail_not_configured", "Email is not configured for this environment");
}
