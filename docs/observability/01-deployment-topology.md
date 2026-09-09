# 01 — Deployment Topology

> Where the observability stack runs, how telemetry flows through it,
> and how the deployment differs across local, staging, and production.
> The companion artifact is `infra/observability/docker-compose.observability.yml`.

# Recommended Deployment Topology

The observability stack is a **separate docker-compose project,
co-located on the application VM**. It is not part of
`docker-compose.prod.yml` — it ships as its own compose file at
`infra/observability/docker-compose.observability.yml` with its own
volumes, its own internal network, and its own lifecycle.

This is the right shape for inflect-compliance for three concrete
reasons:

1. **The primary deployment is already a single VM running compose.**
   `docker-compose.prod.yml` runs Caddy, the `app` container,
   Postgres 16, PgBouncer, Redis 7, ClamAV, and Watchtower on one
   host. The observability stack adds four more containers
   (collector, Prometheus, Tempo, Grafana) to the same host. There
   is no second machine to provision, no orchestrator to learn, and
   no network hop off the box for the hot ingestion path.

2. **Separate compose project, not merged into the app compose.**
   Keeping it a distinct project means the observability stack has
   an independent deploy cadence. You can `docker compose -f
   docker-compose.observability.yml up -d` to roll a collector
   config change without touching the app, and Watchtower — which
   auto-pulls the app's GHCR image — never touches the
   observability containers (their tags are pinned; see
   `04-production-hardening.md`). The blast radius of an
   observability change is the observability stack.

3. **It joins the app's docker network so the app reaches the
   collector by DNS.** The compose file declares the app's
   pre-existing bridge network as `external` and the app's `app`
   container resolves `otel-collector` by service name. The app
   pushes OTLP to `http://otel-collector:4318` — a container-to-
   container call on the internal bridge, never leaving the host,
   never traversing Caddy.

**Scale-out step (documented, not built today): a dedicated
monitoring VM.** When the app fleet grows past one VM, or when
Prometheus TSDB I/O starts competing with Postgres for the same
disk, the same compose file moves to a second, monitoring-only VM.
The collector then receives OTLP over a private network link (or a
mesh / VPN), and the only change is the app's
`OTEL_EXPORTER_OTLP_ENDPOINT` env var pointing at the new host. The
compose project, the collector config, the Prometheus rules, and
the Grafana dashboards are unchanged — co-located vs dedicated-VM is
a placement decision, not an architecture decision. That is the
point of keeping it a separate project from day one.

**HISTORICAL — there is no Kubernetes deployment.** The Helm chart at
`infra/helm/inflect/` was deleted in #810's follow-up alongside the EKS
workflow and the Terraform beneath it; none of it ever ran. The guidance below
is kept because the *config re-use* argument still holds if Kubernetes is ever
revisited, but nothing here is deployed today.

**If a Kubernetes deployment is ever built: do not hand-write manifests.** A
hand-rolled collector Deployment and a hand-rolled Prometheus
StatefulSet are a maintenance liability the moment they drift from
upstream. The recommendation is the community Helm charts:

- `open-telemetry/opentelemetry-collector` — fed *our* collector
  config from `infra/observability/otel-collector/config.yaml` as a
  ConfigMap value, deployed in `mode: deployment` (gateway pattern,
  see `02-otel-collector.md`).
- `prometheus-community/kube-prometheus-stack` — fed *our* scrape
  config, *our* recording and alerting rules from
  `infra/observability/prometheus/rules/`, and *our* dashboards
  from `infra/observability/grafana/dashboards/` as sidecar-loaded
  ConfigMaps.

The collector config, the alert rules, and the dashboard JSON are
**portable between the compose deployment and the Helm deployment**.
Only the *packaging* differs. The compose stack is the primary,
fully-deployable artifact; the Helm path is documented configuration
re-use, not a second product.

# Component Placement

The stack is four containers plus the app it observes. Placement is
governed by one rule: **only Grafana is reachable from outside the
VM, and only through Caddy.**

