# 2026-09-01 — the offline-map toast told the truth about nothing (#780)

**Commit:** `<pending>` fix(map): count tiles that actually cached

## Design

`DownloadBasemapButton` walks the tile list and counted a tile as packed with:

```ts
// 200 = a real tile cached; 204 = ocean/no-coverage (fine).
if (res.ok || res.status === 204) ok += 1;
```

The comment was true when written. The proxy has since grown a **second** 204:

| 204 source | meaning |
|---|---|
| `catch` around the upstream `fetch` | the upstream is **unreachable** — a failure |
| upstream returned 204/404 | genuinely **no tile here** (ocean, out of coverage) — correct |

Both are `204` and they mean opposite things, so an outage produced a clean
sweep of 204s, `ok === tiles.length`, and **"Offline map ready"** over a pack
holding nothing. The operator discovers it after driving out of signal — the
exact moment the feature exists to prevent.

The fix makes the two distinguishable at the source (`X-Basemap-Source` on
both 204 paths, matching the header the 200 path already carried) and counts
three separate things in the client: `stored`, `absent`, `lost`.

## Files

| file | role |
|---|---|
| `…/basemap/[z]/[x]/[y]/route.ts` | both 204 paths now carry provenance; stale docblock corrected |
| `DownloadBasemapButton.tsx` | counts bytes, not statuses; third outcome for a partial pack |
| `messages/{en,bg}.json` | `locations.detail.offlineMapPartial` |
| `tests/rendered/basemap-download-honesty.test.tsx` | 5 cases, mutation-proved |
| `CLAUDE.md` | carried the defect as current behaviour |

## Decisions

- **Read `Content-Length`, never the body.** The obvious check — read the
  bytes and see if there are any — races the service worker, which caches
  `res.clone()` as the response goes past. `tileResponse` sets
  `Content-Length` on every 200, so the size is knowable without touching the
  stream. Simpler *and* safer than the clone dance, which was the first design
  considered.

  (Scoped honestly: this is safe on the SW's MISS path, which `put`s before
  returning. The HIT path clones after returning inside a `.then()` with a
  swallowing `.catch` — a pre-existing race this change neither introduces nor
  fixes.)

- **Reject a 0-byte 200 too.** Beyond the reported bug, and cheap. A 200
  carrying nothing satisfies `res.ok` while caching an empty body — the same
  "0-byte 200" shape `basemap-fixture-tile.ts` documents, arriving from the
  network rather than a fixture.

- **A legitimately empty upstream is a COMPLETE pack, not a failure.** This is
  why the fix reads the provenance header instead of simply rejecting every
  204. "Reject all 204s" would pass both regression tests while reporting
  failure over a perfectly good ocean-edge pack — a green fix that breaks a
  working case. There is a positive-control test for exactly this.

- **A partial pack warns and does NOT set `status: 'done'`.** Labelling the
  button "Offline map ready" over an admittedly incomplete pack is a milder
  instance of the same over-claim. Leaving it on the download affordance is
  also what lets the operator retry.

- **`absent` is counted but never surfaced.** A tile that legitimately does not
  exist is not something an operator can act on, and a message about it would
  be noise dressed as detail.

- **Plain-object stubs in the test, not `new Response(...)`.** The jsdom
  project ships no `Response` and no `fetch`. `new Response(...)` throws a
  ReferenceError inside the mock, the component's `catch {}` swallows it, and
  the run looks like a total failure — which on the UNFIXED code produces the
  same `toast.error` the fixed code produces. The regression tests would have
  passed against the bug. Caught in review before it was written, not after.

- **Mutation-proved.** Restoring `if (res.ok || res.status === 204)` fails
  exactly three of five: the unreachable sweep, the 0-byte 200, and the
  partial pack. The two positive controls pass either way, which is the point
  of having them.

## The family this belongs to

Third instance of one shape, not three unrelated bugs:

- `pending` that will never send (#763)
- "synced" over an evicted queue (#744)
- "downloaded" over zero tiles (this)

Each is a UI reassuring an operator without evidence, and each is only
discoverable in the field, with no signal, when it is too late to act.
