import { Effect } from "effect"
import * as Graph from "effect/Graph"
import { HARNESS_PERA_CONCEPT_LATTICE_CONFIG, decideConceptLattice } from "../concept-lattice.js"
import {
  type DatalogEvaluationContext,
  type FlixConfidenceLatticeElement,
  type ProofRegistrar,
  extractEdbTuplesFromGraph,
  flixConfidenceReducer,
  isCloudBinding,
  isDeciderSpan,
  isDomainOrContractFn,
  isInfraService,
  isReducerSpan,
  makeProofRegistrar,
} from "./datalog-types-and-semiring.js"
import {
  type Stratum1And2Result,
  runStratum1And2,
} from "./stratum-1-and-2-rules.js"
import {
  ConfidenceMillis,
  DatalogRuleId,
  type DerivationProof,
  GraphInferenceError,
  type GraphInferenceResult,
  type HarnessGraph,
  type InhabitingSymbolCandidate,
  NodeKey,
  PageRankScoreMillis,
  ProofHeight,
  ProofId,
  RelationId,
  RoleName,
  type SemanticEdgePriors,
  StratumIndex,
  type SuggestedEdge,
  type TypedHoleContextBundle,
} from "../model.js"

export interface Stratum3Result {
  readonly suggestedEdges: ReadonlyArray<SuggestedEdge>
  readonly typedHoleBundles: ReadonlyArray<TypedHoleContextBundle>
}

