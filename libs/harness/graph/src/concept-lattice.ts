import { Effect } from "effect"
import * as Graph from "effect/Graph"
import {
  ARCHIMATE_BY_ROLE,
  type ConceptClosureEntry,
  ConceptId,
  type ConceptLatticeConfig,
  ConceptLatticeCycleError,
  type ConceptLatticeResult,
  type ConceptSpec,
  RoleName,
  type RoleSpec,
} from "./model.js"

/**
 * Canonical PERA (Polymorphic Entity-Relation-Attribute) Concept Lattice
 * for the Effect-TS Engineering Harness (`RFC-0001` / `harness:ADR-0009`).
 */
export const HARNESS_PERA_CONCEPT_LATTICE_CONFIG: ConceptLatticeConfig = {
  concepts: [
    // Abstract Entity Supertypes
    { id: ConceptId.make("Artifact"), kind: "entity", supertypes: [], playsRoles: [RoleName.make("realizing-symbol"), RoleName.make("specified-target"), RoleName.make("governed-symbol")] },
    { id: ConceptId.make("CodeArtifact"), kind: "entity", supertypes: [ConceptId.make("Artifact")], playsRoles: [RoleName.make("migration-module")] },
    { id: ConceptId.make("GovernanceArtifact"), kind: "entity", supertypes: [ConceptId.make("Artifact")], playsRoles: [] },
    { id: ConceptId.make("VerificationArtifact"), kind: "entity", supertypes: [ConceptId.make("Artifact")], playsRoles: [RoleName.make("verifying-test"), RoleName.make("exercising-test")] },
    { id: ConceptId.make("ExecutableArtifact"), kind: "entity", supertypes: [ConceptId.make("CodeArtifact")], playsRoles: [RoleName.make("caller"), RoleName.make("callee"), RoleName.make("exercised-span"), RoleName.make("endpoint-handler")] },
    { id: ConceptId.make("CapabilityArtifact"), kind: "entity", supertypes: [ConceptId.make("CodeArtifact")], playsRoles: [] },
    { id: ConceptId.make("ContractArtifact"), kind: "entity", supertypes: [ConceptId.make("CodeArtifact")], playsRoles: [] },

    // Concrete Entity Concepts (V_E)
    { id: ConceptId.make("EffectFn"), kind: "entity", supertypes: [ConceptId.make("ExecutableArtifact")], playsRoles: [] },
    { id: ConceptId.make("ServiceTag"), kind: "entity", supertypes: [ConceptId.make("CapabilityArtifact")], playsRoles: [RoleName.make("requires-service"), RoleName.make("provided-service"), RoleName.make("required-service")] },
    { id: ConceptId.make("ServiceLayer"), kind: "entity", supertypes: [ConceptId.make("CapabilityArtifact")], playsRoles: [RoleName.make("provider-layer")] },
    { id: ConceptId.make("TaggedError"), kind: "entity", supertypes: [ConceptId.make("ContractArtifact")], playsRoles: [RoleName.make("fails-with"), RoleName.make("endpoint-error")] },
    { id: ConceptId.make("SchemaDef"), kind: "entity", supertypes: [ConceptId.make("ContractArtifact")], playsRoles: [RoleName.make("uses-schema"), RoleName.make("input-schema"), RoleName.make("output-schema"), RoleName.make("request-schema"), RoleName.make("response-schema")] },
    { id: ConceptId.make("VitestCase"), kind: "entity", supertypes: [ConceptId.make("VerificationArtifact")], playsRoles: [] },
    { id: ConceptId.make("PatternDoc"), kind: "entity", supertypes: [ConceptId.make("GovernanceArtifact")], playsRoles: [RoleName.make("enforcing-pattern")] },
    { id: ConceptId.make("AdrDoc"), kind: "entity", supertypes: [ConceptId.make("GovernanceArtifact")], playsRoles: [RoleName.make("governing-adr")] },
    { id: ConceptId.make("EarsSpec"), kind: "entity", supertypes: [ConceptId.make("GovernanceArtifact")], playsRoles: [RoleName.make("specifying-ears"), RoleName.make("specified-target")] },

    // Abstract & Concrete Relation Concepts (V_R)
    { id: ConceptId.make("SemanticRelation"), kind: "relation", supertypes: [], playsRoles: [], relatesRoles: [] },
    {
      id: ConceptId.make("EffectSignature"),
      kind: "relation",
      supertypes: [ConceptId.make("SemanticRelation")],
      playsRoles: [],
      relatesRoles: [
        { role: RoleName.make("caller"), minCard: 1, maxCard: 1, allowedPlayers: [ConceptId.make("ExecutableArtifact")], archimateRelation: "Access" },
        { role: RoleName.make("callee"), minCard: 0, maxCard: null, allowedPlayers: [ConceptId.make("ExecutableArtifact")], archimateRelation: "Flow" },
        { role: RoleName.make("requires-service"), minCard: 0, maxCard: null, allowedPlayers: [ConceptId.make("ServiceTag")], archimateRelation: "Serving" },
        { role: RoleName.make("fails-with"), minCard: 0, maxCard: null, allowedPlayers: [ConceptId.make("TaggedError")], archimateRelation: "Access" },
        { role: RoleName.make("uses-schema"), minCard: 0, maxCard: null, allowedPlayers: [ConceptId.make("SchemaDef")], archimateRelation: "Access" },
        { role: RoleName.make("input-schema"), minCard: 0, maxCard: 1, allowedPlayers: [ConceptId.make("SchemaDef")], archimateRelation: "Access" },
        { role: RoleName.make("output-schema"), minCard: 0, maxCard: 1, allowedPlayers: [ConceptId.make("SchemaDef")], archimateRelation: "Access" },
      ],
    },
    {
      id: ConceptId.make("LayerFlow"),
      kind: "relation",
      supertypes: [ConceptId.make("SemanticRelation")],
      playsRoles: [],
      relatesRoles: [
        { role: RoleName.make("provider-layer"), minCard: 1, maxCard: 1, allowedPlayers: [ConceptId.make("ServiceLayer")], archimateRelation: "Realization" },
        { role: RoleName.make("provided-service"), minCard: 0, maxCard: null, allowedPlayers: [ConceptId.make("ServiceTag")], archimateRelation: "Realization" },
        { role: RoleName.make("required-service"), minCard: 0, maxCard: null, allowedPlayers: [ConceptId.make("ServiceTag")], archimateRelation: "Serving" },
        { role: RoleName.make("fails-with"), minCard: 0, maxCard: null, allowedPlayers: [ConceptId.make("TaggedError")], archimateRelation: "Access" },
      ],
    },
    {
      id: ConceptId.make("TraceabilityTuple"),
      kind: "relation",
      supertypes: [ConceptId.make("SemanticRelation")],
      playsRoles: [],
      relatesRoles: [
        { role: RoleName.make("governing-adr"), minCard: 0, maxCard: 1, allowedPlayers: [ConceptId.make("AdrDoc")], archimateRelation: "Influence" },
        { role: RoleName.make("governed-symbol"), minCard: 0, maxCard: 1, allowedPlayers: [ConceptId.make("Artifact")], archimateRelation: "Influence" },
        { role: RoleName.make("specifying-ears"), minCard: 0, maxCard: 1, allowedPlayers: [ConceptId.make("EarsSpec")], archimateRelation: "Realization" },
        { role: RoleName.make("realizing-symbol"), minCard: 0, maxCard: 1, allowedPlayers: [ConceptId.make("Artifact")], archimateRelation: "Realization" },
        { role: RoleName.make("specified-target"), minCard: 0, maxCard: null, allowedPlayers: [ConceptId.make("Artifact")], archimateRelation: ARCHIMATE_BY_ROLE["specified-target"] },
        { role: RoleName.make("verifying-test"), minCard: 0, maxCard: null, allowedPlayers: [ConceptId.make("VerificationArtifact")], archimateRelation: "Realization" },
        { role: RoleName.make("exercising-test"), minCard: 0, maxCard: null, allowedPlayers: [ConceptId.make("VerificationArtifact")], archimateRelation: "Triggering" },
        { role: RoleName.make("exercised-span"), minCard: 0, maxCard: null, allowedPlayers: [ConceptId.make("ExecutableArtifact")], archimateRelation: "Triggering" },
        { role: RoleName.make("enforcing-pattern"), minCard: 0, maxCard: null, allowedPlayers: [ConceptId.make("PatternDoc")], archimateRelation: "Influence" },
      ],
    },
    {
      id: ConceptId.make("HttpEndpointTuple"),
      kind: "relation",
      supertypes: [ConceptId.make("SemanticRelation")],
      playsRoles: [],
      relatesRoles: [
        { role: RoleName.make("endpoint-handler"), minCard: 0, maxCard: 1, allowedPlayers: [ConceptId.make("ExecutableArtifact")], archimateRelation: "Realization" },
        { role: RoleName.make("request-schema"), minCard: 0, maxCard: null, allowedPlayers: [ConceptId.make("SchemaDef")], archimateRelation: "Access" },
        { role: RoleName.make("response-schema"), minCard: 0, maxCard: null, allowedPlayers: [ConceptId.make("SchemaDef")], archimateRelation: "Access" },
        { role: RoleName.make("endpoint-error"), minCard: 0, maxCard: null, allowedPlayers: [ConceptId.make("TaggedError")], archimateRelation: "Access" },
      ],
    },
    {
      id: ConceptId.make("MigrationTuple"),
      kind: "relation",
      supertypes: [ConceptId.make("SemanticRelation")],
      playsRoles: [],
      relatesRoles: [
        { role: RoleName.make("migration-module"), minCard: 0, maxCard: 1, allowedPlayers: [ConceptId.make("CodeArtifact")], archimateRelation: "Realization" },
        { role: RoleName.make("verifying-test"), minCard: 0, maxCard: null, allowedPlayers: [ConceptId.make("VerificationArtifact")], archimateRelation: "Realization" },
      ],
    },
  ],
}

