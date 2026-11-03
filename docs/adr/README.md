# Architecture Decision Records (ADRs)

Tento priečinok a príslušné doménové priečinky obsahujú formálne **Architektonické Rozhodovacie Záznamy (Architecture Decision Records — ADR)** pre repozitár Effect-TS Engineering Harness.

Na rozdiel od bežnej statickej dokumentácie, ktorá rýchlo zastaráva a driftuje od reality, ADR v tomto harnessi predstavujú **živé, strojovo overiteľné zmluvy (machine-verifiable contracts)**, ktoré sú priamo prepojené s grafom kódu (`HarnessGraph`).

---

## 1. Konvencia ko-lokovaného monorepa (Co-Located Monorepo Convention)

Pre udržateľnosť veľkého monorepa uplatňujeme pravidlo ko-lokácie:

1. **Doménovo špecifické ADR:**
   - Ukladajú sa priamo do doménových balíkov: `libs/<scope>/docs/adr/NNNN-<slug>.md` (napr. `libs/harness/docs/adr/`, `libs/sample/docs/adr/`, `libs/es/docs/adr/`).
   - Používajú scoped identifikátor: `id: <scope>:ADR-NNNN` (napr. `harness:ADR-0001`, `sample:ADR-0001`).
2. **Koreňový priečinok `docs/adr/`:**
   - Je vyhradený výhradne pre prierezové, celo-monorepové rozhodnutia (cross-cutting workspace-wide decisions), ktoré sa nedajú priradiť jednému scope.
   - Slúži ako centrálny register a index pre celé monorepo.
3. **Automatické skenovanie v bránach:**
   - Nástroj `harness gc --strict` (`loadGovernanceDocsFromDisk`) automaticky rekurzívne skenuje `libs/*/docs/{adr,specs}`, `apps/*/docs/{adr,specs}` aj koreňové `docs/{adr,specs}`.

---

## 2. Formát ADR (MADR s typovo overiteľným frontmatterom)

Každý záznam využíva štandardizovaný formát MADR (Markdown Architecture Decision Records) obohatený o štruktúrovaný YAML frontmatter a kanonickú anglickú štruktúru 6 sekcií:

```yaml
---
id: <scope>:ADR-NNNN # napr. harness:ADR-0001, sample:ADR-0001 (alebo ADR-NNNN pre globálne)
title: Stručný a výstižný názov architektonického rozhodnutia
status: proposed | accepted | superseded | deprecated
date: YYYY-MM-DD
enforced_by:
  - libs/harness/gates/src/stub.ts
  - tools/oxlint/syntax-bans.js
spans:
  - GraphGc.decide
  - SpanBudget.decide
services:
  - PhotoRepo
  - AlbumCounterClient
errors:
  - PhotoNotFoundError
---
```

### Povinné polia frontmatteru a parser-safety:

- **`id`**: Unikátny identifikátor v tvare `<scope>:ADR-NNNN` pre domény alebo `ADR-NNNN` pre globálne ADR (napr. `harness:ADR-0001`, `sample:ADR-0001`).
- **`title`**: Jednoriadkové zhrnutie prijatého rozhodnutia (krátka menná fráza).
- **`status`**: Životný cyklus rozhodnutia (`proposed`, `accepted`, `superseded`, `deprecated`). Ak je status `superseded`, frontmatter **musí** obsahovať pole `superseded_by: <scope>:ADR-MMMM`.
- **`date`**: Dátum prijatia vo formáte ISO (`YYYY-MM-DD`).
- **`enforced_by`**: Zoznam relatívnych ciest k súborom v repozitári, ktoré rozhodnutie vynucujú (minimálne 1 existujúci súbor).
- **Symboly grafu (`spans`, `services`, `errors`)**: Minimálne jedno z polí `spans`, `services` alebo `errors` musí byť definované a neprázdne, čím sa vytvoria hrany `GovernsSymbol` do `HarnessGraph` a Omnigraphu.
- **Pravidlo parser-safety**: Hodnoty obsahujúce dvojbodku s medzerou (`: `) alebo mriežku (` #`) musia byť obalené v úvodzovkách; oddeľovače frontmatteru musia tvoriť presné riadky `---`.

### 2.1 Kanonická 6-sekčná Štruktúra ADR (Canonical English Template)

Každé ADR musí obsahovať presne 6 hlavných sekcií druhej úrovne (`##`) v tomto nemennom poradí (overované cez `AdrDocLint.decide`):

