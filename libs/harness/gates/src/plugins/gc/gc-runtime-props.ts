import { dirname, join, posix, relative } from "node:path"
import { ts } from "@harness/graph"
import type { SyncHostIo } from "@harness/service/host-io"
import { collectWorkspaceTsFiles, type GcFinding, readTextOrReport } from "./gc-helpers.js"

const RUNTIME_CONTEXT_INTERFACE_RE = /^[A-Z]\w*(?:Runtime|Context)$/

interface RuntimeInterfaceInfo {
  readonly key: string
  readonly name: string
  readonly relPath: string
  readonly optionalProps: ReadonlyArray<{ readonly name: string; readonly line: number }>
  readonly allOptionalNames: ReadonlySet<string>
}

interface ParsedAppFile {
  readonly relPath: string
  readonly sf: ts.SourceFile
  readonly isTest: boolean
}

const unwrapParens = (expr: ts.Expression): ts.Expression => {
  let current = expr
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }
  return current
}

const getPropKeyName = (name: ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)
    ? name.text
    : undefined

const resolveRelativeTsPath = (
  fromRelPath: string,
  specifier: string,
  knownFiles: ReadonlySet<string>,
): string | undefined => {
  if (!specifier.startsWith(".")) return undefined
  const joined = posix.normalize(posix.join(dirname(fromRelPath), specifier))
  const candidates: Array<string> = [joined]
  if (joined.endsWith(".js") || joined.endsWith(".jsx")) {
    const stem = joined.slice(0, joined.endsWith(".jsx") ? -4 : -3)
    candidates.push(`${stem}.ts`, `${stem}.tsx`)
  } else {
    candidates.push(`${joined}.ts`, `${joined}.tsx`, `${joined}/index.ts`, `${joined}/index.tsx`)
  }
  return candidates.find((cand) => knownFiles.has(cand))
}

const isEffectFnCallee = (expr: ts.Expression): boolean => {
  const u = unwrapParens(expr)
  return (
    ts.isPropertyAccessExpression(u) &&
    ts.isIdentifier(u.expression) &&
    u.expression.text === "Effect" &&
    (u.name.text === "fn" || u.name.text === "fnUntraced")
  )
}

const unwrapDeclaredFunction = (
  initializer: ts.Expression,
): ts.FunctionExpression | ts.ArrowFunction | undefined => {
  const u = unwrapParens(initializer)
  if (ts.isArrowFunction(u) || ts.isFunctionExpression(u)) return u
  if (!ts.isCallExpression(u)) return undefined
  const callee = unwrapParens(u.expression)
  const isWrappedEffectFn =
    isEffectFnCallee(callee) || (ts.isCallExpression(callee) && isEffectFnCallee(callee.expression))
  if (!isWrappedEffectFn) return undefined
  const fnArg = u.arguments[0]
  if (fnArg === undefined) return undefined
  const inner = unwrapParens(fnArg)
  return ts.isArrowFunction(inner) || ts.isFunctionExpression(inner) ? inner : undefined
}

const hasUndefinedUnionMember = (typeNode: ts.TypeNode | undefined): boolean => {
  if (typeNode === undefined) return false
  if (ts.isParenthesizedTypeNode(typeNode)) return hasUndefinedUnionMember(typeNode.type)
  if (typeNode.kind === ts.SyntaxKind.UndefinedKeyword) return true
  if (ts.isUnionTypeNode(typeNode)) {
    return typeNode.types.some((t) => hasUndefinedUnionMember(t))
  }
  return false
}

const extractTypeRefs = (
  typeNode: ts.TypeNode | undefined,
): ReadonlyArray<{ readonly qualifier?: string | undefined; readonly name: string }> => {
  if (typeNode === undefined) return []
  if (ts.isParenthesizedTypeNode(typeNode)) return extractTypeRefs(typeNode.type)
  if (ts.isTypeReferenceNode(typeNode)) {
    const refs: Array<{ readonly qualifier?: string | undefined; readonly name: string }> = []
    if (ts.isIdentifier(typeNode.typeName)) refs.push({ name: typeNode.typeName.text })
    if (ts.isQualifiedName(typeNode.typeName) && ts.isIdentifier(typeNode.typeName.left)) {
      refs.push({ qualifier: typeNode.typeName.left.text, name: typeNode.typeName.right.text })
    }
    if (typeNode.typeArguments !== undefined) {
      for (const ta of typeNode.typeArguments) {
        refs.push(...extractTypeRefs(ta))
      }
    }
    return refs
  }
  if (ts.isUnionTypeNode(typeNode)) {
    return typeNode.types.flatMap(extractTypeRefs)
  }
  return []
}

