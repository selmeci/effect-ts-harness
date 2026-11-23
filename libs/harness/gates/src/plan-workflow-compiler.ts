import { Effect, Graph } from "effect"
import { match } from "ts-pattern"
import {
  CompileInput,
  CompiledWave,
  CompiledWaves,
  CompiledWorkUnit,
  CyclicPlanWorkflowError,
  DisjointOwnershipViolationError,
  InvalidPlanWorkflowGraphError,
  OwnedRelPath,
  SHARED_STEP_UNIT_ID,
  UnitDependency,
  WaveIndex,
  WorkUnitDraft,
  WorkUnitId,
  WorkflowCompileReason,
  compareCodeUnits,
  pathsOverlap,
  wavesOf,
} from "@harness/contract"

type NonEmptyReadonlyArray<A> = readonly [A, ...Array<A>]

const toNonEmptyArray = <A>(items: ReadonlyArray<A>): NonEmptyReadonlyArray<A> | undefined => {
  const [first, ...rest] = items
  return first === undefined ? undefined : [first, ...rest]
}

export const assertDisjointWave = Effect.fn("PlanWorkflowCompiler.assertDisjoint")(function* (
  wave: CompiledWave,
): Effect.fn.Return<CompiledWave, DisjointOwnershipViolationError, never> {
  const overlappingSet = new Set<OwnedRelPath>()

  for (let i = 0; i < wave.units.length; i += 1) {
    const unitA = wave.units[i]!
    for (let j = i + 1; j < wave.units.length; j += 1) {
      const unitB = wave.units[j]!
      for (const pathA of unitA.ownedRelPaths) {
        for (const pathB of unitB.ownedRelPaths) {
          if (pathsOverlap(pathA, pathB)) {
            overlappingSet.add(pathA)
            overlappingSet.add(pathB)
          }
        }
      }
    }
  }

  const sortedOverlapping = [...overlappingSet].sort(compareCodeUnits)
  const overlappingPaths = toNonEmptyArray(sortedOverlapping)
  if (overlappingPaths !== undefined) {
    return yield* new DisjointOwnershipViolationError({
      waveIndex: wave.waveIndex,
      overlappingPaths,
    })
  }

  return wave
})

const indexWorkUnits = Effect.fnUntraced(function* (
  units: ReadonlyArray<WorkUnitDraft>,
): Effect.fn.Return<ReadonlyMap<WorkUnitId, WorkUnitDraft>, InvalidPlanWorkflowGraphError, never> {
  const unitById = new Map<WorkUnitId, WorkUnitDraft>()
  for (const unit of units) {
    // Defense-in-depth: "shared-step" is reserved for the synthetic sequential shared-step unit.
    if (unit.unitId === SHARED_STEP_UNIT_ID || unitById.has(unit.unitId)) {
      return yield* new InvalidPlanWorkflowGraphError({
        issue: { _tag: "DuplicateWorkUnitId", unitId: unit.unitId },
      })
    }
    unitById.set(unit.unitId, unit)
  }
  return unitById
})

const validateDependencies = Effect.fnUntraced(function* (
  dependencies: ReadonlyArray<UnitDependency>,
  unitById: ReadonlyMap<WorkUnitId, WorkUnitDraft>,
): Effect.fn.Return<void, InvalidPlanWorkflowGraphError, never> {
  for (const dep of dependencies) {
    const missing: Array<WorkUnitId> = []
    if (!unitById.has(dep.from)) {
      missing.push(dep.from)
    }
    if (!unitById.has(dep.to) && dep.to !== dep.from) {
      missing.push(dep.to)
    }
    const missingUnitIds = toNonEmptyArray(missing)
    if (missingUnitIds !== undefined) {
      return yield* new InvalidPlanWorkflowGraphError({
        issue: {
          _tag: "DanglingUnitDependency",
          from: dep.from,
          to: dep.to,
          missingUnitIds,
        },
      })
    }
  }
})

interface BuiltDependencyGraph {
  readonly graph: Graph.DirectedGraph<WorkUnitId, null>
  readonly incomingById: ReadonlyMap<WorkUnitId, ReadonlySet<WorkUnitId>>
  readonly selfLoops: ReadonlySet<WorkUnitId>
}

