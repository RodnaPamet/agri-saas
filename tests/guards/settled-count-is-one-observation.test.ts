/**
 * A count-of-one barrier and what it guards must hold in ONE observation
 * (#1567).
 *
 * ## The defect this forbids
 *
 *     await expect(header).toHaveCount(1, { timeout: 30000 });
 *     await expect(header).toBeVisible();
 *
 * `toHaveCount(1)` returns the instant it observes one. That is not the same
 * as the App Router transition being over, so the count can go back up, the
 * next statement re-queries, and `toBeVisible()` on a two-element locator is a
 * strict-mode violation — which throws IMMEDIATELY rather than retrying, so
 * the generous timeout on the line above never applies.
 *
 * Measured, from attempt 1 of run 38022280789
 * (`admin-regression.spec.ts:35`): `strict mode violation:
 * getByTestId('page-header-title') resolved to 2 elements`, both
 * `<h1 …>Administration</h1>`, with the whole test lasting 2.5s.
 *
 * ## Why a guard and not just the fix
 *
 * Because the shape was written five times, in four files, by authors who had
 * each reasoned the mechanism out correctly. Every one of those sites carries
 * a comment explaining that a bare locator is a strict-mode violation and that
 * `.first()` would be wrong — and data-table-platform's even says "strict mode
 * throws immediately — the 15s never applies". The understanding was right and
 * the two-statement form still followed, each copy citing the previous one. A
 * sixth copy is the default outcome without something mechanical.
 *
 * Use `expectSettledSingle` from `e2e-utils.ts`, which re-checks both together.
 *
 * ## Scope and its denominator
 *
 * Every `tests/e2e/**` spec, comments blanked so the prose at those five sites
 * — which necessarily quotes the forbidden shape — cannot trip it. Strings are
 * KEPT, because the locator expression is the identity being compared and two
 * different test ids must not blank into each other.
 *
 * Only a count of exactly 1 is in scope: `toHaveCount(0)` is an absence
 * assertion and carries none of this, and a count of N is not a strict-mode
 * precondition.
 *
 * The population is clean as of this commit, which is precisely why the control
 * below matters — a detector with nothing left to find reads identical to one
 * that no longer works.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { collectSourceFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** An action between the two assertions legitimately re-opens the window. */
const ACTIONS = ['.click(', '.fill(', '.press(', '.goto(', '.selectOption(', '.check('];

/**
 * The locator expression inside `expect( … )`, by BALANCED parens, plus the
 * method chained onto it. A regex cannot do this: `expect(page.getByTestId('x'))`
 * has nested parens, so a lazy `.+?` stops at the first one.
 */
function expectCall(line: string): { locator: string; method: string } | null {
    const at = line.indexOf('expect(');
    if (at === -1) return null;
    let depth = 0;
    let i = at + 'expect'.length;
    for (; i < line.length; i++) {
        if (line[i] === '(') depth++;
        else if (line[i] === ')') {
            depth--;
            if (depth === 0) break;
        }
    }
    if (depth !== 0) return null; // the call spans lines — not this shape
    const locator = line.slice(at + 'expect('.length, i).trim();
    const m = /^\s*\)?\s*\.\s*(?:not\s*\.\s*)?([A-Za-z]+)\s*\(/.exec(line.slice(i));
    if (!m) return null;
    return { locator, method: m[1] };
}

interface Offence {
    file: string;
    line: number;
    locator: string;
    method: string;
}

function scan(
    src: string,
    label: string,
): { offences: Offence[]; countSites: number; parsed: number } {
    const lines = blankNonCode(src).split('\n');
    const offences: Offence[] = [];
    let countSites = 0;
    let parsed = 0;

    for (let i = 0; i < lines.length; i++) {
        const call = expectCall(lines[i]);
        if (call) parsed++;
        if (!call || call.method !== 'toHaveCount') continue;
        if (!/toHaveCount\(\s*1\s*[,)]/.test(lines[i])) continue;
        countSites++;

        let looked = 0;
        for (let j = i + 1; j < lines.length && looked < 3; j++) {
            if (lines[j].trim() === '') continue;
            looked++;
            if (ACTIONS.some((a) => lines[j].includes(a))) break;
            const next = expectCall(lines[j]);
            if (next && next.locator === call.locator) {
                offences.push({ file: label, line: j + 1, locator: next.locator, method: next.method });
                break;
            }
        }
    }
    return { offences, countSites, parsed };
}

const SPECS = collectSourceFiles({ roots: ['tests/e2e'], extensions: ['.ts'] }).filter((f) =>
    f.endsWith('.spec.ts'),
);

