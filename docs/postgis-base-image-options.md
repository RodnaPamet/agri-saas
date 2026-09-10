# PostGIS base image — options for #832

**Status: RESEARCH. No decision is made here and nothing in the repo is
changed by this file.** Issue #832 remains open for a maintained-Debian base;
this document exists so that decision can be taken from measurements rather
than from recollection. Every number below was produced on 2026-09-11 by
running the thing; anything not measured is labelled as not measured.

- Today's pin: `.github/postgis-image` → `postgis/postgis:16-3.4`
- The stopgap: `-o Acquire::Check-Valid-Until=false`, at
  `deploy/postgres/Dockerfile:25`, `infra/scripts/restore-test-gcp.sh:432`,
  `.github/actions/enable-pgvector/action.yml:102` (merged in #861/#833)
- Nothing enforces pin agreement automatically yet — that guard is #860.

---

## 1. The break, reproduced

```
$ docker run --rm postgis/postgis:16-3.4 sh -c 'apt-get update; echo exit=$?'
E: Release file for http://deb.debian.org/debian-security/dists/bullseye-security/InRelease
   is expired (invalid since 3d 1h 14min 40s). Updates for this repository will not be applied.
exit=100

$ docker run --rm postgis/postgis:16-3.4 sh -c 'apt-get -o Acquire::Check-Valid-Until=false update; echo exit=$?'
exit=0
```

`postgis/postgis:16-3.4` is `PRETTY_NAME="Debian GNU/Linux 11 (bullseye)"`,
glibc 2.31, Postgres 16.4, PostGIS 3.4.3. Debian's own release page gives
bullseye **End of LTS 2026-08-31** — the expiry is the suite reaching its end
of life, not a mirror glitch, so it will never refresh.

---

## 2. What was re-verified rather than trusted

The note at the top of `.github/actions/enable-pgvector/action.yml` says
`postgis/postgis` publishes no Debian tag on a maintained suite for Postgres
16. Checked again against the registry:

```
$ curl -s "https://hub.docker.com/v2/repositories/postgis/postgis/tags?page_size=100&name=16-"
count=6
16-master              2026-08-31
16-3.5                 2026-08-31
16-3.5-alpine          2026-08-31
16-3.4-alpine          2024-10-14
16-3.4                 2024-10-14
16-3.5.0alpha2-alpine  2024-09-23
```

- **`16-3.5` is bullseye and reproduces the failure** — measured:
  `PRETTY_NAME="Debian GNU/Linux 11 (bullseye)"`, `plain update exit=100`.
  The existing claim holds.
- **`16-master` is NOT bullseye.** Measured:
  `PRETTY_NAME="Debian GNU/Linux 13 (trixie)"`, Postgres 16.15,
  `apt-get update` exit 0. So the flat statement "no `postgis/postgis` tag for
  PG16 is on a maintained suite" is, strictly, false — and it was worth
  re-checking rather than repeating.

  It is still not usable: `16-master` ships `postgis 3.7.0dev`, an unreleased
  development build, behind a mutable tag that is rebuilt from the PostGIS
  master branch. It is evidence, not a candidate.

---

## 3. Candidate matrix (measured)

All builds `--no-cache`, base layers already pulled, same machine, one
sample each. Build seconds are **not** transferable to GitHub runners
(different CPU, cold layer cache, different mirror latency) — they are here
only to show none of these options is dramatically slower to build.

| option | base | PG | PostGIS | pgvector | image size | vs today | build |
|---|---|---|---|---|---|---|---|
| **today** | `postgis/postgis:16-3.4` (bullseye, glibc 2.31) | 16.4 | 3.4.3 | 0.8.6 | 794,460,274 B (757.7 MiB) | — | 63 s |
| **A** | `postgres:16-trixie` (glibc 2.41) + PGDG | 16.15 | 3.6.4 | 0.8.6 | 681,994,851 B (650.4 MiB) | **−107.3 MiB (−14.2 %)** | 48 s |
| **B** | `postgres:16-bookworm` (glibc 2.36) + PGDG | 16.15 | 3.6.4 | 0.8.6 | 648,266,142 B (618.2 MiB) | −139.4 MiB (−18.4 %) | 39 s |
| **C** | `postgis/postgis:16-3.5-alpine` (musl) + pgvector from source | 16.15 | 3.5.x | 0.8.6 | 524,948,320 B (500.6 MiB) | −257.0 MiB (−33.9 %) | 39 s |
| **D** | stay on `16-3.4` + the flag | 16.4 | 3.4.3 | 0.8.6 | 794,460,274 B | 0 | 63 s |

### Does PostGIS 3.4/3.5 exist in PGDG for these suites?

**No — PGDG carries only 3.6.x for both trixie and bookworm.** Measured with
`apt-cache madison` inside each base:

```
trixie-pgdg    postgresql-16-postgis-3   3.6.4+dfsg-2.pgdg13+1
                                         3.6.3+dfsg-1.pgdg13+1
                                         3.6.2+dfsg-1.pgdg13+1
bookworm-pgdg  postgresql-16-postgis-3   3.6.4+dfsg-2.pgdg12+1
                                         3.6.3+dfsg-1.pgdg12+1
                                         3.6.2+dfsg-1.pgdg12+1
```

This is the single most decision-relevant fact in the document: **a PGDG move
forces PostGIS 3.4 → 3.6 whichever suite is chosen.** Bookworm does not buy a
gentler PostGIS jump; it buys only an older glibc and a shorter support
horizon.

`postgresql-16-pgvector` is `0.8.6` on trixie, bookworm **and** bullseye — so
pgvector does not move at all. `postgresql-16-postgis-3-scripts` is a hard
`Depends:` of `postgresql-16-postgis-3`, so listing it explicitly is
redundant (harmless; the measured images did list it).

Both official `postgres:16-*` images already ship the PGDG apt source
(`/etc/apt/sources.list.d/pgdg.list`), so no repo has to be added — the
install is one `apt-get install`.

### Extension library parity

`ls /usr/lib/postgresql/16/lib` on today's image and on option A returns the
same set: `postgis-3.so`, `postgis_raster-3.so`, `postgis_sfcgal-3.so`,
`postgis_topology-3.so`, `vector.so`. Nothing the current image can load is
missing from the candidate.

### What the candidate does NOT inherit

`postgis/postgis` ships `/docker-entrypoint-initdb.d/10_postgis.sh`, which on
first init creates a `template_postgis` database and loads `postgis`,
`postgis_topology`, `fuzzystrmatch` and `postgis_tiger_geocoder` into it and
into `$POSTGRES_DB`. The official `postgres` image does not. Consequences,
checked against this repo:

- Migrations create what they need themselves
  (`20260613090735_ag_feature1_spray_map` → `CREATE EXTENSION IF NOT EXISTS
  postgis`, `20260619100000_ai_rag_pgvector` → `vector`), so a fresh stack is
  unaffected. Verified by actually running them (§5).
- `template_postgis` disappears. Nothing in the tree references it —
  `tests/setup/globalSetup.ts:58` clones from the migrated base DB
  (`CREATE DATABASE … TEMPLATE "<baseName>"`), not from `template_postgis`.
- `postgis_topology` / `postgis_tiger_geocoder` stop being created
  automatically. Nothing in `src/`, `prisma/`, `tests/` or `scripts/` uses
  them — but **existing clusters already have them** (measured on a container
  from today's image: `fuzzystrmatch 1.2, postgis 3.4.3,
  postgis_tiger_geocoder 3.4.3, postgis_topology 3.4.3, vector 0.8.6`), which
  is what makes §6's upgrade steps necessary rather than optional.

---

## 4. Support horizon — so we are not choosing the next expiry

Fetched from debian.org/releases and wiki.debian.org/LTS on 2026-09-11:

| suite | regular security ends | LTS ends | state today |
|---|---|---|---|
| bullseye (11) | 2024-08-14 | **2026-08-31 — passed** | frozen; this is #832 |
| bookworm (12) | 2026-07-11 † | **2028-06-30** | already on LTS |
| trixie (13) | **2028-08-09** | **2030-06-30** | current stable |

† The two Debian pages disagree by a month on this one date — the releases
page gives end-of-security-support 2026-07-11, the LTS page gives the LTS
period as starting 2026-06-11. Both agree bookworm is now under LTS and that
LTS ends 2028-06-30, which is the date the decision turns on; the month is
recorded as read rather than reconciled.

Measured freshness of the security indexes right now (`Valid-Until` from the
`debian-security` Release file inside each image, on a 7-day refresh cycle):

```
bookworm-security  Date: Thu, 10 Sep 2026 20:34:01 UTC  Valid-Until: Thu, 17 Sep 2026 20:34:01 UTC
trixie-security    Date: Thu, 10 Sep 2026 20:34:02 UTC  Valid-Until: Thu, 17 Sep 2026 20:34:02 UTC
```

Both are live. The difference is the horizon: bookworm is **already past
regular security support** and its index freezes the way bullseye's just did
in **June 2028**; trixie's does in **June 2030**. Choosing bookworm is
choosing to repeat this exercise roughly two years sooner, for an image that
is 32 MiB smaller and an older glibc.

---

## 5. Does the repo actually work on the candidate?

### Migrations — with red controls

`npx prisma migrate deploy` against a container of each image (Node v22.23.2,
`prisma/init-roles.sh` mounted as the init hook, fresh volume each time):

| target | result |
|---|---|
| **option A** (`postgres:16-trixie` + PostGIS 3.6.4 + pgvector 0.8.6) | **exit 0 — "All migrations have been successfully applied", 241 rows in `_prisma_migrations`**, extensions `postgis 3.6.4`, `vector 0.8.6` |
| control — bare `postgres:16-trixie`, no extensions | **exit 1** at `20260309115528_audit_workflow_extensions`: `ERROR: extension "postgis" is not available` |
| control — `postgis/postgis:16-3.4`, pgvector NOT installed | **exit 1** at `20260619100000_ai_rag_pgvector`: `ERROR: extension "vector" is not available` |

The two controls are the point. A green migrate run against a database is
exactly the observable a *healthy* base and a *silently extension-less* base
would both produce if the migrations never touched the extensions — so the
green above would prove nothing on its own. The controls show the run does
touch them, and name which migration dies for which missing extension.

### PostGIS-touching integration tests

`npx jest tests/integration/parcel-authoring.test.ts
tests/integration/parcel-merge-split.test.ts
tests/integration/parcel-tiles.test.ts --runInBand --no-coverage`
(these are the suites that call `ST_Area`, `ST_IsValid`, MVT export,
merge/split):

| target | result |
|---|---|
| option A (`postgres:16-trixie`, PostGIS 3.6.4) | **3 suites / 15 tests passed** |
| today's image (`postgis/postgis:16-3.4`, PostGIS 3.4.3) | **3 suites / 15 tests passed** |

Both figures come from runs taken minutes apart in the same window. Each was
re-run, because a first attempt at the control reported `Test Suites: 1
failed, 2 passed` / `Tests: 7 failed, 8 passed` — a red with nothing to do
with any base image. Read in full rather than by its colour, the failure was
`Database "agri_saas_test_w1" does not exist`: this worktree's
`node_modules` is a symlink to a checkout shared with a parallel session, and
`tests/helpers/db.ts:78` puts the per-worker marker at
`node_modules/.cache/inflect-test-perworker.json`. Another session's marker
had pointed my workers at per-worker databases that do not exist on my
container. Once the marker was gone, the same command was 15/15 green. **That
red was an artifact of the shared checkout, not evidence about any image**,
and it is recorded here because a future reader running these commands will
hit it. (An earlier attempt failed differently and just as uninformatively —
`Can't reach database server at 127.0.0.1:5432`, because the Prisma client
reads `DATABASE_URL` while the test harness reads `DATABASE_URL_TEST`. Both
must be set to the candidate container.)

*Not measured*: the full 10,000-test suite, E2E/Playwright, and the k6 load
test on the new base. Those need a CI run, which is #832's own point ("a
PostGIS or Postgres minor change under the test suite deserves its own run").

---

## 6. Migration risk (measured, on a real PGDATA)

The production stack keeps a persistent `pgdata` volume
(`deploy/docker-compose.vm.yml:25`), so changing the base is not a rebuild —
it is starting an existing cluster under different binaries. Measured by
initialising a volume with today's image, seeding geometry + text + vector
data with indexes, then swapping images on the same volume.

### On-disk format: unchanged

`pg_controldata` under today's image and under option A, byte for byte:

```
pg_control version number:  1300      Maximum data alignment:  8
Catalog version number:     202307071 Database block size:     8192
WAL block size:             8192      Float8 argument passing: by value
Data page checksum version: 0
```

Same Postgres major (16), same catalog version → **no `pg_upgrade`, no dump
and reload.** The cluster started clean on the new image:
`database system was shut down at …` → `ready to accept connections`.

### Collation: the real risk

```
WARNING:  database "postgres" has a collation version mismatch
DETAIL:   The database was created using collation version 2.31,
          but the operating system provides version 2.41.
HINT:     Rebuild all objects in this database that use the default collation
          and run ALTER DATABASE postgres REFRESH COLLATION VERSION …
```

glibc 2.31 → 2.41. Postgres cannot prove the ordering is unchanged, so every
btree index on `text`/`varchar`, every unique constraint on text, and every
range predicate over text is suspect until rebuilt. `REINDEX DATABASE` and
`ALTER DATABASE … REFRESH COLLATION VERSION` both ran cleanly (`NOTICE:
changing version from 2.31 to 2.41`).

A six-string probe (`a`, `B`, `á`, `Ябълка`, `ябълка`, `Ечемик`) sorted
identically under glibc 2.31 and 2.41 — `a,á,B,Ечемик,ябълка,Ябълка`.
**That is not evidence the collation is equivalent.** Six strings cannot
speak for the domain; the REINDEX is still required.

### PostGIS 3.4.3 catalog under the 3.6.4 library

The forward direction is safe, and this was measured rather than assumed. Of
the 471 distinct C symbols the 3.4.3 catalog binds to, **0** are absent from
the 3.6.4 shared library (control: 0 absent from its own 3.4.3 library — the
comparison method reports 0 when it should). Queries work; `ST_Area` over the
seeded parcels returned the same `3.0000` before and after.

But `postgis_full_version()` reports
`(core procs from "3.4.3 e365945" need upgrade) TOPOLOGY (topology procs …
need upgrade)`, and that state is **silent** — nothing fails, so nothing
tells you. The fix is three statements, all of which succeeded:

```sql
ALTER EXTENSION postgis UPDATE;                 -- → 3.6.4
ALTER EXTENSION postgis_topology UPDATE;        -- INFO: Upgraded validatetopology_returntype.id2 …
ALTER EXTENSION postgis_tiger_geocoder UPDATE;  -- → 3.6.4
```

### Rollback

| when | result |
|---|---|
| **before** `ALTER EXTENSION postgis UPDATE` | **clean.** Restarted on today's image, `postgis_lib_version()` = 3.4.3, data intact, collation version matches again. Just swap the image back. |
| **after** `ALTER EXTENSION postgis UPDATE` | **not clean.** The 3.6.4 catalog binds 485 symbols, of which **13 do not exist in the 3.4.3 library** (`ST_NumCurves`, `ST_CurveN`, `ST_CoverageClean`, `ST_RemoveSmallParts`, `ST_RemoveIrrelevantPointsForView`, `postgis_proj_compiled_version`, `lwgeom_neq`, `LWGEOM_numpatches`, `LWGEOM_patchn`, and the four `*_brin_inclusion_merge`). Demonstrated: `SELECT ST_NumCurves('CIRCULARSTRING(0 0, 1 1, 2 0)'::geometry)` → `ERROR: could not find function "ST_NumCurves" in file "/usr/lib/postgresql/16/lib/postgis-3.so"`, while `ST_Area` on the same cluster still worked. The collation version is now mismatched in the other direction too. |

**So the rollback window is the interval between the image swap and the
`ALTER EXTENSION` — and it closes the moment you take it.** After that,
rollback means restoring a snapshot taken before the change. That ordering
should be written into whatever runbook carries this change.

### Restore from an existing snapshot

Both restore paths were exercised against data created under 3.4.3:

- **Disk-snapshot path** (what `infra/scripts/restore-test-gcp.sh` does — start
  Postgres directly on the restored directory): works, with the collation
  warning and the "procs need upgrade" state above.
- **`pg_dump`/`pg_restore` path**: `pg_dump -Fc` from the 3.4.3 cluster,
  `pg_restore` into option A → exit 0, and the extensions come back **at the
  new version automatically**: `fuzzystrmatch 1.2, postgis 3.6.4,
  postgis_tiger_geocoder 3.6.4, postgis_topology 3.6.4, vector 0.8.6`, all 3
  rows and `sum(ST_Area) = 3.0000` intact.

**One thing the drill would not catch.** Its validation battery
(`restore-test-gcp.sh:480-525`) asserts `SELECT 1`, `Tenant`/`User`
readability, `_prisma_migrations`, `pg_policies`, `pg_roles` — and never calls
a PostGIS function. A cluster restored under a newer PostGIS with un-upgraded
procs passes every one of those checks. That is the same shape as the bug
class this repo keeps paying for: an observable that the healthy and the
degraded state both produce. If the base moves, the battery should gain a
`postgis_full_version() NOT LIKE '%need upgrade%'` assertion — worth its own
issue, and out of scope here.

---

## 7. Alpine (option C), measured and rejected

The claim in the action's note — "`16-3.5-alpine` cannot supply pgvector for
PG16 at all: Alpine's `postgresql-pgvector` depends on `postgresql18`" —
holds:

```
$ docker run --rm postgis/postgis:16-3.5-alpine apk add --simulate postgresql-pgvector
(1/6) Installing postgresql-common (1.3-r0)
(2/6) Installing libpq (18.6-r0)
(3/6) Installing postgresql18-client (18.6-r0)
(4/6) Installing liburing (2.14-r0)
(5/6) Installing postgresql18 (18.6-r0)
(6/6) Installing postgresql-pgvector (0.8.1-r0)
```

It installs a **second Postgres major** to satisfy the extension. But that is
not the end of the option: the image ships PG16 headers
(`/usr/local/include/postgresql/server/postgres.h`), so pgvector can be
compiled. That was done — `make with_llvm=no` after `apk add build-base git`,
building `v0.8.6` — and it works: **500.6 MiB, 39 s**, PostGIS 3.5.x, HNSW
index created, `CREATE EXTENSION vector` fine. It is the smallest option by a
wide margin, on a maintained base (Alpine 3.24.1), and `postgis/postgis`
still actively rebuilds the tag (2026-08-31).

**It is still the wrong choice, for a reason unrelated to size — musl's
collation.** Measured on the same probe across all three:

```
glibc 2.31 (today)   order=a,á,B,Ечемик,ябълка,Ябълка     'ябълка' < 'Ябълка' = true
glibc 2.41 (trixie)  order=a,á,B,Ечемик,ябълка,Ябълка     'ябълка' < 'Ябълка' = true
musl (alpine)        order=B,a,á,Ечемик,Ябълка,ябълка     'ябълка' < 'Ябълка' = false
```

musl sorts by code point. `pg_database.datcollversion` is **null** there —
there is no collation version to track, and therefore no
`REFRESH COLLATION VERSION` safety net either. For a product whose data is
Bulgarian this changes every `ORDER BY name`, every text range scan, and the
comparison semantics of unique indexes on text. That is a product behaviour
change wearing the costume of an infrastructure change, and it is exactly the
kind of thing that would pass CI and surface as "the list is in a weird
order" months later.

Two further costs, for completeness: building pgvector from source puts a
compiler toolchain in the build (`build-base`, `git`) and pins us to
maintaining that recipe; and `postgis/postgis:16-3.5-alpine` is a
**single-manifest amd64 image** — no arm64.

---

## 8. Recommendation

**Option A — `postgres:16-trixie` + PGDG `postgresql-16-postgis-3` +
`postgresql-16-pgvector`.** Reasoning, in the order that decided it:

1. **It is the only option whose support horizon is not already short.**
   trixie: regular security to 2028-08-09, LTS to 2030-06-30. bookworm is
   *already* on LTS and freezes in June 2028. The whole point of #832 is to
   stop being on a suite that expires; bookworm is a two-year deferral of the
   same work.
2. **Bookworm buys nothing on the axis people fear.** PGDG has only PostGIS
   3.6.x for both suites, so the 3.4 → 3.6 jump — the part that needs a test
   run — is identical either way. The only thing bookworm changes is glibc
   2.36 instead of 2.41, and both require the same REINDEX.
3. **The repo runs on it.** 241 migrations apply; the PostGIS-touching
   integration suites are 15/15, matching today's image run in the same
   window; two red controls prove those runs actually exercise the
   extensions.
4. **It is smaller and no slower**: −107.3 MiB (−14.2 %), 48 s vs 63 s.
5. **It fixes the arm64 note as a side effect.** `postgis/postgis:16-3.4` is a
   single amd64 manifest (`docs/dev-setup-macos.md:48`);
   `postgres:16-trixie` is a multi-arch index carrying amd64, arm64, arm and
   386. Apple Silicon developers stop needing Rosetta for the database.
6. **The stopgap comes out in the same change.** All three
   `Acquire::Check-Valid-Until=false` sites are deletable, and a red run then
   has one cause — which is precisely the condition the action's own comment
   sets for removing it.

Alpine is rejected on collation semantics (§7), not on size. Staying put
(option D) is rejected on one point the stopgap's own argument does not
cover. That argument — "the suite is FROZEN, so no newer security updates are
being withheld; the index is merely stale" — is true about the *index* and
says nothing about the *image*: `16-3.4` was last pushed **2024-10-14**
(registry, §2) and carries Postgres 16.4 and glibc 2.31-13+deb11u11, on a
suite whose LTS ended 2026-08-31. Nothing will ever update those packages
again. That is a slowly worsening exposure rather than a broken build, which
is why option D is a defensible *stopgap* and not a defensible destination.

**Recommended sequencing, given §6:** land the base change on its own PR (no
other content), with the production runbook ordered image-swap → verify →
`ALTER EXTENSION` → `REINDEX` → `REFRESH COLLATION VERSION`, and the
rollback window stated explicitly as "before the `ALTER EXTENSION`".

**Not recommended either way, because it is not mine to judge:** whether to
publish our own image instead of installing PostGIS into the CI service
container (option A′, §9). It removes the +14 s and makes CI run production's
bytes, at the cost of a publish pipeline in a GHCR org shared with another
product. Option A can be taken now and A′ later; the reverse is also true.

---

## 9. The exact diff each option requires

Eleven sites carry the pin: nine literal references the pin file enumerates
(six `image:` lines, two `FROM`s, one doc table row) plus the two local image
tags in `docker-compose.yml:14` and `docker-compose.test.yml:21` that spell
the version inside a name no `postgis/postgis` search finds. **None of it is
enforced automatically — #860.** Every one of these must be changed by hand
and checked by hand.

### Option A — `postgres:16-trixie` + PGDG

**1. `.github/postgis-image`** (last line, plus the note above it)

```diff
-# BEFORE YOU BUMP THIS: read the WHY-NOT-YET note at the top of
-# .github/actions/enable-pgvector/action.yml. Every Debian-flavoured
-# `postgis/postgis` tag for Postgres <= 17 is still bullseye, so a tag bump
-# alone does NOT lift the frozen-security-index problem. Issue #832.
-postgis/postgis:16-3.4
+# This is now a STOCK POSTGRES image, not a postgis one: `postgis/postgis`
+# publishes no RELEASED Debian tag on a maintained suite for PG16 (16-3.5 is
+# bullseye; 16-master is trixie but is postgis 3.7.0dev behind a mutable
+# tag). PostGIS and pgvector come from PGDG, which the official image
+# already trusts. Consumers must therefore install postgis themselves —
+# see .github/actions/enable-pgvector/action.yml.
+postgres:16-trixie
```

**2. Six `image:` lines** — `.github/workflows/ci.yml:416`, `:812`, `:1182`,
`lighthouse.yml:44`, `coverage-reference.yml:122`, `load-test.yml:41`:

```diff
-        image: postgis/postgis:16-3.4
+        image: postgres:16-trixie
```

**3. `.github/actions/enable-pgvector/action.yml`** — the service container no
longer has PostGIS baked in, so the action must install it (measured cost:
**36 s → 50 s**, +14 s per job, in six jobs; they run in parallel, so ≈ +14 s
of critical path). Verified in a running plain `postgres:16-trixie` container:
install, then `CREATE EXTENSION postgis` → `CREATE EXTENSION`, no restart.

```diff
-        docker exec "$cid" sh -c 'apt-get -o Acquire::Check-Valid-Until=false update -qq && apt-get install -y -qq postgresql-16-pgvector'
+        docker exec "$cid" sh -c 'apt-get update -qq && apt-get install -y -qq postgresql-16-postgis-3 postgresql-16-pgvector'
```
plus: delete the whole `WHY NOT YET (#832)` / `Acquire::Check-Valid-Until`
comment block (`:65-101`) and restate `name:`/`description:` (`:1-6`), which
currently say the image is a `postgis/postgis` one.

**4. `deploy/postgres/Dockerfile`**

```diff
-FROM postgis/postgis:16-3.4
+FROM postgres:16-trixie
-RUN apt-get -o Acquire::Check-Valid-Until=false update \
-    && apt-get install -y --no-install-recommends postgresql-16-pgvector \
+RUN apt-get update \
+    && apt-get install -y --no-install-recommends \
+        postgresql-16-postgis-3 postgresql-16-pgvector \
     && rm -rf /var/lib/apt/lists/*
```
plus the `:12-24` comment block explaining the flag, which becomes false.

**5. `infra/scripts/restore-test-gcp.sh:431-434`** — the same edit inside the
heredoc, plus the `:410-419` comment.

**6. Two local tags** — `docker-compose.yml:14` and
`docker-compose.test.yml:21`, each with the comment above it:

```diff
-    image: agri-saas-postgres:16-3.4-pgvector
+    image: agri-saas-postgres:16-trixie-3.6-pgvector
```

**7. `docs/dev-setup-macos.md`** — the arm64 table row at `:48` (the image is
now multi-arch, so the answer flips to **yes** and the Rosetta paragraph
narrows to ClamAV only), and section 5, whose premise disappears entirely.

### Option A′ — the same base, but published as our own image

A variant worth naming because the action's own note gestures at it
("migrating therefore means publishing our own image … a registry and
supply-chain decision"). Build `deploy/postgres/Dockerfile` in CI, push it as
`ghcr.io/rodnapamet/agri-saas-postgres:<tag>`, and use THAT everywhere. The
six `image:` lines then name an image that already contains PostGIS and
pgvector, `enable-pgvector` becomes unnecessary (or degenerates to a
verification step), the +14 s per job disappears, and CI runs the same bytes
production runs — which today it does not, since CI uses stock `postgis` plus
a runtime install while production runs a built image.

The costs are not measurable from here and are the reason this is a question
rather than a recommendation: a publish workflow with its own gates, a tag
policy, a first-build ordering problem, and the fact that **the GHCR org is
shared with the other product** (see CLAUDE.md — only the image NAME separates
`agri-saas` from `inflect-compliance` there). Nothing about option A blocks
doing this later; A′ is A plus a registry decision.

### Option B — `postgres:16-bookworm` + PGDG

Character-identical to option A with `bookworm` for `trixie` everywhere.
Measured the same way: image 618.2 MiB, build 39 s, PG 16.15, PostGIS 3.6.4,
pgvector 0.8.6, `CREATE EXTENSION` both fine, glibc 2.36 (so the same
collation-version rebuild is required).

### Option C — Alpine

Same eleven sites, `postgis/postgis:16-3.5-alpine`, and additionally
`deploy/postgres/Dockerfile` and the restore heredoc must build pgvector from
source (`apk add --virtual .build-deps build-base git`, clone `v0.8.6`,
`make with_llvm=no install`, `apk del`). Not recommended — §7.

### Option D — stay put

No diff. The three flag sites and their comments stay as they are, and #832
stays open.

### There is no replica Dockerfile

Worth stating because it is asked about: **`deploy/postgres-replica/Dockerfile`
does not exist.** `find . -name 'Dockerfile*'` on `main` returns exactly two —
`./Dockerfile` (the app) and `./deploy/postgres/Dockerfile` — and listing the
rejected guard branch's tree (`9ca74e52c`) returns the same single Postgres
Dockerfile. The path appears in #860 because the rejected guard's own comment
block named it as a covered scenario; the file it names was never in the tree.
There is no replica image to change, and no streaming replica in the
deployment either (`deploy/docker-compose.vm.yml` declares one `db` service).

### Not in scope of the diffs above

`deploy/docker-compose.vm.yml:17` tags the built image `agrent-db:local`,
which encodes no version and needs no change. `deploy/startup.sh:9,:18`
derive their apt line from `${VERSION_CODENAME}` and follow the host.
`restore-test-gcp.sh:285` runs on an Ubuntu 24.04 VM. All three are
unaffected, as #832's own comments already established.

---

## 10. What is NOT measured

Stated plainly, rather than estimated:

- **CI wall-clock on GitHub runners.** The +14 s install figure is from this
  machine and this network. The direction is certain (an extra ~40 MB of
  packages per job); the magnitude on a runner is not measured.
- **The full test suite, E2E and the k6 load test** on the new base. Only 3
  PostGIS integration suites (15 tests) and the 241 migrations were run.
- **Any production-scale REINDEX duration.** The probe database had 3 rows.
  How long `REINDEX DATABASE agrent_production` takes on the live VM, and
  whether it needs `REINDEX CONCURRENTLY` plus a maintenance window, is
  unmeasured and is the biggest unknown left in option A.
- **Semantic differences between PostGIS 3.4.3 and 3.6.4.** Symbol presence
  was measured (0 lost forward). Symbol presence is not behavioural
  equivalence: measured, GEOS moves 3.9.0 -> 3.14.1 and PROJ 7.2.1 -> 9.8.1 across
  this jump, and output coordinates or validity verdicts for edge-case
  geometries can change. Only a full suite run speaks to that.
- **arm64 in practice.** The multi-arch manifest was read from the registry;
  no arm64 build or test run was performed (this machine is amd64).

## 11. Incidental findings

- `docs/dev-setup-macos.md` currently contains a **duplicated section 5**
  heading and two near-identical copies of the "flag is a labelled stopgap"
  paragraph (headings at `:64` and `:66`, paragraphs at `:93` and `:100`).
  Whoever edits that file for #832 should collapse
  them.
- The restore drill's validation battery cannot see a stale-PostGIS-procs
  cluster (§6). Worth its own issue if the base moves.
- `tests/helpers/db.ts:78` puts the jest per-worker marker inside
  `node_modules/.cache`. When two sessions share a `node_modules` (as two
  checkouts of this repo on one machine do), one session's marker silently
  redirects the other's workers to databases that do not exist. It cost a
  false red here (§5).
