# EARS Feature Specifications & Verified Plan Graphs

Tento priečinok a príslušné doménové priečinky uchovávajú **Špecifikácie požiadaviek EARS (Easy Approach to Requirements Syntax)** a **Záznamy overených topologických grafov plánov (Verified Plan Graph Records)** pre jednotlivé funkcie, míľniky a doménové zmeny v repozitári.

Každá špecifikácia v `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` (alebo v koreňovom `docs/specs/` pre prierezové zmeny) slúži ako **trvalá zmluva o správaní (behavioral contract)**, ktorá prežije zhustenie kontextu agenta (`/compact`) a je automaticky overovaná nástrojom `harness gc --strict` a recenzentom `@effect-ears-test-reviewer`.

---

## 1. Konvencia ko-lokovaného monorepa (Co-Located Monorepo Convention)

Pre udržateľnosť a modularitu monorepa uplatňujeme pravidlo ko-lokácie špecifikácií:

1. **Doménovo špecifické EARS špecifikácie:**
   - Ukladajú sa priamo do priečinka príslušnej domény: `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` (napr. `libs/sample/docs/specs/`, `libs/es/docs/specs/`).
   - Používajú scoped identifikátor: `id: <scope>:SPEC-NNNN` (napr. `sample:SPEC-0001`).
2. **Koreňový priečinok `docs/specs/`:**
   - Je vyhradený výhradne pre prierezové, celo-monorepové špecifikácie, ktoré zasahujú viacero domén súčasne.
   - Slúži ako centrálny register a index pre celé monorepo.
3. **Automatické skenovanie v bránach:**
   - Nástroj `harness gc --strict` (`loadGovernanceDocsFromDisk`) automaticky rekurzívne skenuje `libs/*/docs/{adr,specs}`, `apps/*/docs/{adr,specs}` aj koreňové `docs/{adr,specs}`.

---

## 2. Štruktúra a Formát Špecifikácie

Každý súbor špecifikácie obsahuje strojovo čitateľný frontmatter a štandardizovanú kostru:

```yaml
---
id: <scope>:SPEC-NNNN # napr. sample:SPEC-0001 (alebo SPEC-NNNN pre globálne)
title: Názov funkcie alebo doménového modulu
status: proposed | accepted | superseded | deprecated
date: YYYY-MM-DD
enforced_by:
  - libs/sample/contract/src/index.ts
  - libs/sample/service/src/index.ts
  - libs/sample/domain/src/index.ts
  - libs/sample/infra/src/index.ts
spans:
  - Domain.useCase
  - Domain.decide
services:
  - MyService
errors:
  - MyCustomError
---
```

### 2.1 Kanonická Kostra Špecifikácie

Každá EARS špecifikácia v `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` musí striktne dodržiavať nasledujúcu kanonickú štruktúru:

```markdown
## Context

Dva odseky opisujúce súčasný stav, dôvod požiadavky a existujúci kontext grafu:

- **Reused Contracts / Errors:** `<symboly z type:contract>`
- **Reused Services:** `<Context.Service tagy z type:service>`
- **New Capabilities Needed:** `<nové schémy, chyby alebo servisné metódy>`

## Goal

Jeden odsek definujúci, čo bude pravdivé o samotnom produkte po dokončení — nikdy nepopisuje dokument.

## How to read the requirements

Požiadavky dodržiavajú syntax EARS. Každá požiadavka je jedna veta s tučnými kľúčovými slovami (`When`, `While`, `If ... then`, `Where`) a modálnym slovesom `shall` alebo `shall not`.

## Requirements

### 1 · <Názov oblasti>

**Source (<pôvod>):** <prečo na tom záleží>.

| ID      | Pattern            | Requirement                                                                                                                             | Effect Symbol      | Verification |
| ------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------ |
| REQ-1.1 | Event-driven       | **When** a valid PhotoUpload payload is submitted, the Sample.uploadPhoto use-case **shall** store the photo and return PhotoMetadata.  | Sample.uploadPhoto | UnitTest     |
| REQ-1.2 | State-driven       | **While** currentCount is greater than or equal to maxAllowed, the AlbumQuota.decide decider **shall** return QuotaExceeded.            | AlbumQuota.decide  | PropertyTest |
| REQ-1.3 | Unwanted behaviour | **If** the requested photoId is not present in PhotoRepo, **then** the Sample.getPhoto use-case **shall** fail with PhotoNotFoundError. | PhotoNotFoundError | UnitTest     |

## Assumptions

- **REQ-1.1:** Predvolená maximálna veľkosť uploadu je 10MB; konfigurovateľná cez MaxUploadSizeConfig.

## Out of scope

- **Soft-delete retention policy.** Lehota premazania vymazaných fotografií. Rozhoduje: Produktový tím.

## Known residual risks

- Súbežné nahrávanie fotiek do rovnakého albumu sa spolieha na atomické transakcie Durable Object; vysoká súbežnosť na jeden album môže tvoriť rad v schránke DO aktéra.

## Acceptance criteria

- Všetky riadky požiadaviek prešli deklarovanou metódou verifikácie (`UnitTest`, `PropertyTest`, `TraceTest`).
- Aktualizované dotknuté balíky Nx: `type:contract` -> `type:service` -> `type:domain` -> `type:infra` -> `scope:web`.
- Frontmatter aktualizovaný na `status: accepted` po implementácii a overený cez `harness gc --strict`.
```

