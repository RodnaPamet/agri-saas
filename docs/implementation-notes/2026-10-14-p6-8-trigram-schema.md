# P6.8 PR 1 — trigram search schema

Schema only: `pg_trgm`, a `displayNameLatin` column on `PublicFarmProfile`, and
two `gin_trgm_ops` indexes. The writer populates the column and the search
usecase reads it in the next PR, per the phase rule that tables ship a release
ahead of the code that writes them.

Issue: #1817.

## The mapping already existed, and I had said it did not

I wrote on the issue that Latin↔Cyrillic matching "needs a transliteration
step: a mapping that has to be written and tested". `src/lib/bg-transliterate.ts`
already implements the **Streamlined System** of the Закон за транслитерацията
(2009) — the spelling on Bulgarian passports and road signs — with 9 call
sites and two convergence guards. Its own docblock says the output "becomes a
tenant slug and a public handle".

So this issue's example works forward already: «Победа» → `Pobeda`.

Corrected on the issue. Grepping first would have saved the plan.

## Store the Latin form; never reverse the query

My instinct was to normalise the query. That is the trap, and the reason is
measurable — **the mapping is not injective**:

```
'a' <- а , ъ
'y' <- й , ь
```

A Latin `a` could be `а` or `ъ`, so reversing `pobeda` has more than one answer
and a search built on it would miss farms silently. Transliterating the stored
name forward has exactly one answer per input.

### And the measurement that makes it not a choice at all

```
similarity('pobeda', 'Победа')   = 0
similarity('AgroTeh', 'AgroTech') = 0.545
```

**Cross-script trigram similarity is zero.** No threshold rescues a Latin query
against a Cyrillic column, so the Latin column is not an optimisation — it is
the only design that works. Both numbers are asserted in
`tests/integration/p6-8-trigram-schema.test.ts`, because if either changes the
design needs rereading and nothing else would say so.

The second number is why **similarity** rather than equality: «АгроТех»
transliterates to `AgroTeh`, not `AgroTech`, because `х → h` and
transliteration is not translation. The realistic English-looking query is an
exact match for nothing stored, and trigrams find it anyway.

## A column, not a functional index

A trigram index over `transliterate()` would make the index depend on
application code the database cannot see, and the function's output would then
have to stay byte-stable across deploys for the index to remain valid.

## Nullable, deliberately

The writer lands a release later, so rows projected in between have no Latin
form. The only consequence is that such a row does not match a *Latin* query —
its Cyrillic name still does. A NOT NULL column would have failed against any
database already holding rows, which the production table is not but the test
databases are.

`tests/integration/p6-1-projection-writer.test.ts` asserts the column is
present **and null**, so the intermediate state is the tested state rather than
an accident.

## What the schema test is for

There is no usecase in this PR, which is exactly why it exists. A migration
declaring an extension and two operator-class indexes can fail to deliver any
of them with nothing going red: the column would still be there, `tsc` would
still pass, and the first symptom would be a directory search doing sequential
scans — slow rather than broken, which is harder to notice.

It asserts `gin_trgm_ops` specifically, not merely `USING gin`: a plain GIN
index on text cannot serve `similarity()` or `%`.

Mutation-proved by dropping one index against the live database — one case
fails, and restoring it passes.

## Rollback

`migration.down.sql` drops the indexes and the column. The **extension stays**:
`DROP EXTENSION` without CASCADE fails while anything depends on it, and with
CASCADE silently removes whatever that is. An installed extension nothing uses
costs nothing.

## Production, checked before writing any of it

PostgreSQL 16.15; `datcollate` and `datctype` both `en_US.utf8`, not `C` — the
thing the phase said to check, because a `C` ctype breaks case-insensitive
matching for Cyrillic and would have made this whole approach wrong. `pg_trgm`
available at 1.6, not installed.