const buildDependencyGraph = (
  units: ReadonlyArray<WorkUnitDraft>,
  dependencies: ReadonlyArray<UnitDependency>,
): BuiltDependencyGraph => {
  const indexById = new Map<WorkUnitId, Graph.NodeIndex>()
  const incomingById = new Map<WorkUnitId, Set<WorkUnitId>>()
  const selfLoops = new Set<WorkUnitId>()

  const mutable = Graph.beginMutation(Graph.directed<WorkUnitId, null>())
  for (const unit of units) {
    indexById.set(unit.unitId, Graph.addNode(mutable, unit.unitId))
    incomingById.set(unit.unitId, new Set<WorkUnitId>())
  }
  const seenEdges = new Set<string>()
  for (const dep of dependencies) {
    if (dep.from === dep.to) {
      selfLoops.add(dep.from)
    }
    const edgeKey = `${dep.from}\0${dep.to}`
    if (seenEdges.has(edgeKey)) continue
    seenEdges.add(edgeKey)
    const fromIdx = indexById.get(dep.from)
    const toIdx = indexById.get(dep.to)
    if (fromIdx !== undefined && toIdx !== undefined) {
      Graph.addEdge(mutable, fromIdx, toIdx, null)
      incomingById.get(dep.to)?.add(dep.from)
    }
  }
  const graph = Graph.endMutation(mutable)

  return { graph, incomingById, selfLoops }
}

const buildCycleError = (
  units: ReadonlyArray<WorkUnitDraft>,
  graph: Graph.DirectedGraph<WorkUnitId, null>,
  selfLoops: ReadonlySet<WorkUnitId>,
): CyclicPlanWorkflowError => {
  const cycleUnitSet = new Set<WorkUnitId>()
  for (const component of Graph.stronglyConnectedComponents(graph)) {
    if (component.length > 1) {
      for (const nodeIdx of component) {
        match(Graph.getNode(graph, nodeIdx))
          .with({ _tag: "Some" }, ({ value }) => {
            cycleUnitSet.add(value)
          })
          .with({ _tag: "None" }, () => undefined)
          .exhaustive()
      }
    }
  }
  for (const loopUnitId of selfLoops) {
    cycleUnitSet.add(loopUnitId)
  }
  const sortedCycleUnits = [...cycleUnitSet].sort(compareCodeUnits)
  const [firstCycle, ...restCycle] = sortedCycleUnits
  const cycleUnits: NonEmptyReadonlyArray<WorkUnitId> = [
    firstCycle ?? units[0]!.unitId,
    ...restCycle,
  ]
  return new CyclicPlanWorkflowError({
    cycleUnits,
    reason: WorkflowCompileReason.make(
      `Cyclic dependency detected involving: ${cycleUnits.join(", ")}`,
    ),
  })
}

const computeUnitsByLevel = (
  units: ReadonlyArray<WorkUnitDraft>,
  graph: Graph.DirectedGraph<WorkUnitId, null>,
  incomingById: ReadonlyMap<WorkUnitId, ReadonlySet<WorkUnitId>>,
): ReadonlyArray<ReadonlyArray<WorkUnitDraft>> => {
  const levelById = new Map<WorkUnitId, number>()
  let maxLevel = 0
  for (const unitId of Graph.values(Graph.topo(graph))) {
    const incoming = incomingById.get(unitId)
    let level = 0
    if (incoming !== undefined && incoming.size > 0) {
      let maxPredLevel = 0
      for (const predId of incoming) {
        const predLevel = levelById.get(predId)
        if (predLevel !== undefined && predLevel > maxPredLevel) {
          maxPredLevel = predLevel
        }
      }
      level = maxPredLevel + 1
    }
    levelById.set(unitId, level)
    if (level > maxLevel) {
      maxLevel = level
    }
  }

  const unitsByLevel: Array<Array<WorkUnitDraft>> = Array.from({ length: maxLevel + 1 }, () => [])
  for (const unit of units) {
    const level = levelById.get(unit.unitId)
    if (level !== undefined) {
      unitsByLevel[level]?.push(unit)
    }
  }
  return unitsByLevel
}

const hasPathOverlapWithBucket = (
  unitPaths: ReadonlyArray<OwnedRelPath>,
  bucketPaths: ReadonlyArray<OwnedRelPath>,
): boolean =>
  unitPaths.some((unitPath) =>
    bucketPaths.some((existingPath) => pathsOverlap(unitPath, existingPath)),
  )

