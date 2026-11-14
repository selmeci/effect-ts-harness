import * as path from "node:path"
import { Lang, parse } from "@ast-grep/napi"
import type { SyncHostIo } from "@harness/service"
import { Effect, Result, Schema } from "effect"
import { NonNegativeCount } from "./model.js"

export const StructuralSearchPattern = Schema.NonEmptyString.pipe(
  Schema.brand("StructuralSearchPattern"),
)
export type StructuralSearchPattern = typeof StructuralSearchPattern.Type

export const StructuralSearchFilePath = Schema.NonEmptyString.pipe(
  Schema.brand("StructuralSearchFilePath"),
)
export type StructuralSearchFilePath = typeof StructuralSearchFilePath.Type

export const StructuralSearchSubDir = Schema.NonEmptyString.pipe(
  Schema.brand("StructuralSearchSubDir"),
)
export type StructuralSearchSubDir = typeof StructuralSearchSubDir.Type

export const StructuralSearchLineNumber = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("StructuralSearchLineNumber"),
)
export type StructuralSearchLineNumber = typeof StructuralSearchLineNumber.Type

export const StructuralSearchMatchText = Schema.String.pipe(
  Schema.brand("StructuralSearchMatchText"),
)
export type StructuralSearchMatchText = typeof StructuralSearchMatchText.Type

export const StructuralSearchRangePoint = Schema.Struct({
  line: StructuralSearchLineNumber,
  column: StructuralSearchLineNumber,
  index: NonNegativeCount,
})
export type StructuralSearchRangePoint = typeof StructuralSearchRangePoint.Type

export const StructuralSearchRange = Schema.Struct({
  start: StructuralSearchRangePoint,
  end: StructuralSearchRangePoint,
})
export type StructuralSearchRange = typeof StructuralSearchRange.Type

export const StructuralSearchResultSchema = Schema.Struct({
  file: StructuralSearchFilePath,
  line: StructuralSearchLineNumber,
  column: StructuralSearchLineNumber,
  text: StructuralSearchMatchText,
  range: StructuralSearchRange,
})

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

export const StructuralSearchInput = Schema.Struct({
  pattern: StructuralSearchPattern,
  repoRoot: Schema.optional(StructuralSearchFilePath),
  filePath: Schema.optional(StructuralSearchFilePath),
  paths: Schema.optional(Schema.Array(StructuralSearchFilePath)),
  subDirs: Schema.optional(Schema.Array(StructuralSearchSubDir)),
})
export type StructuralSearchInput = typeof StructuralSearchInput.Type

export interface StructuralSearchOptions {
  readonly pattern: string
  readonly hostIo: SyncHostIo
  readonly repoRoot?: string | undefined
  readonly filePath?: string | undefined
  readonly paths?: ReadonlyArray<string> | undefined
  readonly subDirs?: ReadonlyArray<string> | undefined
}

const isAllowedFile = (fileName: string, allowJsJson: boolean): boolean => {
  if (fileName.endsWith(".d.ts")) {
    return false
  }
  if (fileName.endsWith(".ts") || fileName.endsWith(".tsx")) {
    return true
  }
  if (fileName.endsWith(".md") || fileName.endsWith(".sql")) {
    return true
  }
  if (allowJsJson) {
    if (fileName.endsWith(".js") || fileName.endsWith(".mjs") || fileName.endsWith(".json")) {
      return true
    }
  }
  return false
}

const resolveRepoRoot = (startDir: string, hostIo: SyncHostIo): string => {
  let curr = path.resolve(startDir)
  while (curr !== path.dirname(curr)) {
    if (hostIo.existsSync(path.join(curr, "pnpm-workspace.yaml"))) {
      return curr
    }
    curr = path.dirname(curr)
  }
  return startDir
}

const tryOrUndefined = <A>(fn: () => A): A | undefined =>
  Result.getOrElse(Result.try(fn), () => undefined)

const isContainedInRoot = (
  repoRoot: string,
  candidate: string,
  hostIo: SyncHostIo,
): string | undefined => {
  const resolved = path.resolve(repoRoot, candidate)
  const rel = path.relative(repoRoot, resolved).replace(/\\/g, "/")
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined
  }
  if (hostIo.existsSync(resolved)) {
    const realInside = tryOrUndefined(() => {
      const realRepo = hostIo.realpathSync(repoRoot)
      const realTarget = hostIo.realpathSync(resolved)
      const realRel = path.relative(realRepo, realTarget).replace(/\\/g, "/")
      return !realRel.startsWith("..") && !path.isAbsolute(realRel)
    })
    if (realInside !== true) {
      return undefined
    }
  }
  return rel
}

