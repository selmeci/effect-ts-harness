import * as path from "node:path"
import { Effect, Schema } from "effect"

export const SynthesizedRuleId = Schema.NonEmptyString.pipe(Schema.brand("SynthesizedRuleId"))
export type SynthesizedRuleId = typeof SynthesizedRuleId.Type

export const PatternVariableName = Schema.NonEmptyString.pipe(Schema.brand("PatternVariableName"))
export type PatternVariableName = typeof PatternVariableName.Type

export const RuleGraphToken = Schema.NonEmptyString.pipe(Schema.brand("RuleGraphToken"))
export type RuleGraphToken = typeof RuleGraphToken.Type

export const RuleTargetPath = Schema.NonEmptyString.pipe(Schema.brand("RuleTargetPath"))
export type RuleTargetPath = typeof RuleTargetPath.Type

export const RuleQualityScoreMillis = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
  Schema.brand("RuleQualityScoreMillis"),
)
export type RuleQualityScoreMillis = typeof RuleQualityScoreMillis.Type

export const RuleSynthesisTaskId = Schema.NonEmptyString.pipe(Schema.brand("RuleSynthesisTaskId"))
export type RuleSynthesisTaskId = typeof RuleSynthesisTaskId.Type

export const RuleSynthesisText = Schema.NonEmptyString.pipe(Schema.brand("RuleSynthesisText"))
export type RuleSynthesisText = typeof RuleSynthesisText.Type

export const RuleSynthesisFlag = Schema.Boolean.pipe(Schema.brand("RuleSynthesisFlag"))
export type RuleSynthesisFlag = typeof RuleSynthesisFlag.Type

export const CASCADE_STAGE_NAMES = [
  "Stage1_PushoutWellFormedness",
  "Stage2_PositiveReplay",
  "Stage3_ZeroFalsePositive",
  "Stage4_ImmutableTcbAndQuality",
] as const

export const CascadeStageName = Schema.Literals(CASCADE_STAGE_NAMES).pipe(
  Schema.brand("CascadeStageName"),
)
export type CascadeStageName = typeof CascadeStageName.Type

export const RuleSynthesisFailureStage = Schema.Literals([
  "LggExtraction",
  ...CASCADE_STAGE_NAMES,
]).pipe(Schema.brand("RuleSynthesisFailureStage"))
export type RuleSynthesisFailureStage = typeof RuleSynthesisFailureStage.Type

export const IMMUTABLE_TCB_PATHS: ReadonlyArray<string> = [
  "libs/harness/gates/src/policy.ts",
  "libs/harness/gates/src/verify-stamp.ts",
  "libs/harness/gates/src/ast-cache.ts",
  "libs/harness/gates/src/plugins/ast-gate-visitors.ts",
  "libs/harness/gates/src/mutation-check.ts",
  "libs/harness/gates/src/mutation/mutant-ast-generator.ts",
  "libs/harness/gates/src/rule-synthesizer.ts",
  "apps/harness-cli/src/index.ts",
]