### 2.2 Deterministické Kontroly `EarsSpecLint.decide`

Kvalita a formát špecifikácií nie sú ponechané na voľnú interpretáciu LLM, ale sú deterministicky validované čistým deciderom `EarsSpecLint.decide` v rámci `harness gc --strict`. Linter kontroluje 8 kľúčových invariantov:

| Kontrola lintera               | Význam a dôvod zlyhania                                                                                                                                  | Spôsob nápravy                                                                                                                                                         |
| :----------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`no-requirements-table`**    | Sekcia oblasti požiadaviek (`### <N> · <Area>`) neobsahuje 5-stĺpcovú Markdown tabuľku.                                                                  | Pridajte kanonickú tabuľku `\| ID \| Pattern \| Requirement \| Effect Symbol \| Verification \|`.                                                                      |
| **`id-format`**                | Identifikátor požiadavky nezodpovedá formátu `REQ-<oblasť>.<index>` (napr. `REQ-1.1`).                                                                   | Použite presný formát `REQ-X.Y` zhodný s číslom oblasti.                                                                                                               |
| **`numbering-gap`**            | V číslovaní požiadaviek v rámci oblasti existuje medzera (napr. po `REQ-1.1` nasleduje `REQ-1.3`).                                                       | Použite striktne po sebe idúce číslovanie bez vynechaných čísel.                                                                                                       |
| **`generic-subject`**          | Veta používa generický subjekt (`the system`, `the application`, `the service`).                                                                         | Pomenujte konkrétny Effect use-case, decider, službu alebo Durable Object (`The Sample.uploadPhoto use-case`, `The AlbumQuota.decide decider`).                        |
| **`compound-obligation`**      | Veta spája dve nezávislé povinnosti pomocou spojky `and shall`.                                                                                          | Rozdeľte vetu na dve samostatné požiadavky (`REQ-1.2` a `REQ-1.3`). Ak ide len o negatívne preformulovanie (`and shall not return a photo`), druhú polovicu vypustite. |
| **`pattern-keyword-mismatch`** | Chýba povinné tučné kľúčové slovo pre deklarovaný vzor (`**When**`, `**While**`, `**If** … **then**`, `**Where**`), alebo ubiquitous obsahuje podmienku. | Použite presné tučné kľúčové slovo zodpovedajúce vzoru v stĺpci `Pattern`.                                                                                             |
| **`weak-modal`**               | Veta používa slabé alebo neštandardné modálne sloveso (`should`, `must`, `will`, `can`, `needs to`).                                                     | Použite striktne `**shall**` alebo `**shall not**`.                                                                                                                    |
| **`forbidden-column`**         | Tabuľka obsahuje stĺpce stavu alebo dôkazov (`Status`, `Evidence`, `Test file`).                                                                         | Odstráňte zakázané stĺpce. Stav patrí do git vetiev a `.harness/verify-stamp.json`, dôkazy do hrán grafu `ExercisesSpan`.                                              |