const isCallReturningUndefined = (
  expr: ts.CallExpression,
  isUndefinedReturnRef: (ref: {
    readonly qualifier?: string | undefined
    readonly name: string
  }) => boolean,
): boolean => {
  const c = unwrapParens(expr.expression)
  if (ts.isIdentifier(c)) return isUndefinedReturnRef({ name: c.text })
  if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression)) {
    return isUndefinedReturnRef({ qualifier: c.expression.text, name: c.name.text })
  }
  return false
}

const isOptionalPassThroughExpr = (
  expr: ts.Expression,
  optionalNames: ReadonlySet<string>,
  isUndefinedReturnRef?: (ref: {
    readonly qualifier?: string | undefined
    readonly name: string
  }) => boolean,
): boolean => {
  const u = unwrapParens(expr)
  if (
    u.kind === ts.SyntaxKind.NullKeyword ||
    u.kind === ts.SyntaxKind.VoidExpression ||
    (ts.isIdentifier(u) && u.text === "undefined")
  ) {
    return true
  }
  if (ts.isPropertyAccessChain(u) || ts.isElementAccessChain(u)) return true
  if (ts.isIdentifier(u) && optionalNames.has(u.text)) return true
  if (isUndefinedReturnRef !== undefined && ts.isCallExpression(u)) {
    if (isCallReturningUndefined(u, isUndefinedReturnRef)) return true
  }
  if (
    ts.isPropertyAccessExpression(u) &&
    (optionalNames.has(u.name.text) ||
      isOptionalPassThroughExpr(u.expression, optionalNames, isUndefinedReturnRef))
  ) {
    return true
  }
  if (ts.isConditionalExpression(u)) {
    return (
      isOptionalPassThroughExpr(u.whenTrue, optionalNames, isUndefinedReturnRef) ||
      isOptionalPassThroughExpr(u.whenFalse, optionalNames, isUndefinedReturnRef)
    )
  }
  if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    return isOptionalPassThroughExpr(u.right, optionalNames, isUndefinedReturnRef)
  }
  return false
}

const collectReturnedObjectLiterals = (
  expr: ts.Expression,
  out: Array<ts.ObjectLiteralExpression>,
): void => {
  const u = unwrapParens(expr)
  if (ts.isObjectLiteralExpression(u)) {
    out.push(u)
    return
  }
  if (ts.isConditionalExpression(u)) {
    collectReturnedObjectLiterals(u.whenTrue, out)
    collectReturnedObjectLiterals(u.whenFalse, out)
  }
}

const isEffectGenOrWrapperCallback = (fn: ts.Node): boolean => {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false
  let curr: ts.Node = fn
  while (curr.parent !== undefined && ts.isParenthesizedExpression(curr.parent)) curr = curr.parent
  const p = curr.parent
  if (p === undefined || !ts.isCallExpression(p)) return false
  const c = unwrapParens(p.expression)
  return (
    ts.isPropertyAccessExpression(c) &&
    ts.isIdentifier(c.expression) &&
    c.expression.text === "Effect" &&
    (c.name.text === "gen" || c.name.text === "sync" || c.name.text === "suspend")
  )
}

const collectOptionalPropsFromTypeMembers = (
  members: ts.NodeArray<ts.TypeElement>,
): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (const member of members) {
    if (ts.isPropertySignature(member)) {
      const pName = getPropKeyName(member.name)
      if (
        pName !== undefined &&
        (member.questionToken !== undefined || hasUndefinedUnionMember(member.type))
      ) {
        out.push(pName)
      }
    }
  }
  return out
}

/**
 * REQ-3.6: Scans `apps/**\/src/**\/*.ts` (non-test) for `*Runtime` / `*Context` interfaces
 * with optional properties (`?`), checking constructor sites across `apps/**\/src` and `apps/**\/test`
 * and flagging properties unconditionally populated in every live constructor (when >= 1 src constructor exists).
 */
