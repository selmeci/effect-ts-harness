/**
 * @file ast-cache.ts
 * Content-addressable AST cache and category deciders for Effect-TS Engineering Harness.
 *
 * Implements an in-memory and disk-persisted cache keyed by file path, package tag,
 * and SHA-256 content digest under `HARNESS_GATE_RULE_VERSION` (`ast-gates-v9`).
 * Avoids redundant AST parses and visits across repetitive gate runs.
 *
 * Exposes Effect.fn deciders for each gate category:
 * - AstGateCache.decide: Full multi-file AST evaluation across all 5 gate categories
 *   (syntax-bans, test-integrity, migration-safety, domain-purity, effect-laws).
 * - SyntaxBans.decide: Filters report to syntax-bans violations.
 * - TestIntegrity.decide: Filters report to test-integrity violations.
 * - DomainPurity.decide: Filters report to domain-purity violations.
 * - EffectLaws.decide: Filters report to effect-laws violations.
 * - MigrationSafety.decide: Re-exported from migration-check.ts for SQL DDL safety.
 */

import { Effect, Schema } from "effect"
import {
  AstGateDecisionReport,
  type AstGateEvaluationError,
  type AstGateEvaluationReport,
  type AstGateFileBatchInput,
  type AstGateFileEvaluator,
  AstGatePackageTag,
  AstSourceContent,
  AstSourceFilePath,
  computeContentSha256,
  ContentSha256,
  GateCategory,
  GateRuleVersion,
  HARNESS_GATE_RULE_VERSION,
  inferAstGatePackageTagFromPath,
  makeAstGateDecisionReport,
  type WorkspaceFsError,
} from "@harness/contract"
import { NonNegativeCount, ts } from "@harness/graph"
import { AstGateCachePort } from "@harness/service"
import { decideMigrationSafety } from "./migration-check.js"
import {
  GateViolation,
  getLineNumber,
  isCatchCauseInterruptsOnlyCall,
  isDummyEffectVoidYield,
  isIgnoredChmodPermissionCall,
  isImpureDomainSpecifier,
  isSilentCatchDefectCall,
  MIGRATOR_KEY_REGEX,
  resolveEnclosingSymbol,
  SCHEMA_CTORS,
  SUSPICIOUS_SQL_DDL_REGEX,
  unwrapAstExpression,
  visitSourceFileSinglePass,
} from "./plugins/ast-gate-visitors.js"

export { AstGateDecisionReport, computeContentSha256, GateViolation, makeAstGateDecisionReport }

export const AstGateFileInput = Schema.Struct({
  filePath: AstSourceFilePath,
  content: AstSourceContent,
  packageTag: Schema.optional(AstGatePackageTag),
})
export type AstGateFileInput = typeof AstGateFileInput.Type