const findCycleInConceptHierarchy = (
  conceptsById: ReadonlyMap<ConceptId, ConceptSpec>,
): ReadonlyArray<ConceptId> | undefined => {
  // 0 = unvisited, 1 = visiting (on stack), 2 = visited
  const state = new Map<ConceptId, 0 | 1 | 2>()
  const stack: Array<ConceptId> = []

  const dfs = (current: ConceptId): ReadonlyArray<ConceptId> | undefined => {
    state.set(current, 1)
    stack.push(current)

    const spec = conceptsById.get(current)
    for (const sup of spec?.supertypes ?? []) {
      if (sup === current) {
        return [current, current]
      }
      const supState = state.get(sup) ?? 0
      if (supState === 1) {
        const cycleStart = stack.indexOf(sup)
        const cycleSlice = cycleStart >= 0 ? stack.slice(cycleStart) : [current]
        return [...cycleSlice, sup]
      }
      if (supState === 0 && conceptsById.has(sup)) {
        const found = dfs(sup)
        if (found !== undefined) {
          return found
        }
      }
    }

    stack.pop()
    state.set(current, 2)
    return undefined
  }

  for (const id of conceptsById.keys()) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = dfs(id)
      if (cycle !== undefined) {
        return cycle
      }
    }
  }
  return undefined
}