export const checkAlwaysPopulatedOptionalRuntimeProps = (
  repoRoot: string,
  hostIo: SyncHostIo,
): ReadonlyArray<GcFinding> => {
  const appsDir = join(repoRoot, "apps")
  if (!hostIo.existsSync(appsDir)) return []
  const findings: Array<GcFinding> = []
  const appFiles = collectWorkspaceTsFiles(appsDir, hostIo, findings, repoRoot)
  const parsedFiles: Array<ParsedAppFile> = []
  const knownFiles = new Set<string>()

  for (const absPath of appFiles) {
    const relPath = relative(repoRoot, absPath).replace(/\\/g, "/")
    if (/\.d\.tsx?$/.test(relPath)) continue
    const isSrc = /^apps\/[^/]+\/src\/.*\.tsx?$/.test(relPath) && !/\/test\//.test(relPath)
    const isTest =
      /^apps\/[^/]+\/(?:test\/.*|src\/.*(?:\/test\/.*|\.(?:test|spec)\.tsx?))$/.test(relPath) ||
      /^apps\/[^/]+\/src\/.*\.(?:test|spec)\.tsx?$/.test(relPath)
    if (!isSrc && !isTest) continue
    const content = readTextOrReport(absPath, hostIo, repoRoot, findings)
    if (content === undefined) continue
    const sf = ts.createSourceFile(
      relPath,
      content,
      ts.ScriptTarget.Latest,
      true,
      relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    parsedFiles.push({ relPath, sf, isTest: !isSrc })
    knownFiles.add(relPath)
  }

  const runtimeInterfaces = new Map<string, RuntimeInterfaceInfo>()
  const optionalPropsByTypeKey = new Map<string, ReadonlySet<string>>()
  const fnParamTypes = new Map<string, ReadonlyArray<ReadonlyArray<string>>>()
  const reexportsByFile = new Map<
    string,
    Map<string, { readonly file: string; readonly name: string }>
  >()
  const importsByFile = new Map<
    string,
    Map<string, { readonly file: string; readonly name: string }>
  >()
  const nsImportsByFile = new Map<string, Map<string, string>>()

  for (const { relPath, sf } of parsedFiles) {
    const imports = new Map<string, { readonly file: string; readonly name: string }>()
    const nsImports = new Map<string, string>()
    const reexports = new Map<string, { readonly file: string; readonly name: string }>()
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const targetFile = resolveRelativeTsPath(relPath, stmt.moduleSpecifier.text, knownFiles)
        const nb = stmt.importClause?.namedBindings
        if (targetFile !== undefined && nb !== undefined) {
          if (ts.isNamespaceImport(nb)) nsImports.set(nb.name.text, targetFile)
          if (ts.isNamedImports(nb)) {
            for (const el of nb.elements) {
              imports.set(el.name.text, {
                file: targetFile,
                name: (el.propertyName ?? el.name).text,
              })
            }
          }
        }
      }
      if (
        ts.isExportDeclaration(stmt) &&
        stmt.moduleSpecifier !== undefined &&
        ts.isStringLiteral(stmt.moduleSpecifier) &&
        stmt.exportClause !== undefined &&
        ts.isNamedExports(stmt.exportClause)
      ) {
        const targetFile = resolveRelativeTsPath(relPath, stmt.moduleSpecifier.text, knownFiles)
        if (targetFile !== undefined) {
          for (const el of stmt.exportClause.elements) {
            reexports.set(el.name.text, {
              file: targetFile,
              name: (el.propertyName ?? el.name).text,
            })
          }
        }
      }
    }
    importsByFile.set(relPath, imports)
    nsImportsByFile.set(relPath, nsImports)
    reexportsByFile.set(relPath, reexports)
  }

  const resolveSymbolKey = (
    fromRelPath: string,
    ref: { readonly qualifier?: string | undefined; readonly name: string },
    availableKeys: ReadonlySet<string>,
  ): string | undefined => {
    const chaseReexport = (file: string, name: string, depth = 0): string | undefined => {
      if (depth > 4) return undefined
      const direct = `${file}#${name}`
      if (availableKeys.has(direct)) return direct
      const reexp = reexportsByFile.get(file)?.get(name)
      return reexp !== undefined ? chaseReexport(reexp.file, reexp.name, depth + 1) : undefined
    }
    if (ref.qualifier !== undefined) {
      const nsFile = nsImportsByFile.get(fromRelPath)?.get(ref.qualifier)
      if (nsFile !== undefined) return chaseReexport(nsFile, ref.name)
      return undefined
    }
    const localKey = `${fromRelPath}#${ref.name}`
    if (availableKeys.has(localKey)) return localKey
    const imp = importsByFile.get(fromRelPath)?.get(ref.name)
    if (imp !== undefined) return chaseReexport(imp.file, imp.name)
    return undefined
  }

  const allDeclaredTypeKeys = new Set<string>()
  const allDeclaredFnKeys = new Set<string>()
  const fnReturnsUndefinedKeys = new Set<string>()
  const libOptionalPropsByTypeName = new Map<string, Set<string>>()
  const libFnReturnsUndefined = new Set<string>()

  const libsDir = join(repoRoot, "libs")
  if (hostIo.existsSync(libsDir)) {
    const libFiles = collectWorkspaceTsFiles(libsDir, hostIo, findings, repoRoot)
    for (const absPath of libFiles) {
      const relPath = relative(repoRoot, absPath).replace(/\\/g, "/")
      if (
        /\.d\.tsx?$/.test(relPath) ||
        /\/test\//.test(relPath) ||
        /\.(?:test|spec)\.tsx?$/.test(relPath)
      ) {
        continue
      }
      if (!/^libs\/(?:[^/]+\/)?[^/]+\/src\/.*\.tsx?$/.test(relPath)) continue
      const content = readTextOrReport(absPath, hostIo, repoRoot, findings)
      if (content === undefined) continue
      const sf = ts.createSourceFile(
        relPath,
        content,
        ts.ScriptTarget.Latest,
        true,
        relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      )
      const collectLibTypes = (n: ts.Node): void => {
        if (ts.isInterfaceDeclaration(n)) {
          const props = collectOptionalPropsFromTypeMembers(n.members)
          if (props.length > 0) {
            const set = libOptionalPropsByTypeName.get(n.name.text) ?? new Set<string>()
            for (const p of props) set.add(p)
            libOptionalPropsByTypeName.set(n.name.text, set)
          }
        }
        if (ts.isTypeAliasDeclaration(n) && ts.isTypeLiteralNode(n.type)) {
          const props = collectOptionalPropsFromTypeMembers(n.type.members)
          if (props.length > 0) {
            const set = libOptionalPropsByTypeName.get(n.name.text) ?? new Set<string>()
            for (const p of props) set.add(p)
            libOptionalPropsByTypeName.set(n.name.text, set)
          }
        }
        if (
          ts.isFunctionDeclaration(n) &&
          n.name !== undefined &&
          hasUndefinedUnionMember(n.type)
        ) {
          libFnReturnsUndefined.add(n.name.text)
        }
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) {
          const fn = unwrapDeclaredFunction(n.initializer)
          if (fn !== undefined && hasUndefinedUnionMember(fn.type)) {
            libFnReturnsUndefined.add(n.name.text)
          }
        }
        ts.forEachChild(n, collectLibTypes)
      }
      collectLibTypes(sf)
    }
  }

  for (const { relPath, sf, isTest } of parsedFiles) {
    const collectTypeKeys = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node)) {
        const key = `${relPath}#${node.name.text}`
        allDeclaredTypeKeys.add(key)
        optionalPropsByTypeKey.set(key, new Set(collectOptionalPropsFromTypeMembers(node.members)))
        if (!isTest && RUNTIME_CONTEXT_INTERFACE_RE.test(node.name.text)) {
          const optionalProps: Array<{ readonly name: string; readonly line: number }> = []
          for (const member of node.members) {
            if (ts.isPropertySignature(member) && member.questionToken !== undefined) {
              const pName = getPropKeyName(member.name)
              if (pName !== undefined) {
                const line = sf.getLineAndCharacterOfPosition(member.getStart(sf)).line + 1
                optionalProps.push({ name: pName, line })
              }
            }
          }
          if (optionalProps.length > 0) {
            runtimeInterfaces.set(key, {
              key,
              name: node.name.text,
              relPath,
              optionalProps,
              allOptionalNames: new Set(optionalProps.map((p) => p.name)),
            })
          }
        }
      }
      if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
        const key = `${relPath}#${node.name.text}`
        allDeclaredTypeKeys.add(key)
        optionalPropsByTypeKey.set(
          key,
          new Set(collectOptionalPropsFromTypeMembers(node.type.members)),
        )
      }
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
        allDeclaredFnKeys.add(`${relPath}#${node.name.text}`)
        if (hasUndefinedUnionMember(node.type)) {
          fnReturnsUndefinedKeys.add(`${relPath}#${node.name.text}`)
        }
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        const declaredFn = unwrapDeclaredFunction(node.initializer)
        if (declaredFn !== undefined) {
          allDeclaredFnKeys.add(`${relPath}#${node.name.text}`)
          if (hasUndefinedUnionMember(declaredFn.type)) {
            fnReturnsUndefinedKeys.add(`${relPath}#${node.name.text}`)
          }
        }
      }
      ts.forEachChild(node, collectTypeKeys)
    }
    collectTypeKeys(sf)
  }

  if (runtimeInterfaces.size === 0) return findings

  const resolveInterfaceKeys = (
    fromRelPath: string,
    typeNode: ts.TypeNode | undefined,
  ): ReadonlyArray<string> => {
    const out: Array<string> = []
    for (const ref of extractTypeRefs(typeNode)) {
      const resolved = resolveSymbolKey(fromRelPath, ref, allDeclaredTypeKeys)
      if (resolved !== undefined && runtimeInterfaces.has(resolved)) {
        out.push(resolved)
      }
    }
    return out
  }

  for (const { relPath, sf } of parsedFiles) {
    const collectFnParams = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
        fnParamTypes.set(
          `${relPath}#${node.name.text}`,
          node.parameters.map((p) => resolveInterfaceKeys(relPath, p.type)),
        )
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        const fn = unwrapDeclaredFunction(node.initializer)
        if (fn !== undefined) {
          fnParamTypes.set(
            `${relPath}#${node.name.text}`,
            fn.parameters.map((p) => resolveInterfaceKeys(relPath, p.type)),
          )
        }
      }
      ts.forEachChild(node, collectFnParams)
    }
    collectFnParams(sf)
  }

  const constructorsByIface = new Map<
    string,
    Array<{
      readonly relPath: string
      readonly obj: ts.ObjectLiteralExpression
      readonly optionalNames: ReadonlySet<string>
      readonly isTestSite: boolean
    }>
  >()

  const recordConstructor = (
    ifaceKey: string,
    relPath: string,
    obj: ts.ObjectLiteralExpression,
    optionalNames: ReadonlySet<string>,
    isTestSite: boolean,
  ): void => {
    if (!runtimeInterfaces.has(ifaceKey)) return
    const list = constructorsByIface.get(ifaceKey) ?? []
    list.push({ relPath, obj, optionalNames, isTestSite })
    constructorsByIface.set(ifaceKey, list)
  }

  const makeUndefinedReturnChecker =
    (fromRelPath: string) =>
    (ref: { readonly qualifier?: string | undefined; readonly name: string }): boolean => {
      const resolved = resolveSymbolKey(fromRelPath, ref, fnReturnsUndefinedKeys)
      if (resolved !== undefined) return true
      if (ref.qualifier === undefined && !allDeclaredFnKeys.has(`${fromRelPath}#${ref.name}`)) {
        return libFnReturnsUndefined.has(ref.name)
      }
      return false
    }

  const addTypeOptionalProps = (
    fromRelPath: string,
    typeNode: ts.TypeNode | undefined,
    out: Set<string>,
  ): void => {
    if (typeNode === undefined) return
    if (ts.isTypeLiteralNode(typeNode)) {
      for (const p of collectOptionalPropsFromTypeMembers(typeNode.members)) out.add(p)
    }
    for (const ref of extractTypeRefs(typeNode)) {
      const resolved = resolveSymbolKey(fromRelPath, ref, allDeclaredTypeKeys)
      if (resolved !== undefined) {
        const props = optionalPropsByTypeKey.get(resolved)
        if (props !== undefined) {
          for (const p of props) out.add(p)
        }
      } else {
        const libProps = libOptionalPropsByTypeName.get(ref.name)
        if (libProps !== undefined) {
          for (const p of libProps) out.add(p)
        }
      }
    }
  }

  const computeEnclosingOptionalNames = (
    anchorNode: ts.Node,
    relPath: string,
  ): ReadonlySet<string> => {
    const optionalNames = new Set<string>()
    const containers: Array<ts.Node> = []
    for (let curr: ts.Node | undefined = anchorNode; curr !== undefined; curr = curr.parent) {
      if (ts.isFunctionLike(curr) || ts.isSourceFile(curr)) {
        containers.push(curr)
      }
    }
    for (let idx = containers.length - 1; idx >= 0; idx--) {
      const container = containers[idx]!
      if (ts.isFunctionLike(container)) {
        for (const p of container.parameters) {
          if (ts.isIdentifier(p.name)) {
            if (p.questionToken !== undefined || hasUndefinedUnionMember(p.type)) {
              optionalNames.add(p.name.text)
            }
            addTypeOptionalProps(relPath, p.type, optionalNames)
          }
          if (ts.isObjectBindingPattern(p.name)) {
            const paramTypeProps = new Set<string>()
            addTypeOptionalProps(relPath, p.type, paramTypeProps)
            for (const el of p.name.elements) {
              const propKey =
                el.propertyName !== undefined ? getPropKeyName(el.propertyName) : undefined
              if (ts.isIdentifier(el.name)) {
                const key = propKey ?? el.name.text
                if (el.initializer === undefined && paramTypeProps.has(key)) {
                  optionalNames.add(el.name.text)
                }
              }
            }
          }
        }
      }
      const scanScopeDecls = (n: ts.Node): void => {
        if (n !== container && ts.isFunctionLike(n)) return
        if (ts.isVariableDeclaration(n)) {
          if (ts.isIdentifier(n.name)) {
            if (hasUndefinedUnionMember(n.type)) {
              optionalNames.add(n.name.text)
            }
            addTypeOptionalProps(relPath, n.type, optionalNames)
            if (
              n.initializer !== undefined &&
              isOptionalPassThroughExpr(
                n.initializer,
                optionalNames,
                makeUndefinedReturnChecker(relPath),
              )
            ) {
              optionalNames.add(n.name.text)
            }
          }
          if (ts.isObjectBindingPattern(n.name)) {
            const typeProps = new Set<string>()
            addTypeOptionalProps(relPath, n.type, typeProps)
            const initOpt =
              n.initializer !== undefined &&
              isOptionalPassThroughExpr(
                n.initializer,
                optionalNames,
                makeUndefinedReturnChecker(relPath),
              )
            for (const el of n.name.elements) {
              if (!ts.isIdentifier(el.name) || el.initializer !== undefined) continue
              const key =
                (el.propertyName !== undefined ? getPropKeyName(el.propertyName) : undefined) ??
                el.name.text
              if (initOpt || typeProps.has(key) || optionalNames.has(key)) {
                optionalNames.add(el.name.text)
              }
            }
          }
        }
        ts.forEachChild(n, scanScopeDecls)
      }
      scanScopeDecls(container)
    }
    return optionalNames
  }

  for (const { relPath, sf, isTest } of parsedFiles) {
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
        const u = unwrapParens(node.initializer)
        if (ts.isObjectLiteralExpression(u)) {
          const keys = resolveInterfaceKeys(relPath, node.type)
          if (keys.length > 0) {
            const optNames = computeEnclosingOptionalNames(node, relPath)
            for (const k of keys) recordConstructor(k, relPath, u, optNames, isTest)
          }
        }
      }
      if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
        const u = unwrapParens(node.expression)
        if (ts.isObjectLiteralExpression(u)) {
          const keys = resolveInterfaceKeys(relPath, node.type)
          if (keys.length > 0) {
            const optNames = computeEnclosingOptionalNames(node, relPath)
            for (const k of keys) recordConstructor(k, relPath, u, optNames, isTest)
          }
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = unwrapParens(node.expression)
        const ref = ts.isIdentifier(callee)
          ? { name: callee.text }
          : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
            ? { qualifier: callee.expression.text, name: callee.name.text }
            : undefined
        const fnKey =
          ref !== undefined ? resolveSymbolKey(relPath, ref, allDeclaredFnKeys) : undefined
        const paramTypes = fnKey !== undefined ? fnParamTypes.get(fnKey) : undefined
        if (paramTypes !== undefined) {
          for (let i = 0; i < node.arguments.length; i++) {
            const arg = unwrapParens(node.arguments[i]!)
            const argTypes = paramTypes[i]
            if (
              ts.isObjectLiteralExpression(arg) &&
              argTypes !== undefined &&
              argTypes.length > 0
            ) {
              const optNames = computeEnclosingOptionalNames(node, relPath)
              for (const k of argTypes) recordConstructor(k, relPath, arg, optNames, isTest)
            }
          }
        }
      }
      if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
        const u = unwrapParens(node.body)
        if (ts.isObjectLiteralExpression(u)) {
          const keys = resolveInterfaceKeys(relPath, node.type)
          if (keys.length > 0) {
            const optNames = computeEnclosingOptionalNames(node, relPath)
            for (const k of keys) recordConstructor(k, relPath, u, optNames, isTest)
          }
        }
      }
      if (ts.isReturnStatement(node) && node.expression !== undefined) {
        const returnedObjs: Array<ts.ObjectLiteralExpression> = []
        collectReturnedObjectLiterals(node.expression, returnedObjs)
        if (returnedObjs.length > 0) {
          let curr: ts.Node | undefined = node.parent
          const collectedKeys = new Set<string>()
          while (curr !== undefined) {
            if (ts.isFunctionLike(curr)) {
              for (const k of resolveInterfaceKeys(relPath, curr.type)) collectedKeys.add(k)
              if (curr.type === undefined && isEffectGenOrWrapperCallback(curr)) {
                curr = curr.parent
                continue
              }
              break
            }
            curr = curr.parent
          }
          if (collectedKeys.size > 0) {
            const optNames = computeEnclosingOptionalNames(node, relPath)
            for (const u of returnedObjs) {
              for (const k of collectedKeys) recordConstructor(k, relPath, u, optNames, isTest)
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }

  for (const [ifaceKey, info] of runtimeInterfaces) {
    const ctors = constructorsByIface.get(ifaceKey)
    if (ctors === undefined || !ctors.some((c) => !c.isTestSite)) continue
    for (const prop of info.optionalProps) {
      const alwaysPopulated = ctors.every(({ relPath: ctorRelPath, obj, optionalNames }) => {
        let lastSpreadIdx = -1
        let lastMatchingAssignIdx = -1
        let lastMatchingPopulated = false
        for (let idx = 0; idx < obj.properties.length; idx++) {
          const p = obj.properties[idx]!
          if (ts.isSpreadAssignment(p)) {
            lastSpreadIdx = idx
            continue
          }
          if (ts.isShorthandPropertyAssignment(p) && p.name.text === prop.name) {
            lastMatchingAssignIdx = idx
            lastMatchingPopulated = !optionalNames.has(p.name.text)
            continue
          }
          if (ts.isPropertyAssignment(p) && getPropKeyName(p.name) === prop.name) {
            lastMatchingAssignIdx = idx
            lastMatchingPopulated = !isOptionalPassThroughExpr(
              p.initializer,
              optionalNames,
              makeUndefinedReturnChecker(ctorRelPath),
            )
          }
        }
        return lastMatchingPopulated && lastMatchingAssignIdx > lastSpreadIdx
      })
      if (alwaysPopulated) {
        findings.push({
          kind: "always-populated-optional-runtime-prop",
          nodeId: `${info.relPath}:${info.name}.${prop.name}`,
          location: `${info.relPath}:${prop.line}`,
          message: `Optional property '${prop.name}?' on '${info.name}' is unconditionally populated by all ${ctors.length} constructor(s) in apps/**.`,
          action: `Make '${prop.name}' required on '${info.name}' (remove '?') or omit it when absent in at least one constructor.`,
        })
      }
    }
  }

  return findings
}
