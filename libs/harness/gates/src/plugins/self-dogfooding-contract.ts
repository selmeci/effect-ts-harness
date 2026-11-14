import { Schema } from "effect"
import {
  AstSourceContent,
  AstSourceFilePath,
  MaxPluginFileLines,
} from "@harness/contract"

export const SelfDogfoodingFileInput = Schema.Struct({
  filePath: AstSourceFilePath,
  content: AstSourceContent,
  isModularPluginFile: Schema.optional(Schema.Boolean),
})
export type SelfDogfoodingFileInput = typeof SelfDogfoodingFileInput.Type

export const SelfDogfoodingInput = Schema.Struct({
  files: Schema.Array(SelfDogfoodingFileInput),
  maxPluginFileLines: Schema.optional(MaxPluginFileLines),
  failOnViolation: Schema.optional(Schema.Boolean),
})
export type SelfDogfoodingInput = typeof SelfDogfoodingInput.Type
