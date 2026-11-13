# 2026-11-13 — the leaving-the-area alert (#2948 stage 5)

The last of #2948's six stages, and the first one a farmer notices without
going looking: the live map and the day history are screens you open, and this
arrives.

## The four parameters

| | | |
|---|---|---|
| the area | **union of 2 km buffers per parcel** | owner ruling 2026-11-13 |
| recipients | **OWNER + ADMIN** | §7 |
| cadence | **one push per EVENT** | owner ruling |
| night window | **dropped** | owner ruling |

The area was the open one. §7 proposed the convex hull of the farm's parcels
buffered 500 m. Put to the owner with the trade both ways, and the ruling
replaced it: a hull over blocks 50 km apart swallows every town and road
between them, so a machine taken to a dealership might never count as away —
and an alert that cannot fire is worse than one that fires on a journey
somebody recognises.

**The accepted cost is the mirror image:** a tractor driving between two
distant blocks of the same farm IS outside and will alert. The copy has to
survive that — a farmer seeing «„Трактор 3“ излезе от района на стопанството»
while driving their own tractor between their own blocks must not conclude the
alert is broken.

## Design

```
every 5 min:  machines with a fix in the last 30 min   (positions, not trackers)
              → verdict per machine: outside the union of 2 km parcel buffers?
              → compare with MachineAreaState.outside
              → on false → true: enqueue push-send per OWNER/ADMIN
```

## Decisions

- **One push per event needs a stored verdict, not a time window.** A
  departure is a boundary CROSSING, so the job compares against
  `MachineAreaState`. §7's alternative — "at most one per machine per rule per
  30 min" — is a different rule: it keeps notifying for as long as a machine
  sits at a dealership, which is what the ruling moved away from.

- **Returning is silent.** A farm is told when a machine leaves, not when it
  comes back: the second is not a risk, and the first loses its force if it
  arrives in a pair. The verdict still flips, so leaving again is a new event
  — asserted, because "staying outside is silent" must come from the verdict
  being unchanged rather than from a machine being alerted at most once ever.

- **A farm with no mapped parcels is SKIPPED, not alerted.** `ST_Union` over
  zero rows is NULL and `NOT ST_Contains(NULL, p)` is NULL, so the verdict is
  null and the machine is skipped. A `COALESCE(…, true)` written for tidiness
  would turn "this farm has no area" into "every machine has left" — one push
  per machine per run, at the farm least equipped to understand why.
  `skippedNoArea` on the reading counts those farms, which is a product fact
  invisible without it.

- **A machine already outside at its FIRST verdict counts as a departure.** A
  farm fitting a tracker to a machine that is away wants to know it is away;
  treating an absent prior row as "inside" would stay silent on exactly the
  case somebody fitted the tracker to find.

- **A stale fix is not a verdict.** 30 minutes — sixty missed reports at a
  30 s cadence — so a machine switched off in a shed last week stops producing
  verdicts from its final fix. Skipped, not assumed inside.

- **Idempotent on `evaluatedAt`.** The stored verdict carries the `recordedAt`
  of the fix it came from, so a job that wakes twice before the tracker
  reports again reaches the same conclusion from the same evidence and sends
  nothing.

- **MECHANISATOR is excluded**, and §7's reason is the whole argument: "a
  MECHANISATOR receiving 'a machine is moving at night' would be an alert
  about themselves". The operator persona is this alert's subject, never its
  audience. EDITOR is simply not an audience.

- **It enqueues `push-send` rather than sending.** One enqueue reaches both
  transports and goes through `resolveDelivery`, where the quiet-hours
  decision belongs (#1994). A job calling `sendWebPushToUser` itself would
  reach browsers only — the mistake `weather-pull` had made with the most
  time-sensitive notification in the product.

- **SIMULATED positions are INCLUDED here**, unlike the derivation. A
  `WorkedParcel` row feeds the ДНЕВНИК draft, and the owner's rule is that
  simulated work must never reach it; an alert is not the register, and on a
  demo farm a simulated departure SHOULD raise one. The asymmetry between two
  queries in the same file is written down in both, because it is exactly the
  kind of thing a later reader "fixes".

- **`attempts: 1`**, unlike the derivation's 3. The push is enqueued inside
  the per-asset loop, so an attempt that failed after enqueueing some pushes
  would re-evaluate machines it had already alerted. The stored verdict
  absorbs most of that, but the window between the enqueue and the state write
  is real, and a duplicate "your machine left" is the kind of alert people
  turn off.

## The bug the suite caught

`translateFor` is async. The first version did not await it, so every push
body would have shipped as the literal string `"[object Promise]"` — the
enqueue succeeds, the job reports success, and the farmer gets a notification
whose text is a type name. Nothing else would have noticed: the body assertion
is the only thing that looks at it.
