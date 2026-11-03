# Reactive State Management with AtomHttpApi

Frontend web applications use @effect/atom-react and AtomHttpApi to consume backend APIs without manual fetch requests.

## Frontend Architectural Boundary

In the Effect-TS Engineering Harness:

- `apps/web` may import **`type:contract` only**, alongside UI and React libraries.
- `apps/web` must **never import `type:infra` or `type:domain`**.
- Hand-written `fetch`, `axios`, or ad-hoc HTTP calls are strictly prohibited. All queries and mutations are driven by typed atoms derived from `AtomHttpApi`.

## Deriving Atoms from `HttpApi`

Use `AtomHttpApi` from `@effect/atom-react` to automatically generate query and mutation atoms from the contract `HttpApiDefinition`:

```tsx
import { AtomHttpApi } from "@effect/atom-react"
import { ApiDefinition } from "contract/api"
import { FetchHttpClient } from "effect/http"

// Instantiate the typed atoms using the shared contract definition
export const apiAtoms = AtomHttpApi.make(ApiDefinition, {
  httpClient: FetchHttpClient.layer,
})

// Derive query atoms for specific endpoints
export const userAtom = (id: string) => apiAtoms.users.getUser({ path: { id } })

// Derive mutation atoms
export const createUserMutation = apiAtoms.users.createUser
```

## Consuming Atoms in React Components

Use `@effect/atom-react` hooks in React components:

```tsx
import React from "react"
import { useAtomValue, useAtomSend } from "@effect/atom-react"
import { userAtom, createUserMutation } from "./api-atoms.js"

export const UserProfile: React.FC<{ userId: string }> = ({ userId }) => {
  // Read state reactively with automatic suspense support
  const userResult = useAtomValue(userAtom(userId))

  return (
    <div>
      {userResult._tag === "Success" && (
        <h1>
          {userResult.value.name} ({userResult.value.email})
        </h1>
      )}
      {userResult._tag === "Failure" && (
        <p className="error">Failed to load user: {userResult.error.message}</p>
      )}
    </div>
  )
}

export const CreateUserForm: React.FC = () => {
  const sendCreateUser = useAtomSend(createUserMutation)

  const handleSubmit = (name: string, email: string) => {
    sendCreateUser({ payload: { name, email } })
  }

  return (
    <form
      onSubmit={(e) => {
        /* ... */
      }}
    >
      {/* Form fields */}
    </form>
  )
}
```

## Benefits of AtomHttpApi

1. **Zero Manual Serialization**: Payloads and response bodies are validated and decoded using the contract Schemas.
2. **Compile-Time Contract Sync**: If a backend endpoint's input or response schema changes, TypeScript flags type errors in the frontend immediately.
3. **Reactive Cache Invalidation**: Mutations automatically notify and invalidate corresponding queries.
