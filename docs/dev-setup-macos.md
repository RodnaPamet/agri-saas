# Local development on macOS (Apple silicon)

Verified 2026-09-09 against `origin/main`. The Linux path is covered by
`README.md` and `docs/ci-local.md`; this page exists because five things behave
differently on a Mac, and four of them fail in ways that do not name their cause.

For the iOS device work itself, see **`docs/runbooks/offline-device-probes.md`** —
it is the authority on the probes, and this page deliberately does not restate it.

---

## The five that bite

### 1. Node 22, and only 22

`.nvmrc` pins `22`; `package.json` declares `>=22.0.0 <23.0.0`; `.npmrc` sets
`engine-strict=true`. That last one turns a version mismatch into a hard `npm ci`
failure rather than a warning, so Homebrew's current Node will stop the install
outright.

```bash
nvm install 22 && nvm use 22    # or: fnm use 22
node --version                   # must report v22.x
```

### 2. `brew install pcre2` — before your first commit

`scripts/detect-secrets.sh` runs in the pre-commit hook and needs PCRE, because
its patterns use an inline `(?i)`. It takes `grep -nP`, else `pcre2grep`, else it
**exits 2 deliberately** — a secret scanner that silently degrades to a weaker
pattern set is worse than one that stops.

macOS ships BSD grep, which has no `-P`. Without pcre2 every commit fails, and
the message names PCRE rather than the hook, so it is easy to misread as a
problem with the commit.

```bash
brew install pcre2
```

### 3. Docker images that have no arm64 build

Two images in the stack are amd64-only, and no compose file declares a
`platform:`, so Docker resolves them per-host:

| image | used by | arm64? |
|---|---|---|
| `postgis/postgis:16-3.4` | `deploy/postgres/Dockerfile` | **no** — single amd64 manifest |
| `clamav/clamav:1.4` | `docker-compose.test.yml` | **no** |

Enable Rosetta in Docker Desktop (Settings → General → *Use Rosetta for x86/amd64
emulation*) or use OrbStack, which does it by default.

For ordinary development you can avoid ClamAV entirely: leave `CLAMAV_HOST`
unset and the scan path short-circuits. Only `npm run db:test:up` waits on the
`clamav-test` container.

### 4. `npm ci`, never `npm i`, never `--ignore-scripts`

`postinstall` runs `patch-package`, which applies `patches/next+<version>.patch`.
That patch is the CSP nonce fix for Next's component scripts; skipping it
produces a build that looks fine and ships unnonced scripts.

### 5. Debian bullseye's expired Release file

`deploy/postgres/Dockerfile` builds on a bullseye-based image whose security
`Release` file expired 2026-09-07, so a plain `apt-get update` exits 100 and
the build fails. **No local workaround is needed any more** — the Dockerfile
carries `apt-get -o Acquire::Check-Valid-Until=false update`, as do the CI
action and `infra/scripts/restore-test-gcp.sh`. (An earlier revision of this
page told you to add the flag by hand, because #833 patched only the CI
action; that gap is closed.)

The flag is a labelled stopgap, not a fix, and it is **not** ready to remove:
`postgis/postgis` publishes no Debian tag on a maintained suite for Postgres
16 — upstream's `16-3.5` is `FROM docker.io/postgres:16-bullseye` and
reproduces the same failure. Tracked as **#832**; the argument is written out
at the top of `.github/actions/enable-pgvector/action.yml`.

---

## Setup, in order

```bash
xcode-select --install
brew install pcre2
nvm use 22

git clone https://github.com/RodnaPamet/agri-saas.git && cd agri-saas
npm ci

cp .env.example .env          # then fill the keys marked below
docker compose up -d postgres pgbouncer redis

npm run db:generate
npm run db:reset              # migrates AND seeds — do not run db:seed after it
npm run dev                   # http://localhost:3000
```

`npm run db:reset` is `prisma migrate reset --force && tsx prisma/seed.ts`.
Running `npm run db:seed` afterwards seeds a second time.

### Keys `.env.example` does not fill for you

- `STORAGE_PROVIDER=local` — now in the template, but worth knowing why: the
  schema defaults to `s3` (`src/env.ts:151`), so a checkout that omits it takes
  the S3 path and uploads fail with a 500 rather than a configuration error.
- `NEXT_PUBLIC_MAPTILER_KEY` — the template carries it commented out. Without
  it the map falls back to demo tiles.

### Ports

| service | port | notes |
|---|---|---|
| Postgres via pgbouncer | 5433 | what the app connects to |
| Postgres direct | 5434 | migrations only — pgbouncer's transaction pooling breaks DDL |
| Postgres test | 5435 | `docker-compose.test.yml` |
| Redis | 6379 | |
| Redis test | 6380 | |

The test database is on **5435** and named **`agri_saas_test`**, both on purpose.
A sibling `inflect-compliance` stack holds 5434, and distinct database names
alone were not enough to keep the two apart — the port has to differ too. See the
comment at `docker-compose.test.yml:26`.

### Memory ceilings

`tsc`, `next build` and `jest` all exceed Node's default heap on this codebase:

```bash
NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck
```

CI applies the flag directly to the `tsc` process rather than through
`NODE_OPTIONS`, because it does not reliably reach it.

---

## Running the tests

```bash
npx jest tests/guards tests/guardrails     # fast, no services needed
npm run db:test:up                          # test DB (waits on clamav-test)
npm run e2e:local                           # installs Playwright itself
```

`tests/guards` and `tests/guardrails` are **different directories**. Running one
is not running the sweep — several structural ratchets live only in the second.

For E2E, `cp .env.e2e.example .env.e2e`. The example's database URL matches
`docker-compose.test.yml`; a guard keeps the two in step, because they disagreed
for long enough that the script's own fallback inherited the wrong values.

---

## Known-stale documentation

`README.md` still describes the project under its former name and org. The repo
moved to `RodnaPamet/agri-saas`; `CLAUDE.md` is the current source of truth for
architecture and conventions.
