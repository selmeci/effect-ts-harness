import { Result } from "effect"
import { ts } from "@harness/graph"
import { getStaticMemberName, unwrapExpr } from "./ast-gate-law-helpers.js"

export interface Wave3AstViolation {
  readonly rule: string
  readonly message: string
  readonly node: ts.Node
}

export const isTestOrHelperPath = (normPath: string): boolean =>
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normPath) || /(?:^|\/)test\/(?!fixtures\/)/.test(normPath)

export interface NamespaceAliasSet {
  readonly canonicalName: string
  readonly direct: ReadonlySet<string>
  readonly effectRoots: ReadonlySet<string>
  readonly directMethods: ReadonlyMap<string, string>
}

type Ns = NamespaceAliasSet
type MemExpr = { readonly obj: ts.Expression; readonly name: string }

export const EFFECT_MODULE_SPECS = new Set(["effect", "effect/Effect"])
const OPTION_MODULE_SPECS = new Set(["effect", "effect/Option"])
const SCHEMA_MODULE_SPECS = new Set(["effect", "effect/Schema"])
const LOG_METHOD_RE = /^log(?:Debug|Info|Warning|Error|Fatal|Trace)?$/
const SILENT_PRIMITIVES = new Set(["[]", '""', "''", "{}", "undefined", "null", "false", "void 0"])
const BANNED_WORKFLOW_TAGS = new Set(["WorkflowStoreUnavailableError", "WriterLeaseHeldError"])
const REF_RANGE_GIT_SUBCMDS = new Set(
  "diff rev-parse merge-base log show cat-file checkout branch tag worktree ls-files reset rev-list".split(
    " ",
  ),
)
const GIT_TWO_TOKEN_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree"])
const GIT_EXEC_CALLEES = new Set(
  "spawnSync execFile execFileSync execFileAsync execFileAsyncEffect".split(" "),
)

export const getStaticStr = (expr: ts.Expression): string | undefined => {
  const u = unwrapExpr(expr)
  return ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u) ? u.text : undefined
}

const getPropName = (n: ts.PropertyName): string | undefined =>
  ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
    ? n.text
    : undefined

const asMem = (expr: ts.Expression): MemExpr | undefined => {
  const u = unwrapExpr(expr)
  if (!ts.isPropertyAccessExpression(u) && !ts.isElementAccessExpression(u)) return undefined
  const name = getStaticMemberName(u)
  return name !== undefined ? { obj: u.expression, name } : undefined
}
export const asMemberExpr = asMem

export const findAstMatch = (
  root: ts.Node,
  pred: (n: ts.Node) => boolean,
  stopFn = false,
): boolean => {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found || (stopFn && n !== root && ts.isFunctionLike(n))) return
    if (pred(n)) {
      found = true
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(root)
  return found
}

const matchesRoot = (expr: ts.Expression, a: Ns): boolean => {
  const u = unwrapExpr(expr)
  if (ts.isIdentifier(u)) return a.direct.has(u.text)
  const mem = asMem(u)
  return (
    mem !== undefined &&
    ts.isIdentifier(mem.obj) &&
    a.effectRoots.has(mem.obj.text) &&
    mem.name === a.canonicalName
  )
}