const walkDir = (
  repoRoot: string,
  absDir: string,
  allowJsJson: boolean,
  accum: Set<string>,
  hostIo: SyncHostIo,
): void => {
  if (!hostIo.existsSync(absDir)) return
  const entries = tryOrUndefined(() => hostIo.readdirSync(absDir))
  if (entries === undefined) return
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
    const full = path.join(absDir, name)
    if (entry.isDirectory) {
      walkDir(repoRoot, full, allowJsJson, accum, hostIo)
    }
    if (entry.isFile && isAllowedFile(name, allowJsJson)) {
      const rel = isContainedInRoot(repoRoot, full, hostIo)
      if (rel !== undefined && rel.length > 0) {
        accum.add(rel)
      }
    }
  }
}

const collectSearchFiles = (
  repoRoot: string,
  options: StructuralSearchOptions,
): ReadonlyArray<string> => {
  const { hostIo } = options
  const hasSpecificFiles =
    (options.filePath !== undefined && options.filePath.trim().length > 0) ||
    (options.paths !== undefined && options.paths.length > 0)

  const allowJsJson =
    hasSpecificFiles || (options.subDirs !== undefined && options.subDirs.length > 0)

  const accum = new Set<string>()

  if (hasSpecificFiles) {
    const rawPaths: Array<string> = []
    if (options.filePath !== undefined && options.filePath.trim().length > 0) {
      rawPaths.push(options.filePath.trim())
    }
    if (options.paths !== undefined) {
      for (const p of options.paths) {
        if (typeof p === "string" && p.trim().length > 0) {
          rawPaths.push(p.trim())
        }
      }
    }

    for (const rawPath of rawPaths) {
      const rel = isContainedInRoot(repoRoot, rawPath, hostIo)
      if (rel === undefined) {
        // Escapes repo root -> reject/skip
        continue
      }
      const abs = path.resolve(repoRoot, rawPath)
      if (!hostIo.existsSync(abs)) {
        continue
      }
      if (hostIo.isFileSync(abs)) {
        const base = path.basename(abs)
        if (isAllowedFile(base, allowJsJson)) {
          accum.add(rel)
        }
        continue
      }
      if (hostIo.isDirectorySync(abs)) {
        walkDir(repoRoot, abs, allowJsJson, accum, hostIo)
      }
    }
  } else {
    const subDirs = options.subDirs ?? ["libs", "apps"]
    for (const subDir of subDirs) {
      if (typeof subDir !== "string" || subDir.trim().length === 0) {
        continue
      }
      const rel = isContainedInRoot(repoRoot, subDir.trim(), hostIo)
      if (rel === undefined) {
        // Escapes repo root -> reject/skip
        continue
      }
      const abs = path.resolve(repoRoot, subDir.trim())
      if (!hostIo.existsSync(abs)) {
        continue
      }
      if (hostIo.isDirectorySync(abs)) {
        walkDir(repoRoot, abs, allowJsJson, accum, hostIo)
        continue
      }
      if (hostIo.isFileSync(abs)) {
        const base = path.basename(abs)
        if (isAllowedFile(base, allowJsJson)) {
          accum.add(rel)
        }
      }
    }
  }

  return Array.from(accum).sort()
}

const searchLinesDeterministic = (
  relFile: string,
  source: string,
  pattern: string,
): ReadonlyArray<StructuralSearchResult> => {
  const results: Array<StructuralSearchResult> = []
  const lines = source.split("\n")
  let currentIndex = 0

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx]!
    const lineText = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
    let colIdx = lineText.indexOf(pattern)
    while (colIdx !== -1) {
      const line = lineIdx + 1
      const column = colIdx + 1
      const index = currentIndex + colIdx
      results.push({
        file: relFile,
        line,
        column,
        text: lineText.trim(),
        range: {
          start: {
            line,
            column,
            index,
          },
          end: {
            line,
            column: column + pattern.length,
            index: index + pattern.length,
          },
        },
      })
      colIdx = lineText.indexOf(pattern, colIdx + Math.max(1, pattern.length))
    }
    currentIndex += rawLine.length + 1
  }

  return results
}