export const AstGateEvaluationInput = Schema.Struct({
  files: Schema.Array(AstGateFileInput),
  ruleVersion: Schema.optional(GateRuleVersion),
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

export const AstGateCacheStoreSchema = Schema.Struct({
  version: GateRuleVersion,
  entries: Schema.Record(Schema.String, AstGateCacheEntry),
})
export type AstGateCacheStore = typeof AstGateCacheStoreSchema.Type

export const AstCacheHitCount = NonNegativeCount
export type AstCacheHitCount = typeof AstCacheHitCount.Type

export const AstCacheDurationMs = NonNegativeCount
export type AstCacheDurationMs = typeof AstCacheDurationMs.Type

export const makeAstGateCacheKey = (
  filePath: string,
  packageTag: string,
  ruleVersion: GateRuleVersion = HARNESS_GATE_RULE_VERSION,
): string => `${filePath}\0${packageTag}\0${ruleVersion}`

export const MAX_SOURCE_FILE_CACHE_SIZE = 500
export const MAX_GATE_CACHE_SIZE = 1000

export type AstSourceFileCache = Map<
  string,
  { readonly contentSha256: ContentSha256; readonly sourceFile: ts.SourceFile }
>

export const getOrCreateCachedSourceFile = (
  filePath: string,
  content: string,
  contentSha256?: ContentSha256,
  localCache?: AstSourceFileCache,
): { readonly sourceFile: ts.SourceFile; readonly freshlyParsed: boolean } => {
  const hash = contentSha256 ?? computeContentSha256(content)
  if (localCache !== undefined) {
    const existing = localCache.get(filePath)
    if (existing !== undefined && existing.contentSha256 === hash) {
      return { sourceFile: existing.sourceFile, freshlyParsed: false }
    }
  }
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  if (localCache !== undefined) {
    if (!localCache.has(filePath) && localCache.size >= MAX_SOURCE_FILE_CACHE_SIZE) {
      const oldestKey = localCache.keys().next().value
      if (oldestKey !== undefined) {
        localCache.delete(oldestKey)
      }
    }
    localCache.set(filePath, { contentSha256: hash, sourceFile })
  }
  return { sourceFile, freshlyParsed: true }
}

export const evaluateAstGateFiles = (
  input: AstGateEvaluationInput,
  categoryFilter?: GateCategory,
  cacheStore?: Map<string, AstGateCacheEntry>,
): AstGateDecisionReport => {
  const ruleVersion = input.ruleVersion ?? HARNESS_GATE_RULE_VERSION
  const gateCache = cacheStore ?? new Map<string, AstGateCacheEntry>()
  const sourceFileCache: AstSourceFileCache = new Map()

  let cacheHitCount = 0
  let parsedFileCount = 0
  const allViolations: Array<GateViolation> = []
  const seenBatchKeys = new Set<string>()

  for (const file of input.files) {
    const pkgTag = file.packageTag ?? inferAstGatePackageTagFromPath(file.filePath)
    const batchKey = `${file.filePath}\0${pkgTag}`
    if (seenBatchKeys.has(batchKey)) {
      continue
    }
    seenBatchKeys.add(batchKey)
    const contentSha256 = computeContentSha256(file.content)
    const cacheKey = makeAstGateCacheKey(file.filePath, pkgTag, ruleVersion)
    const cached = gateCache.get(cacheKey)

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
      sourceFileCache,
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
    if (!gateCache.has(cacheKey) && gateCache.size >= MAX_GATE_CACHE_SIZE) {
      const oldestKey = gateCache.keys().next().value
      if (oldestKey !== undefined) {
        gateCache.delete(oldestKey)
      }
    }
    gateCache.set(cacheKey, entry)

    for (const v of fileViolations) {
      if (categoryFilter === undefined || v.category === categoryFilter) {
        allViolations.push(v)
      }
    }
  }

  return makeAstGateDecisionReport({
    violations: allViolations,
    cacheHitCount: NonNegativeCount.make(cacheHitCount),
    parsedFileCount: NonNegativeCount.make(parsedFileCount),
  })
}

export const evaluateSingleAstGateFile: AstGateFileEvaluator = (file) => {
  const pkgTag = file.packageTag ?? inferAstGatePackageTagFromPath(file.filePath)
  const { sourceFile } = getOrCreateCachedSourceFile(file.filePath, file.content)
  return visitSourceFileSinglePass(sourceFile, file.filePath, pkgTag)
}

export const decideAstGateCache = Effect.fn("AstGateCache.decide")(function* (
  input: AstGateEvaluationInput,
  cacheStore?: Map<string, AstGateCacheEntry>,
): Effect.fn.Return<AstGateDecisionReport> {
  return yield* Effect.succeed(evaluateAstGateFiles(input, undefined, cacheStore))
})

export const evaluateCachedAstGates = Effect.fn("AstGateCache.evaluateCached")(function* (
  files: ReadonlyArray<AstGateFileBatchInput>,
): Effect.fn.Return<
  AstGateEvaluationReport,
  AstGateEvaluationError | WorkspaceFsError,
  AstGateCachePort
> {
  const port = yield* AstGateCachePort
  return yield* port.evaluateBatch(files, evaluateSingleAstGateFile)
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
  evaluateCached: evaluateCachedAstGates,
  evaluateFiles: evaluateAstGateFiles,
  computeContentSha256,
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
  inferAstGatePackageTagFromPath,
  inferAstGatePackageTagFromPath as inferPackageTagFromPath,
  isCatchCauseInterruptsOnlyCall,
  isDummyEffectVoidYield,
  isIgnoredChmodPermissionCall,
  isImpureDomainSpecifier,
  isSilentCatchDefectCall,
  MIGRATOR_KEY_REGEX,
  resolveEnclosingSymbol,
  SCHEMA_CTORS,
  SUSPICIOUS_SQL_DDL_REGEX,
  unwrapAstExpression,
  visitSourceFileSinglePass,
}
