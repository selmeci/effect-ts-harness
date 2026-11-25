import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.{test,spec}.ts"],
    testTimeout: 10_000,
    env: {
      HARNESS_WORKTREE_ID: "",
    },
  },
})
