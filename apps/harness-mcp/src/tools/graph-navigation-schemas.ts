import { Schema } from "effect"

const BoundedSymbolOrSpan = Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 512)))
const BoundedRepoRoot = Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 1024)))

const makeSymbolQueryInputSchema = (description: string) =>
  Schema.Struct({
    symbolOrSpan: BoundedSymbolOrSpan.annotate({ description }),
    repoRoot: Schema.optional(
      BoundedRepoRoot.annotate({
        description: "Optional repository root path",
      }),
    ),
  })

export const ResolveInputSchema = makeSymbolQueryInputSchema("Symbol or span name to resolve")
export const CallersInputSchema = makeSymbolQueryInputSchema(
  "Symbol or span name to query callers for",
)
export const CalleesInputSchema = makeSymbolQueryInputSchema(
  "Symbol or span name to query callees for",
)
export const TestsReachingInputSchema = makeSymbolQueryInputSchema(
  "Symbol or span name to find reaching tests for",
)

export const StructuralSearchInputSchema = Schema.Struct({
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

export const RouteInputSchema = Schema.Struct({
  planStep: Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 4096))).annotate({
    description: "Implementation plan step text to route to an Effect idiom block",
  }),
  repoRoot: Schema.optional(
    BoundedRepoRoot.annotate({
      description: "Optional repository root path",
    }),
  ),
})

export const decodeResolveInput = Schema.decodeUnknownEffect(ResolveInputSchema)
export const decodeStructuralSearchInput = Schema.decodeUnknownEffect(StructuralSearchInputSchema)
export const decodeRouteInput = Schema.decodeUnknownEffect(RouteInputSchema)
