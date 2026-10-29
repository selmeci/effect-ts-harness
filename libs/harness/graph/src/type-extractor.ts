import * as fs from "node:fs"
import * as path from "node:path"
import { Effect, Option, Schema } from "effect"
import * as Graph from "effect/Graph"
import {
  type CallExpression,
  type NewExpression,
  Node,
  type ParameterDeclaration,
  type ParenthesizedTypeNode,
  Project,
  type PropertyAccessExpression,
  SyntaxKind,
  ts,
  type Type,
  type TypeNode,
  type UnionTypeNode
} from "ts-morph"
import { buildHarnessGraph } from "./graph-engine.js"
import type {
  AdrDocNode,
  BranchingViolation,
  EarsSpecNode,
  EffectFnNode,
  ExercisesSpanEdge,
  GovernanceDocStatus,
  GovernsSymbolEdge,
  HarnessEdge,
  HarnessGraph,
  HarnessNode,
  LayerKind,
  PackageTag,
  PatternDocNode,
  ServiceLayerNode,
  ServiceTagNode,
  SpecifiesSymbolEdge,
  TaggedErrorNode,
  VitestCaseNode
} from "./model.js"
import { loadPatternDocs } from "./pattern-index.js"

export interface SourceFileInput {
  readonly filePath: string
  readonly content: string
  readonly packageTag: PackageTag
}

export interface TypeExtractorOptions {
  readonly repoRoot?: string
  readonly patternDocs?: ReadonlyArray<PatternDocNode>
}

const PackageJsonSchema = Schema.Struct({
  nx: Schema.optional(
    Schema.Struct({
      tags: Schema.optional(Schema.Array(Schema.String))
    })
  )
})

const decodePackageJson = Schema.decodeOption(Schema.fromJsonString(PackageJsonSchema))

export const resolvePackageTag = (repoRoot: string, relFilePath: string): PackageTag => {
  if (relFilePath.startsWith("apps/") || relFilePath.includes("/apps/")) {
    return "app"
  }
  let currentDir = path.dirname(path.join(repoRoot, relFilePath))
  while (currentDir.length >= repoRoot.length) {
    const pkgPath = path.join(currentDir, "package.json")
    if (fs.existsSync(pkgPath)) {
      const content = fs.readFileSync(pkgPath, "utf-8")
      const opt = decodePackageJson(content)
      if (Option.isSome(opt) && opt.value.nx?.tags) {
        const tags = opt.value.nx.tags
        if (tags.includes("type:domain") || tags.includes("type:core")) return "domain"
        if (tags.includes("type:infra")) return "infra"
        if (tags.includes("type:app")) return "app"
        if (tags.includes("type:contract") && !tags.includes("type:service")) return "contract"
        if (tags.includes("type:service")) return "service"
        if (tags.includes("type:contract")) return "contract"
      }
      break
    }
    const parent = path.dirname(currentDir)
    if (parent === currentDir) break
    currentDir = parent
  }
  if (relFilePath.includes("/domain/") || relFilePath.includes("/core/")) return "domain"
  if (relFilePath.includes("/infra/")) return "infra"
  if (relFilePath.includes("/contract/")) return "contract"
  if (relFilePath.includes("/service/")) return "service"
  return "service"
}

export const resolveRepoRoot = (startDir: string): string => {
  let curr = path.resolve(startDir)
  while (curr !== path.dirname(curr)) {
    if (fs.existsSync(path.join(curr, "pnpm-workspace.yaml"))) {
      return curr
    }
    curr = path.dirname(curr)
  }
  return startDir
}

const cleanName = (raw: string): string => {
  let name = raw.replace(/import\([^)]+\)\./g, "").trim()
  if (name.startsWith("typeof ")) {
    name = name.slice(7).trim()
  }
  return name
}

const decomposeTypeNode = (node: TypeNode): Array<string> => {
  if (node.getKind() === SyntaxKind.UnionType) {
    const unionNode = node as UnionTypeNode
    return unionNode.getTypeNodes().flatMap(decomposeTypeNode)
  }
  if (node.getKind() === SyntaxKind.ParenthesizedType) {
    const paren = node as ParenthesizedTypeNode
    return decomposeTypeNode(paren.getTypeNode())
  }
  const raw = cleanName(node.getText())
  if (
    raw === "never" ||
    raw === "unknown" ||
    raw === "any" ||
    raw === "void" ||
    raw === "undefined" ||
    raw === ""
  ) {
    return []
  }
  return [raw]
}

const decomposeType = (type: Type): Array<string> => {
  if (type.isNever() || type.isUnknown() || type.isAny()) {
    return []
  }
  if (type.isUnion()) {
    return type.getUnionTypes().flatMap(decomposeType)
  }
  const sym = type.getAliasSymbol() ?? type.getSymbol()
  const raw = cleanName(sym ? sym.getName() : type.getText())
  if (
    raw === "never" ||
    raw === "unknown" ||
    raw === "any" ||
    raw === "void" ||
    raw === "undefined" ||
    raw === ""
  ) {
    return []
  }
  return [raw]
}

const isDiscriminantPropertyOfUnion = (
  objType: Type,
  propName: string,
  locationNode: Node
): boolean => {
  if (!objType.isUnion()) return false
  const members = objType.getUnionTypes().filter((u) => !u.isUndefined() && !u.isNull())
  if (members.length < 2) return false
  let literalCount = 0
  for (const member of members) {
    const propSym = member.getProperty(propName)
    if (!propSym) continue
    const propType = propSym.getTypeAtLocation(locationNode)
    if (propType.isLiteral() || propType.isBooleanLiteral()) {
      literalCount += 1
    }
  }
  return literalCount >= 2
}

const isClosedFiniteUnionType = (argType: Type, locationNode: Node): boolean => {
  if (!argType.isUnion()) return false
  const members = argType.getUnionTypes().filter((u) => !u.isUndefined() && !u.isNull())
  if (members.length < 2) return false
  return members.every((member) => {
    if (member.isLiteral() || member.isBooleanLiteral()) return true
    if (member.isObject()) {
      return member.getProperties().some((propSym) => {
        const propType = propSym.getTypeAtLocation(locationNode)
        return propType.isLiteral() || propType.isBooleanLiteral()
      })
    }
    return false
  })
}

const findEnclosingSymbolName = (node: Node, relPath: string): string => {
  let curr: Node | undefined = node
  while (curr !== undefined) {
    if (Node.isVariableDeclaration(curr)) {
      const name = curr.getName()
      if (name) return `${relPath}#${name}`
    }
    if (Node.isFunctionDeclaration(curr) || Node.isMethodDeclaration(curr)) {
      const name = curr.getName()
      if (name) return `${relPath}#${name}`
    }
    curr = curr.getParent()
  }
  return relPath
}

