/** @jest-environment jsdom */

/**
 * Behavioural (Tier-2) test — sidebar `<NavItem>` ACTIVE band tone.
 *
 * THE FLAGSHIP CASE from `docs/roadmap-audit-2026-05-13.md`.
 *
 * What went wrong before:
 *   R13-PR4 (#394) tried to swap the active band to a secondary brand
 *   ramp; the 2026-05-13 v1 (#455) then tried to swap it to the page
 *   background. v1 used Tailwind utility overrides
 *   (`before:from-[var(--bg-page)]!` etc.). Those utilities only set
 *   the `--tw-gradient-from/via/to` CSS variables — they do NOT
 *   override the BASE recipe's literal arbitrary `before:bg-[...]`
 *   value. So the structural ratchet was GREEN (the `--bg-page` token
 *   string was present in `className`) while the RENDERED band still
 *   painted the brand-default ramp. v2 (#463) fixed it by overriding
 *   the entire arbitrary `before:bg-[...]` value.
 *
 * Why this is a Tier-2 test and not a `getComputedStyle(el,'::before')`
 * test (the audit's original sketch):
 *   jsdom does NOT compute pseudo-element styles — verified
 *   2026-05-22, `getComputedStyle(el, '::before')` returns empty
 *   strings. The audit's sketch is aspirational; it cannot run in
 *   jsdom. See `docs/frontend-assurance-model.md`.
 *
 * What this test does instead — same INTENT, achievable in jsdom:
 *   1. Extracts the `before:bg-[...]` arbitrary value that the ACTIVE
 *      recipe actually applies to the rendered `<a>` element.
 *   2. Resolves the CSS custom properties inside it against the REAL
 *      theme blocks in `src/styles/tokens.css` (both METRO dark and
 *      PwC light).
 *   3. Asserts the active band's gradient stops resolve to the
 *      page-background colour — and carry ZERO brand-ramp tokens.
 *
 * Step 3 is the assertion v1 would have FAILED: v1's rendered band
 * still contained `var(--brand-default)` / `--brand-muted` /
 * `--brand-emphasis`. This test is behavioural — it inspects the
 * value the component renders and resolves it, not merely a substring
 * presence.
 */

import fs from 'node:fs';
import path from 'node:path';

import { render, screen } from '@testing-library/react';
import { Settings } from 'lucide-react';
import * as React from 'react';

import { NavItem } from '@/components/layout/nav-item';

// ─── Theme-token resolver ──────────────────────────────────────────
//
// jsdom does not substitute `var(--x)`. We parse the real
// `tokens.css` ourselves so the test resolves against the SAME values
// the app ships.

const TOKENS_CSS = fs.readFileSync(
    path.join(process.cwd(), 'src/styles/tokens.css'),
    'utf8',
);

/**
 * Parse a single theme block (`:root { ... }` or
 * `[data-theme="light"] { ... }`) into a `--token → value` map. Only
 * the FIRST occurrence of each block is read — that is the canonical
 * theme block; later occurrences in the file are sub-scope mirrors.
 */
function parseThemeBlock(selector: string): Record<string, string> {
    const start = TOKENS_CSS.indexOf(selector + ' {');
    if (start === -1) {
        throw new Error(`theme block ${selector} not found in tokens.css`);
    }
    // Walk braces to find the matching close.
    let depth = 0;
    let i = TOKENS_CSS.indexOf('{', start);
    const bodyStart = i + 1;
    for (; i < TOKENS_CSS.length; i++) {
        if (TOKENS_CSS[i] === '{') depth++;
        else if (TOKENS_CSS[i] === '}') {
            depth--;
            if (depth === 0) break;
        }
    }
    const body = TOKENS_CSS.slice(bodyStart, i);
    const map: Record<string, string> = {};
    for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
        // First write wins — top-level declarations precede the
        // nested sub-scope mirrors inside the same block.
        if (!(m[1] in map)) map[m[1]] = m[2].trim();
    }
    return map;
}

const METRO = parseThemeBlock(':root');
const PWC = parseThemeBlock('[data-theme="light"]');

/** Recursively substitute every `var(--x)` against a token map. */
function resolveVars(value: string, tokens: Record<string, string>): string {
    let out = value;
    for (let pass = 0; pass < 10 && out.includes('var('); pass++) {
        out = out.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
            return tokens[name] ?? `__UNRESOLVED(${name})__`;
        });
    }
    return out;
}

/**
 * Pull a `before:bg-[...]` arbitrary value (the band's
 * background-image) out of a className string. Tailwind's arbitrary
 * value escapes spaces as `_`; we un-escape them so `var()` parsing
 * is straightforward.
 *
 * A NavItem className can carry TWO such values:
 *   - the BASE band (brand ramp), applied in every state;
 *   - the ACTIVE override (`...!` important suffix), applied only on
 *     the active row.
 * `which: 'active'` returns the `!`-suffixed override; `'base'`
 * returns the non-suffixed BASE value. The arbitrary value itself
 * contains no `[`/`]` (gradients use only parens), so a
 * `[^\]]+` bracket match is exact.
 */
