# Alchemy Cloud Infrastructure and Bindings

Alchemy v2 declares cloud resources like Workers, R2Buckets, D1Databases, and DurableObjects as Effects inside type:infra and alchemy.run.ts.

## Cloudflare Infrastructure with Alchemy v2

Alchemy v2 (`2.0.0-beta.80`) allows you to define Cloudflare serverless resources and bindings as pure Effect programs:

```ts
import { D1Database, DurableObjectNamespace, R2Bucket, Worker } from "alchemy/cloudflare"
import { Effect } from "effect"

// Declare an R2 storage bucket
export const AssetsBucket = R2Bucket("AssetsBucket", {
  name: "app-assets-production",
})

// Declare a D1 relational database
export const MainDatabase = D1Database("MainDatabase", {
  name: "app-d1-production",
})

// Declare a Durable Object namespace for stateful entities
export const SessionDO = DurableObjectNamespace("SessionDO", {
  className: "SessionDurableObject",
})

// Declare a Cloudflare Worker binding to the resources
export const ApiWorker = Worker("ApiWorker", {
  entrypoint: "./src/worker.ts",
  bindings: {
    ASSETS: AssetsBucket,
    DB: MainDatabase,
    SESSIONS: SessionDO,
  },
})
```

## Bindings and Type-Safe Capabilities

Bindings connect cloud infrastructure to execution contexts. When a Worker binds an `R2Bucket` or `D1Database`, Alchemy generates the IAM permissions, worker environment variables, and typed client SDKs automatically.

## Emulated Testing with `Test.make`

Alchemy provides `Test.make` to run stacks against local emulated environments or in-memory mocks without deploying to Cloudflare:

```ts
import { Test } from "alchemy/Test"
import { Effect } from "effect"
import { MainDatabase } from "infra/alchemy-stack"

export const testStack = Effect.gen(function* () {
  const runner = yield* Test.make
  // Interacting with the emulated database
  yield* runner.apply(MainDatabase)
})
```

## Architectural Boundaries & Guard Rules

According to `AGENTS.md` and repo policy:

1. **`type:infra` Boundary Only**:
   - Resources (`R2Bucket`, `D1Database`, `DurableObjectNamespace`) and bindings may only be imported or instantiated within `type:infra` libraries and the root application's `alchemy.run.ts`.
   - **`type:domain` and `type:contract` libraries must NEVER import or declare cloud resources.**

2. **No Unattended Deploys**:
   - Never execute `alchemy deploy` or `alchemy destroy` autonomously.
   - Deploys and destructions must always be human-confirmed, one at a time.

3. **Credential Storage**:
   - Cloudflare credentials live in Alchemy profiles: `~/.alchemy/profiles.json`.
   - Never export `CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_API_TOKEN` to shell environments, and never place them in `.env`.
