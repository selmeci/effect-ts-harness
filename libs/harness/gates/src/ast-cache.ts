import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import { NonNegativeCount, ts } from "@harness/graph"
import { decideMigrationSafety } from "./migration-check.js"
import {
  getLineNumber,
  inferPackageTagFromPath,
  isDummyEffectVoidYield,
  isImpureDomainSpecifier,
  MIGRATOR_KEY_REGEX,
  resolveEnclosingSymbol,
  SCHEMA_CTORS,
  SUSPICIOUS_SQL_DDL_REGEX,
  unwrapAstExpression,
  visitSourceFileSinglePass,
} from "./plugins/ast-gate-visitors.js"
import { resolveHarnessStateDir } from "./worktree.js"

export const GateRuleVersion = Schema.NonEmptyString.pipe(Schema.brand("GateRuleVersion"))
export type GateRuleVersion = typeof GateRuleVersion.Type
export const AstRuleVersion = GateRuleVersion
export type AstRuleVersion = typeof AstRuleVersion.Type

export const HARNESS_GATE_RULE_VERSION: GateRuleVersion = GateRuleVersion.make("ast-gates-v2")

export const AstSourceFilePath = Schema.NonEmptyString.pipe(Schema.brand("AstSourceFilePath"))
export type AstSourceFilePath = typeof AstSourceFilePath.Type

export const ContentSha256 = Schema.NonEmptyString.pipe(Schema.brand("ContentSha256"))
export type ContentSha256 = typeof ContentSha256.Type
export const AstContentSha256 = ContentSha256
export type AstContentSha256 = typeof AstContentSha256.Type

export const AstSourceContent = Schema.String.pipe(Schema.brand("AstSourceContent"))
export type AstSourceContent = typeof AstSourceContent.Type

export const GateCategory = Schema.Literals([
  "syntax-bans",
  "test-integrity",
  "migration-safety",
  "domain-purity",
  "effect-laws",
]).pipe(Schema.brand("GateCategory"))
export type GateCategory = typeof GateCategory.Type
export const AstGateCategory = GateCategory
export type AstGateCategory = typeof AstGateCategory.Type
export const GateViolationCategory = GateCategory
export type GateViolationCategory = typeof GateViolationCategory.Type

export const GateRuleId = Schema.NonEmptyString.pipe(Schema.brand("GateRuleId"))
export type GateRuleId = typeof GateRuleId.Type

export const GateViolationMessage = Schema.NonEmptyString.pipe(Schema.brand("GateViolationMessage"))
export type GateViolationMessage = typeof GateViolationMessage.Type

export const SourceLineNumber = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("SourceLineNumber"),
)
export type SourceLineNumber = typeof SourceLineNumber.Type

export const EnclosingSymbolName = Schema.NonEmptyString.pipe(Schema.brand("EnclosingSymbolName"))
export type EnclosingSymbolName = typeof EnclosingSymbolName.Type

export const GateVerdict = Schema.Literals(["clean", "violated"]).pipe(Schema.brand("GateVerdict"))
export type GateVerdict = typeof GateVerdict.Type

export const AstGatePackageTag = Schema.Literals([
  "contract",
  "domain",
  "service",
  "infra",
  "app",
  "test",
]).pipe(Schema.brand("AstGatePackageTag"))
export type AstGatePackageTag = typeof AstGatePackageTag.Type

export const GateViolation = Schema.Struct({
  category: GateCategory,
  rule: GateRuleId,
  message: GateViolationMessage,
  file: AstSourceFilePath,
  line: SourceLineNumber,
  enclosingSymbol: EnclosingSymbolName,
})
export type GateViolation = typeof GateViolation.Type

export const AstGateFileInput = Schema.Struct({
  filePath: AstSourceFilePath,
  content: AstSourceContent,
  packageTag: Schema.optional(AstGatePackageTag),
})
export type AstGateFileInput = typeof AstGateFileInput.Type

export const AstGateEvaluationInput = Schema.Struct({
  files: Schema.Array(AstGateFileInput),
  ruleVersion: Schema.optional(GateRuleVersion),
  cacheFilePath: Schema.optional(AstSourceFilePath),
})
export type AstGateEvaluationInput = typeof AstGateEvaluationInput.Type

