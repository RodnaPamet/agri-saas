# 2026-08-23 — the invite email uses the inviter's language (#722)

**Commit:** `see git log` fix(invite): write the invitation in the inviter's language

## The decision

Every other outbound email reads the recipient's `User.uiLanguage`. An invitee
has **no `User` row** — that is the entire point of an invite — so this one
email must pick a proxy. Four candidates, weighed rather than defaulted:

| option | verdict |
|---|---|
| **inviter's language** | **chosen.** Right for the common case; no worse than English for a foreign invitee. Cheap — the inviter is already in `ctx` at all three call sites. |
| bilingual | never wrong, visibly clunky, doubles the body |
| stay English | *looks* neutral and is not — see below |
| ask the admin | most correct, needs a schema column, UI on three surfaces, and a decision imposed on every invite |

**English is not the neutral option.** Measured against production before
deciding: 5 users, **4 `bg` and 1 `en`**, 10 invites sent to date, and
`User.uiLanguage` defaults to `bg`. Staying English would be the wrong language
for four users in five.

## Fail-soft, deliberately

`inviterLocale` returns the fallback on any lookup failure rather than throwing.
An invite in the fallback language is recoverable — the link still works. An
invite that never sends because a locale lookup threw is not: the invite row is
already committed and the admin has been told the email went out. Same reasoning
as the verification-email lookup in `@/lib/auth/email-verification`.

That is also why a call site may safely `await` it inside an argument list, and
the guard asserts the property rather than trusting it.

## A copy regression the existing test caught

Translating collapsed `This link expires in 7 days` into `7 day(s)` — the
original already pluralised with `day${days === 1 ? '' : 's'}`. The pre-existing
`invite-email.test.ts` failed on it. Restored as two keys (`expiresOne` /
`expiresMany`) in **both** languages, since Bulgarian pluralises too (1 ден /
7 дни).

Worth noting the shape: a quality regression riding in on a translation change,
invisible in review because the diff looks like pure extraction.

## The fourth uncovered seam

The routes were not covered by anything — only the email module and the
resolver. That is the **fourth** time in this run: #715's token-exchange
budget, #723's `enqueueEmail` seam, #726's digest dispatcher, this. Every one
was found by mutating the *call site* rather than the mechanism, and every one
was green until a test existed at that layer.

`tests/guards/invite-email-locale-wiring.test.ts` closes it structurally rather
than by executing the three routes, and the trade is stated in the file: driving
them means mocking `requirePermission`, the rate limiter and
`createInviteToken` for a payload whose only interesting property is one
argument, while the risk that actually matters is a FOURTH invite route added
later without the wiring. A filesystem-derived scan catches that the moment the
file exists; mocking the current three never would.

A guard proves the call is written, never that it works. What it works is proven
next door.
