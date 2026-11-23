import { Option, Schema } from "effect"
import { match } from "ts-pattern"
import { SubprocessArg, SubprocessCommand } from "./workspace-and-process.js"

const NX_PROJECT_NAME_RE = /^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/
const NX_RUN_VERIFY_COMMAND_RE =
  /^(pnpm )?nx run ((?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*):(verify|test|typecheck|lint)$/
const NX_AFFECTED_VERIFY_COMMAND_RE =
  /^(pnpm )?nx affected (-t|--target) (verify|test|typecheck|lint)$/
const PNPM_FILTER_VERIFY_COMMAND_RE =
  /^pnpm --filter ((?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*) (verify|test|typecheck|lint)$/
const SAFE_PACKAGE_VERIFY_COMMAND_RE =
  /^(?:(?:pnpm )?nx run (?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*:(?:verify|test|typecheck|lint)|(?:pnpm )?nx affected (?:-t|--target) (?:verify|test|typecheck|lint)|pnpm --filter (?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]* (?:verify|test|typecheck|lint))$/

export const NxProjectName = Schema.String.pipe(
  Schema.check(Schema.isPattern(NX_PROJECT_NAME_RE)),
  Schema.brand("NxProjectName"),
)
export type NxProjectName = typeof NxProjectName.Type

/**
 * Safe package verification command (`1..512` chars): restricted to `nx run <project>:<target>`,
 * `nx affected -t|--target <target>`, or `pnpm --filter <project> <target>` for
 * `verify | test | typecheck | lint` without shell metacharacters or control characters.
 */
export const PackageVerifyCommand = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(512)),
  Schema.check(Schema.isPattern(SAFE_PACKAGE_VERIFY_COMMAND_RE)),
  Schema.brand("PackageVerifyCommand"),
)
export type PackageVerifyCommand = typeof PackageVerifyCommand.Type

export const PackageVerifyExecutable = Schema.Literals(["pnpm", "nx"])
export type PackageVerifyExecutable = typeof PackageVerifyExecutable.Type

export const PackageVerifyTarget = Schema.Literals(["verify", "test", "typecheck", "lint"])
export type PackageVerifyTarget = typeof PackageVerifyTarget.Type

export const NxAffectedTargetFlag = Schema.Literals(["-t", "--target"])
export type NxAffectedTargetFlag = typeof NxAffectedTargetFlag.Type

/** Parsed representation of a validated `PackageVerifyCommand`. */
export const ParsedPackageVerifyCommand = Schema.TaggedUnion({
  NxRun: {
    executable: PackageVerifyExecutable,
    projectName: NxProjectName,
    target: PackageVerifyTarget,
  },
  NxAffected: {
    executable: PackageVerifyExecutable,
    targetFlag: NxAffectedTargetFlag,
    target: PackageVerifyTarget,
  },
  PnpmFilter: {
    projectName: NxProjectName,
    target: PackageVerifyTarget,
  },
})
export type ParsedPackageVerifyCommand = typeof ParsedPackageVerifyCommand.Type

/** Resolved executable + argument vector derived from a `ParsedPackageVerifyCommand`. */
export const PackageVerifyCommandArgv = Schema.Struct({
  executable: SubprocessCommand,
  args: Schema.Array(SubprocessArg),
})
export type PackageVerifyCommandArgv = typeof PackageVerifyCommandArgv.Type

const decodePackageVerifyTarget = Schema.decodeUnknownOption(PackageVerifyTarget)
const decodeNxAffectedTargetFlag = Schema.decodeUnknownOption(NxAffectedTargetFlag)

/** Parses a `PackageVerifyCommand` string into its typed union variant (`Option.none` if invalid). */
export const parsePackageVerifyCommand = (
  command: PackageVerifyCommand,
): Option.Option<ParsedPackageVerifyCommand> => {
  const nxRunMatch = NX_RUN_VERIFY_COMMAND_RE.exec(command)
  if (nxRunMatch !== null) {
    const [, pnpmPrefix, project, target] = nxRunMatch
    if (project !== undefined && target !== undefined) {
      return match(decodePackageVerifyTarget(target))
        .with({ _tag: "None" }, () => Option.none())
        .with({ _tag: "Some" }, ({ value: decodedTarget }) =>
          Option.some(
            ParsedPackageVerifyCommand.cases.NxRun.make({
              executable: PackageVerifyExecutable.make(pnpmPrefix !== undefined ? "pnpm" : "nx"),
              projectName: NxProjectName.make(project),
              target: decodedTarget,
            }),
          ),
        )
        .exhaustive()
    }
  }
  const nxAffectedMatch = NX_AFFECTED_VERIFY_COMMAND_RE.exec(command)
  if (nxAffectedMatch !== null) {
    const [, pnpmPrefix, targetFlag, target] = nxAffectedMatch
    if (targetFlag !== undefined && target !== undefined) {
      return match(decodeNxAffectedTargetFlag(targetFlag))
        .with({ _tag: "None" }, () => Option.none())
        .with({ _tag: "Some" }, ({ value: decodedFlag }) =>
          match(decodePackageVerifyTarget(target))
            .with({ _tag: "None" }, () => Option.none())
            .with({ _tag: "Some" }, ({ value: decodedTarget }) =>
              Option.some(
                ParsedPackageVerifyCommand.cases.NxAffected.make({
                  executable: PackageVerifyExecutable.make(
                    pnpmPrefix !== undefined ? "pnpm" : "nx",
                  ),
                  targetFlag: decodedFlag,
                  target: decodedTarget,
                }),
              ),
            )
            .exhaustive(),
        )
        .exhaustive()
    }
  }
  const pnpmFilterMatch = PNPM_FILTER_VERIFY_COMMAND_RE.exec(command)
  if (pnpmFilterMatch !== null) {
    const [, project, target] = pnpmFilterMatch
    if (project !== undefined && target !== undefined) {
      return match(decodePackageVerifyTarget(target))
        .with({ _tag: "None" }, () => Option.none())
        .with({ _tag: "Some" }, ({ value: decodedTarget }) =>
          Option.some(
            ParsedPackageVerifyCommand.cases.PnpmFilter.make({
              projectName: NxProjectName.make(project),
              target: decodedTarget,
            }),
          ),
        )
        .exhaustive()
    }
  }
  return Option.none()
}

/** Converts a `ParsedPackageVerifyCommand` into exact direct-spawn executable and argv tokens. */
export const toPackageVerifyCommandArgv = (
  parsed: ParsedPackageVerifyCommand,
): PackageVerifyCommandArgv =>
  match(parsed)
    .with({ _tag: "NxRun" }, (c) => ({
      executable: SubprocessCommand.make(c.executable),
      args:
        c.executable === "pnpm"
          ? [
              SubprocessArg.make("nx"),
              SubprocessArg.make("run"),
              SubprocessArg.make(`${c.projectName}:${c.target}`),
            ]
          : [SubprocessArg.make("run"), SubprocessArg.make(`${c.projectName}:${c.target}`)],
    }))
    .with({ _tag: "NxAffected" }, (c) => ({
      executable: SubprocessCommand.make(c.executable),
      args:
        c.executable === "pnpm"
          ? [
              SubprocessArg.make("nx"),
              SubprocessArg.make("affected"),
              SubprocessArg.make(c.targetFlag),
              SubprocessArg.make(c.target),
            ]
          : [
              SubprocessArg.make("affected"),
              SubprocessArg.make(c.targetFlag),
              SubprocessArg.make(c.target),
            ],
    }))
    .with({ _tag: "PnpmFilter" }, (c) => ({
      executable: SubprocessCommand.make("pnpm"),
      args: [
        SubprocessArg.make("--filter"),
        SubprocessArg.make(c.projectName),
        SubprocessArg.make(c.target),
      ],
    }))
    .exhaustive()
