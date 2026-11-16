#!/bin/sh
set -e

echo "╔══════════════════════════════════════════╗"
echo "║  Agrent — Container Start                ║"
echo "╚══════════════════════════════════════════╝"

# ── 1. Apply Prisma migrations (idempotent) ──
#
# Run the CLI that is already VENDORED in the image. `prisma` is a
# production dependency, so ./node_modules/.bin/prisma is present —
# the previous `npx --yes prisma@7.8.0` re-downloaded a package that
# was already sitting on disk.
#
# Three things that bought us:
#   1. No registry round-trip at container start, so a deploy no
#      longer fails when npmjs.org is unreachable or slow.
#   2. The version can no longer drift from @prisma/client — it IS
#      the locked one, instead of a pin that has to be hand-updated
#      in lockstep (it already went stale once at prisma@5.22.0).
#   3. npm itself is no longer needed at runtime, so the Dockerfile
#      strips it from the image. That removes the whole bundled-npm
#      dependency tree from the attack surface — the source of the
#      CRITICAL tar advisory (CVE-2026-59873) and its HIGH siblings
#      that Trivy flags under /usr/local/lib/node_modules/npm.
#
# If this ever needs to run standalone again, the guard is that
# `prisma` must stay in `dependencies`, never `devDependencies`.
#
# Prisma 7 — connection URLs are NOT in the schema any more (they
# moved to `prisma.config.ts` at the repo root). The CLI auto-
# discovers that config file from the cwd, so `--schema` here is
# redundant but kept for explicitness. The previous pin
# `prisma@5.22.0` rejects the Prisma 7 schema with
# "Argument 'url' is missing in data source block 'db'" — bumped
# to 7.8.0 in lockstep with the migration that landed in #140.
echo ""
echo "→ Applying database migrations..."
./node_modules/.bin/prisma migrate deploy --schema=./prisma/schema
echo "✓ Migrations applied"

# ── 2. Create upload directory if missing ──
FILE_DIR="${FILE_STORAGE_ROOT:-/data/uploads}"
mkdir -p "$FILE_DIR" 2>/dev/null || true
echo "✓ Upload directory ready: $FILE_DIR"

# ── 3. Publish the ZarnoBorsa fetch bundle for its own container ──
#
# #3081. `dist/zarnoborsa-fetch.mjs` runs in a Playwright container, because
# Playwright may not be in THIS image — `verify-image-deps.mjs` fails the
# build if it is, and exists because `npm prune --omit=dev` cannot remove it.
#
# COPIED on every start rather than shared as a volume mounted over `dist/`.
# A named volume is populated from the image once and then SHADOWS it, so a
# Watchtower update would leave the fetch container running the bundle from
# whichever image first created the volume — stale for ever, silently, with
# the only symptom being prices that stop moving. Copying here means a
# recreate republishes it, which is exactly when it should.
#
# Best-effort: the directory is absent on a deployment that does not run the
# fetch container, and a missing price feed must never stop the app booting.
ZB_SHARE="${ZARNOBORSA_SHARE_DIR:-/opt/share/dist}"
if [ -d "$ZB_SHARE" ] && [ -f dist/zarnoborsa-fetch.mjs ]; then
    cp dist/zarnoborsa-fetch.mjs "$ZB_SHARE/zarnoborsa-fetch.mjs" 2>/dev/null \
        && echo "✓ Published zarnoborsa-fetch.mjs to $ZB_SHARE" \
        || echo "… could not publish zarnoborsa-fetch.mjs (continuing)"
fi

# ── 4. Start Next.js ──
echo ""
echo "→ Starting Next.js server on port ${PORT:-3000}..."
exec node_modules/.bin/next start -p "${PORT:-3000}" -H "${HOSTNAME:-0.0.0.0}"
