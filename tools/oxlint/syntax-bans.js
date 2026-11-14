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
const explicitAnyBanMessage =
  "Explicit 'any' (including 'as any', ': any', and '<any>') is strictly banned — every value must have an explicit, inferable static type or be decoded via Effect Schema."
const unsafeNeverBanMessage =
  "Unsafe 'never' ('as never' or explicit ': never' on parameters/variables) is banned — fix the underlying type mismatch or use exhaustive ts-pattern matching (.exhaustive()) instead of bypassing the type checker."
const doubleTypeAssertionBanMessage =
  "Double type assertions ('as unknown as T') are banned — decode untrusted data with Effect Schema or type the interface properly instead of erasing types."
const nodeSqliteInfraMessage = (source, filename) =>
  `Do not import '${source}' in type:infra or type:app ('${filename}') — execute Cloudflare Durable Object SQLite and D1 storages against the real workerd runtime via @alchemy.run/cloudflare-runtime instead of hand-rolled node:sqlite mocks (harness:ADR-0008, harness:SPEC-0006, node-sqlite-in-infra).`

const BOOLEAN_STATE_PROP_REGEX =
  /^(is[A-Z]|has[A-Z]|checkedOut|created|completed|cancelled|canceled|deleted|archived|active|closed|opened|approved|rejected|verified|publish|published|expired)$/

const QUANTITY_OR_VERSION_PROP_REGEX =
  /^(qty|quantity|count|[a-z0-9]+Qty|[a-z0-9]+Quantity|[a-z0-9]+Count|streamVersion|[a-z0-9]+StreamVersion|nextExpectedStreamVersion|availableQty|reservedQty|orderedQty)$/i

const DISCRIMINANT_CALLBACK_METHODS = new Set(["filter", "find", "some", "every"])

const DISCRIMINANT_PROP_NAMES = new Set(["_tag", "kind", "status", "verdict", "role", "state"])

export function isEnforcedWorkspaceFile(filename) {
  return /(^|\/)(libs\/[^/]+\/[^/]+|apps\/[^/]+)\//.test(filename)
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
  if (
    node.type === "TemplateLiteral" &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0
  ) {
    return true
  }
  return false
}

function isDiscriminantTestExpression(node) {
  if (node == null || typeof node !== "object") return false
  if (isTagGuardCall(node)) return true
  if (
    node.type === "UnaryExpression" &&
    node.operator === "!" &&
    isDiscriminantTestExpression(node.argument)
  ) {
    return true
  }
  if (node.type === "LogicalExpression") {
    return isDiscriminantTestExpression(node.left) || isDiscriminantTestExpression(node.right)
  }
  if (
    node.type === "BinaryExpression" &&
    (node.operator === "===" ||
      node.operator === "!==" ||
      node.operator === "==" ||
      node.operator === "!=")
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
    (node.operator === "===" ||
      node.operator === "!==" ||
      node.operator === "==" ||
      node.operator === "!=")
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
      (stmt) => stmt != null && stmt.type === "ReturnStatement",
    )
    return returnStmt ? returnStmt.argument : null
  }
  return null
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

