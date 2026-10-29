# 2026-10-29 — Google Calendar sync (#2020)

**Commits:** `50ec914db` client · `7796ffb57` test correction · `200179f85` usecase · `96940dbe8` route + spec + UI

## Design

Follow-up B to #2005 (consent flow) and sibling to #2019 (Drive export). Three
layers, matching `drive.ts`'s shape so the two providers read the same way:

```
GoogleCard  ──POST──▶ /admin/integrations/google/calendar/sync
                             │  admin.manage
                             ▼
                      syncFarmCalendar(ctx)
                             │
      ┌──────────────────────┼──────────────────────┐
      ▼                      ▼                      ▼
getCalendarEvents    providers/google/calendar   configJson
 (9 sources, the        (the API surface)     {calendarId, calendarLocale}
  desired set)
```

The owner ruled **sync, not push** (2026-10-29). Of the nine dated sources,
task due dates, lease expiry and contract delivery windows all move, so a push
leaves the farmer planning around dates that no longer exist.

### The mapping lives ON the event

#2020 proposed `IntegrationConnection.configJson` or a new table. Neither was
needed. Calendar supports `extendedProperties.private`, so each event carries
the stable composite id `getCalendarEvents` already mints
(`TASK:123:task-due`). Consequences: no migration; the mapping cannot drift
from reality because it IS reality; and deleting the Agrent calendar removes
the mapping with it, so the integration stays revocable by one gesture in the
farmer's own UI. Only the calendar's own id is stored, which is one value and
exactly what `configJson` is for — the `driveFolderId` shape.

## Files

| file | role |
| --- | --- |
| `src/app-layer/integrations/providers/google/calendar.ts` | the Calendar API surface: calendar, events, fingerprint, the status→code map |
| `src/app-layer/usecases/calendar-google-sync.ts` | the diff, the window, the locale decision, the audit entry |
| `src/app/api/t/[tenantSlug]/admin/integrations/google/calendar/sync/route.ts` | `POST`, `admin.manage`, no body, `maxDuration = 60` |
| `src/lib/openapi/paths/google-calendar.paths.ts` | the family's first documented route — the undocumented baseline only shrinks |
| `src/app/t/[tenantSlug]/(app)/admin/integrations/GoogleCard.tsx` | the button, and the two notices that carry `partial` / `skippedEdited` |

## Decisions

- **Absence is not evidence, on two axes.** A sync deletes what is no longer
  wanted, so it has to be sure an absence means that. The sources are read over
  a bounded window (30 days back, a year forward), so an event that has aged out
  is absent for a reason that has nothing to do with the farmer — deleting it
  would make every run destroy the farm's history, and the first run after a
  window change would do it wholesale. And `getCalendarEvents` caps each source
  and reports `truncated`, so a truncated desired set makes every dropped event
  look deleted. Deletion is therefore bounded by BOTH: inside the window, and
  only on an untruncated read. Creates and updates still run; `partial` reports
  the suppression rather than hiding it.

- **A farmer's edit wins, deletion included.** `contentFingerprint` records the
  fields we wrote, so a mismatch means they changed it. Such an event is skipped
  for update AND for delete. The second half is the less obvious one: an edited
  event has been repurposed, so withdrawing it because the original deadline
  moved on destroys their work rather than ours. A `null` written hash reads as
  NOT edited, so events written before the fingerprint existed are not frozen
  forever.

- **The language is persisted, not resolved per sync.** `titleKey` is an i18n
  key resolved by the renderer, and there is no renderer here.
  `IntegrationConnection` has no `createdByUserId`, so the connecting user is
  unrecoverable; using the CALLER's language would make two admins with
  different preferences rewrite every title on every alternate sync. The locale
  is written beside the calendar id on creation and read thereafter — the
  stable-destination argument the oldest-connection rule already makes. A farmer
  who wants it changed deletes the calendar, which is already the documented
  reset.

- **Three `runInTenantContext` calls, all sequential, none nested.** Connection
  lookup, the caller-locale read, then the `configJson` write plus the audit
  entry; `getCalendarEvents` opens its own. A second pool connection inside an
  open transaction is #1191's P0.8 deadlock, so the ordering is deliberate
  rather than incidental.

- **The button owns its abort signal.** `apiPost` applies
  `API_CLIENT_TIMEOUT_MS` (20s) against a route declaring `maxDuration = 60`, so
  a first sync on an established farm would be aborted by the client and
  reported as a failure having succeeded. 65s lets the server's bound fire and
  answer with something true.

- **A refusal shows the server's sentence**, via `apiPost` rather than a local
  code→copy map. Owner ruling #1677: the server resolves the locale and sends
  `message` already translated, and the web reads the error `code` nowhere.

- **Documented in OpenAPI rather than baselined.** Every other
  `/admin/integrations/google` route is on `openapi-undocumented-baseline.json`,
  and that baseline only shrinks — so a new route cannot join it. The right
  forcing function, and this is the family's first documented entry.

## Two defects found in my own work while building this

