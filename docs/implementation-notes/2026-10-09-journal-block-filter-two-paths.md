# 2026-10-09 — filtering the journal by block had to reach the records nobody linked by hand

**Commit:** `e47051da7` fix(journal): a block filter must reach the spray records nobody linked by hand (#1545)

## The problem

`?locationId=` on the journal list returned only entries a person had linked to the block **explicitly**. Every automatically-written spray record was missing.

An entry reaches a block two ways:

1. `LogLocation` — explicit, hand-made.
2. `operationParcel → parcel → locationId` — implicit, and **where the bulk of a ДНЕВНИК lives**.

`_buildWhere` matched only (1). The `INPUT_APPLICATION` entry the spray flow writes (`inventory.ts`, the `createLogEntryWithAudit` call) passes `operationParcelId: line.id` and no `locationIds`; the phone's free-hand entries carry neither.

## Why this mattered more than a missing filter usually would

A ДНЕВНИК is a **regulatory record**, and an incomplete one reads exactly like a complete one. The farmer filters by block, sees their hand-linked notes, and nothing says the spray records on that block's parcels were excluded. No error, no empty state, no count that looks wrong.

Reported by the iOS session while building the phone's Дневник filters; all three of its claims verified in the code before acting on them.

## The tell, four lines away

`?crop=` already reached those same records through the same relation:

```ts
where.operationParcel = { is: { parcel: { is: { cropType: { in: filters.crop } } } } };
```

So **crop and block disagreed about which entries belong to a block** — the same spray record reachable by crop and unreachable by block. Two filters over one dataset giving answers that cannot both be right is the strongest signal available, and it was sitting in the same function.

## Design

```ts
where.AND = [{
    OR: [
        { locations: { some: { locationId: filters.locationId } } },
        { operationParcel: { is: { parcel: { is: { locationId: filters.locationId } } } } },
    ],
}];
```

## Decisions

- **`AND`, not `OR`.** `where.OR` is already taken by the `q` free-text search, so assigning `OR` here would discard the search and return the whole block — a filter that *widens* when you add a term to it.

- **Assigning `AND` is safe because the one other writer accumulates.** `listPaginated` appends its cursor predicate with `if (where.AND) { push } else { assign }`. That defensive shape is what keeps the clause on page two, and nothing was pinning it: had it ever become a plain assignment, page two of a block-filtered journal would silently have become page two of the **whole** journal. Found by going to check a comment I had written claiming nothing else set `AND`; now tested.

- **A free-hand entry with no link still matches no block**, and cannot — there is no path from it to one. Asserted, not incidental. The remedy is at write time (the phone sending `locationIds` when an operator picks a block), which `POST /journal` already accepts.

- **Tested against a real database, not only as a query shape.** The unit test pins the AND/OR structure, which is the right place for it, but it cannot tell whether Prisma accepts a two-hop `is` filter on a to-one relation nor whether the clause SELECTS the row. The integration test builds two blocks and four entries and asserts the exact id set; the negative control is the half that matters, since a filter returning everything satisfies every positive assertion.

- **The query contract was undocumented.** `GET /api/t/{tenantSlug}/journal` published only `tenantSlug` while eleven query parameters were live, so a client reading the spec saw a list endpoint with no way to filter it. All eleven are documented now, every one optional, so the contract change is additive.

## A note on the mutation proof

One mutation silently **failed to apply** — `where.AND = [` also appears in the cursor code, so the anchor was ambiguous — and the unmutated run reported "57 passed", which reads exactly like a surviving mutation. A mutation that does not apply and one that is not caught produce the same line. Mutation scripts here now assert their own replacement count.
