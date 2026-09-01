# 2026-09-01 — self-hosting the web fonts (#779)

**Commit:** `<sha>` feat(fonts): self-host the web fonts instead of fetching them from Google

## Design

`src/app/globals.css` fetched three families from `fonts.googleapis.com` on
every page load of every request. They are now vendored under `public/fonts/`
and declared by a generated `src/styles/fonts.css`.

```
scripts/fonts/vendor-fonts.mjs   author-time, network, --write-lock to write
        │  fetches the css2 stylesheet with a Chrome UA (→ woff2, not ttf)
        │  downloads each face, hashes it
        ▼
public/fonts/*.woff2  +  src/styles/fonts.lock.json  +  src/styles/fonts.css
        │                          │                          │
        │                   sha256 + bytes            @font-face, verbatim
        │                   per face                  unicode-range
        ▼
tests/unit/fonts/vendored-font-integrity.test.ts   OFFLINE, per-face
```

The lock is the record of what was measured. Default mode **verifies**;
`--write-lock` **writes**. Without that split, re-vendoring would regenerate
the files *and* their hashes together, so a silently changed font program would
produce a green diff.

### It is not only CI hygiene

`public/sw.js:296` passes every cross-origin request through untouched. The
Google-hosted files were therefore **never cacheable by the service worker** —
an operator with no signal fell back to system-ui for every string, on a
product whose whole cold-start section is about rural LTE. Same-origin files
can be cached.

### It retired an ordering hazard rather than working around it

A remote `@import` cannot be inlined, so it stays an `@import` RULE and must
precede all others. That forced the Google import to be the FIRST statement in
`globals.css`, and on 2026-05-21 it drifted below `@import "tailwindcss"` and
500'd every page. A **relative** import is inlined like `tokens.css`, so the
constraint no longer exists.

## Files

| file | role |
|---|---|
| `scripts/fonts/vendor-fonts.mjs` | **new** — author-time vendoring, verify/write split |
| `src/styles/fonts.lock.json` | **new** — 72 faces, sha256 + bytes + `unicode-range` |
| `src/styles/fonts.css` | **new, generated** — the `@font-face` block |
| `public/fonts/*.woff2` | **new** — 72 files, 1.86 MB |
| `src/app/globals.css` | remote `@import` → relative; ordering comment retired |
| `src/lib/security/csp.ts` | both Google origins dropped from `style-src` / `font-src` |
| `next.config.js` | year-long `immutable` caching for `/fonts/*` |
| `tests/unit/fonts/vendored-font-integrity.test.ts` | **new** — offline integrity + descriptor parity |
| `tests/guards/globals-css-import-order.test.ts` | **inverted** — see Decisions |
| `tests/e2e/fonts-self-hosted.spec.ts` | **new** — the positive detector |
| `tests/e2e/map-basemap-hermetic.spec.ts` | allowlist emptied |
| `docs/security-hardening.md` | CSP block corrected (twice — see Decisions) |

## Decisions

- **Vendor the whole weight set, including unused weights.** Measured: the
  requested weight SET decides which file Google serves — Onest `wght@500;600;700`
  returns a 33760 B variable font, `wght@600` alone returns a 15412 B static
  instance. Trimming would swap the font *program*, not just drop bytes, and
  invalidate the metric argument. Inter is stable across `300..800` and
  `300..700`. Trimming is its own change with its own measurement.
- **Keep all 72 subset files (1.86 MB), don't trim to en+bg.** Trimming to
  latin/latin-ext/cyrillic/cyrillic-ext saves 427 KB — 22% of a number that
  does not matter, because `unicode-range` means a reader downloads only the
  subsets their text needs. It would add a judgement call that can drop a glyph
  someone actually uses, for no runtime benefit.
- **Invert the import-order guard rather than delete it.** With no remote
  imports left, its old assertion ("every remote import precedes tailwindcss")
  filters an empty list and passes trivially, forever. The invariant is now
  "there are NO remote imports", which is falsifiable — mutation-proved: adding
  one back turns it red. The ordering rule is kept beside it, dormant and
  executable, for the day a remote import is genuinely needed.
- **The detector is a positive check, because absence is not evidence.**
  Emptying `ALLOWED_EXTERNAL` proves the fonts are not fetched from Google. It
  proves nothing about whether they are fetched from us — the same assertion
  passes over a page where every face 404s. `fonts-self-hosted.spec.ts` is the
  positive half.
- **Three measured facts shaped every assertion in that detector**, and each
  invalidated an obvious alternative:
    1. `document.fonts.load()` **rejects** on a 404 rather than resolving with
       `status: 'error'`, so a `.status` loop is dead code and a `catch {}`
       swallows the only signal.
    2. `document.fonts.load(spec, text)` matches only faces whose
       `unicode-range` covers `text` — a direct per-subset probe, which is what
       catches "the latin file shipped but the cyrillic one did not".
    3. A missing family falls back to the browser **default (serif)**, not
       `sans-serif`, so `expect(width).not.toBeCloseTo(sansSerifWidth)` passes
       on a broken font. The check compares the app's own stack against that
       stack minus its first family.
- **Probes are single-script and space-free, because U+0020 is a bystander.**
  With a mixed probe (`"Обработка на нивата"`), dropping Inter's Cyrillic face
  still measured 169.5 vs 167.81 — a false pass, because the space lives in the
  LATIN `unicode-range` and kept rendering from the surviving Latin face.
- **`docs/security-hardening.md` carried a second, older error.** It claimed
  "No `unsafe-inline` in production for either scripts or styles". `style-src`
  has carried `'unsafe-inline'` all along — a nonce cannot match a `style=`
  attribute and the app emits many SSR inline styles. Corrected in the same
  diff, with what actually holds the line named (`csp-style-guardrails`).
