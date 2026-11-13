# 2026-11-13 — «Вдъхновение»: the two reads and the seed

**Issue:** #2980, PR 2 of 3. The schema shipped a release ahead in **v14.15.0**
(#3015), which is what this PR waited for. PR 3 is the `/library` page, the nav
item and the `PERSISTABLE_PATHS` entry.

## Design

```
GET /api/library/books          → { books: [BookSummary] }      ETag
GET /api/library/books/{slug}   → BookDetail (with chapters)    ETag
```

Both: `getUserCtx` → `assertFeatureEnabled('library.enabled', …)` →
`runInUserContext` → the query. Non-tenant, signed-in, flag-gated.

The seed is a sixth `dist/seed.mjs` subcommand with three verbs:

```
node dist/seed.mjs library --file /tmp/book.json      # write/update, UNPUBLISHED
node dist/seed.mjs library --publish <slug>           # the owner's decision
node dist/seed.mjs library --unpublish <slug>         # take it back out
```

## Files

| File | Role |
|---|---|
| `src/app-layer/usecases/library.ts` | `listBooks`, `readBook`, one `SUMMARY_SELECT`, one `PUBLISHED` filter |
| `src/app/api/library/books/route.ts` | the directory, `jsonWithETag` |
| `src/app/api/library/books/[slug]/route.ts` | the detail read |
| `scripts/library/seed-library.ts` | the file schema and the three verbs |
| `scripts/seed.ts` | the `library` subcommand — deliberately NOT in `all` |
| `src/lib/openapi/paths/library.paths.ts` | 2 operations, registered |
| `tests/guards/library-reads-filter-published.test.ts` | NEW — the half behaviour cannot see |
| `tests/unit/library-reaches-the-operator.test.ts` | NEW — the audience ruling, EXECUTED against the real middleware |
| `tests/unit/library-routes.test.ts` | the gate, its ORDER, and the ETag round trip |
| `tests/integration/library-reads-and-seed.test.ts` | the queries, the seed and the three verbs |
| `docs/deployment.md`, `CLAUDE.md` | both said "four subcommands"; stale since P9.2 |
| `tests/guards/social-routes-flag-gated.test.ts` | `src/app/api/library/` as a root |
| `tests/guards/seed-deployment.test.ts` | six subcommands, count DERIVED |
| `messages/{en,bg}/app.json` | `BOOK_NOT_FOUND` |

## Decisions

- **NON-TENANT, owner ruling 2026-11-13, and the mechanism is the argument.**
  `isOperatorAllowedPath` is an allowlist that would deny `/api/library/…`
  read in isolation. What makes the path safe is the CALL SITE:
  `src/middleware.ts` consults it only when a slug parses out of
  `/^\/(?:api\/)?t\/([^/]+)/`, so a non-tenant path is never asked about and a
  MECHANISATOR reaches it with no change to the confinement. The page at
  `/t/{slug}/library` would additionally have needed an entry in the separate
  hand-written page enumeration, and the slug would imply a per-farm library
  that does not exist.

- **SIGNED-IN, and deliberately not in `PUBLIC_PATH_PREFIXES`.** Opening a
  prefix opens EVERY METHOD on it, and this repo's rule is that a public
  surface must also authenticate itself in the handler. A library is not a
  legal duty — unlike the Art 16 notice route, anonymous BY DUTY — and a
  signed-in read costs the phone nothing.

- **The seed takes a FILE PATH, and the text is not committed.** This
  repository is public, so a commit IS publication and would pre-empt the
  review `publishedAt` exists to wait for, flag or no flag.

- **WRITING and PUBLISHING are two commands.** `seedLibraryBook` writes
  `publishedAt: NULL` on insert and never touches it on update; publishing is
  its own verb. Three reasons, and the third is the one that matters: it is the
  `channels` rule (a seed writing its create-shape every run resets an
  operator's decision on every deploy); re-seeding a corrected text must not
  unpublish a live book nor publish a withheld one; and **the review happens on
  the FILE**, because `book_select` refuses an unpublished row to every session
  and there is no way to read one back through the API. By design.

- **`publishLibraryBook` does not re-stamp.** `publishedAt` is the date the
  text became public — the only thing a licence question or a takedown would be
  dated from. The `suspendedAt` precedent (P5.9).

- **Chapters are REPLACED wholesale** inside the transaction. Per-chapter
  upserts leave an orphan whenever a revision merges or renumbers chapters, and
  `@@unique([bookId, number])` turns that into a confusing constraint error. A
  chapter row holds only derived text; the file is the source.

- **The file schema is `.strict()`, not `.strip()`** — the opposite choice from
  `FileReportSchema`. A file able to set `publishedAt` would make the review a
  thing somebody can forget, and here the operator IS the trusted party, so a
  silent drop would hide their mistake from them rather than denying an
  attacker knowledge of a field.

- **`library` is NOT in `all`.** There is no file to default to, so including
  it would fail every `all` run — the opposite of `channels`, which is
  self-contained.

- **An unpublished slug answers EXACTLY the 404 a nonexistent one gets**, and
  the test asserts it as a COMPARISON of every observable rather than as two
  separate refusals. A distinct code would confirm that a book exists and is
  merely withheld, which is an oracle over what the review protects — and a
  slug is guessable from a title.

- **Unpaginated, with a ceiling of 200.** A measurement rather than an
  omission: the catalogue is curated by hand and holds single digits. Reaching
  the ceiling is the signal to paginate, not to raise it.

- **`PERSISTABLE_PATHS` is deferred to PR 3, and #2980 §4's entry is wrong.**
  Two measured corrections, both consequences of the `/library` ruling that
  postdates the issue:
  - that allowlist is matched against `tenantRelativePath(key)`, which strips
    only `/api/t/<slug>` — a non-tenant key passes through UNCHANGED, so the
    entry must be `/api/library/books`, not `/library/books`. As §4 writes it,
    it would never match;
  - the bucket namespace for a non-tenant page is `<userId>::global`, so it is
    one copy per USER rather than per (user, farm) — less waste than §4
    predicted.
  An allowlist entry for a path nothing fetches is inert, and this repo has a
  strong norm against inert things that read as wired, so it ships with the
  page that fetches it.

## Mutation proofs

| | mutation | caught by |
|---|---|---|
| L1 | drop the flag gate from the directory route | `social-routes-flag-gated` |
| L2 | interpolate the flag key | same |
| L3 | drop `'library'` from `SUBCOMMANDS` (dispatch + usage kept) | `seed-deployment` |
| L4 | replace the `publishLibraryBook` call with an inline object | **SURVIVED** — see below |
| L5 | drop the `publishedAt` filter from both reads | **SURVIVED** — see below |
| L5b | …and also drop the policy's `publishedAt` arm | 3 integration cases |
| L6 | drop the filter from the directory read | the new source guard |
| L7 | empty the `PUBLISHED` constant | the guard's separate constant check |
| L8 | read BEFORE the gate | *does NOT read when the flag refuses* |
| L9 | replace `jsonWithETag` with a plain response | *carries an ETag* |
| L10 | drop the lockdown's inner `slug &&` guard | **SURVIVED** — see below |
| L10b | …and widen the outer `isTenantPath` gate to admit `/api/library` | *the middleware lets a MECHANISATOR through* |

**L4 was a substring trap in my own guard.** `unpublishLibraryBook(` CONTAINS
`publishLibraryBook(`, so `toMatch(/publishLibraryBook\(/)` was satisfied by
the unpublish call and could never fail while that verb existed. A negative
lookbehind fixes it; `\b` does not, because there is no word boundary inside
`unpublish`.

**L5 surviving is the design working, and it is why the source guard exists.**
`publishedAt` is enforced twice — in the `where` clause and in `book_select`.
Removing the clause from both reads left all twelve integration cases GREEN,
because the policy caught it; only the COMBINED mutation went red. That is the
signature of defence in depth: each layer alone suffices, so a single-site
mutation correctly survives, and neither layer is independently proven by
behaviour. What proves each is the other's absence — so the clause is asserted
on the SOURCE, the `take: limit + 1` precedent.

What the clause is FOR, given the policy already refuses: it makes the reason
visible where somebody writes the next read, and it survives a legitimate
widening of the policy. If a visibility column ever joins `Book`,
`book_select` is rewritten, and a read whose only gate was that policy becomes
a leak in the same diff.

**L10 corrected the reason the library reaches a MECHANISATOR, and #2980 §1
has it incomplete.** The issue — and my first docblock — credits the inner
condition:

```js
const slug = pathname.match(/^\/(?:api\/)?t\/([^/]+)/)?.[1];
if (membership?.role === 'MECHANISATOR' && slug && !isOperatorAllowedPath(...))
```

True, and not what does the work. The whole lockdown sits inside an OUTER `if
(isTenantPath(pathname))`, so a non-tenant path is excluded before the inner
condition is evaluated at all — removing `slug &&` left every case green. Only
the combined mutation reddens it.

That is better news than the issue claims: the safety rests on two independent
gates rather than one condition somebody could tighten. It still matters,
because a sentence crediting the inner condition sends the next reader to
protect a line that is never reached. `tests/unit/library-reaches-the-operator.test.ts`
drives the real middleware and asserts the FUNCTION's own answer beside it —
the two disagree, and the disagreement is the mechanism.

## Two contract guards earned their keep

Both fired on the first `openapi:generate` and both were right:

- `timestamps-declare-their-format` — `LibraryBookSummary.updatedAt` was a bare
  `string`, so a generated client would get a `string` where it could have had
  a date. `.datetime()` added.
- `error-codes-are-documented` — `BOOK_NOT_FOUND` was emitted and named
  nowhere in the spec, so a client switching on codes would have fallen back to
  a generic message. Named on the operation that raises it.
