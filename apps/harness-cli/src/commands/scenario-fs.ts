import { createHash } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import { nodeSyncHostIo, resolveHarnessStateDir } from "@harness/infra"

const EXCLUDE_START = "# --- scenario-runner-hide-start ---"
const EXCLUDE_END = "# --- scenario-runner-hide-end ---"

const STAMP_IGNORED = new Set([
  ".git",
  ".harness",
  "node_modules",
  "dist",
  "coverage",
  ".nx",
  ".superpowers",
  "repos",
  ".idea",
  ".vscode",
  ".DS_Store",
  ".alchemy",
  ".vite",
  ".remember",
])

export interface ScenarioPaths {
  readonly repoRoot: string
  readonly homeDir: string
  readonly scenariosDir: string
  readonly runsDir: string
  readonly stashedScenariosDir: string
  readonly currentPointer: string
  readonly lastPointer: string
  readonly gitExcludeFile: string
}

export type ScenarioFsOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

type GitExcludeResolution =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string }

const resolveGitExcludeFile = (repoRoot: string): GitExcludeResolution => {
  const hasGit = nodeSyncHostIo.existsSync(join(repoRoot, ".git"))
  const res = nodeSyncHostIo.execFileSync(
    "git",
    ["rev-parse", "--git-path", "info/exclude"],
    { cwd: repoRoot },
  )
  const resolved = match(res)
    .with({ _tag: "Exited" }, (exited) => {
      const trimmed = exited.stdout.trim()
      if (exited.exitCode === 0 && trimmed.length > 0) {
        return { ok: true as const, path: resolve(repoRoot, trimmed) }
      }
      return {
        ok: false as const,
        detail: exited.stderr.trim() || trimmed || `git rev-parse exited with ${exited.exitCode}`,
      }
    })
    .with({ _tag: "TimedOut" }, () => ({
      ok: false as const,
      detail: "git rev-parse timed out",
    }))
    .with({ _tag: "Signaled" }, (s) => ({
      ok: false as const,
      detail: `git rev-parse terminated by signal ${s.signal}`,
    }))
    .with({ _tag: "SpawnFailed" }, (s) => ({
      ok: false as const,
      detail: s.spawnError,
    }))
    .exhaustive()
  if (resolved.ok) {
    return resolved
  }
  if (hasGit) {
    return {
      ok: false,
      error: `Failed to resolve git info/exclude in '${repoRoot}': ${resolved.detail}`,
    }
  }
  return { ok: true, path: join(repoRoot, ".git", "info", "exclude") }
}

export type MakeScenarioPathsResult =
  | { readonly ok: true; readonly paths: ScenarioPaths }
  | { readonly ok: false; readonly error: string }

export const makeScenarioPaths = (repoRoot: string): MakeScenarioPathsResult => {
  const runsDir = join(repoRoot, ".harness", "scenario-runs")
  const excludeRes = resolveGitExcludeFile(repoRoot)
  return match(excludeRes)
    .with({ ok: false }, ({ error }) => ({ ok: false as const, error }))
    .with({ ok: true }, ({ path: gitExcludeFile }) => ({
      ok: true as const,
      paths: {
        repoRoot,
        homeDir: process.env.HOME ?? "/root",
        scenariosDir: join(repoRoot, "scenarios"),
        runsDir,
        stashedScenariosDir: join(runsDir, "_stashed-scenarios"),
        currentPointer: join(runsDir, "current.json"),
        lastPointer: join(runsDir, "last.json"),
        gitExcludeFile,
      },
    }))
    .exhaustive()
}

export const resolveStateDir = (repoRoot: string): string => resolveHarnessStateDir(repoRoot)

export const activeScenariosDir = (paths: ScenarioPaths): string =>
  nodeSyncHostIo.existsSync(paths.stashedScenariosDir)
    ? paths.stashedScenariosDir
    : paths.scenariosDir

const decodeJsonRecord = Schema.decodeOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

