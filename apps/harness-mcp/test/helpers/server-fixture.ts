import { buildHarnessGraph } from "@harness/graph"

export const sampleMcpGraph = buildHarnessGraph({
  fns: [
    {
      qualname: "libs/sample/domain/src/index.ts#greet",
      spanName: "Sample.greet",
      file: "libs/sample/domain/src/index.ts",
      line: 4,
      packageTag: "domain",
      successType: "string",
      isStub: false,
    },
    {
      qualname: "libs/sample/service/src/index.ts#callGreet",
      spanName: "Sample.callGreet",
      file: "libs/sample/service/src/index.ts",
      line: 10,
      packageTag: "service",
      successType: "string",
      isStub: false,
    },
  ],
  services: [
    {
      tagId: "libs/sample/service/src/index.ts#Greeter",
      name: "Greeter",
      file: "libs/sample/service/src/index.ts",
      packageTag: "service",
    },
  ],
  layers: [],
  errors: [],
  tests: [
    {
      testId: "libs/sample/domain/test/index.test.ts::greets by name",
      testFile: "libs/sample/domain/test/index.test.ts",
      testName: "greets by name",
      lastTreeHash: "hash1",
    },
  ],
  patternDocs: [],
  requiresService: [
    {
      callerQualname: "libs/sample/service/src/index.ts#callGreet",
      tagId: "libs/sample/service/src/index.ts#Greeter",
    },
  ],
  failsWith: [],
  providesService: [],
  layerRequires: [],
  tracedCalls: [
    {
      callerQualname: "libs/sample/service/src/index.ts#callGreet",
      calleeQualname: "libs/sample/domain/src/index.ts#greet",
      callCount: 2,
      receiverLayer: null,
    },
  ],
  exercisesSpans: [
    {
      testId: "libs/sample/domain/test/index.test.ts::greets by name",
      calleeQualname: "libs/sample/domain/src/index.ts#greet",
      callCount: 1,
      receiverLayer: null,
    },
  ],
})
