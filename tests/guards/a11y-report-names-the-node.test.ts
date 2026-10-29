/**
 * An a11y failure must name the ELEMENT, not just a CSS selector — #2382.
 *
 * ## The failure this exists for
 *
 * `@axe-core/playwright` 4.13 → 4.14 (in the #2382 dev-dependency group) found
 * a real `label-content-name-mismatch` — WCAG 2.5.3 Label in Name, the same
 * rule #2441 fixed on the sidebar search button. The gate went red correctly.
 * What it printed was:
 *
 *     [serious] label-content-name-mismatch — Elements must have their visible
 *               text as part of their accessible name
 *         node: .px-2
 *         node: #market-trends-widget
 *
 * `#market-trends-widget` resolves to one component. **`.px-2` resolves to
 * nothing**: axe emits the shortest selector that is unique ON THE PAGE, and in
 * a Tailwind codebase that is routinely a bare spacing utility used in dozens
 * of components. The two routes left were downloading a 160 MB Playwright
 * artifact or standing the whole E2E stack up locally — for a defect axe had
 * already pinpointed and described.
 *
 * axe had handed us the answer twice over on the same object: `html` (the
 * element) and `failureSummary` (for a name rule, the accessible name beside
 * the visible text — the actual discriminator). Both were declared on
 * `AxeViolationNode` and both were dropped on the floor by the reporter.
 *
 * ## Why this is a test and not a careful reporter
 *
 * Because the reporter was already careful. It grouped by impact, ordered
 * severities, printed help URLs and capped nodes at three with an honest
 * "… and N more" — and still could not be acted on, and nothing failed. The
 * output of a gate is part of the gate; while `formatAxeReport` lived beside
 * `expect` and `AxeBuilder` in `a11y-scan.ts`, the only way to observe it was
 * to read a job log after a failure. Hence `tests/e2e/a11y-report.ts`, which
 * touches no page, and this file, which asserts what CI will print.
 *
 * Related: `uniform-failure-shape-blinds-the-client` — one error shape for
 * every cause means the log names nothing.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { blankNonCode } from '../helpers/blank-non-code';

import { formatAxeReport, type AxeViolation } from '../../tests/e2e/a11y-report';

const ROOT = join(__dirname, '../..');

/** The real finding from #2382, shape intact. */
function nameMismatch(overrides: Partial<AxeViolation['nodes'][number]> = {}): AxeViolation {
    return {
        id: 'label-content-name-mismatch',
        impact: 'serious',
        description: 'Ensures that elements labelled through their content must have their visible text as part of their accessible name',
        help: 'Elements must have their visible text as part of their accessible name',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.14/label-content-name-mismatch',
        nodes: [
            {
                target: ['.px-2'],
                html: '<a id="market-trends-widget" aria-label="Open market trends" class="block rounded-lg px-2">1.95 EUR</a>',
                failureSummary:
                    'Fix any of the following:\n  Element\'s text is not included in the accessible name',
                ...overrides,
            },
        ],
    };
}

describe('an a11y failure names the element, not just a selector (#2382)', () => {
    it('prints the element HTML beside the selector', () => {
        const out = formatAxeReport('dashboard', 'auto', 'http://x/dashboard', [nameMismatch()]);
        // The selector is still there — it is how you find the node in a live
        // page — but it is no longer the ONLY thing.
        expect(out).toContain('node: .px-2');
        expect(out).toContain('market-trends-widget');
        expect(out).toContain('aria-label="Open market trends"');
    });

    it("prints axe's failureSummary, which carries the actual discriminator", () => {
        const out = formatAxeReport('dashboard', 'auto', 'http://x/dashboard', [nameMismatch()]);
        // For a NAME rule this sentence is the whole diagnosis: it says the
        // visible text is absent from the accessible name, which is what
        // distinguishes this from the dozens of other reasons an element can
        // fail. A selector cannot say it.
        expect(out).toContain("Element's text is not included in the accessible name");
        // Multi-line summaries keep their lines; a collapsed one is unreadable.
        expect(out).toContain('Fix any of the following:');
    });

    it('bounds the HTML so one node cannot bury the report', () => {
        const long = `<div class="${'x'.repeat(2000)}">text</div>`;
        const out = formatAxeReport('s', 'auto', 'u', [nameMismatch({ html: long })]);
        const htmlLine = out.split('\n').find((l) => l.includes('html:'));
        expect(htmlLine).toBeDefined();
        // 240 chars + the ellipsis + the label's indent — far short of 2,000.
        expect(htmlLine!.length).toBeLessThan(300);
        expect(htmlLine).toContain('…');
    });

    it('a node with neither html nor failureSummary still prints its selector', () => {
        // axe does not guarantee either field. Losing the selector too would
        // turn a reported violation into an unreported one — strictly worse
        // than the defect this file is about.
        const out = formatAxeReport('s', 'auto', 'u', [
            nameMismatch({ html: undefined, failureSummary: undefined }),
        ]);
        expect(out).toContain('node: .px-2');
        expect(out).not.toContain('html:');
    });

    it('nothing to report is the empty string, not a header over zero findings', () => {
        expect(formatAxeReport('s', 'auto', 'u', [])).toBe('');
    });

    it('the production scan path actually calls this formatter', () => {
        // THE SEAM. Extracting the formatter made it testable and, in the same
        // move, made it skippable: `a11y-scan.ts` could print its own string
        // and every assertion above would still pass over a function CI never
        // runs. Comments are blanked first, so the docblock that EXPLAINS the
        // call cannot satisfy the check for it.
        const src = blankNonCode(readFileSync(join(ROOT, 'tests/e2e/a11y-scan.ts'), 'utf8'));
        expect(src).toContain('formatAxeReport(');
        expect(src).toContain('console.log(report)');
        // And the formatter must not have been re-copied back into the scan
        // file, which would restore the untestable arrangement while leaving
        // this file green.
        expect(src).not.toContain('export function formatAxeReport');
    });

    it('the report module is free of Playwright, so this file can import it', () => {
        // The reason the old reporter was unobservable. If a page import lands
        // here, `a11y-report.ts` becomes browser-only again and every test
        // above would have to be deleted rather than fixed — so fail on the
        // import, not on the consequence.
        const src = blankNonCode(readFileSync(join(ROOT, 'tests/e2e/a11y-report.ts'), 'utf8'));
        expect(src).not.toContain('@playwright/test');
        expect(src).not.toContain('@axe-core/playwright');
    });
});
