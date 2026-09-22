# 2026-09-22 — casing normalisation on `Task.applicationTechnique`

**Change:** a direct production `UPDATE`, on owner instruction. One row.
**Not in the audit trail** — see "Why this is written down" below.

## What changed

```
Task cmr3vmtlw000001p1l9j2yqj9   TSK-4   "Dron"  →  "dron"
Task cmr3wmjtk000001o4qkbetunp   TSK-5   "dron"     (unchanged)
```

Both are `FIELD_OPERATION`, status `RESOLVED`, created 2026-07-02 within 28
minutes of each other on the `agrent` tenant — one operator typing the same
word twice. `applicationTechnique` is the ДНЕВНИК's "Техника за приложение"
column, so these rows are on the legally-filed БАБХ register.

Only the CAPITALISATION was changed. The stored word is exactly what the
operator typed.

## How "all other cases" was established

Not by inspection. A generic sweep of every `text` / `varchar` column in the
`public` schema, comparing `count(DISTINCT col)` against
`count(DISTINCT lower(col))` — any column where those differ holds the same
value in more than one casing.

```
before:  scanned=773  skipped=0  hits=1   (Task.applicationTechnique)
after:   scanned=773  skipped=0  hits=0
```

The `skipped` counter is load-bearing. The first version of this sweep
swallowed exceptions silently, so "only one hit" could equally have meant "most
columns were never examined". The denominator is what makes the claim mean
something.

## Why this is written down rather than audited

`AuditLog` is hash-chained and only `logEvent()` may append to it. There is no
usecase for "normalise a technique string", so a direct SQL `UPDATE` leaves **no
audit row**. On a compliance register that absence matters more than usual, so
the record lives here instead: what changed, on whose instruction, by which id,
and how to reverse it.

**To reverse:** `UPDATE "Task" SET "applicationTechnique" = 'Dron' WHERE id =
'cmr3vmtlw000001p1l9j2yqj9';`

## What this does NOT fix, deliberately

**`dron` is not the vocabulary slug.** The seven options the UI offers are
`boom · ground · airblast · knapsack · spreader · drone · other` — the slug is
`drone`. Both rows still read `dron`, which is in no catalogue, so:

- a client lookup keyed on the vocabulary will not localise it, and
- `farm-record-diary.ts:360` prints the column **raw**, so the register shows
  `dron`.

Changing `dron` → `drone` is a change to the recorded CONTENT of a filed
compliance record, not to its capitalisation, and was not what was asked for.
It is a separate decision and deliberately left open.

**Recurrence is not prevented.** The column is `String?` and the write schema
is `z.string().max(255).nullable().optional()` — free text, unvalidated against
the seven. Nothing stops the next free-text entry drifting again. Normalising on
write, or constraining the field, would close that; neither was in scope here.
