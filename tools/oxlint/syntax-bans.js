const asyncMessage =
  "No async/await in Effect code — use Effect.gen. Escape hatch: an oxlint-disable comment, foreign boundaries only."
const newPromiseMessage =
  "No `new Promise` — wrap callbacks with Effect.try or Effect.async. Escape hatch: an oxlint-disable comment, foreign boundaries only."
const tryMessage =
  "No try/catch in Effect code — model failures with typed errors (Effect.catch*, Effect.die). Escape hatch: an oxlint-disable comment, foreign boundaries only."
const throwMessage =
  "No throw in Effect code — use Effect.fail or Effect.die. Escape hatch: an oxlint-disable comment, foreign boundaries only."
const jsonParseMessage =
  "No raw JSON.parse — decode with Schema (Schema.decodeUnknown*). Escape hatch: an oxlint-disable comment, foreign boundaries only."
const stubMessage =
  "No `stub()` in verified code — replace plan-skeleton `stub<A, E, R>(...)` with a real implementation before running verify."
const effectFnMessage =
  "Effect.fn must be called with a non-empty string literal span name (e.g. Effect.fn('Module.name'))."
const domainExportMessage =
  "Exported domain functions must use Effect.fn('LiteralName') for runtime trace correlation."
const fetchBanMessage =
  "Direct `fetch(...)` is banned in web app code — consume endpoints through typed AtomHttpApi queries and mutations (SampleApiClient)."
const secretConfigMessage =
  "Sensitive configuration keys (SECRET, TOKEN, PASSWORD, API_KEY, PRIVATE_KEY, CREDENTIAL) must use Config.redacted(...) instead of Config.string(...) to prevent leaking secrets in logs and spans."
const sqlInterpolationMessage =
  "Raw SQL template interpolation in .exec(`...${...}`) or .prepare(`...${...}`) is banned (SQL injection risk) — use parameterized queries via @effect/sql SqlClient."
const impureDomainGlobalMessage =
  "Impure global Date.now() / new Date() / Math.random() is banned in type:domain — pass timestamps/randomness via input or use Effect Clock / Random services so domain deciders remain deterministic."
const foreverRetryMessage =
  "Unbounded Effect.retry with Schedule.forever is banned (retry storm risk) — bound retries with Schedule.recurs(n) or Schedule.upTo(duration)."
const domainEffectIgnoreMessage =
  "Swallowing typed errors with Effect.ignore is banned in type:domain — surface failures in the E channel or handle them explicitly."
const switchBanMessage =
  "No switch statements in Effect code — use match(value)...exhaustive() from ts-pattern (see agent-patterns/pattern-matching.md)."
const elseIfBanMessage =
  "No if/else-if chains in domain/app code — use match(value) from ts-pattern with explicit .with(...) branches (see agent-patterns/pattern-matching.md)."
const discriminantIfBanMessage =
  "Do not use if/else or ternary expressions to branch on discriminated unions or tagged types — enumerate all states with match(value).with(...).exhaustive() from ts-pattern, even for 2 variants."
const matchRunBanMessage =
  "match(...).run() is banned (throws at runtime on unhandled states) — use .exhaustive() for closed unions or .otherwise() for open types."
const matchTaggedOtherwiseBanMessage =
  "Do not use .otherwise() when matching on discriminated union tags (_tag) — enumerate every variant and terminate with .exhaustive()."
const schemaBooleanStateMessage =
  "Do not use Schema.Boolean for lifecycle or mutually exclusive state flags in Schema.Struct — model mutually exclusive states with a closed discriminated union (Schema.TaggedUnion / Schema.TaggedStruct)."
const tautologicalFoldPropMessage =
  "Tautological property test: do not assert fold(events) against events.reduce(evolve, ...) using the same evolve function. Instead, assert: (1) monoidal batch fold vs step-by-step fold: expect(fold(events)).toEqual(events.reduce((acc, ev) => fold([ev], acc), initialState)), (2) deterministic replay idempotence: expect(fold(events)).toEqual(folded), or (3) state invariants via ts-pattern match."
const vacuousPropertyAssertMessage =
  "Vacuous assertion in property test: do not use toBeDefined(), toBeUndefined(), toBeTruthy(), toBeFalsy(), or existence checks to satisfy property test invariants — assert concrete domain invariants (e.g. toEqual, toBe, or pattern-matched structural predicates) to ensure the property test cannot pass vacuously."
const impreciseFailureAssertMessage =
  "Imprecise Exit.Failure assertion: checking only exit._tag === 'Failure' masks assertion crashes and unexpected defects (Die) as expected domain errors (Fail). Assert Cause.hasDies(exit.cause) for runner defects or Cause.hasFails / match(exit) for typed domain errors."
const explicitAnyBanMessage =
  "Explicit 'any' (including 'as any', ': any', and '<any>') is strictly banned — every value must have an explicit, inferable static type or be decoded via Effect Schema."
const unsafeNeverBanMessage =
  "Unsafe 'never' ('as never' or explicit ': never' on parameters/variables) is banned — fix the underlying type mismatch or use exhaustive ts-pattern matching (.exhaustive()) instead of bypassing the type checker."
const doubleTypeAssertionBanMessage =
  "Double type assertions ('as unknown as T') are banned — decode untrusted data with Effect Schema or type the interface properly instead of erasing types."
const nodeSqliteInfraMessage = (source, filename) =>
  `Do not import '${source}' in type:infra or type:app ('${filename}') — execute Cloudflare Durable Object SQLite and D1 storages against the real workerd runtime via @alchemy.run/cloudflare-runtime instead of hand-rolled node:sqlite mocks (harness:ADR-0008, harness:SPEC-0006, node-sqlite-in-infra).`
const bannedDrizzleMessage = (source, filename) =>
  `banned-drizzle-import: '${source}' is banned across the workspace in '${filename}' — use native Effect v4 SQL (@effect/sql-d1, @effect/sql-sqlite-do, SqlClient, SqliteMigrator).`
const dynamicHarnessImportMessage = (source, filename) =>
  `dynamic-harness-import: Dynamic import('${source}') in '${filename}' is banned because @nx/eslint-plugin enforce-module-boundaries crashes under TS7 when dynamic import("@harness/...") is mixed with static imports — use a top-level static import instead.`
const invalidClefEndpointMessage =
  "[invalid-clef-endpoint] System One models (clef-flash) only expose POST /v1/systemone (and GET /v1/models or GET /api/tags). Never call /api/generate, /api/chat, or /v1/chat/completions — use DecisionModel.decide (@effect/ai-typesafe) per agent-patterns/decision-model.md."

function isInvalidClefEndpointLiteralText(text) {
  if (typeof text !== "string" || text.length === 0) return false
  if (/11434\/(?:api\/(?:generate|chat)|v1\/(?:chat\/completions|completions))\b/i.test(text)) {
    return true
  }
  return /(?:11434|\bclef(?:-flash)?\b)/i.test(text) && /\/api\/(?:generate|chat)\b/i.test(text)
}

function isClefEndpointCheckedSrcFile(filename) {
  if (typeof filename !== "string") return false
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filename)) return false
  if (!/(?:^|\/)src\//.test(filename)) return false
  return !/(?:^|\/)(?:triage-decision|policy|ast-gate-visitors)\.ts$/.test(filename)
}

function isDrizzleSpecifier(spec) {
  return (
    typeof spec === "string" &&
    (spec === "drizzle-orm" ||
      spec.startsWith("drizzle-orm/") ||
      spec === "drizzle-kit" ||
      spec.startsWith("drizzle-kit/"))
  )
}

function getStaticModuleString(node) {
  if (node == null) return null
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value
  }
  if (
    node.type === "TemplateLiteral" &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0 &&
    Array.isArray(node.quasis) &&
    node.quasis.length === 1
  ) {
    const q = node.quasis[0]
    return q != null && q.value != null ? (q.value.cooked ?? q.value.raw ?? null) : null
  }
  return null
}

function getModulePrefixOrStaticString(node) {
  const staticStr = getStaticModuleString(node)
  if (staticStr != null) return staticStr
  if (
    node != null &&
    node.type === "TemplateLiteral" &&
    Array.isArray(node.quasis) &&
    node.quasis.length > 0
  ) {
    const q = node.quasis[0]
    return q != null && q.value != null ? (q.value.cooked ?? q.value.raw ?? null) : null
  }
  return null
}

function isRequireCallee(callee) {
  if (callee == null) return false
  if (isIdentifier(callee, "require")) return true
  return (
    callee.type === "MemberExpression" &&
    callee.computed !== true &&
    isIdentifier(callee.property, "require")
  )
}

function isSilentFsFallbackCheckedPathEstree(filename) {
  if (/(?:^|\/)libs\/harness\/graph\/src\/extractor\/compiler-session\.ts$/.test(filename)) {
    return false
  }
  return /(?:^|\/)(?:libs\/harness\/(?:gates|graph)\/src|apps\/harness-(?:cli|mcp)\/src)\//.test(
    filename,
  )
}

function unwrapPipeTargetEstree(node) {
  let curr = unwrapEstreeExpr(node)
  while (curr != null && curr.type === "CallExpression") {
    const callee = unwrapEstreeExpr(curr.callee)
    if (
      callee != null &&
      callee.type === "MemberExpression" &&
      callee.computed !== true &&
      isIdentifier(callee.property, "pipe")
    ) {
      curr = unwrapEstreeExpr(callee.object)
      continue
    }
    if (
      callee != null &&
      isIdentifier(callee, "pipe") &&
      Array.isArray(curr.arguments) &&
      curr.arguments.length > 0
    ) {
      curr = unwrapEstreeExpr(curr.arguments[0])
      continue
    }
    break
  }
  return curr
}

function isAllOptionalSchemaStructEstree(node) {
  const call = unwrapPipeTargetEstree(node)
  if (
    call == null ||
    call.type !== "CallExpression" ||
    getCalleeName(call.callee) !== "Schema.Struct" ||
    !Array.isArray(call.arguments) ||
    call.arguments.length === 0
  ) {
    return false
  }
  const obj = unwrapEstreeExpr(call.arguments[0])
  if (
    obj == null ||
    obj.type !== "ObjectExpression" ||
    !Array.isArray(obj.properties) ||
    obj.properties.length === 0
  ) {
    return false
  }
  return obj.properties.every((prop) => {
    if (prop == null || prop.type !== "Property") return false
    const val = unwrapPipeTargetEstree(prop.value)
    return (
      val != null &&
      val.type === "CallExpression" &&
      getCalleeName(val.callee) === "Schema.optional"
    )
  })
}

const PERSISTENCE_RESULT_CALLEES_ESTREE = new Set([
  "writeGraphHeadMeta",
  "updateGraphHeadCursor",
  "writeServerMetaAtomic",
])

function isPersistenceResultCallExprEstree(node) {
  const expr = unwrapEstreeExpr(node)
  if (expr == null) return false
  if (expr.type === "UnaryExpression" && expr.operator === "void") {
    return isPersistenceResultCallExprEstree(expr.argument)
  }
  if (expr.type === "SequenceExpression" && Array.isArray(expr.expressions)) {
    return expr.expressions.some(isPersistenceResultCallExprEstree)
  }
  if (expr.type !== "CallExpression") return false
  const callee = unwrapEstreeExpr(expr.callee)
  if (callee == null) return false
  const name =
    callee.type === "Identifier"
      ? callee.name
      : callee.type === "MemberExpression" &&
          callee.computed !== true &&
          callee.property?.type === "Identifier"
        ? callee.property.name
        : null
  return name != null && PERSISTENCE_RESULT_CALLEES_ESTREE.has(name)
}

function isDiscardedPersistenceCallStatementEstree(node) {
  if (node == null || node.type !== "ExpressionStatement") return false
  return isPersistenceResultCallExprEstree(node.expression)
}

function isConditionalPortBindBailoutEstree(node) {
  if (node == null || node.type !== "IfStatement" || node.alternate != null) return false
  const test = unwrapEstreeExpr(node.test)
  if (test == null || test.type !== "UnaryExpression" || test.operator !== "!") return false
  const arg = unwrapEstreeExpr(test.argument)
  if (arg == null || arg.type !== "Identifier" || !/bound/i.test(arg.name)) return false
  if (node.consequent?.type === "ReturnStatement") return true
  return (
    node.consequent?.type === "BlockStatement" &&
    Array.isArray(node.consequent.body) &&
    node.consequent.body.length === 1 &&
    node.consequent.body[0]?.type === "ReturnStatement"
  )
}

function isVacuousLengthNonNegativeAssertionEstree(node) {
  if (node == null || node.type !== "CallExpression") return false
  const callee = unwrapEstreeExpr(node.callee)
  if (
    callee == null ||
    callee.type !== "MemberExpression" ||
    callee.computed === true ||
    !isIdentifier(callee.property, "toBeGreaterThanOrEqual")
  ) {
    return false
  }
  if (!Array.isArray(node.arguments) || node.arguments.length !== 1) return false
  const arg0 = unwrapEstreeExpr(node.arguments[0])
  if (arg0 == null || arg0.type !== "Literal" || arg0.value !== 0) return false
  const expectCall = unwrapEstreeExpr(callee.object)
  if (
    expectCall == null ||
    expectCall.type !== "CallExpression" ||
    !isIdentifier(unwrapEstreeExpr(expectCall.callee), "expect") ||
    !Array.isArray(expectCall.arguments) ||
    expectCall.arguments.length !== 1
  ) {
    return false
  }
  const expectArg = unwrapEstreeExpr(expectCall.arguments[0])
  return (
    expectArg != null &&
    expectArg.type === "MemberExpression" &&
    expectArg.computed !== true &&
    isIdentifier(expectArg.property, "length")
  )
}

function isPureTierProcessEnvBannedPath(filename) {
  const libsMatch = /(?:^|\/)(libs\/[^/]+\/[^/]+\/src\/.*)$/.exec(filename)
  if (libsMatch == null) return false
  const relLibsPath = libsMatch[1]
  if (relLibsPath == null) return false
  return !/^libs\/[^/]+\/infra\/src\//.test(relLibsPath)
}

function unwrapEstreeExpr(node) {
  let curr = node
  while (
    curr != null &&
    (curr.type === "TSAsExpression" ||
      curr.type === "TSTypeAssertion" ||
      curr.type === "TSSatisfiesExpression" ||
      curr.type === "TSNonNullExpression" ||
      curr.type === "ParenthesizedExpression" ||
      curr.type === "ChainExpression")
  ) {
    curr = curr.expression
  }
  return curr
}

function isProcessTargetAst(node) {
  const target = unwrapEstreeExpr(node)
  if (target == null) return false
  if (isIdentifier(target, "process")) return true
  if (target.type !== "MemberExpression") return false
  if (!isIdentifier(target.object, "globalThis")) return false
  if (target.computed !== true) {
    return isIdentifier(target.property, "process")
  }
  return getStaticModuleString(target.property) === "process"
}

function isProcessEnvMemberAst(node) {
  if (node == null || node.type !== "MemberExpression") return false
  const propName =
    node.computed !== true && node.property?.type === "Identifier"
      ? node.property.name
      : node.computed === true
        ? getStaticModuleString(node.property)
        : null
  return propName === "env" && isProcessTargetAst(node.object)
}

function isProcessEnvDestructuringAst(node) {
  if (
    node == null ||
    node.type !== "VariableDeclarator" ||
    node.id?.type !== "ObjectPattern" ||
    node.init == null ||
    !isProcessTargetAst(node.init)
  ) {
    return false
  }
  return node.id.properties.some((prop) => {
    if (prop.type !== "Property") return false
    if (!prop.computed && prop.key?.type === "Identifier") {
      return prop.key.name === "env"
    }
    return getStaticModuleString(prop.key) === "env"
  })
}

function collectLogicalAndTermsAst(expr, out) {
  const u = unwrapEstreeExpr(expr)
  if (u != null && u.type === "LogicalExpression" && u.operator === "&&") {
    collectLogicalAndTermsAst(u.left, out)
    collectLogicalAndTermsAst(u.right, out)
    return
  }
  if (u != null) out.push(u)
}

function isNegatedCauseMethodCallAst(term, methodName, expectedArgText, context) {
  const u = unwrapEstreeExpr(term)
  if (u == null || u.type !== "UnaryExpression" || u.operator !== "!") return false
  const call = unwrapEstreeExpr(u.argument)
  if (call == null || call.type !== "CallExpression") return false
  if (getCalleeName(call.callee) !== `Cause.${methodName}`) return false
  const arg = Array.isArray(call.arguments) ? call.arguments[0] : undefined
  if (arg == null) return false
  return getNodeSourceText(context, unwrapEstreeExpr(arg)) === expectedArgText
}

const BOOLEAN_STATE_PROP_REGEX =
  /^(is[A-Z]|has[A-Z]|checkedOut|created|completed|cancelled|canceled|deleted|archived|active|closed|opened|approved|rejected|verified|publish|published|expired)$/

const QUANTITY_OR_VERSION_PROP_REGEX =
  /^(qty|quantity|count|[a-z0-9]+Qty|[a-z0-9]+Quantity|[a-z0-9]+Count|streamVersion|[a-z0-9]+StreamVersion|nextExpectedStreamVersion|availableQty|reservedQty|orderedQty)$/i

const DISCRIMINANT_CALLBACK_METHODS = new Set(["filter", "find", "some", "every"])

const DISCRIMINANT_PROP_NAMES = new Set([
  "_tag",
  "kind",
  "status",
  "verdict",
  "role",
  "state",
  "embeddingsMode",
  "retrievalMode",
])

const RETRIEVAL_DISCRIMINANT_PROP_NAMES = new Set(["embeddingsMode", "retrievalMode"])

export function isEnforcedWorkspaceFile(filename) {
  return /(^|\/)(libs\/[^/]+\/[^/]+|apps\/[^/]+)\//.test(filename)
}

function createDiscriminantAliasTracker() {
  const scopes = [new Set()]
  return {
    get size() {
      let total = 0
      for (const s of scopes) total += s.size
      return total
    },
    clear() {
      scopes.length = 0
      scopes.push(new Set())
    },
    pushScope() {
      scopes.push(new Set())
    },
    popScope() {
      if (scopes.length > 1) scopes.pop()
    },
    add(name) {
      if (typeof name === "string" && name.length > 0) {
        scopes[scopes.length - 1].add(name)
      }
    },
    has(name) {
      for (let i = scopes.length - 1; i >= 0; i--) {
        if (scopes[i].has(name)) return true
      }
      return false
    },
  }
}

function getDiscriminantMemberPropName(node) {
  const unwrapped = unwrapEstreeExpr(node)
  if (unwrapped == null || unwrapped.type !== "MemberExpression") {
    return null
  }
  if (unwrapped.computed !== true) {
    return unwrapped.property != null && unwrapped.property.type === "Identifier"
      ? unwrapped.property.name
      : null
  }
  return getStaticModuleString(unwrapEstreeExpr(unwrapped.property))
}

function isDiscriminantMemberAccess(node, propNames = DISCRIMINANT_PROP_NAMES) {
  const propName = getDiscriminantMemberPropName(node)
  return propName != null && propNames.has(propName)
}

function isDiscriminantSourceExpr(node, aliasTracker, propNames = DISCRIMINANT_PROP_NAMES) {
  const u = unwrapEstreeExpr(node)
  if (u == null) return false
  if (isDiscriminantMemberAccess(u, propNames)) return true
  if (u.type === "Identifier" && aliasTracker != null && aliasTracker.has(u.name)) {
    return true
  }
  if (u.type === "LogicalExpression" && (u.operator === "??" || u.operator === "||")) {
    return (
      isDiscriminantSourceExpr(u.left, aliasTracker, propNames) ||
      isDiscriminantSourceExpr(u.right, aliasTracker, propNames)
    )
  }
  if (u.type === "ConditionalExpression") {
    return (
      isDiscriminantSourceExpr(u.consequent, aliasTracker, propNames) ||
      isDiscriminantSourceExpr(u.alternate, aliasTracker, propNames)
    )
  }
  return false
}

function recordDiscriminantAliasesFromPattern(
  patternNode,
  tracker,
  propNames = DISCRIMINANT_PROP_NAMES,
) {
  if (patternNode == null || tracker == null) return
  if (patternNode.type === "AssignmentPattern") {
    recordDiscriminantAliasesFromPattern(patternNode.left, tracker, propNames)
    return
  }
  if (patternNode.type === "ArrayPattern" && Array.isArray(patternNode.elements)) {
    for (const elem of patternNode.elements) {
      if (elem != null) recordDiscriminantAliasesFromPattern(elem, tracker, propNames)
    }
    return
  }
  if (patternNode.type === "ObjectPattern" && Array.isArray(patternNode.properties)) {
    for (const prop of patternNode.properties) {
      if (prop == null || prop.type !== "Property") continue
      const keyName =
        prop.computed !== true && prop.key != null && prop.key.type === "Identifier"
          ? prop.key.name
          : getStaticModuleString(unwrapEstreeExpr(prop.key))
      if (keyName != null && propNames.has(keyName)) {
        const target =
          prop.value != null && prop.value.type === "AssignmentPattern"
            ? prop.value.left
            : prop.value
        if (target != null && target.type === "Identifier") {
          tracker.add(target.name)
        }
      }
      recordDiscriminantAliasesFromPattern(prop.value, tracker, propNames)
    }
  }
}

function recordDiscriminantAliasesFromBinding(
  lhsNode,
  rhsNode,
  tracker,
  propNames = DISCRIMINANT_PROP_NAMES,
) {
  if (lhsNode == null || tracker == null) return
  if (lhsNode.type === "Identifier") {
    if (isDiscriminantSourceExpr(rhsNode, tracker, propNames)) {
      tracker.add(lhsNode.name)
    }
    return
  }
  recordDiscriminantAliasesFromPattern(lhsNode, tracker, propNames)
}

function recordFunctionParamDiscriminantAliases(
  fnNode,
  tracker,
  propNames = DISCRIMINANT_PROP_NAMES,
) {
  if (fnNode == null || !Array.isArray(fnNode.params) || tracker == null) return
  for (const param of fnNode.params) {
    recordDiscriminantAliasesFromPattern(param, tracker, propNames)
  }
}

function isLiteralValue(node) {
  const u = unwrapEstreeExpr(node)
  if (u == null) return false
  if (u.type === "Literal") return true
  if (
    u.type === "UnaryExpression" &&
    (u.operator === "-" || u.operator === "+") &&
    unwrapEstreeExpr(u.argument)?.type === "Literal"
  ) {
    return true
  }
  if (u.type === "TemplateLiteral" && Array.isArray(u.expressions) && u.expressions.length === 0) {
    return true
  }
  return false
}

function isDiscriminantTestExpression(node, propNames = DISCRIMINANT_PROP_NAMES) {
  const unwrapped = unwrapEstreeExpr(node)
  if (unwrapped == null || typeof unwrapped !== "object") return false
  if (propNames === DISCRIMINANT_PROP_NAMES && isTagGuardCall(unwrapped)) return true
  if (
    unwrapped.type === "UnaryExpression" &&
    unwrapped.operator === "!" &&
    isDiscriminantTestExpression(unwrapped.argument, propNames)
  ) {
    return true
  }
  if (unwrapped.type === "LogicalExpression") {
    return (
      isDiscriminantTestExpression(unwrapped.left, propNames) ||
      isDiscriminantTestExpression(unwrapped.right, propNames)
    )
  }
  if (
    unwrapped.type === "BinaryExpression" &&
    (unwrapped.operator === "===" ||
      unwrapped.operator === "!==" ||
      unwrapped.operator === "==" ||
      unwrapped.operator === "!=")
  ) {
    if (
      isDiscriminantSourceExpr(unwrapped.left, null, propNames) &&
      isLiteralValue(unwrapped.right)
    ) {
      return true
    }
    if (
      isDiscriminantSourceExpr(unwrapped.right, null, propNames) &&
      isLiteralValue(unwrapped.left)
    ) {
      return true
    }
  }
  return false
}

function isAliasedDiscriminantTest(node, aliasNames) {
  const unwrapped = unwrapEstreeExpr(node)
  if (
    unwrapped == null ||
    typeof unwrapped !== "object" ||
    aliasNames == null ||
    aliasNames.size === 0
  ) {
    return false
  }
  if (
    unwrapped.type === "UnaryExpression" &&
    unwrapped.operator === "!" &&
    isAliasedDiscriminantTest(unwrapped.argument, aliasNames)
  ) {
    return true
  }
  if (unwrapped.type === "LogicalExpression") {
    return (
      isAliasedDiscriminantTest(unwrapped.left, aliasNames) ||
      isAliasedDiscriminantTest(unwrapped.right, aliasNames)
    )
  }
  if (
    unwrapped.type === "BinaryExpression" &&
    (unwrapped.operator === "===" ||
      unwrapped.operator === "!==" ||
      unwrapped.operator === "==" ||
      unwrapped.operator === "!=")
  ) {
    const left = unwrapEstreeExpr(unwrapped.left)
    const right = unwrapEstreeExpr(unwrapped.right)
    if (left != null && left.type === "Identifier" && aliasNames.has(left.name)) {
      return true
    }
    if (right != null && right.type === "Identifier" && aliasNames.has(right.name)) {
      return true
    }
  }
  return false
}

function isNestedFunctionEstree(node) {
  return (
    node != null &&
    (node.type === "ArrowFunctionExpression" ||
      node.type === "FunctionExpression" ||
      node.type === "FunctionDeclaration")
  )
}

function collectCallbackAliasesAndReturns(
  node,
  localTracker,
  returnsOut,
  propNames = DISCRIMINANT_PROP_NAMES,
) {
  if (node == null || typeof node !== "object") return
  if (Array.isArray(node)) {
    for (const item of node) {
      collectCallbackAliasesAndReturns(item, localTracker, returnsOut, propNames)
    }
    return
  }
  if (typeof node.type !== "string" || isNestedFunctionEstree(node)) return
  if (node.type === "VariableDeclarator") {
    recordDiscriminantAliasesFromBinding(node.id, node.init, localTracker, propNames)
  } else if (node.type === "AssignmentExpression") {
    recordDiscriminantAliasesFromBinding(node.left, node.right, localTracker, propNames)
  } else if (node.type === "ReturnStatement" && node.argument != null) {
    returnsOut.push(node.argument)
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "parent") continue
    if (v != null && typeof v === "object") {
      collectCallbackAliasesAndReturns(v, localTracker, returnsOut, propNames)
    }
  }
}

function checkDiscriminantCollectionCallback(
  node,
  filename,
  outerTracker,
  context,
  propNames = DISCRIMINANT_PROP_NAMES,
) {
  if (!isEnforcedWorkspaceFile(filename) || node == null) return
  const callee = unwrapEstreeExpr(node.callee)
  if (callee == null || callee.type !== "MemberExpression") return
  const methodName =
    callee.computed !== true
      ? callee.property != null && callee.property.type === "Identifier"
        ? callee.property.name
        : null
      : getStaticModuleString(unwrapEstreeExpr(callee.property))
  if (methodName == null || !DISCRIMINANT_CALLBACK_METHODS.has(methodName)) return
  if (!Array.isArray(node.arguments)) return
  let fnNode = null
  for (let i = 0; i < Math.min(2, node.arguments.length); i++) {
    const candidate = unwrapEstreeExpr(node.arguments[i])
    if (
      candidate != null &&
      (candidate.type === "ArrowFunctionExpression" || candidate.type === "FunctionExpression")
    ) {
      fnNode = candidate
      break
    }
  }
  if (fnNode == null) return

  const localSet = new Set()
  const localTracker = {
    get size() {
      return (
        (outerTracker != null && propNames === DISCRIMINANT_PROP_NAMES ? outerTracker.size : 0) +
        localSet.size
      )
    },
    add(name) {
      if (typeof name === "string" && name.length > 0) localSet.add(name)
    },
    has(name) {
      if (localSet.has(name)) return true
      return outerTracker != null && propNames === DISCRIMINANT_PROP_NAMES && outerTracker.has(name)
    },
  }
  recordFunctionParamDiscriminantAliases(fnNode, localTracker, propNames)

  const predExprs = []
  if (fnNode.type === "ArrowFunctionExpression" && fnNode.body?.type !== "BlockStatement") {
    if (fnNode.body != null) predExprs.push(fnNode.body)
  } else if (fnNode.body != null) {
    collectCallbackAliasesAndReturns(fnNode.body, localTracker, predExprs, propNames)
  }

  for (const predExpr of predExprs) {
    if (
      isDiscriminantTestExpression(predExpr, propNames) ||
      isAliasedDiscriminantTest(predExpr, localTracker)
    ) {
      context.report({ node, message: discriminantIfBanMessage })
      return
    }
  }
}

function isTagGuardCall(node) {
  if (node == null || node.type !== "CallExpression") return false
  const callee = node.callee
  if (callee != null && callee.type === "MemberExpression" && callee.computed !== true) {
    const obj = callee.object
    const prop = callee.property
    if (obj != null && obj.type === "Identifier" && prop != null && prop.type === "Identifier") {
      if (
        (obj.name === "Option" && (prop.name === "isSome" || prop.name === "isNone")) ||
        (obj.name === "Either" && (prop.name === "isLeft" || prop.name === "isRight")) ||
        (obj.name === "Result" && (prop.name === "isSuccess" || prop.name === "isFailure")) ||
        (obj.name === "Predicate" && prop.name === "isTagged")
      ) {
        return true
      }
    }
  }
  return false
}

const SCALAR_PRIMITIVE_SCHEMA_NAMES = new Set([
  "String",
  "NonEmptyString",
  "Trimmed",
  "NonEmptyTrimmedString",
  "Int",
  "Number",
  "Finite",
  "FiniteFromString",
  "NumberFromString",
  "Natural",
  "Positive",
  "PositiveInt",
  "NonNegative",
  "NonNegativeInt",
])

function getRawPrimitiveKeywordInfo(typeNode) {
  if (typeNode == null || typeof typeNode !== "object") return null
  if (typeNode.type === "TSParenthesizedType") {
    return getRawPrimitiveKeywordInfo(typeNode.typeAnnotation)
  }
  if (typeNode.type === "TSStringKeyword") return { prim: "string", schema: "String" }
  if (typeNode.type === "TSNumberKeyword") return { prim: "number", schema: "Int" }
  if (typeNode.type === "TSBooleanKeyword") return { prim: "boolean", schema: "Boolean" }
  if (typeNode.type === "TSBigIntKeyword") return { prim: "bigint", schema: "BigInt" }
  if (typeNode.type === "TSAnyKeyword") return { prim: "any", schema: "String" }
  if (typeNode.type === "TSUnknownKeyword") return { prim: "unknown", schema: "String" }
  if (typeNode.type === "TSUnionType" && Array.isArray(typeNode.types)) {
    for (const member of typeNode.types) {
      const info = getRawPrimitiveKeywordInfo(member)
      if (info != null) return info
    }
  }
  return null
}

