import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@harness/ingest": fileURLToPath(new URL("../ingest/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.{test,spec}.ts"],
    testTimeout: 10_000,
  },
})
