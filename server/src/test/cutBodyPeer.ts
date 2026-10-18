// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Socket } from "node:net";

/**
 * Issue #5408: a peer that answers with a Content-Length larger than the body
 * it sends, then drops the connection mid-body. On Bun 1.4 the body read
 * rejects with a TypeError code "ECONNRESET". A real socket is required: an
 * in-memory Response does not reproduce Bun's network-body behaviour.
 *
 * It replies on the first chunk of the request, so a POST upload whose body is
 * still streaming gets its answer too.
 */
export async function startCutBodyPeer(
  status = 200
): Promise<{ url: string; stop(): void }> {
  const sockets = new Set<Socket>();
  const server = createServer(sock => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    sock.once("data", () => {
      sock.write(
        `HTTP/1.1 ${status} Status\r\n` +
          "Content-Type: application/json\r\n" +
          "Content-Length: 200\r\n\r\n" +
          '{"messages":[1,'
      );
      setTimeout(() => sock.destroy(), 20);
    });
  });
  await new Promise<void>(resolve =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("cut-body peer did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop() {
      for (const sock of sockets) sock.destroy();
      server.close();
    },
  };
}