export const extractTypeAwareGraphFromSource = (
  files: ReadonlyArray<SourceFileInput>,
  options?: TypeExtractorOptions
): HarnessGraph => {
  const repoRoot = options?.repoRoot ?? resolveRepoRoot(process.cwd())
  const graphNodeModules = path.join(repoRoot, "libs/harness/graph/node_modules")

  const dynamicPaths: Record<string, Array<string>> = {
    effect: [path.join(graphNodeModules, "effect")],
    "effect/*": [path.join(graphNodeModules, "effect/*")],
    "ts-pattern": [path.join(repoRoot, "node_modules/ts-pattern")],
    "@harness/gates": [path.join(repoRoot, "libs/harness/gates/src/index.ts")],
    "@harness/sample-contract": [path.join(repoRoot, "libs/sample/contract/src/index.ts")],
    "@harness/sample-service": [path.join(repoRoot, "libs/sample/service/src/index.ts")],
    "@harness/sample-domain": [path.join(repoRoot, "libs/sample/domain/src/index.ts")],
    "@harness/sample-infra": [path.join(repoRoot, "libs/sample/infra/src/index.ts")]
  }

  const libsDir = path.join(repoRoot, "libs")
  if (fs.existsSync(libsDir)) {
    for (const scopeEntry of fs.readdirSync(libsDir, { withFileTypes: true })) {
      if (!scopeEntry.isDirectory() || scopeEntry.name === "harness") continue
      const scopeDir = path.join(libsDir, scopeEntry.name)
      for (const tier of ["contract", "service", "domain", "core", "infra"]) {
        const entryFile = path.join(scopeDir, tier, "src", "index.ts")
        dynamicPaths[`@harness/${scopeEntry.name}-${tier}`] = [entryFile]
        dynamicPaths[`@effect-${scopeEntry.name}/${tier}`] = [entryFile]
        dynamicPaths[`@${scopeEntry.name}/${tier}`] = [entryFile]
      }
    }
  }

  const project = new Project({
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      paths: dynamicPaths
    }
  })

  const fileMap = new Map<string, SourceFileInput>()
  for (const f of files) {
    const normalizedRelPath = f.filePath.replace(/\\/g, "/")
    fileMap.set(normalizedRelPath, f)
    const absPath = path.isAbsolute(f.filePath) ? f.filePath : path.resolve(repoRoot, f.filePath)
    project.createSourceFile(absPath, f.content, { overwrite: true })
  }

  const fns: Array<EffectFnNode> = []
  const services: Array<ServiceTagNode> = []
  const layers: Array<ServiceLayerNode> = []
  const errors: Array<TaggedErrorNode> = []
  const requiresService: Array<{ readonly callerQualname: string; readonly tagId: string }> = []
  const failsWith: Array<{ readonly callerQualname: string; readonly errorTag: string }> = []
  const providesService: Array<{ readonly layerQualname: string; readonly tagId: string }> = []
  const layerRequires: Array<{ readonly layerQualname: string; readonly tagId: string }> = []
  const branchingViolations: Array<BranchingViolation> = []

  const serviceMethodErrors = new Map<string, Map<string, Array<string>>>()
  const classNameToTagId = new Map<string, string>()
  const referencedServices = new Set<string>()
  const referencedErrors = new Set<string>()

  interface TaggedSchemaInfo {
    readonly tag: string
    readonly properties: ReadonlyArray<string>
    readonly file: string
    readonly line: number
  }
  const taggedSchemasByTag = new Map<string, TaggedSchemaInfo>()

  // 1. First pass: Extract Services, Errors, and Tagged Schemas
  for (const sourceFile of project.getSourceFiles()) {
    const relPath = path.relative(repoRoot, sourceFile.getFilePath()).replace(/\\/g, "/")
    const filePkgTag = fileMap.get(relPath)?.packageTag ?? resolvePackageTag(repoRoot, relPath)

    for (const cls of sourceFile.getClasses()) {
      if (!cls.isExported()) continue
      const extClause = cls.getExtends()
      if (!extClause) continue
      const extText = extClause.getText()

      // ServiceTag check
      if (extText.includes("Context.Service") || extText.includes("Service<")) {
        const clsName = cls.getName() ?? ""
        let tagId = clsName
        const callExprs = extClause.getDescendantsOfKind(SyntaxKind.CallExpression)
        for (const c of callExprs) {
          const args = c.getArguments()
          if (args.length > 0 && args[0]?.getKind() === SyntaxKind.StringLiteral) {
            tagId = args[0].getText().replace(/^["'`]|["'`]$/g, "")
            break
          }
        }

        classNameToTagId.set(clsName, tagId)
        classNameToTagId.set(tagId, tagId)

        services.push({
          _tag: "ServiceTag",
          tagId,
          name: clsName,
          packageTag: filePkgTag,
          file: relPath
        })

        // Record methods and errors from Shape literal if present
        const typeLiteral = extClause.getFirstDescendantByKind(SyntaxKind.TypeLiteral)
        if (typeLiteral) {
          const methodsMap = new Map<string, Array<string>>()
          for (const member of typeLiteral.getMembers()) {
            const memberName = Node.isPropertySignature(member)
              ? member.getName()
              : member.getFirstChildByKind(SyntaxKind.Identifier)?.getText()
            if (!memberName) continue
            const effectRef = member.getFirstDescendant(
              (node) =>
                node.getKind() === SyntaxKind.TypeReference && node.getText().includes("Effect")
            )
            if (effectRef && Node.isTypeReference(effectRef)) {
              const typeArgs = effectRef.getTypeArguments()
              if (typeArgs.length >= 2 && typeArgs[1]) {
                const errs = decomposeTypeNode(typeArgs[1])
                methodsMap.set(memberName, errs)
              }
            }
          }
          serviceMethodErrors.set(clsName, methodsMap)
          if (tagId !== clsName) {
            serviceMethodErrors.set(tagId, methodsMap)
          }
        }
      }

      // TaggedError check
      if (
        extText.includes("Data.TaggedError") ||
        extText.includes("TaggedError(") ||
        extText.includes("TaggedError<") ||
        extText.includes("Schema.TaggedError") ||
        extText.includes("Schema.TaggedErrorClass") ||
        extText.includes("TaggedErrorClass(")
      ) {
        const clsName = cls.getName() ?? ""
        let errorTag = clsName
        const callExprs = extClause.getDescendantsOfKind(SyntaxKind.CallExpression)
        for (const c of callExprs) {
          const args = c.getArguments()
          if (
            args.length > 0 &&
            (args[0]?.getKind() === SyntaxKind.StringLiteral ||
              args[0]?.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral)
          ) {
            errorTag = args[0].getText().replace(/^["'`]|["'`]$/g, "")
            break
          }
        }
        errors.push({
          _tag: "TaggedError",
          errorTag,
          file: relPath
        })
      }

      // TaggedClass check
      if (extText.includes("TaggedClass")) {
        for (const c of extClause.getDescendantsOfKind(SyntaxKind.CallExpression)) {
          const args = c.getArguments()
          if (args.length >= 2 && Node.isStringLiteral(args[0]) && Node.isObjectLiteralExpression(args[1])) {
            const tag = args[0].getLiteralText()
            const props = args[1]
              .getProperties()
              .filter(Node.isPropertyAssignment)
              .map((p) => p.getName())
              .filter((n) => n !== "_tag" && n !== "version")
            taggedSchemasByTag.set(tag, {
              tag,
              properties: props,
              file: relPath,
              line: c.getStartLineNumber()
            })
            break
          }
        }
      }
    }

    // Collect Schema.TaggedStruct definitions in sourceFile
    for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const calleeText = callExpr.getExpression().getText()
      if (calleeText === "Schema.TaggedStruct" || calleeText === "S.TaggedStruct") {
        const args = callExpr.getArguments()
        if (args.length >= 2 && Node.isStringLiteral(args[0]) && Node.isObjectLiteralExpression(args[1])) {
          const tag = args[0].getLiteralText()
          const props = args[1]
            .getProperties()
            .filter(Node.isPropertyAssignment)
            .map((p) => p.getName())
            .filter((n) => n !== "_tag" && n !== "version")
          taggedSchemasByTag.set(tag, {
            tag,
            properties: props,
            file: relPath,
            line: callExpr.getStartLineNumber()
          })
        }
      }
    }
  }

  // 2. Second pass: Extract Layers and EffectFns
  for (const sourceFile of project.getSourceFiles()) {
    const relPath = path.relative(repoRoot, sourceFile.getFilePath()).replace(/\\/g, "/")
    const filePkgTag = fileMap.get(relPath)?.packageTag ?? resolvePackageTag(repoRoot, relPath)

    for (const varDecl of sourceFile.getVariableDeclarations()) {
      if (!varDecl.isExported()) continue
      const varName = varDecl.getName()
      const typeNode = varDecl.getTypeNode()
      const init = varDecl.getInitializer()
      const typeText = typeNode?.getText() ?? ""
      const initText = init?.getText() ?? ""

      // Layer check
      const isLayer =
        typeText.includes("Layer") ||
        initText.startsWith("Layer.") ||
        (init &&
          Node.isCallExpression(init) &&
          init.getExpression().getText().startsWith("Layer."))

      if (isLayer) {
        const qualname = `${relPath}#${varName}`
        let layerKind: LayerKind = "live"
        if (/test/i.test(varName)) {
          layerKind = "test"
        } else if (/emulated/i.test(varName)) {
          layerKind = "emulated"
        } else if (/infra/i.test(varName)) {
          layerKind = "infra"
        } else {
          layerKind = "live"
        }

        layers.push({
          _tag: "ServiceLayer",
          qualname,
          layerKind,
          packageTag: filePkgTag,
          file: relPath
        })

        const rOutMembers = new Set<string>()
        const rInMembers = new Set<string>()

        // From TypeNode
        if (typeNode && Node.isTypeReference(typeNode)) {
          const typeArgs = typeNode.getTypeArguments()
          if (typeArgs.length >= 1 && typeArgs[0]) {
            for (const m of decomposeTypeNode(typeArgs[0])) {
              rOutMembers.add(m)
            }
          }
          if (typeArgs.length >= 3 && typeArgs[2]) {
            for (const m of decomposeTypeNode(typeArgs[2])) {
              rInMembers.add(m)
            }
          }
        }

        // From TypeChecker
        const type = varDecl.getType()
        const typeArgs = type.getTypeArguments()
        if (typeArgs.length >= 3) {
          if (typeArgs[0]) {
            for (const m of decomposeType(typeArgs[0])) {
              rOutMembers.add(m)
            }
          }
          if (typeArgs[2]) {
            for (const m of decomposeType(typeArgs[2])) {
              rInMembers.add(m)
            }
          }
        }

        // From AST initializer fallback
        if (
          rOutMembers.size === 0 &&
          rInMembers.size === 0 &&
          init &&
          Node.isCallExpression(init)
        ) {
          const args = init.getArguments()
          if (args.length > 0 && args[0]?.getKind() === SyntaxKind.Identifier) {
            rOutMembers.add(args[0].getText())
          }
          const yields = init.getDescendantsOfKind(SyntaxKind.YieldExpression)
          for (const y of yields) {
            const expr = y.getExpression()
            if (expr && expr.getKind() === SyntaxKind.Identifier) {
              rInMembers.add(expr.getText())
            }
          }
        }

        for (const rawROut of rOutMembers) {
          const rOut = classNameToTagId.get(rawROut) ?? rawROut
          providesService.push({ layerQualname: qualname, tagId: rOut })
          referencedServices.add(rOut)
        }
        for (const rawRIn of rInMembers) {
          const rIn = classNameToTagId.get(rawRIn) ?? rawRIn
          layerRequires.push({ layerQualname: qualname, tagId: rIn })
          referencedServices.add(rIn)
        }

        continue
      }

      // EffectFn check
      let isEffectFn = false
      let spanName = varName

      if (init && init.getKind() === SyntaxKind.CallExpression) {
        const outerCall = init as CallExpression
        const innerExpr = outerCall.getExpression()
        if (innerExpr.getKind() === SyntaxKind.CallExpression) {
          const innerCall = innerExpr as CallExpression
          const callee = innerCall.getExpression().getText()
          if (callee === "Effect.fn") {
            isEffectFn = true
            const args = innerCall.getArguments()
            if (args.length > 0 && args[0]?.getKind() === SyntaxKind.StringLiteral) {
              spanName = args[0].getText().replace(/^["'`]|["'`]$/g, "")
            }
          } else if (callee === "Effect.fnUntraced") {
            isEffectFn = true
            spanName = varName
          }
        } else if (innerExpr.getText() === "Effect.fnUntraced") {
          isEffectFn = true
          spanName = varName
        }
      }

      if (
        !isEffectFn &&
        (filePkgTag === "domain" || filePkgTag === "contract") &&
        init &&
        (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) &&
        init.getParameters().length === 2 &&
        /^(?:evolve[A-Z]\w*|reduce[A-Z]\w*|.*Reducer)$/.test(varName)
      ) {
        isEffectFn = true
        spanName =
          varName.startsWith("evolve") && varName.length > 6
            ? `${varName.slice(6)}.evolve`
            : varName
      }

      if (!isEffectFn || !init) continue

      const qualname = `${relPath}#${varName}`
      const line = varDecl.getStartLineNumber()
      let isStub = false
      let successType = "void"
      const errorTags = new Set<string>()
      const requiredServices = new Set<string>()

      // Check stub calls
      const calls = init.getDescendantsOfKind(SyntaxKind.CallExpression)
      for (const c of calls) {
        const expr = c.getExpression()
        const exprText = expr.getText()
        if (exprText === "stub" || exprText.endsWith(".stub")) {
          isStub = true
          const typeArgs = c.getTypeArguments()
          if (typeArgs.length >= 1 && typeArgs[0]) {
            successType = typeArgs[0].getText()
          }
          if (typeArgs.length >= 2 && typeArgs[1]) {
            for (const err of decomposeTypeNode(typeArgs[1])) {
              errorTags.add(err)
            }
          }
          if (typeArgs.length >= 3 && typeArgs[2]) {
            for (const svc of decomposeTypeNode(typeArgs[2])) {
              requiredServices.add(svc)
            }
          }
        }
      }

      // Explicit type on variable declaration
      if (typeNode) {
        const effectRef = typeNode.getFirstDescendant(
          (node) => Node.isTypeReference(node) && node.getText().includes("Effect")
        )
        if (effectRef && Node.isTypeReference(effectRef)) {
          const typeArgs = effectRef.getTypeArguments()
          if (typeArgs.length >= 1 && typeArgs[0] && successType === "void") {
            successType = typeArgs[0].getText()
          }
          if (typeArgs.length >= 2 && typeArgs[1]) {
            for (const err of decomposeTypeNode(typeArgs[1])) {
              errorTags.add(err)
            }
          }
          if (typeArgs.length >= 3 && typeArgs[2]) {
            for (const svc of decomposeTypeNode(typeArgs[2])) {
              requiredServices.add(svc)
            }
          }
        }
      }

      // TypeChecker signature return type
      const sigs = varDecl.getType().getCallSignatures()
      if (sigs.length > 0 && sigs[0]) {
        const retType = sigs[0].getReturnType()
        const typeArgs = retType.getTypeArguments()
        if (typeArgs.length >= 1 && typeArgs[0] && successType === "void" && !typeArgs[0].isAny()) {
          successType = typeArgs[0].getText()
        } else if (successType === "void") {
          const retNode =
            Node.isArrowFunction(init) || Node.isFunctionExpression(init)
              ? init.getReturnTypeNode()?.getText()
              : undefined
          successType = retNode ?? (!retType.isAny() ? retType.getText() : "unknown")
        }
        if (
          typeArgs.length >= 2 &&
          typeArgs[1] &&
          !typeArgs[1].isNever() &&
          !typeArgs[1].isUnknown() &&
          !typeArgs[1].isAny()
        ) {
          for (const err of decomposeType(typeArgs[1])) {
            errorTags.add(err)
          }
        }
        if (
          typeArgs.length >= 3 &&
          typeArgs[2] &&
          !typeArgs[2].isNever() &&
          !typeArgs[2].isUnknown() &&
          !typeArgs[2].isAny()
        ) {
          for (const svc of decomposeType(typeArgs[2])) {
            requiredServices.add(svc)
          }
        }
      }

      // AST yield traversal for real implementations
      const yields = init.getDescendantsOfKind(SyntaxKind.YieldExpression)
      const varToService = new Map<string, string>()
      const shouldExtractYieldedServices = requiredServices.size === 0

      for (const y of yields) {
        const expr = y.getExpression()
        if (!expr) continue

        if (expr.getKind() === SyntaxKind.Identifier) {
          const rawName = expr.getText()
          const isServiceCandidate =
            classNameToTagId.has(rawName) ||
            services.some((s) => s.tagId === rawName || s.name === rawName) ||
            /^[A-Z]/.test(rawName)

          if (shouldExtractYieldedServices && isServiceCandidate) {
            const svcName = classNameToTagId.get(rawName) ?? rawName
            requiredServices.add(svcName)
          }

          const parent = y.getParent()
          if (parent && parent.getKind() === SyntaxKind.VariableDeclaration) {
            const id = parent.getFirstChildByKind(SyntaxKind.Identifier)
            if (id) {
              varToService.set(id.getText(), rawName)
            }
          }
        }

        if (expr.getKind() === SyntaxKind.CallExpression) {
          const callExpr = expr as CallExpression
          const calleeText = callExpr.getExpression().getText()
          if (calleeText === "Effect.fail" || calleeText.endsWith(".fail")) {
            const args = callExpr.getArguments()
            if (args.length > 0 && args[0]) {
              const arg = args[0]
              if (arg.getKind() === SyntaxKind.NewExpression) {
                const newExpr = arg as NewExpression
                errorTags.add(newExpr.getExpression().getText())
              } else if (arg.getKind() === SyntaxKind.Identifier) {
                errorTags.add(arg.getText())
              }
            }
          }
        }
      }

      // Method calls on yielded services
      for (const c of calls) {
        const expr = c.getExpression()
        if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
          const propAccess = expr as PropertyAccessExpression
          const objText = propAccess.getExpression().getText()
          const methodName = propAccess.getName()
          const svcName = varToService.get(objText)
          if (svcName) {
            const methodErrors = serviceMethodErrors.get(svcName)?.get(methodName)
            if (methodErrors) {
              for (const err of methodErrors) {
                errorTags.add(err)
              }
            }
          }
        }
      }

      fns.push({
        _tag: "EffectFn",
        qualname,
        spanName,
        packageTag: filePkgTag,
        file: relPath,
        line,
        successType,
        isStub
      })

      for (const err of errorTags) {
        failsWith.push({ callerQualname: qualname, errorTag: err })
        referencedErrors.add(err)
      }
      for (const rawSvc of requiredServices) {
        const svc = classNameToTagId.get(rawSvc) ?? rawSvc
        requiresService.push({ callerQualname: qualname, tagId: svc })
        referencedServices.add(svc)
      }
    }

    if (filePkgTag === "domain" || filePkgTag === "contract") {
      for (const fnDecl of sourceFile.getFunctions()) {
        if (!fnDecl.isExported()) continue
        const fnName = fnDecl.getName()
        if (!fnName) continue
        if (
          /^(?:evolve[A-Z]\w*|reduce[A-Z]\w*|.*Reducer)$/.test(fnName) &&
          fnDecl.getParameters().length === 2
        ) {
          const qualname = `${relPath}#${fnName}`
          const spanName =
            fnName.startsWith("evolve") && fnName.length > 6
              ? `${fnName.slice(6)}.evolve`
              : fnName
          fns.push({
            _tag: "EffectFn",
            qualname,
            spanName,
            packageTag: filePkgTag,
            file: relPath,
            line: fnDecl.getStartLineNumber(),
            successType: fnDecl.getReturnTypeNode()?.getText() ?? "unknown",
            isStub: false
          })
        }
      }
    }
  }

  // 2b. Type-aware discriminant branching, array predicate branching, non-exhaustive match check, and schema boolean state check
  for (const sourceFile of project.getSourceFiles()) {
    const relPath = path.relative(repoRoot, sourceFile.getFilePath()).replace(/\\/g, "/")
    if (
      !fileMap.has(relPath) ||
      relPath.startsWith("libs/harness/") ||
      relPath.startsWith("apps/harness-")
    ) {
      continue
    }

    const filePkgTag = fileMap.get(relPath)?.packageTag ?? resolvePackageTag(repoRoot, relPath)

    // Track local variable declarations that alias a discriminant property of a union
    const discriminantAliasVars = new Set<string>()
    for (const varDecl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const init = varDecl.getInitializer()
      if (init && Node.isPropertyAccessExpression(init)) {
        const objExpr = init.getExpression()
        const propName = init.getName()
        const objType = objExpr.getType()
        if (isDiscriminantPropertyOfUnion(objType, propName, init)) {
          discriminantAliasVars.add(varDecl.getName())
        }
      } else if (init) {
        const nameNode = varDecl.getNameNode()
        if (Node.isObjectBindingPattern(nameNode)) {
          const objType = init.getType()
          for (const elem of nameNode.getElements()) {
            const propName = elem.getPropertyNameNode()?.getText() ?? elem.getName()
            if (isDiscriminantPropertyOfUnion(objType, propName, elem)) {
              discriminantAliasVars.add(elem.getName())
            }
          }
        }
      }
    }

    const checkConditionNode = (condExpr: Node, statementNode: Node): void => {
      const callNodes = [
        ...(Node.isCallExpression(condExpr) ? [condExpr] : []),
        ...condExpr.getDescendantsOfKind(SyntaxKind.CallExpression)
      ]
      for (const callNode of callNodes) {
        const calleeText = callNode.getExpression().getText()
        if (
          calleeText === "Exit.isSuccess" ||
          calleeText === "Exit.isFailure" ||
          calleeText === "Option.isSome" ||
          calleeText === "Option.isNone" ||
          calleeText === "Either.isRight" ||
          calleeText === "Either.isLeft" ||
          calleeText === "Result.isSuccess" ||
          calleeText === "Result.isFailure"
        ) {
          const enclosingSymbol = findEnclosingSymbolName(statementNode, relPath)
          branchingViolations.push({
            rule: "discriminant-branching",
            message: `Condition in '${enclosingSymbol}' branches on tag guard '${calleeText}(...)' via if/ternary — enumerate all variants explicitly with match(...).with(...).exhaustive() from ts-pattern.`,
            file: relPath,
            line: statementNode.getStartLineNumber(),
            enclosingSymbol
          })
          return
        }
      }

      const binNodes = [
        ...(Node.isBinaryExpression(condExpr) ? [condExpr] : []),
        ...condExpr.getDescendantsOfKind(SyntaxKind.BinaryExpression)
      ]
      for (const bin of binNodes) {
        const opKind = bin.getOperatorToken().getKind()
        if (
          opKind !== SyntaxKind.EqualsEqualsEqualsToken &&
          opKind !== SyntaxKind.ExclamationEqualsEqualsToken &&
          opKind !== SyntaxKind.EqualsEqualsToken &&
          opKind !== SyntaxKind.ExclamationEqualsToken
        ) {
          continue
        }
        const candidatePairs = [
          { side: bin.getLeft(), other: bin.getRight() },
          { side: bin.getRight(), other: bin.getLeft() }
        ]
        for (const { side, other } of candidatePairs) {
          if (Node.isPropertyAccessExpression(side)) {
            const isOtherLiteral =
              Node.isStringLiteral(other) ||
              Node.isNumericLiteral(other) ||
              Node.isNoSubstitutionTemplateLiteral(other) ||
              other.getKind() === SyntaxKind.TrueKeyword ||
              other.getKind() === SyntaxKind.FalseKeyword
            if (!isOtherLiteral) {
              continue
            }
            const objExpr = side.getExpression()
            const propName = side.getName()
            const objType = objExpr.getType()
            if (isDiscriminantPropertyOfUnion(objType, propName, side)) {
              const enclosingSymbol = findEnclosingSymbolName(statementNode, relPath)
              branchingViolations.push({
                rule: "discriminant-branching",
                message: `Condition in '${enclosingSymbol}' branches on union discriminant '${objExpr.getText()}.${propName}' via if/ternary — enumerate all union variants explicitly with match(${objExpr.getText()}).with(...).exhaustive() from ts-pattern.`,
                file: relPath,
                line: statementNode.getStartLineNumber(),
                enclosingSymbol
              })
              return
            }
          } else if (Node.isIdentifier(side) && discriminantAliasVars.has(side.getText())) {
            const enclosingSymbol = findEnclosingSymbolName(statementNode, relPath)
            branchingViolations.push({
              rule: "discriminant-branching",
              message: `Condition in '${enclosingSymbol}' branches on aliased union discriminant '${side.getText()}' via if/ternary — enumerate all union variants explicitly with match(...).with(...).exhaustive() from ts-pattern.`,
              file: relPath,
              line: statementNode.getStartLineNumber(),
              enclosingSymbol
            })
            return
          }
        }
      }
    }

    for (const ifStmt of sourceFile.getDescendantsOfKind(SyntaxKind.IfStatement)) {
      checkConditionNode(ifStmt.getExpression(), ifStmt)
    }

    for (const condExpr of sourceFile.getDescendantsOfKind(SyntaxKind.ConditionalExpression)) {
      checkConditionNode(condExpr.getCondition(), condExpr)
    }

    for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = callExpr.getExpression()
      const calleeText = callee.getText()

      // unscoped-effect-run check
      if (
        calleeText === "Effect.runSync" ||
        calleeText === "Effect.runPromise" ||
        calleeText === "Effect.runFork" ||
        calleeText === "Runtime.runSync" ||
        calleeText === "Runtime.runPromise"
      ) {
        const isInsideDeciderMake = callExpr.getAncestors().some(
          (a) =>
            Node.isCallExpression(a) &&
            /^(?:.*\.)?Decider\.make$/.test(a.getExpression().getText())
        )
        const enclosingSymbol = findEnclosingSymbolName(callExpr, relPath)
        const isDomainOrContract =
          (filePkgTag === "domain" || filePkgTag === "contract") &&
          !relPath.endsWith("/testing.ts")
        const isReducerSymbol = /#(evolve\w*|reduce\w*|.*Reducer)$/i.test(enclosingSymbol)

        if (isDomainOrContract || isInsideDeciderMake || isReducerSymbol) {
          branchingViolations.push({
            rule: "unscoped-effect-run",
            message: `Call to '${calleeText}' in '${enclosingSymbol}' executes an Effect synchronously/imperatively inside domain/reducer logic — keep reducers pure '(state, event) => State' and yield Effects instead of calling Effect.run*.`,
            file: relPath,
            line: callExpr.getStartLineNumber(),
            enclosingSymbol
          })
        }
      }

      // Array predicate callbacks: .filter(...), .find(...), .some(...), .every(...)
      if (Node.isPropertyAccessExpression(callee)) {
        const methodName = callee.getName()
        if (
          methodName === "filter" ||
          methodName === "find" ||
          methodName === "some" ||
          methodName === "every"
        ) {
          const args = callExpr.getArguments()
          if (args.length > 0 && args[0]) {
            const cb = args[0]
            if (Node.isArrowFunction(cb) || Node.isFunctionExpression(cb)) {
              const binNodes = cb.getDescendantsOfKind(SyntaxKind.BinaryExpression)
              for (const bin of binNodes) {
                const opKind = bin.getOperatorToken().getKind()
                if (
                  opKind !== SyntaxKind.EqualsEqualsEqualsToken &&
                  opKind !== SyntaxKind.ExclamationEqualsEqualsToken &&
                  opKind !== SyntaxKind.EqualsEqualsToken &&
                  opKind !== SyntaxKind.ExclamationEqualsToken
                ) {
                  continue
                }
                const candidatePairs = [
                  { side: bin.getLeft(), other: bin.getRight() },
                  { side: bin.getRight(), other: bin.getLeft() }
                ]
                for (const { side, other } of candidatePairs) {
                  if (Node.isPropertyAccessExpression(side)) {
                    const isOtherLiteral =
                      Node.isStringLiteral(other) ||
                      Node.isNumericLiteral(other) ||
                      Node.isNoSubstitutionTemplateLiteral(other) ||
                      other.getKind() === SyntaxKind.TrueKeyword ||
                      other.getKind() === SyntaxKind.FalseKeyword
                    if (!isOtherLiteral) continue
                    const objExpr = side.getExpression()
                    const propName = side.getName()
                    const objType = objExpr.getType()
                    if (isDiscriminantPropertyOfUnion(objType, propName, side)) {
                      const enclosingSymbol = findEnclosingSymbolName(callExpr, relPath)
                      branchingViolations.push({
                        rule: "discriminant-branching",
                        message: `Predicate callback in '${enclosingSymbol}' branches on union discriminant '${objExpr.getText()}.${propName}' via .${methodName}() — enumerate all union variants explicitly with match(${objExpr.getText()}).with(...).exhaustive() from ts-pattern.`,
                        file: relPath,
                        line: bin.getStartLineNumber(),
                        enclosingSymbol
                      })
                      break
                    }
                  } else if (Node.isIdentifier(side) && discriminantAliasVars.has(side.getText())) {
                    const enclosingSymbol = findEnclosingSymbolName(callExpr, relPath)
                    branchingViolations.push({
                      rule: "discriminant-branching",
                      message: `Predicate callback in '${enclosingSymbol}' branches on aliased union discriminant '${side.getText()}' via .${methodName}() — enumerate all union variants explicitly with match(...).with(...).exhaustive() from ts-pattern.`,
                      file: relPath,
                      line: bin.getStartLineNumber(),
                      enclosingSymbol
                    })
                    break
                  }
                }
              }
            }
          }
        }
      }

      // Check ts-pattern match(...).otherwise() on closed union
      if (Node.isPropertyAccessExpression(callee) && callee.getName() === "otherwise") {
        let curr: Node = callee.getExpression()
        while (Node.isCallExpression(curr)) {
          const innerCallee = curr.getExpression()
          if (
            Node.isPropertyAccessExpression(innerCallee) &&
            (innerCallee.getName() === "with" ||
              innerCallee.getName() === "when" ||
              innerCallee.getName() === "narrow" ||
              innerCallee.getName() === "returnType")
          ) {
            curr = innerCallee.getExpression()
          } else {
            break
          }
        }
        if (Node.isCallExpression(curr) && curr.getExpression().getText() === "match") {
          const matchArg = curr.getArguments()[0]
          if (matchArg) {
            const argType = matchArg.getType()
            if (isClosedFiniteUnionType(argType, matchArg)) {
              const enclosingSymbol = findEnclosingSymbolName(callExpr, relPath)
              branchingViolations.push({
                rule: "non-exhaustive-union-match",
                message: `match(${matchArg.getText()}) in '${enclosingSymbol}' matches on a closed union type '${argType.getText(matchArg)}' but terminates with .otherwise() — enumerate every variant and terminate with .exhaustive().`,
                file: relPath,
                line: callExpr.getStartLineNumber(),
                enclosingSymbol
              })
            }
          }
        }
      }
    }

    // fallback-json-equality check
    for (const bin of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      const opKind = bin.getOperatorToken().getKind()
      const isCaseA =
        (opKind === SyntaxKind.EqualsEqualsEqualsToken ||
          opKind === SyntaxKind.ExclamationEqualsEqualsToken ||
          opKind === SyntaxKind.EqualsEqualsToken ||
          opKind === SyntaxKind.ExclamationEqualsToken) &&
        bin.getLeft().getText().trim().startsWith("JSON.stringify(") &&
        bin.getRight().getText().trim().startsWith("JSON.stringify(")
      const isCaseB =
        (opKind === SyntaxKind.BarBarToken || opKind === SyntaxKind.AmpersandAmpersandToken) &&
        bin.getLeft().getText().includes("Equal.equals(") &&
        bin.getRight().getText().includes("JSON.stringify(")

      if (isCaseA || isCaseB) {
        const enclosingSymbol = findEnclosingSymbolName(bin, relPath)
        branchingViolations.push({
          rule: "fallback-json-equality",
          message: `Comparison in '${enclosingSymbol}' uses JSON.stringify equality fallback — compare Effect Data/Schema values exclusively with Equal.equals(a, b).`,
          file: relPath,
          line: bin.getStartLineNumber(),
          enclosingSymbol
        })
      }
    }

    // vacuous-error-assertion check
    const ASSERTION_NAME_REGEX = /^(?:thenFails|assertFails|expectError)$/
    const assertionCandidates = [
      ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodSignature),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment)
    ]
    for (const node of assertionCandidates) {
      const name = node.getName()
      if (!name || !ASSERTION_NAME_REGEX.test(name)) continue

      let params: ReadonlyArray<ParameterDeclaration> | undefined
      if (
        Node.isMethodSignature(node) ||
        Node.isMethodDeclaration(node) ||
        Node.isFunctionDeclaration(node)
      ) {
        params = node.getParameters()
      } else if (Node.isVariableDeclaration(node) || Node.isPropertyAssignment(node)) {
        const init = node.getInitializer()
        if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
          params = init.getParameters()
        }
      }

      if (params !== undefined) {
        const isVacuous =
          params.length === 0 ||
          (params[0] !== undefined &&
            (params[0].hasQuestionToken() ||
              params[0].hasInitializer() ||
              /\bundefined\b/.test(params[0].getTypeNode()?.getText() ?? "")))

        if (isVacuous) {
          const enclosingSymbol = findEnclosingSymbolName(node, relPath)
          branchingViolations.push({
            rule: "vacuous-error-assertion",
            message: `Assertion helper '${name}' in '${enclosingSymbol}' allows an optional or omitted expected error — require an explicit expected error instance or predicate so arbitrary failures are never silently swallowed.`,
            file: relPath,
            line: node.getStartLineNumber(),
            enclosingSymbol
          })
        }
      }
    }

    // Schema.Struct boolean state check in type:contract and type:domain
    if (filePkgTag === "contract" || filePkgTag === "domain") {
      for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = callExpr.getExpression()
        const isStructCall =
          callee.getText() === "Schema.Struct" ||
          callee.getText() === "S.Struct" ||
          (Node.isPropertyAccessExpression(callee) &&
            callee.getName() === "Struct" &&
            (callee.getExpression().getText() === "Schema" ||
              callee.getExpression().getText() === "S"))

        if (!isStructCall) continue

        const args = callExpr.getArguments()
        if (args.length === 0 || !Node.isObjectLiteralExpression(args[0])) continue

        const objLit = args[0]
        const propAssignments: Array<{ name: string; node: Node; init: Node }> = []
        const propMap = new Map<string, { node: Node; init: Node }>()

        for (const p of objLit.getProperties()) {
          if (Node.isPropertyAssignment(p)) {
            const pName = p.getName()
            const pInit = p.getInitializer()
            if (pInit) {
              const entry = { name: pName, node: p, init: pInit }
              propAssignments.push(entry)
              propMap.set(pName, entry)
            }
          }
        }

        const isBooleanSchema = (node: Node): boolean => {
          const text = node.getText().replace(/\s+/g, "")
          if (text === "Schema.Boolean" || text === "S.Boolean") {
            return true
          }
          if (Node.isCallExpression(node)) {
            const calleeText = node.getExpression().getText().replace(/\s+/g, "")
            if (
              calleeText === "Schema.optional" ||
              calleeText === "S.optional" ||
              calleeText === "Schema.optionalWith" ||
              calleeText === "S.optionalWith"
            ) {
              const firstArg = node.getArguments()[0]
              if (firstArg) {
                return isBooleanSchema(firstArg)
              }
            }
          }
          return false
        }

        const isNullOrOrOption = (node: Node): boolean => {
          const text = node.getText()
          return (
            text.includes("NullOr") ||
            text.includes("Option") ||
            text.includes("Schema.NullOr") ||
            text.includes("Schema.Option") ||
            text.includes("S.NullOr") ||
            text.includes("S.Option")
          )
        }

        for (const { name, node, init } of propAssignments) {
          if (!isBooleanSchema(init)) continue

          const matchesRegex =
            /^(is[A-Z]|has[A-Z]|checkedOut|created|completed|cancelled|canceled|deleted|archived|active|closed|opened|approved|rejected|verified|published|expired)$/.test(
              name
            ) ||
            /^(is[A-Z]\w*|has[A-Z]\w*|checkedOut|created|completed|cancelled|canceled|deleted|archived|active|closed|opened|approved|rejected|verified|published|expired)$/.test(
              name
            )

          const hasCompanion = (() => {
            const candidates = [
              `${name}At`,
              `${name}By`,
              ...(name.startsWith("is") && name.length > 2
                ? [
                    `${name[2]!.toLowerCase()}${name.slice(3)}At`,
                    `${name[2]!.toLowerCase()}${name.slice(3)}By`
                  ]
                : []),
              ...(name.startsWith("has") && name.length > 3
                ? [
                    `${name[3]!.toLowerCase()}${name.slice(4)}At`,
                    `${name[3]!.toLowerCase()}${name.slice(4)}By`
                  ]
                : [])
            ]
            for (const cand of candidates) {
              const companion = propMap.get(cand)
              if (companion && isNullOrOrOption(companion.init)) {
                return true
              }
            }
            return false
          })()

          if (matchesRegex || hasCompanion) {
            const enclosingSymbol = findEnclosingSymbolName(node, relPath)
            branchingViolations.push({
              rule: "schema-boolean-state",
              message: `Property '${name}' in '${enclosingSymbol}' uses boolean flag for lifecycle state in Schema.Struct — mutually exclusive lifecycle states must be modeled as a closed union (Schema.TaggedUnion / Schema.TaggedStruct) instead of boolean flags.`,
              file: relPath,
              line: node.getStartLineNumber(),
              enclosingSymbol
            })
          }
        }
      }
    }

    // Event Sourcing Reducer checks: dead-event-payload and terminal-state-unhandled
    if (filePkgTag === "contract" || filePkgTag === "domain") {
      const isReducerName = (name: string): boolean => {
        const baseName = name.includes("#") ? name.split("#")[1]! : name
        return /^(evolve\w*|reduce\w*|.*Reducer)$/i.test(baseName)
      }

      const TERMINAL_VARIANT_REGEX =
        /^(CheckedOut|Cancelled|Canceled|Archived|Completed|Closed|Finished|Terminated)$/i

      const candidateFunctions = [
        ...sourceFile.getFunctions(),
        ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction),
        ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression)
      ]

      const processedSymbols = new Set<string>()

      for (const fnNode of candidateFunctions) {
        const enclosingSymbol = findEnclosingSymbolName(fnNode, relPath)
        if (!isReducerName(enclosingSymbol)) continue
        if (processedSymbols.has(enclosingSymbol)) continue

        const params = fnNode.getParameters()
        if (params.length < 2) continue
        processedSymbols.add(enclosingSymbol)
        const stateParam = params[0]
        const eventParam = params[1]

        // 1. terminal-state-unhandled check
        if (stateParam && eventParam) {
          const stateType = stateParam.getType()
          let terminalVariantName: string | null = null

          if (stateType.isUnion()) {
            for (const unionPart of stateType.getUnionTypes()) {
              const tagProp = unionPart.getProperty("_tag")
              if (tagProp) {
                const tagType = tagProp.getTypeAtLocation(stateParam)
                const rawTag = tagType.getText().replace(/^["'`]|["'`]$/g, "")
                if (TERMINAL_VARIANT_REGEX.test(rawTag)) {
                  terminalVariantName = rawTag
                  break
                }
              } else {
                const typeText = unionPart.getText()
                const matchTag = typeText.match(TERMINAL_VARIANT_REGEX)
                if (matchTag) {
                  terminalVariantName = matchTag[0]
                  break
                }
              }
            }
          }

          if (terminalVariantName !== null) {
            for (const callExpr of fnNode.getDescendantsOfKind(SyntaxKind.CallExpression)) {
              if (callExpr.getExpression().getText() === "match") {
                const matchArg = callExpr.getArguments()[0]
                if (matchArg) {
                  const matchArgText = matchArg.getText()
                  const eventParamName = eventParam.getName()
                  if (matchArgText === eventParamName || matchArgText === "event" || matchArgText === "ev") {
                    branchingViolations.push({
                      rule: "terminal-state-unhandled",
                      message: `Reducer '${enclosingSymbol}' matches only on '${matchArgText}' without checking for terminal state '${terminalVariantName}' — terminal states must be matched on 'state' to preserve terminality during event folding.`,
                      file: relPath,
                      line: callExpr.getStartLineNumber(),
                      enclosingSymbol
                    })
                  }
                }
              }
            }
          }
        }

        // 2. dead-event-payload check
        const handledTags = new Set<string>()
        const usedPropsPerTag = new Map<string, Set<string>>()

        for (const withCall of fnNode.getDescendantsOfKind(SyntaxKind.CallExpression)) {
          const callee = withCall.getExpression()
          if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "with") {
            continue
          }

          const args = withCall.getArguments()
          if (args.length < 2) continue

          const handler = args[args.length - 1]
          if (!handler || (!Node.isArrowFunction(handler) && !Node.isFunctionExpression(handler))) {
            continue
          }

          const patternArgs = args.slice(0, args.length - 1)
          const matchedTagsInWith: Array<string> = []

          for (const patternArg of patternArgs) {
            for (const propAssign of patternArg.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
              if (propAssign.getName() === "_tag") {
                const init = propAssign.getInitializer()
                if (init && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))) {
                  const tag = init.getLiteralText()
                  if (taggedSchemasByTag.has(tag)) {
                    matchedTagsInWith.push(tag)
                    handledTags.add(tag)
                    if (!usedPropsPerTag.has(tag)) {
                      usedPropsPerTag.set(tag, new Set())
                    }
                  }
                }
              }
            }
          }

          if (matchedTagsInWith.length === 0) continue

          // Check parameter destructuring: ({ reservationId }) or ([state, { reservationId }])
          for (const param of handler.getParameters()) {
            for (const binding of param.getDescendantsOfKind(SyntaxKind.BindingElement)) {
              const name = binding.getName()
              for (const tag of matchedTagsInWith) {
                const schema = taggedSchemasByTag.get(tag)
                if (schema && schema.properties.includes(name)) {
                  usedPropsPerTag.get(tag)!.add(name)
                }
              }
            }
          }

          // Check property accesses in handler body: ev.reservationId
          for (const propAccess of handler.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
            const propName = propAccess.getName()
            for (const tag of matchedTagsInWith) {
              const schema = taggedSchemasByTag.get(tag)
              if (schema && schema.properties.includes(propName)) {
                usedPropsPerTag.get(tag)!.add(propName)
              }
            }
          }

          // Check identifiers in handler body
          for (const ident of handler.getDescendantsOfKind(SyntaxKind.Identifier)) {
            const identText = ident.getText()
            for (const tag of matchedTagsInWith) {
              const schema = taggedSchemasByTag.get(tag)
              if (schema && schema.properties.includes(identText)) {
                usedPropsPerTag.get(tag)!.add(identText)
              }
            }
          }
        }

        // For each handled tag, verify all payload fields were used across reducer arms
        for (const tag of handledTags) {
          const schema = taggedSchemasByTag.get(tag)
          if (!schema || schema.properties.length === 0) continue

          const usedProps = usedPropsPerTag.get(tag) ?? new Set()
          for (const prop of schema.properties) {
            if (prop === "_tag" || prop === "version") continue
            if (!usedProps.has(prop)) {
              branchingViolations.push({
                rule: "dead-event-payload",
                message: `Event schema '${tag}' defines property '${prop}', but property '${prop}' is never read or applied in reducer '${enclosingSymbol}'. Superfluous event fields waste storage and mislead consumers.`,
                file: relPath,
                line: fnNode.getStartLineNumber(),
                enclosingSymbol
              })
            }
          }
        }
      }
    }
  }

  // 3. Auto-register referenced services
  const existingServiceTags = new Set(services.map((s) => s.tagId))
  for (const rawSvc of referencedServices) {
    const svc = classNameToTagId.get(rawSvc) ?? rawSvc
    if (!existingServiceTags.has(svc)) {
      existingServiceTags.add(svc)
      const isInfra = /^(Cloudflare|Alchemy|Drizzle|Provider|Binding)\b/.test(svc)
      services.push({
        _tag: "ServiceTag",
        tagId: svc,
        name: svc,
        packageTag: isInfra ? "infra" : "service",
        file: ""
      })
    }
  }

  // 4. Auto-register referenced errors
  const existingErrors = new Set(errors.map((e) => e.errorTag))
  for (const err of referencedErrors) {
    if (!existingErrors.has(err)) {
      existingErrors.add(err)
      errors.push({
        _tag: "TaggedError",
        errorTag: err,
        file: ""
      })
    }
  }

  return buildHarnessGraph({
    fns,
    services,
    layers,
    errors,
    tests: [],
    patternDocs: options?.patternDocs ?? [],
    requiresService,
    failsWith,
    providesService,
    layerRequires,
    tracedCalls: [],
    exercisesSpans: [],
    branchingViolations
  })
}