---

## 3. Životný cyklus špecifikácie (3 fázy governance)

Špecifikácia prechádza tromi fázami životného cyklu zladenými so 6-krokovým procesom harnessu:

### Fáza 1: Vytvorenie návrhu (`specifying-ears-with-effect`)

1. Agent preskúma existujúci kód pomocou MCP nástrojov (`harness_resolve`, `harness_callers`).
2. Sformuluje kanonický EARS kontrakt:
   - **Context & Goal:** Reused Contracts/Errors, Reused Services, New Capabilities, produktový cieľ.
   - **EARS Requirements:** 5-stĺpcové tabuľky pod oblasťami `### <N> · <Area>` s pomenovanými Effect subjektmi a metódami verifikácie.
   - **Assumptions, Out of scope, Risks & Acceptance criteria:** Dôsledné oddelenie potvrdených faktov od predvolených predpokladov a otvorených rozhodnutí.
3. Po potvrdení používateľom agent zapíše súbor do `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` (alebo `docs/specs/` pri cross-cutting zmenách) so statusom `status: proposed` a overí ho cez `harness gc --strict` (`EarsSpecLint.decide`). Tým je zaručené, že znenie požiadaviek sa nestratí pri zmenšení okna kontextu (`/compact`).

### Fáza 2: Plán a overenie grafu (`planning-effect-skeletons`)

1. Agent vytvorí kompilovateľný skeleton pomocou `stub<A, E, R>(...args)` v príslušných balíkoch.
2. Spustí bránu `node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts plan-check`.
3. Po úspešnom výstupe (`exit 0`) agent aktualizuje súbor špecifikácie:
   - Pripojí vytlačený **Mermaid Topology Graph** zobrazujúci presné väzby medzi funkciami, službami a chybami.
   - Pripojí kontrolný zoznam **Pre-Implementation Adversarial Plan Lens** (overenie idempotencie, kompenzácií a čistoty deciderov).
   - Ak bolo prijaté neobvyklé architektonické rozhodnutie so zamietnutými alternatívami, zapíše zodpovedajúce ADR do `libs/<scope>/docs/adr/NNNN-<slug>.md` (alebo `docs/adr/`).

### Fáza 3: Implementácia a verifikácia (`executing-effect-stubs`)

1. Subagenty nahradia stubs reálnou Effect implementáciou a `@effect/vitest` testami.
2. Pred verifikáciou agent nastaví `status: accepted` v hlavičke špecifikácie.
3. Spustia sa validačné mechanizmy:
   - **`@effect-ears-test-reviewer`:** Skontroluje špecifikáciu `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` a overí, že každá EARS klauzula (`WHEN`, `IF/THEN`, `WHILE`) má citlivé testovacie tvrdenie v testoch.
   - **`harness gc --strict` (`stale-doc-reference` a `EarsSpecLint.decide`):** Overí integritu špecifikácií cez `EarsSpecLint.decide` a potvrdí, že všetky súbory v `enforced_by` a symboly v `spans`/`services`/`errors` existujú v grafe `HarnessGraph`.
   - **`harness verify` & `harness done`:** Finálne deterministické zapečatenie úlohy.

---

## 4. Integrácia do `HarnessGraph` & Omnigraph (MCP dopytovanie)

Každá EARS špecifikácia je extrahovaná do `HarnessGraph` a lokálneho analytického grafu Omnigraph ako uzol typu **`EarsSpec` (`_tag: "EarsSpec"`)**:

- **Uzol `EarsSpec`:**
  - Obsahuje metadáta: `id` (napr. `sample:SPEC-0001`), `title`, `status`, `date`, relatívnu cestu k súboru `path` a zoznam súborov `enforcedBy`.
- **Hrany `SpecifiesSymbol`:**
  - Z uzla `EarsSpec` smerujú hrany `SpecifiesSymbol` priamo na dotknuté uzly kódu:
    - `EffectFn` uzly (deklarované v poli `spans`),
    - `ServiceTag` uzly (deklarované v poli `services`),
    - `TaggedError` uzly (deklarované v poli `errors`).