export const collectNamespaceAliases = (
  sf: ts.SourceFile | undefined,
  canonicalName: string,
  specs: ReadonlySet<string>,
): Ns => {
  const direct = new Set<string>([canonicalName])
  const effectRoots = new Set<string>()
  const directMethods = new Map<string, string>()
  const out: Ns = { canonicalName, direct, effectRoots, directMethods }
  if (sf === undefined) return out
  const subpathSpec = `effect/${canonicalName}`
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || stmt.importClause?.isTypeOnly) continue
    const mod = ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : ""
    const nb = stmt.importClause?.namedBindings
    if (!specs.has(mod) || nb === undefined) continue
    if (ts.isNamespaceImport(nb)) {
      if (mod === "effect") effectRoots.add(nb.name.text)
      else direct.add(nb.name.text)
      continue
    }
    if (ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        if (el.isTypeOnly) continue
        const imp = (el.propertyName ?? el.name).text
        if (imp === canonicalName) direct.add(el.name.text)
        if (imp !== canonicalName && mod === subpathSpec) directMethods.set(el.name.text, imp)
      }
    }
  }
  const visitLocal = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer !== undefined) {
      const init = unwrapExpr(n.initializer)
      if (ts.isIdentifier(n.name)) {
        if (matchesRoot(init, out)) direct.add(n.name.text)
        else {
          const mem = asMem(init)
          if (mem !== undefined && matchesRoot(mem.obj, out))
            directMethods.set(n.name.text, mem.name)
        }
      }
      if (ts.isObjectBindingPattern(n.name)) {
        const isRoot = matchesRoot(init, out)
        const isEffMod = ts.isIdentifier(init) && effectRoots.has(init.text)
        for (const el of n.name.elements) {
          if (!ts.isIdentifier(el.name)) continue
          const prop =
            el.propertyName !== undefined && ts.isPropertyName(el.propertyName)
              ? (getPropName(el.propertyName) ?? el.name.text)
              : el.name.text
          if (isRoot) directMethods.set(el.name.text, prop)
          if (!isRoot && isEffMod && prop === canonicalName) direct.add(el.name.text)
        }
      }
    }
    ts.forEachChild(n, visitLocal)
  }
  visitLocal(sf)
  visitLocal(sf)
  return out
}

const mayCallMethod = (
  call: ts.CallExpression,
  sf: ts.SourceFile | undefined,
  targets: ReadonlyArray<string>,
): boolean => {
  const mem = asMem(call.expression)
  if (mem !== undefined) return targets.includes(mem.name)
  const u = unwrapExpr(call.expression)
  return ts.isIdentifier(u) && sf !== undefined && targets.some((t) => sf.text.includes(t))
}

export const getNamespaceMemberName = (expr: ts.Expression, aliases: Ns): string | undefined => {
  const u = unwrapExpr(expr)
  if (ts.isIdentifier(u)) return aliases.directMethods.get(u.text)
  const mem = asMem(u)
  return mem !== undefined && matchesRoot(mem.obj, aliases) ? mem.name : undefined
}

export const getNamespaceCallMethodName = (c: ts.CallExpression, a: Ns): string | undefined =>
  getNamespaceMemberName(c.expression, a)
export const isNamespacePropertyExpr = (e: ts.Expression, a: Ns, prop: string): boolean =>
  getNamespaceMemberName(e, a) === prop
export const isEffectMethodCall = (c: ts.CallExpression, m: string, a: Ns): boolean =>
  getNamespaceMemberName(c.expression, a) === m
const isNsCall = (c: ts.CallExpression, a: Ns, m: string): boolean =>
  getNamespaceMemberName(c.expression, a) === m

/** Flags `Effect.catchCause(...)` handlers in production `src/` lacking `isPureInterruptCause(...)` call. */
export const isUntypedCatchCauseWithoutInterruptGuard = (
  node: ts.CallExpression,
  sf?: ts.SourceFile,
): boolean => {
  const resolvedSf = sf ?? Result.getOrUndefined(Result.try(() => node.getSourceFile()))
  if (!mayCallMethod(node, resolvedSf, ["catchCause"])) return false
  const eff = collectNamespaceAliases(resolvedSf, "Effect", EFFECT_MODULE_SPECS)
  if (!isEffectMethodCall(node, "catchCause", eff)) return false
  const cb = node.arguments.length >= 2 ? node.arguments[1] : node.arguments[0]
  return (
    cb === undefined ||
    !findAstMatch(unwrapExpr(cb), (n) => {
      if (!ts.isCallExpression(n)) return false
      const c = unwrapExpr(n.expression)
      return (
        (ts.isIdentifier(c) && c.text === "isPureInterruptCause") ||
        (ts.isPropertyAccessExpression(c) && c.name.text === "isPureInterruptCause")
      )
    })
  )
}

