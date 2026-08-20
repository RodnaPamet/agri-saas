# 2026-08-20 — Custom-role resolution: the arm that had never executed

**Commit:** `<pending> test(security): drive the custom-role resolution arm, which had never executed`

Closes gap #10 of the enforcement-seam audit (2026-08-19), GitHub issue #629.

## Design

`src/lib/tenant-context.ts:120-122` is the ternary that turns a
`TenantCustomRole.permissionsJson` blob into `ctx.appPermissions`. Measured with
istanbul before this file existed, its custom-role arm had executed **zero**
times — `tests/unit/tenant-context.test.ts` under
`--collectCoverageFrom=src/lib/tenant-context.ts` reported the branch at
`[0, 5]`. No `TenantCustomRole` row is created anywhere in the repo outside a
jest mock.

**This one fails open.** `assignCustomRole` leaves `membership.role` untouched,
so a member given a NARROWING custom role still carries their original enum role
on the row. An inert resolution arm means they silently keep the broader
permissions — the feature inverts into a no-op for exactly the case it exists to
serve.

### The fixture is shaped against the mutation that survives everything

Three mutations produce the same fail-open:

| Mutant | What it does | Caught before this file |
|---|---|---|
| **A** | ternary → `getPermissionsForRole(membership.role)` | one substring in a text guard |
| **B** | ternary kept; pass base-role defaults instead of the stored blob | **nothing** |
| **C** | delete `include: { customRole: true }` | **nothing** |

B is the dangerous one: every substring assertion in
`enterprise-identity-epic.test.ts` still passes, because the ternary is
textually intact. It typechecks, because `parsePermissionsJson(json: unknown, …)`
accepts a `PermissionSet` quite happily.

So the fixture narrows **`evidence.upload`**, chosen because it is `true` for
the membership's enum role (ADMIN) *and* `true` for the custom role's base role
(EDITOR). Only the stored JSON can make it false — neither fallback can fake it,
so one assertion kills both A and B.

C needed a different answer. A mocked prisma returns whatever the fixture says
regardless of the `include`, so no amount of result-assertion notices the
relation going unhydrated. The query SHAPE is therefore asserted directly:
`findUnique` must be called with `include: { customRole: true }`.

## Files

| File | Role |
|---|---|
| `tests/unit/custom-role-resolution-enforced.test.ts` | New. Seven tests: narrowing actually narrows; the merge inherits unlisted permissions rather than blanking them; defaults come from the base role not the membership row; `ctx.role` reports the base role; the OWNER-only clamp holds through the real path; the `customRole` relation is requested; and a control proving members without a custom role still resolve from their enum role. |

## Decisions

- **`tests/unit`, not `tests/integration`.** `resolveTenantContext` makes
  exactly two prisma calls and nothing else — no `runInTenantContext`, no
  transaction, no encryption extension — so mocking `@/lib/prisma` leaves 100%
  of the resolution logic real. An integration test would sit behind the
  `DB_AVAILABLE ? describe : describe.skip` gate and silently report nothing on
  any machine without Postgres (the local DB is unreachable today), which would
  leave the gap open while reading green — strictly worse than the status quo,
  because it would look closed.

- **`@/lib/permissions` is deliberately NOT mocked.** `parsePermissionsJson` and
  `getPermissionsForRole` *are* the logic under test; stubbing them would make
  every assertion vacuous. Only prisma is faked.

- **The control test earns its place.** Without "a membership with no custom
  role resolves from its enum role", a mutation that always narrowed would read
  as a pass — and that mutation would break the overwhelming majority of members,
  who have no custom role at all.

- **The OWNER clamp is asserted through the real path.** The existing
  owner-escalation suite calls `parsePermissionsJson` directly, which proves the
  parser clamps but not that the clamp is reached. The blob here claims
  `tenant_lifecycle` and `owner_management` *and* a legitimate `manage: true`,
  so the test also pins that the clamp is targeted rather than a blanket
  rejection of the domain.

- **Audit path correction.** The audit names
  `src/app-layer/tenant-context.ts`; the file is `src/lib/tenant-context.ts`.
  The line number (120) and the claim were both accurate.
