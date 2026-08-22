# 2026-08-22 — digests speak the recipient's language (#694 step 3)

**Commit:** `see git log` fix(notifications): render digests in the recipient's language

## The finding that shaped the design

`DueItem.reason` was rendered English prose, built in the monitor jobs:

```ts
reason: `Task overdue by ${n} day(s)`                  // deadline-monitor:129
reason = `Evidence retention expired ${n} day(s) ago`  // evidence-expiry-monitor:167
```

Localising only the digest *frame* would have produced a half-Bulgarian email —
headers and greeting translated, every row's detail still English.

And the problem is not really translation. **A monitor produces each item once,
and the dispatcher routes that same item to several recipients whose
`uiLanguage` differs.** The language is not knowable where the string is built.
So `reason` became a descriptor — `{ key, params }` — resolved per recipient at
render time. That is the correct shape independently of i18n.

Bounded, and I checked the thing that would have made it expensive:

| | |
|---|---|
| producers | 5 sites across 2 monitor jobs |
| consumers | **1** — the digest (`digest-templates.ts:71`, `:89`) |
| persistence | **none** — `Monitor → DueItem[] → Dispatcher → outbox`; only the rendered email is stored |

No migration, nothing to convert.

## What else became locale-dependent

`URGENCY_LABEL` and `ENTITY_LABEL` were module-level English maps; a constant
cannot know who is reading, so both are catalogue lookups keyed by the enum
member. Table headers, the summary line, and both digest bodies followed.

## Decisions

- **Emoji stay in code.** `URGENCY_EMOJI` and the summary's 🔴🟡🟢 are
  concatenated onto translated text — `no-decorative-emoji-in-messages` bans
  them in `messages/*.json` and sanctions them in these modules.

- **The English subject lost "Compliance".** `Compliance Deadline Digest` →
  `Deadline digest`. This is an agri product after the GRC teardown, and a
  Bulgarian farm operator's digest should not be named after a framework the
  product no longer has. A copy change alongside a localisation, so it is called
  out rather than slipped in.

- **The escaping guard caught the refactor, correctly.** Hoisting
  `buildDigestTable(...)` to a local `const table` when it became async changed
  a declared-safe expression into an undeclared one, and the guard flagged
  `${table}`. Added to `SAFE_BY_CONSTRUCTION` with the reason — the value did
  not change, but the decision had to be re-made rather than inherited.

## Two weak assertions of mine, both found by mutation

Worth recording because neither was visible by reading.

1. **The dispatcher seam was uncovered.** Replacing `recipient.locale` with a
   hardcoded `'en'` left **all 34 tests green** — the builders were tested, the
   call site was not. `digest-dispatch-locale.test.ts` closes it against the
   OUTBOX ROW, which is the artifact that survives.

   Third time this session for that exact shape: #715's token-exchange budget,
   #723's `enqueueEmail` seam, and this. A test per layer is not redundancy.

2. **`toContain('🔴')` was satisfied by the wrong thing.** Every item row emits
   an urgency emoji, so the assertion passed with the summary's emoji stripped
   entirely. Tightened to `` `🔴 ${overdueText}` `` — the emoji attached to the
   summary entry, not merely present somewhere in the body.