const isSchemaDecodeOptionCallExpr = (expr: ts.Expression, schema: Ns): boolean => {
  const u = unwrapExpr(expr)
  if (!ts.isCallExpression(u)) return false
  const hit = (c: ts.CallExpression) =>
    isNsCall(c, schema, "decodeOption") || isNsCall(c, schema, "decodeUnknownOption")
  if (hit(u)) return true
  const inner = unwrapExpr(u.expression)
  return ts.isCallExpression(inner) && hit(inner)
}

export const unwrapPipeCall = (
  call: ts.CallExpression,
): { readonly subject: ts.Expression; readonly ops: ReadonlyArray<ts.Expression> } | undefined => {
  const c = unwrapExpr(call.expression)
  if (ts.isPropertyAccessExpression(c) && c.name.text === "pipe")
    return { subject: c.expression, ops: call.arguments }
  if (
    ts.isIdentifier(c) &&
    c.text === "pipe" &&
    call.arguments.length >= 2 &&
    call.arguments[0] !== undefined
  ) {
    return { subject: call.arguments[0], ops: call.arguments.slice(1) }
  }
  return undefined
}

const isDecodeOrUnwrappedOptionExpr = (expr: ts.Expression, opt: Ns, schema: Ns): boolean => {
  if (isSchemaDecodeOptionCallExpr(expr, schema)) return true
  const u = unwrapExpr(expr)
  if (!ts.isCallExpression(u)) return false
  if (
    (isNsCall(u, opt, "getOrUndefined") || isNsCall(u, opt, "getOrNull")) &&
    u.arguments[0] !== undefined
  ) {
    return isDecodeOrUnwrappedOptionExpr(u.arguments[0], opt, schema)
  }
  const piped = unwrapPipeCall(u)
  const isUnwrap = (a: ts.Expression) =>
    isNamespacePropertyExpr(a, opt, "getOrUndefined") ||
    isNamespacePropertyExpr(a, opt, "getOrNull")
  return piped !== undefined && piped.ops.some(isUnwrap)
    ? isDecodeOrUnwrappedOptionExpr(piped.subject, opt, schema)
    : false
}

const isSilentValueExpr = (expr: ts.Expression, sf: ts.SourceFile, opt: Ns): boolean => {
  const arg = unwrapExpr(expr)
  if (
    SILENT_PRIMITIVES.has(arg.getText(sf).trim()) ||
    (ts.isIdentifier(arg) && arg.text === "undefined")
  )
    return true
  return ts.isCallExpression(arg) && isNsCall(arg, opt, "none")
}

export const hasFailOrDieEffect = (root: ts.Node, eff: Ns): boolean =>
  findAstMatch(
    root,
    (n) =>
      ts.isCallExpression(n) &&
      (isEffectMethodCall(n, "fail", eff) ||
        isEffectMethodCall(n, "failCause", eff) ||
        isEffectMethodCall(n, "die", eff)),
  )

export const collectDirectReturns = (
  fn: ts.FunctionLikeDeclaration,
): ReadonlyArray<ts.Expression> => {
  if (fn.body === undefined || !ts.isBlock(fn.body)) return []
  const out: Array<ts.Expression> = []
  const collect = (n: ts.Node): void => {
    if (n !== fn && ts.isFunctionLike(n)) return
    if (ts.isReturnStatement(n) && n.expression !== undefined) out.push(n.expression)
    ts.forEachChild(n, collect)
  }
  collect(fn.body)
  return out
}

export const isPureLoggingOrTelemetryCall = (
  call: ts.CallExpression,
  sf: ts.SourceFile,
  eff: Ns,
): boolean => {
  const c = unwrapExpr(call.expression)
  const m = getNamespaceMemberName(c, eff)
  if (m !== undefined && LOG_METHOD_RE.test(m)) return true
  if (ts.isIdentifier(c)) return c.text.startsWith("recordTelemetry")
  const mem = asMem(c)
  return mem !== undefined && c.getText(sf) === "process.stderr.write"
}

