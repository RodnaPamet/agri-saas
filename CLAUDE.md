# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev               # Start Next.js dev server
npm run build             # Validate env + build
npm run typecheck         # tsc --noEmit
npm run lint              # ESLint + the ceiling gate (scripts/lint-ceiling.ts)
npm run lint:raw          # Plain `eslint .`, no ceiling
npm run lint:fix          # Plain `eslint . --fix`

# Database
# The Prisma schema lives in a folder, not a single file — 21 files:
#   base (generator + datasource, never redeclared elsewhere), enums, auth,
#   work, files, assets, automation, audit, schema (transitional, empty),
#   plus one per agri domain (agriculture, agro, ai, exchange, grain,
#   insurance, inventory, journal, knowledge, market, planning, promotions).
#   `compliance.prisma` / `vendor.prisma` / `processes.prisma` were deleted
#   by GRC teardown phase 3 (#567) — do not recreate them.
# Prisma concatenates every `.prisma` file in the folder at generate /
# migrate time. No preview flag is involved: `prismaSchemaFolder` went GA in
# Prisma 6 and is gone entirely in Prisma 7 (we pin ^7.10.0), so base.prisma's
# `generator client` block carries no `previewFeatures` — the folder path
# comes from `schema:` in `prisma.config.ts`. See prisma/schema/README.md.
npm run db:generate       # Regenerate Prisma client after schema changes
npm run db:push           # Push schema to DB (no migration file)
npm run db:migrate        # Create + apply a named migration interactively
npm run db:reset          # Drop, recreate, and reseed the DB

# Tests
npm test                  # Jest (parallel)
npm run test:ci           # Jest (sequential, no coverage) — used by
                          # `scripts/ci-local.mjs`, NOT by CI: the CI `test`
                          # job invokes jest directly with
                          # `--runInBand --coverage --shard=i/6`
npm run test:coverage     # Jest with coverage report
npm run test:e2e          # Playwright browser tests

# Run a single Jest test file
npx jest tests/unit/golden-path.test.ts

# Run a single Playwright test file
npx playwright test tests/e2e/core-flow.spec.ts

# Docker (local dev stack — FIVE services, and docker-compose.yml declares no
# `profiles:`, so this starts all of them: postgres (PostGIS + pgvector, built
# from deploy/postgres/Dockerfile, :5437 for migrations), pgbouncer (the
# runtime DATABASE_URL, :5436), redis, clamav, ollama).
docker-compose up -d
# Ollama ships no model — pull the dev default once:
#   docker compose exec ollama ollama pull qwen3:1.7b
```

## Production VM

The production deployment runs on a single GCP VM, and **Claude has
`gcloud` access to it** — project `hazel-design-419410`, instance
**`agrent`**, zone `europe-west1-b`. It is served at
**`https://app.agrent.bg`** and at `https://35-187-80-26.sslip.io` —
the live Caddy site block carries both names, though the repo copy
(`deploy/Caddyfile`) listed only the sslip.io one until #842, because
`deploy/apply.sh` does not copy that file and `deploy/check-drift.sh`
does not hash it:

```bash
gcloud compute ssh agrent --zone europe-west1-b --command "…"
```

The VM hosts a Docker Compose stack at `/opt/agrent/`
(`docker-compose.vm.yml` — 7 services: app, worker, watchtower,
caddy, pgbouncer, redis, db). Docker commands on the VM need `sudo`.
`/opt/agrent/.env` and the Redis `--requirepass` value are real
secrets — **never echo them**.

**The `health-check` schedule is load-bearing — do not "tidy it away".**
`worker` reported `health=none` next to four healthy siblings until #809,
because a wedged worker (blocked event loop, dead Redis connection, every
concurrency slot held by a hung handler) keeps its container `running` with
the web tier green. The container healthcheck runs
`dist/worker-healthcheck.mjs`, which READS a Redis key that `scripts/worker.ts`
refreshes from BullMQ's `completed` event — never a `setInterval`, which keeps
ticking through a severed connection and would report a wedged worker as
healthy. So a pass means a job was pulled, run and returned.

Events need jobs, which is why `health-check` runs every two minutes. It looks
like a no-op ping — its executor had sat in `executor-registry.ts` since the
queue was built with **nothing ever dispatching it** — but deleting that
schedule makes a perfectly HEALTHY idle worker report unhealthy. It also means
a green healthcheck proves the SCHEDULER's repeatables are still registered,
since `scheduler.mjs` runs before `worker.mjs` in the same command. The key's
TTL is 8 minutes against that 2-minute cron — four missed beats — so the
container does not flap on one slow one.
`tests/guards/worker-heartbeat-wiring.test.ts` pins all four links, and
`tests/integration/bullmq-real-api.test.ts` EXECUTES the chain against a real
Redis, because a guard asserting source text proves nothing about behaviour.

**Ordering matters when changing it:** the image must carry the probe BEFORE
the compose healthcheck runs it, or the worker is marked unhealthy for a
missing file — a signal wrong in the alarming direction, worse than the
`health=none` it replaces. Merge → GHCR publishes → Watchtower pulls → verify
`dist/worker-healthcheck.mjs` exists IN THE RUNNING CONTAINER → then
`deploy/apply.sh`. Note `docker image inspect …:latest` on the VM reads the
LOCAL cache, not the registry; compare digests or read Watchtower's log.

**The repo is canonical; drift is DETECTABLE, not policy.** The compose
STRUCTURE lives at **`deploy/docker-compose.vm.yml`** in the repo and is
kept byte-identical to the VM. Watchtower auto-updates ONLY the `app` +
`worker` *images* (never the compose file); every STRUCTURAL change — a
new service, a resource limit, an env addition — lands in the repo file
and is applied with **`deploy/apply.sh`** (backup → scp → `docker compose
config` → `up -d` → health-verify `/api/readyz` + `/manifest.webmanifest`
+ `/sw.js`). **`deploy/check-drift.sh`** sha256-compares the repo file
against the VM (run it weekly); a mismatch means the VM was hand-edited
(reconcile it back into the repo) or the repo changed without an apply.
`deploy/env.prod.example` lists the prod-required env keys (parity with
`src/env.ts` is guarded by `tests/guardrails/deploy-env-parity.test.ts`).

**The operator runbook is `docs/runbooks/production-vm.md`** — the four
axes (deploy, rollback, scaling, backup/restore) with commands verified
against the running VM, and an inventory of what this deployment does
NOT have, because several docs still describe an EKS/AWS stack that was
never provisioned. `docs/incident-response.md` carries per-symptom
playbooks; read its banner first — only §1 and §6 have been corrected.
`tests/guardrails/vm-runbook-commands.test.ts` holds the runbook,
including a derived check that every repo path it names exists.

