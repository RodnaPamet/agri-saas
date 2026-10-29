/**
 * The sidebar search button's accessible name contains its visible text — #2430.
 *
 * ## The defect this pins
 *
 * `SidebarNav` rendered a button whose visible label was «Търсене» and whose
 * `aria-label` was «Отвори командната палитра». The accessible name therefore
 * did not contain the visible label, which is **WCAG 2.5.3 Label in Name**.
 *
 * The cost is concrete rather than cosmetic: voice-control users say what they
 * can see. «Търсене» matched nothing, because the only name exposed was
 * «Отвори командната палитра», so the control was unreachable by voice on every
 * authenticated page — the element is in the sidebar.
 *
 * ## Why this is asserted on the MESSAGES and not on the DOM
 *
 * `@axe-core/playwright` 4.14 catches this properly, repo-wide, with the
 * `label-content-name-mismatch` rule — that is how it was found. But the bump
 * lives in #2382 and is not on main yet, so on main the E2E gate does NOT run
 * the rule. A fix landing before the detector would otherwise be unverifiable:
 * green because nothing asked, which is the shape this repo keeps naming.
 *
 * So this file asserts the containment directly, offline, independent of which
 * axe version is installed. When 4.14 lands the E2E gate covers the general
 * case and this becomes a cheap, specific regression pin for the one control
 * that was actually broken.
 *
 * ## Why it is NOT a derived scan
 *
 * I tried to derive every (aria-label, visible text) pair statically. 104 .tsx
 * files use `aria-label={t(...)}`, and a bounded-window regex "found" 93 pairs
 * of which the great majority were false — `aria=deleteRole text=loading`,
 * `aria=prevMonth text=loadError` — because the window jumped into unrelated
 * JSX. A guard on that heuristic would be wrong far more often than right, and
 * would need an exemption list for its own false positives: machinery implying
 * coverage it does not have.
 *
 * Doing it properly needs JSX AST analysis — find the `aria-label` attribute
 * and the text children of the SAME element — which is real work and belongs in
 * its own change rather than bolted onto a copy fix. Until then the honest
 * scope of this file is one control, stated plainly.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = process.cwd();
const LOCALES = ['bg', 'en'] as const;

interface SidebarNavMessages {
    search: string;
    openPalette: string;
}

function sidebarNav(locale: string): SidebarNavMessages {
    const msgs = JSON.parse(readFileSync(join(ROOT, `messages/${locale}/app.json`), 'utf8')) as {
        sidebarNav?: Partial<SidebarNavMessages>;
    };
    const ns = msgs.sidebarNav;
    // An ABSENT namespace must not read as a pass: `undefined.includes` would
    // throw, but a missing KEY would make containment vacuously checkable
    // against an empty string. Assert both are real strings first.
    expect(typeof ns?.search).toBe('string');
    expect(typeof ns?.openPalette).toBe('string');
    return ns as SidebarNavMessages;
}

describe('WCAG 2.5.3 — the sidebar search accessible name contains its label (#2430)', () => {
    it.each(LOCALES)('%s: the aria-label contains the visible text', (locale) => {
        const { search, openPalette } = sidebarNav(locale);
        expect({ locale, search, openPalette, contains: openPalette.includes(search) }).toEqual({
            locale,
            search,
            openPalette,
            contains: true,
        });
    });

    it.each(LOCALES)('%s: the visible text is non-trivial, so containment means something', (locale) => {
        const { search } = sidebarNav(locale);
        // Containment is satisfied trivially by an empty or one-character
        // label. Without this, emptying `search` would make the assertion above
        // pass while the control's name matched nothing a user could say.
        expect(search.trim().length).toBeGreaterThanOrEqual(4);
    });

    it('the component still takes its name and its label from these two keys', () => {
        // The assertions above are about MESSAGES. They are only about the
        // button while the component reads these keys — if `SidebarNav` stops
        // using `openPalette` for the aria-label, this file is asserting
        // containment for a string nothing renders.
        // Comments BLANKED, and that is correctness here. The claim is that the
        // component READS these keys; a commented-out `aria-label={t(...)}` —
        // including a note explaining why it was changed — would otherwise
        // satisfy it, and this file would be asserting containment for a string
        // nothing renders. A scar read as a wound.
        const src = blankNonCode(readFileSync(join(ROOT, 'src/components/layout/SidebarNav.tsx'), 'utf8'));
        expect(src).toContain("aria-label={t('openPalette')}");
        expect(src).toContain("{t('search')}");
    });
});

describe('the component check reads code, not comments', () => {
    it('a commented-out aria-label does not satisfy it', () => {
        const commented = "// aria-label={t('openPalette')}";
        expect(commented).toContain("aria-label={t('openPalette')}");
        expect(blankNonCode(commented)).not.toContain("aria-label={t('openPalette')}");
        // And the real attribute survives blanking, or the assertion above
        // would be passing for the wrong reason.
        expect(blankNonCode("aria-label={t('openPalette')}")).toContain("aria-label={t('openPalette')}");
    });
});

describe('the containment check can fail', () => {
    it('a name that does not contain its label is rejected', () => {
        // The positive control. Both halves, because "contains" returning true
        // for everything and false for everything are both broken.
        expect('Отвори командната палитра'.includes('Търсене')).toBe(false);
        expect('Търсене — отвори командната палитра'.includes('Търсене')).toBe(true);
        expect('Open command palette'.includes('Search')).toBe(false);
        expect('Search — open command palette'.includes('Search')).toBe(true);
    });
});
