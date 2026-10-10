# P5.3 — «Сигнализирай» and «Блокирай» (#1594)

One dialog, three triggers, one block control. The design content is almost
entirely about keeping two similar-looking controls from reading alike.

## Two block controls, opposite disclosure rules, one header

| | exchange block | person block (new) |
|---|---|---|
| label | «Блокирай купувача» | «Блокирай потребителя» |
| who may press it | the seller only | either person |
| the other party | **is told** — «Този продавач не приема съобщения от Вас.» | told **nothing**; the conversation disappears from their side |
| flag | none | `social.person-blocks` |

Both are correct and the owner confirmed both: the exchange refusal is
commercial and a buyer is entitled to understand it, a social block must reveal
nothing. The likeliest regression in this phase is somebody making them
consistent, so `tests/rendered/trust-safety-controls.test.tsx` asserts the
person control does **not** render `exchange.messaging.blockParty` — different
namespaces, not merely different strings.

`blockPerson.notTold` tells the blocker that the other party is not informed.
Addressed to the blocker because they are the only person who can read it: the
silence runs towards the person blocked, not towards the one doing it, and
"nothing visibly happened" is the worst version of a silent control.

## The duty is unflagged and the feature is gated

`ReportButton` takes no `enabled` prop. That is the design, not an omission: a
flag defaulting OFF means an Art 16 obligation is unmet until somebody
remembers to flip it. The rendered test asserts the control is present with no
flag at all, so adding a gate later fails there.

`BlockPersonButton` renders `null` when its flag is off — not a disabled
button. A disabled control advertises a feature that does not exist, which is
the opposite of a dark launch. The flag is resolved in the server page and
passed down, because there is no client-side flags hook and inventing one would
be a second source of truth for a kill switch. The route gates again
independently: a client that kept the button gets a 404.

## Literal paths, and why the helper beside them is wrong

Every other call in the exchange client builds `/api/t/{tenantSlug}/…` via
`useTenantApiUrl()`. Reaching for it here is the natural mistake and would fail
silently: `content_report_reporter_read` and `UserBlock`'s policies key on
`app.user_id`, which only `runInUserContext` sets, so a tenant-scoped route
would read zero rows and return no error.

`DELETE /api/social/blocks` carries the id in the **body**, which `apiDelete`
takes through its `RequestInit`. A path parameter would put a third party's
user id in a URL, and iOS logs the full URL unsuppressably.

## The counterparty is derived from the messages, which is a feature

The thread payload names people only on message rows (`senderUserId`, already
in the published contract — the client's local type simply had not declared
it). So the person to block is the sender of the first message that is not
`mine`, and until they have written there is nobody to name and the control
does not appear.

That is not a workaround. It is `blockExchangeParty`'s own standing rule —
"Addressed by THREAD rather than by tenant id … so the caller provably has
standing: you can only block someone who has already written to you."

## Where «Сигнализирай» is NOT offered

- **Your own messages.** `remove` is the control for those, and offering both
  on one row would read as a choice between them.
- **A deleted message.** There is nothing left to capture, and the snapshot
  would store an empty body indistinguishable from a capture failure — which
  P5.2a took trouble to keep distinct (`SUBJECT_NOT_FOUND` vs
  `SUBJECT_KIND_NOT_CAPTURABLE`).
- **Beside a person-block control on a listing.** A listing names a farm; the
  person to block is only identifiable once someone has written.

## Three guards shaped the result

- **`epic55-native-select-ratchet`** caps native `<select>`, so the reason list
  is a `Combobox`. `MISLEADING_LISTING`'s hint lives inside the option label
  rather than as help text, because it is the agricultural case — a false
  grade, quantity, origin or certification — that a generic list would miss and
  the bare label does not convey.
- **`primary-action-budget`** capped this file at one primary button and found
  two: the submit and the post-success dismiss. They never render together, but
  a reader cannot tell mutually exclusive primaries from duplicated ones, and
  nor can the guard. Collapsing them into one button whose label and action
  depend on state is less code than raising the budget and spends no ratchet.
- **`rendered-coverage-floor`** is an upward ratchet — the inverse of every cap
  in this repo. Adding a rendered test obliges the PR to raise the floor
  (248 → 249) so the verification is locked in as the new minimum. It measures
  against the PR's own base rather than main's tip, so a peer merging cannot
  make it fire.

## The test resolves translations to their KEY

`useTranslations` is mocked to return `${namespace}.${key}`, so assertions name
keys rather than strings a copy edit would break. The real Bulgarian and
English live in `messages/*.json` and are checked by the i18n guards; this file
checks structure and behaviour.

Two harness details cost a run each and are worth recording: the `Modal`
primitive calls `useRouter()`, so `next/navigation` must be mocked or every
render throws "invariant expected app router to be mounted" — which reads as a
component fault. And `Combobox` options only mount when its popover opens, so
asserting an option's text needs the click first rather than a looser matcher.
