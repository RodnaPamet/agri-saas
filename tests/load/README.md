# Load tests (k6)

Closes GAP-11. The three scenarios in this directory exercise our
highest-traffic authenticated paths against documented SLOs.

> **Read [`docs/slos.md`](../../docs/slos.md) first** — that doc owns
> the performance targets. Each k6 metric here maps to one of the four
> SLOs defined there; the threshold tables below are the *load-test
> regression gates* (looser than the production SLOs by a calibrated
> margin) not the SLOs themselves. The "Load-Test Validation of SLOs"
> section in `docs/slos.md` is the canonical reference for: the
> scenario→SLO mapping, why the k6 thresholds are looser than
> production, and the operating procedure when a smoke or baseline
> fails.

## Scenarios

| File              | What it measures                                                            |
| ----------------- | --------------------------------------------------------------------------- |
| `auth.js`         | Cold-start NextAuth credentials login throughput + p95 latency.             |
| `lists.js`        | Steady-state authenticated list reads (controls / risks / evidence).        |
| `mutations.js`    | Authenticated mutations: control creation + multipart evidence upload.      |

- `auth.js` opens a fresh cookie jar per iteration so every iteration is
  a real cold login (csrf → callback/credentials → session).
- `lists.js` logs in once in `setup()` and shares the session cookie via
  the setup→default data channel, re-attaching it on every request, so
  we measure the list-read path and not the auth path again. **Do not
  "simplify" this to a per-VU login that trusts the jar — k6 resets the
  cookie jar between iterations while module state survives them, which
  is how this file spent its whole life 401-ing on every iteration
  after the first.**

