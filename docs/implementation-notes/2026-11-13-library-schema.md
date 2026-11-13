# 2026-11-13 — «Вдъхновение»: the library schema

**Issue:** #2980. Schema only — the reads, the seed subcommand and the
`PERSISTABLE_PATHS` entry land in the following release.

## Design

Two tenantless tables in a new domain file, `prisma/schema/library.prisma`:

```
Book          slug (unique) · title · author · locale · summary?
              sourceNote · licenseNote · version · useCases[] · publishedAt?
BookChapter   (bookId, number) unique · title · originalTitle? · paragraphs[]
```

The access model is one sentence: **a PUBLISHED book is readable by any
authenticated caller, in either session context, and writable by nobody
holding `app_user`.**

```sql
CREATE POLICY book_select ON "Book" FOR SELECT USING (
    "publishedAt" IS NOT NULL
    AND (COALESCE(current_setting('app.user_id', true), '') <> ''
      OR COALESCE(current_setting('app.actor_user_id', true), '') <> ''))
```

### Schema a release ahead — decided, not inherited

P5's, P8's and P9's rule ships a NEW TABLE one release before its writer, so a
rollback to the previous image never queries an object that is gone. P8.6
weakened it for an additive nullable column on an existing table, which
carries neither risk. These are new tables, so the rule applies at full
strength — stated here because the alternative was to ship reads in the same
PR and let the ordering happen by omission.

### Both session variables, which removes #1664 rather than documenting it

`runInUserContext` sets `app.user_id`; `runInTenantContext` sets
`app.actor_user_id` and not the other. Picking the wrong one fails SILENTLY:
the arm matches nothing, the read returns zero rows, nothing errors. That cost
a whole feature in #1664.

Every other tenantless table here picks ONE, because its rows belong to
somebody and the policy has to name them. A book belongs to nobody — there is
one population, "is this caller authenticated", and both runners answer it. So
the arm admits either.

Measured rather than argued: mutation M3 below narrows the arm to
`app.user_id` only, and the tenant-context read goes to zero. That is #1664's
premise confirmed on this schema.

### `publishedAt` is a disclosure boundary, in the policy as well as the read

The owner's constraint is that **publishing waits for their review of the
text**. So the seed writes an unpublished book, the owner reads it, and a
deliberate act publishes it — which means production holds rows that must
reach nobody for as long as that takes. #2980 §3(d) names the failure: the
flag "works in the seed and leaks through a read nobody filtered".

A `where` clause is one line somebody deletes while refactoring a list query,
so the policy carries the condition too. `BookChapter` asks the same question
of its PARENT: hiding the book row while serving its text is the whole of the
leak, not half a fix.

## Files

| File | Role |
|---|---|
| `prisma/schema/library.prisma` | the two models, with the tenantless / plaintext / locale reasoning |
| `prisma/migrations/20261113090000_library_books/migration.sql` | tables, the `paragraphs` CHECK, both SELECT arms, both bypasses, FORCE RLS |
| `tests/integration/library-books-rls.test.ts` | executes the policies under the real runners — 11 cases |
| `tests/guardrails/rls-coverage.test.ts` | NEW bucket `GLOBAL_CATALOGUE_RLS_MODELS`, set-equality checked |
| `tests/guardrails/global-catalogue-models.test.ts` | the positive "tenantless on purpose" entries |
| `tests/integration/p5-4-handling-metrics.test.ts` | unrelated fix — see below |
| `CLAUDE.md` | the schema-folder count, stale by six files |

## Decisions

