# Deployment Guide

## Quick Start (Local Production)

```bash
# 1. Copy env template
cp .env.production.example .env.production

# 2. Edit .env.production — set ALL secrets:
#    openssl rand -base64 32    (for AUTH_SECRET, JWT_SECRET)
#    Set OAuth credentials, POSTGRES_PASSWORD, NEXTAUTH_URL

# 3. Start
npm run prod:up
# or: docker compose -f docker-compose.prod.yml up -d --build

# 4. Verify
npm run smoke:staging   # works against localhost:3000
curl http://localhost:3000/api/health | jq .
```

## Architecture

```
┌───────────────────────────────────────────────┐
│ docker-compose.prod.yml                       │
│                                               │
│  ┌──────────┐ internal    ┌────────────────┐  │
│  │ db       │◄────────────│ app            │  │
│  │ pg:16    │  network    │ :3000          │  │
│  │ (no port │             │                │  │
│  │  exposed)│             │ entrypoint:    │  │
│  └────┬─────┘             │  1. migrate    │  │
│       │                   │  2. next start │  │
│  [pgdata]                 └──────┬─────────┘  │
│                           [uploads:/data]     │
└───────────────────────────────────────────────┘
```

## Required Environment Variables

| Variable | Required | Notes |
|----------|----------|-------|
| `POSTGRES_PASSWORD` | ✅ | Docker Compose DB password |
| `AUTH_SECRET` | ✅ | ≥16 chars, `openssl rand -base64 32` |
| `JWT_SECRET` | ✅ | ≥16 chars, `openssl rand -base64 32` |
| `NEXTAUTH_URL` | ✅ | Canonical URL (e.g. `https://app.example.com`) |
| `AUTH_URL` | ✅ | Same as NEXTAUTH_URL |
| `GOOGLE_CLIENT_ID` | ✅ | OAuth provider |
| `GOOGLE_CLIENT_SECRET` | ✅ | OAuth provider |
| `MICROSOFT_CLIENT_ID` | ✅ | OAuth provider |
| `MICROSOFT_CLIENT_SECRET` | ✅ | OAuth provider |
| `UPLOAD_DIR` | ✅ | Set to `/data/uploads` (Docker) |
| `DATA_ENCRYPTION_KEY` | ✅ **REQUIRED** in production | ≥32 chars, `openssl rand -base64 48`. **Production startup exits 1 if missing, too short, or equal to the documented dev fallback.** Both the Next.js app server and the BullMQ worker enforce this. See [encryption docs](encryption-data-protection.md). |
| `REDIS_URL` | ✅ **REQUIRED** in production (GAP-13) | Connection string. **Must be AUTHENTICATED in production** — carry a non-empty password (`redis://:PASSWORD@HOST:6379`, `redis://user:pw@host`, or `rediss://:token@host` for TLS). A bare `redis://host:6379` is rejected. **Production startup exits 1 if unset OR unauthenticated under `NODE_ENV=production`** (`src/env.ts` schema check + `src/instrumentation.ts` defense-in-depth). The `/api/readyz` and legacy `/api/health` probes also PING Redis on every check; a missing or broken Redis returns 503 → orchestrator stops routing traffic. Hosts: rate limits (login brute-force, invite redemption, email dispatch), BullMQ job queue, session/cache coordination. |
| `REDIS_PASSWORD` | ✅ **REQUIRED** for production-like Compose | The password the bundled Redis container enforces via `--requirepass`. `docker-compose.prod.yml`, `docker-compose.staging.yml`, and `deploy/docker-compose.prod.yml` all use `${REDIS_PASSWORD:?…}` — `docker compose up` **aborts** before the container is created if it is unset. The compose files build `REDIS_URL` from it automatically (`redis://:${REDIS_PASSWORD}@redis:6379`). Generate with `openssl rand -base64 32`. Not needed when connecting to an external managed Redis (set `REDIS_URL` directly instead). |
| `CORS_ALLOWED_ORIGINS` | Optional | Comma-separated origins |
| `NOTIFICATIONS_TZ` | Optional (default `Europe/London`) | IANA timezone (DST-aware) for the daily task-due deadline notification cron. Sets **both** the 08:00 firing time **and** the "due today / tomorrow / in a week" calendar-day classification — one zone, so a task due near local midnight is bucketed by the local calendar day rather than the UTC one. Must be a valid IANA zone name (`src/env.ts` rejects an invalid zone at startup). |

## Docker Compose (Self-hosted / VPS)

### Start

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

### Commands

| Action | Command |
|--------|---------|
| Start | `npm run prod:up` |
| Stop | `npm run prod:down` |
| Logs | `docker compose -f docker-compose.prod.yml logs -f app` |
| DB logs | `docker compose -f docker-compose.prod.yml logs -f db` |
| Rebuild | `docker compose -f docker-compose.prod.yml up -d --build --force-recreate` |
| Shell | `docker compose -f docker-compose.prod.yml exec app sh` |
| Reset data | `docker compose -f docker-compose.prod.yml down -v` |
| Smoke check | `npm run smoke:staging` |

### How it works

1. **DB starts** → Postgres 16 on internal network (no port exposed externally)
2. **App starts** → `entrypoint.sh` runs `prisma migrate deploy` then `next start`
3. **Volumes** → `inflect-prod-pgdata` (DB) + `inflect-prod-uploads` (files) persist across restarts
4. **Health** → Docker checks `/api/health` every 15s

