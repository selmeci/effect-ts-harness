import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@harness/ingest": fileURLToPath(new URL("../ingest/src/index.ts", import.meta.url)),
    },
  },
  test: {
    testTimeout: 10_000,
  },
})
