import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import { NonNegativeCount, ts } from "@harness/graph"
import { checkMigrationSqlSafety, decideMigrationSafety } from "./migration-check.js"
import { resolveHarnessStateDir } from "./worktree.js"

export const GateRuleVersion = Schema.NonEmptyString.pipe(Schema.brand("GateRuleVersion"))
export type GateRuleVersion = typeof GateRuleVersion.Type

export const HARNESS_GATE_RULE_VERSION: GateRuleVersion = GateRuleVersion.make("ast-gates-v1")

export const AstSourceFilePath = Schema.NonEmptyString.pipe(Schema.brand("AstSourceFilePath"))
export type AstSourceFilePath = typeof AstSourceFilePath.Type

export const ContentSha256 = Schema.NonEmptyString.pipe(Schema.brand("ContentSha256"))
export type ContentSha256 = typeof ContentSha256.Type

export const AstSourceContent = Schema.String.pipe(Schema.brand("AstSourceContent"))
export type AstSourceContent = typeof AstSourceContent.Type

export const GateCategory = Schema.Literals([
  "syntax-bans",
  "test-integrity",
  "migration-safety",
  "domain-purity",
  "effect-laws",
]).pipe(Schema.brand("GateCategory"))
export type GateCategory = typeof GateCategory.Type

export const GateRuleId = Schema.NonEmptyString.pipe(Schema.brand("GateRuleId"))
export type GateRuleId = typeof GateRuleId.Type

export const GateViolationMessage = Schema.NonEmptyString.pipe(Schema.brand("GateViolationMessage"))
export type GateViolationMessage = typeof GateViolationMessage.Type

export const SourceLineNumber = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("SourceLineNumber"),
)
export type SourceLineNumber = typeof SourceLineNumber.Type

export const EnclosingSymbolName = Schema.NonEmptyString.pipe(Schema.brand("EnclosingSymbolName"))
export type EnclosingSymbolName = typeof EnclosingSymbolName.Type

export const GateVerdict = Schema.Literals(["clean", "violated"]).pipe(Schema.brand("GateVerdict"))
export type GateVerdict = typeof GateVerdict.Type

export const AstGatePackageTag = Schema.Literals([
  "contract",
  "domain",
  "service",
  "infra",
  "app",
  "test",
]).pipe(Schema.brand("AstGatePackageTag"))
export type AstGatePackageTag = typeof AstGatePackageTag.Type

export const GateViolation = Schema.Struct({
  category: GateCategory,
  rule: GateRuleId,
  message: GateViolationMessage,
  file: AstSourceFilePath,
  line: SourceLineNumber,
  enclosingSymbol: EnclosingSymbolName,
})
export type GateViolation = typeof GateViolation.Type

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

const decodeAstGateCacheStore = Schema.decodeOption(Schema.fromJsonString(AstGateCacheStoreSchema))

const inMemoryGateCache = new Map<string, AstGateCacheEntry>()
const inMemorySourceFileCache = new Map<
  string,
  { readonly contentSha256: ContentSha256; readonly sourceFile: ts.SourceFile }
>()
const loadedDiskCachePaths = new Set<string>()
let totalSourceFileParses = 0

export const computeContentSha256 = (content: string): ContentSha256 =>
  ContentSha256.make(createHash("sha256").update(content, "utf8").digest("hex"))

const makeAstGateCacheKey = (filePath: string, packageTag: string): string =>
  `${filePath}\0${packageTag}`

export const resolveAstGateCachePath = (repoRoot: string): AstSourceFilePath =>
  AstSourceFilePath.make(join(resolveHarnessStateDir(repoRoot), "cache", "ast-gates-v1.json"))

