import { match } from "ts-pattern"
import { ts } from "@harness/graph"

export interface EffectPromiseAliases {
  readonly effectNamespaceAliases: Set<string>
  readonly effectModuleAliases: Set<string>
  readonly promiseFnAliases: Set<string>
}

const DEFAULT_EFFECT_PROMISE_ALIASES: EffectPromiseAliases = {
  effectNamespaceAliases: new Set<string>(),
  effectModuleAliases: new Set<string>(["Effect"]),
  promiseFnAliases: new Set<string>(),
}

const unwrapExpr = (expr: ts.Expression): ts.Expression => {
  let curr = expr
  while (
    ts.isParenthesizedExpression(curr) ||
    ts.isAsExpression(curr) ||
    ts.isTypeAssertionExpression(curr) ||
    ts.isNonNullExpression(curr) ||
    ts.isSatisfiesExpression(curr)
  ) {
    curr = curr.expression
  }
  return curr
}

const getStaticMember = (
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (node.argumentExpression === undefined) return undefined
  const arg = unwrapExpr(node.argumentExpression)
  return ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) ? arg.text : undefined
}

const getPropertyNameText = (prop: ts.PropertyName): string | undefined =>
  ts.isIdentifier(prop) || ts.isStringLiteral(prop) || ts.isNoSubstitutionTemplateLiteral(prop)
    ? prop.text
    : undefined

const isEffectNamespaceRef = (expr: ts.Expression, aliases: EffectPromiseAliases): boolean => {
  const u = unwrapExpr(expr)
  return ts.isIdentifier(u) && aliases.effectNamespaceAliases.has(u.text)
}

const isEffectModuleRef = (expr: ts.Expression, aliases: EffectPromiseAliases): boolean => {
  const u = unwrapExpr(expr)
  if (ts.isIdentifier(u) && aliases.effectModuleAliases.has(u.text)) return true
  if (ts.isPropertyAccessExpression(u) || ts.isElementAccessExpression(u)) {
    return getStaticMember(u) === "Effect" && isEffectNamespaceRef(u.expression, aliases)
  }
  return false
}

const isEffectPromiseRef = (expr: ts.Expression, aliases: EffectPromiseAliases): boolean => {
  const u = unwrapExpr(expr)
  if (ts.isIdentifier(u) && aliases.promiseFnAliases.has(u.text)) return true
  if (ts.isPropertyAccessExpression(u) || ts.isElementAccessExpression(u)) {
    return getStaticMember(u) === "promise" && isEffectModuleRef(u.expression, aliases)
  }
  return false
}

const collectBindingElement = (
  el: ts.BindingElement,
  kind: "namespace" | "module",
  aliases: EffectPromiseAliases,
): void => {
  const rawProp = el.propertyName !== undefined ? getPropertyNameText(el.propertyName) : undefined
  const targetName = rawProp ?? (ts.isIdentifier(el.name) ? el.name.text : undefined)
  if (targetName === undefined) return
  match(kind)
    .with("namespace", () => {
      if (targetName !== "Effect") return
      if (ts.isIdentifier(el.name)) {
        aliases.effectModuleAliases.add(el.name.text)
        return
      }
      if (ts.isObjectBindingPattern(el.name)) {
        for (const nested of el.name.elements) collectBindingElement(nested, "module", aliases)
      }
    })
    .with("module", () => {
      if (targetName === "promise" && ts.isIdentifier(el.name)) {
        aliases.promiseFnAliases.add(el.name.text)
      }
    })
    .exhaustive()
}

const collectNamedBindingAlias = (
  clause: ts.ImportClause,
  expectedImportedName: string,
  targetSet: Set<string>,
  namespaceTargetSet: Set<string>,
): void => {
  if (clause.namedBindings === undefined) return
  if (ts.isNamespaceImport(clause.namedBindings)) {
    namespaceTargetSet.add(clause.namedBindings.name.text)
    return
  }
  if (ts.isNamedImports(clause.namedBindings)) {
    for (const el of clause.namedBindings.elements) {
      if (el.isTypeOnly) continue
      const imported = el.propertyName?.text ?? el.name.text
      if (imported === expectedImportedName) targetSet.add(el.name.text)
    }
  }
}

const bindAliasName = (
  name: ts.BindingName,
  directSet: Set<string>,
  bindingKind: "namespace" | "module" | undefined,
  aliases: EffectPromiseAliases,
): void => {
  if (ts.isIdentifier(name)) {
    directSet.add(name.text)
    return
  }
  if (bindingKind !== undefined && ts.isObjectBindingPattern(name)) {
    for (const el of name.elements) collectBindingElement(el, bindingKind, aliases)
  }
}

/**
 * Collects local aliases for `Effect`, `effect` namespaces, and `Effect.promise`
 * so aliased/destructured/subpath calls cannot evade the `unhandled-effect-promise` gate.
 */
export const collectEffectPromiseAliases = (sourceFile: ts.SourceFile): EffectPromiseAliases => {
  const aliases: EffectPromiseAliases = {
    effectNamespaceAliases: new Set<string>(),
    effectModuleAliases: new Set<string>(["Effect"]),
    promiseFnAliases: new Set<string>(),
  }

  for (const stmt of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(stmt) ||
      !ts.isStringLiteral(stmt.moduleSpecifier) ||
      stmt.importClause === undefined ||
      stmt.importClause.isTypeOnly
    ) {
      continue
    }
    const mod = stmt.moduleSpecifier.text
    const clause = stmt.importClause
    if (mod === "effect" || mod === "effect/index" || mod === "effect/index.js") {
      collectNamedBindingAlias(
        clause,
        "Effect",
        aliases.effectModuleAliases,
        aliases.effectNamespaceAliases,
      )
      continue
    }
    if (mod === "effect/Effect" || mod === "effect/Effect.js") {
      if (clause.name !== undefined) {
        aliases.effectModuleAliases.add(clause.name.text)
      }
      collectNamedBindingAlias(
        clause,
        "promise",
        aliases.promiseFnAliases,
        aliases.effectModuleAliases,
      )
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const init = unwrapExpr(node.initializer)
      if (isEffectNamespaceRef(init, aliases)) {
        bindAliasName(node.name, aliases.effectNamespaceAliases, "namespace", aliases)
      }
      if (!isEffectNamespaceRef(init, aliases) && isEffectModuleRef(init, aliases)) {
        bindAliasName(node.name, aliases.effectModuleAliases, "module", aliases)
      }
      if (
        !isEffectNamespaceRef(init, aliases) &&
        !isEffectModuleRef(init, aliases) &&
        isEffectPromiseRef(init, aliases)
      ) {
        bindAliasName(node.name, aliases.promiseFnAliases, undefined, aliases)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return aliases
}

export const isUnhandledEffectPromiseCall = (
  node: ts.CallExpression,
  aliases: EffectPromiseAliases = DEFAULT_EFFECT_PROMISE_ALIASES,
): boolean => {
  if (isEffectPromiseRef(node.expression, aliases)) return true
  const callee = unwrapExpr(node.expression)
  if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    const memberName = getStaticMember(callee)
    if (
      (memberName === "call" || memberName === "apply") &&
      isEffectPromiseRef(callee.expression, aliases)
    ) {
      return true
    }
    const base = unwrapExpr(callee.expression)
    if (
      memberName === "apply" &&
      ts.isIdentifier(base) &&
      base.text === "Reflect" &&
      node.arguments[0] !== undefined &&
      isEffectPromiseRef(node.arguments[0], aliases)
    ) {
      return true
    }
  }
  return false
}
