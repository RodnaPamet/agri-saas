# Runbook — the DSA contact point and moderation triage

**Audience:** the operator of this deployment. **Status as of 2026-10-13: the
contact point is PUBLISHED AND RESOLVABLE.** A notice filed on production
reaches a human, demonstrated end to end. One residual gap remains and it is
named below.

## Status, measured rather than asserted

```
# PRESENT/ABSENT only — never echo a value out of /opt/agrent/.env
gcloud compute ssh agrent --zone europe-west1-b --command \
  "sudo grep -q '^DSA_CONTACT_EMAIL=.' /opt/agrent/.env && echo PRESENT || echo ABSENT"
# -> PRESENT  (2026-10-13)
```

`https://app.agrent.bg/dsa-contact` renders a `mailto:` rather than its
"no address" fallback, and notice `cr-16c17d7f` was delivered at 21:30:04 on
2026-10-13 and confirmed received by the operator. That is both halves of
#1599's exit criterion.

### The residual gap: it is not a ROLE mailbox, and not on `agrent.bg`

DECISION 1 below asks for a role address (`moderation@`, `dsa@`). The
configured address is a person's mailbox on a different domain the operator
controls, and that is a deliberate unblock rather than an oversight: **mail to
any address at `agrent.bg` bounces.** See #1760 — the domain's MX points at a
host that is not where the mailbox lives, and it answers `550` for every
recipient. Until that is fixed, a role address at `agrent.bg` cannot receive
anything, so insisting on one would have left Art 11/12 unmet rather than met
imperfectly.

So: the duty is discharged, the shape is not yet right, and #1760 is what
closes the difference.

## What to do

**Read this before following the steps: the obvious address does not work.**
The steps below are written for a working `agrent.bg` mailbox, which is what
#1760 is about. Creating `moderation@agrent.bg` and setting it here will
produce a page that looks correct and mail that silently bounces — which is
exactly what happened on 2026-10-13, three times, with the sends reporting
success. Verify step 4 actually arrives before believing step 3.

1. **Create a ROLE mailbox**, not a person's. `moderation@agrent.bg` or
   `dsa@agrent.bg`. It must be read by a human within the window below.
2. **Set it on the VM** and restart the app:

   ```
   # Append to /opt/agrent/.env — a ROLE address, never a personal one.
   # This repository is PUBLIC: a personal mailbox must never reach a tracked
   # file. That is the same rule the Caddyfile divergence records, where the
   # live ACME contact is deliberately NOT the repo's.
   #
   # `moderation@agrent.bg` is the RIGHT shape and, as of 2026-10-13, a
   # mailbox that cannot receive — see #1760 and the warning above. Use a
   # domain whose MX you have verified until that is resolved.
   DSA_CONTACT_EMAIL=moderation@your-verified-domain

   sudo docker compose -f /opt/agrent/docker-compose.vm.yml up -d app worker
   ```
3. **Verify the page resolves**, which is the exit criterion's second half:

   ```
   curl -s https://app.agrent.bg/dsa-contact | grep -o 'mailto:[^"]*'
   ```
4. **Demonstrate the path end to end once** — the exit criterion's first half.
   File a notice against production and confirm a message arrives:

   ```
   curl -s -X POST https://app.agrent.bg/api/public/notices \
     -H 'content-type: application/json' \
     -d '{"subjectKind":"LISTING","subjectId":"runbook-drill","reasonCode":"OTHER",
          "detail":"Runbook drill — please ignore."}'
   ```

   The alert job runs every 10 minutes, so the mail arrives within that. Then
   delete the drill notice from the console, or leave it and reject it — a
   drill notice left RECEIVED inflates the queue a real alert is measured
   against.

## How a notice reaches a human

`notice-triage-alert`, every 10 minutes (`*/10 * * * *`).

- **ONE message per run**, however many notices arrived. `POST
  /api/public/notices` needs no credential and `PUBLIC_NOTICE_LIMIT` is 10/min
  per IP, so a per-notice email would let anyone send 600 messages an hour to
  the one mailbox that has to stay readable during an incident. Batching is what
  makes the alert survive the flood it is most needed during.
- **Urgent first.** `ILLEGAL_CONTENT` and `HARASSMENT_OR_HATE` are named in the
  body and counted in the subject; everything else is counted. The threshold
  lives in `URGENT_REASON_CODES` in `src/app-layer/jobs/notice-triage-alert.ts`
  and nowhere else.
- **The notice TEXT is never in the mail.** `ContentReport.detail` is encrypted
  at rest, and a mailbox is outside that boundary. Open the console to read it.
- **Nothing is marked until the send resolves**, so a failed send leaves every
  notice queued for the next run. And while the address is unset the job marks
  nothing at all — so notices filed before you configure it are still alerted
  afterwards, rather than silently skipped.

## Reading the queue

`GET /api/admin/moderation/notices` with `x-platform-admin-key`. Oldest first
within a status, because P5's exit criterion is a MEDIAN HANDLING TIME and a
newest-first queue optimises the wrong end of it.

The lag that criterion measures runs from `ContentReport.createdAt` — **not**
from `alertedAt`. That column says a human was told; it is not a triage clock,
and it must not be used as one.

**Where it runs TO was stated two different ways in this repo**, and the
difference is not cosmetic: this file and `CLAUDE.md` said the
`ModerationAction`, while #1595's exit criterion and the statements route's
docblock said `StatementOfReasons.deliveredAt`. They measure different duties —
how fast we DECIDE, and how fast the notifier is ANSWERED (Art 17) — and an
action taken but never explained leaves the notifier knowing nothing, so
neither subsumes the other. Both are reported, separately and each with its own
denominator; see #1595.

## The moderator credential

There is **no `MODERATOR` role**, deliberately. Every role in the enum is
tenant-scoped, and a platform moderator is not a member of a farm — so
`admin.manage` would let an ADMIN of any one farm read every other farm's
notices. The moderation surfaces are gated on `PLATFORM_ADMIN_API_KEY` instead,
and the four trust & safety tables deny `app_user` outright, so there is no
weaker path for a route to leave open.

**The consequence is in the audit trail and is deliberate.** `moderatorRef`
records a key GENERATION (`platform-key:current` / `platform-key:previous`), not
a person: there is one key for every operator, so a regulator asking "who
decided this" gets "somebody holding the key". Narrowing that to a person needs
per-moderator credentials, which is **#1599's remaining scope** and is not
shipped.

### Rotating it

`PLATFORM_ADMIN_API_KEY` supports two generations so a rotation needs no
downtime: set the new key as current, keep the old as previous until every
operator has it, then drop the previous. Every moderation action taken in
between records which generation authorised it, which narrows a compromise
window to one side of the rotation.

## What is NOT configured, and what that costs

| | |
|---|---|
| `DSA_CONTACT_EMAIL` | **PRESENT** since 2026-10-13 — the page resolves and the alert job sends. NOT a role address and not on `agrent.bg`, because #1760 makes every `agrent.bg` recipient bounce |
| a mailbox at `agrent.bg` | **unreachable** — #1760. The MX points away from where the mailbox lives and answers `550` for every recipient, invented ones included |
| per-moderator credentials | not built; `moderatorRef` names a key generation |
| alerting on a FAILED alert | the job logs `notice-triage-alert.send_failed` at ERROR; nothing pages. Production alerting here is one GCP uptime check on `/api/readyz`, so this is a log line somebody has to read |
