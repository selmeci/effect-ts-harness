import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { match } from "ts-pattern"
import { classifyCommand, isSkipNxCacheOverrideCommand } from "@harness/gates/policy"
import {
  appendHookTelemetryLite,
  findWorkspaceRootLite,
  isIngestSnapshotUpToDateLite,
  readHookStdinCallback,
  tryReadPreInvocationCacheLite,
} from "@harness/infra/hook-io"
import {
  type CliResult,
  detectAntigravityHookPayload,
  hasAntigravityFormat,
  makeDoneBlockResult,
  makeGuardDenyResult,
} from "./hook-format.js"
import {
  evaluateFileWriteDecision,
  extractGuardStdinPayload,
  formatCommandDenyReason,
  type GuardVerdictDecision,
  type ParsedGuardCliArgs,
  parseGuardCliArgs,
  pickStrictestDecision,
  toGuardCliResult,
} from "./hook-guard-payload.js"

const CLI_REPO_ROOT = findWorkspaceRootLite(dirname(fileURLToPath(import.meta.url)))
const STDIN_TIMEOUT_MS = 4_000
const STDIN_MAX_BYTES = 2 * 1024 * 1024

const writeResultAndExit = (res: CliResult): void => {
  if (res.stdout) {
    process.stdout.write(res.stdout.endsWith("\n") ? res.stdout : `${res.stdout}\n`)
  }
  if (res.stderr) {
    process.stderr.write(res.stderr.endsWith("\n") ? res.stderr : `${res.stderr}\n`)
  }
  process.exitCode = res.exitCode
}

const delegateToFallback = (
  argv: ReadonlyArray<string>,
  extraOptions?: {
    readonly stdin?: string | undefined
    readonly skipInitialSessionCacheRead?: boolean | undefined
  },
): void => {
  void import("./hook-fallback.js")
    .then((m) => {
      m.runHookCliFallback(argv, extraOptions)
    })
    .catch((err: unknown) => {
      const target = argv.find((arg) => !arg.startsWith("-"))
      const msg = err instanceof Error ? err.message : String(err)
      const isAg =
        hasAntigravityFormat(argv) ||
        (extraOptions?.stdin !== undefined && detectAntigravityHookPayload(extraOptions.stdin))
      if (target === "guard") {
        const res = makeGuardDenyResult(isAg, `guard: failed to load CLI fallback (${msg})`)
        writeResultAndExit({
          exitCode: 2,
          stdout: res.stdout,
          stderr: res.stderr || `guard: failed to load CLI fallback (${msg})`,
        })
        return
      }
      if (target === "done") {
        const res = makeDoneBlockResult(isAg, `done: failed to load CLI fallback (${msg})`)
        writeResultAndExit({
          exitCode: 2,
          stdout: res.stdout,
          stderr: res.stderr || `done: failed to load CLI fallback (${msg})`,
        })
        return
      }
      process.stderr.write(`[harness:hook] Failed to load CLI fallback: ${msg}\n`)
      process.exitCode = 1
    })
}

const recordGuardTelemetry = (
  outcome: "ok" | "deny" | "ask",
  startMs: number,
  detail: string,
): void => {
  appendHookTelemetryLite({
    repoRoot: findWorkspaceRootLite(process.cwd(), CLI_REPO_ROOT),
    cliRepoRoot: CLI_REPO_ROOT,
    surface: "hook",
    category: "guard",
    toolName: "guard",
    outcome,
    durationMs: performance.now() - startMs,
    detail,
  })
}

const evaluateGuardPayload = (
  argv: ReadonlyArray<string>,
  rawStdin: string,
  startMs: number,
): void => {
  const isAntigravityFlag = hasAntigravityFormat(argv)
  if (rawStdin.trim().length === 0) {
    recordGuardTelemetry("deny", startMs, "fastpath=empty-stdin")
    writeResultAndExit(makeGuardDenyResult(isAntigravityFlag, "guard: empty hook stdin payload"))
    return
  }

  const extracted = extractGuardStdinPayload(rawStdin, isAntigravityFlag)
  match(extracted)
    .with({ _tag: "Error" }, ({ isAntigravity, reason, detail }) => {
      recordGuardTelemetry("deny", startMs, detail)
      writeResultAndExit(makeGuardDenyResult(isAntigravity, reason))
    })
    .with({ _tag: "ReadOnly" }, ({ isAntigravity }) => {
      recordGuardTelemetry("ok", startMs, "fastpath=hit")
      writeResultAndExit(toGuardCliResult({ verdict: "allow" }, isAntigravity))
    })
    .with({ _tag: "Action" }, ({ isAntigravity, candidateCmds, candidatePaths }) => {
      let combinedDecision: GuardVerdictDecision | undefined
      for (const filePath of candidatePaths) {
        const d = evaluateFileWriteDecision(filePath)
        combinedDecision =
          combinedDecision === undefined ? d : pickStrictestDecision(combinedDecision, d)
      }
      for (const cmd of candidateCmds) {
        if (isSkipNxCacheOverrideCommand(cmd)) {
          delegateToFallback(argv, { stdin: rawStdin })
          return
        }
        const classification = classifyCommand(cmd)
        if (classification === "escalate") {
          delegateToFallback(argv, { stdin: rawStdin })
          return
        }
        const d = match<typeof classification, GuardVerdictDecision>(classification)
          .with("deny", () => ({ verdict: "deny", reason: formatCommandDenyReason(cmd) }))
          .with("allow", () => ({ verdict: "allow" }))
          .with("ask", () => ({
            verdict: "ask",
            reason: `Command requires human confirmation: ${cmd}`,
          }))
          .exhaustive()
        combinedDecision =
          combinedDecision === undefined ? d : pickStrictestDecision(combinedDecision, d)
      }

      const finalDecision: GuardVerdictDecision =
        combinedDecision !== undefined
          ? combinedDecision
          : { verdict: "deny", reason: "guard: empty hook command payload" }

      const outcome = match(finalDecision.verdict)
        .with("allow", () => "ok" as const)
        .with("deny", () => "deny" as const)
        .with("ask", () => "ask" as const)
        .exhaustive()
      recordGuardTelemetry(outcome, startMs, "fastpath=hit")
      writeResultAndExit(toGuardCliResult(finalDecision, isAntigravity))
    })
    .exhaustive()
}