export const AstGateCacheEntry = Schema.Struct({
  filePath: AstSourceFilePath,
  contentSha256: ContentSha256,
  ruleVersion: GateRuleVersion,
  packageTag: Schema.optional(AstGatePackageTag),
  violations: Schema.Array(GateViolation),
})
export type AstGateCacheEntry = typeof AstGateCacheEntry.Type
export const AstGateFileEntry = AstGateCacheEntry
export type AstGateFileEntry = typeof AstGateFileEntry.Type

export const AstGateCacheStoreSchema = Schema.Struct({
  version: GateRuleVersion,
  entries: Schema.Record(Schema.String, AstGateCacheEntry),
})
export type AstGateCacheStore = typeof AstGateCacheStoreSchema.Type

export const AstGateDecisionReport = Schema.Struct({
  verdict: GateVerdict,
  violations: Schema.Array(GateViolation),
  cacheHitCount: NonNegativeCount,
  parsedFileCount: NonNegativeCount,
})
export type AstGateDecisionReport = typeof AstGateDecisionReport.Type
export const AstCategoryGateReport = AstGateDecisionReport
export type AstCategoryGateReport = typeof AstCategoryGateReport.Type

export const AstCacheHitCount = NonNegativeCount
export type AstCacheHitCount = typeof AstCacheHitCount.Type

export const AstCacheDurationMs = NonNegativeCount
export type AstCacheDurationMs = typeof AstCacheDurationMs.Type

const decodeAstGateCacheStore = Schema.decodeOption(Schema.fromJsonString(AstGateCacheStoreSchema))

export const inMemoryGateCache = new Map<string, AstGateCacheEntry>()
export const inMemorySourceFileCache = new Map<
  string,
  { readonly contentSha256: ContentSha256; readonly sourceFile: ts.SourceFile }
>()
const loadedDiskCachePaths = new Set<string>()
let totalSourceFileParses = 0

export const computeContentSha256 = (content: string): ContentSha256 =>
  ContentSha256.make(createHash("sha256").update(content, "utf8").digest("hex"))
export const sha256Hex = computeContentSha256

export const makeAstGateCacheKey = (filePath: string, packageTag: string): string =>
  `${filePath}\0${packageTag}`

export const resolveAstGateCachePath = (repoRoot: string): AstSourceFilePath =>
  AstSourceFilePath.make(join(resolveHarnessStateDir(repoRoot), "cache", "ast-gates-v1.json"))
export const resolveDefaultAstGateCachePath = resolveAstGateCachePath

export const loadAstGateCacheFromDisk = (cacheFilePath: string): void => {
  if (loadedDiskCachePaths.has(cacheFilePath)) {
    return
  }
  loadedDiskCachePaths.add(cacheFilePath)
  if (!existsSync(cacheFilePath)) {
    return
  }
  Effect.runSync(
    Effect.try({
      try: () => {
        const raw = readFileSync(cacheFilePath, "utf8")
        const decoded = decodeAstGateCacheStore(raw)
        match(decoded)
          .with({ _tag: "Some" }, ({ value }) => {
            for (const [, entry] of Object.entries(value.entries)) {
              const pkgTag = entry.packageTag ?? inferPackageTagFromPath(entry.filePath)
              const key = makeAstGateCacheKey(entry.filePath, pkgTag)
              inMemoryGateCache.set(key, entry)
            }
          })
          .with({ _tag: "None" }, () => {
            process.stderr.write(
              `[harness:ast-cache] Warning: failed to parse AST gate cache from ${cacheFilePath}: invalid schema format\n`,
            )
          })
          .exhaustive()
      },
      catch: (err) => {
        process.stderr.write(
          `[harness:ast-cache] Warning: failed to read AST gate cache from ${cacheFilePath}: ${err instanceof Error ? err.message : String(err)}\n`,
        )
      },
    }).pipe(Effect.orElseSucceed(() => undefined)),
  )
}

