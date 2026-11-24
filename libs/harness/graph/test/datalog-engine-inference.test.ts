import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Schema } from "effect"
import { match } from "ts-pattern"
import {
  ConfidenceMillis,
  DatalogFilePath,
  DatalogRuleId,
  DatalogSession,
  NodeKey,
  PlaysRoleEdge,
  ProofHeight,
  ProofId,
  RelationId,
  RoleName,
  STANDARD_DATALOG_RULES,
  buildHarnessGraph,
  decideGraphInference,
  flixConfidenceReducer,
  isBipartitePlaysRoleIds,
  minHeightReducer,
  stepDatalogFileDelta,
} from "../src/index.js"
import { runGraphInferencePipeline } from "../src/datalog/stratum-3-completion-and-holes.js"

describe("GraphInfer.decide (Antipatterns, Proof Provenance, Lattices & DatalogSession Deltas)", () => {
  it.effect(
    "detects impure-reducer (Order.evolve requiring a service) as INF-05 and domain-requires-cloud-binding (Order.checkout requiring CloudflareKV) as INF-04",
    () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/sample/domain/src/order.ts#evolve",
              spanName: "Order.evolve",
              file: "libs/sample/domain/src/order.ts",
              line: 10,
              packageTag: "domain",
              successType: "OrderState",
              isStub: false,
            },
            {
              qualname: "libs/sample/domain/src/order.ts#checkout",
              spanName: "Order.checkout",
              file: "libs/sample/domain/src/order.ts",
              line: 30,
              packageTag: "domain",
              successType: "void",
              isStub: false,
            },
          ],
          services: [
            {
              tagId: "OrderRepo",
              name: "OrderRepo",
              packageTag: "service",
              file: "libs/sample/service/src/order-repo.ts",
            },
            {
              tagId: "CloudflareKV",
              name: "CloudflareKV",
              packageTag: "service",
              file: "libs/sample/service/src/kv.ts",
            },
          ],
          requiresService: [
            {
              callerQualname: "libs/sample/domain/src/order.ts#evolve",
              tagId: "OrderRepo",
            },
            {
              callerQualname: "libs/sample/domain/src/order.ts#checkout",
              tagId: "CloudflareKV",
            },
          ],
        })

        const res = yield* decideGraphInference(graph)

        const impureReducer = res.antiPatterns.find(
          (ap) =>
            ap.ruleId === "impure-reducer" &&
            ap.nodeKey === NodeKey.make("EffectFn:libs/sample/domain/src/order.ts#evolve"),
        )
        expect(impureReducer).toBeDefined()
        expect(impureReducer?.datalogRuleId).toBe(DatalogRuleId.make("INF-05"))
        expect(impureReducer?.targetKey).toBe(NodeKey.make("ServiceTag:OrderRepo"))
        expect(impureReducer?.message).toContain("reducer (.evolve/.fold)")

        const domainCloudBinding = res.antiPatterns.find(
          (ap) =>
            ap.ruleId === "domain-requires-cloud-binding" &&
            ap.nodeKey === NodeKey.make("EffectFn:libs/sample/domain/src/order.ts#checkout"),
        )
        expect(domainCloudBinding).toBeDefined()
        expect(domainCloudBinding?.datalogRuleId).toBe(DatalogRuleId.make("INF-04"))
        expect(domainCloudBinding?.targetKey).toBe(NodeKey.make("ServiceTag:CloudflareKV"))
        expect(domainCloudBinding?.message).toContain("cloud binding")
      }),
  )

  it.effect(
    "F-34: caughtErrors on EffectFnNode suppresses transitive EffectiveFailsWith (INF-02) and COMP-01 suggestions",
    () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/sample/domain/src/order.ts#caller",
              spanName: "Order.caller",
              file: "libs/sample/domain/src/order.ts",
              line: 1,
              packageTag: "domain",
              successType: "void",
              caughtErrors: ["HandledError"],
              isStub: false,
            },
            {
              qualname: "libs/sample/domain/src/order.ts#callee",
              spanName: "Order.callee",
              file: "libs/sample/domain/src/order.ts",
              line: 20,
              packageTag: "domain",
              successType: "void",
              isStub: false,
            },
          ],
          errors: [
            {
              errorTag: "HandledError",
              file: "libs/sample/contract/src/errors.ts",
            },
            {
              errorTag: "UnhandledError",
              file: "libs/sample/contract/src/errors.ts",
            },
          ],
          tracedCalls: [
            {
              callerQualname: "libs/sample/domain/src/order.ts#caller",
              calleeQualname: "libs/sample/domain/src/order.ts#callee",
              callCount: 1,
              receiverLayer: null,
            },
          ],
          failsWith: [
            {
              callerQualname: "libs/sample/domain/src/order.ts#callee",
              errorTag: "HandledError",
            },
            {
              callerQualname: "libs/sample/domain/src/order.ts#callee",
              errorTag: "UnhandledError",
            },
          ],
        })

        const res = yield* decideGraphInference(graph)

        const callerKey = NodeKey.make("EffectFn:libs/sample/domain/src/order.ts#caller")
        const handledKey = NodeKey.make("TaggedError:HandledError")
        const unhandledKey = NodeKey.make("TaggedError:UnhandledError")

        const hasHandled = res.effectiveFailsWith.some(
          (f) => f.callerKey === callerKey && f.errorKey === handledKey,
        )
        const hasUnhandled = res.effectiveFailsWith.some(
          (f) => f.callerKey === callerKey && f.errorKey === unhandledKey,
        )
        expect(hasHandled).toBe(false)
        expect(hasUnhandled).toBe(true)

        const comp01ForHandled = res.suggestedEdges.some(
          (e) =>
            e.ruleId === DatalogRuleId.make("COMP-01") &&
            e.sourceEntityKey === callerKey &&
            e.targetEntityKey === handledKey,
        )
        expect(comp01ForHandled).toBe(false)

        const comp01ForUnhandled = res.suggestedEdges.some(
          (e) =>
            e.ruleId === DatalogRuleId.make("COMP-01") &&
            e.sourceEntityKey === callerKey &&
            e.targetEntityKey === unhandledKey,
        )
        expect(comp01ForUnhandled).toBe(true)
      }),
  )

  it("F-20: Z-set negative weight retraction removes tuples with net multiplicity <= 0 in minHeightReducer and flixConfidenceReducer", () => {
    const itemA = {
      proofHeight: ProofHeight.make(2),
      ruleId: DatalogRuleId.make("INF-01"),
      viaIntermediateKey: NodeKey.make("EffectFn:a"),
    }
    const itemB = {
      proofHeight: ProofHeight.make(3),
      ruleId: DatalogRuleId.make("INF-01"),
      viaIntermediateKey: NodeKey.make("EffectFn:b"),
    }

    // Net multiplicity = 0 -> retracted
    expect(
      minHeightReducer([
        [itemA, 1],
        [itemA, -1],
      ]),
    ).toEqual([])

    // Net multiplicity < 0 -> retracted
    expect(
      minHeightReducer([
        [itemA, 1],
        [itemA, -2],
      ]),
    ).toEqual([])

    // Net multiplicity = 0 on one item while other has net > 0 -> only positive item retained
    const mixedHeight = minHeightReducer([
      [itemA, 1],
      [itemA, -1],
      [itemB, 1],
    ])
    expect(mixedHeight).toHaveLength(1)
    expect(mixedHeight[0]?.[0].viaIntermediateKey).toBe(NodeKey.make("EffectFn:b"))

    const flixItem1 = {
      confidenceMillis: ConfidenceMillis.make(800),
      parentProofIds: [ProofId.make("proof:1")],
    }
    const flixItem2 = {
      confidenceMillis: ConfidenceMillis.make(900),
      parentProofIds: [ProofId.make("proof:2")],
    }

    // Flix net <= 0 retraction
    expect(
      flixConfidenceReducer([
        [flixItem1, 1],
        [flixItem1, -1],
      ]),
    ).toEqual([])
    expect(
      flixConfidenceReducer([
        [flixItem1, 1],
        [flixItem1, -3],
      ]),
    ).toEqual([])

    // Flix mixed retraction
    const mixedFlix = flixConfidenceReducer([
      [flixItem1, 1],
      [flixItem1, -1],
      [flixItem2, 1],
    ])
    expect(mixedFlix).toHaveLength(1)
    expect(mixedFlix[0]?.[0].confidenceMillis).toBe(ConfidenceMillis.make(900))
    expect(mixedFlix[0]?.[0].parentProofIds).toEqual([ProofId.make("proof:2")])
  })

  it.effect(
    "F-28: every emitted proof.ruleId and proof.stratum matches its canonical entry in STANDARD_DATALOG_RULES",
    () =>
      Effect.gen(function* () {
        const ruleMap = new Map<string, { stratum: number; headPredicate: string }>()
        for (const rule of STANDARD_DATALOG_RULES) {
          ruleMap.set(rule.id, {
            stratum: rule.stratum,
            headPredicate: rule.headPredicate,
          })
        }

        const graph = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/sample/domain/src/order.ts#checkout",
              spanName: "Order.checkout",
              file: "libs/sample/domain/src/order.ts",
              line: 1,
              packageTag: "domain",
              successType: "void",
              isStub: false,
            },
            {
              qualname: "libs/sample/domain/src/order.ts#decide",
              spanName: "Order.decide",
              file: "libs/sample/domain/src/order.ts",
              line: 20,
              packageTag: "domain",
              successType: "void",
              isStub: true,
            },
          ],
          services: [
            {
              tagId: "OrderRepo",
              name: "OrderRepo",
              packageTag: "service",
              file: "libs/sample/service/src/order-repo.ts",
            },
            {
              tagId: "CloudflareKV",
              name: "CloudflareKV",
              packageTag: "infra",
              file: "libs/sample/infra/src/kv.ts",
            },
          ],
          errors: [
            {
              errorTag: "CheckoutFailed",
              file: "libs/sample/contract/src/errors.ts",
            },
          ],
          tests: [
            {
              testId: "libs/sample/domain/test/order.test.ts#checks out",
              testFile: "libs/sample/domain/test/order.test.ts",
              testName: "checks out",
            },
          ],
          tracedCalls: [
            {
              callerQualname: "libs/sample/domain/src/order.ts#checkout",
              calleeQualname: "libs/sample/domain/src/order.ts#decide",
              callCount: 1,
              receiverLayer: null,
            },
          ],
          requiresService: [
            {
              callerQualname: "libs/sample/domain/src/order.ts#decide",
              tagId: "OrderRepo",
            },
            {
              callerQualname: "libs/sample/domain/src/order.ts#checkout",
              tagId: "CloudflareKV",
            },
          ],
          failsWith: [
            {
              callerQualname: "libs/sample/domain/src/order.ts#decide",
              errorTag: "CheckoutFailed",
            },
          ],
          exercisesSpans: [
            {
              testId: "libs/sample/domain/test/order.test.ts#checks out",
              calleeQualname: "libs/sample/domain/src/order.ts#checkout",
              callCount: 1,
              receiverLayer: null,
            },
          ],
        })

        const res = yield* decideGraphInference(graph)
        expect(res.proofs.length).toBeGreaterThan(0)

        for (const proof of res.proofs) {
          const canonical = ruleMap.get(proof.ruleId)
          expect(canonical).toBeDefined()
          expect(proof.stratum).toBe(canonical!.stratum)
        }
      }),
  )

  it("REQ-1.1: enforces the BipartitePlaysRoleInvariant Schema.check (V_R -> V_E) on PlaysRoleEdge and rejects V_E -> V_E, V_R -> V_R, and V_E -> V_R", () => {
    const validEdge = Schema.decodeSync(PlaysRoleEdge)({
      _tag: "PlaysRole",
      role: "requires-service",
      relationId: "EffectSignature:libs/sample/domain/src/a.ts#fnA",
      entityKey: "ServiceTag:SampleRepo",
    })
    expect(validEdge.role).toBe(RoleName.make("requires-service"))
    expect(
      isBipartitePlaysRoleIds(
        RelationId.make("EffectSignature:libs/sample/domain/src/a.ts#fnA"),
        NodeKey.make("ServiceTag:SampleRepo"),
      ),
    ).toBe(true)

    // V_E -> V_E is rejected
    expect(() =>
      Schema.decodeSync(PlaysRoleEdge)({
        _tag: "PlaysRole",
        role: "callee",
        relationId: "EffectFn:libs/sample/domain/src/a.ts#fnA",
        entityKey: "EffectFn:libs/sample/domain/src/b.ts#fnB",
      }),
    ).toThrow()

    // V_R -> V_R is rejected
    expect(() =>
      Schema.decodeSync(PlaysRoleEdge)({
        _tag: "PlaysRole",
        role: "callee",
        relationId: "EffectSignature:libs/sample/domain/src/a.ts#fnA",
        entityKey: "LayerFlow:libs/sample/infra/src/layer.ts#Live",
      }),
    ).toThrow()

    // V_E -> V_R is rejected
    expect(() =>
      Schema.decodeSync(PlaysRoleEdge)({
        _tag: "PlaysRole",
        role: "caller",
        relationId: "EffectFn:libs/sample/domain/src/a.ts#fnA",
        entityKey: "EffectSignature:libs/sample/domain/src/a.ts#fnA",
      }),
    ).toThrow()
  })

  it.effect.prop(
    "Flix confidence lattice reducer obeys idempotence, commutativity, and associativity across arbitrary confidence scores",
    [
      Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))),
      Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))),
      Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))),
    ],
    ([c1, c2, c3]) =>
      Effect.sync(() => {
        const a = {
          confidenceMillis: ConfidenceMillis.make(c1),
          parentProofIds: [ProofId.make("proof:a")],
        }
        const b = {
          confidenceMillis: ConfidenceMillis.make(c2),
          parentProofIds: [ProofId.make("proof:b")],
        }
        const c = {
          confidenceMillis: ConfidenceMillis.make(c3),
          parentProofIds: [ProofId.make("proof:c")],
        }

        // Idempotence: join(a, a) == a
        const idemp = flixConfidenceReducer([
          [a, 1],
          [a, 1],
        ])
        expect(idemp[0]?.[0]).toEqual(a)

        // Commutativity: join(a, b) == join(b, a)
        const ab = flixConfidenceReducer([
          [a, 1],
          [b, 1],
        ])
        const ba = flixConfidenceReducer([
          [b, 1],
          [a, 1],
        ])
        expect(ab).toEqual(ba)

        // Associativity: join(join(a, b), c) == join(a, join(b, c))
        const abJoined = ab[0]![0]
        const bcJoined = flixConfidenceReducer([
          [b, 1],
          [c, 1],
        ])[0]![0]
        const leftAssoc = flixConfidenceReducer([
          [abJoined, 1],
          [c, 1],
        ])
        const rightAssoc = flixConfidenceReducer([
          [a, 1],
          [bcJoined, 1],
        ])
        expect(leftAssoc).toEqual(rightAssoc)
        expect(leftAssoc[0]?.[0].confidenceMillis).toBe(ConfidenceMillis.make(Math.max(c1, c2, c3)))
      }),
  )

  const makeStepDeltaInitialGraph = () =>
    buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/domain/src/a.ts#fnA",
          spanName: "Sample.fnA",
          file: "libs/sample/domain/src/a.ts",
          line: 1,
          packageTag: "domain",
          successType: "void",
          isStub: false,
        },
        {
          qualname: "libs/sample/domain/src/b.ts#fnB",
          spanName: "Sample.fnB",
          file: "libs/sample/domain/src/b.ts",
          line: 1,
          packageTag: "domain",
          successType: "void",
          isStub: false,
        },
      ],
      services: [
        {
          tagId: "RepoA",
          name: "RepoA",
          packageTag: "service",
          file: "libs/sample/service/src/repo.ts",
        },
        {
          tagId: "SqlClient",
          name: "SqlClient",
          packageTag: "infra",
          file: "libs/sample/infra/src/sql.ts",
        },
      ],
      tracedCalls: [
        {
          callerQualname: "libs/sample/domain/src/a.ts#fnA",
          calleeQualname: "libs/sample/domain/src/b.ts#fnB",
          callCount: 1,
          receiverLayer: null,
        },
      ],
      requiresService: [
        {
          fnQualname: "libs/sample/domain/src/b.ts#fnB",
          tagId: "SqlClient",
        },
      ],
    })

  const makeStepDeltaEditedBSubgraph = () =>
    buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/domain/src/b.ts#fnB",
          spanName: "Sample.fnB",
          file: "libs/sample/domain/src/b.ts",
          line: 1,
          packageTag: "domain",
          successType: "void",
          isStub: false,
        },
      ],
      services: [
        {
          tagId: "RepoA",
          name: "RepoA",
          packageTag: "service",
          file: "libs/sample/service/src/repo.ts",
        },
      ],
      requiresService: [
        {
          fnQualname: "libs/sample/domain/src/b.ts#fnB",
          tagId: "RepoA",
        },
      ],
    })

  const makeStepDeltaScratchGraph = () =>
    buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/domain/src/a.ts#fnA",
          spanName: "Sample.fnA",
          file: "libs/sample/domain/src/a.ts",
          line: 1,
          packageTag: "domain",
          successType: "void",
          isStub: false,
        },
        {
          qualname: "libs/sample/domain/src/b.ts#fnB",
          spanName: "Sample.fnB",
          file: "libs/sample/domain/src/b.ts",
          line: 1,
          packageTag: "domain",
          successType: "void",
          isStub: false,
        },
      ],
      services: [
        {
          tagId: "RepoA",
          name: "RepoA",
          packageTag: "service",
          file: "libs/sample/service/src/repo.ts",
        },
        {
          tagId: "SqlClient",
          name: "SqlClient",
          packageTag: "infra",
          file: "libs/sample/infra/src/sql.ts",
        },
      ],
      tracedCalls: [
        {
          callerQualname: "libs/sample/domain/src/a.ts#fnA",
          calleeQualname: "libs/sample/domain/src/b.ts#fnB",
          callCount: 1,
          receiverLayer: null,
        },
      ],
      requiresService: [
        {
          fnQualname: "libs/sample/domain/src/b.ts#fnB",
          tagId: "RepoA",
        },
      ],
    })

  it.effect(
    "REQ-1.3: DatalogSession.stepFileDelta steps incremental DBSP Z-set deltas (+1 insertions and -1 retractions) on single-file edits with 100% parity with GraphInfer.decide",
    () =>
      Effect.gen(function* () {
        const initialGraph = makeStepDeltaInitialGraph()

        const program = Effect.gen(function* () {
          const session = yield* DatalogSession
          const initialInf = yield* session.latestInference
          expect(initialInf.antiPatterns.some((ap) => ap.ruleId === "domain-requires-infra")).toBe(
            true,
          )

          // Edit b.ts so fnB requires RepoA (type:service) instead of SqlClient (type:infra)
          const editedBSubgraph = makeStepDeltaEditedBSubgraph()

          const step1 = yield* stepDatalogFileDelta({
            filePath: DatalogFilePath.make("libs/sample/domain/src/b.ts"),
            nextGraph: editedBSubgraph,
          })

          expect(step1.epoch).toBe(2)
          expect(step1.retractedFactCount).toBeGreaterThan(0)
          expect(step1.insertedFactCount).toBeGreaterThan(0)
          expect(
            step1.inference.antiPatterns.some((ap) => ap.ruleId === "domain-requires-infra"),
          ).toBe(false)
          expect(
            step1.inference.effectiveRequires.some(
              (r) =>
                r.callerKey === NodeKey.make("EffectFn:libs/sample/domain/src/a.ts#fnA") &&
                r.serviceKey === NodeKey.make("ServiceTag:RepoA"),
            ),
          ).toBe(true)

          const expectedScratchGraph = makeStepDeltaScratchGraph()
          const batchParity = yield* decideGraphInference(expectedScratchGraph)
          expect(step1.inference).toEqual(batchParity)

          // Verify atomic snapshot matches current state
          const snap1 = yield* session.snapshot
          expect(snap1.epoch).toBe(2)
          expect(snap1.inference).toEqual(batchParity)

          // Step 2: no-op edit on b.ts produces 0 retractions and 0 insertions
          const step2 = yield* stepDatalogFileDelta({
            filePath: DatalogFilePath.make("libs/sample/domain/src/b.ts"),
            nextGraph: editedBSubgraph,
          })
          expect(step2.epoch).toBe(3)
          expect(step2.retractedFactCount).toBe(0)
          expect(step2.insertedFactCount).toBe(0)
          expect(step2.inference).toEqual(batchParity)

          // Step 3 (REQ-1.4): root-slash-only filePath fails with GraphInferenceError without corrupting session state
          const invalidExit = yield* Effect.exit(
            stepDatalogFileDelta({
              filePath: DatalogFilePath.make("/"),
              nextGraph: editedBSubgraph,
            }),
          )
          match(invalidExit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(Cause.hasFails(cause)).toBe(true)
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected stepDatalogFileDelta to fail")
            })
            .exhaustive()
          const latestAfterFailure = yield* session.latestInference
          expect(latestAfterFailure).toEqual(batchParity)

          // Step 4: target:role confidence override in priors is honoured
          const stepWithPriors = yield* stepDatalogFileDelta({
            filePath: DatalogFilePath.make("libs/sample/domain/src/b.ts"),
            nextGraph: editedBSubgraph,
            priors: {
              edgeConfidenceOverrides: {
                "ServiceTag:RepoA:provided-service": ConfidenceMillis.make(975),
              },
              holeTeleportationWeights: {},
            },
          })
          const comp03Override = stepWithPriors.inference.suggestedEdges.find(
            (s) => s.ruleId === "COMP-03" && s.targetEntityKey === NodeKey.make("ServiceTag:RepoA"),
          )
          expect(comp03Override?.confidenceMillis).toBe(ConfidenceMillis.make(975))

          // Step 5: deleting b.ts (empty subgraph) retracts all facts for b.ts and removes fnB from currentGraph
          const deletedBStep = yield* stepDatalogFileDelta({
            filePath: DatalogFilePath.make("libs/sample/domain/src/b.ts"),
            nextGraph: buildHarnessGraph({}),
          })
          expect(deletedBStep.retractedFactCount).toBeGreaterThan(0)
          const graphAfterDelete = yield* session.currentGraph
          expect(
            graphAfterDelete.nodeIndexByKey.has(
              NodeKey.make("EffectFn:libs/sample/domain/src/b.ts#fnB"),
            ),
          ).toBe(false)
        })

        yield* program.pipe(Effect.provide(DatalogSession.layer(initialGraph)))
      }),
  )

  it.effect(
    "DatalogSession exact workspace path matching isolates libs/pkg-a/src/index.ts from libs/pkg-b/src/index.ts",
    () =>
      Effect.gen(function* () {
        const twoPkgGraph = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/pkg-a/src/index.ts#fnA",
              spanName: "PkgA.fnA",
              file: "libs/pkg-a/src/index.ts",
              line: 1,
              packageTag: "domain",
              successType: "void",
              isStub: false,
            },
            {
              qualname: "libs/pkg-b/src/index.ts#fnB",
              spanName: "PkgB.fnB",
              file: "libs/pkg-b/src/index.ts",
              line: 1,
              packageTag: "domain",
              successType: "void",
              isStub: false,
            },
          ],
        })

        const editedPkgA = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/pkg-a/src/index.ts#fnAUpdated",
              spanName: "PkgA.fnAUpdated",
              file: "libs/pkg-a/src/index.ts",
              line: 1,
              packageTag: "domain",
              successType: "void",
              isStub: false,
            },
          ],
        })

        const program = Effect.gen(function* () {
          yield* stepDatalogFileDelta({
            filePath: DatalogFilePath.make("/workspace/repo/libs/pkg-a/src/index.ts"),
            nextGraph: editedPkgA,
          })
          const snap = yield* (yield* DatalogSession).snapshot
          expect(
            snap.graph.nodeIndexByKey.has(
              NodeKey.make("EffectFn:libs/pkg-a/src/index.ts#fnAUpdated"),
            ),
          ).toBe(true)
          expect(
            snap.graph.nodeIndexByKey.has(NodeKey.make("EffectFn:libs/pkg-b/src/index.ts#fnB")),
          ).toBe(true)
        })

        yield* program.pipe(Effect.provide(DatalogSession.layer(twoPkgGraph)))

        const directPipeline = yield* runGraphInferencePipeline(twoPkgGraph)
        expect(directPipeline.iterations).toBeGreaterThanOrEqual(1)
      }),
  )

  it.effect(
    "SPEC-0029 REQ-4.1: INF-07 unmapped-spec-symbol skips status: draft specs while enforcing proposed and accepted",
    () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({
          earsSpecs: [
            {
              id: "harness:SPEC-DRAFT",
              title: "Draft Backlog Spec",
              status: "draft",
              path: "libs/harness/docs/specs/draft.md",
              enforcedByFiles: [],
              referencedSpans: ["Future.unimplementedSpan"],
              referencedServices: ["FutureService"],
              referencedErrors: ["FutureError"],
            },
            {
              id: "harness:SPEC-PROPOSED",
              title: "Active Proposed Spec",
              status: "proposed",
              path: "libs/harness/docs/specs/proposed.md",
              enforcedByFiles: [],
              referencedSpans: ["Active.missingSpan"],
              referencedServices: [],
              referencedErrors: [],
            },
          ],
        })
        const inferred = yield* decideGraphInference(graph)
        expect(
          inferred.antiPatterns.some(
            (a) => a.ruleId === "unmapped-spec-symbol" && a.path.includes("harness:SPEC-DRAFT"),
          ),
        ).toBe(false)
        expect(
          inferred.antiPatterns.some(
            (a) =>
              a.ruleId === "unmapped-spec-symbol" &&
              a.path.includes("harness:SPEC-PROPOSED") &&
              a.path.includes("Active.missingSpan"),
          ),
        ).toBe(true)
      }),
  )
})
