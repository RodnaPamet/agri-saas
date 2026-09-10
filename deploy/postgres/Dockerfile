# PostGIS + pgvector for local dev — spatial parcel geometry (PostGIS) AND
# RAG embeddings (pgvector) in one Postgres. Built FROM the vetted official
# postgis image + pgvector from PGDG (the apt repo the image already trusts),
# mirroring the CI `.github/actions/enable-pgvector` step so dev and CI match.
#
# The tag below MUST equal the line in `.github/postgis-image`, the single
# source of truth — `FROM` takes no runtime lookup, so this is a literal by
# necessity. tests/guards/postgis-image-single-source.test.ts fails CI if the
# two disagree.
FROM postgis/postgis:16-3.4

# `Acquire::Check-Valid-Until=false` is REQUIRED here for exactly the reason
# it is required in `.github/actions/enable-pgvector/action.yml` — see that
# file for the full argument and for why it is not ready to come out (#832).
# In short: the base is Debian bullseye, whose security Release file froze at
# `Valid-Until: Mon, 07 Sep 2026 21:13:04 UTC`, so a plain `apt-get update`
# exits 100 and this build fails outright.
#
# #833 added the flag to the CI action ONLY. This file and
# `infra/scripts/restore-test-gcp.sh` run the same `apt-get update` against
# the same frozen suite and were left without it, so from 2026-09-07 the dev
# stack (`docker-compose up -d`), the VM's `agrent-db:local` build
# (`deploy/docker-compose.vm.yml`) and the monthly restore drill could not
# build at all. Verified: exit 100 without the flag, exit 0 with it.
RUN apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install -y --no-install-recommends postgresql-16-pgvector \
    && rm -rf /var/lib/apt/lists/*
