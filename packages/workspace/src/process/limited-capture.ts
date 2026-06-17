const DEFAULT_STREAM_CAPTURE_BYTES = 256 * 1024;

export interface LimitedStreamCapture {
  text: string;
  truncated: boolean;
}

export async function readLimitedStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes = DEFAULT_STREAM_CAPTURE_BYTES,
): Promise<LimitedStreamCapture> {
  if (!stream) return { text: "", truncated: false };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (total + value.byteLength > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}
