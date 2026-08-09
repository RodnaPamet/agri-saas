# 2026-08-09 — Control → Practice rename

**Commit:** `<sha> refactor(rename): Control → Practice, /controls → /practices`

The last piece of the GRC uproot. #501 removed the *quantification*
exoskeleton (risk register, FAIR/Monte-Carlo, test-of-control plans);
what survived was a genuinely useful entity with an inherited name.
A Bulgarian farm does not operate "controls" — it operates **practices**:
the crop-rotation rule, the spray-interval rule, the storage-hygiene
rule. Same table, same lifecycle, honest noun.

This is a pure rename. No behaviour changes, no columns added or
dropped, no route semantics altered. Everything that was reachable
before is reachable after, at a new path.

## Design

Four surfaces move together, because a partial rename is worse than
none — a codebase where the table is `Practice` and the URL is
`/controls` costs every future reader a translation step.

```
 schema      Control          → Practice          (8 tables, 19 columns)
             ControlStatus    → PracticeStatus    (4 enums)
             'CONTROL'        → 'PRACTICE'        (5 enum VALUES)
 code        ControlRepository→ PracticeRepository (~1000 files)
 URL         /t/:slug/controls→ /t/:slug/practices (69 git mv)
             /api/…/controls  → /api/…/practices
 i18n        controls.*       → practices.*       (en + bg)
```

**The migration is hand-written and must stay that way.** `prisma
migrate diff` cannot infer a rename: it sees a table that vanished and
a table that appeared, and proposes `DROP TABLE` + `CREATE TABLE` —
which is a silent, total data loss for every tenant. The file carries
a header saying so. `ALTER TABLE … RENAME TO` is the opposite: it is a
catalogue update that carries the RLS policies, `relrowsecurity` /
`relforcerowsecurity`, indexes, constraints and triggers with it, and
touches no heap pages.

114 statements, in dependency order:

| Kind | Count | Statement |
| --- | --- | --- |
| Enum type renames | 4 | `ALTER TYPE "ControlStatus" RENAME TO "PracticeStatus"` |
| Table renames | 8 | `ALTER TABLE "Control" RENAME TO "Practice"` |
| Column renames | 19 | `ALTER TABLE "Task" RENAME COLUMN "controlId" TO "practiceId"` |
| Index / FK / pkey renames | 77 | `ALTER INDEX … RENAME TO …` |
| Enum **value** renames | 5 | `ALTER TYPE "TaskLinkEntityType" RENAME VALUE 'CONTROL' TO 'PRACTICE'` |
| Data migration | 1 | jsonb rekey on `TenantCustomRole.permissionsJson` |

Renaming an enum **value** is metadata-only (`ALTER TYPE … RENAME
VALUE`) — unlike *removing* one, which Prisma implements as a
type-swap-with-cast and which would rewrite every referencing table.
Five values move: `TaskLinkEntityType.CONTROL`,
`VendorLinkEntityType.CONTROL`, `AuditPackItemEntityType.CONTROL`,
`WorkItemType.CONTROL_GAP`, `NotificationType.CONTROL_ASSIGNED`.

**The permission domain needs a data migration, and it is the one
statement in this file that can silently corrupt authorization.**
`TenantCustomRole.permissionsJson` persists a serialized
`PermissionSet`; `parsePermissionsJson` falls back to the base role's
defaults for any domain it does not find. So renaming the `controls`
key in TypeScript without rekeying the stored jsonb does not fail —
it silently reverts every custom role to its base-role practice
permissions. Hence:

```sql
UPDATE "TenantCustomRole"
   SET "permissionsJson" =
         ("permissionsJson" - 'controls')
         || jsonb_build_object('practices', "permissionsJson" -> 'controls')
 WHERE jsonb_typeof("permissionsJson") = 'object'
   AND "permissionsJson" ? 'controls';
```

Guarded on `jsonb_typeof` so a malformed row is skipped rather than
erroring, and idempotent — the `?` predicate means a re-run updates 0
rows.

**`AuditLog` is deliberately untouched.** Historical entries carry
`entityType: 'CONTROL'` and the table is hash-chained: rewriting a
committed row breaks the chain and destroys the tamper-evidence the
whole audit trail exists to provide. Old entries keep the old noun;
new entries write `PRACTICE`. Reading the audit trail across the
rename boundary means knowing both, which is the correct tradeoff —
an audit log that can be retconned is not an audit log.

## Verification

The migration was applied to a real Postgres 16 with a seeded row,
not just typechecked:

- the seeded `Control` row survived as a `Practice` row, values intact;
- all three RLS policies (`tenant_isolation`, `tenant_isolation_insert`,
  `superuser_bypass`) followed the table;
- `relrowsecurity | relforcerowsecurity` stayed `t | t`;
- 12 indexes carried across;
- `prisma migrate diff` against the post-migration database showed no
  residual `Control` reference — the 31 remaining statements are the
  pre-existing baseline drift, identical on `main`;
- the jsonb rekey preserved intent (`{"controls":{…}}` →
  `{"practices":{…}}`), left sibling domains untouched, and updated 0
  rows on a second run.

## Files