function containsInlineObjectTypeNode(typeNode) {
  if (typeNode == null || typeof typeNode !== "object") return false
  if (typeNode.type === "TSTypeLiteral") return true
  if (typeNode.type === "TSParenthesizedType") {
    return containsInlineObjectTypeNode(typeNode.typeAnnotation)
  }
  if (
    (typeNode.type === "TSUnionType" || typeNode.type === "TSIntersectionType") &&
    Array.isArray(typeNode.types)
  ) {
    return typeNode.types.some(containsInlineObjectTypeNode)
  }
  if (typeNode.type === "TSTypeReference") {
    const params = getTypeParams(typeNode)
    return params.some(containsInlineObjectTypeNode)
  }
  return false
}

function isSchemaBrandCall(node) {
  return (
    node != null &&
    node.type === "CallExpression" &&
    node.callee != null &&
    node.callee.type === "MemberExpression" &&
    node.callee.computed !== true &&
    isIdentifier(node.callee.object, "Schema") &&
    isIdentifier(node.callee.property, "brand") &&
    Array.isArray(node.arguments) &&
    node.arguments[0] != null &&
    node.arguments[0].type === "Literal" &&
    typeof node.arguments[0].value === "string"
  )
}

function hasSchemaBrandInTree(node, brandedTypeNames) {
  if (node == null || typeof node !== "object") return false
  if (node.type === "Identifier" && brandedTypeNames != null && brandedTypeNames.has(node.name)) {
    return true
  }
  if (
    node.type === "CallExpression" &&
    node.callee != null &&
    node.callee.type === "MemberExpression" &&
    node.callee.computed !== true
  ) {
    if (
      isIdentifier(node.callee.object, "Schema") &&
      (isIdentifier(node.callee.property, "brand") ||
        isIdentifier(node.callee.property, "fromBrand"))
    ) {
      return true
    }
    if (
      isIdentifier(node.callee.object, "Schema") &&
      isIdentifier(node.callee.property, "decodeTo") &&
      Array.isArray(node.arguments) &&
      node.arguments.length > 0 &&
      hasSchemaBrandInTree(node.arguments[0], brandedTypeNames)
    ) {
      return true
    }
    if (
      isIdentifier(node.callee.object, "Brand") &&
      (isIdentifier(node.callee.property, "nominal") ||
        isIdentifier(node.callee.property, "make") ||
        isIdentifier(node.callee.property, "check") ||
        isIdentifier(node.callee.property, "refined"))
    ) {
      return true
    }
  }
  for (const key of Object.keys(node)) {
    if (key === "parent") continue
    const val = node[key]
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item != null && typeof item === "object" && item.type) {
          if (hasSchemaBrandInTree(item, brandedTypeNames)) return true
        }
      }
    } else if (val != null && typeof val === "object" && val.type) {
      if (hasSchemaBrandInTree(val, brandedTypeNames)) return true
    }
  }
  return false
}

function getUnbrandedScalarSchemaName(node, unbrandedSchemaVarNames, brandedTypeNames) {
  if (node == null || typeof node !== "object") return null
  if (hasSchemaBrandInTree(node, brandedTypeNames)) return null
  const unwrapped = unwrapSchemaModifier(node)
  if (
    unwrapped != null &&
    unwrapped.type === "Identifier" &&
    unbrandedSchemaVarNames != null &&
    unbrandedSchemaVarNames.has(unwrapped.name)
  ) {
    return unbrandedSchemaVarNames.get(unwrapped.name)
  }
  if (
    unwrapped != null &&
    unwrapped.type === "MemberExpression" &&
    unwrapped.computed !== true &&
    isIdentifier(unwrapped.object, "Schema") &&
    unwrapped.property != null &&
    unwrapped.property.type === "Identifier" &&
    SCALAR_PRIMITIVE_SCHEMA_NAMES.has(unwrapped.property.name)
  ) {
    return unwrapped.property.name
  }
  if (
    unwrapped != null &&
    unwrapped.type === "CallExpression" &&
    unwrapped.callee != null &&
    unwrapped.callee.type === "MemberExpression" &&
    unwrapped.callee.computed !== true &&
    unwrapped.callee.property != null &&
    unwrapped.callee.property.type === "Identifier" &&
    (unwrapped.callee.property.name === "check" || unwrapped.callee.property.name === "pipe")
  ) {
    return getUnbrandedScalarSchemaName(
      unwrapped.callee.object,
      unbrandedSchemaVarNames,
      brandedTypeNames,
    )
  }
  return null
}

function toPascalCase(str) {
  if (!str || typeof str !== "string") return "DomainValue"
  return str.charAt(0).toUpperCase() + str.slice(1)
}

function extractSchemaFieldObjects(callNode) {
  if (
    callNode == null ||
    callNode.type !== "CallExpression" ||
    !Array.isArray(callNode.arguments)
  ) {
    return []
  }
  const callee = callNode.callee
  if (
    callee != null &&
    callee.type === "MemberExpression" &&
    callee.computed !== true &&
    callee.property != null &&
    callee.property.type === "Identifier" &&
    (callee.property.name === "pipe" || callee.property.name === "check") &&
    callee.object != null &&
    callee.object.type === "CallExpression"
  ) {
    return extractSchemaFieldObjects(callee.object)
  }
  if (
    callee != null &&
    callee.type === "MemberExpression" &&
    callee.computed !== true &&
    isIdentifier(callee.object, "Schema")
  ) {
    if (
      isIdentifier(callee.property, "Struct") &&
      callNode.arguments[0] != null &&
      callNode.arguments[0].type === "ObjectExpression"
    ) {
      return [{ kind: "Struct", obj: callNode.arguments[0] }]
    }
    if (
      isIdentifier(callee.property, "TaggedStruct") &&
      callNode.arguments[1] != null &&
      callNode.arguments[1].type === "ObjectExpression"
    ) {
      return [{ kind: "TaggedStruct", obj: callNode.arguments[1] }]
    }
    if (
      isIdentifier(callee.property, "TaggedUnion") &&
      callNode.arguments[0] != null &&
      callNode.arguments[0].type === "ObjectExpression" &&
      Array.isArray(callNode.arguments[0].properties)
    ) {
      const result = []
      for (const variantProp of callNode.arguments[0].properties) {
        if (
          variantProp != null &&
          (variantProp.type === "Property" || variantProp.type === "ObjectProperty") &&
          variantProp.value != null &&
          variantProp.value.type === "ObjectExpression"
        ) {
          result.push({ kind: "TaggedUnion", obj: variantProp.value })
        }
      }
      return result
    }
  }
  if (
    callee != null &&
    callee.type === "CallExpression" &&
    callee.callee != null &&
    callee.callee.type === "MemberExpression" &&
    callee.callee.computed !== true &&
    isIdentifier(callee.callee.object, "Schema") &&
    callee.callee.property != null &&
    callee.callee.property.type === "Identifier" &&
    (callee.callee.property.name === "TaggedError" ||
      callee.callee.property.name === "TaggedClass" ||
      callee.callee.property.name === "Class")
  ) {
    const kind = callee.callee.property.name
    return callNode.arguments
      .filter((arg) => arg != null && arg.type === "ObjectExpression")
      .map((obj) => ({ kind, obj }))
  }
  return []
}

function getTypeParams(node) {
  if (node == null) return []
  const box = node.typeArguments ?? node.typeParameters
  if (box != null && Array.isArray(box.params)) return box.params
  return []
}

function getEffectSuccessTypeNode(typeNode) {
  if (typeNode == null || typeNode.type !== "TSTypeReference") return null
  const tn = typeNode.typeName
  const isEffectType =
    isIdentifier(tn, "Effect") ||
    (tn != null &&
      (tn.type === "TSQualifiedName" || tn.type === "MemberExpression") &&
      isIdentifier(tn.left ?? tn.object, "Effect") &&
      isIdentifier(tn.right ?? tn.property, "Effect"))
  if (!isEffectType) return null
  const params = getTypeParams(typeNode)
  return params.length > 0 ? params[0] : null
}

const DOMAIN_BRAND_IDENTIFIER_REGEX =
  /^[A-Z][A-Za-z0-9]*(?:Id|Name|Count|Amount|Price|Quantity|Version|Millis|Timestamp|Email|Slug|Token|Code|Url|Message|Brand)$/

function containsBrandTypeReference(typeNode, brandedTypeNames) {
  if (typeNode == null || typeof typeNode !== "object") return false
  if (typeNode.type === "TSTypeReference" && typeNode.typeName != null) {
    const tn = typeNode.typeName
    if (
      tn.type === "Identifier" &&
      ((brandedTypeNames != null && brandedTypeNames.has(tn.name)) ||
        DOMAIN_BRAND_IDENTIFIER_REGEX.test(tn.name))
    ) {
      return true
    }
    if (
      (tn.type === "TSQualifiedName" || tn.type === "MemberExpression") &&
      isIdentifier(tn.left ?? tn.object, "Brand") &&
      (isIdentifier(tn.right ?? tn.property, "Branded") ||
        isIdentifier(tn.right ?? tn.property, "Brand"))
    ) {
      return true
    }
  }
  if (typeNode.type === "TSIntersectionType" && Array.isArray(typeNode.types)) {
    return typeNode.types.some((t) => containsBrandTypeReference(t, brandedTypeNames))
  }
  if (typeNode.type === "TSParenthesizedType" && typeNode.typeAnnotation != null) {
    return containsBrandTypeReference(typeNode.typeAnnotation, brandedTypeNames)
  }
  return false
}

function unwrapSchemaModifier(node) {
  if (
    node != null &&
    node.type === "CallExpression" &&
    node.callee != null &&
    node.callee.type === "MemberExpression" &&
    node.callee.computed !== true &&
    isIdentifier(node.callee.object, "Schema") &&
    Array.isArray(node.arguments) &&
    node.arguments.length > 0
  ) {
    return unwrapSchemaModifier(node.arguments[0])
  }
  return node
}

function isSchemaBoolean(node) {
  const unwrapped = unwrapSchemaModifier(node)
  return (
    unwrapped != null &&
    unwrapped.type === "MemberExpression" &&
    unwrapped.computed !== true &&
    isIdentifier(unwrapped.object, "Schema") &&
    isIdentifier(unwrapped.property, "Boolean")
  )
}

function isSchemaIntOrNumber(node) {
  const unwrapped = unwrapSchemaModifier(node)
  return (
    unwrapped != null &&
    unwrapped.type === "MemberExpression" &&
    unwrapped.computed !== true &&
    isIdentifier(unwrapped.object, "Schema") &&
    (isIdentifier(unwrapped.property, "Int") || isIdentifier(unwrapped.property, "Number"))
  )
}

function getUncheckedSchemaIntOrNumberName(node) {
  const unwrapped = unwrapSchemaModifier(node)
  if (unwrapped == null || typeof unwrapped !== "object") return null
  if (
    unwrapped.type === "MemberExpression" &&
    unwrapped.computed !== true &&
    isIdentifier(unwrapped.object, "Schema") &&
    (isIdentifier(unwrapped.property, "Int") || isIdentifier(unwrapped.property, "Number"))
  ) {
    return unwrapped.property.name
  }
  if (
    unwrapped.type === "CallExpression" &&
    unwrapped.callee != null &&
    unwrapped.callee.type === "MemberExpression" &&
    unwrapped.callee.computed !== true &&
    isIdentifier(unwrapped.callee.property, "pipe")
  ) {
    const hasCheckArg =
      Array.isArray(unwrapped.arguments) &&
      unwrapped.arguments.some(
        (arg) =>
          arg != null &&
          arg.type === "CallExpression" &&
          arg.callee != null &&
          arg.callee.type === "MemberExpression" &&
          isIdentifier(arg.callee.object, "Schema") &&
          isIdentifier(arg.callee.property, "check"),
      )
    if (hasCheckArg) return null
    return getUncheckedSchemaIntOrNumberName(unwrapped.callee.object)
  }
  return null
}

function isExpectCall(node) {
  if (node == null || node.type !== "CallExpression") return false
  return isIdentifier(node.callee, "expect")
}

function isVacuousAssertionCall(node) {
  if (node == null || node.type !== "CallExpression") return false
  const callee = node.callee
  if (callee == null || callee.type !== "MemberExpression" || callee.computed === true) {
    return false
  }
  const prop = callee.property
  if (prop == null || prop.type !== "Identifier") return false
  const name = prop.name

  if (
    name === "toBeDefined" ||
    name === "toBeUndefined" ||
    name === "toBeTruthy" ||
    name === "toBeFalsy"
  ) {
    if (isExpectCall(callee.object)) return true
    if (
      callee.object.type === "MemberExpression" &&
      isIdentifier(callee.object.property, "not") &&
      isExpectCall(callee.object.object)
    ) {
      return true
    }
  }

  if (name === "toBeNull" || name === "toBeUndefined") {
    if (
      callee.object.type === "MemberExpression" &&
      isIdentifier(callee.object.property, "not") &&
      isExpectCall(callee.object.object)
    ) {
      return true
    }
  }

  return false
}

function getMemberObjectChainKey(node) {
  if (node == null) return null
  if (node.type === "Identifier") return node.name
  if (
    node.type === "MemberExpression" &&
    node.computed !== true &&
    node.property != null &&
    node.property.type === "Identifier"
  ) {
    const prefix = getMemberObjectChainKey(node.object)
    return prefix ? `${prefix}.${node.property.name}` : null
  }
  return null
}

function getTagOnlyExpectTarget(node) {
  if (node == null || node.type !== "CallExpression") return null
  const callee = node.callee
  if (callee == null || callee.type !== "MemberExpression" || callee.computed === true) {
    return null
  }
  const prop = callee.property
  if (prop == null || prop.type !== "Identifier") return null
  if (prop.name !== "toBe" && prop.name !== "toEqual") return null
  if (
    !isExpectCall(callee.object) ||
    !Array.isArray(callee.object.arguments) ||
    callee.object.arguments.length === 0
  ) {
    return null
  }
  const expectArg = callee.object.arguments[0]
  if (
    expectArg != null &&
    expectArg.type === "MemberExpression" &&
    expectArg.computed !== true &&
    isIdentifier(expectArg.property, "_tag")
  ) {
    return getMemberObjectChainKey(expectArg.object)
  }
  return null
}

function findVacuousAssertionCalls(root) {
  const matches = []
  const tagAsserts = []
  const observedTargets = new Set()

  function walk(node) {
    if (node == null || typeof node !== "object") return
    if (isVacuousAssertionCall(node)) {
      matches.push(node)
      return
    }
    const tagTarget = getTagOnlyExpectTarget(node)
    if (tagTarget != null) {
      tagAsserts.push({ node, target: tagTarget })
    }
    if (
      node.type === "MemberExpression" &&
      node.computed !== true &&
      node.property != null &&
      node.property.type === "Identifier" &&
      node.property.name !== "_tag"
    ) {
      const objKey = getMemberObjectChainKey(node.object)
      if (objKey != null) {
        observedTargets.add(objKey)
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "parent") continue
      const val = node[key]
      if (Array.isArray(val)) {
        for (const item of val) {
          if (item != null && typeof item === "object" && item.type) {
            walk(item)
          }
        }
      } else if (val != null && typeof val === "object" && val.type) {
        walk(val)
      }
    }
  }
  walk(root)
  for (const item of tagAsserts) {
    if (!observedTargets.has(item.target)) {
      matches.push(item.node)
    }
  }
  return matches
}

function isPropertyTestCall(node) {
  if (node == null || node.type !== "CallExpression") return false
  const callee = node.callee
  if (callee == null) return false
  if (callee.type === "MemberExpression" && callee.computed !== true && callee.property != null) {
    if (isIdentifier(callee.property, "prop")) {
      return true
    }
    if (
      callee.object != null &&
      callee.object.type === "MemberExpression" &&
      isIdentifier(callee.object.property, "prop")
    ) {
      return true
    }
    if (isIdentifier(callee.object, "fc") && isIdentifier(callee.property, "assert")) {
      return true
    }
  }
  return false
}

function isImpreciseFailureAssert(node) {
  if (node == null || node.type !== "CallExpression") return false
  const callee = node.callee
  if (callee == null || callee.type !== "MemberExpression" || callee.computed === true) {
    return false
  }
  if (!isIdentifier(callee.property, "toBe") && !isIdentifier(callee.property, "toEqual")) {
    return false
  }
  if (!Array.isArray(node.arguments) || node.arguments.length === 0) return false
  const firstArg = node.arguments[0]

  // Case 1: expect(exit._tag).toBe("Failure") / toEqual("Failure")
  if (firstArg.type === "Literal" && firstArg.value === "Failure") {
    const obj = callee.object
    if (isExpectCall(obj) && Array.isArray(obj.arguments) && obj.arguments.length > 0) {
      const expectArg = obj.arguments[0]
      if (
        expectArg != null &&
        expectArg.type === "MemberExpression" &&
        expectArg.computed !== true &&
        isIdentifier(expectArg.property, "_tag")
      ) {
        return true
      }
    }
  }

  // Case 2: expect(Exit.isFailure(exit)).toBe(true) / toEqual(true)
  if (firstArg.type === "Literal" && firstArg.value === true) {
    const obj = callee.object
    if (isExpectCall(obj) && Array.isArray(obj.arguments) && obj.arguments.length > 0) {
      const expectArg = obj.arguments[0]
      if (
        expectArg != null &&
        expectArg.type === "CallExpression" &&
        expectArg.callee != null &&
        expectArg.callee.type === "MemberExpression" &&
        isIdentifier(expectArg.callee.object, "Exit") &&
        isIdentifier(expectArg.callee.property, "isFailure")
      ) {
        return true
      }
    }
  }

  return false
}

function isTestFilePath(filename) {
  return (
    filename.endsWith(".test.ts") ||
    filename.endsWith(".test.tsx") ||
    filename.endsWith(".spec.ts") ||
    filename.endsWith(".spec.tsx")
  )
}

function getCalleeName(callee) {
  if (callee == null) return ""
  if (callee.type === "Identifier") return callee.name
  if (
    callee.type === "MemberExpression" &&
    callee.computed !== true &&
    callee.property != null &&
    callee.property.type === "Identifier"
  ) {
    const objKey = getMemberObjectChainKey(callee.object)
    return objKey != null ? `${objKey}.${callee.property.name}` : `.${callee.property.name}`
  }
  return ""
}

function getPropertyKeyName(prop) {
  if (prop == null || prop.key == null) return null
  if (prop.key.type === "Identifier") return prop.key.name
  if (prop.key.type === "Literal" && typeof prop.key.value === "string") return prop.key.value
  return null
}

function getSourceCode(context) {
  if (context == null) return undefined
  if (context.sourceCode != null) return context.sourceCode
  if (typeof context.getSourceCode === "function") {
    try {
      return context.getSourceCode()
    } catch {
      return undefined
    }
  }
  return undefined
}

function readFullSourceText(sc, programNode) {
  if (sc == null) return undefined
  const hasBody = Array.isArray(programNode?.body) && programNode.body.length > 0
  if (typeof sc.text === "string") {
    if (sc.text.length === 0 && hasBody) return undefined
    return sc.text
  }
  if (typeof sc.getText === "function") {
    try {
      const text = sc.getText(programNode)
      if (typeof text === "string") {
        if (text.length === 0 && hasBody) return undefined
        return text
      }
    } catch {
      return undefined
    }
  }
  return undefined
}

function getNodeSourceText(context, node) {
  if (node == null) return ""
  if (node.rawSource && typeof node.rawSource === "string") {
    return node.rawSource
  }
  const sc = getSourceCode(context)
  if (sc && typeof sc.getText === "function") {
    try {
      const text = sc.getText(node)
      if (typeof text === "string" && text.length > 0) return text
    } catch {
      // fallback
    }
  }
  const fullText = sc && typeof sc.text === "string" ? sc.text : ""
  if (fullText) {
    if (Array.isArray(node.range) && node.range.length >= 2) {
      return fullText.slice(node.range[0], node.range[1])
    }
    if (typeof node.start === "number" && typeof node.end === "number") {
      return fullText.slice(node.start, node.end)
    }
  }
  return ""
}

function inspectMatchChain(node) {
  const withPatterns = []
  let curr = node
  while (
    curr != null &&
    curr.type === "CallExpression" &&
    curr.callee != null &&
    curr.callee.type === "MemberExpression" &&
    curr.callee.computed !== true &&
    curr.callee.property != null &&
    curr.callee.property.type === "Identifier"
  ) {
    const method = curr.callee.property.name
    if (method === "with") {
      if (Array.isArray(curr.arguments) && curr.arguments.length >= 2) {
        withPatterns.push(...curr.arguments.slice(0, curr.arguments.length - 1))
      }
      curr = curr.callee.object
    } else if (method === "when" || method === "narrow" || method === "returnType") {
      curr = curr.callee.object
    } else {
      break
    }
  }
  const isRootMatch =
    curr != null && curr.type === "CallExpression" && isIdentifier(curr.callee, "match")
  return { isRootMatch, withPatterns }
}

function isTagObjectPattern(patternNode) {
  if (
    patternNode == null ||
    patternNode.type !== "ObjectExpression" ||
    !Array.isArray(patternNode.properties)
  ) {
    return false
  }
  return patternNode.properties.some((prop) => {
    if (prop == null || (prop.type !== "Property" && prop.type !== "ObjectProperty")) return false
    const key = prop.key
    return (
      (key != null && key.type === "Identifier" && key.name === "_tag") ||
      (key != null && key.type === "Literal" && key.value === "_tag")
    )
  })
}

function isIdentifier(node, name) {
  return node != null && node.type === "Identifier" && node.name === name
}

function isFetchCall(node) {
  const callee = node.callee
  if (isIdentifier(callee, "fetch")) return true
  if (
    callee != null &&
    callee.type === "MemberExpression" &&
    callee.computed !== true &&
    (isIdentifier(callee.object, "globalThis") || isIdentifier(callee.object, "window")) &&
    isIdentifier(callee.property, "fetch")
  ) {
    return true
  }
  return false
}

function isNewPromise(node) {
  return isIdentifier(node.callee, "Promise")
}

function isJsonParse(node) {
  const callee = node.callee
  return (
    callee != null &&
    callee.type === "MemberExpression" &&
    callee.computed !== true &&
    isIdentifier(callee.object, "JSON") &&
    isIdentifier(callee.property, "parse")
  )
}

function isStubCall(node) {
  const callee = node.callee
  if (isIdentifier(callee, "stub")) return true
  return (
    callee != null &&
    callee.type === "MemberExpression" &&
    callee.computed !== true &&
    isIdentifier(callee.property, "stub")
  )
}

function isEffectFnCall(node) {
  const callee = node.callee
  return (
    callee != null &&
    callee.type === "MemberExpression" &&
    callee.computed !== true &&
    isIdentifier(callee.object, "Effect") &&
    isIdentifier(callee.property, "fn")
  )
}

function isEffectFnInvocation(node) {
  if (node == null || node.type !== "CallExpression") return false
  if (isEffectFnCall(node)) return true
  if (node.callee != null && node.callee.type === "CallExpression" && isEffectFnCall(node.callee))
    return true
  return false
}

function isUntracedEffectCall(node) {
  if (node == null || node.type !== "CallExpression") return false
  const callee = node.callee
  if (callee == null) return false
  if (
    callee.type === "MemberExpression" &&
    callee.computed !== true &&
    isIdentifier(callee.object, "Effect") &&
    (isIdentifier(callee.property, "fnUntraced") || isIdentifier(callee.property, "gen"))
  ) {
    return true
  }
  if (
    callee.type === "CallExpression" &&
    callee.callee != null &&
    callee.callee.type === "MemberExpression" &&
    callee.callee.computed !== true &&
    isIdentifier(callee.callee.object, "Effect") &&
    isIdentifier(callee.callee.property, "fnUntraced")
  ) {
    return true
  }
  return false
}

function isSecretConfigCall(node) {
  if (node == null || node.type !== "CallExpression") return false
  const callee = node.callee
  if (
    callee != null &&
    callee.type === "MemberExpression" &&
    callee.computed !== true &&
    isIdentifier(callee.object, "Config") &&
    (isIdentifier(callee.property, "string") || isIdentifier(callee.property, "nonEmptyString"))
  ) {
    const arg0 = node.arguments[0]
    if (
      arg0 != null &&
      arg0.type === "Literal" &&
      typeof arg0.value === "string" &&
      /(SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(arg0.value)
    ) {
      return true
    }
  }
  return false
}

function isSqlInterpolationCall(node) {
  if (node == null || node.type !== "CallExpression") return false
  const callee = node.callee
  if (
    callee != null &&
    callee.type === "MemberExpression" &&
    callee.computed !== true &&
    (isIdentifier(callee.property, "exec") || isIdentifier(callee.property, "prepare"))
  ) {
    const arg0 = node.arguments[0]
    if (
      arg0 != null &&
      arg0.type === "TemplateLiteral" &&
      Array.isArray(arg0.expressions) &&
      arg0.expressions.length > 0
    ) {
      return true
    }
  }
  return false
}

function hasScheduleForever(node) {
  if (node == null || typeof node !== "object") return false
  if (
    node.type === "MemberExpression" &&
    node.computed !== true &&
    isIdentifier(node.object, "Schedule") &&
    isIdentifier(node.property, "forever")
  ) {
    return true
  }
  for (const key of Object.keys(node)) {
    if (key === "parent") continue
    const val = node[key]
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item != null && typeof item === "object" && item.type) {
          if (hasScheduleForever(item)) return true
        }
      }
    } else if (val != null && typeof val === "object" && val.type) {
      if (hasScheduleForever(val)) return true
    }
  }
  return false
}

function isEffectRetryCall(node) {
  if (node == null || node.type !== "CallExpression") return false
  const callee = node.callee
  if (
    callee != null &&
    callee.type === "MemberExpression" &&
    callee.computed !== true &&
    isIdentifier(callee.object, "Effect") &&
    isIdentifier(callee.property, "retry")
  ) {
    return true
  }
  return false
}

const effectTsgoDisableMessage =
  "Suppressing `effecttsgo/*` (@effect/language-service) or `harness/*` diagnostics with oxlint-disable/eslint-disable/@effect-diagnostics is banned — fix the underlying violation instead."
const tsSuppressionMessage =
  "TypeScript suppression directives (@ts-ignore, @ts-expect-error, @ts-nocheck) are banned in production source files — fix the underlying type error instead."
const testTsIgnoreMessage =
  "Unconditional TypeScript suppression (@ts-ignore, @ts-nocheck) is banned in tests — fix the types or use @ts-expect-error with an explanation for negative type tests."
const testSkipOrOnlyMessage =
  "Skipping or focusing tests (.skip, .only, .todo) is banned by Three-Layer Test Defence (E4 §3) — fix the failing test or implementation instead of bypassing verification."

function isTestRunnerTarget(node) {
  if (node == null) return false
  if (
    node.type === "Identifier" &&
    (node.name === "it" ||
      node.name === "test" ||
      node.name === "describe" ||
      node.name === "suite" ||
      node.name === "vitest")
  ) {
    return true
  }
  if (node.type === "MemberExpression" && node.computed !== true) {
    return isTestRunnerTarget(node.object)
  }
  return false
}

function isSkippedOrFocusedTestCall(node) {
  if (node == null || node.type !== "CallExpression") return false
  const callee = node.callee
  if (
    callee != null &&
    callee.type === "MemberExpression" &&
    callee.computed !== true &&
    (isIdentifier(callee.property, "skip") ||
      isIdentifier(callee.property, "only") ||
      isIdentifier(callee.property, "todo") ||
      isIdentifier(callee.property, "skipIf") ||
      isIdentifier(callee.property, "runIf")) &&
    isTestRunnerTarget(callee.object)
  ) {
    return true
  }
  if (
    isIdentifier(callee, "xit") ||
    isIdentifier(callee, "xtest") ||
    isIdentifier(callee, "xdescribe") ||
    isIdentifier(callee, "fit") ||
    isIdentifier(callee, "fdescribe")
  ) {
    return true
  }
  return false
}

function unwrapTSParenthesizedType(typeNode) {
  let curr = typeNode
  while (curr != null && curr.type === "TSParenthesizedType" && curr.typeAnnotation != null) {
    curr = curr.typeAnnotation
  }
  return curr
}

function unwrapAssertionInnerExpression(expr) {
  let curr = expr
  while (
    curr != null &&
    (curr.type === "ParenthesizedExpression" || curr.type === "TSSatisfiesExpression") &&
    curr.expression != null
  ) {
    curr = curr.expression
  }
  return curr
}

function checkAsOrTypeAssertion(context, node) {
  const targetType = unwrapTSParenthesizedType(node.typeAnnotation)
  if (targetType != null && targetType.type === "TSNeverKeyword") {
    context.report({ node, message: unsafeNeverBanMessage })
  }
  const innerExpr = unwrapAssertionInnerExpression(node.expression)
  if (
    innerExpr != null &&
    (innerExpr.type === "TSAsExpression" || innerExpr.type === "TSTypeAssertion")
  ) {
    context.report({ node, message: doubleTypeAssertionBanMessage })
  }
}

function checkNeverVariableDeclarator(context, node) {
  if (node.id != null && node.id.typeAnnotation != null) {
    const targetType = unwrapTSParenthesizedType(node.id.typeAnnotation.typeAnnotation)
    if (targetType != null && targetType.type === "TSNeverKeyword") {
      context.report({ node, message: unsafeNeverBanMessage })
    }
  }
}

function checkNeverParams(context, node) {
  if (Array.isArray(node.params)) {
    for (const param of node.params) {
      if (param == null) continue
      const typeAnnotation =
        param.typeAnnotation != null
          ? param.typeAnnotation
          : param.type === "AssignmentPattern" && param.left != null
            ? param.left.typeAnnotation
            : param.type === "RestElement" && param.argument != null
              ? param.argument.typeAnnotation
              : null
      if (typeAnnotation != null) {
        const targetType = unwrapTSParenthesizedType(typeAnnotation.typeAnnotation)
        if (targetType != null && targetType.type === "TSNeverKeyword") {
          context.report({ node: param, message: unsafeNeverBanMessage })
        }
      }
    }
  }
}

