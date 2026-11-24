/**
 * @fileoverview Symbol-aware barrel export/import graph and scoped reverse-import closure for mutation test partitioning.
 */
import { match } from "ts-pattern"
import { compareCodeUnits } from "@harness/contract"
import { ts } from "@harness/graph"

export interface BarrelExportIndex {
  readonly exportsByTarget: ReadonlyMap<string, ReadonlySet<string>>
  readonly wildcardTargets: ReadonlySet<string>
}

export interface BarrelImportUsage {
  readonly importsAllFromBarrel: boolean
  readonly importedNames: ReadonlySet<string>
}

export type PackageImportResolver = (fromRel: string, spec: string) => string | undefined

const addTargetExport = (map: Map<string, Set<string>>, target: string, name: string): void => {
  const set = map.get(target) ?? new Set<string>()
  set.add(name)
  map.set(target, set)
}

const collectReferencedTargets = (
  node: ts.Node,
  localToTargets: ReadonlyMap<string, ReadonlySet<string>>,
  outTargets: Set<string>,
): void => {
  if (ts.isIdentifier(node)) {
    const targets = localToTargets.get(node.text)
    if (targets !== undefined) {
      for (const t of targets) outTargets.add(t)
    }
  }
  ts.forEachChild(node, (child) => {
    collectReferencedTargets(child, localToTargets, outTargets)
  })
}

const collectBindingNames = (name: ts.BindingName, out: Array<string>): void => {
  if (ts.isIdentifier(name)) {
    out.push(name.text)
    return
  }
  for (const elem of name.elements) {
    if (ts.isBindingElement(elem)) collectBindingNames(elem.name, out)
  }
}

const hasModifier = (stmt: ts.Statement, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(stmt) && (ts.getModifiers(stmt)?.some((m) => m.kind === kind) ?? false)

const addLocalTarget = (
  map: Map<string, Set<string>>,
  localName: string,
  target: string,
): boolean => {
  let set = map.get(localName)
  if (set === undefined) {
    set = new Set<string>()
    map.set(localName, set)
  }
  const before = set.size
  set.add(target)
  return set.size > before
}

/** Extracts runtime symbol-to-target and wildcard re-export mappings from a package barrel `src/index.ts`. */
export const extractBarrelExportIndex = (
  barrelRel: string,
  content: string,
  resolveImport: PackageImportResolver,
): BarrelExportIndex => {
  const sf = ts.createSourceFile(barrelRel, content, ts.ScriptTarget.Latest, true)
  const exportsByTarget = new Map<string, Set<string>>()
  const wildcardTargets = new Set<string>()
  const localToTargets = new Map<string, Set<string>>()

  // Pass 1: collect all runtime import bindings and resolve iterative local non-exported wrappers.
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const clause = stmt.importClause
      if (clause === undefined || clause.isTypeOnly) continue
      const targetRel = resolveImport(barrelRel, stmt.moduleSpecifier.text)
      if (targetRel === undefined) continue
      if (clause.name !== undefined) addLocalTarget(localToTargets, clause.name.text, targetRel)
      if (clause.namedBindings !== undefined) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          addLocalTarget(localToTargets, clause.namedBindings.name.text, targetRel)
        } else {
          for (const elem of clause.namedBindings.elements) {
            if (!elem.isTypeOnly) addLocalTarget(localToTargets, elem.name.text, targetRel)
          }
        }
      }
    }
  }

  let changed = true
  while (changed) {
    changed = false
    for (const stmt of sf.statements) {
      if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) continue
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (decl.initializer === undefined) continue
          const refs = new Set<string>()
          collectReferencedTargets(decl.initializer, localToTargets, refs)
          if (refs.size === 0) continue
          const names: Array<string> = []
          collectBindingNames(decl.name, names)
          for (const name of names) {
            for (const targetRel of refs) {
              if (addLocalTarget(localToTargets, name, targetRel)) changed = true
            }
          }
        }
        continue
      }
      if (
        (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) &&
        stmt.name !== undefined
      ) {
        const refs = new Set<string>()
        collectReferencedTargets(stmt, localToTargets, refs)
        for (const targetRel of refs) {
          if (addLocalTarget(localToTargets, stmt.name.text, targetRel)) changed = true
        }
      }
    }
  }

  // Pass 2: extract exports using the complete local-to-target map.
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly) continue
      const modSpec = stmt.moduleSpecifier
      if (modSpec !== undefined && ts.isStringLiteral(modSpec)) {
        const targetRel = resolveImport(barrelRel, modSpec.text)
        if (targetRel === undefined) continue
        if (stmt.exportClause === undefined) {
          wildcardTargets.add(targetRel)
          continue
        }
        if (ts.isNamespaceExport(stmt.exportClause)) {
          addTargetExport(exportsByTarget, targetRel, stmt.exportClause.name.text)
          continue
        }
        for (const elem of stmt.exportClause.elements) {
          if (!elem.isTypeOnly) addTargetExport(exportsByTarget, targetRel, elem.name.text)
        }
        continue
      }
      if (stmt.exportClause !== undefined && ts.isNamedExports(stmt.exportClause)) {
        for (const elem of stmt.exportClause.elements) {
          if (elem.isTypeOnly) continue
          for (const targetRel of localToTargets.get((elem.propertyName ?? elem.name).text) ?? []) {
            addTargetExport(exportsByTarget, targetRel, elem.name.text)
          }
        }
      }
      continue
    }
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      const refs = new Set<string>()
      collectReferencedTargets(stmt.expression, localToTargets, refs)
      for (const targetRel of refs) addTargetExport(exportsByTarget, targetRel, "default")
      continue
    }
    if (!hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) continue
    const isDefault = hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)
    const exportedNames: Array<string> = []
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        collectBindingNames(decl.name, exportedNames)
      }
    }
    if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
      if (stmt.name !== undefined) exportedNames.push(stmt.name.text)
      if (isDefault) exportedNames.push("default")
    }
    if (exportedNames.length === 0) continue
    const refs = new Set<string>()
    collectReferencedTargets(stmt, localToTargets, refs)
    for (const targetRel of refs) {
      for (const name of exportedNames) addTargetExport(exportsByTarget, targetRel, name)
    }
  }
  return { exportsByTarget, wildcardTargets }
}

