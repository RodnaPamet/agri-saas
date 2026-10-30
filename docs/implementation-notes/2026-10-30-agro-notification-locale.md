# 2026-10-30 — agro notifications in the recipient's language

**Commit:** `<pending>` fix(agro): render agro notifications in the recipient's language

## Design

`src/lib/agro/rules.ts` has returned reasons in **two forms** since #37, and
its own docblock states the split: English `reasons[]` "for AI/audit/
notification consumers", structured `reasonCodes[]` "for i18n at the UI render
layer". The spray evaluator emits both; the five spray codes have carried
Bulgarian copy under `locations.smart.sprayReason.*` all along, and
`SmartDefaultsBanner` renders them.

The defect is that **one of the three consumers on the English side does not
belong there**. A notification is read by a farmer, and `User.uiLanguage`
defaults to `bg` (four of five users carry it). So:

- `src/app-layer/notifications/agro.ts` held three English title literals and
  three English body template functions. Every bell row and every Web Push on
  the agro surface arrived in English, whatever the recipient speaks.
- `agro-signals.ts` passed `spray.reasons[0]` — an English sentence — as the
  push `detail`, which would have put an English clause inside a Bulgarian
  sentence even after the titles were fixed.
- `evaluateDiseaseRisk` had no `reasonCodes` at all, so its reason had only an
  English form and nothing to render from.

The other two English consumers stay English, deliberately: the copilot builds
an English prompt and pins its *output* language separately
(`generateCopilotExplanation({ locale })`), and `AgroSignal.detailsJson` is read
by that prompt. `detailsJson` is therefore unchanged — storing descriptors there
would also silently empty `agronomy-copilot.ts`'s
`.filter((r): r is string => typeof r === 'string')`.

Three moving parts:

1. **`DiseaseReasonCode`** (`noSustainedWarmWet`, `consecutiveWarmWetDays`)
   mirrors the spray shape, with copy at `locations.smart.diseaseReason.*`.
2. **`@/lib/agro/reason-label`** renders one reason for a person. It reuses the
   UI's existing keys rather than translating the same five spray sentences
   into a notification namespace — one catalogue per string, or the two copies
   drift. Returns `null` rather than the key on a miss, because
   `translateFor` returns the KEY when a lookup fails and
   «…за пръскане — locations.smart.sprayReason.windUnsuitable» is worse than
   no detail at all.
3. **`AgroNotificationTarget.locale` is REQUIRED.** The `Notification` row
   stores rendered text, so a forgotten locale is indistinguishable from a
   chosen one — the same rule as `EnqueueEmailInput.locale`.

## Files

| File | Role |
|---|---|
| `src/lib/agro/rules.ts` | `DiseaseReasonCode` / `DiseaseReason`; `evaluateDiseaseRisk` emits `reasonCodes`; the split docblock corrected |
| `src/lib/agro/reason-label.ts` | new — renders a spray or disease reason for a person, `null` on a catalogue miss |
| `src/app-layer/notifications/agro.ts` | `COPY` holds keys not sentences; `locale` required; `AGRO_COPY_KEYS` derived from the table |
| `src/app-layer/usecases/agro-signals.ts` | reads `owner.uiLanguage` off the existing relation; renders `detail` from `reasonCodes[0]` |
| `src/app-layer/jobs/agronomy-copilot.ts` | passes the locale it already resolves for the prompt |
| `messages/{bg,en}/app.json` | +11 keys each: 2 disease reasons, 3×3 notification copy |

## Decisions

- **Two body keys (`body` / `bodyWithDetail`), not one with a conditional.**
  `translateFor` is a plain `interpolate` with no ICU: a `select` would come
  back as the literal template, and the i18n drift check would read its inner
  words as placeholder names. Same shape as the digest reasons and task-due.
- **The disease day count rides AFTER a label** —
  «Топло-влажни дни подред: {days}» rather than «{days} поредни дни». Bulgarian
  needs plural agreement, there is no ICU, and `DiseaseRiskThresholds` is a
  parameter, so a `moderateRun: 1` would make an inline count ungrammatical.
  This is the house convention from the triage-alert note.
- **The locale is read off the `Location.owner` relation the claim query
  already walks**, not a second `findUnique`. That query runs inside the claim
  transaction, and a read needing its own connection is #1191's P0.8 deadlock
  at `PG_POOL_MAX`.
- **`recipientLocale` is hoisted above the `obs.length === 0` early return** so
  both of phase 1's returns carry it. The alternative — a
  `?? RECIPIENT_FALLBACK_LOCALE` at the consuming site — is a branch that can
  never run (`obs.length === 0` implies `diseaseNew === false`), i.e. a gate
  narrow enough to always pass.
- **An absent preference resolves to `bg`, not `en`.** That is
  `resolveRecipientLocale`'s documented fallback and the column default, so the
  unowned-location case (notified to `ctx.userId`, whose language this query
  never read) lands on the language the row would have carried anyway.
- **«A risk has been raised» was dropped from the disease body.** It referred to
  the GRC `Risk` register, which the teardown removed — `agro-signals.ts`'s own
  comment says "the AgroSignal row IS the record now". Re-translating a sentence
  about a deleted feature would have carried it into a second language.
- **A whitespace-only `detail` is now treated as absent.** It used to be truthy
  and rendered a dangling « — ». Same direction as `sanitizePlainText` trimming
  since #1825.
- **Not in scope**, each for a stated reason: `soil/suitability.ts` (its
  spec-exposed `SoilSuitability.reasons` has no renderer — a separate change),
  `detailsJson` (its reader is an English prompt), and the copilot prompt
  itself (English input, output locale pinned separately).

## Verification

`tests/unit/agro/agro-notification-locale.test.ts` **executes** the writer
against the real catalogue — the i18n layer is deliberately not mocked, because
a mocked `translateFor` cannot report a missing key, which is the half that
fails silently. The catalogue-completeness check derives its key list from
`AGRO_COPY_KEYS`, so a fourth notification kind added without copy fails there
rather than shipping its key as a push title. Four assertions were added to
`tests/unit/agro/agro-signals.test.ts` for the wiring (the locale threaded from
`owner.uiLanguage`, and `detail` being a rendered sentence with no Latin
characters in it).