export const isImmutableTcbPath = (targetPath: string): boolean => {
  const forwardSlashes = targetPath.replace(/\\/g, "/").trim()
  const normalized = path.posix.normalize(forwardSlashes).replace(/^\.\//, "")
  return IMMUTABLE_TCB_PATHS.some((tcb) => {
    const canonicalTcb = path.posix.normalize(tcb)
    return normalized === canonicalTcb || normalized.endsWith(`/${canonicalTcb}`)
  })
}

export const LggNodeMapping = Schema.Struct({
  badNodeKey: RuleGraphToken,
  goodNodeKey: RuleGraphToken,
  patternVar: PatternVariableName,
})
export type LggNodeMapping = typeof LggNodeMapping.Type

export const SynthesizedDpoRuleSpec = Schema.Struct({
  ruleId: SynthesizedRuleId,
  name: RuleSynthesisText,
  description: RuleSynthesisText,
  patternVariables: Schema.Array(PatternVariableName),
  lhsNodes: Schema.Array(RuleGraphToken),
  lhsHyperedges: Schema.Array(RuleGraphToken),
  interfaceNodes: Schema.Array(RuleGraphToken),
  rhsNodes: Schema.Array(RuleGraphToken),
  rhsHyperedges: Schema.Array(RuleGraphToken),
  nacForbiddenHyperedges: Schema.Array(RuleGraphToken),
  targetGateFiles: Schema.Array(RuleTargetPath),
  qualityScoreMillis: Schema.optional(RuleQualityScoreMillis),
})
export type SynthesizedDpoRuleSpec = typeof SynthesizedDpoRuleSpec.Type

export const CascadeCorpusSnapshot = Schema.Struct({
  snapshotId: RuleSynthesisTaskId,
  isHealthy: RuleSynthesisFlag,
  nodeKeys: Schema.Array(RuleGraphToken),
  hyperedgeSignatures: Schema.Array(RuleGraphToken),
})
export type CascadeCorpusSnapshot = typeof CascadeCorpusSnapshot.Type

export const RuleSynthesizerInput = Schema.Struct({
  taskId: RuleSynthesisTaskId,
  badGraphNodes: Schema.Array(RuleGraphToken),
  badGraphHyperedges: Schema.Array(RuleGraphToken),
  goodGraphNodes: Schema.Array(RuleGraphToken),
  goodGraphHyperedges: Schema.Array(RuleGraphToken),
  healthyCorpusSnapshots: Schema.Array(CascadeCorpusSnapshot),
  targetFiles: Schema.Array(RuleTargetPath),
  qualityPriorMillis: Schema.optional(RuleQualityScoreMillis),
  minQualityMillis: Schema.optional(RuleQualityScoreMillis),
})
export type RuleSynthesizerInput = typeof RuleSynthesizerInput.Type

export const CascadeStageResult = Schema.Struct({
  stage: CascadeStageName,
  passed: RuleSynthesisFlag,
  detail: RuleSynthesisText,
})
export type CascadeStageResult = typeof CascadeStageResult.Type

export const RuleSynthesisReport = Schema.Struct({
  rule: SynthesizedDpoRuleSpec,
  nodeMappings: Schema.Array(LggNodeMapping),
  cascadeResults: Schema.Array(CascadeStageResult),
  promoted: RuleSynthesisFlag,
})
export type RuleSynthesisReport = typeof RuleSynthesisReport.Type

export class RuleSynthesisError extends Schema.TaggedError<RuleSynthesisError>()(
  "RuleSynthesisError",
  {
    stage: RuleSynthesisFailureStage,
    reason: RuleSynthesisText,
    offendingPaths: Schema.optional(Schema.Array(RuleTargetPath)),
  },
) {}

const SCOPE_PATH_REGEX = /\b(libs|apps)\/([a-z0-9_-]+)\//g

export const extractScopePrefix = (token: string): string | undefined => {
  const match = /\b(?:libs|apps)\/([a-z0-9_-]+)\//.exec(token)
  return match?.[1]
}

export const variabilizeGraphTokenWithMap = (
  raw: string,
  scopeVarMap: Map<string, string>,
): {
  readonly variabilized: RuleGraphToken
  readonly usedScopeVar: boolean
  readonly scopeVars: ReadonlyArray<PatternVariableName>
} => {
  let usedScopeVar = false
  const vars: Array<PatternVariableName> = []
  const replaced = raw.replace(SCOPE_PATH_REGEX, (_match, rootDir: string, scopeName: string) => {
    usedScopeVar = true
    let varName = scopeVarMap.get(scopeName)
    if (varName === undefined) {
      varName = scopeVarMap.size === 0 ? "?Scope" : `?Scope${scopeVarMap.size + 1}`
      scopeVarMap.set(scopeName, varName)
    }
    vars.push(PatternVariableName.make(varName))
    return `${rootDir}/${varName}/`
  })
  return {
    variabilized: RuleGraphToken.make(replaced),
    usedScopeVar,
    scopeVars: vars,
  }
}

export const variabilizeGraphToken = (
  raw: string,
): {
  readonly variabilized: RuleGraphToken
  readonly usedScopeVar: boolean
} => variabilizeGraphTokenWithMap(raw, new Map<string, string>())

export interface ComputedLggRule {
  readonly patternVariables: ReadonlyArray<PatternVariableName>
  readonly lhsNodes: ReadonlyArray<RuleGraphToken>
  readonly lhsHyperedges: ReadonlyArray<RuleGraphToken>
  readonly interfaceNodes: ReadonlyArray<RuleGraphToken>
  readonly rhsNodes: ReadonlyArray<RuleGraphToken>
  readonly rhsHyperedges: ReadonlyArray<RuleGraphToken>
  readonly nacForbiddenHyperedges: ReadonlyArray<RuleGraphToken>
  readonly nodeMappings: ReadonlyArray<LggNodeMapping>
  readonly scopeVarMap: ReadonlyMap<string, string>
}

export const computeLggRule = (
  badGraphNodes: ReadonlyArray<RuleGraphToken>,
  badGraphHyperedges: ReadonlyArray<RuleGraphToken>,
  goodGraphNodes: ReadonlyArray<RuleGraphToken>,
  goodGraphHyperedges: ReadonlyArray<RuleGraphToken>,
): ComputedLggRule => {
  const scopeVarMap = new Map<string, string>()
  const patternVariables = new Set<PatternVariableName>()
  const nodeMappings: Array<LggNodeMapping> = []

  const goodNodeSet = new Set<string>(goodGraphNodes)
  const badEdgeSet = new Set<string>(badGraphHyperedges)
  const goodEdgeSet = new Set<string>(goodGraphHyperedges)

  const removedEdges = badGraphHyperedges.filter((e) => !goodEdgeSet.has(e))
  const addedEdges = goodGraphHyperedges.filter((e) => !badEdgeSet.has(e))
  const preservedRawNodes = badGraphNodes.filter((n) => goodNodeSet.has(n))

  const lhsNodes = Array.from(
    new Set(
      badGraphNodes.map((n) => {
        const v = variabilizeGraphTokenWithMap(n, scopeVarMap)
        for (const sv of v.scopeVars) patternVariables.add(sv)
        return v.variabilized
      }),
    ),
  )

  const rhsNodes = Array.from(
    new Set(
      goodGraphNodes.map((n) => {
        const v = variabilizeGraphTokenWithMap(n, scopeVarMap)
        for (const sv of v.scopeVars) patternVariables.add(sv)
        return v.variabilized
      }),
    ),
  )

  const interfaceNodes = Array.from(
    new Set(
      preservedRawNodes.map((n) => {
        const v = variabilizeGraphTokenWithMap(n, scopeVarMap)
        for (const sv of v.scopeVars) patternVariables.add(sv)
        nodeMappings.push({
          badNodeKey: n,
          goodNodeKey: n,
          patternVar: PatternVariableName.make(
            v.usedScopeVar && v.scopeVars[0] !== undefined ? v.scopeVars[0] : "?Node",
          ),
        })
        if (!v.usedScopeVar) {
          patternVariables.add(PatternVariableName.make("?Node"))
        }
        return v.variabilized
      }),
    ),
  )

  const lhsHyperedges = Array.from(
    new Set(
      (removedEdges.length > 0 ? removedEdges : badGraphHyperedges).map((e) => {
        const v = variabilizeGraphTokenWithMap(e, scopeVarMap)
        for (const sv of v.scopeVars) patternVariables.add(sv)
        return v.variabilized
      }),
    ),
  )

  const rhsHyperedges = Array.from(
    new Set(
      (addedEdges.length > 0 ? addedEdges : goodGraphHyperedges).map((e) => {
        const v = variabilizeGraphTokenWithMap(e, scopeVarMap)
        for (const sv of v.scopeVars) patternVariables.add(sv)
        return v.variabilized
      }),
    ),
  )

  const nacForbiddenHyperedges = Array.from(
    new Set(
      addedEdges.map((e) => {
        const v = variabilizeGraphTokenWithMap(e, scopeVarMap)
        for (const sv of v.scopeVars) patternVariables.add(sv)
        return v.variabilized
      }),
    ),
  )

  if (patternVariables.size === 0) {
    patternVariables.add(PatternVariableName.make("?Scope"))
  }

  return {
    patternVariables: Array.from(patternVariables),
    lhsNodes,
    lhsHyperedges,
    interfaceNodes,
    rhsNodes,
    rhsHyperedges,
    nacForbiddenHyperedges,
    nodeMappings,
    scopeVarMap,
  }
}

export const patternToRegex = (patternToken: string): RegExp => {
  const escaped = patternToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const seenGroups = new Set<string>()
  const withVars = escaped.replace(/\\\?Scope(\d*)/g, (_match, digits: string) => {
    const groupName = digits === "" ? "Scope" : `Scope${digits}`
    if (!seenGroups.has(groupName)) {
      seenGroups.add(groupName)
      return `(?<${groupName}>[a-z0-9_-]+)`
    }
    return `\\k<${groupName}>`
  })
  return new RegExp(`^${withVars}$`)
}

export const subgraphMatchesWithScopeVar = (
  lhsPatterns: ReadonlyArray<RuleGraphToken>,
  nacPatterns: ReadonlyArray<RuleGraphToken>,
  hyperedges: ReadonlyArray<RuleGraphToken>,
): boolean => {
  if (lhsPatterns.length === 0) {
    return false
  }

  const varNames = Array.from(
    new Set(
      [...lhsPatterns, ...nacPatterns].flatMap((p) =>
        Array.from(p.matchAll(/\?Scope\d*/g), (m) => m[0]),
      ),
    ),
  )

  const candidateScopes = new Set<string>(["*"])
  for (const edge of hyperedges) {
    const m = /\b(?:libs|apps)\/([a-z0-9_-]+)\//.exec(edge)
    if (m?.[1] !== undefined) {
      candidateScopes.add(m[1])
    }
  }

  const scopes = Array.from(candidateScopes)
  const assignments: Array<Map<string, string>> = []
  if (varNames.length === 0) {
    assignments.push(new Map())
  } else {
    const generate = (index: number, current: Map<string, string>) => {
      if (index === varNames.length) {
        assignments.push(new Map(current))
        return
      }
      const v = varNames[index]!
      for (const s of scopes) {
        current.set(v, s)
        generate(index + 1, current)
        current.delete(v)
      }
    }
    generate(0, new Map())
  }

  for (const assignment of assignments) {
    const instantiate = (p: string): string => {
      let res = p
      for (const [varName, scopeVal] of assignment.entries()) {
        if (scopeVal !== "*") {
          res = res.replaceAll(varName, scopeVal)
        }
      }
      return res
    }

    const allLhsPresent = lhsPatterns.every((lhs) => {
      const inst = instantiate(lhs)
      const re = patternToRegex(inst)
      return hyperedges.some((e) => e === inst || re.test(e))
    })
    if (!allLhsPresent) {
      continue
    }

    const anyNacPresent = nacPatterns.some((nac) => {
      const inst = instantiate(nac)
      const re = patternToRegex(inst)
      return hyperedges.some((e) => e === inst || re.test(e))
    })

    if (!anyNacPresent) {
      return true
    }
  }
  return false
}

export const doesPatternSetMatchSnapshot = subgraphMatchesWithScopeVar

export interface PositiveReplayEvaluation {
  readonly passed: boolean
  readonly detail: string
}

export const evaluatePositiveReplay = (
  lhsPatterns: ReadonlyArray<RuleGraphToken>,
  nacPatterns: ReadonlyArray<RuleGraphToken>,
  rhsNodes: ReadonlyArray<RuleGraphToken>,
  rhsHyperedges: ReadonlyArray<RuleGraphToken>,
  badNodes: ReadonlyArray<RuleGraphToken>,
  badHyperedges: ReadonlyArray<RuleGraphToken>,
  goodNodes: ReadonlyArray<RuleGraphToken>,
  goodHyperedges: ReadonlyArray<RuleGraphToken>,
  scopeVarMap: ReadonlyMap<string, string>,
): PositiveReplayEvaluation => {
  // 1. L matches G_bad and NAC does not already match G_bad
  const triggersOnBad = subgraphMatchesWithScopeVar(lhsPatterns, nacPatterns, badHyperedges)
  if (!triggersOnBad) {
    return {
      passed: false,
      detail: "LHS does not match G_bad or NAC already matches G_bad",
    }
  }

  // 2. Build mapping of ?Scope -> concrete scope
  const varToScope = new Map<string, string>()
  for (const [concreteScope, varName] of scopeVarMap.entries()) {
    varToScope.set(varName, concreteScope)
  }

  const instantiate = (token: string): string => {
    let res = token
    for (const [varName, concreteScope] of varToScope.entries()) {
      res = res.replaceAll(varName, concreteScope)
    }
    return res
  }

  // DPO rewrite: (G_bad \ (L \ K)) ∪ (R \ K)
  const badEdgeSet = new Set<string>(badHyperedges)
  const goodEdgeSet = new Set<string>(goodHyperedges)
  const concreteLhsEdges = new Set(lhsPatterns.map(instantiate))
  const concreteRhsEdges = new Set(rhsHyperedges.map(instantiate))
  const removedEdges = new Set(
    [...concreteLhsEdges].filter((e) => !concreteRhsEdges.has(e) && !goodEdgeSet.has(e)),
  )
  const addedEdges = [...concreteRhsEdges].filter((e) => !badEdgeSet.has(e))

  const rewrittenEdges = new Set<string>(badHyperedges.filter((e) => !removedEdges.has(e)))
  for (const added of addedEdges) {
    rewrittenEdges.add(added)
  }

  const badNodeSet = new Set<string>(badNodes)
  const goodNodeSet = new Set<string>(goodNodes)
  const concreteRhsNodes = new Set(rhsNodes.map(instantiate))
  const removedNodes = new Set(badNodes.filter((n) => !concreteRhsNodes.has(n) && !goodNodeSet.has(n)))
  const addedNodes = [...concreteRhsNodes].filter((n) => !badNodeSet.has(n))

  const rewrittenNodes = new Set<string>(badNodes.filter((n) => !removedNodes.has(n)))
  for (const added of addedNodes) {
    rewrittenNodes.add(added)
  }

  // Verify all required RHS nodes and hyperedges are present in G_rewritten and in G_good
  for (const rhsNode of rhsNodes) {
    const concrete = instantiate(rhsNode)
    if (!rewrittenNodes.has(concrete) || !goodNodeSet.has(concrete)) {
      return {
        passed: false,
        detail: `RHS node '${concrete}' missing in G_rewritten or G_good`,
      }
    }
  }

  for (const rhsEdge of rhsHyperedges) {
    const concrete = instantiate(rhsEdge)
    if (!rewrittenEdges.has(concrete) || !goodEdgeSet.has(concrete)) {
      return {
        passed: false,
        detail: `RHS hyperedge '${concrete}' missing in G_rewritten or G_good`,
      }
    }
  }

  // Verify G_rewritten covers all hyperedges of G_good
  for (const goodEdge of goodHyperedges) {
    if (!rewrittenEdges.has(goodEdge)) {
      return {
        passed: false,
        detail: `Target hyperedge '${goodEdge}' in G_good was not produced by DPO rewrite`,
      }
    }
  }

  // (L, NAC) must no longer trigger on G_rewritten
  const triggersOnRewritten = subgraphMatchesWithScopeVar(
    lhsPatterns,
    nacPatterns,
    Array.from(rewrittenEdges).map((e) => RuleGraphToken.make(e)),
  )
  if (triggersOnRewritten) {
    return {
      passed: false,
      detail: "(L, NAC) still triggers on G_rewritten after positive rewrite",
    }
  }

  return {
    passed: true,
    detail: "Verified positive DPO replay on G_bad -> G_good with idempotent NAC termination.",
  }
}

export const evaluateZeroFalsePositive = (
  lhsPatterns: ReadonlyArray<RuleGraphToken>,
  nacPatterns: ReadonlyArray<RuleGraphToken>,
  snapshots: ReadonlyArray<CascadeCorpusSnapshot>,
): {
  readonly passed: boolean
  readonly falsePositiveSnapshots: ReadonlyArray<string>
} => {
  const healthy = snapshots.filter((s) => s.isHealthy)
  if (healthy.length === 0) {
    return {
      passed: false,
      falsePositiveSnapshots: ["<empty-healthy-corpus>"],
    }
  }

  const falsePositives: Array<string> = []
  for (const snapshot of healthy) {
    const matches = subgraphMatchesWithScopeVar(
      lhsPatterns,
      nacPatterns,
      snapshot.hyperedgeSignatures,
    )
    if (matches) {
      falsePositives.push(snapshot.snapshotId)
    }
  }

  return {
    passed: falsePositives.length === 0,
    falsePositiveSnapshots: falsePositives,
  }
}

export const decideRuleSynthesizer = Effect.fn("RuleSynthesizer.decide")(function* (
  input: RuleSynthesizerInput,
): Effect.fn.Return<RuleSynthesisReport, RuleSynthesisError, never> {
  // Hard Invariant: Immutable Trusted Computing Base (TCB) Protection
  const offendingTcbPaths = input.targetFiles.filter((p) => isImmutableTcbPath(p))
  if (offendingTcbPaths.length > 0) {
    return yield* new RuleSynthesisError({
      stage: RuleSynthesisFailureStage.make("Stage4_ImmutableTcbAndQuality"),
      reason: RuleSynthesisText.make(
        `Synthesized rule targets Immutable Trusted Computing Base (TCB) file(s): ${offendingTcbPaths.join(", ")}.`,
      ),
      offendingPaths: offendingTcbPaths,
    })
  }

  const badEdgeSet = new Set<string>(input.badGraphHyperedges)
  const goodEdgeSet = new Set<string>(input.goodGraphHyperedges)

  const removedEdges = input.badGraphHyperedges.filter((e) => !goodEdgeSet.has(e))
  const addedEdges = input.goodGraphHyperedges.filter((e) => !badEdgeSet.has(e))

  if (removedEdges.length === 0 && addedEdges.length === 0) {
    return yield* new RuleSynthesisError({
      stage: RuleSynthesisFailureStage.make("LggExtraction"),
      reason: RuleSynthesisText.make(
        `Cannot synthesize DPO rule for task '${input.taskId}': G_bad and G_good have identical hyperedge sets.`,
      ),
    })
  }

  // Stage 1: LGG Anti-Unification & DPO Pushout Well-Formedness
  const goodNodeSet = new Set<string>(input.goodGraphNodes)
  const preservedRawNodes = input.badGraphNodes.filter((n) => goodNodeSet.has(n))

  if (preservedRawNodes.length === 0) {
    return yield* new RuleSynthesisError({
      stage: RuleSynthesisFailureStage.make("Stage1_PushoutWellFormedness"),
      reason: RuleSynthesisText.make(
        `DPO pushout well-formedness failed for '${input.taskId}': interface graph K (V_bad ∩ V_good) is empty, violating the dangling-edge condition.`,
      ),
    })
  }

  const lgg = computeLggRule(
    input.badGraphNodes,
    input.badGraphHyperedges,
    input.goodGraphNodes,
    input.goodGraphHyperedges,
  )

  const lhsNodeSet = new Set<string>(lgg.lhsNodes)
  const rhsNodeSet = new Set<string>(lgg.rhsNodes)
  const interfacePreservedInBoth = lgg.interfaceNodes.every(
    (k) => lhsNodeSet.has(k) && rhsNodeSet.has(k),
  )
  if (!interfacePreservedInBoth) {
    return yield* new RuleSynthesisError({
      stage: RuleSynthesisFailureStage.make("Stage1_PushoutWellFormedness"),
      reason: RuleSynthesisText.make(
        `Interface K must be a subgraph of both L and R in DPO rule for '${input.taskId}'.`,
      ),
    })
  }

  const cascadeResults: Array<CascadeStageResult> = [
    {
      stage: CascadeStageName.make("Stage1_PushoutWellFormedness"),
      passed: RuleSynthesisFlag.make(true),
      detail: RuleSynthesisText.make(
        `Verified DPO interface K (${lgg.interfaceNodes.length} node(s)) and variabilized LGG bindings (${lgg.patternVariables.join(", ")}).`,
      ),
    },
  ]

  // Stage 2: Positive Replay on G_bad -> G_good
  const replayResult = evaluatePositiveReplay(
    lgg.lhsHyperedges,
    lgg.nacForbiddenHyperedges,
    lgg.rhsNodes,
    lgg.rhsHyperedges,
    input.badGraphNodes,
    input.badGraphHyperedges,
    input.goodGraphNodes,
    input.goodGraphHyperedges,
    lgg.scopeVarMap,
  )

  if (!replayResult.passed) {
    return yield* new RuleSynthesisError({
      stage: RuleSynthesisFailureStage.make("Stage2_PositiveReplay"),
      reason: RuleSynthesisText.make(
        `Positive replay failed for '${input.taskId}': ${replayResult.detail}.`,
      ),
    })
  }

  cascadeResults.push({
    stage: CascadeStageName.make("Stage2_PositiveReplay"),
    passed: RuleSynthesisFlag.make(true),
    detail: RuleSynthesisText.make(replayResult.detail),
  })

  // Stage 3: Zero False Positives across healthy corpus snapshots
  const zeroFpResult = evaluateZeroFalsePositive(
    lgg.lhsHyperedges,
    lgg.nacForbiddenHyperedges,
    input.healthyCorpusSnapshots,
  )

  if (!zeroFpResult.passed) {
    const firstFp = zeroFpResult.falsePositiveSnapshots[0]!
    const reasonText =
      firstFp === "<empty-healthy-corpus>"
        ? `Synthesized DPO rule failed zero false positive validation: healthy corpus is empty.`
        : `Synthesized DPO rule triggered a false positive on healthy corpus snapshot '${firstFp}'.`
    return yield* new RuleSynthesisError({
      stage: RuleSynthesisFailureStage.make("Stage3_ZeroFalsePositive"),
      reason: RuleSynthesisText.make(reasonText),
    })
  }

  cascadeResults.push({
    stage: CascadeStageName.make("Stage3_ZeroFalsePositive"),
    passed: RuleSynthesisFlag.make(true),
    detail: RuleSynthesisText.make(
      `Verified 0 false positives across ${input.healthyCorpusSnapshots.filter((s) => s.isHealthy).length} healthy corpus snapshot(s).`,
    ),
  })

  // Stage 4: Immutable TCB Protection & System One Quality Prior
  const minQuality = input.minQualityMillis ?? 500
  const qualityMillis = input.qualityPriorMillis ?? 500

  if (qualityMillis < minQuality) {
    return yield* new RuleSynthesisError({
      stage: RuleSynthesisFailureStage.make("Stage4_ImmutableTcbAndQuality"),
      reason: RuleSynthesisText.make(
        `SynthesizedRuleQualityV1 prior ${qualityMillis} millis is below promotion threshold ${minQuality} millis.`,
      ),
    })
  }

  cascadeResults.push({
    stage: CascadeStageName.make("Stage4_ImmutableTcbAndQuality"),
    passed: RuleSynthesisFlag.make(true),
    detail: RuleSynthesisText.make(
      `Verified Immutable TCB boundary and quality threshold (score=${qualityMillis} millis, min=${minQuality} millis).`,
    ),
  })

  const sanitizedId = input.taskId.replace(/[^a-zA-Z0-9_-]/g, "-")
  const rule: SynthesizedDpoRuleSpec = {
    ruleId: SynthesizedRuleId.make(`SYNTH-${sanitizedId}`),
    name: RuleSynthesisText.make(`LGG DPO Rule for ${input.taskId}`),
    description: RuleSynthesisText.make(
      `Synthesized via First-Order Graph Anti-Unification (LGG) from G_bad -> G_good for task ${input.taskId}.`,
    ),
    patternVariables: [...lgg.patternVariables],
    lhsNodes: lgg.lhsNodes,
    lhsHyperedges: lgg.lhsHyperedges,
    interfaceNodes: lgg.interfaceNodes,
    rhsNodes: lgg.rhsNodes,
    rhsHyperedges: lgg.rhsHyperedges,
    nacForbiddenHyperedges: lgg.nacForbiddenHyperedges,
    targetGateFiles: [...input.targetFiles],
    ...(input.qualityPriorMillis !== undefined
      ? { qualityScoreMillis: input.qualityPriorMillis }
      : {}),
  }

  return {
    rule,
    nodeMappings: [...lgg.nodeMappings],
    cascadeResults,
    promoted: RuleSynthesisFlag.make(true),
  }
})

export const RuleSynthesizer = {
  decide: decideRuleSynthesizer,
  isImmutableTcbPath,
  extractScopePrefix,
  variabilizeGraphTokenWithMap,
  variabilizeGraphToken,
  computeLggRule,
  patternToRegex,
  subgraphMatchesWithScopeVar,
  doesPatternSetMatchSnapshot,
  evaluatePositiveReplay,
  evaluateZeroFalsePositive,
} as const

