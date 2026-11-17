# 2026-11-17 — the citation watch (#3146, first slice)

**Commit:** `ffde5417a feat(market): watch the agro calendar's cited documents for revision`

Server half of **agrent-ios#639** (owner: *"add a cron job for querying the МЗХ
for new series content every day"*). Note the namespace — in this repo `#639`
is an unrelated merged security PR.

## Design

`citedSourceUrls()` returns the documents the agro calendar cites: **13 today,
12 МЗХ and one seed-company variety sheet.** A daily job (`04:55 UTC`) fetches
each, hashes the bytes, and compares against a stored baseline.

```
schedules.ts ──► executor-registry ──► source-document-watch.ts
                                            │
                        citedSourceUrls() ───┤── one findMany for all baselines
                                            │
                        measureDocument() ───┤── fetchPublicUrl, per-hop policy
                                            │
                                            ▼
                                  SourceDocumentWatch
                           sha256 (baseline)  ·  changedAt/changedSha256 (flag)
```

The baseline is **never overwritten by a flag.** A changed document sets the
three `changed*` columns and leaves `sha256` alone, so the record of what a
published figure was checked against survives the revision.

## Files

| file | role |
|---|---|
| `prisma/schema/market.prisma` | `SourceDocumentWatch`, tenantless |
| `prisma/migrations/20261117004500_source_document_watch/` | table, unique index, two indexes, the flag-completeness CHECK |
| `src/lib/sources/document-fetch.ts` | `measureDocument` — fetch, cap, hash |
| `src/app-layer/jobs/source-document-watch.ts` | the job, the classifier, the five verdicts |
| `src/app-layer/jobs/{types,executor-registry,schedules}.ts` | payload, `attempts: 1`, the daily cron |
| `tests/unit/sources/document-fetch.test.ts` | 11 cases over the measure seam |
| `tests/unit/jobs/source-document-watch.test.ts` | 17 cases, in-memory store so multi-run state is real |
| `tests/integration/source-document-watch-schema.test.ts` | 8 cases — the CHECK, the unique index, the absence of RLS |
| `tests/regression/infrastructure-guards.test.ts` | schedule count 41 → 42, name set |
| `tests/guardrails/rls-coverage.test.ts` | the model's access classification |

## Decisions

- **The series comes from the CITATION KEY, never the URL.** Measured over all
  13. Of the four technology cards exactly one is named `tk_vineni_lozia.pdf`;
  the other three are `kanventsionalno_otglezhdane_…` /
  `konventsionalno_…` — МЗХ's own typo, two spellings across three siblings. A
  filename classifier places **1 of 4**; the dataset's `mzh-tk-*` slug places
  **4 of 4**, because it is a curated fact rather than a CMS artefact. Two
  bulletins also carry a random suffix (`…_Nd73T7O.pdf`), which is what #3136
  measured when it rejected constructing these URLs. An unrecognised prefix
  classifies as `null`: a wrong series label is worse than an absent one.

- **The change is flagged, not consumed.** The alternative — replace `sha256`
  and emit a log line — loses the baseline the moment it becomes interesting.
  The flag is therefore STICKY, and `changedAt` is not re-stamped on later runs
  over the same bytes: one revision must not read as a fresh incident every
  day, and the date a reviewer needs is when it FIRST changed.

- **A revert clears the flag.** If the document comes back to the bytes we
  checked against, the citation holds again; leaving it set would report an
  incident that no longer exists.

- **A failure never mints a row.** A baseline has to be bytes we actually read.
  An invented one (empty hash) would make the next *successful* run look like a
  change — a false alarm manufactured by the watcher itself.

- **Five verdicts with the denominator beside them.** `0 changed` is ambiguous
  between "every citation holds" and "nothing could be read", and those want
  opposite responses, so `partial` and `unreachable` are separate from `clean`.
  `no-citations` refuses to report success over an empty population — the trap
  P8.9's ciphertext check records.

- **Bytes are measured, never inferred.** `Content-Length` refuses early,
  before a body is buffered, and is never the answer: it may be absent, and
  #3147 is the whole story of a client that read emptiness out of that header's
  absence. The suite carries a server that under-declares, one that omits, and
  one that over-declares.

- **A CHECK the schema cannot express.** `source_document_watch_flag_is_complete`
  keeps the three `changed*` columns all-null or all-set. It is load-bearing:
  a row with `changedAt` set and `changedSha256` null reads as "changed, hash
  unknown", and the job compares against that column, so the partial state
  would re-flag the document every day for ever. Prisma has no CHECK syntax, so
  it lives in the migration — the `channel_post_says_something` arrangement.

- **`attempts: 1`, for the third distinct reason on that list.** Its МЗХ
  sibling uses 1 because a retry re-downloads a PDF; `zarnoborsa-pull` because
  a retry is a no-op dressed as recovery. Here a retry re-downloads *thirteen*
  documents, and a single unreachable one is already a recorded `failures[]`
  entry rather than a thrown run. The next daily run is a real retry: the
  comparison is against a stored hash, so a day's gap costs a day of detection
  latency and nothing else.

- **04:55 UTC, not 05:40.** Both this and `mzh-prices-pull` hit
  `mzh.government.bg`. Separating them keeps either job's failure readable as
  its own rather than as contention for one government CMS.

- **Sequential fetches.** Thirteen parallel requests at a government CMS is a
  load we have no reason to apply, and nothing waits on this job.

- **No new CLAUDE.md section.** The ratio claim about `runJob` was corrected
  there because this change invalidated it (and it was already out by half:
  "26 of the 45 job modules" against a measured 29 of 67). A feature section
  would have been out of proportion — #3136, this job's larger sibling, has
  none.

## Known limit

**The only reader of a flag today is the job's own structured log.** The row
persists, so a later console can read it, but nothing yet lets a superuser
acknowledge one and promote the new hash — which means a flag raised today
stays raised. That is stated in the model docblock rather than left for
somebody to discover, and it is the next slice on #3146, alongside discovery of
NEW documents (which needs a listing page per series; four of the five are
still unlocated).
