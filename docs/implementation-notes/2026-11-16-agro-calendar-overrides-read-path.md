# 2026-11-16 — agro calendar overrides, the read path

**Commit:** `<pending> feat(agro): merge calendar overrides into the served window`

Stage 1 of #3095. This is the READ path only: the table, the migration, the pure
merge, and the served shape. The write path — the usecase, the two route doors,
the audit registrations and its coded refusals — is deliberately a second PR.

## Design

An override is a row, not an edit to the dataset. `AgroCalendarOverride` holds a
whole replacement window as `windowJson` plus a `basisBg` explaining why it
differs from МЗХ's card, and `applyOverrides()` folds live rows into the
published windows at serve time. The dataset literals are never mutated, so
clearing an override restores the published figure with no migration and no
redeploy.

The served shape carries the outcome rather than the mechanism:

```
published   cites present     no origin, no basis, no supersedes
corrected   NO cites          origin + basis + supersedes
added       NO cites          origin + basis
```

`cites` and `basis` are **mutually exclusive by construction**. An override
changes a figure while the published citation still points at a page that no
longer supports it, so a corrected window drops `cites` entirely — that makes
"a basis rendered beside a citation" unrepresentable instead of merely
discouraged. An uncited window is honest; a wrongly-cited one looks sourced,
which is worse.

`supersedes` records what a correction replaced (МЗХ's own dates and citation).
It is traceability for the admin console, NOT a live citation, and the OpenAPI
description says so at the field.

## Files

| file | role |
|---|---|
| `prisma/schema/agro.prisma` | `AgroCalendarOverride` — pure addition |
| `prisma/schema/enums.prisma` | `AgroCalendarOverrideOrigin { CORRECTED ADDED }` — pure addition |
| `prisma/migrations/20261116140000_agro_calendar_overrides/migration.sql` | hand-written; partial unique index + RLS |
| `src/lib/agro/calendar/overrides.ts` | the pure merge; no I/O, no casts |
| `src/lib/agro/calendar/load.ts` | `ServedWindow` widened; `mergedWindows()` |
| `src/lib/openapi/paths/agro-calendar.paths.ts` | the three new fields, described |
| `tests/guardrails/rls-coverage.test.ts` | classifies the model `platform-only-rls` |
| `tests/guards/audit-redaction-covers-the-schema.test.ts` | excuses `cropKey` with a reason |

## Decisions

- **`OverrideWindowSchema` is derived by omission** —
  `CalendarWindowSchema.omit({ cite: true, alsoCite: true })` — so the override
  shape cannot drift from the published one. A hand-written twin would have to
  be edited every time a window field is added, and nothing would fail if it
  were not.

- **The region filter runs AFTER the merge, not before.** A correction may move
  a window between regions, so filtering first drops a window the override was
  about to relocate into the requested region. Mutation-proved: filtering first
  fails two assertions.

- **Liveness is a partial unique index, not a flag.**
  `AgroCalendarOverride_live_windowId_key ON ("windowId") WHERE "clearedAt" IS
  NULL` — so "two live overrides for one window" is refused by the database
  rather than by whoever remembers to check. Verified against a scratch DB: a
  second live row is refused, one is admitted after clearing, and `basisBg`
  NOT NULL holds.

- **RLS is `superuser_bypass` only**, following `NoticeScore`. These rows are
  platform-wide agronomic corrections with no `tenantId`; there is no tenant
  whose context should read them, and the serve path reads them privileged.

- **`basisBg` is NOT NULL and `basisEn` is nullable.** A correction with no
  stated reason is the thing this table exists to prevent, and Bulgarian is the
  language the operator reads. An English gloss is a convenience.

- **The audit and RLS-bypass-reason registrations were REVERTED out of this
  PR.** They belong to the write path, and registering them early widened the
  derived test population from 5 paths to 25 for code that does not exist yet.
  Premature registration reads as coverage.

- **`cropKey` is excused in the audit-redaction guard rather than redacted.**
  That guard flags `*Key` columns; this one is credential-SHAPED and is a crop
  slug (`wheat`), authenticating nothing. Same treatment as `pathKey` /
  `storageKey`, with its own written reason because theirs ("a stable slug
  chosen by the tenant") does not describe a platform-wide crop key.

- **`prisma format` was reverted.** It reformatted 12 unrelated schema files;
  only the two pure additions are in this diff.
