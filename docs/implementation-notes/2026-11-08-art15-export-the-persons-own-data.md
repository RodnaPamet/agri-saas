# 2026-11-08 — the Art 15 export carries the person's own data (#2863)

**Commit:** `<pending>` fix(privacy): export the person's own data, not the ids

## Design

#2840's derived guard measured the export at **107 of 176 columns**, with 39
left over whose honest reason was "nobody has decided". This is that decision
(owner ruling 2026-11-08): **the person's OWN data, not ids.**

```
  BEFORE   107 selected · 30 exempt by rule · 39 UNREVIEWED
  AFTER    138 selected · 30 exempt by rule · 10 OMITTED BY DECISION
```

The line it draws: a column is exported when it is a fact about the person or
about something they made, and withheld when it is an **identifier for an
entity other people belong to**, or another party's data. That is the same
boundary P5.6a drew for farm records — *"a farmer's own compliance diary is not
theirs to take away from the farm"* — applied to the ids that point into that
scope.

## What the person now gets

| model | columns | why they are theirs |
|---|---|---|
| `ExchangeListing` | `quantityTonnes`, `pricePerTonne`, `priceCurrency`, `regionCode`, `regionName`, `lat`, `lon`, `sellerDisplayName`, `publishAsFarm`, `sellerContact`, `suppressedForDeletionAt`, `expiresAt` | the offer they made. The starkest gap the guard found: a listing exported with its commodity and description and **no price, quantity or region** is not the listing. |
| `User` | `image`, `acceptedTermsVersion`, `bottomTabOrder`, `newsTagPreferences`, `isPrivateRelay`, `deletionRequestedAt`, `deletionRequestedBy`, `terminatedAt`, `pseudonymisedAt` | their avatar, the preferences they set, and the state of their own erasure request |
| `ExchangeInquiry` | `inquirerContact`, `contactSharedAt` | the contact details they chose to share, and when |
| `ExchangeThread` | `lastMessageAt`, `inquirerLastReadAt` | their own read cursor |
| `ExchangeMessage` | `deletedAt` | whether they withdrew it themselves |
| `AssistantMemoryFact` | `supersededAt` | when a point we held about them stopped applying |
| `ContentReport` | `alertedAt` | already reporter-visible through RLS |
| `PromotionLead` | `deletedAt` | whether their own lead was withdrawn |

## Decisions

- **`deletionRequestedBy` is exported, and it is not a person.** It is an actor
  CLASS (`SELF` / `MODERATION`), and whether they or a moderator started the
  erasure is exactly what the Art 17 statement tells them for a termination.

- **`ContentReport.alertedAt` is the consistency argument, not a new
  disclosure.** The reporter-read arm is ROW-level, so every column of their
  own row is already theirs to read; withholding it from the export while the
  policy admits it was the inconsistent half. It says a human was told, which
  Art 16 entitles a notifier to know — and P5.8 is explicit that it is NOT the
  triage clock.

- **`ExchangeThread.sellerLastReadAt` stays out while its sibling goes in.**
  Those rows are selected `where: { inquirerUserId: userId }`, so this column
  is the COUNTERPARTY's. P8.5 draws exactly this line for the same column
  family — "the CALLER's own read cursor, never the counterparty's" — and when
  somebody else read your message is their information rather than yours. §4b
  asserts both directions, because a ruling that only ever widens is not a
  line.

- **Nine ids stay out, each with a written reason.** Four `*TenantId` columns
  name a FARM — an entity with other members — and three parcel/location ids
  are farm records, which P5.6a puts out of scope deliberately. `PersonProfile.id`
  is a surrogate key with no meaning outside the database.
  `DirectMessage.attachmentKey` keeps the reason #2840 gave it: a locator that
  authorises nothing, since the egress route gates on RLS participation.

- **`UNREVIEWED_BASELINE` is gone, replaced by `OMITTED_BY_DECISION`.** The
  unreviewed bucket existed because nobody had decided; with the ruling there
  is nothing left in it, so §1 now asserts the omitted count is **equal** to
  the map rather than `<=` it — slack there would let the next unreviewed
  column hide under a decision somebody else made. Each entry needs a reason
  over 100 characters, which is what caught three entries that said only "same
  reason" and now say what they defer to and why.

- **A runtime half, because the guard is a SOURCE guard.** It proves a column
  reaches a `select`; only running the function proves it reaches the person.
  `p5-6a-export` seeds a listing with real figures and asserts eleven columns
  arrive, plus the account facts — and still asserts no credential ever does,
  because that rule is older than this change and has to survive it.

- **`bottomTabOrder` is a JSON column.** The fixture's raw UPDATE needs
  `$3::jsonb`; without the cast Postgres answers 22P02 rather than coercing,
  which is a nicer failure than a silently stringified preference.
