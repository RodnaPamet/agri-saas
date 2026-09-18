/** @type {import('tailwindcss').Config} */
module.exports = {
    content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
    theme: {
        // B7 — large-monitor responsiveness. Tailwind's default
        // breakpoints stop at `2xl` (1536px); a 4K screen has no
        // dedicated step. The new `3xl` (1792px) unblocks the
        // page-content width on QHD/4K monitors per the AppShell
        // shell — pre-B7 the page sat at 1280px max with vast
        // empty margins on the wider hardware.
        screens: {
            sm: '640px',
            md: '768px',
            lg: '1024px',
            xl: '1280px',
            '2xl': '1536px',
            '3xl': '1792px',
        },
        extend: {
            fontFamily: {
                // Display face — Bricolage Grotesque — for the big dashboard
                // NUMBERS (`font-display`). Latin digits only — Bricolage has no
                // Cyrillic, so it never lands on text. Body stays Inter.
                display: ['Bricolage Grotesque', 'Inter', 'system-ui', 'sans-serif'],
                // Heading face — Onest (`font-heading`) — for page + section
                // headings; carries full Cyrillic for the Bulgarian UI. Both are
                // SELF-HOSTED since #779 — vendored into `public/fonts/` and
                // declared by the generated `src/styles/fonts.css`, which
                // `globals.css` imports by RELATIVE path. The Google-Fonts
                // `@import` this used to name is gone, and with it the ordering
                // hazard that 500'd every page when it drifted below the
                // Tailwind import. Inter's Latin cut (and Cyrillic on `bg`) is
                // additionally `<link rel=preload>`ed from the root layout,
                // derived from `fonts.lock.json` (#796).
                heading: ['Onest', 'Inter', 'system-ui', 'sans-serif'],
            },
            colors: {
                // ── Existing brand palette (unchanged) ──
                brand: {
                    50: '#eef2ff',
                    100: '#e0e7ff',
                    200: '#c7d2fe',
                    300: '#a5b4fc',
                    400: '#818cf8',
                    500: '#6366f1',
                    600: '#4f46e5',
                    700: '#4338ca',
                    800: '#3730a3',
                    900: '#312e81',
                    950: '#1e1b4b',
                    // ── Semantic brand tokens (theme-driven via CSS vars) ──
                    // Without these, named utilities like `bg-brand-emphasis`,
                    // `border-brand-emphasis`, `bg-brand-subtle`, etc. — used
                    // across ~30 components (radio dot, checkbox fill, switch,
                    // progress bars, date-picker selected day, filter selected
                    // state, charts) — resolved to NOTHING and rendered
                    // colorless (e.g. the radio "fills" with a transparent
                    // dot). Mapping them to the same `--brand-*` vars the
                    // arbitrary `[var(--brand-*)]` callers already use makes
                    // every named usage paint correctly.
                    default: 'var(--brand-default)',
                    emphasis: 'var(--brand-emphasis)',
                    muted: 'var(--brand-muted)',
                    subtle: 'var(--brand-subtle)',
                },

                // ── Semantic surface tokens ──
                bg: {
                    default: 'var(--bg-default)',
                    muted: 'var(--bg-muted)',
                    subtle: 'var(--bg-subtle)',
                    elevated: 'var(--bg-elevated)',
                    page: 'var(--bg-page)',
                    inverted: 'var(--bg-inverted)',
                    overlay: 'var(--bg-overlay)',
                    success: 'var(--bg-success)',
                    'success-emphasis': 'var(--bg-success-emphasis)',
                    warning: 'var(--bg-warning)',
                    'warning-emphasis': 'var(--bg-warning-emphasis)',
                    error: 'var(--bg-error)',
                    'error-emphasis': 'var(--bg-error-emphasis)',
                    info: 'var(--bg-info)',
                    'info-emphasis': 'var(--bg-info-emphasis)',
                    attention: 'var(--bg-attention)',
                },

                // ── Semantic content/text tokens ──
                content: {
                    emphasis: 'var(--content-emphasis)',
                    default: 'var(--content-default)',
                    muted: 'var(--content-muted)',
                    subtle: 'var(--content-subtle)',
                    inverted: 'var(--content-inverted)',
                    success: 'var(--content-success)',
                    warning: 'var(--content-warning)',
                    error: 'var(--content-error)',
                    info: 'var(--content-info)',
                    attention: 'var(--content-attention)',
                },

                // ── Semantic border tokens ──
                border: {
                    default: 'var(--border-default)',
                    subtle: 'var(--border-subtle)',
                    emphasis: 'var(--border-emphasis)',
                    success: 'var(--border-success)',
                    warning: 'var(--border-warning)',
                    error: 'var(--border-error)',
                    info: 'var(--border-info)',
                },

                // ── Process canvas surfaces (Roadmap-27) ──
                // Dedicated surface ramp for the node-based Processes
                // editor — recessed plane, frame chrome, elevated nodes.
                canvas: {
                    surface: 'var(--canvas-surface)',
                    frame: 'var(--canvas-frame)',
                    grid: 'var(--canvas-grid)',
                    node: 'var(--canvas-node)',
                    'node-muted': 'var(--canvas-node-muted)',
                    border: 'var(--canvas-border)',
                },

                // ── Inverted surface (used directly as bg-inverted) ──
                inverted: 'var(--bg-inverted)',

                // ── shadcn / Radix compatibility ──
                primary: 'var(--primary)',
                ring: 'var(--ring)',
                background: 'var(--ring-offset-background)',
            },

            ringOffsetColor: {
                background: 'var(--ring-offset-background)',
            },

            borderRadius: {
                sm: 'var(--radius-sm)',
                DEFAULT: 'var(--radius)',
                lg: 'var(--radius-lg)',
                xl: 'var(--radius-xl)',
            },

            boxShadow: {
                sm: 'var(--shadow-sm)',
                DEFAULT: 'var(--shadow)',
                lg: 'var(--shadow-lg)',
                // R18-PR3 — soft drop shadow for chart surfaces.
                // `shadow-chart-soft` lifts the donut ring / bar
                // cluster / area fill a hair off the card so it
                // reads as a glossy physical object. Token-backed
                // (theme-aware: heavier in dark, lighter in light).
                'chart-soft': 'var(--chart-soft-shadow)',
                // Roadmap-27 — elevated process-node lift + the
                // recessed canvas-plane inner shadow.
                'canvas-node': 'var(--canvas-shadow)',
                'canvas-recess': 'var(--canvas-recess)',
            },

            // ── Semantic spacing scale (v2-PR-2) ──
            // Five named tokens that replace the high-frequency raw
            // numerics (gap-2..gap-6, space-y-2..space-y-6, etc.).
            // The intent is to put a semantic vocabulary on top of
            // Tailwind's numeric scale so consumers reach for purpose
            // ("section break") instead of magnitude ("gap-6").
            //
            //   tight     8 px — in-row icon+text, small button gaps
            //   compact  12 px — dense form rows, list items
            //   default  16 px — default block separation, card padding
            //   section  24 px — between major sections inside a page
            //   page     40 px — between top-level page regions
            //
            // The default Tailwind numeric scale is left untouched —
            // these tokens are additive. Primitive-level micro spacing
            // (gap-1 / space-y-1 = 4 px) intentionally stays as the
            // raw numeric since its sites are inside primitives where
            // the exact value is part of the render contract.
            spacing: {
                tight: '0.5rem',
                compact: '0.75rem',
                default: '1rem',
                section: '1.5rem',
                page: '2.5rem',
            },

            // ── Truncation max-width scale (Roadmap-4 PR-6) ──
            // Three semantic ceilings for `truncate` callsites. The
            // unit is `ch` so the visible character count stays
            // stable across font weight / size variants — the same
            // 14-character tenant name reads the same in the
            // sidebar identity pill (text-sm) and in a sheet header
            // (text-base).
            //
            //   trunc-tight    14 ch — identity labels (tenant name,
            //                          org name), code chips, badges.
            //   trunc-default  28 ch — typical truncated copy
            //                          (justification cells, copy-text).
            //   trunc-loose    40 ch — breadcrumb crumbs, long-prose
            //                          fields where the ceiling
            //                          should still allow most full
            //                          values to render.
            //
            // The arbitrary `max-w-[…]` shape is banned by
            // `tests/guards/truncation-max-width-tokens.test.ts`
            // when paired with a `truncate` class — every truncated
            // surface must reach for one of these tokens.
            maxWidth: {
                'trunc-tight': '14ch',
                'trunc-default': '28ch',
                'trunc-loose': '40ch',
            },

            // ── Animations required by Dub-ported components ──
            keyframes: {
                'slide-up-fade': {
                    '0%': { opacity: '0', transform: 'translateY(6px)' },
                    '100%': { opacity: '1', transform: 'translateY(0)' },
                },
                'slide-down-fade': {
                    '0%': { opacity: '0', transform: 'translateY(-6px)' },
                    '100%': { opacity: '1', transform: 'translateY(0)' },
                },
                'scale-in': {
                    '0%': { opacity: '0', transform: 'scale(0.95)' },
                    '100%': { opacity: '1', transform: 'scale(1)' },
                },
                // Modal "fly-in" (Tier 2, 2026-06-08) — a macOS window-open
                // pop: the panel scales up from 0.88 and the back-out easing
                // (in the `animation` shorthand below) carries it past 1.0
                // before it settles, so it reads as flying toward the viewer.
                // Two-stop keyframe; the overshoot lives in the cubic-bezier,
                // not a third keyframe stop. Centre transform-origin (default)
                // grows it from the middle of the viewport.
                'modal-fly-in': {
                    '0%': { opacity: '0', transform: 'scale(0.88)' },
                    '100%': { opacity: '1', transform: 'scale(1)' },
                },
                // Dismiss is snappier than open — a quick shrink + fade, no
                // overshoot (you don't bounce things away from you).
                'modal-fly-out': {
                    '0%': { opacity: '1', transform: 'scale(1)' },
                    '100%': { opacity: '0', transform: 'scale(0.96)' },
                },
                'fade-in': {
                    '0%': { opacity: '0' },
                    '100%': { opacity: '1' },
                },
                'fade-out': {
                    '0%': { opacity: '1' },
                    '100%': { opacity: '0' },
                },
                'table-pinned-shadow': {
                    '0%': { filter: 'drop-shadow(rgba(0, 0, 0, 0.1) -2px 10px 6px)' },
                    '100%': { filter: 'drop-shadow(rgba(0, 0, 0, 0) -2px 10px 6px)' },
                },
                // Epic 64 — shimmer wave for ShimmerDots. Each dot in
                // the grid stamps an `animation-delay` derived from its
                // (row, col) coordinates so a diagonal wave reads
                // across the surface. Deliberately gentle (opacity
                // 0.25 → 1 → 0.25) to feel polished rather than noisy.
                'shimmer-pulse': {
                    '0%, 100%': { opacity: '0.25' },
                    '50%': { opacity: '1' },
                },
                // R11-PR2 — gradient-sweep shimmer for skeleton loaders.
                // Replaces the static `animate-pulse` opacity flicker
                // with a true left-to-right gradient sweep, the canonical
                // skeleton loading affordance across premium products.
                // The translateX is on a `::after` overlay in CSS so the
                // sweep masks within whatever rounded shape the parent
                // skeleton block uses (line, pill, avatar, etc.).
                'shimmer-sweep': {
                    '0%': { transform: 'translateX(-100%)' },
                    '100%': { transform: 'translateX(100%)' },
                },
                // R13-PR3 — slow vertical pan on the NavItem brand
                // band. The band's `::before` paints a 3-stop
                // gradient at `background-size: 100% 200%` (twice
                // its own height). This keyframe pans the gradient
                // position from top to bottom and back — the band
                // visibly "breathes", a slow pulse of brand light
                // travelling along its length. ease-in-out + the
                // 0% / 50% / 100% palindrome avoids the visible
                // jump that a linear infinite loop would have at
                // the seam between asymmetric gradient endpoints.
                // `prefers-reduced-motion: reduce` flattens the
                // duration to 1ms via tokens.css — no per-component
                // opt-in needed.
                'nav-band-shimmer': {
                    '0%, 100%': { 'background-position': '0% 0%' },
                    '50%': { 'background-position': '0% 100%' },
                },
                // R14-PR3 — slow horizontal pan on the NavBar brand
                // mark's gradient. The mark paints a 3-stop brand
                // gradient at `background-size: 200% 100%`; this
                // keyframe pans the gradient left → right → left
                // over 6 seconds. The mark visibly "breathes" — a
                // slow pulse one rung slower than the band's 4s
                // tempo so the eye reads them as a hierarchy (band
                // moves first, brand follows).
                'nav-brand-pulse': {
                    '0%, 100%': { 'background-position': '0% 50%' },
                    '50%': { 'background-position': '100% 50%' },
                },
                // R15-PR2 — asymmetric halo breath on the NavItem
                // band's ::before. Animates `filter: brightness()`
                // so the band's whole rendered surface (gradient +
                // stardust particles + glow) softly pulses brighter
                // and back over 6 seconds. Crucially OFFSET from
                // the 4-second shimmer — 4s and 6s never sync
                // (LCM 12s), so the two rhythms continuously drift
                // out of phase. Visual asynchrony reads as "alive"
                // where synchronised rhythms read as "mechanical".
                'nav-band-halo-breath': {
                    '0%, 100%': { filter: 'brightness(1)' },
                    '50%': { filter: 'brightness(1.25)' },
                },
                // R15-PR3 — top-to-bottom reveal sweep on the NavItem
                // band's ::before. Animates `clip-path: inset(...)`
                // from `inset(100% 0 0 0)` (fully clipped from below
                // the top edge) to `inset(0)` (fully revealed). One-
                // shot animation — fires once when the band's
                // animation runtime engages (i.e. on hover-enter for
                // default rows, on activation for the active row).
                // After it completes the band's clip-path stays at
                // `inset(0)` (no `animation-fill-mode: forwards`
                // needed — the keyframe's 100% state is its final
                // visible state). The eye reads the reveal as the
                // band "drawing itself in" from the top down, like
                // a stardust trace materializing into a line.
                //
                // Mechanism note: clip-path's `inset()` shape animates
                // smoothly between matching-signature values. Other
                // shape functions (polygon, circle) won't interpolate
                // with inset — keeping both stops as `inset(...)` is
                // load-bearing.
                'nav-band-reveal-sweep': {
                    '0%': { 'clip-path': 'inset(100% 0 0 0)' },
                    '100%': { 'clip-path': 'inset(0 0 0 0)' },
                },
                // R15-PR4 — one-shot starburst bloom on the active
                // row's band. Fires when a row BECOMES active (i.e.
                // when the user navigates). Animates `box-shadow`
                // outward from the baseline glow (6px blur) to a
                // dramatic peak (24px blur + 4px spread) at 30%,
                // then contracts back to baseline by 100%. The eye
                // reads it as a celebration — "the page changed,
                // this is where you are now".
                //
                // Mechanism note: the keyframe ANIMATES box-shadow
                // during playback; after the animation ends the
                // declared `before:shadow-[var(--nav-band-glow-
                // active)]` resumes (no animation-fill-mode:
                // forwards). The 100% keyframe matches the resting
                // shadow shape exactly so there's no visible jump
                // when the animation hands back to the declared
                // value.
                //
                // Why brand-secondary-default (navy) as the glow
                // colour? The active row's band is already navy
                // (R13-PR4 secondary-brand band overrides). The
                // starburst is the same hue family — it reads as
                // "the existing band, but momentarily blooming".
                // A different colour would feel like a different
                // signal.
                'nav-band-starburst': {
                    '0%': {
                        'box-shadow':
                            '0 0 6px var(--brand-secondary-default)',
                    },
                    '30%': {
                        'box-shadow':
                            '0 0 24px 4px var(--brand-secondary-default)',
                    },
                    '100%': {
                        'box-shadow':
                            '0 0 6px var(--brand-secondary-default)',
                    },
                },
                // R15-PR7 — one-shot horizontal sweep of brand-tinted
                // light across the row body. The hover paints a
                // narrow diagonal gradient at `background-size:
                // 300% 100%`; this keyframe pans the
                // `background-position` from -100% (gradient's
                // bright centre is off-left) to 100% (off-right)
                // over 1.2 seconds. The row visibly catches light
                // ONCE as the pointer arrives, then settles.
                //
                // Why one-shot, not infinite? Looping the sweep
                // would make every hovered row continuously
                // shimmer like a loading skeleton — visually
                // exhausting. Once-per-engage is the sweet spot:
                // a moment of polish, then the row trusts its
                // other state signals (band, gloss, outline,
                // bevel) to carry the rest of the hover.
                //
                // nav-row-sweep-delay-3s (2026-05-15) — the user
                // observed that the sweep visibly produces TWO
                // bright peaks during one engage: the gradient
                // has a `transparent/tint/transparent` stop
                // pattern at `background-size: 300%` with the
                // default `background-repeat: repeat`, so the
                // bright peak passes through the visible 100%-
                // wide row TWICE as the position animates from
                // -100% to +100% (once from tile 0's centre at
                // 0% progress, once from tile 1's centre at 75%
                // progress). Original 1.2s ease-out landed the
                // second peak ~0.5s after hover, which felt like
                // an unintended echo.
                //
                // New keyframes: animation runs 3.5s linear with
                // intermediate stops that hold the sweep in the
                // transparent zone between peaks. Peak 1 fires
                // immediately on hover; peak 2 lands at t=3s
                // (the user-requested delay). Linear timing is
                // load-bearing — ease-out front-loads progress
                // and would pull peak 2 earlier; linear pins the
                // peak to the exact wall-clock moment.
                'nav-row-liquid-sweep': {
                    '0%': { 'background-position': '-100% 0%' },
                    // Peak 1 has exited (~0.4s into the 3.5s
                    // animation — the entry feel matches the
                    // original 1.2s sweep's first phase).
                    '11%': { 'background-position': '-50% 0%' },
                    // Hold in the transparent zone for ~2.2s —
                    // the row "settles" between the two diagonal
                    // flashes. Same bg-position as 11%, so the
                    // tween from 11% to 74% is a freeze.
                    '74%': { 'background-position': '-50% 0%' },
                    // Peak 2 passes — t=3s (86% of 3.5s). The
                    // jump from -50% to 50% is the 100%-bg-width
                    // shift that brings tile 1's bright centre
                    // through the visible row.
                    '86%': { 'background-position': '50% 0%' },
                    // Peak 2 exits over the remaining 0.5s —
                    // matches the original sweep's exit pace.
                    '100%': { 'background-position': '100% 0%' },
                },
                // R17-PR2 / removed by hero-static-glow (2026-05-15).
                // Originally drove a 6s opacity palindrome (0.65 →
                // 1 → 0.65) on the HeroMetric glow's `::before`.
                // User feedback: the breath drew the eye to the
                // masthead repeatedly and competed with content. The
                // hero now paints the glow STATICALLY at the breath
                // floor (0.65) via `before:opacity-[0.65]` in
                // HeroMetric.tsx. Keyframe + animation utility
                // removed from this config to avoid stale dead-code.
                // If a future "alive masthead" PR wants the breath
                // back, restore both the `hero-glow-breath` keyframe
                // here AND the `before:animate-hero-glow-breath`
                // class in HeroMetric.tsx; the
                // hero-static-glow ratchet locks the static contract.
                // R17-PR12 — first-paint choreography for the
                // dashboard body. Combines an 8px translateY-from-
                // below with a 0→1 opacity ramp. Replaces the
                // previous bare 150ms `fade-in` on the
                // <DashboardLayout> wrapper — the longer 600ms
                // duration + small vertical motion reads as "the
                // dashboard COMPOSES ITSELF" rather than "the page
                // popped in." 8px is the smallest distance the eye
                // still registers as motion at this duration; larger
                // would feel jumpy on a content-heavy page.
                'dashboard-rise-in': {
                    '0%': { opacity: '0', transform: 'translateY(8px)' },
                    '100%': { opacity: '1', transform: 'translateY(0)' },
                },
                // R18-PR3 — bubbly chart-surface entrance. The
                // pure-CSS sibling of the JS `useChartSpring` hook
                // (R18-PR2) — for chart surfaces that animate via
                // a className rather than a per-shape progress
                // value (e.g. the <ChartFrame> wrapper, a whole
                // donut <svg>). The keyframe mirrors easeOutBack:
                // scale starts SMALL (0.8), overshoots PAST 1
                // (1.05 at the 70% mark — the "bubble" peak),
                // then settles to exactly 1. Opacity ramps 0→1
                // over the first 40% so the surface fades in
                // WHILE it bubbles, not after. The 70%-mark
                // overshoot keyframe is what distinguishes this
                // from a plain `scale-in` — without it the
                // surface just grows, it doesn't bubble.
                'chart-bubble-in': {
                    '0%': { opacity: '0', transform: 'scale(0.8)' },
                    '40%': { opacity: '1' },
                    '70%': { transform: 'scale(1.05)' },
                    '100%': { opacity: '1', transform: 'scale(1)' },
                },
            },
            animation: {
                'slide-up-fade': 'slide-up-fade 0.2s ease-out',
                'slide-down-fade': 'slide-down-fade 0.2s ease-out',
                'scale-in': 'scale-in 0.15s ease-out',
                // The back-out cubic-bezier is the spring: it overshoots ~2.5%
                // past full size near the end, then settles. Defined here in
                // config (not an `ease-[…]` className) so the animation-language
                // lock — which bans arbitrary easings in markup — stays green.
                'modal-fly-in': 'modal-fly-in 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
                'modal-fly-out': 'modal-fly-out 0.15s ease-in',
                'fade-in': 'fade-in 0.15s ease-out',
                'fade-out': 'fade-out 0.15s ease-out',
                'table-pinned-shadow': 'table-pinned-shadow cubic-bezier(0, 0, 1, 0)',
                'shimmer-pulse': 'shimmer-pulse 1.6s ease-in-out infinite',
                'shimmer-sweep': 'shimmer-sweep 1.6s ease-in-out infinite',
                // 4s is deliberately slow — the band shouldn't read
                // as a loading indicator. Closer to a quiet pulse of
                // brand light than to the 1.6s skeleton-shimmer
                // tempo. ease-in-out gives the motion its natural
                // breathing curve; `infinite` keeps it going as long
                // as the band is visible.
                'nav-band-shimmer': 'nav-band-shimmer 4s ease-in-out infinite',
                // 6s tempo — deliberately slower than the band's 4s.
                // Two reasons:
                //   • Visual hierarchy. The band is the state signal;
                //     the brand mark is the identity signal. The
                //     state should "lead" the eye; the identity
                //     pulses underneath.
                //   • Cognitive load. Two animations at the same
                //     tempo synchronise and become hypnotic. Different
                //     tempos let the eye treat each as a separate
                //     piece of choreography.
                'nav-brand-pulse': 'nav-brand-pulse 6s ease-in-out infinite',
                // 6s — same tempo as the brand-mark pulse, but on
                // the NavItem band. The shimmer-shift (4s) and the
                // halo-breath (6s) are deliberately mismatched so
                // they never re-sync; the band feels continuously
                // alive instead of mechanically looping.
                'nav-band-halo-breath':
                    'nav-band-halo-breath 6s ease-in-out infinite',
                // R15-PR3 — one-shot reveal sweep, fires when the
                // band first engages (hover-enter or activation).
                // 450ms is the slow side of "felt-but-not-noticed"
                // — long enough for the eye to register the top-
                // to-bottom motion as deliberate, short enough that
                // a quick mouse-over still completes before the
                // pointer moves away. ease-out lands the bottom
                // edge softly rather than racing into the bottom
                // corner. No `infinite` — the reveal plays once
                // per engagement and lets the perpetual shimmer +
                // halo-breath take over.
                'nav-band-reveal-sweep':
                    'nav-band-reveal-sweep 450ms ease-out',
                // R15-PR2 + R15-PR3 — combined "alive" animation
                // that composes THREE timelines on the same
                // ::before pseudo-element:
                //
                //   nav-band-reveal-sweep  450ms ease-out (one-shot)
                //   nav-band-shimmer       4s ease-in-out infinite
                //   nav-band-halo-breath   6s ease-in-out infinite
                //
                // CSS's `animation` property accepts a comma-
                // separated list — each entry gets its own timeline.
                // The reveal is FIRST in the list because the eye
                // reads animation order as visual order: the band
                // materializes (reveal), then begins to shimmer
                // (drift), then begins to breathe (halo pulse).
                //
                // The two infinite tracks have an LCM of 12s but
                // their phase never coincides except at multiples
                // of 12s, so the band reads as continuously
                // evolving for every glance shorter than 12 seconds
                // (i.e. always, in practice). A consumer applies a
                // single `animate-nav-band-alive` utility and gets
                // all three animations composed.
                // R15-PR5 — each perpetual track (shimmer + halo-
                // breath) carries a per-row `animation-delay`
                // pulled from a CSS custom property on the host
                // <Link> element. Without staggering, every row's
                // bands march in lockstep — easy for the eye to
                // read as "a periodic system". With per-row drift
                // the sidebar ripples rather than marches.
                //
                // CSS shorthand order: <name> <duration> <timing>
                // <delay> <iteration>. The `var(--nav-*-delay, 0ms)`
                // form preserves the default-0-delay behaviour for
                // any consumer that doesn't set the custom property
                // (e.g. legacy NavItem callers, the org sidebar's
                // OrgNavItem, the mobile drawer trigger animation).
                //
                // The one-shot tracks (reveal-sweep, starburst)
                // intentionally keep zero delay — they're
                // celebration moments that need to fire instantly
                // when the row engages.
                'nav-band-alive':
                    'nav-band-reveal-sweep 450ms ease-out, nav-band-shimmer 4s ease-in-out var(--nav-shimmer-delay, 0ms) infinite, nav-band-halo-breath 6s ease-in-out var(--nav-breath-delay, 0ms) infinite',
                // R15-PR4 — 700ms ease-out one-shot. The bloom peaks
                // at ~30% (210ms in) and settles back to baseline by
                // 700ms. The slow-out curve makes the peak feel
                // earned and the fade-back feel like a settling
                // breath, not a snap.
                'nav-band-starburst':
                    'nav-band-starburst 700ms ease-out',
                // R15-PR7 — 1.2s ease-out one-shot. Bright centre
                // arrives at the row's right edge by ~700ms and
                // exits off the right by 1.2s. ease-out keeps the
                // sweep feeling like it ACCELERATES into the row
                // and SETTLES out the far side — gravity-aware
                // motion. No `infinite` — the sweep fires once
                // when hover engages.
                // nav-row-sweep-delay-3s (2026-05-15) — duration
                // extended from 1.2s → 3.5s and easing changed
                // from `ease-out` → `linear` so the keyframe
                // percentages map directly to wall-clock time:
                // peak 1 at t=0, peak 2 at t=3s (86% of 3.5s).
                // ease-out would compress the peak 2 timing.
                'nav-row-liquid-sweep':
                    'nav-row-liquid-sweep 3.5s linear',
                // R17-PR2 / removed by hero-static-glow (2026-05-15).
                // See the keyframes block above for the rationale.
                // R17-PR12 — 600ms ease-out one-shot. Slow enough
                // that the eye registers the dashboard COMPOSING
                // itself; fast enough that an impatient user
                // doesn't wait. ease-out keeps the motion
                // decelerating into its final position — feels
                // "landing" rather than "stopping."
                'dashboard-rise-in':
                    'dashboard-rise-in 600ms ease-out',
                // R18-PR3 — bubbly chart-surface entrance. 520ms
                // matches `--chart-bubble-duration` + the JS
                // `CHART_SPRING_DURATION_MS` so the CSS path and
                // the JS-hook path read as the SAME motion. The
                // timing function is `ease-out` only — the
                // OVERSHOOT lives in the keyframe (the 70%-mark
                // scale(1.05)), not the curve. Putting the bounce
                // in the keyframe rather than a back-curve timing
                // function keeps it identical to the easeOutBack
                // shape useChartSpring computes. One-shot — fires
                // once on mount, the surface then trusts its
                // gloss + soft-shadow to carry the rest.
                'chart-bubble-in':
                    'chart-bubble-in 520ms ease-out',
                // R15-PR4 — combined "alive" animation for the
                // ACTIVE row. Adds the starburst bloom as the first
                // track ahead of the three R15-PR1..3 tracks. All
                // four animations start at the same instant when
                // the row engages:
                //
                //   nav-band-starburst     700ms ease-out (one-shot)
                //   nav-band-reveal-sweep  450ms ease-out (one-shot)
                //   nav-band-shimmer       4s ease-in-out infinite
                //   nav-band-halo-breath   6s ease-in-out infinite
                //
                // The two one-shot tracks (starburst + reveal) end
                // at 700ms and 450ms respectively; the two infinite
                // tracks continue forever. Visually the band
                // materializes (reveal) WHILE blooming (starburst),
                // then settles into perpetual drift (shimmer) +
                // pulse (halo-breath).
                //
                // Default rows use `nav-band-alive` (without
                // starburst) — the bloom is reserved for the
                // "this is now where you are" signal of becoming
                // active.
                'nav-band-active-alive':
                    'nav-band-starburst 700ms ease-out, nav-band-reveal-sweep 450ms ease-out, nav-band-shimmer 4s ease-in-out var(--nav-shimmer-delay, 0ms) infinite, nav-band-halo-breath 6s ease-in-out var(--nav-breath-delay, 0ms) infinite',
            },
        },
    },
    plugins: [
        function ({ addUtilities }) {
            addUtilities({
                '.scrollbar-hide': {
                    '-ms-overflow-style': 'none',
                    'scrollbar-width': 'none',
                    '&::-webkit-scrollbar': { display: 'none' },
                },
            });
        },
    ],
};
