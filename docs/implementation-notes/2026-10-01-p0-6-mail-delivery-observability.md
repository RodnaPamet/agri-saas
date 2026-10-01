# 2026-10-01 — P0.6 mail delivery is observable

**Roadmap:** social-network P0.6 (#1191)

## The gap this closes — and the one it does NOT

Resend went live in production on **2026-10-01**: `RESEND_API_KEY` + `RESEND_FROM`
are set on the `agrent` VM and two real messages were delivered (Gmail and
inflect.bg). `SMTP_*` remain set as a dormant fallback, and `mailer.ts` prefers
`RESEND_API_KEY` over `SMTP_HOST`. So the roadmap's premise — "the live
production config has no mail transport" — is **out of date**, and nothing here
re-fixes it.

What was still true is the half that makes the first half unprovable from
inside the app. Delivery was demonstrated by calling Resend's API **by hand**
with the container's env. That proves the credentials work; it says nothing
about `sendEmail`. And `ConsoleEmailProvider.send` logged at `debug`, which
production log levels drop — so a silent fallback to "log the message and throw
it away" was **indistinguishable from a successful send**, for invites,
verification links, password resets and the notification outbox alike.

## Design

One decision function, two readers.

`src/lib/email/provider-selection.ts` holds `selectMailProviderKind(env)` —
`resend` if `RESEND_API_KEY`, else `smtp` if `SMTP_HOST`, else `console` — plus
`emailCapabilityStatus(env)`, which wraps it as `{ provider, sends }`.
`initMailerFromEnv()` branches on that function to CONSTRUCT the provider, and
`/api/readyz` calls it to REPORT the provider. A reporter that re-derived the
branch would drift from the constructor the first time a third transport
landed.

The module is a pure function of its argument and imports nothing. That is
deliberate: `mailer.ts` requires `@/env` *lazily* (Next's bundler loads it in
several chunks, and the lazy init path is guarded on the provider still being
the console sink — a guard this change does not touch), so a selection module
that imported `@/env` at parse time would pull env validation back into every
chunk. Each caller passes the env object it already holds.

Three observable signals, none of which can 503 a healthy instance:

1. **The console sink WARNs in production**, naming that the message was NOT
   sent and that `/api/readyz` carries the provider. Dev and test stay at
   `debug` — local development is not made noisy. Production is detected
   through `@/env`'s `NODE_ENV`, not raw `process.env`.
2. **`initMailerFromEnv` logs the selected transport at `info`** (`provider`,
   `sends`) — the inside-the-app counterpart to the hand-run Resend call.
3. **`/api/readyz` reports `capabilities.email`** — `{ provider, sends }`,
   alongside `satellite` and `basemap`, outside `checks`/`failed`.

The probe body reports what is **configured**, which is the honest answer a
probe can give: the web tier initialises the mailer lazily per bundler chunk,
so the provider instance live in the probe's own chunk is not evidence about
the chunk that sends an invite. Both sides branch on the same selector, so
"configured" and "selected" cannot diverge.

`/api/readyz` needs no OpenAPI change — it sits on
`tests/guards/openapi-undocumented-baseline.json` (verified, not assumed).

## Two things deliberately kept out of the WARN

- **The message body.** The `debug` line carries a 200-char `bodyPreview`; the
  production WARN does not. These messages hold verification and password-reset
  links, and a WARN that survives production log levels is a WARN that reaches
  log storage.
- **Any key material.** `provider` is a closed enum; no host, no sender, no
  key appears in the log line or in the probe body.

## Files

| File | Role |
| --- | --- |
| `src/lib/email/provider-selection.ts` | NEW — the one selection function + the readyz capability shape |
| `src/lib/mailer.ts` | console sink WARNs in prod; `initMailerFromEnv` branches on the shared selector and names the transport at `info` |
| `src/app/api/readyz/route.ts` | `capabilities.email` |
| `deploy/env.prod.example` | mail-transport block: `RESEND_*` (priority) + the dormant `SMTP_*` fallback, and what branch 3 costs |
| `tests/unit/mailer-provider-selection.test.ts` | NEW — behavioural: which transport actually ran |
| `tests/unit/readyz-email-capability.test.ts` | NEW — the probe body, through the real route handler |

## Decisions

- **Assert on behaviour, not source text.** Each selection case drives
  `sendEmail` and checks what left the process: a POST to `api.resend.com`, a
  `sendMail` call, or neither plus a WARN. A source-text assertion
  ("mailer.ts mentions `RESEND_API_KEY` first") stays green through a refactor
  that drops the behaviour, and each case also asserts
  `emailCapabilityStatus` agrees with the transport that ran — a probe that can
  disagree with the sender is worse than no probe.
- **The warn fires per send, not once at init.** The send is the moment the
  message is discarded, and an init-time WARN would also have collided with
  `tests/unit/mailer-default-sender.test.ts`'s "does NOT warn" cases, which
  assert on the deliverability warning next door.
- **`deploy/env.prod.example` gains `SMTP_*` as well as `RESEND_*`.** The
  comment has to say Resend takes priority *over SMTP*, which is meaningless if
  the SMTP keys are absent from the file. (The sibling dotfile
  `deploy/.env.prod.example` already carried both; the canonical
  non-dot file — the one `tests/guardrails/deploy-env-parity.test.ts` reads and
  CLAUDE.md names — had no mail keys at all.)
- **`sends` is a boolean, not an inference the reader makes.** "Is mail leaving
  this container?" is the operator's actual question, and `provider: "console"`
  only answers it if you already know what the console sink does.

## Mutation proof

Three mutations, each restored and md5-verified:

1. Inverted the priority in `selectMailProviderKind` (SMTP before Resend) →
   the two resend-selection tests went RED, one per suite.
2. `logger.warn` → `logger.debug` on the production console-sink path → the
   "WARNs in production that mail was NOT sent" test went RED.
3. Dropped `email` from the readyz `capabilities` object → all three probe
   tests went RED.