- **Priebežná existencia naprieč vetvami Omnigraphu:**
  - Tieto uzly a hrany existujú v lokálnom grafe naprieč vetvami `plan/current`, `impl/current` aj hlavnou vetvou `main`.

### MCP dopytovanie pre autonómnych agentov

Autonómni agenti využívajú MCP nástroje (`apps/harness-mcp`) na navigáciu medzi požiadavkami a symbolmi kódu:

- **`harness_callers("<ServiceOrFn>")`:** Vráti všetky špecifikácie, ktoré daný symbol definujú (`nodeTag: "EarsSpec"`, `edgeKind: "SpecifiesSymbol"`).
- **`harness_callees("<scope>:SPEC-NNNN")`:** Vráti všetky funkcie, služby a chyby vymedzené danou špecifikáciou.
- **`harness_resolve("<scope>:SPEC-NNNN")`:** Vráti podrobné metadáta a umiestnenie špecifikácie na disku.

---

## 5. Dvojstupňové Deterministické Brány: Spec $\rightarrow$ Plan a Plan $\rightarrow$ Impl

Architektúra prepája špecifikácie s kódom pomocou dvoch deterministických kontrol:

### 1. Spec $\rightarrow$ Plan Brána (`unmapped-spec-symbol` v `harness plan-check`)

Aj keď má špecifikácia stav **`status: proposed`**, nástroj `harness plan-check` (`checkEffectGraph`) striktne overuje súlad medzi EARS kontraktom a navrhnutým skeletonom:

- Každý `span`, `service` a `error` deklarovaný v YAML frontmatteri špecifikácie **musí existovať** ako uzol v grafe skeletonu (`stub<A, E, R>()`).
- Ak agent v špecifikácii navrhne požiadavku vyžadujúcu span `Sample.deletePhoto` alebo službu `PhotoRepo`, no v TypeScript skeletone ju vynechá alebo premenuje, `plan-check` zlyhá s chybou `unmapped-spec-symbol`.
- **Výsledok:** Ani jedna požiadavka z EARS kontraktu nemôže vypadnúť medzi fázou špecifikácie požiadaviek a fázou plánovania.

### 2. Plan $\rightarrow$ Impl Brána (`diffHarnessGraphs` v `harness done` + `stale-doc-reference` v `harness gc --strict`)

Prechod z overeného plánu do hotovej implementácie je zapečatený dvoma mechanizmami:

- **`stale-doc-reference` v `harness gc --strict`:** Po nastavení `status: accepted` overí, že všetky súbory v `enforced_by` fyzicky existujú a všetky symboly v `spans`, `services` a `errors` majú aktívne náprotivky v `HarnessGraph`.
- **`diffHarnessGraphs` v `harness done`:** Porovná topologický graf plánu (`plan/current`) s grafom hotovej implementácie (`impl/current`). Implementácia nesmie vynechať žiadnu z naplánovaných funkcií, služieb či chybových vetiev.

---

## 6. Register existujúcich špecifikácií

| Identifikátor                                                                                                 | Rozsah (Scope) | Názov                                                        | Status     | Dátum      |
| :------------------------------------------------------------------------------------------------------------ | :------------- | :----------------------------------------------------------- | :--------- | :--------- |
| [sample:SPEC-0001](../../libs/sample/docs/specs/2026-10-25-sample-photo-gallery.md)                           | `sample`       | Sample Photo Gallery and Durable Object Album Quota Counter                                  | `accepted` | 2026-10-25 |
| [harness:SPEC-0007](../../libs/harness/docs/specs/2026-11-06-polymorphic-hypergraph-and-datalog-inference.md) | `harness`      | Polymorphic Hypergraph & Stratified Datalog Inference Engine                                 | `proposed` | 2026-11-06 |
| [harness:SPEC-0011](../../libs/harness/docs/specs/2026-11-12-self-dogfooding-and-capability-plugin-harness.md) | `harness`      | Self-Dogfooding Audit Enforcement & Effect-TS v4 Modular Capability Plugin Harness           | `accepted` | 2026-11-12 |
