/**
 * @fileoverview Two-tier mutation cache digests (Tier-1 source closure vs. AST witness test blocks)
 * and prior survivor persistence for `--survivors-only` (`SPEC-0037 REQ-3.1`, `REQ-3.3`).
 */
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type AstSourceFilePath,
  type ContentSha256,
  type MutationCacheStore,
  compareCodeUnits,
  computeContentSha256,
} from "@harness/contract"
import { ts } from "@harness/graph"
import type { SyncHostIo } from "@harness/service/host-io"
import { resolveHarnessStateDir } from "../worktree.js"
import {
  type CodeMutant,
  type MutantSchemaModule,
  compileMutantSchemaModule,
  discoverDomainMutants,
  verifyMutantSchemaSyntax,
} from "./mutant-ast-generator.js"
import {
  type FileMutationClosureDigestResult,
  type MutationContextDigests,
  computeFileMutationClosureDigest,
  validateHarnessCacheFileSafety,
} from "./mutation-cache.js"
import { readSafeText, unwrapOption } from "./mutation-context-digest.js"
import type { DomainFile } from "./mutation-target-discovery.js"

const SURVIVORS_CACHE_FILENAME = "mutation-survivors.json"

const SurvivorsStoreSchema = Schema.fromJsonString(
  Schema.Struct({
    survivorIds: Schema.Array(Schema.String),
  }),
)

const TEST_CALL_NAMES: ReadonlySet<string> = new Set(["it", "test"])
const DESCRIBE_CALL_NAMES: ReadonlySet<string> = new Set(["describe", "suite"])
const UNSAFE_WITNESS_CALLEE_NAMES: ReadonlySet<string> = new Set([
  "beforeEach",
  "afterEach",
  "beforeAll",
  "afterAll",
])
const UNSAFE_WITNESS_PROP_NAMES: ReadonlySet<string> = new Set([
  "only",
  "skip",
  "todo",
  "concurrent",
])
const UNSAFE_VI_METHODS: ReadonlySet<string> = new Set([
  "mock",
  "doMock",
  "unmock",
  "stubGlobal",
  "unstubAllGlobals",
  "spyOn",
])

const getRootCalleeIdentifier = (expr: ts.Expression): string | undefined => {
  let curr: ts.Expression = expr
  while (ts.isPropertyAccessExpression(curr) || ts.isCallExpression(curr)) {
    curr = curr.expression
  }
  return ts.isIdentifier(curr) ? curr.text : undefined
}