1. `## Context and Problem Statement` (1–2 odseky popisujúce runtime kontext a čo zlyhá, ak rozhodnutie neurobíme)
2. `## Decision Drivers` (minimálne 2 odrážky `* ...` pomenúvajúce kľúčové obmedzenia)
3. `## Considered Options` (minimálne 2 položky `* **Option N:** ...`)
4. `## Decision Outcome` (otvára sa presnou frázou `**Chosen option:** "<Option Name>"` nasledovanou architektonickými pravidlami)
5. `## Rejected Alternatives` (číslované podsekcie `### N · <Option Name>` so stredovou bodkou `·`, každá otváraná frázou `**Why rejected:** <dôvod>`)
6. `## Consequences and Enforcement` (obsahuje `### Positive Consequences`, `### Negative Consequences and Trade-offs` a tabuľku `### Deterministic Enforcement`)

```markdown
---
id: <scope>:ADR-NNNN
title: Short Noun Phrase Stating the Architectural Decision
status: accepted
date: YYYY-MM-DD
enforced_by:
  - libs/<scope>/infra/src/specific-enforcer.ts
  - tools/oxlint/syntax-bans.js
spans:
  - DomainSymbol.decide
services:
  - SpecificService
errors:
  - SpecificDomainError
---

# <scope>:ADR-NNNN: Short Noun Phrase Stating the Architectural Decision

## Context and Problem Statement

First paragraph describing the runtime environment, business context, and operational forces currently at play. Clearly state the architectural problem and the tension between competing requirements.

Second paragraph explaining what breaks, degrades, or incurs unacceptable risk if this decision is left unresolved or left to individual engineer discretion.

## Decision Drivers

- Non-negotiable driver or constraint 1 (e.g. latency budget, cloud runtime limitation, memory footprint)
- Non-negotiable driver or constraint 2 (e.g. data consistency requirement, transactional boundary, type-safety guarantee)

## Considered Options

- **Option 1:** Short title and description of Option 1
- **Option 2:** Short title and description of Option 2
- **Option 3:** Short title and description of Option 3

## Decision Outcome

**Chosen option:** "Option 1: Short title of Option 1", because detailed justification explaining how it addresses all decision drivers.

### Architectural Rules and Guarantees

1. Binding architectural rule or invariant 1.
2. Binding architectural rule or invariant 2.
3. Boundary rule between layers, services, or storage mechanisms.

## Rejected Alternatives

### 1 · Option 2: Short title of Option 2

**Why rejected:** Concrete failure mode, operational cost, or runtime violation that disqualified this option. Explain why future engineers or agents must not attempt this path.

### 2 · Option 3: Short title of Option 3

**Why rejected:** Concrete failure mode, operational cost, or runtime violation that disqualified this option. Explain why future engineers or agents must not attempt this path.

## Consequences and Enforcement

### Positive Consequences

- Observable architectural or operational benefit 1.
- Observable architectural or operational benefit 2.

### Negative Consequences and Trade-offs

- Accepted cost, complexity, or restriction 1.
- Accepted cost, complexity, or restriction 2.

### Deterministic Enforcement

| Rule                  | Enforced By                      | Gate / Mechanism      | Governed Symbols      |
| --------------------- | -------------------------------- | --------------------- | --------------------- |
| Description of rule 1 | `libs/<scope>/infra/src/file.ts` | `harness gc --strict` | `DomainSymbol.decide` |
| Description of rule 2 | `tools/oxlint/syntax-bans.js`    | AST syntax ban        | `SpecificService`     |
```

---

## 3. Kontrafaktuálne Pravidlo (Counterfactual Rule)

Inšpirované metodikou `ce-compound`, Nygard ADR štandardom a ISO/IEC/IEEE 42010:

> **Zaznamenajte ADR len vtedy, keď rozhodnutie zahŕňa neobvyklé obmedzenia, kompromisy alebo zamietnuté alternatívy, ktoré budúci inžinier alebo agent nemôže odvodiť zo samotného kódu.**

### Kontrafaktuálny test:

Pred zapísaním ADR si položte otázku:

> _"Zopakoval by budúci inžinier alebo autonómny agent rovnakú chybu, zvrátil by tento kompromis, alebo by znovu otvoril túto diskusiu, keby nemal k dispozícii kontext PREČO sme sa takto rozhodli?"_

- **Ak je odpoveď ÁNO (Nové rozhodnutie):** Vytvorte nový záznam v `libs/<scope>/docs/adr/NNNN-<slug>.md` (alebo `docs/adr/` pre celo-workspace rozhodnutia).
- **Ak je odpoveď ÁNO (Vývoj existujúceho):** Aktualizujte existujúci ADR priamo na mieste, alebo ho označte ako `status: superseded` s odkazom `superseded_by: <scope>:ADR-MMMM`.
- **Ak je odpoveď NIE:** Bežné implementačné detaily, štandardné Effect vzory a rutinné refaktoringy patria do `agent-patterns/*.md` alebo priamo do testov, nie do ADR.

