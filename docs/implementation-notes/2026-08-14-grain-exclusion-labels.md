# 2026-08-14 — Excluded records get names, not cuids

**Commit:** (pending — see PR)

Third of a four-prompt roadmap.

## The defect

```ts
function describeEntry(entry: ExclusionEntry): string {
    if (typeof entry === 'string') return entry;
    if ('lotId' in entry) return entry.unitKey ? `${entry.lotId} (${entry.unitKey})` : entry.lotId;
    return `${entry.leaseId} — ${entry.reason}`;
}
```

rendered into a `font-mono text-xs` list. Open "3 plantings missing a yield
estimate" and you got three cuids — `cmslvwqsj0000j44se0pwtxns`. No parcel, no
crop, nothing a person can recognise. The COUNT was honest; the DETAIL was
unusable, which made the accordion decoration.

## No new query — not even the batched one the brief allowed

The brief permitted "gather the ids, then ONE findMany per entity type". That
turned out to be unnecessary: `getGrainNetWorth` already reads every planting,
lot, unit, lease and cost entry for the arithmetic. The names came from widening
six columns on selects that already run —

    planting   + parcel.name, cropPlan.cropType.name
    lease      + lessorName, parcel.name
    costEntry  + supplier, description, incurredOn

— and a single labelling pass over rows already in memory. **Zero reads added**,
verified by grepping the diff, so D1 cannot fire and there is nothing for D2 to
bound.

## One entry shape

Three shapes became one. `{ id, label }` for every class: the id because the
deep links from the previous prompt need it, the label because that is what a
person reads. `describeEntry` collapsed from a structural branch to
`entry.label`, and `font-mono` went with it — monospace signals "machine
identifier", which these have stopped being.

The compute functions still push bare ids. Threading lookup maps through five of
them to save one pass would have been a worse trade than the pass, so the raw
shape stayed internal (`RawExclusions`) and the published contract carries
labels.

## Files

| file | role |
|---|---|
| `src/lib/grain/exclusion-labels.ts` | the resolvers, pure |
| `src/app-layer/usecases/grain-net-worth.ts` | widened selects, one labelling pass, `RawExclusions` split from the public type |
| `…/grain/calculator/CalculatorClient.tsx` | one entry type |
| `…/grain/calculator/components.tsx` | `describeEntry` reads a field; no `font-mono` |

## Decisions

- **`|| id`, not `?? id`.** An unresolved name produces an EMPTY STRING, not
  null — `join()` of two absent parts is `''`. Nullish coalescing would let a
  blank bullet through, and a bullet with nothing in it is worse than one with a
  cuid: the reader cannot even tell how many records are involved.

- **The unit stays on an unresolved lot.** `lot-orphan (bag)` rather than
  `lot-orphan`. The id is useless to a person but the unit is not — it is the
  thing they would go and change.

- **`join()` skips absent parts.** A lease with a lessor and no parcel reads
  `Мария Георгиева`, not `Мария Георгиева · ` — a dangling separator reads as a
  bug in the software rather than a gap in the data.

- **`commoditiesWithNoPrice` keeps the slug as its label.** Commodity names are
  the one thing here the CLIENT can translate, and it already does everywhere
  else on this page. Every other label is data and is not translatable.

- **The lease `reason` was dropped from the label.** It was server-authored
  English (`'rent unit not recognised'`), and the class name above it already
  says "leases whose rent could not be read". Putting untranslated prose inside
  a record's name would have re-introduced, at a smaller scale, the problem the
  reason-code work removed.
