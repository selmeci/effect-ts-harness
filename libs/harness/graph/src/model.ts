import type * as Graph from "effect/Graph"

export type PackageTag = "contract" | "domain" | "service" | "infra" | "app"
export type LayerKind = "live" | "test" | "emulated" | "infra"

export interface EffectFnNode {
  readonly _tag: "EffectFn"
  readonly qualname: string
  readonly spanName: string
  readonly packageTag: PackageTag
  readonly file: string
  readonly line: number
  readonly successType: string
  readonly isStub: boolean
}

export interface ServiceTagNode {
  readonly _tag: "ServiceTag"
  readonly tagId: string
  readonly name: string
  readonly packageTag: PackageTag
  readonly file: string
}

export interface ServiceLayerNode {
  readonly _tag: "ServiceLayer"
  readonly qualname: string
  readonly layerKind: LayerKind
  readonly packageTag: PackageTag
  readonly file: string
}

export interface TaggedErrorNode {
  readonly _tag: "TaggedError"
  readonly errorTag: string
  readonly file: string
}

export interface VitestCaseNode {
  readonly _tag: "VitestCase"
  readonly testId: string
  readonly testFile: string
  readonly testName: string
  readonly lastTreeHash: string
  readonly isPropertyTest?: boolean | undefined
  readonly hasNonPrimitiveArbitrary?: boolean | undefined
}

export interface PatternDocNode {
  readonly _tag: "PatternDoc"
  readonly slug: string
  readonly path: string
  readonly summary: string
}

export type GovernanceDocStatus = "accepted" | "proposed" | "superseded" | "deprecated"
export type GovernedTargetKind = "EffectFn" | "ServiceTag" | "TaggedError"

export interface AdrDocNode {
  readonly _tag: "AdrDoc"
  readonly id: string
  readonly title: string
  readonly status: GovernanceDocStatus
  readonly path: string
  readonly enforcedByFiles: ReadonlyArray<string>
  readonly referencedSpans: ReadonlyArray<string>
  readonly referencedServices: ReadonlyArray<string>
  readonly referencedErrors: ReadonlyArray<string>
}

export interface EarsSpecNode {
  readonly _tag: "EarsSpec"
  readonly id: string
  readonly title: string
  readonly status: GovernanceDocStatus
  readonly path: string
  readonly enforcedByFiles: ReadonlyArray<string>
  readonly referencedSpans: ReadonlyArray<string>
  readonly referencedServices: ReadonlyArray<string>
  readonly referencedErrors: ReadonlyArray<string>
}

export type HarnessNode =
  | EffectFnNode
  | ServiceTagNode
  | ServiceLayerNode
  | TaggedErrorNode
  | VitestCaseNode
  | PatternDocNode
  | AdrDocNode
  | EarsSpecNode

export interface RequiresServiceEdge {
  readonly _tag: "RequiresService"
  readonly callerQualname: string
  readonly tagId: string
}

export interface FailsWithEdge {
  readonly _tag: "FailsWith"
  readonly callerQualname: string
  readonly errorTag: string
}

export interface ProvidesServiceEdge {
  readonly _tag: "ProvidesService"
  readonly layerQualname: string
  readonly tagId: string
}

export interface LayerRequiresEdge {
  readonly _tag: "LayerRequires"
  readonly layerQualname: string
  readonly tagId: string
}

export interface TracedCallEdge {
  readonly _tag: "TracedCall"
  readonly callerQualname: string
  readonly calleeQualname: string
  readonly callCount: number
  readonly receiverLayer: string | null
}

export interface ExercisesSpanEdge {
  readonly _tag: "ExercisesSpan"
  readonly testId: string
  readonly calleeQualname: string
  readonly callCount: number
  readonly receiverLayer: string | null
}

export interface GovernsSymbolEdge {
  readonly _tag: "GovernsSymbol"
  readonly adrId: string
  readonly targetKey: string
  readonly targetKind: GovernedTargetKind
}

export interface SpecifiesSymbolEdge {
  readonly _tag: "SpecifiesSymbol"
  readonly specId: string
  readonly targetKey: string
  readonly targetKind: GovernedTargetKind
}

export type HarnessEdge =
  | RequiresServiceEdge
  | FailsWithEdge
  | ProvidesServiceEdge
  | LayerRequiresEdge
  | TracedCallEdge
  | ExercisesSpanEdge
  | GovernsSymbolEdge
  | SpecifiesSymbolEdge