/**
 * Cache for O(1) indexed lookups over `ConceptLatticeResult` entries.
 */
const latticeIndexCache = new WeakMap<
  ConceptLatticeResult,
  ReadonlyMap<ConceptId, ConceptClosureEntry>
>()

/**
 * O(1) indexed lookup for a concept's closure entry in a `ConceptLatticeResult`.
 */
export const getConceptClosureEntry = (
  lattice: ConceptLatticeResult,
  id: ConceptId,
): ConceptClosureEntry | undefined => {
  let index = latticeIndexCache.get(lattice)
  if (index === undefined) {
    const map = new Map<ConceptId, ConceptClosureEntry>()
    for (const entry of lattice.entries) {
      map.set(entry.conceptId, entry)
    }
    index = map
    latticeIndexCache.set(lattice, index)
  }
  return index.get(id)
}

/**
 * Pure ontology concept lattice decider (`ConceptLattice.decide`, `R = never`).
 * Validates acyclicity of the concept hierarchy using `effect/Graph` and computes
 * reflexive-transitive subtype closure ($\sqsubseteq^*$) and inherited role sets ($\text{roles}^*(c)$).
 */
export const decideConceptLattice = Effect.fn("ConceptLattice.decide")(function* (
  config: ConceptLatticeConfig,
): Effect.fn.Return<ConceptLatticeResult, ConceptLatticeCycleError, never> {
  // 1. Duplicate concept ID validation
  const seenIds = new Set<ConceptId>()
  for (const c of config.concepts) {
    if (seenIds.has(c.id)) {
      return yield* new ConceptLatticeCycleError({
        cycle: [c.id, c.id],
        reason: "duplicate-concept-id",
        message: `Duplicate concept ID in lattice: ${c.id}`,
      })
    }
    seenIds.add(c.id)
  }

  const conceptsById = new Map<ConceptId, ConceptSpec>()
  for (const c of config.concepts) {
    conceptsById.set(c.id, c)
  }

  // 2. Dangling supertype validation
  for (const c of config.concepts) {
    for (const supId of c.supertypes) {
      if (!conceptsById.has(supId)) {
        return yield* new ConceptLatticeCycleError({
          cycle: [c.id, supId],
          reason: "dangling-supertype",
          message: `Concept ${c.id} references unknown supertype ${supId}`,
        })
      }
    }
  }

  // 3. Cycle detection
  const detectedCycle = findCycleInConceptHierarchy(conceptsById)
  if (detectedCycle !== undefined) {
    return yield* new ConceptLatticeCycleError({
      cycle: [...detectedCycle],
      reason: "cycle",
      message: `Concept lattice contains a subtype cycle: ${detectedCycle.join(" -> ")}`,
    })
  }

  const nodeIdxById = new Map<ConceptId, Graph.NodeIndex>()
  const hierarchyGraph = Graph.directed<ConceptId, string>((mutable) => {
    for (const c of config.concepts) {
      nodeIdxById.set(c.id, Graph.addNode(mutable, c.id))
    }
    for (const c of config.concepts) {
      const subIdx = nodeIdxById.get(c.id)
      if (subIdx === undefined) continue
      for (const supId of c.supertypes) {
        const supIdx = nodeIdxById.get(supId)
        if (supIdx !== undefined) {
          // Edge supertype -> subtype so topological sort orders supertypes first
          Graph.addEdge(mutable, supIdx, subIdx, "subsumes")
        }
      }
    }
  })

  if (!Graph.isAcyclic(hierarchyGraph)) {
    const cycle = detectedCycle ?? []
    return yield* new ConceptLatticeCycleError({
      cycle: [...cycle],
      reason: "cycle",
      message: `Concept lattice contains a subtype cycle`,
    })
  }

  // Deterministic Kahn's topological sort (supertypes before subtypes)
  const inDegree = new Map<ConceptId, number>()
  const directSubtypes = new Map<ConceptId, Array<ConceptId>>()
  for (const c of config.concepts) {
    inDegree.set(c.id, 0)
    directSubtypes.set(c.id, [])
  }
  for (const c of config.concepts) {
    let validSupCount = 0
    for (const supId of c.supertypes) {
      if (conceptsById.has(supId)) {
        validSupCount += 1
        directSubtypes.get(supId)?.push(c.id)
      }
    }
    inDegree.set(c.id, validSupCount)
  }

  const ready: Array<ConceptId> = []
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      ready.push(id)
    }
  }
  ready.sort((a, b) => a.localeCompare(b))

  const topologicalOrder: Array<ConceptId> = []
  while (ready.length > 0) {
    const current = ready.shift()!
    topologicalOrder.push(current)
    const subs = directSubtypes.get(current) ?? []
    for (const subId of subs) {
      const nextDeg = (inDegree.get(subId) ?? 1) - 1
      inDegree.set(subId, nextDeg)
      if (nextDeg === 0) {
        ready.push(subId)
        ready.sort((a, b) => a.localeCompare(b))
      }
    }
  }

  // Compute reflexive-transitive supertypesClosure for each concept
  const supertypesClosureById = new Map<ConceptId, ReadonlyArray<ConceptId>>()
  const supertypesSetById = new Map<ConceptId, Set<ConceptId>>()
  for (const id of topologicalOrder) {
    const spec = conceptsById.get(id)!
    const closure = new Set<ConceptId>([id])
    for (const supId of spec.supertypes) {
      closure.add(supId)
      for (const ancestor of supertypesClosureById.get(supId) ?? []) {
        closure.add(ancestor)
      }
    }
    supertypesClosureById.set(id, Array.from(closure))
    supertypesSetById.set(id, closure)
  }

  // 4. Role Cardinality & Covariant Role Refinement Validation
  for (const c of config.concepts) {
    for (const cSpec of c.relatesRoles ?? []) {
      // Verify minCard >= 0 and (maxCard === null || minCard <= maxCard)
      if (cSpec.minCard < 0 || (cSpec.maxCard !== null && cSpec.minCard > cSpec.maxCard)) {
        return yield* new ConceptLatticeCycleError({
          cycle: [c.id, c.id],
          reason: "invalid-role-refinement",
          message: `Role '${cSpec.role}' on concept '${c.id}' has invalid cardinality: minCard (${cSpec.minCard}) must be <= maxCard (${cSpec.maxCard})`,
        })
      }
      // Verify every allowedPlayer exists in conceptsById
      for (const player of cSpec.allowedPlayers) {
        if (!conceptsById.has(player)) {
          return yield* new ConceptLatticeCycleError({
            cycle: [c.id, player],
            reason: "invalid-role-refinement",
            message: `Role '${cSpec.role}' on concept '${c.id}' references unknown allowedPlayer '${player}'`,
          })
        }
      }

      // Check refinement against supertypes
      for (const supId of supertypesClosureById.get(c.id) ?? []) {
        if (supId === c.id) continue
        const supSpec = conceptsById.get(supId)
        const matchedSupRoleSpec = supSpec?.relatesRoles?.find((r) => r.role === cSpec.role)
        if (matchedSupRoleSpec !== undefined) {
          // Cannot weaken lower bound: cSpec.minCard >= matchedSupRoleSpec.minCard
          if (cSpec.minCard < matchedSupRoleSpec.minCard) {
            return yield* new ConceptLatticeCycleError({
              cycle: [c.id, supId],
              reason: "invalid-role-refinement",
              message: `Concept '${c.id}' weakens lower cardinality bound for role '${cSpec.role}' (refined: ${cSpec.minCard}, supertype '${supId}': ${matchedSupRoleSpec.minCard})`,
            })
          }
          // Cannot widen upper bound: if matchedSupRoleSpec.maxCard !== null, then cSpec.maxCard !== null && cSpec.maxCard <= matchedSupRoleSpec.maxCard
          if (
            matchedSupRoleSpec.maxCard !== null &&
            (cSpec.maxCard === null || cSpec.maxCard > matchedSupRoleSpec.maxCard)
          ) {
            return yield* new ConceptLatticeCycleError({
              cycle: [c.id, supId],
              reason: "invalid-role-refinement",
              message: `Concept '${c.id}' widens upper cardinality bound for role '${cSpec.role}' (refined: ${cSpec.maxCard}, supertype '${supId}': ${matchedSupRoleSpec.maxCard})`,
            })
          }
          // Covariant allowedPlayers: every player in cSpec.allowedPlayers must be a subtype of (or equal to) at least one player in matchedSupRoleSpec.allowedPlayers
          for (const player of cSpec.allowedPlayers) {
            const playerSupertypes = supertypesSetById.get(player)
            const isSubtypeOfAllowed = matchedSupRoleSpec.allowedPlayers.some(
              (supPlayer) => playerSupertypes?.has(supPlayer) ?? false,
            )
            if (!isSubtypeOfAllowed) {
              return yield* new ConceptLatticeCycleError({
                cycle: [c.id, supId],
                reason: "invalid-role-refinement",
                message: `Concept '${c.id}' specifies incompatible allowedPlayer '${player}' for role '${cSpec.role}'; must be a subtype of supertype '${supId}' allowed players (${matchedSupRoleSpec.allowedPlayers.join(", ")})`,
              })
            }
          }
        }
      }
    }
  }

  // Compute reflexive-transitive subtypesClosure for each concept
  const subtypesClosureById = new Map<ConceptId, Set<ConceptId>>()
  for (const c of config.concepts) {
    subtypesClosureById.set(c.id, new Set<ConceptId>([c.id]))
  }
  for (const [subId, sups] of supertypesClosureById.entries()) {
    for (const supId of sups) {
      subtypesClosureById.get(supId)?.add(subId)
    }
  }

  // Compute inheritedPlayedRoles and inheritedRelatedRoles
  const entries: Array<ConceptClosureEntry> = []
  for (const c of config.concepts) {
    const sups = supertypesClosureById.get(c.id) ?? [c.id]
    const subs = Array.from(subtypesClosureById.get(c.id) ?? [c.id])

    const playedRoles = new Set<RoleName>()
    const relatedRolesMap = new Map<RoleName, RoleSpec>()

    // Traverse from most general ancestors down to `c` in topological order so `c`'s RoleSpec refines ancestor RoleSpec
    const supsSet = new Set(sups)
    const orderedAncestors = topologicalOrder.filter((id) => supsSet.has(id))
    for (const ancId of orderedAncestors) {
      const ancSpec = conceptsById.get(ancId)
      if (!ancSpec) continue
      for (const r of ancSpec.playsRoles) {
        playedRoles.add(r)
      }
      for (const relSpec of ancSpec.relatesRoles ?? []) {
        relatedRolesMap.set(relSpec.role, relSpec)
      }
    }

    entries.push({
      conceptId: c.id,
      kind: c.kind,
      supertypesClosure: [...sups],
      subtypesClosure: subs,
      inheritedPlayedRoles: Array.from(playedRoles),
      inheritedRelatedRoles: Array.from(relatedRolesMap.values()),
    })
  }

  const result: ConceptLatticeResult = {
    entries,
    topologicalOrder,
  }

  // Pre-populate index cache for O(1) lookups
  const index = new Map<ConceptId, ConceptClosureEntry>()
  for (const entry of entries) {
    index.set(entry.conceptId, entry)
  }
  latticeIndexCache.set(result, index)

  return result
})