export const loadAstGateCacheFromDisk = (cacheFilePath: string): void => {
  if (loadedDiskCachePaths.has(cacheFilePath)) {
    return
  }
  loadedDiskCachePaths.add(cacheFilePath)
  if (!existsSync(cacheFilePath)) {
    return
  }
  Effect.runSync(
    Effect.try({
      try: () => {
        const raw = readFileSync(cacheFilePath, "utf8")
        const decoded = decodeAstGateCacheStore(raw)
        match(decoded)
          .with({ _tag: "Some" }, ({ value }) => {
            for (const [, entry] of Object.entries(value.entries)) {
              const pkgTag = entry.packageTag ?? inferPackageTagFromPath(entry.filePath)
              const key = makeAstGateCacheKey(entry.filePath, pkgTag)
              inMemoryGateCache.set(key, entry)
            }
          })
          .with({ _tag: "None" }, () => undefined)
          .exhaustive()
      },
      catch: () => undefined,
    }).pipe(Effect.ignore),
  )
}

export const saveAstGateCacheToDisk = (
  cacheFilePath: string,
  ruleVersion: GateRuleVersion = HARNESS_GATE_RULE_VERSION,
): void => {
  Effect.runSync(
    Effect.try({
      try: () => {
        mkdirSync(dirname(cacheFilePath), { recursive: true })
        const entries: Record<string, AstGateCacheEntry> = {}
        for (const [key, entry] of inMemoryGateCache.entries()) {
          if (entry.ruleVersion === ruleVersion) {
            entries[key] = entry
          }
        }
        const payload: AstGateCacheStore = {
          version: ruleVersion,
          entries,
        }
        const tmpPath = `${cacheFilePath}.${process.pid}.tmp`
        writeFileSync(tmpPath, JSON.stringify(payload), "utf8")
        renameSync(tmpPath, cacheFilePath)
      },
      catch: () => undefined,
    }).pipe(Effect.ignore),
  )
}

export const clearAstGateCache = (): void => {
  inMemoryGateCache.clear()
  inMemorySourceFileCache.clear()
  loadedDiskCachePaths.clear()
  totalSourceFileParses = 0
}

export const getAstGateCacheSize = (): number => inMemoryGateCache.size

export const getAstGateSourceFileParseCount = (): number => totalSourceFileParses

export const MAX_SOURCE_FILE_CACHE_SIZE = 500

export const getOrCreateCachedSourceFile = (
  filePath: string,
  content: string,
  contentSha256?: ContentSha256,
): { readonly sourceFile: ts.SourceFile; readonly freshlyParsed: boolean } => {
  const hash = contentSha256 ?? computeContentSha256(content)
  const existing = inMemorySourceFileCache.get(filePath)
  if (existing !== undefined && existing.contentSha256 === hash) {
    return { sourceFile: existing.sourceFile, freshlyParsed: false }
  }
  totalSourceFileParses += 1
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  if (
    !inMemorySourceFileCache.has(filePath) &&
    inMemorySourceFileCache.size >= MAX_SOURCE_FILE_CACHE_SIZE
  ) {
    const oldestKey = inMemorySourceFileCache.keys().next().value
    if (oldestKey !== undefined) {
      inMemorySourceFileCache.delete(oldestKey)
    }
  }
  inMemorySourceFileCache.set(filePath, { contentSha256: hash, sourceFile })
  return { sourceFile, freshlyParsed: true }
}

const inferPackageTagFromPath = (filePath: string): AstGatePackageTag => {
  if (filePath.includes("/contract/")) return AstGatePackageTag.make("contract")
  if (filePath.includes("/domain/") || filePath.includes("/core/")) {
    return AstGatePackageTag.make("domain")
  }
  if (filePath.includes("/service/")) return AstGatePackageTag.make("service")
  if (filePath.includes("/infra/")) return AstGatePackageTag.make("infra")
  return AstGatePackageTag.make("app")
}

const getLineNumber = (sourceFile: ts.SourceFile, pos: number): SourceLineNumber => {
  const { line } = sourceFile.getLineAndCharacterOfPosition(Math.max(0, pos))
  return SourceLineNumber.make(line + 1)
}

