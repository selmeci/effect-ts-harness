import { execSync, spawnSync } from "node:child_process"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import { resolve } from "node:path"
import process from "node:process"
import { buildOpenApiSpec, detectOpenApiBreakingChanges } from "../src/index.js"

const openApiPath = resolve(import.meta.dirname, "../openapi.json")
const shouldWrite = process.argv.includes("--write")

const currentSpec = buildOpenApiSpec()
const currentJson = JSON.stringify(currentSpec, null, 2) + "\n"

if (shouldWrite) {
  writeFileSync(openApiPath, currentJson, "utf8")
  console.log("Successfully wrote openapi.json")
  process.exit(0)
}

if (!existsSync(openApiPath)) {
  console.error(
    "ERROR: openapi.json does not exist. Run scripts/check-openapi.mjs --write to generate it.",
  )
  process.exit(1)
}

const committedJson = readFileSync(openApiPath, "utf8")
const committedSpec = JSON.parse(committedJson)

// 1. Resolve baseline JSON
let baselineJson = null
let baselineSource = null

// Check --baseline <path>
const baselineFlagIndex = process.argv.indexOf("--baseline")
if (baselineFlagIndex !== -1 && baselineFlagIndex + 1 < process.argv.length) {
  const cliBaselinePath = process.argv[baselineFlagIndex + 1]
  if (existsSync(cliBaselinePath)) {
    baselineJson = readFileSync(cliBaselinePath, "utf8")
    baselineSource = `file:${cliBaselinePath}`
  }
}

// Check process.env.OPENAPI_BASELINE_PATH
if (baselineJson == null && process.env.OPENAPI_BASELINE_PATH) {
  if (existsSync(process.env.OPENAPI_BASELINE_PATH)) {
    baselineJson = readFileSync(process.env.OPENAPI_BASELINE_PATH, "utf8")
    baselineSource = `env:${process.env.OPENAPI_BASELINE_PATH}`
  }
}

// Check git show main:libs/sample/contract/openapi.json
if (baselineJson == null) {
  try {
    const gitMain = execSync("git show main:libs/sample/contract/openapi.json 2>/dev/null", {
      encoding: "utf8",
    })
    if (gitMain.trim().length > 0) {
      baselineJson = gitMain
      baselineSource = "git:main"
    }
  } catch {
    // ignore
  }
}

// Check git show HEAD:libs/sample/contract/openapi.json
if (baselineJson == null) {
  try {
    const gitHead = execSync("git show HEAD:libs/sample/contract/openapi.json 2>/dev/null", {
      encoding: "utf8",
    })
    if (gitHead.trim().length > 0) {
      baselineJson = gitHead
      baselineSource = "git:HEAD"
    }
  } catch {
    // ignore
  }
}

// Fallback to committed openapi.json
if (baselineJson == null) {
  baselineJson = committedJson
  baselineSource = "committed"
}

let baselineSpec
try {
  baselineSpec = JSON.parse(baselineJson)
} catch (e) {
  console.error(`ERROR: Failed to parse baseline JSON from ${baselineSource}:`, e)
  process.exit(1)
}

// 2. Check for breaking changes against baseline first (exiting 2 with ESCALATE on breaking change)
let oasdiffAvailable = false
try {
  const check = spawnSync("oasdiff", ["--version"], { stdio: "ignore" })
  oasdiffAvailable = check.status === 0
} catch {
  oasdiffAvailable = false
}

if (oasdiffAvailable) {
  const tmpBaselinePath = resolve(
    os.tmpdir(),
    `harness-baseline-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  )
  try {
    writeFileSync(tmpBaselinePath, baselineJson, "utf8")
    const result = spawnSync("oasdiff", ["breaking", tmpBaselinePath, openApiPath], {
      stdio: "pipe",
      encoding: "utf8",
    })
    if (result.status !== 0) {
      console.error(
        "openapi check: ESCALATE — breaking OpenAPI changes require human confirmation:",
      )
      if (result.stderr) console.error(result.stderr)
      if (result.stdout) console.error(result.stdout)
      process.exit(2)
    }
  } finally {
    rmSync(tmpBaselinePath, { force: true })
  }
}

// Also run detectOpenApiBreakingChanges
const breakingChanges = detectOpenApiBreakingChanges(baselineSpec, currentSpec)
if (breakingChanges.length > 0) {
  console.error("openapi check: ESCALATE — breaking OpenAPI changes require human confirmation:")
  for (const change of breakingChanges) {
    console.error(` - ${change}`)
  }
  process.exit(2)
}

// 3. Check snapshot freshness (exit 1 on uncommitted snapshot drift)
if (JSON.stringify(committedSpec) !== JSON.stringify(currentSpec)) {
  console.error("ERROR: openapi.json is stale and does not match SampleApi.")
  console.error(
    "Run `node --import ../../../tools/node-ts-resolver.mjs scripts/check-openapi.mjs --write` to update it.",
  )
  process.exit(1)
}

console.log("OpenAPI check passed: openapi.json is fresh and backward-compatible.")
