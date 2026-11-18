export async function readLimitedBytes(message: Request | Response, limit: number, tooLarge: Error): Promise<Buffer> {
  if (Number(message.headers.get("content-length")) > limit) {
    void message.body?.cancel().catch(() => {});
    throw tooLarge;
  }
  const reader = message.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > limit) {
        void reader.cancel().catch(() => {});
        throw tooLarge;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}