**Production outages are DETECTED and emailed; there is no rota (#854).** Since
2026-09-17 a GCP Cloud Monitoring uptime check
(`agrent-readyz-oKY0R5q09QU`) probes `https://app.agrent.bg/api/readyz`
every 60s from six regions, requiring a 2xx whose body contains
`"status":"ready"` — so a dependency outage fails it, not just a dead
process. Alert policy `agrent production is not ready (#854)` fires on
sustained failure from more than one region.
**That matcher does not say WHOSE readiness it is**, and the sibling
`inflect-compliance` emits the identical string. From 12:00–17:50 UTC on
2026-09-27 `app.agrent.bg` was served intermittently by a third app
(#1117/#1143) and the check went red only because that app happened not to
emit it — measured from the check's own series: 62 five-minute buckets with
>1 region failing, one unbroken ~5h50m run, zero on the six surrounding days.
So `/api/readyz`, `/api/livez` and `/api/health` now emit
`"service":"agri-saas"` from `SERVICE_ID` (`src/lib/service-identity.ts`) —
a LITERAL, because `package.json` still reads `inflect-compliance` and
deriving it from there would match the sibling exactly. **Both steps are DONE** (2026-09-29): the field
shipped in #1156, and the matcher was tightened to `"service":"agri-saas"`
once the live body carried it — verified afterwards at a 1.00 passing
fraction across all six probe regions. Keep that ORDER for any future change
to the probed body: serve it, verify on the live response, then require it.
Tightening first fails every probe and pages for an outage you caused.
That same measurement settles a question that was open: a deploy's restart
window CANNOT trip this alert (a restart is under a minute; the condition
needs >1 region sustained over 300s), so no deploy-suppression is needed. Detection latency is
therefore about two minutes, and a detection time MAY now be written
down — but only that one. An email notification channel is attached, and on
2026-09-17 it was proved to deliver END TO END rather than assumed: a
throwaway uptime check pointed at a path that returns 401 by design,
routed to the SAME channel, produced a real alert email, and both
throwaway resources were then deleted. The control that makes that
result readable was asserting the throwaway check was genuinely
FAILING (8 failing samples across 3 probe regions) — otherwise "no
email" and "the test never fired" are the same observation. GCP
reports no `verificationStatus` on an email channel, so nothing short
of a delivered message settles it. **There is still no rota and no pager** — one
address, one person, email — so
`docs/slos.md` SLO 7's 4 hours is still time-to-restore from the moment
a person starts. **#981 accepted one inbox as the posture** rather than
building a rota, so `docs/incident-response.md` now DESCRIBES it: the
15-minute PagerDuty acknowledge is gone from the severity table instead
of being annotated as aspirational, because a caveat under a wrong table
loses to the table for a reader mid-incident. Do not write an acknowledge or
alert-to-human time into any doc: an inbox is not an on-call rota. `infra/alerts/external-uptime.yml` records what runs
and why the probe is `readyz` rather than `livez` — the previous spec's
reasoning was imported from a multi-pod Kubernetes deployment and is
false for a single VM with one app container.

**`deploy/Caddyfile` is a record, not a deployment.** `deploy/apply.sh`
does not copy it and `deploy/check-drift.sh` does not hash it, so the
live `/opt/agrent/Caddyfile` is edited by hand and nothing detects the
two diverging. The `caddy` service declares neither `env_file` nor
`environment`, so no `{$VAR}` in that file can be supplied by this repo.
**One divergence is known and deliberate** — compared on the VM
2026-09-10, the two files differ in exactly one token: the live ACME
contact defaults to the operator's personal mailbox, and the repo keeps
the role address `admin@agrent.bg`. **This repository is public. Never
paste that personal address into a tracked file to make a doc
"accurate"** — reconcile by changing the VM, or by giving the `caddy`
service an environment that supplies `ACME_EMAIL`. The field routes
Let's Encrypt expiry notices only; nothing about TLS depends on it.
`tests/guardrails/caddyfile-divergence.test.ts` holds all of that,
including that every address in `deploy/Caddyfile` stays on the
`agrent.bg` role domain (#842).

**When a runtime change must be applied to the VM** — a one-off job run,
inspecting container logs, a manual restart — execute it directly via
`gcloud compute ssh`; do not ask the operator to do it by hand. But a
**structural** compose change goes through the repo + `deploy/apply.sh`,
NOT a hand-edit on the VM. Back up any file before editing it (the
`<file>.bak.<timestamp>` convention).

**Backups: one disk, one daily snapshot — per stack.** Postgres lives
in a local Docker volume on each instance's boot disk (`agrent-pgdata`
on agrent, `inflect_pgdata` on inflect-compliance) — no managed
database, no replica. Each disk carries a GCE snapshot schedule
(`agrent-daily-snapshot` and `inflect-daily-snapshot`, BOTH 02:00 UTC — the
inflect policy's own `description` claims a 30-minute stagger but its
`startTime` is 02:00, and its snapshots land ~02:17, AHEAD of agrent's
~02:29; the stagger is intent, not configuration, and
`docs/backup-restore.md` still repeats the 02:30 figure. Both 14-day
retention, `eu` storage, `keep-auto-snapshots`). So **RPO
is up to 24 hours**, which is now also what `docs/slos.md` SLO 6
*targets* — the 1-hour target it carried until 2026-09-10 was retired
(#842) rather than met, and SLO 6 keeps that history. Snapshots are
crash-consistent (Postgres replays WAL on restore).
Restores are drilled monthly by `infra/scripts/restore-test-gcp.sh`
via `.github/workflows/restore-test.yml`, which runs it once per
target from a job matrix — it boots a real Postgres over the restored
data directory rather than just checking a snapshot exists.
**The drill's validation battery runs on the VM, from a string the
script builds — and that heredoc's delimiter is QUOTED (`cat
<<'REMOTE'`) on purpose.** A quoted heredoc expands nothing, so the
body's own prose cannot execute on the machine building it; the five
values the VM cannot know (`PGDATA_VOLUME`, `STACK_DIR`, `PG_IMAGE`,
`DB_USER_HINT`, `DB_NAME_HINT`) are injected ahead of it by a
`printf %q` prelude. Never un-quote it and never write a host value
into the body — while it was unquoted, markdown backticks in the
body's COMMENTS were command substitutions that ran on the GitHub
runner and left the drill dead for a month with the restore never
attempted (#1179/#1212/#1225). `docs/backup-restore.md` →
"Editing the remote half" is the operator-facing rule;
`tests/guards/shell-heredoc-no-live-backticks.test.ts` pins the
delimiter and `tests/guards/restore-drill-remote-script.test.ts`
executes the drill against a stubbed `gcloud` and asserts the payload
body is byte-identical to the heredoc source. The
`DATA_ENCRYPTION_KEY` sits on the same disk as the data it protects
(`/opt/agrent/.env`; `/opt/inflect/.env.prod`), so a whole-disk restore
recovers key and ciphertext together; a pgdata-only copy is NOT a
complete backup. **See `docs/backup-restore.md`** for the operator
runbook. Before 2026-08-01 NEITHER stack had any backup at all, and the
monthly restore test drilled AWS RDS — infrastructure neither product
runs.

**A snapshot restore is not the only rollback, and it is the wrong one
for a bad migration.** `prisma migrate deploy` runs from
`scripts/entrypoint.sh`, so shipping an image is what applies a
migration — and pinning Watchtower back reverts the CODE while leaving
the SCHEMA migrated. After a rename or a drop the previous image is
querying objects that no longer exist, so an image-only rollback fails
outright and the only remaining lever is a snapshot: up to 24 hours of
farm data to undo a UI regression. `deploy/rollback/` holds hand-written
inverse scripts for exactly those migrations (one transaction, and each
deletes its own `_prisma_migrations` row so a later roll-forward
re-applies rather than silently skipping). **Add one whenever a
migration would break the previous image** — renames a table / column /
enum value, drops a column still written, or rewrites persisted data
still read. Plain additive migrations need none. See
`deploy/rollback/README.md`. Two guards hold this at different depths:
`tests/guards/destructive-migration-has-inverse.test.ts` DERIVES the
destructive set by scanning every `migration.sql` for `DROP TABLE` /
`DROP COLUMN` / `DROP TYPE` / `RENAME TO` / `RENAME COLUMN` and requires
each to have a `.down.sql` (one transaction, deletes its own
`_prisma_migrations` row), with pre-convention migrations sitting in a
`PREDATES_RULE` baseline that is not meant to grow; and
`tests/guards/rename-rollback-inverse.test.ts` holds the rename
bijection for the one migration it names.

> **The `inflect-compliance` VM is NOT this product and is NOT idle.**
> The same GCP project runs a second GCE instance, `inflect-compliance`
> (`/opt/inflect/`, host `inflect.34-140-180-255.sslip.io`), serving a
> DIFFERENT product from a DIFFERENT repo — its image is
> `ghcr.io/rodnapamet/inflect-compliance` (verified on the VM itself),
> which this repo never pushes to: `ghcr-publish.yml` and `deploy.yml`
> both build `ghcr.io/${{ github.repository }}`, i.e.
> `ghcr.io/rodnapamet/agri-saas`. **The GHCR org is SHARED** — after the
> 2026-08-03 move to `RodnaPamet` (see
> `docs/implementation-notes/2026-07-04-vm-auto-deploy.md`) only the image
> NAME separates the two products, so read the WHOLE path before
> concluding an image is ours. It is live: Watchtower still
> auto-deploys to it, and as of 2026-08-01 its database held 7 tenants,
> 18 users and audit rows written that day. Earlier wording here said
> the VM was "being retired as part of the Agrent rebrand"; that was
> intent, not fact, and reading it as fact nearly led to deleting a VM
> with live users on it. **Check what an instance is actually running
> before acting on a doc that says it is on its way out.** Beyond the
> GCP project, the GHCR org and the backup tooling (see
> `docs/backup-restore.md`), this repo shares nothing with it.
> `deploy/docker-compose.prod.yml` is the older inflect-branded manifest,
> retained because the GAP-03 encryption-key guardrail asserts its
> `:?`-fail-fast syntax — it still pins the PRE-move
> `ghcr.io/inflect-compliance/inflect-compliance` path, which nothing
> runs; the live agrent stack uses `docker-compose.vm.yml`.

## Architecture

### Framework baseline

**Next.js 16.3.3** (App Router) + **React 19.2** + **TypeScript 6.0**.
`next` is pinned EXACTLY (no caret) and is deliberately EXCLUDED from the
Dependabot `production` group, so it arrives as its own PR. We CARRIED
`patches/next+<version>.patch` and every bump required regenerating it; since
**16.3.5 fixes the nonce upstream** there is no patch to regenerate, but a
bump must still re-verify the property — see **"Bumping Next"** immediately
below.
The React 18 → 19 bump (#67) is complete: React 19 removed
`propTypes`, function-component `defaultProps`, string refs and
legacy context — the codebase carries none of those.
`forwardRef` still works in React 19 (which also accepts `ref` as a
plain prop); existing `forwardRef` call sites are fine and
modernising them is optional.
GAP-05 (2026-04-25) first migrated off the vulnerable `next@^14.2.0` line —
the two HIGH advisories (Image Optimizer DoS, RSC request
deserialization) were unfixable in 14.x. CI security gates restored
to their pre-workaround strictness, and on 2026-05-12 tightened one
further notch: npm audit blocks on **MODERATE+** (production deps),
Trivy blocks on `CRITICAL,HIGH` (container scan). The structural
ratchet at `tests/guardrails/security-gate-strictness.test.ts` fails
CI if either gate is silently re-lowered (`moderate` → `high` /
`critical`, or `CRITICAL,HIGH` → `CRITICAL`) or `next` is downgraded
back to 14.x.

**Bumping Next — the CSP nonce patch. FIXED UPSTREAM in 16.3.5; the patch is
gone.** Next's `createComponentStylesAndScripts` built a `<script>` with no
`nonce`, which `script-src 'nonce-…' 'strict-dynamic'` blocks. That was true
from the Next 14 line through **16.3.4**, and we carried
`patches/next+<version>.patch` to add it.

**16.3.5 carries the nonce itself**, in both readable sources and all four
prod bundles, so `patches/` now holds no patch — see `patches/README.md` for
how that was verified (pristine `npm ci --ignore-scripts`, the guard's own
regexes, and the ordering tell: our patch inserted `nonce` BEFORE `key:`,
upstream puts it AFTER). Do not re-add a patch to a version that does not
need one; you would be patching a fix.

**What did not change is the property, or who checks it.** The guarantee was
never "a patch file exists" — #929 is precisely a patch present in the tree
and green in CI while the image shipped unpatched for ~7 weeks. It is
`tests/guards/csp-nonce-component-scripts-patch.test.ts` (local
`node_modules`) and `scripts/verify-image-patches.mjs` (inside the BUILT
IMAGE), both asserting an ABSENCE of unnonced sites plus a positive control.
The patch machinery stays wired — `postinstall: patch-package`, and the
Dockerfile COPYs `patches/` before `npm ci` without `--ignore-scripts` — so a
future regression is a patch away.

**If a future Next regresses**, the procedure below is the one to follow. The
guard requires any patch present to match the INSTALLED next version, because
a patch silently drifting against a newer Next is how #929 happened:

1. `npm install next@<v> --save-exact`, delete the old patch file.
2. Add `nonce: ctx.nonce` to the component-script element in **all SIX**
   files — the two readable sources (`dist/server/...` + `dist/esm/server/...`)
   AND all four `dist/compiled/next-server/app-page*.runtime.prod.js` bundles.
   **The bundles are what `next start` executes**; patching only the readable
   sources is cosmetic and is exactly what #929 shipped for ~7 weeks.
3. `npx patch-package next`, then CONFIRM the patch names six files.
   patch-package regenerates by diffing a FRESH download, so bundle hunks
   vanish silently after a version bump — that is the #929 failure verbatim.
4. Run `tests/guards/csp-nonce-component-scripts-patch.test.ts` AND the
   end-to-end check, `tests/e2e/security/csp-nonce.spec.ts`. The guard reads
   bytes in `node_modules`; the spec renders real pages under `next start` and
   asserts every executable `<script>` in the SERVER-RENDERED HTML carries the
   nonce from that same response. Only the second one can catch an unnonced
   script that arrives for a reason other than our patch failing to apply.

In each minified bundle the injection is `,nonce:<ctx>.nonce` immediately
after ``key:`script-${…}` ``, anchored on the `${<ctx>.assetPrefix}` src
interpolation in the same object literal. Minifier-assigned names change per
release, so re-derive them; do not copy the letters from a previous patch.

**Two sites match that shape and only one is ours.** The sibling
`getLayerAssets` builds an identical-looking element and has carried a nonce
upstream all along — which is why a "does `nonce:` appear somewhere" check is
useless: the bystander satisfies it. Both the guard and
`scripts/verify-image-patches.mjs` therefore assert the **absence** of an
unnonced site, plus a **positive control** that the fingerprint still matches
something at all (16.2.x had two matching sites per bundle; 16.3.1 has one,
because `getLayerAssets` hoisted its `src` to a local). Without that control
the check fails OPEN on the exact release where the patch most likely broke.

`scripts/verify-image-patches.mjs` runs inside a BUILT IMAGE — the Dockerfile
must COPY `patches/` before `npm ci`, without `--ignore-scripts`, or the image
ships unpatched while CI stays green.

> **It runs in TWO places, and they are not the same image.** CI's `docker`
> job builds one, gates it, and DISCARDS it; that build passes no
> `build-args` (so an empty `NEXT_PUBLIC_MAPTILER_KEY`) and comes from the
> MUTABLE `node:22-alpine` tag, so it is a twin rather than the artifact.
> Read a green CI run as *"an image built from this commit was patched"*,
> never as *"production is patched"*.
>
> Since #826 `ghcr-publish.yml` runs the same three gates against the image
> it is about to push, then re-reads the digest FROM THE REGISTRY and
> re-verifies the pulled bytes, so a gate cannot pass by failing to see.
> That is the signal that describes production. CI's `docker` job keeps its
> copy on purpose: it gates the PR, where feedback belongs.
>
> This paragraph twice claimed `verify-image-patches.mjs` was "the only one
> of these signals that describes production". It was not, and #838 retracted
> it before #826 made it true.

**In-image verification is now the house pattern for any claim about what
shipped**, and there are two such scripts: that one, and
`scripts/verify-image-deps.mjs` (#801), which asserts no test tooling reaches
the runtime image. The second exists because `npm prune --omit=dev` CANNOT
remove playwright — `next` declares `@playwright/test` as an OPTIONAL
peerDependency, so npm resolves it through a PRODUCTION edge and marks every
node `dev: false`. The Dockerfile's prune comment claimed for two releases that
the prune removed it. Both scripts assert a POSITIVE CONTROL alongside the
absence they check, because "not present" and "I resolved the wrong tree" are
the same observation and the second fails toward green.

Async-request-API: GAP-05 is **complete**. Every dynamic route
handler under `src/app/api` types `params` as `Promise<…>` and
`await`s it (the Next 16 contract, enforced by
`tests/guards/async-params-route-typing.test.ts`), the runtime
transparent-await shim was removed from `withApiErrorHandling`, and the
last vestige — the `AsyncifyParams` type transform that bridged the
sync-params middleware to the Promise-shaped export — is also gone.
`requirePermission` now resolves the params Promise once and forwards
the RESOLVED params to its inner handler (so handlers read `params.foo`
directly), and its returned `RouteHandler` types `params` as a Promise,
so `withApiErrorHandling` exports the Next-shaped signature with no type
bridge. Tests invoke wrapped routes with `{ params: Promise.resolve(...) }`.
See `docs/implementation-notes/2026-04-25-gap-05-next15-migration.md`
and `docs/implementation-notes/2026-06-17-gap-05-asyncify-removal.md`.

### Layer Structure

```
src/app/api/           → Next.js route handlers (HTTP boundary only — parse input, call usecases, return responses)
src/app-layer/usecases/→ Business logic orchestration (thin: validate → call policy → call repo → emit event)
src/app-layer/policies/→ Authorization checks (assertCanRead/Write/Admin/Audit) — always called before data access
src/app-layer/repositories/ → All Prisma queries (every query must filter by tenantId)
src/app-layer/jobs/    → BullMQ job definitions (background tasks)
src/app-layer/services/→ Cross-cutting domain services (canvas↔AutomationRule sync, draft/publish lifecycle, governance graph, SLA computation)
src/app-layer/events/  → Audit event writers (immutable, hash-chained audit trail)
src/lib/               → Shared infrastructure (auth, observability, storage, rate-limiting, permissions)
src/components/        → React components

prisma/schema/         → Multi-file Prisma schema (GAP-09):
                            base.prisma         — generator + datasource (sole owners)
                            enums.prisma        — every shared enum
                            auth.prisma         — Tenant/User/Membership/Session/SSO/Billing
                            work.prisma         — Task family (THE farm task system)
                            files.prisma        — FileRecord + Evidence + EvidenceReview
                            assets.prisma       — Asset + maintenance + key sequence
                            automation.prisma   — AutomationRule/Execution + Notification +
                                                  Integration + the process-map models
                            audit.prisma        — AuditLog + OrgAuditLog (PLATFORM)
                            schema.prisma       — transitional sediment file (currently empty)
                          …plus one file per agri domain (agriculture, agro, ai,
                          exchange, grain, insurance, inventory, journal,
                          knowledge, market, planning, promotions).

                          THE GRC TEARDOWN IS COMPLETE. This codebase was spun out
                          of a GRC SaaS; the inherited surface was removed in three
                          phases — see
                          docs/implementation-notes/2026-08-12-grc-teardown-plan.md
                          for the KILL/KEEP lists and
                          docs/implementation-notes/2026-08-15-grc-teardown-phase3.md
                          for the schema drop. `compliance.prisma`, `vendor.prisma`
                          and `processes.prisma` NO LONGER EXIST, and `audit.prisma`
                          keeps only the two platform audit-log models. Do not
                          recreate those files — a new model goes in the matching
                          agri domain file.
                          See prisma/schema/README.md for the full layout + conventions.
                          Adding a new model: pick the matching domain file. Generator
                          and datasource ONLY live in base.prisma — Prisma rejects
                          duplicates across the folder.
```

### Request Context (`RequestContext`)

Every usecase and repository receives a `RequestContext` (defined in `src/app-layer/types.ts`) containing `userId`, `tenantId`, `role`, `permissions`, and `appPermissions`. This is propagated via AsyncLocalStorage — never thread through manually. Access via `getRequestContext()` from `src/lib/observability`.

### Multi-Tenant Isolation

Two layers, both load-bearing:

1. **PostgreSQL Row-Level Security** (Epic A.1). Every tenant-scoped
   table has `tenant_isolation` + `superuser_bypass` policies and
   `FORCE ROW LEVEL SECURITY`. Tenant context is bound per-transaction
   via `runInTenantContext` from `@/lib/db/rls-middleware`. The DB
   returns zero rows if the context is unset on an `app_user`
   session — isolation is architecturally impossible to bypass by
   accident. **See `docs/rls-tenant-isolation.md`** for the full guide
   including the bypass model, the policy shapes for nullable /
   ownership-chained tables, and how to add a new tenant-scoped model.

2. **Application-layer `tenantId` filters** — every repository query
   also filters by `tenantId`. Defence in depth; makes error messages
   clear when the app is working correctly.

Guard tests: `tests/guardrails/rls-coverage.test.ts` (DB-backed — CI
fails if a tenant table is missing RLS) and
`tests/unit/tenant-isolation-structural.test.ts` (code-pattern scanner).

### API Rate Limiting (Epic A.2 + GAP-17)

Three tiers, each scoped to a different traffic class. Operator runbook:
[`docs/rate-limiting.md`](docs/rate-limiting.md).

- **Mutation tier** — `API_MUTATION_LIMIT` (60/min) on POST/PUT/DELETE/PATCH
  for every route wrapped in `withApiErrorHandling`, keyed `(IP, userId)` BY
  DEFAULT. The wrapper resolves the userId itself; `getUserId` is an OVERRIDE
  for the rare route whose budget should be bounded by a TARGET user. Stricter
  presets (`LOGIN_LIMIT`, `SIGNUP_LIMIT`, `API_KEY_CREATE_LIMIT`,
  `EMAIL_DISPATCH_LIMIT`) are applied per route.
- **`getBucket` caps a SHARED resource** and REPLACES the `(IP, userId)` portion
  of the key — appending it keeps the per-caller split and changes nothing.
  Reach for it when the cost lands on somebody ELSE. **Derive the bucket from
  the URL**: the resolver runs BEFORE the handler, so a database read there is
  work an abusive caller can compel inside the check meant to stop them. It
  fails CLOSED onto the per-caller key.
- **Read tier** — `API_READ_LIMIT` (120/min) at the Edge for tenant-scoped
  GETs, keyed `(IP, userId, tenantSlug)`. Health probes and `/api/docs` are
  excluded: operators must keep monitoring access during an attack.
- **Auth tier** — tiered per-endpoint at the Edge, keyed `(IP, ua-hash)`
  because it runs pre-authentication.
- **Storage is Upstash with an in-process Map fallback**, degrading
  fail-to-local on a Redis error, never fail-open. **The Map is only correct on
  a single node** — behind a load balancer the real limit is `N × preset`, and
  the live stack pins `RATE_LIMIT_MODE: memory`. That is the first thing to
  change when a second replica appears.
- 429s carry `Retry-After` + `X-RateLimit-*` + `x-request-id`.
  **Body never contains IP/userId/tenantSlug.** Presets live in
  `src/lib/security/rate-limit.ts`.

**See [`docs/epic-a-security.md`](docs/epic-a-security.md)** for the reasoning,
including why 343 of 346 wrapped routes once keyed `anon`.

### Cold-start data cost (Roadmap-6 P3)

Three seams keep a PWA relaunch cheap on rural LTE — see
`docs/implementation-notes/2026-07-11-cold-start-datacost.md`.

- **Persistent SWR cache.** `providers.tsx` mounts ONE
  `<SWRConfig provider>` via `SWRPersistenceProvider`, backed by the
  disk-backed Map in `src/lib/swr/persistent-cache.ts` (localStorage
  sync-hydrate + IndexedDB backfill, versioned + 24h-evicting, graceful
  fallback). **Never add a second `<SWRConfig provider>`** — extend this
  one.
  - **An ALLOWLIST decides what reaches disk.** `PERSISTABLE_PATHS` in
    `persistent-cache.ts` — currently journal / farm-tasks / locations /
    exchange-listings. Everything else is memory-only. This is an
    allowlist and not a denylist on purpose: `ParcelLease.lessorName` /
    `lessorEik` are in `ENCRYPTED_FIELDS` *because* they are personal
    data about a third party, and they still reached plaintext
    `localStorage`, because persisting them required nobody's decision —
    only that the Rent page use `useTenantSWR` like every other list. A
    forgotten denylist entry writes PII to a phone; a forgotten allowlist
    entry costs one refetch. Adding an entry means deciding that response
    is acceptable on a phone that may be lost, sold or handed on. Capped
    and enforced by `tests/guards/swr-persist-allowlist.test.ts`.
  - **The bucket is namespaced by USER **and** tenant.** Tenant alone let
    a second operator on a shared device rehydrate the first one's rows —
    and because this codebase renders an error only when there is nothing
    to show (`isError && rows.length === 0`), a subsequent 403 would not
    even display. `RootLayout` resolves the id via `auth()` (a cookie
    decode, no DB) and passes it down; it namespaces a cache key and is
    never a credential.
  - **Bump `SWR_CACHE_VERSION` to erase what is already on devices.** The
    24h TTL only fires when that namespace is hydrated, and the IndexedDB
    tier has no delete path at all, so a phone that never revisits a page
    keeps its bucket indefinitely. `parseBucket` drops a wrong-version
    bucket wholesale — that constant is the only lever that removes bytes
    already written.
- **Conditional revalidation.** Every hot list-read GET returns a weak
  ETag via `jsonWithETag(req, payload)` from `src/lib/http/etag.ts`
  (honors `If-None-Match` → 304). Wired into journal / farm-tasks /
  locations / exchange-listings. New cacheable list GETs SHOULD use
  `jsonWithETag` instead of `jsonResponse`.
- **Cursor-paginated journal.** The journal list server-renders a
  bounded first page (`JOURNAL_PAGE_SIZE = 50`) and pages forward over
  the `?limit`/`?cursor` path via `useCursorPagination` (its additive
  `reload()` reseeds the accumulator on a filter/optimistic change).
  The paginated `/journal` branch returns `{ rows, nextCursor }`; the
  bare `/journal` (no params) still returns a flat array (offline
  outbox replay depends on it).

### Offline outbox durability

The outbox holds unsynced field work in IndexedDB, which the phone is free to
evict. The rules, each of which has cost something to learn:

- **One queue truth: `src/lib/offline/outbox-state.ts`** — counts, loss record
  and the SHARED flush lock. `useOfflineSync` is a thin subscriber. **Never
  reintroduce a per-instance `flushing` ref**: five surfaces mount the hook.
- **Never claim "synced" without evidence.** An evicted IndexedDB rebuilds
  empty and is indistinguishable from a clean drain, so the UI carries three
  base states — `pending > 0`, `pending === 0`, and `lost !== null`. The lost
  record is STICKY: a later success must never wipe it.
- **`blocked` is a strict SUBSET of `pending`, not a sibling.** Surface "N
  waiting, of which M cannot move" — never two numbers an operator has to
  reconcile in a field.
- **A poison item is PARKED, never deleted** — `flushOutbox` has exactly ONE
  removal (success). Park through `parkIfStillQueued`, because `store.update`
  is an upsert and the page and service worker drain the same queue. A
  `refused` park MUST be surfaced with a per-item discard.
- **Request `navigator.storage.persist()` at the FIRST ENQUEUE**, not on first
  paint, and read the CACHED verdict (`agri.offline.durability.v1`) rather than
  re-measuring. Installed PWA grants on iOS; Safari refuses — so Add-to-Home-
  Screen is a real durability mitigation, not packaging taste.
- **A removal writes a RECEIPT first** (`noteDelivered`, then `store.remove`).
  Any removal path not immediately followed by a page-side refresh MUST write
  one, or a service-worker drain reads as eviction and reports false loss.
- **`OUTBOX_DB_VERSION` is a ONE-WAY DOOR.** IndexedDB refuses to open at a
  lower version: roll clients forward, never back.
- **Every enqueue path stamps `attribution()` from `outbox.ts`**, and every
  outbox-bound sender builds headers through `outboxHeaders()` so the FIRST
  attempt carries the same `Idempotency-Key` as its replays. A new path that
  skips either is #786 or #924 again.
- **Not every write belongs here.** The insurance quote (#1120) is deliberately
  NOT an outbox surface — a queued lead would email figures the farmer may have
  since corrected.

New offline surfaces subscribe to the shared state; they do not add another
count or another flush loop.

**See [`docs/offline-outbox-durability.md`](docs/offline-outbox-durability.md)**
before changing any of it — the eviction-detector's blind spot on iOS (where
eviction is class-wide, not selective), the #923 silent-destruction incident,
the service worker's parallel reimplementation and why it cannot import from
`src/`, and the receipt/manifest reconciliation in full. That document is the
reasoning; this is the contract.

### Client data retention

Epic B's encryption boundary stops at the Postgres row. Anything a client
persists is outside the KEK/DEK hierarchy entirely — plaintext, on a phone
that gets lost, sold or handed to another worker. Two rules:

- **`sweepClientStores()` bounds how long the device keeps a farm.** Runs
  once per launch (`ClientDataRetentionSweep` in the root layout), 24h
  default. It covers field snapshots (`agri.offline.fieldop.v1.*`, which had
  no timestamp and no expiry — `clearFieldSnapshot` had zero callers), the
  persistent SWR buckets (whose own TTL only fires on hydrate, so a tenant
  the operator stopped visiting never expired), and the tenant Cache Storage
  buckets.
  - **The Cache Storage half DEFERS while offline**, and that exception is
    load-bearing. The buckets are deleted whole rather than aged, justified by
    "the SW repopulates on next use" — true with a network, false without one.
    Since the sweep runs once per LAUNCH, an offline cold launch was served
    from `PAGE_CACHE`, then deleted it, and the NEXT cold launch had nothing to
    serve: offline cold launch worked exactly once per online session. So
    `sweepCaches()` returns early on `navigator.onLine === false`. Deferral,
    not exemption — the next online launch sweeps as before. `onLine === true`
    does not prove reachability, but `false` is a reliable negative, and that
    asymmetry is the whole basis for the check. Both directions are pinned by
    `tests/unit/offline/client-data-retention-caches.test.ts`, which is also
    the first thing that ever executed this function: jsdom defines no
    `caches`, so it had always returned 0 at its own guard.
- **The sweep NEVER touches the outbox** — that is what makes it safe. An
  earlier design purged the queue too, and every serious failure it had came
  from that: clearing the manifest without the queue is exactly the shape the
  loss detector reads as "this phone deleted your work" (a sticky FALSE
  banner); `flushOutbox`'s `store.update()` is an upsert, so a flush in
  flight writes items back into a cleared store; and queued work exists
  nowhere else, so deleting it is unrecoverable. Scoped to caches, none of
  those are reachable. The one outbox read is protective: a snapshot whose
  task still has queued work is never evicted.

`public/sw.js` caps `DATA_CACHE` / `PAGE_CACHE` by BYTES. Ageing them is the
window's job (`caches.delete`), deliberately kept out of the service worker —
install skips `skipWaiting`, so a bug there waits on operator consent to fix.

### Auth Brute-Force Protection (Epic A.3)

`authenticateWithPassword` applies `LOGIN_PROGRESSIVE_POLICY`:
3 failures → 5s delay, 5 → 30s, 10 → 15-min lockout. Timing is
equalised via `dummyVerify` so lockout is indistinguishable from
wrong-password. Signup rejects known-breached passwords via
`checkPasswordAgainstHIBP` (k-anonymity, fail-open on HIBP outage).

**Password change + reset.** Three routes under `/api/auth/`:
`change-password` (authenticated — verifies the current password),
`forgot-password` (issues a token, enumeration-safe), and
`reset-password` (consumes the token). Reset tokens are
`SHA-256`-hashed at rest in `PasswordResetToken`, single-use
(conditional-`updateMany` claim), and expire after 1 hour. Both
set-password routes run `validatePasswordPolicy` + the HIBP check;
every success revokes ALL of the user's sessions (`sessionVersion`
bump + `UserSession.revokedAt`). Logic lives in
`src/lib/auth/password-management.ts`. Any future password-accepting
route MUST wire HIBP the same way — the Epic E.4 guardrail enforces
it.

**See `docs/epic-a-security.md`** for the unified operator runbook
(verification commands, rollback procedure, observability signals)
and `docs/rls-tenant-isolation.md` for the RLS deep dive.

### Field Encryption (Epic B)

Business-content fields (`Task.description`, `Task.resolution`,
`TaskComment.body`, `ParcelLease.lessorName`, `FarmProfile.egn`,
`Contract.terms`, …) are encrypted at rest by a Prisma `$extends({ query })`
client extension (`src/lib/prisma.ts`). The manifest is
`src/lib/security/encrypted-fields.ts`.

**The rules, each of which has cost something to learn:**

- **NEVER add or remove encrypted columns outside the manifest.** Until #1222
  this was aspirational: a model absent from the manifest resolved to `'*'`,
  which matches field NAMES across the whole manifest without telling models
  apart, so 18 `(model, field)` pairs were encrypted by collision rather than
  by decision. Both paths now pass the real model, so the rule is enforced
  rather than hoped for.
- **A field carrying a manifest field NAME that should stay plaintext goes in
  `DELIBERATELY_PLAINTEXT`** (same file), keyed `Model.field` — per FIELD, not
  per model. Each entry needs a written reason;
  `tests/guards/deliberately-plaintext-is-honest.test.ts` enforces no stale
  entries and no contradiction with `ENCRYPTED_FIELDS`.
- **Narrowing stops DECRYPTION too, so order matters.** Declaring a field must
  land in the same change as — or before — any narrowing. A field left
  undeclared with ciphertext in it becomes unreadable to everyone, with no
  error and no log. Measure first with `npm run preflight:fanout`, which counts
  `v1:` AND `v2:` per affected pair (both envelopes deliberately: a `v1:`-only
  row once hid from a "misplaced v2" check).
- **`Tenant.encryptedDek` is master-KEK ciphertext in NEITHER manifest** — a
  second encryption the field manifests cannot see.
- **Do NOT use "zero `v1:` rows" as a rotation stop condition.** The count
  never reaches zero; see the doc for what to use instead.
- **The master KEK is REQUIRED in production.** Three independent checks refuse
  to start a prod process whose `DATA_ENCRYPTION_KEY` is missing, under 32
  chars, or equal to the dev fallback — the zod schema in `src/env.ts`, and
  startup hooks in `src/instrumentation.ts`, `scripts/worker.ts` and
  `scripts/scheduler.ts`.

Key hierarchy: `DATA_ENCRYPTION_KEY` (master KEK) wraps a per-tenant DEK on
`Tenant.encryptedDek`. Ciphertexts carry a `v1:` (global KEK, legacy) or `v2:`
(per-tenant DEK) envelope and the extension dispatches per value on read.

**See [`docs/epic-b-encryption.md`](docs/epic-b-encryption.md)** for the key
hierarchy in full, the sentinel's failure modes, the #698 worker/scheduler
divergence, rotation and fan-out preflight, the lookup-hash population, and
deployment order. That document is the detail; this is the contract.

### Defense-in-Depth (Epic C)

Five complementary controls. Treat them as one system — each sub-epic has the
others as backstops.

- **C.1 — Wrap every privileged API handler in `requirePermission('<key>', …)`**
  from `@/lib/security/permission-middleware`, and add the rule to
  `src/lib/security/route-permissions.ts`. The legacy `requireAdminCtx` /
  `requireWriteCtx` / `requireRoleCtx` helpers no longer exist and must not
  return — `tests/guardrails/no-legacy-admin-guard.test.ts` fails CI if they do.
- **C.1a/b/c — A surface the Edge cannot authenticate must be in
  `PUBLIC_PATH_PREFIXES` *and* authenticate itself in the handler.** That covers
  SCIM (opaque bearer), signed webhooks (Stripe, AV, integrations) and
  uncredentialed browser beacons (the CSP sink, `/api/metrics`, the manifest).
  **Spell a beacon path as the CONSTANT that goes into the header**, never a
  literal. **Opening a prefix opens EVERY method on it** — gate the privileged
  ones in the handler in the same diff. Write the trailing slash on a prefix
  entry.
- **C.2 — Secrets: patterns live in `.secret-patterns`, one source of truth**
  for the pre-commit hook and the CI guardrail. Carve out with
  `// pragma: allowlist secret`, or put fixtures under `tests/fixtures/secrets/`.
- **C.3 — Sessions are rows.** `UserSession` is minted per sign-in and verified
  on every JWT pass; per-tenant policy caps concurrency and max age.
- **C.4 — Audit events stream out HMAC-signed**, fail-safe: the audit row is
  already committed, so a broken SIEM never undoes the write. Free-text
  `details` is dropped; actor is an opaque id, never an email.
- **C.5 — Sanitise user-supplied rich text at the USECASE layer**, with
  `sanitizeRichTextHtml` / `sanitizePlainText` from `@/lib/security/sanitize` —
  never at render time only, because the row is also read by PDF export, share
  links and SDK consumers. Do not widen the allowlist without a security review.

**When you add an auth scheme that is not the session cookie, add an HTTP-level
test that crosses the middleware.** `token.error`, the `iflk_` API key and SCIM
were all complete, unit-tested mechanisms severed at that seam.

**See [`docs/epic-c-security.md`](docs/epic-c-security.md)** for the operator
runbook and the reasoning — including three occasions when a working mechanism
was Edge-severed and nobody noticed for months.

### Isolation & Sanitisation Completeness (Epic D)

Three gaps Epic C left, each now held by a CI ratchet.

- **D.1 — `UserSession` RLS uses a SINGLE asymmetric policy**
  (`USING (tenantId IS NULL OR own) WITH CHECK (own)`), not a split pair. The
  column is nullable, so a separate insert policy would be a permissive sibling
  letting `app_user` claim a NULL row for any tenant. It is listed in
  `SINGLE_POLICY_EXCEPTIONS` and a "simplify" PR that strips either clause fails
  CI.
- **D.2 — Encryption is not sanitisation.** A field being encrypted at rest says
  nothing about the renderer that decrypts it, so every encrypted free-text
  write path sanitises too.
- **D.3 — `requirePermission(...)` is the only admin-authorization guard.** The
  legacy role-tier helpers threw 403 without writing an `AUTHZ_DENIED` audit row
  and were invisible to the C.1 guardrail.

**See [`docs/epic-d-completeness.md`](docs/epic-d-completeness.md)** for the
runbook and [`docs/epic-c-security.md`](docs/epic-c-security.md) for the
reasoning behind the asymmetric RLS shape.

### Observability & Operational Hardening (Epic E)

- **E.2 — Outbound webhook headers come from `buildOutboundHeaders(...)` and
  dedupe keys from `computeBatchId(...)`** in
  `src/app-layer/events/webhook-headers.ts`. Never spell an outbound header name
  inline and never hand-roll a dedupe key. `X-Agrent-*` is canonical;
  `X-Inflect-*` is dual-emitted at an identical value until every consumer SIEM
  has migrated.
- **E.3 — `installShutdownHandlers()` drains audit buffers, then OTel, then
  Sentry**, each `Promise.race`d against a per-stage budget so a slow exporter
  never outlives the container grace period. It never calls `process.exit` —
  `next start` owns the lifecycle. A paired shutdown helper lives beside each
  `init*`, and must stay bounded, idempotent and non-throwing.
- **E.4 — Every route ingesting a user-chosen password MUST import AND call
  `checkPasswordAgainstHIBP`.** Declare the request schema in `@/lib/schemas`
  and import it BY NAME — resolution is per-symbol, so a namespace import has
  no symbol to follow and the scan goes blind.

**See [`docs/epic-e-observability.md`](docs/epic-e-observability.md)** for the
runbook and the reasoning.

### Finishing Touches (Epic F)

Small, independent remediations that close the long tail after
Epic E. Each landed as a focused PR; treating them as one "epic"
was purely a scheduling convenience.

**F.2 — `rotateTenantDek` reserved (since superseded).** Originally
landed as a stub at
`src/lib/security/tenant-key-manager.ts::rotateTenantDek(tenantId)`
that threw a runbook-carrying error pointing at the master-KEK
rotation workaround. The reservation included a new
`Tenant.previousEncryptedDek String?` column from migration
`20260424010000_add_tenant_previous_encrypted_dek`, paired with a
CHECK constraint (`previousEncryptedDek IS NULL OR !=
encryptedDek` — silent key-mixing guard) and a partial index for
the eventual sweep-rotations query.

The real implementation has since landed (see the "Field
Encryption" section above). The reservation paid off: the
implementation slotted in without a schema change and without any
caller-signature break (the function now takes an options object
instead of a single id; the only previous caller was the stub
test itself). Integration test renamed to
`tests/integration/tenant-dek-rotation.test.ts` — happy-path swap
+ double-rotation rejection + the original CHECK-constraint
assertion preserved verbatim.

**F.3 — `HttpMethod` union + sentinel comment.** The route
permission matcher previously did
`rule.methods.map((m) => m.toUpperCase()).includes(upperMethod)`
per gated-route request. The new `type HttpMethod = 'GET' | 'POST'
| 'PUT' | 'PATCH' | 'DELETE'` union enforces uppercase at compile
time, so the hot path drops the `.map(...)` allocation.
Ratchet: `tests/guardrails/route-permissions-uppercase.test.ts`
catches `as` casts, lowercase union-member additions, and type
widening back to `readonly string[]`. Separately, `encryption.ts:141`
now carries a three-state sentinel comment explaining that
`_lastPreviousKeySource: string | null | undefined` uses all three
states deliberately (undefined = never checked, null = checked-no-key,
string = checked-with-key-source).

**F.4 — SECURITY.md + detect-secrets.** `SECURITY.md` now documents
GitHub Security Advisories as the private-by-default primary
reporting channel (no fabricated security email). `scripts/detect-secrets.sh`
uses `git diff --cached --name-only --diff-filter=ACMR` so renamed
files with staged secrets still get scanned.

**See `docs/epic-f-finishing-touches.md`** for the Epic F operator
runbook (verification commands, rollback procedures, how to add a
new DEK-lifecycle verb to `tenant-key-manager`).

### Access Control & Tenant Onboarding (Epic 1)

Authentication and tenant membership are orthogonal: signing in authenticates a
person, tenant access needs an explicit grant.

- **Six roles: `OWNER | ADMIN | EDITOR | READER | AUDITOR | MECHANISATOR`.**
  OWNER is strictly superior to ADMIN (`admin.tenant_lifecycle`,
  `admin.owner_management`). **Any `switch` on `Role` MUST give MECHANISATOR an
  explicit arm** — the switch in `getPermissionsForRole` ends
  `case 'READER': default:`, so a missing arm silently grants the restricted
  machine-operator persona a view of every screen. Its real confinement is the
  middleware lockdown in `src/middleware.ts` + `isOperatorAllowedPath`, and it
  is never an SSO-mappable target.
- **Membership creation is EXPLICIT and allowlisted.** Only the modules listed
  in `tests/guardrails/no-auto-join.test.ts` may write a `TenantMembership`
  row, each with a written reason; any site not on that list fails CI. There is
  no auto-join path: no invite ⇒ no membership.
- **The tenant-access gate reads `memberships[]`, never the single
  `tenantSlug` claim** — that claim is the oldest membership, kept for
  backward compatibility, and gating on it denies a legitimate member of a
  second tenant. A slug-miss on a TRUNCATED list defers to the DB-backed server
  check rather than denying.
- **Last-OWNER protection is two layers**: the usecase counts ACTIVE OWNERs,
  and a DB trigger raises P0001 on any UPDATE or DELETE that would leave a
  tenant with none. Transfer promotes before demoting, so the trigger is
  satisfied throughout.
- **Invite redemption runs in the `jwt` callback, NOT `signIn`.** A first-time
  OAuth user's `user.id` in `signIn` is the IdP subject, not our `User.id` — the
  adapter creates that row only after `signIn` returns — so redeeming there
  wrote a membership against a non-existent FK and stranded the invitee.
- **The emailed link is OPTIONAL**: an OAuth sign-in whose IdP-VERIFIED email
  matches a pending invite provisions the membership. OAuth only — the
  credentials provider's email is self-asserted, and honouring an invite there
  would hand a tenant to whoever guessed an invited address.
- **Terms acceptance is captured on `register/start` and at `/accept-terms`.**
  A first-time Google sign-in creates its row inside NextAuth's
  `PrismaAdapter`, recording none — so an unconsented session is HELD by the
  Edge rather than stamped, which would file an agreement nobody gave.

**See [`docs/epic-1-access-control.md`](docs/epic-1-access-control.md)** for the
runbook and the reasoning.

### RBAC & Permissions

- `src/lib/permissions.ts` — `PermissionSet` (granular UI flags) resolved from the user's role
- Built-in roles: `OWNER`, `ADMIN`, `EDITOR`, `READER`, `AUDITOR`,
  `MECHANISATOR` (Prisma enum `Role`)
- **Any `switch` on `Role` MUST give `MECHANISATOR` an explicit arm** — the switch in `getPermissionsForRole` ends `case 'READER': default:`, so a missing arm does not fail, it silently grants the restricted machine-operator persona view of every screen. See the Epic 1 "Role model" section above for the middleware lockdown and the SSO exclusion that go with it.
- Custom roles: `TenantCustomRole` model with `permissionsJson` overrides, referenced via `TenantMembership.customRoleId`
- `appPermissions` on `RequestContext` is already custom-role–aware

### Observability

All structured logging, tracing, and metrics flow through `src/lib/observability/index.ts` (barrel export). Use `log(level, message, fields)` or `logger.info(...)` for logging — the request context is picked up from AsyncLocalStorage inside `log`, never passed in. Use `traceUsecase()` / `traceOperation()` for OpenTelemetry spans. Never `console.log` in application code.

### Auth

NextAuth v4.24.15 (stable) is configured in `src/auth.ts`. Providers: Google OAuth, Microsoft Entra ID (via the v4 `azure-ad` provider — same OAuth endpoints, Microsoft renamed the product), SAML and OIDC (both under `src/app/api/auth/sso/` — `saml/` and `oidc/`, each a `start` + `callback` pair, configured per tenant from `/admin/sso`), and Credentials. The JWT carries `tenantId`, `role`, `mfaPending`, `memberships[]`, and the Epic C.3 `userSessionId`. Token refresh logic lives in `src/lib/auth/refresh.ts`.

**Bounded JWT membership payload.** The JWT is a fixed-size cookie credential — `memberships[]` / `orgMemberships[]` are capped at `MAX_JWT_MEMBERSHIPS` (50) in the `jwt` callback. Over the cap, `membershipsTruncated` / `orgMembershipsTruncated` is set and the middleware's `checkTenantAccess` / `checkOrgAccess` defers a slug-miss to the authoritative DB-backed server gate (`TenantLayout` / `getTenantCtx`) instead of denying. UI that needs the COMPLETE list (the `/tenants` picker) does its own server-side DB lookup — the JWT list is a bounded fast-path, not the source of truth. Old sessions (pre-cap, no flag) degrade gracefully: an absent flag reads as `false`, so they behave exactly as before until natural re-mint. Locked by `tests/guardrails/jwt-membership-bound.test.ts`.

**GAP-04 — type augmentation pattern.** `src/auth.ts` declares two module augmentations: `next-auth` for `Session.user` (id/tenantId/role/mfaPending/memberships) and `next-auth/jwt` for the full JWT shape (every custom field the codebase stores). Middleware reads typed `token.role` / `token.memberships` directly via `getToken({ req, secret })`. There are zero `as any` casts in the auth-critical path; the structural guardrail at `tests/guardrails/auth-stack-pinning.test.ts` fails CI if any are reintroduced.

**Compat shims.** `auth()` returns `Session | null` and `signOut({ redirectTo })` redirects to `/api/auth/signout?callbackUrl=…`. Both keep the 15+ server-component import sites stable across the v5→v4 migration.

**`auth()` stopped being a bare alias for `getServerSession(authOptions)` in #601.** It tries the COOKIE first and returns that session unchanged when one resolves — the web path is bit-for-bit as before — and only with no cookie falls back to `resolveBearerSession()` from `@/lib/auth/native/bearer-principal`. That fallback exists because native clients hold a NON-COOKIE session: `getToken()` accepts an `Authorization: Bearer` header, so middleware authorises a bearer unchanged, but `getServerSession()` reads `sessionStore.value` — cookies ONLY — so without it a bearer clears the Edge and then 401s at `requirePermission → getTenantCtx → getSessionOrThrow → auth()`, the chain every `/api/t/**` route runs. `resolveBearerSession` reuses the same `getToken` locator and the same `authOptions.callbacks.session` shaper, so the two paths cannot disagree on claims; a bearer principal deliberately carries no `email`.

The token surface is `POST /api/auth/token` (exchanges the current session for an access + refresh pair bound to the SAME `UserSession` row, refusing `session_not_tracked` when the session has no lineage — no unkillable credential is ever minted), `/api/auth/token/refresh`, and `/api/auth/native/{start,complete,exchange,adopt}` for the system-browser PKCE handoff. Hand-minted sessions rebuild their claims through `buildSessionClaims` in `src/auth.ts` (SSO, native exchange/adopt, refresh); `POST /api/auth/token` deliberately RE-ENCODES the existing claims instead, because `applyMembershipClaims` is the only producer of `memberships` / `membershipsTruncated` and a second producer that missed its ACTIVE filter or 50-item slice would be silently more permissive than the cookie.

So do NOT reach for `getServerSession(authOptions)` on anything a native client can reach — use `auth()`, or the `getSessionOrThrow` chain, which already does. **The `/api/account/` family is NOT the exception this paragraph used to name.** It read "calling it directly is still right on a surface that is cookie-only by design: the self-service `/api/account/**` routes do, pinned by `tests/guards/ui-profile-name-capture.test.ts` and `tests/guards/avatar-renderer-convergence.test.ts`" — wrong on all three counts, and corrected by #1299. Every `/api/account/**` route (`profile`, `language`, `bottom-tabs`, `avatar`, `avatar/[userId]`) calls `auth()`; both of those guards pin `auth()` and the avatar one's own comment records that pinning the raw helper "was enforcing a cookie-only route by accident"; and none of the five is cookie-only — iOS reads them over a bearer, which is why the two that are described (`bottom-tabs`, `avatar/{userId}`) carry the `bearerToken` scheme. Measured 2026-09-20 by `tests/guards/native-bearer-auth-parity.test.ts`: five routes DID import the raw helper, and all five were account-level features a native client needs on day one; that guard now holds the count at zero across every file under `src/app/api`. So the sentence has no live referent — if you think you have found a cookie-only surface, the bar is a guard pinning it, not a sentence here.

### Environment Validation

`src/env.ts` uses `@t3-oss/env-nextjs` for type-safe env vars. Tests set `SKIP_ENV_VALIDATION=1` to bypass this. Never add raw `process.env` access — add the var to `env.ts` first.

### Background Jobs (BullMQ)

Job definitions are in `src/app-layer/jobs/`. The BullMQ worker dispatches through `executorRegistry.execute(name, payload, ctx)` from `src/app-layer/jobs/executor-registry.ts`, which gives fault isolation and `recordJobMetrics` but **no context and no span** — instrumentation is the executor's own responsibility, as that registry's docblock says. Most executors (26 of the 45 job modules today) therefore wrap their body in `runJob(name, fn, { tenantId })` from `@/lib/observability/job-runner`, which mints a fresh `jobRunId`, opens a NEW observability context (`runWithRequestContext({ requestId: jobRunId, route: 'job:<name>', … })` — `asyncLocalStorage.run` REPLACES the store, it never merges) and wraps the body in a `traceOperation('job.<name>')` span with metrics and Sentry capture. Nothing is inherited from the enqueuing request — in a worker process there is no such context to inherit — and the app-layer `RequestContext` that usecases and repositories take is likewise SYNTHESIZED per job, from the payload's `tenantId` plus an ACTIVE membership (`buildJobContext` / `buildCtx`) or as an explicit system context (`makeSystemCtx`). A new job wraps itself in `runJob` and builds its own context; no job calls `traceUsecase`.

### Knowledge-base / RAG seeding

`scripts/import-knowledge.ts`, `scripts/rag/ingest-satellite-guide.ts`,
and `scripts/rag/ingest-corpus.ts` are DEV-ONLY via their `npm run
import:knowledge` / `rag:ingest:satellite` / `rag:ingest` `tsx`
scripts — the production runtime image ships no `tsx` and no source
`scripts/` tree (devDependencies are pruned before the runner stage),
so none of the three can run there directly. **Production seeding goes
through `dist/seed.mjs`** — `scripts/seed.ts`, one CLI with
`knowledge`/`satellite`/`corpus`/`all` subcommands, calling the exact
same idempotent exported functions as the three scripts above. It is
esbuild-bundled by `npm run build:seed` (mirroring `build:worker`
exactly — same mechanism, same esbuild config shape), wired into the
Dockerfile right after `build:worker`, before the dev-dependency
prune; the existing whole-directory `COPY --from=builder .../app/dist
./dist` ships it, no separate COPY needed.
`tests/guards/seed-deployment.test.ts` fails CI if the build step, the
entrypoint, or the `dist` COPY is dropped. The `corpus` subcommand
requires a configured embeddings backend (`AI_EMBED_BASE_URL` +
`AI_EMBED_API_KEY`, or `AI_BASE_URL` as a self-hosted-Ollama fallback)
and fails loudly, naming the missing var, instead of silently writing
a chunk with no usable embedding — see
`assertEmbeddingBackendConfigured` in `scripts/rag/corpus.ts`. Run it
on the `agrent` VM via `docker compose exec app node dist/seed.mjs
<subcommand>`. **See the "Knowledge-base seeding (production)" section
of `docs/deployment.md`** for the full operator runbook.

### Billing & entitlements (GAP-18)

The codebase has two billing modes, decided by a single env var:

  • `STRIPE_SECRET_KEY` set → **SaaS mode**. Per-tenant plan
    (`FREE` / `TRIAL` / `PRO` / `ENTERPRISE`) is read from
    `BillingAccount.plan` and enforced at the mutation boundary
    via `assertWithinLimit(ctx, resource)` from
    `src/lib/billing/entitlements.ts`. **`ai_tokens` is the exception**:
    it is a monthly SUM, not a row count, so it is enforced at the
    MODEL-CALL boundary instead — `assertAiBudget(ctx)` in
    `src/app-layer/ai/budget.ts`, called unconditionally by
    `completeWithRouting` in `src/app-layer/ai/routing.ts`. It reads the
    SAME `PLAN_LIMITS` row via `getLimit` + `getAiTokensUsedThisMonth`
    (never a second limits table), but throws
    `forbidden('ai_budget_exceeded: …')` — NOT `plan_limit_exceeded` —
    and returns a non-blocking `softWarn` at 80% of the cap. No call
    site passes `'ai_tokens'` to `assertWithinLimit`.
    SaaS tenants without a
    `BillingAccount` row resolve to `FREE`.

  • `STRIPE_SECRET_KEY` unset/empty → **self-hosted mode**.
    Every tenant resolves to `ENTERPRISE` and per-resource limits
    are unlimited. No DB query happens for plan resolution.

The decision is read once at module load. Four resources are gated
today — `user` (FREE 3 / working tiers 25), `location` (5 / 50),
`exchange_listing` (5 / 50) and `ai_tokens` (a monthly token budget:
50k / 1M / 5M) — with ENTERPRISE unlimited on all four. The fifth,
`practice`, went with the GRC teardown.
Adding a new gated resource is a one-line change in `PLAN_LIMITS`,
a `switch` arm in `getCurrentCount`, and one
`await assertWithinLimit(ctx, '<resource>')` call at the create-site.

**A failed payment is a SECOND, separate gate, and it is not a plan (#1325).**
`BillingAccount.status = 'PAST_DUE'` keeps full access for **14 days**
(`PAST_DUE_GRACE_DAYS`), then withholds a named list of CAPABILITIES —
exchange, trends, `task.create`, `upload`, `journal.create` — via
`assertNotPastDueRestricted(ctx, '<capability>')` from
`@/lib/billing/entitlements`. `plan` is never touched. Owner-ruled: read what
you have, add nothing new, and the two market surfaces close.

- **Keep the two failures distinguishable.** The refusal is a 403 carrying
  `PAST_DUE_RESTRICTED` in `code` (the #1388 / #1405 convention, via
  `codedForbidden`) and sends the user to the billing PORTAL;
  `plan_limit_exceeded:` is a prose `forbidden()` and sends them to a plan
  picker. Different destinations, and a tenant sent to the wrong one cannot get
  out. Do not collapse the gates: "have you room on your plan" and "is your
  account in good standing" are different questions with different fixes. Note
  the new gate does NOT copy its sibling's prose message — the user-facing
  sentences are in `billing.pastDue.*` in both locales, and
  `no-server-authored-user-copy` is ratcheting the prose ones down.
  **The "different destinations" half is true of the WEB client only (#1490).**
  App Store guideline 3.1.1 keeps the native client from pointing anyone to pay
  outside the app, so on iOS both refusals are statements with no routing —
  different Bulgarian sentences, the same (absent) destination. That does NOT
  weaken the rule above: the codes must stay distinct because a farmer should be
  told a payment failed rather than that they lack permission, which is what the
  generic FORBIDDEN string was saying. It does mean the justification is the
  WORDING on one client and the ROUTING on the other, so do not reach for the
  destination argument when the surface in question is native. The spec's own
  description of the code therefore names no remedy — a documented remedy only
  one client can perform is the same defect as a code only one client can read.
  `PAST_DUE_RESTRICTED` IS in the spec now, in the shared 403 description in
  `src/lib/openapi/paths/helpers.ts`; it was the first entry ever deleted from
  `UNDOCUMENTED_BASELINE` rather than added to it.
- **There is NO sweep, deliberately.** The restriction is COMPUTED from
  `pastDueSince` at request time, so a `payment_succeeded` that clears the
  column unrestricts the tenant on the very next request. #1325 specified a
  scheduled job and then named the race it would have with the webhook; both
  dissolve this way. Do not "optimise" it into a cron.
- **Only `pastDueStatusPatch` may write `pastDueSince`.** Stripe fires
  `invoice.payment_failed` on EVERY smart retry, so a site stamping `now()`
  each time pushes the deadline out ~4× and the restriction never fires — a
  14-day grace that silently lasts for ever, with every "entering PAST_DUE
  sets the clock" test still green. All five `status` writes in
  `src/lib/stripe.ts` spread that helper so the two columns cannot be written
  apart.
- **A NULL `pastDueSince` on a PAST_DUE row means IN-GRACE, never expired.**
  That is every row that predates the column; reading it as expired would
  restrict every already-failing tenant on the first request after a deploy.
- **The restriction is the unpaid tenant's OWN view.** Their ACTIVE listings
  stay visible to every other farm and inbound threads keep arriving — pulling
  them would break live negotiations with PAYING buyers and would need a
  suppressed-not-withdrawn state to restore from. Nothing is restored on
  payment, which is what makes the narrow scope safe.
- **Gate at the usecase, except where the usecase has no tenant.** Trends is
  gated at its three ROUTES because `getPriceTrends` / `getMarketNews` take no
  `RequestContext` and their payload is Redis-cached across tenants. Uploads
  are gated once at `ingestUploadedFile`, the choke point every record-backed
  upload reaches. `tests/guards/past-due-capability-coverage.test.ts` derives
  its population from the filesystem, so a new exchange or trends USECASE
  fails until somebody records whether it is gated or deliberately open.

**See `docs/billing.md`** for the full operator + developer runbook,
the reasoning behind plan limits, the failure-shape contract
(`forbidden('plan_limit_exceeded: …')` → 403), and the "what NOT to
do" list (no UI-only gating, no second mode-detection mechanism, no
duplicating the limits table).

## Testing Conventions

- **Unit tests**: Mock dependencies with `jest.mock()` declared **before** imports. Use `makeRequestContext(role?, overrides?)` from `tests/helpers/make-context.ts` to construct test contexts. Note `jest.clearAllMocks()` clears CALLS but not IMPLEMENTATIONS — a test that installs a throwing `mockImplementation` poisons every later test in the file unless the mock is `mockReset()` in `beforeEach`.
- **Integration tests**: Use `prismaTestClient()` and `resetDatabase()` from `tests/helpers/db.ts`. Hit a real DB — do not mock Prisma in integration tests.
- **Guard tests** (`tests/guards/`): Static analysis tests that enforce architectural rules (no `as any`, no unsafe patterns). These are regular Jest tests that scan source files with regex. They assert on source TEXT and contribute **no runtime coverage** — see "Green is not the same as executed" below before treating one as proof a feature works.
- **Rendered tests run as a PHONE by default.** `tests/rendered/setup.ts`
  stubs `matchMedia` to answer `matches: false` to every query, and
  `useMediaQuery` derives the device from two `min-width` probes — both
  false resolves to `isMobile: true`. That default is deliberate (this is
  a mobile-first product), but it decides which branch a test executes:
  `<DataTable mobileFallback="card">` renders `<MobileCardList>` on a
  phone, and `MobileCardList` **omits every column without
  `meta.mobileCard`**. So a test that means to assert the desktop
  `<table>` MUST call `setViewport('desktop')` from
  `tests/rendered/viewport.ts` before `render`, with
  `afterEach(restoreViewport)`. Tests that mean the phone branch should
  call `setViewport('mobile')` rather than inherit the default silently.
  Note `useMediaQuery` starts at `device = null`, so DataTable paints the
  table first and swaps to cards on the mount effect — render *counts*
  cannot tell you which branch a test saw, only the final DOM can. The
  mechanism is executed (not just asserted about) by
  `tests/rendered/viewport-helper.test.tsx`; the audit that found three
  suites green about a branch they never ran is
  `docs/implementation-notes/2026-07-30-rendered-suite-viewport-audit.md`.
- **E2E tests**: Playwright in serial mode (`workers: 1`). CI cuts
  wall-clock by CROSS-JOB sharding, not intra-run parallelism: the
  `e2e-shard` matrix in `ci.yml` runs `--shard=i/2` on two runners (each
  with its own isolated DB, each still serial), aggregated by the `E2E`
  gate job — `workers>1` was tried and reverted for flaking timing-
  sensitive specs. **Structural isolation, not shared state** (`chore/e2e-isolation`):
    - **Read-only specs** (list pages, filters, a11y, theme, tooltips,
      responsive, display checks — navigate + assert, never
      create/edit/delete) keep the SHARED seeded tenant via
      `loginAndGetTenant(page)` / `DEFAULT_USER`. They need the seed
      data and read-only access cannot cascade.
    - **Mutating specs** (anything that creates/edits/deletes) import
      `{ test, expect }` from `./fixtures` and declare the
      `isolatedTenant` / `authedPage` fixture. Each `test()` gets its
      own fresh, EMPTY tenant via `createIsolatedTenant` — writes can
      never touch the shared tenant or another test. An isolated
      tenant starts empty: the spec creates the resources it needs in
      its own body or a `beforeEach`.
    - **No cross-test `let` cascade.** A `let`/`var` assigned inside
      one `test()` and read by another is banned — a failed setup
      step would cascade. Make each test self-contained, or collapse
      a true sequence into ONE `test()` with `test.step(...)`
      sub-steps. Assigning a top-level `let` in a `beforeEach` /
      `beforeAll` is fine. Enforced by
      `tests/guards/e2e-isolation.test.ts`.
    - **A flake that is already known is quiet; a NEW one is not.** `retries: 2`,
      so a spec that fails an attempt and passes on retry leaves the shard
      green — and in the log it is byte-identical to one that has done so every
      run for a month. That is #1076: its spec needed a retry on essentially
      every run, stayed a `::notice` every time, and surfaced only when the
      retries ran out and it blocked an unrelated dependency bump (#1036).
      `ci.yml`'s "Name the failing specs" step now classifies each flake
      against **`tests/e2e/known-flakes.json`** — ledgered ones stay a notice,
      unledgered ones become a warning with their own step-summary section.
      **When your spec starts flaking, either fix it or add it to that ledger
      with an issue and a written reason** — an unledgered flake is the only
      kind that shouts, which is what keeps the shouting worth reading.
      The split is KNOWN vs NEW and deliberately NOT flake vs failure:
      annotating every green-run flake as an error was tried, measured on run
      35427726541, and reverted, because a step that cries wolf on clean runs
      is one people learn to ignore — the same ending as the silence it was
      written to fix. Matching is on spec file + title SUBSTRING, never a line
      number (a comment added above a test moved one from `:24` to `:51`
      inside a single PR). `tests/guards/known-flake-ledger.test.ts` holds the
      ledger's hygiene, and its load-bearing assertion is that every ledgered
      title still occurs in its spec: a renamed-but-shortened title would
      otherwise start matching a DIFFERENT test and silently excuse a flake
      nobody ledgered. It deliberately does NOT assert a flake has stopped —
      absence is not observable from one run — so pruning a fixed entry is a
      human review.
    - Use existing HTML `id` attributes — do NOT add `data-testid`
      attributes.
    - Scope `#id` / role locators to `getByRole('main')` where a
      Next streaming duplicate of the page could match — never a
      bare page-level locator (the lesson came from the since-removed
      risk-matrix E2E spec).
  See `docs/implementation-notes/2026-05-21-e2e-isolation.md` and
  `tests/e2e/fixtures.ts`.
- **The map surface is network-hermetic under E2E, held by TWO EXECUTING
  assertions — not a guard, and not the DNS blackhole.** Every run that
  mounted a map used to fetch `demotiles.maplibre.org`; it had already failed
  on GitHub runners and been harmless only by luck of which specs assert what
  (#764). MapLibre reaches it from three routes — `/locations/{id}` (whose
  detail page DEFAULTS to the Map tab, so merely opening a location mounts
  it), `/field/{taskId}` and `/farm-tasks/{taskId}` — so ~16 specs were
  exposed, most with no map intent at all. That breadth is why the fix is an
  app-level seam rather than a per-spec stub.
    - **Client:** `NEXT_PUBLIC_MAP_BASEMAP_FIXTURE=1` makes
      `resolveBasemapStyle` (`src/lib/geo/basemap-style.ts`) return an inline,
      sources-free style **object** — zero requests. `NEXT_PUBLIC_*` is
      inlined at **BUILD** time, so it belongs on the build step:
      `ci.yml`'s `Build Next.js app` and `scripts/e2e-local.mjs`. Setting it
      on `playwright test` is inert.
    - **Server:** `E2E_BASEMAP_FIXTURE_TILES=1` makes the per-location basemap
      proxy serve a checked-in 38-byte vector tile and never call `fetch`.
      Separate from the client flag because that fetch runs in the **Node**
      process, which Playwright route interception cannot see. A plain runtime
      var, so ONE site — `playwright.config.ts`'s `webServer.command` —
      covers CI, `e2e-local` and a bare `npx playwright test`.
    - **`NEXT_PUBLIC_MAPTILER_KEY` must never be set in CI.** The fixture
      branch is checked FIRST precisely so a runner that carries one stays
      hermetic anyway.
    - **The enforcement is `tests/e2e/map-basemap-hermetic.spec.ts`** (a live
      `page.on('request')` observer against a written allowlist, plus an
      absence-of-`AJAXError` assertion) **and the `X-Basemap-Source: fixture`
      header** asserted in `offline-basemap.spec.ts` — the only observable
      that separates "server half wired" from "server half unwired but the CDN
      was up", because a 200 looks identical either way. The 204 paths carry
      the same header for the same reason: an unreachable upstream and a
      genuinely empty tile are BOTH 204 and mean opposite things, and until
      #780 the download button counted both as a cached tile — so an outage
      produced a full sweep of 204s and a confident "Offline map ready" over
      an empty pack. The `/etc/hosts` blackhole in `ci.yml`
      is belt-and-braces only: **blocking the CDN does not turn the suite
      red** — `maplibregl-canvas` is created synchronously in the Map
      constructor before any style fetch, the map specs' controls are React
      siblings of `<Map>`, and nothing asserts on console output. Both
      runner-up designs proposed that blackhole AS the ratchet; it was
      measured inert.
    - **The suite is now fully hermetic and `ALLOWED_EXTERNAL` is EMPTY** —
      basemap (#764), ISRIC soil (#782) and the web fonts (#779) are all
      same-origin. An empty allowlist is NOT the proof: `expect(external)
      .toEqual([])` is satisfied by a page that never loaded. What makes it
      mean something is that the spec RENDERS the map and toggles Soil view,
      so the requests whose absence it asserts are requests the page would
      have made. **Never delete an entry without a phase that exercises it.**
    - **Which basemap production resolves is WATCHED, not gated** (#781).
  `/api/readyz` reports `capabilities.basemap` by scanning the shipped bundle's
  inlined env (#790), and `.github/workflows/basemap-provenance.yml` probes it
  daily; a red run becomes an issue via `ci-failure-issue.yml`. A publish-time
  gate was designed and REJECTED on proportionality — the failure is "map
  served by the wrong provider", not data loss, while gating would restructure
  the publish pipeline, and that design's own review found a flaw
  (`--push --load` redefines `steps.build.outputs.digest` from the index to
  the platform manifest) that would have stopped GHCR publishing on the first
  merge. **`blind` is treated as RED, not as a pass** — a scanner that cannot
  classify the build does not know which basemap ships, and reporting unknown
  as fine is the defect its positive controls exist to prevent.
- **Web fonts are SELF-HOSTED** (#779) — vendored byte-identical from
      Google under `public/fonts/`, declared by the generated
      `src/styles/fonts.css`, pinned by `src/styles/fonts.lock.json`. Re-vendor
      with `npm run fonts:vendor -- --write-lock`; the default mode VERIFIES
      and exits 1 on drift, because regenerating both the files and their
      hashes in one step would make a changed font program a green diff.
      A lock change is a FONT PROGRAM change: keep the whole weight set, since
      trimming Onest's unused weights swaps a variable font for a static
      instance (measured) and moves metrics.
      This is not only CI hygiene. `public/sw.js` passes cross-origin requests
      through untouched, so the Google-hosted files were never cacheable — an
      operator with no signal fell back to system-ui for every string.
      It also retired an ordering hazard rather than working around it: a
      remote `@import` cannot be inlined, so it had to be the FIRST statement
      in `globals.css`, and on 2026-05-21 it drifted below
      `@import "tailwindcss"` and 500'd every page. A relative import is
      inlined; there is no ordering left to get wrong.
- `SKIP_ENV_VALIDATION=1` is set in `jest.setup.js` to prevent env loader crash in unit tests.
- Coverage thresholds live in `jest.thresholds.json`, NOT in `jest.config.js`:
  jest 29.7's per-project (and multi-project top-level) `coverageThreshold` is
  silently unenforced — the run exits 0 at 9% against a 99% floor. Global floors
  are branches 63 / functions 65 / lines 70 / statements 70, set at measured−2
  and capped at 70 as a brittleness ceiling (the #233 policy).
  **Re-floor from the ENFORCED number, never the summary.** Because this file
  carries path-specific keys (`usecases/`, `policies/`, `events/`, `lib/`),
  jest SUBTRACTS those paths from the `global` group — so the `Coverage
  summary` table (branches 69.78) and what `global` is actually checked
  against (65.46) differ by ~4 points. Take the value from the
  `does not meet "global" threshold` line; re-flooring from the summary broke
  main on 2026-08-20.
  **The gate runs on PULL REQUESTS as well as main pushes**, because coverage is
  collected by the `test` job (see below). `npm run test:coverage` prints the
  same numbers locally but does not fail.

- **Coverage is collected by the `test` job, 6 shards, and the floors are
  scored once on the merged map.** As its own `--runInBand` job it outgrew its
  ceiling three times (25 → 35 → 60) and past ~24,600 tests began CANCELLING at
  60 on consecutive main pushes — a cancelled job loses its log buffer, so the
  gate reported neither a number nor a diagnosis. Sharding fixed that; folding
  it into `test` fixed something else.

  **Why folded:** while coverage had its own `if: github.event_name == 'push'`
  job it could only ever detect a regression AFTER the merge, and adding it to
  branch protection in that shape would have been THEATRE — a job skipped by
  `if:` reports as SKIPPED, and a skipped required check counts as PASSING. The
  `test` job already ran the whole suite on every PR without coverage, so the
  two events were paying for two full runs. Now `test` runs `--shard=i/6
  --coverage` (instrumentation costs ~1.5x, a 6-way split is ~1.5x finer — they
  cancel, so shards stay 5-9 min and PR wall clock stays under E2E's ~16 min),
  and `coverage-gate` merges the six reports with `scripts/merge-coverage.mjs`
  before scoring them with `scripts/check-coverage-thresholds.mjs`.

  **The fold CHANGED THE POPULATION, deliberately.** `test` sets
  `REDIS_URL_TEST`, `BULLMQ_SMOKE_REQUIRE_REDIS=1` and
  `RLS_GUARDRAIL_REQUIRE_DB=1` and declares a redis service; the old coverage
  job had postgres only. So `tests/integration/bullmq-real-api.test.ts` — which
  gates on `REDIS_URL_TEST` and had NEVER been in the denominator — now
  executes. `.github/workflows/coverage-reference.yml` must match `test`'s
  `env:` and `services:` exactly or the parity comparison is measuring two
  different populations; that is held by
  `tests/guards/coverage-parity-env-match.test.ts`, which derives both sides
  from the live YAML.
    - `check-coverage-thresholds.mjs` is a line-for-line port of jest 30's
      `_checkThreshold`, because `--coverageThreshold` only applies to a live
      jest run and the merged map is not one. It prints all five group rows
      unconditionally — jest prints them only on failure, which is what made
      the enforced number guessable and the 2026-08-20 re-floor possible.
    - `merge-coverage.mjs --expect N` is load-bearing. istanbul's merge UNIONS
      the file set, so a missing shard does not depress coverage — it removes
      files from the DENOMINATOR and the percentages **RISE**. Measured:
      dropping 3 of 315 files from `./src/lib/` moved it statements
      84.96 → 85.06. Never remove `--expect`, and never let a shard failure be
      non-fatal.
    - `scripts/lib/coverage-groups.mjs` holds jest's group-assignment algorithm
      ONCE, shared by the checker and the differ. Do not fork it.
  All four are executed — not merely guarded — by
  `tests/unit/coverage-tooling/coverage-scripts.test.ts`.

- **Every jest project must compile with the SAME TypeScript target.**
  `jest.config.js` declares `node` and `jsdom`, each handing ts-jest a tsconfig.
  Until 2026-08-23 those disagreed (ES2017 vs ES2020). `?.` and `??` are ES2020,
  so under ES2017 ts-jest DOWNLEVELS them — and istanbul instruments the emitted
  JS, not the source. The same file therefore got a different coverage shape
  depending on which project loaded it, and when both ran in ONE process jest
  merged the two instrumentations into an inflated map (**50 statements for a
  26-statement file**). Coverage totals became dependent on load order. Held by
  `tests/guards/jest-project-instrumentation-parity.test.ts`, which derives each
  project's tsconfig from `jest.config.js`. See
  `docs/implementation-notes/2026-08-23-jest-project-instrumentation-divergence.md`.

- **`.github/workflows/coverage-reference.yml` proves the sharded merge is
  faithful, and it HAS.** Dispatch-only (a ~60-90 min single-process run is
  exactly the cost sharding removed): it runs the suite unsharded on a named
  commit, downloads that commit's sharded merge, and diffs file set, per-file
  covered/total, and the five group rows via `scripts/diff-coverage.mjs`.
  Proven 2026-08-24 on `fe56063d` (run 32769512898): identical file set
  (1382/1382), **all 1382 files identical**, all five groups identical to the
  decimal — which is why the gate ENFORCES rather than running `--report-only`.
  That re-run was prompted by a POPULATION change, not a mechanism change:
  coverage moved into the `test` job, which has redis, so
  `bullmq-real-api.test.ts` entered the denominator for the first time. No
  guard demanded it — the mechanism pins all stayed green — and that is the
  point: the previous constant was still DEFENSIBLE, and a constant asserting
  a proof should mean the proof, not an argument for why the proof probably
  still holds.
  Re-run it when the merge MECHANISM changes — a jest or istanbul major, an edit
  to `merge-coverage.mjs`, a change to the shard count. Those three inputs are
  pinned beside the run id in `PARITY_PROOF` in
  `tests/guards/coverage-parity-proof-current.test.ts`, which fails CI when one
  of them moves. **If it fails, find the divergence; do not move the floors.**

  Getting there took four fixes, and three of them were invisible rather than
  wrong: a `| tee` with no `pipefail` reported a failed comparison as a green
  job; `actions/checkout` silently rejects a SHORT sha; the two jest projects
  instrumented the same file differently; and three `setTimeout` callbacks were
  covered only when a run happened to be slow enough
  (`audit-stream.ts` 5s periodic flush, `filter-context.tsx` bare-pathname arm,
  `CostEntryFormModal.tsx` deferred autofocus — each now pinned by a real test,
  because a tolerance would have hidden untested behaviour rather than fixed
  it).

### Green is not the same as executed

Several mechanisms in this repo let a check pass without verifying
anything. All read as green forever, so all are named here.

**Guards assert on source text, not behaviour.** Every file under
`tests/guards/` — and most of `tests/guardrails/` — `readFileSync`s a
source file and matches a regex. They execute the *test*, never the
*subject*, so they contribute **zero runtime coverage**: a heavily-guarded
file can sit at 0%. Two measured examples. `FilterRangePanel` was named by
eight guards while every decision point inside it was unexercised, until a
rendered test took it 0% → 88.76% branches
(`docs/implementation-notes/2026-07-28-coverage-wave-14.md`).
`tests/guardrails/jwt-membership-bound.test.ts` greps `src/auth.ts` for
`.slice(0, MAX_JWT_MEMBERSHIPS)` — it proves the JWT membership cap exists
in source and never once runs it (wave 15). The third and worst was the
COVERAGE GATE ITSELF: `merge-coverage.mjs`, `diff-coverage.mjs`,
`check-coverage-thresholds.mjs` and `coverage-groups.mjs` were 675 lines
deciding whether the gate passes, and every test naming them was a guard.
Neutering BOTH seams at once — the differ hardcoded to report parity, and
`--expect` ignored so a missing shard passes silently — left **28 of 28 tests
green** (2026-08-22). Both failures point TOWARD GREEN, which is why it
mattered: a gate green over less code is worse than a dark one, because
darkness at least prompts someone to look. A guard is the right tool for
"this pattern is present / this banned token is gone". When you need the
guarantee that the code *behaves*, write an executing test under
`tests/unit/`, `tests/rendered/`, or `tests/integration/`. The four-tier
model is `docs/frontend-assurance-model.md`; the curated structural-ratchet
↔ rendered-test pairing is
`tests/guards/behavioural-coverage-registry.test.ts`.

**A skipped suite is indistinguishable from a passing one.** The
`const describeFn = DB_AVAILABLE ? describe : describe.skip` gate used
across `tests/integration/**` means a run gets *greener* by running less —
observed live on `tests/guardrails/rls-coverage.test.ts`, which failed six
assertions against a stale DB and then went silent when that DB became
unreachable. If you add such a gate, keep the skip derived from a flag (a
hard `describe.skip(` never re-arms) and make the non-execution visible:
`rls-coverage.test.ts` carries an always-running execution-status test that
prints a banner naming what did not run, plus the
`RLS_GUARDRAIL_REQUIRE_DB=1` escalation for environments that guarantee a
database. The structural half of that contract lives in
`tests/guards/rls-coverage-skip-visibility.test.ts`, modelled on
`tests/guards/tooltip-kill-switch-consistency.test.ts`.

**And `DB_AVAILABLE` — the flag that whole gate reads — could not tell "no
database" from "could not look".** `tests/integration/db-helper.ts` probes
Postgres once at module load with `spawnSync`, and ended
`return result.status === 0`. **`spawnSync` sets `status: null` on a
TIMEOUT**, so a probe that was merely too SLOW returned `false`, and `false`
means absent: every integration suite became `describe.skip`. The failure is
load-correlated, which is the worst possible shape — integration coverage
thins exactly when the machine is busy, and a busy machine is what CI is.
Measured 2026-09-29: under a mutation sweep holding the box at load ~12 the
30s probe timed out and a fresh integration suite reported `1 skipped`, while
the database answered in 1.1s when asked directly.

The probe has THREE outcomes now (`classifyProbe` in
`tests/integration/db-probe.ts`): `'ok'`, `'refused'` — the probe FINISHED
and said no — and `'unknown'` for a timeout, a signal, or a spawn failure.
**Only exit 1 is an answer about the database**, because that is the probe
script's own `.catch`; every other non-zero exit is the probe itself
breaking, and reading that as absence is how a broken probe silently
disables a tier. `'unknown'` retries once at 90s, then prints a banner
saying which of the two it is, and `INTEGRATION_REQUIRE_DB=1` turns either
into a hard failure — set on the `test` job (and its
`coverage-reference.yml` twin, which the parity guard requires to match)
because that job runs `prisma migrate deploy` against a declared service.
The classifier lives in its OWN module so a test can import it without
paying the module-load probe: a test that had to spawn would be flaky under
exactly the load it exists to catch, and green otherwise.

**A mocked dependency cannot report that the dependency changed.** `bullmq`
5 → 6 (a MAJOR) went 19/19 green while nothing in the repo executed one line of
BullMQ: `tests/integration/bullmq-queue.test.ts` and `bullmq-scheduler.test.ts`
both open with `jest.mock('bullmq', …)`, `redis-connection.test.ts` maps
`ioredis` to `ioredis-mock`, and the only files that actually construct a
`Worker` or register a scheduler — `scripts/worker.ts` and `scripts/scheduler.ts`
— sit **outside `tsconfig.json`**, so not even `tsc` reads them. A rewritten
constructor or a renamed scheduler verb would have passed CI and surfaced as a
worker that will not start behind a healthy web tier. The closure is
`tests/integration/bullmq-real-api.test.ts` — real Redis, no mocks, asserting
`jest.isMockFunction(Queue) === false` so the file cannot be quietly neutered —
plus a `redis:7-alpine` service on the `test` job with
`BULLMQ_SMOKE_REQUIRE_REDIS=1`, which turns a skip into a failure where Redis is
guaranteed. **When you add a BullMQ verb to `queue.ts` / `worker.ts` /
`scheduler.ts`, add it there too.** The general rule: when a test mocks the
thing whose behaviour you actually depend on, it verifies your wiring and
nothing about the dependency — so a dependency bump needs a path that runs the
real thing. See
`docs/implementation-notes/2026-08-17-bullmq-real-api-smoke.md`.

**A fail-safe write path reports nothing, so a dead subsystem reads exactly
like a working one.** The audit extension logs `audit.write_failed` and
SWALLOWS, because the business write has already COMMITTED and failing it
afterwards would be worse (#1269). That decision is right and it stays — and
it means a green E2E run with 275 swallowed audit failures and a green E2E run
with 275 successes are the same observation. On main `e1acca2c5` it was the
first: 275 attempted audit writes on shard 1 and 85 on shard 2, **zero**
successes, 28 models, every run green, for an unknown period. #1288 fixed the
cause (the bundled Next runtime could not resolve the chain writer), and note
which tests did NOT catch it — `audit-write-failure-is-loud.test.ts` and
`before-commit-audit-queue.test.ts` both execute the writer and assert rows
appear, and both passed throughout, because jest resolves the module fine. The
defect lived only in the bundled runtime. So the closure is a STEP inside the
`e2e-shard` job (#1289), never a new job — a skipped required check counts as
PASSING, so a new job is both a protection change and a thing that can pass by
not running. `scripts/check-e2e-audit-writes.mjs` reads that step's own tee'd
log and requires BOTH `audit.write_failed` at 0 and the positive control
`pii.middleware_registered` above 0: the count alone is satisfied perfectly by
an unreadable, empty or moved log, so the control is the half that stops a
broken input from reading as a clean run. Measured on the four real shard logs
— 275/85 failures before, 0/0 after, control at 2 in every one.
**When you add a fail-safe path — a catch that logs and continues so a
committed write survives — add the check that counts its log line in the same
diff.** `tests/guards/e2e-audit-writes-not-silently-zero.test.ts` holds the
wiring and EXECUTES the checker, including that it fails on an empty log.

**A required aggregate cannot tell "nothing to run" from "the detector
broke" — unless it reads the prerequisite's result.** Three of the ten
required contexts are summary jobs that register AFTER the work: `Test`
(`test-summary`), `E2E` (`e2e`) and `Docker Build & Scan`
(`docker-summary`). The heavy job skips on a content-only diff and the
summary passes on `skipped`, which is correct — a docs-only PR genuinely
needs no E2E run, and making every skip fail reddens every docs PR.
#1301 is the other half: a GitHub API 503 inside `dorny/paths-filter`
failed `Detect changes`, both `e2e-shard` jobs were skipped because they
are gated on its outputs, and `E2E` passed on `skipped` with no E2E test
executed and the #1289 gate above skipped along with it. **Both causes
arrive at the aggregate as `skipped`; only `needs.<job>.result` separates
them.** So `e2e` and `docker-summary` now list `changes` and `build` in
`needs:` purely to read their results, and fail when either is `failure`
or `cancelled` — *not* on `!= success`, which would redden the legitimate
schedule / merge-queue skip chains. `test-summary` needed no change and
the reason is worth knowing: `test` has no `needs:` and no path filter, so
nothing upstream can skip it, and that step already fails on any result
but `success`. The contract is executed, not asserted about:
`tests/guards/ci-aggregate-upstream-failure.test.ts` lifts each
aggregate's `run:` block out of `ci.yml`, substitutes scenario values into
its `${{ needs.X.result }}` expressions, and runs it under `bash -e` for
the exit code — plus it fails if any job in an aggregate's `needs:` has no
result read, since `needs.X.result` for an undeclared `X` is the empty
string and the check is then inert. Adding a prerequisite to one of these
jobs means handling its result in the same diff.

**Under jsdom the app is a PHONE, so a whole branch may be unreachable.**
`tests/rendered/setup.ts` stubs `matchMedia` to answer `matches: false` to
*every* query. `useMediaQuery` derives the device from two `min-width`
probes, and both false resolves to `isMobile: true`. Two consequences that
have each cost real time:

- `<DataTable mobileFallback="card">` renders **cards**, and
  `MobileCardList` omits every column without `meta.mobileCard`. The
  desktop `<table>` branch never mounts, so a suite can be green about a
  branch it has never executed. The 2026-07-30 audit found **three** such
  suites — `ag-pages-a11y` (the WCAG axe sweep: four of its six surfaces
  are card-fallback, so the table markup its docblock names had never been
  through axe), `org-drilldown-load-more`, and `grain-contracts-error-state`
  — plus one outright broken (`access-reviews-list`, asserting rows against
  a hidden sidecar of empty `<span>`s). Searching for table SELECTORS finds
  almost none of this: the damage is in suites whose stated purpose is the
  table, not in their locators. Only a dynamic probe settles which branch
  ran, and note `useMediaQuery` starts at `device = null`, so DataTable
  paints the table first and swaps to cards on the mount effect — render
  counts are ambiguous, only the final DOM is authoritative.
- Any component branching on a coarse-pointer or hover media query has
  that branch dead under jsdom. This is how a tooltip touch regression
  shipped: tap-to-toggle was added, `tooltip.test.tsx` passed, and the
  coarse-pointer path it added had never executed
  (`docs/implementation-notes/2026-07-29-tooltip-touch-uniformity.md`).

The phone default is deliberate — a phone is the operator's real device on
this product — so do not flip it globally. When a test genuinely means to
assert the desktop branch, override the stub for that test and restore it
in `afterEach`; the shared `setViewport` / `restoreViewport` helpers live in
`tests/rendered/viewport.ts` (extracted there by #464 from a local helper that
used to sit in `tests/rendered/inventory-client.test.tsx`, which remains a
reference call site — it pins the desktop `<tr>` branch and the phone card
branch in adjacent tests). If you assert on a media-query
branch, say in the test which viewport it is asserting, or the next reader
cannot tell whether the pass was earned.

### Index & query-shape guardrails

Two structural guardrails enforce database-performance hygiene. Both
read the LIVE Prisma schema / `src/app-layer` source — no DB, no
migration-file coupling. The structured schema parser they stand on
is `tests/helpers/prisma-schema-models.ts` (`parseSchemaModels()`).

- `tests/guardrails/schema-index-coverage.test.ts` — four index
  layers. **A** (auto): every model with a `tenantId` field must have
  a `tenantId`-leading `@@index`/`@@unique`/`@@id`. **B** (auto):
  every foreign-key scalar field must be indexed — leading an index,
  or (on a tenant model) the 2nd column of a `[tenantId, fk]`
  composite. **C**
  (curated): `LIST_QUERY_INDEXES` — composite indexes backing
  specific list filter+sort shapes. **C-completeness** (auto): every
  tenant-scoped model that is `findMany`'d in `src/app-layer` must be
  in `LIST_QUERY_INDEXES` or `LIST_MODELS_TENANT_INDEX_SUFFICIENT`.

- `tests/guardrails/query-shape-guardrails.test.ts` — two query
  layers. **D1**: no Prisma READ call inside a loop (N+1).
  **D2**: a one-way-down budget on unbounded (`take:`-less)
  repository `findMany` calls.

**When you add a model:** Layers A/B/C-completeness fire
automatically. If the model has a `tenantId`, add a
`@@index([tenantId])` (or a tenantId-leading composite). Index every
FK column (a `[tenantId, fk]` composite counts) or expect Layer B to
flag it. The first `findMany` on the
model forces a Layer C-completeness triage — add it to
`LIST_QUERY_INDEXES` (with a real composite index) or to
`LIST_MODELS_TENANT_INDEX_SUFFICIENT` (with a written reason).

**When you add a `findMany`:** keep it bounded with `take:`. An
unbounded repository `findMany` must either add `take:` or carry
`// guardrail-allow: unbounded` with a reason. A read inside a loop
trips D1 — hoist it to one `findMany({ where: { id: { in: [...] } } })`
plus an in-memory map, or (for an intentional bounded-loop
idempotency check) add `// guardrail-allow: n+1` or a
`KNOWN_N_PLUS_ONE` entry with a reason.

All exempt/baseline maps carry a written reason per entry and a
"no stale entries" test — when a real index lands or an N+1 is
fixed, delete the entry in the same diff.

### Codebase-hygiene ratchets

Four codebase-hygiene invariants are held by structural guardrails
— **see `docs/codebase-hygiene.md`** for the contributor guide:

- **The `Lint` gate counts SUPPRESSIONS, not just warnings.**
  `npm run lint` runs `scripts/lint-ceiling.ts`, because ESLint excludes
  inline-disabled findings from BOTH `errorCount` and `warningCount` —
  they move to `suppressedMessages`, which a `--max-warnings` ceiling
  never reads. Measured at `0a109317b`: 121 warnings against **1,580
  suppressions**, so 93% of findings sat outside anything a warning
  ceiling could see, and 13 of them mute rules the config sets to
  severity 2. The invariant is that **converting a warning into a
  suppression changes no total** — muting relaxes the warning ceiling by
  one and breaches the suppression ceiling by one, so silencing costs
  what leaving it costs. The gate also floors the LINTED-FILE COUNT: a
  config that stops resolving reports zero findings and satisfies every
  ceiling, which is the empty-selection defect one level up. Ceilings may
  be lowered freely and drift sentinels force them down; raising one is a
  visible line in the diff. Proof is `tests/guards/lint-ceiling-has-teeth.test.ts`
  (13 mutations of a passing baseline plus a control).

- **`as any` stays on a downward ratchet.** The `src/` count is 4
  (documented staged debt). `tests/guardrails/no-explicit-any-ratchet.test.ts`
  caps it via `CURRENT_BASELINE` with a drift sentinel (slack cannot
  accumulate); `tests/guards/no-explicit-any-ratchet.test.ts` caps
  `: any` / `<any>` / `as any` / `@ts-ignore`. Removing casts ⇒
  lower the baseline/caps in the same PR. `@typescript-eslint/no-explicit-any`
  is intentionally `warn` (a large `: any` debt makes `error`
  infeasible) — the ratchet is the enforcement.
- **Logging discipline applies to adapted code too.** No `console.*`
  in server code (`tests/guardrails/logging-import-hygiene.test.ts`).
  The vendored `src/lib/dub-utils/` tree that motivated the rule is
  GONE (deleted by #829), but the guard still pins `lib/dub-utils/`
  OUT of the allowlist and `codebase-hygiene-integrity.test.ts`
  requires that anchor to survive — so the exemption cannot be quietly
  re-added under a future vendored tree. The live carve-outs are three
  named files (`lib/observability/edge-logger.ts`, `lib/api-client.ts`,
  `instrumentation.ts`), four `components/ui/` prefixes, and a blanket
  skip for any file whose first line is `'use client'`.
  **Every exemption map in that file is SHRINK-ONLY and pinned to disk**
  — the two console lists and the `require()` allowlist each have a
  no-stale-entries test asserting the key still names something under
  `src/` (#1285). Four `require('@/env')` entries had outlived the
  vendor-questionnaire usecases the GRC teardown (#547) deleted, which
  kept those four PATHS pre-approved for whatever was created there
  next; nothing detected it, because this was the one baseline in the
  repo with no existence test. Delete an entry in the same diff as its
  file.
- **Route handlers type `params` as `Promise<…>`.** Next 15+
  contract; `tests/guards/async-params-route-typing.test.ts` blocks
  a regression. The old transparent-await shim is retired.
- **Web-platform identifiers are off-limits to renames.**
  `tests/guards/web-platform-identifiers.test.ts` pins the canonical
  spelling of names this codebase does not own — `Cache-Control`,
  `Access-Control-Allow-*`, `aria-controls`, `AbortController`, the
  `control` keyboard-modifier alias — and bans the mangled forms.
  Every one of these is a *string literal*, so TypeScript cannot help:
  the Control→Practice rename silently turned 39 `Cache-Control`
  headers into `Cache-Practice` (dropping `no-store` on evidence and
  avatar downloads) and 5 `aria-controls` into `aria-practices`, and
  the whole suite stayed green. Before any project-wide identifier
  sweep, add the at-risk standard names here.

`tests/guards/codebase-hygiene-integrity.test.ts` is the meta-ratchet
over the first three bullets' four guardrail files. The web-platform
guard stands alone — it carries its own mutation proof instead.

### The API route surface is a contract with native clients

**A path cannot leave this API silently.** `src/generated/route-inventory.json`
is an APPEND-ONLY ledger of every path template served — 387 entries, each
`live` or `retired` with a written reason — regenerated by
`npm run routes:inventory` and held by
`tests/guards/route-inventory-ledger.test.ts`.

It exists because #1087 renamed five satellite-tile routes and the native iOS
client went on calling the old shape: every request 404'd, no vegetation
overlay mounted, and nobody knew until the owner opened the map on a phone four
days later. The rename was CORRECT — it moved a location id out of a query
string, which Apple's networking layer writes to the device log below anything
an app can suppress — and it deliberately shipped without a shim, reasoning
that "the app is pre-release so a coordinated change costs a version bump
rather than users". The coordinated change never happened, and **both suites
stayed green throughout**, because a route rename is invisible to a repo that
only checks its own callers.

- **The generator never retires anything.** It adds new paths and resurrects
  returning ones; a path that LEAVES the filesystem stays `live` and the guard
  fails until a human writes `status: "retired"` with a reason. A generator
  that rewrote the list wholesale would make a removal cost exactly what an
  addition costs — the `fonts:vendor` lesson, where writing files and hashes in
  one step makes a changed font program a green diff.
- **`documented: false` means the route EXISTS and no schema describes it.**
  153 of the 371 LIVE paths are in `openapi.json`; the other 218 sit on
  `tests/guards/openapi-undocumented-baseline.json`. A client checking against
  the spec ALONE would report `/api/auth/token`, `/api/account/profile` and
  most of the admin surface as nonexistent, so the inventory carries the
  distinction rather than hiding it.
- **The route derivation is held ONCE**, in `scripts/lib/api-routes.ts`, shared
  by the generator and by `openapi-paths-complete.test.ts` — which carried it
  inline until this landed. Two copies of a selection rule is how two answers
  diverge. Do not fork it.
- **This is the SERVER half of a two-direction control**, and agrent-ios#132 is
  the client half (every path that app builds must exist in the inventory).
  Neither subsumes the other: a client-side check cannot fail on the diff that
  causes the break, and a server-side check cannot know what a client calls.
  Same argument as `public-routes-self-authenticate.test.ts`, where "either
  half alone is worse than neither".

## Runtime feature flags and the social dark-launch rail

Every social route and page the roadmap builds (P2-P6) sits behind a runtime
feature flag that defaults to OFF. That is the only agreed way to turn one of
those surfaces off in production — the alternative is shipping an image — so a
social route that forgot its gate is a surface with no off switch.

**`src/lib/feature-flags.ts` holds three rules, in precedence order, and the
order is the design:**

  1. `FEATURE_FLAGS_FORCE_OFF=1` turns EVERYTHING off, within one request. Read
     from `process.env` per call and never cached, because a kill switch
     defeated by a warm cache is a suggestion. It is deliberately **not
     reachable from the API** — an endpoint that could clear it is an endpoint
     that can be compromised into clearing it, and the switch exists for the
     case where the application is the thing going wrong. Turning it off is an
     operator action on the VM.
  2. A flag absent from the table is OFF. There is no code path treating
     "unknown" as enabled.
  3. `enabled` **AND** cohort membership. A non-empty `cohorts` array NARROWS;
     read as OR, an enabled flag with cohorts set would expose the surface to
     the whole deployment.

**Never `NEXT_PUBLIC_*` as a feature switch** — it is inlined at `next build`,
so flipping it needs a rebuild, an image push and a rollout.
`NEXT_PUBLIC_NOTIFICATIONS_SSE` is the live example: off in production and not
turnable on without shipping.

The flag TABLE is cached in Redis for 30s under one key, so a flip propagates
in ≤30s. **Cohort membership is NOT cached** — it is per-user, and a stale
membership is a wrong answer about one person rather than bounded staleness
about the deployment. That asymmetry decides what each write path does: a flag
flip calls `invalidateFlagCache()`, a membership change calls nothing.

**The console is `/api/admin/feature-flags` (GET list, PUT upsert) and
`/api/admin/feature-flags/cohorts` (GET, POST, DELETE).** Platform-admin-key
gated via `verifyPlatformApiKey`, not a tenant permission: `FeatureFlag` has no
`tenantId`, so `admin.manage` would let an ADMIN of any one tenant launch a
feature for every other. Four things worth knowing before touching it:

- **It is in `PUBLIC_PATH_PREFIXES`/`PUBLIC_PATH_EXACT` and has to be.** The
  Edge calls `getToken()`, which understands only a NextAuth cookie, so an
  `x-platform-admin-key` request is 401'd before the handler runs — the
  SCIM / `iflk_` / signed-webhook shape, six prior instances. It is opened as
  an EXACT entry for the console plus a `'/api/admin/feature-flags/'` prefix
  for its children, rather than one bare prefix, so a future
  `/api/admin/feature-flagsomething` is not opened too.
  `tests/unit/admin-feature-flags-console.test.ts` asserts both halves —
  reachable, and not widened.
- **GET returns the RAW table plus `forcedOff`**, never a resolved per-caller
  view. An operator opens this screen to see that a flag is
  enabled-but-cohort-gated, which `/api/auth/me` deliberately collapses to one
  boolean. `forcedOff` rides along because it overrides every row; without it
  the console would show `enabled: true` while every client sees the flag off.
- **`FeatureFlag.updatedByUserId` is left NULL.** The credential is an API key,
  so there is no user in scope; accepting an actor id from the body would put a
  caller-supplied name in an attribution field, which is worse than an absent
  one. The record is the operator's access to the key plus the `INFO` log line.
  A real platform audit chain is **P1.9** (`PlatformAuditLog`), and this route
  is one of its first writers.
- **Membership is by `userId`, not email.** Resolving an email would add a 17th
  `hashForLookup` call site the week before **P1.1** re-keys that derivation
  onto `LOOKUP_HMAC_KEY`. `GET /cohorts` with no argument lists cohort SIZES,
  because a flag naming a cohort with zero members reads as a live rollout and
  is off for everyone.

**`FLAG_KEY_PATTERN` + `FLAG_KEY_MAX_LENGTH` live in `@/lib/feature-flags`, and
three artefacts share them**: the console validates writes against the pattern,
and `tests/guards/social-routes-flag-gated.test.ts` holds every key a social
route gates on to it. A route gated on a key the console refuses is a surface
with a gate and no way to open it — permanently off, reading as not-yet-built.
Do not restate the regex at a call site.

**`tests/guards/social-routes-flag-gated.test.ts` enforces the gating rule, and
its population is ZERO until P2.** So it is built for that: it prints the
denominator on every run, proves the detector against synthetic gated/ungated
sources (the only mutation proof available before a real social route exists),
and defends its own roots — every route or page path with a `social` SEGMENT
must fall under a declared root, so landing a social surface at
`api/t/[slug]/social` costs a visible line adding that root rather than a silent
exclusion from the population. Account deletion and the DSA notice endpoints are
LEGAL DUTIES and exempt; `FLAG_EXEMPT` is empty today and an entry lands in the
PR that adds its route, with the duty named.

A gate counts as a call to `assertFeatureEnabled` / `isFeatureEnabled` with a
**string literal** key — an operator holding the console has to be able to find
the flag that gates a route, and a key assembled at runtime is not findable by
reading the route. The guard's own mutation proof is what caught the
interpolated-template hole: `` `social.${surface}` `` contains no quote
character, so a naive literal matcher read a computed key as a static one.

This is the SERVER half. The iOS flags store (P0.9) is the client half, and
neither subsumes the other.

### P5.1 — trust & safety tables, and the one policy arm that constrains a schema

Four tenantless tables (#1553): `ContentReport`, `ModerationAction`,
`StatementOfReasons`, `UserBlock`. Schema only — P5's rule ships tables one
release before the code that writes them, so no route, UI or flag lands with
them.

**Three of them deny `app_user` outright, and the fourth is the exception that
shapes the schema.** `ContentReport` carries
`content_report_reporter_read` — `FOR SELECT USING ("reporterUserId" =
current_setting('app.user_id', true))` — so a reporter can read their own
notice back and "my reports" needs no second read path.

**Postgres RLS is ROW-level, not column-level.** That arm exposes EVERY column
of the reporter's own row, so the three-table split is load-bearing rather than
tidy: the decision, the rationale and `moderatorRef` live on
`ModerationAction`, which denies `app_user` entirely. Anything added to
`ContentReport` is by construction reporter-visible, and
`tests/guards/content-report-columns-are-reporter-safe.test.ts` refuses a new
column without a written note saying why that is acceptable.

**`app.user_id`, not `app.actor_user_id`.** Two different variables set by two
different runners, and picking the wrong one fails SILENTLY — the unset one
yields NULL and the arm matches nothing. `runInUserContext` sets `app.user_id`
and no tenant (person-scoped); `runInTenantContext` sets `app.actor_user_id`
alongside a tenant. Reports and person↔person blocks have no tenant, so they
are person-scoped. `ExchangeBlock` uses the other one because the exchange runs
in a tenant context — the two block tables look alike and are keyed
differently.

**`UserBlock` is ADDITIONAL to `ExchangeBlock`, never a replacement.** Person↔person
and social, versus tenant↔person and commercial. Collapsing them would silently
un-block every person already blocked on the exchange. Its policies are SPLIT
per command for `ExchangeBlock`'s reason: the blocked party must be able to
SELECT the row that refuses them, and a single `USING` clause would govern
DELETE too and let them unblock themselves. This is deliberately the opposite
of `UserSession`'s one-policy rule, which exists to stop an UPDATE rewriting
`tenantId` — a column these tables do not have.

**A refused UPDATE or DELETE does not raise; a refused INSERT does.** With no
permissive policy for the command, the rows to change are selected by a
USING clause that is effectively false, so the statement affects ZERO rows and
returns normally. A `WITH CHECK` violation on INSERT raises `42501`. So every
negative in `tests/integration/p5-1-trust-safety-rls.test.ts` asserts a row
COUNT or a code, never that a call returned — and every positive asserts a
NON-ZERO count, because a silently-unset session variable also produces zero.

**All three encrypted columns are in `GLOBAL_KEK_MODELS`.** `detail`,
`rationale` and `bodyRendered` are tenantless and encrypted, which
`global-kek-models-covers-tenantless` requires — and here the global KEK is the
only correct key rather than a compromise: every reader is either a platform
admin with no tenant context or, for `ContentReport.detail`, the reporter
reading through `runInUserContext`, which sets no tenant either. This is not
the `PromotionLead` case, which is tenantless and deliberately on a per-tenant
DEK because exactly one farm reads it.

`ReportReasonCode` is PROVISIONAL — an enum rather than free text so a count by
reason needs nobody to read a `detail` field (DECISION 6), but the category
list itself is a product and legal choice still open on #1553. Adding a value
is a trivial migration.

### P5.2a — the notice routes, and three places the obvious shape is wrong

Two routes (#1593): `POST /api/public/notices` (anonymous, Art 16) and
`POST`/`GET /api/social/reports` (signed-in). `ReportSnapshot` holds the
evidence. The block half is P5.2b.

**`/api/t/[slug]/reports` cannot work, and would fail silently.** A tenant
route runs `runInTenantContext`, which sets `app.actor_user_id` and
deliberately NOT `app.user_id`. The reporter-read arm matches `app.user_id`, so
under a tenant context it matches nothing and "my reports" returns **zero rows
with no error** — indistinguishable from having filed none. Person-scoped
surfaces go under `/api/social/` (which is what `isOperatorBlockedPersonPath`
covers, so they get the operator-persona refusal) and authenticate with
`getUserCtx`, not bare `auth()`.

**The read and the write run in different contexts, on purpose.** Reading goes
through `runInUserContext` because only that runner sets the variable the
policy needs. Writing goes through the privileged client because there is
deliberately no `app_user` INSERT arm — a reporter who could insert directly
could forge `reporterUserId` or set any `status`. Nothing in
`usecases/trust-safety.ts` may put a client value into `reporterUserId`: the
anonymous path writes NULL, the signed-in path writes `ctx.userId`, and
`FileReportSchema.strip()` drops a client-supplied one rather than rejecting it
(so a caller cannot learn from an error that the field exists).

**The snapshot is a table, not a column, and retention is why.** The
reporter-read arm is ROW-level, so a snapshot column on `ContentReport` would
hand a reporter a durable decryptable copy of a private message *after* its
author deleted it. `ReportSnapshot` denies `app_user` outright.

**The response discloses nothing about the subject.** `SUBJECT_NOT_FOUND` goes
to the snapshot for the moderator, never to the notifier — a notice form that
told a real id from a made-up one would be an enumeration oracle on an
unauthenticated route. `tests/unit/trust-safety-routes.test.ts` pins the
response to exactly `{id, status}`.

**Neither reporting route is flag-gated**, and both exemptions are the same
legal duty rather than two judgement calls: a flag defaulting OFF means an Art
16 obligation is unmet until someone flips it. `FLAG_EXEMPT` keys are
repo-relative FILE paths under a declared social root — a URL-shaped key is an
exemption the population never selects. The public route has no `social`
segment so it is not in that guard's population at all; its unauthenticated
nature is exempted in `public-routes-self-authenticate` instead.

**`PUBLIC_NOTICE_LIMIT` is 10/min per IP** — a tuning choice, not a new
mechanism. `withApiErrorHandling` already defaults every mutation to
`API_MUTATION_LIMIT` (60/min) keyed on `(IP, userId)` with the userId NULL when
anonymous. 10 rather than 60 because the harm is a flood burying real notices
in the triage queue; not lower, because carrier-grade NAT puts a village behind
one IPv4 and a genuine burst about one bad listing is what an incident looks
like.

## Failing tests

A failing test on a branch is a failing test, full stop. "Pre-existing on
main" is a diagnosis, not a license to bypass it. The rule:

- **Run the affected test suites before claiming a task is done.** Don't
  rely on "my changes only touch X" — Jest projects, structural ratchets,
  and import graphs catch surprising regressions.

- **When a test fails, find the root cause first.** Check whether your
  change broke it; if not, check whether it's failing on `main` too. The
  goal is to know what the failure means, not to assign blame.

- **Pre-existing failures must be fixed, not bypassed.** If a suite is
  red on `main`, that's a bug — open a focused fix PR, link it from the
  current PR, and either (a) include the fix in the current PR if it's
  small and on-scope, or (b) explicitly call out the blocker in the PR
  description. Never silently admin-merge through a red test.

- **Never use `gh pr merge --admin` to push past failing CI** without
  the user's explicit authorisation for that specific PR. Required
  checks exist for a reason; the cost of pausing is low, the cost of
  shipping a regression to main is high.

- **Apply the same standard to dependency PRs.** A dependabot bump that
  breaks a test on `main` still needs the underlying breakage fixed,
  even though the bump itself is mechanical.

The exception: if the user has explicitly said "merge despite the
failures, I know what they are" for a specific PR, that authorisation
stands for that PR only — not as a precedent.

## A merged PR body is not a tracker

Scope you deliberately leave out is tracked only if it exists as an **open
issue**. A carve-out explained in a PR description is invisible the moment that
PR merges — nobody greps merged PR bodies. **File the remainder as its own
issue BEFORE you merge**, and reference that issue from the PR.

The mechanical half is a trap worth knowing by name. This repo's
`squash_merge_commit_message` is **`COMMIT_MESSAGES`**, so GitHub builds the
squash commit from the BRANCH COMMITS, not from the PR body. A `Closes #N` in
a commit message therefore closes #N on merge, and editing the PR body to say
"Part of #N" does **not** stop it. That is #641/#626 verbatim: the body opened
with *"Part of #626 — deliberately does NOT close it"*, the branch commit said
`Closes #626.`, and the merge closed the issue anyway. The failure is silent
and inverted — the PR page displays the careful "Part of", while the issue
quietly reads CLOSED.

So when a PR only partly addresses an issue, the closing keyword must not
appear in ANY branch commit: write `Part of #N` / `Refs #N` there too. If you
notice late, amend the COMMIT — amending the body changes nothing, and
`gh issue reopen` plus a comment stating what shipped and what remains is the
recovery.

**And the keyword closes even inside a DENIAL.** GitHub's parser matches
`close #N` as a substring; it does not understand negation. So the sentence

> This does NOT close #748.

**closes #748.** Measured 2026-09-04: two issues (#748, #796) were closed by
commits whose text said, in terms, that they must not be. Both were written
deliberately to prevent exactly that outcome, which is what makes the trap
worth a rule rather than a caution — the more carefully you disclaim, the more
likely you are to trip it.

Never write the words `close` / `closes` / `closed` / `fix` / `fixes` /
`resolve` / `resolves` adjacent to a `#N` you intend to leave open, even
negated. Say what remains instead:

> Ships one measured cause; the swallowed `networkidle` waits are a separate
> PR. Refs #748.

## Key Conventions

- **Zod schemas** for all API input validation live in `src/app-layer/schemas/` (backend) and `src/lib/schemas/` (shared).
- **A breaking API change is measured against the PR's BASE, and regenerating
  the spec no longer silences it (#1228).** `tests/contracts/openapi-breaking-change.test.ts`
  compared the committed `src/generated/openapi.json` against a spec generated
  from the SAME tree — and step 1 of the documented contract procedure
  (`npm run openapi:generate`, enforced for schema dirs by
  `scripts/check-openapi-sync.sh`) makes those two sides equal, so the gate
  held a tree against itself and reported no breakage whatever the API did.
  The baseline now comes from the PR's base commit: CI materialises it into
  `OPENAPI_BASE_SPEC` (the `test` job checks out at depth 1 and its base fetch
  is `--filter=blob:none`, which supplies trees but not blobs), with
  `RATCHET_BASE_SHA` as the fallback and `RATCHET_DELTA_REQUIRE_BASE=1` so a
  base it cannot read is a hard failure rather than a silent skip. **So if you
  remove a property, narrow an enum or make a field required, the gate goes red
  and is supposed to** — regenerate the spec, and if the change is intended,
  say so in the PR for a reviewer rather than looking for a way to quiet it.
  The base-resolution logic is shared with the coverage ratchet in
  `tests/helpers/ratchet-base.ts`; do not fork it. Its one subtlety is that
  `git ls-tree` finding no file at the base means EITHER a genuinely new spec
  OR a commit this clone never fetched, so `commitPresent` is asked first —
  only the former is a pass.
- **Money is integer CENTS and rates are BASIS POINTS — never a float, and
  never computed on the client.** `src/lib/insurance` is the worked example:
  `quotePremium` does round-half-up in integer arithmetic
  (`floor((cents * bp + 5_000) / 10_000)`), so nothing is a float at any point,
  and `MAX_SUM_INSURED_CENTS` is capped at 1e11 precisely so `cents * bp` stays
  inside `Number.MAX_SAFE_INTEGER`. Instalments are split so the parts sum back
  to the total EXACTLY, with the leftover cents on the FIRST one.
  Render with `formatCents(cents, symbol)`, never `useExactMoneyFormatter` —
  that goes through `formatDecimal`, which sets `maximumFractionDigits` only and
  renders "€10,000" and "€3,333.3", and a premium schedule must show its cents.
  The client may PREVIEW a price but never states one: the request body carries
  only the inputs, the server recomputes, and the stored snapshot is what the
  operator is shown. `tests/unit/insurance/client-server-agreement.test.ts` pins
  that the two sides agree.
- **A URL field in a payload schema uses `httpsUrl()`** from
  `@/lib/schemas/url`, never a bare `z.string().url()`. Under the installed zod
  (4.4.3) the loose form accepts `http://`, `ftp://`, `file://`, `data:`,
  `urn:` and `javascript:` — all measured. This is contract-narrowing, not XSS
  remediation (React 19 rewrites `javascript:` hrefs and the CSP carries no
  `unsafe-inline` in `script-src`); what survives those is the plain `http://`
  downgrade and a field contract far wider than the field's purpose.
  `tests/guards/payload-url-scheme.test.ts` scans
  `src/app-layer/schemas/` + `src/lib/schemas/` from the FILESYSTEM, so a new
  schema file is covered the moment it exists. A field that must stay open goes
  in `OPEN_BY_DESIGN` keyed `file:field` **with a written reason** — the two
  entries there today are output-DTO fields holding server-minted RELATIVE
  paths, which `httpsUrl()` would reject. A "no stale entries" test removes the
  exemption's cover as soon as the field is pinned or deleted.
  **A scheme pin is not an SSRF guard.** `https://169.254.169.254/` passes it.
  For a URL the SERVER will fetch, the host policy lives in
  `@/app-layer/automation/webhook-safety` and is **two layers, both required**:
  `checkWebhookUrl` (structural — scheme + literal host) and
  `assertPublicAddress` (resolves DNS with `{ all: true }`, refuses if ANY
  address is private, bounded at 2s, fails CLOSED on a resolve error, per-host
  cached). Web Push additionally uses `checkPushEndpoint`, which adds a
  single-label-host rejection — `https://redis/` resolves inside the compose
  network, and the host-less `https:///path` form parses to one.
  **`isPrivateAddress` returns false for anything that is not an IP literal**,
  and that is deliberate: it used to match `startsWith('fc')` on a raw
  hostname, so it classified `fcm.googleapis.com` — every Chrome/Android push
  endpoint — as a private address (#696). A NAME is not an ADDRESS; names are
  the blocklist's job and DNS's job.
  **A URL the server will `fetch` needs the policy at every HOP, not once.**
  `fetch` follows redirects by default — measured: a `302` to
  `http://127.0.0.1:9/` is followed, so a check before the call validates the
  URL the caller chose while the responder chooses where the request lands.
  Use `fetchPublicUrl` from `@/lib/security/safe-fetch`, which takes the
  redirect loop back (`redirect: 'manual'`) and re-runs both layers per hop.
  `web-push` did not need this — it uses raw `https.request` and treats any
  non-2xx as an error, so there is no `Location` handling to abuse.
  **`maxRedirects: 0` for any request whose BODY carries a credential**: the
  OIDC token exchange POSTs `client_secret`, and following a redirect would
  re-send it to a host the responder named (#708).
- **Audit trail**: Call `logEvent()` from `src/app-layer/events/audit.ts` after mutating state. Entries are hash-chained — never write directly to the `AuditLog` table.
- **Audit verbs: domain verbs are the deliberate majority, not a wart.**
  `AuditEventPayload.action` is a bare `string` with no enum, no registry
  and no guard, so the convention is the only thing holding it. Measured
  over every `logEvent` call site in `src/app-layer` carrying a literal
  action: **193 sites — 65 canonical (34%: `UPDATE` 26, `CREATE` 22,
  `SOFT_DELETE` 9, `DELETE` 8) and 128 bespoke (66%) across 106 distinct
  domain verbs.** `docs/app-layer.md` teaches the domain form
  (`action: 'WIDGET_CREATED'`) as the canonical example. The rule:
    - **Canonical verb** (`CREATE` / `UPDATE` / `SOFT_DELETE` / `DELETE`)
      when the operation genuinely *is* a create/update/delete of the row
      and `changedFields` already says what moved. The lot-move audit
      (`inventory.ts`, #391) is the reference: changing `locationId` IS a
      field update.
    - **Domain verb** (`LOTS_BLENDED`, `STOCK_RECEIVED`,
      `HARVEST_LOT_CREATED`, …) when the row-level shape understates a
      distinct business event. `detailsJson.operation` is `'created'` for
      an ordinary lot creation, a harvest lot AND a blend, so the verb is
      the only field a SIEM filter can separate them on. Stay consistent
      *within* an `entityType`: five of `InventoryLot`'s six audit writes
      use domain verbs, so canonicalising the sixth would make it the odd
      one out, not the tidy one.
  Do not "clean up" a domain verb to a canonical one on consistency
  grounds alone — measure the family first (issue #393 item 4 proposed
  exactly that, on a premise the measurement contradicted).
- **Error classes**: Use typed errors from `src/lib/errors/` rather than throwing raw `Error`.
- **Uploaded bytes always reach a scanner.** Two shapes, both in
  `@/lib/upload/ingest`, and which one you need is decided by whether the
  bytes get a `FileRecord`:
    - **Record-backed** (evidence, journal, invoices, importers) →
      `ingestUploadedFile(tenantId, file, opts)`. Allowlist → write →
      MIME-reconcile → scan, then the caller mints its `FileRecord` inside
      the same transaction as the entity write and passes the returned
      `scanStatus` to `FileRepository.markStored`. Writing before scanning is
      safe *here* because the download route asks `isDownloadAllowed` on the
      way back out — a claim that was false for four of five byte-serving
      routes until `tests/guards/download-route-gate-reachability.test.ts`
      was added as the EGRESS half of this convention (three ungated routes
      deleted as uncalled, one gated). Never restore a default on that `scanStatus` argument —
      `isDownloadAllowed('SKIPPED')` is true in every `AV_SCAN_MODE`, so a
      default meaning "unscanned" also means "downloadable".
    - **Record-less** (a fixed key streamed straight back by an image route:
      `avatars/<userId>.webp`, `promotions/<id>.webp`) → `scanOrRefuse(buf,
      opts)` **before** the write. There is no download gate to defer to, so
      the gate runs at ingest and the write does not happen unless it passes.
      Its policy is derived from `isDownloadAllowed`, not restated beside it.
  Enforcement is two guards, deliberately derived from two different roots
  because each is blind to the other's class:
  `tests/guards/upload-scan-explicitness.test.ts` (from `markStored` call
  sites — record-backed) and
  `tests/guards/upload-route-scan-reachability.test.ts` (from API routes that
  read `formData()` and handle a `File` — every class, including record-less).
- **i18n**: UI strings go through `next-intl`. Message files are in
  `messages/`. Server components use `getTranslations()`, client components
  use `useTranslations()`. **Every user-facing string is added to BOTH
  `en.json` AND `bg.json` in the same PR** — with a real Bulgarian
  translation, not the English value pasted in. Three guards enforce this so
  Bulgarian can't silently fall behind:
    - **No-new-hardcoded-string ratchet**
      (`tests/guards/no-hardcoded-ui-strings.test.ts`) — an AST scan of
      `src/app` + `src/components` caps hard-coded JSX text + user-facing
      string attributes at `CURRENT_BASELINE`; a new raw string fails CI.
      Every extraction PR lowers the baseline in the same diff. Error
      boundaries (`error`/`global-error`/`not-found.tsx`) are allowlisted.
    - **Key parity** (`tests/guardrails/i18n-completeness.test.ts` +
      `node scripts/i18n-diff.mjs --check`) — MISSING / ORPHAN /
      PLACEHOLDER-DRIFT between locales.
    - **Untranslated-copy** (same two files) — a `bg` value byte-identical
      to `en` that reads like prose is flagged; legitimately-identical values
      (brand, unit, deliberately bilingual) go in `UNTRANSLATED_ALLOWLIST`
      with a reason.
  `i18n-diff.mjs --check` runs in CI (the `Lint` job) and `.husky/pre-commit`.
- **The product's own nouns live in `docs/nav-vocabulary.md`, and a guard
  PARSES that file.** Key parity and the untranslated check are blind to a
  surface with two names: before P2.6 the exchange was «Борса» in the sidebar
  section header, the breadcrumbs and the map legend, «Пазар» in the sidebar
  item that navigated to it, and `Борса / Exchange` in the page heading — three
  spellings of one destination, every locale consistent, every guard green.
  That doc's table (`Concept | Bulgarian | English | Keys | Never |
  Namespaces`) IS the expectation `tests/guards/nav-vocabulary.test.ts` checks,
  so an owner reversal is one edit there and CI then names every catalogue key
  to follow. Do NOT restate a noun in the guard — and when you add a surface
  whose name people navigate by, add its row. The canonical three today:
  «Борса» (the `/exchange` destination), «Тенденции» (`/trends`), «Пазар» (the
  sidebar SECTION holding them, plus the news category and price copy — the
  `Never` sweep bans a reserved noun as a key's WHOLE value, never the word).
  The same file carries the load-bearing spellings that must NOT be renamed
  (the sidebar section `id`, the `/exchange` + `/trends` path strings shared
  with the iOS bottom-tab order, `complianceMailbox`), with the reason each
  one stays — the discipline `no-legacy-brand.test.ts` applies to the previous
  brand.
- **An outbound email is written in the RECIPIENT's language, not the
  sender's.** `getTranslations()` resolves from the request cookie, which at
  send time is the *sender's* — on a task assignment the sender is the assigner
  and the recipient is the assignee. Use `translateFor(locale, key, params)`
  from `@/lib/i18n/server-messages` with an EXPLICIT locale, resolved via
  `resolveRecipientLocale(user.uiLanguage)` from `@/lib/email/recipient-locale`.
  The fallback there is `bg` — deliberately NOT `DEFAULT_LOCALE`, which is `en`
  for *unauthenticated* surfaces; an email recipient is a known user whose
  column default is `bg`.
  `EnqueueEmailInput.locale` is **required**, not defaulted: `NotificationOutbox`
  stores RENDERED text, so a forgotten locale is indistinguishable from a chosen
  one and would silently ship the wrong language. A producer with only an email
  must write `RECIPIENT_FALLBACK_LOCALE` so the decision shows in the diff.
  Inside an HTML template, **resolve each translated string to a local `const`
  before interpolating it** — `${escapeHtml(t)}`, never
  `${escapeHtml(await t('k', { n }))}`. Until #717 the escaping guard's
  extractor excluded braces, so the inline form was invisible to it; the
  extractor is brace-balanced now, and the local-const form keeps each
  interpolation readable at the point it is escaped.
  **A value shown to a recipient must not be a pre-rendered sentence.**
  `DueItem.reason` was English prose built in the monitor jobs; a monitor
  produces each item ONCE and the digest routes it to SEVERAL recipients whose
  languages differ, so the language is not knowable where the item is built.
  It is a descriptor now — `{ key, params }` resolved under
  `notificationEmail.digest.reason.*` at render time. Any future
  recipient-facing string produced far from its reader wants the same shape.
  **The invite email is the one exception, and it uses the INVITER's language**
  (#722). An invitee has no `User` row, so there is no recipient locale to read
  and any answer picks a proxy. The product call was the inviter's, via
  `inviterLocale(ctx.userId)` from `@/lib/email/inviter-locale` — right for the
  common case (a Bulgarian farm inviting Bulgarian staff) and no worse than
  English for a foreign invitee. **English is NOT the neutral fallback it looks
  like**: measured, four of five users carry `uiLanguage: 'bg'`. The resolver
  fails SOFT — an invite in the fallback language is recoverable, one that never
  sends because a lookup threw is not, and the invite row is already committed
  by then. `tests/guards/invite-email-locale-wiring.test.ts` derives the call
  sites from the filesystem, so a fourth invite route is covered the moment it
  exists.
  Every outbound email is now localised.
- **Path alias**: `@/` maps to `src/`. Always use this alias — never relative paths crossing layer boundaries.
- **`@/lib/storage`, never `@/lib/storage/index`.** `src/lib/storage.ts`
  AND `src/lib/storage/index.ts` both exist; the bare specifier resolves to
  the FILE, so the two name different modules that read as one. Production
  behaviour is identical (the shim re-exports the abstraction) — but
  `jest.mock` is keyed on the resolved path, so mocking one leaves the other
  REAL. That shipped a test which got the real `LocalStorageProvider`, whose
  `createReadStream` on a fixture path emitted an unhandled async `error`
  and killed the worker PROCESS: CI showed a flaky shard with no jest
  summary while the tests themselves passed. Guarded by
  `tests/guards/storage-module-specifier.test.ts`. More generally: **when
  you mock a module, assert the mock was CALLED** — "the mock did not apply"
  is silent whenever the real thing returns a lazily-failing handle.
- **Two `DATABASE_URL` vars**: `DATABASE_URL` points to PgBouncer (transaction-mode, used at runtime). `DIRECT_DATABASE_URL` points directly to Postgres (used for Prisma migrations).
- **A side effect that ANNOUNCES a write goes through `afterCommit`, never inline.**
  `afterCommit(name, fn)` from `@/lib/db/after-commit` queues `fn` until the
  OUTERMOST transaction commits; a rollback discards the queue unrun. Both
  transaction helpers in `src/lib/db-context.ts` own a scope, placed OUTSIDE
  `$transaction`, so a usecase may queue from inside its callback and the drain
  happens after COMMIT. Reach for it for a `Notification` row, an SSE publish,
  an outbox enqueue, a webhook — anything whose only job is to tell somebody
  that a write happened.
  **Why a collector and not "move the call after the closure":** a usecase
  cannot know whether it is the outermost transaction. `runInTenantContext` IS a
  `$transaction` and usecases call usecases, so a helper that moved its own
  notify one level out would still be inside somebody else's. The queue is
  addressed through `AsyncLocalStorage`, because the top of a shared stack
  under concurrent requests is whichever request pushed last. This used to read
  "NOT the module-level stack `audit-context.ts` uses" — that contrast is gone:
  the same reasoning turned out to apply to `audit-context.ts` itself (#1259,
  7 of 8 concurrent writes encrypted under the WRONG tenant's DEK), and it is
  AsyncLocalStorage now too.
  The defect it was built for: `notifyOtherParty` (exchange-messaging) wrote the
  bell rows, published the SSE events and enqueued the mail from inside the
  sender's still-open transaction, under a comment claiming the opposite. Those
  writes land in an INDEPENDENT transaction (Prisma does not nest), so they
  committed early — and a sender transaction that then rolled back left the
  other party notified about a message that does not exist. Measured by
  restoring the old line: 2 `Notification` rows where there must be 0
  (`tests/integration/exchange-notify-after-commit.test.ts`).
  Prisma's non-nesting also decides the conservative case: an inner
  transaction's WRITES survive an outer rollback, its ANNOUNCEMENTS do not.
- **The pg pool `max` is EXPLICIT, and a transaction that needs a second
  connection deadlocks at it.** `PG_POOL_MAX` (`src/lib/db/pool-config.ts`) is
  derived — `floor((25 − 1) / 2) = 12` — from pgbouncer's `DEFAULT_POOL_SIZE:
  "25"` in `deploy/docker-compose.vm.yml`, the two containers that connect
  through it (`app` + `worker`), and one slot reserved for an operator session.
  It was `pg`'s default of 10 until #1191's P0.8: a ceiling nobody chose.
  `connection_limit` in the URL is NOT the lever — with `@prisma/adapter-pg` the
  pool is `pg`'s and that parameter is read by nobody.
  `tests/guards/pg-pool-size-fits-pgbouncer.test.ts` re-derives it from the
  compose file rather than trusting the comment.
  **A transaction that holds one slot and then wants a second cannot make
  progress once every slot is held that way** — nobody can acquire, so nobody
  can release, and `pg` has no `connectionTimeoutMillis` so the wait is
  unbounded. The caller sees Prisma's 5s interactive timeout (`P2028`) or its 2s
  `maxWait`; neither error names a pool, which is why this reads as a Prisma
  bug. Measured 2026-10-01 (#1191's P0.8) with a `pg_stat_activity` sample
  showing 12 backends all `idle in transaction`. Two things did it; **one is
  fixed and one is not, and they fail in opposite directions.**
    - **The DEK read is FIXED (#1223).** `withEncryptionExtension`'s
      `resolveTenantDekPair` awaits `getTenantDek(tenantId)` on every model read
      and write, and `tenant-key-manager` reads the `Tenant` row through the
      GLOBAL client rather than the caller's `tx` — so the first model operation
      of a COLD tenant's transaction wanted slot 13. Both helpers in
      `src/lib/db-context.ts` now call `prewarmTenantKeys(tenantId)` BEFORE
      `$transaction`, so the lookup runs with nothing held and the in-transaction
      call is a cache hit. Costs nothing in steady state (a `Map` hit), and is
      skipped when the caller injects a client — a different pool cannot
      deadlock this one, so the lookup would be waste. It IS unconditional
      otherwise, so a cold tenant whose transaction body touches no model
      (raw SQL only, or `GLOBAL_KEK_MODELS` only) now pays a lookup it used to
      skip — once per tenant per process, outside any transaction, and the
      alternative is predicting from outside the callback what the callback
      will touch. It never throws:
      `resolveTenantDekPair` owns the global-KEK fallback and must stay the
      authority on a failed lookup, so a propagating prewarm would make
      `withTenantDb` for a nonexistent tenant fail where it used to proceed.
      `tests/integration/tenant-tx-single-connection.test.ts` asserts the
      PROPERTY at `max` concurrency, cold, barrier-synchronised so every
      transaction is provably open — and carries a positive control that takes a
      second connection BY HAND and still deadlocks, because three green
      concurrency tests are also what a harness that never achieved concurrency
      produces. Before the fix: 12/12 stalled barrier-synchronised, 9/12 as an
      unsynchronised burst.
    - **`appendAuditEntry` no longer reaches for a second connection at all,
      since #1223's before-commit collector.** It used to open its own
      `$transaction` on the global client for every audited write, so each one
      needed a SECOND pool connection; at `max` it could not get one and the
      row was lost while the write committed. Measured at exactly `max`: 12
      writes, 11 audit rows, every one of them `actorType: SYSTEM` — the rows
      the EXTENSION writes, which `logEvent`'s #1271 fix could not reach
      because a `$extends({ query })` handler is given no transaction client.
      `src/lib/db/before-commit.ts` closes it: the extension ENQUEUES into an
      ALS-scoped queue and the `db-context.ts` helpers, which hold `tx`, drain
      it onto that transaction before COMMIT — the mirror of `afterCommit`.
      After: 12 writes, 12 audit rows. **The queue and the drain are ONE
      function on purpose** — splitting them lets a nested helper drain the
      OUTER transaction's rows onto its own `tx`, and `runInTenantContext` IS
      a `$transaction` that usecases nest. Two further consequences, both
      deliberate: audit rows are now ATOMIC with the write they describe (a
      rolled-back write no longer leaves a row asserting it happened, which it
      did before), and the per-tenant advisory lock is taken once per
      transaction instead of once per row. The historical detail below is kept
      because the MEASUREMENTS are what make the shape defensible:
      and past `max` that tier still loses the audit row — no longer silently.** It opens its own `$transaction` on the
      global client for every audited write and is not cached. The failure is
      not the visible one: measured 2026-10-02 at exactly `max`, with every DEK
      warm and disjoint tenants per run — `max - 1` wrote 11 tasks and 11 audit
      rows, `max` wrote **12 tasks and 0 audit rows, with zero rejections**, and
      a repeat run wrote 12 tasks and 4 audit rows. The audit transaction's 2s
      `maxWait` expires inside the caller's 5s budget, the extension's
      best-effort `catch` absorbs it, and the caller’s own write then commits
      fine.
      **The catch now REPORTS the gap**: `auditMiddlewareLogger.error`
      (`audit.write_failed`, carrying tenantId / requestId / model / operation —
      never `diffJson`, which holds the changed row) plus the
      `audit.write.failures` counter, both UNGATED. Until the #1223
      observability change that log sat inside
      `if (env.NODE_ENV === 'development')`, so in PRODUCTION the catch was
      EMPTY: a hole in the hash-chained trail emitted no log, no metric, no
      error and no trace, which is why the measurement above had to count rows
      to find it. Each reporter is individually try-wrapped — a committed write
      must never fail because the telemetry for its missing audit row broke.
      The LOSS is now FIXED for the seventeen compliance-critical entities in
      `src/lib/audit/fail-closed-entities.ts`, and remains open for everything
      else — a deliberate split, not a half-finished one. `logEvent` already
      RECEIVED the caller's transaction on all 222 of its call sites and
      discarded it (the parameter was spelled `_db`), so for those entities the
      chain append now runs ON that transaction: no second connection, and the
      row commits or rolls back with the write it describes. Measured:
      `PG_POOL_MAX` concurrent fail-closed audited writes all commit AND all
      get their row, and reverting the routing fails that same assertion.
      **Why not everywhere.** On the caller's transaction a failed insert
      ABORTS it, and until #1223 there were no SAVEPOINTs in `src/` or
      `prisma/` at all (stated at
      `exchange-messaging.ts`, relied on by `farm-profile.ts`, measured by
      `tests/integration/notify-transaction-abort.test.ts`). A TOLERATED
      failure there would turn the caller's COMMIT into a silent ROLLBACK and
      destroy the business write — strictly worse than losing the audit row,
      and #1102/#1168 verbatim. Best-effort entities therefore keep their own
      transaction by design rather than by omission. One side effect worth
      knowing: a best-effort audit row SURVIVES a write that rolled back, so
      the trail can assert something that did not happen — pre-existing, and
      now fixed for the seventeen.
      Membership rule, so the list is not taste: an entity is fail-closed when
      the audit row IS the compliance artifact rather than a record about one
      — it GRANTS or REVOKES access, mints or burns a CREDENTIAL, moves KEY
      material, or creates or destroys a TENANCY. The agronomic surface is
      deliberately excluded: a field entry must not be blocked by an audit
      subsystem problem.
      **The tier has an operator KILL SWITCH, and `shouldFailClosed` is the one
      place that reads it.** `AUDIT_FAIL_CLOSED_ENABLED=0` degrades every
      fail-closed entity to best-effort; anything else — unset, empty,
      `false`, a typo — leaves it ENFORCING, because an audit control must not
      be disarmed by a misspelling. It is read from `process.env` on every
      call, never hoisted and never routed through `src/env.ts`, both of which
      would need a restart; that is the `AUDIT_STREAM_RETRY_ENABLED`
      convention and the only reason a mid-incident switch is worth having.
      It exists because the tier is designed for a PER-ROW failure while the
      writer can fail WHOLESALE: measured 2026-10-03, the chain append failed
      on 275 of 275 attempts under the E2E runtime and took tenant creation
      and invite creation down with it (production was unaffected — #1287 —
      but the shape is real, and the only other lever was a deploy).
      Degrading is a LOSS, not a fix: each row that would have aborted now
      commits unaudited and is reported by `reportLostAuditRow`, and a WARN
      fires once per process so a switch left on is visible in the log rather
      than only in someone's memory of an incident. `isFailClosedAuditEntity`
      stays PURE and answers the other question — whether the ENTITY is
      compliance-critical, which no env var changes — so tests and
      enumerations keep using it while write paths use `shouldFailClosed`.
      Both callers (the Prisma extension via the queue, and `logEvent`) go
      through it, because two spellings of one policy is how a tier ends up
      enforced on one path and not the other. Held by
      `tests/unit/audit-fail-closed-kill-switch.test.ts`, mutation-proved
      against a hoisted read (3 failures), a truthiness check (1) and an inert
      switch (3).
      On observability, "alertable" would overstate what
      shipped: the error log is the signal that reaches a human, because
      agri-saas deploys NO OTel→Prometheus→Alertmanager pipeline (the live
      alerting is one GCP uptime check on `/api/readyz`). The `AuditRowLost`
      threshold is DECLARED in
      `infra/observability/prometheus/rules/alerting-rules.yml` — `> 0` over a
      window rather than a ratio, because one missing entry is a permanent gap
      in a tamper-evident chain — and fires only if that pipeline is ever
      deployed. Pinned by
      `tests/integration/audit-write-failure-is-loud.test.ts` with a negative
      control (a reporter firing unconditionally would satisfy the regression
      test and alert on every healthy write).
      Supportable concurrency for an audited write is now `max` on BOTH tiers.
      It was `max - 1` on the best-effort tier until the collector landed, which is
      why the P0.8 hardening test runs 11 sends and not the
      20 its roadmap asked for — that test's bound is now historical rather
      than required. A best-effort row can still be lost if its insert fails
      for some OTHER reason: the savepoint rolls it back, the write commits,
      and the gap is
      reported by the same `audit.write_failed` log line and
      `audit.write.failures` counter #1269 added, with a `stage` field saying where.
      **The `afterCommit` seam IS reachable from the extension, contrary to what
      this file said for a day, and to what `audit-context.ts`'s docblock
      CLAIMED until #1259.** That docblock's "Prisma's $use middleware runs in a
      detached async context that loses ALS state" is a statement about Prisma
      **5**, and `$use` was removed in Prisma 7 — and `audit-context.ts` is
      AsyncLocalStorage itself since #1259, so that docblock now records the
      claim as corrected history rather than making it.
      Measured 2026-10-02 by
      `tests/integration/prisma-extension-als-reachability.test.ts`: a
      `$extends({ query })` handler calling `afterCommit` has its effect
      DEFERRED to the post-commit drain, not fired inline — so a query extension
      DOES see the ALS store. Whether the audit write SHOULD move there is still
      a design question (an audit row written after COMMIT has a crash window,
      and the alternative of writing it on the caller's `tx` changes the
      documented "best-effort, never breaks the original write" contract and
      holds `pg_advisory_xact_lock(hashtext(tenantId))` for the whole caller
      transaction) — but it is not blocked by ALS. **Do not re-derive "the
      extension cannot see ALS" from that Prisma-5 docblock; run the test.**
  Full sweep in
  `docs/implementation-notes/2026-10-01-p0-8-after-commit-notifications.md`;
  the fix and the remaining half in
  `docs/implementation-notes/2026-10-02-tenant-tx-single-connection.md`.
- **Page-section rhythm** (Roadmap-5 PR-9): the spacing scale
  (`tight` / `compact` / `default` / `section` / `page`) is rich, but
  vertical page rhythm wants only TWO answers most of the time.
    - **`space-y-section`** — between top-level page regions (page
      header, filter toolbar, primary table, footer toast). The
      24-32 px breath that says "this is a different kind of thing".
    - **`space-y-default`** — inside a card, between sibling fields,
      between rows in a panel. The 16 px breath that says "same kind
      of thing, next instance".
  Use `space-y-tight` / `space-y-compact` only inside dense field
  groups where the children are micro-elements (icon + label, status
  pills). The semantic-scale ratchet at
  `tests/guards/spacing-scale-discipline.test.ts` already bans raw
  numerics; this convention guides the choice between `default` and
  `section`.
- **Border tone discipline** (Roadmap-5 PR-10): three semantic
  border tones, each with a clear role.
    - **`border-border-subtle`** — DEFAULT. Structural separators
      (form-field outlines, table-cell separators, quiet panel
      boundaries, sidebar item dividers). If you have to ask
      "default or subtle?", the answer is subtle.
    - **`border-border-default`** — Reserved for surfaces that need
      explicit containment: card outer border, table outer border,
      modal/sheet boundary, popover/tooltip outline. The "this is a
      discrete surface" statement.
    - **`border-border-emphasis`** — Reserved for state: selected
      card, active panel, focused field, hovered click target. Tone
      that says "this is the one you mean".
  Forward enforcement at `tests/guards/border-tone-budget.test.ts`
  (budget ratchet that locks the current count and only ratchets
  down).
- **The button size ladder is a SINGLE RUNG** (#776, 2026-09-01). `xs`, `sm`,
  `md` and `lg` all resolve to the same 28px rung —
  `h-7 px-[0.7rem] text-[0.76rem] gap-tight tracking-[0.005em] font-[560]
  [&_svg]:size-[15px]` — in `button-variants.ts`, in BOTH mirrors in
  `button.tsx`, and in `controlSize`. Adopted from the sibling product,
  reversing four deliberate density passes (R20-PR-A/C/E/F, R22-PR-C,
  R24-PR-C); those guards now assert UNIFORMITY where they used to assert a
  gradation, and each records what it dropped and why.
    - **The `size` prop is kept on purpose.** Call sites still record intent,
      and reversal stays a one-file edit. `r20-pra-foundation.test.ts` pins
      the four keys existing, so a collapse cannot quietly become an
      amputation.
    - **The #765 coarse-pointer floor is untouched** — `pointer-coarse:min-h-11`
      on the base and `min-w-11` on `icon`. On a phone every button is still
      44px; the collapse is desktop-only. `button-touch-target-floor.test.ts`
      passed through the change unmodified.
    - **`<Input>` collapsed too, so the row actually lines up.** The lockstep
      between the button scale and `controlSize` was documented and asserted
      long before it was WIRED: `controlSize` has zero importers, `<Input>`
      declares its own size map, so collapsing it changed nothing on screen
      and a 28px button sat beside a 36px field. `input.tsx`'s map is now the
      same rung. The sibling product still ships that mismatch, for exactly
      this reason — its `controlSize` has no consumers either.
      Do NOT "fix" a future misalignment by re-grading the buttons.
    - **Every field is ≥44px on a phone**, and that floor WIDENED rather than
      carried over: Roadmap-6 P4 put `min-h-[44px]` on `md` alone, so a
      collapsed `sm` would have gone from 32px to 28px on mobile. It is on
      the rung now. The floor stays VIEWPORT-based (`md:` breakpoint) while
      the button's is POINTER-based (`pointer-coarse:min-h-11`) — matching
      heights did not require matching the mechanism, and
      `tests/e2e/mobile/forms.spec.ts` measures the result rather than the
      mechanism.
- **Action button vocabulary** (revised 2026-05-28). The label on a
  primary "create" header button is JUST the entity noun. The `+`
  glyph rides the `icon` slot — never as text. So an entity list page's
  header trigger reads:

  ```tsx
  <Button variant="primary" icon={<Plus />} onClick={…}>Asset</Button>
  ```

  not `+ Asset` (in text) and not `Create Asset` / `New Asset` /
  `Add Asset` (verb-prefixed). The verb is dead weight once the Plus
  glyph is doing the work, and the Button primitive's icon-balance ghost
  optically centres `[+] Asset` as one symmetric unit.

  Caveats — where verbs still belong:
    - **Modal/dialog confirm buttons** keep their verbed form
      (`Create asset`, `Add document`, `Save policy`) — confirmation
      surfaces need to declare the action, not just the subject.
    - **Detail-page "+ child entity" affordances** that attach to an
      open parent (the "Record" trigger on an asset's Maintenance tab —
      `assets/[id]/MaintenanceTab.tsx`, `icon={<Plus />}` + bare noun —
      or a task detail page's evidence / comment forms) follow this same
      icon-slot rule, but if you keep a verb it's `Add {Entity}` (the
      child-attachment register).
    - **Traceability / cross-entity association** uses
      `Link {Entity}` (`Link Asset`) — the verb
      changes the meaning (associating, not creating).

  Forward enforcement:
    - `tests/guards/action-label-vocabulary.test.ts` — bans literal
      `+ Word` text in JSX/source.
    - `tests/guards/action-button-canonical-entity-label.test.ts` —
      asserts the canonical entity-page header buttons render
      `icon={<Plus />}` + bare noun, AND that the header-action
      i18n keys (`assets.addAsset` → "Asset", `evidence.addEvidence`
      → "Record") hold just the noun, not a verb-prefixed string.
      Both halves of that guard are down to those two pages —
      `audits.newAudit` / `findings.newFinding` and the pages that
      rendered them went with GRC teardown phase 2 (#547). A verbed
      `newAudit` still lives under `dashboard`, deliberately: the
      dashboard "Quick Actions" block is a different register and is
      outside the header-action rule.
- **Destructive-action vocabulary** (Roadmap-4 PR-9): every
  `<ConfirmDialog tone="danger">` confirmLabel MUST start with one of
  the canonical verbs below. Pick the one that matches the actual
  effect — the verb is the user's last clue before they commit.
    - **`Delete {Entity}`** — permanent erasure of a top-level entity
      or configuration (`Delete configuration`). The data is gone.
    - **`Remove {Item}`** — detach an item from a parent OR turn off
      an enrollment (`Remove MFA`, `Remove document`). Source row may
      live on.
    - **`Revoke {Credential}`** — invalidate an authority / credential
      (`Revoke API key`, `Revoke SCIM token`, `Revoke session`).
    - **`Discard {Draft}`** — abandon unsaved or draft state.
    - **`Archive {Entity}`** — soft delete with history preserved.
    - **`Unlink {Entity}`** / **`Detach {Entity}`** — break an
      association without deleting either side.
    - **`Reject {Request}`** — refuse an approval request or finding.
  Forward enforcement at `tests/guards/destructive-vocabulary.test.ts`.
- **Search placeholder vocabulary** (PR-9): every `<FilterToolbar
  searchPlaceholder>` value follows `Search {entityPlural}…`. One
  ellipsis (`…`, single character — not `...`). NEVER append a
  parenthetical hint like `(Enter)` / `(Press Enter)` — the
  FilterToolbar search is **live** (typing filters the table on a
  short debounce, no Enter required), so an Enter hint would be
  actively wrong. Forward enforcement at
  `tests/guards/search-placeholder-vocabulary.test.ts`. The same
  format applies to i18n `searchPlaceholder` values in `messages/`.
  Free-text search lives **inside the Filter dropdown**, NOT in a
  separate search bar: passing `searchPlaceholder` turns the Filter
  popover's top input into a live content search (the categories stay
  listed below it). Every standard list page MUST wire `searchId` +
  `searchPlaceholder` (the R14-PR7 kill sweep was reversed 2026-05-30,
  then the search was moved into the filter bar per user directive);
  presence is locked by `tests/guards/r14-no-page-searchbars.test.ts`.

## Implementation notes

**This file is a contract, not a scrapbook: a PR that invalidates a claim in
CLAUDE.md updates that claim in the same diff.** A stale operating manual is
worse than none — it sends the next engineer (or agent) down a path the code no
longer supports. If your change moves a file, renames a symbol, flips a default,
or supersedes a documented mechanism, fix the sentence here too.

Every substantive prompt — architectural decisions, new features, security
or infrastructure changes, anything worth revisiting in six months — lands
a short markdown file in `docs/implementation-notes/<YYYY-MM-DD>-<slug>.md`
alongside the code + tests. Commit messages carry the `what + why`; these
notes carry the `design + decisions + tradeoffs` in a grep-friendly form.

**Default structure** (skip any section that doesn't apply):

```markdown
# YYYY-MM-DD — <feature name>

**Commit:** `<sha> <commit subject>`

## Design
<architectural shape — diagrams or prose, 10-30 lines>

## Files
<table of files changed with one-line role per file>

## Decisions
<bullet list of non-obvious tradeoffs and why they went the way they did>
```

**Do NOT include a "Tests added" section** — the test files themselves
are the durable record. Duplicating counts into docs creates rot when the
test list moves.

**Skip** for small UI tweaks, config bumps, bug fixes that don't shift
architecture. The bar is "would a future engineer need the context?"

Existing examples: `docs/implementation-notes/2026-04-22-*.md`.

## UI Platform — Epics 51–60

The following epics established shared primitives, guardrail tests, and
contributor guides. **Always use the platform primitives** — never
hand-roll a replacement. Each section points to its decision-tree doc.

### Epic 51 — Design Tokens & Theme System

Use semantic token classes (`bg-bg-default`, `text-content-muted`,
`border-border-subtle`) instead of raw Tailwind color scales
(`bg-slate-800`, `text-slate-400`). Use `<Button>`, `<StatusBadge>`,
and `<EmptyState>` components instead of legacy `.btn` / `.badge` CSS
classes. See `docs/token-cheatsheet.md` and `docs/ui-buttons.md`.

**«Слънце» inherits from LIGHT, not from dark, and there is no
`data-theme="sunlight"`.** `attributesFor('sunlight')`
(`src/lib/theme/theme-cookie.ts`) returns `{ theme: 'light', contrast:
'high' }`, so the element carries `data-theme="light"` AND
`data-contrast="high"` together. Both selectors are single attribute
selectors, so specificity ties and SOURCE ORDER decides: `[data-contrast="high"]`
is declared after `[data-theme="light"]` in `tokens.css`, so it wins for the 25
tokens it declares and LIGHT supplies the remaining 105. Writing
`data-theme="sunlight"` selects no palette at all.

Both P2.3 artefacts resolved it against dark instead —
`scripts/generate-tokens.mjs` and
`tests/guards/token-contrast-wcag.test.ts` — and because the generator has no
cascade, that shipped **58 wrong colours** into `AgrentTheme.highContrast`
for iOS (P2.8's consumer): «Слънце» on the web showed the cream light palette
while Swift returned the dark forest greens. P2.9 fixed both; the chain lives
in `CASCADE` in each file, and the guard cross-checks its own chain against
the generator's COMMITTED output rather than against a second copy of the
constant. A fourth theme adds a `CASCADE` entry — do not reintroduce a
`?? dark` default, which is wrong for any theme that is not a sibling of light.

**Rollback of a colour IS a revert of `design/tokens.json`**, and that is
measured rather than asserted: all 178 colour-literal custom-property
declarations under `src/**/*.css` sit in `src/styles/tokens.css` and are
generated from the JSON (`npm run tokens:check`, CI `Lint` job); the 21 in
`globals.css` are `var(--token)` aliases carrying no values, and the only
hand-authored declarations in `tokens.css` are the three
`--duration-*` reduced-motion overrides inside the `@media` block, which the
generator deliberately skips via `themeOfLine()`. A NEW colour declared in
another stylesheet would escape that rollback silently, so
`tests/guards/tokens-generated-in-sync.test.ts` fails on one.

### Epic 52 — DataTable Platform

Every list page must use `<DataTable>` from `@/components/ui/table`.
Never add raw `<table>` elements in app pages. Use the
`useListPagination` adapter for cursor-based APIs. See
`tests/guards/epic52-datatable-ratchet.test.ts`.

**List-page layout (the viewport-clamped scroll pattern):**
Wrap the page in `<ListPageShell>` from `@/components/layout/ListPageShell`
and pass `fillBody` to the primary `<DataTable>`. Result: the table
card fits the viewport, only the table body scrolls — page header,
filter toolbar, and pagination footer stay anchored. On mobile (<md)
the shell is a no-op and natural document scroll resumes.

```tsx
<ListPageShell>
  <ListPageShell.Header>...</ListPageShell.Header>
  <ListPageShell.Filters><FilterToolbar ... /></ListPageShell.Filters>
  <ListPageShell.Body>
    <DataTable fillBody data={...} columns={...} />
  </ListPageShell.Body>
</ListPageShell>
```

A new app page that imports `DataTable` MUST either wrap in
`<ListPageShell>` OR add itself to `EXEMPTIONS` in
`tests/guards/list-page-shell-coverage.test.ts` with a written
reason. Exemptions exist for multi-table / multi-section admin pages
(admin/api-keys, admin/members, admin/notifications,
admin/integrations) and
detail-page sub-tables / wizards where viewport-clamping doesn't fit. See `docs/epic-52-list-page-shell.md` for the
decision tree.

### Entity-page architecture (`EntityListPage` + `EntityDetailLayout`)

Two composition shells live in `src/components/layout/` —
`EntityListPage` (list pages) and `EntityDetailLayout` (detail
pages). Both carry **layout, not business content**. Reach for them
whenever you build a new entity page; never re-introduce the inline
`<ListPageShell> + <FilterToolbar> + <DataTable>` block or the
inline back-link / title / tab-bar / loading-skeleton dance.

```tsx
// List page — reference impl: grain/contracts ContractsClient.tsx
<EntityListPage<Row>
  header={{ title, count, actions }}
  filters={{ defs, searchId, searchPlaceholder, toolbarActions }}
  table={{ data, columns, getRowId, onRowClick, emptyState, … }}
>
  {/* page-level modals/sheets sit as children */}
</EntityListPage>

// Detail page — reference impl: journal/[id]/page.tsx
<EntityDetailLayout
  back={{ href, label }}
  title={…}
  meta={…}
  actions={…}
  loading={…}
  error={…}
  empty={…}
  tabs={…}
  activeTab={…}
  onTabChange={…}
>
  {/* active-tab content owned by the page */}
</EntityDetailLayout>
```

The shells are reusable; the pages stay opinionated. Column defs,
filter defs (including runtime-derived options), data fetching,
mutations, optimistic updates, modals, sheets, permission gates,
and domain-specific tab bodies (e.g. `LinkedTasksPanel`,
`AttachedEvidencePanel` — both mounted by the asset detail page) all
stay in the page. The GRC teardown deleted the two other panels
originally named here: `TraceabilityPanel` (#547) and `TestPlansPanel`
(#501). The docblock at `src/components/layout/EntityDetailLayout.tsx`
still names both — it is stale, not a pointer to live code.

**When NOT to reach for these shells.**

  - Multi-table / multi-section admin pages (already in the Epic 52
    `EXEMPTIONS` list — admin/api-keys, admin/members,
    admin/notifications, admin/integrations).
  - Wizards / multi-step flows where the page isn't a single list or
    detail.
  - Sub-tables nested inside a detail tab — `<DataTable>` directly
    is the right primitive there, not `<EntityListPage>`.

**Adoption ratchet.** Each adoption is locked by a structural test
that asserts the page mounts the shell and doesn't hand-roll the
inline composition. The GRC teardown deleted the two originally named
here (`practices-client-shell-adoption` / `practice-detail-shell-adoption`);
the surviving locks are `{bins,contracts,costs,yield}-list-shell-adoption.test.ts`
(list) and `entity-detail-shell-adoption.test.ts` (detail, pinned to
`journal/[id]`). When you migrate a new entity page, add a sibling
`*-shell-adoption.test.ts` next to those — same shape, same
regression-class lock.

The detail ratchet is the load-bearing one and is easy to delete by
accident, because the guards that *look* like they cover it do not: the
`entity-detail-{shell,layout}-coverage` guards only assert
`<EntityDetailLayout` appears, `detail-page-tabs-slot` is a negative pin,
and `state-coverage` EXEMPTS detail pages precisely because they
"delegate loading to EntityDetailLayout" — a delegation only the detail
ratchet actually verifies.

See `docs/implementation-notes/2026-04-30-entity-page-architecture.md`
for the unified architecture rationale and
`docs/implementation-notes/2026-04-30-entity-detail-layout-extraction.md`
for the detail-shell extraction.

### Epic 53 — Enterprise Filter System

Use `FilterToolbar` from `@/components/filters/FilterToolbar` together
with `FilterProvider` + `useFilterContext` from
`@/components/ui/filter/` for list-page filtering. Never build ad-hoc
`useState` + manual URL sync. See
`src/components/ui/filter/GUIDE.md` and `docs/filters.md`.

**A `multiple: true` facet has a REQUIRED server-side counterpart.**
`filterStateToUrlParams` comma-joins a multi-select facet into ONE
param (`?status=DRAFT,ACTIVE`), so a route that reads it with a bare
`searchParams.get(key)` receives the literal string `"DRAFT,ACTIVE"`.
Passing that to Prisma as an enum equality throws a
`PrismaClientValidationError` — a 500 the list page renders as its
EMPTY state, i.e. a confident claim of zero matching rows in response
to a crash. Parse such params with `parseCsvEnumParam` from
`@/lib/validation/query-params` (validates each member against
`z.nativeEnum(...)`, 400 on any invalid one), type the usecase's
filter field as an ENUM ARRAY — never `string` plus a cast — and query
with `{ field: { in: [...] } }` guarded on `.length` so a cleared
facet omits the filter instead of emitting `{ in: [] }` (which matches
nothing). Reference: `grain/contracts` route + `listContracts`.

**A failed list read must never fall through to the empty state.**
`<DataTable>` / `EntityListPage` accept `error` — wire it. Gate it on
having nothing to show (`isError && rows.length === 0`) so a failed
BACKGROUND refetch keeps stale rows on screen: `error` renders
*instead of* the table, so raising it unconditionally blanks good
data. See `docs/implementation-notes/2026-07-25-grain-contract-defect-fixes.md`.

### Epic 54 — Modal & Sheet Strategy

Use `<Modal>` for quick create/edit/confirm flows and `<Sheet>` for
inspect-and-edit without losing list context. Never hand-roll a
`fixed inset-0 bg-black/…` overlay. See `docs/modal-sheet-strategy.md`.

### Epic 55 — Combobox & Form Primitives

Use `<Combobox>` for selection lists, `<UserCombobox>` for people
pickers, `<RadioGroup>` for 2–5 visible choices, and wrap every
field with `<FormField>`. Never use raw `<select>` or
`<input className="input">` in app pages. See
`docs/combobox-form-strategy.md`.

### Epic 56 — Tooltip & Copy Primitives

Use `<Tooltip>` for hover/focus hints, `<InfoTooltip>` for help icons,
`<CopyButton>` / `<CopyText>` / `useCopyToClipboard` for clipboard.
Never use raw `navigator.clipboard` or add new `title=` attributes.
See `docs/tooltip-and-copy-strategy.md`.

**Tooltips carry TWO open gestures and exactly ONE behaviour.** Since
#449 the primitive drives `open` itself on a coarse pointer — tap
toggles, dismissing on the next outside tap, on scroll, or after
`TOUCH_AUTO_DISMISS_MS` — because Radix gives touch users nothing and a
desktop-only tooltip is decoration on a mobile-first product. Content,
surface, side/align/offset are identical for both; only the gesture
differs. That second path lives **inside `src/components/ui/tooltip.tsx`
and nowhere else**: never re-implement it at a call site
(`matchMedia('(pointer: coarse)')`, `'ontouchstart' in window`,
`onTouchStart` on a trigger), never add a prop that forks or disables it
(`disabled` is the sanctioned escape hatch and short-circuits for
everyone), and never drop one of the four dismissal paths (outside tap,
scroll, Escape, timeout).

**The tap handler must never call `preventDefault()`.** #449 shipped it on
the trigger's `onPointerDown` + `onClick` to make Radix's
`composeEventHandlers` skip its composed close-handlers; it also cancelled
the default action of whatever the tooltip wrapped, so on touch a
`<Tooltip>` around a `<Link>` (Next's app-dir Link returns early on
`e.defaultPrevented`) or an `<a href download>` did nothing but show its
own tooltip — ~17 inline call sites plus every collapsed-sidebar nav item.
Radix's close requests are declined in `handleTouchOpenChange` instead:
because the coarse path already passes `open` + `onOpenChange`, every
close arrives as a call we own rather than a DOM event we have to
suppress. Declining a close is invisible to the wrapped element;
preventing an event is not. Escape became ours for the same reason —
Radix's DismissableLayer dismissal is declined along with every other
close — and is wired through the Content's `onEscapeKeyDown`, which runs
before that dismissal and rides Radix's own document-level listener, so
Epic 57's ban on raw `keydown` listeners still holds.

`tests/guards/tooltip-touch-uniformity.test.ts` enforces the shape and
`tests/rendered/tooltip-touch.test.tsx` the behaviour — the latter
installs a coarse-pointer `matchMedia` per test, because the project-wide
jsdom stub answers `matches: false` and left the whole branch unexecuted.
See `docs/implementation-notes/2026-07-29-tooltip-touch-uniformity.md`.

### Epic 57 — Keyboard Shortcuts & Command Palette

Register shortcuts via `useKeyboardShortcut` — never
`document.addEventListener('keydown', …)`. Always supply a
`description`. See `docs/keyboard-shortcuts.md`.

### Epic 58 — Date Pickers

Use `<DatePicker>` for single dates and `<DateRangePicker>` for
ranges. Use `formatDate` / `formatDateTime` from `@/lib/format-date`
for display. Never use `<input type="date">` or raw
`toLocaleDateString`. See `docs/date-picker.md`.

### Epic 59 — Dashboard Charts

When adding or modifying charts/visuals on any dashboard page,
always use the shared chart platform. See `docs/charts.md` for the
decision tree. Never use raw `<svg>`, `<polyline>`, or inline
`style={{ width: \`\${pct}%\` }}` progress bars.

### Epic 60 — Shared Hooks & Polish Primitives

Import shared hooks from `@/components/ui/hooks` (barrel): `useLocalStorage`,
`useOptimisticUpdate`, `useEnterSubmit`, `useInputFocused`, `useScroll`,
`useScrollProgress`, `useInViewport`, etc. Use the polish primitives
`<Accordion>`, `<TabSelect>`, `<ToggleGroup>`, `<Slider>`,
`<NumberStepper>` for dense interaction areas. Never hand-roll a tab
bar, segmented filter row, `localStorage` cache, Enter-submit handler,
or `<input type="number">` stepper — reach for the shared primitive. See
`docs/epic-60-shared-hooks-and-polish.md` and the ratchet
`tests/guards/epic60-ratchet.test.ts`.

### Epic 60 — Automation Events & Dispatch (backend)

The event-driven backbone the rule-builder epic will stand on.
Import everything from `@/app-layer/automation` (single barrel).
Emit via `emitAutomationEvent(ctx, input)` — never construct
`AutomationExecution` rows directly from a usecase. When adding a
new event: add to `events.ts`, add the typed variant to
`event-contracts.ts`, emit from the usecase (or audit emitter), and
write a wiring test. **The "emit from the usecase" half is
now enforced**: `tests/guards/automation-catalog-emitter-coverage.test.ts`
fails if any `AUTOMATION_EVENTS` entry has no producer. It exists because
nine events (`TEST_PLAN_*` / `TEST_RUN_*` / `TEST_EVIDENCE_*`) outlived the
models they described — the rule builder went on OFFERING them as triggers
and the suggestions rail went on RECOMMENDING one at 0.82 confidence, so a
tenant could build a rule that could never fire. Nothing caught it because
`automation-templates.test.ts` validates templates against the CATALOGUE,
and the catalogue was the thing that was wrong. **A trigger / filter-field
catalogue is a claim about the schema: when a model dies, grep the
catalogues for it BY MODEL NAME.** Action handlers, rule-builder UI, and filter
DSL evolution all plug into clearly-marked seams — don't bypass
them. See `docs/automation-events.md` for the full contributor
guide and the decision-tree for extensions.

### Epic 67 — Destructive-action undo-toast convention

Every delete / unlink / remove flow in the product MUST use
`useToastWithUndo()` from `@/components/ui/hooks`. The hook returns
a stable `trigger` function that schedules the destructive commit
to fire 5 seconds after the click; during that window a custom
toast renders with an Undo button + animated countdown bar. Click
Undo and the timer is cancelled — the destructive write never
happens. The pending state lives at module scope (NOT in component
state) so commits survive client-side navigation, mirroring Gmail's
"undo send" UX.

The wired sites today: farm-task link removal on the task detail
page, exchange-listing withdraw on My Listings, lease removal on the
Rent page, and asset delete on the asset detail page. (The four GRC
sites this list used to name — `TraceabilityPanel`, practice-evidence
and practice-requirement unlink, vendor document removal — went with
the teardown.) The structural ratchet
at `tests/guards/epic-67-rollout-coverage.test.ts` locks the wiring
in — adding a new site means appending it to `SITE_CONTRACTS`.

Never write a `confirm()` blocking dialog or a fire-and-forget
direct DELETE for a routine destructive action — those are the
anti-patterns Epic 67 replaces. Top-level entity deletion (tenant,
organization) is the documented exception: cascading
consequences mean the 5-second window is too short, so use a
typed-confirmation modal there instead.

See `docs/destructive-actions.md` for the canonical wiring (snapshot
+ optimistic remove + trigger), the four invariants every site must
satisfy, message-tone rules, when NOT to use the pattern, and the
test layout (hook hardening at
`src/components/ui/hooks/__tests__/use-toast-with-undo.test.ts`,
baseline + UI tests under `tests/rendered/`, structural ratchet
under `tests/guards/`).

### Epic 68 — List virtualization

Two platform files import `react-window` v2's `List`, and feature code
imports neither. `src/components/ui/virtualized-list.tsx`
(`<VirtualizedList>`) is the general primitive — `<Combobox>`'s
`virtualized-options.tsx` is its one consumer.
`src/components/ui/table/virtual-table-body.tsx` (`<VirtualTable>`) is a
sibling implementation that `<DataTable>` routes to directly,
deliberately NOT built on the primitive: it renders `display: grid` divs
because bolting a windowed renderer into a real `<tbody>` needs
`display: block` on table elements plus a rewrite of the column-width
inference, and the risk to the existing 80+ tables was judged too high
(see that file's docblock). So a windowing-engine swap is a two-file
change, not one. Don't add a third seam — new surfaces use
`<VirtualizedList>`. `react-virtualized-auto-sizer` is no longer
involved and is no longer a dependency: v2's `List` self-measures its
parent via a ResizeObserver.

Two production rollouts:

- **`<DataTable>` rows** — auto-virtualizes when `data.length > 1000`.
  Threshold raised from 100 → 1000 in a follow-up to scope auto-
  virtualization to genuinely large unpaginated tables (the lower
  threshold caused click-intercept regressions on medium-sized
  tables in Playwright). `virtualize={false}` forces it off where the
  non-virtualized `<table>` layout is intentionally preserved (today two
  detail-page sub-tables: `grain/bins/[binId]/BinDetailClient.tsx` and
  `planning/[cropPlanId]/PlantingBoard.tsx`).
  `virtualize={{ threshold: N }}` customises.
  Pages that legitimately need virtualization on smaller datasets
  should opt in explicitly. Falls back to the standard `<Table>`
  automatically when pagination, column resizing, column pinning,
  or empty/error/loading chrome is requested.
- **`<Combobox>` / `<UserCombobox>` dropdowns** — auto-virtualize
  when visible options exceed `COMBOBOX_VIRTUALIZE_THRESHOLD = 50`.
  cmdk's nav (which assumes items live in the DOM) is bypassed in
  the virtualized branch via a bespoke capture-phase keyboard layer
  bound to the search input — ArrowDown / ArrowUp / Home / End /
  Enter all flow through there with `aria-activedescendant` tracking.
  `<UserCombobox>` is a thin wrapper over `<Combobox>` so it gets
  virtualization for free.

Performance contract: any list above the threshold renders ≤30 row /
option nodes regardless of dataset size. The benchmark test in
`tests/rendered/combobox-virtualize.test.tsx` locks both the
DOM-count invariant AND a wall-clock budget (1000 options + open in
<2s on CI) so accidental regressions are caught.

See `docs/list-virtualization.md` for the rollout decision tree
(when to use the primitive directly vs reach for `<DataTable>` /
`<Combobox>`), the four `VirtualizedList` contract rules, the
DataTable + Combobox preserved/dropped feature lists, and the test
layout.