| Container | Image | Network(s) | Host port | Reachable from |
|-----------|-------|------------|-----------|----------------|
| `otel-collector` | `otel/opentelemetry-collector-contrib:0.123.0` | `observability`, `app` | none | App (OTLP, over `app` net); Prometheus (scrape, over `observability` net) |
| `prometheus` | `prom/prometheus:v3.3.0` | `observability` | none | Grafana; operators via `docker exec` |
| `tempo` | `grafana/tempo:2.7.2` | `observability` | none | Collector (OTLP push); Grafana (query) |
| `grafana` | `grafana/grafana:11.6.0` | `observability` | `127.0.0.1:3001` | Caddy (reverse proxy → public TLS) |

Two networks:

- **`observability`** — an internal bridge (`obs-internal`). The
  four stack services talk to each other here. Nothing on this
  network is published to the host.
- **`app`** — the application compose project's pre-existing bridge
  network, joined as `external`. In `docker-compose.prod.yml` it is
  named `internal`; the observability compose declares it via
  `APP_NETWORK_NAME` in `.env` (default `inflect_internal`). Only
  the **collector** joins this network — it is the single bridge
  between the two compose projects. Prometheus, Tempo, and Grafana
  never touch the app network.

Why the collector is the only service on both networks: it is the
ingestion gateway. The app must reach it; the observability tier
must reach it. Putting Prometheus or Grafana on the app network
would widen the trust boundary for no reason — Prometheus has no
business resolving `app:3000`, and the app has no business
resolving `prometheus:9090`.

**Grafana's host binding is `127.0.0.1:3001`, never `0.0.0.0`.** It
is published on loopback only so that Caddy — running on the same
host — can reverse-proxy it. A public `0.0.0.0:3001` mapping would
expose Grafana's login page to the internet bypassing Caddy's TLS
and security headers. Operator access to Grafana is *exclusively*
`https://<grafana-host>/` through Caddy; see the Caddy block in
`04-production-hardening.md`.

**Prometheus, Tempo, and the collector are not host-published at
all.** An operator who needs the Prometheus UI directly does it
through an SSH tunnel or a temporary, loopback-only `docker compose
port` mapping — never a persistent `0.0.0.0` port. The collector's
pprof and zpages debug surfaces, if enabled, bind to localhost
inside the container only (see `02-otel-collector.md`).

Process types observed: the app runs **three process types from one
image** — the web server, the BullMQ worker (`scripts/worker.ts`),
and the one-shot deploy scheduler (`scripts/scheduler.ts`). The web
server and the worker are long-lived and both push OTLP. They share
the `OTEL_SERVICE_NAME` (`inflect-compliance`) but are distinguished
in telemetry by a resource attribute — the collector's
`resourcedetection` and `resource` processors stamp the
`deployment.environment`, and the OTel SDK already stamps
`service.version`. To split web from worker on dashboards, set a
distinct `OTEL_SERVICE_NAME` per process type (e.g.
`inflect-compliance-web`, `inflect-compliance-worker`) — this is a
deploy-time env decision, recommended for production so RED metrics
and job metrics land on separate `service.name` series.

# Telemetry Flow

There are two distinct verbs in this system and conflating them is
the most common source of confusion. **The app PUSHES. Prometheus
SCRAPES.** They never overlap.

