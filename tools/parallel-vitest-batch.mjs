import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { availableParallelism, tmpdir } from "node:os"
import { join, resolve } from "node:path"

const vitestCli = process.env["HARNESS_BATCH_VITEST_CLI"] ?? ""
const cwd = process.env["HARNESS_BATCH_CWD"] ?? process.cwd()
const parsedTimeout = Number(process.env["HARNESS_BATCH_TIMEOUT_MS"] ?? "30000")
const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 30_000
const testFiles = JSON.parse(process.env["HARNESS_BATCH_TESTS_JSON"] ?? "[]")
const mutantIds = JSON.parse(process.env["HARNESS_BATCH_MUTANTS_JSON"] ?? "[]")

const truncateOutput = (text) =>
  text.length > 48_000
    ? `${text.slice(0, 16_000)}\n...[truncated]...\n${text.slice(-24_000)}`
    : text

const childBaseEnv = { ...process.env }
delete childBaseEnv["HARNESS_BATCH_VITEST_CLI"]
delete childBaseEnv["HARNESS_BATCH_CWD"]
delete childBaseEnv["HARNESS_BATCH_TIMEOUT_MS"]
delete childBaseEnv["HARNESS_BATCH_TESTS_JSON"]
delete childBaseEnv["HARNESS_BATCH_MUTANTS_JSON"]
delete childBaseEnv["HARNESS_ACTIVE_MUTANT_ID"]

const activeChildren = new Set()
const activeStateDirs = new Set()

const cleanupActiveWorkers = () => {
  for (const child of activeChildren) {
    try {
      child.kill("SIGKILL")
    } catch {
      // Best-effort termination of active batch worker
    }
  }
  activeChildren.clear()
  for (const dir of activeStateDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup of per-worker temporary state directory
    }
  }
  activeStateDirs.clear()
}

for (const [sig, code] of [
  ["SIGINT", 2],
  ["SIGTERM", 15],
]) {
  process.once(sig, () => {
    cleanupActiveWorkers()
    process.exit(128 + code)
  })
}

const runOneMutant = async (mutantId) => {
  const workerStateDir = resolve(mkdtempSync(join(tmpdir(), "harness-batch-state-")))
  activeStateDirs.add(workerStateDir)
  const childEnv = {
    ...childBaseEnv,
    HARNESS_STATE_DIR: workerStateDir,
    HARNESS_ACTIVE_MUTANT_ID: mutantId,
  }
  try {
    return await new Promise((resolvePromise) => {
      let stdout = ""
      let stderr = ""
      let timedOut = false
      let settled = false
      let child
      try {
        child = spawn(
          process.execPath,
          [vitestCli, "run", "--bail=1", "--maxWorkers=1", ...testFiles],
          {
            cwd,
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
          },
        )
      } catch (err) {
        const rawErr = (err instanceof Error ? err.message : String(err)).trim()
        resolvePromise({
          id: mutantId,
          result: {
            _tag: "SpawnFailed",
            spawnError: rawErr.length > 0 ? rawErr : "Spawn failed",
            stdout: "",
            stderr: "",
          },
        })
        return
      }
      activeChildren.add(child)
      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
      }, timeoutMs)
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        activeChildren.delete(child)
        resolvePromise({ id: mutantId, result })
      }
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk)
      })
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk)
      })
      child.on("error", (err) => {
        const rawErr = (err instanceof Error ? err.message : String(err)).trim()
        finish({
          _tag: "SpawnFailed",
          spawnError: rawErr.length > 0 ? rawErr : "Spawn failed",
          stdout: truncateOutput(stdout),
          stderr: truncateOutput(stderr),
        })
      })
      child.on("close", (code, signal) => {
        const out = truncateOutput(stdout)
        const errOut = truncateOutput(stderr)
        if (timedOut) {
          finish({ _tag: "TimedOut", stdout: out, stderr: errOut })
          return
        }
        if (signal !== null) {
          finish({ _tag: "Signaled", signal, stdout: out, stderr: errOut })
          return
        }
        finish({ _tag: "Exited", exitCode: code ?? -1, stdout: out, stderr: errOut })
      })
    })
  } finally {
    activeStateDirs.delete(workerStateDir)
    try {
      rmSync(workerStateDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup of per-worker temporary state directory
    }
  }
}

const results = Array.from({ length: mutantIds.length })
if (mutantIds.length > 0) {
  const concurrency = Math.min(6, Math.max(2, availableParallelism()), mutantIds.length)
  let nextIdx = 0
  const workers = Array.from({ length: concurrency }, async () => {
    while (nextIdx < mutantIds.length) {
      const idx = nextIdx
      nextIdx += 1
      results[idx] = await runOneMutant(mutantIds[idx])
    }
  })
  try {
    await Promise.all(workers)
  } finally {
    cleanupActiveWorkers()
  }
}

const payload = JSON.stringify(results)
await new Promise((resolve) => {
  process.stdout.write(payload, () => resolve(undefined))
})
