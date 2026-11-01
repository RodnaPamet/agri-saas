# PostGIS + pgvector for dev, CI's restore drill, and the production VM's
# `agrent-db` — spatial parcel geometry (PostGIS) AND RAG embeddings
# (pgvector) in one Postgres, both installed from PGDG, the official
# PostgreSQL apt repo the base image already trusts.
#
# The tag below MUST equal the line in `.github/postgis-image`, the single
# source of truth — `FROM` takes no runtime lookup, so this is a literal by
# necessity. `tests/guards/postgis-image-single-source.test.ts` fails
# CI if this literal and that file disagree (#860).
#
# THE BASE IS A STOCK POSTGRES IMAGE, NOT `postgis/postgis` (#832). The old
# base was `postgis/postgis:16-3.4`, which is Debian bullseye, whose security
# `Release` file froze on 2026-09-07 — past which a plain `apt-get update`
# exited 100 and this build failed outright. Debian re-signed that suite on
# 2026-09-12 with no `Valid-Until` at all, so the break has lapsed; bullseye
# is still `oldoldstable` with its LTS ended 2026-08-31, and an index kept
# valid by ad-hoc re-signing is a worse foundation than a supported suite. `postgis/postgis` publishes no
# Debian tag on a maintained suite for Postgres 16 (its `16-3.5` is
# `FROM postgres:16-bullseye` and reproduces the same failure), and its only
# trixie tag forces a Postgres MAJOR bump. So PostGIS moves from "baked into
# the base" to "installed here", which is why this file now installs two
# packages where it used to install one.
#
# Trixie's regular security support runs to 2028-08-09, so the
# `Acquire::Check-Valid-Until=false` flag this RUN used to carry is GONE
# rather than moved. Measurements behind the choice — image size, migrations
# with red controls, the collation and PostGIS-catalog risk on a real PGDATA
# — are in docs/postgis-base-image-options.md.
FROM postgres:16-trixie

#
# THE PACKAGE SET IS A CLAIM ABOUT WHAT PRODUCTION'S PGDATA NEEDS (#2652).
# `postgresql-16-postgis-tiger-geocoder` is here for RESTORE, not for any
# feature: nothing in `src/`, `prisma/` or `scripts/` calls a geocoder, and a
# US TIGER address geocoder has no use in a Bulgarian farm database. But
# `agrent_production` HAS the extension — created by the old `postgis/postgis`
# base image, which bundled it — so every `pg_dump` emits
#
#     CREATE EXTENSION IF NOT EXISTS postgis_tiger_geocoder WITH SCHEMA tiger;
#
# and `pg_restore --exit-on-error` dies on it if the target cannot provide it.
# #974 moved off that base and installed two packages explicitly, which was
# right, and silently dropped the third thing the base had been supplying.
# Nothing noticed for five weeks, because the monthly restore drill is the ONLY
# check that reads the package set against production's actual catalogue — the
# existing `postgis-image-single-source` guard pins the TAG across its nine
# consumers and is blind to what the image contains.
#
# Measured on `postgres:16-trixie` 2026-11-01, production's seven extensions
# against the two-package set: six available, `postgis_tiger_geocoder` the only
# one missing. The package costs 3 MB.
#
# DO NOT "tidy" this away by dropping the extension in production instead. That
# is a defensible end state and is NOT equivalent: the bucket holds 30 days of
# dumps that already carry the CREATE EXTENSION line, and a backup you cannot
# restore is not a backup. The drop is tracked separately, and is only safe once
# no retained dump needs it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        postgresql-16-postgis-3 \
        postgresql-16-pgvector \
        postgresql-16-postgis-tiger-geocoder \
    && rm -rf /var/lib/apt/lists/*