```
  ┌─────────────────────────────────────────────────────────────┐
  │  APP VM                                                      │
  │                                                              │
  │  docker-compose.prod.yml          docker-compose.observability│
  │  ┌──────────────┐                 ┌────────────────────────┐ │
  │  │ app (web)    │                 │                        │ │
  │  │ app (worker) │── OTLP/HTTP ────▶│  otel-collector        │ │
  │  │              │   PUSH          │   :4318 (http receiver) │ │
  │  │ Caddy        │   :4318         │   :4317 (grpc receiver) │ │
  │  │ Postgres     │                 │                        │ │
  │  │ Redis        │                 │   ├─ metrics pipeline ──┼─┐
  │  │ ...          │                 │   │   → :8889 exporter  │ ││
  │  └──────────────┘                 │   └─ traces pipeline ───┼┐││
  │         ▲                         │       → OTLP push       ││││
  │         │ reverse proxy           └────────────────────────┘│││
  │         │ (TLS)                            │ :8888 self     │││
  │  ┌──────┴───────┐                          │ :13133 health  │││
  │  │ operator     │                          │                │││
  │  │ browser      │                  ┌───────▼──────┐         │││
  │  └──────────────┘                  │  prometheus  │◀────────┘││
  │         │                          │   :9090      │ SCRAPE   ││
  │         │ https://grafana/         │              │ :8889    ││
  │         ▼                          │   SCRAPES:   │ :8888    ││
  │  ┌──────────────┐                  │   collector  │          ││
  │  │   grafana    │◀── query ────────┤   itself     │          ││
  │  │   :3000      │   PromQL         │   grafana    │          ││
  │  │ (127.0.0.1:  │                  │   tempo      │          ││
  │  │  3001 → Caddy)│                 └──────────────┘          ││
  │  │              │                  ┌──────────────┐         ││
  │  │              │◀── query ────────┤    tempo     │◀────────┘│
  │  │              │   traces         │  :3200 query │  OTLP    │
  │  └──────────────┘                  │  :4317 recv  │  push    │
  │                                    └──────────────┘          │
  └─────────────────────────────────────────────────────────────┘
```

**What is pushed (OTLP, app-initiated):**

- App web + worker → collector `:4318` (OTLP/HTTP). The OTel SDK in
  `src/lib/observability/instrumentation.ts` sends traces to
  `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` via a
  `BatchSpanProcessor` and metrics to `.../v1/metrics` via a
  `PeriodicExportingMetricReader` flushing every 30 s.
- Collector traces pipeline → Tempo `:4317` (OTLP). The collector's
  `otlp` exporter pushes sampled spans to Tempo.

**What is scraped (HTTP pull, Prometheus-initiated):**

- Prometheus → collector `:8889` — the collector's **Prometheus
  exporter**, carrying all application metrics (`api_request_*`,
  `repo_method_*`, `job_*`, `audit_stream_delivery_failures`).
- Prometheus → collector `:8888` — the collector's **self-metrics**
  (`otelcol_*`), so the stack can monitor its own ingestion health.
- Prometheus → Prometheus `:9090` — itself.
- Prometheus → Grafana `:3000` (`/metrics`) — Grafana's own metrics.
- Prometheus → Tempo `:3200` (`/metrics`) — Tempo's own metrics.

**The application is never scraped.** It has no `/metrics` endpoint
by design — it is a push-only OTLP source. The *only* scrape
targets are the four observability containers. This is the single
most important property of the data flow: the app's metric path is
fire-and-forget OTLP, and if the collector is down the app simply
drops telemetry (the OTLP exporter fails silently) — the app itself
is unaffected. See the runbook in `04-production-hardening.md`.

**Query path (Grafana-initiated, read-only):**

- Grafana → Prometheus `:9090` (PromQL) for metrics panels and
  alert evaluation.
- Grafana → Tempo `:3200` (TraceQL) for trace search and the
  trace-view panel.

Both datasources are provisioned as code under
`infra/observability/grafana/provisioning/datasources/`.

# Environment Strategy

There is **one stack instance per environment**. Never one
Prometheus serving multiple environments — see the per-environment
isolation argument in `04-production-hardening.md`. Each environment
runs the same compose file with a different `.env`
(`infra/observability/.env.example` is the template).

| Aspect | Local | Staging | Production |
|--------|-------|---------|------------|
| Stack runs? | Optional | Always | Always |
| App `OTEL_ENABLED` | Unset (off by default) | `true` | `true` |
| Trace sampling | 100% | 100% | ~20% (`OTEL_SAMPLING_PERCENTAGE=20`) |
| Metrics retention (`PROM_RETENTION`) | 1–3d | 15d | 30d |
| Traces retention (`TEMPO_RETENTION`) | 24h | 72h–7d | 7d (`168h`) |
| Volumes | Ephemeral (anonymous) | Durable named | Durable named, backed up |
| Grafana auth | Anonymous viewer OK | Admin password + TLS | Admin password + Google SSO + TLS |
| Grafana exposure | `localhost:3001` direct | Caddy + TLS | Caddy + TLS |
| Alerting | Off / none | Low-severity channel | On-call channel + paging for sev-1 |
| Grafana folder | `Local` (or shared) | `Staging` folder | `Production` folder |
| Remote-write | Not used | Not used | Config-ready, commented; enable when needed |

