import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { runHookEntryFastPath } from "./commands/hook-fastpath-core.js"

const argv = process.argv.slice(2)

if (
  process.argv[1] !== undefined &&
  (fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
    process.argv[1].endsWith("hook-entry.ts"))
) {
  runHookEntryFastPath(argv)
}
