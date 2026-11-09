# 2026-11-09 — P9.1: the channel schema

**Issue:** #2935. **Phase:** P9 (#1200), started today because P8 completed and
`social.direct-messages` went ON in production (#2861) — P9's stated dependency.

Schema only. Five models, their RLS and their encryption classification; no
route, usecase, UI or flag. #2795 (P8.1) and #1553 (P5.1) are the precedents.

## Design

```
Channel  ─┬─ ChannelMembership   (one row per person per channel; ban lives here)
          └─ ChannelPost  ─┬─ ChannelPostReaction
                           ├─ ChannelPostMention
                           └─ ChannelPost (parentPostId — threads, one level)
```

Its own file, `prisma/schema/channels.prisma`, for the reason
`public-profile.prisma` is its own: `social.prisma` is already 809 lines over
sixteen models spanning flags, trust-and-safety and direct messages.

## Files

| File | Role |
|---|---|
| `prisma/schema/channels.prisma` | five models + two enums; the header carries the design |
| `prisma/migrations/20261109120000_p9_1_channels/migration.sql` | tables, indexes, FKs, **16 policies** |
| `tests/guardrails/rls-coverage.test.ts` | all five classified as party-scoped |
| `src/lib/security/encrypted-fields.ts` | `DELIBERATELY_PLAINTEXT['ChannelPost.body']` |
| `tests/integration/p9-1-channels-rls.test.ts` | 16 cases, every refusal paired with a positive |

## Decisions

- **Tenantless, and that was a PRIOR decision.** `social.prisma`'s preamble
  already commits a channel to it: *"a profile, a direct message and a channel
  do not belong to one farm."* A crop channel spans every farm growing that
  crop. The header CITES that argument rather than copying it, because two
  copies of a design decision is how they come to disagree.

- **A CHANNEL IS PUBLIC — the real departure from the DM family.**
  `conversation_select` admits participants only; `channel_select` and
  `channel_post_select` admit any authenticated caller. P9.2 cannot suggest a
  channel nobody can read, and nobody joins one they cannot look into first. So
  the gate is on POSTING, not on reading, and the test asserts the public read
  as a POSITIVE — a non-member reading a channel is the feature, not a leak.
  Consequence stated once: there is no private channel in this design, and
  adding one means a visibility column plus a second SELECT arm.

- **`channel_membership_select` admits the caller's OWN ROW ONLY, and that is
  forced rather than chosen.** A policy admitting "every member of a channel I
  am in" must ask `ChannelMembership` whether I am in it, and Postgres refuses:
  `infinite recursion detected in policy for relation`. P8.1 paid for this
  lesson — a WITH CHECK on `DirectMessage` reading `DirectMessage` refused
  *every* insert, whatever the command. **`Channel.memberCount` is denormalised
  because of it**, not as an optimisation: a member physically cannot count
  rows they cannot see.

  Posts, reactions and mentions may query `ChannelMembership` freely — a
  different table from the one being guarded, so no recursion arises.

- **`ChannelPost.body` is PLAINTEXT**, departing from both message models here
  (`DirectMessage.body` and `ExchangeMessage.body` are global-KEK encrypted,
  because a two-party row under either party's DEK is unreadable by the other —
  there is no second party to lock out of a channel). The deciding reason is
  SEARCH: P9.7 requires posts searchable, and an encrypted column cannot be
  searched without a second plaintext copy, which would become the real store
  with nothing guarding it. So the choice is not "encrypt or not" but "one
  plaintext column, or one encrypted column plus an unguarded plaintext index".

  The `DELIBERATELY_PLAINTEXT` entry is REQUIRED, not courteous: `body` is a
  field name the manifest carries for other models, and since #1222 the
  manifest is per `(model, field)`, so an unclassified model no longer resolves
  to `'*'` and the guard refuses the silence.

- **The ban keeps its membership row.** Deleting it would let the banned person
  rejoin and post again; `@@unique([channelId, userId])` means a rejoin cannot
  mint a second row to escape through. `channel_post_insert` requires
  `bannedAt IS NULL`, so the ban is enforced in SQL and not only in a usecase —
  the layer a refactor removes.

- **`channel_post_insert` carries all three of P9.10's access rules**, each
  answering one case: the author equals the session (no forged author), a
  membership row exists (no non-member), that row is unbanned (no banned
  member). Slow mode and the five-mention cap are deliberately NOT here — both
  need a comparison against other rows of the same table, which is the shape
  that recurses. P9.3 owns them.

- **Mentions are a TABLE, not a derived list.** P9.3 caps mentions at five, and
  a cap is only enforceable if mentions are a constrained thing; derived from
  body text the cap would be advisory. The table is also READ-ONLY to a
  session — no `app_user` INSERT arm — because a mention is a PUSH TRIGGER, so
  a caller able to insert one could push to any person on the platform without
  posting anything they would read.

- **Three removal columns, not one.** `removedByModerationAt` (a human
  decision, reversible by #2867's restore route), `autoHiddenAt` (P9.3's
  threshold, reversed by a different act) and `deletedAt` (the author's own
  retraction). Collapsing them would make a statement of reasons claim a
  moderator looked when none did, and would tell a reader the author retracted
  when they did not.

- **Reactions SPLIT per command**, exactly as `MessageReaction` and
  `ExchangeBlock`: a reader must be able to SEE a reaction they did not write
  without being able to DELETE it, and one USING clause would govern both.

- **`Channel.key` is UNIQUE, which makes P9.2's seed idempotent by
  construction** rather than by a `seeded` flag somebody forgets to set — the
  `NoticeScore.reportId` precedent. It also makes suggestion a JOIN: an oblast
  channel's key carries the same `BG-16` code `ExchangeListing.oblast` stores.

- **`nameBg`/`nameEn` are columns, not `messages/` keys.** A channel name is
  reference data seeded by `dist/seed.mjs`, and a seeded row cannot reach a
  `next-intl` catalogue.

## What the test proved, and what it nearly failed to

Sixteen cases, every refusal paired with the same operation by somebody
entitled to it — P8.1's rule, and it is a rule because all three of ITS
`REFUSES …` cases passed while the request rule enforced nothing.

**The instrument was wrong before the policies were.** All seven refusal cases
failed on the first run reporting `P2010`, Prisma's wrapper for a raw-query
failure, because I read `err.meta.code` for the SQLSTATE. The RLS had been
correct throughout; `p5-1-trust-safety-rls` already matched on the error
message for exactly this reason. The helper's docblock records it.

Mutation-proved against the DATABASE rather than the ORM, both restored:

| mutation on the base DB | result |
|---|---|
| drop `bannedAt IS NULL` from `channel_post_insert` | ✕ the banned-member case **only** |
| widen `channel_membership_select` to every authenticated caller | ✕ the own-row case and the outsider case |

The second is the widening somebody would reach for to render a member list,
which is why it is worth having a test that refuses it.
