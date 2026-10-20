// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { getMailProvider, MailProviderError, type MailMessage } from "@/lib/email/provider";

const message: MailMessage = {
  from: "Infinity Books <books@example.com>",
  to: "reader@example.com",
  subject: "Your book is ready",
  text: "Your book is ready to read.",
  html: "<p>Your book is ready to read.</p>",
  idempotencyKey: "outbox-row-123",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getMailProvider", () => {
  it("returns the Resend adapter when EMAIL_PROVIDER=resend", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: "resend-message-id" }));
    const provider = getMailProvider(
      { appEnv: "production", emailProvider: "resend", resendApiKey: "re_test_key" },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await provider.send(message);

    expect(result).toEqual({ messageId: "resend-message-id" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns the no-network adapter in local", async () => {
    const provider = getMailProvider({ appEnv: "local", emailProvider: "test", resendApiKey: null });
    const result = await provider.send(message);
    expect(result).toEqual({ messageId: `test/${message.idempotencyKey}` });
  });

  it("returns the no-network adapter in test", async () => {
    const provider = getMailProvider({ appEnv: "test", emailProvider: "test", resendApiKey: null });
    const result = await provider.send(message);
    expect(result).toEqual({ messageId: `test/${message.idempotencyKey}` });
  });

  it("throws a safe error when the no-network provider is requested outside local and test", () => {
    expect(() =>
      getMailProvider({ appEnv: "staging", emailProvider: "test", resendApiKey: null }),
    ).toThrow(MailProviderError);
    try {
      getMailProvider({ appEnv: "staging", emailProvider: "test", resendApiKey: null });
      throw new Error("expected getMailProvider to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MailProviderError);
      expect((error as MailProviderError).code).toBe("mail_not_configured");
    }
  });

  it("throws a safe error when email is not configured at all", () => {
    expect(() =>
      getMailProvider({ appEnv: "staging", emailProvider: null, resendApiKey: null }),
    ).toThrow(MailProviderError);
  });

  it("throws a safe error when EMAIL_PROVIDER=resend but no key is present", () => {
    try {
      getMailProvider({ appEnv: "production", emailProvider: "resend", resendApiKey: null });
      throw new Error("expected getMailProvider to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MailProviderError);
      expect((error as MailProviderError).code).toBe("mail_not_configured");
    }
  });
});

describe("createResendMailProvider (via getMailProvider)", () => {
  function provider(fetchImpl: typeof fetch) {
    return getMailProvider(
      { appEnv: "production", emailProvider: "resend", resendApiKey: "re_test_key" },
      fetchImpl,
    );
  }

  it("posts to the documented Resend endpoint with bearer auth, JSON fields, and an idempotency key", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: "resend-message-id" }));

    await provider(fetchImpl as unknown as typeof fetch).send(message);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");

    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer re_test_key");
    expect(headers.get("Idempotency-Key")).toBe(message.idempotencyKey);
    expect(headers.get("Content-Type")).toBe("application/json");

    expect(JSON.parse(init.body as string)).toEqual({
      from: message.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  });

  it("resolves with the Resend message id on success", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: "resend-message-id" }));
    const result = await provider(fetchImpl as unknown as typeof fetch).send(message);
    expect(result).toEqual({ messageId: "resend-message-id" });
  });

  it("throws MailProviderError with a status-coded safe code on a non-2xx response, without exposing the body", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(429, { message: "Too many requests", secret: "should-not-leak" }),
    );

    await expect(provider(fetchImpl as unknown as typeof fetch).send(message)).rejects.toMatchObject({
      name: "MailProviderError",
      code: "resend_http_429",
    });

    try {
      await provider(fetchImpl as unknown as typeof fetch).send(message);
      throw new Error("expected send to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MailProviderError);
      const err = error as MailProviderError;
      expect(err.message).not.toContain("Too many requests");
      expect(err.message).not.toContain("should-not-leak");
    }
  });

  it("maps a 5xx response to a distinct safe code", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { message: "internal error" }));
    await expect(provider(fetchImpl as unknown as typeof fetch).send(message)).rejects.toMatchObject({
      code: "resend_http_500",
    });
  });

  it("maps a network failure to resend_network_error without leaking the underlying error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.resend.com - internal detail");
    });

    try {
      await provider(fetchImpl as unknown as typeof fetch).send(message);
      throw new Error("expected send to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MailProviderError);
      const err = error as MailProviderError;
      expect(err.code).toBe("resend_network_error");
      expect(err.message).not.toContain("ENOTFOUND");
    }
  });

  it("maps an abort/timeout to resend_timeout", async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new DOMException("The operation was aborted due to timeout", "TimeoutError");
      throw error;
    });

    await expect(provider(fetchImpl as unknown as typeof fetch).send(message)).rejects.toMatchObject({
      code: "resend_timeout",
    });
  });

  it("never sends the API key anywhere but the Authorization header", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: "resend-message-id" }));
    await provider(fetchImpl as unknown as typeof fetch).send(message);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body as string).not.toContain("re_test_key");
  });
});
