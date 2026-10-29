import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { Effect } from "effect"

export type MutantCategory =
  | "boundary-operator"
  | "equality-operator"
  | "arithmetic-operator"
  | "boolean-return"
  | "batch-folding"
  | "terminal-state-preservation"
  | "guard-condition"

export interface CodeMutant {
  readonly id: string
  readonly file: string
  readonly line: number
  readonly category: MutantCategory
  readonly original: string
  readonly replacement: string
  readonly mutatedSource: string
}

export interface MutantOutcome {
  readonly mutant: CodeMutant
  readonly status: "killed" | "survived"
}

export interface MutationEvaluationInput {
  readonly outcomes: ReadonlyArray<MutantOutcome>
  readonly minScore?: number | undefined
}

export interface MutationSuiteReport {
  readonly passed: boolean
  readonly totalMutants: number
  readonly killedCount: number
  readonly survivedCount: number
  readonly mutationScore: number
  readonly survivedMutants: ReadonlyArray<CodeMutant>
}

const MUTATION_PATTERNS: ReadonlyArray<{
  readonly original: string
  readonly replacement: string
  readonly category: MutantCategory
}> = [
  { original: ">=", replacement: ">", category: "boundary-operator" },
  { original: "<=", replacement: "<", category: "boundary-operator" },
  { original: "===", replacement: "!==", category: "equality-operator" },
  { original: "!==", replacement: "===", category: "equality-operator" },
  { original: "+ 1", replacement: "- 1", category: "arithmetic-operator" },
  { original: "- 1", replacement: "+ 1", category: "arithmetic-operator" },
  { original: "return true", replacement: "return false", category: "boolean-return" },
  { original: "return false", replacement: "return true", category: "boolean-return" },
  { original: "events.reduce(", replacement: "events.slice(0, 1).reduce(", category: "batch-folding" },
  { original: ".reduce(evolve,", replacement: ".slice(0, 1).reduce(evolve,", category: "batch-folding" },
  { original: "() => state", replacement: "() => initialState", category: "terminal-state-preservation" },
  { original: "return state", replacement: "return initialState", category: "terminal-state-preservation" },
  { original: "if (!Equal.equals(", replacement: "if (false && !Equal.equals(", category: "guard-condition" },
  { original: "if (Equal.equals(", replacement: "if (true || Equal.equals(", category: "guard-condition" },
  { original: "if (Exit.isSuccess(", replacement: "if (false && Exit.isSuccess(", category: "guard-condition" }
]

const shouldSkipLine = (trimmed: string): boolean => {
  if (trimmed.length === 0) return true
  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("import ") ||
    trimmed.startsWith("import\t") ||
    trimmed.startsWith("export type ") ||
    trimmed.startsWith("export type\t") ||
    trimmed.startsWith("type ") ||
    trimmed.startsWith("type\t") ||
    trimmed.startsWith("interface ") ||
    trimmed.startsWith("export interface ")
  ) {
    return true
  }
  return false
}

export const discoverDomainMutants = (
  filePath: string,
  sourceCode: string
): ReadonlyArray<CodeMutant> => {
  const mutants: Array<CodeMutant> = []
  const newline = sourceCode.includes("\r\n") ? "\r\n" : "\n"
  const lines = sourceCode.split(newline)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (shouldSkipLine(trimmed)) {
      continue
    }

    const lineNo = i + 1

    for (const pattern of MUTATION_PATTERNS) {
      if (line.includes(pattern.original)) {
        const mutatedLines = [...lines]
        mutatedLines[i] = line.replace(pattern.original, pattern.replacement)
        const mutatedSource = mutatedLines.join(newline)

        mutants.push({
          id: `${filePath}:${lineNo}:${pattern.original}->${pattern.replacement}`,
          file: filePath,
          line: lineNo,
          category: pattern.category,
          original: pattern.original,
          replacement: pattern.replacement,
          mutatedSource
        })
      }
    }
  }

  return mutants
}

