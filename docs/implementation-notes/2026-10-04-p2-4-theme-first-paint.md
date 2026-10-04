# P2.4 — the theme reaches the first paint

*2026-10-04 · PR #1304 · roadmap #1193*

## What was wrong

`layout.tsx` hard-coded `data-theme="dark"` into the SSR markup and
`ThemeProvider` corrected it from `localStorage` inside a `useEffect`.

An effect runs **after** the first paint. So every `light` or `sunlight` user
watched the dark palette render and then flip — not a race that sometimes
loses, a guaranteed flash on every shell render. And it was unfixable from the
client: the server cannot read `localStorage`, so no amount of care in
`ThemeProvider` could make the *first* frame correct.

## The shape of the fix

Two halves, neither sufficient alone:

| half | covers | mechanism |
|---|---|---|
| cookie `agrent_theme` | every visit after the first | the server reads it and seeds `data-theme` / `data-contrast` into the markup |
| inline `<head>` script | the first visit | only the browser knows `prefers-color-scheme`; it resolves, applies, and writes the cookie so the next request is server-correct |

`sunlight` resolves to `data-theme="light"` **plus** `data-contrast="high"`.
There is no `[data-theme="sunlight"]` block in `tokens.css` — emitting the raw
name would select no palette at all and silently render dark. `attributesFor()`
is the single place that mapping lives, and
`tests/unit/theme-cookie.test.ts` asserts it never returns `sunlight` as a
`data-theme` value.

### Script placement

The pre-paint script sits in `<head>` **after** the webpack-nonce bridge.
`tests/guards/csp-webpack-nonce-bridge-hydration.test.ts` locates that bridge by
slicing between two literal markers in `layout.tsx`, and the file already
records a case where a *comment quoting those markers* moved the window. The
comments added here describe the markers rather than reproducing them.

## What the E2E found that review did not

The new spec throttles the CPU 4× and records every attribute write against the
`first-contentful-paint` entry. On the path that was supposed to be *already
correct* — cookie present, server seeded from it — it caught two redundant
writes:

```
data-theme -> light   readyState=loading    t=1525    (pre-paint script)
data-theme -> light   readyState=complete   t=8099    (hydration effect)
                                            FCP=3728
```

`setAttribute` invalidates style and queues a mutation record **even when the
new value equals the old one**. Both writes were invisible only because the
value happened to match — and the second one lands after the first paint, which
is exactly the shape of the defect this work removes. Had the hydration effect
ever computed a different answer, that is a flash.

The fix is a compare-before-write guard placed in `applyTheme`, the one function
every theme change goes through, rather than at the two call sites — so
re-picking the theme you already have is also a no-op. The pre-paint script does
the same.

**Transferable:** an assertion that the correct value *ends up* applied cannot
see this. Only recording the writes themselves can. Where the defect is "it
flickers", the observable is the sequence of mutations, not the final state.

## Proving "before the paint" without a clock

The obvious instrument is to timestamp each write and compare to FCP. It is the
wrong one twice over: `MutationObserver` callbacks are microtask-queued, so the
timestamp is when the *callback* ran; and FCP is a quantised reported value. The
central assertion would be a comparison of two fuzzy numbers.

`document.readyState` is exact and needs no clock. A write observed while the
state is still `'loading'` happened during head parsing — before `<body>`
exists, therefore before anything could be painted. That is a structural
argument, so it is the primary assertion; the FCP comparison is kept alongside
as corroboration, and a `'loading'` write timestamped *after* FCP would mean one
of the two instruments is lying and the whole result should be distrusted.

One more property makes the two halves separable with no timing at all: an
attribute present in the HTML **source** produces no `attributes` mutation
record — it arrives inside the `childList` record that adds `<html>`. Only a
script-driven change produces an `attributes` record. So "the server got it
right" and "a script corrected it" differ by record *type*.

## The guard that was blind to the thing it guarded

`no-legacy-brand` has a `BINARY_EXT` set that skips `.png` — reasonable, since
byte-grepping compressed pixel data is meaningless. It asserted the three app
icons **exist**.

All three still carried the `#0b1220` PwC navy. The guard passed 5/5 for the
whole of the rebrand while shipping the old brand to every installed home
screen. **Existence was never the property worth guarding**, and the exclusion
that made the text scan sane also made it structurally incapable of noticing.

The icons are regenerated from the corrected `icon.svg` (Chromium is the
rasteriser; the PNGs were verified by eye to be the same artwork before and
after, with ground `#0b1220` → `#05231b`, transparent corners and dimensions
preserved). The guard now decodes a pixel with a minimal 8-bit RGBA PNG reader
that **refuses** any other format rather than mis-decoding it.

Two details worth copying:

- it asserts **equality to the new colour**, not inequality to the old. A
  decoder bug returning zeroes satisfies "not navy" trivially; only the positive
  form validates the measurement at the same time as the asset.
- a separate case asserts the gold mark is present, because a solid `#05231B`
  rectangle would otherwise satisfy everything above.

Mutation-proved both ways: a navy re-render reddens the ground assertion, a
mark-less one reddens the gold assertion, and neither touches the other.

## Also

The toggle's label was a hardcoded English template (`"dark theme — switch to
light"`) used as both the tooltip and the `aria-label`, so a screen reader in
Bulgarian announced English. Now a `theme` namespace: «Тъмна», «Светла»,
«Слънце» (ADR 0002 OD8).

## Known gap, not fixed here

`public/sw.js`'s offline page is hardcoded English. This change only moves its
colours; it is not covered by the `no-hardcoded-ui-strings` ratchet, which does
not scan `public/`.
