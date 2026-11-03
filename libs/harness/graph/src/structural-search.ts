import * as fs from "node:fs"
import * as path from "node:path"
import { Lang, parse } from "@ast-grep/napi"
import { Effect } from "effect"

export interface StructuralSearchResult {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly text: string
  readonly range: {
    readonly start: { readonly line: number; readonly column: number; readonly index: number }
    readonly end: { readonly line: number; readonly column: number; readonly index: number }
  }
}

export interface StructuralSearchOptions {
  readonly pattern: string
  readonly repoRoot?: string
  readonly subDirs?: ReadonlyArray<string>
}

const findWorkspaceTsFiles = (
  repoRoot: string,
  subDirs: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const results: Array<string> = []

  const walk = (current: string): void => {
    if (!fs.existsSync(current)) return
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const name = entry.name
      if (
        name === "node_modules" ||
        name === "dist" ||
        name === "repos" ||
        name === ".nx" ||
        name === ".git" ||
        name === ".harness"
      ) {
        continue
      }
      const full = path.join(current, name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (
        entry.isFile() &&
        (name.endsWith(".ts") || name.endsWith(".tsx")) &&
        !name.endsWith(".d.ts")
      ) {
        const rel = path.relative(repoRoot, full).replace(/\\/g, "/")
        results.push(rel)
      }
    }
  }

  for (const subDir of subDirs) {
    walk(path.join(repoRoot, subDir))
  }

  return results
}

const resolveRepoRoot = (startDir: string): string => {
  let curr = path.resolve(startDir)
  while (curr !== path.dirname(curr)) {
    if (fs.existsSync(path.join(curr, "pnpm-workspace.yaml"))) {
      return curr
    }
    curr = path.dirname(curr)
  }
  return startDir
}

export const structuralSearch = (
  options: StructuralSearchOptions,
): ReadonlyArray<StructuralSearchResult> => {
  const repoRoot = options.repoRoot ?? resolveRepoRoot(process.cwd())
  const subDirs = options.subDirs ?? ["libs", "apps"]
  const files = findWorkspaceTsFiles(repoRoot, subDirs)
  const results: Array<StructuralSearchResult> = []

  for (const relFile of files) {
    const fullPath = path.join(repoRoot, relFile)
    if (!fs.existsSync(fullPath)) continue
    const source = fs.readFileSync(fullPath, "utf-8")
    const root = parse(Lang.TypeScript, source).root()
    const matches = root.findAll(options.pattern)

    for (const match of matches) {
      const range = match.range()
      results.push({
        file: relFile,
        line: range.start.line + 1,
        column: range.start.column + 1,
        text: match.text(),
        range: {
          start: {
            line: range.start.line + 1,
            column: range.start.column + 1,
            index: range.start.index,
          },
          end: {
            line: range.end.line + 1,
            column: range.end.column + 1,
            index: range.end.index,
          },
        },
      })
    }
  }

  return results
}

export const structuralSearchEffect = (
  options: StructuralSearchOptions,
): Effect.Effect<ReadonlyArray<StructuralSearchResult>> =>
  Effect.sync(() => structuralSearch(options))
