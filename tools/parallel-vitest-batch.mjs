import { spawn } from "node:child_process"
import { availableParallelism } from "node:os"

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

const runOneMutant = (mutantId) =>
  new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    const child = spawn(
      process.execPath,
      [vitestCli, "run", "--bail=1", "--maxWorkers=2", ...testFiles],
      {
        cwd,
        env: { ...childBaseEnv, HARNESS_ACTIVE_MUTANT_ID: mutantId },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ id: mutantId, result })
    }
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", (err) => {
      finish({
        _tag: "SpawnFailed",
        spawnError: err instanceof Error ? err.message : String(err),
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
  await Promise.all(workers)
}

const payload = JSON.stringify(results)
await new Promise((resolve) => {
  process.stdout.write(payload, () => resolve(undefined))
})