export const runStratum3CompletionAndHoles = (
  ctx: DatalogEvaluationContext,
  s12: Stratum1And2Result,
  proofReg: ProofRegistrar,
  priors?: SemanticEdgePriors,
): Stratum3Result => {
  const { registerProof, proofsById } = proofReg
  const suggestedEdges: Array<SuggestedEdge> = []

  // COMP-01: Missing fails-with PlaysRoleEdge on EffectSignature
  for (const [pairKey, [[specKey, callerKey, errKey]]] of s12.stratum3Facts.collectedComp01) {
    const relId = ctx.sigIdByCallerKey.get(callerKey) ?? `EffectSignature:${ctx.fnQualnameByKey.get(callerKey) ?? callerKey}`
    const parentId = s12.stratum1.failProofByPair.get(pairKey)
    const proof = registerProof({
      proofId: ProofId.make(`proof:COMP-01:${relId}->${errKey}`),
      ruleId: DatalogRuleId.make("COMP-01"),
      stratum: StratumIndex.make(3),
      conclusion: `SuggestedEdge(PlaysRole, ${relId}, ${errKey}, fails-with)`,
      premises: [`SpecSpecifiesTarget(${specKey}, ${callerKey})`, `SpecReferencesError(${specKey}, ${errKey})`, `!PlaysRole(${relId}, ${errKey}, fails-with)`],
      parentProofIds: parentId !== undefined ? [parentId] : [],
    })
    suggestedEdges.push({
      ruleId: DatalogRuleId.make("COMP-01"),
      relationTag: "EffectSignature",
      relationId: RelationId.make(relId),
      role: RoleName.make("fails-with"),
      targetEntityKey: NodeKey.make(errKey),
      sourceEntityKey: NodeKey.make(callerKey),
      confidenceMillis: ConfidenceMillis.make(950),
      rationale: `EARS spec '${specKey}' specifies '${callerKey}' and declares error '${errKey}', which is missing from '${relId}'`,
      proof,
    })
  }

  for (const fail of s12.stratum1.effectiveFailsWith) {
    if (!fail.isDirect) {
      const relId = ctx.sigIdByCallerKey.get(fail.callerKey) ?? `EffectSignature:${ctx.fnQualnameByKey.get(fail.callerKey) ?? fail.callerKey}`
      const alreadySuggested = suggestedEdges.some(
        (s) => s.relationId === relId && s.role === "fails-with" && s.targetEntityKey === fail.errorKey,
      )
      if (!alreadySuggested) {
        const proof = registerProof({
          proofId: ProofId.make(`proof:COMP-01:transitive:${relId}->${fail.errorKey}`),
          ruleId: DatalogRuleId.make("COMP-01"),
          stratum: StratumIndex.make(3),
          conclusion: `SuggestedEdge(PlaysRole, ${relId}, ${fail.errorKey}, fails-with)`,
          premises: [fail.proof.conclusion, `!PlaysRole(${relId}, ${fail.errorKey}, fails-with)`],
          parentProofIds: [fail.proof.proofId],
        })
        suggestedEdges.push({
          ruleId: DatalogRuleId.make("COMP-01"),
          relationTag: "EffectSignature",
          relationId: RelationId.make(relId),
          role: RoleName.make("fails-with"),
          targetEntityKey: fail.errorKey,
          sourceEntityKey: fail.callerKey,
          confidenceMillis: ConfidenceMillis.make(900),
          rationale: `Transitive callee propagates '${fail.errorKey}' along [${fail.path.join(" -> ")}], but caller signature '${relId}' lacks a direct fails-with role edge`,
          proof,
        })
      }
    }
  }

  // COMP-02: Missing requires-service PlaysRoleEdge on EffectSignature
  for (const [pairKey, [[specKey, callerKey, svcKey]]] of s12.stratum3Facts.collectedComp02) {
    const callerNode = ctx.fnsByKey.get(callerKey)
    const svcNode = ctx.servicesByKey.get(svcKey)
    const callerIsDomainOrContract = callerNode !== undefined && isDomainOrContractFn(callerNode)
    const svcIsInfraOrCloud = svcNode !== undefined && (isInfraService(svcNode) || isCloudBinding(svcNode))
    if (callerIsDomainOrContract && svcIsInfraOrCloud) continue

    const relId = ctx.sigIdByCallerKey.get(callerKey) ?? `EffectSignature:${ctx.fnQualnameByKey.get(callerKey) ?? callerKey}`
    const parentId = s12.stratum1.reqProofByPair.get(pairKey)
    const proof = registerProof({
      proofId: ProofId.make(`proof:COMP-02:${relId}->${svcKey}`),
      ruleId: DatalogRuleId.make("COMP-02"),
      stratum: StratumIndex.make(3),
      conclusion: `SuggestedEdge(PlaysRole, ${relId}, ${svcKey}, requires-service)`,
      premises: [`SpecSpecifiesTarget(${specKey}, ${callerKey})`, `SpecReferencesService(${specKey}, ${svcKey})`, `!PlaysRole(${relId}, ${svcKey}, requires-service)`],
      parentProofIds: parentId !== undefined ? [parentId] : [],
    })
    suggestedEdges.push({
      ruleId: DatalogRuleId.make("COMP-02"),
      relationTag: "EffectSignature",
      relationId: RelationId.make(relId),
      role: RoleName.make("requires-service"),
      targetEntityKey: NodeKey.make(svcKey),
      sourceEntityKey: NodeKey.make(callerKey),
      confidenceMillis: ConfidenceMillis.make(950),
      rationale: `EARS spec '${specKey}' specifies '${callerKey}' and declares service '${svcKey}', which is missing from '${relId}'`,
      proof,
    })
  }

  // COMP-03: Missing LayerFlow provider edge
  for (const [svcKey, [callerKey]] of s12.stratum3Facts.collectedComp03) {
    const svcTag = ctx.svcTagIdByKey.get(svcKey) ?? svcKey
    const relId = `LayerFlow:suggested:${svcTag}`
    const proof = registerProof({
      proofId: ProofId.make(`proof:COMP-03:${relId}->${svcKey}`),
      ruleId: DatalogRuleId.make("COMP-03"),
      stratum: StratumIndex.make(3),
      conclusion: `SuggestedEdge(PlaysRole, ${relId}, ${svcKey}, provided-service)`,
      premises: [`DirectRequires(${callerKey}, ${svcKey})`, `!PlaysRole(LayerFlow:*, ${svcKey}, provided-service)`],
      parentProofIds: [],
    })
    suggestedEdges.push({
      ruleId: DatalogRuleId.make("COMP-03"),
      relationTag: "LayerFlow",
      relationId: RelationId.make(relId),
      role: RoleName.make("provided-service"),
      targetEntityKey: NodeKey.make(svcKey),
      sourceEntityKey: NodeKey.make(callerKey),
      confidenceMillis: ConfidenceMillis.make(850),
      rationale: `ServiceTag '${svcTag}' is required by '${callerKey}' but has no providing LayerFlow in the hypergraph`,
      proof,
    })
  }

  // COMP-04: Missing verifying-test for untested domain span
  for (const [fnKey] of s12.stratum2.collectedUntestedDomainSpans) {
    const fnNode = ctx.fnsByKey.get(fnKey)
    if (!fnNode) continue
    const relId = ctx.traceIdByTargetKey.get(fnKey) ?? `TraceabilityTuple:fn:${fnNode.qualname}`
    const proof = registerProof({
      proofId: ProofId.make(`proof:COMP-04:${relId}->${fnKey}`),
      ruleId: DatalogRuleId.make("COMP-04"),
      stratum: StratumIndex.make(3),
      conclusion: `SuggestedEdge(PlaysRole, ${relId}, ${fnKey}, verifying-test)`,
      premises: [`DomainEffectFn(${fnKey})`, `!EffectiveTestReach(*, ${fnKey})`],
      parentProofIds: [ProofId.make(`proof:INF-09:untested-span:${fnKey}`)],
    })
    suggestedEdges.push({
      ruleId: DatalogRuleId.make("COMP-04"),
      relationTag: "TraceabilityTuple",
      relationId: RelationId.make(relId),
      role: RoleName.make("verifying-test"),
      targetEntityKey: NodeKey.make(fnKey),
      confidenceMillis: ConfidenceMillis.make(900),
      rationale: `Non-stub ${fnNode.packageTag} EffectFn '${fnNode.spanName}' lacks a verifying-test role edge on TraceabilityTuple '${relId}'`,
      proof,
    })
  }

  // COMP-05: Missing governing-adr for enforced files
  for (const [, [[adrKey, fnKey]]] of s12.stratum3Facts.collectedComp05) {
    const fnNode = ctx.fnsByKey.get(fnKey)
    const relId = ctx.traceIdByTargetKey.get(fnKey) ?? `TraceabilityTuple:fn:${fnNode?.qualname ?? fnKey}`
    const proof = registerProof({
      proofId: ProofId.make(`proof:COMP-05:${relId}->${adrKey}`),
      ruleId: DatalogRuleId.make("COMP-05"),
      stratum: StratumIndex.make(3),
      conclusion: `SuggestedEdge(PlaysRole, ${relId}, ${adrKey}, governing-adr)`,
      premises: [`AdrEnforcesFile(${adrKey}, ${fnNode?.file ?? fnKey})`, `!PlaysRole(${relId}, ${adrKey}, governing-adr)`],
      parentProofIds: [],
    })
    suggestedEdges.push({
      ruleId: DatalogRuleId.make("COMP-05"),
      relationTag: "TraceabilityTuple",
      relationId: RelationId.make(relId),
      role: RoleName.make("governing-adr"),
      targetEntityKey: NodeKey.make(adrKey),
      sourceEntityKey: NodeKey.make(fnKey),
      confidenceMillis: ConfidenceMillis.make(920),
      rationale: `ADR '${adrKey}' lists '${fnNode?.file ?? fnKey}' in enforcedByFiles, but '${relId}' lacks a governing-adr role edge`,
      proof,
    })
  }

  // Flix join-semilattice reduction and priors overrides
  const mergedSuggestedMap = new Map<string, SuggestedEdge>()
  const groupedByEdgeKey = new Map<string, Array<SuggestedEdge>>()
  for (const edge of suggestedEdges) {
    const edgeIdentity = `${edge.relationTag}::${edge.targetEntityKey}::${edge.role}`
    const group = groupedByEdgeKey.get(edgeIdentity) ?? []
    group.push(edge)
    groupedByEdgeKey.set(edgeIdentity, group)
  }
  for (const [edgeIdentity, group] of groupedByEdgeKey.entries()) {
    const primary = group[0]
    if (!primary) continue
    const latticeInputs: Array<readonly [FlixConfidenceLatticeElement, number]> = group.map((g) => [
      { confidenceMillis: g.confidenceMillis, parentProofIds: [g.proof.proofId, ...g.proof.parentProofIds] },
      1,
    ])
    const overrideKeys = [
      edgeIdentity,
      `${primary.relationId}:${primary.role}:${primary.targetEntityKey}`,
      `${primary.sourceEntityKey ?? primary.relationId}->${primary.targetEntityKey}`,
      `${primary.targetEntityKey}:${primary.role}`,
      primary.targetEntityKey,
    ]
    for (const k of overrideKeys) {
      const overrideVal = priors?.edgeConfidenceOverrides[k]
      if (overrideVal !== undefined) {
        latticeInputs.push([{ confidenceMillis: overrideVal, parentProofIds: [primary.proof.proofId] }, 1])
      }
    }
    const reduced = flixConfidenceReducer(latticeInputs)[0]?.[0]
    const joinedConfidence = reduced?.confidenceMillis ?? primary.confidenceMillis
    const mergedParentProofIds = reduced?.parentProofIds ?? primary.proof.parentProofIds
    const updatedProof: DerivationProof = { ...primary.proof, parentProofIds: mergedParentProofIds }
    proofsById.set(updatedProof.proofId, updatedProof)
    mergedSuggestedMap.set(edgeIdentity, { ...primary, confidenceMillis: joinedConfidence, proof: updatedProof })
  }
  const finalSuggestedEdges = Array.from(mergedSuggestedMap.values())

  // COMP-06: Typed Hole Inhabitation & PPR
  const entityNeighbors = new Map<string, Set<string>>()
  const addHyperedgeClique = (roleMap: ReadonlyMap<string, ReadonlySet<string>>): void => {
    const participants = new Set<string>()
    for (const keys of roleMap.values()) {
      for (const k of keys) participants.add(k)
    }
    const arr = Array.from(participants)
    for (const u of arr) {
      let uSet = entityNeighbors.get(u)
      if (!uSet) { uSet = new Set<string>(); entityNeighbors.set(u, uSet) }
      for (const v of arr) {
        if (u !== v) uSet.add(v)
      }
    }
  }
  for (const roles of ctx.sigRoles.values()) addHyperedgeClique(roles)
  for (const roles of ctx.layerFlowRoles.values()) addHyperedgeClique(roles)
  for (const roles of ctx.traceRoles.values()) addHyperedgeClique(roles)
  for (const roles of ctx.migrationRoles.values()) addHyperedgeClique(roles)
  for (const roles of ctx.httpRoles.values()) addHyperedgeClique(roles)

  const typedHoleBundles: Array<TypedHoleContextBundle> = []
  const stubFns = Array.from(ctx.fnsByKey.entries()).filter(([, fnNode]) => fnNode.isStub).sort((a, b) => a[0].localeCompare(b[0]))

  for (const [holeKey, holeFn] of stubFns) {
    const sigRelId = ctx.sigIdByCallerKey.get(holeKey)
    const roles = sigRelId !== undefined ? ctx.sigRoles.get(sigRelId) : undefined
    const outputSchemaKeys = new Set<string>(roles?.get("output-schema") ?? [])
    const inputSchemaKeys = new Set<string>(roles?.get("input-schema") ?? [])
    const directErrorKeys = new Set<string>(roles?.get("fails-with") ?? [])
    const directServiceKeys = new Set<string>(roles?.get("requires-service") ?? [])

    if (holeFn.outputSchema !== undefined) {
      for (const [sKey, sNode] of ctx.schemasByKey.entries()) {
        if (sNode.schemaName === holeFn.outputSchema || sNode.name === holeFn.outputSchema || sKey === `SchemaDef:${holeFn.outputSchema}`) {
          outputSchemaKeys.add(sKey)
        }
      }
    } else if (holeFn.successType !== undefined && holeFn.successType !== "void" && holeFn.successType !== "never") {
      for (const [sKey, sNode] of ctx.schemasByKey.entries()) {
        if (sNode.schemaName === holeFn.successType || sNode.name === holeFn.successType || sKey === `SchemaDef:${holeFn.successType}`) {
          outputSchemaKeys.add(sKey)
        }
      }
    }
    if (holeFn.inputSchema !== undefined) {
      for (const [sKey, sNode] of ctx.schemasByKey.entries()) {
        if (sNode.schemaName === holeFn.inputSchema || sNode.name === holeFn.inputSchema || sKey === `SchemaDef:${holeFn.inputSchema}`) {
          inputSchemaKeys.add(sKey)
        }
      }
    }

    for (const [specKey, targetKey] of ctx.existingSpecToTargetPairs) {
      if (targetKey !== holeKey) continue
      const specNode = ctx.specsByKey.get(specKey)
      if (!specNode) continue
      for (const errName of specNode.referencedErrors ?? []) {
        const errKey = `TaggedError:${errName}`
        if (ctx.errorsByKey.has(errKey)) directErrorKeys.add(errKey)
      }
      for (const svcName of specNode.referencedServices ?? []) {
        for (const [svcKey, svcNode] of ctx.servicesByKey.entries()) {
          if (svcNode.tagId === svcName || svcNode.name === svcName || svcNode.tagId.endsWith(`#${svcName}`)) {
            directServiceKeys.add(svcKey)
          }
        }
      }
    }

    // Personalized PageRank
    const rawSeeds = new Map<string, number>()
    rawSeeds.set(holeKey, 1.0)
    for (const k of [...outputSchemaKeys, ...inputSchemaKeys, ...directErrorKeys, ...directServiceKeys]) {
      rawSeeds.set(k, Math.max(rawSeeds.get(k) ?? 0, 1.0))
    }
    for (const [, traceRoleMap] of ctx.traceRoles.entries()) {
      const targets = new Set([
        ...(traceRoleMap.get("realizing-symbol") ?? []),
        ...(traceRoleMap.get("specified-target") ?? []),
        ...(traceRoleMap.get("exercised-span") ?? []),
      ])
      if (targets.has(holeKey)) {
        for (const entityKeys of traceRoleMap.values()) {
          for (const ek of entityKeys) {
            if (ek !== holeKey && ctx.allEntityKeys.has(ek)) rawSeeds.set(ek, Math.max(rawSeeds.get(ek) ?? 0, 0.5))
          }
        }
      }
    }
    if (priors?.holeTeleportationWeights !== undefined) {
      for (const [k, weightMillis] of Object.entries(priors.holeTeleportationWeights)) {
        if (weightMillis > 0 && ctx.allEntityKeys.has(k)) rawSeeds.set(k, Math.max(rawSeeds.get(k) ?? 0, weightMillis / 1000))
      }
    }
    let seedSum = 0
    for (const w of rawSeeds.values()) seedSum += w
    const normalizedSeeds = new Map<string, number>()
    for (const [k, w] of rawSeeds.entries()) normalizedSeeds.set(k, seedSum > 0 ? w / seedSum : 0)

    let ppr = new Map<string, number>(normalizedSeeds)
    const alpha = 0.85
    for (let step = 0; step < 10; step++) {
      const nextPpr = new Map<string, number>()
      for (const [sKey, sWeight] of normalizedSeeds.entries()) nextPpr.set(sKey, (1 - alpha) * sWeight)
      let danglingMass = 0
      for (const [u, uMass] of ppr.entries()) {
        if (uMass <= 0) continue
        const neighbors = entityNeighbors.get(u)
        if (!neighbors || neighbors.size === 0) {
          danglingMass += uMass
        } else {
          const share = (alpha * uMass) / neighbors.size
          for (const v of neighbors) nextPpr.set(v, (nextPpr.get(v) ?? 0) + share)
        }
      }
      if (danglingMass > 0) {
        for (const [sKey, sWeight] of normalizedSeeds.entries()) {
          nextPpr.set(sKey, (nextPpr.get(sKey) ?? 0) + alpha * danglingMass * sWeight)
        }
      }
      ppr = nextPpr
    }

    const holePkgPrefix = holeFn.file.split("/").slice(0, 3).join("/")
    const rawCandidates: Array<{
      readonly symbolKey: NodeKey
      readonly inhabitsChannel: "A" | "E" | "R" | "decider-delegate"
      readonly signatureSummary: string
      readonly rawMass: number
    }> = []

    const pushCandidate = (
      symbolKey: string,
      inhabitsChannel: "A" | "E" | "R" | "decider-delegate",
      signatureSummary: string,
      bonusMass: number,
    ): void => {
      const overrideMillis = priors?.holeTeleportationWeights[NodeKey.make(symbolKey)]
      const baseMass = ppr.get(symbolKey) ?? 0
      const effectiveMass = overrideMillis !== undefined ? Math.max(baseMass + bonusMass, overrideMillis / 1000) : baseMass + bonusMass
      rawCandidates.push({ symbolKey: NodeKey.make(symbolKey), inhabitsChannel, signatureSummary, rawMass: effectiveMass })
    }

    // Channel A
    for (const [schemaKey, schemaNode] of ctx.schemasByKey.entries()) {
      const isDirectSchema = outputSchemaKeys.has(schemaKey) || inputSchemaKeys.has(schemaKey)
      const isSameScope = schemaNode.file.startsWith(holePkgPrefix)
      if (isDirectSchema || isSameScope || (ppr.get(schemaKey) ?? 0) > 0) {
        const schemaLabel = schemaNode.name ?? schemaNode.schemaName
        pushCandidate(schemaKey, "A", `Schema ${schemaLabel}${schemaNode.isBranded === true ? " (branded)" : ""}`, isDirectSchema ? 0.5 : isSameScope ? 0.15 : 0.05)
      }
    }

    // Channel E
    for (const errKey of Array.from(directErrorKeys).sort()) {
      const errNode = ctx.errorsByKey.get(errKey)
      if (errNode) pushCandidate(errKey, "E", `TaggedError<${errNode.tag ?? errNode.errorTag}>("${errNode.errorTag}")`, 0.6)
    }

    // Channel R
    for (const svcKey of Array.from(directServiceKeys).sort()) {
      const svcNode = ctx.servicesByKey.get(svcKey)
      if (svcNode) pushCandidate(svcKey, "R", `Context.Service<${svcNode.name}>("${svcNode.tagId}")`, 0.6)
    }

    // Channel decider-delegate
    for (const [otherKey, otherFn] of ctx.fnsByKey.entries()) {
      if (otherKey === holeKey) continue
      if (isDeciderSpan(otherFn.spanName) || isReducerSpan(otherFn.spanName)) {
        const isSameScope = otherFn.file.startsWith(holePkgPrefix)
        pushCandidate(otherKey, "decider-delegate", `Effect.fn("${otherFn.spanName}") (${otherFn.qualname})`, isSameScope ? 0.45 : 0.2)
      }
    }

    let maxRawMass = 0
    for (const c of rawCandidates) {
      if (c.rawMass > maxRawMass) maxRawMass = c.rawMass
    }

    const scoredCandidates: Array<InhabitingSymbolCandidate> = rawCandidates
      .map((c) => {
        const normalizedMillis = maxRawMass > 0 ? Math.min(1000, Math.max(1, Math.round((c.rawMass / maxRawMass) * 950))) : 500
        const overrideMillis = priors?.holeTeleportationWeights[c.symbolKey]
        const finalScore = overrideMillis !== undefined ? Math.max(normalizedMillis, overrideMillis) : normalizedMillis
        return { symbolKey: c.symbolKey, inhabitsChannel: c.inhabitsChannel, signatureSummary: c.signatureSummary, pprScore: PageRankScoreMillis.make(finalScore) }
      })
      .sort((a, b) => a.pprScore !== b.pprScore ? b.pprScore - a.pprScore : a.symbolKey.localeCompare(b.symbolKey))

    const MAX_HOLE_TOKENS = 1500
    let estimatedTokens = Math.min(MAX_HOLE_TOKENS, 96 + Math.ceil((holeFn.qualname.length + holeFn.spanName.length) / 4))
    const boundedCandidates: Array<InhabitingSymbolCandidate> = []
    for (const cand of scoredCandidates) {
      const candTokens = Math.max(16, Math.ceil((cand.symbolKey.length + cand.signatureSummary.length + 16) / 4))
      if (estimatedTokens + candTokens > MAX_HOLE_TOKENS) break
      boundedCandidates.push(cand)
      estimatedTokens += candTokens
    }

    const outputSchemaNames = Array.from(outputSchemaKeys).map((k) => ctx.schemasByKey.get(k)?.name ?? ctx.schemasByKey.get(k)?.schemaName ?? k.replace(/^SchemaDef:/, "")).sort()
    const successTypeSignature = outputSchemaNames.length > 0 ? outputSchemaNames.join(" | ") : (holeFn.successType ?? "unknown")
    const allowedErrorConstructors = Array.from(directErrorKeys).map((k) => ctx.errTagByKey.get(k) ?? k.replace(/^TaggedError:/, "")).sort()
    const requiredServiceCapabilities = Array.from(directServiceKeys).map((k) => ctx.svcTagIdByKey.get(k) ?? k.replace(/^ServiceTag:/, "")).sort()

    registerProof({
      proofId: ProofId.make(`proof:COMP-06:${holeKey}`),
      ruleId: DatalogRuleId.make("COMP-06"),
      stratum: StratumIndex.make(3),
      proofHeight: ProofHeight.make(1),
      conclusion: `SuggestedHoleInhabitant(${holeKey}, candidates=${boundedCandidates.length})`,
      premises: [`StubEffectFn(${holeKey})`, ...boundedCandidates.slice(0, 4).map((c) => `Inhabits(${c.symbolKey}, ${c.inhabitsChannel})`)],
      parentProofIds: [],
      witnessPath: [holeFn.qualname, ...boundedCandidates.slice(0, 4).map((c) => c.symbolKey)],
    })

    typedHoleBundles.push({
      holeQualname: holeFn.qualname,
      spanName: holeFn.spanName,
      successTypeSignature,
      allowedErrorConstructors,
      requiredServiceCapabilities,
      inhabitingCandidates: boundedCandidates,
      estimatedTokens,
    })
  }

  return {
    suggestedEdges: finalSuggestedEdges,
    typedHoleBundles,
  }
}