`auth.js` and `lists.js` each run TWO scenarios sequentially — a 1-VU
`latency` regime that gates the p95 budgets, and a ramping `saturation`
regime that gates error rate and a throughput floor. See
[Two regimes](#two-regimes) below.
- `mutations.js` does a single global login in `setup()` and shares the
  session cookie across all VUs via the data channel; bcrypt is paid
  once, the iteration loop is purely write-path work. Every created
  row carries a `[loadtest-<runId>-vu<N>-it<M>]` tag prefix so cleanup
  is straightforward (see [Cleanup after local runs](#cleanup-after-local-runs)).

## Prerequisites

### Install k6

k6 is a Go binary, not an npm package. Pick one:

```bash
# macOS
brew install k6

# Debian / Ubuntu
sudo gpg -k && sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt update && sudo apt install k6

# No-install — static binary
curl -sSL https://github.com/grafana/k6/releases/download/v0.55.0/k6-v0.55.0-linux-amd64.tar.gz | tar xz
./k6-v0.55.0-linux-amd64/k6 version
```

CI installs k6 via `grafana/setup-k6-action` — see
`.github/workflows/load-test.yml`.

### Bring up a target server

The scripts default to `http://localhost:3006` (the port `npm start`
uses with the production build, matching Playwright's E2E config).

```bash
# Reset the DB to known seed state (4 controls, 4 risks, etc.)
npm run db:reset

# Start the server with the load-test escape hatches enabled.
# AUTH_TEST_MODE=1 disables the progressive lockout policy (3/5/10
# fail tiers) so bcrypt can stay the bottleneck.
# RATE_LIMIT_ENABLED=0 disables the API rate-limit middleware so
# endpoint latency reflects the auth + DB path, not the limiter.
AUTH_TEST_MODE=1 RATE_LIMIT_ENABLED=0 PORT=3006 npm start
```

Wait until `curl -fsS http://localhost:3006/api/health` returns 200.

## Running the baselines

The standard 50 / 100 / 200 VU runs:

```bash
# auth scenario
npm run load:auth:50
npm run load:auth:100
npm run load:auth:200

# list scenario
npm run load:lists:50
npm run load:lists:100
npm run load:lists:200

# mutation scenario
npm run load:mutations:50
npm run load:mutations:100
npm run load:mutations:200

# CI smoke profile (10 VUs, 30s — same shape PR CI runs)
npm run load:mutations:smoke

# quick sanity check (5 VUs, 30s, auth + lists)
npm run load:smoke
```

Or directly:

```bash
k6 run -e VUS=100 -e DURATION=2m tests/load/auth.js
k6 run -e VUS=100 -e DURATION=2m tests/load/lists.js
```

Override host or credentials:

```bash
k6 run \
  -e BASE_URL=https://staging.example.com \
  -e LOAD_TEST_EMAIL=loadtest@example.com \
  -e LOAD_TEST_PASSWORD='…' \
  -e LOAD_TEST_TENANT=loadtest-corp \
  -e VUS=200 -e DURATION=2m \
  tests/load/lists.js
```

## Two regimes

`auth.js` and `lists.js` each run two scenarios, **sequentially** — the
saturation one has a `startTime` past the end of the latency one, so
they never overlap:

| Regime       | Profile                  | Measures                       | Gates |
|--------------|--------------------------|--------------------------------|-------|
| `latency`    | 1 VU, no think-time      | service time — nothing queues  | the p95/p99 budgets |
| `saturation` | ramping VUs + think-time | capacity, behaviour under overload | error rate, check rate, throughput floor |

**Why:** a latency threshold on a saturated system measures the arrival
rate the script chose, not the code. `bcryptjs` is pure JS on the Node
main thread, so a login costs ~405ms of single-thread CPU and one
process tops out at ~2.4 logins/s no matter how many cores it has. The
nightly's 25 VUs offer ~25 logins/s — ~10x capacity — so p95 settles at
≈ VUs / capacity ≈ 10s however fast the login path is.

That is not hypothetical. `auth.js` asserted `p95 < 1500ms` across the
whole ramp and failed **40 consecutive nightly runs** with 100% of
checks passing and zero HTTP failures; CI measured p95 8.62s. The gate
was ~7x outside the implementation's physical capacity. Uncontended,
the same login measures p95 ~794ms.

Two rules follow:

1. **Tag every latency threshold `regime:latency`.** An untagged one
   spans both scenarios and re-creates the bug.
2. **Never gate latency on `regime:saturation`.** Gate throughput
   (a `count` over the fixed window) and error rate there instead.

Capacity floors are **collapse detectors, not precision gates** — two
back-to-back runs on one dev box returned 176 then 113 completed logins
purely because the host's load average climbed, so a tight floor would
just be a new flaky red. They sit at ~30% of the observed line;
precision lives in the summary artifact.

## Thresholds

A run **fails** (non-zero exit) if any of these are crossed.

### `auth.js`

| Metric                                | Budget          | Why                                         |
| ------------------------------------- | --------------- | ------------------------------------------- |
| `http_req_failed{step:csrf}`          | `rate < 1%`     | CSRF is a flat read; should never 5xx.      |
| `http_req_failed{step:login}`         | `rate < 1%`     | Login SLO ceiling.                          |
| `http_req_failed{step:session}`       | `rate < 1%`     | Session check must be reliable.             |
| `http_req_duration{regime:latency,step:csrf}`    | `p95 < 500ms`  | Flat read. Measured: 13.8ms.     |
| `http_req_duration{regime:latency,step:login}`   | `p95 < 1500ms` | Bcrypt bound. Measured: 794ms.   |
| `http_req_duration{regime:latency,step:login}`   | `p99 < 2500ms` | Tail of the uncontended login.   |
| `http_req_duration{regime:latency,step:session}` | `p95 < 500ms`  | JWT verify only. Measured: 21.8ms. |
| `auth_full_login_ms{regime:latency}`             | `p95 < 2000ms` | E2E login. Measured: 839ms.      |
| `auth_full_login_ms{regime:latency}`             | `p99 < 3000ms` | Tail of the full transaction.    |
| `auth_success_count{regime:saturation}`          | `count > floor`| Capacity collapse detector.      |
| `checks{check:csrf_ok}`               | `rate > 99%`    |                                             |
| `checks{check:login_ok}`              | `rate > 99%`    |                                             |
| `checks{check:session_ok}`            | `rate > 99%`    |                                             |

Every latency budget carries `regime:latency`. That tag is load-bearing
— see [Two regimes](#two-regimes).

### `mutations.js`

| Metric                                       | Budget          | Why                                  |
| -------------------------------------------- | --------------- | ------------------------------------ |
| `http_req_failed{op:create_control}`         | `rate < 2%`     | Mutation error budget.               |
| `http_req_failed{op:upload_evidence}`        | `rate < 2%`     |                                      |
| `http_req_duration{op:create_control}`       | `p95 < 1500ms`  | One INSERT + audit log.              |
| `http_req_duration{op:create_control}`       | `p99 < 3000ms`  |                                      |
| `http_req_duration{op:upload_evidence}`      | `p95 < 2000ms`  | File write + 2 INSERTs + audit.      |
| `http_req_duration{op:upload_evidence}`      | `p99 < 4000ms`  |                                      |
| `mutation_loop_ms`                           | `p95 < 3000ms`  | Full create+upload+sleep loop.       |
| `checks{check:control_created}`              | `rate > 98%`    |                                      |
| `checks{check:evidence_uploaded}`            | `rate > 98%`    |                                      |

Mutation thresholds are slightly looser than read thresholds because
RLS + audit + encryption add real variance, and the smoke profile
(10 VUs × 30s) yields ~200 samples per op — a single retry can move
the rate noticeably.

### `lists.js`

| Metric                                       | Budget          | Why                                  |
| -------------------------------------------- | --------------- | ------------------------------------ |
| `http_req_failed{type:list}`                 | `rate < 1%`     | Read-path error budget.              |
| `http_req_duration{regime:latency,endpoint:controls}` | `p95 < 800ms`  | Paginated list w/ auth + RLS. Measured: 94.6ms. |
| `http_req_duration{regime:latency,endpoint:controls}` | `p99 < 2000ms` |                             |
| `http_req_duration{regime:latency,endpoint:risks}`    | `p95 < 800ms`  | Measured: 68.3ms.           |
| `http_req_duration{regime:latency,endpoint:risks}`    | `p99 < 2000ms` |                             |
| `http_req_duration{regime:latency,endpoint:evidence}` | `p95 < 800ms`  | Measured: 49.0ms.           |
| `http_req_duration{regime:latency,endpoint:evidence}` | `p99 < 2000ms` |                             |
| `list_iterations{regime:saturation}`         | `count > floor` | Capacity collapse detector.         |
| `list_success_rate`                          | `rate > 99%`    | Aggregate.                           |
| `checks{check:controls_ok}`                  | `rate > 99%`    |                                      |
| `checks{check:risks_ok}`                     | `rate > 99%`    |                                      |
| `checks{check:evidence_ok}`                  | `rate > 99%`    |                                      |
| `http_req_failed{step:login}`                | `rate < 5%`     | Once-per-VU warm-up; 5% is generous. |

These are starting budgets calibrated for the seed dataset (~4 controls,
~4 risks). When running against a heavier seed or a populated tenant
expect the list p95 to drift up — re-baseline before tightening.

> **Dev server vs production build.** The thresholds are calibrated
> for `npm start` against a production build (the same shape CI runs).
> If you point the scripts at `npm run dev` you'll see p95 latency
> 5-10× higher because Next.js compiles each route on its first hit;
> that's a property of dev mode, not a regression. For a sanity-only
> smoke against the dev server, expect threshold breaches on
> `http_req_duration{*}` while every check still passes (200 OK,
> JSON shape valid). The error shape will look like:
> `error msg="thresholds on metrics 'http_req_duration{...}' have
> been crossed"` — that's the SUT, not the script.

## Cleanup after local runs

`mutations.js` writes real rows. Every one is tagged with
`[loadtest-<runId>-...]` in the title/name field so you can identify
and bulk-delete them.

In CI this is a non-issue — the postgres service container is
recreated per workflow run, so tagged rows never accumulate across
runs. For repeated local runs, either:

```bash
# Clean reset (also reseeds — slow but bullet-proof):
npm run db:reset

# Or surgical delete via raw SQL (skip Prisma's soft-delete middleware
# which would only set deletedAt):
psql "$DATABASE_URL" <<'SQL'
DELETE FROM "Evidence"   WHERE title LIKE '[loadtest-%';
DELETE FROM "Control"    WHERE name  LIKE '[loadtest-%';
DELETE FROM "FileRecord" WHERE "pathKey" LIKE '%loadtest-%';
SQL
```

`/controls/[id]` and `/evidence/[id]` don't expose HTTP DELETE
handlers (and `/purge` requires `deletedAt` first), so HTTP-only
cleanup isn't possible. The SQL above is the supported path.

## Result artifacts

Each run writes a JSON summary to `tests/load/results/`:

- `auth-summary.json`
- `lists-summary.json`
- `mutations-summary.json`

The directory is gitignored; the CI workflow uploads it as an artifact.

## Configuration knobs

| env / flag              | default                  | what it does                                     |
| ----------------------- | ------------------------ | ------------------------------------------------ |
| `BASE_URL`              | `http://localhost:3006`  | Target host.                                     |
| `LOAD_TEST_EMAIL`       | `admin@acme.com`         | Login email.                                     |
| `LOAD_TEST_PASSWORD`    | _(see `prisma/seed.ts`)_ | Login password — matches the seeded demo users.  |
| `LOAD_TEST_TENANT`      | `acme-corp`              | Tenant slug for `/api/t/<slug>/…`.               |
| `VUS`                   | `50`                     | Target concurrency.                              |
| `DURATION`              | `2m`                     | Steady-state duration.                           |
| `RAMP_UP`               | `30s`                    | 0 → VUS ramp.                                    |
| `RAMP_DOWN`             | `15s`                    | VUS → 0 ramp.                                    |
| `RUN_ID`                | `local-<timestamp>`      | Tag prefix on `mutations.js` rows for cleanup.   |

## Adding a new scenario

1. Drop `tests/load/<name>.js`. Reuse `lib/config.js` and `lib/auth.js`.
2. Define a single scenario in `options.scenarios` with `executor:
   'ramping-vus'` and the same stage shape (`rampUp`, `duration`,
   `rampDown`) so the suite stays consistent.
3. Add real thresholds. **No script ships without thresholds** — a
   "load test" with no pass/fail gates is just a benchmark, not a
   regression detector.
4. Add a `load:<name>` script to `package.json` mirroring the existing
   `load:auth` / `load:lists` entries.
5. Add it to the `scenario` choice list in
   `.github/workflows/load-test.yml`.

## Why these scenarios

GAP-11 called out `auth` and `lists` as the highest-leverage starting
points: every authenticated user hits both on every session. The auth
scenario gates regressions in the credentials path (most common
production load: thundering-herd login at the start of the workday).
The lists scenario gates regressions in the three highest-traffic
read endpoints.

The mutations scenario closes the second half of GAP-11 — control
creation and multipart evidence upload are the two write paths most
likely to introduce a latency cliff (RLS, audit trail, encryption,
storage). It runs at three scales (50/100/200 VUs) for full baselines
plus the **10 VUs × 30s smoke profile that PR CI executes on every
pull request** via the `Load Smoke (k6)` job in
`.github/workflows/ci.yml`. The smoke profile is sized to fit a PR
budget (~5 min job total) while still producing ~200 samples per op —
enough for p95 to be meaningful and catch obvious regressions before
merge without being flaky.

For the full SLO framing — which production SLO each k6 metric
validates, why the k6 budgets are deliberately looser than the
production p95 < 500ms target, what to do when a CI smoke or full
baseline breaches a threshold — see the **Load-Test Validation of
SLOs** section in [`docs/slos.md`](../../docs/slos.md).
