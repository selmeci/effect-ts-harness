/**
 * @fileoverview Classifier distinguishing mutated module-initialization exceptions from runner infrastructure errors (`SPEC-0037 REQ-3.2`).
 */
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Result } from "effect"
import type { SyncHostIo } from "@harness/service/host-io"
import { stripAnsi } from "./mutation-witness.js"

const VITEST_CONFIG_CANDIDATES = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.cts",
  "vitest.config.cjs",
] as const

const isPathContainedStrict = (parentDir: string, childPath: string): boolean => {
  const rel = relative(parentDir, childPath)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** Resolves the nearest non-symlink Vitest config file covering all `testFiles` inside `repoRoot`. */
export const resolveCommonVitestConfigPath = (
  repoRoot: string,
  testFiles: ReadonlyArray<string>,
  hostIo: SyncHostIo,
): string | undefined => {
  if (testFiles.length === 0) return undefined
  const resolvedRoot = resolve(repoRoot)
  const dirs = testFiles.map((f) => dirname(resolve(resolvedRoot, f)))
  let commonDir = dirs[0]!
  while (!dirs.every((d) => isPathContainedStrict(commonDir, d))) {
    const parent = dirname(commonDir)
    if (parent === commonDir) return undefined
    commonDir = parent
  }
  if (!isPathContainedStrict(resolvedRoot, commonDir)) return undefined
  let cur = commonDir
  while (isPathContainedStrict(resolvedRoot, cur)) {
    for (const cfgName of VITEST_CONFIG_CANDIDATES) {
      const candidate = join(cur, cfgName)
      const exists = Result.getOrElse(
        Result.try(() => hostIo.existsSync(candidate) && !hostIo.isSymbolicLinkSync(candidate)),
        () => false,
      )
      if (exists) return candidate
    }
    if (cur === resolvedRoot) break
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return undefined
}

export interface MutatedModuleInitFailureInput {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly baselineImportClean: boolean
}

const HARD_INFRA_OR_SYNTAX_RE =
  /\bERR_PNPM_|Command\s+["']?vitest["']?\s+not found|Failed to load config|Failed to resolve import|Cannot find (?:module|package)|\bERR_MODULE_NOT_FOUND\b|\bSyntaxError:|Transform failed|Worker exited unexpectedly|Reached heap limit|Allocation failed|Channel closed|\b(?:EMFILE|ENOMEM|EPIPE)\b|Timeout starting/i

const MODULE_INIT_THROW_RE =
  /(?:^|\r?\n)\s*(?:(?:SchemaError|ParseError|TypeError|RangeError|ReferenceError):\s+|Error:\s+Invalid WORKFLOW_TIMEOUT_BUDGETS\b)/

const STACK_ERROR_THROW_RE =
  /(?:^|\r?\n)\s*(?:[A-Za-z_][A-Za-z0-9_]*Error|Error):\s+[^\r\n]+[\s\S]*?\r?\n\s+at\s+/

const STACK_FRAME_RE = /^\s+at\s+.*$/gm
const RUNNER_INTERNAL_FRAME_RE = /node_modules\/(?:vitest|@vitest|tinypool|birpc)\b/
const WORKSPACE_FRAME_RE = /(?:^|[\s(/])(?:libs|apps|src|test)\//

const hasOnlyRunnerInternalFrames = (text: string): boolean => {
  const frames = text.match(STACK_FRAME_RE) ?? []
  if (frames.length === 0) return false
  return (
    frames.some((frame) => RUNNER_INTERNAL_FRAME_RE.test(frame)) &&
    !frames.some((frame) => WORKSPACE_FRAME_RE.test(frame))
  )
}

/**
 * Returns `true` ONLY when an unmutated baseline imported cleanly (`baselineImportClean === true`),
 * the mutant exited with code `1`, no runner/resolution/syntax/OOM/worker crash error is present,
 * and output shows a runtime/schema module initialization throw (even if Vitest reports `Tests no tests`).
 */
export const isMutatedModuleInitFailure = (input: MutatedModuleInitFailureInput): boolean => {
  if (!input.baselineImportClean || input.exitCode !== 1) return false
  const cleanStdout = stripAnsi(input.stdout)
  const cleanStderr = stripAnsi(input.stderr).replace(/^\[mutation-check\].*$/gm, "")
  const combined = `${cleanStdout}\n${cleanStderr}`
  if (HARD_INFRA_OR_SYNTAX_RE.test(combined) || hasOnlyRunnerInternalFrames(combined)) {
    return false
  }
  return MODULE_INIT_THROW_RE.test(combined) || STACK_ERROR_THROW_RE.test(combined)
}
