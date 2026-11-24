import { buildHarnessGraph } from "../../src/graph-engine.js"

export const makeSampleGraph = () =>
  buildHarnessGraph({
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
        qualname: "libs/sample/infra/src/index.ts#PhotoRepo.insert",
        spanName: "PhotoRepo.insert",
        file: "libs/sample/infra/src/index.ts",
        line: 10,
        packageTag: "infra",
        successType: "Photo",
        isStub: false,
      },
    ],
    services: [],
    layers: [],
    errors: [],
    tests: [
      {
        testId: "libs/sample/domain/test/index.test.ts::greets by name",
        testFile: "libs/sample/domain/test/index.test.ts",
        testName: "greets by name",
        lastTreeHash: "abc123",
      },
    ],
    patternDocs: [],
    requiresService: [],
    failsWith: [],
    providesService: [],
    layerRequires: [],
    tracedCalls: [
      {
        callerQualname: "libs/sample/domain/src/index.ts#greet",
        calleeQualname: "libs/sample/infra/src/index.ts#PhotoRepo.insert",
        callCount: 1,
        receiverLayer: "PhotoRepoLive",
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