const isSilentSuccessEffectExpr = (
  expr: ts.Expression,
  sf: ts.SourceFile,
  eff: Ns,
  opt: Ns,
): boolean => {
  const u = unwrapExpr(expr)
  if (
    isNamespacePropertyExpr(u, eff, "void") ||
    (ts.isCallExpression(u) && isPureLoggingOrTelemetryCall(u, sf, eff))
  )
    return true
  if (!ts.isCallExpression(u)) return false
  if (isEffectMethodCall(u, "succeed", eff) && u.arguments[0] !== undefined)
    return isSilentValueExpr(u.arguments[0], sf, opt)
  const fn = u.arguments[0] !== undefined ? unwrapExpr(u.arguments[0]) : undefined
  if (
    fn === undefined ||
    (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) ||
    hasFailOrDieEffect(fn, eff)
  )
    return false
  if (isEffectMethodCall(u, "sync", eff)) {
    return !ts.isBlock(fn.body)
      ? isSilentValueExpr(fn.body, sf, opt)
      : collectDirectReturns(fn).every((e) => isSilentValueExpr(e, sf, opt))
  }
  if (isEffectMethodCall(u, "gen", eff)) {
    const rets = collectDirectReturns(fn)
    if (rets.length === 0) {
      return (
        fn.body !== undefined &&
        !findAstMatch(
          fn.body,
          (n) => {
            if (!ts.isYieldExpression(n) || n.expression === undefined) return false
            const y = unwrapExpr(n.expression)
            return !ts.isCallExpression(y) || !isPureLoggingOrTelemetryCall(y, sf, eff)
          },
          true,
        )
      )
    }
    return rets.every((e) => {
      const r = unwrapExpr(e)
      return ts.isYieldExpression(r) && r.expression !== undefined
        ? isSilentSuccessEffectExpr(r.expression, sf, eff, opt)
        : isSilentValueExpr(e, sf, opt)
    })
  }
  return false
}

export const isFnExpr = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n)

const isSilentCatchFn = (
  fn: ts.FunctionLikeDeclaration,
  sf: ts.SourceFile,
  eff: Ns,
  opt: Ns,
): boolean => {
  if (fn.body === undefined || hasFailOrDieEffect(fn, eff)) return false
  if (!ts.isBlock(fn.body))
    return ts.isExpression(fn.body) && isSilentSuccessEffectExpr(fn.body, sf, eff, opt)
  const rets = collectDirectReturns(fn)
  return rets.length > 0 && rets.every((e) => isSilentSuccessEffectExpr(e, sf, eff, opt))
}

const matchesWorkflowTag = (arg: ts.Expression): boolean => {
  const txt = getStaticStr(arg)
  if (txt !== undefined) return BANNED_WORKFLOW_TAGS.has(txt)
  const u = unwrapExpr(arg)
  return (
    ts.isArrayLiteralExpression(u) &&
    u.elements.some((el) => BANNED_WORKFLOW_TAGS.has(getStaticStr(el) ?? ""))
  )
}