export const decideMutationReport = Effect.fn("MutationCheck.decide")(function* (
  input: MutationEvaluationInput
) {
  yield* Effect.void

  const totalMutants = input.outcomes.length
  const killedCount = input.outcomes.filter((o) => o.status === "killed").length
  const survivedMutants = input.outcomes
    .filter((o) => o.status === "survived")
    .map((o) => o.mutant)
  const survivedCount = survivedMutants.length
  const mutationScore = totalMutants === 0 ? 1 : killedCount / totalMutants
  const minScore = input.minScore ?? 1
  const passed = survivedCount === 0 && mutationScore >= minScore

  return {
    passed,
    totalMutants,
    killedCount,
    survivedCount,
    mutationScore,
    survivedMutants
  } satisfies MutationSuiteReport
})

export const evaluateMutationOutcomes = (
  outcomes: ReadonlyArray<MutantOutcome>,
  minScore?: number
): MutationSuiteReport =>
  Effect.runSync(decideMutationReport({ outcomes, minScore }))

interface DomainFile {
  readonly scope: string
  readonly tier: "domain" | "core" | "contract"
  readonly fullPath: string
  readonly relFile: string
}

const findDomainFiles = (
  repoRoot: string,
  scope?: string
): ReadonlyArray<DomainFile> => {
  const results: Array<DomainFile> = []
  const libsDir = join(repoRoot, "libs")
  if (!existsSync(libsDir)) return results

  let cleanScope = scope
  if (cleanScope) {
    cleanScope = cleanScope
      .replace(/^@harness\//, "")
      .replace(/-(domain|core|contract)$/, "")
  }

  const scopes = cleanScope !== undefined ? [cleanScope] : readdirSync(libsDir)

  for (const s of scopes) {
    const scopePath = join(libsDir, s)
    const tiersToScan: ReadonlyArray<{
      readonly dir: string
      readonly tier: "domain" | "core" | "contract"
    }> = [
      { dir: join(scopePath, "domain", "src"), tier: "domain" as const },
      { dir: join(scopePath, "core", "src"), tier: "core" as const },
      { dir: join(scopePath, "contract", "src"), tier: "contract" as const }
    ]

    for (const { dir, tier } of tiersToScan) {
      if (existsSync(dir)) {
        const walk = (d: string) => {
          const entries = readdirSync(d, { withFileTypes: true })
          for (const entry of entries) {
            const full = join(d, entry.name)
            if (entry.isDirectory()) {
              walk(full)
            } else if (
              entry.isFile() &&
              (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
              !entry.name.endsWith(".d.ts")
            ) {
              if (tier === "contract") {
                const content = readFileSync(full, "utf8")
                if (
                  content.includes("Effect.fn") ||
                  content.includes("Effect.gen") ||
                  content.includes("match(")
                ) {
                  const relFile = relative(repoRoot, full).replace(/\\/g, "/")
                  results.push({ scope: s, tier, fullPath: full, relFile })
                }
              } else {
                const relFile = relative(repoRoot, full).replace(/\\/g, "/")
                results.push({ scope: s, tier, fullPath: full, relFile })
              }
            }
          }
        }
        walk(dir)
      }
    }
  }

  return results
}

export const runDomainMutationSuite = (
  repoRoot: string,
  options?: { readonly scope?: string | undefined }
): MutationSuiteReport => {
  const domainFiles = findDomainFiles(repoRoot, options?.scope)
  const outcomes: Array<MutantOutcome> = []

  for (const file of domainFiles) {
    const originalContent = readFileSync(file.fullPath, "utf8")
    const mutants = discoverDomainMutants(file.relFile, originalContent)
    const pkgDir = join(repoRoot, "libs", file.scope, file.tier)

    for (const mutant of mutants) {
      const outcome = Effect.runSync(
        Effect.sync(() => {
          writeFileSync(file.fullPath, mutant.mutatedSource, "utf8")
        }).pipe(
          Effect.andThen(
            Effect.try(() => {
              execFileSync("pnpm", ["test"], {
                cwd: pkgDir,
                stdio: "pipe",
                env: { ...process.env, CI: "true" }
              })
            })
          ),
          Effect.match({
            onFailure: (): "killed" => "killed",
            onSuccess: (): "survived" => "survived"
          }),
          Effect.map((status): MutantOutcome => ({ mutant, status })),
          Effect.ensuring(
            Effect.sync(() => {
              writeFileSync(file.fullPath, originalContent, "utf8")
            })
          )
        )
      )
      outcomes.push(outcome)
    }
  }

  return evaluateMutationOutcomes(outcomes)
}
