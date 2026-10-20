// @vitest-environment node
import { describe, expect, it } from "vitest";

import { readBoundedText } from "./bounded-body";

const encoder = new TextEncoder();

// A body delivered in chunks with no Content-Length, the way a chunked request arrives. It records
// how many chunks were pulled and whether the reader cancelled it. No read-ahead (highWaterMark 0):
// a chunk is pulled only when the consumer asks for one, so `pulled` counts what was actually read.
function chunkedStream(chunks: Uint8Array[]) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[state.pulled]);
        state.pulled += 1;
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

describe("readBoundedText", () => {
  it("reads a body within the limit", async () => {
    const { stream } = chunkedStream([encoder.encode('{"a":'), encoder.encode("1}")]);
    await expect(readBoundedText(stream, 1024)).resolves.toEqual({ ok: true, text: '{"a":1}' });
  });

  it("reads a body exactly at the limit", async () => {
    const { stream } = chunkedStream([encoder.encode("x".repeat(1024))]);
    await expect(readBoundedText(stream, 1024)).resolves.toEqual({ ok: true, text: "x".repeat(1024) });
  });

  it("stops and cancels the stream as soon as the limit is passed", async () => {
    const chunks = Array.from({ length: 100 }, () => encoder.encode("x".repeat(512)));
    const { stream, state } = chunkedStream(chunks);

    await expect(readBoundedText(stream, 1024)).resolves.toEqual({ ok: false, reason: "too_large" });
    expect(state.cancelled).toBe(true);
    // The third 512-byte chunk passes 1,024 bytes; nothing after it is read.
    expect(state.pulled).toBe(3);
  });

  it("decodes a multi-byte character split across chunks", async () => {
    const bytes = encoder.encode("sách");
    const { stream } = chunkedStream([bytes.slice(0, 3), bytes.slice(3)]);
    await expect(readBoundedText(stream, 1024)).resolves.toEqual({ ok: true, text: "sách" });
  });

  it("rejects invalid UTF-8", async () => {
    const { stream } = chunkedStream([new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])]);
    await expect(readBoundedText(stream, 1024)).resolves.toEqual({ ok: false, reason: "invalid_encoding" });
  });

  it("reports a body that fails mid-read, such as a client abort, as aborted", async () => {
    let sent = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent) {
            controller.error(new TypeError("terminated"));
            return;
          }
          sent = true;
          controller.enqueue(encoder.encode('{"a":'));
        },
      },
      { highWaterMark: 0 },
    );

    await expect(readBoundedText(stream, 1024)).resolves.toEqual({ ok: false, reason: "aborted" });
  });

  it("treats a missing body as empty", async () => {
    await expect(readBoundedText(null, 1024)).resolves.toEqual({ ok: true, text: "" });
  });
});
