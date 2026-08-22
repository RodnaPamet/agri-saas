# 2026-08-22 — notification emails speak the recipient's language (#694 step 2)

**Commit:** `see git log` fix(notifications): render outbox emails in the recipient's language

## Design

`locale` becomes a **required** field on `EnqueueEmailInput`. Each producer
resolves it from the `User` row it already loads; the seam only carries it.
`buildEmailContent` becomes `async` and passes it to the live template builders.

No Prisma migration: `User.uiLanguage` already exists, and nothing about locale
is persisted on the outbox row.

## Why required rather than optional

`NotificationOutbox` stores RENDERED `subject` / `bodyText` / `bodyHtml` and has
no locale column, so the language is frozen at enqueue time. A defaulted locale
would be indistinguishable from a chosen one and would silently ship `bg` to an
English speaker with nothing to notice. There are three call sites; TypeScript
found all three. Same reasoning CLAUDE.md already records for the upload
convention's `scanStatus`: never restore a default that means "unknown".

## Why the producers resolve it, not the seam

Every producer already selects the recipient's `User` row, so this is a
one-column addition each:

| producer | existing query |
|---|---|
| `task.ts:407` | `select: { email, name }` → `+ uiLanguage` |
| `access-review-reminder.ts:143` | nested `reviewer: { select: … }` |
| `access-review-overdue-escalation.ts:110` | nested `user: { select: … }` inside the bulk `loadAdmins` |
| `retention-notifications.ts:155` | nested `user: { select: … }` |

Resolving inside `enqueueEmail` would add a `user.findUnique` per call — and the
escalation job calls it once per admin per campaign, inside a loop that
`loadAdmins` was hoisted out of specifically to satisfy the D1 N+1 guardrail.
It would also widen the interactive transaction the task path runs inside.

## What I found that the issue did not say

- **`retention-notifications.ts` does not use `enqueueEmail` at all.** It writes
  its own `notificationOutbox` row at `:169` with inline strings, so the
  `EVIDENCE_EXPIRING` arm of `buildEmailContent` — and
  `buildEvidenceExpiringEmail` with it — is **unreachable**. That makes **nine**
  dead template arms, not the eight #694 counted. It does check
  `isNotificationsEnabled` and hand-rolls a matching dedupe key, so it is a
  deliberate parallel path, not a bypass. Localised in place.

- **Access reviews are live**, checked before translating their prose into
  Bulgarian: `AccessReview` is in `auth.prisma:505`, both jobs are registered in
  `executor-registry.ts` and scheduled in `schedules.ts`, and the UI route
  exists. Worth checking after a teardown that deleted neighbouring models.

- **The dedupe key was already per-recipient** —
  `{tenantId}:{type}:{email}:{entityId}:{day}` includes the email — so two
  recipients with different locales were never at risk of sharing a row. Locale
  is deliberately **not** added to it: a user switching language mid-UTC-day
  would then receive a second copy, which is worse than the first arriving in
  the prior language.

## Decisions

- **Emoji stay in code.** `no-decorative-emoji-in-messages` bans them in
  `messages/*.json` and sanctions them in these template modules. The `⏰` and
  `⚠️` markers are concatenated onto the translated subject, and a test asserts
  they survive translation *and* are absent from the catalogues.

- **`taskType` is left untranslated.** It is a Prisma enum member lower-cased
  for prose; translating it needs a per-member key set, which is a separate
  decision rather than something to slip in.

- **Deferred, with issues:** the digest (#694 step 3) and the invite email
  (#722 — an invitee has no `User` row, so any fix picks a proxy; that is a
  product call). Deleting the nine dead arms is also separate — doing it here
  would bury a localisation diff under a large removal.

## A test-layering lesson, found by mutation

Replacing `buildEmailContent(type, payload, locale)` with a hardcoded `'en'`
left **all 34 tests green**. The builders were covered; the *seam* was not.
`tests/unit/enqueue-email-locale.test.ts` closes it by driving `enqueueEmail`
and asserting the stored row's language — the artifact that actually reaches the
recipient, since `processOutbox` replays it verbatim.

Same shape as the token-exchange budget in #715. A test per layer is not
redundancy; the layers fail independently, and only mutation shows which one is
uncovered.
