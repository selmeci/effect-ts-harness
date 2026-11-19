import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.{test,spec}.ts"],
    testTimeout: 10_000,
    env: {
      HARNESS_DISABLE_LIVE_TELEMETRY: "1",
    },
  },
})