- **A NEW access-classification bucket, because the taxonomy had a hole on
  this axis.** `rls-coverage` had `GLOBAL_BY_DESIGN_MODELS` (global, therefore
  no RLS at all — `Unit`, `AgriEvent`, `SoilSample`) and
  `PLATFORM_ONLY_RLS_MODELS` (RLS, and no `app_user` arm for anything). A
  published book is neither: every farm may read it and nobody may write it.
  Filing it under `PARTY_SCOPED_MODELS` was the available option and wrong
  twice — there is no party, and that check is CONTAINMENT, which cannot see
  an added permissive `book_insert`. The new bucket is checked with set
  EQUALITY for `PLATFORM_ONLY_RLS_MODELS`'s stated reason: `ALTER DEFAULT
  PRIVILEGES` grants `app_user` every command on a new public table, so the
  ABSENCE of a policy is the refusal and an EXTRA policy is the failure to
  look for.

- **The channel tables are NOT moved into it.** They are the near neighbours
  and sit in the containment bucket, whose comment there already apologises
  for the fit. Moving them is a MEASUREMENT of five tables' live arms, not a
  re-filing, and a wrong equality list reddens main. **#3014** carries it.

- **ONE title, in the language of the TEXT — never `titleBg` / `titleEn`.**
  `Channel` carries both locales because a channel name stands in for UI copy.
  A book title NAMES AN ARTEFACT: «Изкуството на войната» is our own Bulgarian
  translation from the public-domain classical Chinese, and rendering it "The
  Art of War" in an English UI would name a DIFFERENT artefact — here
  specifically the Giles 1910 translation, which #2980 avoids deliberately
  because Giles died in 1958 and EU protection runs to the end of 2028. A
  `locale` column says which language the text is in.

- **`locale` is a string, not the `Locale` enum.** That enum is the UI's
  two-language set; a library may hold a text in a language the interface does
  not speak, and reusing it would make such a book unrepresentable.

- **`summary`, not `description`; `sourceNote`, not `notes`.** Both avoided
  spellings are encryption-manifest field names, and since #1222 the manifest
  is per `(model, field)` — a plaintext column wearing a manifest name owes a
  `DELIBERATELY_PLAINTEXT` entry. The clearer name costs nothing and avoids
  the classification. `ChannelPost.body` is the case where that was not
  available.

- **`version` is an INTEGER with `updatedAt` beside it**, per #2980 §3(a): the
  phone compares versions to decide whether to re-download, and a timestamp
  invites a string comparison and a clock question. `updatedAt` is for
  display. The two answer different questions and neither substitutes.

- **`BookUseCase` is an enum, provisional like `ReportReasonCode`.** An
  unvalidated string list becomes a taxonomy nobody owns, and the phone
  renders an unknown code as a missing string — so the DATABASE refuses an
  unknown value and a seed cannot introduce one either. `STRATEGY` is the only
  member the owner has named; adding a value is a trivial migration. It is a
  CONTENT taxonomy, so deliberately not governed by `nav-vocabulary.md`.

- **`cardinality("paragraphs") > 0`, never `array_length(x, 1) >= 1`.**
  `array_length` returns NULL for an empty array and a CHECK whose expression
  is NULL PASSES, so the tempting spelling is a constraint that admits exactly
  the row it exists to refuse — the same family as an empty window satisfying
  a negated assertion.

- **No `app_user` write arm at all**, `Channel`'s reasoning: these rows are
  seeded and administered, and a caller able to insert one could publish a
  text under the platform's own name.

- **Signed-in rather than public** (owner ruling). `isPublicPath` opens a
  prefix for EVERY METHOD on it, and this repo's rule is that a public surface
  must also authenticate itself in the handler. A library is not a legal duty,
  nothing about it wants to be anonymous, and a signed-in read costs the phone
  nothing. A marketing-page library later is a `/f/`-style surface and its own
  decision.

- **The text itself is NOT in this PR and will not be committed until the
  owner approves it.** This repository is public, so a commit IS publication —
  which would pre-empt the review `published: false` exists to wait for, even
  with the flag set. The seed subcommand will read the text from a file the
  owner supplies.

## Mutation proofs

Applied to the live test database, suite re-run, then restored. Each line is
the case that caught it.

| | mutation | caught by |
|---|---|---|
| M1 | drop `publishedAt IS NOT NULL` from `book_select` | 3 cases, incl. "the book row is invisible in both contexts" |
| M2 | drop the parent-published check from `book_chapter_select` | "and so are its CHAPTERS — the half that is the actual leak" (only that one) |
| M3 | narrow the arm to `app.user_id` only (the #1664 shape) | "is visible under runInTenantContext" + the same-set comparison |
| M4 | `USING (true)` on both | 6 cases, incl. both unauthenticated controls |
| M5 | drop the `paragraphs` CHECK | "REFUSES an empty array with 23514" |
| M6 | `CREATE POLICY book_insert … WITH CHECK (true)` | the new `rls-coverage` bucket, by set equality |

M2 is the one worth keeping in mind: ONLY the chapter case failed. A book-only
assertion would have passed a policy that served the unpublished text.

## The unrelated fix riding along: a test that passed only on a pristine DB

`p5-4-handling-metrics`'s median case (shipped in #3011) took the median over
a 30-day window ending NOW and asserted the figure was exactly 2h. That is
true only of a database holding no other moderation rows in that window. CI is
such a database — a fresh service per run, migrated from empty — so the case
was green there and failed on this machine at 2.85h against an expected 2h.

`prisma/schema/social.prisma` and P5.4b both already state the rule: this
queue is GLOBAL, so a test asserting on it must scope itself to its own rows,
and the very next case in the same file does exactly that. The window is now
one day ending three minutes after the last fixture, **311** days back — an
offset no other case uses, so a leftover row from an interrupted run cannot
drift into it.

The assertions got STRONGER rather than merely stable: `n` is now `toBe(3)`
instead of `>= 3`, and `withinTarget` is `toBe(2)`. Mutation M7 — dropping the
window's upper bound — moves `n` to 5, which the old `>= 3` would have passed.
M8 — the answer median at `percentile_cont(0.9)` — reports 87,840s against
7,200s.

Fixed here rather than on its own PR because it is one test file, it was red
locally for anyone running the derived population, and leaving it would have
made this PR's own verification unreadable.
