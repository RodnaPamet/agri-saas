# 2026-11-13 — the nightly worked-parcel derivation, and its run marker

**Issues:** #2948 stage 4, #2984. Stages 1–3 (schema, listener, reads) are
already on main; this is the derivation that fills `WorkedParcel`, plus the
marker that makes "it ran and found nothing" expressible.

## Design

The matching runs in SQL, as #2948 §8 settles: positions → `ST_MakeLine`
ordered by `recordedAt` → `ST_Intersects` against `Parcel.geometry` → lengths
through **EPSG:32635**. The alternative is pulling ~2,900 points per machine
per day into node.

One statement, read inside-out: `filtered` (positions that could be work at
all) → `hits` (those inside some parcel) → `marked`/`runs` (a gap longer than
10 minutes starts a new run) → `per_run` → `kept` (runs of at least 5
minutes). Minutes are summed per RUN and then across runs, so a machine that
left the field and came back is not credited with the hour in between.

## Decisions

- **SIMULATED positions are excluded**, and this is the one decision here that
  is a rule rather than a tuning choice. `MachinePositionSource`'s own
  docblock states it: "marking only the asset leaves rows that outlive a
  reconfiguration still claiming to be real. The thing that must never happen
  is simulated work reaching a real farm's ДНЕВНИК, even as a «Нов запис»
  draft." A `WorkedParcel` row is what fills that draft and carries no
  provenance — `derivedFrom` records the MATCHER, not where the positions came
  from — so a farm that tried the simulator once would otherwise find a
  simulated afternoon in its register offering to be filed. It is an
  ALLOWLIST (`IN ('TRACKER','TELEMATICS')`), so a sixth source is excluded
  until somebody decides it belongs.

  The cost, stated rather than discovered later: a demo farm's worked-parcels
  screen stays empty with a marker saying the derivation ran. Fixing that
  needs a provenance column on `WorkedParcel` so the draft can refuse the row,
  which is a schema decision rather than a filter.

- **The marker is written in the job's transaction, and written even when
  nothing matched.** That second half is the whole of #2984: `derivedAt` used
  to be reduced out of the `WorkedParcel` rows, and an idle day has none, so
  the read answered `null` — which the phone renders as «изчисляват се през
  нощта», for ever, with no error and no metric. One transaction per (asset,
  day) rather than per tenant: a farm with forty machines would otherwise hold
  one transaction across forty PostGIS scans, and one bad geometry would roll
  back the other thirty-nine.

- **`areaHa` stays NULL.** Area worked is the track length times the
  implement's working width, and nothing in this product knows that width.
  The column's own comment says why a guess is not acceptable: "a derived area
  presented as a measurement is a number somebody will put in a subsidy
  return."

- **`confidence` is the share of matched points inside the parcel shrunk by
  20 m**, so a road hugging a field edge scores near zero and a machine
  working the field scores near one. It is NULL rather than 0 when nothing
  could be measured, because zero asserts "measured, and badly" — a different
  claim from "no basis to judge".

- **Retries are allowed (`attempts: 3`)**, which is the opposite of the two
  jobs either side of it in `JOB_DEFAULTS`: `statement-dispatch` uses 1
  because a retry re-SENDS and `notice-score` because a retry re-SPENDS. This
  writes through unique indexes, so a second attempt updates the same rows.

- **The day boundary is computed in Europe/Sofia, in SQL.** A UTC boundary
  splits a night shift across two days. `positionsConsidered` is counted in JS
  from the `+02:00` offset, which is a SECOND spelling and an hour off during
  summer time — recorded in the code as a reading rather than a threshold,
  since no row is created or withheld on it.

## Two mistakes worth keeping

**Backticks inside a template literal.** The SQL lives in a JS template
literal, and a comment I wrote inside it contained `` `!= 'SIMULATED'` `` —
which closed the string and turned the next token into a tagged-template call.
Every test failed with `"SIMULATED" is not a function`. Same family as the
restore drill's heredoc, where markdown backticks in a comment became command
substitutions.

**A branch's uncommitted schema followed me.** The `MachineWorkedDay` model
and its migration were written here, then travelled with me to the #2989
branch, where a `git add -A` committed them into a PR under review. The tell
was a PR carrying a migration for a table nothing in its diff mentioned.
Reverted there, restored here.
