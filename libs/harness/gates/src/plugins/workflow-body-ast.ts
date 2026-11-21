import { ts } from "@harness/graph"
import { match } from "ts-pattern"

/** Single AST violation emitted when non-deterministic APIs run directly inside a workflow body. */
export interface WorkflowBodyViolation {
  readonly message: string
  readonly node: ts.Node
}

type BannedCategory =
  | "wall-clock"
  | "randomness"
  | "environment"
  | "filesystem"
  | "subprocess"
  | "git"
  | "omnigraph"
  | "network"

const FS_MODULES = new Set("node:fs fs node:fs/promises fs/promises".split(" "))
const CHILD_PROCESS_MODULES = new Set("node:child_process child_process".split(" "))
const NETWORK_MODULES = new Set("node:http http node:https https node:net net".split(" "))
const CRYPTO_MODULES = new Set("node:crypto crypto".split(" "))

const CRYPTO_RANDOM_EXPORTS = new Set(
  "randomUUID randomBytes randomInt randomFillSync getRandomValues".split(" "),
)

const OMNIGRAPH_IMPORTS = new Set(
  "OmnigraphClient createOmnigraphClient invokeStoredQuery invokeWorkflowStoreQuery invokeWorkflowStoreQueryWithMeta".split(
    " ",
  ),
)

const FS_DIRECT_CALLEES = new Set(
  "readFileSync writeFileSync appendFileSync mkdirSync rmSync unlinkSync readdirSync statSync existsSync readFile writeFile".split(
    " ",
  ),
)

const SUBPROCESS_DIRECT_CALLEES = new Set(
  "execFileSync spawnSync execSync execFile exec spawn execCheckedSubprocess".split(" "),
)

const NETWORK_MEMBER_CALLS = new Set(
  "http.request http.get https.request https.get net.connect net.createConnection".split(" "),
)

const OMNIGRAPH_METHODS = new Set("invokeQuery runQuery executeQuery".split(" "))

const isTestFilePath = (normalizedPath: string): boolean =>
  normalizedPath.endsWith(".test.ts") ||
  normalizedPath.endsWith(".test.tsx") ||
  normalizedPath.endsWith(".spec.ts") ||
  normalizedPath.endsWith(".spec.tsx") ||
  /(?:^|\/)test\/(?!fixtures\/)/.test(normalizedPath)

const unwrapExpr = (expr: ts.Expression): ts.Expression => {
  let curr = expr
  while (
    ts.isParenthesizedExpression(curr) ||
    ts.isAsExpression(curr) ||
    ts.isTypeAssertionExpression(curr) ||
    ts.isSatisfiesExpression(curr) ||
    ts.isNonNullExpression(curr)
  ) {
    curr = curr.expression
  }
  return curr
}

const extractStaticKey = (expr: ts.Expression): string | undefined => {
  const u = unwrapExpr(expr)
  if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) {
    return u.text
  }
  return undefined
}

const getMemberParts = (
  expr: ts.Expression,
): { readonly receiver: ts.Expression; readonly name: string } | undefined => {
  const u = unwrapExpr(expr)
  if (ts.isPropertyAccessExpression(u)) {
    return { receiver: unwrapExpr(u.expression), name: u.name.text }
  }
  if (ts.isElementAccessExpression(u)) {
    const key = extractStaticKey(u.argumentExpression)
    if (key !== undefined) {
      return { receiver: unwrapExpr(u.expression), name: key }
    }
  }
  return undefined
}

const getQualifiedRootedName = (expr: ts.Expression): string | undefined => {
  const u = unwrapExpr(expr)
  if (ts.isIdentifier(u)) return u.text
  const member = getMemberParts(u)
  if (member === undefined) return undefined
  if (ts.isIdentifier(member.receiver)) {
    return member.receiver.text === "globalThis"
      ? member.name
      : `${member.receiver.text}.${member.name}`
  }
  const outer = getMemberParts(member.receiver)
  if (
    outer !== undefined &&
    ts.isIdentifier(outer.receiver) &&
    outer.receiver.text === "globalThis"
  ) {
    return `${outer.name}.${member.name}`
  }
  return undefined
}