const findWorkspaceSrcFiles = (repoRoot: string): ReadonlyArray<string> => {
  const results: Array<string> = []
  const subDirs = ["libs", "apps"]

  const walk = (current: string): void => {
    if (!fs.existsSync(current)) return
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const e of entries) {
      if (
        e.name === "node_modules" ||
        e.name === "dist" ||
        e.name === ".nx" ||
        e.name === "repos" ||
        e.name === ".git" ||
        e.name === ".harness"
      ) {
        continue
      }
      if (e.name === "test") {
        const fixturesDir = path.join(current, "test", "fixtures")
        if (fs.existsSync(fixturesDir)) {
          walk(fixturesDir)
        }
        continue
      }
      const full = path.join(current, e.name)
      if (e.isDirectory()) {
        walk(full)
      } else if (
        e.isFile() &&
        (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) &&
        !e.name.endsWith(".d.ts") &&
        !e.name.endsWith(".config.ts")
      ) {
        const rel = path.relative(repoRoot, full).replace(/\\/g, "/")
        if (rel.includes("/src/") || rel.includes("/test/fixtures/") || rel.endsWith("alchemy.run.ts")) {
          results.push(rel)
        }
      }
    }
  }

  for (const sub of subDirs) {
    walk(path.join(repoRoot, sub))
  }

  return results
}