- **A raw NUL byte made the client invisible to `grep` (#2446).**
  `contentFingerprint` separates its fields with a NUL, which is the right
  choice — it cannot occur in the inputs, so the digest is unambiguous and
  `{summary: 'a b', startDay: 'c'}` cannot collide with
  `{summary: 'a', startDay: 'b c'}`. It was written as a RAW byte, and ugrep
  classifies such a file as binary and skips it silently, for every pattern.
  That exempted the file from `scripts/detect-secrets.sh` and from every
  `grep -r` over `src/`. Proved with a positive control: a planted
  AWS-key-shaped string is found in a clean file and invisible in a NUL-bearing
  copy, while Node reads it in both. Fixed by spelling it as the escape —
  identical at runtime, so no digest changed. The repo-wide scan found the same
  idiom in two files already on main (`cadastre/ownership.ts`,
  `grain/contract-value.ts`), which is why #2446 takes the guard and those two
  rather than this PR.

  Found by accident, chasing a `grep` that looked like a false absence. That is
  the argument for the guard: three authors reached for the same reasonable
  thing and nothing could tell them the file had gone dark.

- **The Bulgarian button label was informal.** #2020 requires formal "Ви", and
  the adjacent button on the same card is «Свържете Google». Mine read
  «Синхронизирай календара» — singular imperative. Now «Синхронизирайте
  календара». Worth recording because the i18n gates cannot catch it: key
  parity, drift and the untranslated check were all green, since the string
  exists in both locales and differs from the English.

## A 429 reached the operator as "An error occurred" — on BOTH providers

`refuseCalendar` and `refuseDrive` both fell through to `externalServiceError`
for a 429. That is a 502, `DomainError` sets `expose = status < 500`, so
`toApiErrorResponse` replaces the message with the literal
`'An error occurred'` — and `errors.EXTERNAL_SERVICE_ERROR` has no catalogue
entry for `localizeErrorPayload` to put anything better in its place.

The measurement worth keeping is about which POPULATION the catalogue migration
reached. Of 257 distinct `coded*()` codes, **255 have an entry** — only
`BLOCK_SELLER_ONLY` and `THREAD_BLOCKED` do not. But the codes minted by the
OTHER error constructors were left behind wholesale: `EXTERNAL_SERVICE_ERROR`,
`CONFIGURATION_ERROR`, `DEPRECATED_RESOURCE`, `STALE_DATA` and
`TENANT_ISOLATION_VIOLATION` have no entries at all. So #1677's catalogue is
effectively complete for `coded*()` and empty for everything else, which is why
reaching `externalServiceError` is the branch that loses the farmer's language.
That is a wider question than this PR and is not addressed here.

So a rate-limited farmer was told nothing and given no remedy, while the
identical condition reported as a 403 got «Опитайте отново след малко». The two
providers needed different fixes, which is the part worth knowing:

| | 429 maps to | why |
| --- | --- | --- |
| Calendar | `GOOGLE_CALENDAR_REFUSED` (existing) | its sentence already says «Опитайте отново след малко» — Calendar's 403-other case IS usually a rate limit |
| Drive | `GOOGLE_DRIVE_RATE_LIMITED` (new) | `GOOGLE_DRIVE_REFUSED` says «Проверете свободното място в Drive», which is right for the 403 quota case and wrong for a rate limit |

Routing Drive's 429 to the existing code would have told a farmer to free disk
space — the same wrong-advice trap that function's 403 arm already guards
against, pointing the other way.

`GOOGLE_GRANT_REVOKED` is shared by both features and its copy named only
exporting («Свържете я отново, за да експортирате»), which is the wrong verb
for a sync. Now purpose-neutral.

A **5xx is deliberately NOT folded in**: "Google is down" is not "Google
refused", a 502 propagates the first honestly, and the suppressed message is a
repo-wide policy that should not be overridden for one provider without a
separate decision. Both clients have a control case pinning that.

## What this did NOT do

- **The Drive path is still unexercised.** #2020's own sequencing wants #2019
  proven "with a human watching every attempt" first, and nobody has pressed
  that button yet. It is shipped, not exercised — so the failure-surfacing this
  feature was meant to inherit has not actually been established by anything.
  Flagged to the owner rather than quietly treated as satisfied.
- **No schedule — owner decision, 2026-10-29, tracked as #2450.** The issue
  describes a feature that "writes on a schedule"; this is a button, for
  #2019's reason — a person in front of every attempt finds an expired token or
  a partial grant. A scheduled sweep inherits the question of how a 03:00
  failure reaches somebody, and the Drive path was sequenced ahead of this to
  answer it. It has not, because nobody has pressed that button. The sync
  itself is already safe to run unattended (idempotent, never deletes on an
  incomplete read, never touches an edited event), so deferring costs nothing
  but the cadence.
- **The two pre-existing NUL files** (`cadastre/ownership.ts`,
  `grain/contract-value.ts`) are left to #2446 with the guard, since they are
  nothing to do with #2020 and the guard is what stops recurrence.