export const refreshVerifyStampHash = (repoRoot: string): void => {
  const stateDir = resolveStateDir(repoRoot)
  const stampPath = join(stateDir, "verify-stamp.json")
  if (!nodeSyncHostIo.existsSync(stampPath)) {
    return
  }
  const files: Array<string> = []
  const walk = (dir: string): void => {
    for (const entry of nodeSyncHostIo.readdirSync(dir)) {
      if (STAMP_IGNORED.has(entry.name)) {
        continue
      }
      const full = join(dir, entry.name)
      if (full === stateDir || full.startsWith(`${stateDir}/`)) {
        continue
      }
      if (entry.isDirectory) {
        walk(full)
      } else {
        if (entry.isFile) {
          files.push(full.slice(repoRoot.length + 1).replace(/\\/g, "/"))
        }
      }
    }
  }
  walk(repoRoot)
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const hasher = createHash("sha256")
  for (const rel of files) {
    hasher.update(rel)
    hasher.update("\0")
    hasher.update(nodeSyncHostIo.readBytesSync(join(repoRoot, rel)))
  }
  const stampOpt = decodeJsonRecord(nodeSyncHostIo.readTextSync(stampPath))
  match(stampOpt)
    .with({ _tag: "Some" }, ({ value }) => {
      const updated = { ...value, treeHash: hasher.digest("hex") }
      nodeSyncHostIo.writeTextSync(stampPath, `${JSON.stringify(updated, null, 2)}\n`)
    })
    .with({ _tag: "None" }, () => {
      process.stderr.write(
        `[harness:scenario] Warning: verify-stamp.json at '${stampPath}' failed Schema decode; treeHash was not refreshed.\n`,
      )
    })
    .exhaustive()
}

export const hideScenariosFromWorkspace = (paths: ScenarioPaths): ScenarioFsOutcome => {
  nodeSyncHostIo.mkdirRecursiveSync(paths.runsDir)
  if (
    nodeSyncHostIo.existsSync(paths.scenariosDir) &&
    nodeSyncHostIo.existsSync(paths.stashedScenariosDir)
  ) {
    return {
      ok: false,
      error: `Scenario stash collision: both '${paths.scenariosDir}' and '${paths.stashedScenariosDir}' exist; refusing to clobber stashed scenarios.`,
    }
  }
  let didRename = false
  if (
    nodeSyncHostIo.existsSync(paths.scenariosDir) &&
    !nodeSyncHostIo.existsSync(paths.stashedScenariosDir)
  ) {
    nodeSyncHostIo.renameSync(paths.scenariosDir, paths.stashedScenariosDir)
    didRename = true
  }
  const rollbackRename = (): void => {
    if (
      didRename &&
      nodeSyncHostIo.existsSync(paths.stashedScenariosDir) &&
      !nodeSyncHostIo.existsSync(paths.scenariosDir)
    ) {
      nodeSyncHostIo.renameSync(paths.stashedScenariosDir, paths.scenariosDir)
    }
  }
  const postRename = Result.try(() => {
    const hasGit = nodeSyncHostIo.existsSync(join(paths.repoRoot, ".git"))
    const excludeRes = resolveGitExcludeFile(paths.repoRoot)
    if (!excludeRes.ok) {
      return { ok: false as const, error: excludeRes.error }
    }
    const excludePath = excludeRes.path
    if (hasGit && !nodeSyncHostIo.existsSync(excludePath)) {
      return { ok: false as const, error: `Git exclude file not found at '${excludePath}'` }
    }
    if (nodeSyncHostIo.existsSync(excludePath)) {
      const raw = nodeSyncHostIo.readTextSync(excludePath)
      if (!raw.includes(EXCLUDE_START)) {
        const suffix = `${raw.endsWith("\n") ? "" : "\n"}${EXCLUDE_START}\n/scenarios/\n/tools/scenario/\n${EXCLUDE_END}\n`
        nodeSyncHostIo.writeTextSync(excludePath, raw + suffix)
      }
    }
    refreshVerifyStampHash(paths.repoRoot)
    return { ok: true as const }
  })
  return match(postRename)
    .with({ _tag: "Success" }, ({ success }) => {
      if (!success.ok) {
        rollbackRename()
      }
      return success
    })
    .with({ _tag: "Failure" }, ({ failure }) => {
      rollbackRename()
      return {
        ok: false as const,
        error: `Failed to hide scenarios from workspace: ${failure instanceof Error ? failure.message : String(failure)}`,
      }
    })
    .exhaustive()
}

const mergeRestoreWithoutClobber = (
  stashedDir: string,
  targetDir: string,
  relPrefix = "",
): { readonly restoredCount: number; readonly conflicts: ReadonlyArray<string> } => {
  let restoredCount = 0
  const conflicts: Array<string> = []
  nodeSyncHostIo.mkdirRecursiveSync(targetDir)
  for (const entry of nodeSyncHostIo.readdirSync(stashedDir)) {
    const rel = relPrefix.length > 0 ? join(relPrefix, entry.name) : entry.name
    const src = join(stashedDir, entry.name)
    const dst = join(targetDir, entry.name)
    if (entry.isDirectory) {
      const sub = mergeRestoreWithoutClobber(src, dst, rel)
      restoredCount += sub.restoredCount
      conflicts.push(...sub.conflicts)
      continue
    }
    if (entry.isFile) {
      if (nodeSyncHostIo.existsSync(dst)) {
        conflicts.push(rel)
      } else {
        nodeSyncHostIo.mkdirRecursiveSync(dirname(dst))
        nodeSyncHostIo.cpRecursiveSync(src, dst)
        restoredCount += 1
      }
    }
  }
  return { restoredCount, conflicts }
}

