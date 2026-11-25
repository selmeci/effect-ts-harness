import type { SyncHostIo } from "@harness/service/host-io"
import { makeTestHostIo, testHostIo } from "@harness/service/testing"

export { makeTestHostIo, testHostIo }

/**
 * Isolated `SyncHostIo` copy that strips `HARNESS_STATE_DIR` and `HARNESS_WORKTREE_ID`
 * so temp-repo unit tests reading/writing `join(dir, ".harness", ...)` stay hermetic
 * even inside `warm-vitest-worker` child processes.
 */
export const isolatedTestHostIo: SyncHostIo = {
  ...testHostIo,
  getEnv: () => {
    const env = { ...testHostIo.getEnv() }
    Reflect.deleteProperty(env, "HARNESS_STATE_DIR")
    Reflect.deleteProperty(env, "HARNESS_WORKTREE_ID")
    return env
  },
}
