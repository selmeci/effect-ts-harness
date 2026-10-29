# EARS Patterns with Effect-TS

EARS (Easy Approach to Requirements Syntax) constrains natural-language requirements to a fixed clause order and a small set of structural keywords. In the Effect-TS Engineering Harness, EARS requirements map directly to Effect v4 architectural building blocks (`Effect<A, E, R>`, pure deciders with `R = never`, tagged errors in `E`, and services/layers in `R`).

---

## 1. The General EARS Template & Effect-TS Channel Mapping

The general EARS sentence structure is:

```
While <precondition>, When <trigger>, the <Effect component/service/decider> shall <observable response>.
```

Both leading clauses are optional. Which clauses are present defines the pattern:

| Part | Description | Effect v4 Channel / Scope |
| --- | --- | --- |
| **Precondition** | A persisting state that must hold (`**While**`) | Pure state decider input (`*.decide` with `R = never`) |
| **Trigger** | A discrete event or invocation (`**When**` or `**If**`) | `Effect.fn` parameter schema or error condition |
| **Named Subject** | The concrete Effect use-case, service, decider, or DO | Specific symbol in `type:domain`, `type:service`, etc. |
| **Response** | Observable return value, typed error, or pure decision | `A` (success), `E` (tagged error), or decider output |

### Pattern Mapping Matrix

| Pattern | Required Bold Keyword | Modal Verb | Effect v4 Building Block | Channel / Location | Required Verification |
| --- | --- | --- | --- | --- | --- |
| **Ubiquitous** | *(none)* | `**shall**` / `**shall not**` | `Schema` brand / refinement / invariant | `type:contract` | `UnitTest` / `AstGate` |
| **Event-driven** | `**When**` | `**shall**` | `Effect.fn` input schema & success outcome | `A` channel (`type:domain`) | `UnitTest` / `TraceTest` |
| **State-driven** | `**While**` | `**shall**` | Pure `*.decide` function (`R = never`) | Domain decider (`type:domain`) | `PropertyTest` (`it.prop`) |
| **Unwanted behaviour** | `**If** … **then**` | `**shall**` / `**shall not**` | `Schema.TaggedError<Self>()("Tag", { ... })` | `E` channel (`type:contract` / `domain`) | `UnitTest` |
| **Optional feature** | `**Where**` | `**shall**` | `Context.Service` + `Layer` / `Config` | `R` channel (`type:service` / `infra`) | `GraphCheck` / `UnitTest` |

### Modal Verb Rule
Always use **`shall`** or **`shall not`**. Never use `should`, `must`, `will`, `can`, or `needs to`.
- `should` signals an optional preference, not an obligation.
- `must` / `will` / `can` introduce colloquial drift and weaken requirement clarity.
- Weak or non-standard modals trigger `weak-modal` in `EarsSpecLint.decide`.

### Allowed Verification Column Values
- **`UnitTest`**: Automated unit test using `@effect/vitest` (`it.effect`).
- **`PropertyTest`**: Property-based test using `@effect/vitest` (`it.effect.prop` or `it.prop` with `effect/Arbitrary`). Required for `While` state deciders.
- **`TraceTest`**: Integration test verifying W3C `traceparent` propagation and span telemetry (`runWithTestTracer`, `checkSpanBudgets`).
- **`AstGate`**: Static analysis verification via `@ast-grep/napi` or `oxlint` syntax rules.
- **`GraphCheck`**: Verification by topological graph policies (`checkEffectGraph`, `unmapped-spec-symbol`).
- **`Inspection`**: Human or schema review (e.g. `openapi:check`, migration review, code inspection).
- **`Analysis`**: Logical or mathematical proof from invariants or third-party contract guarantees.

---

## 2. Slicing & Subject Rules (Enforced by `EarsSpecLint.decide`)

Every requirement table row is verified by deterministic linter rules:

### Named Subject (Never "the system")
Always name the concrete Effect use-case, decider, repository, or Durable Object:
- ✓ `The Sample.uploadPhoto use-case **shall** store the photo and return PhotoMetadata.`
- ✓ `The AlbumQuota.decide decider **shall** return QuotaExceeded.`
- ✓ `The PhotoCounter Durable Object **shall** increment the quota atomically.`
- ✗ `The system shall reject the upload.` $\to$ **Fails `EarsSpecLint.decide` (`generic-subject`)**.

### Split When Two Halves Can Fail Independently (No "and shall")
If one half of a requirement can pass while the other fails, split into two separate requirements with consecutive IDs:
- ✗ `**If** the file exceeds 10MB, **then** the uploadPhoto use-case **shall** reject the upload **and shall** emit a telemetry event.` $\to$ **Fails `EarsSpecLint.decide` (`compound-obligation`)**.
- ✓ **REQ-1.2:** `**If** the file exceeds 10MB, **then** the Sample.uploadPhoto use-case **shall** fail with FileTooLargeError.`
- ✓ **REQ-1.3:** `**If** the file exceeds 10MB, **then** the Sample.uploadPhoto use-case **shall** record a rejected upload metric.`

