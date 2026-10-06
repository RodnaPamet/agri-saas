# 2026-10-06 — P2.6: consistent vocabulary (Борса, Тенденции), celebration copy into `messages/`, GRC leftovers

**Commit:** see the branch `feat/p2-6-vocabulary` (phase P2, issue #1193)

## Design

Three strands, and the first one needed a *source* before it needed edits.

### 1. The vocabulary has a single source, and a guard that reads it

The phase plan says an owner reversal must be a one-file edit and names
`docs/nav-vocabulary.md`. That file did not exist, so it was created — and
deliberately not as prose. It carries a machine-readable table
(`Concept | Bulgarian | English | Keys | Never | Namespaces`) which
`tests/guards/nav-vocabulary.test.ts` **parses**. The doc is therefore the
expectation, not a mirror of one: change «Борса» in the doc and CI immediately
names every catalogue key that still says the old noun. Proved by mutation —
editing the one table cell produced a seven-key work order (below).

A guard with the nouns hard-coded in TypeScript would have made the doc
decorative and a reversal two files with nothing checking they agree.

The convergence itself is three nouns, not two, because «Борса» and «Пазар» name
different things:

| | before | after |
|---|---|---|
| sidebar SECTION holding Борса / Тенденции / Новини / Схеми | «Борса» | «Пазар» |
| sidebar ITEM for `/exchange` | «Пазар» | «Борса» |
| `/exchange` page heading | `Борса / Exchange` (both locales) | «Борса» / "Exchange" |
| sidebar ITEM for `/trends` | «Тренд» | «Тенденции» |
| `/trends` page title | «Тренд» | «Тенденции» |

Naming the section «Борса» made a group and one of its members share a name —
which no other sidebar section does — and left the exchange itself called
«Пазар». «Пазар» stays legal as a news category and in price copy («пазарна
цена»): the guard's `Never` sweep bans a noun as the WHOLE VALUE of a key under
a named namespace, never the word.

Two key RENAMES came with it, because the key names had become lies:
`sidebarNav.sectionExchange` → `sectionMarket`, `sidebarNav.marketplace` →
`sidebarNav.exchange`. The section `id: 'exchange'` did **not** change — it keys
the persisted per-section collapse state.

OpenAPI: the 19 `Борса` / `Тенденции` operation summaries now name the product
surface, and `src/generated/openapi.json` was regenerated in the same diff. The
**tags** stay `Exchange` / `Exchange messaging` / `Trends` — renaming a tag
regroups somebody's generated SDK, and that is recorded in the doc's
load-bearing-spellings table rather than left to be rediscovered.

### 2. Celebration copy moved into `messages/`; onboarding was already there

`src/lib/celebrations.ts` held eight milestone records with English `message` /
`description` literals. They are now `celebrations.<camelCaseKey>.{message,description}`
in both catalogues, resolved by `useCelebration()` through an exhaustive
`Record<MilestoneKey, …>` of resolvers (`MILESTONE_COPY`), so a milestone added
without copy is a compile error rather than a toast rendering its own key path.

Two consequences worth knowing:

- **The emoji could not come along.** `messages/*.json` may contain no
  decorative emoji (`tests/guards/no-decorative-emoji-in-messages`). Dropping
  the emoji would have been a silent copy regression, so it rides
  `MilestoneDefinition.glyph` instead and the hook appends it to the translated
  title. An emoji is not copy — it does not differ between locales.
- **`src/components/onboarding/` needed nothing.** Both files there route every
  string through `useTranslations` already (the T00–T15 migration got them). The
  onboarding work in this item was therefore *wording*, not extraction — three
  live strings about a "compliance workspace" / "compliance platform" /
  "compliance experience" became farm copy.

### 3. GRC leftovers — the population, and the split

The denominator was derived, not guessed. An AST walk resolved every static
`t('…')` call under `src/{app,components,lib,app-layer}` (4,269 distinct keys
from 4,982 call sites, 48 namespaces reached only dynamically), an import graph
over 2,060 modules from the 491 Next entrypoints decided which referencing files
the app can actually load (1,860 live, 200 unreachable), and a GRC-vocabulary
regex over `messages/en.json` was intersected with both.

**72 GRC-vocabulary strings are reached by a static `t()`. 66 sit in a live
module; 6 do not.** Of the 66, **26 were reworded or deleted** and **40 are
deliberately kept** — the PR description lists all 40 with a reason. The three
changes that mattered most:

- **The org sidebar's "Non-Performing Practices" row pointed at
  `/org/<slug>/practices`**, a route GRC teardown phase 2 deleted. Every click
  was a 404. The portfolio *dashboard's* matching card was repointed at the time
  (there is a comment in `dashboard-sections.tsx` saying so) and the sidebar was
  missed — `tests/guards/nav-routes-exist.test.ts` derives its population from
  the TENANT app tree, so nothing looked.
- **The new-tenant form shipped a compliance-framework picker.** ISO/IEC 27001,
  NIS2, ISO 9001, ISO 28000, ISO 39001 — on a farm product — and five of its six
  options pushed `/t/<slug>/frameworks?install=…`, also deleted. A brand-new
  tenant's first screen was a 404. Nothing caught it because the selection never
  reached the server, so no contract test saw it, and the nav-route guard reads
  registries rather than `router.push` call sites.
- **Three celebration milestones** (`framework-100`, `audit-pack-complete`,
  `first-practice-mapped`) described models the teardown deleted, had no caller,
  and were about to have "Audit pack ready" translated into Bulgarian for
  farmers. Gone, with the `scopedMilestone` helper whose only two documented
  use-cases were those surfaces.

## Files

| File | Role |
|---|---|
| `docs/nav-vocabulary.md` | **New.** The vocabulary's single source; a parsed table plus the load-bearing-spellings list. |
| `tests/guards/nav-vocabulary.test.ts` | **New.** Derives its expectations from that doc. Mutation-proved both ways (doc edit; catalogue edit). |
| `messages/bg.json`, `messages/en.json` | 2 key renames, 31 values changed, 10 keys deleted, `celebrations.*` added (10 new leaves). |
| `src/components/layout/SidebarNav.tsx` | Section «Пазар», item «Борса»; the `id` stays. |
| `src/components/layout/OrgSidebarNav.tsx` | Dead `/org/<slug>/practices` row removed. |
| `src/app/org/[orgSlug]/(app)/tenants/new/NewTenantForm.tsx` | Framework picker and its 404 redirect removed; two fields remain. |
| `src/lib/celebrations.ts` | Copy out, `glyph` in, three GRC milestones and `scopedMilestone` deleted. |
| `src/components/ui/hooks/use-celebration.ts` | Resolves milestone copy from `celebrations.*`; exports `MILESTONE_COPY`. |
| `src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx` | Calls `celebrate('evidence-all-current')` — the hook owns the copy now. |
| `src/lib/openapi/paths/{exchange-listings,exchange-messaging,trends}.paths.ts` | 19 summaries carry the product noun. |
| `src/generated/openapi.json` | Regenerated (21 lines). |
| `scripts/i18n-diff.mjs`, `tests/guardrails/i18n-completeness.test.ts` | `exchange.client.heading` left `UNTRANSLATED_ALLOWLIST` — it is no longer bilingual. |
| `tests/guards/no-hardcoded-ui-strings.test.ts` | JSX floor 17 → 13, the branch's measured count. |
| `tests/rendered/scoped-celebration.test.tsx` | Renamed from `audit-pack-celebration.test.tsx`; same contract, live milestone. |
| `tests/rendered/milestone-{discipline,trigger-conditions}.test.tsx`, `tests/unit/celebrations.test.ts`, `tests/guards/celebrations-coverage.test.ts` | Expectations follow the registry + catalogue. |
| `tests/unit/org-switcher-and-new-tenant-structural.test.ts`, `tests/e2e/ciso-portfolio.spec.ts`, `tests/guards/form-drift.test.ts` | Follow the removed framework field. |
| `tests/unit/org-shell-structural.test.ts` | Six org nav entries → five; pins the ABSENCE of the row, its key and its href. |
| `tests/guards/form-drift.test.ts` | A population floor on `walk()` — `selector-teeth` reported it toothless once this PR's comment fix brought the file into the audited delta. |

## Decisions

- **The doc is parsed, not mirrored.** The alternative — constants in the guard,
  prose in the doc — satisfies the letter of "one-file reversal" and none of its
  point. The cost is a parser that must REFUSE an absent or restructured table
  rather than return `[]`, because an empty selection is a pass; that refusal is
  asserted three ways in the self-test block.

- **The section was renamed, not just the item.** Converging the item on «Борса»
  alone would have produced a section and its first child with the same label.
  Renaming the section to «Пазар» is what makes both nouns mean exactly one
  thing, and it is the reason the guard needs the `Never` column at all.

- **The emoji stayed out of the catalogue.** The two honest options were "drop
  the emoji" (a copy regression nobody asked for) and "move it to a non-copy
  field". The second keeps the toast byte-identical in English and keeps
  `messages/*.json` clean.

- **Dead GRC strings were LEFT, and counted.** 6 statically-reached strings sit
  in modules the app cannot load (`NewEvidenceTextModal.tsx`,
  `OnboardingBanner.tsx` — both with zero importers), and a further set sits in
  dead render branches of live files (`OnboardingWizard`'s `STEPS` array has two
  entries, so its `FrameworkSelectionStep` / `PracticeInstallStep` / `ReviewStep`
  arms never mount). Rewording a string nobody can see is churn; deleting the
  components is a separate removal with its own blast radius (`NextBestActionCard`
  alone is named by nine test files). The PR description lists them so the next
  pass does not have to re-derive them.

- **`evidence.detailSheet.metaPractice` stays.** `Evidence` has no `practiceId`
  column, so the branch is unreachable — but `EvidenceListItemDTOSchema` still
  declares `practice`, and that schema is published as `EvidenceListItem` in
  `openapi.json`. Removing the label means narrowing a documented response
  shape, which belongs with the DTO and would (correctly) redden the
  breaking-change gate.

- **The calendar's GRC category labels stay.** `CalendarClient` builds an
  exhaustive `Record<CalendarEventCategory, string>`, so `policy` / `vendor` /
  `practice` / `finding` / `audit` / `risk` labels must EXIST; `calendar.ts`
  emits none of those categories. Narrowing `CALENDAR_EVENT_CATEGORIES` is an
  enum narrowing in a published schema — the same argument as above, and not a
  copy change.

- **`complianceMailbox` keeps its name.** It is a `TenantNotificationSettings`
  column and a field in the `/notification-settings` request body. Only the
  LABEL moved («Пощенска кутия за архив»). Recorded in the doc's load-bearing
  table, the same discipline `no-legacy-brand.test.ts` applies to the previous
  brand.

- **The JSX floor moved for a reason that is not this item's work.** 17 → 13 is
  the branch's measured count; the four-wide slack predated the item and the
  drift sentinel tolerates it. Saying so matters because the brief assumed
  moving strings into `messages/` would lower this number: it did not, and
  cannot, for the strings this item moved — the scan covers `src/app` +
  `src/components`, and the celebration copy lived in `src/lib`.

- **The command-palette placeholder named the wrong things twice.** It said
  "practices, risks, policies, evidence, frameworks" — five nouns, four of them
  for deleted models. The first rewrite said "locations, field work, journal,
  records", which was *farm* vocabulary and still wrong: `__SEARCHABLE_TYPES__`
  in `src/app-layer/usecases/search.ts` is `evidence | asset | task |
  knowledge`. It now names those four. Converging a vocabulary is not the same
  as making a string true, and a placeholder is a claim about what the box
  searches.

- **`'use client'` was added to `use-celebration.ts`.** `useTranslations` is the
  CLIENT binding and next-intl picks the implementation from the module's
  directive. `tests/guards/i18n-use-client-directive.test.ts` walks `.tsx`
  only, so neither this hook nor `use-palette-commands.ts` (the one existing
  `.ts` precedent, which carries the directive) is in its population — the
  directive is correctness here, not guard compliance.

- **Two assertions I wrote were aimed one level off, and both reddened before
  they were right.** `expect(src).not.toContain('/frameworks')` over the whole
  of `NewTenantForm.tsx` matched the DOCBLOCK that explains why the picker is
  gone — a negative assertion failing on its own explanation. It compares the
  comment-STRIPPED source now, with a positive control that the strip did not
  eat everything. And `org-shell-structural.test.ts` asserted six org nav
  entries by name; removing one means that test is the pin, so it now asserts
  five plus the absence of the row, its key AND its href. Both were found by
  running the suite, not by reading the diff.

- **One pre-existing toothless guard surfaced and was fixed rather than
  baselined.** `scripts/selector-teeth.mjs` audits the PR's CHANGED guard
  files, so editing one dangling comment in `tests/guards/form-drift.test.ts`
  pulled it into the delta — and reported `walk() -> return []` SURVIVED every
  test in it. Both of its assertions are ABSENCE checks over that walk, so an
  empty file list is a perfect pass. It already threw on a MISSING root (#875),
  which covers a rename; it did not cover a root that exists and yields
  nothing. It has a population floor now (>500 across both roots, >100 each),
  deliberately far below the live ~1,900 so it guards COLLAPSE rather than
  ratcheting a count. The alternative the tool offers — an entry in
  `selector-teeth-baseline.json` — would have recorded the hole instead of
  closing it, for a guard whose teeth cost eight lines.

- **`/org/<slug>/settings` is a second dead org nav row and was LEFT.** It is
  not a GRC leftover — it is an unbuilt settings surface, adjacent to P2.7's
  `/account` shell — so removing it here would be deciding somebody else's item.
  An org-nav route-existence check was drafted and dropped for the same reason:
  it would have gone red on that row on its first run.