| File | Role |
| --- | --- |
| `prisma/migrations/20260809120000_rename_control_to_practice/migration.sql` | The whole rename. Hand-written; header warns against regeneration. |
| `prisma/schema/{compliance,enums,auth,audit,automation,processes,agriculture,vendor,exchange}.prisma` | Model + enum + relation-field renames. |
| `src/app-layer/repositories/PracticeRepository.ts` | Was `ControlRepository`. |
| `src/app-layer/usecases/practice/` | Was `usecases/control/`. |
| `src/app/t/[tenantSlug]/(app)/practices/` | Was `(app)/controls/`. The URL change. |
| `src/app/api/t/[tenantSlug]/practices/` | Was `api/…/controls/`. |
| `src/lib/permissions.ts` | `PermissionSet.controls` → `.practices`. |
| `messages/{en,bg}.json` | `controls.*` → `practices.*`, both locales. |

## Decisions

- **`/practices` with no redirect from `/controls`.** The product has
  no external consumers, no bookmarked deep links worth preserving,
  and a redirect layer is a second source of truth about where a page
  lives. A clean break is cheaper than a compatibility shim nobody
  removes.

- **Homonyms are not renamed, and there are far more of them than you
  would guess.** A blind `s/control/practice/` produces a codebase that
  typechecks and is subtly wrong in a dozen places. Explicitly left
  alone: `AbortController`; react-hook-form's `control` prop and
  `<Controller>`; the `controlled` / `uncontrolled` component
  vocabulary; xyflow's `<Controls>` component **and its
  `react-flow__controls` CSS class names** (renaming a vendor's CSS
  selector breaks the vendor's stylesheet); `pagination-controls.tsx`;
  `control-variants.ts`; GDPR "data controller"; the persisted string
  `'Access Control'`; and `isoControlId`, which is ISO 27001's own
  terminology for its clauses and not ours to rename.

- **The homonyms that cost the most were the ones nothing could catch.**
  Five review rounds found identifier-level over-reach. A sixth found a
  worse class, and only because a single E2E assertion happened to
  execute it (`keyboard.press('Practice+KeyK')` → *Unknown key*). Every
  member of that class is a **string literal**, invisible to TypeScript,
  and the full suite — 26,642 tests — was green with all of them live:

  | Mangled | Sites | Consequence |
  | --- | --- | --- |
  | `Cache-Control` → `Cache-Practice` | 39 | Unknown header ⇒ ignored. `no-store` silently stopped applying to avatar, evidence-download, file-download, farm-record, policy-export, PDF-export and access-review-evidence responses — those became cacheable by browsers and intermediaries — and `immutable` basemap/cadastre tile caching stopped working, on the rural LTE this product optimises for. |
  | `Access-Control-Allow-*` → `Access-Practice-Allow-*` | 28 | No CORS. |
  | `aria-controls` → `aria-practices` | 5 | React passes `aria-*` through verbatim ⇒ invalid ARIA shipped; tab→tabpanel and accordion-rail relationships broke for screen readers. |
  | `control` modifier alias | 2 | `"control+k"` threw *unknown modifier*; the palette's modifier formatter lost its arm. |
  | `Pest control` / `Disease control` | 2 | User-facing farm-task labels, in an agriculture product. |

  Two second-order lessons. **A guardrail renamed alongside its subject
  stops guarding**: `b7-layout-redesign.test.ts` asserted
  `aria-practices=\{contentId\}` and passed, green about the bug.
  And **case matters where the platform says it doesn't**: HTTP header
  names are case-insensitive, so routes wrote `'Cache-Control'` and
  tests read `'cache-control'`; the first repair grepped case-sensitively,
  fixed only the writers, and CI caught two tests still asserting on
  `headers.get('cache-practice')`.

  `tests/guards/web-platform-identifiers.test.ts` is the backstop: it
  pins the canonical spellings, bans the mangled forms **case-folded**,
  and carries a mutation proof including the lowercase case that
  escaped. Before the next project-wide identifier sweep, add the
  at-risk standard names to it first.

- **Historical migrations are asserted verbatim.** Two structural
  guards (`pr-asset-practice-codes`, `notif-assignment-alerts-wiring`)
  read applied migration SQL. They now assert the ORIGINAL spelling
  (`ControlKeySequence`, `CONTROL_ASSIGNED`) plus a new assertion that
  the rename migration carries each to its new name. Editing an applied
  migration to match a rename would change its checksum and break
  `migrate deploy` on every existing database — the current name is
  asserted against the live schema instead.

- **Bulgarian is a gender change, not a find-and-replace.** «контрол»
  is masculine, «практика» is feminine, so agreement propagates:
  *нов контрол* → *нова практика*, *този контрол* → *тази практика*,
  *приложим* → *приложима*, *Свързан контрол* → *Свързана практика*.
  Pasting the English value or swapping the noun alone would have
  passed the key-parity guard and read as broken Bulgarian.

- **The `CTL-` key prefix stays.** Practice keys are `CTL-1`, `CTL-2`,
  … and every existing row carries one. Renaming the prefix means
  either rewriting user-visible identifiers that appear in exported
  audit packs and printed records, or running two prefixes forever.
  The prefix is an opaque handle; it does not need to spell the noun.