export const saveAstGateCacheToDisk = (
  cacheFilePath: string,
  ruleVersion: GateRuleVersion = HARNESS_GATE_RULE_VERSION,
): void => {
  const tmpPath = `${cacheFilePath}.${process.pid}.${randomUUID()}.tmp`
  Effect.runSync(
    Effect.try({
      try: () => {
        mkdirSync(dirname(cacheFilePath), { recursive: true })
        const entries: Record<string, AstGateCacheEntry> = {}
        for (const [key, entry] of inMemoryGateCache.entries()) {
          if (entry.ruleVersion === ruleVersion) {
            entries[key] = entry
          }
        }
        const payload: AstGateCacheStore = {
          version: ruleVersion,
          entries,
        }
        writeFileSync(tmpPath, JSON.stringify(payload), "utf8")
        renameSync(tmpPath, cacheFilePath)
      },
      catch: (err) => {
        process.stderr.write(
          `[harness:ast-cache] Warning: failed to persist AST gate cache to ${cacheFilePath}: ${err instanceof Error ? err.message : String(err)}\n`,
        )
      },
    }).pipe(
      Effect.orElseSucceed(() => undefined),
      Effect.ensuring(
        Effect.try({
          try: () => {
            if (existsSync(tmpPath)) {
              unlinkSync(tmpPath)
            }
          },
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined)),
      ),
    ),
  )
}

export const clearAstGateCache = (): void => {
  inMemoryGateCache.clear()
  inMemorySourceFileCache.clear()
  loadedDiskCachePaths.clear()
  totalSourceFileParses = 0
}
export const clearAstGateInMemoryCache = clearAstGateCache

export const getAstGateCacheSize = (): number => inMemoryGateCache.size
export const getAstGateSourceFileParseCount = (): number => totalSourceFileParses
export const MAX_SOURCE_FILE_CACHE_SIZE = 500
export const MAX_GATE_CACHE_SIZE = 1000

export const getOrCreateCachedSourceFile = (
  filePath: string,
  content: string,
  contentSha256?: ContentSha256,
): { readonly sourceFile: ts.SourceFile; readonly freshlyParsed: boolean } => {
  const hash = contentSha256 ?? computeContentSha256(content)
  const existing = inMemorySourceFileCache.get(filePath)
  if (existing !== undefined && existing.contentSha256 === hash) {
    return { sourceFile: existing.sourceFile, freshlyParsed: false }
  }
  totalSourceFileParses += 1
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  if (
    !inMemorySourceFileCache.has(filePath) &&
    inMemorySourceFileCache.size >= MAX_SOURCE_FILE_CACHE_SIZE
  ) {
    const oldestKey = inMemorySourceFileCache.keys().next().value
    if (oldestKey !== undefined) {
      inMemorySourceFileCache.delete(oldestKey)
    }
  }
  inMemorySourceFileCache.set(filePath, { contentSha256: hash, sourceFile })
  return { sourceFile, freshlyParsed: true }
}

export const evaluateAstGateFiles = (
  input: AstGateEvaluationInput,
  categoryFilter?: GateCategory,
): AstGateDecisionReport => {
  const ruleVersion = input.ruleVersion ?? HARNESS_GATE_RULE_VERSION
  if (input.cacheFilePath !== undefined) {
    loadAstGateCacheFromDisk(input.cacheFilePath)
  }

  let cacheHitCount = 0
  let parsedFileCount = 0
  let dirtyCache = false
  const allViolations: Array<GateViolation> = []

  for (const file of input.files) {
    const pkgTag = file.packageTag ?? inferPackageTagFromPath(file.filePath)
    const contentSha256 = computeContentSha256(file.content)
    const cacheKey = makeAstGateCacheKey(file.filePath, pkgTag)
    const cached = inMemoryGateCache.get(cacheKey)

    const isHit =
      cached !== undefined &&
      cached.contentSha256 === contentSha256 &&
      cached.ruleVersion === ruleVersion &&
      (cached.packageTag ?? pkgTag) === pkgTag

    if (isHit) {
      cacheHitCount += 1
      for (const v of cached.violations) {
        if (categoryFilter === undefined || v.category === categoryFilter) {
          allViolations.push(v)
        }
      }
      continue
    }

    const { sourceFile, freshlyParsed } = getOrCreateCachedSourceFile(
      file.filePath,
      file.content,
      contentSha256,
    )
    if (freshlyParsed) {
      parsedFileCount += 1
    }

    const fileViolations = visitSourceFileSinglePass(sourceFile, file.filePath, pkgTag)
    const entry: AstGateCacheEntry = {
      filePath: file.filePath,
      contentSha256,
      ruleVersion,
      packageTag: pkgTag,
      violations: [...fileViolations],
    }
    if (!inMemoryGateCache.has(cacheKey) && inMemoryGateCache.size >= MAX_GATE_CACHE_SIZE) {
      const oldestKey = inMemoryGateCache.keys().next().value
      if (oldestKey !== undefined) {
        inMemoryGateCache.delete(oldestKey)
      }
    }
    inMemoryGateCache.set(cacheKey, entry)
    dirtyCache = true

    for (const v of fileViolations) {
      if (categoryFilter === undefined || v.category === categoryFilter) {
        allViolations.push(v)
      }
    }
  }

  if (dirtyCache && input.cacheFilePath !== undefined) {
    saveAstGateCacheToDisk(input.cacheFilePath, ruleVersion)
  }

  return {
    verdict: allViolations.length === 0 ? GateVerdict.make("clean") : GateVerdict.make("violated"),
    violations: allViolations,
    cacheHitCount: NonNegativeCount.make(cacheHitCount),
    parsedFileCount: NonNegativeCount.make(parsedFileCount),
  }
}