const hasUnsafeWitnessConstruct = (node: ts.Node): boolean => {
  let unsafe = false
  const visit = (n: ts.Node): void => {
    if (unsafe) return
    if (ts.isPropertyAccessExpression(n)) {
      if (UNSAFE_WITNESS_PROP_NAMES.has(n.name.text)) {
        unsafe = true
        return
      }
      if (
        ts.isIdentifier(n.expression) &&
        n.expression.text === "vi" &&
        UNSAFE_VI_METHODS.has(n.name.text)
      ) {
        unsafe = true
        return
      }
    }
    if (
      (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
      ts.isIdentifier(n.name) &&
      UNSAFE_WITNESS_PROP_NAMES.has(n.name.text)
    ) {
      unsafe = true
      return
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      if (UNSAFE_WITNESS_CALLEE_NAMES.has(n.expression.text)) {
        unsafe = true
        return
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return unsafe
}

const getBlockKindFromStatement = (
  stmt: ts.Statement,
):
  | {
      readonly kind: "describe" | "test"
      readonly callExpr: ts.CallExpression
      readonly callbackBody: ts.Block
    }
  | undefined => {
  if (!ts.isExpressionStatement(stmt) || !ts.isCallExpression(stmt.expression)) return undefined
  const callExpr = stmt.expression
  const rootName = getRootCalleeIdentifier(callExpr.expression)
  if (rootName === undefined) return undefined
  const kind = DESCRIBE_CALL_NAMES.has(rootName)
    ? ("describe" as const)
    : TEST_CALL_NAMES.has(rootName)
      ? ("test" as const)
      : undefined
  if (kind === undefined) return undefined
  const fnArg = [...callExpr.arguments]
    .reverse()
    .find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a))
  if (
    fnArg === undefined ||
    !(ts.isArrowFunction(fnArg) || ts.isFunctionExpression(fnArg)) ||
    !ts.isBlock(fnArg.body)
  ) {
    return undefined
  }
  return { kind, callExpr, callbackBody: fnArg.body }
}

const collectBlockDigestsFromStatements = (
  sf: ts.SourceFile,
  statements: ReadonlyArray<ts.Statement>,
  digests: Set<ContentSha256>,
  unsafeDigests: Set<ContentSha256>,
): void => {
  const addRawStatementDigest = (stmt: ts.Statement, forceUnsafe: boolean): void => {
    const text = stmt.getText(sf).trim()
    if (text.length > 0) {
      const digest = computeContentSha256(text)
      digests.add(digest)
      if (forceUnsafe || hasUnsafeWitnessConstruct(stmt)) {
        unsafeDigests.add(digest)
      }
    }
  }
  for (const stmt of statements) {
    match(getBlockKindFromStatement(stmt))
      .with({ kind: "describe" }, ({ callExpr, callbackBody }) => {
        const nonChildStatements: Array<string> = []
        const childBlocks: Array<ts.Statement> = []
        for (const inner of callbackBody.statements) {
          if (getBlockKindFromStatement(inner) !== undefined) {
            childBlocks.push(inner)
          } else {
            nonChildStatements.push(inner.getText(sf).trim())
          }
        }
        const headerText = callExpr.arguments
          .filter((a) => !ts.isArrowFunction(a) && !ts.isFunctionExpression(a))
          .map((a) => a.getText(sf).trim())
          .join(",")
        const describeDigest = computeContentSha256(
          `describe:${headerText}\0${nonChildStatements.join("\n")}`,
        )
        digests.add(describeDigest)
        if (nonChildStatements.length > 0 || hasUnsafeWitnessConstruct(callExpr.expression)) {
          unsafeDigests.add(describeDigest)
        }
        collectBlockDigestsFromStatements(sf, childBlocks, digests, unsafeDigests)
      })
      .with({ kind: "test" }, ({ callExpr }) => {
        addRawStatementDigest(stmt, hasUnsafeWitnessConstruct(callExpr))
      })
      .with(undefined, () => {
        addRawStatementDigest(stmt, true)
      })
      .exhaustive()
  }
}

export interface WitnessTestBlockAnalysis {
  readonly digests: ReadonlyArray<ContentSha256>
  readonly unsafeBlockDigests: ReadonlySet<ContentSha256>
}

/**
 * Analyzes `testSource` into AST statements / `describe` / `it` / `test` block digests
 * alongside the subset of digests representing `.only`/`.skip`/mock/hook/setup blocks (`SPEC-0037 REQ-3.1`).
 */
export const analyzeWitnessTestBlocks = (testSource: string): WitnessTestBlockAnalysis => {
  const sf = ts.createSourceFile("witness.test.ts", testSource, ts.ScriptTarget.Latest, true)
  const digests = new Set<ContentSha256>()
  const unsafeBlockDigests = new Set<ContentSha256>()
  collectBlockDigestsFromStatements(sf, sf.statements, digests, unsafeBlockDigests)
  return {
    digests: [...digests].sort(compareCodeUnits),
    unsafeBlockDigests,
  }
}

/**
 * Computes Tier-1 source-only closure digest by invoking `computeFileMutationClosureDigest`
 * with `allReachingTests: []` (`SPEC-0037 REQ-3.1`).
 */
export const computeSourceOnlyClosureDigest = (input: {
  readonly repoRoot: string
  readonly relFile: string
  readonly digests: MutationContextDigests
  readonly hostIo: SyncHostIo
}): FileMutationClosureDigestResult =>
  computeFileMutationClosureDigest({
    repoRoot: input.repoRoot,
    relFile: input.relFile,
    allReachingTests: [],
    digests: input.digests,
    hostIo: input.hostIo,
  })

/**
 * Parses `testSource` into AST statements / `describe` / `it` / `test` blocks and returns
 * deterministically sorted `ContentSha256` block digests (`SPEC-0037 REQ-3.1`).
 */
export const extractWitnessTestBlockDigests = (testSource: string): ReadonlyArray<ContentSha256> =>
  analyzeWitnessTestBlocks(testSource).digests

/**
 * Computes a deterministic SHA-256 closure digest over all transitive helper, workspace,
 * package-support, and test-support dependencies reachable from `witnessTestFile` while
 * excluding `witnessTestFile`'s own source bytes (`SPEC-0037 REQ-3.1`).
 */
export const computeWitnessSupportClosureDigest = (input: {
  readonly repoRoot: string
  readonly witnessTestFile: AstSourceFilePath
  readonly digests: MutationContextDigests
  readonly hostIo: SyncHostIo
}): ContentSha256 | undefined =>
  match(
    computeFileMutationClosureDigest({
      repoRoot: input.repoRoot,
      relFile: input.witnessTestFile,
      allReachingTests: [],
      digests: input.digests,
      hostIo: input.hostIo,
      excludeEntryRelFileDigest: true,
    }),
  )
    .with({ _tag: "Ok" }, ({ closureDigest }) => closureDigest)
    .with({ _tag: "Disabled" }, () => undefined)
    .exhaustive()

/** Resolves and memoizes Tier-2 witness closure digest for `(relFile, witnessTestFile)`. */
export const resolveMemoizedWitnessClosureDigest = (input: {
  readonly repoRoot: string
  readonly relFile: string
  readonly witnessTestFile: AstSourceFilePath
  readonly digests: MutationContextDigests
  readonly hostIo: SyncHostIo
  readonly witnessClosureMemo?: Map<string, ContentSha256 | null> | undefined
}): ContentSha256 | undefined => {
  const memoKey = `${input.relFile}\0${input.witnessTestFile}`
  if (input.witnessClosureMemo?.has(memoKey) === true) {
    return input.witnessClosureMemo.get(memoKey) ?? undefined
  }
  return match(
    computeFileMutationClosureDigest({
      repoRoot: input.repoRoot,
      relFile: input.relFile,
      allReachingTests: [input.witnessTestFile],
      digests: input.digests,
      hostIo: input.hostIo,
    }),
  )
    .with({ _tag: "Ok" }, ({ closureDigest }) => {
      input.witnessClosureMemo?.set(memoKey, closureDigest)
      return closureDigest
    })
    .with({ _tag: "Disabled" }, ({ reason }) => {
      input.witnessClosureMemo?.set(memoKey, null)
      process.stderr.write(
        `[mutation-check] Warning: Witness closure disabled for '${input.relFile}' (${reason}).\n`,
      )
      return undefined
    })
    .exhaustive()
}

/** Computes witness-closure, Tier-1 source-closure, and witness AST block digests for cache lookup. */
export const prepareTwoTierLookupInputs = (input: {
  readonly repoRoot: string
  readonly relFile: AstSourceFilePath
  readonly candidateKeys: ReadonlyArray<ContentSha256>
  readonly loadedCacheStore: MutationCacheStore
  readonly reachingSet: ReadonlySet<AstSourceFilePath>
  readonly digests: MutationContextDigests
  readonly hostIo: SyncHostIo
  readonly witnessClosureMemo?: Map<string, ContentSha256 | null> | undefined
  readonly sourceClosureMemo?: Map<string, ContentSha256 | null> | undefined
}): {
  readonly witnessClosureDigests: Record<AstSourceFilePath, ContentSha256>
  readonly sourceClosureDigests: Record<AstSourceFilePath, ContentSha256>
  readonly witnessSupportDigests: Record<AstSourceFilePath, ContentSha256>
  readonly witnessTestAstDigests: Record<AstSourceFilePath, ReadonlyArray<ContentSha256>>
} => {
  const distinctWitnessFiles = new Set<AstSourceFilePath>()
  const twoTierEntriesByWitness = new Map<AstSourceFilePath, Array<readonly ContentSha256[]>>()
  let needsSourceClosure = false
  for (const candidateKey of input.candidateKeys) {
    const entry = Object.hasOwn(input.loadedCacheStore.entries, candidateKey)
      ? input.loadedCacheStore.entries[candidateKey]
      : undefined
    if (entry !== undefined && input.reachingSet.has(entry.witnessTestFile)) {
      distinctWitnessFiles.add(entry.witnessTestFile)
      if (entry.twoTierWitness !== undefined) {
        needsSourceClosure = true
        const list = twoTierEntriesByWitness.get(entry.witnessTestFile) ?? []
        list.push(entry.twoTierWitness.witnessTestAstDigests)
        twoTierEntriesByWitness.set(entry.witnessTestFile, list)
      }
    }
  }
  const witnessClosureDigests: Record<AstSourceFilePath, ContentSha256> = {}
  const witnessSupportDigests: Record<AstSourceFilePath, ContentSha256> = {}
  const witnessTestAstDigests: Record<AstSourceFilePath, ReadonlyArray<ContentSha256>> = {}
  for (const witnessTestFile of distinctWitnessFiles) {
    const digest = resolveMemoizedWitnessClosureDigest({
      repoRoot: input.repoRoot,
      relFile: input.relFile,
      witnessTestFile,
      digests: input.digests,
      hostIo: input.hostIo,
      witnessClosureMemo: input.witnessClosureMemo,
    })
    if (digest !== undefined) witnessClosureDigests[witnessTestFile] = digest
    if (needsSourceClosure) {
      const content = unwrapOption(
        readSafeText(join(input.repoRoot, witnessTestFile), input.hostIo),
      )
      if (content !== undefined) {
        const analysis = analyzeWitnessTestBlocks(content)
        const recordedLists = twoTierEntriesByWitness.get(witnessTestFile) ?? []
        const hasUnsafeNewBlock = recordedLists.some((recorded) => {
          const recordedSet = new Set(recorded)
          return analysis.digests.some(
            (d) => !recordedSet.has(d) && analysis.unsafeBlockDigests.has(d),
          )
        })
        if (!hasUnsafeNewBlock) {
          witnessTestAstDigests[witnessTestFile] = analysis.digests
        }
      }
      const supportDigest = computeWitnessSupportClosureDigest({
        repoRoot: input.repoRoot,
        witnessTestFile,
        digests: input.digests,
        hostIo: input.hostIo,
      })
      if (supportDigest !== undefined) witnessSupportDigests[witnessTestFile] = supportDigest
    }
  }
  const sourceClosureDigests: Record<AstSourceFilePath, ContentSha256> = {}
  if (needsSourceClosure) {
    const srcDigest = resolveMemoizedSourceOnlyClosureDigest({
      repoRoot: input.repoRoot,
      relFile: input.relFile,
      digests: input.digests,
      hostIo: input.hostIo,
      sourceClosureMemo: input.sourceClosureMemo,
    })
    if (srcDigest !== undefined) sourceClosureDigests[input.relFile] = srcDigest
  }
  return {
    witnessClosureDigests,
    sourceClosureDigests,
    witnessSupportDigests,
    witnessTestAstDigests,
  }
}

/** Reads target file (or overlay), discovers/filters mutants, and compiles + syntax-verifies the mutant schema module. */
export const readAndCompileTargetMutants = (input: {
  readonly file: DomainFile
  readonly overlaySource: string | undefined
  readonly modifiedLines: ReadonlySet<number> | undefined
  readonly priorSurvivorIds: ReadonlySet<string> | undefined
  readonly hostIo: SyncHostIo
}):
  | { readonly _tag: "Skip" }
  | { readonly _tag: "Abort"; readonly diagnostic: string }
  | {
      readonly _tag: "Ok"
      readonly originalContent: string
      readonly mutants: ReadonlyArray<CodeMutant>
      readonly schemaBundle: MutantSchemaModule
    } => {
  const originalContent = match(
    input.overlaySource !== undefined
      ? Result.succeed(input.overlaySource)
      : Result.try({
          try: () => input.hostIo.readTextSync(input.file.fullPath),
          catch: (err) => (err instanceof Error ? err.message : String(err)),
        }),
  )
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => ({ readErr: failure }))
    .exhaustive()
  if (typeof originalContent !== "string") {
    return {
      _tag: "Abort",
      diagnostic: `[mutation-check] Failed to read source file '${input.file.relFile}': ${originalContent.readErr}`,
    }
  }
  const discovered = discoverDomainMutants(
    input.file.relFile,
    originalContent,
    input.modifiedLines !== undefined && input.modifiedLines.size > 0
      ? { modifiedLines: input.modifiedLines }
      : undefined,
  )
  const mutants =
    input.priorSurvivorIds !== undefined
      ? discovered.filter((m) => input.priorSurvivorIds!.has(m.id))
      : discovered
  if (mutants.length === 0) return { _tag: "Skip" }
  const schemaBundle = compileMutantSchemaModule(input.file.relFile, originalContent, mutants)
  const syntaxErrors = verifyMutantSchemaSyntax(input.file.relFile, schemaBundle.schemaSource)
  if (syntaxErrors.length > 0) {
    return {
      _tag: "Abort",
      diagnostic: `[mutation-check] Compiled mutant schema for '${input.file.relFile}' failed syntax verification: ${syntaxErrors.join("; ")}`,
    }
  }
  return { _tag: "Ok", originalContent, mutants, schemaBundle }
}

/** Computes sorted AST block digests for a repo-relative witness test file on disk. */
export const computeWitnessTestAstDigestsForPath = (
  repoRoot: string,
  witnessTestFile: AstSourceFilePath,
  hostIo: SyncHostIo,
): ReadonlyArray<ContentSha256> | undefined => {
  const content = unwrapOption(readSafeText(join(repoRoot, witnessTestFile), hostIo))
  return content !== undefined ? extractWitnessTestBlockDigests(content) : undefined
}

/** Resolves and memoizes Tier-1 source-only closure digest for `relFile`. */
export const resolveMemoizedSourceOnlyClosureDigest = (input: {
  readonly repoRoot: string
  readonly relFile: string
  readonly digests: MutationContextDigests
  readonly hostIo: SyncHostIo
  readonly sourceClosureMemo?: Map<string, ContentSha256 | null> | undefined
}): ContentSha256 | undefined => {
  if (input.sourceClosureMemo?.has(input.relFile) === true) {
    return input.sourceClosureMemo.get(input.relFile) ?? undefined
  }
  return match(
    computeSourceOnlyClosureDigest({
      repoRoot: input.repoRoot,
      relFile: input.relFile,
      digests: input.digests,
      hostIo: input.hostIo,
    }),
  )
    .with({ _tag: "Ok" }, ({ closureDigest }) => {
      input.sourceClosureMemo?.set(input.relFile, closureDigest)
      return closureDigest
    })
    .with({ _tag: "Disabled" }, () => {
      input.sourceClosureMemo?.set(input.relFile, null)
      return undefined
    })
    .exhaustive()
}

/** Builds a sanitized subprocess environment for mutation test execution. */
export const buildMutationSubprocessEnv = (
  hostIo: SyncHostIo,
  resolvedBackupPath: string,
): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = {
    ...hostIo.getEnv(),
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    HARNESS_ACTIVE_BACKUP_PATH: resolvedBackupPath,
  }
  delete env["HARNESS_ACTIVE_MUTANT_ID"]
  delete env["HARNESS_STATE_DIR"]
  delete env["HARNESS_MUTATE_WARM_ISOLATE"]
  delete env["HARNESS_WARM_ISOLATE"]
  delete env["HARNESS_COVERAGE_OUT_DIR"]
  return env
}