---

## 4. Ochrana proti zastarávaniu a deterministické kontroly: `AdrDocLint.decide` a `stale-doc-reference` v `harness gc --strict`

Statická dokumentácia je často nebezpečnejšia než žiadna, pretože vytvára falošný pocit istoty.

V našom harnessi spúšťa príkaz:

```bash
node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts gc --strict
```

čisté rozhodovacie funkcie **`AdrDocLint.decide`** a **`GraphGc.decide`**, ktoré deterministicky garantujú štrukturálnu integritu aj platnosť prepojenia s kódom.

### 4.1 Deterministické Kontroly `AdrDocLint.decide`

Každý ADR dokument je automaticky validovaný čistým deciderom `AdrDocLint.decide` voči 7 kľúčovým invariantom:

| Kontrola lintera                         | Význam a dôvod zlyhania                                                                                                                                                                                                            | Spôsob nápravy                                                                                                            |
| :--------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------ |
| **`adr-frontmatter-invalid`**            | Chýbajúci YAML frontmatter, chýbajúce povinné polia (`id`, `title`, `status`, `date`, `enforced_by`), neplatný status, status `superseded` bez `superseded_by`, alebo absencia symbolov (`spans`, `services`, `errors`).           | Opravte frontmatter, doplňte povinné polia a aspoň jeden zoznam symbolov (`spans`, `services` alebo `errors`).            |
| **`adr-section-structure`**              | Chýbajúca alebo nesprávne zoradená niektorá zo 6 kanonických `##` sekcií (`Context and Problem Statement`, `Decision Drivers`, `Considered Options`, `Decision Outcome`, `Rejected Alternatives`, `Consequences and Enforcement`). | Použite presne 6 kanonických `##` sekcií v predpísanom poradí.                                                            |
| **`adr-missing-drivers-or-options`**     | Sekcia `## Decision Drivers` obsahuje menej ako 2 odrážky `* ...`, alebo `## Considered Options` obsahuje menej ako 2 položky `* **Option N:** ...`.                                                                               | Doplňte aspoň 2 záväzné požiadavky (drivers) a aspoň 2 zvažované možnosti (options).                                      |
| **`adr-missing-chosen-option`**          | Sekcia `## Decision Outcome` nezačína predpísanou frázou `**Chosen option:** "<Option Name>"`.                                                                                                                                     | Otvorte sekciu presnou frázou `**Chosen option:** "<Názov zvolenej možnosti>"`.                                           |
| **`adr-rejected-alternative-structure`** | Sekcia `## Rejected Alternatives` neobsahuje podsekcie vo formáte `### N · <Option Name>` (so stredovou bodkou `·`), alebo podsekcia nezačína vetou `**Why rejected:** <dôvod>`.                                                   | Každú zamietnutú alternatívu naformátujte ako `### N · <Názov>` a otvorte vetou `**Why rejected:** <dôvod zlyhania>`.     |
| **`adr-missing-enforcement-table`**      | Sekcia `## Consequences and Enforcement` neobsahuje podsekcie `### Positive Consequences`, `### Negative Consequences and Trade-offs` alebo tabuľku `### Deterministic Enforcement`.                                               | Doplňte obe podsekcie dôsledkov a 4-stĺpcovú tabuľku `\| Rule \| Enforced By \| Gate / Mechanism \| Governed Symbols \|`. |
| **`adr-unfilled-placeholder`**           | Záznam obsahuje nevyplnené šablónové zástupné symboly (`<...>` alebo `TODO`).                                                                                                                                                      | Nahraďte všetky placeholdery skutočnými technickými špecifikáciami.                                                       |

### 4.2 Validácia Odkazov na Kód: `stale-doc-reference`

Čistá rozhodovacia funkcia `GraphGc.decide` automaticky vykonáva validáciu **`stale-doc-reference`**:

1. Pre každý súbor ADR so statusom `status: accepted` (v `libs/*/docs/adr/*.md`, `apps/*/docs/adr/*.md` aj `docs/adr/*.md`):
   - Overí, že každý súbor deklarovaný v poli **`enforced_by`** fyzicky existuje na disku.
   - Overí, že každý identifikátor v poli **`spans`** existuje ako aktívny `EffectFn` uzol v `HarnessGraph`.
   - Overí, že každý servis v poli **`services`** existuje ako `ServiceTag` v grafe.
   - Overí, že každá chyba v poli **`errors`** existuje ako `TaggedError` v grafe.
