# 2026-09-10 — the PostGIS pin gets one owner, and #832 gets a corrected premise

**Commit:** `<sha> fix(ci): give the PostGIS pin one owner, and un-break the two apt sites #833 missed`

Issue #832 asked for a migration off the expired Debian base. **The migration
is not available today**, and that is the main finding: no tag change fixes it.
What this change ships instead is the drift guard the seven-site edit would
have needed anyway, plus the two live breakages #833 left behind.

## The image question, answered with evidence

`postgis/postgis:16-3.4` is Debian bullseye, whose security `Release` file
froze at `Valid-Until: Mon, 07 Sep 2026 21:13:04 UTC`. Past that instant
`apt-get update` exits 100. The obvious move is a newer tag. Measured
2026-09-10, against Docker Hub and the upstream `postgis/docker-postgis`
repo:

| candidate | base OS | PG major | pgvector for PG16? | verdict |
|---|---|---|---|---|
| `16-3.4` (current) | Debian 11 bullseye | 16 | yes, from PGDG | frozen index — the problem |
| `16-3.5` | **Debian 11 bullseye** | 16 | yes, from PGDG | **does not fix it** |
| `16-3.5-alpine` | Alpine 3.24 | 16 | **no** | unusable |
| `18-3.6` | Debian 13 trixie | **18** | yes | forces a MAJOR bump |
| `postgres:16-trixie` + PGDG | Debian 13 trixie | 16 | yes (postgis 3.6.4, pgvector 0.8.6) | needs us to publish an image |

The three load-bearing measurements:

- **`16-3.5` is bullseye too.** Upstream's `16-3.5/Dockerfile` is literally
  `FROM docker.io/postgres:16-bullseye`. Run `apt-get update` in it without
  the flag and it exits 100 with the same expired-Release error. Across all
  159 `postgis/postgis` tags there is **no** OS-suffixed Debian variant, and
  every Debian tag for PG ≤ 17 is bullseye; `18-3.6` and `19beta1-3.6` are the
  only trixie ones. So the Postgres major and the maintained base are welded
  together upstream, and #832 cannot be closed by editing a tag.
- **Alpine cannot carry pgvector for PG16.** Alpine 3.24's package is
  `postgresql-pgvector`, and `apk info -R` shows it `depends on postgresql18`
  — installing it into the PG16 image drags in a second Postgres and puts
  `vector.control` in PG18's extension directory. (There is no `pgvector`
  package at all; the `vector` package in the repo is the Datadog log agent.)
- **`postgres:16-trixie` would work**, and is the shape of the real fix:
  `apt-get update` exits 0, and PGDG trixie carries `postgresql-16-postgis-3`
  3.6.4 and `postgresql-16-pgvector` 0.8.6. But a GitHub Actions service
  container takes a pullable `image:`, not a build — so this route means
  publishing our own image to a registry. That is a supply-chain decision, not
  a tag edit, and it contradicts the action's own "no new image in the trust
  boundary" premise. It belongs in #832, argued on its merits.

## Does the stopgap come out here? No.

**For removing it:** its own comment calls it a stopgap; a permanently frozen
security index is not a resting state; and leaving a flag that reads as a
security relaxation invites a future reader to "fix" it and re-break every job
that touches the action.

**Against, and decisive:** removing it requires a base image that does not
have the problem, and the table above shows there isn't one for PG16. Removing
it without that is not a cleanup, it is an outage. The secondary argument —
that changing the base and dropping the flag in one diff makes a red run
ambiguous between two causes — is real but subordinate; it would matter if the
choice were live, and it isn't.

So the flag stays, and the *reason it stays* is now written where someone
about to remove it will read it, with the falsifiable measurements attached.
`tests/guards/postgis-image-single-source.test.ts` also fails if the flag is
dropped from any of the three sites that need it.

## The drift guard, and why not seven literals alone

Six of the sites are `jobs.<id>.services.<id>.image`, which accepts no `env`
context and cannot call an action; two are `FROM`; one is a doc table. All
nine are literals by necessity. The tenth consumer is different in kind:
`.github/actions/enable-pgvector/action.yml` selects the service container
with `docker ps --filter ancestor=<image>`.

A guard asserting the literals agree with *each other* would have a hole
exactly there — move all six `image:` lines together and it stays green while
the action filters for an image nothing is running. So the action **derives**
its value from `.github/postgis-image` and holds no literal at all: a site
with nothing to drift cannot drift. The guard then checks (A) every literal in
the tracked tree equals the owner, (B) the three sites that run `apt-get` in
the image keep the flag, (C) the action reads the owner file and restates
nothing.

Every assertion carries a positive control on its own population, and each was
mutation-proven red. One of those proofs earned its keep immediately: the
first draft of check (C) matched `toContain('postgis-image')`, and pointing
`pin_file` at `/dev/null` left all 21 tests green — the word survives in the
comments that explain the derivation. It matches the assignment now.

## Files

| file | role |
|---|---|
| `.github/postgis-image` | **new** — the owner. First non-comment line is the image ref. |
| `.github/actions/enable-pgvector/action.yml` | derives the pin; counts matches instead of `head -1`; carries the WHY-NOT-YET argument |
| `.github/workflows/{ci,lighthouse,coverage-reference,load-test}.yml` | six pins, unchanged in value, each annotated with where the owner lives |
| `deploy/postgres/Dockerfile` | **un-broken** — gains the flag |
| `infra/scripts/restore-test-gcp.sh` | **un-broken** — gains the flag in its heredoc copy |
| `docs/dev-setup-macos.md` | the "add the flag locally" workaround is obsolete |
| `tests/guards/postgis-image-single-source.test.ts` | **new** — the three-direction guard |

## Decisions

- **The pin does NOT move.** `16-3.5` would be a strictly fresher image (the
  3.4 line has not been rebuilt since 2024-10-14; 3.5 was rebuilt 2026-08-31)
  but it does not address the defect this change is about, and it is not free:
  `deploy/postgres/Dockerfile` is what the agrent VM builds `agrent-db:local`
  from, and moving PostGIS 3.4 → 3.5 under an existing cluster needs an
  `ALTER EXTENSION postgis UPDATE` runbook. CI and prod deliberately share one
  image, so bumping CI alone would break that documented parity. Bumping both
  is a separate change with a production step in it.
- **#833's fix was one site out of three.** `deploy/postgres/Dockerfile` and
  the `restore-test-gcp.sh` heredoc run the same `apt-get update` against the
  same frozen suite and never got the flag. Measured: a `--no-cache` build of
  the Dockerfile fails with exit 100 on today's main, so `docker-compose up
  -d`, the VM's DB image build and the monthly restore drill have all been
  unbuildable since 2026-09-07 while CI stayed green. That is the cost of a
  per-site literal, and check (B) is the guard that would have caught it.
- **The restore drill's failure would have lied.** It cannot build a Postgres
  to restore *into*, which reads on the dashboard as a failed restore rather
  than as a broken build — a backup-confidence signal reporting the wrong
  thing.
- **`head -1` became a count.** The old selection collapsed "no container" and
  "one container" into one variable; only a separate emptiness check told them
  apart, and two matches silently picked the first. Zero and two are now
  distinct, named errors that dump `docker ps` alongside.
- **The host `apt-get update` in `restore-test-gcp.sh` is deliberately NOT
  flagged.** It installs `docker.io` on the restore VM's own host — a
  different, healthy suite. Check (B) narrows to `RUN` and `docker exec` lines
  for exactly that reason; requiring the flag there would teach the next
  reader to relax an index that is fine.
