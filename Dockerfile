# ─── Stage 1: Dependencies ─────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

# `npm ci` — strict, deterministic install: installs exactly the
# package-lock.json tree and fails if it is out of sync with
# package.json. Never `npm install` in an image build (it can mutate
# the lockfile and resolve fresh versions, defeating reproducibility).
COPY package.json package-lock.json ./
# `patches/` MUST be present before `npm ci`, because the `postinstall`
# hook is `patch-package` and it resolves patches relative to the CWD.
# Without this COPY the build logged "No patch files found" and produced
# an UNPATCHED node_modules — which stage 2 then inherits and stage 3
# ships. The `COPY . .` in the builder stage brings patches/ in, but that
# is AFTER the install, and nothing re-runs patch-package.
#
# This silently shipped the CSP-nonce bug that patches/next+*.patch
# exists to fix: `createComponentStylesAndScripts` rendered a <script>
# with no nonce, which script-src 'nonce-…' 'strict-dynamic' blocks. It
# was invisible because the patch file WAS in the repo and CI asserted
# against the local node_modules (where postinstall does see patches/),
# so only the image was affected. Guarded by
# tests/guards/csp-nonce-component-scripts-patch.test.ts.
COPY patches ./patches
RUN npm ci

# ─── Stage 2: Builder ──────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build Next.js (skip env validation — real vars provided at runtime).
# --webpack: build with webpack, NOT Next 16's default Turbopack. The
# strict production CSP (script-src 'nonce-…' 'strict-dynamic', no
# unsafe-eval) needs the bundler runtime to put the nonce on every
# dynamically-loaded chunk. Webpack does (via __webpack_nonce__ →
# script.setAttribute('nonce', …)); Turbopack's runtime sets no nonce and
# relies on strict-dynamic propagation, which left some dynamic chunks
# blocked by script-src-elem. See docs/implementation-notes/2026-06-05-csp-webpack-bundler.md.
ENV SKIP_ENV_VALIDATION=1
ENV NEXT_TELEMETRY_DISABLED=1
# Public build-time env — Next inlines NEXT_PUBLIC_* into the client
# bundle at `next build`, so the parcel-map basemap key must be present
# HERE (a runtime env var is too late — the value is already baked).
# `.dockerignore` excludes `.env*`, so this is the only injection point:
# pass it with `--build-arg NEXT_PUBLIC_MAPTILER_KEY=…` (or compose
# `build.args`). Defaults empty ⇒ MapCanvas falls back to the demo
# basemap, so builds without a key (CI, contributors) still work.
ARG NEXT_PUBLIC_MAPTILER_KEY=""
ENV NEXT_PUBLIC_MAPTILER_KEY=$NEXT_PUBLIC_MAPTILER_KEY
ARG NEXT_PUBLIC_MAP_BASEMAP_STYLE="hybrid"
ENV NEXT_PUBLIC_MAP_BASEMAP_STYLE=$NEXT_PUBLIC_MAP_BASEMAP_STYLE
# `next build` OOMs on the ~2 GB default V8 heap when it can't reuse a cached
# build layer (any app-source change) on the private-repo CI runners — exit
# 134 / SIGABRT. Lift it here as the CI workflow's build/jest jobs do; the
# ci.yml build step's fix doesn't reach this in-container build.
ENV NODE_OPTIONS="--max-old-space-size=8192"
RUN npx next build --webpack

# Build the standalone BullMQ worker + scheduler bundles. esbuild is
# a devDependency, so this MUST run before the prune below. Produces
# self-contained dist/worker.mjs + dist/scheduler.mjs (node_modules
# external) — the `worker` compose service runs these.
RUN npm run build:worker

# Prune dev dependencies before the runner stage copies node_modules.
# Without this, the runtime image carries ts-jest, semantic-release,
# playwright, and friends — including their transitive CVEs (e.g.
# handlebars@4.7.8 via ts-jest) — which Trivy then reports as
# production vulnerabilities even though the runtime never executes
# those modules.
RUN npm prune --omit=dev

# Drop the Next.js webpack build cache before the runner stage copies
# `.next`. `.next/cache` holds incremental-compilation artefacts used
# only by a subsequent `next build` — `next start` never reads it. On
# this app it is ~1 GB of dead weight in the runtime image. Removing
# it here keeps it out of the `COPY --from=builder /app/.next` layer.
RUN rm -rf .next/cache

# ─── Stage 3: Runner ──────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# System deps for Prisma
RUN apk add --no-cache openssl

# Non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy build output.
#
# Every COPY carries `--chown=nextjs:nodejs` so the files land already
# owned by the runtime user. The previous `RUN chown -R nextjs:nodejs
# /app` at the end of this stage rewrote every one of these files in a
# SEPARATE image layer — because the COPYs create root-owned files and
# a recursive chown changes the metadata of all of them, Docker's
# overlay filesystem duplicated the ENTIRE /app tree (~4.4 GB) into the
# chown layer. Chowning at COPY time writes the files once, with the
# right owner, in the copy layer itself — no duplicate.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
# Prisma 7 — connection URL config moved out of `datasource db {}`
# in `prisma/schema/base.prisma` into `prisma.config.ts`. The CLI
# (`prisma migrate deploy` from the entrypoint) reads URLs from
# this file. Without it, deploy fails with
# "datasource.url property is required in your Prisma config file".
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/entrypoint.sh ./scripts/entrypoint.sh
# The compiled BullMQ worker + scheduler bundles — run by the
# `worker` compose service, a separate process from `next start`.
COPY --from=builder --chown=nextjs:nodejs /app/dist ./dist
# DejaVu Sans TTFs for Cyrillic PDF generation (БАБХ ДНЕВНИК). This is a
# non-standalone build (ships .next/public/node_modules only), so the font
# assets read at runtime via process.cwd() must be copied explicitly.
COPY --from=builder --chown=nextjs:nodejs /app/src/lib/pdf/fonts ./src/lib/pdf/fonts

# Ensure entrypoint is executable and upload dir exists. `/app` is
# already owned by nextjs:nodejs via the per-COPY --chown above, so we
# only chown the freshly-created upload dir here — NOT a recursive
# `chown -R /app`, which duplicated the whole tree into its own layer.
RUN chmod +x ./scripts/entrypoint.sh && \
    mkdir -p /data/uploads && \
    chown nextjs:nodejs /data/uploads

# Strip the bundled npm CLI from the RUNTIME image.
#
# Nothing here needs it: the entrypoint runs the vendored
# ./node_modules/.bin/prisma, and the worker/scheduler run `node
# dist/*.mjs` directly. What it does carry is npm's own dependency
# tree (tar, brace-expansion, js-yaml, …) living at
# /usr/local/lib/node_modules/npm — which is where Trivy's CRITICAL
# tar advisory (CVE-2026-59873, gzip-bomb DoS) and its HIGH siblings
# come from. They are unreachable from application code and
# unfixable via our package-lock, because they belong to the base
# image's npm, not to us.
#
# Deleting the CLI removes the finding at the source rather than
# suppressing it in .trivyignore, and shrinks the runtime image.
# Node itself is untouched. If a future runtime step genuinely needs
# a package manager, prefer vendoring the tool over restoring npm.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

ENTRYPOINT ["./scripts/entrypoint.sh"]
