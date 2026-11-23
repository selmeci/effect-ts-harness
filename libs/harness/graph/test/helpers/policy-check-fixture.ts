import type { EffectFnNode } from "../../src/model.js"

export const makeTestFnNode = (partial: {
  readonly spanName: string
  readonly file?: string | undefined
  readonly qualname?: string | undefined
}): EffectFnNode => ({
  _tag: "EffectFn",
  qualname: partial.qualname ?? `test#${partial.spanName}`,
  spanName: partial.spanName,
  file: partial.file ?? "libs/sample/domain/src/index.ts",
  line: 1,
  packageTag: "infra",
  successType: "void",
  isStub: false,
})
