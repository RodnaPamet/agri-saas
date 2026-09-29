# 2026-09-29 — a health probe says whose health it is

**Refs:** #854 (the uptime check), #1117 / #1143 (the misrouting incident)

## Design

The GCP uptime check for `app.agrent.bg` matches `"status":"ready"` in the
`/api/readyz` body. That asks *"is something at this address ready?"* — not
*"is agri-saas ready?"* — and the difference is not academic, because the
sibling product `inflect-compliance` emits the identical string and the two
share a GCP project, a GHCR org and a Docker network.

The fix is one literal, emitted by all three probes:

```
SERVICE_ID = 'agri-saas'   →   "service":"agri-saas"   in readyz / livez / health
```

and, as a **separate later step**, tightening the check's content matcher to
require it.

## What made this worth doing rather than theorising about

Measured from the uptime check's own time series, seven days, using the exact
alert expression (`300s` / `ALIGN_NEXT_OLDER` / `REDUCE_COUNT_FALSE`, fires at
`> 1`):

| | |
|---|---|
| 5-min buckets with >1 region failing | **62** |
| longest unbroken run | **16 buckets = 80 minutes** |
| days those 62 buckets fall on | **1** (2026-09-27), zero on the other six |
| window | 12:00 → 17:50 UTC, continuous |

That window is #1117: a stack sharing `agrent_internal` declared the same `app`
network alias, Docker DNS answered `app` with two addresses, and Caddy's
`reverse_proxy app:3000` chose per connection. #1143 states the consequence
outright — *"`/api/readyz` answered 200 through the proxy while agri-saas 404'd
it, because the 200 came from the OTHER app."*

The check went red only because the misrouting app happened not to emit
`"status":"ready"`. Had the misroute been to `inflect-compliance`, which does,
the check would have read GREEN for six hours over an application serving
somebody else's data.

## Files

| file | role |
|---|---|
| `src/lib/service-identity.ts` | `SERVICE_ID` + `SERVICE_ID_MATCHER`, with the reasoning |
| `src/app/api/{readyz,livez,health}/route.ts` | emit `service` |
| `tests/unit/health-probe-identity.test.ts` | EXECUTES the handlers; asserts the raw body |
| `infra/alerts/external-uptime.yml` | records the incident, stages the matcher change |
| `CLAUDE.md` | the probe claim it makes is now qualified |

## Decisions

- **A literal, not `package.json`.** `package.json` still reads
  `"name": "inflect-compliance"` from the spin-out, and `OTEL_SERVICE_NAME`
  defaults to the same string. Deriving the identity from either would produce
  a value matching the sibling EXACTLY — worse than no identity, because the
  probe would go green on precisely the misroute it exists to detect, while
  looking solved.

- **`agri-saas`, not `agrent`.** `agrent` is the deployment and the hostname;
  `agri-saas` is the repo and the GHCR image path. CLAUDE.md records that the
  GHCR org is shared and "only the image NAME separates the two products", so
  this is the token an operator already uses to tell them apart.

- **The matcher change is a SECOND deploy, and the order is not negotiable.**
  Tightening it before the image carrying the field has rolled fails every
  probe and pages for an outage we caused. Same shape as the worker-healthcheck
  ordering CLAUDE.md already records. Staged as `body_contains_pending`.

- **Executed, not guarded.** A regex can confirm `service: SERVICE_ID` appears
  in a route; only calling the handler proves the field survives `jsonResponse`
  and reaches the bytes a probe reads. The test asserts against the RAW BODY
  for the same reason — the probe matches a substring of the wire, so a
  key-presence check on a parsed object would pass through a serialisation
  change that broke the matcher.

- **The failure path carries it too.** A 503 from the wrong application would
  page an operator about a service that is fine, so `not_ready` names itself
  as well.

- **No deploy-suppression mechanism was built, because the premise was false.**
  This work began as "make Watchtower's restart visible to the uptime check so
  a deploy's 502 window doesn't read as an outage". The measurement above kills
  it: across seven days the ONLY breaches of the alert condition were the
  misrouting incident. A restart is under a minute; the condition needs >1
  region sustained across a 300s window and absorbs it completely. The thing
  worth building was the one the same measurement exposed.
