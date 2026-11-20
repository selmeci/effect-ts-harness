import { runCliProgram } from "./cli-runtime.js"
import type { CliEnv } from "./daemon-and-omnigraph.service.js"

export const runHookCliFallback = (argv: ReadonlyArray<string>, extraOptions?: CliEnv): void => {
  runCliProgram(argv, extraOptions)
}