export const runGraphInferencePipeline = Effect.fn("GraphInfer.runPipeline")(function* (
  harnessGraph: HarnessGraph,
  priors?: SemanticEdgePriors,
) {
  yield* decideConceptLattice(HARNESS_PERA_CONCEPT_LATTICE_CONFIG)

  return yield* Effect.try({
    try: (): GraphInferenceResult => {
      const ctx = extractEdbTuplesFromGraph(harnessGraph, priors)
      const proofReg = makeProofRegistrar()
      const s12 = runStratum1And2(ctx, proofReg)
      const s3 = runStratum3CompletionAndHoles(ctx, s12, proofReg, priors)

      const antiPatterns = [...s12.stratum2.antiPatterns].sort((a, b) =>
        a.ruleId !== b.ruleId
          ? a.ruleId.localeCompare(b.ruleId)
          : a.nodeKey !== b.nodeKey
            ? a.nodeKey.localeCompare(b.nodeKey)
            : (a.targetKey ?? "").localeCompare(b.targetKey ?? ""),
      )

      const suggestedEdges = [...s3.suggestedEdges].sort((a, b) =>
        a.ruleId !== b.ruleId
          ? a.ruleId.localeCompare(b.ruleId)
          : a.relationId !== b.relationId
            ? a.relationId.localeCompare(b.relationId)
            : a.targetEntityKey.localeCompare(b.targetEntityKey),
      )

      const proofs = Array.from(proofReg.proofsById.values()).sort((a, b) =>
        a.stratum !== b.stratum ? a.stratum - b.stratum : a.proofId.localeCompare(b.proofId),
      )

      let maxDepth = 0
      for (const [, ann] of s12.stratum1.collectedCallReachProvenance) {
        if (ann.proofHeight > maxDepth) maxDepth = ann.proofHeight
      }
      for (const proof of proofReg.proofsById.values()) {
        if (proof.proofHeight !== undefined && proof.proofHeight > maxDepth) maxDepth = proof.proofHeight
      }
      const hasGraphContent = Graph.nodeCount(harnessGraph.graph) > 0 || ctx.directCallPairs.length > 0
      const iterations = hasGraphContent ? Math.max(1, maxDepth) : 0

      return {
        effectiveRequires: s12.stratum1.effectiveRequires,
        effectiveFailsWith: s12.stratum1.effectiveFailsWith,
        effectiveLayerDeps: s12.stratum1.effectiveLayerDeps,
        effectiveTestReach: s12.stratum1.effectiveTestReach,
        antiPatterns,
        suggestedEdges,
        typedHoleBundles: s3.typedHoleBundles,
        proofs,
        iterations,
      }
    },
    catch: (err) =>
      new GraphInferenceError({
        reason: "d2ts-execution-failed",
        message: String(err),
      }),
  })
})
