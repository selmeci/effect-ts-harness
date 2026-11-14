import * as fs from "node:fs"
import * as path from "node:path"
import { Cause, Effect, Option, Schema } from "effect"
import {
  decideStructuralSearch,
  findCallees,
  findCallers,
  findTestsReaching,
  resolveNode,
} from "@harness/graph"
import { LocalDecisionModel, routeStep } from "@harness/decision"
import { nodeSyncHostIo } from "@harness/infra"
import {
  isPathInsideRoot,
  McpToolName,
  type McpToolPluginDescriptor,
  normalizeProjectPath,
  resolveDefaultRepoRoot,
  resolveGraph,
  type ServerOptions,
} from "./mcp-helpers.js"

export { isPathInsideRoot, normalizeProjectPath, resolveDefaultRepoRoot, resolveGraph }

const ResolveInputSchema = Schema.Struct({
  symbolOrSpan: Schema.String.annotate({
    description: "Symbol or span name to resolve",
  }),
  repoRoot: Schema.optional(
    Schema.String.annotate({
      description: "Optional repository root path",
    }),
  ),
})

const CallersInputSchema = Schema.Struct({
  symbolOrSpan: Schema.String.annotate({
    description: "Symbol or span name to query callers for",
  }),
  repoRoot: Schema.optional(
    Schema.String.annotate({
      description: "Optional repository root path",
    }),
  ),
})

const CalleesInputSchema = Schema.Struct({
  symbolOrSpan: Schema.String.annotate({
    description: "Symbol or span name to query callees for",
  }),
  repoRoot: Schema.optional(
    Schema.String.annotate({
      description: "Optional repository root path",
    }),
  ),
})

const TestsReachingInputSchema = Schema.Struct({
  symbolOrSpan: Schema.String.annotate({
    description: "Symbol or span name to find reaching tests for",
  }),
  repoRoot: Schema.optional(
    Schema.String.annotate({
      description: "Optional repository root path",
    }),
  ),
})

const StructuralSearchInputSchema = Schema.Struct({
  pattern: Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 2048))).annotate({
    description: "ast-grep pattern to search for across workspace TypeScript files",
  }),
  filePath: Schema.optional(
    Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 512))).annotate({
      description: "Optional relative or absolute file path to scope search to a single file",
    }),
  ),
  paths: Schema.optional(
    Schema.Array(Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 512))))
      .pipe(Schema.check(Schema.isMaxLength(100)))
      .annotate({
        description: "Optional list of file or directory paths to scope search",
      }),
  ),
  subDirs: Schema.optional(
    Schema.Array(Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 256))))
      .pipe(Schema.check(Schema.isMaxLength(50)))
      .annotate({
        description: "Optional workspace subdirectories to search (defaults to ['libs', 'apps'])",
      }),
  ),
  repoRoot: Schema.optional(
    Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 1024))).annotate({
      description: "Optional repository or worktree root directory",
    }),
  ),
})

const RouteInputSchema = Schema.Struct({
  planStep: Schema.String.annotate({
    description: "Implementation plan step text to route to an Effect idiom block",
  }),
  repoRoot: Schema.optional(
    Schema.String.annotate({
      description: "Optional repository root path",
    }),
  ),
})

const decodeResolveInput = Schema.decodeUnknownEffect(ResolveInputSchema)
const decodeStructuralSearchInput = Schema.decodeUnknownEffect(StructuralSearchInputSchema)
const decodeRouteInput = Schema.decodeUnknownEffect(RouteInputSchema)

export const buildGraphNavigationToolDescriptors = (
  options?: ServerOptions,
): ReadonlyArray<McpToolPluginDescriptor> => [
  {
    name: McpToolName.make("harness_resolve"),
    description: "Resolve a symbol or span name to its node in the Effect graph",
    inputSchema: ResolveInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const { symbolOrSpan } = yield* decodeResolveInput(args)
        const graph = yield* resolveGraph(options, args)
        return resolveNode(graph, symbolOrSpan) ?? null
      }),
  },
  {
    name: McpToolName.make("harness_callers"),
    description: "Find callers of an Effect function, service, or layer",
    inputSchema: CallersInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const { symbolOrSpan } = yield* decodeResolveInput(args)
        const graph = yield* resolveGraph(options, args)
        return findCallers(graph, symbolOrSpan)
      }),
  },
  {
    name: McpToolName.make("harness_callees"),
    description: "Find callees of an Effect function, service, or layer",
    inputSchema: CalleesInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const { symbolOrSpan } = yield* decodeResolveInput(args)
        const graph = yield* resolveGraph(options, args)
        return findCallees(graph, symbolOrSpan)
      }),
  },
  {
    name: McpToolName.make("harness_tests_reaching"),
    description: "Find all Vitest test cases reaching a given symbol or span",
    inputSchema: TestsReachingInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const { symbolOrSpan } = yield* decodeResolveInput(args)
        const graph = yield* resolveGraph(options, args)
        return findTestsReaching(graph, symbolOrSpan)
      }),
  },
  {
    name: McpToolName.make("harness_structural_search"),
    description: "Perform structural AST search using ast-grep across workspace TypeScript code",
    inputSchema: StructuralSearchInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const input = yield* decodeStructuralSearchInput(args)
        const root = options?.repoRoot ?? resolveDefaultRepoRoot(args)
        return yield* decideStructuralSearch({
          pattern: input.pattern,
          repoRoot: root,
          filePath: input.filePath,
          paths: input.paths,
          subDirs: input.subDirs,
          hostIo: nodeSyncHostIo,
        })
      }),
  },
  {
    name: McpToolName.make("harness_route"),
    description:
      "Route an implementation plan step to an Effect idiom building block using local decision model",
    inputSchema: RouteInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const { planStep } = yield* decodeRouteInput(args)
        const decisionLayer = options?.decisionLayer ?? LocalDecisionModel
        const routedOpt = yield* routeStep(planStep).pipe(
          Effect.provide(decisionLayer),
          Effect.timeoutOption("1500 millis"),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeedNone,
          ),
        )
        let block: string = Option.getOrElse(routedOpt, () => "review")
        const root = options?.repoRoot ?? resolveDefaultRepoRoot(args)
        if (block === "review") {
          const patternsDir = path.join(root, "agent-patterns")
          if (fs.existsSync(patternsDir)) {
            const files = fs.readdirSync(patternsDir, "utf8")
            const stepLower = planStep.toLowerCase()
            const candidates = files
              .filter((f: string) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
              .map((f: string) => f.replace(/\.md$/, ""))
              .sort((a: string, b: string) => b.length - a.length)
            for (const slug of candidates) {
              const words = slug.split("-").filter((w: string) => w.length > 0)
              if (words.length > 0 && words.every((w: string) => stepLower.includes(w))) {
                block = slug
                break
              }
            }
          }
        }
        const patternFile =
          block === "review" || block === "effect" ? null : `agent-patterns/${block}.md`
        return { block, patternFile }
      }),
  },
]