/** Extracts runtime barrel import usage (named symbols vs wildcard/default/side-effect) for a module. */
export const extractBarrelImportUsage = (
  relPath: string,
  content: string,
  barrelRel: string,
  resolveImport: PackageImportResolver,
): BarrelImportUsage | undefined => {
  const sf = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true)
  let importsAllFromBarrel = false
  const importedNames = new Set<string>()
  let sawRuntimeBarrelRef = false

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      if (resolveImport(relPath, stmt.moduleSpecifier.text) !== barrelRel) continue
      const clause = stmt.importClause
      if (clause === undefined) {
        importsAllFromBarrel = true
        sawRuntimeBarrelRef = true
        continue
      }
      if (clause.isTypeOnly) continue
      sawRuntimeBarrelRef = true
      if (clause.name !== undefined) importsAllFromBarrel = true
      if (clause.namedBindings !== undefined) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          importsAllFromBarrel = true
        } else {
          for (const elem of clause.namedBindings.elements) {
            if (!elem.isTypeOnly) importedNames.add((elem.propertyName ?? elem.name).text)
          }
        }
      }
      continue
    }
    if (
      ts.isExportDeclaration(stmt) &&
      !stmt.isTypeOnly &&
      stmt.moduleSpecifier !== undefined &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      resolveImport(relPath, stmt.moduleSpecifier.text) === barrelRel
    ) {
      sawRuntimeBarrelRef = true
      if (stmt.exportClause === undefined || ts.isNamespaceExport(stmt.exportClause)) {
        importsAllFromBarrel = true
      } else {
        for (const elem of stmt.exportClause.elements) {
          if (!elem.isTypeOnly) importedNames.add((elem.propertyName ?? elem.name).text)
        }
      }
    }
  }

  const visitCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const firstArg = node.arguments[0]
      if (firstArg !== undefined && ts.isStringLiteral(firstArg)) {
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
        const isRequireCall = ts.isIdentifier(node.expression) && node.expression.text === "require"
        if (
          (isDynamicImport || isRequireCall) &&
          resolveImport(relPath, firstArg.text) === barrelRel
        ) {
          sawRuntimeBarrelRef = true
          importsAllFromBarrel = true
        }
      }
    }
    ts.forEachChild(node, visitCalls)
  }
  visitCalls(sf)

  return match(sawRuntimeBarrelRef)
    .with(true, () => ({ importsAllFromBarrel, importedNames }))
    .with(false, () => undefined)
    .exhaustive()
}

const collectClosureUpward = (
  seeds: ReadonlyArray<string>,
  revNoBarrel: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string> => {
  const visited = new Set<string>(seeds)
  const queue = [...seeds].sort(compareCodeUnits)
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const importerRel of revNoBarrel.get(cur) ?? []) {
      if (!visited.has(importerRel)) {
        visited.add(importerRel)
        queue.push(importerRel)
      }
    }
  }
  return visited
}

/**
 * Computes eligible test abs paths in the scoped reverse-import + symbol-aware barrel closure of `targetRelFile`.
 */
export const computeScopedClosureTestAbsPaths = (input: {
  readonly targetRelFile: string
  readonly revNoBarrel: ReadonlyMap<string, ReadonlySet<string>>
  readonly barrelExports: BarrelExportIndex
  readonly barrelImporters: ReadonlyMap<string, BarrelImportUsage>
  readonly eligibleByRel: ReadonlyMap<string, string>
  readonly nonBarrelTests: ReadonlyArray<string>
}): ReadonlySet<string> => {
  const scoped = new Set<string>(input.nonBarrelTests)
  const nonBarrelClosure = collectClosureUpward([input.targetRelFile], input.revNoBarrel)
  const dependentBarrelExports = new Set<string>()
  let matchesWildcard = false
  for (const modRel of nonBarrelClosure) {
    if (input.barrelExports.wildcardTargets.has(modRel)) matchesWildcard = true
    for (const expName of input.barrelExports.exportsByTarget.get(modRel) ?? []) {
      dependentBarrelExports.add(expName)
    }
  }
  if (!matchesWildcard && dependentBarrelExports.size === 0) return scoped

  const matchingBarrelImporters: Array<string> = []
  for (const [importerRel, usage] of input.barrelImporters.entries()) {
    const matchesSymbol = Array.from(usage.importedNames).some((name) =>
      dependentBarrelExports.has(name),
    )
    if (usage.importsAllFromBarrel || matchesWildcard || matchesSymbol) {
      matchingBarrelImporters.push(importerRel)
    }
  }
  if (matchingBarrelImporters.length === 0) return scoped

  const barrelConsumerClosure = collectClosureUpward(matchingBarrelImporters, input.revNoBarrel)
  for (const consumerRel of barrelConsumerClosure) {
    const abs = input.eligibleByRel.get(consumerRel)
    if (abs !== undefined) scoped.add(abs)
  }
  return scoped
}