### Negative Restatements
If the second half merely negates the first without adding a distinct testable obligation, drop the second half:
- ✗ `... **shall** fail with PhotoNotFoundError **and shall not** return a photo.`
- ✓ `... **shall** fail with PhotoNotFoundError.`

### No Status or Evidence Columns
Requirement tables contain exactly 5 columns:
`| ID | Pattern | Requirement | Effect Symbol | Verification |`
- Never include `Status` ("Done", "WIP") or `Evidence` (`test.ts:42`) in requirement tables.
- Status belongs in git branches (`plan/current`, `impl/current`), PR metadata, and `.harness/verify-stamp.json`.
- Evidence belongs in `ExercisesSpan` graph edges and test execution traces.
- Extra columns fail `EarsSpecLint.decide` (`forbidden-column`).

---

## 3. When the Source Does Not Say (The Specificity Test)

Before writing any requirement, point at the exact words in the user's prompt or the existing `HarnessGraph` (`harness_resolve`):

1. **You can point at it:**
   - Write the requirement as `REQ-x.y`.
2. **The source is silent and nobody can start without an answer:**
   - Ask one targeted question during the discovery interview.
   - If work must proceed on other areas, record it under `## Out of scope` with a named owner:
     `* **Soft-delete retention policy.** Purge delay for deleted photos. Decides: Product team.`
3. **The source is silent on a minor detail and a sensible default exists:**
   - Write `REQ-x.y` using the default.
   - **Crucial:** Record the default explicitly under `## Assumptions`:
     `* **REQ-1.2:** Maximum upload size defaults to 10MB; configurable via MaxUploadSizeConfig.`
   - **Rule:** Never smuggle unrequested numbers, field lists, or specific algorithms into `REQ-x.y` without recording them in `## Assumptions`!

---

## 4. Effect-TS Rewrites (Before vs. After)

### Example 1: Generic subject & vague outcome
- ✗ *The system shall validate photo uploads properly.*
- ✓ **REQ-1.1** (Event-driven): `**When** a valid PhotoUpload payload is submitted, the Sample.uploadPhoto use-case **shall** persist the photo record and return PhotoMetadata.`
  - Symbol: `Sample.uploadPhoto` | Verification: `UnitTest`

### Example 2: Missing typed error in E channel & compound obligation
- ✗ *If photo does not exist, then the system shall return 404 and shall not crash.*
- ✓ **REQ-2.1** (Unwanted behaviour): `**If** the requested photoId is not present in PhotoRepo, **then** the Sample.getPhoto use-case **shall** fail with PhotoNotFoundError.`
  - Symbol: `PhotoNotFoundError` | Verification: `UnitTest`

### Example 3: Imperative mutation instead of pure decider
- ✗ *The system must check if album quota is exceeded before adding photo.*
- ✓ **REQ-3.1** (State-driven): `**While** currentCount is greater than or equal to maxAllowed, the AlbumQuota.decide decider **shall** return QuotaExceeded.`
  - Symbol: `AlbumQuota.decide` | Verification: `PropertyTest`

### Example 4: Leaking infrastructure into domain requirement
- ✗ *The service shall use Cloudflare R2 bucket to save image binaries.*
- ✓ **REQ-4.1** (Event-driven): `**When** photo binary data is received, the PhotoStorage service **shall** store the stream and return a StorageKey.`
  - Symbol: `PhotoStorage` | Verification: `UnitTest`

### Example 5: Weak modal and missing configuration scope
- ✗ *The app should support dark theme.*
- ✓ **REQ-5.1** (Optional feature): `**Where** ThemeConfig is set to dark, the SampleTheme provider **shall** apply the dark color palette.`
  - Symbol: `SampleTheme` | Verification: `UnitTest`

---

## 5. Three-Role Self-Review

Before saving the specification to `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md`, review it from three viewpoints:

1. **As the Implementer:**
   - Can you write the `stub<A, E, R>()` skeleton directly from the requirement table?
   - Are the types `A` (happy path), `E` (`TaggedError`), and `R` (`Context.Service` / `Config`) completely unambiguous?
   - Are there hidden decisions that should be moved to `## Assumptions` or `## Out of scope`?

2. **As `@effect-ears-test-reviewer`:**
   - Does every requirement define an observable, testable assertion with binary pass/fail criteria?
   - Does every `While` clause target a pure decider (`*.decide`) tested via `PropertyTest`?
   - Does every `If ... then` clause specify the exact `Schema.TaggedError`?
   - Does every Effect symbol exist or map cleanly to the planned graph?

3. **As the User / Source Author:**
   - Can every requirement be traced back to the user's intent?
   - Has any unprompted specificity been documented in `## Assumptions` instead of being silently invented?
   - Are out-of-scope boundaries clearly declared?