/**
 * O(1) indexed check whether `subId` is a reflexive-transitive subtype of `supId`.
 */
export const isConceptSubtypeOf = (
  lattice: ConceptLatticeResult,
  subId: ConceptId,
  supId: ConceptId,
): boolean => {
  const entry = getConceptClosureEntry(lattice, subId)
  return entry !== undefined && entry.supertypesClosure.includes(supId)
}

/**
 * O(1) indexed check whether `conceptId` can play `role`.
 */
export const canConceptPlayRole = (
  lattice: ConceptLatticeResult,
  conceptId: ConceptId,
  role: RoleName,
): boolean => {
  const entry = getConceptClosureEntry(lattice, conceptId)
  return entry !== undefined && entry.inheritedPlayedRoles.includes(role)
}

/**
 * Pure helper validating relation role-playing incidence edges against the concept lattice.
 * Checks:
 * 1. The `relationTag` exists in `lattice` as a `"relation"` concept.
 * 2. Every `edge.role` is in `relationEntry.inheritedRelatedRoles`, `edge.entityTag` can play `edge.role`,
 *    and `edge.entityTag` is a subtype of at least one `allowedPlayer` in the `RoleSpec`.
 * 3. For each `RoleSpec` in `relationEntry.inheritedRelatedRoles`, the count of matching `roleEdges` satisfies
 *    `count >= roleSpec.minCard` and `(roleSpec.maxCard === null || count <= roleSpec.maxCard)`.
 *
 * Returns an array of human-readable violation strings (empty if valid).
 */