const runGuardFastPath = (argv: ReadonlyArray<string>, startMs: number): void => {
  const isAntigravity = hasAntigravityFormat(argv)
  const parsed = parseGuardCliArgs(argv.slice(1))
  match(parsed)
    .with({ _tag: "Help" }, () => {
      recordGuardTelemetry("deny", startMs, "fastpath=help-flag")
      writeResultAndExit(
        makeGuardDenyResult(
          isAntigravity,
          "guard: CLI parse failure (--help is not allowed in hook mode)",
        ),
      )
    })
    .with({ _tag: "UnknownFlag" }, ({ flag }) => {
      recordGuardTelemetry("deny", startMs, "fastpath=unknown-flag")
      writeResultAndExit(
        makeGuardDenyResult(isAntigravity, `guard: CLI parse failure (Unrecognized flag: ${flag})`),
      )
    })
    .with({ _tag: "MissingFlagValue" }, ({ flag }) => {
      recordGuardTelemetry("deny", startMs, "fastpath=missing-flag-value")
      writeResultAndExit(
        makeGuardDenyResult(isAntigravity, `guard: CLI parse failure (Missing value for ${flag})`),
      )
    })
    .with({ _tag: "Ok" }, ({ positionalArgs, fileFlag }) => {
      if (positionalArgs.length > 0 || fileFlag !== undefined || process.stdin.isTTY === true) {
        delegateToFallback(argv)
        return
      }
      readHookStdinCallback({ timeoutMs: STDIN_TIMEOUT_MS, maxBytes: STDIN_MAX_BYTES }, (res) => {
        match(res)
          .with({ _tag: "Failed" }, ({ reason }) => {
            recordGuardTelemetry("deny", startMs, "fastpath=stdin-error")
            writeResultAndExit(
              makeGuardDenyResult(
                isAntigravity,
                `guard: failed or timed out reading hook stdin payload (${reason})`,
              ),
            )
          })
          .with({ _tag: "Ok" }, ({ text }) => {
            evaluateGuardPayload(argv, text, startMs)
          })
          .exhaustive()
      })
    })
    .exhaustive()
}

const isPlainFormatOnlyFlags = (parsed: ParsedGuardCliArgs): boolean =>
  match(parsed)
    .with(
      { _tag: "Ok" },
      ({ positionalArgs, fileFlag }) => positionalArgs.length === 0 && fileFlag === undefined,
    )
    .with({ _tag: "Help" }, { _tag: "UnknownFlag" }, { _tag: "MissingFlagValue" }, () => false)
    .exhaustive()

const runIngestFastPath = (argv: ReadonlyArray<string>, startMs: number): void => {
  if (!isPlainFormatOnlyFlags(parseGuardCliArgs(argv.slice(1))) || !hasAntigravityFormat(argv)) {
    delegateToFallback(argv)
    return
  }
  const repoRoot = findWorkspaceRootLite(process.cwd(), CLI_REPO_ROOT)
  if (!isIngestSnapshotUpToDateLite(repoRoot, process.env)) {
    delegateToFallback(argv)
    return
  }
  appendHookTelemetryLite({
    repoRoot,
    cliRepoRoot: CLI_REPO_ROOT,
    surface: "hook",
    category: "lifecycle",
    toolName: "ingest",
    outcome: "ok",
    durationMs: performance.now() - startMs,
    detail: "cache=hit",
  })
  writeResultAndExit({ exitCode: 0, stdout: "{}", stderr: "" })
}

const runSessionFastPath = (argv: ReadonlyArray<string>, startMs: number): void => {
  if (
    !isPlainFormatOnlyFlags(parseGuardCliArgs(argv.slice(1))) ||
    !hasAntigravityFormat(argv) ||
    process.env["HARNESS_REQUIRE_OLLAMA"] === "1"
  ) {
    delegateToFallback(argv)
    return
  }

  const repoRoot = findWorkspaceRootLite(process.cwd(), CLI_REPO_ROOT)
  const lookup = tryReadPreInvocationCacheLite({
    repoRoot,
    cliRepoRoot: CLI_REPO_ROOT,
    env: process.env,
  })
  match(lookup)
    .with({ _tag: "Hit" }, ({ stdout, stderr }) => {
      appendHookTelemetryLite({
        repoRoot,
        cliRepoRoot: CLI_REPO_ROOT,
        surface: "hook",
        category: "lifecycle",
        toolName: "session",
        outcome: "ok",
        durationMs: performance.now() - startMs,
        detail: "cache=hit",
      })
      writeResultAndExit({ exitCode: 0, stdout, stderr })
    })
    .with({ _tag: "Miss" }, () => {
      delegateToFallback(argv, { skipInitialSessionCacheRead: true })
    })
    .exhaustive()
}

export const runHookEntryFastPath = (argv: ReadonlyArray<string>): void => {
  const startMs = performance.now()
  const subcommand = argv[0]
  if (subcommand === "guard") {
    runGuardFastPath(argv, startMs)
    return
  }
  if (subcommand === "ingest") {
    runIngestFastPath(argv, startMs)
    return
  }
  if (subcommand === "session") {
    runSessionFastPath(argv, startMs)
    return
  }
  delegateToFallback(argv)
}