/** Flags nullish/Option fallbacks on `Schema.decodeOption` or silent workflow-store `Effect.catchTag`/`catchTags`. */
export const isSilentDecodeOrStoreFallback = (node: ts.Node, sf: ts.SourceFile): boolean => {
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    if (!sf.text.includes("decodeOption") && !sf.text.includes("decodeUnknownOption")) return false
    const opt = collectNamespaceAliases(sf, "Option", OPTION_MODULE_SPECS)
    const schema = collectNamespaceAliases(sf, "Schema", SCHEMA_MODULE_SPECS)
    return isDecodeOrUnwrappedOptionExpr(node.left, opt, schema)
  }
  if (
    !ts.isCallExpression(node) ||
    !mayCallMethod(node, sf, ["getOrElse", "catchTag", "catchTags"])
  ) {
    return false
  }
  const eff = collectNamespaceAliases(sf, "Effect", EFFECT_MODULE_SPECS)
  const opt = collectNamespaceAliases(sf, "Option", OPTION_MODULE_SPECS)
  const schema = collectNamespaceAliases(sf, "Schema", SCHEMA_MODULE_SPECS)
  if (isNsCall(node, opt, "getOrElse")) {
    if (node.arguments.length >= 2 && node.arguments[0] !== undefined)
      return isSchemaDecodeOptionCallExpr(node.arguments[0], schema)
    const piped =
      node.arguments.length === 1 && node.parent !== undefined && ts.isCallExpression(node.parent)
        ? unwrapPipeCall(node.parent)
        : undefined
    return piped !== undefined && isSchemaDecodeOptionCallExpr(piped.subject, schema)
  }
  if (isEffectMethodCall(node, "catchTag", eff)) {
    const dataLast = node.arguments[0] !== undefined && matchesWorkflowTag(node.arguments[0])
    const [tagArg, cbArg] = dataLast
      ? [node.arguments[0], node.arguments[1]]
      : [node.arguments[1], node.arguments[2]]
    const fn = cbArg !== undefined ? unwrapExpr(cbArg) : undefined
    return (
      tagArg !== undefined &&
      matchesWorkflowTag(tagArg) &&
      fn !== undefined &&
      isFnExpr(fn) &&
      isSilentCatchFn(fn, sf, eff, opt)
    )
  }
  if (isEffectMethodCall(node, "catchTags", eff)) {
    const a0 = node.arguments[0]
    const hArg =
      node.arguments.length >= 2 &&
      !(a0 !== undefined && ts.isObjectLiteralExpression(unwrapExpr(a0)))
        ? node.arguments[1]
        : a0
    const obj = hArg !== undefined ? unwrapExpr(hArg) : undefined
    return (
      obj !== undefined &&
      ts.isObjectLiteralExpression(obj) &&
      obj.properties.some((p) => {
        const k =
          ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) ? getPropName(p.name) : undefined
        if (k === undefined || !BANNED_WORKFLOW_TAGS.has(k)) return false
        const fn = ts.isPropertyAssignment(p) ? unwrapExpr(p.initializer) : p
        return (isFnExpr(fn) || ts.isMethodDeclaration(fn)) && isSilentCatchFn(fn, sf, eff, opt)
      })
    )
  }
  return false
}

const isEnclosingProvisionOrAcquire = (
  node: ts.CallExpression,
  sf: ts.SourceFile,
  eff: Ns,
): boolean => {
  let child: ts.Node = node
  for (let c: ts.Node | undefined = node.parent; c !== undefined; child = c, c = c.parent) {
    if (
      ts.isCallExpression(c) &&
      isEffectMethodCall(c, "acquireRelease", eff) &&
      c.arguments[0] === child
    )
      return true
    if (
      (ts.isFunctionDeclaration(c) || ts.isMethodDeclaration(c)) &&
      c.name !== undefined &&
      /provision/i.test(c.name.getText(sf))
    )
      return true
    if (ts.isVariableDeclaration(c) && ts.isIdentifier(c.name) && /provision/i.test(c.name.text))
      return true
  }
  return false
}

/** Flags `Effect.tapError(...)` rollback cleanup inside `provision*` or `Effect.acquireRelease` acquire blocks. */
export const isProvisionTapErrorRollback = (
  node: ts.CallExpression,
  sf: ts.SourceFile,
): boolean => {
  if (!mayCallMethod(node, sf, ["tapError"])) return false
  const eff = collectNamespaceAliases(sf, "Effect", EFFECT_MODULE_SPECS)
  if (!isEffectMethodCall(node, "tapError", eff)) return false
  const cb = node.arguments.length >= 2 ? node.arguments[1] : node.arguments[0]
  if (cb === undefined || !isEnclosingProvisionOrAcquire(node, sf, eff)) return false
  const fn = unwrapExpr(cb)
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return true
  let foundLog = false
  const hasUnsafe = findAstMatch(fn.body, (n) => {
    if (!ts.isCallExpression(n)) return false
    if (isPureLoggingOrTelemetryCall(n, sf, eff)) {
      foundLog = true
      return false
    }
    return true
  })
  return !(foundLog && !hasUnsafe)
}

const hasGlobWord = (text: string): boolean =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .some((tok) => /^globs?\d*$/i.test(tok))

