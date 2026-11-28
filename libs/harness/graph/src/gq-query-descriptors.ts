export const HARNESS_GQ_QUERY_NAMES = [
  "resolve_effect_fn",
  "find_service_providers",
  "find_callers",
  "find_callees",
  "find_tests_reaching",
  "ontology_layer_nodes",
  "ontology_governed_by",
  "untested_domain_fns",
  "resolve_effect_fn_fuzzy",
  "ontology_realized_by_doc",
  "rank_patterns_hybrid",
  "rank_patterns_vector_hybrid",
  "rank_patterns_bm25",
  "search_adrs_vector_hybrid",
  "search_adrs_bm25",
  "search_requirements_vector_hybrid",
  "search_requirements_bm25",
  "rank_candidate_services_for_stub",
  "policy_unverified_domain_fns",
  "policy_orphan_effect_signatures",
  "workflow_pending_units",
  "ears_without_completed_unit",
] as const

export type HarnessGqQueryName = (typeof HARNESS_GQ_QUERY_NAMES)[number]

export interface HarnessGqQueryDescriptor {
  readonly name: HarnessGqQueryName
  readonly description: string
  readonly params: ReadonlyArray<string>
  readonly source: string
}

export const HARNESS_GQ_QUERIES: Readonly<Record<HarnessGqQueryName, HarnessGqQueryDescriptor>> = {
  resolve_effect_fn: {
    name: "resolve_effect_fn",
    description:
      "Resolve an Effect function or symbol and return its properties and ArchiMate classification",
    params: ["spanOrQualname"],
    source: `query resolve_effect_fn($spanOrQualname: String) {
  match {
    $fn: EffectFn
    $fn.spanName = $spanOrQualname or $fn.qualname = $spanOrQualname
  }
  return {
    $fn.qualname,
    $fn.spanName,
    $fn.packageTag,
    $fn.file,
    $fn.line,
    $fn.successType,
    $fn.isStub,
    $fn.archimateLayer,
    $fn.archimateAspect,
    $fn.archimateElementType
  }
}`,
  },
  find_service_providers: {
    name: "find_service_providers",
    description: "Find all ServiceLayer implementations that provide a given ServiceTag",
    params: ["tagId"],
    source: `query find_service_providers($tagId: String) {
  match {
    $lf: LayerFlow
    $layer: ServiceLayer
    $tag: ServiceTag
    $lf playsProviderLayerRole $layer
    $lf playsProvidedServiceRole $tag
    $tag.tagId = $tagId or $tag.name = $tagId or $tag.qualname = $tagId
  }
  return {
    $layer.qualname as layerQualname,
    $layer.layerKind as layerKind,
    $layer.packageTag as packageTag,
    $layer.file as file,
    $tag.tagId as tagId
  }
}`,
  },
  find_callers: {
    name: "find_callers",
    description: "Find callers of an Effect function, service, or layer",
    params: ["target"],
    source: `query find_callers($target: String) {
  match {
    $sig: EffectSignature
    $caller: EffectFn
    $callee: EffectFn
    $sig playsCallerRole $caller
    $sig $rel:playsCalleeRole $callee
    $callee.qualname = $target or $callee.spanName = $target
  }
  return {
    $caller.qualname as caller,
    $rel.archimateRelation as rel,
    $callee.qualname as callee
  }
}`,
  },
  find_callees: {
    name: "find_callees",
    description: "Find callees of an Effect function, service, or layer",
    params: ["caller"],
    source: `query find_callees($caller: String) {
  match {
    $sig: EffectSignature
    $src: EffectFn
    $callee: EffectFn
    $sig playsCallerRole $src
    $sig $rel:playsCalleeRole $callee
    $src.qualname = $caller or $src.spanName = $caller
  }
  return {
    $src.qualname as src,
    $rel.archimateRelation as rel,
    $callee.qualname as callee
  }
}`,
  },
  find_tests_reaching: {
    name: "find_tests_reaching",
    description: "Find test cases reaching a given callee Effect function",
    params: ["callee"],
    source: `query find_tests_reaching($callee: String) {
  match {
    $tt: TraceabilityTuple
    $test: VitestCase
    $fn: EffectFn
    $tt playsExercisingTestRole $test
    $tt playsExercisedSpanRole $fn
    $fn.qualname = $callee or $fn.spanName = $callee
  }
  return {
    $test.testId as testId,
    $test.testFile as testFile,
    $test.testName as testName
  }
}`,
  },
  ontology_layer_nodes: {
    name: "ontology_layer_nodes",
    description: "Query all nodes projected onto a given ArchiMate layer",
    params: ["layer"],
    source: `query ontology_layer_nodes($layer: String) {
  match {
    $node: EffectFn
    $node.archimateLayer = $layer
  }
  return {
    $node
  }
}`,
  },
  ontology_governed_by: {
    name: "ontology_governed_by",
    description: "Query governing ADRs and realizing EARS specs for a symbol",
    params: ["symbol"],
    source: `query ontology_governed_by($symbol: String) {
  match {
    $tt: TraceabilityTuple
    $tt.targetSymbolQualname = $symbol
  }
  return {
    $tt.relationId as tupleId,
    $tt.adrId as adrId,
    $tt.earsSpecId as earsSpecId,
    $tt.requirementId as requirementId,
    $tt.earsPattern as earsPattern,
    $tt.targetSymbolQualname as targetQualname
  }
}`,
  },
  untested_domain_fns: {
    name: "untested_domain_fns",
    description: "Find all non-stub domain Effect functions that lack reaching test coverage",
    params: [],
    source: `query untested_domain_fns() {
  match {
    $fn: EffectFn
    ($fn.packageTag = "domain" or $fn.packageTag = "contract") and $fn.isStub = false
    not {
      $tt: TraceabilityTuple
      $test: VitestCase
      $tt playsExercisingTestRole $test
      $tt playsExercisedSpanRole $fn
    }
  }
  return {
    $fn.qualname as qualname,
    $fn.spanName as spanName,
    $fn.file as file
  }
}`,
  },
  resolve_effect_fn_fuzzy: {
    name: "resolve_effect_fn_fuzzy",
    description:
      "Typo-tolerant EffectFn resolution using Levenshtein fuzzy(..., 2) + BM25 ordering",
    params: ["query"],
    source: `query resolve_effect_fn_fuzzy($query: String) {
  match {
    $fn: EffectFn
    fuzzy($fn.spanName, $query, 2)
  }
  return {
    $fn.qualname,
    $fn.spanName,
    $fn.packageTag,
    $fn.file,
    $fn.line,
    $fn.isStub,
    bm25($fn.spanName, $query) as score
  }
  order { bm25($fn.spanName, $query) }
  limit 10
}`,
  },
  ontology_realized_by_doc: {
    name: "ontology_realized_by_doc",
    description: "Query all traceability tuples realizing a given AdrDoc or EarsSpec",
    params: ["docId"],
    source: `query ontology_realized_by_doc($docId: String) {
  match {
    $tt: TraceabilityTuple
    $tt.adrId = $docId or $tt.earsSpecId = $docId
  }
  return {
    $tt.relationId as tupleId,
    $tt.adrId as adrId,
    $tt.earsSpecId as earsSpecId,
    $tt.requirementId as requirementId,
    $tt.earsPattern as earsPattern,
    $tt.targetSymbolQualname as artifactQualname
  }
  order { $tt.targetSymbolQualname asc, $tt.relationId asc }
}`,
  },
  rank_patterns_hybrid: {
    name: "rank_patterns_hybrid",
    description: "Hybrid Scope-First, Rank-Second pattern routing via query-time embedding",
    params: ["query", "targetLayer"],
    source: `query rank_patterns_hybrid($query: String, $targetLayer: String) {
  match {
    $p: PatternDoc
    $p.archimateLayer = $targetLayer or $targetLayer = "*"
  }
  return {
    $p.slug as slug,
    $p.path as path,
    $p.title as title,
    $p.summary as summary
  }
  order { rrf(nearest($p.summaryEmbedding, $query), bm25($p.summary, $query)) }
  limit 8
}`,
  },
  rank_patterns_vector_hybrid: {
    name: "rank_patterns_vector_hybrid",
    description: "Precomputed Qwen3 vector + BM25 RRF pattern search",
    params: ["vectorQuery", "textQuery", "targetLayer"],
    source: `query rank_patterns_vector_hybrid($vectorQuery: Vector(4096), $textQuery: String, $targetLayer: String) {
  match {
    $p: PatternDoc
    $p.summaryEmbedding is not null
    $p.archimateLayer = $targetLayer or $targetLayer = "*"
  }
  return {
    $p.slug as slug,
    $p.path as path,
    $p.title as title,
    $p.summary as summary
  }
  order { rrf(nearest($p.summaryEmbedding, $vectorQuery), bm25($p.summary, $textQuery)) }
  limit 8
}`,
  },
  rank_patterns_bm25: {
    name: "rank_patterns_bm25",
    description: "Pure BM25 full-text fallback search for PatternDoc",
    params: ["query", "targetLayer"],
    source: `query rank_patterns_bm25($query: String, $targetLayer: String) {
  match {
    $p: PatternDoc
    $p.archimateLayer = $targetLayer or $targetLayer = "*"
  }
  return {
    $p.slug as slug,
    $p.path as path,
    $p.title as title,
    $p.summary as summary,
    bm25($p.summary, $query) as score
  }
  order { bm25($p.summary, $query) }
  limit 8
}`,
  },
  search_adrs_vector_hybrid: {
    name: "search_adrs_vector_hybrid",
    description: "Hybrid RRF search over AdrDoc using precomputed Qwen3 vector + BM25",
    params: ["vectorQuery", "textQuery", "status"],
    source: `query search_adrs_vector_hybrid($vectorQuery: Vector(4096), $textQuery: String, $status: String) {
  match {
    $a: AdrDoc
    $a.searchEmbedding is not null
    $a.status = $status or $status = "*"
  }
  return {
    $a.id as id,
    $a.title as title,
    $a.status as status,
    $a.path as path,
    $a.searchText as searchText
  }
  order { rrf(nearest($a.searchEmbedding, $vectorQuery), bm25($a.searchText, $textQuery)) }
  limit 10
}`,
  },
  search_adrs_bm25: {
    name: "search_adrs_bm25",
    description: "Pure BM25 fallback search over AdrDoc searchText",
    params: ["query", "status"],
    source: `query search_adrs_bm25($query: String, $status: String) {
  match {
    $a: AdrDoc
    $a.status = $status or $status = "*"
  }
  return {
    $a.id as id,
    $a.title as title,
    $a.status as status,
    $a.path as path,
    $a.searchText as searchText,
    bm25($a.searchText, $query) as score
  }
  order { bm25($a.searchText, $query) }
  limit 10
}`,
  },
  search_requirements_vector_hybrid: {
    name: "search_requirements_vector_hybrid",
    description:
      "Hybrid RRF search over EarsRequirement clauses using precomputed Qwen3 vector + BM25",
    params: ["vectorQuery", "textQuery", "status"],
    source: `query search_requirements_vector_hybrid($vectorQuery: Vector(4096), $textQuery: String, $status: String) {
  match {
    $r: EarsRequirement
    $r.clauseEmbedding is not null
    $r.status = $status or $status = "*"
  }
  return {
    $r.id as id,
    $r.specId as specId,
    $r.requirementId as requirementId,
    $r.area as area,
    $r.pattern as pattern,
    $r.clauseText as clauseText,
    $r.effectSymbol as effectSymbol,
    $r.path as path,
    $r.line as line,
    $r.status as status
  }
  order { rrf(nearest($r.clauseEmbedding, $vectorQuery), bm25($r.clauseText, $textQuery)) }
  limit 10
}`,
  },
  search_requirements_bm25: {
    name: "search_requirements_bm25",
    description: "Pure BM25 fallback search over EarsRequirement clauseText",
    params: ["query", "status"],
    source: `query search_requirements_bm25($query: String, $status: String) {
  match {
    $r: EarsRequirement
    $r.status = $status or $status = "*"
  }
  return {
    $r.id as id,
    $r.specId as specId,
    $r.requirementId as requirementId,
    $r.area as area,
    $r.pattern as pattern,
    $r.clauseText as clauseText,
    $r.effectSymbol as effectSymbol,
    $r.path as path,
    $r.line as line,
    $r.status as status,
    bm25($r.clauseText, $query) as score
  }
  order { bm25($r.clauseText, $query) }
  limit 10
}`,
  },
  rank_candidate_services_for_stub: {
    name: "rank_candidate_services_for_stub",
    description:
      "Scope-First, BM25-ranked ServiceTag discovery for stub<A, E, R>() hole completion",
    params: ["layer", "intent"],
    source: `query rank_candidate_services_for_stub($layer: String, $intent: String) {
  match {
    $svc: ServiceTag
    $svc.archimateLayer = $layer or $layer = "*"
  }
  return {
    $svc.tagId as tagId,
    $svc.qualname as qualname,
    $svc.file as file,
    bm25($svc.name, $intent) as score
  }
  order { bm25($svc.name, $intent) }
  limit 10
}`,
  },
  policy_unverified_domain_fns: {
    name: "policy_unverified_domain_fns",
    description: "GraphPolicy check: non-stub domain EffectFns lacking reaching test coverage",
    params: [],
    source: `query policy_unverified_domain_fns() {
  match {
    $fn: EffectFn
    $fn.packageTag = "domain" and $fn.isStub = false
    not {
      $tt: TraceabilityTuple
      $test: VitestCase
      $tt playsExercisingTestRole $test
      $tt playsExercisedSpanRole $fn
    }
  }
  return {
    $fn.qualname as qualname,
    $fn.spanName as spanName,
    $fn.file as file
  }
}`,
  },
  policy_orphan_effect_signatures: {
    name: "policy_orphan_effect_signatures",
    description: "GraphPolicy check: EffectSignature relation nodes missing a PlaysCallerRole edge",
    params: [],
    source: `query policy_orphan_effect_signatures() {
  match {
    $sig: EffectSignature
    not { $sig playsCallerRole $_ }
  }
  return {
    $sig.relationId as relationId,
    $sig.callerQualname as callerQualname,
    $sig.file as file
  }
}`,
  },
  workflow_pending_units: {
    name: "workflow_pending_units",
    description: "List pending WorkUnit projections belonging to a WorkflowRun",
    params: ["runId"],
    source: `query workflow_pending_units($runId: String) {
  match {
    $run: WorkflowRun
    $run.runId = $runId
    $unit: WorkUnit
    $run playsRunUnitRole $unit
    $unit.status = "pending"
  }
  return {
    $unit.unitId as unitId,
    $unit.waveIndex as waveIndex,
    $unit.kind as kind
  }
  order { $unit.waveIndex asc, $unit.unitId asc }
}`,
  },
  ears_without_completed_unit: {
    name: "ears_without_completed_unit",
    description:
      "Find EarsSpec nodes linked to a WorkflowRun that lack a completed WorkUnit in that run",
    params: ["runId"],
    source: `query ears_without_completed_unit($runId: String) {
  match {
    $run: WorkflowRun
    $run.runId = $runId
    $memberUnit: WorkUnit
    $spec: EarsSpec
    $run playsRunUnitRole $memberUnit
    $memberUnit playsUnitEarsRole $spec
    not {
      $unit: WorkUnit
      $run playsRunUnitRole $unit
      $unit playsUnitEarsRole $spec
      $unit.status = "completed"
    }
  }
  return {
    $spec.id as specId,
    $spec.path as path
  }
  order { $spec.id asc, $spec.path asc }
}`,
  },
}
