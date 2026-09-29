# 2026-09-29 — a database probe that did not finish is UNKNOWN, not absent

**Commit:** `<pending> test(integration): a db probe that did not finish is unknown, not absent`

## Design

`tests/integration/db-helper.ts` decides, once at module load, whether the
entire integration tier runs. Every suite under `tests/integration/**` is
gated `DB_AVAILABLE ? describe : describe.skip`, so that one boolean is the
on/off switch for the layer. It was computed like this:

```ts
const result = spawnSync('node', [probeScript], { timeout: 30_000, env: { DATABASE_URL: url } });
return result.status === 0;
```

**`spawnSync` sets `status: null` on a timeout.** So a probe that merely did
not finish in 30 seconds returned `false`, and in this codebase `false` means
*there is no database*. Every integration suite skipped, and the run reported
green — CLAUDE.md's first-named hazard, "a skipped suite is indistinguishable
from a passing one", entered through the flag that hazard's own gate reads.

The shape is what makes it serious. The probe is a `spawnSync` of a Node
process that connects to Postgres; it gets slower exactly when the machine is
loaded, which is when CI runs six jest shards in parallel. So integration
coverage thinned under load and was intact when idle — the inverse of what a
useful signal does, and invisible because the outcome is a *pass*.

Measured while chasing something else: under a mutation sweep holding the box
at load ~12, the 30s probe timed out and a newly-written integration suite
reported `1 skipped`. Asked directly, the database connected in 1.1s.

The probe now answers with three outcomes instead of a boolean:

| outcome | meaning | consequence |
|---|---|---|
| `'ok'` | connected, ran `SELECT 1` | suites run |
| `'refused'` | the probe **finished** and could not connect | suites skip — correct |
| `'unknown'` | timed out, signalled, or would not spawn | retry at 90s, then banner |

**Only exit 1 counts as `'refused'`**, because exit 1 is the probe script's own
`.catch`. Any other non-zero status — a Node crash, an OOM exit, a
module-resolution failure — is the probe breaking, and scoring that as absence
is how a broken probe silently disables a whole tier. `classifyProbe` returns
`'unknown'` for all of them.

`'unknown'` is not silent: it retries once with a 90s budget, then prints a
banner that names which of the two situations it is in, and
`INTEGRATION_REQUIRE_DB=1` promotes either non-`ok` outcome to a hard failure.
That mirrors `RLS_GUARDRAIL_REQUIRE_DB=1` exactly, and is set in CI for the
same reason: the `test` job declares a Postgres service and runs
`prisma migrate deploy` against it, so a skip there means the service is
broken, not that a developer lacks a local database.

## Files

| File | Role |
|---|---|
| `tests/integration/db-probe.ts` | **new** — `DbProbeOutcome` + `classifyProbe`, in its own module so a test can import it without triggering the load-time probe |
| `tests/integration/db-helper.ts` | `checkDbAvailable` → `probeOnce`/`probeDb`; retry at 90s, banner, `INTEGRATION_REQUIRE_DB` escalation; exports `DB_PROBE` alongside `DB_AVAILABLE` |
| `tests/unit/db-probe-classification.test.ts` | **new** — seven pure tests over the classifier, including the timeout case the old code got wrong |
| `.github/workflows/ci.yml` | `INTEGRATION_REQUIRE_DB: "1"` on the `test` job |
| `.github/workflows/coverage-reference.yml` | the same, because `coverage-parity-env-match` requires the two `env:` blocks to match |
| `CLAUDE.md` | records that `DB_AVAILABLE` itself was the hazard, and the three-outcome replacement |

## Decisions

- **The classifier lives in a separate module from the probe.** A test that
  imported `db-helper` to reach the classifier would execute `probeDb(dbUrl)`
  at module load and pay the 30s+90s it exists to avoid. Worse, a test that
  *spawned* to observe a timeout would be subject to the same load it is
  testing for: flaky exactly in the conditions that matter and green in the
  ones that do not. The classification is a pure function, so the test is pure.
  This was caught on the first draft, which did import `db-helper`.
- **`DB_AVAILABLE` is kept, as `DB_PROBE === 'ok'`.** Roughly fifty suites read
  it; widening the signal did not need to be a fifty-file rename. `DB_PROBE` is
  exported alongside for anything that needs to tell the two non-`ok` cases
  apart.
- **`'unknown'` still skips by default, and that is deliberate.** A developer
  without a local Postgres must be able to run the sweep — that is the reason
  the gate exists at all. What changed is that not-running is now *visible*
  (banner) and *escalatable* (`INTEGRATION_REQUIRE_DB=1`) instead of being
  reported as an unremarkable pass. Making `'unknown'` fail everywhere would
  trade a silent false-green for a loud false-red on every laptop.
- **The retry is 90s, not a longer first budget.** Raising the single timeout
  to 90s would cost 90s on every run where there genuinely is no database —
  the common case for a developer. Retrying only the ambiguous outcome keeps
  the fast path fast and spends the extra time only when the answer is
  uncertain.
- **Both workflow files, one diff.** `tests/guards/coverage-parity-env-match.test.ts`
  derives both sides from the live YAML and fails if the `test` job's `env:`
  and `services:` diverge from `coverage-reference.yml`'s, because the parity
  proof is only meaningful if the two runs cover the same population. Adding
  the var to `ci.yml` alone would have reddened that guard.