describe('a count-of-one barrier is one observation, not two statements', () => {
    it('control: the detector finds the shape it forbids', () => {
        // THE POSITIVE CONTROL. The real population is clean, so without this
        // every assertion below would also pass with `expectCall` returning
        // null for everything — a guard that cannot fail is green for ever.
        const fixture = [
            "const pill = page.locator('#x');",
            'await expect(pill).toHaveCount(1, { timeout: 15000 });',
            'await expect(pill).toBeVisible();',
        ].join('\n');

        const { offences, countSites } = scan(fixture, 'fixture');
        expect(countSites).toBe(1);
        expect(offences).toHaveLength(1);
        expect(offences[0].method).toBe('toBeVisible');

        // The nested-paren form too, which is what defeats a naive regex and
        // is the shape four of the five real sites had.
        const nested = [
            "await expect(page.getByTestId('page-header-title')).toHaveCount(1, { timeout: 30000 });",
            "await expect(page.getByTestId('page-header-title')).toContainText('Administration');",
        ].join('\n');
        const n = scan(nested, 'fixture');
        expect(n.offences).toHaveLength(1);
        expect(n.offences[0].locator).toBe("page.getByTestId('page-header-title')");
        expect(n.offences[0].method).toBe('toContainText');
    });

    it('control: it does NOT flag the cases that are fine', () => {
        // A different locator, an absence assertion, and an intervening action
        // are all legitimate. A guard that flagged these would be turned off.
        const fine = [
            "await expect(page.locator('#a')).toHaveCount(1);",
            "await expect(page.locator('#b')).toBeVisible();",
            "await expect(page.locator('#t')).toHaveCount(0);",
            "await expect(page.locator('#t')).toBeVisible();",
            "await expect(page.locator('#c')).toHaveCount(1);",
            "await page.locator('#c').click();",
            "await expect(page.locator('#c')).toBeVisible();",
        ].join('\n');

        expect(scan(fine, 'fixture').offences).toEqual([]);
        // …and it still SAW the in-scope sites, so the empty result above is
        // a verdict rather than a failure to parse.
        expect(scan(fine, 'fixture').countSites).toBe(2);
    });

    it('control: comments are blanked, so the prose at the fixed sites cannot trip it', () => {
        const prose = [
            '// This used to be two statements:',
            "//     await expect(pill).toHaveCount(1, { timeout: 15000 });",
            '//     await expect(pill).toBeVisible();',
            'await expectSettledSingle(pill, { timeout: 15000 });',
        ].join('\n');

        const { offences, countSites } = scan(prose, 'fixture');
        expect(countSites).toBe(0);
        expect(offences).toEqual([]);
    });

    it('scans a real population', () => {
        // The denominator, printed rather than implied: a guard scoped to
        // nothing passes for the wrong reason.
        expect(SPECS.length).toBeGreaterThanOrEqual(40);
    });

    it('no spec re-opens the window', () => {
        const all: Offence[] = [];
        let sites = 0;
        let parsedCalls = 0;
        for (const abs of SPECS) {
            const rel = path.relative(REPO_ROOT, abs);
            const { offences, countSites, parsed } = scan(fs.readFileSync(abs, 'utf8'), rel);
            all.push(...offences);
            sites += countSites;
            parsedCalls += parsed;
        }

        // LIVENESS, and deliberately not `sites > 0`.
        //
        // That was the first version of this assertion and it failed the
        // moment the fix landed: converting all five call sites left ZERO
        // in-scope `toHaveCount(1)` sites, so a guard anchored to the defect's
        // own precondition cannot pass on a clean tree. The property worth
        // asserting is that the PARSER ran over real spec code — which the
        // population keeps having regardless of whether the defect does.
        expect(parsedCalls).toBeGreaterThan(200);

        if (all.length > 0) {
            throw new Error(
                `${all.length} count-of-one barrier(s) followed by a separate assertion on the ` +
                    `SAME locator (${sites} in-scope site(s) scanned across ${SPECS.length} specs):\n` +
                    all.map((o) => `  ${o.file}:${o.line}  .${o.method}() on ${o.locator}`).join('\n') +
                    `\n\n` +
                    `\`toHaveCount(1)\` returns on its first sight of one, so the assertion after ` +
                    `it can re-query into the double it was supposed to have waited out — and a ` +
                    `strict-mode violation throws immediately, so the timeout above never ` +
                    `applies.\n` +
                    `Use \`expectSettledSingle\` from tests/e2e/e2e-utils.ts, which re-checks ` +
                    `both together; pass \`also\` if the second assertion is not visibility.`,
            );
        }
        expect(all).toEqual([]);
    });
});
