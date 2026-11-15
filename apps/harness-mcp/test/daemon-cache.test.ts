import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { Effect, Option } from "effect"
import { DaemonSocketPath } from "@harness/contract"
import { queryUnixSocketLine, UnixSocketDaemonLive } from "@harness/infra"
import { startHarnessDaemonServer } from "../src/daemon/unix-socket-daemon.js"

describe("Harness daemon shared AST gate cache", () => {
  it("reuses the in-memory AstGateCachePort across consecutive ast-gates requests", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-daemon-cache-"))
    try {
      const srcDir = path.join(tmpRoot, "libs", "sample", "domain", "src")
      fs.mkdirSync(srcDir, { recursive: true })
      fs.writeFileSync(path.join(srcDir, "example.ts"), "export const answer = 42\n", "utf8")

      const handle = await startHarnessDaemonServer(tmpRoot)
      try {
        const socketPath = DaemonSocketPath.make(handle.socketPath)
        const req1 = JSON.stringify({
          id: "req-1",
          command: "ast-gates",
          files: ["libs/sample/domain/src/example.ts"],
        })
        const req2 = JSON.stringify({
          id: "req-2",
          command: "ast-gates",
          files: ["libs/sample/domain/src/example.ts"],
        })

        const raw1 = await Effect.runPromise(
          queryUnixSocketLine(socketPath, req1, 5000).pipe(Effect.provide(UnixSocketDaemonLive)),
        )
        const raw2 = await Effect.runPromise(
          queryUnixSocketLine(socketPath, req2, 5000).pipe(Effect.provide(UnixSocketDaemonLive)),
        )

        const res1 = JSON.parse(Option.getOrThrow(raw1)) as {
          readonly ok: boolean
          readonly report: { readonly cacheHitCount: number; readonly inspectedFileCount: number }
        }
        const res2 = JSON.parse(Option.getOrThrow(raw2)) as {
          readonly ok: boolean
          readonly report: { readonly cacheHitCount: number; readonly inspectedFileCount: number }
        }

        expect(res1.ok).toBe(true)
        expect(res1.report.inspectedFileCount).toBe(1)
        expect(res1.report.cacheHitCount).toBe(0)

        expect(res2.ok).toBe(true)
        expect(res2.report.inspectedFileCount).toBe(1)
        expect(res2.report.cacheHitCount).toBeGreaterThan(0)
      } finally {
        await handle.close()
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})