export interface BuildHarnessGraphInput {
  readonly fns?: ReadonlyArray<Omit<EffectFnNode, "_tag"> | EffectFnNode>
  readonly services?: ReadonlyArray<Omit<ServiceTagNode, "_tag"> | ServiceTagNode>
  readonly layers?: ReadonlyArray<Omit<ServiceLayerNode, "_tag"> | ServiceLayerNode>
  readonly errors?: ReadonlyArray<Omit<TaggedErrorNode, "_tag"> | TaggedErrorNode>
  readonly tests?: ReadonlyArray<Omit<VitestCaseNode, "_tag"> | VitestCaseNode>
  readonly patternDocs?: ReadonlyArray<Omit<PatternDocNode, "_tag"> | PatternDocNode>
  readonly adrDocs?: ReadonlyArray<Omit<AdrDocNode, "_tag"> | AdrDocNode>
  readonly earsSpecs?: ReadonlyArray<Omit<EarsSpecNode, "_tag"> | EarsSpecNode>
  readonly governsSymbols?: ReadonlyArray<{
    readonly adrId: string
    readonly targetKey: string
    readonly targetKind: GovernedTargetKind
  }>
  readonly specifiesSymbols?: ReadonlyArray<{
    readonly specId: string
    readonly targetKey: string
    readonly targetKind: GovernedTargetKind
  }>
  readonly requiresService?: ReadonlyArray<
    | { readonly callerQualname: string; readonly tagId: string }
    | { readonly fnQualname: string; readonly tagId: string }
  >
  readonly failsWith?: ReadonlyArray<
    | { readonly callerQualname: string; readonly errorTag: string }
    | { readonly fnQualname: string; readonly errorTag: string }
  >
  readonly providesService?: ReadonlyArray<{
    readonly layerQualname: string
    readonly tagId: string
  }>
  readonly layerRequires?: ReadonlyArray<{
    readonly layerQualname: string
    readonly tagId: string
  }>
  readonly tracedCalls?: ReadonlyArray<{
    readonly callerQualname: string
    readonly calleeQualname: string
    readonly callCount: number
    readonly receiverLayer: string | null
  }>
  readonly exercisesSpans?: ReadonlyArray<{
    readonly testId: string
    readonly calleeQualname: string
    readonly callCount: number
    readonly receiverLayer: string | null
  }>
  readonly branchingViolations?: ReadonlyArray<BranchingViolation> | undefined
}

export interface BranchingViolation {
  readonly rule:
    | "discriminant-branching"
    | "non-exhaustive-union-match"
    | "schema-boolean-state"
    | "dead-event-payload"
    | "terminal-state-unhandled"
    | "fallback-json-equality"
    | "vacuous-error-assertion"
    | "unscoped-effect-run"
  readonly message: string
  readonly file: string
  readonly line: number
  readonly enclosingSymbol: string
}

export interface HarnessGraph {
  readonly graph: Graph.DirectedGraph<HarnessNode, HarnessEdge>
  readonly nodeIndexByKey: ReadonlyMap<string, Graph.NodeIndex>
  readonly branchingViolations?: ReadonlyArray<BranchingViolation> | undefined
}

export const getNodeKey = (node: HarnessNode): string => {
  switch (node._tag) {
    case "EffectFn":
      return node.qualname
    case "ServiceTag":
      return node.tagId
    case "ServiceLayer":
      return node.qualname
    case "TaggedError":
      return node.errorTag
    case "VitestCase":
      return node.testId
    case "PatternDoc":
      return node.slug
    case "AdrDoc":
      return node.id
    case "EarsSpec":
      return node.id
  }
}

export const getEdgeKey = (edge: HarnessEdge): string => {
  switch (edge._tag) {
    case "RequiresService":
      return `RequiresService:${edge.callerQualname}->${edge.tagId}`
    case "FailsWith":
      return `FailsWith:${edge.callerQualname}->${edge.errorTag}`
    case "ProvidesService":
      return `ProvidesService:${edge.layerQualname}->${edge.tagId}`
    case "LayerRequires":
      return `LayerRequires:${edge.layerQualname}->${edge.tagId}`
    case "TracedCall":
      return `TracedCall:${edge.callerQualname}->${edge.calleeQualname}`
    case "ExercisesSpan":
      return `ExercisesSpan:${edge.testId}->${edge.calleeQualname}`
    case "GovernsSymbol":
      return `GovernsSymbol:${edge.adrId}->${edge.targetKey}`
    case "SpecifiesSymbol":
      return `SpecifiesSymbol:${edge.specId}->${edge.targetKey}`
  }
}

export interface CalleeResult {
  readonly qualname: string
  readonly spanName?: string
  readonly tagId?: string
  readonly name?: string
  readonly edgeKind: string
  readonly receiverLayer: string | null
  readonly callCount?: number
  readonly candidates?: ReadonlyArray<string>
}

export interface CallerResult {
  readonly qualname: string
  readonly spanName?: string
  readonly testId?: string
  readonly edgeKind: string
  readonly receiverLayer: string | null
  readonly callCount?: number
}