const isBackslashEscaper = (expr: ts.Expression): boolean => {
  const fn = unwrapExpr(expr)
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false
  const p = fn.parameters[0]?.name
  if (p === undefined || !ts.isIdentifier(p)) return false
  const body = !ts.isBlock(fn.body)
    ? unwrapExpr(fn.body)
    : fn.body.statements.length === 1 &&
        ts.isReturnStatement(fn.body.statements[0]!) &&
        fn.body.statements[0]!.expression !== undefined
      ? unwrapExpr(fn.body.statements[0]!.expression)
      : undefined
  if (body === undefined) return false
  if (ts.isBinaryExpression(body) && body.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const r = unwrapExpr(body.right)
    return getStaticStr(body.left) === "\\" && ts.isIdentifier(r) && r.text === p.text
  }
  if (ts.isTemplateExpression(body) && body.templateSpans.length === 1) {
    const s = unwrapExpr(body.templateSpans[0]!.expression)
    return (
      body.head.text === "\\" &&
      body.templateSpans[0]!.literal.text === "" &&
      ts.isIdentifier(s) &&
      s.text === p.text
    )
  }
  return false
}

const isGlobWildcardPat = (expr: ts.Expression): boolean => {
  const lit = getStaticStr(expr)
  if (lit !== undefined) return /[*?]/.test(lit)
  const u = unwrapExpr(expr)
  if (!ts.isRegularExpressionLiteral(u)) return false
  const body = u.text.slice(1, Math.max(1, u.text.lastIndexOf("/")))
  return /(?:\\\*|\\\?(?![A-Za-z]))/.test(body) || /\[(?:\\?[*?])+\]/.test(body)
}

const hasGlobReplace = (expr: ts.Expression): boolean =>
  findAstMatch(expr, (n) => {
    if (!ts.isCallExpression(n)) return false
    const mem = asMem(n.expression)
    if (mem === undefined) return false
    if ((mem.name === "replace" || mem.name === "replaceAll") && n.arguments.length >= 2) {
      const rep = unwrapExpr(n.arguments[1]!)
      return (
        getStaticStr(rep) !== "\\$&" &&
        !isBackslashEscaper(rep) &&
        isGlobWildcardPat(n.arguments[0]!)
      )
    }
    if (mem.name === "join") {
      const inner = unwrapExpr(mem.obj)
      const innerMem = ts.isCallExpression(inner) ? asMem(inner.expression) : undefined
      return (
        innerMem?.name === "split" &&
        ts.isCallExpression(inner) &&
        inner.arguments.length >= 1 &&
        isGlobWildcardPat(inner.arguments[0]!)
      )
    }
    return false
  })

const evalStaticSentinel = (expr: ts.Expression): number | undefined => {
  const u = unwrapExpr(expr)
  const lit = getStaticStr(u)
  if (lit !== undefined)
    return /^0+$/.test(lit) ? lit.length : /^[fF]+$/.test(lit) ? -lit.length : undefined
  if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const [l, r] = [evalStaticSentinel(u.left), evalStaticSentinel(u.right)]
    return l !== undefined && r !== undefined && l * r > 0 ? l + r : undefined
  }
  const mem = ts.isCallExpression(u) ? asMem(u.expression) : undefined
  if (mem === undefined || !ts.isCallExpression(u)) return undefined
  if (mem.name === "repeat" && u.arguments.length === 1) {
    const [recv, cnt] = [evalStaticSentinel(mem.obj), unwrapExpr(u.arguments[0]!)]
    return recv !== undefined && ts.isNumericLiteral(cnt) ? recv * Number(cnt.text) : undefined
  }
  if ((mem.name === "padStart" || mem.name === "padEnd") && u.arguments.length === 2) {
    const [lenNode, fill] = [unwrapExpr(u.arguments[0]!), evalStaticSentinel(u.arguments[1]!)]
    const recvText = getStaticStr(mem.obj)
    if (!ts.isNumericLiteral(lenNode) || fill === undefined || recvText === undefined)
      return undefined
    const targetLen = Number(lenNode.text)
    const signed = fill > 0 ? targetLen : -targetLen
    if (recvText === "") return signed
    const recv = evalStaticSentinel(mem.obj)
    return recv !== undefined && recv * fill > 0 && targetLen >= Math.abs(recv) ? signed : undefined
  }
  if (mem.name === "join" && u.arguments.length === 1 && getStaticStr(u.arguments[0]!) === "") {
    const fc = unwrapExpr(mem.obj)
    const fm =
      ts.isCallExpression(fc) && fc.arguments.length === 1 ? asMem(fc.expression) : undefined
    if (fm?.name !== "fill" || !ts.isCallExpression(fc)) return undefined
    const fill = evalStaticSentinel(fc.arguments[0]!)
    const arr = unwrapExpr(fm.obj)
    if (
      fill === undefined ||
      (!ts.isCallExpression(arr) && !ts.isNewExpression(arr)) ||
      arr.arguments?.length !== 1
    )
      return undefined
    const [ctor, lenArg] = [unwrapExpr(arr.expression), unwrapExpr(arr.arguments[0]!)]
    return ts.isIdentifier(ctor) && ctor.text === "Array" && ts.isNumericLiteral(lenArg)
      ? fill * Number(lenArg.text)
      : undefined
  }
  return undefined
}

