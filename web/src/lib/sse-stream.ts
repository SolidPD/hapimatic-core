// SPDX-License-Identifier: AGPL-3.0-only
export interface SseStreamCallbacks {
  onEvent: (data: string) => void;
  onHeartbeat?: () => void;
}

export async function parseSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  callbacks: SseStreamCallbacks
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete events (separated by \n\n)
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        if (!block.trim()) continue;

        // Check if it's a comment/heartbeat
        if (block.startsWith(":")) {
          callbacks.onHeartbeat?.();
          continue;
        }

        // Parse data lines
        const lines = block.split("\n");
        let data = "";
        for (const line of lines) {
          if (line.startsWith("data:")) {
            // "data:" or "data: " prefix
            data += (data ? "\n" : "") + line.slice(line[5] === " " ? 6 : 5);
          }
          // Ignore other fields (event:, id:, retry:) as the server doesn't use them
        }

        if (data) {
          callbacks.onEvent(data);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
