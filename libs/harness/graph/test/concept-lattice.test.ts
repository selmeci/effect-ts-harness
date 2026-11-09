import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import { match } from "ts-pattern"
import {
  canConceptPlayRole,
  ConceptId,
  type ConceptLatticeConfig,
  ConceptLatticeCycleError,
  getConceptClosureEntry,
  HARNESS_PERA_CONCEPT_LATTICE_CONFIG,
  isConceptSubtypeOf,
  RoleName,
  decideConceptLattice,
  validateRelationRolesWithLattice,
} from "../src/index.js"

const AcyclicChainItem = Schema.Struct({
  conceptSuffix: Schema.Literals(["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]),
  playedRole: Schema.Literals([
    "caller",
    "callee",
    "requires-service",
    "fails-with",
    "realizing-symbol",
  ]),
})

const AcyclicChainSpec = Schema.Array(AcyclicChainItem)

describe("ConceptLattice.decide (PERA Polymorphic Concept Hierarchy)", () => {
  it.effect(
    "computes reflexive-transitive subtype closure and inherited roles for HARNESS_PERA_CONCEPT_LATTICE_CONFIG",
    () =>
      Effect.gen(function* () {
        const result = yield* decideConceptLattice(HARNESS_PERA_CONCEPT_LATTICE_CONFIG)

        expect(result.topologicalOrder.length).toBe(
          HARNESS_PERA_CONCEPT_LATTICE_CONFIG.concepts.length,
        )

        const byId = new Map(result.entries.map((e) => [e.conceptId, e]))

        // EffectFn subtypes ExecutableArtifact -> CodeArtifact -> Artifact
        const effectFnEntry = byId.get(ConceptId.make("EffectFn"))
        expect(effectFnEntry).toBeDefined()
        expect(effectFnEntry?.supertypesClosure).toContain("EffectFn")
        expect(effectFnEntry?.supertypesClosure).toContain("ExecutableArtifact")
        expect(effectFnEntry?.supertypesClosure).toContain("CodeArtifact")
        expect(effectFnEntry?.supertypesClosure).toContain("Artifact")

        // EffectFn inherits caller, callee, exercised-span, realizing-symbol from supertypes
        expect(effectFnEntry?.inheritedPlayedRoles).toContain("caller")
        expect(effectFnEntry?.inheritedPlayedRoles).toContain("callee")
        expect(effectFnEntry?.inheritedPlayedRoles).toContain("realizing-symbol")
        expect(effectFnEntry?.inheritedPlayedRoles).toContain("exercised-span")
        expect(effectFnEntry?.inheritedPlayedRoles).toContain("specified-target")

        // EffectSignature inherits relations from SemanticRelation
        const sigEntry = byId.get(ConceptId.make("EffectSignature"))
        expect(sigEntry).toBeDefined()
        expect(sigEntry?.supertypesClosure).toContain("EffectSignature")
        expect(sigEntry?.supertypesClosure).toContain("SemanticRelation")
        const sigRoleNames = sigEntry?.inheritedRelatedRoles.map((r) => r.role) ?? []
        expect(sigRoleNames).toContain("caller")
        expect(sigRoleNames).toContain("callee")
        expect(sigRoleNames).toContain("requires-service")
        expect(sigRoleNames).toContain("fails-with")
      }),
  )

  it.effect(
    "preserves subtype RoleSpec refinement in diamond DAG concept hierarchies and rejects 1-node self-cycles",
    () =>
      Effect.gen(function* () {
        const diamondConfig: ConceptLatticeConfig = {
          concepts: [
            {
              id: ConceptId.make("Artifact"),
              kind: "entity",
              supertypes: [],
              playsRoles: [],
            },
            {
              id: ConceptId.make("EffectFn"),
              kind: "entity",
              supertypes: [ConceptId.make("Artifact")],
              playsRoles: [],
            },
            {
              id: ConceptId.make("RootRel"),
              kind: "relation",
              supertypes: [],
              playsRoles: [],
              relatesRoles: [
                {
                  role: RoleName.make("caller"),
                  minCard: 0,
                  maxCard: null,
                  allowedPlayers: [ConceptId.make("Artifact")],
                },
              ],
            },
            {
              id: ConceptId.make("GenericBranchRel"),
              kind: "relation",
              supertypes: [ConceptId.make("RootRel")],
              playsRoles: [],
              relatesRoles: [],
            },
            {
              id: ConceptId.make("RefinedBranchRel"),
              kind: "relation",
              supertypes: [ConceptId.make("RootRel")],
              playsRoles: [],
              relatesRoles: [
                {
                  role: RoleName.make("caller"),
                  minCard: 1,
                  maxCard: 1,
                  allowedPlayers: [ConceptId.make("EffectFn")],
                },
              ],
            },
            {
              id: ConceptId.make("LeafRel"),
              kind: "relation",
              supertypes: [
                ConceptId.make("GenericBranchRel"),
                ConceptId.make("RefinedBranchRel"),
              ],
              playsRoles: [],
              relatesRoles: [],
            },
          ],
        }

        const diamondRes = yield* decideConceptLattice(diamondConfig)
        const leafEntry = diamondRes.entries.find(
          (e) => e.conceptId === ConceptId.make("LeafRel"),
        )
        const callerRoleSpec = leafEntry?.inheritedRelatedRoles.find(
          (r) => r.role === RoleName.make("caller"),
        )
        expect(callerRoleSpec?.minCard).toBe(1)
        expect(callerRoleSpec?.maxCard).toBe(1)

        // 1-node self-cycle
        const selfCycleExit = yield* Effect.exit(
          decideConceptLattice({
            concepts: [
              {
                id: ConceptId.make("SelfConcept"),
                kind: "entity",
                supertypes: [ConceptId.make("SelfConcept")],
                playsRoles: [],
              },
            ],
          }),
        )
        expect(Exit.isFailure(selfCycleExit)).toBe(true)
        const selfCycleError = match(selfCycleExit)
          .with({ _tag: "Failure" }, ({ cause }) => Cause.findErrorOption(cause))
          .with({ _tag: "Success" }, () => {
            throw new Error("Expected failure")
          })
          .exhaustive()
        match(selfCycleError)
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value).toBeInstanceOf(ConceptLatticeCycleError)
            expect(value.reason).toBe("cycle")
            expect(value.cycle).toEqual(["SelfConcept", "SelfConcept"])
          })
          .with({ _tag: "None" }, () => {
            throw new Error("Expected ConceptLatticeCycleError")
          })
          .exhaustive()
      }),
  )

  it.effect(
    "fails with ConceptLatticeCycleError when the subtype hierarchy contains a direct or transitive cycle",
    () =>
      Effect.gen(function* () {
        const cyclicConfig: ConceptLatticeConfig = {
          concepts: [
            {
              id: ConceptId.make("ConceptA"),
              kind: "entity",
              supertypes: [ConceptId.make("ConceptC")],
              playsRoles: [RoleName.make("caller")],
            },
            {
              id: ConceptId.make("ConceptB"),
              kind: "entity",
              supertypes: [ConceptId.make("ConceptA")],
              playsRoles: [RoleName.make("callee")],
            },
            {
              id: ConceptId.make("ConceptC"),
              kind: "entity",
              supertypes: [ConceptId.make("ConceptB")],
              playsRoles: [],
            },
          ],
        }

        const exit = yield* Effect.exit(decideConceptLattice(cyclicConfig))
        const errorOpt = match(exit)
          .with({ _tag: "Failure" }, ({ cause }) => Cause.findErrorOption(cause))
          .with({ _tag: "Success" }, () => {
            throw new Error("Expected decideConceptLattice to fail on cyclic hierarchy")
          })
          .exhaustive()

        match(errorOpt)
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value).toBeInstanceOf(ConceptLatticeCycleError)
            expect(value._tag).toBe("ConceptLatticeCycleError")
            expect(value.reason).toBe("cycle")
            expect(value.cycle.length).toBeGreaterThanOrEqual(2)
            expect(value.message).toContain("Concept lattice contains a subtype cycle")
          })
          .with({ _tag: "None" }, () => {
            throw new Error("Expected ConceptLatticeCycleError in Failure cause")
          })
          .exhaustive()
      }),
  )

  it.effect(
    "fails with ConceptLatticeCycleError (reason: 'dangling-supertype') when a concept references an unknown supertype",
    () =>
      Effect.gen(function* () {
        const config: ConceptLatticeConfig = {
          concepts: [
            {
              id: ConceptId.make("Child"),
              kind: "entity",
              supertypes: [ConceptId.make("UnknownParent")],
              playsRoles: [],
            },
          ],
        }
        const exit = yield* Effect.exit(decideConceptLattice(config))
        expect(Exit.isFailure(exit)).toBe(true)
        const errorOpt = match(exit)
          .with({ _tag: "Failure" }, ({ cause }) => Cause.findErrorOption(cause))
          .with({ _tag: "Success" }, () => {
            throw new Error("Expected decideConceptLattice to fail")
          })
          .exhaustive()

        match(errorOpt)
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value).toBeInstanceOf(ConceptLatticeCycleError)
            expect(value.reason).toBe("dangling-supertype")
            expect(value.cycle).toEqual(["Child", "UnknownParent"])
            expect(value.message).toContain("references unknown supertype UnknownParent")
          })
          .with({ _tag: "None" }, () => {
            throw new Error("Expected ConceptLatticeCycleError")
          })
          .exhaustive()
      }),
  )

  it.effect(
    "fails with ConceptLatticeCycleError (reason: 'duplicate-concept-id') on duplicate concept IDs",
    () =>
      Effect.gen(function* () {
        const config: ConceptLatticeConfig = {
          concepts: [
            {
              id: ConceptId.make("DupeNode"),
              kind: "entity",
              supertypes: [],
              playsRoles: [],
            },
            {
              id: ConceptId.make("DupeNode"),
              kind: "entity",
              supertypes: [],
              playsRoles: [],
            },
          ],
        }
        const exit = yield* Effect.exit(decideConceptLattice(config))
        expect(Exit.isFailure(exit)).toBe(true)
        const errorOpt = match(exit)
          .with({ _tag: "Failure" }, ({ cause }) => Cause.findErrorOption(cause))
          .with({ _tag: "Success" }, () => {
            throw new Error("Expected decideConceptLattice to fail")
          })
          .exhaustive()

        match(errorOpt)
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value).toBeInstanceOf(ConceptLatticeCycleError)
            expect(value.reason).toBe("duplicate-concept-id")
            expect(value.cycle).toEqual(["DupeNode", "DupeNode"])
            expect(value.message).toContain("Duplicate concept ID in lattice: DupeNode")
          })
          .with({ _tag: "None" }, () => {
            throw new Error("Expected ConceptLatticeCycleError")
          })
          .exhaustive()
      }),
  )

  describe("Invalid role refinement validation (reason: 'invalid-role-refinement')", () => {
    it.effect("rejects minCard > maxCard on a single concept", () =>
      Effect.gen(function* () {
        const config: ConceptLatticeConfig = {
          concepts: [
            {
              id: ConceptId.make("EntityNode"),
              kind: "entity",
              supertypes: [],
              playsRoles: [],
            },
            {
              id: ConceptId.make("BadRel"),
              kind: "relation",
              supertypes: [],
              playsRoles: [],
              relatesRoles: [
                {
                  role: RoleName.make("caller"),
                  minCard: 5,
                  maxCard: 2,
                  allowedPlayers: [ConceptId.make("EntityNode")],
                },
              ],
            },
          ],
        }
        const exit = yield* Effect.exit(decideConceptLattice(config))
        expect(Exit.isFailure(exit)).toBe(true)
        const error = match(exit)
          .with({ _tag: "Failure" }, ({ cause }) => Cause.findErrorOption(cause))
          .with({ _tag: "Success" }, () => {
            throw new Error("Expected failure")
          })
          .exhaustive()
        match(error)
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value).toBeInstanceOf(ConceptLatticeCycleError)
            expect(value.reason).toBe("invalid-role-refinement")
            expect(value.message).toContain("invalid cardinality")
          })
          .with({ _tag: "None" }, () => {
            throw new Error("Expected ConceptLatticeCycleError")
          })
          .exhaustive()
      }),
    )

    it.effect("rejects unknown allowedPlayer in RoleSpec", () =>
      Effect.gen(function* () {
        const config: ConceptLatticeConfig = {
          concepts: [
            {
              id: ConceptId.make("BadRel"),
              kind: "relation",
              supertypes: [],
              playsRoles: [],
              relatesRoles: [
                {
                  role: RoleName.make("caller"),
                  minCard: 0,
                  maxCard: null,
                  allowedPlayers: [ConceptId.make("UnknownConcept")],
                },
              ],
            },
          ],
        }
        const exit = yield* Effect.exit(decideConceptLattice(config))
        expect(Exit.isFailure(exit)).toBe(true)
        const error = match(exit)
          .with({ _tag: "Failure" }, ({ cause }) => Cause.findErrorOption(cause))
          .with({ _tag: "Success" }, () => {
            throw new Error("Expected failure")
          })
          .exhaustive()
        match(error)
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value).toBeInstanceOf(ConceptLatticeCycleError)
            expect(value.reason).toBe("invalid-role-refinement")
            expect(value.cycle).toEqual(["BadRel", "UnknownConcept"])
            expect(value.message).toContain("references unknown allowedPlayer 'UnknownConcept'")
          })
          .with({ _tag: "None" }, () => {
            throw new Error("Expected ConceptLatticeCycleError")
          })
          .exhaustive()
      }),
    )

    it.effect("rejects subtype widening maxCard (e.g. supertype has maxCard 1, subtype has maxCard 2 or null)", () =>
      Effect.gen(function* () {
        const config: ConceptLatticeConfig = {
          concepts: [
            {
              id: ConceptId.make("PlayerNode"),
              kind: "entity",
              supertypes: [],
              playsRoles: [],
            },
            {
              id: ConceptId.make("ParentRel"),
              kind: "relation",
              supertypes: [],
              playsRoles: [],
              relatesRoles: [
                {
                  role: RoleName.make("caller"),
                  minCard: 1,
                  maxCard: 1,
                  allowedPlayers: [ConceptId.make("PlayerNode")],
                },
              ],
            },
            {
              id: ConceptId.make("ChildRel"),
              kind: "relation",
              supertypes: [ConceptId.make("ParentRel")],
              playsRoles: [],
              relatesRoles: [
                {
                  role: RoleName.make("caller"),
                  minCard: 1,
                  maxCard: 2,
                  allowedPlayers: [ConceptId.make("PlayerNode")],
                },
              ],
            },
          ],
        }
        const exit = yield* Effect.exit(decideConceptLattice(config))
        expect(Exit.isFailure(exit)).toBe(true)
        const error = match(exit)
          .with({ _tag: "Failure" }, ({ cause }) => Cause.findErrorOption(cause))
          .with({ _tag: "Success" }, () => {
            throw new Error("Expected failure")
          })
          .exhaustive()
        match(error)
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value).toBeInstanceOf(ConceptLatticeCycleError)
            expect(value.reason).toBe("invalid-role-refinement")
            expect(value.cycle).toEqual(["ChildRel", "ParentRel"])
            expect(value.message).toContain("widens upper cardinality bound")
          })
          .with({ _tag: "None" }, () => {
            throw new Error("Expected ConceptLatticeCycleError")
          })
          .exhaustive()
      }),
    )

    it.effect("rejects subtype lowering minCard (e.g. supertype has minCard 2, subtype has minCard 1)", () =>
      Effect.gen(function* () {
        const config: ConceptLatticeConfig = {
          concepts: [
            {
              id: ConceptId.make("PlayerNode"),
              kind: "entity",
              supertypes: [],
              playsRoles: [],
            },
            {
              id: ConceptId.make("ParentRel"),
              kind: "relation",
              supertypes: [],
              playsRoles: [],
              relatesRoles: [
                {
                  role: RoleName.make("caller"),
                  minCard: 2,
                  maxCard: null,
                  allowedPlayers: [ConceptId.make("PlayerNode")],
                },
              ],
            },
            {
              id: ConceptId.make("ChildRel"),
              kind: "relation",
              supertypes: [ConceptId.make("ParentRel")],
              playsRoles: [],
              relatesRoles: [
                {
                  role: RoleName.make("caller"),
                  minCard: 1,
                  maxCard: null,
                  allowedPlayers: [ConceptId.make("PlayerNode")],
                },
              ],
            },
          ],
        }
        const exit = yield* Effect.exit(decideConceptLattice(config))
        expect(Exit.isFailure(exit)).toBe(true)
        const error = match(exit)
          .with({ _tag: "Failure" }, ({ cause }) => Cause.findErrorOption(cause))
          .with({ _tag: "Success" }, () => {
            throw new Error("Expected failure")
          })
          .exhaustive()
        match(error)
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value).toBeInstanceOf(ConceptLatticeCycleError)
            expect(value.reason).toBe("invalid-role-refinement")
            expect(value.cycle).toEqual(["ChildRel", "ParentRel"])
            expect(value.message).toContain("weakens lower cardinality bound")
          })
          .with({ _tag: "None" }, () => {
            throw new Error("Expected ConceptLatticeCycleError")
          })
          .exhaustive()
      }),
    )

    it.effect("rejects subtype adding incompatible allowedPlayers", () =>
      Effect.gen(function* () {
        const config: ConceptLatticeConfig = {
          concepts: [
            {
              id: ConceptId.make("AllowedParent"),
              kind: "entity",
              supertypes: [],
              playsRoles: [],
            },
            {
              id: ConceptId.make("UnrelatedEntity"),
              kind: "entity",
              supertypes: [],
              playsRoles: [],
            },
            {
              id: ConceptId.make("ParentRel"),
              kind: "relation",
              supertypes: [],
              playsRoles: [],
              relatesRoles: [
                {
                  role: RoleName.make("caller"),
                  minCard: 0,
                  maxCard: null,
                  allowedPlayers: [ConceptId.make("AllowedParent")],
                },
              ],
            },
            {
              id: ConceptId.make("ChildRel"),
              kind: "relation",
              supertypes: [ConceptId.make("ParentRel")],
              playsRoles: [],
              relatesRoles: [
                {
                  role: RoleName.make("caller"),
                  minCard: 0,
                  maxCard: null,
                  allowedPlayers: [ConceptId.make("UnrelatedEntity")],
                },
              ],
            },
          ],
        }
        const exit = yield* Effect.exit(decideConceptLattice(config))
        expect(Exit.isFailure(exit)).toBe(true)
        const error = match(exit)
          .with({ _tag: "Failure" }, ({ cause }) => Cause.findErrorOption(cause))
          .with({ _tag: "Success" }, () => {
            throw new Error("Expected failure")
          })
          .exhaustive()
        match(error)
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value).toBeInstanceOf(ConceptLatticeCycleError)
            expect(value.reason).toBe("invalid-role-refinement")
            expect(value.cycle).toEqual(["ChildRel", "ParentRel"])
            expect(value.message).toContain("incompatible allowedPlayer 'UnrelatedEntity'")
          })
          .with({ _tag: "None" }, () => {
            throw new Error("Expected ConceptLatticeCycleError")
          })
          .exhaustive()
      }),
    )
  })

  it.effect("detects exact cycle in a second disconnected component without fabricating [first, first]", () =>
    Effect.gen(function* () {
      const config: ConceptLatticeConfig = {
        concepts: [
          // Component 1: acyclic
          {
            id: ConceptId.make("FirstComponentRoot"),
            kind: "entity",
            supertypes: [],
            playsRoles: [],
          },
          {
            id: ConceptId.make("FirstComponentChild"),
            kind: "entity",
            supertypes: [ConceptId.make("FirstComponentRoot")],
            playsRoles: [],
          },
          // Component 2: cycle between CycleNodeA and CycleNodeB
          {
            id: ConceptId.make("CycleNodeA"),
            kind: "entity",
            supertypes: [ConceptId.make("CycleNodeB")],
            playsRoles: [],
          },
          {
            id: ConceptId.make("CycleNodeB"),
            kind: "entity",
            supertypes: [ConceptId.make("CycleNodeA")],
            playsRoles: [],
          },
        ],
      }
      const exit = yield* Effect.exit(decideConceptLattice(config))
      expect(Exit.isFailure(exit)).toBe(true)
      const error = match(exit)
        .with({ _tag: "Failure" }, ({ cause }) => Cause.findErrorOption(cause))
        .with({ _tag: "Success" }, () => {
          throw new Error("Expected failure")
        })
        .exhaustive()
      match(error)
        .with({ _tag: "Some" }, ({ value }) => {
          expect(value).toBeInstanceOf(ConceptLatticeCycleError)
          expect(value.reason).toBe("cycle")
          // Must NOT be ["FirstComponentRoot", "FirstComponentRoot"]
          expect(value.cycle).not.toEqual(["FirstComponentRoot", "FirstComponentRoot"])
          // Must contain the actual cycle nodes
          expect(value.cycle.length).toBe(3)
          expect(value.cycle).toContain("CycleNodeA")
          expect(value.cycle).toContain("CycleNodeB")
        })
        .with({ _tag: "None" }, () => {
          throw new Error("Expected ConceptLatticeCycleError")
        })
        .exhaustive()
    }),
  )

  describe("validateRelationRolesWithLattice", () => {
    it.effect("validates valid relation edges, unknown roles, wrong player concepts, and cardinality violations", () =>
      Effect.gen(function* () {
        const lattice = yield* decideConceptLattice(HARNESS_PERA_CONCEPT_LATTICE_CONFIG)

        // 1. Valid relation
        const validViolations = validateRelationRolesWithLattice(lattice, "EffectSignature", [
          { role: "caller", entityTag: "EffectFn" },
          { role: "callee", entityTag: "EffectFn" },
          { role: "requires-service", entityTag: "ServiceTag" },
        ])
        expect(validViolations).toEqual([])

        // 2. Unknown role
        const unknownRoleViolations = validateRelationRolesWithLattice(lattice, "EffectSignature", [
          { role: "caller", entityTag: "EffectFn" },
          { role: "non-existent-role", entityTag: "EffectFn" },
        ])
        expect(unknownRoleViolations.length).toBeGreaterThanOrEqual(1)
        expect(unknownRoleViolations[0]).toContain("is not a valid related role")

        // 3. Wrong player concept (cannot play role and not allowed player)
        const wrongPlayerViolations = validateRelationRolesWithLattice(lattice, "EffectSignature", [
          { role: "caller", entityTag: "PatternDoc" },
        ])
        expect(wrongPlayerViolations.length).toBeGreaterThanOrEqual(1)
        expect(
          wrongPlayerViolations.some(
            (v) => v.includes("cannot play role") || v.includes("not an allowed player"),
          ),
        ).toBe(true)

        // 4. Min cardinality violation (EffectSignature requires at least 1 caller)
        const minCardViolations = validateRelationRolesWithLattice(lattice, "EffectSignature", [
          { role: "callee", entityTag: "EffectFn" },
        ])
        expect(minCardViolations.length).toBeGreaterThanOrEqual(1)
        expect(minCardViolations.some((v) => v.includes("minimum cardinality"))).toBe(true)

        // 5. Max cardinality violation (EffectSignature allows at most 1 caller)
        const maxCardViolations = validateRelationRolesWithLattice(lattice, "EffectSignature", [
          { role: "caller", entityTag: "EffectFn" },
          { role: "caller", entityTag: "EffectFn" },
        ])
        expect(maxCardViolations.length).toBeGreaterThanOrEqual(1)
        expect(maxCardViolations.some((v) => v.includes("maximum cardinality"))).toBe(true)

        // 6. Non-relation concept tag
        const nonRelViolations = validateRelationRolesWithLattice(lattice, "EffectFn", [])
        expect(nonRelViolations.length).toBe(1)
        expect(nonRelViolations[0]).toContain("Unknown or non-relation")
      }),
    )
  })

  it.effect("golden consistency: every EntityNode tag and RelationNode tag is present in HARNESS_PERA_CONCEPT_LATTICE_CONFIG", () =>
    Effect.gen(function* () {
      const ENTITY_TAGS = [
        "EffectFn",
        "ServiceTag",
        "ServiceLayer",
        "TaggedError",
        "SchemaDef",
        "VitestCase",
        "PatternDoc",
        "AdrDoc",
        "EarsSpec",
      ] as const

      const RELATION_TAGS = [
        "EffectSignature",
        "LayerFlow",
        "TraceabilityTuple",
        "HttpEndpointTuple",
        "MigrationTuple",
      ] as const

      const lattice = yield* decideConceptLattice(HARNESS_PERA_CONCEPT_LATTICE_CONFIG)
      const conceptMap = new Map(lattice.entries.map((e) => [e.conceptId, e]))

      for (const tag of ENTITY_TAGS) {
        const entry = conceptMap.get(ConceptId.make(tag))
        expect(entry).toBeDefined()
        expect(entry?.kind).toBe("entity")
      }

      for (const tag of RELATION_TAGS) {
        const entry = conceptMap.get(ConceptId.make(tag))
        expect(entry).toBeDefined()
        expect(entry?.kind).toBe("relation")
      }

      // Verify specified-target role on Artifact and TraceabilityTuple
      const artifactEntry = conceptMap.get(ConceptId.make("Artifact"))
      expect(artifactEntry?.inheritedPlayedRoles).toContain("specified-target")

      const earsEntry = conceptMap.get(ConceptId.make("EarsSpec"))
      expect(earsEntry?.inheritedPlayedRoles).toContain("specified-target")

      const traceEntry = conceptMap.get(ConceptId.make("TraceabilityTuple"))
      const specifiedTargetSpec = traceEntry?.inheritedRelatedRoles.find(
        (r) => r.role === RoleName.make("specified-target"),
      )
      expect(specifiedTargetSpec).toBeDefined()
      expect(specifiedTargetSpec?.minCard).toBe(0)
      expect(specifiedTargetSpec?.maxCard).toBeNull()
      expect(specifiedTargetSpec?.allowedPlayers).toContain("Artifact")
    }),
  )

  it.effect("indexes lattice lookups with getConceptClosureEntry, isConceptSubtypeOf, and canConceptPlayRole", () =>
    Effect.gen(function* () {
      const lattice = yield* decideConceptLattice(HARNESS_PERA_CONCEPT_LATTICE_CONFIG)

      const entry = getConceptClosureEntry(lattice, ConceptId.make("EffectFn"))
      expect(entry).toBeDefined()
      expect(entry?.conceptId).toBe("EffectFn")

      expect(isConceptSubtypeOf(lattice, ConceptId.make("EffectFn"), ConceptId.make("Artifact"))).toBe(true)
      expect(isConceptSubtypeOf(lattice, ConceptId.make("Artifact"), ConceptId.make("EffectFn"))).toBe(false)

      expect(canConceptPlayRole(lattice, ConceptId.make("EffectFn"), RoleName.make("caller"))).toBe(true)
      expect(canConceptPlayRole(lattice, ConceptId.make("ServiceTag"), RoleName.make("caller"))).toBe(false)
    }),
  )

  it.effect.prop(
    "preserves reflexivity, transitivity, and monotonic role inheritance across arbitrary DAG concept chains",
    [AcyclicChainSpec],
    ([items]) =>
      Effect.gen(function* () {
        const uniqueItems: Array<(typeof items)[number]> = []
        const seen = new Set<string>()
        for (const item of items) {
          if (!seen.has(item.conceptSuffix)) {
            seen.add(item.conceptSuffix)
            uniqueItems.push(item)
          }
        }

        const config: ConceptLatticeConfig = {
          concepts: [
            {
              id: ConceptId.make("RootConcept"),
              kind: "entity",
              supertypes: [],
              playsRoles: [RoleName.make("governing-adr")],
            },
            ...uniqueItems.map((item, idx) => ({
              id: ConceptId.make(`Node_${item.conceptSuffix}`),
              kind: "entity" as const,
              supertypes: [
                idx === 0
                  ? ConceptId.make("RootConcept")
                  : ConceptId.make(`Node_${uniqueItems[idx - 1]?.conceptSuffix ?? "RootConcept"}`),
              ],
              playsRoles: [RoleName.make(item.playedRole)],
            })),
          ],
        }

        const exit = yield* Effect.exit(decideConceptLattice(config))
        expect(Exit.isSuccess(exit)).toBe(true)
        const result = match(exit)
          .with({ _tag: "Success" }, ({ value }) => value)
          .with({ _tag: "Failure" }, () => {
            throw new Error("Unexpected failure on DAG concept lattice")
          })
          .exhaustive()

        const byId = new Map(result.entries.map((e) => [e.conceptId, e]))

        for (const concept of config.concepts) {
          const entry = byId.get(concept.id)
          const supers = entry?.supertypesClosure ?? []
          // Reflexivity
          expect(supers).toContain(concept.id)
          expect(supers).toContain("RootConcept")

          const myRoles = new Set(entry?.inheritedPlayedRoles ?? [])
          expect(myRoles.has(RoleName.make("governing-adr"))).toBe(true)

          // Monotonic role inheritance: every supertype's roles are a subset of subtype's roles
          for (const superId of supers) {
            const superRoles = byId.get(superId)?.inheritedPlayedRoles ?? []
            for (const r of superRoles) {
              expect(myRoles.has(r)).toBe(true)
            }
          }
        }
      }),
  )
})

