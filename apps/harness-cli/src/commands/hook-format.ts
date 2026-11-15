import type { CliResult } from "./daemon-and-omnigraph.service.js"

const processHookStdinState = { isAntigravity: false }

export const markProcessStdinAntigravityDetected = (): void => {
  processHookStdinState.isAntigravity = true
}

export const resetProcessStdinAntigravityDetected = (): void => {
  processHookStdinState.isAntigravity = false
}

export const isProcessStdinAntigravityDetected = (): boolean => processHookStdinState.isAntigravity

export const resolveTeardownFailure = (
  args: ReadonlyArray<string>,
  isInterruptOnly: boolean,
  prettyCause: string,
): { readonly exitCode: number; readonly stdout: string; readonly stderr: string } => {
  const target = args.find((arg) => !arg.startsWith("-"))
  const isHook = target === "guard" || target === "done"
  if (isInterruptOnly && !isHook) return { exitCode: 130, stdout: "", stderr: "" }
  const summary = isInterruptOnly ? "interrupted by signal" : prettyCause
  if (!isHook) return { exitCode: 1, stdout: "", stderr: `${summary}\n` }
  const isAntigravity = hasAntigravityFormat(args) || isProcessStdinAntigravityDetected()
  const res =
    target === "guard"
      ? makeGuardDenyResult(isAntigravity, `${target}: ${summary}`)
      : makeDoneBlockResult(isAntigravity, `${target}: ${summary}`)
  const stdout = res.stdout ? `${res.stdout}\n` : ""
  const stderr = isInterruptOnly ? (res.stderr ? `${res.stderr}\n` : "") : `${summary}\n`
  return { exitCode: 2, stdout, stderr }
}

/**
 * Strips `[node, script]` prefix from raw `process.argv` while preserving already-normalized arrays.
 */
export const normalizeProcessArgv = (
  argv: ReadonlyArray<string>,
  isKnownCommand: (cmd: string) => boolean,
): ReadonlyArray<string> => {
  if (argv.length === 0) return argv
  const first = argv[0] ?? ""
  if (isKnownCommand(first) || first.startsWith("-")) {
    return argv
  }
  if (
    argv.length >= 2 &&
    (first.includes("/") ||
      first.includes("\\") ||
      first === "node" ||
      first === "tsx" ||
      first.endsWith(".exe"))
  ) {
    return argv.slice(2)
  }
  return argv
}

/**
 * Returns true when argv specifies `--format=antigravity` or `--format antigravity`.
 */
export const hasAntigravityFormat = (argv: ReadonlyArray<string>): boolean => {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--format=antigravity") {
      return true
    }
    if (arg === "--format" && argv[i + 1] === "antigravity") {
      return true
    }
  }
  return false
}

/**
 * Returns true when raw stdin JSON contains an Antigravity PreToolUse or Stop hook payload.
 */
export const detectAntigravityHookPayload = (rawStdin: string): boolean =>
  /"(?:toolCall|fullyIdle|workspacePaths|conversationId)"\s*:/.test(rawStdin)

/**
 * Builds a fail-closed Stop (`done`) hook result matching Antigravity (`continue`, exit 0)
 * or Claude Code (`block`, exit 2) protocol.
 */
export const makeDoneBlockResult = (
  isAntigravity: boolean,
  reason: string,
  extraStderr = "",
): CliResult =>
  isAntigravity
    ? {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "continue", reason }),
        stderr: extraStderr,
      }
    : {
        exitCode: 2,
        stdout: JSON.stringify({ decision: "block", reason }),
        stderr: extraStderr.length > 0 ? `${extraStderr}${reason}` : reason,
      }

/**
 * Builds a fail-closed PreToolUse (`guard`) hook result matching Antigravity (`deny`, exit 0)
 * or Claude Code (exit 2) protocol.
 */
export const makeGuardDenyResult = (
  isAntigravity: boolean,
  reason: string,
  extraStderr = "",
): CliResult =>
  isAntigravity
    ? {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "deny", reason }),
        stderr: extraStderr,
      }
    : {
        exitCode: 2,
        stdout: "",
        stderr: extraStderr.length > 0 ? `${extraStderr}${reason}` : reason,
      }
