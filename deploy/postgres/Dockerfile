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

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        postgresql-16-postgis-3 \
        postgresql-16-pgvector \
    && rm -rf /var/lib/apt/lists/*