const syntaxBans = {
  create(context) {
    const discriminantAliasNames = new Set()
    const schemaVarNames = new Set()
    const brandedTypeNames = new Set()
    const unbrandedSchemaVarNames = new Map()
    const declaredBrandKeys = new Map()
    const migrationRecordVars = new Map()
    const allowedDdlTemplateNodes = new Set()
    const effectNamespaceNames = new Set(["Effect"])
    let hasSqliteMigratorImport = false
    const reportedNodes = new WeakSet()

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
        effectNamespaceNames.clear()
        effectNamespaceNames.add("Effect")
        hasSqliteMigratorImport = false
        if (node.body && Array.isArray(node.body)) {
          for (const stmt of node.body) {
            if (stmt.type === "ImportDeclaration") {
              recordContractImports(stmt)
            } else if (stmt.type === "VariableDeclaration" && Array.isArray(stmt.declarations)) {
              for (const decl of stmt.declarations) {
                recordSchemaDeclarator(decl)
              }
            } else if (stmt.type === "ExportNamedDeclaration" && stmt.declaration) {
              if (
                stmt.declaration.type === "VariableDeclaration" &&
                Array.isArray(stmt.declaration.declarations)
              ) {
                for (const decl of stmt.declaration.declarations) {
                  recordSchemaDeclarator(decl)
                }
              } else if (stmt.declaration.type === "FunctionDeclaration" && stmt.declaration.id) {
                if (
                  stmt.declaration.id.name.endsWith("Schema") ||
                  stmt.declaration.id.name.startsWith("make")
                ) {
                  schemaVarNames.add(stmt.declaration.id.name)
                }
              } else if (
                stmt.declaration.type === "TSTypeAliasDeclaration" &&
                stmt.declaration.id != null &&
                containsBrandTypeReference(stmt.declaration.typeAnnotation, brandedTypeNames)
              ) {
                brandedTypeNames.add(stmt.declaration.id.name)
              }
            } else if (stmt.type === "FunctionDeclaration" && stmt.id) {
              if (stmt.id.name.endsWith("Schema") || stmt.id.name.startsWith("make")) {
                schemaVarNames.add(stmt.id.name)
              }
            } else if (
              stmt.type === "TSTypeAliasDeclaration" &&
              stmt.id != null &&
              containsBrandTypeReference(stmt.typeAnnotation, brandedTypeNames)
            ) {
              brandedTypeNames.add(stmt.id.name)
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
        if (
          node.source != null &&
          typeof node.source.value === "string"
        ) {
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
          if (
            node.importKind !== "type" &&
            (importSource === "effect" || importSource === "effect/Effect") &&
            Array.isArray(node.specifiers)
          ) {
            const isEnforcedSrc =
              !isTestFilePath(filename) &&
              /(?:^|\/)(?:libs\/[^/]+\/[^/]+\/src|apps\/[^/]+\/src)\//.test(filename) &&
              !/(?:^|\/)libs\/es\/infra\/src\/memory\.ts$/.test(filename)
            const isMcpBoundary = /(?:^|\/)apps\/harness-mcp\/src\//.test(filename)
            const isAppSrc = /(?:^|\/)apps\/[^/]+\/src\//.test(filename)
            for (const spec of node.specifiers) {
              if (spec == null || spec.importKind === "type") continue
              if (spec.type === "ImportNamespaceSpecifier" && spec.local?.name) {
                effectNamespaceNames.add(spec.local.name)
              } else if (spec.type === "ImportSpecifier") {
                const importedName = spec.imported?.name ?? spec.local?.name
                const localName = spec.local?.name
                if (importSource === "effect" && importedName === "Effect" && localName) {
                  effectNamespaceNames.add(localName)
                }
                if (importSource === "effect/Effect" && isEnforcedSrc && importedName != null) {
                  const isBannedSync = importedName === "runSync" || importedName === "runSyncExit"
                  const isBannedPromise =
                    (importedName === "runPromise" || importedName === "runPromiseExit") &&
                    !isMcpBoundary
                  const isBannedFork = importedName === "runFork" && !isAppSrc
                  if (isBannedSync || isBannedPromise || isBannedFork) {
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
        if (/(?:libs\/[^/]+\/infra\/|apps\/)/.test(filename)) {
          const sourceVal =
            node.source != null &&
            node.source.type === "Literal" &&
            typeof node.source.value === "string"
              ? node.source.value
              : null
          if (
            sourceVal === "node:sqlite" ||
            sourceVal === "sqlite" ||
            sourceVal === "better-sqlite3"
          ) {
            reportOnce(node, nodeSqliteInfraMessage(sourceVal, filename))
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
        if (node.id != null && node.id.type === "Identifier") {
          if (node.init != null && node.init.type === "ObjectExpression") {
            migrationRecordVars.set(node.id.name, node.init)
            if (
              /libs\/[^/]+\/infra\/src\//.test(getNormalizedFilename()) &&
              !(/(?:^|\/)libs\/harness\//.test(getNormalizedFilename())) &&
              hasSqliteMigratorImport &&
              /[Mm]igrations/.test(node.id.name)
            ) {
              markAllowedDdlTemplates(node.init)
              validateMigrationRecordObject(node.init)
            }
          }
          if (isDiscriminantMemberAccess(node.init)) {
            discriminantAliasNames.add(node.id.name)
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
      FunctionDeclaration(node) {
        reportAsync(node)
        checkNeverParams(context, node)
      },
      FunctionExpression(node) {
        reportAsync(node)
        checkNeverParams(context, node)
      },
      ArrowFunctionExpression(node) {
        reportAsync(node)
        checkNeverParams(context, node)
      },
      AwaitExpression(node) {
        context.report({ node, message: asyncMessage })
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
      },
      MemberExpression(node) {
        const filename = getNormalizedFilename()
        if (
          /libs\/[^/]+\/(?:domain|core)\/src\//.test(filename) &&
          node.computed !== true &&
          node.object != null &&
          node.object.type === "Identifier" &&
          effectNamespaceNames.has(node.object.name) &&
          isIdentifier(node.property, "ignore")
        ) {
          context.report({ node, message: domainEffectIgnoreMessage })
        }
        if (
          !isTestFilePath(filename) &&
          /(?:^|\/)(?:libs\/[^/]+\/[^/]+\/src|apps\/[^/]+\/src)\//.test(filename) &&
          !/(?:^|\/)libs\/es\/infra\/src\/memory\.ts$/.test(filename) &&
          node.computed !== true &&
          node.object != null &&
          node.object.type === "Identifier" &&
          effectNamespaceNames.has(node.object.name) &&
          node.property != null &&
          node.property.type === "Identifier"
        ) {
          const methodName = node.property.name
          const isBannedSyncRun = methodName === "runSync" || methodName === "runSyncExit"
          const isBannedPromiseRun =
            (methodName === "runPromise" || methodName === "runPromiseExit") &&
            !/(?:^|\/)apps\/harness-mcp\/src\//.test(filename)
          const isBannedForkRun =
            methodName === "runFork" && !/(?:^|\/)apps\/[^/]+\/src\//.test(filename)
          if (isBannedSyncRun || isBannedPromiseRun || isBannedForkRun) {
            context.report({
              node,
              message: `unscoped-effect-run: '${node.object.name}.${methodName}' is banned in '${filename}' — compose Effects and execute via NodeRuntime.runMain or ManagedRuntime at the app edge.`,
            })
          }
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

        if (isEnforcedWorkspaceFile(filename)) {
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
        }

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
          /(?:libs\/[^/]+\/infra\/|apps\/)/.test(filename) &&
          isIdentifier(node.callee, "require") &&
          Array.isArray(node.arguments) &&
          node.arguments.length >= 1
        ) {
          const arg0 = node.arguments[0]
          const sourceVal =
            arg0 != null && arg0.type === "Literal" && typeof arg0.value === "string"
              ? arg0.value
              : null
          if (
            sourceVal === "node:sqlite" ||
            sourceVal === "sqlite" ||
            sourceVal === "better-sqlite3"
          ) {
            reportOnce(node, nodeSqliteInfraMessage(sourceVal, filename))
          }
        }
        if (
          /libs\/[^/]+\/infra\/src\//.test(filename) &&
          !(/(?:^|\/)libs\/harness\//.test(filename)) &&
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

        if (!isTest && calleeName === "Cause.hasInterruptsOnly") {
          let anc = node.parent
          let hasUnsafeAncestor = false
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
                hasUnsafeAncestor = true
                break
              }
            }
            anc = anc.parent
          }
          if (hasUnsafeAncestor) {
            context.report({
              node,
              message:
                "Cause.hasInterruptsOnly(cause) inside catchCause/runPromiseExit/runSyncExit is banned — use Cause.hasInterrupts(cause) and !Cause.hasFails(cause) && !Cause.hasDies(cause) so composite Fail+Interrupt causes are not misclassified.",
            })
          }
        }

        if (!isTest && (calleeName === "Effect.catchDefect" || calleeName.endsWith(".catchDefect"))) {
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
              if (
                ancCallee === "Effect.ignore" ||
                ancCallee === "Effect.orElseSucceed"
              ) {
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
      ExportNamedDeclaration(node) {
        const filename = getNormalizedFilename()
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
    }
  },
}

const testIntegrity = {
  create(context) {
    const discriminantAliasNames = new Set()

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
      },
      ImportDeclaration(node) {
        const filename = getNormalizedFilename()
        if (
          node.source != null &&
          typeof node.source.value === "string"
        ) {
          const importSource = node.source.value
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
      ImportExpression(node) {
        const filename = getNormalizedFilename()
        if (
          node.source != null &&
          typeof node.source.value === "string"
        ) {
          const importSource = node.source.value
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
        if (
          node.id != null &&
          node.id.type === "Identifier" &&
          isDiscriminantMemberAccess(node.init)
        ) {
          discriminantAliasNames.add(node.id.name)
        }
      },
      FunctionDeclaration(node) {
        checkNeverParams(context, node)
      },
      FunctionExpression(node) {
        checkNeverParams(context, node)
      },
      ArrowFunctionExpression(node) {
        checkNeverParams(context, node)
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
          /(?:libs\/[^/]+\/infra\/|apps\/)/.test(filename) &&
          isIdentifier(node.callee, "require") &&
          Array.isArray(node.arguments) &&
          node.arguments.length >= 1
        ) {
          const arg0 = node.arguments[0]
          const importSource =
            arg0 != null && arg0.type === "Literal" && typeof arg0.value === "string"
              ? arg0.value
              : null
          if (
            importSource === "node:sqlite" ||
            importSource === "sqlite" ||
            importSource === "better-sqlite3"
          ) {
            context.report({
              node,
              message: `Do not import '${importSource}' in type:infra or type:app tests ('${filename}') — execute Cloudflare Durable Object SQLite and D1 tests against the real workerd runtime via @alchemy.run/cloudflare-runtime instead of hand-rolled node:sqlite mocks (harness:ADR-0008, harness:SPEC-0006, node-sqlite-in-infra).`,
            })
          }
        }
        if (isEnforcedWorkspaceFile(filename)) {
          if (isImpreciseFailureAssert(node)) {
            context.report({ node, message: impreciseFailureAssertMessage })
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
