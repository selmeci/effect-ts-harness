import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  AttemptNumber,
  type CompiledWorkUnit,
  OwnedRelPath,
  SliceBranchName,
  WaveIndex,
  WorkUnitId,
} from "@harness/contract"
import { TypedHoleContextBundle } from "@harness/graph"
import { buildUnitBrief, parseAntigravityOutput, parseClaudeCodeOutput } from "../src/index.js"

const CWD = AbsoluteRepoRoot.make("/tmp/wf5-pure-boundaries-repo")

const makeSliceUnit = (ownedRelPaths: ReadonlyArray<OwnedRelPath>): CompiledWorkUnit => ({
  _tag: "SliceUnit",
  unitId: WorkUnitId.make("slice-boundary"),
  waveIndex: WaveIndex.make(0),
  dependsOn: [],
  ownedRelPaths: [...ownedRelPaths],
  earsKeys: [],
  branch: SliceBranchName.make("slice/boundary-1"),
})

const buildExactOwnedRelPaths = (targetJoinedChars: number): ReadonlyArray<OwnedRelPath> => {
  // Each formatted line is `- <path>`, separated by `\n`. For k lines: sum(len(path_i)) + 3*k - 1 = targetJoinedChars.
  const paths: Array<OwnedRelPath> = []
  let currentJoinedLen = 0
  let idx = 0
  while (true) {
    const remaining = targetJoinedChars - currentJoinedLen
    const prefixAndSep = paths.length === 0 ? 2 : 3
    if (remaining - prefixAndSep <= 240) {
      const slugLen = remaining - prefixAndSep - 6
      if (slugLen < 1) {
        throw new Error(`Unexpected exact-fit slug length ${slugLen}`)
      }
      paths.push(OwnedRelPath.make(`p${String(idx).padStart(4, "0")}/${"x".repeat(slugLen)}`))
      break
    }
    const chunkPath = `p${String(idx).padStart(4, "0")}/${"x".repeat(200)}`
    paths.push(OwnedRelPath.make(chunkPath))
    currentJoinedLen += prefixAndSep + chunkPath.length
    idx += 1
  }
  return paths
}

