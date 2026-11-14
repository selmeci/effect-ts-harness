/**
 * @file ast-cache.ts
 * Content-addressable AST cache and category deciders for Effect-TS Engineering Harness.
 *
 * Implements an in-memory and disk-persisted cache keyed by file path, package tag,
 * and SHA-256 content digest. Avoids redundant AST parses and visits across repetitive
 * gate runs.
 *
 * Exposes Effect.fn deciders for each gate category:
 * - AstGateCache.decide: Full multi-file AST evaluation across all 5 gate categories.
 * - SyntaxBans.decide: Filters report to syntax-bans violations.
 * - TestIntegrity.decide: Filters report to test-integrity violations.
 * - DomainPurity.decide: Filters report to domain-purity violations.
 * - EffectLaws.decide: Filters report to effect-laws violations.
 * - MigrationSafety.decide: Re-exported from migration-check.ts for SQL DDL safety.
 */

import { createHash } from "node:crypto"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import {
  type AstGateEvaluationReport,
  type AstGateFileBatchInput,
  type WorkspaceFsError,
} from "@harness/contract"
import { NonNegativeCount, ts } from "@harness/graph"
import { AstGateCachePort } from "@harness/service"
import { decideMigrationSafety } from "./migration-check.js"
import {
  AstContentSha256,
  AstGateCategory,
  AstGatePackageTag,
  AstRuleVersion,
  AstSourceContent,
  AstSourceFilePath,
  ContentSha256,
  EnclosingSymbolName,
  GateCategory,
  GateRuleId,
  GateRuleVersion,
  GateVerdict,
  GateViolation,
  GateViolationCategory,
  GateViolationMessage,
  HARNESS_GATE_RULE_VERSION,
  SourceLineNumber,
  getLineNumber,
  inferPackageTagFromPath,
  isCatchCauseInterruptsOnlyCall,
  isDummyEffectVoidYield,
  isIgnoredChmodPermissionCall,
  isImpureDomainSpecifier,
  isRepoWideAstRule,
  isSilentCatchDefectCall,
  MIGRATOR_KEY_REGEX,
  resolveEnclosingSymbol,
  SCHEMA_CTORS,
  SUSPICIOUS_SQL_DDL_REGEX,
  unwrapAstExpression,
  visitSourceFileSinglePass,
} from "./plugins/ast-gate-visitors.js"
import { resolveHarnessStateDir } from "./worktree.js"

// Re-export leaf AST gate schemas and contract types defined in ast-gate-visitors
export {
  AstContentSha256,
  AstGateCategory,
  AstGatePackageTag,
  AstRuleVersion,
  AstSourceContent,
  AstSourceFilePath,
  ContentSha256,
  EnclosingSymbolName,
  GateCategory,
  GateRuleId,
  GateRuleVersion,
  GateVerdict,
  GateViolation,
  GateViolationCategory,
  GateViolationMessage,
  HARNESS_GATE_RULE_VERSION,
  SourceLineNumber,
}

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

/**
 * Contract alias for a cached AST evaluation record for a single file.
 */
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

/**
 * Contract alias for the aggregate AST decision report for a gate evaluation run.
 */
export const AstCategoryGateReport = AstGateDecisionReport
export type AstCategoryGateReport = typeof AstCategoryGateReport.Type

export const AstCacheHitCount = NonNegativeCount
export type AstCacheHitCount = typeof AstCacheHitCount.Type

export const AstCacheDurationMs = NonNegativeCount
export type AstCacheDurationMs = typeof AstCacheDurationMs.Type

export const computeContentSha256 = (content: string): ContentSha256 =>
  ContentSha256.make(createHash("sha256").update(content, "utf8").digest("hex"))
export const sha256Hex = computeContentSha256

export const makeAstGateCacheKey = (filePath: string, packageTag: string): string =>
  `${filePath}\0${packageTag}`

export const resolveAstGateCachePath = (repoRoot: string): AstSourceFilePath =>
  AstSourceFilePath.make(join(resolveHarnessStateDir(repoRoot), "cache", "ast-gates-v1.json"))
export const resolveDefaultAstGateCachePath = resolveAstGateCachePath

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

  for (const file of input.files) {
    const pkgTag = file.packageTag ?? inferPackageTagFromPath(file.filePath)
    const contentSha256 = computeContentSha256(file.content)
    const cacheKey = makeAstGateCacheKey(file.filePath, pkgTag)
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

  return {
    verdict: allViolations.length === 0 ? GateVerdict.make("clean") : GateVerdict.make("violated"),
    violations: allViolations,
    cacheHitCount: NonNegativeCount.make(cacheHitCount),
    parsedFileCount: NonNegativeCount.make(parsedFileCount),
  }
}

export const decideAstGateCache = Effect.fn("AstGateCache.decide")(function* (
  input: AstGateEvaluationInput,
  cacheStore?: Map<string, AstGateCacheEntry>,
): Effect.fn.Return<AstGateDecisionReport> {
  return yield* Effect.succeed(evaluateAstGateFiles(input, undefined, cacheStore))
})

export const evaluateCachedAstGates = Effect.fn("AstGateCache.evaluateCached")(function* (
  files: ReadonlyArray<AstGateFileBatchInput>,
): Effect.fn.Return<AstGateEvaluationReport, WorkspaceFsError, AstGateCachePort> {
  const port = yield* AstGateCachePort
  return yield* port.evaluateBatch(files)
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
  resolveCachePath: resolveAstGateCachePath,
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
  isCatchCauseInterruptsOnlyCall,
  isDummyEffectVoidYield,
  isIgnoredChmodPermissionCall,
  isImpureDomainSpecifier,
  isRepoWideAstRule,
  isSilentCatchDefectCall,
  MIGRATOR_KEY_REGEX,
  resolveEnclosingSymbol,
  SCHEMA_CTORS,
  SUSPICIOUS_SQL_DDL_REGEX,
  unwrapAstExpression,
  visitSourceFileSinglePass,
}
