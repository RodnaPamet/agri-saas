# 2026-10-12 — a moderator's reason was accepted and discarded

**Issue:** #1667 (ruling 1, first stage). Part of #1600.

## The finding

`POST /api/admin/moderation/suspensions` took an optional `reason`, and threw
the text away. What reached `PlatformAuditLog` was:

```ts
detailsJson: {
    // The reason is NOT recorded here, only whether there was
    // one. It is moderator free text and `detailsJson` is not
    // an encrypted column; the rationale belongs on
    // `ModerationAction.rationale`, which is.
    hasReason: Boolean(input.reason),
}
```

Every clause of that comment is true, and it describes a row **this path never
created**. `actOnNotice` always has a `ModerationAction` — there is a notice to
act on — but a PROACTIVE suspension had no record of why it happened at all. A
moderator typed a justification for withholding a farm from a person and
nothing kept it.

Found while measuring the owner's ruling that a suspension must queue an Art 17
statement: `queueStatement` requires an `actionId`, so the chain could not even
begin here.

## What changed

- `ReportSubjectKind` gains **`ACCOUNT`** — a proactive suspension's subject is
  a PERSON, and the other four values are all content.
- `suspendAccount` creates a proactive `ModerationAction` (`reportId: null`)
  carrying `sanitizePlainText(reason)` as its `rationale`, in the same
  transaction as the suspension.
- `reason` becomes **required**, in the route's zod AND in the published schema.
- `moderatorRefFor` moves to `@/lib/auth/platform-admin`.

The schema anticipated all of it: `reportId` is nullable *"because a PROACTIVE
action has no notice behind it"*.

## Decisions

- **`ACCOUNT` is NOT reportable, and that is now checked.**
  `REPORT_SUBJECT_KINDS` — the zod list `FileReportSchema` validates against —
  carried a comment saying it *"Mirrors the `ReportSubjectKind` enum"* with
  **nothing comparing them**. The relationship is not equality and never was;
  it is a strict subset, and the difference is the values that exist for
  ACTIONS only. `tests/guards/report-subject-kinds-mirror.test.ts` holds that,
  with each difference justified by what naming it in a notice would let an
  unauthenticated caller do — `/api/public/notices` needs no credential, so the
  reportable set is the one place widening is an escalation rather than a
  convenience. Proved both ways: adding `ACCOUNT` to the zod list fails, and a
  new enum value classified nowhere fails.

- **The action is written only when the suspension APPLIED and was not already
  in force.** An action for a nonexistent user is a decision about nobody, and
  the idempotent repeat returns `applied: true` with `alreadySuspended` — one
  decision must not mint two rows. Mutation-proved: widening the condition to
  `result.applied` alone fails.

- **`moderatorRefFor` had to move, and the reason is a cycle.** Two usecases
  need it now, and `moderation.ts` already imports `suspendAccountOnTx` from
  `account-suspension.ts`, so importing it back would make the two modules
  mutually dependent. It lives beside `PlatformKeyGeneration`, the type it
  takes, and `moderation.ts` re-exports it so existing importers and
  `p5-4a-moderation-console.test.ts` are untouched.

- **The route's validation and its published schema were SEPARATE zod
  objects**, and narrowing one left the other documenting the old contract.
  `SuspendBody` is local to the route; `SuspendAccount` is declared in
  `moderation.paths.ts`. Both are narrowed here, and it is worth knowing the
  divergence is possible: the breaking-change gate reads the SPEC, so a code
  change alone would have tightened the route while the gate saw nothing.

- **The breaking change is acknowledged, not worked around.** Making a request
  property required is `property-now-required`, and the gate fires on it — once
  given a real base; locally it passed until `RATCHET_BASE_SHA` was supplied,
  which is the shape `ratchet-base.ts` warns about in its own docblock. The
  entry records that the caller population is ONE (a platform admin holding the
  API key, i.e. the owner — no third-party integration, and agrent-ios does not
  call admin routes) and that requiring it IS the owner's ruling rather than a
  side effect of it. The alternative — keeping it optional and writing an empty
  rationale — would put an unexplained decision in a legal record.

- **A test comment became a test.** `account-suspension-wiring.test.ts`
  asserted the reason does not reach `detailsJson`, with a comment saying it
  "belongs on `ModerationAction.rationale`, which is [encrypted]". That half
  was aspirational. It is now asserted.

## Not in this change

Queueing the statement itself, and the console view for suspensions that have
none. Both need this action row to exist first; they are the second stage of
#1667's ruling 1.