const findWorkspaceTestFiles = (repoRoot: string): ReadonlyArray<string> => {
  const results: Array<string> = []
  const subDirs = ["libs", "apps"]

  const walk = (current: string): void => {
    if (!fs.existsSync(current)) return
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const e of entries) {
      if (
        e.name === "node_modules" ||
        e.name === "dist" ||
        e.name === ".nx" ||
        e.name === "repos" ||
        e.name === ".git" ||
        e.name === ".harness"
      ) {
        continue
      }
      const full = path.join(current, e.name)
      if (e.isDirectory()) {
        walk(full)
      } else if (
        e.isFile() &&
        e.name.endsWith(".test.ts")
      ) {
        const rel = path.relative(repoRoot, full).replace(/\\/g, "/")
        if (rel.includes("/test/")) {
          results.push(rel)
        }
      }
    }
  }

  for (const sub of subDirs) {
    walk(path.join(repoRoot, sub))
  }

  return results
}

const parseGovernanceDocFile = (
  relDocPath: string,
  content: string
): AdrDocNode | EarsSpecNode | null => {
  const normalized = content.replace(/^\uFEFF/, "")
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match || match[1] === undefined) {
    return null
  }

  const yamlContent = match[1]
  const lines = yamlContent.split(/\r?\n/)

  const scalars = new Map<string, string>()
  const lists = new Map<string, Array<string>>()

  let currentListKey: string | null = null

  const stripQuotes = (val: string): string => {
    let trimmed = val.trim()
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1).trim()
    }
    const hashIdx = trimmed.indexOf("#")
    if (hashIdx !== -1) {
      trimmed = trimmed.slice(0, hashIdx).trim()
    }
    return trimmed
  }

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue
    }

    const listItemMatch = rawLine.match(/^\s*-\s*(.*)$/)
    if (listItemMatch && currentListKey !== null) {
      const item = stripQuotes(listItemMatch[1] ?? "")
      if (item.length > 0) {
        const list = lists.get(currentListKey)
        if (list) {
          list.push(item)
        }
      }
      continue
    }

    currentListKey = null

    const keyValMatch = rawLine.match(/^([a-zA-Z0-9_-]+)\s*:(.*)$/)
    if (keyValMatch) {
      const key = keyValMatch[1]!.trim()
      const rest = keyValMatch[2]!.trim()

      if (rest.startsWith("[") && rest.endsWith("]")) {
        const inner = rest.slice(1, -1).trim()
        const items =
          inner.length === 0
            ? []
            : inner
                .split(",")
                .map(stripQuotes)
                .filter((s) => s.length > 0)
        lists.set(key, items)
      } else if (rest === "") {
        lists.set(key, [])
        currentListKey = key
      } else {
        scalars.set(key, stripQuotes(rest))
      }
    }
  }

  const id = scalars.get("id")
  if (!id || id.trim() === "") {
    return null
  }

  let title = scalars.get("title")
  if (!title || title.trim() === "") {
    const titleMatch = normalized.match(/^#\s+(.+)$/m)
    title = titleMatch ? titleMatch[1]!.trim() : id
  }

  const rawStatus = scalars.get("status")
  const status: GovernanceDocStatus =
    rawStatus === "accepted" ||
    rawStatus === "proposed" ||
    rawStatus === "superseded" ||
    rawStatus === "deprecated"
      ? rawStatus
      : "proposed"

  const enforcedByFiles = lists.get("enforced_by") ?? []
  const referencedSpans = lists.get("spans") ?? []
  const referencedServices = lists.get("services") ?? []
  const referencedErrors = lists.get("errors") ?? []

  if (relDocPath.includes("/adr/")) {
    return {
      _tag: "AdrDoc",
      id,
      title,
      status,
      path: relDocPath,
      enforcedByFiles,
      referencedSpans,
      referencedServices,
      referencedErrors
    }
  }

  if (relDocPath.includes("/specs/")) {
    return {
      _tag: "EarsSpec",
      id,
      title,
      status,
      path: relDocPath,
      enforcedByFiles,
      referencedSpans,
      referencedServices,
      referencedErrors
    }
  }

  return null
}

