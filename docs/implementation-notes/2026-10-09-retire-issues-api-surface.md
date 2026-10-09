# 2026-10-09 — retiring the `/issues/**` API surface

**Issue:** #1479

## Design

Fifteen live routes under `/api/t/{tenantSlug}/issues/**` served a model the
schema does not have. The GRC teardown removed `Issue`; the routes stayed and
operated on `Task` rows through `usecases/issue.ts` — a second write path to the
same table, diverging from `/tasks/**` in two measured ways.

**Cache invalidation was absent across the whole surface.** `task.ts` calls
`bumpEntityCacheVersion` 17 times; `issue.ts` called it zero times across 26
write functions. The task list cache is 60s TTL keyed on an entity cache
version, so a mutation through `/issues/**` changed the rows and left every
reader serving pre-change data until the TTL lapsed. The write was real and
invisible.

**Audit rows carried a dead `entityType`.** Fifteen `logEvent` calls wrote
`entityType: 'Issue'`. Nothing in the schema is an `Issue`, and `Issue` appears
nowhere in `fail-closed-entities.ts`, so a mutation to a `Task` row landed in
the hash-chained trail labelled as a nonexistent entity — invisible to any
audit query or SIEM filter scoped to `Task`.

Authorization was **not** the divergence. `issue.policies.ts` checked
`canRead` / `canWrite` / `role !== 'READER'`: coarser in wording, not weaker in
effect. This was a consistency and observability defect, never a privilege one.

### Retire, not repair

Adding the cache bump and correcting the `entityType` would have kept a second
write path to `Task` alive for no caller, which is how the two diverged in the
first place. Nothing in the repo called the routes and agrent-ios confirmed the
client calls nothing under `/issues/`.

### The bundle third was worse than undocumented

Three routes (`/bundles`, `/bundles/{id}/freeze`, `/bundles/{id}/items`) ran
through `EvidenceBundleRepository`, every method of which was a stub. Three
threw `deprecatedResource`; the other three did not:

| method | body | what a client saw |
|---|---|---|
| `listByIssue` | `return []` | **200 OK, `[]`** |
| `listItems` | `return []` | **200 OK, `[]`** |
| `getById` | `return null` | 404 |

So `GET /issues/{id}/bundles` told an authenticated caller *"this issue has no
evidence bundles"* when the correct answer was *"evidence bundles do not
exist"*. Those are different facts and the response could not distinguish them.
No `Bundle` model appears anywhere in `prisma/schema/`.

### Why nothing flagged it for two months

The only artefact pinning the surface in place was
`tests/integration/evidence-bundle.test.ts` — 117 lines of `existsSync`
asserting the route *files* were on disk, with a comment stating they "stay". A
file-existence check standing in for a behavioural one, filed under
`tests/integration/`.

Worth knowing for its own sake: because that kind of guard reads source at
`describe` time, a deleted subject makes the suite fail to **load** — `ENOENT`,
`Tests: 0 total`, and no `✕` line naming it. In a batch run that is easy to
mis-read as a pass. It is louder than a vacuous pass, but not where you look.

## The automation catalogue had to go in the same change

`ISSUE_CREATED` and `ISSUE_STATUS_CHANGED` had no producer once the usecases
were deleted. Leaving them would have reproduced the `TEST_PLAN_*` defect
CLAUDE.md records verbatim: the rule builder offering triggers for deleted
models, and `automation-catalog-emitter-coverage` going red. Both event names,
their data interfaces, their barrel re-exports, their UI labels and **two
shipped templates** (`tpl_critical_issue_ciso`, `tpl_slack_finding_webhook`)
went with the surface — a tenant adopting either would have built a rule that
could never fire.

`SEVERITY_OPTS` in `event-labels.ts` went too; its only consumer was the
`ISSUE_CREATED` severity filter.

## Files

