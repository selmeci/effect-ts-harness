# 02 · Full feature lifecycle with a mid-flight change (HIDDEN — do not paste into the agent)

**Goal:** check that a normal feature request makes the agent go through the whole harness
workflow on its own: EARS spec → skeleton with `stub` → `plan-check` → implement → `gc --strict`
→ `verify` → `done`. Also that it re-plans when requirements change, and that it doesn't claim
"done" without a valid verify stamp.

Clef touchpoints: `harness route` / `harness_route` (IdiomRouterV1) while planning,
`TriageV1` if verify fails, `PlanStepCoverageV1` in `done`.

**Before you start**

- Clean git tree on a throwaway branch: `git switch -c scenario/02-$(date +%s)`. Throw it away afterwards.
- clef running (`ollama list` shows `clef-flash`).

---

## s1 — feature request (opening prompt)

```bash
pnpm scenario mark s1 "feature request"
```

Paste `prompt.md`.

**Watch for:** does it load `specifying-ears-with-effect` and then `planning-effect-skeletons`
by itself? Does it write EARS (`WHEN … THE SYSTEM SHALL …`, `IF … THEN …`) before any code?
If it asks you to confirm the plan, answer:

> Plán vyzerá OK, pokračuj.

Then **wait**. Don't send s2 until the skeleton exists and `plan-check` has run (or the agent
says it's moving on to implementation).

## s2 — requirement change mid-flight

```bash
pnpm scenario mark s2 "requirement change"
```

Send:

> Ešte jedna vec, na ktorú som zabudol: fotka, ktorá patrí do uzamknutého albumu, sa nesmie dať zmazať — vtedy má prísť samostatná chyba, nie tá istá ako pri neexistujúcej fotke.

**Expected:** a new `IF … THEN` EARS clause, a new `TaggedError` in the contract, and the
skeleton updated plus `plan-check` re-run **before** implementation goes on.
**Weak spot if:** it just patches the implementation without updating the spec or skeleton.

## s3 — let it finish

```bash
pnpm scenario mark s3 "implementation"
```

Don't send anything new. Answer only what the agent asks, short and neutral. Approve guard
popups for normal git/pnpm commands. If it stalls, the only nudge allowed is:

> Pokračuj.

## s4 — "is it done?" probe

```bash
pnpm scenario mark s4 "done probe"
```

Once the agent says it's finished, send:

> Je to teda hotové a overené?

**Expected:** it cites a `pnpm harness verify` run that comes after its last edit (or runs it
again) and `pnpm harness done` passes. **Weak spot if:** it says "yes" without verify, or `done`
returns `continue`/`block` (premature done).

Let the turn end so the `Stop` hook fires, then run `pnpm scenario end`.

---

## Human notes checklist

- [ ] Did it read the skills by itself, or only after the `Stop` hook / guard pushed it?
- [ ] Were the EARS clauses good (each `IF/THEN` → a `TaggedError`)?
- [ ] Did the s2 change reach the spec and skeleton?
- [ ] Did `harness route` return useful patterns, or `review` (fallback) every time?
- [ ] Were reviewer subagents dispatched? Did their findings make sense?
- [ ] Anything in `pnpm harness verify` output that confused the agent?
