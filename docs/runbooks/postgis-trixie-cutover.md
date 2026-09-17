# Cutover: `postgis/postgis:16-3.4` → `postgres:16-trixie` (#832)

The production VM builds `agrent-db:local` from `deploy/postgres/Dockerfile`
(`deploy/docker-compose.vm.yml`), so changing that file changes the database
image `app.agrent.bg` runs. This is **not a rebuild** — it is starting an
existing cluster under different binaries, on the same `pgdata` volume.

Everything below was measured on a real PGDATA before being written down; the
evidence is in `docs/postgis-base-image-options.md` §6.

## Before you run this: the acute break has lapsed

Debian re-signed `bullseye-security` on **2026-09-12 09:27:08 UTC**, and the
refreshed InRelease carries **no `Valid-Until` field**, so apt cannot consider
it expired. Verified on the production VM on 2026-09-17: a `--no-cache` build
of the OLD Dockerfile, with no `Acquire::Check-Valid-Until=false` flag, exits
0.

So this cutover is **not an emergency** and should be scheduled, not rushed.
What it buys is a supported base: bullseye is `oldoldstable`, its LTS ended
2026-08-31, and its index is now kept valid by someone choosing to re-sign an
EOL suite rather than by a support commitment. Trixie has regular security
support to 2028-08-09.

## What does NOT change

Postgres stays on **major 16**. `pg_controldata` is byte-identical across the
two images — same `pg_control version number` (1300), same
`Catalog version number` (202307071), same block size, same checksum version.

**So: no `pg_upgrade`, no dump and reload.** The cluster starts clean on the
new image.

PostGIS forward compatibility was measured rather than assumed: of the 471
distinct C symbols the 3.4.3 catalog binds to, **0** are absent from the 3.6.4
library (control: 0 absent from its own 3.4.3 library, so the method reports 0
when it should).

## What does change, and is the whole risk

**glibc 2.31 → 2.41.** Postgres cannot prove the collation ordering is
unchanged, so on first start it warns:

```
WARNING:  database "agrent_production" has a collation version mismatch
DETAIL:   The database was created using collation version 2.31,
          but the operating system provides version 2.41.
```

Every btree index on `text`/`varchar`, every unique constraint on text, and
every range predicate over text is **suspect until rebuilt**. A six-string
probe (`a`, `B`, `á`, `Ябълка`, `ябълка`, `Ечемик`) sorted identically under
both — that is not evidence the collation is equivalent, and six strings cannot
speak for a domain of Bulgarian farm records. The REINDEX is required.

## The rollback boundary — read this before starting

| after | rollback is |
|---|---|
| the image swap | **clean.** Swap the image back; `postgis_lib_version()` returns 3.4.3, data intact, collation version matches again. |
| the REINDEX | **cheap but not free.** Indexes are now built under 2.41; reverting means reindexing again on the old image. No data loss, no snapshot. |
| `ALTER EXTENSION postgis UPDATE` | **snapshot restore only.** The 3.6.4 catalog binds 485 symbols, 13 of which do not exist in the 3.4.3 library (`ST_NumCurves`, `ST_CurveN`, `ST_CoverageClean`, `ST_RemoveSmallParts`, `ST_RemoveIrrelevantPointsForView`, `postgis_proj_compiled_version`, `lwgeom_neq`, `LWGEOM_numpatches`, `LWGEOM_patchn`, and four `*_brin_inclusion_merge`). |

**`ALTER EXTENSION` goes LAST**, after the reindex, so the cheap-rollback
window stays open across the longest step. (`docs/postgis-base-image-options.md`
§8 recommends `ALTER EXTENSION` before the REINDEX; that ordering closes the
window earlier than it needs to, for no gain. Its own §6 is the reason.)

The "procs need upgrade" state is **silent** — nothing fails, so nothing tells
you it is pending. `postgis_full_version()` is the only thing that says so.

## Procedure

Every command runs on the VM. `gcloud compute ssh agrent --zone europe-west1-b`.

### 0. Snapshot first — do not rely on the daily

The schedule runs at 02:00 UTC, so RPO is up to 24 hours. Take a fresh one:

```bash
gcloud compute disks snapshot agrent --zone europe-west1-b \
  --snapshot-names "agrent-pre-trixie-$(date -u +%Y%m%d-%H%M)"
```

Confirm it reports `READY` before continuing.

### 1. Stop the writers, leave the database up

```bash
sudo docker compose -f /opt/agrent/docker-compose.vm.yml stop app worker
```

The REINDEX takes text indexes offline for its duration; an app writing
through that is the avoidable half of the risk.

### 2. Rebuild the image and restart the database

```bash
cd /opt/agrent
sudo docker compose -f docker-compose.vm.yml build db
sudo docker compose -f docker-compose.vm.yml up -d db
sudo docker compose -f docker-compose.vm.yml logs --tail=40 db
```

Expect `database system was shut down at …` → `ready to accept connections`,
and the collation warning above. **Rollback is still clean here.**

### 3. Verify the cluster before touching anything

```sql
SELECT version();                       -- expect PostgreSQL 16.x on trixie
SELECT postgis_lib_version();           -- expect 3.6.4 (library)
SELECT count(*) FROM "Parcel";          -- expect the pre-cutover count
SELECT sum(ST_Area(geometry::geometry)) FROM "Parcel" WHERE geometry IS NOT NULL;
```

Record the `Parcel` count and area sum **before** step 2 so this is a
comparison and not a reading.

### 4. REINDEX, then refresh the collation version

```sql
REINDEX DATABASE agrent_production;
ALTER DATABASE agrent_production REFRESH COLLATION VERSION;
```

The second expects `NOTICE: changing version from 2.31 to 2.41`. Doing it
without the REINDEX would silence the warning while leaving the indexes
suspect — that is the one sequencing mistake with a quiet failure mode.

### 5. Upgrade the PostGIS catalog — the rollback window closes here

```sql
ALTER EXTENSION postgis UPDATE;
ALTER EXTENSION postgis_topology UPDATE;
ALTER EXTENSION postgis_tiger_geocoder UPDATE;
SELECT postgis_full_version();          -- must NOT say "need upgrade"
```

### 6. Bring the app back and verify from outside

```bash
sudo docker compose -f /opt/agrent/docker-compose.vm.yml up -d app worker
curl -fsS https://app.agrent.bg/api/readyz
```

Then exercise a real spatial read — open a parcel with geometry in the map
view. `/api/readyz` proves the process started; it does not prove PostGIS
answers.

## If it goes wrong

Before step 5: `sudo docker compose -f docker-compose.vm.yml stop db`, restore
`deploy/postgres/Dockerfile` to the previous `FROM`, rebuild, `up -d db`. If
step 4 had already run, reindex again on the old image.

After step 5: restore the snapshot from step 0. `docs/backup-restore.md` has
the disk-restore procedure; the drill in `infra/scripts/restore-test-gcp.sh`
exercises exactly that path.

## Note for the next base change

The same collation rebuild is required by **any** base change that moves
glibc, including a future trixie → forky. That is a property of glibc, not of
this migration, and it is the reason the support horizon mattered more than the
107 MiB the image lost: trixie's regular security support runs to 2028-08-09,
so this should not recur before then.
