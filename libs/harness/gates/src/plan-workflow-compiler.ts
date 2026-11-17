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
  UnitDependency,
  WaveIndex,
  WorkUnitId,
  WorkflowCompileReason,
  wavesOf,
} from "@harness/contract"

export const assertDisjointWave = Effect.fn("PlanWorkflowCompiler.assertDisjoint")(function* (
  wave: CompiledWave,
): Effect.fn.Return<CompiledWave, DisjointOwnershipViolationError, never> {
  const pathOwnerCounts = new Map<OwnedRelPath, number>()

  for (const unit of wave.units) {
    const unitPaths = new Set<OwnedRelPath>(unit.ownedRelPaths)
    for (const relPath of unitPaths) {
      pathOwnerCounts.set(relPath, (pathOwnerCounts.get(relPath) ?? 0) + 1)
    }
  }

  const overlappingPaths: Array<OwnedRelPath> = []
  for (const [relPath, count] of pathOwnerCounts) {
    if (count >= 2) {
      overlappingPaths.push(relPath)
    }
  }

  overlappingPaths.sort((a, b) => a.localeCompare(b))

  if (overlappingPaths.length > 0) {
    return yield* new DisjointOwnershipViolationError({
      waveIndex: wave.waveIndex,
      overlappingPaths,
    })
  }

  return wave
})