const WF_FS_MODULES = new Set(["node:fs", "fs", "node:fs/promises", "fs/promises"])
const WF_CHILD_PROCESS_MODULES = new Set(["node:child_process", "child_process"])
const WF_NETWORK_MODULES = new Set(["node:http", "http", "node:https", "https", "node:net", "net"])
const WF_CRYPTO_MODULES = new Set(["node:crypto", "crypto"])
const WF_CRYPTO_RANDOM_EXPORTS = new Set([
  "randomUUID",
  "randomBytes",
  "randomInt",
  "randomFillSync",
  "getRandomValues",
])
const WF_OMNIGRAPH_IMPORTS = new Set([
  "OmnigraphClient",
  "createOmnigraphClient",
  "invokeStoredQuery",
  "invokeWorkflowStoreQuery",
  "invokeWorkflowStoreQueryWithMeta",
])
const WF_FS_DIRECT_CALLEES = new Set([
  "readFileSync",
  "writeFileSync",
  "appendFileSync",
  "mkdirSync",
  "rmSync",
  "unlinkSync",
  "readdirSync",
  "statSync",
  "existsSync",
  "readFile",
  "writeFile",
])
const WF_SUBPROCESS_DIRECT_CALLEES = new Set([
  "execFileSync",
  "spawnSync",
  "execSync",
  "execFile",
  "exec",
  "spawn",
  "execCheckedSubprocess",
])
const WF_NETWORK_MEMBER_CALLS = new Set([
  "http.request",
  "http.get",
  "https.request",
  "https.get",
  "net.connect",
  "net.createConnection",
])
const WF_OMNIGRAPH_METHODS = new Set(["invokeQuery", "runQuery", "executeQuery"])

function checkWorkflowBodyDeterminismEstree(programNode, filename, reportOnce) {
  if (programNode == null || !Array.isArray(programNode.body)) return
  if (typeof filename !== "string" || isTestFilePath(filename)) return
  if (!/(?:^|\/)(?:libs|apps)\/.*\/src\//.test(filename)) return

  const wfAliases = new Set(["Workflow"])
  const wfMakeAliases = new Set()
  const actAliases = new Set(["Activity"])
  const actMakeAliases = new Set()
  const engineAliases = new Set(["WorkflowEngine"])
  const effectAliases = new Set(["Effect"])
  const bannedBindings = new Map()
  const cryptoNsAliases = new Set(["crypto"])
  const fsNsAliases = new Set()
  const childProcessNsAliases = new Set()
  const netNsAliases = new Set()

  const recordBinding = (spec, localName, importedName) => {
    if (localName == null) return
    if (spec === "effect/workflow") {
      if (importedName === "Workflow") wfAliases.add(localName)
      if (importedName === "Activity") actAliases.add(localName)
      if (importedName === "WorkflowEngine") engineAliases.add(localName)
    } else if (spec === "effect/workflow/Workflow") {
      if (importedName === "make") wfMakeAliases.add(localName)
      if (importedName == null) wfAliases.add(localName)
    } else if (spec === "effect/workflow/Activity") {
      if (importedName === "make") actMakeAliases.add(localName)
      if (importedName == null) actAliases.add(localName)
    } else if (spec === "effect" && importedName === "Effect") {
      effectAliases.add(localName)
    } else if (spec === "effect/Effect" && importedName == null) {
      effectAliases.add(localName)
    }

    if (WF_FS_MODULES.has(spec)) {
      if (importedName == null) fsNsAliases.add(localName)
      bannedBindings.set(localName, "filesystem")
    } else if (WF_CHILD_PROCESS_MODULES.has(spec)) {
      if (importedName == null) childProcessNsAliases.add(localName)
      bannedBindings.set(localName, "subprocess")
    } else if (WF_NETWORK_MODULES.has(spec)) {
      if (importedName == null) netNsAliases.add(localName)
      bannedBindings.set(localName, "network")
    } else if (WF_CRYPTO_MODULES.has(spec)) {
      if (importedName == null) {
        cryptoNsAliases.add(localName)
      } else if (WF_CRYPTO_RANDOM_EXPORTS.has(importedName)) {
        bannedBindings.set(localName, "randomness")
      }
    }
    if (importedName != null && WF_OMNIGRAPH_IMPORTS.has(importedName)) {
      bannedBindings.set(localName, "omnigraph")
    }
  }

  for (const stmt of programNode.body) {
    if (stmt == null || stmt.type !== "ImportDeclaration" || stmt.importKind === "type") continue
    const spec = stmt.source && typeof stmt.source.value === "string" ? stmt.source.value : null
    if (spec == null || !Array.isArray(stmt.specifiers)) continue
    for (const s of stmt.specifiers) {
      if (s == null || s.importKind === "type") continue
      if (s.type === "ImportDefaultSpecifier" || s.type === "ImportNamespaceSpecifier") {
        recordBinding(spec, s.local?.name, undefined)
      } else if (s.type === "ImportSpecifier") {
        recordBinding(spec, s.local?.name, s.imported?.name ?? s.local?.name)
      }
    }
  }

  const unwrap = (node) => {
    let curr = node
    while (
      curr != null &&
      (curr.type === "TSAsExpression" ||
        curr.type === "TSTypeAssertion" ||
        curr.type === "TSSatisfiesExpression" ||
        curr.type === "TSNonNullExpression" ||
        curr.type === "ParenthesizedExpression" ||
        curr.type === "ChainExpression")
    ) {
      curr = curr.expression
    }
    return curr
  }

  const getMemberParts = (expr) => {
    const u = unwrap(expr)
    if (u == null || u.type !== "MemberExpression") return null
    if (u.computed !== true && u.property?.type === "Identifier") {
      return { receiver: unwrap(u.object), name: u.property.name }
    }
    if (u.computed === true) {
      const k = getStaticModuleString(u.property)
      if (k != null) return { receiver: unwrap(u.object), name: k }
    }
    return null
  }

  const getRootedName = (expr) => {
    const u = unwrap(expr)
    if (u == null) return null
    if (u.type === "Identifier") return u.name
    const m = getMemberParts(u)
    if (m == null) return null
    if (m.receiver?.type === "Identifier") {
      if (m.receiver.name === "globalThis") return m.name
      return `${m.receiver.name}.${m.name}`
    }
    const outer = getMemberParts(m.receiver)
    if (
      outer != null &&
      outer.receiver?.type === "Identifier" &&
      outer.receiver.name === "globalThis"
    ) {
      return `${outer.name}.${m.name}`
    }
    return null
  }

  const isWfMakeCall = (callNode) => {
    if (callNode == null || callNode.type !== "CallExpression") return false
    const callee = unwrap(callNode.callee)
    if (callee?.type === "Identifier") return wfMakeAliases.has(callee.name)
    const m = getMemberParts(callee)
    return (
      m != null &&
      m.name === "make" &&
      m.receiver?.type === "Identifier" &&
      wfAliases.has(m.receiver.name)
    )
  }

  const isActMakeCall = (callNode) => {
    if (callNode == null || callNode.type !== "CallExpression") return false
    const callee = unwrap(callNode.callee)
    if (callee?.type === "Identifier") return actMakeAliases.has(callee.name)
    const m = getMemberParts(callee)
    return (
      m != null &&
      m.name === "make" &&
      m.receiver?.type === "Identifier" &&
      actAliases.has(m.receiver.name)
    )
  }

  const declaredWorkflowVars = new Set()
  const isWorkflowReceiverExpr = (expr) => {
    const u = unwrap(expr)
    if (u?.type === "Identifier") return declaredWorkflowVars.has(u.name)
    if (u?.type === "CallExpression") return isWfMakeCall(u)
    return false
  }

  const isToLayerOrRegister = (callNode) => {
    const m = getMemberParts(callNode.callee)
    if (m == null) return false
    if (
      m.name === "toLayer" &&
      Array.isArray(callNode.arguments) &&
      callNode.arguments.length >= 1
    ) {
      return isWorkflowReceiverExpr(m.receiver)
    }
    return (
      m.name === "register" &&
      m.receiver?.type === "Identifier" &&
      engineAliases.has(m.receiver.name) &&
      Array.isArray(callNode.arguments) &&
      callNode.arguments.length >= 2
    )
  }

  const wfMakeCalls = []
  const toLayerCalls = []

  const visitAll = (node, fn) => {
    if (node == null || typeof node !== "object") return
    fn(node)
    for (const key of Object.keys(node)) {
      if (key === "parent" || key === "loc" || key === "range") continue
      const child = node[key]
      if (Array.isArray(child)) {
        for (const item of child) visitAll(item, fn)
      } else if (child != null && typeof child === "object" && child.type) {
        visitAll(child, fn)
      }
    }
  }

  visitAll(programNode, (n) => {
    if (n.type === "CallExpression" && isWfMakeCall(n)) wfMakeCalls.push(n)
    if (n.type === "VariableDeclarator" && n.id?.type === "Identifier" && n.init != null) {
      if (isWfMakeCall(unwrap(n.init))) declaredWorkflowVars.add(n.id.name)
    }
    if (
      n.type === "ClassDeclaration" &&
      n.id?.type === "Identifier" &&
      n.superClass != null &&
      isWorkflowReceiverExpr(n.superClass)
    ) {
      declaredWorkflowVars.add(n.id.name)
    }
  })

  if (wfMakeCalls.length === 0) return

  visitAll(programNode, (n) => {
    if (n.type === "CallExpression" && isToLayerOrRegister(n)) toLayerCalls.push(n)
  })

  const unwrapEffectFn = (expr) => {
    const u = unwrap(expr)
    if (
      u == null ||
      u.type !== "CallExpression" ||
      !Array.isArray(u.arguments) ||
      u.arguments.length === 0
    ) {
      return u
    }
    const callee = unwrap(u.callee)
    const m = getMemberParts(callee)
    if (
      m != null &&
      m.name === "fnUntraced" &&
      m.receiver?.type === "Identifier" &&
      effectAliases.has(m.receiver.name)
    ) {
      return unwrap(u.arguments[0])
    }
    if (callee != null && callee.type === "CallExpression") {
      const inner = getMemberParts(callee.callee)
      if (
        inner != null &&
        inner.name === "fn" &&
        inner.receiver?.type === "Identifier" &&
        effectAliases.has(inner.receiver.name)
      ) {
        return unwrap(u.arguments[0])
      }
    }
    return u
  }

  const localFunctions = new Map()
  const topStmts = new Set(programNode.body)
  const recordLocalFns = (stmt, isExportedStmt, currNode) => {
    if (currNode == null || typeof currNode !== "object") return
    if (
      currNode.type === "FunctionDeclaration" &&
      currNode.id?.type === "Identifier" &&
      currNode.body != null
    ) {
      localFunctions.set(currNode.id.name, {
        body: currNode.body,
        isExported: isExportedStmt && topStmts.has(currNode === stmt.declaration ? stmt : currNode),
        topStmt:
          currNode === stmt ||
          (stmt.type === "ExportNamedDeclaration" && stmt.declaration === currNode)
            ? stmt
            : null,
      })
    } else if (
      currNode.type === "VariableDeclarator" &&
      currNode.id?.type === "Identifier" &&
      currNode.init != null
    ) {
      const impl = unwrapEffectFn(currNode.init)
      if (
        impl != null &&
        (impl.type === "ArrowFunctionExpression" || impl.type === "FunctionExpression")
      ) {
        const declStmt =
          stmt.type === "ExportNamedDeclaration" && stmt.declaration?.type === "VariableDeclaration"
            ? stmt.declaration
            : stmt.type === "VariableDeclaration"
              ? stmt
              : null
        const isSingleTopDecl =
          declStmt != null &&
          Array.isArray(declStmt.declarations) &&
          declStmt.declarations.length === 1 &&
          declStmt.declarations[0] === currNode
        localFunctions.set(currNode.id.name, {
          body: impl.body,
          isExported: isExportedStmt && isSingleTopDecl,
          topStmt: isSingleTopDecl ? stmt : null,
        })
      }
    }
    for (const key of Object.keys(currNode)) {
      if (key === "parent" || key === "loc" || key === "range") continue
      const child = currNode[key]
      if (Array.isArray(child)) {
        for (const item of child) recordLocalFns(stmt, isExportedStmt, item)
      } else if (child != null && typeof child === "object" && child.type) {
        recordLocalFns(stmt, isExportedStmt, child)
      }
    }
  }
  for (const stmt of programNode.body) {
    if (stmt == null) continue
    const isExp = stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportDefaultDeclaration"
    recordLocalFns(stmt, isExp, stmt)
  }

  const getActivityPropName = (prop) => {
    if (prop != null && prop.type === "Property" && prop.computed !== true) {
      if (prop.key?.type === "Identifier") return prop.key.name
      if (prop.key?.type === "Literal" && typeof prop.key.value === "string") return prop.key.value
    }
    return null
  }

  const collectActivityOnlyFns = () => {
    const safeDirect = new Set()
    const unsafeDirect = new Set()
    const fnBodyRefs = new Map()
    const bodyToFn = new Map()
    for (const [name, info] of localFunctions) {
      bodyToFn.set(info.body, name)
      fnBodyRefs.set(name, new Set())
      if (info.isExported) unsafeDirect.add(name)
    }

    const walkRefs = (node, inSafe, enclosingFn) => {
      if (node == null || typeof node !== "object") return
      if (
        typeof node.type === "string" &&
        node.type.startsWith("TS") &&
        node.type !== "TSAsExpression" &&
        node.type !== "TSTypeAssertion" &&
        node.type !== "TSSatisfiesExpression" &&
        node.type !== "TSNonNullExpression"
      ) {
        return
      }
      if (node.type === "ImportDeclaration") return
      const nextFn = bodyToFn.get(node) ?? enclosingFn
      if (node.type === "ExportDefaultDeclaration") {
        const d = unwrap(node.declaration)
        if (d?.type === "Identifier" && localFunctions.has(d.name)) unsafeDirect.add(d.name)
      }
      if (node.type === "ExportNamedDeclaration" && Array.isArray(node.specifiers)) {
        for (const sp of node.specifiers) {
          const nm = sp?.local?.name
          if (nm != null && localFunctions.has(nm)) unsafeDirect.add(nm)
        }
      }
      if (node.type === "Identifier" && localFunctions.has(node.name)) {
        if (inSafe) safeDirect.add(node.name)
        else if (nextFn != null) fnBodyRefs.get(nextFn)?.add(node.name)
        else unsafeDirect.add(node.name)
        return
      }
      if (node.type === "CallExpression") {
        if (isActMakeCall(node)) {
          const arg0 = unwrap(node.arguments?.[0])
          if (arg0 != null && arg0.type === "ObjectExpression" && Array.isArray(arg0.properties)) {
            for (const prop of arg0.properties) {
              walkRefs(prop, inSafe || getActivityPropName(prop) === "execute", nextFn)
            }
            return
          }
        }
        const cm = getMemberParts(node.callee)
        if (cm?.name === "addFinalizer") {
          for (const arg of node.arguments ?? []) walkRefs(arg, true, nextFn)
          walkRefs(node.callee, inSafe, nextFn)
          return
        }
        if (
          cm?.name === "withCompensation" &&
          Array.isArray(node.arguments) &&
          node.arguments.length >= 2
        ) {
          node.arguments.forEach((arg, idx) => walkRefs(arg, idx === 1 ? true : inSafe, nextFn))
          walkRefs(node.callee, inSafe, nextFn)
          return
        }
      }
      if (node.type === "MemberExpression") {
        walkRefs(node.object, inSafe, nextFn)
        if (node.computed === true) walkRefs(node.property, inSafe, nextFn)
        return
      }
      if (node.type === "Property") {
        if (node.computed === true) walkRefs(node.key, inSafe, nextFn)
        walkRefs(node.value, inSafe, nextFn)
        return
      }
      if (node.type === "VariableDeclarator") {
        walkRefs(node.init, inSafe, nextFn)
        return
      }
      if (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression"
      ) {
        walkRefs(node.body, inSafe, nextFn)
        return
      }
      if (node.type === "LabeledStatement") {
        walkRefs(node.body, inSafe, nextFn)
        return
      }
      if (node.type === "BreakStatement" || node.type === "ContinueStatement") return
      if (node.type === "MethodDefinition" || node.type === "PropertyDefinition") {
        if (node.computed === true) walkRefs(node.key, inSafe, nextFn)
        walkRefs(node.value, inSafe, nextFn)
        return
      }
      if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
        walkRefs(node.superClass, inSafe, nextFn)
        walkRefs(node.body, inSafe, nextFn)
        return
      }
      for (const key of Object.keys(node)) {
        if (key === "parent" || key === "loc" || key === "range") continue
        const child = node[key]
        if (Array.isArray(child)) {
          for (const item of child) walkRefs(item, inSafe, nextFn)
        } else if (child != null && typeof child === "object" && child.type) {
          walkRefs(child, inSafe, nextFn)
        }
      }
    }
    walkRefs(programNode, false, null)

    const expand = (seeds) => {
      const out = new Set(seeds)
      const q = [...seeds]
      while (q.length > 0) {
        const curr = q.pop()
        for (const dep of fnBodyRefs.get(curr) ?? []) {
          if (!out.has(dep)) {
            out.add(dep)
            q.push(dep)
          }
        }
      }
      return out
    }
    const safeReach = expand(safeDirect)
    const unsafeReach = expand(unsafeDirect)
    const out = new Set()
    for (const name of safeReach) {
      if (!unsafeReach.has(name)) out.add(name)
    }
    return out
  }

  const visitedFunctions = new Set()
  const reportBody = (node, label, category) => {
    reportOnce(
      node,
      `[nondeterministic-workflow-body] Nondeterministic ${category} access '${label}' inside workflow body outside Activity.make({ execute: ... }) — move side effects, wall-clock reads, randomness, env, fs, git, Omnigraph, and network calls into Activity.make handlers.`,
    )
  }
  const reportCtor = (node, ctorName, prefix, suffix) => {
    if (ctorName === "Date") reportBody(node, `${prefix}Date${suffix}`, "wall-clock")
    else if (ctorName === "OmnigraphClient")
      reportBody(node, `${prefix}OmnigraphClient${suffix}`, "omnigraph")
    else if (ctorName === "WebSocket") reportBody(node, `${prefix}WebSocket${suffix}`, "network")
  }

  const walkBody = (node) => {
    if (node == null || typeof node !== "object") return
    if (
      typeof node.type === "string" &&
      node.type.startsWith("TS") &&
      node.type !== "TSAsExpression" &&
      node.type !== "TSTypeAssertion" &&
      node.type !== "TSSatisfiesExpression" &&
      node.type !== "TSNonNullExpression"
    ) {
      return
    }
    if (node.type === "ImportDeclaration") return

    if (isProcessEnvMemberAst(node)) {
      reportBody(node, "process.env", "environment")
      return
    }
    if (isProcessEnvDestructuringAst(node)) {
      reportBody(node, "process.env", "environment")
    }

    if (node.type === "NewExpression") {
      reportCtor(node, getRootedName(node.callee), "new ", "()")
    }

    if (node.type === "MemberExpression") {
      const qn = getRootedName(node)
      if (qn === "Date.now" || qn === "Date.parse" || qn === "Date.UTC") {
        reportBody(node, qn, "wall-clock")
        return
      }
      if (qn === "Math.random") {
        reportBody(node, qn, "randomness")
        return
      }
      if (
        qn != null &&
        qn.startsWith("crypto.") &&
        WF_CRYPTO_RANDOM_EXPORTS.has(qn.slice("crypto.".length))
      ) {
        reportBody(node, qn, "randomness")
        return
      }
      const m = getMemberParts(node)
      if (m != null && m.receiver?.type === "Identifier") {
        if (cryptoNsAliases.has(m.receiver.name) && WF_CRYPTO_RANDOM_EXPORTS.has(m.name)) {
          reportBody(node, `${m.receiver.name}.${m.name}`, "randomness")
          return
        }
        if (fsNsAliases.has(m.receiver.name)) {
          reportBody(node, `${m.receiver.name}.${m.name}`, "filesystem")
          return
        }
        if (childProcessNsAliases.has(m.receiver.name)) {
          reportBody(node, `${m.receiver.name}.${m.name}`, "subprocess")
          return
        }
        if (netNsAliases.has(m.receiver.name)) {
          reportBody(node, `${m.receiver.name}.${m.name}`, "network")
          return
        }
      }
      walkBody(node.object)
      if (node.computed === true) walkBody(node.property)
      return
    }

    if (node.type === "CallExpression") {
      if (isActMakeCall(node)) {
        const arg0 = unwrap(node.arguments?.[0])
        if (arg0 != null && arg0.type === "ObjectExpression" && Array.isArray(arg0.properties)) {
          for (const prop of arg0.properties) {
            if (getActivityPropName(prop) === "execute") continue
            walkBody(prop)
          }
          return
        }
      }

      const cm = getMemberParts(node.callee)
      if (cm != null && cm.name === "addFinalizer") return
      if (
        toLayerCalls.length === 0 &&
        cm != null &&
        cm.name === "toLayer" &&
        !isToLayerOrRegister(node)
      ) {
        return
      }
      if (cm != null && cm.name === "withCompensation") {
        if (
          Array.isArray(node.arguments) &&
          node.arguments.length >= 2 &&
          node.arguments[0] != null
        ) {
          walkBody(node.arguments[0])
        }
        return
      }

      const qn = getRootedName(node.callee)
      const calleeUnwrapped = unwrap(node.callee)
      const calleeTermName =
        calleeUnwrapped?.type === "Identifier" ? calleeUnwrapped.name : cm?.name
      const isGit =
        (calleeTermName != null &&
          (/^(?:exec|run|spawn)Git/i.test(calleeTermName) || /^gitExec/i.test(calleeTermName))) ||
        (calleeTermName != null &&
          WF_SUBPROCESS_DIRECT_CALLEES.has(calleeTermName) &&
          getStaticModuleString(unwrap(node.arguments?.[0])) === "git")

      if (qn === "Date") {
        reportBody(node, "Date()", "wall-clock")
      } else if (
        qn === "Reflect.get" &&
        node.arguments?.[0] != null &&
        node.arguments?.[1] != null &&
        isProcessTargetAst(node.arguments[0]) &&
        getStaticModuleString(unwrap(node.arguments[1])) === "env"
      ) {
        reportBody(node, 'Reflect.get(process, "env")', "environment")
      } else if (qn === "Reflect.construct" && node.arguments?.[0] != null) {
        reportCtor(node, getRootedName(node.arguments[0]), "", " (Reflect.construct)")
      } else if (qn === "fetch") {
        reportBody(node, "fetch()", "network")
      } else if (qn != null && WF_NETWORK_MEMBER_CALLS.has(qn)) {
        reportBody(node, `${qn}()`, "network")
      } else if (qn != null && WF_FS_DIRECT_CALLEES.has(qn)) {
        reportBody(node, `${qn}()`, "filesystem")
      } else if (isGit) {
        reportBody(node, qn ?? calleeTermName ?? "git", "git")
      } else if (qn != null && WF_SUBPROCESS_DIRECT_CALLEES.has(qn)) {
        reportBody(node, `${qn}()`, "subprocess")
      } else if (
        cm != null &&
        (WF_OMNIGRAPH_METHODS.has(cm.name) ||
          (cm.receiver?.type === "Identifier" && /omnigraph/i.test(cm.receiver.name)))
      ) {
        reportBody(node, `${cm.name}()`, "omnigraph")
      }

      if (calleeUnwrapped?.type === "Identifier") {
        const localInfo = localFunctions.get(calleeUnwrapped.name)
        if (localInfo != null && !visitedFunctions.has(calleeUnwrapped.name)) {
          visitedFunctions.add(calleeUnwrapped.name)
          walkBody(localInfo.body)
        }
      }
    }

    if (node.type === "Identifier") {
      const cat = bannedBindings.get(node.name)
      if (cat != null) {
        reportBody(node, node.name, cat)
        return
      }
      const localInfo = localFunctions.get(node.name)
      if (localInfo != null && !visitedFunctions.has(node.name)) {
        visitedFunctions.add(node.name)
        walkBody(localInfo.body)
      }
      return
    }

    if (node.type === "Property") {
      if (node.computed === true) walkBody(node.key)
      walkBody(node.value)
      return
    }

    if (node.type === "VariableDeclarator") {
      walkBody(node.init)
      return
    }

    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      walkBody(node.body)
      return
    }

    if (node.type === "LabeledStatement") {
      walkBody(node.body)
      return
    }
    if (node.type === "BreakStatement" || node.type === "ContinueStatement") return
    if (node.type === "MethodDefinition" || node.type === "PropertyDefinition") {
      if (node.computed === true) walkBody(node.key)
      walkBody(node.value)
      return
    }
    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      walkBody(node.superClass)
      walkBody(node.body)
      return
    }

    for (const key of Object.keys(node)) {
      if (key === "parent" || key === "loc" || key === "range") continue
      const child = node[key]
      if (Array.isArray(child)) {
        for (const item of child) walkBody(item)
      } else if (child != null && typeof child === "object" && child.type) {
        walkBody(child)
      }
    }
  }

  for (const wfCall of wfMakeCalls) {
    if (Array.isArray(wfCall.arguments) && wfCall.arguments[1] != null) {
      walkBody(wfCall.arguments[1])
    }
  }
  for (const regCall of toLayerCalls) {
    const m = getMemberParts(regCall.callee)
    const handler = m?.name === "register" ? regCall.arguments?.[1] : regCall.arguments?.[0]
    if (handler != null) walkBody(handler)
  }
  if (toLayerCalls.length === 0) {
    const activityOnlyFns = collectActivityOnlyFns()
    const skippedTopStmts = new Set()
    for (const fnName of activityOnlyFns) {
      const topStmt = localFunctions.get(fnName)?.topStmt
      if (topStmt != null) skippedTopStmts.add(topStmt)
    }
    for (const stmt of programNode.body) {
      if (stmt != null && stmt.type !== "ImportDeclaration" && !skippedTopStmts.has(stmt)) {
        walkBody(stmt)
      }
    }
  }
}

const CONTRACT_SCHEMA_CHAIN_METHODS = new Set(["pipe", "check", "annotate"])
const CONTRACT_STRING_BOUND_CALLS = new Set(["isTrimmed", "isPattern", "isMaxLength"])
const VITEST_HYGIENE_BASE_NAMES = new Set(["it", "test"])
const VITEST_HYGIENE_CURRIED_NAMES = new Set(["each", "for", "skipIf", "runIf"])
const VITEST_HYGIENE_NON_REGISTRATION_METHODS = new Set([...VITEST_HYGIENE_CURRIED_NAMES, "extend"])
const MAX_TEST_FILE_LINES = 1500
const MAX_TESTS_PER_FILE = 30

function walkEstreeChildren(node, fn) {
  if (node == null || typeof node !== "object") return
  for (const key of Object.keys(node)) {
    if (
      key === "parent" ||
      key === "loc" ||
      key === "range" ||
      key === "tokens" ||
      key === "comments"
    ) {
      continue
    }
    const val = node[key]
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item != null && typeof item === "object" && typeof item.type === "string") fn(item)
      }
    } else if (val != null && typeof val === "object" && typeof val.type === "string") {
      fn(val)
    }
  }
}

function unwrapEstreeTop(n) {
  let cur = n
  while (
    cur != null &&
    (cur.type === "TSAsExpression" ||
      cur.type === "TSTypeAssertion" ||
      cur.type === "TSSatisfiesExpression" ||
      cur.type === "TSNonNullExpression" ||
      cur.type === "ParenthesizedExpression")
  ) {
    cur = cur.expression
  }
  return cur
}

function isEstreeSchemaMember(expr, objName, propName) {
  const u = unwrapEstreeTop(expr)
  return (
    u != null &&
    u.type === "MemberExpression" &&
    u.computed !== true &&
    u.object?.type === "Identifier" &&
    u.object.name === objName &&
    u.property?.type === "Identifier" &&
    u.property.name === propName
  )
}

