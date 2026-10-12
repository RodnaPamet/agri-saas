# 2026-10-12 — the dead-key detector's fifth blind spot, and 171 keys removed

**Issue:** #1534

## Design

Two halves, and the order matters: the detector was wrong, I found out by
starting to act on its output, and only then was the deletion safe.

1. `scripts/i18n-dead-keys.mjs` now recognises a translator passed as a
   function **parameter** by what the parameter's type *mentions*, not by how it
   is spelled.
2. 171 keys across 11 fully-dead sub-namespaces are deleted from both locales.

## The blind spot

Handing `t` to a function takes its calls out of a regex scan's sight, so the
detector already marked the caller's namespace **undecidable** rather than
calling its unreached keys dead. That treatment was right. What was wrong was
which functions it found:

```js
if (/:\s*[A-Z]\w*Translator\b/.test(params)) TRANSLATOR_TAKERS.add(name);
```

That requires a word **before** `Translator`. So a parameter typed plainly
`Translator` did not match — and nothing matched
`ReturnType<typeof useTranslations>` at all. Those are the only two shapes in
this repo, so **7 of 9 takers were invisible**.

The consequence is **false positives**, which is the direction that matters,
because the candidate list is what somebody deletes from:

```ts
// journal/filter-defs.ts — all three were in the dead set
label: t('filter.type')     label: t('filter.status')     label: t('filter.crop')

// planning/filter-defs.ts — `filter.status` dead, and `status.*` too
label: t('filter.status'),
options: f.options?.map((o) => ({ ...o, label: t(`status.${o.value}`) }))
```

14 keys recovered: `journalEnums.filter.*` + `journalEnums.operationType.*`,
`planningEnums.filter.*` + `planningEnums.status.*`. I found them because I was
about to delete them.

## A claim this corrects

The detector's report and #1534's comments described the unreferenced count as
a **floor**, on the grounds that every remaining limit "pushes toward calling a
dead key LIVE" — and named *a translator passed as a prop* as an example of
exactly that. It is the opposite. An untracked translator hides its calls, so
its keys look **dead**. The floor claim does not hold, and "candidate for
review, not a verdict" has to be read as meaning both directions.

## The fix nearly inverted the bug

The first version was
`/:\s*[^,)]*\b(?:Translator|useTranslations|getTranslations)\b/`. The **leading
`\b`** matches `Translator` and does **not** match `EnumTranslator` — there is
no word boundary between `m` and `T`. So widening the matcher silently dropped
the `*Translator` shape the old one was built for: `crops`, `weeds`,
`taskEnums` and `knowledge.filters` left the undecidable set and **61 keys
became deletion candidates**.

Caught by diffing the before/after reports rather than by reading the regex. The
fix for a matcher written to the shape in front of me was a matcher written to
the shape in front of me — the fifth instance of that error in this one script:

```
1. response schemas / JSON columns     swept schemas no route parses
2. object-level .superRefine           validation not attached to its field
3. field NAMING                        matched *At/*Date/*On, missed from/to
4. member expressions                  matched t(ident), missed t(obj.prop)
5. translator PARAMETERS               matched *Translator, missed Translator
```

## The deletion, and why it is safe independently of the detector

11 sub-namespaces where **every** key is unreferenced, 171 keys. Ten of the
eleven are GRC-teardown residue — the models and pages went in #547/#501/#567
and the catalogue kept their copy:

| prefix | keys | |
|---|---|---|
| `admin.vendorReview` | 31 | vendor models dropped in teardown phase 3 |
| `admin.riskAppetite` | 31 | |
| `admin.vendorTemplateBuilder` | 28 | |
| `admin.vendorTemplates` | 21 | |
| `ui.approvalBanner` | 20 | |
| `admin.templates` | 9 | "Information Security Policy", "Access Control Policy" … |
| `ui.riskHeatmap` | 8 | |
| `practiceReverseLookup` | 8 | `practice` went with the teardown |
| `ui.sankeyChart` | 7 | |
| `ui.frameworkBuilder` | 5 | |
| `ui.tree` | 3 | no Tree component, no `expandAll`/`collapseAll` caller |

Four checks per prefix, as #1501 established: nothing binds the namespace or a
parent to a literal call that reaches it; no full key path is quoted anywhere in
`src/`; no `translateFor` template head starts with it; en/bg sets identical.

Plus one check that does **not** depend on the detector at all: **zero files in
`src/` so much as mention the feature** — `riskAppetite`, `vendorReview`,
`vendorTemplate`, `approvalBanner`, `frameworkBuilder`,
`practiceReverseLookup` all return nothing, and no vendor/framework/heatmap
component file exists.

`RiskHeatmap` and `Sankey` *did* return hits, and that is why the check was
worth running: all of them are **docblock mentions** in
`charts/index.ts`, `use-heat-scale.ts` and `chart-legend.tsx`, naming removed
consumers. A scar is not a wound — but it took looking to know which.

## Files

| file | role |
|---|---|
| `scripts/i18n-dead-keys.mjs` | the parameter matcher, plus the arrow form |
| `tests/guards/i18n-dead-keys-reports-three-numbers.test.ts` | three controls; the "derived from `: SomethingTranslator`" claim corrected |
| `messages/{en,bg}.json` | −171 keys each, +0 lines |

## Decisions

- **Matched by what the type mentions, not how it is spelled.** `Translator`,
  `useTranslations` or `getTranslations` anywhere in the parameter's type. A
  list of spellings is what produced this bug twice in one hour.

- **The arrow form is covered too**, though no file uses it today. The asymmetry
  between `function f(t: Translator)` and `const f = (t: Translator) =>` is
  exactly the kind of gap the previous four instances came through.

- **Three controls, each pinning a shape that was broken at some point in this
  change**: the bare alias (`exchangeFilters` undecidable), `ReturnType<…>`
  (`journalEnums`/`planningEnums` undecidable AND not in the dead set), and
  `*Translator` (`taskEnums`, `knowledge.filters` still undecidable — the half
  the first fix dropped). Mutation-proved: the old pattern fails 1, the inverted
  one fails 3.

- **`referenced` is the deletion's own control.** It is **4408 before and 4408
  after** — unchanged across the deletion of 171 keys. A referenced key removed
  would have moved that number, so it is the single figure that says nothing
  live went.

- **Four enum namespaces were NOT deleted** despite looking fully dead at the
  start: `journalEnums.filter`, `journalEnums.operationType`,
  `planningEnums.filter`, `planningEnums.status`. They are the false positives
  above, and they are the reason the detector fix had to land first.

- **The diff is `+0 −193` per locale.** The writer detects the file's existing
  indent rather than imposing one; a reformat would have buried 171 deletions in
  5559 lines of churn.