**Local.** The stack is *optional* and the app is **zero-overhead
when it is absent**. `OTEL_ENABLED` is unset by default, so
`initTelemetry()` in `instrumentation.ts` short-circuits — no SDK,
no exporters, no heavy imports. A developer who wants to see traces
locally brings up the compose stack, sets `OTEL_ENABLED=true` and
`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`, and gets 100%
sampling against ephemeral volumes and a tiny retention window.
Anonymous Grafana access is fine locally. Nobody is *required* to
run it.

**Staging.** The full stack, exercised exactly as production runs
it — same compose file, same collector config, same dashboards.
100% trace sampling because staging traffic is low and complete
traces are worth more than storage savings when validating a
release. 15d retention is enough to spot a regression across a
sprint. Alerts fire but route to a **low-severity channel** (a Slack
channel, not a pager) — staging alerts are signal, not pages.
Staging gets its **own Grafana folder** so its dashboards never
sit next to production's.

**Production.** Durable named volumes (`obs-prometheus-data`,
`obs-tempo-data`, `obs-grafana-data`), 30d metrics / 7d traces,
**~20% trace sampling** via the collector's `probabilistic_sampler`
(staging-and-local keep 100%; production trades a fifth of traces
for a fifth of the Tempo disk and ingestion cost — RED metrics are
unsampled and remain exact). TLS at Caddy, Google SSO for Grafana
(the app already uses Google OAuth — reuse the identity provider).
Alerts route to the **on-call channel**, and **sev-1 alerts page**.
Backups are on (see `04-production-hardening.md`). **Remote-write
is the documented next step** — the Prometheus config ships with a
commented `remote_write:` block so long-term/off-host storage is a
config change, not a re-architecture.

# Scalability / Reliability Strategy

The stack is deliberately **single-instance per component**. That
is the correct posture at this scale, and the rationale matters
because "add HA" is the reflexive wrong answer.

**Collector — single gateway instance.** The app is a small fleet
(one VM, three process types) pushing OTLP. One gateway collector
centralizes batching, sampling, and the Prometheus-exporter
surface. An agent-per-host or a DaemonSet would add operational
surface for no benefit at this scale. See the full argument in
`02-otel-collector.md`. If the collector restarts, the app's OTLP
exports fail for the restart window and that telemetry is lost —
acceptable, because telemetry is fire-and-forget and the app keeps
serving requests. The collector's `restart: unless-stopped` policy
plus a `health_check` extension on `:13133` keep the window to
seconds.

**Prometheus — single instance, persistent volume, not HA.** No
Thanos, no Mimir, no second replica. At this app's series count
(see the sizing formula in `03-prometheus-grafana.md`) a single
node is correct; HA would double the storage and add a dedup layer
to solve a problem this deployment does not have. The reliability
investment is instead: (a) a persistent named volume so a container
restart does not lose the TSDB, (b) a disk-runway alert so the
volume never silently fills, and (c) a **commented `remote_write`
block** in `prometheus.yml` — the moment durability beyond one
VM's disk is required, remote-write to a managed backend is a
config edit and a redeploy, not a migration. Single-node-now,
remote-write-ready is the deliberate trade.

**Tempo — single instance, local filesystem backend.** Traces are
diagnostic, not source-of-truth. A single Tempo with a local-disk
backend and a 7d retention window is right-sized. If trace volume
or durability needs grow, Tempo's backend swaps to object storage
(S3/GCS) via config — same component, different `storage` block.