const getObjectPropName = (prop: ts.ObjectLiteralElementLike): string | undefined => {
  if (
    !ts.isPropertyAssignment(prop) &&
    !ts.isMethodDeclaration(prop) &&
    !ts.isShorthandPropertyAssignment(prop)
  ) {
    return undefined
  }
  const name = prop.name
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text
  }
  return undefined
}

interface WorkflowAnalysisContext {
  readonly workflowAliases: Set<string>
  readonly workflowMakeAliases: Set<string>
  readonly activityAliases: Set<string>
  readonly activityMakeAliases: Set<string>
  readonly workflowEngineAliases: Set<string>
  readonly effectAliases: Set<string>
  readonly bannedBindings: Map<string, BannedCategory>
  readonly cryptoNamespaceAliases: Set<string>
  readonly fsNamespaceAliases: Set<string>
  readonly childProcessNamespaceAliases: Set<string>
  readonly networkNamespaceAliases: Set<string>
}

const createAnalysisContext = (sourceFile: ts.SourceFile): WorkflowAnalysisContext => {
  const ctx: WorkflowAnalysisContext = {
    workflowAliases: new Set(["Workflow"]),
    workflowMakeAliases: new Set(),
    activityAliases: new Set(["Activity"]),
    activityMakeAliases: new Set(),
    workflowEngineAliases: new Set(["WorkflowEngine"]),
    effectAliases: new Set(["Effect"]),
    bannedBindings: new Map(),
    cryptoNamespaceAliases: new Set(["crypto"]),
    fsNamespaceAliases: new Set(),
    childProcessNamespaceAliases: new Set(),
    networkNamespaceAliases: new Set(),
  }

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || stmt.importClause?.isTypeOnly) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const spec = stmt.moduleSpecifier.text
    const clause = stmt.importClause
    if (clause === undefined) continue

    const recordBinding = (localName: string, importedName?: string): void => {
      if (spec === "effect/workflow") {
        if (importedName === "Workflow") ctx.workflowAliases.add(localName)
        if (importedName === "Activity") ctx.activityAliases.add(localName)
        if (importedName === "WorkflowEngine") ctx.workflowEngineAliases.add(localName)
      }
      if (spec === "effect/workflow/Workflow") {
        if (importedName === "make") ctx.workflowMakeAliases.add(localName)
        if (importedName === undefined) ctx.workflowAliases.add(localName)
      }
      if (spec === "effect/workflow/Activity") {
        if (importedName === "make") ctx.activityMakeAliases.add(localName)
        if (importedName === undefined) ctx.activityAliases.add(localName)
      }
      if (
        (spec === "effect" && importedName === "Effect") ||
        (spec === "effect/Effect" && importedName === undefined)
      ) {
        ctx.effectAliases.add(localName)
      }
      if (FS_MODULES.has(spec)) {
        if (importedName === undefined) ctx.fsNamespaceAliases.add(localName)
        ctx.bannedBindings.set(localName, "filesystem")
        return
      }
      if (CHILD_PROCESS_MODULES.has(spec)) {
        if (importedName === undefined) ctx.childProcessNamespaceAliases.add(localName)
        ctx.bannedBindings.set(localName, "subprocess")
        return
      }
      if (NETWORK_MODULES.has(spec)) {
        if (importedName === undefined) ctx.networkNamespaceAliases.add(localName)
        ctx.bannedBindings.set(localName, "network")
        return
      }
      if (CRYPTO_MODULES.has(spec)) {
        if (importedName === undefined) ctx.cryptoNamespaceAliases.add(localName)
        if (importedName !== undefined && CRYPTO_RANDOM_EXPORTS.has(importedName)) {
          ctx.bannedBindings.set(localName, "randomness")
        }
      }
      if (importedName !== undefined && OMNIGRAPH_IMPORTS.has(importedName)) {
        ctx.bannedBindings.set(localName, "omnigraph")
      }
    }

    if (clause.name !== undefined) recordBinding(clause.name.text, undefined)
    const bindings = clause.namedBindings
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      recordBinding(bindings.name.text, undefined)
    }
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if (el.isTypeOnly) continue
        recordBinding(el.name.text, (el.propertyName ?? el.name).text)
      }
    }
  }

  return ctx
}

