/**
 * The market-trends link takes its name from CONTENT, not an aria-label — #2449.
 *
 * ## The defect
 *
 * `MarketTrendsWidget` wrapped its headline figures in a `<Link>` carrying
 * `aria-label={t('widget.tapThrough')}` — «Отвори пазарните тенденции» /
 * "Open market trends". An `aria-label` REPLACES the accessible name, so the
 * name contained none of the visible text, which is the price, its unit and
 * its delta. **WCAG 2.5.3 Label in Name**, and the same
 * `label-content-name-mismatch` rule as #2430 on the sidebar search button.
 *
 * The cost is the same as #2430's: voice-control users say what they can see.
 * The dashboard is the post-login landing page, so this was on the first
 * screen of every session.
 *
 * ## Why the #2430 remedy does NOT transfer
 *
 * #2441 fixed the sidebar button by widening its `aria-label` to contain the
 * visible word — «Търсене — отвори командната палитра». That worked because
 * the visible text was a static label.
 *
 * Here the visible text is **live numeric data**. Any static `aria-label`
 * would stop containing it the moment the price moved, so widening the label
 * is not a fix but a fix that expires. Hence the inversion: drop the
 * `aria-label` entirely and let the name come from content — an `sr-only`
 * span for the destination plus the figures themselves. Containment then holds
 * BY CONSTRUCTION rather than by a string comparison someone must maintain.
 *
 * That is why this file asserts the ABSENCE of an aria-label on the element.
 * Re-adding one would re-break the rule even if its text looked reasonable.
 *
 * ## Why it is asserted on the source, offline
 *
 * `@axe-core/playwright` 4.14 catches this repo-wide and is how it was found —
 * but the bump is in #2382 and is not on main, so on main the E2E gate does
 * not run the rule. A fix landing before the detector would be green because
 * nothing asked. When 4.14 lands, the E2E gate covers the general case and
 * this stays as the specific regression pin.
 *
 * Scope stated plainly: one control. The general case needs JSX AST analysis
 * to pair an `aria-label` with the text children of the same element — see the
 * docblock in `label-in-name-sidebar-search.test.ts` for why a bounded-window
 * regex produced mostly false pairs.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { blankNonCode } from '../helpers/blank-non-code';
import { readCatalogue } from '../helpers/catalogue';

const ROOT = process.cwd();
const LOCALES = ['bg', 'en'] as const;
const COMPONENT = 'src/components/trends/MarketTrendsWidget.tsx';

/** Comments blanked: a commented-out attribute must not satisfy these. */
const source = () => blankNonCode(readFileSync(join(ROOT, COMPONENT), 'utf8'));

function tapThrough(locale: string): string {
    const ns = (readCatalogue(locale) as unknown as {
        trends?: { widget?: { tapThrough?: string } };
    }).trends?.widget;
    // An absent key must not read as a pass — `undefined` would make the
    // non-triviality check below throw rather than fail, and a missing string
    // would make it vacuous.
    expect(typeof ns?.tapThrough).toBe('string');
    return ns!.tapThrough!;
}

describe('WCAG 2.5.3 — the market-trends link is named by its content (#2449)', () => {
    it('the link carries NO aria-label, so its name includes the visible figures', () => {
        const src = source();
        // The element is identified by its id, which is also what axe reported.
        expect(src).toContain('id="market-trends-widget"');
        // THE ASSERTION. `tapThrough` must not appear as an aria-label anywhere
        // in this component — that is the exact shape that was broken.
        expect(src).not.toContain("aria-label={t('widget.tapThrough')}");
    });

    it('the destination is still announced, via sr-only text inside the link', () => {
        // Removing the aria-label without this would leave the link named by
        // bare numbers — compliant with 2.5.3 and useless to a screen-reader
        // user. The fix is only correct with both halves.
        expect(source()).toContain(
            '<span className="sr-only">{t(\'widget.tapThrough\')}</span>',
        );
    });

    it.each(LOCALES)('%s: the announced text is non-trivial', (locale) => {
        // An empty or one-word string would satisfy the containment the fix
        // relies on while announcing nothing.
        expect(tapThrough(locale).trim().length).toBeGreaterThanOrEqual(8);
    });

    it('the visible figures are still rendered inside the same link', () => {
        // The containment argument is "name = sr-only + visible content". If
        // the figures moved OUT of the link, the name would no longer contain
        // them and this file would be asserting a property of a different DOM.
        const src = source();
        const linkStart = src.indexOf('id="market-trends-widget"');
        expect(linkStart).toBeGreaterThan(-1);
        // The window is bounded by the CLOSING TAG, not by a character count.
        // A constant was wrong twice over: too small and the assertion fails on
        // a comment being added (blanking preserves length, so prose inside the
        // element pushes the figures further out), too large and it reaches
        // into the next element and passes on somebody else's markup.
        const linkEnd = src.indexOf('</Link>', linkStart);
        expect(linkEnd).toBeGreaterThan(linkStart);
        const linkRegion = src.slice(linkStart, linkEnd);
        expect(linkRegion).toContain('formatPriceWithCurrency(headline.price');
    });

    it('sr-only is a real utility in this codebase, not an invented class', () => {
        // A class that resolves to nothing would render the destination text
        // VISIBLY, changing the widget's appearance — a silent regression that
        // no a11y rule would report. Pinned against an existing consumer
        // rather than against a Tailwind config that may generate it either
        // way.
        const rail = blankNonCode(
            readFileSync(join(ROOT, 'src/components/ui/left-accordion-rail.tsx'), 'utf8'),
        );
        expect(rail).toContain('className="sr-only"');
    });
});
