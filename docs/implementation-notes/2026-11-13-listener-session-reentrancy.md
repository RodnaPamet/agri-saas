# 2026-11-13 — the listener session was not re-entrant, and only the process could show it

**Commit:** `eed2b0aaa fix(machines): serialise the listener session, and test the process that drives it`

## Design

#2948 stage 6 asked for three properties. Measured before writing anything, two
were already asserted and the third was done:

| claim | where |
|---|---|
| the sweep's denominator is printed | #3012's reading — `mode`, `expired`, `deleted`, `remaining`, `daysWithoutMarker`, every run |
| an unallowlisted IMEI writes nothing | `listener-session.test.ts` §2, seven cases, §1 as the control |
| a forged tenant is impossible | `machine-tracking-schema.test.ts` §1/§2 — RLS, and the composite FK |

So the gap was not a property. It was that **nothing had ever executed the
process that enforces them.** `scripts/machine-listener.ts` builds the lookup,
makes one `ListenerSession` per socket, and turns the session's actions into
side effects. It calls `main()` at module load, so it cannot be imported; it is
outside `tsconfig.json`; and no test referenced it. That is the shape CLAUDE.md
records for `worker.ts` and `scheduler.ts` — a mocked or unexecuted boundary
where a rename passes CI and surfaces as a process that will not start.

The new suite spawns it and speaks Codec 8 to it over TCP against the real
database. On its second run it failed, and the failure was real.

## The defect

```ts
if (!this.identity) {
    const handled = await this.handleHandshake(out);   // ← awaits the lookup
    if (!handled) return out;
}
```

`handleHandshake` sets `this.identity` and slices `this.buf` **after** awaiting
`lookup(imei)`. Two overlapping `feed` calls therefore both observe
`identity === null` with the IMEI still at the head of the buffer, and both run
the handshake.

The overlap is not hypothetical: an `on('data')` handler cannot be awaited, so
the script dispatches each event in its own async IIFE — which is correct — and
a device whose handshake and first frame arrive close together produces it.

Measured on the real process, 2 runs in 3: **two allowlist queries and two
`ACCEPT` bytes.**

### Why the second ACCEPT is the expensive half

After the handshake a Teltonika device expects one byte, then a four-byte
big-endian count of accepted records. Given `01 01 00 00 00 01` it reads
`01 00 00 00` as its ack — **16,777,216 records accepted** — and discards a
buffer it has not delivered. That is precisely the field-data loss the rate cap
refuses to cause by acking, arriving instead through a framing bug.

The duplicate query is the lesser half and still matters: it doubles database
work per connection on an unauthenticated port, which is what §2's "do not
query the allowlist for a malformed IMEI" exists to avoid.

## Files

| file | role |
|---|---|
| `src/lib/machines/listener-session.ts` | `feed` now chains onto a serialisation queue and delegates to `feedSerial`; the lock and its reasoning live here |
| `tests/unit/machines/listener-session.test.ts` | §2a — four cases forcing the overlap with a slow lookup; the reliable guard |
| `tests/integration/machine-listener-process.test.ts` | NEW — spawns the real process, five cases; the thing that FOUND it |
| `tests/helpers/codec8-frames.ts` | NEW — the frame builders, shared by both suites |

## Decisions

- **The lock is in the session, not the caller.** The invariant is that
  object's — its buffer and its identity — and a caller cannot be expected to
  know that an async method must not overlap. Serialising inside keeps every
  future caller safe and leaves the script's dispatch, which is correct, alone.

- **Each call still resolves with the actions for ITS OWN chunk.** Asserted,
  because a lock that handed the whole queue to whichever call finished first
  would put the ack on the wire before the ACCEPT, and the device would read
  the ack as its handshake answer.

- **The chain is kept on a swallowed copy.** Chaining on the live promise would
  let one rejected chunk poison every later feed on that connection — a dead
  socket rather than a refused chunk.

- **Two detectors, and they are not equally strong — measured.** §2a kills the
  mutation every run (3 of 4 cases). The process suite kills it in 2 runs of 5,
  because the overlap depends on how the kernel groups two writes into `data`
  events. Both numbers are in the process suite's docblock, so nobody reads its
  green as proof the serialisation is intact.

- **Byte-count driven, never timer driven.** The first version hung up 900 ms
  after writing and failed twice on a loaded machine with an incomplete buffer.
  TCP is a stream; the only deterministic wait is for a LENGTH. It is also six
  times faster.

- **`node --import tsx`, detached, killed by process GROUP.** `spawn('npx',
  ['tsx', …])` ends the wrapper and orphans the listener: thirteen runs left
  **54 live processes**, each holding a Postgres connection, with load average
  at 14 — and that starvation is what made the suite look flaky before the real
  defect was found. The leak was actively misleading about the thing the suite
  exists to measure.

- **The frame builders are shared.** Two builders are two definitions of a
  valid frame, and every negative in both files means "the listener refused a
  GOOD frame" — a claim that stops being true the moment they drift.

- **No port was opened.** Owner ruling the same day: the listener's inbound TCP
  port stays closed until there is a tracker to fit. So these properties were
  pinned while nothing is listening, which is the right order — the refusals
  are asserted before the surface is reachable.