### Redis authentication — per-environment policy

Redis carries sessions, rate-limit counters, and the BullMQ job
queue. An unauthenticated Redis that is ever network-reachable is
wide open. The policy is environment-specific:

| Environment | Redis auth | How |
|-------------|-----------|-----|
| Local dev (`docker-compose.yml`) | **Unauthenticated**, loopback-only | Redis intentionally runs without `--requirepass` for dev ergonomics, but its host port is bound to `127.0.0.1:6379` — not reachable from the dev machine's network. |
| Staging / Production Compose (`docker-compose.staging.yml`, `docker-compose.prod.yml`, `deploy/docker-compose.prod.yml`) | **Required password** | The bundled Redis container runs `redis-server --requirepass "${REDIS_PASSWORD:?…}"`. The `:?` fail-fast syntax aborts `docker compose up` before the container is created if `REDIS_PASSWORD` is unset. The app `REDIS_URL` is built from it (`redis://:${REDIS_PASSWORD}@redis:6379`). |
| Kubernetes / AWS | **Managed Redis, TLS + auth** | ElastiCache with `transit_encryption_enabled` + an AUTH token (Epic OI-1). The token is provisioned by Terraform into AWS Secrets Manager; the app receives a `rediss://:token@host` connection string via the `REDIS_URL` secret. |

`src/env.ts` enforces the contract from the application side: under
`NODE_ENV=production` it rejects a `REDIS_URL` that is missing **or**
unauthenticated (no password in the URL) — the process exits 1 at
startup. The structural ratchet at
`tests/guards/redis-production-auth.test.ts` locks the compose-file
shape so a future "simplify" PR cannot quietly drop `--requirepass`.

> **Rollout note.** This change is fail-fast by design. Operators
> **MUST set `REDIS_PASSWORD`** in their `.env.production` /
> `.env.staging` (or `deploy/.env.runtime`) **before** deploying this
> change — otherwise `docker compose up` aborts immediately with a
> clear message. Generate one with `openssl rand -base64 32`. Test
> Redis (`docker-compose.test.yml`) is exempt and stays
> unauthenticated.

### Redis — eviction policy (BullMQ durability)

BullMQ stores job state in Redis. If Redis is configured to **evict**
keys under memory pressure, queued jobs are silently dropped — lost
work, no error. The only BullMQ-safe `maxmemory-policy` is
`noeviction`: Redis then rejects new writes with an `OOM` error,
which surfaces loudly and is alertable, instead of discarding job
records.

| Environment | `maxmemory-policy` | How |
|-------------|--------------------|-----|
| Local dev (`docker-compose.yml`) | `noeviction` | `redis-server … --maxmemory-policy noeviction` |
| Staging / Production Compose | `noeviction` | same flag on each `redis` service `command:` |
| Kubernetes / ElastiCache | `noeviction` | terraform parameter group (`infra/terraform/modules/redis/main.tf`) |
| Test (`docker-compose.test.yml`) | `noeviction` (Redis default) | no `maxmemory` cap is set, so eviction never triggers |

With `noeviction` **and** a `maxmemory` cap, a Redis at its memory
ceiling rejects writes — workers fail to enqueue and the failure is
visible — rather than silently discarding job records.

Two layers keep this from regressing:

- `tests/guards/redis-eviction-policy.test.ts` — fails CI if any
  Compose `redis` service reverts to a key-evicting policy.
- `verifyRedisEvictionPolicy` (`src/lib/redis.ts`), called at startup
  from `src/instrumentation.ts` — a best-effort `CONFIG GET` check
  that logs loudly (error in production, warning in dev) if the
  connected Redis is evicting. Skipped quietly when `CONFIG` is
  unavailable (managed Redis disables it), since terraform +
  `terraform-redis-storage.test.ts` enforce that path.

### Background worker

The Next.js `app` container serves HTTP only. **Every background
job runs in a separate `worker` container** — the BullMQ worker
(`scripts/worker.ts`) plus the scheduler (`scripts/scheduler.ts`).
Without it, the 12 repeatable crons in `src/app-layer/jobs/schedules.ts`
never run (task-due reminders, evidence-expiry sweeps, retention,
the notification digest, …) and anything the app enqueues piles up
in Redis unprocessed.

How it is wired:

- The Docker image build (`Dockerfile`) runs `npm run build:worker`,
  which esbuild-bundles the two entrypoints into self-contained
  `dist/worker.mjs` + `dist/scheduler.mjs` (the production image is
  dev-dependency-pruned, so it cannot run the TypeScript sources
  via `tsx`).
- Each production-like Compose file (`docker-compose.prod.yml`,
  `docker-compose.staging.yml`, `deploy/docker-compose.prod.yml`)
  declares a `worker` service using the **same image** as `app`,
  with the ENTRYPOINT overridden to
  `node dist/scheduler.mjs && node dist/worker.mjs` — register the
  repeatable schedules (idempotent), then daemonise the worker.
- `tests/guards/worker-deployment.test.ts` fails CI if the `worker`
  service, the build step, or the build script is dropped.