const resolveEnclosingSymbol = (node: ts.Node, filePath: string): EnclosingSymbolName => {
  let curr: ts.Node | undefined = node
  while (curr !== undefined) {
    if (ts.isVariableDeclaration(curr) && ts.isIdentifier(curr.name)) {
      return EnclosingSymbolName.make(`${filePath}#${curr.name.text}`)
    }
    if (ts.isFunctionDeclaration(curr) && curr.name !== undefined) {
      return EnclosingSymbolName.make(`${filePath}#${curr.name.text}`)
    }
    if (ts.isClassDeclaration(curr) && curr.name !== undefined) {
      return EnclosingSymbolName.make(`${filePath}#${curr.name.text}`)
    }
    curr = curr.parent
  }
  return EnclosingSymbolName.make(filePath)
}

const IMPURE_DOMAIN_MODULES = new Set([
  "node:fs",
  "fs",
  "node:http",
  "http",
  "node:https",
  "https",
  "node:net",
  "net",
  "node:child_process",
  "child_process",
  "drizzle-orm",
  "alchemy",
])

const isImpureDomainSpecifier = (spec: string): boolean =>
  IMPURE_DOMAIN_MODULES.has(spec) ||
  spec.startsWith("drizzle-orm/") ||
  spec.startsWith("@effect/sql") ||
  spec.startsWith("alchemy/") ||
  /^@harness\/[a-z0-9-]+-infra$/.test(spec)