/** Reads previously persisted surviving mutant IDs from `.harness/cache/mutation-survivors.json`. */
export const readLastSurvivorIds = (repoRoot: string, hostIo: SyncHostIo): ReadonlySet<string> => {
  const filePathRes = Result.try(() =>
    join(resolveHarnessStateDir(repoRoot, hostIo.getEnv()), "cache", SURVIVORS_CACHE_FILENAME),
  )
  return match(filePathRes)
    .with({ _tag: "Failure" }, () => new Set<string>())
    .with({ _tag: "Success" }, ({ success: filePath }) => {
      if (validateHarnessCacheFileSafety(repoRoot, filePath, true, hostIo) !== undefined) {
        return new Set<string>()
      }
      return match(Result.try(() => hostIo.readTextSync(filePath)))
        .with({ _tag: "Failure" }, () => new Set<string>())
        .with({ _tag: "Success" }, ({ success: raw }) =>
          match(Schema.decodeExit(SurvivorsStoreSchema)(raw))
            .with({ _tag: "Failure" }, () => new Set<string>())
            .with({ _tag: "Success" }, ({ value }) => new Set<string>(value.survivorIds))
            .exhaustive(),
        )
        .exhaustive()
    })
    .exhaustive()
}

/** Atomically persists surviving mutant IDs to `.harness/cache/mutation-survivors.json`. */
export const writeLastSurvivorIds = (
  repoRoot: string,
  survivorIds: ReadonlyArray<string>,
  hostIo: SyncHostIo,
): void => {
  const pathRes = Result.try(() => {
    const cacheDir = join(resolveHarnessStateDir(repoRoot, hostIo.getEnv()), "cache")
    return { cacheDir, filePath: join(cacheDir, SURVIVORS_CACHE_FILENAME) }
  })
  match(pathRes)
    .with({ _tag: "Failure" }, () => {})
    .with({ _tag: "Success" }, ({ success: { cacheDir, filePath } }) => {
      if (validateHarnessCacheFileSafety(repoRoot, filePath, false, hostIo) !== undefined) {
        return
      }
      void Result.try(() => {
        hostIo.mkdirRecursiveSync(cacheDir)
        if (validateHarnessCacheFileSafety(repoRoot, filePath, false, hostIo) !== undefined) {
          return
        }
        const uniqueSorted = [...new Set(survivorIds)].sort(compareCodeUnits)
        const encoded = Schema.encodeSync(SurvivorsStoreSchema)({ survivorIds: uniqueSorted })
        const tmpPath = join(
          cacheDir,
          `.mutation-survivors.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
        )
        hostIo.writeTextSync(tmpPath, encoded)
        hostIo.renameSync(tmpPath, filePath)
      })
    })
    .exhaustive()
}

/** Prepared per-file target state before package baseline / batch execution. */
export interface PreparedMutationTarget {
  readonly file: DomainFile
  readonly pkgKey: string
  readonly originalContent: string
  readonly schemaSource: string
  readonly mutants: ReadonlyArray<CodeMutant>
  readonly uncachedMutants: ReadonlyArray<CodeMutant>
  readonly mutantKeys: ReadonlyMap<string, ContentSha256>
  readonly primaryTests: ReadonlyArray<string>
  readonly scopedFallbackTests: ReadonlyArray<string>
  readonly packageFallbackTests: ReadonlyArray<string>
  readonly cachedHitIds: ReadonlySet<string>
}

/** Converts a prepared target into a package batch entry. */
export const toQueuedMutationBatchEntry = (
  prep: PreparedMutationTarget,
  baselineVerified: boolean = false,
) => ({
  pkgKey: prep.pkgKey,
  mutantKeys: prep.mutantKeys,
  baselineVerified,
  input: {
    file: prep.file,
    originalContent: prep.originalContent,
    schemaSource: prep.schemaSource,
    mutants: prep.mutants,
    uncachedMutants: prep.uncachedMutants,
    primaryTests: prep.primaryTests,
    scopedFallbackTests: prep.scopedFallbackTests,
    packageFallbackTests: prep.packageFallbackTests,
    fallbackTests: [...prep.scopedFallbackTests, ...prep.packageFallbackTests],
    cachedHitIds: prep.cachedHitIds,
  },
})
