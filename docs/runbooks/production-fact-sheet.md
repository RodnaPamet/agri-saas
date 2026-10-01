# Production fact sheet — agrent VM

**Measured 2026-10-01** against the live `agrent` VM (`europe-west1-b`). P0.3 of the
social-network roadmap (#1191).

Every figure here was read from the running system, not from a config file in this
repo — where the two disagree, this file records what production actually does.
**Key NAMES only; no secret values are recorded here or were printed while
gathering them.**

Re-measure before P7 (realtime capacity) and P11.1 (launch capacity). The commands
are given so the next person gets the same numbers rather than a different method.

---

## Database

| | |
|---|---|
| database | `agrent_production` |
| collation / ctype | **`en_US.utf8` / `en_US.utf8`** |
| encoding | `UTF8` |

**The collation is not `C`.** That was a P0 exit criterion, and it is also the
precondition P6.8 names before enabling `pg_trgm` for Latin↔Cyrillic matching
(«Pobeda» finding «Победа»). A `C` collation would have made that search behave
differently and the plan says to check it first.

```bash
gcloud compute ssh agrent --zone europe-west1-b --command \
  "sudo docker exec agrent-db psql -U postgres -tAc \"select datname, datcollate, datctype, pg_encoding_to_char(encoding) from pg_database\""
```

## Connection pooling

| | |
|---|---|
| pgbouncer `pool_mode` | **`transaction`** |
| `max_client_conn` | 200 |
| `default_pool_size` | 25 |
| Prisma `connection_limit` | **not set** — Prisma uses its own default |

Two things follow, and they interact:

- **Prisma's pool is implicit.** No `connection_limit` or `pool_timeout` appears in
  the production URL, so each container runs Prisma's default sizing. **P0.8 asks
  for an explicit `max`** — this is the measurement behind that item, and it means
  the real limit today depends on the container's CPU count rather than a decision
  anyone made.
- **Transaction pooling with 25 server connections is the constraint P0.8's other
  half acts on.** The review found notifications firing inside the sender's still-open
  transaction, each send holding 2 database connections. Under `transaction` mode a
  connection is held for the life of the transaction, so work done inside one is
  work done while holding a slot out of 25.

## Caddy

| | |
|---|---|
| version | **v2.11.4** |
| image tag | `caddy:2-alpine` — **floating** |

**Not pinned.** P11.1 calls for pinning it in coordination with playerz, and this is
why: `caddy:2-alpine` resolves to whatever the latest 2.x alpine build is at pull
time, so a container recreate can change the proxy version with no change in this
repo. The same Caddy fronts **both products** on this host, so an unexpected minor
affects playerz too.

## Redis

| | |
|---|---|
| `maxmemory` | 512 MB |
| `maxmemory-policy` | **`noeviction`** |
| used | **95.67 MB** (18.7% of cap) |
| peak used | 95.77 MB |
| keys | 63,009, of which **34 have a TTL** |
| `mem_fragmentation_ratio` | 0.54 |
| auth env var | `REDISCLI_AUTH` (name only) |

**`noeviction` is deliberate and must stay.** `verifyRedisEvictionPolicy` in
`src/lib/redis.ts` logs an ERROR in production if it finds a key-evicting policy,
because BullMQ job state lives in Redis and would be silently dropped under memory
pressure. Do not "fix" this to `allkeys-lru`.

**The consequence to understand is what happens at the cap.** With `noeviction`,
a full Redis fails *writes* rather than evicting. That is not only a cold cache:
BullMQ enqueues fail, rate-limit counters fail, and the feature-flag cache fails
(the last degrades safely — `src/lib/feature-flags.ts` catches and reads the
database).

**Growth is bounded, so the 18.7% is a steady state and not an early reading.**
99.9% of the keyspace — 62,969 of 63,009 keys — is `bull:inflect-jobs`, and every
job type in `src/app-layer/jobs/types.ts` sets explicit `removeOnComplete`
(50–1000) and `removeOnFail` (100–2000) caps. The keyspace therefore has a ceiling
rather than growing with time. Only 34 keys carrying a TTL is consistent with that:
BullMQ prunes by count, not by expiry.

| prefix | keys |
|---|---|
| `bull:inflect-jobs` | 62,969 |
| `api:route-outcome` | 24 |
| `bull:inflect-soil` | 11 |
| `trends:prices` | 3 |
| `inflect:cache` | 3 |
| `agrent:worker` | 1 |

**One number recorded without a diagnosis:** `mem_fragmentation_ratio` of 0.54.
Below 1.0 means resident memory is smaller than the logical dataset, which usually
indicates swapping. It is recorded here as an observation for P11.2's Redis alerting
rather than interpreted — a single reading is not a trend, and the right response
is a metric over time, not a conclusion now.

## Container images — what floats

Watchtower polls and auto-updates, so a floating tag is a live surface, not a
latent one.

| container | image | pinned? |
|---|---|---|
| `agrent-app`, `agrent-worker` | `ghcr.io/rodnapamet/agri-saas:latest` | floating — **intentional**, this is how Watchtower deploys |
| `agrent-caddy` | `caddy:2-alpine` | **floating** — P11.1 |
| `agrent-pgbouncer` | `edoburu/pgbouncer:latest` | **floating** |
| `agrent-redis` | `redis:7-alpine` | floating within 7.x |
| `agrent-db` | `agrent-db:local` | locally built |
| `agrent-watchtower` | `containrrr/watchtower:latest` | **floating** |

`edoburu/pgbouncer:latest` is the one worth a second look: it sits on the path of
every database query, and `latest` on a connection pooler is an unannounced change
to the thing that holds the 25 server connections above.

## This VM is shared

Ten `playerz-*` containers run alongside the six `agrent-*` ones, including their
own Postgres, Redis and pgbouncer. **Capacity work in P11.1 is therefore a
negotiation, not a unilateral change** — and the shared Caddy is the component both
products route through. The misrouting incident that produced `deploy/caddy-foreign-sites.txt`
came from exactly this overlap.
