# 2026-11-10 — `translateFor` stops being silent

**Issue:** #2958. **Owner ruling (2026-11-10):** log both, deduped per key —
chosen over adding a derived guard as well, and over throwing in dev.

## What was silent

```ts
export async function translateFor(locale, key, params) {
    for (const candidate of locale === DEFAULT_LOCALE ? [locale] : [locale, DEFAULT_LOCALE]) {
        const messages = await loadMessages(candidate);
        const found = messages ? lookup(messages, key) : undefined;
        if (found !== undefined) return interpolate(found, params);
    }
    return key;                      // no throw, no log, no metric
}
```

Two different failures came out of that looking like success:

1. **a `bg` miss falls back to `en`** — a Bulgarian recipient gets an English
   legal notice or email, and the output looks like a successful translation;
2. **a miss in BOTH returns the key** — the recipient gets
   `statementOfReasons.action.CONTENT_AUTO_HIDDEN` where a sentence belongs.

Outcome 2 shipped in P9.3d and was found by hand, not by a test.

## Why the existing gates could not see it

- **Key parity** compares the two catalogues to EACH OTHER. A key missing from
  both is perfectly balanced.
- **The untranslated-copy check** needs a value to compare; there is none.
- **A per-site assertion** covers the site somebody remembered.
  `moderation-action-kinds-mirror` asserted the copy for ONE hardcoded kind.
- **The counts matched.** Six `ModerationActionKind` values, six catalogue
  keys — one of them `CONTENT_DEMOTED`, deleted from the enum by #2868, while
  the new kind was absent. A count check passes that exactly.

## What landed

`i18n.locale_fallback` at **warn** when the requested locale missed and the
default served; `i18n.key_missing` at **error** when the key itself comes back.

- **No behaviour change.** A missing string still renders exactly as before.
  What is new is that it stops being silent.
- **One change covers ~92 dynamic-key call sites** and every future one, with
  no population to maintain — which is why it was chosen over the derived
  guard, whose population cannot be inferred from the key string (`${key}`
  says nothing about what `key` ranges over, so it would be a hand-maintained
  list of six sites, five of them measured covered already).
- **Deduped per `(locale, key)` per process.** A hot path with one missing
  string would otherwise log on every render. The Set is deliberately
  UNBOUNDED: its population is the set of broken keys, which ought to be zero,
  and a cap would stop reporting exactly when a release broke many at once.
- **The KEY is logged, never the resolved string.** A translated value can
  carry interpolated personal data — a name, an address — and a log is a
  different retention domain from the row. A key is a catalogue constant.
- **`reportOnce` never throws.** The fallback chain exists so a missing string
  cannot throw inside a fail-open notification path; telemetry about the
  failure must not reintroduce the throw. That is the audit extension's rule.

## A safety claim corrected

`digest-templates.ts` stated: *"The enum MEMBER is the key, so a new member
fails at the lookup rather than silently rendering its raw identifier."*

It does not fail — `return key` is the mechanism. A new `DueItemUrgency` would
render `notificationEmail.digest.urgency.<NEW>` into a digest email. Measured
when this landed, both unions were fully covered (`DueItemUrgency` 3/3,
`MonitoredEntityType` 2/2), so nothing there was broken; the ARGUMENT was.

## Mutation proofs

Six, each killing exactly the intended assertion:

| mutation | assertion that went red |
|---|---|
| drop the fallback warn | a key present only in `en` logs a WARN |
| drop the key-missing error | a key present in NEITHER logs an ERROR |
| dedupe on locale alone | a DIFFERENT key is reported even after one has been |
| no dedupe at all | DEDUPES per (locale, key) |
| log the resolved value | NEVER logs the resolved string |
| remove the try/catch | a throwing logger does not break the translation |

**One of my own assertions was vacuous and the fix is the lesson.** "NEVER logs
the resolved string" first read
`expect(...).not.toContain('Такава публикация не съществува.')` — a string that
key never returns, because I had misquoted my own catalogue entry
(`CHANNEL_NOT_FOUND` is «Такъв канал не съществува.»; the other is
`CHANNEL_POST_NOT_FOUND`). The negation passed over nothing and would have
passed with the value logged. It now reads the value back from the call and
asserts the absence of THAT, plus the presence of the key — because a report
naming no key would satisfy the absence too.
