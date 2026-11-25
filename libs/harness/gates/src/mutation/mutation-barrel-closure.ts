/**
 * @fileoverview Symbol-aware barrel closure pruning and safe file verification helpers.
 */
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Option, Result } from "effect"
import { match } from "ts-pattern"
import { type ContentSha256, compareCodeUnits, computeContentSha256 } from "@harness/contract"
import { ts } from "@harness/graph"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  type BarrelExportIndex,
  type PackageImportResolver,
  extractBarrelExportIndex,
  extractBarrelImportUsage,
} from "./mutation-barrel-reachability.js"

const BARREL_FILE_PATH_RE = /(?:^|\/)src\/index\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/

/** Returns `true` when `relPath` points to a package barrel (`src/index.*`). */
export const isBarrelFilePath = (relPath: string): boolean => BARREL_FILE_PATH_RE.test(relPath)

/**
 * Returns `true` only when every top-level statement in `barrelRel` is a pure export declaration,
 * a type-only import declaration, a runtime named import whose every binding is re-exported by a
 * runtime local `ExportDeclaration` in the same barrel (and mapped by `exportIndex` when provided),
 * an interface/type-alias declaration, or an empty statement.
 */
export const isPureReExportBarrel = (
  barrelRel: string,
  content: string,
  exportIndex?: BarrelExportIndex,
): boolean => {
  const sf = ts.createSourceFile(barrelRel, content, ts.ScriptTarget.Latest, true)
  const localRuntimeReExports = new Map<string, Array<string>>()
  for (const stmt of sf.statements) {
    if (
      ts.isExportDeclaration(stmt) &&
      !stmt.isTypeOnly &&
      stmt.moduleSpecifier === undefined &&
      stmt.exportClause !== undefined &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      for (const elem of stmt.exportClause.elements) {
        if (elem.isTypeOnly) continue
        const localName = (elem.propertyName ?? elem.name).text
        let exportedNames = localRuntimeReExports.get(localName)
        if (exportedNames === undefined) {
          exportedNames = []
          localRuntimeReExports.set(localName, exportedNames)
        }
        exportedNames.push(elem.name.text)
      }
    }
  }

  let mappedExportNames: Set<string> | undefined = undefined
  if (exportIndex !== undefined) {
    mappedExportNames = new Set<string>()
    for (const exportedSet of exportIndex.exportsByTarget.values()) {
      for (const name of exportedSet) mappedExportNames.add(name)
    }
  }

  for (const stmt of sf.statements) {
    if (ts.isEmptyStatement(stmt)) continue
    if (ts.isExportDeclaration(stmt)) continue
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) continue
    if (ts.isImportDeclaration(stmt)) {
      const clause = stmt.importClause
      if (clause === undefined) return false
      if (clause.isTypeOnly) continue
      if (
        clause.name !== undefined ||
        clause.namedBindings === undefined ||
        !ts.isNamedImports(clause.namedBindings) ||
        clause.namedBindings.elements.length === 0
      ) {
        return false
      }
      const runtimeBindings = clause.namedBindings.elements
        .filter((elem) => !elem.isTypeOnly)
        .map((elem) => elem.name.text)
      if (runtimeBindings.length === 0) return false
      for (const localName of runtimeBindings) {
        const exportedNames = localRuntimeReExports.get(localName)
        if (exportedNames === undefined || exportedNames.length === 0) return false
        if (
          mappedExportNames !== undefined &&
          !exportedNames.every((expName) => mappedExportNames.has(expName))
        ) {
          return false
        }
      }
      continue
    }
    return false
  }
  return true
}

export interface ResolveBarrelClosureStepInput {
  readonly importerRel: string
  readonly importerContent: string
  readonly barrelRel: string
  readonly barrelContent: string
  readonly resolveImport: PackageImportResolver
  readonly barrelExportIndex?: BarrelExportIndex | undefined
  readonly isPureBarrel?: boolean | undefined
}

export type BarrelClosureStepResult =
  | { readonly _tag: "FullBarrel" }
  | {
      readonly _tag: "Pruned"
      readonly targetFiles: ReadonlyArray<string>
      readonly bindingDigest: ContentSha256
      readonly isPureBarrel: boolean
    }

const buildReverseBarrelExportMap = (
  index: BarrelExportIndex,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const nameToTargets = new Map<string, Set<string>>()
  for (const [targetRel, exportedNames] of index.exportsByTarget.entries()) {
    for (const name of exportedNames) {
      let targets = nameToTargets.get(name)
      if (targets === undefined) {
        targets = new Set<string>()
        nameToTargets.set(name, targets)
      }
      targets.add(targetRel)
    }
  }
  return nameToTargets
}

/**
 * Resolves a single importer -> barrel edge into either a `Pruned` symbol-scoped target set
 * or a fail-closed `FullBarrel` fallback.
 */