const visitSourceFileSinglePass = (
  sourceFile: ts.SourceFile,
  filePath: AstSourceFilePath,
  packageTag: AstGatePackageTag,
): ReadonlyArray<GateViolation> => {
  const violations: Array<GateViolation> = []
  const isTestFile = filePath.endsWith(".test.ts") || filePath.endsWith(".spec.ts")
  const isHarnessInternal =
    filePath.startsWith("libs/harness/") || filePath.startsWith("apps/harness-")
  let hasMigratorImport = false

  // Pre-scan top-level imports for SqliteMigrator / Migrator presence
  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const modText = stmt.moduleSpecifier.text
      if (modText.includes("SqliteMigrator") || modText.includes("Migrator")) {
        hasMigratorImport = true
      }
    }
  }

  const isInsideMigrationsRecord = (node: ts.Node): boolean => {
    let curr: ts.Node | undefined = node.parent
    while (curr !== undefined) {
      if (ts.isCallExpression(curr)) {
        const exprText = curr.expression.getText(sourceFile)
        if (exprText.endsWith("fromRecord")) {
          return true
        }
      }
      if (ts.isVariableDeclaration(curr) && ts.isIdentifier(curr.name)) {
        if (/migrations/i.test(curr.name.text)) {
          return true
        }
      }
      curr = curr.parent
    }
    return false
  }

  const isDiscriminantCondition = (cond: ts.Expression): boolean => {
    const text = cond.getText(sourceFile)
    if (
      /\b(?:Option\.isSome|Option\.isNone|Either\.isRight|Either\.isLeft|Result\.isSuccess|Result\.isFailure|Exit\.isSuccess|Exit\.isFailure)\s*\(/.test(
        text,
      )
    ) {
      return true
    }
    if (/\.(?:_tag|kind|status)\s*(?:===|!==|==|!=)\s*["'`]/.test(text)) {
      return true
    }
    return false
  }

  const walk = (node: ts.Node): void => {
    // 1. Import declarations (domain-purity + syntax-bans + test-integrity)
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text
      if (
        (spec === "node:sqlite" || spec === "sqlite" || spec === "better-sqlite3") &&
        !isHarnessInternal &&
        (packageTag === "infra" || packageTag === "app")
      ) {
        violations.push({
          category: GateCategory.make(isTestFile ? "test-integrity" : "syntax-bans"),
          rule: GateRuleId.make("node-sqlite-in-infra"),
          message: GateViolationMessage.make(
            `Do not import '${spec}' in '${filePath}' — use @alchemy.run/cloudflare-runtime workerd storage instead of node:sqlite mocks.`,
          ),
          file: filePath,
          line: getLineNumber(sourceFile, node.getStart(sourceFile)),
          enclosingSymbol: resolveEnclosingSymbol(node, filePath),
        })
      }
      if (
        !isTestFile &&
        !isHarnessInternal &&
        (packageTag === "domain" || packageTag === "contract") &&
        isImpureDomainSpecifier(spec)
      ) {
        violations.push({
          category: GateCategory.make("domain-purity"),
          rule: GateRuleId.make("impure-domain-import"),
          message: GateViolationMessage.make(
            `Module '${filePath}' (${packageTag}) imports impure infrastructure dependency '${spec}'.`,
          ),
          file: filePath,
          line: getLineNumber(sourceFile, node.getStart(sourceFile)),
          enclosingSymbol: resolveEnclosingSymbol(node, filePath),
        })
      }
    }

    // 2. Switch statements (syntax-bans)
    if (ts.isSwitchStatement(node) && !isTestFile && !isHarnessInternal) {
      violations.push({
        category: GateCategory.make("syntax-bans"),
        rule: GateRuleId.make("discriminant-branching"),
        message: GateViolationMessage.make(
          `Switch statement in '${filePath}' is banned — use match(value).with(...).exhaustive() from ts-pattern.`,
        ),
        file: filePath,
        line: getLineNumber(sourceFile, node.getStart(sourceFile)),
        enclosingSymbol: resolveEnclosingSymbol(node, filePath),
      })
    }

    // 3. AsExpression / TypeAssertionExpression (syntax-bans: unsafe-type-cast)
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      const typeNode = node.type
      if (
        typeNode.kind === ts.SyntaxKind.AnyKeyword ||
        typeNode.kind === ts.SyntaxKind.NeverKeyword
      ) {
        const keyword = typeNode.kind === ts.SyntaxKind.AnyKeyword ? "any" : "never"
        violations.push({
          category: GateCategory.make("syntax-bans"),
          rule: GateRuleId.make("unsafe-type-cast"),
          message: GateViolationMessage.make(
            `Unsafe type assertion 'as ${keyword}' in '${filePath}' is banned.`,
          ),
          file: filePath,
          line: getLineNumber(sourceFile, node.getStart(sourceFile)),
          enclosingSymbol: resolveEnclosingSymbol(node, filePath),
        })
      } else if (
        (ts.isAsExpression(node.expression) || ts.isTypeAssertionExpression(node.expression)) &&
        node.expression.type.kind === ts.SyntaxKind.UnknownKeyword
      ) {
        violations.push({
          category: GateCategory.make("syntax-bans"),
          rule: GateRuleId.make("unsafe-type-cast"),
          message: GateViolationMessage.make(
            `Double type assertion 'as unknown as T' in '${filePath}' is banned.`,
          ),
          file: filePath,
          line: getLineNumber(sourceFile, node.getStart(sourceFile)),
          enclosingSymbol: resolveEnclosingSymbol(node, filePath),
        })
      }
    }

    // 4. IfStatement & ConditionalExpression (effect-laws: discriminant-branching)
    if (ts.isIfStatement(node) && !isTestFile && !isHarnessInternal) {
      if (isDiscriminantCondition(node.expression)) {
        violations.push({
          category: GateCategory.make("effect-laws"),
          rule: GateRuleId.make("discriminant-branching"),
          message: GateViolationMessage.make(
            `If statement in '${filePath}' inspects union discriminant or Option/Either/Result guard — use match(...).exhaustive().`,
          ),
          file: filePath,
          line: getLineNumber(sourceFile, node.getStart(sourceFile)),
          enclosingSymbol: resolveEnclosingSymbol(node, filePath),
        })
      }
    }
    if (ts.isConditionalExpression(node) && !isTestFile && !isHarnessInternal) {
      if (isDiscriminantCondition(node.condition)) {
        violations.push({
          category: GateCategory.make("effect-laws"),
          rule: GateRuleId.make("discriminant-branching"),
          message: GateViolationMessage.make(
            `Ternary expression in '${filePath}' inspects union discriminant or Option/Either/Result guard — use match(...).exhaustive().`,
          ),
          file: filePath,
          line: getLineNumber(sourceFile, node.getStart(sourceFile)),
          enclosingSymbol: resolveEnclosingSymbol(node, filePath),
        })
      }
    }

    // 5. CallExpressions (effect-laws, domain-purity, test-integrity)
    if (ts.isCallExpression(node)) {
      const calleeText = node.expression.getText(sourceFile)

      // match(...).run() ban
      if (
        !isTestFile &&
        !isHarnessInternal &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "run" &&
        /\bmatch\s*\(/.test(node.expression.expression.getText(sourceFile))
      ) {
        violations.push({
          category: GateCategory.make("effect-laws"),
          rule: GateRuleId.make("non-exhaustive-union-match"),
          message: GateViolationMessage.make(
            `match(...).run() in '${filePath}' is banned — use .exhaustive() instead.`,
          ),
          file: filePath,
          line: getLineNumber(sourceFile, node.getStart(sourceFile)),
          enclosingSymbol: resolveEnclosingSymbol(node, filePath),
        })
      }

      // Unscoped Effect.runSync / Effect.runPromise in domain/contract/service/infra
      if (
        !isTestFile &&
        !isHarnessInternal &&
        packageTag !== "app" &&
        (calleeText === "Effect.runSync" ||
          calleeText === "Effect.runPromise" ||
          calleeText === "Effect.runFork")
      ) {
        violations.push({
          category: GateCategory.make("domain-purity"),
          rule: GateRuleId.make("unscoped-effect-run"),
          message: GateViolationMessage.make(
            `Unscoped '${calleeText}' in '${filePath}' (${packageTag}) — compose Effects and run at the app edge.`,
          ),
          file: filePath,
          line: getLineNumber(sourceFile, node.getStart(sourceFile)),
          enclosingSymbol: resolveEnclosingSymbol(node, filePath),
        })
      }

      // Test integrity: vacuous Exit.isFailure assertion
      if (
        isTestFile &&
        calleeText.startsWith("expect(") &&
        /expect\s*\(\s*Exit\.isFailure\s*\(\s*([A-Za-z0-9_$]+)\s*\)\s*\)/.test(
          node.expression.getText(sourceFile),
        )
      ) {
        const fullSourceText = sourceFile.text
        if (
          !fullSourceText.includes("Cause.findErrorOption") &&
          !fullSourceText.includes(".cause")
        ) {
          violations.push({
            category: GateCategory.make("test-integrity"),
            rule: GateRuleId.make("vacuous-error-assertion"),
            message: GateViolationMessage.make(
              `Vacuous Exit.isFailure assertion in '${filePath}' without inspecting Cause.findErrorOption or error fields.`,
            ),
            file: filePath,
            line: getLineNumber(sourceFile, node.getStart(sourceFile)),
            enclosingSymbol: resolveEnclosingSymbol(node, filePath),
          })
        }
      }
    }

    // 6. BinaryExpression: JSON.stringify(a) === JSON.stringify(b) in tests
    if (ts.isBinaryExpression(node) && isTestFile) {
      const op = node.operatorToken.kind
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
        const leftText = node.left.getText(sourceFile)
        const rightText = node.right.getText(sourceFile)
        if (leftText.startsWith("JSON.stringify(") && rightText.startsWith("JSON.stringify(")) {
          violations.push({
            category: GateCategory.make("test-integrity"),
            rule: GateRuleId.make("fallback-json-equality"),
            message: GateViolationMessage.make(
              `Fallback JSON.stringify equality comparison in '${filePath}' — use structured equality or Equal.equals.`,
            ),
            file: filePath,
            line: getLineNumber(sourceFile, node.getStart(sourceFile)),
            enclosingSymbol: resolveEnclosingSymbol(node, filePath),
          })
        }
      }
    }

    // 7. TaggedTemplateExpression: sql`...` migration safety & unmanaged DDL
    if (ts.isTaggedTemplateExpression(node)) {
      const tagText = node.tag.getText(sourceFile)
      if (tagText === "sql" || tagText.endsWith(".sql")) {
        const templateText = node.template.getText(sourceFile).slice(1, -1)
        const isDdl =
          /\b(?:CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?(?:TABLE|INDEX|UNIQUE\s+INDEX|VIEW|TRIGGER)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER))\b/i.test(
            templateText,
          )
        if (isDdl) {
          if (
            packageTag === "infra" &&
            !isHarnessInternal &&
            (!hasMigratorImport || !isInsideMigrationsRecord(node))
          ) {
            violations.push({
              category: GateCategory.make("migration-safety"),
              rule: GateRuleId.make("unmanaged-sql-ddl"),
              message: GateViolationMessage.make(
                `Raw SQL DDL in '${filePath}' outside SqliteMigrator.fromRecord migration record.`,
              ),
              file: filePath,
              line: getLineNumber(sourceFile, node.getStart(sourceFile)),
              enclosingSymbol: resolveEnclosingSymbol(node, filePath),
            })
          }
          const safety = checkMigrationSqlSafety([{ file: filePath, sql: templateText }])
          for (const v of safety.violations) {
            violations.push({
              category: GateCategory.make("migration-safety"),
              rule: GateRuleId.make("unsafe-sql-migration"),
              message: GateViolationMessage.make(v.message),
              file: filePath,
              line: getLineNumber(sourceFile, node.getStart(sourceFile)),
              enclosingSymbol: resolveEnclosingSymbol(node, filePath),
            })
          }
        }
      }
    }

    ts.forEachChild(node, walk)
  }

  walk(sourceFile)
  return violations
}