const checkGitArgs = (
  arr: ts.ArrayLiteralExpression,
  callNode: ts.CallExpression,
  normPath: string,
  out: Array<Wave3AstViolation>,
): void => {
  let subIdx = -1
  let subName: string | undefined
  for (let i = 0; i < arr.elements.length; i++) {
    const txt = getStaticStr(arr.elements[i]!)
    if (txt === undefined) continue
    if (GIT_TWO_TOKEN_FLAGS.has(txt)) {
      i++
      continue
    }
    if (!txt.startsWith("-")) {
      subIdx = i
      subName = txt
      break
    }
  }
  if (subIdx === -1 || subName === undefined || !REF_RANGE_GIT_SUBCMDS.has(subName)) return
  let seenEnd = false
  for (let i = subIdx + 1; i < arr.elements.length; i++) {
    const txt = getStaticStr(arr.elements[i]!)
    if (txt !== undefined) {
      if (txt === "--end-of-options") seenEnd = true
      if (txt === "--") break
      continue
    }
    if (!seenEnd) {
      out.push({
        rule: "unsafe-dynamic-git-ref",
        message: `Dynamic git '${subName}' ref argument in '${normPath}' lacks preceding '--end-of-options' separator.`,
        node: callNode,
      })
      return
    }
  }
}

const isScopeBlk = (n: ts.Node): boolean =>
  ts.isBlock(n) ||
  ts.isForStatement(n) ||
  ts.isForOfStatement(n) ||
  ts.isForInStatement(n) ||
  ts.isCatchClause(n)

const hasAncestor = (start: ts.Node, pred: (n: ts.Node) => boolean, exprOnly = false): boolean => {
  let c: ts.Node | undefined = start.parent
  while (c !== undefined && (!exprOnly || ts.isExpression(c))) {
    if (pred(c)) return true
    c = c.parent
  }
  return false
}

const isRegExpCtorCall = (expr: ts.Expression): boolean => {
  const u = unwrapExpr(expr)
  if (ts.isIdentifier(u)) return u.text === "RegExp"
  const mem = asMem(u)
  const base = mem !== undefined ? unwrapExpr(mem.obj) : undefined
  return (
    mem !== undefined &&
    base !== undefined &&
    ts.isIdentifier(base) &&
    base.text === "globalThis" &&
    mem.name === "RegExp"
  )
}

type GitArrMap = ReadonlyMap<string, ts.ArrayLiteralExpression>
const resolveScopedGitArgs = (expr: ts.Expression, scopes: ReadonlyArray<GitArrMap>) => {
  const u = unwrapExpr(expr)
  if (ts.isArrayLiteralExpression(u)) return u
  if (!ts.isIdentifier(u)) return undefined
  for (let i = scopes.length - 1; i >= 0; i--) {
    const f = scopes[i]!.get(u.text)
    if (f !== undefined) return f
  }
  return undefined
}

const isSentinelExprNode = (n: ts.Node): boolean =>
  ts.isExpression(n) && unwrapExpr(n) === n && Math.abs(evalStaticSentinel(n) ?? 0) === 64

const isGlobOwnerNode = (c: ts.Node): boolean =>
  (ts.isFunctionDeclaration(c) || ts.isMethodDeclaration(c) || ts.isVariableDeclaration(c)) &&
  c.name !== undefined &&
  ts.isIdentifier(c.name) &&
  hasGlobWord(c.name.text)

