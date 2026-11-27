import { match } from "ts-pattern"

/** Parsed and validated CLI flags for `harness mutate`. */
export interface ParsedMutateFlags {
  readonly isStrict: boolean
  readonly isAll: boolean
  readonly isDiff: boolean
  readonly disableMutantCache: boolean
  readonly failFast: boolean
  readonly stageAOnly: boolean
  readonly survivorsOnly: boolean
  readonly scope: string | undefined
  readonly targetFiles: ReadonlyArray<string> | undefined
  readonly baseRef: string | undefined
  readonly maxSurvivors: number | undefined
}

/** Closed result of parsing `harness mutate` CLI flags. */
export type ParseMutateFlagsResult =
  | { readonly _tag: "Ok"; readonly parsed: ParsedMutateFlags }
  | { readonly _tag: "Invalid"; readonly reason: string }

const BOOLEAN_FLAGS = [
  "--strict",
  "--all",
  "--diff",
  "--no-cache",
  "--fail-fast",
  "--stage-a-only",
  "--survivors-only",
] as const

type BooleanFlagName = (typeof BOOLEAN_FLAGS)[number]

const SCALAR_FLAGS = ["--scope", "--file", "--files", "--base", "--max-survivors"] as const

type ScalarFlagName = (typeof SCALAR_FLAGS)[number]

const matchScalarToken = (
  token: string,
): { readonly name: ScalarFlagName; readonly inlineValue: string | undefined } | undefined => {
  for (const name of SCALAR_FLAGS) {
    if (token === name) {
      return { name, inlineValue: undefined }
    }
    if (token.startsWith(`${name}=`)) {
      return { name, inlineValue: token.slice(name.length + 1) }
    }
  }
  return undefined
}

const parseMaxSurvivorsValue = (
  rawValue: string | undefined,
  failFast: boolean,
):
  | { readonly _tag: "Ok"; readonly maxSurvivors: number | undefined }
  | { readonly _tag: "Invalid"; readonly reason: string } => {
  if (rawValue === undefined) {
    return { _tag: "Ok", maxSurvivors: failFast ? 1 : undefined }
  }
  const trimmed = rawValue.trim()
  if (!/^[1-9]\d*$/.test(trimmed)) {
    return {
      _tag: "Invalid",
      reason: `Invalid --max-survivors value '${rawValue}': expected a positive integer >= 1.`,
    }
  }
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return {
      _tag: "Invalid",
      reason: `Invalid --max-survivors value '${rawValue}': expected a positive safe integer >= 1.`,
    }
  }
  return { _tag: "Ok", maxSurvivors: parsed }
}

/** Parses and validates all `harness mutate` flags, failing closed on invalid inputs. */
export const parseMutateCliFlags = (argv: ReadonlyArray<string>): ParseMutateFlagsResult => {
  const tokens = argv[0] === "mutate" ? argv.slice(1) : argv
  const boolValues: Record<BooleanFlagName, boolean> = {
    "--strict": false,
    "--all": false,
    "--diff": false,
    "--no-cache": false,
    "--fail-fast": false,
    "--stage-a-only": false,
    "--survivors-only": false,
  }
  const scalarValues: Partial<Record<ScalarFlagName, string>> = {}

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === undefined) {
      continue
    }

    const matchedBool = BOOLEAN_FLAGS.find((flag) => flag === token)
    if (matchedBool !== undefined) {
      boolValues[matchedBool] = true
      continue
    }

    const matchedScalar = matchScalarToken(token)
    if (matchedScalar !== undefined) {
      if (scalarValues[matchedScalar.name] !== undefined) {
        return {
          _tag: "Invalid",
          reason: `Duplicate flag ${matchedScalar.name} for 'harness mutate'.`,
        }
      }
      if (matchedScalar.inlineValue !== undefined) {
        if (matchedScalar.inlineValue.trim().length === 0) {
          return {
            _tag: "Invalid",
            reason: `Flag ${matchedScalar.name} requires a non-empty value.`,
          }
        }
        scalarValues[matchedScalar.name] = matchedScalar.inlineValue
        continue
      }
      const next = tokens[i + 1]
      if (next === undefined || next.trim().length === 0 || next.startsWith("--")) {
        return {
          _tag: "Invalid",
          reason: `Flag ${matchedScalar.name} requires a non-empty value.`,
        }
      }
      scalarValues[matchedScalar.name] = next
      i += 1
      continue
    }

    if (token.startsWith("-")) {
      return {
        _tag: "Invalid",
        reason: `Unknown flag '${token}' for 'harness mutate'.`,
      }
    }

    return {
      _tag: "Invalid",
      reason: `Unexpected positional argument '${token}' for 'harness mutate'.`,
    }
  }

  const scope = scalarValues["--scope"]
  const rawFileCsv = scalarValues["--file"]
  const rawFilesCsv = scalarValues["--files"]
  const baseRef = scalarValues["--base"]

  if (rawFileCsv !== undefined && rawFilesCsv !== undefined) {
    return {
      _tag: "Invalid",
      reason: "Cannot specify both --file and --files for 'harness mutate'.",
    }
  }

  if (baseRef !== undefined && baseRef.startsWith("-")) {
    return {
      _tag: "Invalid",
      reason: `Invalid --base ref '${baseRef}': must not start with '-'.`,
    }
  }

  const fileCsv = rawFileCsv ?? rawFilesCsv
  const fileFlagName = rawFilesCsv !== undefined ? "--files" : "--file"
  const targetFiles =
    fileCsv !== undefined
      ? fileCsv
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : undefined

  if (targetFiles !== undefined && targetFiles.length === 0) {
    return {
      _tag: "Invalid",
      reason: `Empty ${fileFlagName} target list; refusing to run mutation suite.`,
    }
  }

  const failFast = boolValues["--fail-fast"]
  return match(parseMaxSurvivorsValue(scalarValues["--max-survivors"], failFast))
    .with({ _tag: "Invalid" }, (err) => err)
    .with({ _tag: "Ok" }, ({ maxSurvivors }) => ({
      _tag: "Ok" as const,
      parsed: {
        isStrict: boolValues["--strict"],
        isAll: boolValues["--all"],
        isDiff: boolValues["--diff"],
        disableMutantCache: boolValues["--no-cache"],
        failFast,
        stageAOnly: boolValues["--stage-a-only"],
        survivorsOnly: boolValues["--survivors-only"],
        scope,
        targetFiles,
        baseRef,
        maxSurvivors,
      },
    }))
    .exhaustive()
}
