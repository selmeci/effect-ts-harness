import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { Effect, Option } from "effect"
import { DaemonSocketPath, WorkspaceFilePath } from "@harness/contract"
import { AST_GATE_RULE_SOURCE_FILES } from "@harness/gates"
import { queryUnixSocketLine, resolveAstGateCachePath, UnixSocketDaemonLive } from "@harness/infra"
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

  it("F-10.1: ast-gates fails closed with ok: false when any requested file is missing", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-daemon-missing-"))
    try {
      const handle = await startHarnessDaemonServer(tmpRoot)
      try {
        const socketPath = DaemonSocketPath.make(handle.socketPath)
        const req = JSON.stringify({
          id: "req-missing",
          command: "ast-gates",
          files: ["libs/sample/domain/src/does-not-exist.ts"],
        })
        const raw = await Effect.runPromise(
          queryUnixSocketLine(socketPath, req, 5000).pipe(Effect.provide(UnixSocketDaemonLive)),
        )
        const res = JSON.parse(Option.getOrThrow(raw)) as {
          readonly id: string
          readonly ok: boolean
          readonly error?: string
        }
        expect(res.id).toBe("req-missing")
        expect(res.ok).toBe(false)
        expect(typeof res.error).toBe("string")
        expect((res.error ?? "").length).toBeGreaterThan(0)
      } finally {
        await handle.close()
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it("F-2.1: ast-gates rejects stale cached evaluation with fallbackToInProcess: true when rule source files drift after daemon startup", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-daemon-drift-root-"))
    const tmpRuleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-daemon-drift-rules-"))
    try {
      const srcDir = path.join(tmpRoot, "libs", "sample", "domain", "src")
      fs.mkdirSync(srcDir, { recursive: true })
      fs.writeFileSync(path.join(srcDir, "example.ts"), "export const answer = 42\n", "utf8")

      for (const rel of AST_GATE_RULE_SOURCE_FILES) {
        const abs = path.join(tmpRuleRoot, rel)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, `// fixture rule ${rel}\n`, "utf8")
      }

      const handle = await startHarnessDaemonServer(tmpRoot, {
        ruleSourceRoot: WorkspaceFilePath.make(tmpRuleRoot),
      })
      try {
        const socketPath = DaemonSocketPath.make(handle.socketPath)
        const req1 = JSON.stringify({
          id: "req-before-drift",
          command: "ast-gates",
          files: ["libs/sample/domain/src/example.ts"],
        })
        const raw1 = await Effect.runPromise(
          queryUnixSocketLine(socketPath, req1, 5000).pipe(Effect.provide(UnixSocketDaemonLive)),
        )
        const res1 = JSON.parse(Option.getOrThrow(raw1)) as {
          readonly ok: boolean
          readonly report?: { readonly inspectedFileCount: number }
        }
        expect(res1.ok).toBe(true)
        expect(res1.report?.inspectedFileCount).toBe(1)

        const cachePath = resolveAstGateCachePath(tmpRoot)
        expect(fs.existsSync(cachePath)).toBe(true)
        const diskSnapshotBeforeDrift = fs.readFileSync(cachePath, "utf8")

        // Mutate one tracked AST gate rule source file on disk after daemon boot
        const firstRuleFile = path.join(tmpRuleRoot, AST_GATE_RULE_SOURCE_FILES[0])
        fs.writeFileSync(firstRuleFile, "// rule mutated after daemon boot\n", "utf8")

        const req2 = JSON.stringify({
          id: "req-after-drift",
          command: "ast-gates",
          files: ["libs/sample/domain/src/example.ts"],
        })
        const raw2 = await Effect.runPromise(
          queryUnixSocketLine(socketPath, req2, 5000).pipe(Effect.provide(UnixSocketDaemonLive)),
        )
        const res2 = JSON.parse(Option.getOrThrow(raw2)) as {
          readonly id: string
          readonly ok: boolean
          readonly fallbackToInProcess?: boolean
          readonly error?: string
        }
        expect(res2.id).toBe("req-after-drift")
        expect(res2.ok).toBe(false)
        expect(res2.fallbackToInProcess).toBe(true)
        expect(res2.error).toContain("changed since daemon startup")
        expect(fs.readFileSync(cachePath, "utf8")).toBe(diskSnapshotBeforeDrift)
      } finally {
        await handle.close()
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
      fs.rmSync(tmpRuleRoot, { recursive: true, force: true })
    }
  })

  it("F-21: ast-gates returns structured ok: false error when source file exceeds 4MiB AstSourceContent bound", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-daemon-oversized-"))
    try {
      const srcDir = path.join(tmpRoot, "libs", "sample", "domain", "src")
      fs.mkdirSync(srcDir, { recursive: true })
      fs.writeFileSync(path.join(srcDir, "huge.ts"), `// ${"a".repeat(4_194_310)}\n`, "utf8")

      const handle = await startHarnessDaemonServer(tmpRoot)
      try {
        const socketPath = DaemonSocketPath.make(handle.socketPath)
        const req = JSON.stringify({
          id: "req-oversized",
          command: "ast-gates",
          files: ["libs/sample/domain/src/huge.ts"],
        })
        const raw = await Effect.runPromise(
          queryUnixSocketLine(socketPath, req, 5000).pipe(Effect.provide(UnixSocketDaemonLive)),
        )
        const res = JSON.parse(Option.getOrThrow(raw)) as {
          readonly id: string
          readonly ok: boolean
          readonly error?: string
        }
        expect(res.id).toBe("req-oversized")
        expect(res.ok).toBe(false)
        expect(res.error).toContain("exceeds bounded size")
      } finally {
        await handle.close()
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})