/** REQ-3.4: Detects fabricated 64-char sentinel hashes, dynamic glob `RegExp(...)`, and dynamic `git` ref calls missing `--end-of-options`. */
export const collectWave3FailClosedViolations = (
  sourceFile: ts.SourceFile,
  normPath: string,
): ReadonlyArray<Wave3AstViolation> => {
  if (isTestOrHelperPath(normPath) || !/(?:^|\/)src\//.test(normPath)) return []
  const out: Array<Wave3AstViolation> = []
  const reportedSent = new Set<ts.Node>()
  const globScopes: Array<Set<string>> = [new Set()]
  const gitScopes: Array<Map<string, ts.ArrayLiteralExpression>> = [new Map()]

  const walk = (node: ts.Node): void => {
    const isFnOrFile = ts.isSourceFile(node) || ts.isFunctionLike(node)
    const pushes = isFnOrFile || isScopeBlk(node)
    if (pushes) {
      globScopes.push(new Set())
      gitScopes.push(new Map())
      const scan = (n: ts.Node): void => {
        const nested = n !== node && isScopeBlk(n)
        if ((n !== node && ts.isFunctionLike(n)) || (nested && !isFnOrFile)) return
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) {
          const isVar =
            ts.isVariableDeclarationList(n.parent) &&
            (n.parent.flags & ts.NodeFlags.BlockScoped) === 0
          if (isVar || !nested) {
            const init = unwrapExpr(n.initializer)
            if (hasGlobWord(n.name.text) || hasGlobReplace(init))
              globScopes[globScopes.length - 1]!.add(n.name.text)
            if (ts.isArrayLiteralExpression(init))
              gitScopes[gitScopes.length - 1]!.set(n.name.text, init)
          }
        }
        ts.forEachChild(n, scan)
      }
      scan(node)
    }

    if (
      isSentinelExprNode(node) &&
      !hasAncestor(node, isSentinelExprNode, true) &&
      !reportedSent.has(node)
    ) {
      reportedSent.add(node)
      out.push({
        rule: "fabricated-sentinel-hash",
        message: `Fabricated 64-character sentinel hash in '${normPath}' is banned — use ContentSha256 or Option/Error.`,
        node,
      })
    }

    if (ts.isCallExpression(node)) {
      const c = unwrapExpr(node.expression)
      const fnName = ts.isIdentifier(c) ? c.text : asMem(c)?.name
      if (fnName !== undefined) {
        const rawArr =
          GIT_EXEC_CALLEES.has(fnName) &&
          node.arguments.length >= 2 &&
          getStaticStr(node.arguments[0]!) === "git"
            ? resolveScopedGitArgs(node.arguments[1]!, gitScopes)
            : fnName.startsWith("execGit") || fnName.startsWith("runGit")
              ? node.arguments
                  .map((a) => resolveScopedGitArgs(a, gitScopes))
                  .find((a) => a !== undefined)
              : undefined
        if (rawArr !== undefined) checkGitArgs(rawArr, node, normPath, out)
      }
    }

    if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      isRegExpCtorCall(node.expression)
    ) {
      const arg0 = node.arguments?.[0]
      if (arg0 !== undefined && getStaticStr(arg0) === undefined) {
        const uArg = unwrapExpr(arg0)
        const hasGlobId = findAstMatch(
          uArg,
          (n) =>
            ts.isIdentifier(n) && (globScopes.some((s) => s.has(n.text)) || hasGlobWord(n.text)),
        )
        if (hasGlobReplace(uArg) || hasGlobId || hasAncestor(node, isGlobOwnerNode)) {
          out.push({
            rule: "dynamic-glob-regexp",
            message: `Dynamic glob-derived 'RegExp(...)' in '${normPath}' is banned — use a bounded literal matcher or segment parser.`,
            node,
          })
        }
      }
    }

    ts.forEachChild(node, walk)
    if (pushes) {
      globScopes.pop()
      gitScopes.pop()
    }
  }
  walk(sourceFile)
  return out
}