| file | role |
|---|---|
| `src/app/api/t/[tenantSlug]/issues/**` (15) | the retired routes |
| `src/app-layer/usecases/issue.ts` | 524 lines, 26 exports, the second write path |
| `src/app-layer/policies/issue.policies.ts` | its policy layer |
| `src/app-layer/repositories/EvidenceBundleRepository.ts` | six stubs, three of them silently empty |
| `src/app-layer/repositories/IssueRepository.ts` | deprecated re-export of `WorkItemRepository`, no `src` caller |
| `src/app-layer/automation/{events,event-contracts,index}.ts` | the two producerless events |
| `src/lib/automation/event-labels.ts` | their trigger labels + `SEVERITY_OPTS` |
| `src/data/automation-templates/index.ts` | two templates on a producerless trigger |
| `src/app-layer/usecases/automation-suggestions.ts` | its only candidate recommended one |
| `src/lib/auth/api-key-scope.ts` | the `issues` scope family |
| `src/lib/schemas/index.ts` | `CreateBundleSchema`, `AddBundleItemSchema` |
| `src/generated/route-inventory.json` | 15 entries `live` → `retired`, with reasons |
| `tests/unit/issue-guardrails.test.ts` | **kept and repurposed** — see below |

## Decisions

- **The four `/issues` UI pages STAY.** `src/app/t/[tenantSlug]/(app)/issues/`
  holds four page files and they are pure redirects to `/farm-tasks`, calling no
  API. They are not part of the defect — no cache bug, no audit mislabelling —
  and deleting them would break old bookmarks for no gain. Worth stating because
  #1479's "no caller" claim rested on a grep for `issues/bulk`, which would have
  missed a page that *did* fetch. These do not.

- **`issue-guardrails.test.ts` was repurposed rather than deleted**, and its
  route assertion changed shape. It read:

      if (!fs.existsSync(issueRoutesDir)) return; // routes already removed

  so on the day the retirement it anticipated actually happened, it would have
  passed by not running, with nothing left to stop the surface returning. It
  asserts the directory's **absence** now, plus the absence of the four deleted
  modules. An early return that anticipates a future deletion becomes a silent
  pass on the day of it.

- **`ALLOWED_LEGACY_FILES` went from five entries to one** and is shrink-only.

- **The suggestions rail is now empty, and that is filed (#1525) not hidden.**
  `rankRuleSuggestions` held exactly one candidate and it triggered on
  `ISSUE_CREATED`. Removing it leaves the function's ranking logic — ordering,
  exclusion, contiguous re-ranking — with no subject, because `candidates` is a
  module-local const with no injection seam. The three tests asserting those
  properties were replaced by one asserting the empty state, so **adding a
  candidate fails that test** and forces the ranking tests back in the same
  diff. A conditional skip was the alternative and it is the worse one: it reads
  as a pass. Inventing a replacement candidate was rejected — a retirement PR is
  the wrong place to author product content.

- **Four shared guards were edited rather than deleted**, and in each case the
  Issue assertions were provably duplicates:
  - `sanitize-task-fields` — four Issue tests hit the same mocks and the same
    `Task` columns as their Task siblings.
  - `sanitize-write-paths` — the `addIssueComment` block was byte-equivalent to
    the `addTaskComment` one, entity-decoding test included (checked before
    deleting; that property would otherwise have been lost).
  - `sanitize-rich-text-coverage` — `usecases/issue.ts` was a declared path for
    `Task.description` / `TaskComment.body`. Its removal narrows the declared
    *paths* without narrowing the *columns*, since `task.ts` reaches the
    identical write seams. That list is otherwise exactly how a two-year gap
    happened, so the reason is recorded at the site.
  - `audit-s8-task-remediation` — five Issue blocks removed, Task half intact.

- **Three ratchets were lowered to their measured live values**, not merely to
  inside their drift allowance: `UNDOCUMENTED_CEILING` 233 → 218,
  `no-server-authored-user-copy`'s baseline 492 → 470, and the lint suppression
  ceiling. Slack left in a ratchet is headroom a later regression spends
  without going red.

- **`swr-keys.ts`'s `issues: makeResource('issues')` was left in place**,
  deliberately. It is an unused cache-key factory with no behaviour, and
  removing an exported symbol has its own route (#1386's deprecate-then-delete).
  Out of scope here rather than overlooked.

- **Six deprecated schema aliases stay** (`CreateIssueSchema` and friends at
  `src/lib/schemas/index.ts:310-315`). They are one-liners pointing at live
  `Task` schemas, so the orphan guard correctly does not flag them — the
  underlying schema is reachable. Same #1386 argument.
