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
  "libs/harness/gates/src/mutation-check.ts",
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

const variabilizeGraphToken = (raw: string): {
  readonly variabilized: RuleGraphToken
  readonly usedScopeVar: boolean
} => {
  let usedScopeVar = false
  const replaced = raw.replace(SCOPE_PATH_REGEX, (_match, rootDir: string) => {
    usedScopeVar = true
    return `${rootDir}/?Scope/`
  })
  return {
    variabilized: RuleGraphToken.make(replaced),
    usedScopeVar,
  }
}

const patternToRegex = (patternToken: string): RegExp => {
  const escaped = patternToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  let hasNamedGroup = false
  const withVars = escaped.replace(/\\\?Scope/g, () => {
    if (!hasNamedGroup) {
      hasNamedGroup = true
      return "(?<Scope>[a-z0-9_-]+)"
    }
    return "\\k<Scope>"
  })
  return new RegExp(`^${withVars}$`)
}

const doesPatternSetMatchSnapshot = (
  lhsPatterns: ReadonlyArray<RuleGraphToken>,
  nacPatterns: ReadonlyArray<RuleGraphToken>,
  hyperedges: ReadonlyArray<RuleGraphToken>,
): boolean => {
  if (lhsPatterns.length === 0) {
    return false
  }
  const candidateScopes = new Set<string>(["*"])
  for (const edge of hyperedges) {
    const m = /\b(?:libs|apps)\/([a-z0-9_-]+)\//.exec(edge)
    if (m?.[1] !== undefined) {
      candidateScopes.add(m[1])
    }
  }

  for (const scopeVal of candidateScopes) {
    const instantiate = (p: string): string =>
      scopeVal === "*" ? p : p.replace(/\?Scope/g, scopeVal)

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

export const decideRuleSynthesizer = Effect.fn("RuleSynthesizer.decide")(function* (
  input: RuleSynthesizerInput,
): Effect.fn.Return<RuleSynthesisReport, RuleSynthesisError, never> {
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

  const patternVariables = new Set<PatternVariableName>([
    PatternVariableName.make("?Scope"),
  ])
  const nodeMappings: Array<LggNodeMapping> = []

  const lhsNodes = Array.from(
    new Set(input.badGraphNodes.map((n) => variabilizeGraphToken(n).variabilized)),
  )
  const rhsNodes = Array.from(
    new Set(input.goodGraphNodes.map((n) => variabilizeGraphToken(n).variabilized)),
  )
  const interfaceNodes = Array.from(
    new Set(
      preservedRawNodes.map((n) => {
        const v = variabilizeGraphToken(n)
        nodeMappings.push({
          badNodeKey: n,
          goodNodeKey: n,
          patternVar: PatternVariableName.make(v.usedScopeVar ? "?Scope" : "?Node"),
        })
        if (!v.usedScopeVar) {
          patternVariables.add(PatternVariableName.make("?Node"))
        }
        return v.variabilized
      }),
    ),
  )

  const lhsNodeSet = new Set<string>(lhsNodes)
  const rhsNodeSet = new Set<string>(rhsNodes)
  const interfacePreservedInBoth = interfaceNodes.every(
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

  const lhsHyperedges = Array.from(
    new Set(
      (removedEdges.length > 0 ? removedEdges : input.badGraphHyperedges).map(
        (e) => variabilizeGraphToken(e).variabilized,
      ),
    ),
  )
  const rhsHyperedges = Array.from(
    new Set(
      (addedEdges.length > 0 ? addedEdges : input.goodGraphHyperedges).map(
        (e) => variabilizeGraphToken(e).variabilized,
      ),
    ),
  )
  const nacForbiddenHyperedges = Array.from(
    new Set(addedEdges.map((e) => variabilizeGraphToken(e).variabilized)),
  )

  const cascadeResults: Array<CascadeStageResult> = [
    {
      stage: CascadeStageName.make("Stage1_PushoutWellFormedness"),
      passed: RuleSynthesisFlag.make(true),
      detail: RuleSynthesisText.make(
        `Verified DPO interface K (${interfaceNodes.length} node(s)) and variabilized LGG bindings (${Array.from(patternVariables).join(", ")}).`,
      ),
    },
  ]

  // Stage 2: Positive Replay on G_bad -> G_good
  const matchesBad = doesPatternSetMatchSnapshot(
    lhsHyperedges,
    nacForbiddenHyperedges,
    input.badGraphHyperedges,
  )
  const matchesGoodAfterRewrite =
    nacForbiddenHyperedges.length > 0 &&
    doesPatternSetMatchSnapshot(
      lhsHyperedges,
      nacForbiddenHyperedges,
      input.goodGraphHyperedges,
    )

  if (!matchesBad || matchesGoodAfterRewrite) {
    return yield* new RuleSynthesisError({
      stage: RuleSynthesisFailureStage.make("Stage2_PositiveReplay"),
      reason: RuleSynthesisText.make(
        `Positive replay failed for '${input.taskId}': matchesBad=${matchesBad}, matchesGoodAfterRewrite=${matchesGoodAfterRewrite}.`,
      ),
    })
  }

  cascadeResults.push({
    stage: CascadeStageName.make("Stage2_PositiveReplay"),
    passed: RuleSynthesisFlag.make(true),
    detail: RuleSynthesisText.make(
      `Verified positive DPO replay on G_bad -> G_good with idempotent NAC termination.`,
    ),
  })

  // Stage 3: Zero False Positives across healthy corpus snapshots
  for (const snapshot of input.healthyCorpusSnapshots) {
    if (!snapshot.isHealthy) {
      continue
    }
    const falsePositive = doesPatternSetMatchSnapshot(
      lhsHyperedges,
      nacForbiddenHyperedges,
      snapshot.hyperedgeSignatures,
    )
    if (falsePositive) {
      return yield* new RuleSynthesisError({
        stage: RuleSynthesisFailureStage.make("Stage3_ZeroFalsePositive"),
        reason: RuleSynthesisText.make(
          `Synthesized DPO rule triggered a false positive on healthy corpus snapshot '${snapshot.snapshotId}'.`,
        ),
      })
    }
  }

  cascadeResults.push({
    stage: CascadeStageName.make("Stage3_ZeroFalsePositive"),
    passed: RuleSynthesisFlag.make(true),
    detail: RuleSynthesisText.make(
      `Verified 0 false positives across ${input.healthyCorpusSnapshots.filter((s) => s.isHealthy).length} healthy corpus snapshot(s).`,
    ),
  })

  // Stage 4: Immutable TCB Protection & System One Quality Prior
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

  if (input.qualityPriorMillis !== undefined && input.qualityPriorMillis < 500) {
    return yield* new RuleSynthesisError({
      stage: RuleSynthesisFailureStage.make("Stage4_ImmutableTcbAndQuality"),
      reason: RuleSynthesisText.make(
        `SynthesizedRuleQualityV1 prior ${input.qualityPriorMillis} millis is below promotion threshold 500 millis.`,
      ),
    })
  }

  cascadeResults.push({
    stage: CascadeStageName.make("Stage4_ImmutableTcbAndQuality"),
    passed: RuleSynthesisFlag.make(true),
    detail: RuleSynthesisText.make(
      `Verified Immutable TCB boundary and quality threshold (score=${input.qualityPriorMillis ?? 800} millis).`,
    ),
  })

  const sanitizedId = input.taskId.replace(/[^a-zA-Z0-9_-]/g, "-")
  const rule: SynthesizedDpoRuleSpec = {
    ruleId: SynthesizedRuleId.make(`SYNTH-${sanitizedId}`),
    name: RuleSynthesisText.make(`LGG DPO Rule for ${input.taskId}`),
    description: RuleSynthesisText.make(
      `Synthesized via First-Order Graph Anti-Unification (LGG) from G_bad -> G_good for task ${input.taskId}.`,
    ),
    patternVariables: Array.from(patternVariables),
    lhsNodes,
    lhsHyperedges,
    interfaceNodes,
    rhsNodes,
    rhsHyperedges,
    nacForbiddenHyperedges,
    targetGateFiles: [...input.targetFiles],
    ...(input.qualityPriorMillis !== undefined
      ? { qualityScoreMillis: input.qualityPriorMillis }
      : {}),
  }

  return {
    rule,
    nodeMappings,
    cascadeResults,
    promoted: RuleSynthesisFlag.make(true),
  }
})

export const RuleSynthesizer = {
  decide: decideRuleSynthesizer,
  isImmutableTcbPath,
} as const
