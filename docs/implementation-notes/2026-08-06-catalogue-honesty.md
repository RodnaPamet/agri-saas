# 2026-08-06 — Saying what the catalogue is, and who it is for

**Commit:** `feat(schemes): disclose demo catalogues, serve the Bulgarian market, version standards`

Seven items. The through-line: the catalogue was honest in its own source files
and silent everywhere a user could look.

## Design

### The disclaimer that reached nobody

The shipped catalogues are 3–8% stubs. GlobalG.A.P. carries 7 control points
against ~200+; EU Organic 5 against a 61-article regulation. **The YAMLs say so
plainly** in their header comments, and a header comment reaches no user.
`SchemesClient` fetched `description` and never rendered it, so the only
in-product signal was a parenthetical in the name.

A farmer who maps their practices to 7 control points and sees "GlobalG.A.P."
will believe they are covered. That is the failure this fixes.

The fix is to make the disclaimer **data**: `Framework.isDemo` +
`coverageNote`, declared in each YAML, badged on the list, and rendered as a
prominent notice on the detail page — the surface where someone decides to
adopt a standard, which is the moment they most need to know these are seven
illustrative control points.

The license-hygiene test moved with it. It matched
`/illustrative|concept|paraphrased/` against the description — English-only,
and silently un-assertable for a Bulgarian catalogue. It now asserts the
structured flag (language-independent, and the thing users actually see) plus a
bilingual prose check.

### A catalogue for a market the product does not serve

The four shipped schemes were GlobalG.A.P., EU Organic, and **two UK-only
standards**: Red Tractor requires UK production, LEAF Marque is UK. A Bulgarian
producer cannot be certified against either.

Meanwhile the product already implements the regime a Bulgarian farm actually
faces every season — the **ДНЕВНИК за проведените растителнозащитни
мероприятия** (`/locations/:id/farm-record`), the БАБХ identity block, the
season diary — and none of it connected to `/schemes`.

The UK catalogues are removed. `bg-babh-plant-protection.yaml` replaces them:
six record-keeping obligations a Bulgarian holding is inspected against, in
Bulgarian, wired into `AUTO_EVIDENCE_RULES` so a spray record already being
kept in this product satisfies the ДНЕВНИК and pre-harvest-interval control
points through the same path GlobalG.A.P. and EU Organic use.

Scope stated in the file itself: it is the record-keeping subset the product
can genuinely evidence, referencing public EU law (1107/2009, 2009/128/EC,
2017/625) as applied through the Закон за защита на растенията. Referencing
public law is fine; claiming to *be* the regulation is not — hence `isDemo`.

### A standard that could not be revised

`Framework.key` carried `@unique` **and** `@@unique([key, version])`. The
single-column one wins, so two versions of a standard could never coexist — and
bumping `version:` in a YAML hard-failed the importer: `catalog-applier` upserts
on `key_version`, misses, tries to CREATE, and violates the key-only unique with
P2002. Standards revise annually. A product that cannot ingest a revision has a
catalogue that freezes on the day it ships.

Dropping the single-column unique is what TypeScript then made visible: six
`findUnique({ where: { key } })` call sites stopped compiling, because `key`
is no longer a unique field. Each became `findFirst` ordered by version
descending — "a caller that names no version means the current one".

`version` is also now written on **update**, not just create; it was
create-only, so a revision left the row's version stale even where the upsert
could reach it.

### Provenance that was never written

`contentHash` and `sourceUrn` have existed on the model since it was created
and **nothing ever set them** — zero provenance on a document a certifier is
handed. `contentHashOf` fingerprints the framework identity plus every
requirement's code, title and ordering, deliberately *not* the raw file:
reformatting a YAML should not look like a revision, while retitling a control
point should.

### Two of four catalogues were loaded by nothing

`seed-demo.ts` hardcoded two filenames, and `schemes:import` is a manual CLI
absent from `db:seed`, CI and `deploy/`. So a catalogue could be added to the
repo and simply never exist in any database — **a fresh production DB has an
empty `/schemes`**. The seeder now reads the directory; adding a YAML is the
whole change.

The catalogue test had the same hardcoding, and its coverage was one-directional:
it checked rule → catalogue (do the codes a rule names exist) and never
catalogue → rule. Two shipped catalogues advertised "auto-evidence from farm
records" in their own descriptions while no rule ever fired for them, carrying
perfectly good pre-harvest-interval and application-record control points that
nothing satisfied. The reverse assertion is added.

### A CSV that executes when the certifier opens it

`escapeCSV` quoted correctly and guarded nothing. **Quoting is about parsing;
formula injection is about evaluation.** `"=cmd|'/c calc'!A1"` is perfectly
valid CSV — the quoting is right — and Excel still runs it.