describe("WF-5 pure mutation-killing boundary guards", () => {
  it("parseClaudeCodeOutput classifies non-zero exit vs zero exit on non-result Claude envelope types", () => {
    const payload = JSON.stringify({ type: "system", subtype: "init" })

    const errNonZero = parseClaudeCodeOutput(2, payload, "fatal stderr")
    expect(Result.isFailure(errNonZero)).toBe(true)
    match(errNonZero)
      .with({ _tag: "Failure" }, ({ failure }) => {
        expect(failure._tag).toBe("AgentExitError")
        match(failure)
          .with({ _tag: "AgentExitError" }, (e) => {
            expect(e.exit).toBe(2)
            expect(e.detail).toContain("fatal stderr")
          })
          .with(
            { _tag: "AgentTimeoutError" },
            { _tag: "AgentToolDeniedError" },
            { _tag: "AgentAuthRequiredError" },
            { _tag: "AgentOutputParseError" },
            { _tag: "AgentNoChangeError" },
            () => expect.unreachable("Expected AgentExitError"),
          )
          .exhaustive()
      })
      .with({ _tag: "Success" }, () => expect.unreachable("Expected Failure"))
      .exhaustive()

    const errZero = parseClaudeCodeOutput(0, payload, "")
    match(errZero)
      .with({ _tag: "Failure" }, ({ failure }) => {
        expect(failure._tag).toBe("AgentOutputParseError")
      })
      .with({ _tag: "Success" }, () => expect.unreachable("Expected Failure"))
      .exhaustive()
  })

  it("buildUnitBrief preserves exact-budget hole section without truncation (unit-brief-builder:114)", () => {
    const unit = makeSliceUnit([OwnedRelPath.make("libs/alpha/src/index.ts")])
    const makeHole = (sig: string): TypedHoleContextBundle =>
      Schema.decodeSync(TypedHoleContextBundle)({
        holeQualname: "Alpha.exactBoundary",
        spanName: "Alpha.exactBoundary",
        estimatedTokens: 10,
        successTypeSignature: sig,
        allowedErrorConstructors: [],
        requiredServiceCapabilities: [],
        inhabitingCandidates: [],
      })

    const dry = buildUnitBrief({
      unit,
      attempt: AttemptNumber.make(1),
      cwd: CWD,
      holeBundles: [makeHole("SIG")],
    })
    const remainingToExactMax = 65_536 - dry.promptText.length
    expect(remainingToExactMax).toBeGreaterThan(100)

    const exactSig = `SIG_${"h".repeat(remainingToExactMax - 1)}`
    const exactBrief = buildUnitBrief({
      unit,
      attempt: AttemptNumber.make(1),
      cwd: CWD,
      holeBundles: [makeHole(exactSig)],
    })
    expect(exactBrief.promptText.length).toBe(65_536)
    expect(exactBrief.promptText).toContain(exactSig)
    expect(exactBrief.promptText).not.toContain("... [truncated]")
  })

  it("buildUnitBrief preserves exact-budget ownedRelPaths and exact-budget compacted prefix item (unit-brief-builder:129,142)", () => {
    const dryUnit = makeSliceUnit([OwnedRelPath.make("libs/seed.ts")])
    const dryBrief = buildUnitBrief({
      unit: dryUnit,
      attempt: AttemptNumber.make(1),
      cwd: CWD,
    })
    const seedLineLen = "- libs/seed.ts".length
    const exactJoinedBudget = seedLineLen + (65_536 - dryBrief.promptText.length)

    // Boundary 1 (line 129): fullJoined.length === ownedPathsBudget with short final line ("\n- z" = 4 < 35 notice) keeps all ownedRelPaths only when fast-path uses <=.
    const exactPaths = [...buildExactOwnedRelPaths(exactJoinedBudget - 4), OwnedRelPath.make("z")]
    const exactBrief = buildUnitBrief({
      unit: makeSliceUnit(exactPaths),
      attempt: AttemptNumber.make(1),
      cwd: CWD,
    })
    const lastExactPath = exactPaths[exactPaths.length - 1]!
    expect(exactBrief.promptText.length).toBe(65_536)
    expect(exactBrief.promptText).toContain(lastExactPath)
    expect(exactBrief.promptText).not.toContain("more owned paths truncated)")

    // Boundary 1b (unit-brief-builder:351): fullJoined.length === ownedPathsBudget + 1 truncates only when budget uses - 1.
    const overByOnePaths = [...exactPaths.slice(0, -1), OwnedRelPath.make("zz")]
    const overByOneBrief = buildUnitBrief({
      unit: makeSliceUnit(overByOnePaths),
      attempt: AttemptNumber.make(1),
      cwd: CWD,
    })
    expect(overByOneBrief.promptText).toContain("more owned paths truncated)")
    expect(overByOneBrief.promptText).not.toContain("- zz")
    expect(overByOneBrief.promptText.length).toBeLessThanOrEqual(65_536)

    // Boundary 2 (unit-brief-builder:139,142): 9 tail items give 1-digit notice (37 chars) vs mutated i-1 giving 11 (38 chars).
    const tailPaths = Array.from({ length: 9 }, (_, i) =>
      OwnedRelPath.make(`q${String(i).padStart(4, "0")}/${"y".repeat(40)}`),
    )
    const noticeLen = `\n... (+9 more owned paths truncated)`.length

    const exactFirstTwoBudget = exactJoinedBudget - noticeLen
    const exactFirstTwoPaths = buildExactOwnedRelPaths(exactFirstTwoBudget)
    const exactLoopUnit = makeSliceUnit([...exactFirstTwoPaths, ...tailPaths])
    const exactLoopBrief = buildUnitBrief({
      unit: exactLoopUnit,
      attempt: AttemptNumber.make(1),
      cwd: CWD,
    })
    const secondKeptPath = exactFirstTwoPaths[exactFirstTwoPaths.length - 1]!
    expect(exactLoopBrief.promptText).toContain(secondKeptPath)
    expect(exactLoopBrief.promptText).toContain("... (+9 more owned paths truncated)")
    expect(exactLoopBrief.promptText).not.toContain(tailPaths[0]!)
    expect(exactLoopBrief.promptText.length).toBeLessThanOrEqual(65_536)

    // Boundary 3 (unit-brief-builder:117): bodyBudget === 15 (TRUNCATION_MARKER.length) keeps 15 body chars when using <=.
    const holePrefix = "Typed hole context (bounded <= 1500 tokens):\n<typed-hole-context>\n"
    const holeSuffix = "\n</typed-hole-context>"
    const exactRemainingFor15 = 2 + holePrefix.length + holeSuffix.length + 15
    const tightUnit = makeSliceUnit(
      buildExactOwnedRelPaths(exactJoinedBudget - exactRemainingFor15),
    )
    const tightBrief = buildUnitBrief({
      unit: tightUnit,
      attempt: AttemptNumber.make(1),
      cwd: CWD,
      holeBundles: [
        Schema.decodeSync(TypedHoleContextBundle)({
          holeQualname: "Alpha.exactBoundary",
          spanName: "Alpha.exactBoundary",
          estimatedTokens: 10,
          successTypeSignature: "Z".repeat(50),
          allowedErrorConstructors: [],
          requiredServiceCapabilities: [],
          inhabitingCandidates: [],
        }),
      ],
    })
    expect(tightBrief.promptText).toContain(
      "<typed-hole-context>\n- Alpha.exactBo\n</typed-hole-context>",
    )
    expect(tightBrief.promptText).not.toContain("... [truncated]")
    expect(tightBrief.promptText.length).toBe(65_536)
  })

  it("AUTH_PROMPT_RE ignores filename/path prose like unauthorized.ts while keeping 401/auth classifications", () => {
    for (const prose of [
      "tsc error in src/unauthorized.ts: expected 401",
      "failed in unauthenticated_helper",
      "test foo.unauthorized crashed",
    ]) {
      const claudeRes = parseClaudeCodeOutput(
        1,
        JSON.stringify({ is_error: true, result: prose }),
        "",
      )
      match(claudeRes)
        .with({ _tag: "Failure" }, ({ failure }) => {
          expect(failure._tag).toBe("AgentExitError")
        })
        .with({ _tag: "Success" }, () => expect.unreachable("Expected Failure"))
        .exhaustive()

      const agyRes = parseAntigravityOutput(
        1,
        JSON.stringify({ status: "ERROR", response: prose }),
        "",
      )
      match(agyRes)
        .with({ _tag: "Failure" }, ({ failure }) => {
          expect(failure._tag).toBe("AgentExitError")
        })
        .with({ _tag: "Success" }, () => expect.unreachable("Expected Failure"))
        .exhaustive()
    }

    const authClaude = parseClaudeCodeOutput(1, "", "Authentication required.")
    match(authClaude)
      .with({ _tag: "Failure" }, ({ failure }) => {
        expect(failure._tag).toBe("AgentAuthRequiredError")
      })
      .with({ _tag: "Success" }, () => expect.unreachable("Expected Failure"))
      .exhaustive()
  })
})
