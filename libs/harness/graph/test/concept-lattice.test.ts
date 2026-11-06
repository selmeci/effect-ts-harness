import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import { match } from "ts-pattern"
import {
  ConceptId,
  type ConceptLatticeConfig,
  ConceptLatticeCycleError,
  HARNESS_PERA_CONCEPT_LATTICE_CONFIG,
  RoleName,
  decideConceptLattice,
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
            expect(value.cycle.length).toBeGreaterThanOrEqual(2)
            expect(value.message).toContain("Concept lattice contains a subtype cycle")
          })
          .with({ _tag: "None" }, () => {
            throw new Error("Expected ConceptLatticeCycleError in Failure cause")
          })
          .exhaustive()
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