> **Operator action — existing self-hosted VM.** The GCP VM's
> `/opt/inflect/` Compose file is hand-managed; Watchtower only
> swaps the *image*, it does NOT apply Compose structure changes.
> After this change ships, add the `worker` service to the VM's
> Compose file (copy the block from `deploy/docker-compose.prod.yml`)
> and run `docker compose up -d worker`. Until then, no scheduled
> job runs on that host.

### Knowledge-base seeding (production)

Seeding the Knowledge Base (`/knowledge` — growing-guide articles) and
the RAG corpus (`KnowledgeChunk`, the AI advisor's cited source
material) used to be `tsx`-only: `npm run import:knowledge`,
`npm run rag:ingest:satellite`, `npm run rag:ingest`. The production
runtime image ships neither `tsx` nor the source `scripts/` tree
(devDependencies, including `tsx` and `esbuild`, are pruned before the
runner stage — see the Dockerfile), so none of those three could run
against the deployed database. The only way to seed content used to be
copying a one-off applier script into the container by hand.

`scripts/seed.ts` — one operator-facing CLI with four subcommands —
closes that gap the same way `scripts/worker.ts` already does: esbuild
bundles it into a self-contained `dist/seed.mjs` (`npm run build:seed`,
wired into the Dockerfile right after `build:worker`, before the
dev-dependency prune), and the existing `COPY --from=builder
.../app/dist ./dist` ships it in the runtime image — no separate COPY
needed. `tests/guards/seed-deployment.test.ts` fails CI if the build
step, the entrypoint, or the `dist` COPY is dropped.

**Run it on the `agrent` VM:**

```bash
gcloud compute ssh agrent --zone europe-west1-b --command \
  "cd /opt/agrent && sudo docker compose -f docker-compose.vm.yml exec app node dist/seed.mjs <subcommand>"
```

Subcommands:

- **`knowledge [--tenant <slug>]`** — seeds the eight Bulgarian arable-crop
  growing-guide articles (wheat/barley/maize/sunflower, bg + en) into ONE
  tenant (the oldest active tenant by default, or `--tenant <slug>`).
  Idempotent per `(tenantId, slug)` — run it again per tenant as new
  tenants onboard.
- **`satellite`** — seeds the ten GLOBAL satellite-imagery guide articles
  (NDVI/NDMI/NDRE/GNDVI/EVI, bg + en, `tenantId` NULL) — every tenant sees
  these for free, no per-tenant step. Idempotent on `(tenantId: null,
  slug)`.
- **`corpus`** — seeds the GLOBAL RAG corpus (~34 licensed/original
  agronomy chunks, WITH embeddings) that the AI advisor cites from.
  Idempotent on `(source, sourceRef)`. **Requires a configured embeddings
  backend** — `AI_EMBED_BASE_URL` + `AI_EMBED_API_KEY` (or `AI_BASE_URL`
  as a fallback for a self-hosted Ollama-serves-both deploy) — see the
  `AI_EMBED_*` block in `deploy/env.prod.example`. As of this writing
  NEITHER is set on the `agrent` VM's `.env` (no Ollama runs there, by
  design — a 768-dim embedding model alongside 7 other Compose services
  is a memory risk that VM doesn't need to take), so `corpus` currently
  exits non-zero with a message naming the missing env var. It never
  silently writes a chunk with no usable embedding. Configure a hosted
  embeddings endpoint (e.g. OpenAI) before running this subcommand.
