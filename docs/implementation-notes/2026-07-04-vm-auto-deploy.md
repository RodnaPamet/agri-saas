# 2026-07-04 — VM auto-deploy via GHCR + Watchtower

**Commit:** `<this PR>` ci(ghcr): bake NEXT_PUBLIC_MAPTILER_KEY into the published image

> **Path changed 2026-08-03.** The image paths written below
> (`ghcr.io/inflect-compliance/agri-saas`) are historical. The repo moved to
> the `RodnaPamet` org, and because the publish workflow derives its target
> from `${{ github.repository }}`, images now go to
> **`ghcr.io/rodnapamet/agri-saas`**. The compose file kept pointing at the old
> path, so Watchtower polled a location that no longer received pushes and
> silently stopped deploying — `Session done … Updated=0` on every cycle, which
> reads exactly like "nothing to do". The mechanism described here is unchanged;
> only the registry path moved.

## Design

The single-VM `agrent` deployment (GCP `hazel-design-419410`, zone
`europe-west1-b`) was deployed **manually** on every merge: SSH in →
`git reset --hard origin/main` → `docker compose build app` (6–8 min on
the box) → recreate `app` + `worker`. This note wires the
merge-to-`main` → running-in-prod path so no SSH is needed.

The pipeline has two halves:

```
  merge to main
      │
      ├─► ghcr-publish.yml (GitHub Actions)
      │      build image  ──►  push ghcr.io/inflect-compliance/agri-saas:latest + :sha-<short>
      │
      └─► (VM) Watchtower polls :latest ──► pulls new digest ──► recreates app + worker
                                                                    │
                                                       entrypoint runs `prisma migrate deploy`
                                                       (migrations self-apply on boot)
```

The CI push half (`ghcr-publish.yml`) already existed and succeeds on
every push. **Two gaps blocked it from being usable:**

1. **The published image had no MapTiler basemap key.** `NEXT_PUBLIC_*`
   are inlined into the client bundle at *build* time (Dockerfile
   `ARG NEXT_PUBLIC_MAPTILER_KEY` → `ENV` before `next build`). The
   local VM build passes it via `docker-compose.vm.yml` `build.args`;
   the CI build did **not** pass it, so the GHCR image fell back to the
   bare `demotiles.maplibre.org` demo basemap. Auto-deploying it would
   have been a silent map regression. **Fix (this PR):** add `build-args`
   to the `docker/build-push-action` step, sourced from the repo
   Variable `NEXT_PUBLIC_MAPTILER_KEY` (public-by-design,
   referrer-restricted — a Variable, not a Secret). Absent var → empty
   string → graceful demo-basemap fallback, never a build failure.

2. **No Watchtower ran on the VM** (the earlier "Watchtower polls
   :latest" note was aspirational). `app`/`worker` used `build:` +
   `image: agrent-app:local`. **Fix (VM config, not this PR):** repoint
   `app`/`worker` to `image: ghcr.io/inflect-compliance/agri-saas:latest`
   and add a `watchtower` service scoped to those two containers.

## Files

| File | Role |
|------|------|
| `.github/workflows/ghcr-publish.yml` | + `build-args` (MapTiler key + basemap style) so the registry image matches the local VM build |
| `docs/implementation-notes/2026-07-04-vm-auto-deploy.md` | this note |

VM-side (hand-managed, outside the repo — recorded in the deploy memory):
`/opt/agrent/docker-compose.vm.yml` `app`/`worker` → GHCR image + a
`watchtower` service (`--cleanup`, label-scoped, poll interval).

## Decisions

- **Variable, not Secret, for the MapTiler key.** It is inlined into the
  public client bundle and referrer-restricted in the MapTiler
  dashboard — masking it in CI logs would be security theatre. A repo
  Variable is the honest classification. Runtime secrets (Earth Engine
  service-account JSON, SMTP/Resend key, DB creds) stay in the VM's
  `/opt/agrent/.env` and never enter CI.
- **`:latest` auto-pull, unattended.** Matches the existing
  `ghcr-publish.yml` design intent ("git push → running in prod ~5 min").
  The `deploy.yml` Helm pipeline (staging-gated, reviewer-approved) is a
  separate, manual, EKS-targeted path — not used for the single VM.
  Trade-off accepted: a bad merge auto-ships. Mitigations already in the
  graph: full CI (all shards + Trivy container scan) must pass on the
  merge commit, and the entrypoint applies migrations idempotently.
- **`deploy.yml`'s `build-image` job has the SAME MapTiler gap** but its
  EKS environments aren't provisioned, so it's left as a documented
  follow-up rather than fixed speculatively here.
- **Migrations need no pipeline step** — `scripts/entrypoint.sh` runs
  `prisma migrate deploy` before Next boots, so a Watchtower recreate
  applies pending migrations on its own.
