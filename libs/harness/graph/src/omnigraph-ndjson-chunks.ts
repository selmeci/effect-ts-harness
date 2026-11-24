export const DEFAULT_OMNIGRAPH_LOAD_CHUNK_BYTES = 1_048_576
export const DEFAULT_OMNIGRAPH_OVERWRITE_CHUNK_BYTES = 16 * 1024 * 1024

const UTF8_ENCODER = new TextEncoder()

/** Splits an NDJSON payload on line boundaries so each chunk fits within `maxChunkBytes` UTF-8 bytes. */
export const splitNdjsonIntoByteChunks = (
  ndjson: string,
  maxChunkBytes: number = DEFAULT_OMNIGRAPH_LOAD_CHUNK_BYTES,
): ReadonlyArray<string> => {
  const limit = Math.max(1, Math.floor(maxChunkBytes))
  if (UTF8_ENCODER.encode(ndjson).byteLength <= limit) return [ndjson]
  const lines = ndjson.split("\n").filter((line) => line.length > 0)
  if (lines.length <= 1) return [ndjson]
  const chunks: Array<string> = []
  let current: Array<string> = []
  let currentBytes = 0
  for (const line of lines) {
    const lineBytes = UTF8_ENCODER.encode(line).byteLength + 1
    if (current.length > 0 && currentBytes + lineBytes > limit) {
      chunks.push(current.join("\n"))
      current = []
      currentBytes = 0
    }
    current.push(line)
    currentBytes += lineBytes
  }
  if (current.length > 0) chunks.push(current.join("\n"))
  return chunks
}