- **`all [--tenant <slug>]`** — runs all three, each attempted and
  reported independently (one step's failure does not skip the others).
  Exits non-zero if any step failed.

**What "already seeded" looks like** — every step is a safe no-op on a
re-run, reporting skips instead of creating duplicates:

```
[knowledge] OK — tenant <id>: 0 created, 8 already present.
[satellite] OK — GLOBAL: 0 created, 10 already present.
[corpus] FAILED — RAG corpus ingestion needs an embeddings backend, but
AI_EMBED_BASE_URL and AI_EMBED_API_KEY are not set (AI_BASE_URL is not
set either, ...). Set AI_EMBED_BASE_URL + AI_EMBED_API_KEY to a hosted,
OpenAI-compatible embeddings endpoint before running this step — see
deploy/env.prod.example.

2/3 step(s) OK, 1/3 step(s) failed.
```

(That is the ACTUAL state of the `agrent` VM as of 2026-08-10 — the
`knowledge` + `satellite` content was seeded by hand before this CLI
existed, and `corpus` has never successfully run.)

Local dev keeps the original `tsx`-based scripts (`npm run
import:knowledge`, `npm run rag:ingest:satellite`, `npm run rag:ingest`)
— `scripts/seed.ts` calls the exact same idempotent, exported functions,
so there is only one implementation to keep correct; `npm run seed --
<subcommand>` runs the consolidated CLI itself via `tsx` for local
parity with the production `dist/seed.mjs` invocation.

---

## Railway

### Setup

```bash
# 1. Create project on railway.app, connect your GitHub repo
# 2. Railway auto-detects the Dockerfile

# 3. Add a PostgreSQL plugin:
#    Railway dashboard → New → Database → PostgreSQL
#    This provides DATABASE_URL automatically

# 4. Add environment variables in Railway dashboard:
#    AUTH_SECRET, JWT_SECRET, NEXTAUTH_URL, AUTH_URL,
#    GOOGLE_CLIENT_ID/SECRET, MICROSOFT_CLIENT_ID/SECRET,
#    UPLOAD_DIR=/data/uploads, FILE_STORAGE_ROOT=/data/uploads

# 5. Add a persistent volume:
#    Settings → Volumes → Mount path: /data/uploads
```

### Key points

- Railway provides `DATABASE_URL` via the PostgreSQL plugin — **don't set it manually**
- Set `NEXTAUTH_URL` to your Railway-generated domain (or custom domain)
- Volume mount at `/data/uploads` persists uploaded files across deploys
- The Dockerfile entrypoint automatically runs `prisma migrate deploy` on each deploy

### Railway-specific env vars

```
PORT=3000                    # Railway sets this automatically
DATABASE_URL=                # Provided by PostgreSQL plugin
NEXTAUTH_URL=https://your-app.up.railway.app
AUTH_URL=https://your-app.up.railway.app
AUTH_SECRET=<generated>
JWT_SECRET=<generated>
UPLOAD_DIR=/data/uploads
FILE_STORAGE_ROOT=/data/uploads
```

---

## Fly.io

### Setup

```bash
# 1. Install flyctl
curl -L https://fly.io/install.sh | sh

# 2. Launch (uses existing Dockerfile)
fly launch --no-deploy

# 3. Create Postgres cluster
fly postgres create --name inflect-db
fly postgres attach inflect-db

# 4. Create volume for uploads
fly volumes create uploads --size 1 --region your-region

# 5. Set secrets (never in fly.toml)
fly secrets set \
  AUTH_SECRET=$(openssl rand -base64 32) \
  JWT_SECRET=$(openssl rand -base64 32) \
  NEXTAUTH_URL=https://your-app.fly.dev \
  AUTH_URL=https://your-app.fly.dev \
  GOOGLE_CLIENT_ID=xxx \
  GOOGLE_CLIENT_SECRET=xxx \
  MICROSOFT_CLIENT_ID=xxx \
  MICROSOFT_CLIENT_SECRET=xxx \
  UPLOAD_DIR=/data/uploads \
  FILE_STORAGE_ROOT=/data/uploads

# 6. Deploy
fly deploy
```

### fly.toml additions

```toml
[mounts]
  source = "uploads"
  destination = "/data/uploads"

[http_service]
  internal_port = 3000
  force_https = true

[[http_service.checks]]
  grace_period = "30s"
  interval = "15s"
  method = "GET"
  path = "/api/health"
  timeout = "5s"
```

### Key points

- `fly postgres attach` sets `DATABASE_URL` automatically
- Volume mount persists uploads across deploys and restarts
- Secrets set via `fly secrets set` — never committed
- Health check uses `/api/health` (DB connectivity check)

---

## ⚠️ Hosting Considerations

| Provider | File Storage | Recommended |
|----------|-------------|-------------|
| **VPS + Docker Compose** | ✅ Volumes | ✅ Best for this app |
| **Railway** | ✅ Persistent volumes | ✅ Great |
| **Fly.io** | ✅ Mounted volumes | ✅ Great |
| **Vercel** | ❌ Ephemeral filesystem | ❌ Not suitable |
| **Netlify** | ❌ No server | ❌ Not suitable |

This app uses **local file storage** for evidence uploads. Platforms without persistent filesystems (Vercel, Netlify) require migrating to S3/R2 first — that's a separate effort.

---

## Migrations

- Applied via `prisma migrate deploy` (idempotent, safe to re-run)
- **Docker**: Automatic on every container start via `entrypoint.sh`
- **Manual**: `npm run migrate:deploy`
- **Never** use `db push` in production

## Backup & Restore (Docker Compose — legacy path only)

> **K8s/EKS users see [Backup & Restore (RDS + S3)](#backup--restore-rds--s3)
> in the Kubernetes section below.** The commands here apply only to
> the deprecated docker-compose deploy model (self-hosted single VPS
> running Postgres in a container with a mounted volume). They do
> NOT apply to the EKS production path, which uses RDS automated
> backups + S3 versioning instead of host-level pg_dump and tar.

### Database

```bash
# Backup
docker compose -f docker-compose.prod.yml exec db \
  pg_dump -U inflect agrent_production > backup_$(date +%Y%m%d).sql

# Restore
docker compose -f docker-compose.prod.yml exec -i db \
  psql -U inflect agrent_production < backup_20240314.sql
```

### Uploads

```bash
# Backup
docker compose -f docker-compose.prod.yml exec app \
  tar czf /tmp/uploads.tar.gz -C /data/uploads .
docker compose -f docker-compose.prod.yml cp app:/tmp/uploads.tar.gz ./uploads_backup.tar.gz

# Restore
docker compose -f docker-compose.prod.yml cp ./uploads_backup.tar.gz app:/tmp/uploads.tar.gz
docker compose -f docker-compose.prod.yml exec app \
  tar xzf /tmp/uploads.tar.gz -C /data/uploads
```

## Security Checklist

- [x] Secrets via env vars only (never in code/config)
- [x] DB not exposed externally (internal Docker network)
- [x] Non-root container user (`nextjs:nodejs`)
- [x] Auth cookies: `httpOnly`, `secure`, `sameSite: lax`
- [x] HSTS + CSP + X-Frame-Options headers
- [x] Rate limiting on auth endpoints, mutations, and tenant-scoped reads — see [rate-limiting docs](rate-limiting.md) for the three-tier design + exclusions
- [x] Test credentials disabled in production
- [x] File upload: mime/size validation + path traversal protection
- [x] PII column-level encryption (AES-256-GCM) — see [encryption docs](encryption-data-protection.md)
- [ ] Volume/disk encryption enabled (self-hosted) — see [encryption docs](encryption-data-protection.md)
- [ ] Backup encryption (GPG) configured — see [encryption docs](encryption-data-protection.md)

---

## Kubernetes (Helm) — primary production path

As of Epic OI-2 (2026-04-27), production deployments use the Helm
chart at `infra/helm/inflect/` running on EKS. The earlier
SSH/docker-compose path remains documented for self-hosted scenarios
but is **deprecated as the primary production model**.

> **Companion docs**
> - `infra/helm/inflect/README.md` — chart-specific operator notes
> - `docs/infrastructure.md` — Epic OI-1 (Terraform/AWS layer beneath the cluster)
> - `docs/implementation-notes/2026-04-27-epic-oi-2-*.md` — design history

### Architecture

```
┌─────────────────── EKS cluster ───────────────────────┐
│                                                       │
│  Namespace: inflect-{staging,production}              │
│                                                       │
│  ┌── Service ──────┐                                  │
│  │ ClusterIP :80   │ ◄── Ingress (NGINX or ALB)       │
│  └────────┬────────┘                                  │
│           │ targetPort: http (3000)                   │
│           ▼                                           │
│  ┌──── App pod ──────────────────────────────┐        │
│  │  ┌── inflect ─────────┐  ┌── pgbouncer ─┐ │        │
│  │  │ Next.js :3000      │──│ :5432 (loop)  │ │        │
│  │  └────────────────────┘  └──────┬────────┘ │        │
│  └─────────┬─────────────────────────┼────────┘        │
│            │                         │                 │
│  ┌── Worker pod ──────┐               │                │
│  │ node tsx worker.ts │               │                │
│  └────────────────────┘               │                │
│            │                          │                │
│            └────── envFrom ──┬────────┘                │
│                              │                         │
│                       (egress via NetworkPolicy:       │
│                        DNS, VPC:5432/6379, HTTPS)      │
└──────────────────────────────┼─────────────────────────┘
                               ▼
                  RDS Postgres + ElastiCache Redis
                  (Epic OI-1 — terraform-managed)
```

Per-release resources rendered by the chart:

| Kind | Name | When |
|---|---|---|
| Service | `<release>` | always |
| Deployment | `<release>` (component=app, with PgBouncer sidecar) | always |
| Deployment | `<release>-worker` (component=worker) | `worker.enabled=true` |
| Job | `<release>-migrate` | Helm pre-install/pre-upgrade hook |
| HorizontalPodAutoscaler | `<release>` | `autoscaling.enabled=true` |
| Ingress | `<release>` | `ingress.enabled=true` |
| NetworkPolicy | `<release>-app` | `networkPolicy.enabled=true` |

### Deploying

The `Deploy` GitHub Actions workflow (`.github/workflows/deploy.yml`)
is the canonical path. Manual trigger only:

```
GitHub → Actions → Deploy → Run workflow
  environment: staging | production
  ref: (blank for current main, or branch/tag/SHA)
  image_tag: (blank for short-SHA-derived)
```

The `environment` input chooses how far to promote:

- **`staging`** — deploy + smoke staging, then stop.
- **`production`** — deploy + smoke **staging first**, and only if
  that passes, deploy + smoke production.

#### The staging smoke gate

Production is **structurally gated behind staging**. A single
`production` run executes:

```
gate → build-image → deploy-staging → smoke-staging → deploy-production → smoke-production
```

The `deploy-production` job declares `needs: [smoke-staging]`.
GitHub Actions never starts a job whose `needs` dependency failed —
so **production cannot deploy unless the exact same image first
passed staging deploy + staging smoke**. The dependency is explicit
in the job graph, not implicit run-ordering. The wiring is locked by
`tests/guards/deploy-staging-gate.test.ts`.

Two layers protect production, in order:

1. **Staging smoke must pass** — the `needs:` edge above. A failed
   staging smoke turns the run red; `deploy-production` is skipped.
2. **A human approves the production stage** — the `production`
   GitHub Environment's required-reviewers rule, enforced on
   `deploy-production`. The approval prompt fires *after* staging
   smoke has already passed, so reviewers approve a release that is
   already proven on staging.

The same built image is promoted staging → production (built once
in `build-image`), so what staging validated is byte-identical to
what production receives.

What each deploy stage does — both call the shared
`.github/actions/helm-deploy` composite action, so the helm logic
cannot drift between environments:

1. OIDC into AWS, fetch kubeconfig for the target EKS cluster
2. `helm lint` + `helm upgrade --install --dry-run` (validation)
3. `helm upgrade --install ... --atomic --wait --timeout 10m`
   - Pre-install/upgrade hook runs the Prisma migration Job; Helm
     waits for the Job to succeed before rolling the Deployments
   - `--atomic` rolls back automatically on any failure during
     the upgrade window
   - `--wait` blocks until all Deployments reach Ready and the
     RolloutStatus reports complete (or `--timeout` expires)
4. Smoke test (`scripts/smoke-prod.mjs`, the generic post-deploy
   validator) against the environment's `vars.SMOKE_URL`

### Local helm commands

For ad-hoc operations (debugging, manual rollback, pod inspection)
operators run helm locally with kubectl pointing at the cluster.

**Setup once per workstation**:

```bash
# Authenticate to the AWS account
aws sso login --profile inflect-prod   # or your auth method of choice

# Update kubeconfig for the target cluster
aws eks update-kubeconfig \
  --region us-east-1 \
  --name <eks-cluster-name>

# Verify
kubectl config current-context
kubectl get nodes
```

**Inspect a release**:

```bash
helm list --namespace inflect-production
helm history inflect-production --namespace inflect-production
helm get values inflect-production --namespace inflect-production
helm status inflect-production --namespace inflect-production
```

**Render the chart locally** (without applying):

```bash
helm template inflect-production infra/helm/inflect \
  -f infra/helm/inflect/values-production.yaml \
  --namespace inflect-production
```

**Manual install/upgrade** (rare — prefer the workflow so the
approval audit trail is captured):

```bash
helm upgrade --install \
  inflect-production \
  infra/helm/inflect \
  --namespace inflect-production \
  --create-namespace \
  --values infra/helm/inflect/values-production.yaml \
  --set image.tag=<short-sha> \
  --atomic \
  --wait \
  --timeout 10m
```

### Rollback via `helm rollback`

Helm keeps the last 10 revisions per release (configurable via
`HELM_HISTORY_MAX` in the workflow). Rollback restores the prior
manifest set in a single atomic operation.

**Find the target revision**:

```bash
helm history inflect-production --namespace inflect-production
```

Output (example):

```
REVISION  UPDATED                  STATUS      CHART          APP VERSION  DESCRIPTION
1         2026-04-26 10:00:00 UTC  superseded  inflect-0.1.0  1.35.0       Install complete
2         2026-04-27 09:15:00 UTC  superseded  inflect-0.1.0  1.35.1       Upgrade complete
3         2026-04-27 14:00:00 UTC  deployed    inflect-0.1.0  1.36.0       Upgrade complete
```

**Roll back**:

```bash
# Roll back to the IMMEDIATELY PRIOR revision (most common)
helm rollback inflect-production --namespace inflect-production

# Roll back to a SPECIFIC revision
helm rollback inflect-production 2 --namespace inflect-production

# Roll back AND wait for resources to be ready
helm rollback inflect-production 2 \
  --namespace inflect-production \
  --wait \
  --timeout 5m

# Roll back AND force-restart pods (sometimes needed when env hasn't actually changed)
helm rollback inflect-production 2 \
  --namespace inflect-production \
  --recreate-pods   # deprecated but still useful in older Helm versions
```

**What rollback re-applies** (and what it doesn't):
- ✅ Deployment image tags, replica counts, env, resources
- ✅ ConfigMap / Secret content (chart-managed)
- ✅ HPA bounds + metrics
- ✅ Ingress + NetworkPolicy + Service spec
- ⚠️  Pre-install/upgrade hook Jobs are **NOT re-run** on rollback —
  Helm rollback does not invoke `helm.sh/hook: pre-install,pre-upgrade`
  Jobs. The migration Job is one-way: rolling back the app image
  to a revision that pre-dates a schema migration may break the
  app on startup. See "Migration safety on rollback" below.
- ❌ Externally-managed resources (RDS state, S3 bucket contents,
  Secrets Manager entries) are NOT touched by rollback. Operator
  handles those manually if a rollback also requires data revert.

**Migration safety on rollback**:
- Forward-incompatible schema changes (column drops, type changes,
  constraint adds) make a rollback to a previous app image
  dangerous — the old app code expects the old schema.
- Mitigation: write **expand-and-contract** migrations.
  - **Expand** PR adds the new column / table (compatible with
    both app versions).
  - **Migrate** PR ships the app code that uses the new shape.
  - **Contract** PR drops the old shape AFTER the new code is
    confirmed stable.
  - Rollback after a Contract PR is a data-loss event — flag it
    in PR descriptions so reviewers see the constraint explicitly.

### Scaling

**Horizontal — replicas**:

The HPA owns the replica count when `autoscaling.enabled=true`
(production default). Modify the bounds via values:

```bash
# Adjust bounds + reapply via helm upgrade
helm upgrade --install \
  inflect-production \
  infra/helm/inflect \
  --namespace inflect-production \
  -f infra/helm/inflect/values-production.yaml \
  --set autoscaling.minReplicas=4 \
  --set autoscaling.maxReplicas=20 \
  --reuse-values

# OR: edit the per-env values file and commit + redeploy via the workflow
```

**Manual override** (when you need to pin replicas during an
incident):

```bash
# Temporarily disable HPA + pin replica count
kubectl --namespace inflect-production scale deployment inflect-production --replicas=8

# WARNING: the next helm upgrade will reset this. Disable autoscaling
# in values OR delete the HPA manually before the next deploy:
kubectl --namespace inflect-production delete hpa inflect-production
```

**Vertical — resources**:

```bash
helm upgrade --install \
  inflect-production \
  infra/helm/inflect \
  --namespace inflect-production \
  -f infra/helm/inflect/values-production.yaml \
  --set resources.requests.cpu=2 \
  --set resources.requests.memory=1Gi \
  --set resources.limits.cpu=4 \
  --set resources.limits.memory=2Gi \
  --reuse-values
```

For a permanent change, edit `values-production.yaml` and deploy
through the workflow so the change is reviewable.

**Worker scaling** is manual (no HPA per OI-2 spec):

```bash
helm upgrade --install \
  inflect-production \
  infra/helm/inflect \
  --namespace inflect-production \
  -f infra/helm/inflect/values-production.yaml \
  --set worker.replicaCount=4 \
  --reuse-values
```

### Secret rotation

Production runtime secrets live in **AWS Secrets Manager** (per
Epic OI-1). The K8s Secret in the namespace is populated by an
External Secrets Operator (ESO) sync from Secrets Manager, OR
manually via `kubectl create secret`. Both paths are supported.

**Generated secrets — terraform-managed** (`AUTH_SECRET`,
`JWT_SECRET`, `AV_WEBHOOK_SECRET`, `DATA_ENCRYPTION_KEY`,
`POSTGRES_PASSWORD` (RDS-managed), Redis `AUTH_TOKEN`):

See `docs/infrastructure.md` § "Day-2 ops → Rotating a generated
secret" for the source-of-truth runbooks. Summary:

| Secret | How to rotate |
|---|---|
| RDS master password | `aws secretsmanager rotate-secret --secret-id <rds-secret-id>` (RDS rotates without app downtime) |
| Redis AUTH | `terraform apply` regenerates and rolls (auth_token_update_strategy = ROTATE keeps old token valid during transition) |
| AUTH_SECRET / JWT_SECRET | Edit `modules/secrets/main.tf` to bump the random_id `keepers`, `terraform apply`, restart app pods (sessions invalidate — one mass logout) |
| AV_WEBHOOK_SECRET | Same as AUTH_SECRET; ALSO update the AV scanner's HMAC config in lock-step |
| DATA_ENCRYPTION_KEY | **NEVER regenerate without the v1→v2 sweep**. See `docs/epic-b-encryption.md` for the rotation runbook |

**Operator-supplied secrets** (`GOOGLE_CLIENT_SECRET`,
`MICROSOFT_CLIENT_SECRET`):

```bash
# 1. Rotate the secret in the cloud console (Google Cloud Console / Entra Portal)
# 2. Update the value in AWS Secrets Manager
aws secretsmanager put-secret-value \
  --secret-id inflect-compliance-production-google-client-secret \
  --secret-string '<new-value>'

# 3. Force a sync if using External Secrets Operator
kubectl --namespace inflect-production annotate \
  externalsecret inflect-production-secrets \
  force-sync=$(date +%s) \
  --overwrite

# 4. Restart pods to pick up the new value
kubectl --namespace inflect-production rollout restart deployment inflect-production
kubectl --namespace inflect-production rollout restart deployment inflect-production-worker
```

**Picking up a new K8s Secret value** (the chart's contract):
- The Deployment uses `envFrom: [secretRef]`. K8s does NOT
  hot-reload env vars when the Secret changes — pods read the
  Secret's value at start time only.
- Therefore: every secret rotation requires a `kubectl rollout
  restart` (or a `helm upgrade` that triggers a pod recreation
  via a non-trivial change like a templated annotation).

**Triggering a no-op rollout** to pick up new Secret values
without a values change:

```bash
# Bumps a pod template annotation, forcing K8s to recreate pods
kubectl --namespace inflect-production rollout restart \
  deployment/inflect-production
```

### Backup & Restore (RDS + S3)

In the EKS path the stateful stores are AWS-managed; backup is
automated by AWS, not by the operator. Operators DO drive the
restore — the runbook below is what to run when something needs
recovery.

#### Database (RDS Postgres)

**What's automatic** (no operator action required):

- **Automated backups** — RDS takes a daily snapshot during the
  configured `backup_window`, retained for `db_backup_retention_days`
  (staging: 7d, production: 14d — see
  `infra/terraform/environments/*/terraform.tfvars`).
- **Point-in-time recovery (PITR)** — implicit while
  `backup_retention_period > 0`. The recovery window equals the
  retention period.
- **Multi-AZ failover** (production only) — RDS handles automatic
  failover to the standby on AZ outage. No restore needed; the
  standby promotes within ~60 seconds.

**Manual snapshot** (one-off — typically before a risky migration):

```bash
# Identifier embeds a date so listing snapshots later is grep-friendly
aws rds create-db-snapshot \
  --db-instance-identifier inflect-production-db \
  --db-snapshot-identifier inflect-production-pre-migration-$(date +%Y%m%d-%H%M%S) \
  --region us-east-1

# Verify
aws rds describe-db-snapshots \
  --db-instance-identifier inflect-production-db \
  --snapshot-type manual \
  --region us-east-1 \
  --query 'DBSnapshots[*].[DBSnapshotIdentifier,Status,SnapshotCreateTime]' \
  --output table
```

**Restore from snapshot** (creates a NEW DB instance — never
overwrites the running one):

```bash
# 1. List available snapshots
aws rds describe-db-snapshots \
  --db-instance-identifier inflect-production-db \
  --region us-east-1 \
  --query 'DBSnapshots[*].[DBSnapshotIdentifier,SnapshotCreateTime]' \
  --output table

# 2. Restore to a new instance (cannot reuse the original identifier)
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier inflect-production-db-restored \
  --db-snapshot-identifier <snapshot-id> \
  --db-subnet-group-name inflect-production-db-subnet-group \
  --vpc-security-group-ids <db-sg-id> \
  --no-publicly-accessible \
  --multi-az \
  --region us-east-1

# 3. Once the restored instance is "available", point app at it via
#    the runtime ConfigMap (DATABASE_URL host) — atomic cutover via
#    `kubectl rollout restart`. Old instance kept until the cutover
#    is verified, then deleted with a final snapshot.
```

**Restore to a point in time** (PITR — surgical recovery from a
specific minute, e.g. just before a destructive query):

```bash
# Restore to 2 hours ago (or any timestamp within the retention window)
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier inflect-production-db \
  --target-db-instance-identifier inflect-production-db-pitr \
  --restore-time "$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)" \
  --db-subnet-group-name inflect-production-db-subnet-group \
  --vpc-security-group-ids <db-sg-id> \
  --no-publicly-accessible \
  --region us-east-1
```

The new instance comes up with the same parameter group, security
group, and subnet group — only the data differs. Cutover via the
same ConfigMap-edit + `rollout restart` pattern as the snapshot
restore.

#### Files (S3 storage bucket)

**What's automatic**:

- **Versioning** is enabled on the bucket
  (`infra/terraform/modules/storage/main.tf::aws_s3_bucket_versioning`).
  Every PUT creates a new version; deletes are tombstones, not
  data loss.
- **Lifecycle** transitions current objects to `STANDARD_IA` after
  90d (configurable via `storage_ia_transition_days`); noncurrent
  versions expire after `noncurrent_version_expiration_days`
  (default 90d). **Tune the noncurrent retention up if you need a
  longer file-restore window.**

**Find a deleted or overwritten file**:

```bash
# List ALL versions of a key (including delete markers)
aws s3api list-object-versions \
  --bucket inflect-production-storage \
  --prefix path/to/file \
  --output table
```

The output shows `IsLatest`, `VersionId`, `LastModified`, and
whether a row is a `DeleteMarker`. The version you want to restore
is the `LastModified`-most-recent non-delete-marker entry from
before the unwanted change.

**Restore a single file**:

```bash
# Copy an old version back to the canonical key — creates a new
# "latest" version that matches the old content.
aws s3api copy-object \
  --bucket inflect-production-storage \
  --copy-source 'inflect-production-storage/path/to/file?versionId=<VERSION_ID>' \
  --key path/to/file
```

**Restore from a delete marker** (file was deleted, want it back):

```bash
# Removing the delete marker re-exposes the version underneath.
aws s3api delete-object \
  --bucket inflect-production-storage \
  --key path/to/file \
  --version-id <DELETE_MARKER_VERSION_ID>
```

**Bulk-restore a deleted prefix** (e.g. accidental `aws s3 rm
--recursive`): script the above two calls over the output of
`list-object-versions --prefix <prefix>`. There's no single AWS
command for this — list, then iterate. Test against a small
prefix first.

#### What this section deliberately does NOT cover

- **Off-region disaster recovery** (cross-region snapshot copy,
  Aurora Global, S3 Cross-Region Replication) — out of scope for
  the current single-region production posture. When a DR objective
  forces a cross-region requirement, that's its own runbook.
- **Audit-log database** — we use the same RDS instance; if an
  immutable separate-store audit DB ships, it gets its own backup
  policy here.
- **Redis** — BullMQ job state is intentionally ephemeral; on-disk
  Redis snapshots exist (`redis_snapshot_retention_days`) but there
  is no operator restore flow because losing in-flight jobs is
  acceptable. Document a Redis restore procedure here once a job
  type is added that requires durability beyond the in-flight
  window.

### Operational runbook quick reference

```bash
# Status
helm list -n inflect-production
helm status inflect-production -n inflect-production
helm history inflect-production -n inflect-production --max 10
kubectl -n inflect-production get pods -l "app.kubernetes.io/instance=inflect-production"

# Logs
kubectl -n inflect-production logs -f -l "app.kubernetes.io/component=app" --tail=100
kubectl -n inflect-production logs -f -l "app.kubernetes.io/component=worker" --tail=100

# Debug a single pod
kubectl -n inflect-production describe pod <pod>
kubectl -n inflect-production exec -it <pod> -c inflect -- /bin/sh

# Migration Job logs (after a failed pre-install hook)
kubectl -n inflect-production logs job/inflect-production-migrate

# PgBouncer state
kubectl -n inflect-production exec <app-pod> -c pgbouncer -- \
  psql "host=127.0.0.1 port=5432 dbname=pgbouncer user=postgres" \
  -c "SHOW POOLS;"

# Rollback
helm rollback inflect-production [revision] -n inflect-production --wait

# Scale
helm upgrade ... --set autoscaling.minReplicas=4 --reuse-values
helm upgrade ... --set worker.replicaCount=4 --reuse-values

# Force secret-pickup rollout
kubectl -n inflect-production rollout restart \
  deployment/inflect-production deployment/inflect-production-worker
```