**Grafana — single instance, stateless-by-policy.** Grafana has a
SQLite `grafana-data` volume, but **everything that matters is
provisioned from code** — datasources, dashboards, alert rules,
contact points. The only state unique to the volume is
user-created ad-hoc dashboards and login sessions. Treat Grafana
as reproducible: if the volume is lost, redeploy and the
provisioned config rebuilds the entire UI. This is why "Grafana
down" is a low-severity incident (see runbooks).

**Reliability of the observed system is not coupled to the stack.**
The single most important reliability property: **if the entire
observability stack is down, the application keeps serving
production traffic unaffected.** The app's OTLP exporter fails
silently; `recordRequestMetrics` and friends write to noop
instruments when the SDK cannot reach a collector. The stack is an
*observer*, never a dependency in the request path. The
`/api/livez` and `/api/readyz` probes do not depend on it.

**Scale-out path, in order:** (1) raise retention or enable
remote-write within the single-VM stack; (2) move the compose
project to a dedicated monitoring VM (env var change only); (3) on
Kubernetes, adopt `kube-prometheus-stack` + the collector Helm
chart with our config. Each step is a placement or config change —
none re-opens the architecture.

# Risks and Tradeoffs

| Risk / tradeoff | Decision and mitigation |
|-----------------|-------------------------|
| **Single VM hosts both the app and its observability stack.** A host failure loses both the app and its telemetry simultaneously — exactly when you most want the data. | Accepted at current scale; the cost of a second VM is not yet justified. Mitigation: the scale-out step (dedicated monitoring VM) is documented and is an env-var change. The deadman's-switch alert (`04`) detects total-stack loss from an external uptime check. |
| **Observability containers compete with Postgres/Redis for VM CPU, memory, and disk I/O.** Prometheus TSDB compaction is I/O-heavy. | Each observability container has explicit `mem_limit` / `cpus` caps in the compose file (collector 512m/1.0, Prometheus 1g/1.0, Tempo 1g/1.0, Grafana 512m/0.75). Prometheus retention is bounded (30d) and the volume is sized small (10–20Gi). If contention appears, the dedicated-monitoring-VM step is the answer. |
| **Single-instance components have no failover.** A collector or Prometheus restart is a telemetry gap. | Accepted: telemetry is fire-and-forget; a gap is not an outage. `restart: unless-stopped` + healthchecks bound the gap to seconds. HA would cost more than the gap it prevents. |
| **20% production trace sampling means 4 of 5 traces do not exist.** A specific failing request may have no trace. | Accepted: RED metrics (`api_request_*`) are **unsampled** and remain exact — they answer "is something wrong". Sampling only affects traces ("why"). 20% is enough to characterise behaviour; raise it temporarily during an incident via the collector env var + redeploy. |
| **Logs are out of scope.** No Loki, no log search in Grafana. | Deliberate. The app emits Pino JSON to stdout, captured by the docker log driver; `docker logs` and `journalctl` remain the log surface. Adding Loki is a separate, bounded initiative — not folded into this stack to keep the component count down. |
| **The compose stack joins the app's docker network.** A misconfigured `APP_NETWORK_NAME` silently breaks app→collector resolution. | The `.env.example` documents how to find the real network name (`docker network ls`); the deadman's switch and the collector `up==0` alert catch a broken link within one scrape interval. |
| **Grafana SSO depends on the Google OAuth app already used by the product.** A misconfigured redirect URI locks operators out of Grafana. | Mitigation: the admin password login remains enabled as the break-glass path; SSO is additive. Document the Grafana redirect URI in the OAuth app config. |
| **Watchtower auto-updates the app image; the observability stack is on pinned tags.** A divergence: the app moves, the stack does not. | Intentional — the stack must be upgraded deliberately, staging-first (see `04`). Watchtower is scoped to the app compose project and does not see the observability project. |

# Implementation Phases

Each phase is independently shippable and leaves the system in a
working state.

**Phase 1 — Stack stands up, app still off.**
- Land `infra/observability/` in full: the compose file, the
  collector config, the Prometheus config + rules, the Grafana
  provisioning, the Tempo config, `.env.example`.
- Deploy the compose stack on staging. Verify all four containers
  reach `healthy`.
