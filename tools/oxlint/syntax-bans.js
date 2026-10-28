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
  "Raw SQL template interpolation in .exec(`...${...}`) or .prepare(`...${...}`) is banned (SQL injection risk) — use parameterized queries or Drizzle ORM."
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

const BOOLEAN_STATE_PROP_REGEX =
  /^(is[A-Z]|has[A-Z]|checkedOut|created|completed|cancelled|canceled|deleted|archived|active|closed|opened|approved|rejected|verified|published|expired)$/

const QUANTITY_OR_VERSION_PROP_REGEX =
  /^(qty|quantity|[a-z0-9]+Qty|[a-z0-9]+Quantity|streamVersion|[a-z0-9]+StreamVersion|nextExpectedStreamVersion|availableQty|reservedQty|orderedQty)$/i

const DISCRIMINANT_CALLBACK_METHODS = new Set(["filter", "find", "some", "every"])

const DISCRIMINANT_PROP_NAMES = new Set([
  "_tag",
  "kind",
  "status",
  "verdict",
  "role",
  "state"
])

function isInternalHarnessFile(filename) {
  return /(^|\/)(libs\/harness|apps\/harness-[^/]+)\//.test(filename)
}

function isDiscriminantMemberAccess(node) {
  if (node == null || node.type !== "MemberExpression" || node.computed === true) {
    return false
  }
  const prop = node.property
  return prop != null && prop.type === "Identifier" && DISCRIMINANT_PROP_NAMES.has(prop.name)
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

function isLiteralValue(node) {
  if (node == null) return false
  if (node.type === "Literal") return true
  if (node.type === "TemplateLiteral" && Array.isArray(node.expressions) && node.expressions.length === 0) {
    return true
  }
  return false
}

function isDiscriminantTestExpression(node) {
  if (node == null || typeof node !== "object") return false
  if (isTagGuardCall(node)) return true
  if (node.type === "UnaryExpression" && node.operator === "!" && isDiscriminantTestExpression(node.argument)) {
    return true
  }
  if (node.type === "LogicalExpression") {
    return isDiscriminantTestExpression(node.left) || isDiscriminantTestExpression(node.right)
  }
  if (
    node.type === "BinaryExpression" &&
    (node.operator === "===" || node.operator === "!==" || node.operator === "==" || node.operator === "!=")
  ) {
    if (isDiscriminantMemberAccess(node.left) && isLiteralValue(node.right)) {
      return true
    }
    if (isDiscriminantMemberAccess(node.right) && isLiteralValue(node.left)) {
      return true
    }
  }
  return false
}

function isAliasedDiscriminantTest(node, aliasNames) {
  if (node == null || typeof node !== "object" || aliasNames == null || aliasNames.size === 0) {
    return false
  }
  if (
    node.type === "UnaryExpression" &&
    node.operator === "!" &&
    isAliasedDiscriminantTest(node.argument, aliasNames)
  ) {
    return true
  }
  if (node.type === "LogicalExpression") {
    return (
      isAliasedDiscriminantTest(node.left, aliasNames) ||
      isAliasedDiscriminantTest(node.right, aliasNames)
    )
  }
  if (
    node.type === "BinaryExpression" &&
    (node.operator === "===" || node.operator === "!==" || node.operator === "==" || node.operator === "!=")
  ) {
    if (node.left != null && node.left.type === "Identifier" && aliasNames.has(node.left.name)) {
      return true
    }
    if (node.right != null && node.right.type === "Identifier" && aliasNames.has(node.right.name)) {
      return true
    }
  }
  return false
}

function getCallbackPredicateExpression(fnNode) {
  if (fnNode == null) return null
  if (fnNode.type === "ArrowFunctionExpression") {
    if (fnNode.body != null && fnNode.body.type !== "BlockStatement") {
      return fnNode.body
    }
  }
  if (
    (fnNode.type === "ArrowFunctionExpression" || fnNode.type === "FunctionExpression") &&
    fnNode.body != null &&
    fnNode.body.type === "BlockStatement" &&
    Array.isArray(fnNode.body.body)
  ) {
    const returnStmt = fnNode.body.body.find(
      (stmt) => stmt != null && stmt.type === "ReturnStatement"
    )
    return returnStmt ? returnStmt.argument : null
  }
  return null
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

function findVacuousAssertionCalls(root) {
  const matches = []
  function walk(node) {
    if (node == null || typeof node !== "object") return
    if (isVacuousAssertionCall(node)) {
      matches.push(node)
      return
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

function getPropertyKeyName(prop) {
  if (prop == null || prop.key == null) return null
  if (prop.key.type === "Identifier") return prop.key.name
  if (prop.key.type === "Literal" && typeof prop.key.value === "string") return prop.key.value
  return null
}

function getNodeSourceText(context, node) {
  if (node == null) return ""
  if (node.rawSource && typeof node.rawSource === "string") {
    return node.rawSource
  }
  if (context.sourceCode && typeof context.sourceCode.getText === "function") {
    try {
      const text = context.sourceCode.getText(node)
      if (typeof text === "string" && text.length > 0) return text
    } catch {
      // fallback
    }
  }
  if (typeof context.getSourceCode === "function") {
    try {
      const sc = context.getSourceCode()
      if (sc && typeof sc.getText === "function") {
        const text = sc.getText(node)
        if (typeof text === "string" && text.length > 0) return text
      }
    } catch {
      // fallback
    }
  }
  const fullText =
    context.sourceCode && typeof context.sourceCode.text === "string"
      ? context.sourceCode.text
      : ""
  if (fullText) {
    if (Array.isArray(node.range) && node.range.length >= 2) {
      return fullText.slice(node.range[0], node.range[1])
    }
    if (typeof node.start === "number" && typeof node.end === "number") {
      return fullText.slice(node.start, node.end)
    }
    return fullText
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
    curr != null &&
    curr.type === "CallExpression" &&
    isIdentifier(curr.callee, "match")
  return { isRootMatch, withPatterns }
}

function isTagObjectPattern(patternNode) {
  if (patternNode == null || patternNode.type !== "ObjectExpression" || !Array.isArray(patternNode.properties)) {
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
  if (node.callee != null && node.callee.type === "CallExpression" && isEffectFnCall(node.callee)) return true
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

const syntaxBans = {
  create(context) {
    const discriminantAliasNames = new Set()
    const schemaVarNames = new Set()

    function getNormalizedFilename() {
      return (
        context.filename ??
        (typeof context.getFilename === "function" ? context.getFilename() : "")
      ).replace(/\\/g, "/")
    }

    function reportAsync(node) {
      if (node.async === true) {
        context.report({ node, message: asyncMessage })
      }
    }

    return {
      Program(node) {
        discriminantAliasNames.clear()
        schemaVarNames.clear()
        if (node.body && Array.isArray(node.body)) {
          for (const stmt of node.body) {
            if (stmt.type === "VariableDeclaration" && Array.isArray(stmt.declarations)) {
              for (const decl of stmt.declarations) {
                if (decl.id && decl.id.type === "Identifier") {
                  if (decl.id.name.endsWith("Schema") || decl.id.name.startsWith("make")) {
                    schemaVarNames.add(decl.id.name)
                  }
                }
              }
            } else if (stmt.type === "ExportNamedDeclaration" && stmt.declaration) {
              if (stmt.declaration.type === "VariableDeclaration" && Array.isArray(stmt.declaration.declarations)) {
                for (const decl of stmt.declaration.declarations) {
                  if (decl.id && decl.id.type === "Identifier") {
                    if (decl.id.name.endsWith("Schema") || decl.id.name.startsWith("make")) {
                      schemaVarNames.add(decl.id.name)
                    }
                  }
                }
              } else if (stmt.declaration.type === "FunctionDeclaration" && stmt.declaration.id) {
                if (stmt.declaration.id.name.endsWith("Schema") || stmt.declaration.id.name.startsWith("make")) {
                  schemaVarNames.add(stmt.declaration.id.name)
                }
              }
            } else if (stmt.type === "FunctionDeclaration" && stmt.id) {
              if (stmt.id.name.endsWith("Schema") || stmt.id.name.startsWith("make")) {
                schemaVarNames.add(stmt.id.name)
              }
            }
          }
        }
        const text =
          context.sourceCode && typeof context.sourceCode.text === "string"
            ? context.sourceCode.text
            : ""
        if (
          /^\s*(\/\/|\/\*)\s*(oxlint-disable|eslint-disable)[^\n]*(effecttsgo\/|harness\/)/m.test(text) ||
          /oxlint-disable[^\n]*effecttsgo\//.test(text) ||
          /^\s*(\/\/|\/\*)\s*@effect-diagnostics(-next-line)?\b/m.test(text)
        ) {
          context.report({ node, message: effectTsgoDisableMessage })
        }
        if (/^\s*(\/\/|\/\*)\s*@ts-(ignore|expect-error|nocheck)\b/m.test(text)) {
          context.report({ node, message: tsSuppressionMessage })
        }
      },
      VariableDeclarator(node) {
        if (
          node.id != null &&
          node.id.type === "Identifier" &&
          isDiscriminantMemberAccess(node.init)
        ) {
          discriminantAliasNames.add(node.id.name)
        }
      },
      FunctionDeclaration: reportAsync,
      FunctionExpression: reportAsync,
      ArrowFunctionExpression: reportAsync,
      AwaitExpression(node) {
        context.report({ node, message: asyncMessage })
      },
      SwitchStatement(node) {
        const filename = getNormalizedFilename()
        if (!isInternalHarnessFile(filename)) {
          context.report({ node, message: switchBanMessage })
        }
      },
      IfStatement(node) {
        const filename = getNormalizedFilename()
        if (isInternalHarnessFile(filename)) return
        if (
          isDiscriminantTestExpression(node.test) ||
          isAliasedDiscriminantTest(node.test, discriminantAliasNames)
        ) {
          context.report({ node, message: discriminantIfBanMessage })
          return
        }
        if (node.alternate != null && node.alternate.type === "IfStatement") {
          context.report({ node, message: elseIfBanMessage })
        }
      },
      ConditionalExpression(node) {
        const filename = getNormalizedFilename()
        if (isInternalHarnessFile(filename)) return
        if (
          isDiscriminantTestExpression(node.test) ||
          isAliasedDiscriminantTest(node.test, discriminantAliasNames)
        ) {
          context.report({ node, message: discriminantIfBanMessage })
        }
      },
      NewExpression(node) {
        if (isNewPromise(node)) {
          context.report({ node, message: newPromiseMessage })
        }
        const filename = getNormalizedFilename()
        if (/libs\/[^/]+\/domain\/src\//.test(filename) && isIdentifier(node.callee, "Date")) {
          context.report({ node, message: impureDomainGlobalMessage })
        }
      },
      MemberExpression(node) {
        const filename = getNormalizedFilename()
        if (
          /libs\/[^/]+\/domain\/src\//.test(filename) &&
          node.computed !== true &&
          isIdentifier(node.object, "Effect") &&
          isIdentifier(node.property, "ignore")
        ) {
          context.report({ node, message: domainEffectIgnoreMessage })
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
        if (!isInternalHarnessFile(filename)) {
          if (
            node.callee != null &&
            node.callee.type === "MemberExpression" &&
            node.callee.computed !== true &&
            node.callee.property != null &&
            node.callee.property.type === "Identifier" &&
            DISCRIMINANT_CALLBACK_METHODS.has(node.callee.property.name)
          ) {
            const callbackArg = node.arguments[0]
            const predExpr = getCallbackPredicateExpression(callbackArg)
            if (
              predExpr != null &&
              (isDiscriminantTestExpression(predExpr) ||
                isAliasedDiscriminantTest(predExpr, discriminantAliasNames))
            ) {
              context.report({ node, message: discriminantIfBanMessage })
            }
          }

          if (
            node.callee != null &&
            node.callee.type === "MemberExpression" &&
            node.callee.computed !== true &&
            isIdentifier(node.callee.object, "Schema") &&
            isIdentifier(node.callee.property, "Struct") &&
            node.arguments.length > 0 &&
            node.arguments[0] != null &&
            node.arguments[0].type === "ObjectExpression" &&
            Array.isArray(node.arguments[0].properties)
          ) {
            for (const prop of node.arguments[0].properties) {
              if (
                prop == null ||
                (prop.type !== "Property" && prop.type !== "ObjectProperty") ||
                prop.computed === true
              ) {
                continue
              }
              const keyName = getPropertyKeyName(prop)
              if (
                keyName != null &&
                BOOLEAN_STATE_PROP_REGEX.test(keyName) &&
                isSchemaBoolean(prop.value)
              ) {
                context.report({ node: prop, message: schemaBooleanStateMessage })
              }
              if (
                keyName != null &&
                QUANTITY_OR_VERSION_PROP_REGEX.test(keyName) &&
                isSchemaIntOrNumber(prop.value)
              ) {
                const unwrapped = unwrapSchemaModifier(prop.value)
                const propType = unwrapped && unwrapped.property ? unwrapped.property.name : "Int"
                context.report({
                  node: prop,
                  message: `Do not use Schema.${propType} for quantity, version, or count field '${keyName}' in Schema.Struct — use Schema.Natural (non-negative) or Schema.PositiveInt to prevent negative domain values.`
                })
              }
            }
          }
        }

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
        if (/libs\/[^/]+\/domain\/src\//.test(filename)) {
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
      },
      ExportNamedDeclaration(node) {
        const filename = getNormalizedFilename()
        if (isInternalHarnessFile(filename)) return
        if (!/libs\/[^/]+\/(contract|domain|service|infra)\/src\//.test(filename)) return
        if (node.declaration == null) return

        const decl = node.declaration
        if (decl.type === "TSTypeAliasDeclaration" || decl.type === "TSInterfaceDeclaration") {
          const typeName = decl.id != null ? decl.id.name : null
          if (typeName != null) {
            let matchingSchema = null
            if (schemaVarNames.has(typeName + "Schema")) {
              matchingSchema = typeName + "Schema"
            } else if (schemaVarNames.has("make" + typeName + "Schema")) {
              matchingSchema = "make" + typeName + "Schema"
            } else if (schemaVarNames.has("make" + typeName)) {
              matchingSchema = "make" + typeName
            }
            if (matchingSchema != null) {
              let isLoose = false
              if (decl.type === "TSInterfaceDeclaration") {
                isLoose = true
              } else if (decl.type === "TSTypeAliasDeclaration" && decl.typeAnnotation != null) {
                if (decl.typeAnnotation.type === "TSTypeLiteral") {
                  isLoose = true
                } else if (
                  decl.typeAnnotation.type === "TSUnionType" &&
                  Array.isArray(decl.typeAnnotation.types) &&
                  decl.typeAnnotation.types.some((t) => t.type === "TSTypeLiteral")
                ) {
                  isLoose = true
                }
              }
              if (isLoose) {
                context.report({
                  node: decl,
                  message: `Do not declare loose handwritten TypeScript type/interface '${typeName}' alongside '${matchingSchema}' — derive the type directly via Schema.Schema.Type<typeof ${matchingSchema}> (or Schema.Schema.Type<ReturnType<typeof ${matchingSchema}>>) to preserve schema constraints.`
                })
              }
            }
          }
          return
        }

        if (!/libs\/[^/]+\/(domain|service|infra)\/src\//.test(filename)) return

        if (decl.type === "FunctionDeclaration") {
          context.report({ node: decl, message: domainExportMessage })
          return
        }

        if (decl.type === "VariableDeclaration") {
          const isDomain = /libs\/[^/]+\/domain\/src\//.test(filename)
          for (const varDecl of decl.declarations) {
            const init = varDecl.init
            if (init == null) continue
            if (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") {
              context.report({ node: varDecl, message: domainExportMessage })
            } else if (init.type === "CallExpression") {
              if (isUntracedEffectCall(init) || (isDomain && !isEffectFnInvocation(init))) {
                context.report({ node: varDecl, message: domainExportMessage })
              }
            }
          }
        }
      },
    }
  },
}

const testIntegrity = {
  create(context) {
    const discriminantAliasNames = new Set()

    function getNormalizedFilename() {
      return (
        context.filename ??
        (typeof context.getFilename === "function" ? context.getFilename() : "")
      ).replace(/\\/g, "/")
    }

    return {
      Program(node) {
        discriminantAliasNames.clear()
        const text =
          context.sourceCode && typeof context.sourceCode.text === "string"
            ? context.sourceCode.text
            : ""
        if (
          /^\s*(\/\/|\/\*)\s*(oxlint-disable|eslint-disable)[^\n]*(harness\/test-integrity|effecttsgo\/)/m.test(text) ||
          /^\s*(\/\/|\/\*)\s*@effect-diagnostics(-next-line)?\b/m.test(text)
        ) {
          context.report({ node, message: effectTsgoDisableMessage })
        }
        if (/^\s*(\/\/|\/\*)\s*@ts-(ignore|nocheck)\b/m.test(text)) {
          context.report({ node, message: testTsIgnoreMessage })
        }
      },
      VariableDeclarator(node) {
        if (
          node.id != null &&
          node.id.type === "Identifier" &&
          isDiscriminantMemberAccess(node.init)
        ) {
          discriminantAliasNames.add(node.id.name)
        }
      },
      IfStatement(node) {
        const filename = getNormalizedFilename()
        if (isInternalHarnessFile(filename)) return
        if (
          isDiscriminantTestExpression(node.test) ||
          isAliasedDiscriminantTest(node.test, discriminantAliasNames)
        ) {
          context.report({ node, message: discriminantIfBanMessage })
        }
      },
      ConditionalExpression(node) {
        const filename = getNormalizedFilename()
        if (isInternalHarnessFile(filename)) return
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
        if (!isInternalHarnessFile(filename)) {
          if (isImpreciseFailureAssert(node)) {
            context.report({ node, message: impreciseFailureAssertMessage })
          }
          if (isPropertyTestCall(node) && Array.isArray(node.arguments) && node.arguments.length > 0) {
            const callbackArg = node.arguments[node.arguments.length - 1]
            if (callbackArg != null) {
              const callbackText = getNodeSourceText(context, callbackArg)
              if (
                (callbackText.includes("fold(") || /\bfold\s*\(/.test(callbackText)) &&
                (/\.reduce\s*\(\s*[a-zA-Z0-9_$]*evolve/i.test(callbackText) ||
                  /\.reduce\s*\([^)]*\bevolve/i.test(callbackText))
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
