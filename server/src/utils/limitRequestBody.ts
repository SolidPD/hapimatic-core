// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Wrap a request body so reading it fails past `maxBytes` (#5228). The stream
 * pulls one chunk per read, so no more than `maxBytes` plus one chunk is ever
 * buffered, and the source is cancelled at the limit. Hono's `bodyLimit`
 * middleware is not used: it runs before the handler's token lookup, and its
 * `start()` loop reads ahead without backpressure.
 */
export function limitRequestBody(
  raw: Request,
  maxBytes: number
): { request: Request; overLimit: () => boolean } {
  let over = false;
  if (!raw.body) return { request: raw, overLimit: () => over };
  const source = raw.body.getReader();
  let received = 0;
  const limited = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await source.read();
      if (done) {
        controller.close();
        return;
      }
      received += value.byteLength;
      if (received > maxBytes) {
        over = true;
        await source.cancel();
        controller.error(new Error("request body over limit"));
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return source.cancel(reason);
    },
  });
  return {
    request: new Request(raw, {
      body: limited,
      duplex: "half",
    } as RequestInit),
    overLimit: () => over,
  };
}