function checkContractShapeHardeningEstree(programNode, filename, report) {
  if (typeof filename !== "string" || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filename)) return
  if (!/(?:^|\/)libs\/[^/]+\/contract\/src\/.*\.ts$/.test(filename)) return
  const allowUnknownRecord = /(?:^|\/)wire-(?:adapter|envelope)\.ts$/.test(filename)
  const visitedChains = new Set()

  const isPipeParent = (parent) => {
    if (parent == null || parent.type !== "CallExpression") return false
    const c = unwrapEstreeTop(parent.callee)
    if (
      c != null &&
      c.type === "MemberExpression" &&
      c.computed !== true &&
      c.property?.type === "Identifier" &&
      CONTRACT_SCHEMA_CHAIN_METHODS.has(c.property.name)
    ) {
      return true
    }
    return c != null && c.type === "Identifier" && c.name === "pipe"
  }

  const resolveRootSchema = (chainRoot) => {
    let cur = chainRoot
    while (cur != null && cur.type === "CallExpression") {
      const c = unwrapEstreeTop(cur.callee)
      if (
        c != null &&
        isEstreeSchemaMember(c.callee, "Schema", "brand") &&
        getStaticModuleString(c.arguments?.[0]) != null &&
        cur.arguments?.[0] != null
      ) {
        cur = unwrapEstreeTop(cur.arguments[0])
        continue
      }
      if (
        c != null &&
        c.type === "MemberExpression" &&
        c.computed !== true &&
        c.property?.type === "Identifier" &&
        CONTRACT_SCHEMA_CHAIN_METHODS.has(c.property.name) &&
        c.object != null
      ) {
        cur = unwrapEstreeTop(c.object)
        continue
      }
      if (c != null && c.type === "Identifier" && c.name === "pipe" && cur.arguments?.[0] != null) {
        cur = unwrapEstreeTop(cur.arguments[0])
        continue
      }
      break
    }
    return cur
  }

  const hasBoundCall = (root) => {
    let found = false
    const walk = (n) => {
      if (found || n == null || typeof n !== "object") return
      if (n.type === "CallExpression") {
        const c = unwrapEstreeTop(n.callee)
        if (c?.type === "Identifier" && CONTRACT_STRING_BOUND_CALLS.has(c.name)) {
          found = true
          return
        }
        if (
          c?.type === "MemberExpression" &&
          c.computed !== true &&
          c.property?.type === "Identifier" &&
          CONTRACT_STRING_BOUND_CALLS.has(c.property.name)
        ) {
          found = true
          return
        }
      }
      walkEstreeChildren(n, walk)
    }
    walk(root)
    return found
  }

  const ancestors = []
  const visit = (node) => {
    if (node == null || typeof node !== "object") return
    if (node.type === "CallExpression") {
      if (
        isEstreeSchemaMember(node.callee, "Schema", "brand") &&
        getStaticModuleString(node.arguments?.[0]) != null
      ) {
        let chainRoot = null
        let child = node
        let idx = ancestors.length - 1
        while (idx >= 0) {
          const parent = ancestors[idx]
          if (parent == null) break
          if (parent.type === "ParenthesizedExpression" || parent.type === "ChainExpression") {
            child = unwrapEstreeTop(parent)
            idx--
            continue
          }
          if (
            chainRoot === null &&
            parent.type === "CallExpression" &&
            unwrapEstreeTop(parent.callee) === child
          ) {
            chainRoot = parent
            child = parent
            idx--
            continue
          }
          if (
            parent.type === "MemberExpression" &&
            parent.computed !== true &&
            parent.property?.type === "Identifier" &&
            CONTRACT_SCHEMA_CHAIN_METHODS.has(parent.property.name) &&
            unwrapEstreeTop(parent.object) === child &&
            ancestors[idx - 1]?.type === "CallExpression" &&
            unwrapEstreeTop(ancestors[idx - 1].callee) === parent
          ) {
            chainRoot = ancestors[idx - 1]
            child = chainRoot
            idx -= 2
            continue
          }
          if (isPipeParent(parent)) {
            const pCallee = unwrapEstreeTop(parent.callee)
            const isMethodOnChild =
              pCallee?.type === "MemberExpression" && unwrapEstreeTop(pCallee.object) === child
            const isPipeArg =
              (pCallee?.type === "Identifier" && pCallee.name === "pipe") ||
              (chainRoot === null && pCallee?.type === "MemberExpression")
            if (isMethodOnChild || isPipeArg) {
              chainRoot = parent
              child = parent
              idx--
              continue
            }
          }
          break
        }
        if (chainRoot != null && !visitedChains.has(chainRoot)) {
          visitedChains.add(chainRoot)
          const rootSchema = resolveRootSchema(chainRoot)
          const isUnboundedRoot =
            isEstreeSchemaMember(rootSchema, "Schema", "String") ||
            isEstreeSchemaMember(rootSchema, "Schema", "NonEmptyString")
          if (isUnboundedRoot && !hasBoundCall(chainRoot)) {
            report(
              node,
              `[contract-shape-hardening] Branded string schema in '${filename}' must constrain bounds with Schema.isTrimmed(), Schema.isPattern(...), or Schema.isMaxLength(...).`,
            )
          }
        }
      }
      if (!allowUnknownRecord && isEstreeSchemaMember(node.callee, "Schema", "Record")) {
        let keyArg = null
        let valArg = null
        if (Array.isArray(node.arguments) && node.arguments.length >= 2) {
          keyArg = node.arguments[0]
          valArg = node.arguments[1]
        } else if (
          Array.isArray(node.arguments) &&
          node.arguments.length === 1 &&
          unwrapEstreeTop(node.arguments[0])?.type === "ObjectExpression"
        ) {
          for (const prop of unwrapEstreeTop(node.arguments[0]).properties ?? []) {
            if (
              prop?.type !== "Property" ||
              prop.computed === true ||
              prop.key?.type !== "Identifier"
            ) {
              continue
            }
            if (prop.key.name === "key") keyArg = prop.value
            if (prop.key.name === "value") valArg = prop.value
          }
        }
        if (
          isEstreeSchemaMember(keyArg, "Schema", "String") &&
          isEstreeSchemaMember(valArg, "Schema", "Unknown")
        ) {
          report(
            node,
            `[contract-shape-hardening] Unguarded Schema.Record(Schema.String, Schema.Unknown) in '${filename}' is banned outside wire-adapter modules — use a named typed Struct or Schema.Record with branded keys and value schemas.`,
          )
        }
      }
    }
    ancestors.push(node)
    walkEstreeChildren(node, visit)
    ancestors.pop()
  }
  visit(programNode)
}

function isEstreeWorkflowMake(expr) {
  const u = unwrapEstreeTop(expr)
  if (u == null || u.type !== "CallExpression") return false
  const c = unwrapEstreeTop(u.callee)
  if (c == null || c.type !== "MemberExpression" || c.computed === true) return false
  if (c.property?.type !== "Identifier" || c.property.name !== "make") return false
  const recv = unwrapEstreeTop(c.object)
  return (
    (recv?.type === "Identifier" && recv.name === "Workflow") ||
    (recv?.type === "MemberExpression" &&
      recv.computed !== true &&
      recv.property?.type === "Identifier" &&
      recv.property.name === "Workflow")
  )
}

function checkWorkflowNameInsteadOfTagEstree(programNode, filename, report) {
  const wfDefNames = new Set()
  const wfNsImports = new Set()
  const collect = (node) => {
    if (node == null || typeof node !== "object") return
    if (node.type === "ImportDeclaration" && node.importKind !== "type") {
      const mod = node.source?.value
      const isWsOrRel =
        typeof mod === "string" && (mod.startsWith("@harness/") || mod.startsWith("."))
      if (isWsOrRel && Array.isArray(node.specifiers)) {
        for (const spec of node.specifiers) {
          if (spec == null || spec.importKind === "type") continue
          if (spec.type === "ImportNamespaceSpecifier" && spec.local?.name) {
            wfNsImports.add(spec.local.name)
          } else if (spec.type === "ImportSpecifier" && spec.local?.name) {
            const imp = spec.imported?.name ?? spec.local.name
            if (imp !== "Workflow" && /^[A-Z][A-Za-z0-9_]*Workflow$/.test(imp)) {
              wfDefNames.add(spec.local.name)
            }
          }
        }
      }
    } else if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      node.init != null
    ) {
      const init = unwrapEstreeTop(node.init)
      if (
        isEstreeWorkflowMake(init) ||
        (init?.type === "Identifier" && wfDefNames.has(init.name))
      ) {
        wfDefNames.add(node.id.name)
      }
    }
    walkEstreeChildren(node, collect)
  }
  collect(programNode)

  const isWfTarget = (expr) => {
    const u = unwrapEstreeTop(expr)
    if (u == null) return false
    if (u.type === "Identifier") return wfDefNames.has(u.name)
    if (isEstreeWorkflowMake(u)) return true
    return (
      u.type === "MemberExpression" &&
      u.computed !== true &&
      u.object?.type === "Identifier" &&
      wfNsImports.has(u.object.name) &&
      u.property?.type === "Identifier" &&
      u.property.name !== "Workflow" &&
      /^[A-Z][A-Za-z0-9_]*Workflow$/.test(u.property.name)
    )
  }

  const visit = (node) => {
    if (node == null || typeof node !== "object") return
    if (node.type === "MemberExpression") {
      const isNameProp =
        (node.computed !== true &&
          node.property?.type === "Identifier" &&
          node.property.name === "name") ||
        (node.computed === true && getStaticModuleString(node.property) === "name")
      if (isNameProp && isWfTarget(node.object)) {
        report(
          node,
          `[workflow-name-instead-of-tag] Do not read '.name' on a Workflow.make(...) definition in '${filename}' (evaluates to Function.prototype.name 'Workflow') — use '._tag' instead.`,
        )
      }
    }
    walkEstreeChildren(node, visit)
  }
  visit(programNode)
}

function isEstreeVitestChain(expr) {
  const u = unwrapEstreeTop(expr)
  if (u == null) return false
  if (u.type === "Identifier") return VITEST_HYGIENE_BASE_NAMES.has(u.name)
  if (u.type === "MemberExpression" && u.computed !== true) return isEstreeVitestChain(u.object)
  if (u.type === "CallExpression") {
    const inner = unwrapEstreeTop(u.callee)
    if (
      inner != null &&
      inner.type === "MemberExpression" &&
      inner.computed !== true &&
      inner.property?.type === "Identifier" &&
      VITEST_HYGIENE_CURRIED_NAMES.has(inner.property.name) &&
      isEstreeVitestChain(inner.object)
    ) {
      return true
    }
  }
  return false
}

function checkMaxTestCaseLinesEstree(programNode, filename, report) {
  if (typeof filename !== "string" || !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filename)) return
  const visit = (node) => {
    if (node == null || typeof node !== "object") return
    if (
      node.type === "CallExpression" &&
      isEstreeVitestChain(node.callee) &&
      Array.isArray(node.arguments)
    ) {
      for (const arg of node.arguments) {
        if (
          arg == null ||
          (arg.type !== "ArrowFunctionExpression" && arg.type !== "FunctionExpression")
        ) {
          continue
        }
        const s = arg.loc?.start?.line
        const e = arg.loc?.end?.line
        if (typeof s === "number" && typeof e === "number") {
          const lineSpan = e - s + 1
          if (lineSpan > 200) {
            report(
              node,
              `[max-test-case-lines] Test callback in '${filename}' spans ${lineSpan} lines (max 200) — split into focused helpers or separate it(...) blocks.`,
            )
            break
          }
        }
      }
    }
    walkEstreeChildren(node, visit)
  }
  visit(programNode)
}

function isEstreeVitestTestRegistrationCall(node) {
  if (
    node == null ||
    node.type !== "CallExpression" ||
    !isEstreeVitestChain(node.callee) ||
    !Array.isArray(node.arguments) ||
    node.arguments.length < 2
  ) {
    return false
  }
  const u = unwrapEstreeTop(node.callee)
  if (
    u != null &&
    u.type === "MemberExpression" &&
    u.computed !== true &&
    u.property?.type === "Identifier" &&
    VITEST_HYGIENE_NON_REGISTRATION_METHODS.has(u.property.name)
  ) {
    return false
  }
  return true
}

function checkMaxTestFileLinesEstree(programNode, text, filename, report) {
  if (typeof filename !== "string" || !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filename)) return
  if (typeof text !== "string" || text.length === 0) return
  const lineCount = text.split(/\r?\n/).length
  if (lineCount > MAX_TEST_FILE_LINES) {
    report(
      programNode,
      `[max-test-file-lines] Test file '${filename}' has ${lineCount} lines (max ${MAX_TEST_FILE_LINES}) — split tests by domain into focused *.test.ts files.`,
    )
  }
}

function checkMaxTestsPerFileEstree(programNode, filename, report) {
  if (typeof filename !== "string" || !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filename)) return
  let count = 0
  let overflowNode = null
  const visit = (node) => {
    if (node == null || typeof node !== "object") return
    if (isEstreeVitestTestRegistrationCall(node)) {
      count += 1
      if (count === MAX_TESTS_PER_FILE + 1) {
        overflowNode = node
      }
    }
    walkEstreeChildren(node, visit)
  }
  visit(programNode)
  if (count > MAX_TESTS_PER_FILE) {
    report(
      overflowNode ?? programNode,
      `[max-tests-per-file] Test file '${filename}' declares ${count} test cases (max ${MAX_TESTS_PER_FILE}) — split suites by domain into focused *.test.ts files for Vitest parallelism and targeted mutation reachability.`,
    )
  }
}

const WAVE3_CORE_SRC_RE =
  /(?:^|\/)libs\/(?:[^/]+\/core|harness\/(?:gates|graph|decision|ingest))\/src\//
const WAVE3_REF_RANGE_GIT_SUBCMDS = new Set([
  "diff",
  "rev-parse",
  "merge-base",
  "log",
  "show",
  "cat-file",
  "checkout",
  "branch",
  "tag",
  "worktree",
  "ls-files",
  "reset",
  "rev-list",
])
const WAVE3_GIT_TWO_TOKEN_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree"])
const WAVE3_CANONICAL_CLOSED_LITERAL_TYPES = new Set(
  [
    "AdrStatus AntiPatternRuleId AstGatePackageTag CanonicalCliCommandName CanonicalMcpToolName CascadeStageName",
    "CircuitBreakerStatus CodeModActionKind CodeModEngineKind ConceptKind ConceptLatticeErrorReason DaemonServerErrorKind",
    "DstExecutionTier DstHazardRiskLevel EarsClauseOutcomeKind EarsClausePatternKind EarsClausePolarity EarsConsistencyRuleId",
    "EarsConsistencyViolationKind EarsGuardPairRelation EarsPatternKind EarsStatus EmbeddingCacheErrorKind",
    "EmbeddingCacheOperation EmbeddingNodeKind EmbeddingUnavailableCause EntityNodeTag EscalationDecision FrictionEventKind",
    "FrictionLogState GateCategory GateVerdict GcFindingKind GovernanceDocKind GovernanceDocLifecycleStatus GovernanceDocStatus",
    "GraphRewriteErrorReason HttpMethod LatencyExceededDimension LayerKind MigrationEngineKind MutantCategory MutateDiffMode",
    "MutateEnforcementMode NxAffectedTargetFlag NxScopeTag NxTierTag OmnigraphChangeOp OmnigraphConfigDriftKind",
    "OmnigraphConflictKind OmnigraphDiagnosticSeverity OmnigraphEntityKind OmnigraphLintPolicy OmnigraphLintStatus",
    "OmnigraphReconcileReason PackageTag PackageVerifyExecutable PackageVerifyFailureKind PackageVerifyTarget RelationTag",
    "RemediationFindingSeverity ReviewDepth ReviewRoutingSource ReviewerId RewriteMode RewritePhase RewriteRuleCategory",
    "RuleSynthesisFailureStage RunnerId SelfDogfoodingRuleId ShipAttemptStatus ShipErrorTag ShipRunOrigin ShipStage",
    "SpanBudgetRuleId SpanBudgetViolationKind StageLatencyStatus StandardRoleName StdinReadErrorKind SubprocessFailureKind",
    "TelemetryCategory TelemetryEngineSource TelemetryOutcome TelemetrySurface TierTopologyRuleId VerificationStatus",
    "ViolationRule WorkflowAttemptVerdict WorkflowBackupMode WorkflowDoctorCheckStatus WorkflowDoctorMode WorkflowGqQueryName",
    "WorkflowLevel WorkflowProjectionStatus WorkflowRunState WorkflowStartOutcome WorkflowStoreAvailabilityState",
    "WorkflowUnitKind WorkflowUnitStatus WorkspaceFsOperation WorktreePathKind",
  ]
    .join(" ")
    .split(" "),
)

function isWave3ProdSrc(filename) {
  return (
    typeof filename === "string" &&
    !isTestFilePath(filename) &&
    !/(?:^|\/)test\/(?!fixtures\/)/.test(filename) &&
    /(?:^|\/)src\//.test(filename)
  )
}

function getEstreeStaticMemberName(memNode) {
  if (memNode == null || memNode.type !== "MemberExpression") return null
  if (memNode.computed !== true) {
    return memNode.property?.type === "Identifier" ? memNode.property.name : null
  }
  return getStaticModuleString(memNode.property)
}

function isWave3PureLoggingCallEstree(callNode, context, getEffectMemberName) {
  if (callNode == null || callNode.type !== "CallExpression") return false
  const c = unwrapEstreeExpr(callNode.callee)
  if (c == null) return false
  const effMethod = getEffectMemberName != null ? getEffectMemberName(c) : null
  if (effMethod != null && /^log(?:Debug|Info|Warning|Error|Fatal|Trace)?$/.test(effMethod)) {
    return true
  }
  if (c.type === "Identifier") {
    return c.name.startsWith("recordTelemetry")
  }
  if (c.type === "MemberExpression") {
    const txt = getNodeSourceText(context, c)
    return txt === "process.stderr.write"
  }
  return false
}

function getWave3UnwrappedPipeEstree(callNode) {
  if (callNode == null || callNode.type !== "CallExpression") return null
  const c = unwrapEstreeExpr(callNode.callee)
  if (c != null && c.type === "MemberExpression" && getEstreeStaticMemberName(c) === "pipe") {
    return { subject: c.object, ops: Array.isArray(callNode.arguments) ? callNode.arguments : [] }
  }
  if (
    c != null &&
    isIdentifier(c, "pipe") &&
    Array.isArray(callNode.arguments) &&
    callNode.arguments.length >= 2
  ) {
    return { subject: callNode.arguments[0], ops: callNode.arguments.slice(1) }
  }
  return null
}

function getWave3PipeStagesBeforeEstree(opNode) {
  const parent = opNode?.parent
  const piped = getWave3UnwrappedPipeEstree(parent)
  if (piped == null) return null
  const uOp = unwrapEstreeExpr(opNode)
  const idx = piped.ops.findIndex((o) => o === opNode || unwrapEstreeExpr(o) === uOp)
  if (idx === -1) return null
  return [piped.subject, ...piped.ops.slice(0, idx)]
}

