#!/usr/bin/env bash
#
# Pre-commit guard: a staged schema change must carry the regenerated
# OpenAPI artifact with it.
#
# `src/generated/openapi.json` is BUILT from the Zod layer, but it is a
# committed file — editing a schema updates what the generator WOULD
# produce and leaves the artifact behind. The only thing that notices is
# `tests/contracts/api-schemas.test.ts`, which enumerates every schema in
# the spec and therefore names none of your symbols: a test population
# derived by grepping what you changed can never return it, so the usual
# local run comes back green and CI goes red.
#
# This runs only when a file that feeds the spec is staged (see the
# `lint-staged` glob in package.json), and refuses the commit with the
# one command that fixes it. Filenames are appended by lint-staged and
# deliberately ignored — the check is repo-wide by nature.
#
# Bypass, as with the rest of the hook: git commit --no-verify
set -uo pipefail

if ! npx jest tests/contracts/api-schemas.test.ts --silent 2>&1 | tail -40; then
    cat <<'MSG'

──────────────────────────────────────────────────────────────────────
The OpenAPI artifact is out of sync with the schema layer you just
edited. Regenerate it and stage the result:

    npm run openapi:generate
    npx jest tests/contracts/api-schemas.test.ts -u
    git add src/generated/openapi.json tests/contracts/__snapshots__/

Both steps matter: the first rewrites src/generated/openapi.json, the
second refreshes the per-schema snapshots. A schema change usually
touches both.
──────────────────────────────────────────────────────────────────────
MSG
    exit 1
fi