2. Ak je súbor zmazaný/premenovaný, alebo ak je span/servis/error v kóde odstránený bez aktualizácie príslušného ADR, `GraphGc.decide` zlyhá s chybou:
   ```json
   {
     "kind": "stale-doc-reference",
     "nodeId": "libs/harness/docs/adr/0001-deterministic-gates-and-plan-as-code.md",
     "message": "Referenced symbol 'OldSpan.decide' in libs/harness/docs/adr/0001-deterministic-gates-and-plan-as-code.md does not exist in workspace HarnessGraph."
   }
   ```
3. Zlyhanie zastaví prechod bránou `harness verify` a zablokuje `harness done`, čím garantuje 100% súlad medzi architektonickou dokumentáciou a skutočným kódom repozitára.

---

## 5. Integrácia do `HarnessGraph` & Omnigraph (MCP dopytovanie)

Každý ADR dokument je počas zostavovania grafu reprezentovaný ako plnohodnotný uzol v `HarnessGraph` a synchronizovaný do lokálneho analytického grafu Omnigraph:

- **Uzol `AdrDoc` (`_tag: "AdrDoc"`):**
  - Obsahuje metadáta: `id` (napr. `sample:ADR-0001`), `title`, `status`, `date`, relatívnu cestu k súboru `path` a zoznam vynucujúcich súborov `enforcedBy`.
- **Hrany `GovernsSymbol`:**
  - Z uzla `AdrDoc` smerujú hrany `GovernsSymbol` priamo na dotknuté uzly kódu:
    - `EffectFn` uzly (deklarované v poli `spans`),
    - `ServiceTag` uzly (deklarované v poli `services`),
    - `TaggedError` uzly (deklarované v poli `errors`).

### MCP dopytovanie pre autonómnych agentov

Autonómni agenti využívajú sadu MCP nástrojov (`apps/harness-mcp`) na obojsmernú navigáciu medzi kódom a architektonickými rozhodnutiami:

1. **Zistenie riadiacich ADR pre funkciu alebo službu (`harness_callers`):**
   Agent pred úpravou existujúcej služby alebo funkcie spustí dopyt na jej volajúcich:

   ```json
   // Nástroj: harness_callers({"qualname": "PhotoRepo"})
   {
     "callers": [
       {
         "qualname": "sample:ADR-0001",
         "nodeTag": "AdrDoc",
         "edgeKind": "GovernsSymbol",
         "file": "libs/sample/docs/adr/0001-cloudflare-d1-do-sqlite-and-traceparent-boundaries.md"
       }
     ]
   }
   ```

   Vďaka hrane `GovernsSymbol` agent okamžite vidí, že manipulácia s `PhotoRepo` podlieha rozhodnutiu `sample:ADR-0001`, a prečíta si zaznamenané architektonické obmedzenia a zamietnuté alternatívy skôr, než navrhne nekompatibilnú zmenu.

2. **Zistenie všetkých symbolov riadených daným ADR (`harness_callees`):**
   Pre zobrazenie všetkých funkcií, služieb a chýb podliehajúcich danému ADR:

   ```json
   // Nástroj: harness_callees({"qualname": "sample:ADR-0001"})
   {
     "callees": [
       { "qualname": "PhotoRepo", "nodeTag": "ServiceTag", "edgeKind": "GovernsSymbol" },
       { "qualname": "AlbumCounterClient", "nodeTag": "ServiceTag", "edgeKind": "GovernsSymbol" }
     ]
   }
   ```

3. **Detail uzla a metadáta ADR (`harness_resolve`):**
   ```json
   // Nástroj: harness_resolve({"qualname": "sample:ADR-0001"})
   ```
   Vráti kompletné metadáta uzla `AdrDoc`, vrátane cesty k súboru, statusu a väzieb na kód.

---

## 6. Register existujúcich ADR

| Identifikátor                                                                                            | Rozsah (Scope) | Názov                                                                                                    | Status     | Dátum      |
| :------------------------------------------------------------------------------------------------------- | :------------- | :------------------------------------------------------------------------------------------------------- | :--------- | :--------- |
| [harness:ADR-0001](../../libs/harness/docs/adr/0001-deterministic-gates-and-plan-as-code.md)             | `harness`      | Deterministic Gates and Compilable Plan-as-Code Skeletons Over Prose Plans                               | `accepted` | 2026-10-25 |
| [sample:ADR-0001](../../libs/sample/docs/adr/0001-cloudflare-d1-do-sqlite-and-traceparent-boundaries.md) | `sample`       | Cloudflare D1 Read Projections, Durable Object Synchronous SQLite State, and W3C Traceparent Propagation | `accepted` | 2026-10-26 |
