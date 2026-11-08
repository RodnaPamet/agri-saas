# 2026-11-08 — the Art 15 export's column coverage (#2840)

**Commit:** `<pending>` fix(privacy): the DM attachment and link columns reach the Art 15 export

## Design

`exportPersonalData` reads every model with an **explicit `select`**, and an
explicit list is a list that goes stale. P8.6 added eight columns to
`DirectMessage`; the select omitted all eight, so a photo-only message exported
as a row with a null body and nothing else — which reads as an empty message
rather than as a photograph.

Three parts, and the third is the one that stops it recurring:

```
1. the seven metadata columns join the DM select
     attachmentMime/Bytes/Sha256 + linkUrl/Title/Description/FetchedAt
     attachmentKey deliberately NOT exported

2. a notIncluded line naming the omission
     the BYTES are not in the file — owner ruling 2026-11-08

3. tests/guards/export-select-covers-every-column.test.ts
     DMMF columns × every select in the file
     → 176 columns / 19 models: 107 selected, 30 exempt by rule, 39 unreviewed
```

## Files

| file | role |
|---|---|
| `src/app-layer/usecases/personal-data-export.ts` | the seven columns, the `notIncluded` line, and a corrected docblock |
| `tests/guards/export-select-covers-every-column.test.ts` | NEW — the derived per-column check |
| `tests/integration/p8-6-dm-link-cards.test.ts` | the runtime half: what the person actually receives |
| `tests/integration/p5-6a-export.test.ts` | a stale comment corrected |

## Decisions

- **Metadata, not bytes, and the omission is NAMED** (owner ruling
  2026-11-08). The response is one JSON document and `PER_COLLECTION_LIMIT`
  bounds rows rather than megabytes, so bytes would make the export a
  different artefact. `notIncluded` already exists for exactly this kind of
  honest omission — it names farm records, credentials and other people's
  blocks — and Art 15 is a right to know what is held, so a silent omission
  is the worse answer.

- **`attachmentKey` is not exported.** Honest and useless: the egress route
  authorises by participation, so a bare key in a downloadable file resolves
  to nothing for the person holding it, and exporting a locator that grants no
  access only widens where it travels. It sits on the unreviewed baseline so
  the decision is visible rather than implied by its absence.

- **The guard unions EVERY `select`, not the first — and the first draft did
  not.** It reported `PromotionLead.requestMessage` as missing while
  `export-decrypts-promotion-lead.test.ts` was passing, which is how the error
  surfaced. That column is deliberately absent from the privileged read and
  fetched by a SECOND, tenant-bound query (its `v2:` envelope is under a
  per-tenant DEK a tenantless read cannot resolve), then merged into the row.
  **The contradicting passing test is what caught it**, and §0 now pins that
  union with an assertion that fails if somebody simplifies the extraction
  back.

- **`User` is in the population though it is not in the registry.** The
  registry classifies models whose rows belong to a person; the `User` row is
  P5.6b's special case, surviving erasure under Art 17(3)(b). It has no
  registry entry and `exportPersonalData` reads it into the `account` block,
  so a population derived from `EXPORTED_MODELS` alone skips the one model
  every export contains. That was measured, not assumed: without `User`, the
  credential exemption rule (`passwordHash`, `emailHash`, `sessionVersion`)
  matched **nothing**, and §5 — which requires every rule to exempt something
  — said so. A rule matching nothing reads as a reason while being inert.

- **Exemptions are PREDICATES with a reason each, not 30 strings.** The
  reasons are categorical (a person id, a credential, a client replay key,
  row bookkeeping, another party's moderation join), and a per-column list of
  them would be 30 places to forget rather than five. Anything matching no
  rule has to be decided individually.

- **The 39 left over are a BASELINE, not a decision.** Shrink-only, named for
  #2863, and §3 fails when an entry names a column that no longer exists, has
  since been selected, or sits outside the population — because an entry is
  cover, and cover that outlives its subject stays alive for whatever is
  created at the same name next (#1285). Several of the 39 look plainly wrong:
  a seller's own listing exports with no price or quantity, and the person's
  avatar and preferences are absent. Adding ~39 columns to a legal export is
  not a change to make silently on the way past another PR, and some of them
  are ids for entities other people belong to.

- **A source guard and a runtime test, because neither subsumes the other.**
  The guard proves a column reaches a `select` — it would pass on a column
  selected and then dropped before the envelope. The runtime assertion in
  `p8-6-dm-link-cards` reads what the person receives, and covers the merge
  the guard can only approximate; it covers one model, because that is the one
  the fixture seeds.

- **A docblock claim corrected.** `PersonalDataExport.notIncluded` said "the
  strings are resolved from the registry so they cannot drift from what the
  code does". The MODELS are (`EXPORTED_MODELS`); the STRINGS are hand-written
  prose, and nothing derives them — so a category that stops being omitted
  leaves its line behind.