export const resolveBarrelClosureStep = (
  input: ResolveBarrelClosureStepInput,
): BarrelClosureStepResult => {
  const usage = extractBarrelImportUsage(
    input.importerRel,
    input.importerContent,
    input.barrelRel,
    input.resolveImport,
  )
  if (usage === undefined || usage.importsAllFromBarrel || usage.importedNames.size === 0) {
    return { _tag: "FullBarrel" }
  }

  const index =
    input.barrelExportIndex ??
    extractBarrelExportIndex(input.barrelRel, input.barrelContent, input.resolveImport)
  const nameToTargets = buildReverseBarrelExportMap(index)

  const targetSet = new Set<string>()
  const bindingPairs: Array<string> = []
  const sortedSymbols = Array.from(usage.importedNames).sort(compareCodeUnits)

  for (const sym of sortedSymbols) {
    const targets = nameToTargets.get(sym)
    if (targets === undefined || targets.size === 0) {
      return { _tag: "FullBarrel" }
    }
    const sortedTargets = Array.from(targets).sort(compareCodeUnits)
    for (const targetRel of sortedTargets) {
      targetSet.add(targetRel)
    }
    bindingPairs.push(`${sym}->${sortedTargets.join(",")}`)
  }

  const isPureBarrel =
    input.isPureBarrel ?? isPureReExportBarrel(input.barrelRel, input.barrelContent, index)
  return {
    _tag: "Pruned",
    targetFiles: Array.from(targetSet).sort(compareCodeUnits),
    bindingDigest: computeContentSha256(JSON.stringify(bindingPairs)),
    isPureBarrel,
  }
}

export const unwrapResult = <A>(res: Result.Result<A, unknown>): Option.Option<A> =>
  match(res)
    .with({ _tag: "Success" }, ({ success }) => Option.some(success))
    .with({ _tag: "Failure" }, () => Option.none())
    .exhaustive()

export const unwrapOption = <A>(opt: Option.Option<A>): A | undefined =>
  match(opt)
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()

export const isNonSymlink = (targetPath: string, hostIo: SyncHostIo): boolean =>
  match(unwrapResult(Result.try(() => hostIo.isSymbolicLinkSync(targetPath))))
    .with({ _tag: "Some" }, ({ value }) => !value)
    .with({ _tag: "None" }, () => false)
    .exhaustive()

export const readSafeText = (filePath: string, hostIo: SyncHostIo): Option.Option<string> =>
  isNonSymlink(filePath, hostIo)
    ? unwrapResult(Result.try(() => hostIo.readTextSync(filePath)))
    : Option.none()

export const checkExists = (targetPath: string, hostIo: SyncHostIo): boolean | undefined =>
  unwrapOption(unwrapResult(Result.try(() => hostIo.existsSync(targetPath))))

export const realpathOrUndefined = (targetPath: string, hostIo: SyncHostIo): string | undefined =>
  unwrapOption(unwrapResult(Result.try(() => hostIo.realpathSync(targetPath))))

