import type { CliResult } from "./daemon-and-omnigraph.service.js"

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