export const loadWorkspaceGovernanceDocs = (
  repoRoot: string
): ReadonlyArray<AdrDocNode | EarsSpecNode> => {
  const root = resolveRepoRoot(repoRoot)
  const candidateRelDirs: Array<string> = ["docs/adr", "docs/specs"]

  const listSubdirectories = (parentRel: string): ReadonlyArray<string> => {
    const parentPath = path.join(root, parentRel)
    if (!fs.existsSync(parentPath)) {
      return []
    }
    return fs
      .readdirSync(parentPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  }

  const libScopes = listSubdirectories("libs")
  for (const scope of libScopes) {
    candidateRelDirs.push(`libs/${scope}/docs/adr`)
    candidateRelDirs.push(`libs/${scope}/docs/specs`)
  }

  const appNames = listSubdirectories("apps")
  for (const app of appNames) {
    candidateRelDirs.push(`apps/${app}/docs/adr`)
    candidateRelDirs.push(`apps/${app}/docs/specs`)
  }

  const results: Array<AdrDocNode | EarsSpecNode> = []

  for (const relDir of candidateRelDirs) {
    const fullDir = path.join(root, relDir)
    if (!fs.existsSync(fullDir)) {
      continue
    }

    const entries = fs.readdirSync(fullDir, { withFileTypes: true })
    const files = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".md") &&
          entry.name !== "README.md" &&
          entry.name !== "TEMPLATE.md"
      )
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))

    for (const file of files) {
      const relDocPath = `${relDir}/${file}`
      const fullPath = path.join(root, relDocPath)
      const content = fs.readFileSync(fullPath, "utf-8")
      const parsed = parseGovernanceDocFile(relDocPath, content)
      if (parsed !== null) {
        results.push(parsed)
      }
    }
  }

  return results
}