const isWorkflowMakeCall = (node: ts.CallExpression, ctx: WorkflowAnalysisContext): boolean => {
  const callee = unwrapExpr(node.expression)
  if (ts.isIdentifier(callee)) return ctx.workflowMakeAliases.has(callee.text)
  const member = getMemberParts(callee)
  return (
    member !== undefined &&
    member.name === "make" &&
    ts.isIdentifier(member.receiver) &&
    ctx.workflowAliases.has(member.receiver.text)
  )
}

const isActivityMakeCall = (node: ts.CallExpression, ctx: WorkflowAnalysisContext): boolean => {
  const callee = unwrapExpr(node.expression)
  if (ts.isIdentifier(callee)) return ctx.activityMakeAliases.has(callee.text)
  const member = getMemberParts(callee)
  return (
    member !== undefined &&
    member.name === "make" &&
    ts.isIdentifier(member.receiver) &&
    ctx.activityAliases.has(member.receiver.text)
  )
}

const isWorkflowReceiverExpr = (
  expr: ts.Expression,
  ctx: WorkflowAnalysisContext,
  declaredWorkflowVars: ReadonlySet<string>,
): boolean => {
  const u = unwrapExpr(expr)
  if (ts.isIdentifier(u)) return declaredWorkflowVars.has(u.text)
  if (ts.isCallExpression(u)) return isWorkflowMakeCall(u, ctx)
  return false
}

const isWorkflowToLayerOrRegisterCall = (
  node: ts.CallExpression,
  ctx: WorkflowAnalysisContext,
  declaredWorkflowVars: ReadonlySet<string>,
): boolean => {
  const member = getMemberParts(node.expression)
  if (member === undefined) return false
  if (member.name === "toLayer" && node.arguments.length >= 1) {
    return isWorkflowReceiverExpr(member.receiver, ctx, declaredWorkflowVars)
  }
  return (
    member.name === "register" &&
    ts.isIdentifier(member.receiver) &&
    ctx.workflowEngineAliases.has(member.receiver.text) &&
    node.arguments.length >= 2
  )
}

const unwrapEffectFnImpl = (expr: ts.Expression, ctx: WorkflowAnalysisContext): ts.Expression => {
  const u = unwrapExpr(expr)
  if (!ts.isCallExpression(u) || u.arguments.length === 0) return u
  const callee = unwrapExpr(u.expression)
  const member = getMemberParts(callee)
  if (
    member !== undefined &&
    member.name === "fnUntraced" &&
    ts.isIdentifier(member.receiver) &&
    ctx.effectAliases.has(member.receiver.text) &&
    u.arguments[0] !== undefined
  ) {
    return unwrapExpr(u.arguments[0])
  }
  if (ts.isCallExpression(callee)) {
    const innerMember = getMemberParts(callee.expression)
    if (
      innerMember !== undefined &&
      innerMember.name === "fn" &&
      ts.isIdentifier(innerMember.receiver) &&
      ctx.effectAliases.has(innerMember.receiver.text) &&
      u.arguments[0] !== undefined
    ) {
      return unwrapExpr(u.arguments[0])
    }
  }
  return u
}

interface LocalFnInfo {
  readonly body: ts.Node
  readonly isExported: boolean
  readonly topLevelStmt: ts.Statement | undefined
}

const hasExportModifier = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)