export const compileWorkflowWaves = Effect.fn("PlanWorkflowCompiler.decide")(function* (
  input: CompileInput,
): Effect.fn.Return<CompiledWaves, CyclicPlanWorkflowError | InvalidPlanWorkflowGraphError, never> {
  const unitById = new Map<WorkUnitId, CompiledWorkUnit>()
  const ownedSetById = new Map<WorkUnitId, ReadonlySet<OwnedRelPath>>()

  for (const unit of input.units) {
    if (unitById.has(unit.unitId)) {
      return yield* new InvalidPlanWorkflowGraphError({
        issue: { _tag: "DuplicateWorkUnitId", unitId: unit.unitId },
        reason: WorkflowCompileReason.make(`Duplicate WorkUnitId: ${unit.unitId}`),
      })
    }
    unitById.set(unit.unitId, unit)
    ownedSetById.set(unit.unitId, new Set<OwnedRelPath>(unit.ownedRelPaths))
  }

  const allDependencies: ReadonlyArray<UnitDependency> = [
    ...input.dependencies,
    ...input.units.flatMap((u) => u.dependsOn.map((from) => ({ from, to: u.unitId }))),
  ]

  for (const dep of allDependencies) {
    if (!unitById.has(dep.from)) {
      return yield* new InvalidPlanWorkflowGraphError({
        issue: {
          _tag: "DanglingUnitDependency",
          from: dep.from,
          to: dep.to,
          missingUnitId: dep.from,
        },
        reason: WorkflowCompileReason.make(
          `Dangling dependency from missing WorkUnitId: ${dep.from}`,
        ),
      })
    }
    if (!unitById.has(dep.to)) {
      return yield* new InvalidPlanWorkflowGraphError({
        issue: {
          _tag: "DanglingUnitDependency",
          from: dep.from,
          to: dep.to,
          missingUnitId: dep.to,
        },
        reason: WorkflowCompileReason.make(`Dangling dependency to missing WorkUnitId: ${dep.to}`),
      })
    }
  }

  if (input.units.length === 0) {
    return { units: [], waves: [] }
  }

  const indexById = new Map<WorkUnitId, Graph.NodeIndex>()
  const incomingById = new Map<WorkUnitId, Set<WorkUnitId>>()
  const selfLoops = new Set<WorkUnitId>()

  const graph = Graph.directed<WorkUnitId, null>((mutable) => {
    for (const unit of input.units) {
      const idx = Graph.addNode(mutable, unit.unitId)
      indexById.set(unit.unitId, idx)
      incomingById.set(unit.unitId, new Set<WorkUnitId>())
    }
    const seenEdges = new Set<string>()
    for (const dep of allDependencies) {
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
  })

  if (!Graph.isAcyclic(graph)) {
    const cycleUnitSet = new Set<WorkUnitId>()
    const sccs = Graph.stronglyConnectedComponents(graph)
    for (const component of sccs) {
      if (component.length > 1) {
        for (const nodeIdx of component) {
          match(Graph.getNode(graph, nodeIdx))
            .with({ _tag: "Some" }, ({ value }) => {
              cycleUnitSet.add(value)
            })
            .with({ _tag: "None" }, () => undefined)
            .exhaustive()
        }
        continue
      }
      if (component.length === 1) {
        const nodeIdx = component[0]
        if (nodeIdx !== undefined) {
          match(Graph.getNode(graph, nodeIdx))
            .with({ _tag: "Some" }, ({ value }) => {
              if (selfLoops.has(value)) {
                cycleUnitSet.add(value)
              }
            })
            .with({ _tag: "None" }, () => undefined)
            .exhaustive()
        }
      }
    }
    const cycleUnits = [...cycleUnitSet].sort((a, b) => a.localeCompare(b))
    return yield* new CyclicPlanWorkflowError({
      cycleUnits,
      reason: WorkflowCompileReason.make(
        `Cyclic dependency detected involving: ${cycleUnits.join(", ")}`,
      ),
    })
  }

  const levelById = new Map<WorkUnitId, number>()
  let maxLevel = 0
  for (const unitId of Graph.values(Graph.topo(graph))) {
    const incoming = incomingById.get(unitId)
    let level = 0
    if (incoming !== undefined && incoming.size > 0) {
      let maxPredLevel = 0
      for (const predId of incoming) {
        const predLevel = levelById.get(predId) ?? 0
        if (predLevel > maxPredLevel) {
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

  const unitsByLevel: Array<Array<CompiledWorkUnit>> = Array.from(
    { length: maxLevel + 1 },
    () => [],
  )
  for (const unit of input.units) {
    const level = levelById.get(unit.unitId) ?? 0
    unitsByLevel[level]?.push(unit)
  }

  const subWaves: Array<Array<CompiledWorkUnit>> = []
  for (const levelUnits of unitsByLevel) {
    levelUnits.sort((a, b) => a.unitId.localeCompare(b.unitId))
    const levelBuckets: Array<{
      readonly units: Array<CompiledWorkUnit>
      readonly ownedPaths: Set<OwnedRelPath>
    }> = []

    for (const unit of levelUnits) {
      const unitPaths = ownedSetById.get(unit.unitId) ?? new Set<OwnedRelPath>()
      let placed = false
      for (const bucket of levelBuckets) {
        let overlaps = false
        for (const relPath of unitPaths) {
          if (bucket.ownedPaths.has(relPath)) {
            overlaps = true
            break
          }
        }
        if (!overlaps) {
          bucket.units.push(unit)
          for (const relPath of unitPaths) {
            bucket.ownedPaths.add(relPath)
          }
          placed = true
          break
        }
      }
      if (!placed) {
        levelBuckets.push({
          units: [unit],
          ownedPaths: new Set<OwnedRelPath>(unitPaths),
        })
      }
    }

    for (const bucket of levelBuckets) {
      subWaves.push(bucket.units)
    }
  }

  const flattenedUnits: Array<CompiledWorkUnit> = []
  const waves: Array<CompiledWave> = []

  for (let i = 0; i < subWaves.length; i++) {
    const waveIndex = WaveIndex.make(i)
    const rawUnits = subWaves[i] ?? []
    const stampedUnits: Array<CompiledWorkUnit> = rawUnits.map((unit) => {
      const sortedDependsOn = [...(incomingById.get(unit.unitId) ?? new Set<WorkUnitId>())].sort(
        (a, b) => a.localeCompare(b),
      )
      return match(unit)
        .with({ _tag: "SliceUnit" }, (sliceUnit) => ({
          ...sliceUnit,
          waveIndex,
          dependsOn: sortedDependsOn,
        }))
        .with({ _tag: "PackageUnit" }, (packageUnit) => ({
          ...packageUnit,
          waveIndex,
          dependsOn: sortedDependsOn,
        }))
        .exhaustive()
    })
    const compiledWave: CompiledWave = {
      waveIndex,
      units: stampedUnits,
    }
    yield* Effect.orDie(assertDisjointWave(compiledWave))
    waves.push(compiledWave)
    flattenedUnits.push(...stampedUnits)
  }

  return {
    units: flattenedUnits,
    waves,
  }
})

export const PlanWorkflowCompiler = {
  decide: compileWorkflowWaves,
  assertDisjoint: assertDisjointWave,
  wavesOf,
} as const