export const isPathContained = (parentReal: string, childReal: string): boolean => {
  const rel = relative(parentReal, childReal)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

export const verifyClosurePathSafe = (
  repoRoot: string,
  repoReal: string,
  fullPath: string,
  hostIo: SyncHostIo,
): string | undefined => {
  const resolvedRoot = resolve(repoRoot)
  let cur = resolve(fullPath)
  while (true) {
    if (!isNonSymlink(cur, hostIo)) {
      return `symlink or unreadable path '${cur}'`
    }
    if (cur === resolvedRoot || cur === dirname(cur)) break
    cur = dirname(cur)
  }
  const targetReal = realpathOrUndefined(fullPath, hostIo)
  if (targetReal === undefined || !isPathContained(repoReal, targetReal)) {
    return `realpath escape detected for '${fullPath}'`
  }
  return undefined
}

export interface CachedBarrelMeta {
  readonly content: string
  readonly fileSha: ContentSha256
  readonly exportIndex: BarrelExportIndex
  readonly isPureBarrel: boolean
}

/**
 * Loads and memoizes a barrel's export index and purity flag in `barrelMetaCache` keyed by
 * `(fullBarrelPath, fileDigest)` so repeated traversals within a closure avoid re-parsing `src/index.ts`.
 */
export const loadCachedBarrelMeta = (input: {
  readonly barrelMetaCache: Map<string, CachedBarrelMeta>
  readonly barrelRel: string
  readonly fullBarrelPath: string
  readonly knownFileDigest: ContentSha256 | undefined
  readonly hostIo: SyncHostIo
  readonly resolveImport: PackageImportResolver
  readonly getDisabledReason: () => string | undefined
}):
  | { readonly _tag: "Ok"; readonly meta: CachedBarrelMeta }
  | { readonly _tag: "Disabled"; readonly reason: string } => {
  const cacheKey = input.fullBarrelPath
  const cached = input.barrelMetaCache.get(cacheKey)
  if (
    cached !== undefined &&
    input.knownFileDigest !== undefined &&
    cached.fileSha === input.knownFileDigest
  ) {
    return { _tag: "Ok", meta: cached }
  }

  const content = unwrapOption(readSafeText(input.fullBarrelPath, input.hostIo))
  if (content === undefined) {
    return { _tag: "Disabled", reason: `unreadable file '${input.fullBarrelPath}'` }
  }
  const fileSha = input.knownFileDigest ?? computeContentSha256(content)
  if (cached !== undefined && cached.fileSha === fileSha) {
    return { _tag: "Ok", meta: cached }
  }

  const exportIndex = extractBarrelExportIndex(input.barrelRel, content, input.resolveImport)
  const disabledReason = input.getDisabledReason()
  if (disabledReason !== undefined) {
    return { _tag: "Disabled", reason: disabledReason }
  }
  const isPureBarrel = isPureReExportBarrel(input.barrelRel, content, exportIndex)
  const meta: CachedBarrelMeta = { content, fileSha, exportIndex, isPureBarrel }
  input.barrelMetaCache.set(cacheKey, meta)
  return { _tag: "Ok", meta }
}

export interface BarrelTraversalState {
  readonly fullBarrels: Set<string>
  readonly verifiedBarrels: Set<string>
  readonly prunedBarrelBindings: Map<string, Set<string>>
  readonly visited: Set<string>
  readonly barrelMetaCache: Map<string, CachedBarrelMeta>
}

const promoteBarrelToFull = (
  barrelRel: string,
  state: BarrelTraversalState,
  enqueue: (relPath: string) => void,
): void => {
  state.fullBarrels.add(barrelRel)
  state.prunedBarrelBindings.delete(barrelRel)
  enqueue(barrelRel)
}

/**
 * Evaluates a discovered barrel dependency edge (`importerRel -> barrelRel`) during closure BFS,
 * updating `state` and enqueuing either pruned target files or the full barrel fail-closed.
 */
export const applyBarrelImportEdge = (input: {
  readonly repoRoot: string
  readonly repoReal: string
  readonly importerRel: string
  readonly importerContent: string
  readonly importerHasNonLiteralDynamicImport: boolean
  readonly barrelRel: string
  readonly knownFileDigest: ContentSha256 | undefined
  readonly hostIo: SyncHostIo
  readonly resolveImport: PackageImportResolver
  readonly getDisabledReason: () => string | undefined
  readonly state: BarrelTraversalState
  readonly enqueue: (relPath: string) => void
}): string | undefined => {
  const { barrelRel, state, enqueue } = input
  if (state.fullBarrels.has(barrelRel) || state.visited.has(barrelRel)) {
    enqueue(barrelRel)
    return undefined
  }
  if (input.importerHasNonLiteralDynamicImport) {
    promoteBarrelToFull(barrelRel, state, enqueue)
    return undefined
  }
  const fullBarrelPath = join(input.repoRoot, barrelRel)
  if (!state.verifiedBarrels.has(barrelRel)) {
    const pathErr = verifyClosurePathSafe(
      input.repoRoot,
      input.repoReal,
      fullBarrelPath,
      input.hostIo,
    )
    if (pathErr !== undefined) return pathErr
    state.verifiedBarrels.add(barrelRel)
  }
  return match(
    loadCachedBarrelMeta({
      barrelMetaCache: state.barrelMetaCache,
      barrelRel,
      fullBarrelPath,
      knownFileDigest: input.knownFileDigest,
      hostIo: input.hostIo,
      resolveImport: input.resolveImport,
      getDisabledReason: input.getDisabledReason,
    }),
  )
    .with({ _tag: "Disabled" }, ({ reason }) => reason)
    .with({ _tag: "Ok" }, ({ meta }) => {
      const step = resolveBarrelClosureStep({
        importerRel: input.importerRel,
        importerContent: input.importerContent,
        barrelRel,
        barrelContent: meta.content,
        resolveImport: input.resolveImport,
        barrelExportIndex: meta.exportIndex,
        isPureBarrel: meta.isPureBarrel,
      })
      match(step)
        .with({ _tag: "FullBarrel" }, () => {
          promoteBarrelToFull(barrelRel, state, enqueue)
        })
        .with({ _tag: "Pruned" }, ({ targetFiles, bindingDigest, isPureBarrel }) => {
          if (!isPureBarrel) {
            promoteBarrelToFull(barrelRel, state, enqueue)
            return
          }
          for (const targetRel of targetFiles) {
            if (isBarrelFilePath(targetRel)) promoteBarrelToFull(targetRel, state, enqueue)
            else enqueue(targetRel)
          }
          let bindings = state.prunedBarrelBindings.get(barrelRel)
          if (bindings === undefined) {
            bindings = new Set<string>()
            state.prunedBarrelBindings.set(barrelRel, bindings)
          }
          bindings.add(bindingDigest)
        })
        .exhaustive()
      return undefined
    })
    .exhaustive()
}