It matters on these exports specifically because they are the
hand-this-to-your-certifier path: control names and applicability
justifications are tenant-authored free text, and the file's whole purpose is
to be opened in a spreadsheet by someone outside the farm who has no reason to
distrust a document their client sent them.

Leading `=`, `+`, `-`, `@`, tab and CR are now prefixed with an apostrophe.
Only *leading* — guarding mid-string would corrupt ordinary values like
`pH 6.5-7.0`. `coverage.ts` had two hand-rolled
`"${c.replace(/"/g,'""')}"` joins that reimplemented half the escaper; they
route through it now, because a fix to one copy was never going to reach the
other.

`soa.ts`'s evidence count filtered `deletedAt` only, so archived and unreviewed
rows inflated a number that appears in the Statement of Applicability — the
same overstatement the readiness score used to make, in the document an auditor
reads.

### Cleanup

- **`install.ts`'s dead `computeCoverage`** — a ~140-line duplicate of the real
  one, with its own `: any` casts. Nothing imported it, and being a copy meant
  every correction to the real one (the APPROVED filter, the deleted/archived
  filter, per-requirement satisfaction, the readiness ratio) silently did not
  apply. A dead duplicate of a function that keeps being corrected is a trap
  for whoever greps the name and finds this copy first.
- **The dashboard's unrendered certification query** — `listSchemes` plus a full
  `generateReadinessReport` on every load, for a field `AgDashboardStrip` never
  displayed. It also picked the "top" scheme *alphabetically*, the same
  wrong-scheme selection the certifier pack had.
- **`NewSchemeModal`'s fixed `grid-cols-12`** — never collapsed, so three
  inputs shared a phone's width. Now stacks below `sm`.
- **`MODULE_DESCRIPTIONS`** — all eleven strings were English-only in a lib
  module, so a Bulgarian operator read English regardless of locale. Moved to
  next-intl. The CERTIFICATION line also described the machinery ("Audit
  frameworks, controls, evidence, and policies") rather than the point;
  it now says what a farmer is buying.

### Selection was eating the first click

Adding rendered coverage — there was **none** on this surface, which is why the
dead-end list shipped — turned up something a static read would not: `DataTable`
defaults `selectionEnabled` to true, and with selection on the row's *single*
click toggles selection while the row action moves to double-click. The schemes
list has no batch actions, so selection cost a click and gave nothing back,
under a row rendering `cursor-pointer`. `EntityListPage` now forwards
`selectionEnabled` (the precedent is `EvidenceSubTable`, which sets it false and
calls it load-bearing) and the schemes list turns it off.

## Files

| File | Role |
|---|---|
| `prisma/schema/compliance.prisma` + migration | `isDemo`, `coverageNote`; single-column unique on `key` dropped |
| `prisma/catalog-loader.ts` / `catalog-applier.ts` | demo + provenance fields; `version` written on update; `contentHashOf` |
| `prisma/catalogs/bg-babh-plant-protection.yaml` | **new** — the Bulgarian regime |
| `prisma/catalogs/{red-tractor,leaf-marque}-demo.yaml` | **removed** — UK-only |
| `src/app-layer/usecases/auto-evidence.ts` | ДНЕВНИК control points wired |
| `scripts/seed-demo.ts` | reads the catalogue directory |
| `src/lib/reports/soa-csv.ts` | formula guard |
| `src/app-layer/usecases/framework/coverage.ts` | CSV joins routed through the shared escaper |
| `src/app-layer/usecases/soa.ts` | evidence count filtered |
| `src/app-layer/usecases/framework/install.ts` | dead duplicate removed |
| `src/app-layer/usecases/ag-dashboard.ts` | unrendered certification query removed |
| `src/lib/modules.ts` + settings page | descriptions into next-intl |
| `src/components/layout/EntityListPage.tsx` | forwards `selectionEnabled` |

## Decisions

- **The disclaimer is data, not prose.** A header comment cannot be badged, and
  a description that is fetched-but-unrendered is indistinguishable from one
  that does not exist. `isDemo` is the only form that reaches a user.
- **Drop the UK schemes rather than keep them "for completeness".** A catalogue
  entry a Bulgarian producer cannot be certified against is not neutral — it is
  a scheme they might adopt, map their practices to, and never be able to use.
- **Reference public law; do not reproduce a standard.** The BG catalogue
  paraphrases obligations derived from public EU regulations and says so, and
  carries `isDemo: true` like every other.
- **Fingerprint content, not the file.** Hashing the raw YAML would make a
  whitespace change look like a revision, which trains people to ignore the
  signal.
- **Only guard a LEADING formula character.** Mid-string guarding corrupts
  ordinary agronomic values (`pH 6.5-7.0`, `N=180 kg/ha`) and buys nothing —
  spreadsheets evaluate on the leading character.
- **Turn selection off rather than document the double-click.** A row that
  renders `cursor-pointer` and needs two clicks is lying about itself, and
  selection with no batch actions has nothing to offer in exchange.
