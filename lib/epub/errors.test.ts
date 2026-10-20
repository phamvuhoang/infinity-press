import { describe, expect, it } from "vitest";

import { ProcessingError, processingFailure } from "@/lib/epub/errors";

describe("processingFailure", () => {
  it("marks invalid EPUB input as non-retryable", () => {
    expect(processingFailure("INVALID_EPUB", "Missing container.xml")).toEqual({
      code: "INVALID_EPUB",
      message: "Missing container.xml",
      retryable: false,
    });
  });

  it("marks a storage failure as retryable", () => {
    expect(processingFailure("STORAGE_FAILURE", "Upload timed out")).toEqual({
      code: "STORAGE_FAILURE",
      message: "Upload timed out",
      retryable: true,
    });
  });

  it("marks a stale asset version as non-retryable", () => {
    // Retrying this exact job would re-process bytes that are no longer the
    // active asset version; the worker must queue a fresh job instead.
    expect(processingFailure("STALE_VERSION", "Asset changed during processing").retryable).toBe(false);
  });

  it("marks a source checksum mismatch as non-retryable", () => {
    expect(processingFailure("SOURCE_CHECKSUM_MISMATCH", "Source bytes changed").retryable).toBe(false);
  });

  it("marks an unclassified processing failure as retryable", () => {
    expect(processingFailure("PROCESSING_FAILURE", "Unexpected error").retryable).toBe(true);
  });
});

describe("ProcessingError", () => {
  it("is a real Error carrying the failure's code and retryability", () => {
    const error = new ProcessingError(processingFailure("INVALID_EPUB", "Missing container.xml"));

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ProcessingError");
    expect(error.message).toBe("Missing container.xml");
    expect(error.code).toBe("INVALID_EPUB");
    expect(error.retryable).toBe(false);
    expect(error.failure).toEqual({ code: "INVALID_EPUB", message: "Missing container.xml", retryable: false });
  });

  it("has a usable stack trace", () => {
    const error = new ProcessingError(processingFailure("PROCESSING_FAILURE", "Unexpected error"));
    expect(typeof error.stack).toBe("string");
    expect(error.stack).toBeTruthy();
  });

  it("satisfies rejects.toMatchObject({ code }) directly on the thrown value", async () => {
    const reject = async () => {
      throw new ProcessingError(processingFailure("UNSAFE_SCRIPT", "Inline <script> tag"));
    };
    await expect(reject()).rejects.toMatchObject({ code: "UNSAFE_SCRIPT" });
  });
});