- App `OTEL_ENABLED` stays **unset** — the app is untouched, the
  stack idles with no app data.
- Exit criteria: `docker compose -f docker-compose.observability.yml
  ps` shows four healthy containers; Prometheus targets page shows
  collector `:8889`/`:8888`, itself, Grafana, Tempo all `UP`.

**Phase 2 — Turn the app on, staging.**
- Set `OTEL_ENABLED=true` and
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318` in the
  staging app `.env`; redeploy the app.
- Verify app metrics appear in Prometheus (`api_request_count` is
  non-zero) and traces appear in Tempo.
- Exit criteria: the "Inflect — API Overview" dashboard renders
  real data; a known request produces a trace in Tempo.

**Phase 3 — Dashboards and alerts, staging.**
- Confirm all provisioned dashboards render. Confirm provisioned
  recording rules evaluate. Confirm alert rules load in Grafana
  Unified Alerting.
- Wire the staging alert contact point to a low-severity channel.
- Fire a synthetic alert (stop the collector) and confirm the
  deadman's switch + `collector down` alert trigger and notify.
- Exit criteria: a deliberate collector stop produces a
  notification within the alert's `for:` window.

**Phase 4 — Production rollout.**
- Deploy the compose stack on the production VM with the production
  `.env` (30d retention, 20% sampling, durable volumes, SSO).
- Place Grafana behind Caddy with TLS; configure Google SSO.
- Set `OTEL_ENABLED=true` on the production app; redeploy.
- Wire alerts to the on-call channel; configure sev-1 paging.
- Enable backups for the Grafana volume (and optionally Prometheus
  TSDB snapshots).
- Exit criteria: production dashboards render; a sev-1 test alert
  pages on-call; the acceptance checklist below passes.

**Phase 5 — Kubernetes parity (when/if the Helm deployment is in
use).**
- Adopt the `opentelemetry-collector` and `kube-prometheus-stack`
  Helm charts, fed our config / rules / dashboards.
- Out of scope for the compose deliverable; documented so it is not
  reinvented.

# Acceptance Criteria

- [ ] `infra/observability/docker-compose.observability.yml` exists
      and brings up exactly four services: `otel-collector`,
      `prometheus`, `tempo`, `grafana`.
- [ ] The compose project is **separate** from
      `docker-compose.prod.yml` — independent volumes, independent
      `up`/`down`, not merged.
- [ ] The collector joins the app's external network via
      `APP_NETWORK_NAME`; the app container resolves
      `otel-collector` by DNS.
- [ ] No observability container publishes a host port **except**
      Grafana, and Grafana publishes `127.0.0.1:3001` only — never
      `0.0.0.0`.
- [ ] The app reaches the collector at
      `http://otel-collector:4318`; setting `OTEL_ENABLED=true` and
      that endpoint produces metrics in Prometheus within two
      scrape intervals.
- [ ] With `OTEL_ENABLED` unset, the app starts with **zero**
      observability overhead — `initTelemetry()` short-circuits and
      no exporter is created.
- [ ] Prometheus scrapes the collector (`:8889` app metrics,
      `:8888` self-metrics), itself, Grafana, and Tempo — and
      scrapes **nothing** in the app compose project. The app has
      no `/metrics` endpoint and is not a scrape target.
- [ ] Stopping the entire observability stack leaves the
      application serving production traffic; `/api/livez` and
      `/api/readyz` stay green.
- [ ] Each environment (local / staging / production) runs its
      **own** stack instance with its own `.env`; no Prometheus
      serves more than one environment.
- [ ] Production uses durable named volumes, 30d metric retention,
      ~20% trace sampling, TLS, and SSO; staging uses 15d / 100%
      sampling / low-severity alerts; local is optional with
      ephemeral volumes.
- [ ] `prometheus.yml` ships a commented `remote_write:` block so
      long-term storage is a config change.
- [ ] Component image tags are pinned (`:0.123.0`, `:v3.3.0`,
      `:2.7.2`, `:11.6.0`) — no `:latest`; Watchtower does not
      touch them.