export const restoreScenariosToWorkspace = (paths: ScenarioPaths): ScenarioFsOutcome => {
  let changed = false
  if (nodeSyncHostIo.existsSync(paths.stashedScenariosDir)) {
    if (!nodeSyncHostIo.existsSync(paths.scenariosDir)) {
      nodeSyncHostIo.renameSync(paths.stashedScenariosDir, paths.scenariosDir)
      changed = true
    } else {
      const { restoredCount, conflicts } = mergeRestoreWithoutClobber(
        paths.stashedScenariosDir,
        paths.scenariosDir,
      )
      if (restoredCount > 0) {
        changed = true
      }
      process.stderr.write(
        `[harness:scenario] Warning: dual scenario directory collision ('${paths.stashedScenariosDir}' and '${paths.scenariosDir}'); restored ${restoredCount} missing file(s), ${conflicts.length} existing file(s) preserved.\n`,
      )
      if (conflicts.length === 0) {
        nodeSyncHostIo.rmRecursiveSync(paths.stashedScenariosDir)
        changed = true
      } else {
        if (changed) {
          refreshVerifyStampHash(paths.repoRoot)
        }
        return {
          ok: false,
          error: `Scenario restore collision: refused to clobber ${conflicts.length} existing file(s) in '${paths.scenariosDir}': ${conflicts.join(", ")}`,
        }
      }
    }
  }
  if (nodeSyncHostIo.existsSync(paths.gitExcludeFile)) {
    const raw = nodeSyncHostIo.readTextSync(paths.gitExcludeFile)
    if (raw.includes(EXCLUDE_START)) {
      const cleaned = raw.replace(
        new RegExp(`\\n?${EXCLUDE_START}[\\s\\S]*?${EXCLUDE_END}\\n?`, "g"),
        "\n",
      )
      nodeSyncHostIo.writeTextSync(paths.gitExcludeFile, cleaned)
      changed = true
    }
  }
  if (changed) {
    refreshVerifyStampHash(paths.repoRoot)
  }
  return { ok: true }
}

export const extractStepGuide = (scenarioDir: string, label: string): string | undefined => {
  const mdFile = join(scenarioDir, "scenario.md")
  if (!nodeSyncHostIo.existsSync(mdFile)) {
    return undefined
  }
  const lines = nodeSyncHostIo.readTextSync(mdFile).split("\n")
  const headerRe = new RegExp(`^##\\s+${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
  const startIdx = lines.findIndex((l) => headerRe.test(l))
  if (startIdx === -1) {
    return undefined
  }
  const body: Array<string> = []
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined || /^##\s+|^---\s*$/.test(line)) {
      break
    }
    body.push(line)
  }
  return body.join("\n").trim()
}

export const listScenarios = (paths: ScenarioPaths): ReadonlyArray<string> => {
  const root = activeScenariosDir(paths)
  if (!nodeSyncHostIo.isDirectorySync(root)) {
    return []
  }
  return nodeSyncHostIo
    .readdirSync(root)
    .map((entry) => entry.name)
    .filter(
      (name) =>
        !name.startsWith("_") && nodeSyncHostIo.existsSync(join(root, name, "expectations.json")),
    )
}

export const ScenarioMarkSchema = Schema.Struct({
  label: Schema.String,
  note: Schema.optional(Schema.String),
  timestamp: Schema.String,
})
export type ScenarioMark = typeof ScenarioMarkSchema.Type

export const ScenarioPreflightSchema = Schema.Struct({
  clefModel: Schema.Boolean,
  coldMs: Schema.optional(Schema.Finite),
  warmMs: Schema.optional(Schema.Finite),
  detail: Schema.String,
})
export type ScenarioPreflight = typeof ScenarioPreflightSchema.Type

export const ScenarioRunStateSchema = Schema.Struct({
  scenario: Schema.String,
  startedAt: Schema.String,
  endedAt: Schema.optional(Schema.String),
  stateDir: Schema.String,
  preflight: ScenarioPreflightSchema,
  marks: Schema.Array(ScenarioMarkSchema),
  transcriptFile: Schema.optional(Schema.String),
})
export type ScenarioRunState = typeof ScenarioRunStateSchema.Type

export const ScenarioPointerSchema = Schema.Struct({
  runDir: Schema.String,
})
