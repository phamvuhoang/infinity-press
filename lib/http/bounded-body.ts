// Reads a request body as UTF-8 text without ever holding more than `maxBytes` of it. A declared
// Content-Length is optional and untrusted - a chunked body has none - so request.text(), which
// buffers everything before any size check can run, is not a limit. This reads chunk by chunk and
// cancels the stream the moment the running total passes the limit, so an oversized body is never
// read to its end. A body that fails mid-read - a client that disconnects or aborts - is reported
// as `aborted`, never thrown, so the caller answers it like any other malformed request.
export type BoundedTextResult =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" | "invalid_encoding" | "aborted" };

export async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<BoundedTextResult> {
  if (body === null) return { ok: true, text: "" };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        return { ok: false, reason: "aborted" };
      }
      const { done, value } = chunk;
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Tell the source to stop sending; the rest of the body is discarded unread.
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, reason: "invalid_encoding" };
  }
}