function isWave3FnExprEstree(n) {
  return n != null && (n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression")
}

function isWave3TargetPureLoggingEstree(target, context, getEffectMemberName) {
  if (target == null) return false
  let hasLog = false
  let hasUnsafe = false
  const visit = (n) => {
    if (n == null || hasUnsafe) return
    if (
      n.type === "AssignmentExpression" ||
      n.type === "UpdateExpression" ||
      n.type === "ThrowStatement" ||
      n.type === "NewExpression" ||
      (n.type === "UnaryExpression" && n.operator === "delete")
    ) {
      hasUnsafe = true
      return
    }
    if (n.type === "CallExpression") {
      if (isWave3PureLoggingCallEstree(n, context, getEffectMemberName)) {
        hasLog = true
      } else {
        const effWrap = getEffectMemberName != null ? getEffectMemberName(n.callee) : null
        const isValidWrap =
          (effWrap === "sync" || effWrap === "try" || effWrap === "suspend" || effWrap === "tap") &&
          Array.isArray(n.arguments) &&
          n.arguments.length >= 1 &&
          isWave3FnExprEstree(unwrapEstreeExpr(n.arguments[0]))
        if (!isValidWrap) {
          hasUnsafe = true
          return
        }
      }
    }
    walkEstreeChildren(n, visit)
  }
  visit(target)
  return hasLog && !hasUnsafe
}

function areWave3AllStagesPureLoggingEstree(stages, context, getEffectMemberName) {
  return (
    Array.isArray(stages) &&
    stages.length > 0 &&
    stages.every((s) => isWave3TargetPureLoggingEstree(s, context, getEffectMemberName))
  )
}

function isWave3InsideFinalizerOrCompEstree(node, getEffectMemberName, scopeNamespaceNames) {
  let curr = node?.parent
  let child = node
  while (curr != null) {
    if (curr.type === "CallExpression" && Array.isArray(curr.arguments)) {
      const effMethod = getEffectMemberName != null ? getEffectMemberName(curr.callee) : null
      if (effMethod === "addFinalizer" && curr.arguments[0] === child) return true
      if (
        (effMethod === "onExit" ||
          effMethod === "ensuring" ||
          effMethod === "onInterrupt" ||
          effMethod === "acquireRelease") &&
        ((curr.arguments.length === 1 && curr.arguments[0] === child) ||
          (curr.arguments.length >= 2 && curr.arguments[1] === child))
      ) {
        return true
      }
      if (
        effMethod === "acquireUseRelease" &&
        curr.arguments.length >= 3 &&
        curr.arguments[2] === child
      ) {
        return true
      }
      const c = unwrapEstreeExpr(curr.callee)
      if (c != null && c.type === "MemberExpression") {
        const m = getEstreeStaticMemberName(c)
        const obj = unwrapEstreeExpr(c.object)
        const isScopeFin =
          m === "addFinalizer" && obj?.type === "Identifier" && scopeNamespaceNames.has(obj.name)
        if (
          (isScopeFin || m === "withCompensation") &&
          ((curr.arguments.length === 1 && curr.arguments[0] === child) ||
            (curr.arguments.length >= 2 && curr.arguments[1] === child))
        ) {
          return true
        }
      } else if (isIdentifier(c, "withCompensation")) {
        if (
          (curr.arguments.length === 1 && curr.arguments[0] === child) ||
          (curr.arguments.length >= 2 && curr.arguments[1] === child)
        ) {
          return true
        }
      }
    }
    if (
      curr.type === "FunctionDeclaration" &&
      curr.id?.name != null &&
      /compensat/i.test(curr.id.name)
    ) {
      return true
    }
    if (
      curr.type === "MethodDefinition" &&
      curr.key?.type === "Identifier" &&
      /compensat/i.test(curr.key.name)
    ) {
      return true
    }
    if (
      curr.type === "VariableDeclarator" &&
      curr.id?.type === "Identifier" &&
      /compensat/i.test(curr.id.name)
    ) {
      return true
    }
    child = curr
    curr = curr.parent
  }
  return false
}

function collectWave3BlockLocalsEstree(blockNode) {
  const locals = new Map()
  if (blockNode == null || !Array.isArray(blockNode.body)) return locals
  for (const stmt of blockNode.body) {
    if (stmt == null || stmt.type !== "VariableDeclaration" || !Array.isArray(stmt.declarations)) {
      continue
    }
    for (const d of stmt.declarations) {
      if (d?.id?.type === "Identifier" && d.init != null) locals.set(d.id.name, d.init)
    }
  }
  return locals
}

function resolveWave3LocalExprEstree(expr, locals, depth = 0) {
  const u = unwrapEstreeExpr(expr)
  if (u == null || depth >= 4 || u.type !== "Identifier") return u
  const next = locals.get(u.name)
  return next !== undefined ? resolveWave3LocalExprEstree(next, locals, depth + 1) : u
}

function isWave3EmptyOrVoidExprEstree(expr) {
  const u = unwrapEstreeExpr(expr)
  if (u == null) return false
  if (u.type === "Literal" && u.value === null) return true
  if (u.type === "UnaryExpression" && u.operator === "void") return true
  return u.type === "Identifier" && u.name === "undefined"
}

function isWave3EmptyOrVoidCallbackEstree(expr) {
  const fn = unwrapEstreeExpr(expr)
  if (!isWave3FnExprEstree(fn) || fn.body == null) return false
  if (fn.body.type !== "BlockStatement") return isWave3EmptyOrVoidExprEstree(fn.body)
  if (!Array.isArray(fn.body.body) || fn.body.body.length === 0) return true
  const locals = collectWave3BlockLocalsEstree(fn.body)
  let sawReturn = false
  let nonEmpty = false
  const visit = (n) => {
    if (n == null || nonEmpty) return
    if (
      n !== fn &&
      (n.type === "ArrowFunctionExpression" ||
        n.type === "FunctionExpression" ||
        n.type === "FunctionDeclaration")
    ) {
      return
    }
    if (n.type === "ReturnStatement") {
      sawReturn = true
      if (
        n.argument != null &&
        !isWave3EmptyOrVoidExprEstree(resolveWave3LocalExprEstree(n.argument, locals))
      ) {
        nonEmpty = true
      }
    }
    walkEstreeChildren(n, visit)
  }
  visit(fn.body)
  return (
    !nonEmpty &&
    (sawReturn ||
      fn.body.body.every(
        (s) => s != null && (s.type === "VariableDeclaration" || s.type === "EmptyStatement"),
      ))
  )
}

function isWave3SilentCatchCallbackEstree(expr, context, getEffectMemberName) {
  const fn = unwrapEstreeExpr(expr)
  if (!isWave3FnExprEstree(fn) || fn.body == null) return false

  const hasTopLevelUnconditionalLogOrFail = (node) => {
    const u = unwrapEstreeExpr(node)
    if (u == null) return false
    if (
      u.type === "ArrowFunctionExpression" ||
      u.type === "FunctionExpression" ||
      u.type === "FunctionDeclaration" ||
      u.type === "ConditionalExpression" ||
      u.type === "LogicalExpression"
    ) {
      return false
    }
    if (u.type === "YieldExpression" && u.argument != null) {
      return hasTopLevelUnconditionalLogOrFail(u.argument)
    }
    if (u.type === "CallExpression") {
      if (isWave3PureLoggingCallEstree(u, context, getEffectMemberName)) return true
      const effMethod = getEffectMemberName != null ? getEffectMemberName(u.callee) : null
      if (effMethod === "fail" || effMethod === "failCause" || effMethod === "die") return true
      return (
        Array.isArray(u.arguments) && u.arguments.some((a) => hasTopLevelUnconditionalLogOrFail(a))
      )
    }
    if (u.type === "VariableDeclaration" && Array.isArray(u.declarations)) {
      return u.declarations.some(
        (d) => d?.init != null && hasTopLevelUnconditionalLogOrFail(d.init),
      )
    }
    if (u.type === "ExpressionStatement") return hasTopLevelUnconditionalLogOrFail(u.expression)
    return false
  }

  const isSilentEff = (e, locals) => {
    const u = resolveWave3LocalExprEstree(e, locals)
    if (u == null) return false
    if (u.type === "YieldExpression" && u.argument != null) return isSilentEff(u.argument, locals)
    if (u.type === "ConditionalExpression") {
      return isSilentEff(u.consequent, locals) || isSilentEff(u.alternate, locals)
    }
    if (isWave3EmptyOrVoidExprEstree(u)) return true
    if (getEffectMemberName != null && getEffectMemberName(u) === "void") return true
    if (u.type !== "CallExpression") return false
    const effM = getEffectMemberName != null ? getEffectMemberName(u.callee) : null
    if (effM === "succeed") {
      return (
        u.arguments?.[0] == null ||
        isWave3EmptyOrVoidExprEstree(resolveWave3LocalExprEstree(u.arguments[0], locals))
      )
    }
    if (effM === "sync")
      return u.arguments?.[0] != null && isWave3EmptyOrVoidCallbackEstree(u.arguments[0])
    if (effM === "gen") {
      const gFn = u.arguments?.[0] != null ? unwrapEstreeExpr(u.arguments[0]) : null
      return gFn != null && isWave3FnExprEstree(gFn) && isSilentFnBody(gFn)
    }
    if (effM === "asVoid") {
      const inner =
        u.arguments?.[0] != null ? resolveWave3LocalExprEstree(u.arguments[0], locals) : null
      if (inner == null) return false
      const innerM =
        inner.type === "CallExpression" && getEffectMemberName != null
          ? getEffectMemberName(inner.callee)
          : null
      return isSilentEff(inner, locals) || innerM === "succeed" || innerM === "sync"
    }
    const piped = getWave3UnwrappedPipeEstree(u)
    if (
      piped != null &&
      piped.ops.some(
        (op) =>
          (getEffectMemberName != null && getEffectMemberName(op) === "asVoid") ||
          (op?.type === "CallExpression" &&
            getEffectMemberName != null &&
            getEffectMemberName(op.callee) === "asVoid"),
      )
    ) {
      const subj = resolveWave3LocalExprEstree(piped.subject, locals)
      const subjM =
        subj?.type === "CallExpression" && getEffectMemberName != null
          ? getEffectMemberName(subj.callee)
          : null
      return isSilentEff(subj, locals) || subjM === "succeed" || subjM === "sync"
    }
    return false
  }

  const checkStmtSeq = (stmts, locals, initialPriorLog) => {
    let priorLog = initialPriorLog
    let sawRet = false
    for (const s of stmts) {
      if (s == null) continue
      const res = checkStmt(s, locals, priorLog)
      if (res.hasSilent) return { hasSilent: true, sawRet: true, terminated: true }
      if (res.sawRet) sawRet = true
      if (res.terminated) return { hasSilent: false, sawRet, terminated: true }
      if (res.unconditionalLog) priorLog = true
    }
    return { hasSilent: false, sawRet, terminated: false }
  }

  const checkStmt = (stmt, locals, priorLog) => {
    if (stmt == null) {
      return { hasSilent: false, sawRet: false, terminated: false, unconditionalLog: false }
    }
    if (stmt.type === "ReturnStatement") {
      if (stmt.argument == null) {
        return { hasSilent: !priorLog, sawRet: true, terminated: true, unconditionalLog: false }
      }
      if (hasTopLevelUnconditionalLogOrFail(stmt.argument)) {
        return { hasSilent: false, sawRet: true, terminated: true, unconditionalLog: true }
      }
      return {
        hasSilent: !priorLog && isSilentEff(stmt.argument, locals),
        sawRet: true,
        terminated: true,
        unconditionalLog: false,
      }
    }
    if (stmt.type === "ThrowStatement") {
      return { hasSilent: false, sawRet: true, terminated: true, unconditionalLog: true }
    }
    if (stmt.type === "BlockStatement" && Array.isArray(stmt.body)) {
      const r = checkStmtSeq(stmt.body, locals, priorLog)
      return {
        hasSilent: r.hasSilent,
        sawRet: r.sawRet,
        terminated: r.terminated,
        unconditionalLog: false,
      }
    }
    if (stmt.type === "IfStatement") {
      const c = checkStmt(stmt.consequent, locals, priorLog)
      if (c.hasSilent) {
        return { hasSilent: true, sawRet: true, terminated: true, unconditionalLog: false }
      }
      const a = stmt.alternate != null ? checkStmt(stmt.alternate, locals, priorLog) : null
      if (a?.hasSilent) {
        return { hasSilent: true, sawRet: true, terminated: true, unconditionalLog: false }
      }
      return {
        hasSilent: false,
        sawRet: c.sawRet || Boolean(a?.sawRet),
        terminated: c.terminated && Boolean(a?.terminated),
        unconditionalLog: false,
      }
    }
    if (stmt.type === "SwitchStatement" && Array.isArray(stmt.cases)) {
      let anyRet = false
      for (const cs of stmt.cases) {
        const r = checkStmtSeq(Array.isArray(cs?.consequent) ? cs.consequent : [], locals, priorLog)
        if (r.hasSilent) {
          return { hasSilent: true, sawRet: true, terminated: true, unconditionalLog: false }
        }
        if (r.sawRet) anyRet = true
      }
      return { hasSilent: false, sawRet: anyRet, terminated: false, unconditionalLog: false }
    }
    if (stmt.type === "TryStatement") {
      const b = checkStmt(stmt.block, locals, priorLog)
      if (b.hasSilent) {
        return { hasSilent: true, sawRet: true, terminated: true, unconditionalLog: false }
      }
      const h = stmt.handler != null ? checkStmt(stmt.handler.body, locals, priorLog) : null
      if (h?.hasSilent) {
        return { hasSilent: true, sawRet: true, terminated: true, unconditionalLog: false }
      }
      const f = stmt.finalizer != null ? checkStmt(stmt.finalizer, locals, priorLog) : null
      if (f?.hasSilent) {
        return { hasSilent: true, sawRet: true, terminated: true, unconditionalLog: false }
      }
      return {
        hasSilent: false,
        sawRet: b.sawRet || Boolean(h?.sawRet) || Boolean(f?.sawRet),
        terminated: false,
        unconditionalLog: false,
      }
    }
    if (
      stmt.type === "WhileStatement" ||
      stmt.type === "DoWhileStatement" ||
      stmt.type === "ForStatement" ||
      stmt.type === "ForOfStatement" ||
      stmt.type === "ForInStatement" ||
      stmt.type === "LabeledStatement"
    ) {
      const r = checkStmt(stmt.body, locals, priorLog)
      return {
        hasSilent: r.hasSilent,
        sawRet: r.sawRet,
        terminated: false,
        unconditionalLog: false,
      }
    }
    return {
      hasSilent: false,
      sawRet: false,
      terminated: false,
      unconditionalLog: hasTopLevelUnconditionalLogOrFail(stmt),
    }
  }

  const isSilentFnBody = (targetFn) => {
    if (targetFn.body == null) return false
    if (targetFn.body.type !== "BlockStatement") {
      return (
        !hasTopLevelUnconditionalLogOrFail(targetFn.body) && isSilentEff(targetFn.body, new Map())
      )
    }
    if (!Array.isArray(targetFn.body.body) || targetFn.body.body.length === 0) return true
    const locals = collectWave3BlockLocalsEstree(targetFn.body)
    const r = checkStmtSeq(targetFn.body.body, locals, false)
    if (r.hasSilent) return true
    if (r.sawRet) return false
    return targetFn.body.body.every(
      (s) => s != null && (s.type === "VariableDeclaration" || s.type === "EmptyStatement"),
    )
  }

  return isSilentFnBody(fn)
}

function unwrapWave3NullishTypePartsEstree(tsTypeNode) {
  if (tsTypeNode == null) return []
  if (tsTypeNode.type === "TSParenthesizedType")
    return unwrapWave3NullishTypePartsEstree(tsTypeNode.typeAnnotation)
  if (tsTypeNode.type !== "TSUnionType" || !Array.isArray(tsTypeNode.types)) return [tsTypeNode]
  return tsTypeNode.types.filter(
    (t) =>
      t != null &&
      t.type !== "TSUndefinedKeyword" &&
      t.type !== "TSNullKeyword" &&
      !(t.type === "TSLiteralType" && t.literal?.type === "Literal" && t.literal.value === null),
  )
}

function isWave3ClosedStringUnionTypeEstree(tsTypeNode, closedTypeNames) {
  if (tsTypeNode == null) return false
  if (tsTypeNode.type === "TSParenthesizedType") {
    return isWave3ClosedStringUnionTypeEstree(tsTypeNode.typeAnnotation, closedTypeNames)
  }
  if (tsTypeNode.type === "TSTypeReference" && tsTypeNode.typeName?.type === "Identifier") {
    return closedTypeNames.has(tsTypeNode.typeName.name)
  }
  if (
    tsTypeNode.type === "TSTypeQuery" &&
    tsTypeNode.exprName?.type === "TSQualifiedName" &&
    tsTypeNode.exprName.left?.type === "Identifier" &&
    tsTypeNode.exprName.right?.name === "Type"
  ) {
    return closedTypeNames.has(tsTypeNode.exprName.left.name)
  }
  if (tsTypeNode.type === "TSUnionType" && Array.isArray(tsTypeNode.types)) {
    const nonNullish = unwrapWave3NullishTypePartsEstree(tsTypeNode)
    if (nonNullish.length === 1) {
      return isWave3ClosedStringUnionTypeEstree(nonNullish[0], closedTypeNames)
    }
    if (nonNullish.length >= 2) {
      return nonNullish.every(
        (t) =>
          t.type === "TSLiteralType" &&
          t.literal?.type === "Literal" &&
          typeof t.literal.value === "string",
      )
    }
  }
  return false
}

function hasWave3GlobWordSegmentEstree(text) {
  if (typeof text !== "string" || text.length === 0) return false
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .some((tok) => /^globs?\d*$/i.test(tok))
}

function isWave3BackslashEscaperFnEstree(expr) {
  const fn = unwrapEstreeExpr(expr)
  if (
    !isWave3FnExprEstree(fn) ||
    !Array.isArray(fn.params) ||
    fn.params[0]?.type !== "Identifier"
  ) {
    return false
  }
  const pName = fn.params[0].name
  let body = null
  if (fn.body?.type !== "BlockStatement") {
    body = unwrapEstreeExpr(fn.body)
  } else if (
    Array.isArray(fn.body.body) &&
    fn.body.body.length === 1 &&
    fn.body.body[0]?.type === "ReturnStatement"
  ) {
    body = unwrapEstreeExpr(fn.body.body[0].argument)
  }
  if (body == null) return false
  if (body.type === "BinaryExpression" && body.operator === "+") {
    const r = unwrapEstreeExpr(body.right)
    return getStaticModuleString(body.left) === "\\" && r?.type === "Identifier" && r.name === pName
  }
  if (
    body.type === "TemplateLiteral" &&
    body.expressions?.length === 1 &&
    body.quasis?.length === 2
  ) {
    const s = unwrapEstreeExpr(body.expressions[0])
    const head = body.quasis[0]?.value?.cooked ?? body.quasis[0]?.value?.raw ?? ""
    const tail = body.quasis[1]?.value?.cooked ?? body.quasis[1]?.value?.raw ?? ""
    return head === "\\" && tail === "" && s?.type === "Identifier" && s.name === pName
  }
  return false
}

function isWave3GlobWildcardPatEstree(expr) {
  const lit = getStaticModuleString(expr)
  if (lit != null) return /[*?]/.test(lit)
  const u = unwrapEstreeExpr(expr)
  if (u == null || u.type !== "Literal" || !(u.regex != null || u.value instanceof RegExp)) {
    return false
  }
  const pat = typeof u.regex?.pattern === "string" ? u.regex.pattern : (u.value?.source ?? "")
  return /(?:\\\*|\\\?(?![A-Za-z]))/.test(pat) || /\[(?:\\?[*?])+\]/.test(pat)
}

function hasWave3GlobReplaceChainEstree(expr) {
  let found = false
  const visit = (n) => {
    if (n == null || found) return
    if (n.type === "CallExpression" && Array.isArray(n.arguments)) {
      const c = unwrapEstreeExpr(n.callee)
      if (c != null && c.type === "MemberExpression") {
        const m = getEstreeStaticMemberName(c)
        if ((m === "replace" || m === "replaceAll") && n.arguments.length >= 2) {
          const repStr = getStaticModuleString(n.arguments[1])
          if (
            repStr !== "\\$&" &&
            !isWave3BackslashEscaperFnEstree(n.arguments[1]) &&
            isWave3GlobWildcardPatEstree(n.arguments[0])
          ) {
            found = true
            return
          }
        }
        if (m === "join") {
          const inner = unwrapEstreeExpr(c.object)
          if (
            inner?.type === "CallExpression" &&
            Array.isArray(inner.arguments) &&
            inner.arguments.length >= 1
          ) {
            const innerC = unwrapEstreeExpr(inner.callee)
            if (
              getEstreeStaticMemberName(innerC) === "split" &&
              isWave3GlobWildcardPatEstree(inner.arguments[0])
            ) {
              found = true
              return
            }
          }
        }
      }
    }
    walkEstreeChildren(n, visit)
  }
  visit(expr)
  return found
}

function evalWave3StaticSentinelEstree(expr) {
  const u = unwrapEstreeExpr(expr)
  if (u == null) return null
  const lit = getStaticModuleString(u)
  if (lit != null) {
    if (/^0+$/.test(lit)) return lit.length
    if (/^[fF]+$/.test(lit)) return -lit.length
    return null
  }
  if (u.type === "BinaryExpression" && u.operator === "+") {
    const l = evalWave3StaticSentinelEstree(u.left)
    const r = evalWave3StaticSentinelEstree(u.right)
    return l != null && r != null && l * r > 0 ? l + r : null
  }
  if (u.type !== "CallExpression" || !Array.isArray(u.arguments)) return null
  const c = unwrapEstreeExpr(u.callee)
  const m = getEstreeStaticMemberName(c)
  if (m == null) return null
  if (m === "repeat" && u.arguments.length === 1) {
    const recv = evalWave3StaticSentinelEstree(c.object)
    const cnt = unwrapEstreeExpr(u.arguments[0])
    return recv != null && cnt?.type === "Literal" && typeof cnt.value === "number"
      ? recv * cnt.value
      : null
  }
  if ((m === "padStart" || m === "padEnd") && u.arguments.length === 2) {
    const lenNode = unwrapEstreeExpr(u.arguments[0])
    const fill = evalWave3StaticSentinelEstree(u.arguments[1])
    const recvText = getStaticModuleString(c.object)
    if (
      lenNode?.type !== "Literal" ||
      typeof lenNode.value !== "number" ||
      fill == null ||
      recvText == null
    ) {
      return null
    }
    if (recvText === "") return fill > 0 ? lenNode.value : -lenNode.value
    const recv = evalWave3StaticSentinelEstree(c.object)
    return recv != null && recv * fill > 0 && lenNode.value >= Math.abs(recv)
      ? fill > 0
        ? lenNode.value
        : -lenNode.value
      : null
  }
  if (m === "join" && u.arguments.length === 1 && getStaticModuleString(u.arguments[0]) === "") {
    const fc = unwrapEstreeExpr(c.object)
    if (fc?.type !== "CallExpression" || !Array.isArray(fc.arguments) || fc.arguments.length !== 1)
      return null
    const fm = unwrapEstreeExpr(fc.callee)
    if (getEstreeStaticMemberName(fm) !== "fill") return null
    const fill = evalWave3StaticSentinelEstree(fc.arguments[0])
    const arr = unwrapEstreeExpr(fm.object)
    if (
      fill == null ||
      arr == null ||
      (arr.type !== "CallExpression" && arr.type !== "NewExpression") ||
      !Array.isArray(arr.arguments) ||
      arr.arguments.length !== 1
    ) {
      return null
    }
    const ctor = unwrapEstreeExpr(arr.callee)
    const lenArg = unwrapEstreeExpr(arr.arguments[0])
    return isIdentifier(ctor, "Array") &&
      lenArg?.type === "Literal" &&
      typeof lenArg.value === "number"
      ? fill * lenArg.value
      : null
  }
  return null
}

const syntaxBans = {
  create(context) {
    const discriminantAliasNames = createDiscriminantAliasTracker()
    const schemaVarNames = new Set()
    const brandedTypeNames = new Set()
    const unbrandedSchemaVarNames = new Map()
    const declaredBrandKeys = new Map()
    const migrationRecordVars = new Map()
    const allowedDdlTemplateNodes = new Set()
    const effectModuleNamespaceNames = new Set()
    const effectNamespaceNames = new Set(["Effect"])
    const effectMethodAliases = new Map()
    const scopeNamespaceNames = new Set(["Scope"])
    const bannedRunAliases = new Map()
    const wave3ClosedTypeNames = new Set(WAVE3_CANONICAL_CLOSED_LITERAL_TYPES)
    const wave3ClosedPropsByType = new Map()
    const wave3FnReturnTypes = new Map()
    const WAVE3_OPEN_INFO = { isClosed: false, typeName: null, inlineProps: null }
    const WAVE3_CLOSED_INFO = { isClosed: true, typeName: null, inlineProps: null }
    const wave3VarScopes = [
      { isFnBoundary: true, vars: new Map(), globs: new Set(), gitArgs: new Map() },
    ]
    const pushWave3Scope = (isFnBoundary = false) =>
      wave3VarScopes.push({ isFnBoundary, vars: new Map(), globs: new Set(), gitArgs: new Map() })
    const popWave3Scope = () => {
      if (wave3VarScopes.length > 1) wave3VarScopes.pop()
    }
    const recordWave3Var = (name, info, hoistToFn = false) => {
      if (!hoistToFn) {
        wave3VarScopes[wave3VarScopes.length - 1].vars.set(name, info)
        return
      }
      for (let i = wave3VarScopes.length - 1; i >= 0; i--) {
        if (wave3VarScopes[i].isFnBoundary) {
          wave3VarScopes[i].vars.set(name, info)
          return
        }
      }
    }
    const recordWave3GlobVar = (name, hoistToFn = false) => {
      if (!hoistToFn) {
        wave3VarScopes[wave3VarScopes.length - 1].globs.add(name)
        return
      }
      for (let i = wave3VarScopes.length - 1; i >= 0; i--) {
        if (wave3VarScopes[i].isFnBoundary) {
          wave3VarScopes[i].globs.add(name)
          return
        }
      }
    }
    const recordWave3GitArgVar = (name, arrNode, hoistToFn = false) => {
      if (!hoistToFn) {
        wave3VarScopes[wave3VarScopes.length - 1].gitArgs.set(name, arrNode)
        return
      }
      for (let i = wave3VarScopes.length - 1; i >= 0; i--) {
        if (wave3VarScopes[i].isFnBoundary) {
          wave3VarScopes[i].gitArgs.set(name, arrNode)
          return
        }
      }
    }
    const lookupWave3Var = (name) => {
      for (let i = wave3VarScopes.length - 1; i >= 0; i--) {
        const val = wave3VarScopes[i].vars.get(name)
        if (val !== undefined) return val
      }
      return undefined
    }
    const isWave3GlobVar = (name) => wave3VarScopes.some((s) => s.globs.has(name))
    const resolveWave3GitArgs = (expr) => {
      const u = unwrapEstree(expr)
      if (u == null) return null
      if (u.type === "ArrayExpression") return u
      if (u.type !== "Identifier") return null
      for (let i = wave3VarScopes.length - 1; i >= 0; i--) {
        const f = wave3VarScopes[i].gitArgs.get(u.name)
        if (f !== undefined) return f
      }
      return null
    }
    let hasSqliteMigratorImport = false
    const reportedNodes = new WeakSet()

    const unwrapEstree = (n) => {
      let cur = n
      while (
        cur != null &&
        (cur.type === "TSAsExpression" ||
          cur.type === "TSTypeAssertion" ||
          cur.type === "TSSatisfiesExpression" ||
          cur.type === "TSNonNullExpression" ||
          cur.type === "ParenthesizedExpression")
      ) {
        cur = cur.expression
      }
      return cur
    }

    const isEffectNamespaceExpr = (expr) => {
      const u = unwrapEstree(expr)
      if (u == null) return false
      if (u.type === "Identifier") return effectNamespaceNames.has(u.name)
      if (u.type === "MemberExpression") {
        const propName = getEstreeStaticMemberName(u)
        if (propName === "Effect") {
          const inner = unwrapEstree(u.object)
          return (
            inner != null &&
            inner.type === "Identifier" &&
            effectModuleNamespaceNames.has(inner.name)
          )
        }
      }
      return false
    }

    const getWave3EffectMemberName = (expr) => {
      const u = unwrapEstree(expr)
      if (u == null) return null
      if (u.type === "Identifier") return effectMethodAliases.get(u.name) ?? null
      if (u.type === "MemberExpression" && isEffectNamespaceExpr(u.object)) {
        return getEstreeStaticMemberName(u)
      }
      return null
    }

    const isWave3SchemaLiteralsEstree = (init) => {
      const target = unwrapPipeTargetEstree(init)
      if (target == null || target.type !== "CallExpression") return false
      if (getCalleeName(target.callee) !== "Schema.Literals") return false
      const arg0 = unwrapEstree(target.arguments?.[0])
      if (arg0 == null || arg0.type !== "ArrayExpression" || !Array.isArray(arg0.elements)) {
        return false
      }
      return (
        arg0.elements.filter((el) => el != null && getStaticModuleString(unwrapEstree(el)) != null)
          .length >= 2
      )
    }

    const resolveWave3TypeNodeInfo = (tsTypeNode) => {
      if (tsTypeNode == null) return WAVE3_OPEN_INFO
      if (isWave3ClosedStringUnionTypeEstree(tsTypeNode, wave3ClosedTypeNames)) {
        return WAVE3_CLOSED_INFO
      }
      const parts = unwrapWave3NullishTypePartsEstree(tsTypeNode)
      if (parts.length !== 1) return WAVE3_OPEN_INFO
      let single = parts[0]
      while (
        single?.type === "TSParenthesizedType" ||
        (single?.type === "TSTypeReference" &&
          single.typeName?.type === "Identifier" &&
          single.typeName.name === "Readonly" &&
          single.typeParameters?.params?.[0] != null)
      ) {
        single =
          single.type === "TSParenthesizedType"
            ? single.typeAnnotation
            : single.typeParameters.params[0]
      }
      if (single != null && isWave3ClosedStringUnionTypeEstree(single, wave3ClosedTypeNames)) {
        return WAVE3_CLOSED_INFO
      }
      if (single?.type === "TSTypeReference" && single.typeName?.type === "Identifier") {
        if (wave3ClosedPropsByType.has(single.typeName.name)) {
          return { isClosed: false, typeName: single.typeName.name, inlineProps: null }
        }
      }
      if (single?.type === "TSTypeLiteral" && Array.isArray(single.members)) {
        const inlineProps = new Map()
        for (const mem of single.members) {
          if (mem?.type === "TSPropertySignature" && mem.key?.type === "Identifier") {
            const info = resolveWave3TypeNodeInfo(mem.typeAnnotation?.typeAnnotation)
            if (info.isClosed || info.typeName != null || info.inlineProps != null) {
              inlineProps.set(mem.key.name, info)
            }
          }
        }
        if (inlineProps.size > 0) return { isClosed: false, typeName: null, inlineProps }
      }
      return WAVE3_OPEN_INFO
    }

    const recordWave3TypeMembers = (typeName, members) => {
      if (!Array.isArray(members)) return
      const propMap = wave3ClosedPropsByType.get(typeName) ?? new Map()
      for (const mem of members) {
        if (mem?.type === "TSPropertySignature" && mem.key?.type === "Identifier") {
          const info = resolveWave3TypeNodeInfo(mem.typeAnnotation?.typeAnnotation)
          if (info.isClosed || info.typeName != null || info.inlineProps != null) {
            propMap.set(mem.key.name, info)
          }
        }
      }
      if (propMap.size > 0) wave3ClosedPropsByType.set(typeName, propMap)
    }

    const resolveWave3ExprInfo = (expr) => {
      const u = unwrapEstree(expr)
      if (u == null || u.type === "UnaryExpression") return WAVE3_OPEN_INFO
      if (u.type === "Identifier") return lookupWave3Var(u.name) ?? WAVE3_OPEN_INFO
      if (u.type === "CallExpression") {
        const c = unwrapEstree(u.callee)
        if (c?.type === "Identifier") return wave3FnReturnTypes.get(c.name) ?? WAVE3_OPEN_INFO
      }
      if (u.type === "MemberExpression") {
        const propName = getEstreeStaticMemberName(u)
        if (propName != null) {
          const recv = resolveWave3ExprInfo(u.object)
          if (recv.inlineProps != null) return recv.inlineProps.get(propName) ?? WAVE3_OPEN_INFO
          if (recv.typeName != null) {
            return wave3ClosedPropsByType.get(recv.typeName)?.get(propName) ?? WAVE3_OPEN_INFO
          }
        }
      }
      return WAVE3_OPEN_INFO
    }

    const bindWave3Pattern = (pat, info, hoist) => {
      if (pat == null) return
      if (pat.type === "AssignmentPattern") {
        bindWave3Pattern(pat.left, info, hoist)
        return
      }
      if (pat.type === "Identifier") {
        recordWave3Var(pat.name, info, hoist)
        return
      }
      if (pat.type === "ObjectPattern" && Array.isArray(pat.properties)) {
        for (const prop of pat.properties) {
          if (prop == null || prop.type !== "Property") continue
          const keyName = getEstreeBindingPropName(prop)
          const propInfo =
            keyName == null
              ? WAVE3_OPEN_INFO
              : (info.inlineProps?.get(keyName) ??
                (info.typeName != null
                  ? wave3ClosedPropsByType.get(info.typeName)?.get(keyName)
                  : undefined) ??
                WAVE3_OPEN_INFO)
          bindWave3Pattern(prop.value, propInfo, hoist)
        }
      }
    }

    const checkWave3SentinelEstree = (node, filename) => {
      if (!isWave3ProdSrc(filename)) return
      if (Math.abs(evalWave3StaticSentinelEstree(node) ?? 0) !== 64) return
      for (let p = node.parent; p != null; p = p.parent) {
        const pt = p.type
        if (
          pt !== "BinaryExpression" &&
          pt !== "CallExpression" &&
          pt !== "MemberExpression" &&
          pt !== "NewExpression" &&
          pt !== "TSAsExpression" &&
          pt !== "TSTypeAssertion" &&
          pt !== "TSNonNullExpression" &&
          pt !== "ParenthesizedExpression"
        ) {
          break
        }
        if (unwrapEstree(p) === p && Math.abs(evalWave3StaticSentinelEstree(p) ?? 0) === 64) {
          return
        }
      }
      reportOnce(
        node,
        `[fabricated-sentinel-hash] Fabricated 64-character sentinel hash in '${filename}' is banned — use ContentSha256 or Option/Error.`,
      )
    }

    const checkWave3RegExpEstree = (node, filename) => {
      if (
        !isWave3ProdSrc(filename) ||
        !Array.isArray(node.arguments) ||
        node.arguments.length < 1
      ) {
        return
      }
      const ctor = unwrapEstree(node.callee)
      const isGlobalThisRegExp =
        ctor?.type === "MemberExpression" &&
        isIdentifier(unwrapEstree(ctor.object), "globalThis") &&
        getEstreeStaticMemberName(ctor) === "RegExp"
      if (!isIdentifier(ctor, "RegExp") && !isGlobalThisRegExp) return
      const arg0 = unwrapEstree(node.arguments[0])
      if (arg0 == null || getStaticModuleString(arg0) != null) return
      let hasGlobIdent = false
      const findGlobId = (n) => {
        if (n == null || hasGlobIdent) return
        if (
          n.type === "Identifier" &&
          (isWave3GlobVar(n.name) || hasWave3GlobWordSegmentEstree(n.name))
        ) {
          hasGlobIdent = true
          return
        }
        walkEstreeChildren(n, findGlobId)
      }
      findGlobId(arg0)
      let inGlobFn = false
      for (let c = node.parent; c != null; c = c.parent) {
        if (
          (c.type === "FunctionDeclaration" &&
            c.id?.name != null &&
            hasWave3GlobWordSegmentEstree(c.id.name)) ||
          (c.type === "MethodDefinition" &&
            c.key?.type === "Identifier" &&
            hasWave3GlobWordSegmentEstree(c.key.name)) ||
          (c.type === "VariableDeclarator" &&
            c.id?.type === "Identifier" &&
            hasWave3GlobWordSegmentEstree(c.id.name))
        ) {
          inGlobFn = true
          break
        }
      }
      if (hasWave3GlobReplaceChainEstree(arg0) || hasGlobIdent || inGlobFn) {
        reportOnce(
          node,
          `[dynamic-glob-regexp] Dynamic glob-derived 'RegExp(...)' in '${filename}' is banned — use a bounded literal matcher or segment parser.`,
        )
      }
    }

    const checkWave3IgnoreExprEstree = (exprNode, opName, filename) => {
      if (!isWave3ProdSrc(filename)) return
      const p = exprNode.parent
      if (exprNode.type === "Identifier") {
        if (p?.type === "MemberExpression" && p.property === exprNode && p.computed !== true) return
        if (
          (p?.type === "MethodDefinition" || p?.type === "PropertyDefinition") &&
          p.key === exprNode &&
          p.computed !== true
        )
          return
        if (p?.type === "FunctionDeclaration" && p.id === exprNode) return
        if (p?.type === "ImportSpecifier" && (p.local === exprNode || p.imported === exprNode))
          return
        if (p?.type === "TSTypeQuery" || p?.type === "TSTypeReference") return
      }
      if (p?.type === "VariableDeclarator" && (p.id === exprNode || p.init === exprNode)) return
      if (
        p?.type === "Property" &&
        ((p.key === exprNode && p.computed !== true) || p.parent?.type === "ObjectPattern")
      ) {
        return
      }
      const parentCall =
        p?.type === "CallExpression" && unwrapEstree(p.callee) === exprNode ? p : null
      const opNode = parentCall ?? exprNode
      const stages =
        parentCall != null &&
        Array.isArray(parentCall.arguments) &&
        parentCall.arguments.length >= 1
          ? [parentCall.arguments[0]]
          : getWave3PipeStagesBeforeEstree(opNode)
      if (
        (WAVE3_CORE_SRC_RE.test(filename) ||
          isWave3InsideFinalizerOrCompEstree(
            opNode,
            getWave3EffectMemberName,
            scopeNamespaceNames,
          )) &&
        !areWave3AllStagesPureLoggingEstree(stages, context, getWave3EffectMemberName)
      ) {
        reportOnce(
          opNode,
          `[silent-error-swallow] Swallowing errors with Effect.${opName} in '${filename}' is banned outside pure logging/telemetry.`,
        )
      }
    }

    const hasWave3ClosedLiteralComparisonEstree = (testExpr) => {
      let found = false
      const check = (n) => {
        if (n == null || found) return
        const u = unwrapEstree(n)
        if (
          u != null &&
          u.type === "BinaryExpression" &&
          (u.operator === "===" ||
            u.operator === "!==" ||
            u.operator === "==" ||
            u.operator === "!=")
        ) {
          const l = unwrapEstree(u.left)
          const r = unwrapEstree(u.right)
          const lStr = getStaticModuleString(l) != null
          const rStr = getStaticModuleString(r) != null
          const isClosedExpr = (e) =>
            e != null && e.type !== "UnaryExpression" && resolveWave3ExprInfo(e).isClosed
          if ((lStr && !rStr && isClosedExpr(r)) || (rStr && !lStr && isClosedExpr(l))) {
            found = true
            return
          }
        }
        walkEstreeChildren(n, check)
      }
      check(testExpr)
      return found
    }

    const isBannedEffectRunMethodName = (methodName, filename) => {
      if (
        methodName === "runSync" ||
        methodName === "runSyncExit" ||
        methodName === "runSyncWith" ||
        methodName === "runCallback" ||
        methodName === "runCallbackWith" ||
        methodName === "runPromise" ||
        methodName === "runPromiseWith"
      ) {
        return true
      }
      const isMcpRunPromiseExitBoundary =
        /(?:^|\/)apps\/harness-mcp\/src\/(?:server|daemon\/unix-socket-daemon)\.ts$/.test(filename)
      if (methodName === "runPromiseExit") return !isMcpRunPromiseExitBoundary
      if (methodName === "runFork" || methodName === "runForkWith") {
        return !/(?:^|\/)apps\/[^/]+\/src\//.test(filename)
      }
      return false
    }

    const getEstreeBindingPropName = (prop) => {
      if (prop == null || prop.type !== "Property") return null
      if (prop.computed !== true) {
        if (prop.key?.type === "Identifier") return prop.key.name
        if (prop.key?.type === "Literal" && typeof prop.key.value === "string")
          return prop.key.value
        return null
      }
      return getStaticModuleString(prop.key)
    }

    const hasResultTryFsReadEstree = (text) =>
      text.includes("Result.try") &&
      /(?:readTextSync|readdirSync|readBytesSync)/.test(text) &&
      !text.includes("procCmdlinePath") &&
      !text.includes("/proc/")

    const isSilentEmptyFallbackEstree = (fnNode, allowExtended) => {
      const fn = unwrapEstree(fnNode)
      if (
        fn == null ||
        (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression")
      ) {
        return false
      }
      let expr = fn.body
      if (expr != null && expr.type === "BlockStatement") {
        if (
          !Array.isArray(expr.body) ||
          expr.body.length !== 1 ||
          expr.body[0]?.type !== "ReturnStatement"
        ) {
          return false
        }
        expr = expr.body[0].argument
      }
      if (expr == null) return false
      if (expr.type === "Literal" && expr.value === "") return true
      if (expr.type === "ArrayExpression" && expr.elements.length === 0) return true
      if (!allowExtended) return false
      if (expr.type === "ObjectExpression" && expr.properties.length === 0) return true
      if (expr.type === "Identifier" && expr.name === "undefined") return true
      if (expr.type === "Literal" && expr.value === false) return true
      return false
    }

    function reportOnce(node, message) {
      if (node != null && typeof node === "object") {
        if (reportedNodes.has(node)) return
        reportedNodes.add(node)
      }
      context.report({ node, message })
    }

    const markAllowedDdlTemplates = (astNode, visited = new Set()) => {
      if (astNode == null || typeof astNode !== "object" || visited.has(astNode)) return
      visited.add(astNode)
      if (astNode.type === "TaggedTemplateExpression") {
        allowedDdlTemplateNodes.add(astNode)
      }
      if (astNode.type === "Identifier" && typeof astNode.name === "string") {
        const savedObj = migrationRecordVars.get(astNode.name)
        if (savedObj != null) {
          markAllowedDdlTemplates(savedObj, visited)
        }
      }
      for (const key of Object.keys(astNode)) {
        if (key === "parent" || key === "range" || key === "loc") continue
        const child = astNode[key]
        if (Array.isArray(child)) {
          for (const item of child) markAllowedDdlTemplates(item, visited)
        } else if (child != null && typeof child === "object") {
          markAllowedDdlTemplates(child, visited)
        }
      }
    }

    const validateMigrationRecordObject = (expr) => {
      const visited = new Set()
      const collectEntries = (e, out) => {
        if (e == null || typeof e !== "object" || visited.has(e)) return
        visited.add(e)
        if (e.type === "Identifier" && typeof e.name === "string") {
          const saved = migrationRecordVars.get(e.name)
          if (saved != null) {
            collectEntries(saved, out)
          }
          return
        }
        if (e.type === "ObjectExpression" && Array.isArray(e.properties)) {
          for (const prop of e.properties) {
            if (prop == null) continue
            if (prop.type === "SpreadElement" && prop.argument != null) {
              collectEntries(prop.argument, out)
            } else if (prop.type === "Property" && prop.key != null) {
              const keyName =
                prop.key.type === "Identifier"
                  ? prop.key.name
                  : prop.key.type === "Literal" && typeof prop.key.value === "string"
                    ? prop.key.value
                    : null
              if (keyName != null) {
                out.push({ keyName, node: prop.key })
              }
            }
          }
        }
      }
      const entries = []
      collectEntries(expr, entries)
      const seenIds = new Set()
      for (const entry of entries) {
        const m = /^([1-9]\d*)_([a-z0-9_]+)$/.exec(entry.keyName)
        if (m == null) {
          reportOnce(
            entry.node,
            `Invalid SqliteMigrator.fromRecord migration key '${entry.keyName}' (invalid-migrator-record-key) — migration keys must match '<positive_integer>_<snake_case_name>' (e.g. '1_init_tables') because Effect's Migrator.fromRecord silently ignores keys without a numeric prefix (harness:ADR-0008, harness:SPEC-0006).`,
          )
        } else {
          const idNum = Number(m[1])
          if (seenIds.has(idNum)) {
            reportOnce(
              entry.node,
              `Duplicate SqliteMigrator.fromRecord migration numeric id '${idNum}' in key '${entry.keyName}' (invalid-migrator-record-key) — each migration must have a unique monotonic integer prefix (harness:ADR-0008, harness:SPEC-0006).`,
            )
          }
          seenIds.add(idNum)
        }
      }
    }

    function getNormalizedFilename() {
      return (
        context.filename ?? (typeof context.getFilename === "function" ? context.getFilename() : "")
      ).replace(/\\/g, "/")
    }

    function reportAsync(node) {
      if (node.async === true) {
        context.report({ node, message: asyncMessage })
      }
    }

    function recordContractImports(importNode) {
      if (importNode == null || importNode.type !== "ImportDeclaration") return
      const sourceVal =
        importNode.source && typeof importNode.source.value === "string"
          ? importNode.source.value
          : ""
      if (!/contract/i.test(sourceVal) || !Array.isArray(importNode.specifiers)) return
      for (const spec of importNode.specifiers) {
        if (spec != null && spec.local != null && spec.local.type === "Identifier") {
          const localName = spec.local.name
          if (
            !/(?:Error|Api|Group|Rpc|Service|Repo|Client|Layer|Store|Database)$/.test(localName)
          ) {
            brandedTypeNames.add(localName)
          }
        }
      }
    }

    function recordSchemaDeclarator(decl) {
      if (decl == null || decl.id == null || decl.id.type !== "Identifier") return
      const varName = decl.id.name
      if (varName.endsWith("Schema") || varName.startsWith("make")) {
        schemaVarNames.add(varName)
      }
      if (hasSchemaBrandInTree(decl.init, brandedTypeNames)) {
        brandedTypeNames.add(varName)
      } else {
        const unbrandedScalar = getUnbrandedScalarSchemaName(
          decl.init,
          unbrandedSchemaVarNames,
          brandedTypeNames,
        )
        if (unbrandedScalar != null) {
          unbrandedSchemaVarNames.set(varName, unbrandedScalar)
        }
      }
    }

    function findMatchingSchemaVar(typeName) {
      if (typeName == null) return null
      if (schemaVarNames.has(typeName + "Schema")) return typeName + "Schema"
      if (schemaVarNames.has("make" + typeName + "Schema")) return "make" + typeName + "Schema"
      if (schemaVarNames.has("make" + typeName)) return "make" + typeName
      return null
    }

    function checkTypeAliasDeclaration(decl, filename) {
      if (decl == null || decl.type !== "TSTypeAliasDeclaration") return
      if (!/libs\/[^/]+\/(contract|domain|core|service|infra)\/src\//.test(filename)) return
      const typeName = decl.id != null ? decl.id.name : null
      if (typeName == null) return
      if (containsBrandTypeReference(decl.typeAnnotation, brandedTypeNames)) {
        brandedTypeNames.add(typeName)
      }
      const matchingSchema = findMatchingSchemaVar(typeName)
      if (matchingSchema != null && containsInlineObjectTypeNode(decl.typeAnnotation)) {
        reportOnce(
          decl,
          `Do not declare loose handwritten TypeScript type/interface '${typeName}' alongside '${matchingSchema}' — derive the type directly via Schema.Schema.Type<typeof ${matchingSchema}> (or Schema.Schema.Type<ReturnType<typeof ${matchingSchema}>>) to preserve schema constraints.`,
        )
        return
      }
      const primInfo = getRawPrimitiveKeywordInfo(decl.typeAnnotation)
      if (primInfo != null) {
        reportOnce(
          decl,
          `Do not declare raw primitive type alias '${typeName} = ${primInfo.prim}' — raw type aliases are erased by TypeScript and do not prevent mixing domain values. Define a branded schema in type:contract using Schema.${primInfo.schema}.pipe(Schema.brand('${typeName}')) and export type ${typeName} = typeof ${typeName}.Type (or use Brand.Branded<${primInfo.prim}, '${typeName}'>).`,
        )
        return
      }
      if (containsInlineObjectTypeNode(decl.typeAnnotation)) {
        reportOnce(
          decl,
          `Do not declare inline object type alias '${typeName}' — inline object types bypass runtime Schema validation and branded field checks. Define a Schema.Struct, Schema.Class, or Schema.TaggedStruct in type:contract with branded field schemas and derive 'export type ${typeName} = typeof ${typeName}.Type'.`,
        )
      }
    }

    function checkSchemaFieldObjects(callNode, filename) {
      const fieldObjects = extractSchemaFieldObjects(callNode)
      if (fieldObjects.length === 0) return
      const isContractDomainOrCore = /libs\/[^/]+\/(contract|domain|core)\/src\//.test(filename)

      for (const { kind, obj } of fieldObjects) {
        if (!Array.isArray(obj.properties)) continue
        for (const prop of obj.properties) {
          if (
            prop == null ||
            (prop.type !== "Property" && prop.type !== "ObjectProperty") ||
            prop.computed === true
          ) {
            continue
          }
          const keyName = getPropertyKeyName(prop)
          if (keyName == null) continue

          if (
            kind === "Struct" &&
            BOOLEAN_STATE_PROP_REGEX.test(keyName) &&
            isSchemaBoolean(prop.value)
          ) {
            reportOnce(prop, schemaBooleanStateMessage)
            continue
          }

          if (kind === "Struct" && QUANTITY_OR_VERSION_PROP_REGEX.test(keyName)) {
            if (isSchemaIntOrNumber(prop.value)) {
              const unwrapped = unwrapSchemaModifier(prop.value)
              const propType = unwrapped && unwrapped.property ? unwrapped.property.name : "Int"
              const suggestedBrand = toPascalCase(keyName)
              reportOnce(
                prop,
                `Do not use Schema.${propType} for quantity, version, or count field '${keyName}' in Schema.Struct — use Schema.Natural (non-negative) or Schema.PositiveInt piped into Schema.brand('${suggestedBrand}') (e.g. Schema.Natural.pipe(Schema.brand('${suggestedBrand}'))) to prevent negative domain values and enforce nominal branding.`,
              )
              continue
            }
          }

          if (isContractDomainOrCore) {
            const unbrandedSchemaName = getUnbrandedScalarSchemaName(
              prop.value,
              unbrandedSchemaVarNames,
              brandedTypeNames,
            )
            if (unbrandedSchemaName != null) {
              const suggestedBrand = toPascalCase(keyName)
              reportOnce(
                prop,
                `Do not use unbranded Schema.${unbrandedSchemaName} for field '${keyName}' in Schema.${kind} — define a reusable branded schema with Schema.brand('${suggestedBrand}') in type:contract (e.g. export const ${suggestedBrand} = Schema.${unbrandedSchemaName}.pipe(Schema.brand('${suggestedBrand}'))) and reference it here so domain values cannot be mixed.`,
              )
            }
          }
        }
      }
    }

    function checkContextServiceClass(classNode, filename) {
      if (classNode == null || classNode.superClass == null) return

      // Also check Schema.TaggedError / Schema.TaggedClass / Schema.Class superClass field objects
      if (classNode.superClass.type === "CallExpression") {
        checkSchemaFieldObjects(classNode.superClass, filename)
      }

      if (!/libs\/[^/]+\/service\/src\//.test(filename)) return
      const superCall = classNode.superClass
      if (
        superCall.type !== "CallExpression" ||
        superCall.callee == null ||
        superCall.callee.type !== "CallExpression"
      ) {
        return
      }
      const innerCall = superCall.callee
      if (
        innerCall.callee == null ||
        innerCall.callee.type !== "MemberExpression" ||
        innerCall.callee.computed === true ||
        !isIdentifier(innerCall.callee.object, "Context") ||
        !isIdentifier(innerCall.callee.property, "Service")
      ) {
        return
      }
      const typeParams = getTypeParams(innerCall)
      if (typeParams.length < 2) return
      const shapeNode = typeParams[1]
      if (
        shapeNode == null ||
        shapeNode.type !== "TSTypeLiteral" ||
        !Array.isArray(shapeNode.members)
      ) {
        return
      }

      for (const member of shapeNode.members) {
        if (member == null) continue
        const memberName = getPropertyKeyName(member) ?? "method"
        const fnType =
          member.type === "TSPropertySignature" && member.typeAnnotation != null
            ? member.typeAnnotation.typeAnnotation
            : member.type === "TSMethodSignature"
              ? member
              : null
        if (fnType == null) continue

        const params = Array.isArray(fnType.params)
          ? fnType.params
          : Array.isArray(fnType.parameters)
            ? fnType.parameters
            : []
        for (const param of params) {
          const paramType = param?.typeAnnotation?.typeAnnotation
          const primInfo = getRawPrimitiveKeywordInfo(paramType)
          if (primInfo != null) {
            reportOnce(
              param,
              `Do not use raw primitive type '${primInfo.prim}' for parameter in Context.Service capability '${memberName}' — use a branded domain type from type:contract (defined with Schema.brand('<BrandName>')) so service ports enforce nominal domain safety.`,
            )
          } else if (containsInlineObjectTypeNode(paramType)) {
            reportOnce(
              param,
              `Do not use inline object type for parameter in Context.Service capability '${memberName}' — define a named Schema.Struct or Schema.Class in type:contract with branded fields and reference its derived type.`,
            )
          }
        }

        const returnTypeNode =
          fnType.returnType?.typeAnnotation ??
          fnType.typeAnnotation?.typeAnnotation ??
          (member.type === "TSPropertySignature" ? member.typeAnnotation?.typeAnnotation : null)
        const successType = getEffectSuccessTypeNode(returnTypeNode) ?? returnTypeNode
        if (successType != null && successType.type !== "TSVoidKeyword") {
          const retPrim = getRawPrimitiveKeywordInfo(successType)
          if (retPrim != null) {
            reportOnce(
              member,
              `Do not use raw primitive success type '${retPrim.prim}' in Context.Service capability '${memberName}' — use a branded domain type from type:contract (defined with Schema.brand('<BrandName>')) so service ports enforce nominal domain safety.`,
            )
          } else if (containsInlineObjectTypeNode(successType)) {
            reportOnce(
              member,
              `Do not use inline object return/success type in Context.Service capability '${memberName}' — define a named Schema.Struct or Schema.Class in type:contract with branded fields and reference its derived type.`,
            )
          }
        }
      }
    }

    function checkDomainBoundaryFunctionNode(implFn, fnName) {
      if (implFn == null) return
      const params = Array.isArray(implFn.params) ? implFn.params : []
      for (const param of params) {
        const paramType = param?.typeAnnotation?.typeAnnotation
        const primInfo = getRawPrimitiveKeywordInfo(paramType)
        if (primInfo != null) {
          reportOnce(
            param,
            `Do not use raw primitive type '${primInfo.prim}' at exported domain boundary '${fnName}' — use a branded domain type from type:contract (defined with Schema.brand('<BrandName>')) so domain deciders and use cases cannot accept or return unvalidated primitives.`,
          )
        } else if (containsInlineObjectTypeNode(paramType)) {
          reportOnce(
            param,
            `Do not use inline object type for parameter at exported domain boundary '${fnName}' — define a named Schema.Struct or Schema.Class in type:contract with branded fields and reference its derived type.`,
          )
        }
      }

      const retType = implFn.returnType?.typeAnnotation
      const successType = getEffectSuccessTypeNode(retType) ?? retType
      if (successType != null && successType.type !== "TSVoidKeyword") {
        const retPrim = getRawPrimitiveKeywordInfo(successType)
        if (retPrim != null) {
          reportOnce(
            implFn,
            `Do not use raw primitive return type '${retPrim.prim}' at exported domain boundary '${fnName}' — use a branded domain type from type:contract (defined with Schema.brand('<BrandName>')) so domain deciders and use cases cannot accept or return unvalidated primitives.`,
          )
        } else if (containsInlineObjectTypeNode(successType)) {
          reportOnce(
            implFn,
            `Do not use inline object return/success type at exported domain boundary '${fnName}' — define a named Schema.Struct or Schema.Class in type:contract with branded fields and reference its derived type.`,
          )
        }
      }

      // Check stub<A, E, R>(...) call inside body
      const bodyNode = implFn.body
      if (bodyNode != null) {
        const stubCall =
          bodyNode.type === "CallExpression" && isStubCall(bodyNode)
            ? bodyNode
            : bodyNode.type === "BlockStatement" && Array.isArray(bodyNode.body)
              ? bodyNode.body
                  .map((s) =>
                    s.type === "ReturnStatement"
                      ? s.argument?.type === "YieldExpression"
                        ? s.argument.argument
                        : s.argument
                      : null,
                  )
                  .find(
                    (expr) => expr != null && expr.type === "CallExpression" && isStubCall(expr),
                  )
              : null
        if (stubCall != null) {
          const stubParams = getTypeParams(stubCall)
          const stubA = stubParams.length > 0 ? stubParams[0] : null
          const stubPrim = getRawPrimitiveKeywordInfo(stubA)
          if (stubPrim != null) {
            reportOnce(
              stubCall,
              `Do not use raw primitive success type '${stubPrim.prim}' in stub<A, E, R> at exported domain boundary '${fnName}' — use a branded domain type from type:contract (defined with Schema.brand('<BrandName>')).`,
            )
          } else if (containsInlineObjectTypeNode(stubA)) {
            reportOnce(
              stubCall,
              `Do not use inline object success type in stub<A, E, R> at exported domain boundary '${fnName}' — define a named Schema.Struct or Schema.Class in type:contract with branded fields and reference its derived type.`,
            )
          }
        }
      }
    }

    function checkDomainBoundaryVarDeclarator(varDecl, filename) {
      if (varDecl == null || varDecl.init == null) return
      if (!/libs\/[^/]+\/(?:domain|core)\/src\//.test(filename)) return
      const fnName = varDecl.id != null && varDecl.id.type === "Identifier" ? varDecl.id.name : "fn"
      const init = varDecl.init
      if (
        init.type === "CallExpression" &&
        init.callee != null &&
        init.callee.type === "CallExpression" &&
        isEffectFnCall(init.callee) &&
        Array.isArray(init.arguments) &&
        init.arguments.length > 0
      ) {
        const implFn = init.arguments[0]
        if (
          implFn != null &&
          (implFn.type === "FunctionExpression" || implFn.type === "ArrowFunctionExpression")
        ) {
          checkDomainBoundaryFunctionNode(implFn, fnName)
        }
      } else if (
        init.type === "CallExpression" &&
        isUntracedEffectCall(init) &&
        Array.isArray(init.arguments) &&
        init.arguments.length > 0
      ) {
        const implFn = init.arguments[0]
        if (
          implFn != null &&
          (implFn.type === "FunctionExpression" || implFn.type === "ArrowFunctionExpression")
        ) {
          checkDomainBoundaryFunctionNode(implFn, fnName)
        }
      } else if (init.type === "FunctionExpression" || init.type === "ArrowFunctionExpression") {
        checkDomainBoundaryFunctionNode(init, fnName)
      }
    }

    return {
      Program(node) {
        const sc = getSourceCode(context)
        const rawText = readFullSourceText(sc, node)
        if (rawText === undefined) {
          context.report({
            node,
            message:
              "missing-source-code: Unable to access sourceCode.text or sourceCode.getText() for AST inspection.",
          })
        }
        discriminantAliasNames.clear()
        schemaVarNames.clear()
        brandedTypeNames.clear()
        unbrandedSchemaVarNames.clear()
        declaredBrandKeys.clear()
        migrationRecordVars.clear()
        allowedDdlTemplateNodes.clear()
        effectModuleNamespaceNames.clear()
        effectNamespaceNames.clear()
        effectNamespaceNames.add("Effect")
        effectMethodAliases.clear()
        scopeNamespaceNames.clear()
        scopeNamespaceNames.add("Scope")
        bannedRunAliases.clear()
        wave3ClosedTypeNames.clear()
        for (const t of WAVE3_CANONICAL_CLOSED_LITERAL_TYPES) wave3ClosedTypeNames.add(t)
        wave3ClosedPropsByType.clear()
        wave3FnReturnTypes.clear()
        wave3VarScopes.length = 0
        pushWave3Scope(true)
        hasSqliteMigratorImport = false
        if (node.body && Array.isArray(node.body)) {
          const unwrapTopDecl = (stmt) =>
            stmt?.type === "ExportNamedDeclaration" && stmt.declaration != null
              ? stmt.declaration
              : stmt
          for (const stmt of node.body) {
            if (stmt.type === "ImportDeclaration") {
              recordContractImports(stmt)
              const impSrc = typeof stmt.source?.value === "string" ? stmt.source.value : ""
              if (
                stmt.importKind !== "type" &&
                (impSrc === "effect" || impSrc === "effect/Effect" || impSrc === "effect/Scope") &&
                Array.isArray(stmt.specifiers)
              ) {
                for (const spec of stmt.specifiers) {
                  if (spec == null || spec.importKind === "type") continue
                  if (spec.type === "ImportNamespaceSpecifier" && spec.local?.name) {
                    if (impSrc === "effect") effectModuleNamespaceNames.add(spec.local.name)
                    else if (impSrc === "effect/Effect") effectNamespaceNames.add(spec.local.name)
                    else if (impSrc === "effect/Scope") scopeNamespaceNames.add(spec.local.name)
                  } else if (spec.type === "ImportSpecifier" && spec.local?.name) {
                    const impName = spec.imported?.name ?? spec.local.name
                    if (impSrc === "effect" && impName === "Effect")
                      effectNamespaceNames.add(spec.local.name)
                    else if (impSrc === "effect" && impName === "Scope")
                      scopeNamespaceNames.add(spec.local.name)
                    else if (impSrc === "effect/Effect" && impName !== "Effect") {
                      effectMethodAliases.set(spec.local.name, impName)
                    }
                  }
                }
              }
            }
            const d = unwrapTopDecl(stmt)
            if (d?.type === "VariableDeclaration" && Array.isArray(d.declarations)) {
              for (const decl of d.declarations) {
                recordSchemaDeclarator(decl)
                if (decl?.id?.type === "Identifier" && decl.init != null) {
                  if (isWave3SchemaLiteralsEstree(decl.init)) wave3ClosedTypeNames.add(decl.id.name)
                  const initU = unwrapEstree(decl.init)
                  if (
                    hasWave3GlobWordSegmentEstree(decl.id.name) ||
                    hasWave3GlobReplaceChainEstree(decl.init)
                  ) {
                    recordWave3GlobVar(decl.id.name, true)
                  }
                  if (initU?.type === "ArrayExpression")
                    recordWave3GitArgVar(decl.id.name, initU, true)
                }
              }
            } else if (d?.type === "FunctionDeclaration" && d.id) {
              if (d.id.name.endsWith("Schema") || d.id.name.startsWith("make")) {
                schemaVarNames.add(d.id.name)
              }
            } else if (d?.type === "TSTypeAliasDeclaration" && d.id != null) {
              if (containsBrandTypeReference(d.typeAnnotation, brandedTypeNames)) {
                brandedTypeNames.add(d.id.name)
              }
              if (isWave3ClosedStringUnionTypeEstree(d.typeAnnotation, wave3ClosedTypeNames)) {
                wave3ClosedTypeNames.add(d.id.name)
              }
            }
          }
          for (let pass = 0; pass < 2; pass++) {
            for (const stmt of node.body) {
              const d = unwrapTopDecl(stmt)
              if (d?.type === "TSInterfaceDeclaration" && d.id?.name) {
                recordWave3TypeMembers(d.id.name, d.body?.body)
              } else if (
                d?.type === "TSTypeAliasDeclaration" &&
                d.id?.name &&
                d.typeAnnotation?.type === "TSTypeLiteral"
              ) {
                recordWave3TypeMembers(d.id.name, d.typeAnnotation.members)
              }
            }
          }
          for (const stmt of node.body) {
            const d = unwrapTopDecl(stmt)
            if (
              d?.type === "FunctionDeclaration" &&
              d.id?.name &&
              d.returnType?.typeAnnotation != null
            ) {
              const retInfo = resolveWave3TypeNodeInfo(d.returnType.typeAnnotation)
              if (retInfo.isClosed || retInfo.typeName != null || retInfo.inlineProps != null) {
                wave3FnReturnTypes.set(d.id.name, retInfo)
              }
            } else if (d?.type === "VariableDeclaration" && Array.isArray(d.declarations)) {
              for (const decl of d.declarations) {
                if (decl?.id?.type === "Identifier" && decl.init != null) {
                  const fn = unwrapEstree(decl.init)
                  if (isWave3FnExprEstree(fn) && fn.returnType?.typeAnnotation != null) {
                    const retInfo = resolveWave3TypeNodeInfo(fn.returnType.typeAnnotation)
                    if (
                      retInfo.isClosed ||
                      retInfo.typeName != null ||
                      retInfo.inlineProps != null
                    ) {
                      wave3FnReturnTypes.set(decl.id.name, retInfo)
                    }
                  }
                }
                if (d.kind === "var") {
                  const varInfo =
                    decl?.id?.typeAnnotation?.typeAnnotation != null
                      ? resolveWave3TypeNodeInfo(decl.id.typeAnnotation.typeAnnotation)
                      : decl?.init != null
                        ? resolveWave3ExprInfo(decl.init)
                        : WAVE3_OPEN_INFO
                  if (varInfo.isClosed || varInfo.typeName != null || varInfo.inlineProps != null) {
                    bindWave3Pattern(decl.id, varInfo, true)
                  }
                }
              }
            }
          }
        }
        const text = rawText ?? ""
        if (
          /^\s*(\/\/|\/\*)\s*(oxlint-disable|eslint-disable)[^\n]*(effecttsgo\/|harness\/)/m.test(
            text,
          ) ||
          /oxlint-disable[^\n]*effecttsgo\//.test(text) ||
          /^\s*(\/\/|\/\*)\s*@effect-diagnostics(-next-line)?\b/m.test(text)
        ) {
          context.report({ node, message: effectTsgoDisableMessage })
        }
        if (/^\s*(\/\/|\/\*)\s*@ts-(ignore|expect-error|nocheck)\b/m.test(text)) {
          context.report({ node, message: tsSuppressionMessage })
        }
        const normalized = getNormalizedFilename()
        checkWorkflowBodyDeterminismEstree(node, normalized, reportOnce)
        checkContractShapeHardeningEstree(node, normalized, reportOnce)
        checkWorkflowNameInsteadOfTagEstree(node, normalized, reportOnce)
      },
      ImportDeclaration(node) {
        recordContractImports(node)
        const filename = getNormalizedFilename()
        if (node.source != null && typeof node.source.value === "string") {
          const importSource = node.source.value
          if (importSource.includes("SqliteMigrator") || importSource.includes("Migrator")) {
            hasSqliteMigratorImport = true
          }
          if (Array.isArray(node.specifiers)) {
            for (const spec of node.specifiers) {
              const localName = spec?.local?.name
              const importedName = spec?.imported?.name
              if (
                localName === "SqliteMigrator" ||
                localName === "Migrator" ||
                importedName === "SqliteMigrator" ||
                importedName === "Migrator"
              ) {
                hasSqliteMigratorImport = true
              }
            }
          }
        }
        if (node.source != null && typeof node.source.value === "string") {
          const importSource = node.source.value
          if (
            /libs\/[^/]+\/(domain|core)\/(src|test\/fixtures)\//.test(filename) &&
            (importSource.startsWith("effect/sql") || importSource.startsWith("@effect/sql"))
          ) {
            reportOnce(
              node,
              `Do not import SQL client/driver module '${importSource}' in type:domain or type:core — keep domain/core packages 100% free of I/O and place SqlClient implementations in type:infra.`,
            )
          }
          if (
            /libs\/[^/]+\/infra\/src\/index\.ts$/.test(filename) &&
            importSource.startsWith("node:")
          ) {
            reportOnce(
              node,
              `Do not import Node.js builtin '${importSource}' in the main Cloudflare Worker infra entrypoint (src/index.ts) — isolate Node-backed test/memory adapters in a separate module (e.g. src/memory.ts).`,
            )
          }
          if (
            /(?:libs\/[^/]+\/infra\/|apps\/)/.test(filename) &&
            (importSource === "node:sqlite" ||
              importSource === "sqlite" ||
              importSource === "better-sqlite3")
          ) {
            reportOnce(node, nodeSqliteInfraMessage(importSource, filename))
          }
          if (isDrizzleSpecifier(importSource)) {
            reportOnce(node, bannedDrizzleMessage(importSource, filename))
          }
          if (
            node.importKind !== "type" &&
            (importSource === "effect" ||
              importSource === "effect/Effect" ||
              importSource === "effect/Scope") &&
            Array.isArray(node.specifiers)
          ) {
            const isEnforcedSrc =
              !isTestFilePath(filename) &&
              /(?:^|\/)(?:libs\/[^/]+\/[^/]+\/src|apps\/[^/]+\/src)\//.test(filename)
            const isMcpRunPromiseExitBoundary =
              /(?:^|\/)apps\/harness-mcp\/src\/(?:server|daemon\/unix-socket-daemon)\.ts$/.test(
                filename,
              )
            const isAppSrc = /(?:^|\/)apps\/[^/]+\/src\//.test(filename)
            for (const spec of node.specifiers) {
              if (spec == null || spec.importKind === "type") continue
              if (spec.type === "ImportNamespaceSpecifier" && spec.local?.name) {
                if (importSource === "effect") {
                  effectModuleNamespaceNames.add(spec.local.name)
                } else if (importSource === "effect/Scope") {
                  scopeNamespaceNames.add(spec.local.name)
                } else {
                  effectNamespaceNames.add(spec.local.name)
                }
              } else if (spec.type === "ImportSpecifier") {
                const importedName = spec.imported?.name ?? spec.local?.name
                const localName = spec.local?.name
                if (importSource === "effect" && importedName === "Effect" && localName) {
                  effectNamespaceNames.add(localName)
                }
                if (importSource === "effect" && importedName === "Scope" && localName) {
                  scopeNamespaceNames.add(localName)
                }
                if (
                  importSource === "effect/Effect" &&
                  localName &&
                  importedName != null &&
                  importedName !== "Effect"
                ) {
                  effectMethodAliases.set(localName, importedName)
                }
                if (importSource === "effect/Effect" && isEnforcedSrc && importedName != null) {
                  const isBannedSync =
                    importedName === "runSync" ||
                    importedName === "runSyncExit" ||
                    importedName === "runSyncWith"
                  const isBannedCallback =
                    importedName === "runCallback" || importedName === "runCallbackWith"
                  const isBannedPromise =
                    importedName === "runPromise" ||
                    importedName === "runPromiseWith" ||
                    (importedName === "runPromiseExit" && !isMcpRunPromiseExitBoundary)
                  const isBannedFork =
                    (importedName === "runFork" || importedName === "runForkWith") && !isAppSrc
                  if (isBannedSync || isBannedCallback || isBannedPromise || isBannedFork) {
                    context.report({
                      node: spec,
                      message: `unscoped-effect-run: 'Effect.${importedName}' import is banned in '${filename}' — compose Effects and execute via NodeRuntime.runMain or ManagedRuntime at the app edge.`,
                    })
                  }
                }
              }
            }
          }
        }
      },
      TSAnyKeyword(node) {
        context.report({ node, message: explicitAnyBanMessage })
      },
      TSTypeAssertion(node) {
        checkAsOrTypeAssertion(context, node)
      },
      ImportExpression(node) {
        const filename = getNormalizedFilename()
        const sourceVal = getStaticModuleString(node.source)
        const drizzleSourceVal = getModulePrefixOrStaticString(node.source)
        if (drizzleSourceVal != null && isDrizzleSpecifier(drizzleSourceVal)) {
          reportOnce(node, bannedDrizzleMessage(drizzleSourceVal, filename))
        }
        if (
          drizzleSourceVal != null &&
          drizzleSourceVal.startsWith("@harness/") &&
          /(?:^|\/)(?:libs|apps)\/.*\/(?:src|test)\//.test(filename)
        ) {
          reportOnce(node, dynamicHarnessImportMessage(drizzleSourceVal, filename))
        }
        if (/(?:libs\/[^/]+\/infra\/|apps\/)/.test(filename)) {
          if (
            sourceVal === "node:sqlite" ||
            sourceVal === "sqlite" ||
            sourceVal === "better-sqlite3"
          ) {
            reportOnce(node, nodeSqliteInfraMessage(sourceVal, filename))
          }
        }
      },
      TSImportEqualsDeclaration(node) {
        const filename = getNormalizedFilename()
        if (
          node.moduleReference != null &&
          node.moduleReference.type === "TSExternalModuleReference"
        ) {
          const importSource = getStaticModuleString(node.moduleReference.expression)
          if (importSource != null && isDrizzleSpecifier(importSource)) {
            reportOnce(node, bannedDrizzleMessage(importSource, filename))
          }
          if (
            /(?:libs\/[^/]+\/infra\/|apps\/)/.test(filename) &&
            (importSource === "node:sqlite" ||
              importSource === "sqlite" ||
              importSource === "better-sqlite3")
          ) {
            reportOnce(node, nodeSqliteInfraMessage(importSource, filename))
          }
        }
      },
      TaggedTemplateExpression(node) {
        const filename = getNormalizedFilename()
        if (!/libs\/[^/]+\/infra\/src\//.test(filename)) return
        const tag = node.tag
        const isSqlTag =
          (tag != null && tag.type === "Identifier" && tag.name === "sql") ||
          (tag != null &&
            tag.type === "MemberExpression" &&
            tag.computed !== true &&
            tag.property != null &&
            tag.property.type === "Identifier" &&
            tag.property.name === "sql")
        if (!isSqlTag || node.quasi == null || !Array.isArray(node.quasi.quasis)) return
        const sqlText = node.quasi.quasis
          .map((q) => (q.value && (q.value.raw ?? q.value.cooked)) || "")
          .join(" ")
        const hasDdl =
          /\b(?:CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?(?:TABLE|INDEX|UNIQUE\s+INDEX|VIEW|TRIGGER)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER))\b/i.test(
            sqlText,
          )
        if (!hasDdl) return
        if (!hasSqliteMigratorImport || !allowedDdlTemplateNodes.has(node)) {
          reportOnce(
            node,
            `Do not execute ad-hoc SQL DDL ('CREATE TABLE' / 'ALTER TABLE' / 'DROP TABLE') outside SqliteMigrator in type:infra ('${filename}') — manage Durable Object SQLite schema migrations transactionally via @effect/sql-sqlite-do/SqliteMigrator (SqliteMigrator.run / SqliteMigrator.layer with SqliteMigrator.fromRecord) so applied versions are tracked in effect_sql_migrations (harness:ADR-0008, harness:SPEC-0006, unmanaged-sql-ddl).`,
          )
        }
      },
      VariableDeclarator(node) {
        checkNeverVariableDeclarator(context, node)
        const isVar = node.parent?.type === "VariableDeclaration" && node.parent.kind === "var"
        if (node.id?.type === "Identifier" && node.init != null) {
          if (isWave3SchemaLiteralsEstree(node.init)) {
            wave3ClosedTypeNames.add(node.id.name)
          }
          const fnInit = unwrapEstree(node.init)
          if (isWave3FnExprEstree(fnInit) && fnInit.returnType?.typeAnnotation != null) {
            const retInfo = resolveWave3TypeNodeInfo(fnInit.returnType.typeAnnotation)
            if (retInfo.isClosed || retInfo.typeName != null || retInfo.inlineProps != null) {
              wave3FnReturnTypes.set(node.id.name, retInfo)
            }
          }
          if (
            hasWave3GlobWordSegmentEstree(node.id.name) ||
            hasWave3GlobReplaceChainEstree(node.init)
          ) {
            recordWave3GlobVar(node.id.name, isVar)
          }
          if (fnInit?.type === "ArrayExpression") {
            recordWave3GitArgVar(node.id.name, fnInit, isVar)
          }
        }
        const wave3InitInfo =
          node.id?.typeAnnotation?.typeAnnotation != null
            ? resolveWave3TypeNodeInfo(node.id.typeAnnotation.typeAnnotation)
            : node.init != null
              ? resolveWave3ExprInfo(node.init)
              : WAVE3_OPEN_INFO
        bindWave3Pattern(node.id, wave3InitInfo, isVar)
        const filenameForRun = getNormalizedFilename()
        if (
          !isTestFilePath(filenameForRun) &&
          isPureTierProcessEnvBannedPath(filenameForRun) &&
          isProcessEnvDestructuringAst(node)
        ) {
          context.report({
            node,
            message:
              "process-env-outside-infra-or-app: Direct process.env access is banned outside type:infra and type:app — inject Config or read environment variables in @harness/infra or apps/*.",
          })
        }
        if (node.init != null) {
          const unwrappedInit = unwrapEstree(node.init)
          if (
            unwrappedInit?.type === "MemberExpression" &&
            isEffectNamespaceExpr(unwrappedInit.object) &&
            node.id?.type === "Identifier"
          ) {
            const effM = getEstreeStaticMemberName(unwrappedInit)
            if (effM != null) effectMethodAliases.set(node.id.name, effM)
          }
          if (isEffectNamespaceExpr(unwrappedInit)) {
            if (node.id?.type === "Identifier") {
              effectNamespaceNames.add(node.id.name)
            } else if (node.id?.type === "ObjectPattern" && Array.isArray(node.id.properties)) {
              for (const prop of node.id.properties) {
                const propName = getEstreeBindingPropName(prop)
                if (propName != null && prop.value?.type === "Identifier") {
                  effectMethodAliases.set(prop.value.name, propName)
                  if (isBannedEffectRunMethodName(propName, filenameForRun)) {
                    bannedRunAliases.set(prop.value.name, propName)
                  }
                }
              }
            }
          } else if (
            unwrappedInit != null &&
            unwrappedInit.type === "Identifier" &&
            effectModuleNamespaceNames.has(unwrappedInit.name) &&
            node.id?.type === "ObjectPattern" &&
            Array.isArray(node.id.properties)
          ) {
            for (const prop of node.id.properties) {
              if (getEstreeBindingPropName(prop) !== "Effect") continue
              if (prop.value?.type === "Identifier") {
                effectNamespaceNames.add(prop.value.name)
              } else if (
                prop.value?.type === "ObjectPattern" &&
                Array.isArray(prop.value.properties)
              ) {
                for (const nested of prop.value.properties) {
                  const propName = getEstreeBindingPropName(nested)
                  if (propName != null && nested.value?.type === "Identifier") {
                    effectMethodAliases.set(nested.value.name, propName)
                    if (isBannedEffectRunMethodName(propName, filenameForRun)) {
                      bannedRunAliases.set(nested.value.name, propName)
                    }
                  }
                }
              }
            }
          }
        }
        recordDiscriminantAliasesFromBinding(node.id, node.init, discriminantAliasNames)
        if (node.id != null && node.id.type === "Identifier") {
          if (node.init != null && node.init.type === "ObjectExpression") {
            migrationRecordVars.set(node.id.name, node.init)
            if (
              /libs\/[^/]+\/infra\/src\//.test(getNormalizedFilename()) &&
              !/(?:^|\/)libs\/harness\//.test(getNormalizedFilename()) &&
              hasSqliteMigratorImport &&
              /[Mm]igrations/.test(node.id.name)
            ) {
              markAllowedDdlTemplates(node.init)
              validateMigrationRecordObject(node.init)
            }
          }
          recordSchemaDeclarator(node)
          const filename = getNormalizedFilename()
          if (
            /libs\/[^/]+\/(contract|domain|core)\/src\//.test(filename) &&
            node.init != null &&
            QUANTITY_OR_VERSION_PROP_REGEX.test(node.id.name)
          ) {
            const uncheckedIntOrNumber = getUncheckedSchemaIntOrNumberName(node.init)
            if (uncheckedIntOrNumber != null) {
              const suggestedBrand = toPascalCase(node.id.name)
              reportOnce(
                node,
                `Do not use Schema.${uncheckedIntOrNumber} for quantity, version, or count schema '${node.id.name}' — use Schema.Natural (non-negative) or Schema.PositiveInt piped into Schema.brand('${suggestedBrand}') (e.g. Schema.Natural.pipe(Schema.brand('${suggestedBrand}'))) to prevent negative domain values and enforce nominal branding.`,
              )
            }
          }
        }
      },
      TSTypeAliasDeclaration(node) {
        const filename = getNormalizedFilename()
        checkTypeAliasDeclaration(node, filename)
        if (node.id?.type === "Identifier") {
          if (isWave3ClosedStringUnionTypeEstree(node.typeAnnotation, wave3ClosedTypeNames)) {
            wave3ClosedTypeNames.add(node.id.name)
          } else if (node.typeAnnotation?.type === "TSTypeLiteral") {
            recordWave3TypeMembers(node.id.name, node.typeAnnotation.members)
          }
        }
      },
      TSInterfaceDeclaration(node) {
        if (node.id?.type === "Identifier") {
          recordWave3TypeMembers(node.id.name, node.body?.body)
        }
      },
      ClassDeclaration(node) {
        const filename = getNormalizedFilename()
        checkContextServiceClass(node, filename)
      },
      TSAsExpression(node) {
        checkAsOrTypeAssertion(context, node)
        const filename = getNormalizedFilename()
        if (!/libs\/[^/]+\/(contract|domain|core|service|infra)\/src\//.test(filename)) return
        if (containsBrandTypeReference(node.typeAnnotation, brandedTypeNames)) {
          reportOnce(
            node,
            "Do not bypass brand validation with 'as' type assertion — construct branded values via <BrandedSchema>.make(value), Schema.decodeUnknownEffect(<BrandedSchema>)(value), or Effect v4 Brand.nominal<T>()(value) / Brand.make<T>(filter)(value) / Brand.check<T>(...checks)(value).",
          )
        }
      },
      AssignmentExpression(node) {
        recordDiscriminantAliasesFromBinding(node.left, node.right, discriminantAliasNames)
      },
      BlockStatement(node) {
        discriminantAliasNames.pushScope()
        pushWave3Scope(false)
        if (Array.isArray(node.body)) {
          for (const stmt of node.body) {
            if (
              stmt?.type === "FunctionDeclaration" &&
              stmt.id?.name &&
              stmt.returnType?.typeAnnotation != null
            ) {
              const retInfo = resolveWave3TypeNodeInfo(stmt.returnType.typeAnnotation)
              if (retInfo.isClosed || retInfo.typeName != null || retInfo.inlineProps != null) {
                wave3FnReturnTypes.set(stmt.id.name, retInfo)
              }
            } else if (stmt?.type === "VariableDeclaration" && Array.isArray(stmt.declarations)) {
              for (const d of stmt.declarations) {
                if (d?.id?.type === "Identifier" && d.init != null) {
                  const uInit = unwrapEstree(d.init)
                  if (
                    hasWave3GlobWordSegmentEstree(d.id.name) ||
                    hasWave3GlobReplaceChainEstree(d.init)
                  ) {
                    recordWave3GlobVar(d.id.name, stmt.kind === "var")
                  }
                  if (uInit?.type === "ArrayExpression")
                    recordWave3GitArgVar(d.id.name, uInit, stmt.kind === "var")
                }
              }
            }
          }
        }
      },
      "BlockStatement:exit"() {
        discriminantAliasNames.popScope()
        popWave3Scope()
      },
      ForStatement() {
        pushWave3Scope(false)
      },
      "ForStatement:exit"() {
        popWave3Scope()
      },
      ForOfStatement() {
        pushWave3Scope(false)
      },
      "ForOfStatement:exit"() {
        popWave3Scope()
      },
      ForInStatement() {
        pushWave3Scope(false)
      },
      "ForInStatement:exit"() {
        popWave3Scope()
      },
      CatchClause(node) {
        pushWave3Scope(false)
        if (node.param != null) {
          bindWave3Pattern(
            node.param,
            resolveWave3TypeNodeInfo(node.param.typeAnnotation?.typeAnnotation),
            false,
          )
        }
      },
      "CatchClause:exit"() {
        popWave3Scope()
      },
      FunctionDeclaration(node) {
        discriminantAliasNames.pushScope()
        recordFunctionParamDiscriminantAliases(node, discriminantAliasNames)
        reportAsync(node)
        checkNeverParams(context, node)
        if (node.id?.name && node.returnType?.typeAnnotation != null) {
          const retInfo = resolveWave3TypeNodeInfo(node.returnType.typeAnnotation)
          if (retInfo.isClosed || retInfo.typeName != null || retInfo.inlineProps != null) {
            wave3FnReturnTypes.set(node.id.name, retInfo)
          }
        }
      },
      "FunctionDeclaration:exit"() {
        discriminantAliasNames.popScope()
      },
      FunctionExpression(node) {
        discriminantAliasNames.pushScope()
        recordFunctionParamDiscriminantAliases(node, discriminantAliasNames)
        reportAsync(node)
        checkNeverParams(context, node)
      },
      "FunctionExpression:exit"() {
        discriminantAliasNames.popScope()
      },
      ArrowFunctionExpression(node) {
        discriminantAliasNames.pushScope()
        recordFunctionParamDiscriminantAliases(node, discriminantAliasNames)
        reportAsync(node)
        checkNeverParams(context, node)
      },
      "ArrowFunctionExpression:exit"() {
        discriminantAliasNames.popScope()
      },
      AwaitExpression(node) {
        context.report({ node, message: asyncMessage })
      },
      ":function"(node) {
        pushWave3Scope(true)
        if (Array.isArray(node.params)) {
          for (const p of node.params) {
            const pat = p?.type === "AssignmentPattern" ? p.left : p
            bindWave3Pattern(
              p,
              resolveWave3TypeNodeInfo(pat?.typeAnnotation?.typeAnnotation),
              false,
            )
          }
        }
        if (node.body?.type === "BlockStatement") {
          const visitHoisted = (s) => {
            if (s == null) return
            if (s.type === "FunctionDeclaration") {
              if (s.id?.name && s.returnType?.typeAnnotation != null) {
                const retInfo = resolveWave3TypeNodeInfo(s.returnType.typeAnnotation)
                if (retInfo.isClosed || retInfo.typeName != null || retInfo.inlineProps != null) {
                  wave3FnReturnTypes.set(s.id.name, retInfo)
                }
              }
              return
            }
            if (
              s.type === "ArrowFunctionExpression" ||
              s.type === "FunctionExpression" ||
              s.type === "ClassDeclaration" ||
              s.type === "ClassExpression"
            ) {
              return
            }
            if (
              s.type === "VariableDeclaration" &&
              s.kind === "var" &&
              Array.isArray(s.declarations)
            ) {
              for (const decl of s.declarations) {
                if (decl?.id?.type === "Identifier" && decl.init != null) {
                  const uInit = unwrapEstree(decl.init)
                  if (
                    hasWave3GlobWordSegmentEstree(decl.id.name) ||
                    hasWave3GlobReplaceChainEstree(decl.init)
                  ) {
                    recordWave3GlobVar(decl.id.name, true)
                  }
                  if (uInit?.type === "ArrayExpression") {
                    recordWave3GitArgVar(decl.id.name, uInit, true)
                  }
                }
                const varInfo =
                  decl?.id?.typeAnnotation?.typeAnnotation != null
                    ? resolveWave3TypeNodeInfo(decl.id.typeAnnotation.typeAnnotation)
                    : decl?.init != null
                      ? resolveWave3ExprInfo(decl.init)
                      : WAVE3_OPEN_INFO
                if (varInfo.isClosed || varInfo.typeName != null || varInfo.inlineProps != null) {
                  bindWave3Pattern(decl.id, varInfo, true)
                }
              }
              return
            }
            walkEstreeChildren(s, visitHoisted)
          }
          if (Array.isArray(node.body.body)) {
            for (const stmt of node.body.body) visitHoisted(stmt)
          }
        }
      },
      ":function:exit"() {
        popWave3Scope()
      },
      SwitchStatement(node) {
        context.report({ node, message: switchBanMessage })
      },
      IfStatement(node) {
        const filename = getNormalizedFilename()
        if (!isEnforcedWorkspaceFile(filename)) return
        if (
          isDiscriminantTestExpression(node.test) ||
          isAliasedDiscriminantTest(node.test, discriminantAliasNames)
        ) {
          context.report({ node, message: discriminantIfBanMessage })
          return
        }
        if (isWave3ProdSrc(filename) && hasWave3ClosedLiteralComparisonEstree(node.test)) {
          reportOnce(node, discriminantIfBanMessage)
          return
        }
        if (node.alternate != null && node.alternate.type === "IfStatement") {
          context.report({ node, message: elseIfBanMessage })
        }
      },
      ConditionalExpression(node) {
        const filename = getNormalizedFilename()
        if (!isEnforcedWorkspaceFile(filename)) return
        if (
          isDiscriminantTestExpression(node.test) ||
          isAliasedDiscriminantTest(node.test, discriminantAliasNames)
        ) {
          context.report({ node, message: discriminantIfBanMessage })
          return
        }
        if (isWave3ProdSrc(filename) && hasWave3ClosedLiteralComparisonEstree(node.test)) {
          reportOnce(node, discriminantIfBanMessage)
        }
      },
      NewExpression(node) {
        if (isNewPromise(node)) {
          context.report({ node, message: newPromiseMessage })
        }
        const filename = getNormalizedFilename()
        if (
          /libs\/[^/]+\/(?:domain|core)\/src\//.test(filename) &&
          isIdentifier(node.callee, "Date")
        ) {
          context.report({ node, message: impureDomainGlobalMessage })
        }
        checkWave3RegExpEstree(node, filename)
      },
      Identifier(node) {
        const effM = effectMethodAliases.get(node.name)
        if (effM === "ignore" || effM === "ignoreCause") {
          checkWave3IgnoreExprEstree(node, effM, getNormalizedFilename())
        }
      },
      BinaryExpression(node) {
        checkWave3SentinelEstree(node, getNormalizedFilename())
      },
      MemberExpression(node) {
        const filename = getNormalizedFilename()
        if (
          !isTestFilePath(filename) &&
          /(?:^|\/)src\//.test(filename) &&
          !/(?:^|\/)libs\/harness\/contract\/src\/workspace-and-process\.ts$/.test(filename) &&
          node.computed !== true &&
          isIdentifier(node.object, "Cause") &&
          (isIdentifier(node.property, "hasInterrupts") ||
            isIdentifier(node.property, "hasInterruptsOnly"))
        ) {
          let curr = node
          let anc = node.parent
          while (
            anc != null &&
            (anc.type === "TSAsExpression" ||
              anc.type === "TSTypeAssertion" ||
              anc.type === "TSSatisfiesExpression" ||
              anc.type === "TSNonNullExpression" ||
              anc.type === "ParenthesizedExpression" ||
              anc.type === "ChainExpression")
          ) {
            curr = anc
            anc = anc.parent
          }
          if (!(anc != null && anc.type === "CallExpression" && anc.callee === curr)) {
            context.report({
              node,
              message:
                "bare-cause-has-interrupts: Point-free Cause.hasInterrupts or Cause.hasInterruptsOnly in production src/ can misclassify composite Fail+Interrupt causes — use isPureInterruptCause from @harness/contract instead.",
            })
          }
        }
        if (isWave3ProdSrc(filename) && isEffectNamespaceExpr(node.object)) {
          const effMemName = getEstreeStaticMemberName(node)
          if (effMemName === "ignore" || effMemName === "ignoreCause") {
            checkWave3IgnoreExprEstree(node, effMemName, filename)
          }
        }
        if (
          !isTestFilePath(filename) &&
          isPureTierProcessEnvBannedPath(filename) &&
          isProcessEnvMemberAst(node)
        ) {
          context.report({
            node,
            message:
              "process-env-outside-infra-or-app: Direct process.env access is banned outside type:infra and type:app — inject Config or read environment variables in @harness/infra or apps/*.",
          })
        }
        if (
          /libs\/[^/]+\/(?:domain|core)\/src\//.test(filename) &&
          node.computed !== true &&
          isEffectNamespaceExpr(node.object) &&
          isIdentifier(node.property, "ignore")
        ) {
          context.report({ node, message: domainEffectIgnoreMessage })
        }
        const isEnforcedRunSrc =
          !isTestFilePath(filename) &&
          /(?:^|\/)(?:libs\/[^/]+\/[^/]+\/src|apps\/[^/]+\/src)\//.test(filename)
        const accessMethodName =
          node.computed !== true && node.property?.type === "Identifier"
            ? node.property.name
            : node.computed === true
              ? getStaticModuleString(node.property)
              : null
        if (
          isEnforcedRunSrc &&
          accessMethodName != null &&
          isBannedEffectRunMethodName(accessMethodName, filename) &&
          (node.computed === true || isEffectNamespaceExpr(node.object))
        ) {
          const isMemoryWorkerdBridge = /(?:^|\/)libs\/es\/infra\/src\/memory\.ts$/.test(filename)
          const isAllowedMemoryDie = (() => {
            if (!isMemoryWorkerdBridge || accessMethodName !== "runSync") return false
            const parentCall = node.parent
            if (
              parentCall == null ||
              parentCall.type !== "CallExpression" ||
              parentCall.callee !== node
            ) {
              return false
            }
            const arg = unwrapEstree(parentCall.arguments?.[0])
            return (
              arg != null &&
              arg.type === "CallExpression" &&
              arg.callee != null &&
              arg.callee.type === "MemberExpression" &&
              arg.callee.computed !== true &&
              isEffectNamespaceExpr(arg.callee.object) &&
              isIdentifier(arg.callee.property, "die")
            )
          })()
          if (isAllowedMemoryDie) return
          const objText = getNodeSourceText(context, node.object) || "Effect"
          const targetLabel =
            node.computed === true
              ? `${objText}["${accessMethodName}"]`
              : `${objText}.${accessMethodName}`
          context.report({
            node,
            message: `unscoped-effect-run: '${targetLabel}' is banned in '${filename}' — compose Effects and execute via NodeRuntime.runMain or ManagedRuntime at the app edge.`,
          })
        }
      },
      TryStatement(node) {
        context.report({ node, message: tryMessage })
      },
      ThrowStatement(node) {
        context.report({ node, message: throwMessage })
      },
      CallExpression(node) {
        const filename = getNormalizedFilename()

        if (isWave3ProdSrc(filename)) {
          checkWave3SentinelEstree(node, filename)
          checkWave3RegExpEstree(node, filename)
          const effM = getWave3EffectMemberName(node.callee)
          if (
            effM != null &&
            Array.isArray(node.arguments) &&
            (WAVE3_CORE_SRC_RE.test(filename) ||
              isWave3InsideFinalizerOrCompEstree(
                node,
                getWave3EffectMemberName,
                scopeNamespaceNames,
              ))
          ) {
            const pipeStages = getWave3PipeStagesBeforeEstree(node)
            const isPiped = pipeStages != null
            if (effM === "orElseSucceed") {
              const isDataLast = isPiped || node.arguments.length === 1
              const cb = isDataLast ? node.arguments[0] : node.arguments[1]
              const stages = isDataLast ? pipeStages : [node.arguments[0]]
              if (
                cb != null &&
                isWave3EmptyOrVoidCallbackEstree(cb) &&
                !areWave3AllStagesPureLoggingEstree(stages, context, getWave3EffectMemberName)
              ) {
                reportOnce(
                  node,
                  `[silent-error-swallow] Silent Effect.orElseSucceed(() => void/undefined) in '${filename}' is banned — return a typed fallback or log/propagate the error.`,
                )
              }
            } else if (
              effM === "catch" ||
              effM === "catchAll" ||
              effM === "catchCause" ||
              effM === "catchAllCause" ||
              effM === "orElse"
            ) {
              const isDataLast = isPiped || node.arguments.length === 1
              const cb = isDataLast ? node.arguments[0] : node.arguments[1]
              const stages = isDataLast ? pipeStages : [node.arguments[0]]
              if (
                cb != null &&
                isWave3SilentCatchCallbackEstree(cb, context, getWave3EffectMemberName) &&
                !areWave3AllStagesPureLoggingEstree(stages, context, getWave3EffectMemberName)
              ) {
                reportOnce(
                  node,
                  `[silent-error-swallow] Silent Effect.${effM} returning void/undefined without logging or re-failing in '${filename}' is banned.`,
                )
              }
            } else if (effM === "catchTag" || effM === "catchIf") {
              const isDataLast = isPiped || node.arguments.length === 2
              const cb = isDataLast ? node.arguments[1] : node.arguments[2]
              const stages = isDataLast
                ? pipeStages
                : node.arguments[0] != null
                  ? [node.arguments[0]]
                  : null
              if (
                cb != null &&
                isWave3SilentCatchCallbackEstree(cb, context, getWave3EffectMemberName) &&
                !areWave3AllStagesPureLoggingEstree(stages, context, getWave3EffectMemberName)
              ) {
                reportOnce(
                  node,
                  `[silent-error-swallow] Silent Effect.${effM} returning void/undefined without logging or re-failing in '${filename}' is banned.`,
                )
              }
            } else if (effM === "catchTags") {
              const a0 = node.arguments[0]
              const isObjFirst = unwrapEstree(a0)?.type === "ObjectExpression"
              const isDataLast = isPiped || isObjFirst || node.arguments.length === 1
              const objExpr = isDataLast ? a0 : node.arguments[1]
              const stages = isDataLast ? pipeStages : a0 != null ? [a0] : null
              const obj = unwrapEstree(objExpr)
              if (
                obj?.type === "ObjectExpression" &&
                Array.isArray(obj.properties) &&
                !areWave3AllStagesPureLoggingEstree(stages, context, getWave3EffectMemberName) &&
                obj.properties.some(
                  (p) =>
                    p?.type === "Property" &&
                    isWave3SilentCatchCallbackEstree(p.value, context, getWave3EffectMemberName),
                )
              ) {
                reportOnce(
                  node,
                  `[silent-error-swallow] Silent Effect.catchTags handler returning void/undefined without logging or re-failing in '${filename}' is banned.`,
                )
              }
            }
          }
          const w3Callee = unwrapEstreeExpr(node.callee)
          const fnName =
            w3Callee?.type === "Identifier"
              ? w3Callee.name
              : w3Callee?.type === "MemberExpression"
                ? getEstreeStaticMemberName(w3Callee)
                : null
          const checkGitArrayEstree = (arrNode) => {
            if (
              arrNode == null ||
              arrNode.type !== "ArrayExpression" ||
              !Array.isArray(arrNode.elements)
            ) {
              return
            }
            let subIdx = -1
            let subName = null
            for (let i = 0; i < arrNode.elements.length; i++) {
              const s = getStaticModuleString(arrNode.elements[i])
              if (s == null) continue
              if (WAVE3_GIT_TWO_TOKEN_FLAGS.has(s)) {
                i++
                continue
              }
              if (s.startsWith("-")) continue
              subIdx = i
              subName = s
              break
            }
            if (subIdx === -1 || subName == null || !WAVE3_REF_RANGE_GIT_SUBCMDS.has(subName))
              return
            let seenEnd = false
            for (let i = subIdx + 1; i < arrNode.elements.length; i++) {
              const s = getStaticModuleString(arrNode.elements[i])
              if (s != null) {
                if (s === "--end-of-options") seenEnd = true
                if (s === "--") break
                continue
              }
              if (!seenEnd) {
                reportOnce(
                  node,
                  `[unsafe-dynamic-git-ref] Dynamic git '${subName}' ref argument in '${filename}' lacks preceding '--end-of-options' separator.`,
                )
                return
              }
            }
          }
          if (
            (fnName === "spawnSync" ||
              fnName === "execFile" ||
              fnName === "execFileSync" ||
              fnName === "execFileAsync" ||
              fnName === "execFileAsyncEffect") &&
            Array.isArray(node.arguments) &&
            node.arguments.length >= 2 &&
            getStaticModuleString(node.arguments[0]) === "git"
          ) {
            const arr = resolveWave3GitArgs(node.arguments[1])
            if (arr != null) checkGitArrayEstree(arr)
          } else if (
            fnName != null &&
            (fnName.startsWith("execGit") || fnName.startsWith("runGit")) &&
            Array.isArray(node.arguments)
          ) {
            for (const a of node.arguments) {
              const arr = resolveWave3GitArgs(a)
              if (arr != null) {
                checkGitArrayEstree(arr)
                break
              }
            }
          }
        }

        if (
          isRequireCallee(node.callee) &&
          Array.isArray(node.arguments) &&
          node.arguments.length >= 1
        ) {
          const reqSourceVal = getModulePrefixOrStaticString(node.arguments[0])
          if (
            reqSourceVal != null &&
            reqSourceVal.startsWith("@harness/") &&
            /(?:^|\/)(?:libs|apps)\/.*\/(?:src|test)\//.test(filename)
          ) {
            context.report({
              node,
              message: dynamicHarnessImportMessage(reqSourceVal, filename),
            })
          }
        }

        checkDiscriminantCollectionCallback(node, filename, discriminantAliasNames, context)

        if (
          /libs\/[^/]+\/(contract|domain|core|service|infra)\/src\//.test(filename) &&
          isSchemaBrandCall(node)
        ) {
          const brandKey = node.arguments[0].value
          const firstNode = declaredBrandKeys.get(brandKey)
          if (firstNode != null && firstNode !== node) {
            reportOnce(
              node,
              `Do not declare duplicate Schema.brand('${brandKey}') across multiple schemas — each brand key must have a single canonical constructor schema so validation invariants cannot be weakened. Compose wire or parameter schemas into the canonical branded schema using Schema.decodeTo(<BrandedSchema>) (e.g. Schema.FiniteFromString.pipe(Schema.decodeTo(${brandKey}))).`,
            )
          } else {
            declaredBrandKeys.set(brandKey, node)
          }
        }

        checkSchemaFieldObjects(node, filename)

        if (
          node.callee != null &&
          node.callee.type === "MemberExpression" &&
          node.callee.computed !== true &&
          node.callee.property != null &&
          node.callee.property.type === "Identifier"
        ) {
          const termName = node.callee.property.name
          if (termName === "run") {
            const chain = inspectMatchChain(node.callee.object)
            if (chain.isRootMatch) {
              context.report({ node, message: matchRunBanMessage })
            }
          } else if (termName === "otherwise") {
            const chain = inspectMatchChain(node.callee.object)
            if (
              chain.isRootMatch &&
              chain.withPatterns.length > 0 &&
              chain.withPatterns.every(isTagObjectPattern)
            ) {
              context.report({ node, message: matchTaggedOtherwiseBanMessage })
            }
          }
        }
        if (isJsonParse(node)) {
          context.report({ node, message: jsonParseMessage })
        }
        if (process.env.HARNESS_PLAN_CHECK !== "1" && isStubCall(node)) {
          context.report({ node, message: stubMessage })
        }
        if (isEffectFnCall(node)) {
          const arg0 = node.arguments[0]
          if (
            node.arguments.length === 0 ||
            arg0 == null ||
            arg0.type !== "Literal" ||
            typeof arg0.value !== "string" ||
            arg0.value.trim() === ""
          ) {
            context.report({ node, message: effectFnMessage })
          }
        }
        if (isSecretConfigCall(node)) {
          context.report({ node, message: secretConfigMessage })
        }
        if (isSqlInterpolationCall(node)) {
          context.report({ node, message: sqlInterpolationMessage })
        }
        if (isEffectRetryCall(node) && node.arguments.some(hasScheduleForever)) {
          context.report({ node, message: foreverRetryMessage })
        }
        if (filename.includes("sample-web/src/") && isFetchCall(node)) {
          context.report({ node, message: fetchBanMessage })
        }
        if (/libs\/[^/]+\/(?:domain|core)\/src\//.test(filename)) {
          const callee = node.callee
          if (
            callee != null &&
            callee.type === "MemberExpression" &&
            callee.computed !== true &&
            ((isIdentifier(callee.object, "Date") && isIdentifier(callee.property, "now")) ||
              (isIdentifier(callee.object, "Math") && isIdentifier(callee.property, "random")))
          ) {
            context.report({ node, message: impureDomainGlobalMessage })
          }
        }
        if (
          isRequireCallee(node.callee) &&
          Array.isArray(node.arguments) &&
          node.arguments.length >= 1
        ) {
          const sourceVal = getStaticModuleString(node.arguments[0])
          const drizzleSourceVal = getModulePrefixOrStaticString(node.arguments[0])
          if (drizzleSourceVal != null && isDrizzleSpecifier(drizzleSourceVal)) {
            reportOnce(node, bannedDrizzleMessage(drizzleSourceVal, filename))
          }
          if (
            /(?:libs\/[^/]+\/infra\/|apps\/)/.test(filename) &&
            isIdentifier(node.callee, "require") &&
            (sourceVal === "node:sqlite" ||
              sourceVal === "sqlite" ||
              sourceVal === "better-sqlite3")
          ) {
            reportOnce(node, nodeSqliteInfraMessage(sourceVal, filename))
          }
        }
        if (
          /libs\/[^/]+\/infra\/src\//.test(filename) &&
          !/(?:^|\/)libs\/harness\//.test(filename) &&
          node.callee != null &&
          node.callee.type === "MemberExpression" &&
          node.callee.computed !== true &&
          isIdentifier(node.callee.property, "fromRecord") &&
          Array.isArray(node.arguments) &&
          node.arguments.length >= 1
        ) {
          if (hasSqliteMigratorImport) {
            markAllowedDdlTemplates(node.arguments[0])
          }
          validateMigrationRecordObject(node.arguments[0])
        }

        const isTest = isTestFilePath(filename)
        const calleeName = getCalleeName(node.callee)

        if (
          !isTest &&
          /(?:^|\/)(?:libs\/[^/]+\/[^/]+\/src|apps\/[^/]+\/src)\//.test(filename) &&
          node.callee?.type === "Identifier" &&
          bannedRunAliases.has(node.callee.name)
        ) {
          const origMethod = bannedRunAliases.get(node.callee.name)
          context.report({
            node,
            message: `unscoped-effect-run: destructured 'Effect.${origMethod}' alias '${node.callee.name}' is banned in '${filename}' — compose Effects and execute via NodeRuntime.runMain or ManagedRuntime at the app edge.`,
          })
        }

        if (!isTest && isSilentFsFallbackCheckedPathEstree(filename)) {
          if (calleeName === "safeFs") {
            context.report({
              node,
              message: `silent-gate-fs-fallback: 'safeFs(...)' in '${filename}' silently swallows host I/O errors — propagate explicit 'unreadable-workspace-file' findings instead.`,
            })
          }
          const isResultGetOrElse =
            calleeName === "Result.getOrElse" &&
            Array.isArray(node.arguments) &&
            node.arguments.length >= 2
          if (isResultGetOrElse) {
            const firstArgText = context.sourceCode.getText(node.arguments[0])
            if (
              isSilentEmptyFallbackEstree(node.arguments[1], false) &&
              hasResultTryFsReadEstree(firstArgText)
            ) {
              context.report({
                node,
                message: `silent-gate-fs-fallback: 'Result.getOrElse(Result.try(...readTextSync|readdirSync...), () => ""|[])' in '${filename}' silently hides unreadable gate inputs — emit an explicit 'unreadable-workspace-file' finding instead.`,
              })
            }
          }
          const isPipeGetOrElseArg = (arg) =>
            arg != null &&
            arg.type === "CallExpression" &&
            getCalleeName(arg.callee) === "Result.getOrElse" &&
            Array.isArray(arg.arguments) &&
            arg.arguments.length === 1 &&
            isSilentEmptyFallbackEstree(arg.arguments[0], true)
          if (
            node.callee?.type === "MemberExpression" &&
            node.callee.computed !== true &&
            isIdentifier(node.callee.property, "pipe") &&
            hasResultTryFsReadEstree(context.sourceCode.getText(node.callee.object)) &&
            Array.isArray(node.arguments) &&
            node.arguments.some(isPipeGetOrElseArg)
          ) {
            context.report({
              node,
              message: `silent-gate-fs-fallback: 'Result.try(...).pipe(..., Result.getOrElse(...))' in '${filename}' silently hides unreadable gate inputs — emit an explicit 'unreadable-workspace-file' finding instead.`,
            })
          }
          if (
            calleeName === "pipe" &&
            Array.isArray(node.arguments) &&
            node.arguments.length >= 2 &&
            hasResultTryFsReadEstree(context.sourceCode.getText(node.arguments[0])) &&
            node.arguments.slice(1).some(isPipeGetOrElseArg)
          ) {
            context.report({
              node,
              message: `silent-gate-fs-fallback: 'pipe(Result.try(...), ..., Result.getOrElse(...))' in '${filename}' silently hides unreadable gate inputs — emit an explicit 'unreadable-workspace-file' finding instead.`,
            })
          }
          if (
            node.callee?.type === "MemberExpression" &&
            node.callee.computed !== true &&
            isIdentifier(node.callee.property, "with") &&
            Array.isArray(node.arguments) &&
            node.arguments.length >= 2 &&
            isSilentEmptyFallbackEstree(node.arguments[1], true)
          ) {
            const pat = unwrapEstree(node.arguments[0])
            const isFailurePat =
              pat != null &&
              pat.type === "ObjectExpression" &&
              Array.isArray(pat.properties) &&
              pat.properties.some(
                (p) =>
                  p != null &&
                  p.type === "Property" &&
                  getEstreeBindingPropName(p) === "_tag" &&
                  getStaticModuleString(p.value) === "Failure",
              )
            if (isFailurePat) {
              let curr = node.callee
              while (
                curr != null &&
                curr.type === "MemberExpression" &&
                curr.object != null &&
                curr.object.type === "CallExpression"
              ) {
                const innerCall = curr.object
                if (innerCall.callee?.type === "Identifier" && innerCall.callee.name === "match") {
                  const arg0 = innerCall.arguments?.[0]
                  if (arg0 != null && hasResultTryFsReadEstree(context.sourceCode.getText(arg0))) {
                    context.report({
                      node,
                      message: `silent-gate-fs-fallback: 'match(Result.try(...)).with({ _tag: "Failure" }, ...)' in '${filename}' silently hides unreadable gate inputs — emit an explicit 'unreadable-workspace-file' finding instead.`,
                    })
                  }
                  break
                }
                curr = innerCall.callee
              }
            }
          }
        }

        let isCatchCauseOnly = false
        if (!isTest && calleeName === "Cause.hasInterruptsOnly") {
          let anc = node.parent
          while (anc != null) {
            if (anc.type === "CallExpression") {
              const ancCallee = getCalleeName(anc.callee)
              if (
                ancCallee === "Effect.catchCause" ||
                ancCallee.endsWith(".catchCause") ||
                ancCallee === "catchCause" ||
                ancCallee === "Effect.runPromiseExit" ||
                ancCallee.endsWith(".runPromiseExit") ||
                ancCallee === "Effect.runSyncExit" ||
                ancCallee.endsWith(".runSyncExit")
              ) {
                isCatchCauseOnly = true
                break
              }
            }
            anc = anc.parent
          }
          if (isCatchCauseOnly) {
            context.report({
              node,
              message:
                "Cause.hasInterruptsOnly(cause) inside catchCause/runPromiseExit/runSyncExit is banned — use isPureInterruptCause(cause) or Cause.hasInterrupts(cause) && !Cause.hasFails(cause) && !Cause.hasDies(cause) so composite Fail+Interrupt causes are not misclassified.",
            })
          }
        }

        if (
          !isTest &&
          !isCatchCauseOnly &&
          /(?:^|\/)src\//.test(filename) &&
          !/(?:^|\/)libs\/harness\/contract\/src\/workspace-and-process\.ts$/.test(filename) &&
          (calleeName === "Cause.hasInterrupts" || calleeName === "Cause.hasInterruptsOnly")
        ) {
          if (calleeName === "Cause.hasInterruptsOnly") {
            context.report({
              node,
              message:
                "bare-cause-has-interrupts: Bare Cause.hasInterrupts(cause) or Cause.hasInterruptsOnly(cause) in production src/ can misclassify composite Fail+Interrupt causes — use isPureInterruptCause(cause) from @harness/contract (or Cause.hasInterrupts(cause) && !Cause.hasFails(cause) && !Cause.hasDies(cause)).",
            })
          } else {
            const firstArg = Array.isArray(node.arguments) ? node.arguments[0] : undefined
            if (firstArg == null) {
              context.report({
                node,
                message:
                  "bare-cause-has-interrupts: Bare Cause.hasInterrupts(cause) or Cause.hasInterruptsOnly(cause) in production src/ can misclassify composite Fail+Interrupt causes — use isPureInterruptCause(cause) from @harness/contract (or Cause.hasInterrupts(cause) && !Cause.hasFails(cause) && !Cause.hasDies(cause)).",
              })
            } else {
              const argText = getNodeSourceText(context, unwrapEstreeExpr(firstArg))
              let root = node
              let anc = node.parent
              while (anc != null) {
                if (anc.type === "LogicalExpression" && anc.operator === "&&") {
                  root = anc
                  anc = anc.parent
                  continue
                }
                if (anc.type === "ParenthesizedExpression" || anc.type === "ChainExpression") {
                  root = anc
                  anc = anc.parent
                  continue
                }
                break
              }
              const terms = []
              collectLogicalAndTermsAst(root, terms)
              const hasNegatedFails = terms.some((t) =>
                isNegatedCauseMethodCallAst(t, "hasFails", argText, context),
              )
              const hasNegatedDies = terms.some((t) =>
                isNegatedCauseMethodCallAst(t, "hasDies", argText, context),
              )
              if (!(hasNegatedFails && hasNegatedDies)) {
                context.report({
                  node,
                  message:
                    "bare-cause-has-interrupts: Bare Cause.hasInterrupts(cause) or Cause.hasInterruptsOnly(cause) in production src/ can misclassify composite Fail+Interrupt causes — use isPureInterruptCause(cause) from @harness/contract (or Cause.hasInterrupts(cause) && !Cause.hasFails(cause) && !Cause.hasDies(cause)).",
                })
              }
            }
          }
        }

        if (
          !isTest &&
          (calleeName === "Effect.catchDefect" || calleeName.endsWith(".catchDefect"))
        ) {
          const handlerArg = Array.isArray(node.arguments)
            ? node.arguments.length >= 2
              ? node.arguments[1]
              : node.arguments[0]
            : undefined
          if (handlerArg != null) {
            const argText = getNodeSourceText(context, handlerArg)
            const hasReportingOrRethrow =
              argText.includes("stderr.write") ||
              argText.includes("logWarning") ||
              argText.includes("logError") ||
              argText.includes("Effect.log") ||
              argText.includes("console.error") ||
              argText.includes("console.warn") ||
              argText.includes("Effect.fail") ||
              argText.includes("Effect.die") ||
              argText.includes("makeLspExceptionReport") ||
              argText.includes("ExceptionReport")
            if (!hasReportingOrRethrow) {
              context.report({
                node,
                message:
                  "Effect.catchDefect handler silently swallows runtime defects without logging or reporting — log via Effect.logWarning / process.stderr.write or re-fail.",
              })
            }
          }
        }

        if (
          !isTest &&
          (calleeName === "chmodSync" ||
            calleeName.endsWith(".chmodSync") ||
            calleeName === "fchmodSync" ||
            calleeName.endsWith(".fchmodSync"))
        ) {
          let anc = node.parent
          let isIgnored = false
          for (let depth = 0; depth < 8 && anc != null; depth += 1) {
            if (anc.type === "CallExpression") {
              const ancCallee = getCalleeName(anc.callee)
              if (ancCallee === "Effect.ignore" || ancCallee === "Effect.orElseSucceed") {
                isIgnored = true
                break
              }
              if (ancCallee === "pipe" || ancCallee.endsWith(".pipe")) {
                const pipeText = getNodeSourceText(context, anc)
                if (
                  pipeText.includes("Effect.ignore") ||
                  pipeText.includes("Effect.orElseSucceed")
                ) {
                  isIgnored = true
                  break
                }
              }
            }
            anc = anc.parent
          }
          if (isIgnored) {
            context.report({
              node,
              message:
                "Ignoring chmodSync/fchmodSync failure with Effect.ignore or Effect.orElseSucceed is banned — permission hardening must fail closed on error.",
            })
          }
        }
      },
      ExportAllDeclaration(node) {
        const filename = getNormalizedFilename()
        if (
          /(?:^|\/)(?:libs|apps)\/.*\/src\/index\.ts$/.test(filename) ||
          /(?:^|\/)libs\/harness\/graph\/src\/(?:type-extractor|datalog-engine|graph-rewrite|graph-engine|graph-projector)\.ts$/.test(
            filename,
          )
        ) {
          reportOnce(
            node,
            `facade-star-reexport: Wildcard 'export *' re-export in '${filename}' is banned — use explicit named re-exports (export { ... } from "./...") instead of export * from.`,
          )
        }
        if (
          node.source != null &&
          typeof node.source.value === "string" &&
          isDrizzleSpecifier(node.source.value)
        ) {
          reportOnce(node, bannedDrizzleMessage(node.source.value, filename))
        }
      },
      ExportNamedDeclaration(node) {
        const filename = getNormalizedFilename()
        if (
          node.source != null &&
          typeof node.source.value === "string" &&
          isDrizzleSpecifier(node.source.value)
        ) {
          reportOnce(node, bannedDrizzleMessage(node.source.value, filename))
        }
        if (!/libs\/[^/]+\/(contract|domain|core|service|infra)\/src\//.test(filename)) return
        if (node.declaration == null) return

        const decl = node.declaration
        if (decl.type === "ClassDeclaration") {
          checkContextServiceClass(decl, filename)
          return
        }

        if (decl.type === "TSTypeAliasDeclaration" || decl.type === "TSInterfaceDeclaration") {
          const typeName = decl.id != null ? decl.id.name : null
          if (typeName != null) {
            const matchingSchema = findMatchingSchemaVar(typeName)
            if (matchingSchema != null) {
              let isLoose = false
              if (decl.type === "TSInterfaceDeclaration") {
                isLoose = true
              } else if (decl.type === "TSTypeAliasDeclaration" && decl.typeAnnotation != null) {
                if (containsInlineObjectTypeNode(decl.typeAnnotation)) {
                  isLoose = true
                }
              }
              if (isLoose) {
                reportOnce(
                  decl,
                  `Do not declare loose handwritten TypeScript type/interface '${typeName}' alongside '${matchingSchema}' — derive the type directly via Schema.Schema.Type<typeof ${matchingSchema}> (or Schema.Schema.Type<ReturnType<typeof ${matchingSchema}>>) to preserve schema constraints.`,
                )
                return
              }
            }
          }
          if (
            decl.type === "TSInterfaceDeclaration" &&
            /libs\/[^/]+\/(contract|domain|core)\/src\//.test(filename) &&
            decl.body != null &&
            Array.isArray(decl.body.body)
          ) {
            for (const member of decl.body.body) {
              if (
                member != null &&
                member.type === "TSPropertySignature" &&
                member.key != null &&
                member.key.type === "Identifier" &&
                BOOLEAN_STATE_PROP_REGEX.test(member.key.name) &&
                member.typeAnnotation != null &&
                getRawPrimitiveKeywordInfo(member.typeAnnotation.typeAnnotation)?.prim === "boolean"
              ) {
                reportOnce(member, schemaBooleanStateMessage)
              }
            }
          }
          if (decl.type === "TSTypeAliasDeclaration") {
            checkTypeAliasDeclaration(decl, filename)
          }
          return
        }

        if (/libs\/[^/]+\/contract\/src\//.test(filename) && decl.type === "VariableDeclaration") {
          for (const varDecl of decl.declarations) {
            if (varDecl.id != null && varDecl.id.type === "Identifier" && varDecl.init != null) {
              const varName = varDecl.id.name
              if (QUANTITY_OR_VERSION_PROP_REGEX.test(varName)) {
                const uncheckedIntOrNumber = getUncheckedSchemaIntOrNumberName(varDecl.init)
                if (uncheckedIntOrNumber != null) {
                  const suggestedBrand = toPascalCase(varName)
                  reportOnce(
                    varDecl,
                    `Do not use Schema.${uncheckedIntOrNumber} for quantity, version, or count schema '${varName}' — use Schema.Natural (non-negative) or Schema.PositiveInt piped into Schema.brand('${suggestedBrand}') (e.g. Schema.Natural.pipe(Schema.brand('${suggestedBrand}'))) to prevent negative domain values and enforce nominal branding.`,
                  )
                }
              }
              if (hasSchemaBrandInTree(varDecl.init, brandedTypeNames)) {
                brandedTypeNames.add(varName)
              } else {
                const unbrandedScalar = getUnbrandedScalarSchemaName(
                  varDecl.init,
                  unbrandedSchemaVarNames,
                  brandedTypeNames,
                )
                if (unbrandedScalar != null) {
                  unbrandedSchemaVarNames.set(varName, unbrandedScalar)
                  reportOnce(
                    varDecl,
                    `Do not export unbranded primitive schema '${varName}' from type:contract — pipe into Schema.brand('${varName}') (e.g. Schema.${unbrandedScalar}.pipe(Schema.brand('${varName}'))) and export type ${varName} = typeof ${varName}.Type so the decoded type carries a compile-time brand.`,
                  )
                }
              }
              if (varDecl.init != null && isAllOptionalSchemaStructEstree(varDecl.init)) {
                reportOnce(
                  varDecl,
                  `[all-optional-contract-struct] Schema.Struct '${varName}' has all Schema.optional(...) fields in '${filename}' — require canonical non-optional contract fields.`,
                )
              }
            }
          }
          return
        }

        if (!/libs\/[^/]+\/(domain|core|service|infra)\/src\//.test(filename)) return

        if (decl.type === "FunctionDeclaration") {
          if (/libs\/[^/]+\/(domain|service|infra)\/src\//.test(filename)) {
            context.report({ node: decl, message: domainExportMessage })
          }
          if (/libs\/[^/]+\/(?:domain|core)\/src\//.test(filename)) {
            const fnName = decl.id != null && decl.id.type === "Identifier" ? decl.id.name : "fn"
            checkDomainBoundaryFunctionNode(decl, fnName)
          }
          return
        }

        if (decl.type === "VariableDeclaration") {
          const isDomain = /libs\/[^/]+\/domain\/src\//.test(filename)
          const isDomainServiceOrInfra = /libs\/[^/]+\/(domain|service|infra)\/src\//.test(filename)
          for (const varDecl of decl.declarations) {
            const init = varDecl.init
            if (init == null) continue
            if (isDomainServiceOrInfra) {
              if (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") {
                context.report({ node: varDecl, message: domainExportMessage })
              } else if (init.type === "CallExpression") {
                if (isUntracedEffectCall(init) || (isDomain && !isEffectFnInvocation(init))) {
                  context.report({ node: varDecl, message: domainExportMessage })
                }
              }
            }
            checkDomainBoundaryVarDeclarator(varDecl, filename)
          }
        }
      },
      ExpressionStatement(node) {
        const filename = getNormalizedFilename()
        if (
          !isTestFilePath(filename) &&
          /(?:^|\/)(?:libs|apps)\/.*\/src\//.test(filename) &&
          isDiscardedPersistenceCallStatementEstree(node)
        ) {
          reportOnce(
            node,
            `[discarded-persistence-result] Discarded persistence call result in '${filename}' is banned — inspect or propagate the returned Result/Effect.`,
          )
        }
      },
      Literal(node) {
        if (typeof node.value !== "string") return
        const filename = getNormalizedFilename()
        checkWave3SentinelEstree(node, filename)
        if (
          isClefEndpointCheckedSrcFile(filename) &&
          isInvalidClefEndpointLiteralText(node.value)
        ) {
          reportOnce(node, invalidClefEndpointMessage)
        }
      },
      TemplateLiteral(node) {
        const filename = getNormalizedFilename()
        checkWave3SentinelEstree(node, filename)
        if (!isClefEndpointCheckedSrcFile(filename) || !Array.isArray(node.quasis)) return
        const text = node.quasis
          .map((q) => (q != null && q.value != null ? (q.value.cooked ?? q.value.raw ?? "") : ""))
          .join("")
        if (isInvalidClefEndpointLiteralText(text)) {
          reportOnce(node, invalidClefEndpointMessage)
        }
      },
    }
  },
}

const testIntegrity = {
  create(context) {
    const discriminantAliasNames = createDiscriminantAliasTracker()

    function getNormalizedFilename() {
      return (
        context.filename ?? (typeof context.getFilename === "function" ? context.getFilename() : "")
      ).replace(/\\/g, "/")
    }

    return {
      Program(node) {
        const sc = getSourceCode(context)
        const rawText = readFullSourceText(sc, node)
        if (rawText === undefined) {
          context.report({
            node,
            message:
              "missing-source-code: Unable to access sourceCode.text or sourceCode.getText() for AST inspection.",
          })
        }
        discriminantAliasNames.clear()
        const text = rawText ?? ""
        if (
          /^\s*(\/\/|\/\*)\s*(oxlint-disable|eslint-disable)[^\n]*(harness\/test-integrity|effecttsgo\/)/m.test(
            text,
          ) ||
          /^\s*(\/\/|\/\*)\s*@effect-diagnostics(-next-line)?\b/m.test(text)
        ) {
          context.report({ node, message: effectTsgoDisableMessage })
        }
        if (/^\s*(\/\/|\/\*)\s*@ts-(ignore|nocheck)\b/m.test(text)) {
          context.report({ node, message: testTsIgnoreMessage })
        }
        const normalized = getNormalizedFilename()
        checkWorkflowNameInsteadOfTagEstree(node, normalized, (target, message) => {
          context.report({ node: target, message })
        })
        checkMaxTestCaseLinesEstree(node, normalized, (target, message) => {
          context.report({ node: target, message })
        })
        checkMaxTestFileLinesEstree(node, text, normalized, (target, message) => {
          context.report({ node: target, message })
        })
        checkMaxTestsPerFileEstree(node, normalized, (target, message) => {
          context.report({ node: target, message })
        })
      },
      ImportDeclaration(node) {
        const filename = getNormalizedFilename()
        if (node.source != null && typeof node.source.value === "string") {
          const importSource = node.source.value
          if (isDrizzleSpecifier(importSource)) {
            context.report({
              node,
              message: bannedDrizzleMessage(importSource, filename),
            })
          }
          if (
            /(?:libs\/[^/]+\/infra\/|apps\/)/.test(filename) &&
            (importSource === "node:sqlite" ||
              importSource === "sqlite" ||
              importSource === "better-sqlite3")
          ) {
            context.report({
              node,
              message: `Do not import '${importSource}' in type:infra or type:app tests ('${filename}') — execute Cloudflare Durable Object SQLite and D1 tests against the real workerd runtime via @alchemy.run/cloudflare-runtime instead of hand-rolled node:sqlite mocks (harness:ADR-0008, harness:SPEC-0006, node-sqlite-in-infra).`,
            })
          }
        }
      },
      ExportNamedDeclaration(node) {
        const filename = getNormalizedFilename()
        if (
          node.source != null &&
          typeof node.source.value === "string" &&
          isDrizzleSpecifier(node.source.value)
        ) {
          context.report({
            node,
            message: bannedDrizzleMessage(node.source.value, filename),
          })
        }
      },
      ExportAllDeclaration(node) {
        const filename = getNormalizedFilename()
        if (
          node.source != null &&
          typeof node.source.value === "string" &&
          isDrizzleSpecifier(node.source.value)
        ) {
          context.report({
            node,
            message: bannedDrizzleMessage(node.source.value, filename),
          })
        }
      },
      ImportExpression(node) {
        const filename = getNormalizedFilename()
        const importSource = getStaticModuleString(node.source)
        const drizzleSourceVal = getModulePrefixOrStaticString(node.source)
        if (drizzleSourceVal != null && isDrizzleSpecifier(drizzleSourceVal)) {
          context.report({
            node,
            message: bannedDrizzleMessage(drizzleSourceVal, filename),
          })
        }
        if (
          drizzleSourceVal != null &&
          drizzleSourceVal.startsWith("@harness/") &&
          /(?:^|\/)(?:libs|apps)\/.*\/(?:src|test)\//.test(filename)
        ) {
          context.report({
            node,
            message: dynamicHarnessImportMessage(drizzleSourceVal, filename),
          })
        }
        if (
          importSource != null &&
          /(?:libs\/[^/]+\/infra\/|apps\/)/.test(filename) &&
          (importSource === "node:sqlite" ||
            importSource === "sqlite" ||
            importSource === "better-sqlite3")
        ) {
          context.report({
            node,
            message: `Do not import '${importSource}' in type:infra or type:app tests ('${filename}') — execute Cloudflare Durable Object SQLite and D1 tests against the real workerd runtime via @alchemy.run/cloudflare-runtime instead of hand-rolled node:sqlite mocks (harness:ADR-0008, harness:SPEC-0006, node-sqlite-in-infra).`,
          })
        }
      },
      TSImportEqualsDeclaration(node) {
        const filename = getNormalizedFilename()
        if (
          node.moduleReference != null &&
          node.moduleReference.type === "TSExternalModuleReference"
        ) {
          const importSource = getStaticModuleString(node.moduleReference.expression)
          if (importSource != null && isDrizzleSpecifier(importSource)) {
            context.report({
              node,
              message: bannedDrizzleMessage(importSource, filename),
            })
          }
        }
      },
      TSAnyKeyword(node) {
        context.report({ node, message: explicitAnyBanMessage })
      },
      TSAsExpression(node) {
        checkAsOrTypeAssertion(context, node)
      },
      TSTypeAssertion(node) {
        checkAsOrTypeAssertion(context, node)
      },
      VariableDeclarator(node) {
        checkNeverVariableDeclarator(context, node)
        recordDiscriminantAliasesFromBinding(node.id, node.init, discriminantAliasNames)
      },
      AssignmentExpression(node) {
        recordDiscriminantAliasesFromBinding(node.left, node.right, discriminantAliasNames)
      },
      BlockStatement() {
        discriminantAliasNames.pushScope()
      },
      "BlockStatement:exit"() {
        discriminantAliasNames.popScope()
      },
      FunctionDeclaration(node) {
        discriminantAliasNames.pushScope()
        recordFunctionParamDiscriminantAliases(node, discriminantAliasNames)
        checkNeverParams(context, node)
      },
      "FunctionDeclaration:exit"() {
        discriminantAliasNames.popScope()
      },
      FunctionExpression(node) {
        discriminantAliasNames.pushScope()
        recordFunctionParamDiscriminantAliases(node, discriminantAliasNames)
        checkNeverParams(context, node)
      },
      "FunctionExpression:exit"() {
        discriminantAliasNames.popScope()
      },
      ArrowFunctionExpression(node) {
        discriminantAliasNames.pushScope()
        recordFunctionParamDiscriminantAliases(node, discriminantAliasNames)
        checkNeverParams(context, node)
      },
      "ArrowFunctionExpression:exit"() {
        discriminantAliasNames.popScope()
      },
      IfStatement(node) {
        const filename = getNormalizedFilename()
        if (!isEnforcedWorkspaceFile(filename)) return
        if (
          isDiscriminantTestExpression(node.test) ||
          isAliasedDiscriminantTest(node.test, discriminantAliasNames)
        ) {
          context.report({ node, message: discriminantIfBanMessage })
        }
        if (isConditionalPortBindBailoutEstree(node)) {
          context.report({
            node,
            message: `[conditional-port-bind-bailout] Conditional port-bind bailout ('if (!bound) return') in '${filename}' silently skips test assertions.`,
          })
        }
      },
      ConditionalExpression(node) {
        const filename = getNormalizedFilename()
        if (!isEnforcedWorkspaceFile(filename)) return
        if (
          isDiscriminantTestExpression(node.test) ||
          isAliasedDiscriminantTest(node.test, discriminantAliasNames)
        ) {
          context.report({ node, message: discriminantIfBanMessage })
        }
      },
      CallExpression(node) {
        if (isSkippedOrFocusedTestCall(node)) {
          context.report({ node, message: testSkipOrOnlyMessage })
        }
        const filename = getNormalizedFilename()
        if (
          isRequireCallee(node.callee) &&
          Array.isArray(node.arguments) &&
          node.arguments.length >= 1
        ) {
          const importSource = getStaticModuleString(node.arguments[0])
          const drizzleSourceVal = getModulePrefixOrStaticString(node.arguments[0])
          if (drizzleSourceVal != null && isDrizzleSpecifier(drizzleSourceVal)) {
            context.report({
              node,
              message: bannedDrizzleMessage(drizzleSourceVal, filename),
            })
          }
          if (
            drizzleSourceVal != null &&
            drizzleSourceVal.startsWith("@harness/") &&
            /(?:^|\/)(?:libs|apps)\/.*\/(?:src|test)\//.test(filename)
          ) {
            context.report({
              node,
              message: dynamicHarnessImportMessage(drizzleSourceVal, filename),
            })
          }
          if (
            /(?:libs\/[^/]+\/infra\/|apps\/)/.test(filename) &&
            isIdentifier(node.callee, "require") &&
            (importSource === "node:sqlite" ||
              importSource === "sqlite" ||
              importSource === "better-sqlite3")
          ) {
            context.report({
              node,
              message: `Do not import '${importSource}' in type:infra or type:app tests ('${filename}') — execute Cloudflare Durable Object SQLite and D1 tests against the real workerd runtime via @alchemy.run/cloudflare-runtime instead of hand-rolled node:sqlite mocks (harness:ADR-0008, harness:SPEC-0006, node-sqlite-in-infra).`,
            })
          }
        }
        if (isEnforcedWorkspaceFile(filename)) {
          checkDiscriminantCollectionCallback(
            node,
            filename,
            discriminantAliasNames,
            context,
            RETRIEVAL_DISCRIMINANT_PROP_NAMES,
          )
          if (isImpreciseFailureAssert(node)) {
            context.report({ node, message: impreciseFailureAssertMessage })
          }
          if (isVacuousLengthNonNegativeAssertionEstree(node)) {
            context.report({
              node,
              message: `[vacuous-length-nonnegative-assertion] Vacuous 'expect(...length).toBeGreaterThanOrEqual(0)' assertion in '${filename}' is always true — assert exact length or element contents.`,
            })
          }
          if (
            isPropertyTestCall(node) &&
            Array.isArray(node.arguments) &&
            node.arguments.length > 0
          ) {
            const callbackArg = node.arguments[node.arguments.length - 1]
            if (callbackArg != null) {
              const callbackText = getNodeSourceText(context, callbackArg)
              if (
                (callbackText.includes("fold(") || /\bfold\s*\(/.test(callbackText)) &&
                /\.reduce\s*\(\s*(?:(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>\s*)?[a-zA-Z0-9_$.]*\b(?:evolve|reduce)\w*/i.test(
                  callbackText,
                )
              ) {
                context.report({ node, message: tautologicalFoldPropMessage })
              }
              const vacuousCalls = findVacuousAssertionCalls(callbackArg)
              for (const vacuousNode of vacuousCalls) {
                context.report({ node: vacuousNode, message: vacuousPropertyAssertMessage })
              }
            }
          }
        }
      },
      SwitchStatement(node) {
        context.report({ node, message: switchBanMessage })
      },
    }
  },
}

export default {
  meta: {
    name: "harness",
  },
  rules: {
    "syntax-bans": syntaxBans,
    "test-integrity": testIntegrity,
  },
}