export const validateRelationRolesWithLattice = (
  lattice: ConceptLatticeResult,
  relationTag: string,
  roleEdges: ReadonlyArray<{ readonly role: string; readonly entityTag: string }>,
): ReadonlyArray<string> => {
  const relationConceptId = ConceptId.make(relationTag)
  const relationEntry = getConceptClosureEntry(lattice, relationConceptId)
  if (relationEntry === undefined || relationEntry.kind !== "relation") {
    return [`Unknown or non-relation concept tag '${relationTag}' in concept lattice`]
  }

  const roleSpecByRole = new Map<string, RoleSpec>()
  for (const spec of relationEntry.inheritedRelatedRoles) {
    roleSpecByRole.set(spec.role, spec)
  }

  const violations: Array<string> = []
  const roleCounts = new Map<string, number>()

  for (const edge of roleEdges) {
    const roleSpec = roleSpecByRole.get(edge.role)
    if (roleSpec === undefined) {
      violations.push(
        `Role '${edge.role}' is not a valid related role for relation '${relationTag}'`,
      )
      continue
    }

    roleCounts.set(edge.role, (roleCounts.get(edge.role) ?? 0) + 1)

    const entityConceptId = ConceptId.make(edge.entityTag)
    const entityEntry = getConceptClosureEntry(lattice, entityConceptId)

    if (entityEntry === undefined) {
      violations.push(
        `Entity tag '${edge.entityTag}' for role '${edge.role}' in relation '${relationTag}' is not a recognized concept in the lattice`,
      )
      continue
    }

    const roleName = RoleName.make(edge.role)
    if (!canConceptPlayRole(lattice, entityConceptId, roleName)) {
      violations.push(
        `Entity '${edge.entityTag}' cannot play role '${edge.role}' in relation '${relationTag}'`,
      )
    }

    const isAllowedPlayerSubtype = roleSpec.allowedPlayers.some((allowedPlayer) =>
      isConceptSubtypeOf(lattice, entityConceptId, allowedPlayer),
    )
    if (!isAllowedPlayerSubtype) {
      violations.push(
        `Entity '${edge.entityTag}' is not an allowed player for role '${edge.role}' in relation '${relationTag}' (allowed: ${roleSpec.allowedPlayers.join(", ")})`,
      )
    }
  }

  for (const roleSpec of relationEntry.inheritedRelatedRoles) {
    const count = roleCounts.get(roleSpec.role) ?? 0
    if (count < roleSpec.minCard) {
      violations.push(
        `Role '${roleSpec.role}' in relation '${relationTag}' violates minimum cardinality: required at least ${roleSpec.minCard}, but found ${count}`,
      )
    }
    if (roleSpec.maxCard !== null && count > roleSpec.maxCard) {
      violations.push(
        `Role '${roleSpec.role}' in relation '${relationTag}' violates maximum cardinality: required at most ${roleSpec.maxCard}, but found ${count}`,
      )
    }
  }

  return violations
}