const collectLocalFunctions = (
  sourceFile: ts.SourceFile,
  ctx: WorkflowAnalysisContext,
): ReadonlyMap<string, LocalFnInfo> => {
  const fns = new Map<string, LocalFnInfo>()
  const topStmts = new Set<ts.Node>(sourceFile.statements)
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
      fns.set(node.name.text, {
        body: node.body,
        isExported: hasExportModifier(node),
        topLevelStmt: topStmts.has(node) ? node : undefined,
      })
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const impl = unwrapEffectFnImpl(node.initializer, ctx)
      if (ts.isArrowFunction(impl) || ts.isFunctionExpression(impl)) {
        const varStmt = node.parent?.parent
        const isTopVarStmt =
          varStmt !== undefined && topStmts.has(varStmt) && ts.isVariableStatement(varStmt)
        fns.set(node.name.text, {
          body: impl.body,
          isExported: varStmt !== undefined && hasExportModifier(varStmt),
          topLevelStmt:
            isTopVarStmt && varStmt.declarationList.declarations.length === 1 ? varStmt : undefined,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return fns
}

const isProcessRootExpr = (expr: ts.Expression): boolean => {
  const u = unwrapExpr(expr)
  if (ts.isIdentifier(u) && u.text === "process") return true
  const member = getMemberParts(u)
  return (
    member !== undefined &&
    member.name === "process" &&
    ts.isIdentifier(member.receiver) &&
    member.receiver.text === "globalThis"
  )
}

const isProcessEnvAccess = (node: ts.Node): boolean => {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false
  const member = getMemberParts(node)
  return member !== undefined && member.name === "env" && isProcessRootExpr(member.receiver)
}

const isProcessEnvDestructuring = (node: ts.Node): boolean => {
  if (
    !ts.isVariableDeclaration(node) ||
    !ts.isObjectBindingPattern(node.name) ||
    node.initializer === undefined ||
    !isProcessRootExpr(node.initializer)
  ) {
    return false
  }
  return node.name.elements.some((el) => {
    const prop = el.propertyName ?? el.name
    return ts.isIdentifier(prop) && prop.text === "env"
  })
}

const isIdentifierInValuePosition = (id: ts.Identifier): boolean => {
  const p = id.parent
  if (p === undefined) return false
  if (ts.isShorthandPropertyAssignment(p)) return true
  if (
    (ts.isPropertyAccessExpression(p) && p.name === id) ||
    (ts.isPropertyAssignment(p) && p.name === id) ||
    (ts.isVariableDeclaration(p) && p.name === id) ||
    (ts.isParameter(p) && p.name === id) ||
    (ts.isFunctionDeclaration(p) && p.name === id) ||
    ts.isImportSpecifier(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p) ||
    ts.isTypeNode(p) ||
    ts.isTypeReferenceNode(p) ||
    ts.isQualifiedName(p)
  ) {
    return false
  }
  return true
}

const isGitExecCall = (node: ts.CallExpression): boolean => {
  const callee = unwrapExpr(node.expression)
  const name = ts.isIdentifier(callee) ? callee.text : getMemberParts(callee)?.name
  if (name !== undefined && (/^(?:exec|run|spawn)Git/i.test(name) || /^gitExec/i.test(name))) {
    return true
  }
  return (
    name !== undefined &&
    SUBPROCESS_DIRECT_CALLEES.has(name) &&
    node.arguments[0] !== undefined &&
    extractStaticKey(node.arguments[0]) === "git"
  )
}

const collectActivityOnlyLocalFunctions = (
  sourceFile: ts.SourceFile,
  localFunctions: ReadonlyMap<string, LocalFnInfo>,
  ctx: WorkflowAnalysisContext,
): ReadonlySet<string> => {
  const safeDirectRefs = new Set<string>()
  const unsafeDirectRefs = new Set<string>()
  const fnBodyRefs = new Map<string, Set<string>>()
  const fnBodyBodies = new Map<ts.Node, string>()
  for (const [name, info] of localFunctions) {
    fnBodyBodies.set(info.body, name)
    fnBodyRefs.set(name, new Set())
    if (info.isExported) unsafeDirectRefs.add(name)
  }

  const visit = (node: ts.Node, inSafeZone: boolean, enclosingFn: string | undefined): void => {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node)) return
    const nextEnclosing = fnBodyBodies.get(node) ?? enclosingFn
    if (ts.isExportAssignment(node) && ts.isIdentifier(unwrapExpr(node.expression))) {
      const id = unwrapExpr(node.expression) as ts.Identifier
      if (localFunctions.has(id.text)) unsafeDirectRefs.add(id.text)
    }
    if (ts.isExportSpecifier(node)) {
      const local = (node.propertyName ?? node.name).text
      if (localFunctions.has(local)) unsafeDirectRefs.add(local)
    }
    if (
      ts.isIdentifier(node) &&
      isIdentifierInValuePosition(node) &&
      localFunctions.has(node.text)
    ) {
      if (inSafeZone) {
        safeDirectRefs.add(node.text)
      } else {
        if (nextEnclosing !== undefined) fnBodyRefs.get(nextEnclosing)?.add(node.text)
        else unsafeDirectRefs.add(node.text)
      }
    }
    if (ts.isCallExpression(node)) {
      if (isActivityMakeCall(node, ctx) && node.arguments[0] !== undefined) {
        const unwrapped = unwrapExpr(node.arguments[0])
        if (ts.isObjectLiteralExpression(unwrapped)) {
          for (const prop of unwrapped.properties) {
            visit(prop, inSafeZone || getObjectPropName(prop) === "execute", nextEnclosing)
          }
          return
        }
      }
      const cm = getMemberParts(node.expression)
      if (cm?.name === "addFinalizer") {
        ts.forEachChild(node, (c) => visit(c, true, nextEnclosing))
        return
      }
      if (cm?.name === "withCompensation" && node.arguments.length >= 2) {
        node.arguments.forEach((arg, idx) =>
          visit(arg, idx === 1 ? true : inSafeZone, nextEnclosing),
        )
        visit(node.expression, inSafeZone, nextEnclosing)
        return
      }
    }
    ts.forEachChild(node, (child) => visit(child, inSafeZone, nextEnclosing))
  }
  visit(sourceFile, false, undefined)

  const expandReachable = (seeds: ReadonlySet<string>): Set<string> => {
    const out = new Set(seeds)
    const queue = [...seeds]
    while (queue.length > 0) {
      const curr = queue.pop()!
      for (const callee of fnBodyRefs.get(curr) ?? []) {
        if (!out.has(callee)) {
          out.add(callee)
          queue.push(callee)
        }
      }
    }
    return out
  }

  const safeReachable = expandReachable(safeDirectRefs)
  const unsafeReachable = expandReachable(unsafeDirectRefs)
  const activityOnly = new Set<string>()
  for (const name of safeReachable) {
    if (!unsafeReachable.has(name)) activityOnly.add(name)
  }
  return activityOnly
}

const formatViolationMessage = (label: string, category: BannedCategory): string =>
  `[nondeterministic-workflow-body] Nondeterministic ${category} access '${label}' inside workflow body outside Activity.make({ execute: ... }) — move side effects, wall-clock reads, randomness, env, fs, git, Omnigraph, and network calls into Activity.make handlers.`

/**
 * Inspects TypeScript files declaring `Workflow.make(...)` and collects non-deterministic
 * side effects or wall-clock/env/randomness/IO calls executing outside `Activity.make` handlers.
 */
export const collectWorkflowBodyViolations = (
  sourceFile: ts.SourceFile,
  normalizedFilePath: string,
): ReadonlyArray<WorkflowBodyViolation> => {
  if (isTestFilePath(normalizedFilePath)) return []

  const ctx = createAnalysisContext(sourceFile)
  const workflowMakeCalls: Array<ts.CallExpression> = []
  const declaredWorkflowVars = new Set<string>()

  const discoverWorkflowDecls = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isWorkflowMakeCall(node, ctx)) {
      workflowMakeCalls.push(node)
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const init = unwrapExpr(node.initializer)
      if (ts.isCallExpression(init) && isWorkflowMakeCall(init, ctx)) {
        declaredWorkflowVars.add(node.name.text)
      }
    }
    if (
      ts.isClassDeclaration(node) &&
      node.name !== undefined &&
      node.heritageClauses !== undefined
    ) {
      const isWfSubclass = node.heritageClauses.some(
        (hc) =>
          hc.token === ts.SyntaxKind.ExtendsKeyword &&
          hc.types.some((t) => isWorkflowReceiverExpr(t.expression, ctx, declaredWorkflowVars)),
      )
      if (isWfSubclass) declaredWorkflowVars.add(node.name.text)
    }
    ts.forEachChild(node, discoverWorkflowDecls)
  }
  discoverWorkflowDecls(sourceFile)

  if (workflowMakeCalls.length === 0) return []

  const layerOrRegisterCalls: Array<ts.CallExpression> = []
  const discoverRegistrations = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      isWorkflowToLayerOrRegisterCall(node, ctx, declaredWorkflowVars)
    ) {
      layerOrRegisterCalls.push(node)
    }
    ts.forEachChild(node, discoverRegistrations)
  }
  discoverRegistrations(sourceFile)

  const localFunctions = collectLocalFunctions(sourceFile, ctx)
  const violations: Array<WorkflowBodyViolation> = []
  const reportedNodes = new WeakSet<ts.Node>()
  const visitedFunctions = new Set<string>()

  const report = (node: ts.Node, label: string, category: BannedCategory): void => {
    if (reportedNodes.has(node)) return
    reportedNodes.add(node)
    violations.push({ node, message: formatViolationMessage(label, category) })
  }

  const reportCtorName = (
    node: ts.Node,
    ctorName: string | undefined,
    prefix: string,
    suffix: string,
  ): void => {
    match(ctorName)
      .with("Date", () => report(node, `${prefix}Date${suffix}`, "wall-clock"))
      .with("OmnigraphClient", () => report(node, `${prefix}OmnigraphClient${suffix}`, "omnigraph"))
      .with("WebSocket", () => report(node, `${prefix}WebSocket${suffix}`, "network"))
      .otherwise(() => {})
  }

  const walk = (node: ts.Node): void => {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node)) return
    if (isProcessEnvAccess(node)) return report(node, "process.env", "environment")
    if (isProcessEnvDestructuring(node)) report(node, "process.env", "environment")
    if (ts.isNewExpression(node)) {
      reportCtorName(node, getQualifiedRootedName(node.expression), "new ", "()")
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const qname = getQualifiedRootedName(node)
      if (qname === "Date.now" || qname === "Date.parse" || qname === "Date.UTC")
        return report(node, qname, "wall-clock")
      if (qname === "Math.random") return report(node, qname, "randomness")
      if (qname?.startsWith("crypto.") && CRYPTO_RANDOM_EXPORTS.has(qname.slice(7)))
        return report(node, qname, "randomness")
      const member = getMemberParts(node)
      if (member !== undefined && ts.isIdentifier(member.receiver)) {
        const r = member.receiver.text
        const cat: BannedCategory | undefined =
          ctx.cryptoNamespaceAliases.has(r) && CRYPTO_RANDOM_EXPORTS.has(member.name)
            ? "randomness"
            : ctx.fsNamespaceAliases.has(r)
              ? "filesystem"
              : ctx.childProcessNamespaceAliases.has(r)
                ? "subprocess"
                : ctx.networkNamespaceAliases.has(r)
                  ? "network"
                  : undefined
        if (cat !== undefined) return report(node, `${r}.${member.name}`, cat)
      }
    }

    if (ts.isCallExpression(node)) {
      if (isActivityMakeCall(node, ctx) && node.arguments[0] !== undefined) {
        const u = unwrapExpr(node.arguments[0])
        if (ts.isObjectLiteralExpression(u)) {
          for (const prop of u.properties) {
            if (getObjectPropName(prop) !== "execute") walk(prop)
          }
          return
        }
      }

      const calleeMember = getMemberParts(node.expression)
      if (calleeMember?.name === "addFinalizer") return
      if (
        layerOrRegisterCalls.length === 0 &&
        calleeMember?.name === "toLayer" &&
        !isWorkflowToLayerOrRegisterCall(node, ctx, declaredWorkflowVars)
      ) {
        return
      }
      if (calleeMember?.name === "withCompensation") {
        if (node.arguments.length >= 2 && node.arguments[0] !== undefined) walk(node.arguments[0])
        return
      }

      const qname = getQualifiedRootedName(node.expression)
      const [a0, a1] = node.arguments
      const reportCall = (): void => {
        if (qname === "Date") return report(node, "Date()", "wall-clock")
        if (
          qname === "Reflect.get" &&
          a0 &&
          a1 &&
          isProcessRootExpr(a0) &&
          extractStaticKey(a1) === "env"
        )
          return report(node, 'Reflect.get(process, "env")', "environment")
        if (qname === "Reflect.construct" && a0)
          return reportCtorName(node, getQualifiedRootedName(a0), "", " (Reflect.construct)")
        if (qname === "fetch") return report(node, "fetch()", "network")
        if (qname !== undefined && NETWORK_MEMBER_CALLS.has(qname))
          return report(node, `${qname}()`, "network")
        if (qname !== undefined && FS_DIRECT_CALLEES.has(qname))
          return report(node, `${qname}()`, "filesystem")
        if (isGitExecCall(node)) return report(node, node.expression.getText(sourceFile), "git")
        if (qname !== undefined && SUBPROCESS_DIRECT_CALLEES.has(qname))
          return report(node, `${qname}()`, "subprocess")
        const isOgRecv =
          calleeMember !== undefined &&
          ts.isIdentifier(calleeMember.receiver) &&
          /omnigraph/i.test(calleeMember.receiver.text)
        if (calleeMember !== undefined && (OMNIGRAPH_METHODS.has(calleeMember.name) || isOgRecv))
          report(node, `${calleeMember.name}()`, "omnigraph")
      }
      reportCall()

      const unwrappedCallee = unwrapExpr(node.expression)
      if (ts.isIdentifier(unwrappedCallee)) {
        const localInfo = localFunctions.get(unwrappedCallee.text)
        if (localInfo !== undefined && !visitedFunctions.has(unwrappedCallee.text)) {
          visitedFunctions.add(unwrappedCallee.text)
          walk(localInfo.body)
        }
      }
    }

    if (ts.isIdentifier(node) && isIdentifierInValuePosition(node)) {
      const bannedCat = ctx.bannedBindings.get(node.text)
      if (bannedCat !== undefined) return report(node, node.text, bannedCat)
      const localInfo = localFunctions.get(node.text)
      if (localInfo !== undefined && !visitedFunctions.has(node.text)) {
        visitedFunctions.add(node.text)
        walk(localInfo.body)
      }
    }

    ts.forEachChild(node, walk)
  }

  for (const wfCall of workflowMakeCalls) {
    if (wfCall.arguments[1] !== undefined) walk(wfCall.arguments[1])
  }
  for (const regCall of layerOrRegisterCalls) {
    const member = getMemberParts(regCall.expression)
    const handler = member?.name === "register" ? regCall.arguments[1] : regCall.arguments[0]
    if (handler !== undefined) walk(handler)
  }
  if (layerOrRegisterCalls.length === 0) {
    const activityOnlyFns = collectActivityOnlyLocalFunctions(sourceFile, localFunctions, ctx)
    const skippedTopStmts = new Set<ts.Statement>()
    for (const fnName of activityOnlyFns) {
      const stmt = localFunctions.get(fnName)?.topLevelStmt
      if (stmt !== undefined) skippedTopStmts.add(stmt)
    }
    for (const stmt of sourceFile.statements) {
      if (!ts.isImportDeclaration(stmt) && !skippedTopStmts.has(stmt)) walk(stmt)
    }
  }

  return violations
}