export const evaluateAstGateFiles = (
  input: AstGateEvaluationInput,
  categoryFilter?: GateCategory,
): AstGateDecisionReport => {
  const ruleVersion = input.ruleVersion ?? HARNESS_GATE_RULE_VERSION
  if (input.cacheFilePath !== undefined) {
    loadAstGateCacheFromDisk(input.cacheFilePath)
  }

  let cacheHitCount = 0
  let parsedFileCount = 0
  let dirtyCache = false
  const allViolations: Array<GateViolation> = []

  for (const file of input.files) {
    const pkgTag = file.packageTag ?? inferPackageTagFromPath(file.filePath)
    const contentSha256 = computeContentSha256(file.content)
    const cacheKey = makeAstGateCacheKey(file.filePath, pkgTag)
    const cached = inMemoryGateCache.get(cacheKey)

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
    inMemoryGateCache.set(cacheKey, entry)
    dirtyCache = true

    for (const v of fileViolations) {
      if (categoryFilter === undefined || v.category === categoryFilter) {
        allViolations.push(v)
      }
    }
  }

  if (dirtyCache && input.cacheFilePath !== undefined) {
    saveAstGateCacheToDisk(input.cacheFilePath, ruleVersion)
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
): Effect.fn.Return<AstGateDecisionReport> {
  return yield* Effect.succeed(evaluateAstGateFiles(input))
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
  evaluateFiles: evaluateAstGateFiles,
  computeContentSha256,
  resolveCachePath: resolveAstGateCachePath,
  loadFromDisk: loadAstGateCacheFromDisk,
  saveToDisk: saveAstGateCacheToDisk,
  clear: clearAstGateCache,
  getCacheSize: getAstGateCacheSize,
  getSourceFileParseCount: getAstGateSourceFileParseCount,
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