export const MAX_STRUCTURAL_SEARCH_MATCHES = 200
const DEFAULT_MAX_RESULTS = 1000

export const runStructuralSearch = (
  options: StructuralSearchOptions,
): ReadonlyArray<StructuralSearchResult> => {
  if (options.pattern.trim().length === 0) {
    return []
  }

  const { hostIo } = options
  const repoRoot = path.resolve(options.repoRoot ?? resolveRepoRoot(process.cwd(), hostIo))
  let effectiveOptions = options
  if (options?.filePath !== undefined && options.filePath.trim().length > 0) {
    const candidate = path.resolve(repoRoot, options.filePath.trim())
    if (hostIo.existsSync(candidate) && hostIo.isDirectorySync(candidate)) {
      effectiveOptions = {
        ...options,
        filePath: undefined,
        paths: options.paths
          ? [...options.paths, options.filePath.trim()]
          : [options.filePath.trim()],
      }
    }
  }

  const files = collectSearchFiles(repoRoot, effectiveOptions)
  const results: Array<StructuralSearchResult> = []

  for (const relFile of files) {
    if (results.length >= DEFAULT_MAX_RESULTS) {
      break
    }
    const fullPath = path.join(repoRoot, relFile)
    if (!hostIo.existsSync(fullPath)) continue
    const source = tryOrUndefined(() => hostIo.readTextSync(fullPath))
    if (source === undefined) {
      continue
    }

    const isTs = (relFile.endsWith(".ts") || relFile.endsWith(".tsx")) && !relFile.endsWith(".d.ts")
    const isBareDollarVar = /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(options.pattern.trim())

    if (isTs && !isBareDollarVar) {
      const lang = relFile.endsWith(".tsx") ? Lang.Tsx : Lang.TypeScript
      const matches =
        tryOrUndefined(() => parse(lang, source).root().findAll(options.pattern)) ?? []

      if (matches.length > 0) {
        for (const match of matches) {
          if (results.length >= DEFAULT_MAX_RESULTS) {
            break
          }
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
        continue
      }
      if (!options.pattern.includes("$$$")) {
        const lineMatches = searchLinesDeterministic(relFile, source, options.pattern)
        for (const m of lineMatches) {
          if (results.length >= DEFAULT_MAX_RESULTS) {
            break
          }
          results.push(m)
        }
      }
    } else {
      const lineMatches = searchLinesDeterministic(relFile, source, options.pattern)
      for (const m of lineMatches) {
        if (results.length >= DEFAULT_MAX_RESULTS) {
          break
        }
        results.push(m)
      }
    }
  }

  return results
}

export const structuralSearch = runStructuralSearch

export interface StructuralSearchMatchList extends ReadonlyArray<StructuralSearchResult> {
  readonly matchCount: number
  readonly truncated: boolean
  readonly matches: ReadonlyArray<StructuralSearchResult>
}

export const decideStructuralSearch = Effect.fn("StructuralSearch.decide")(function* (
  options: StructuralSearchOptions,
): Effect.fn.Return<StructuralSearchMatchList> {
  return yield* Effect.sync(() => {
    const allMatches = runStructuralSearch(options)
    const matches = allMatches.slice(0, MAX_STRUCTURAL_SEARCH_MATCHES)
    const out: StructuralSearchMatchList = Object.defineProperties(
      [...matches] as Array<StructuralSearchResult> & {
        matchCount: number
        truncated: boolean
        matches: ReadonlyArray<StructuralSearchResult>
      },
      {
        matchCount: {
          value: allMatches.length,
          enumerable: false,
          configurable: true,
        },
        truncated: {
          value: allMatches.length > MAX_STRUCTURAL_SEARCH_MATCHES,
          enumerable: false,
          configurable: true,
        },
        matches: {
          value: matches,
          enumerable: false,
          configurable: true,
        },
      },
    )
    return out
  })
})

export const structuralSearchEffect = (
  options: StructuralSearchOptions,
): Effect.Effect<StructuralSearchMatchList> => decideStructuralSearch(options)

export const StructuralSearch = {
  decide: decideStructuralSearch,
  search: structuralSearch,
  run: runStructuralSearch,
} as const