function extractBeforeBg(
    className: string,
    which: 'active' | 'base',
): string {
    const re =
        which === 'active'
            ? /before:bg-\[([^\]]+)\]!/g
            : /before:bg-\[([^\]]+)\](?!!)/g;
    const matches = [...className.matchAll(re)];
    if (matches.length === 0) {
        throw new Error(
            `no ${which} before:bg-[...] found in className`,
        );
    }
    return matches[0][1].replace(/_/g, ' ');
}

describe('<NavItem> active band tone — behavioural (Tier 2)', () => {
    it('the active band exists as a `before:bg-[...]` arbitrary value (not utility overrides)', () => {
        // v1's failure mode was using `before:from-X!` UTILITY classes
        // which silently no-op against an arbitrary `before:bg-[...]`.
        // The fix (v2) overrides the whole arbitrary value. This test
        // locks that the active band is expressed as a full arbitrary
        // value — the only form that actually overrides the BASE band.
        render(
            <NavItem
                href="/t/acme/controls"
                icon={Settings}
                label="Controls"
                active
            />,
        );
        const link = screen.getByRole('link', { name: 'Controls' });
        // The arbitrary-value override must be present...
        expect(() =>
            extractBeforeBg(link.className, 'active'),
        ).not.toThrow();
        // ...and it must carry the `!` important suffix, because both
        // the BASE band and the active override compile to the same
        // `background-image` property — without `!` the cascade is a
        // coin-flip and v1's brand ramp can win.
        expect(link.className).toMatch(/before:bg-\[[^\]]+\]!/);
    });

    it('the rendered active band resolves to --bg-page on the METRO dark theme', () => {
        render(
            <NavItem
                href="/t/acme/controls"
                icon={Settings}
                label="Controls"
                active
            />,
        );
        const link = screen.getByRole('link', { name: 'Controls' });
        const bandValue = extractBeforeBg(link.className, 'active');

        const resolved = resolveVars(bandValue, METRO);

        // The page-background colour MUST appear in the resolved band —
        // that IS the property, and it is what this test's name describes.
        //
        // This used to assert the literal #001830, the navy-era value. When
        // the dark ground moved to green on 2026-07-30 it failed while the
        // relationship it exists to protect was completely intact, and
        // hard-coding the new green would only reset the same trap for the
        // next re-theme. It now reads --bg-page from the parsed theme, so
        // the assertion tracks the token instead of shadowing it.
        const pageBg = METRO['--bg-page'];
        expect(pageBg).toMatch(/^#[0-9a-f]{6}$/i);
        expect(resolved).toContain(pageBg);
        // Nothing should be left unresolved.
        expect(resolved).not.toContain('__UNRESOLVED');
    });

    it('the rendered active band resolves to --bg-page on the PwC light theme', () => {
        render(
            <NavItem
                href="/t/acme/controls"
                icon={Settings}
                label="Controls"
                active
            />,
        );
        const link = screen.getByRole('link', { name: 'Controls' });
        const bandValue = extractBeforeBg(link.className, 'active');

        const resolved = resolveVars(bandValue, PWC);

        // PwC --bg-page is #F4F2ED (warm off-white).
        expect(PWC['--bg-page']).toBe('#F4F2ED');
        expect(resolved).toContain('#F4F2ED');
        expect(resolved).not.toContain('__UNRESOLVED');
    });

    it('the rendered active band carries ZERO brand-ramp tokens — the exact v1 regression', () => {
        // THIS is the assertion v1 (#455) would have failed. v1 left
        // the BASE recipe's `linear-gradient(..., var(--brand-default),
        // var(--brand-muted), var(--brand-emphasis))` intact in the
        // rendered band because the utility overrides didn't touch the
        // arbitrary value. A structural "contains --bg-page" scan was
        // green; the band still painted brand yellow.
        render(
            <NavItem
                href="/t/acme/controls"
                icon={Settings}
                label="Controls"
                active
            />,
        );
        const link = screen.getByRole('link', { name: 'Controls' });
        const bandValue = extractBeforeBg(link.className, 'active');

        // The band's linear-gradient stops must NOT reference the
        // brand ramp. The radial "stardust particle" layers are pure
        // white rgba and carry no brand tokens, so the only brand
        // tokens that could appear here would be a leftover ramp.
        expect(bandValue).not.toContain('var(--brand-default)');
        expect(bandValue).not.toContain('var(--brand-muted)');
        expect(bandValue).not.toContain('var(--brand-emphasis)');

        // And it positively IS the page-bg ramp (three identical
        // --bg-page stops collapse the linear gradient to a solid).
        expect(bandValue).toContain('var(--bg-page)');
    });

    it('the DEFAULT (idle) band still uses the brand ramp — the swap is active-only', () => {
        // Regression guard in the other direction: the active-only
        // page-bg swap must not bleed into the idle/hover band, which
        // is still meant to be the warm brand gradient.
        render(
            <NavItem
                href="/t/acme/controls"
                icon={Settings}
                label="Controls"
                active={false}
            />,
        );
        const link = screen.getByRole('link', { name: 'Controls' });
        // The BASE band (applied in every state) carries the brand
        // ramp; the idle state does NOT override it with --bg-page.
        const bandValue = extractBeforeBg(link.className, 'base');
        expect(bandValue).toContain('var(--brand-default)');
        expect(bandValue).toContain('var(--brand-emphasis)');
        // The idle row must not carry the active page-bg override.
        expect(link.className).not.toContain(
            'linear-gradient(to bottom, var(--bg-page)',
        );
    });
});
