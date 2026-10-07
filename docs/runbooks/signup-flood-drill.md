# Signup flood drill

What happens when somebody points 100 signups a minute at registration from
rotating addresses, and what stops them.

**The answer is already measured and checked in.**
`tests/unit/signup-flood.test.ts` runs the experiment on every CI run and
prints its numbers. Read that first; this page is for the cases it cannot
reach.

## What the checked-in experiment found

Measured 2026-10-07, 100 attempts per phase:

| phase | created | 429 | 400 |
|---|---|---|---|
| 100 attempts from ONE address | **15** | 85 | 0 |
| 100 attempts from 100 addresses | **100** | 0 | 0 |
| 100 from 100 addresses, Turnstile configured + verification failing | **0** | 0 | 100 |
| same, token omitted entirely | **0** | 0 | 100 |

Three things to take from it.

**The per-IP tier works and is not the defence here.** `SIGNUP_LIMIT` is 15 an
hour and the first row shows it holding exactly. It is keyed on the address, so
the second row is not a bug in it — it is the definition of it. An attacker
holding a hundred addresses holds a hundred budgets.

**While `TURNSTILE_SECRET_KEY` is unset, a rotating-address flood is not
stopped.** Every one of those hundred attempts wrote a real unverified `User`
row. Nothing else on the path refuses them: the disposable-domain list only
catches listed domains, and a bot can send `acceptedTerms: true` as easily as a
person can tick a box.

**Turnstile is the control that closes it, and it is dormant.** P3.5c shipped it
deliberately so — the keys are the owner's to add, and no deploy is needed, just
the environment variables. The third and fourth rows are what setting them buys.
The fourth row matters on its own: once a secret is configured, a request with
no token at all is refused rather than treated as a skip.

## Why rotating the header is a fair simulation

`getClientIp` reads `x-forwarded-for` and takes its first entry, so the test
sets that header. That is not a production hole. The live Caddy site block
carries:

```
header_up X-Forwarded-For {remote_host}
```

which **replaces** the field with the real peer address rather than appending to
it, so a client cannot choose its own bucket. Setting the header locally
therefore stands in for an attacker with many real addresses, which is the
threat, rather than for a header-spoofing bug.

**If that directive ever becomes an append, the premise inverts** and a single
host could spoof its way to unlimited buckets. Re-check it before trusting the
per-IP tier. Note also that `deploy/Caddyfile` is a record, not a deployment —
`deploy/apply.sh` does not copy it and `deploy/check-drift.sh` does not hash it — so confirm
against the live `/opt/agrent/Caddyfile`, not only the repo copy.

## What the experiment does NOT cover

It drives the route handler directly, so it says nothing about:

- **the Edge middleware** — `authRateLimit` and the public-path gate run before
  the handler;
- **real bcrypt cost under parallel load** — the handler is awaited serially
  here, and `hashPassword` is mocked, so the CPU a flood actually imposes is not
  measured;
- **connection-pool behaviour** — Prisma is mocked, so `PG_POOL_MAX` is never
  approached.

Those need a real HTTP flood against a real server.

## Running the real thing, if you want it

The owner's standing decision (2026-10-07) is **local stack only**. Do not point
this at `app.agrent.bg`: at 100 signups a minute it exhausts the shared limiter
for real users, sends a burst of verification mail that costs sender reputation,
bloats the production database, and can trip the `/api/readyz` uptime check —
which emails an outage alert you caused.

```bash
# 1. local stack (postgres, pgbouncer, redis)
docker compose up -d postgres pgbouncer redis

# 2. build and start the app with the limiter ON and in-process
RATE_LIMIT_ENABLED=1 RATE_LIMIT_MODE=memory npm run build
RATE_LIMIT_ENABLED=1 RATE_LIMIT_MODE=memory npm run start
```

Then drive it with any HTTP tool that can vary a header — the shape is one POST
to `/api/auth/register/start` per attempt, carrying a distinct
`X-Forwarded-For`, a unique email, `acceptedTerms: true` and the current
`termsVersion` (render `/terms` to read it, or send a wrong one once and take
`currentVersion` from the `400`).

To exercise the control rather than the gap, use Cloudflare's documented test
secrets rather than real keys:

| secret | behaviour |
|---|---|
| `1x0000000000000000000000000000000AA` | always passes |
| `2x0000000000000000000000000000000AA` | always fails |

Set `TURNSTILE_SECRET_KEY` to the second and the flood should land nothing; set
it to the first and a single legitimate signup should still succeed. **Run both.**
"Nothing landed" on its own is equally satisfied by a broken endpoint, which is
why the checked-in experiment has that positive control and why a manual drill
needs it too.

## The open item

Setting `TURNSTILE_SITEKEY` and `TURNSTILE_SECRET_KEY` on the VM is the one
action that turns the second row of that table into the third. It needs no
deploy. Until then the measurement above stands as the honest description of
what registration will accept.
