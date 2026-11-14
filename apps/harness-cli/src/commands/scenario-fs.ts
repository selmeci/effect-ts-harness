import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import { Schema } from "effect"
import { match } from "ts-pattern"
import { nodeSyncHostIo } from "@harness/infra"

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

const resolveGitExcludeFile = (repoRoot: string): string => {
  const res = nodeSyncHostIo.execFileSync(
    "git",
    ["rev-parse", "--git-path", "info/exclude"],
    { cwd: repoRoot },
  )
  const trimmed = res.stdout.trim()
  if (res.exitCode === 0 && trimmed.length > 0) {
    return resolve(repoRoot, trimmed)
  }
  return join(repoRoot, ".git", "info", "exclude")
}

export const makeScenarioPaths = (repoRoot: string): ScenarioPaths => {
  const runsDir = join(repoRoot, ".harness", "scenario-runs")
  return {
    repoRoot,
    homeDir: process.env.HOME ?? "/root",
    scenariosDir: join(repoRoot, "scenarios"),
    runsDir,
    stashedScenariosDir: join(runsDir, "_stashed-scenarios"),
    currentPointer: join(runsDir, "current.json"),
    lastPointer: join(runsDir, "last.json"),
    gitExcludeFile: resolveGitExcludeFile(repoRoot),
  }
}

export const resolveStateDir = (repoRoot: string): string => {
  const custom = process.env.HARNESS_STATE_DIR?.trim()
  if (custom !== undefined && custom.length > 0) {
    return resolve(repoRoot, custom)
  }
  const worktreeId = process.env.HARNESS_WORKTREE_ID?.trim()
  if (worktreeId !== undefined && worktreeId.length > 0) {
    return join(repoRoot, ".harness", "worktrees", worktreeId.replace(/[^a-zA-Z0-9._-]/g, "_"))
  }
  return join(repoRoot, ".harness")
}

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
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()
}

export const hideScenariosFromWorkspace = (paths: ScenarioPaths): void => {
  nodeSyncHostIo.mkdirRecursiveSync(paths.runsDir)
  if (
    nodeSyncHostIo.existsSync(paths.scenariosDir) &&
    !nodeSyncHostIo.existsSync(paths.stashedScenariosDir)
  ) {
    nodeSyncHostIo.renameSync(paths.scenariosDir, paths.stashedScenariosDir)
  }
  if (nodeSyncHostIo.existsSync(paths.gitExcludeFile)) {
    const raw = nodeSyncHostIo.readTextSync(paths.gitExcludeFile)
    if (!raw.includes(EXCLUDE_START)) {
      const suffix = `${raw.endsWith("\n") ? "" : "\n"}${EXCLUDE_START}\n/scenarios/\n/tools/scenario/\n${EXCLUDE_END}\n`
      nodeSyncHostIo.writeTextSync(paths.gitExcludeFile, raw + suffix)
    }
  }
  refreshVerifyStampHash(paths.repoRoot)
}

export const restoreScenariosToWorkspace = (paths: ScenarioPaths): void => {
  let changed = false
  if (
    nodeSyncHostIo.existsSync(paths.stashedScenariosDir) &&
    !nodeSyncHostIo.existsSync(paths.scenariosDir)
  ) {
    nodeSyncHostIo.renameSync(paths.stashedScenariosDir, paths.scenariosDir)
    changed = true
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
