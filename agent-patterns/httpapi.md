# Schema-First HttpApi and OpenAPI Export

Public HTTP APIs are defined with HttpApi, HttpApiGroup, and HttpApiEndpoint in effect/http-api, exporting OpenAPI specs verified with oasdiff.

## Defining Schema-First APIs

Effect's `HttpApi` provides end-to-end type safety, automatic request/response decoding, tagged error mapping, and OpenAPI specification derivation from a single definition:

```ts
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { User, UserInput, UserNotFoundError } from "contract/users"

// Define a group of related endpoints
export class UsersGroup extends HttpApiGroup.make("users")
  .add(
    HttpApiEndpoint.get("getUser", "/users/:id")
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(User)
      .addError(UserNotFoundError),
  )
  .add(HttpApiEndpoint.post("createUser", "/users").setPayload(UserInput).addSuccess(User)) {}

// Compose groups into an API contract
export class ApiDefinition extends HttpApi.make("AppApi").add(UsersGroup) {}
```

## Implementing Handlers with `HttpApiBuilder`

Implement the endpoints in `type:infra` using `HttpApiBuilder`:

```ts
import { HttpApiBuilder } from "effect/http-api"
import { Effect, Layer } from "effect"
import { ApiDefinition } from "contract/api"
import { UserService } from "service/user"

export const UsersGroupLive = HttpApiBuilder.group(ApiDefinition, "users", (handlers) =>
  handlers
    .handle("getUser", ({ path }) =>
      Effect.gen(function* () {
        const users = yield* UserService
        return yield* users.getById(path.id)
      }),
    )
    .handle("createUser", ({ payload }) =>
      Effect.gen(function* () {
        const users = yield* UserService
        return yield* users.create(payload)
      }),
    ),
)

export const ApiLive = HttpApiBuilder.api(ApiDefinition).pipe(Layer.provide(UsersGroupLive))
```

## OpenAPI Export & Breaking Change Gates

The harness exports the OpenAPI specification directly from `ApiDefinition` to `openapi.json`:

```bash
pnpm nx run @sample/contract:openapi
```

In CI, the contract gate runs `oasdiff breaking` against `main`:

```bash
oasdiff breaking ./openapi.json main:openapi.json
```

Any breaking changes (such as removing a field, changing a type, or adding an unhandled error code) will fail the CI gate immediately.