const partitionIntoDisjointSubWaves = (
  unitsByLevel: ReadonlyArray<ReadonlyArray<WorkUnitDraft>>,
): ReadonlyArray<NonEmptyReadonlyArray<WorkUnitDraft>> => {
  const subWaves: Array<NonEmptyReadonlyArray<WorkUnitDraft>> = []
  for (const levelUnits of unitsByLevel) {
    const sortedUnits = [...levelUnits].sort((a, b) => compareCodeUnits(a.unitId, b.unitId))
    const buckets: Array<{
      readonly first: WorkUnitDraft
      readonly rest: Array<WorkUnitDraft>
      readonly ownedPaths: Array<OwnedRelPath>
    }> = []

    for (const unit of sortedUnits) {
      const targetBucket = buckets.find(
        (bucket) => !hasPathOverlapWithBucket(unit.ownedRelPaths, bucket.ownedPaths),
      )
      if (targetBucket !== undefined) {
        targetBucket.rest.push(unit)
        targetBucket.ownedPaths.push(...unit.ownedRelPaths)
      } else {
        buckets.push({
          first: unit,
          rest: [],
          ownedPaths: [...unit.ownedRelPaths],
        })
      }
    }

    for (const bucket of buckets) {
      subWaves.push([bucket.first, ...bucket.rest])
    }
  }
  return subWaves
}

const stampWorkUnit = (
  unit: WorkUnitDraft,
  waveIndex: WaveIndex,
  dependsOn: ReadonlyArray<WorkUnitId>,
): CompiledWorkUnit =>
  match(unit)
    .with({ _tag: "SliceUnit" }, (sliceUnit) => ({
      ...sliceUnit,
      waveIndex,
      dependsOn,
    }))
    .with({ _tag: "PackageUnit" }, (packageUnit) => ({
      ...packageUnit,
      waveIndex,
      dependsOn,
    }))
    .exhaustive()

const stampAndValidateWaves = Effect.fnUntraced(function* (
  subWaves: ReadonlyArray<NonEmptyReadonlyArray<WorkUnitDraft>>,
  incomingById: ReadonlyMap<WorkUnitId, ReadonlySet<WorkUnitId>>,
): Effect.fn.Return<ReadonlyArray<CompiledWorkUnit>, never, never> {
  const flattenedUnits: Array<CompiledWorkUnit> = []
  for (let i = 0; i < subWaves.length; i += 1) {
    const waveIndex = WaveIndex.make(i)
    const rawUnits = subWaves[i]!
    const [firstUnit, ...restUnits] = rawUnits
    const toStamped = (unit: WorkUnitDraft): CompiledWorkUnit => {
      const incoming = incomingById.get(unit.unitId)
      const sortedDependsOn = incoming !== undefined ? [...incoming].sort(compareCodeUnits) : []
      return stampWorkUnit(unit, waveIndex, sortedDependsOn)
    }
    const stampedUnits: NonEmptyReadonlyArray<CompiledWorkUnit> = [
      toStamped(firstUnit),
      ...restUnits.map(toStamped),
    ]
    const compiledWave: CompiledWave = {
      waveIndex,
      units: stampedUnits,
    }
    yield* Effect.orDie(assertDisjointWave(compiledWave))
    flattenedUnits.push(...stampedUnits)
  }
  return flattenedUnits
})

export const compileWorkflowWaves = Effect.fn("PlanWorkflowCompiler.decide")(function* (
  input: CompileInput,
): Effect.fn.Return<CompiledWaves, CyclicPlanWorkflowError | InvalidPlanWorkflowGraphError, never> {
  const unitById = yield* indexWorkUnits(input.units)
  yield* validateDependencies(input.dependencies, unitById)

  if (input.units.length === 0) {
    return { units: [] }
  }

  const { graph, incomingById, selfLoops } = buildDependencyGraph(input.units, input.dependencies)
  if (!Graph.isAcyclic(graph)) {
    return yield* buildCycleError(input.units, graph, selfLoops)
  }

  const unitsByLevel = computeUnitsByLevel(input.units, graph, incomingById)
  const subWaves = partitionIntoDisjointSubWaves(unitsByLevel)
  const units = yield* stampAndValidateWaves(subWaves, incomingById)

  return { units }
})

export const PlanWorkflowCompiler = {
  decide: compileWorkflowWaves,
  assertDisjoint: assertDisjointWave,
  wavesOf,
} as const