export const stripCommentsAndTestTitles = (code: string): string => {
  let stripped = code.replace(/\/\*[\s\S]*?\*\//g, " ")
  stripped = stripped.replace(/\/\/[^\r\n]*/g, " ")
  stripped = stripped.replace(
    /\b(?:describe|it|test)(?:\.[a-zA-Z0-9_$]+)*\s*\(\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[\s\S]*?`)/g,
    (match) => match.replace(/(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[\s\S]*?`)$/, '""')
  )
  return stripped
}

const splitTopLevelCommas = (input: string): Array<string> => {
  const items: Array<string> = []
  let depth = 0
  let current = ""
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (char === "(" || char === "[" || char === "{") {
      depth++
      current += char
    } else if (char === ")" || char === "]" || char === "}") {
      if (depth > 0) depth--
      current += char
    } else if (char === "," && depth === 0) {
      items.push(current)
      current = ""
    } else {
      current += char
    }
  }
  if (current.length > 0) {
    items.push(current)
  }
  return items
}

const PRIMITIVE_SCALAR_REGEX =
  /^(?:(?:Schema|S)\.(?:String|Number|Boolean|Int|Natural|Positive|Negative|NonNegative|NonPositive|NonEmptyString)(?:\.[A-Za-z0-9_($. )]+)*|PositiveInt|NonEmptyString|fc\.(?:integer|nat|string|boolean|float|double)\s*\([^)]*\))$/

