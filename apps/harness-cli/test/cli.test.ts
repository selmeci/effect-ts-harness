import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { buildHarnessGraph } from "@harness/graph"
import { runCli } from "../src/index.js"

describe("harness cli plan-synth and repair commands", () => {
  it("rejects plan-synth without spec-id and prints usage", async () => {
    const res = await runCli(["plan-synth"])
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain("usage: harness plan-synth <spec-id>")
  })

  it("executes plan-synth <spec-id> against a graph with an EarsSpec", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cli-plan-synth-"))
    try {
      const planGraph = buildHarnessGraph({
        earsSpecs: [
          {
            id: "order:SPEC-0001",
            title: "Order Placement Spec",
            status: "proposed",
            path: "libs/order/docs/specs/0001-order.md",
            enforcedByFiles: ["libs/order/domain/src/order.ts"],
            referencedSpans: ["Order.placeOrder"],
            referencedServices: ["OrderService"],
            referencedErrors: ["OrderRejectedError"],
          },
        ],
      })

      const res = await runCli(["plan-synth", "order:SPEC-0001"], {
        repoRoot: dir,
        implGraph: planGraph,
      })

      expect(res.exitCode).toBe(0)
      const payload = JSON.parse(res.stdout) as {
        readonly specId: string
        readonly mode: string
        readonly patchCount: number
        readonly overlayCount: number
        readonly overlays: ReadonlyArray<{ readonly targetFile: string; readonly content: string }>
      }

      expect(payload.specId).toBe("order:SPEC-0001")
      expect(payload.mode).toBe("auto-plan")
      expect(payload.patchCount).toBeGreaterThan(0)
      expect(payload.overlayCount).toBeGreaterThan(0)
      expect(Array.isArray(payload.overlays)).toBe(true)

      // Test with --write flag
      const writeRes = await runCli(["plan-synth", "order:SPEC-0001", "--write"], {
        repoRoot: dir,
        implGraph: planGraph,
      })
      expect(writeRes.exitCode).toBe(0)
      const writePayload = JSON.parse(writeRes.stdout) as {
        readonly written: boolean
        readonly writtenFiles: ReadonlyArray<string>
      }
      expect(writePayload.written).toBe(true)
      expect(writePayload.writtenFiles.length).toBeGreaterThan(0)
      for (const writtenFile of writePayload.writtenFiles) {
        const fullPath = join(dir, writtenFile)
        expect(existsSync(fullPath)).toBe(true)
        const fileContent = readFileSync(fullPath, "utf-8")
        expect(fileContent.length).toBeGreaterThan(0)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("executes repair --rule REP-05 against a graph with an untraced function", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cli-repair-"))
    try {
      const untracedGraph = buildHarnessGraph({
        fns: [
          {
            qualname: "libs/sample/domain/src/order.ts#decideUntraced",
            spanName: "untraced",
            file: "libs/sample/domain/src/order.ts",
            line: 20,
            packageTag: "domain",
            successType: "void",
            isStub: false,
          },
        ],
      })

      const res = await runCli(["repair", "--rule", "REP-05"], {
        repoRoot: dir,
        implGraph: untracedGraph,
      })

      expect(res.exitCode).toBe(0)
      const payload = JSON.parse(res.stdout) as {
        readonly mode: string
        readonly ruleFilter: string
        readonly patchCount: number
        readonly overlayCount: number
        readonly operations: ReadonlyArray<unknown>
      }

      expect(payload.mode).toBe("auto-repair")
      expect(payload.ruleFilter).toBe("REP-05")
      expect(payload.patchCount).toBeGreaterThan(0)
      expect(Array.isArray(payload.operations)).toBe(true)

      // Also test --rule=REP-05 syntax
      const resEq = await runCli(["repair", "--rule=REP-05"], {
        repoRoot: dir,
        implGraph: untracedGraph,
      })
      expect(resEq.exitCode).toBe(0)
      expect(JSON.parse(resEq.stdout).ruleFilter).toBe("REP-05")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
