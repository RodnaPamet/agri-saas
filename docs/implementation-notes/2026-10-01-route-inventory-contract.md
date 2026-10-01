# 2026-10-01 — the API route surface as a client contract

**Commit:** `<pending> feat(api): a path cannot leave this surface silently`

## Design

#1087 renamed five satellite-tile routes. The rename was right: it moved a
location id out of a query string, which CFNetwork writes to the iOS unified
log below anything an app can suppress, so the id was already in a
device-local log and no amount of client care could fix it. It shipped without
a compatibility shim, deliberately — "two routes doing one thing is how they
drift, and the app is pre-release so a coordinated change costs a version bump
rather than users".

The coordinated change never happened. The native client kept building
`/agro/<index>-tiles?locationId=<id>`, every request 404'd, `AgroAPI.tiles`
threw, `SatelliteIndexStore` set `tiles = nil`, and `syncTiles` mounted no
overlay. Apple's photography and the parcel outlines rendered fine, so the map
looked working-but-empty. Four days later the owner noticed on a phone.

Both test suites were green for all four days, and that is the structural
point: **a route rename is invisible to a repo that only checks its own
callers.** Nothing in agri-saas knows what the iOS app requests, and nothing
in the iOS app runs in agri-saas CI.

Two halves, in two repos:

```
agri-saas (this)                        agrent-ios#132
  emits route-inventory.json  ───────▶  reads it; every path the app
  fails when a path LEAVES it           builds must exist in it
  (fires on the diff that                (fires on the diff that
   causes the break)                      starts calling a dead path)
```

Neither subsumes the other. A client-side check cannot fail on the agri-saas
PR that removes the route; a server-side check cannot know which paths a client
calls. `tests/guards/public-routes-self-authenticate.test.ts` already makes
this argument for its own two directions — "either half alone is worse than
neither".

## Files

| File | Role |
|---|---|
| `scripts/lib/api-routes.ts` | **new** — the route derivation, held once: walk, floor, `[x]`→`{x}` mapping. Extracted from `openapi-paths-complete.test.ts`, which now imports it |
| `scripts/generate-route-inventory.ts` | **new** — emits the ledger. Adds and resurrects; never retires |
| `src/generated/route-inventory.json` | **new** — 368 entries, 129 documented / 239 not, 0 retired |
| `tests/guards/route-inventory-ledger.test.ts` | **new** — fails when a live path leaves the filesystem |
| `tests/guards/openapi-paths-complete.test.ts` | imports the shared derivation; local copies deleted |
| `package.json` | `routes:inventory` |
| `CLAUDE.md` | the contract |

## Decisions

- **Append-only, and the generator cannot retire.** A regenerated list makes a
  removal cost what an addition costs, which is the defect the file exists to
  prevent — the same shape as `fonts:vendor` writing files and hashes in one
  step. A vanished path stays `live`, the guard fails, and a human writes down
  what replaced it. That sentence in the diff is the deliverable.
- **A derived inventory, not the spec.** Measured before choosing: `openapi.json`
  is 1.29 MB across 39 commits in 30 days (~1 every 18h), but only **18** of
  those changed the path set, and **every single change was purely additive —
  zero path removals in the file's entire history**. A client vendoring the spec
  would carry daily megabyte churn for a handful of strings; additions cannot
  break it; only a rename can, which is rare and is exactly what the guard
  catches. So the artifact is the path list alone.
- **Snapshot over live fetch, for the client.** A client fetching main's spec in
  CI couples its build to this repo's merge queue: a merge here reddens an
  unrelated PR there and the failure is attributed to the wrong diff. That is
  how a guard gets switched off.
- **`documented` is a third outcome, not a boolean verdict.** 239 of 368 routes
  exist and are undocumented. A client checking the spec alone would call
  `/api/auth/token` and most of the admin surface nonexistent. `documented:
  false` says "the route is real and its shape is described nowhere", which is
  the honest answer and also a shrinking to-do list.
- **The comparison is a pure function over two arrays.** `auditInventory(onDisk,
  routes)` takes lists, not a reader. Making a collector testable by injecting
  a reader creates a NEW untested collector — measured twice in #1170 and
  #1172, where `readFromDisk` came back as a fresh survivor because every
  control passed its own reader. Arrays avoid the seam entirely.
- **Four outcomes, each named once.** The first draft partitioned on `live`, so
  a retired path that reappeared was reported as BOTH `staleRetired` and
  `missingFromInventory` — and the second message told the reader to
  regenerate, which was the wrong fix. `missingFromInventory` now means "not
  recorded at all".
- **The round-trip control does not assert files exist.** "Every live entry maps
  to a real file" is also false during a genuine removal, so it would raise a
  second alarm for the situation `vanished` already names. It asserts the
  path↔file mapping round-trips instead, which is the failure it is actually
  for: both sides derived from the same wrong function would agree perfectly.
- **End-to-end proof, not only synthetic.** Moving the real `ndvi-tiles` route
  aside produces 1 failed / 8 passed, naming that path. The synthetic controls
  prove the function; this proves the wiring.