export const extractWorkspaceTypeAwareGraph = (
  repoRoot: string
): Effect.Effect<HarnessGraph> =>
  Effect.sync(() => {
    const root = resolveRepoRoot(repoRoot)
    const relFiles = findWorkspaceSrcFiles(root)
    const inputs: Array<SourceFileInput> = []

    for (const file of relFiles) {
      const fullPath = path.join(root, file)
      if (!fs.existsSync(fullPath)) continue
      const content = fs.readFileSync(fullPath, "utf-8")
      const packageTag = resolvePackageTag(root, file)
      inputs.push({
        filePath: file,
        content,
        packageTag
      })
    }

    const patternDocs = loadPatternDocs(root)
    const baseGraph = extractTypeAwareGraphFromSource(inputs, {
      repoRoot: root,
      patternDocs
    })

    const effectFns: Array<EffectFnNode> = []
    const serviceTags: Array<ServiceTagNode> = []
    const taggedErrors: Array<TaggedErrorNode> = []
    for (const [, node] of Graph.nodes(baseGraph.graph)) {
      if (node._tag === "EffectFn") {
        effectFns.push(node)
      } else if (node._tag === "ServiceTag") {
        serviceTags.push(node)
      } else if (node._tag === "TaggedError") {
        taggedErrors.push(node)
      }
    }

    const testFiles = findWorkspaceTestFiles(root)
    const governanceDocs = loadWorkspaceGovernanceDocs(root)
    const updatedNodeIndexByKey = new Map<string, Graph.NodeIndex>(baseGraph.nodeIndexByKey)

    const deciderAliasesByFnName = new Map<string, Set<string>>()
    const deciderRegex = /(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*Decider\.make\s*(?:<[\s\S]*?>)?\s*\(\s*\{([\s\S]*?)\}\s*\)/g
    for (const input of inputs) {
      const deciderMatches = input.content.matchAll(deciderRegex)
      for (const m of deciderMatches) {
        const deciderVarName = m[1]
        const body = m[2]
        if (!deciderVarName || !body) continue

        const decideMatch = body.match(/decide\s*:\s*([A-Za-z0-9_$]+)/)
        const decideFn = decideMatch ? decideMatch[1] : (/\bdecide\b/.test(body) ? "decide" : null)

        const evolveMatch = body.match(/evolve\s*:\s*([A-Za-z0-9_$]+)/)
        const evolveFn = evolveMatch ? evolveMatch[1] : (/\bevolve\b/.test(body) ? "evolve" : null)

        for (const fn of [decideFn, evolveFn]) {
          if (!fn) continue
          let set = deciderAliasesByFnName.get(fn)
          if (!set) {
            set = new Set<string>()
            deciderAliasesByFnName.set(fn, set)
          }
          set.add(deciderVarName)
        }
      }
    }

    const augmentedGraph = Graph.mutate<HarnessNode, HarnessEdge>(
      baseGraph.graph,
      (mutable) => {
        for (const relTestFile of testFiles) {
          const fullPath = path.join(root, relTestFile)
          if (!fs.existsSync(fullPath)) continue
          const content = fs.readFileSync(fullPath, "utf-8")
          if (
            !content.includes("describe(") &&
            !content.includes("it(") &&
            !content.includes("it.effect(") &&
            !content.includes("it.prop(") &&
            !content.includes("it.effect.prop(")
          ) {
            continue
          }

          const hasPropTest =
            /\b(?:it|test)(?:\.effect)?\.prop\s*\(/.test(content) ||
            /\bfc\.assert\s*\(/.test(content)

          const strippedContent = stripCommentsAndTestTitles(content)

          let hasNonPrimitiveArbitrary: boolean | undefined = undefined
          if (hasPropTest) {
            const propCallRegex =
              /\b(?:it|test)(?:\.effect)?\.prop\s*\(\s*(?:""|''|``)\s*,\s*\[([\s\S]*?)\]/g
            const matches = [...strippedContent.matchAll(propCallRegex)]
            if (matches.length > 0) {
              const allCallsOnlyPrimitive = matches.every((m) => {
                const interior = m[1] ?? ""
                const rawItems = splitTopLevelCommas(interior)
                const items = rawItems.map((s) => s.trim()).filter((s) => s.length > 0)
                if (items.length === 0) {
                  return true
                }
                return items.every((item) => PRIMITIVE_SCALAR_REGEX.test(item))
              })
              hasNonPrimitiveArbitrary = !allCallsOnlyPrimitive
            } else {
              hasNonPrimitiveArbitrary = true
            }
          }

          const testNode: VitestCaseNode = {
            _tag: "VitestCase",
            testId: `${relTestFile}::suite`,
            testFile: relTestFile,
            testName: relTestFile,
            lastTreeHash: "workspace",
            isPropertyTest: hasPropTest,
            ...(hasNonPrimitiveArbitrary !== undefined ? { hasNonPrimitiveArbitrary } : {})
          }
          const testIdx = Graph.addNode(mutable, testNode)
          updatedNodeIndexByKey.set(testNode.testId, testIdx)

          const usesTestTracer = strippedContent.includes("runWithTestTracer")

          for (const fnNode of effectFns) {
            const fnName = fnNode.qualname.split("#")[1] ?? ""
            const escapedFnName = fnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            const fnRegex = escapedFnName
              ? new RegExp(`(?:\\b|\\$)${escapedFnName}\\s*(?:\\(|\\)|,)`)
              : null

            const isDottedIdentifier = /^[a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*$/.test(
              fnNode.spanName
            )
            const escapedSpanName = fnNode.spanName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            const spanCallRegex =
              isDottedIdentifier && escapedSpanName
                ? new RegExp(`\\b${escapedSpanName}\\s*\\(`)
                : null

            const testTracerMatches =
              usesTestTracer &&
              ((fnName.length > 0 && strippedContent.includes(fnName)) ||
                (fnNode.spanName.length > 0 && strippedContent.includes(fnNode.spanName)))

            const deciderAliases = deciderAliasesByFnName.get(fnName)
            let deciderAliasMatches = false
            if (deciderAliases) {
              for (const alias of deciderAliases) {
                const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                if (new RegExp(`\\b${escapedAlias}\\b`).test(strippedContent)) {
                  deciderAliasMatches = true
                  break
                }
              }
            }

            const matches =
              (fnRegex !== null && fnRegex.test(strippedContent)) ||
              (spanCallRegex !== null && spanCallRegex.test(strippedContent)) ||
              testTracerMatches ||
              deciderAliasMatches

            if (matches) {
              const calleeIdx = updatedNodeIndexByKey.get(fnNode.qualname)
              if (calleeIdx !== undefined) {
                const edge: ExercisesSpanEdge = {
                  _tag: "ExercisesSpan",
                  testId: testNode.testId,
                  calleeQualname: fnNode.qualname,
                  callCount: 1,
                  receiverLayer: null
                }
                Graph.addEdge(mutable, testIdx, calleeIdx, edge)
              }
            }
          }
        }

        for (const docNode of governanceDocs) {
          const docIdx = Graph.addNode(mutable, docNode)
          updatedNodeIndexByKey.set(docNode.id, docIdx)

          // 1. Spans -> EffectFn
          const addedFnTargets = new Set<string>()
          for (const span of docNode.referencedSpans) {
            for (const fnNode of effectFns) {
              if (
                fnNode.spanName === span ||
                fnNode.qualname === span ||
                fnNode.qualname.endsWith(`#${span}`)
              ) {
                if (addedFnTargets.has(fnNode.qualname)) continue
                addedFnTargets.add(fnNode.qualname)
                const targetIdx = updatedNodeIndexByKey.get(fnNode.qualname)
                if (targetIdx !== undefined) {
                  if (docNode._tag === "AdrDoc") {
                    const edge: GovernsSymbolEdge = {
                      _tag: "GovernsSymbol",
                      adrId: docNode.id,
                      targetKey: fnNode.qualname,
                      targetKind: "EffectFn"
                    }
                    Graph.addEdge(mutable, docIdx, targetIdx, edge)
                  } else {
                    const edge: SpecifiesSymbolEdge = {
                      _tag: "SpecifiesSymbol",
                      specId: docNode.id,
                      targetKey: fnNode.qualname,
                      targetKind: "EffectFn"
                    }
                    Graph.addEdge(mutable, docIdx, targetIdx, edge)
                  }
                }
              }
            }
          }

          // 2. Services -> ServiceTag
          const addedSvcTargets = new Set<string>()
          for (const svc of docNode.referencedServices) {
            for (const sNode of serviceTags) {
              if (
                sNode.tagId === svc ||
                sNode.name === svc ||
                sNode.tagId.endsWith(`#${svc}`)
              ) {
                if (addedSvcTargets.has(sNode.tagId)) continue
                addedSvcTargets.add(sNode.tagId)
                const targetIdx = updatedNodeIndexByKey.get(sNode.tagId)
                if (targetIdx !== undefined) {
                  if (docNode._tag === "AdrDoc") {
                    const edge: GovernsSymbolEdge = {
                      _tag: "GovernsSymbol",
                      adrId: docNode.id,
                      targetKey: sNode.tagId,
                      targetKind: "ServiceTag"
                    }
                    Graph.addEdge(mutable, docIdx, targetIdx, edge)
                  } else {
                    const edge: SpecifiesSymbolEdge = {
                      _tag: "SpecifiesSymbol",
                      specId: docNode.id,
                      targetKey: sNode.tagId,
                      targetKind: "ServiceTag"
                    }
                    Graph.addEdge(mutable, docIdx, targetIdx, edge)
                  }
                }
              }
            }
          }

          // 3. Errors -> TaggedError
          const addedErrTargets = new Set<string>()
          for (const err of docNode.referencedErrors) {
            for (const eNode of taggedErrors) {
              if (eNode.errorTag === err) {
                if (addedErrTargets.has(eNode.errorTag)) continue
                addedErrTargets.add(eNode.errorTag)
                const targetIdx = updatedNodeIndexByKey.get(eNode.errorTag)
                if (targetIdx !== undefined) {
                  if (docNode._tag === "AdrDoc") {
                    const edge: GovernsSymbolEdge = {
                      _tag: "GovernsSymbol",
                      adrId: docNode.id,
                      targetKey: eNode.errorTag,
                      targetKind: "TaggedError"
                    }
                    Graph.addEdge(mutable, docIdx, targetIdx, edge)
                  } else {
                    const edge: SpecifiesSymbolEdge = {
                      _tag: "SpecifiesSymbol",
                      specId: docNode.id,
                      targetKey: eNode.errorTag,
                      targetKind: "TaggedError"
                    }
                    Graph.addEdge(mutable, docIdx, targetIdx, edge)
                  }
                }
              }
            }
          }
        }
      }
    )

    return {
      graph: augmentedGraph,
      nodeIndexByKey: updatedNodeIndexByKey,
      branchingViolations: baseGraph.branchingViolations
    } satisfies HarnessGraph
  })