export const decideAstGateCache = Effect.fn("AstGateCache.decide")(function* (
  input: AstGateEvaluationInput,
): Effect.fn.Return<AstGateDecisionReport> {
  return yield* Effect.succeed(evaluateAstGateFiles(input))
})

export const decideSyntaxBansGate = Effect.fn("SyntaxBans.decide")(function* (
  input: AstGateEvaluationInput,
): Effect.fn.Return<AstGateDecisionReport> {
  return yield* Effect.succeed(evaluateAstGateFiles(input, GateCategory.make("syntax-bans")))
})

export const decideTestIntegrityGate = Effect.fn("TestIntegrity.decide")(function* (
  input: AstGateEvaluationInput,
): Effect.fn.Return<AstGateDecisionReport> {
  return yield* Effect.succeed(evaluateAstGateFiles(input, GateCategory.make("test-integrity")))
})

export const decideDomainPurityGate = Effect.fn("DomainPurity.decide")(function* (
  input: AstGateEvaluationInput,
): Effect.fn.Return<AstGateDecisionReport> {
  return yield* Effect.succeed(evaluateAstGateFiles(input, GateCategory.make("domain-purity")))
})

export const decideEffectLawsGate = Effect.fn("EffectLaws.decide")(function* (
  input: AstGateEvaluationInput,
): Effect.fn.Return<AstGateDecisionReport> {
  return yield* Effect.succeed(evaluateAstGateFiles(input, GateCategory.make("effect-laws")))
})

export const AstGateCache = {
  decide: decideAstGateCache,
  evaluateFiles: evaluateAstGateFiles,
  computeContentSha256,
  resolveCachePath: resolveAstGateCachePath,
  loadFromDisk: loadAstGateCacheFromDisk,
  saveToDisk: saveAstGateCacheToDisk,
  clear: clearAstGateCache,
  getCacheSize: getAstGateCacheSize,
  getSourceFileParseCount: getAstGateSourceFileParseCount,
  getOrCreateCachedSourceFile,
} as const

export const SyntaxBans = {
  decide: decideSyntaxBansGate,
} as const

export const TestIntegrity = {
  decide: decideTestIntegrityGate,
} as const

export const DomainPurity = {
  decide: decideDomainPurityGate,
} as const

export const EffectLaws = {
  decide: decideEffectLawsGate,
} as const

export const MigrationSafety = {
  decide: decideMigrationSafety,
} as const

export {
  getLineNumber,
  inferPackageTagFromPath,
  isDummyEffectVoidYield,
  isImpureDomainSpecifier,
  MIGRATOR_KEY_REGEX,
  resolveEnclosingSymbol,
  SCHEMA_CTORS,
  SUSPICIOUS_SQL_DDL_REGEX,
  unwrapAstExpression,
  visitSourceFileSinglePass,
}
