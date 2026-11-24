import type { Option } from "effect"
import { match } from "ts-pattern"

const appendScalarFlag = <A extends string | number>(
  out: Array<string>,
  flagName: string,
  opt: Option.Option<A>,
): void => {
  match(opt)
    .with({ _tag: "Some" }, ({ value }) => {
      out.push(`--${flagName}=${value}`)
    })
    .with({ _tag: "None" }, () => {})
    .exhaustive()
}

/** Appends `--<flagName>=<value>` to `out` when an optional string flag is `Some`. */
export const appendStringFlag = (
  out: Array<string>,
  flagName: string,
  opt: Option.Option<string>,
): void => {
  appendScalarFlag(out, flagName, opt)
}

/** Appends `--<flagName>=<value>` to `out` when an optional numeric flag is `Some`. */
export const appendNumberFlag = (
  out: Array<string>,
  flagName: string,
  opt: Option.Option<number>,
): void => {
  appendScalarFlag(out, flagName, opt)
}

/** Appends `--<flagName>` to `out` when a boolean flag is enabled. */
export const appendBoolFlag = (out: Array<string>, flagName: string, enabled: boolean): void => {
  if (enabled) {
    out.push(`--${flagName}`)
  }
}
