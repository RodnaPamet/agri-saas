# 2026-07-30 — dark theme re-grounded in the Bulgarian tricolour

**Commits:** `087c384a` re-ground the dark theme · `34e92d95` keep gold as the
brand · `fcee9ba1` re-ground the stranded surfaces · this commit — the AA lift
and the visual verification pass.

## Design

The dark theme moved off Metro navy onto the Bulgarian tricolour. The palette
is not "three flag colours sprinkled about" — it is a **role hierarchy**, and
the single rule that generates the whole thing is **one hue, exactly one job**:

```
  green  = the GROUND      surfaces only, never a signal
  white  = the CONTENT     what you read (green-tinted, not neutral grey)
  GOLD   = the BRAND       links, primary actions, focus, nav glow
  red    = DANGER ONLY     nothing else competes for "alarm"
```

Everything else follows from that assignment:

- **The ground is a DESATURATED green, not the flag's `#00966E`.** A
  marketplace-and-records app is stared at for whole working days, and
  saturated green at full-viewport scale is exhausting. More importantly it
  would destroy every green *signal* in the product — a success badge on a
  success-coloured page says nothing. So the ground is the flag green pulled
  down in saturation and lightness until it recedes (`--bg-page #05231B`,
  `--bg-default #0A3327`, `--bg-muted #07291F`, `--bg-elevated #0E4232`), and
  the vivid green is spent only where it has to carry meaning.
- **Success is pushed BRIGHTER than stock emerald** (`--content-success
  #5FE39B`, `--bg-success-emphasis #14B866`) so a positive badge
  out-luminates the ground instead of dissolving into it.
- **Red is danger and is deliberately NOT the brand.** Gold carries identity,
  so red is free to mean one thing. It is also kept hotter and lighter than
  stock red-500 (`#F04438` / `#FF8A7A`) to separate cleanly from deep green.
- **The remaining functional tones are deliberately NON-flag hues.** The
  tricolour has claimed ground, content and danger; amber `warning` and blue
  `info`/secondary need colours the theme is not already using.
- **Surfaces that carried their own navy were re-keyed by RATIO, not by
  value.** The process canvas depth ramp (`surface < page < frame < node`)
  is defined by its luminance ratios to `--bg-page` — 0.65x / 1.6x / 2.5x /
  4.7x / 11.9x — so the recessed/elevated relationships the editor depends on
  survived the ground change intact.

Light theme (`[data-theme="light"]`) is untouched throughout.

## The AA lift

`--content-inverted` is the ink on every BRIGHT surface: the gold primary
button and the solid status chips (`--bg-*-emphasis`). Its floor is set by the
worst of those pairings, which is solid red — `EnvironmentBadge` (DEV/STAGING)
and the notification unread count both print it at **10px bold**, and 10px
bold is NORMAL text to WCAG (bold only counts as large from 18.66px), so it
owes the full 4.5:1.

At the ground's own `#05231B` that pairing measured **4.43:1**. The re-ground
had already lifted it a long way from the navy theme's 3.71:1, but not over
the line. Dropped one notch to `#041C15`, which closes it and buys headroom
everywhere else:

| ink on…                          | navy (old) | green (before lift) | shipped |
| -------------------------------- | ---------: | ------------------: | ------: |
| `--bg-error-emphasis` `#F04438`   |     3.71:1 |              4.43:1 |  **4.73:1** |
| `--bg-inverted` gold `#D4AF37`    |     8.51:1 |              7.91:1 |  **8.45:1** |
| `--bg-success-emphasis` `#14B866` |     4.75:1 |              6.40:1 |  **6.83:1** |
| `--bg-warning-emphasis` `#D97706` |     5.62:1 |              5.22:1 |  **5.58:1** |

It is still the deepest forest — it sits between `--canvas-surface` (`#041B14`)
and `--bg-page` (`#05231B`), so it reads as the same ink, only denser. No hue
role moved.

Every other pairing was measured against both grounds and clears AA:

| pairing | on `--bg-default` | on `--bg-page` |
| --- | ---: | ---: |
| `content-emphasis` | 13.85:1 | 16.63:1 |
| `content-default` | 11.25:1 | 13.50:1 |
| `content-muted` | 7.64:1 | 9.17:1 |
| `content-subtle` | 5.81:1 | 6.97:1 |
| gold as link/accent | 6.59:1 | 7.91:1 |
| blue-400 secondary | 5.45:1 | 6.54:1 |
| success badge (tint over surface) | 5.83:1 | 7.02:1 |
| warning badge | 6.48:1 | 7.74:1 |
| error badge | 5.20:1 | 6.13:1 |
| info badge | 4.54:1 | 5.41:1 |
| white on the destructive glass fill | 4.52:1 | 4.59:1 |

The secondary brand was lifted blue-500 → **blue-400 `#60A5FA`** in `087c384a`
for exactly this reason: blue-500 measured 3.70:1 on the new `--bg-default`,
under AA; blue-400 restores it to 5.45:1.

## Files

| File | Role |
| --- | --- |
| `src/styles/tokens.css` | The whole palette. `:root` re-grounded; `--content-inverted` lifted to `#041C15` with the pairing table inline. Light block untouched. |
| `src/app/globals.css` | `--grad-page` painted on `body`; `.metric-gradient` gold number fill. |
| `tests/guardrails/raw-color-ratchet.test.ts` | Baseline tightened 95 → 14 (see below). |
| `docs/implementation-notes/2026-07-30-…` | This note. |

## Decisions

- **Gold was left exactly as it was, on instruction.** `--brand-*`,
  `--bg-inverted`, `--primary`, `--ring`, the `--grad-gold` metric numbers,
  `--btn-aura-primary`, the iridescent edge, the nav band glow,
  `--nav-row-liquid-tint` and all eight `rgba(255, 205, 17, …)` sites are
  byte-identical to the navy theme. The one gold-adjacent value that moved is
  the *ink on top of it*, and it moved in the direction that raises contrast.

- **The ratchet was tightened 95 → 14, not merely held.** The navy→green sweep
  removed the last route-level components painting raw slate/navy, and the 95
  had carried ~81 of stale slack since April. A ratchet with that much give is
  not a ratchet. 14 is the exact current count and all 14 sit in the one file
  the cheatsheet says should keep raw colours — `audit/shared/[token]/page.tsx`,
  the public audit-pack viewer, which renders with no `ThemeProvider` in scope.

- **Border tones were NOT raised to meet 3:1.** `--border-default` sits at
  1.59:1 against `--bg-default` and `--border-subtle` at 1.28:1. WCAG 1.4.11
  governs the *essential* boundaries of UI components and state indicators, not
  decorative separators — a card is identified by its fill, and its edge is
  finishing, not information. Both are already *better* than the navy theme
  (1.36:1 / 1.16:1), and raising them would contradict the border-tone
  discipline in CLAUDE.md and blow the budget ratchet at
  `tests/guards/border-tone-budget.test.ts`. Left deliberately.

- **`canvas-node` vs `canvas-surface` at 1.90:1 is by design.** Node/plane
  separation is carried by the `--canvas-border` hairline and `--canvas-shadow`
  lift, not by fill contrast; the ratio is an intentional re-expression of the
  navy ladder's own 1.62:1, and it improved.

- **The primary button's blue tail was left alone and is flagged, not fixed.**
  `--btn-gradient-primary` ramps `--brand-default → #6ea6ea`, so the right half
  of every primary button fades to blue. It is **pre-existing** (byte-identical
  before the re-ground), it is contrast-safe (the label reads 6.58:1 on the blue
  end), and it is deliberately governed by `tests/guards/ui-create-gradient.test.ts`,
  which was written to *want* a cool tail. On the navy ground that tail read as
  the brand dissolving into the page; on green it reads as a foreign hue on the
  one surface that is supposed to be pure brand, and it puts `info` blue on the
  primary action — a direct tension with one-hue-one-job. Changing it is a
  one-line edit that keeps that guard green, but it re-colours the brand button,
  which was explicitly locked. Raised for a decision rather than taken.
