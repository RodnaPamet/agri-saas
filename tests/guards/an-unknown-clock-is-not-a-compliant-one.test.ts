/**
 * Guard: a status resolver that accepts `now: Date | null` must not answer
 * "compliant" on its nil branch (#2039, from #2033).
 *
 * ## The defect
 *
 * `getRetentionStatus` in `EvidenceClient` opened with
 *
 *     if (!now) return { label: t('client.retentionActive'), badge: 'success' };
 *
 * so a caller that could not supply a clock was told everything was fine. In
 * #2033 exactly such a caller existed — a memo captured `hydratedNow` without
 * depending on it, froze on null, and every retained record rendered as a
 * green "Active" badge while its retention date passed. On a БАБХ compliance
 * surface that is the wrong answer in the direction that matters.
 *
 * Fixing the caller was necessary and is not sufficient: the resolver stayed
 * willing to reassure the next one.
 *
 * ## Why not simply read the clock, as `resolveFreshness` does
 *
 * Its sibling one directory over does `const reference = now ?? new Date()`,
 * and for that function it is right. It is NOT right here. These resolvers
 * run during render, so a server read and a client read either side of a day
 * boundary disagree, and the UI hydrates with two different badges — React
 * #418/#422, which is the entire reason `useHydratedNow()` returns null for
 * the first frame. A fallback that reads the clock would trade a wrong badge
 * for a hydration error.
 *
 * The answer available to a render-path resolver is therefore neither "fine"
 * nor a guess: it is "not yet known". That is what this guard pins.
 *
 * ## What it covers, and what it does not
 *
 * It reads the nil-guard early return of every function in `src/` that takes
 * a `now: Date | null` parameter, and fails if that return carries a
 * success-shaped badge or level. It cannot judge a resolver that encodes the
 * same mistake without an early return — a ternary deep in a template, say.
 * The honest claim is "no nil-guard early return says everything is fine",
 * which is the shape both instances of this bug actually took.
 */
import { readFileSync } from 'node:fs';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/** A badge/level literal that tells the reader nothing is wrong. */
const REASSURING = /\b(?:badge|level|variant)\s*:\s*'(success|fresh|ok|current|valid)'/;

/** `now: Date | null` / `now?: Date` in a parameter list. */
const NULLABLE_NOW = /\bnow\s*\??\s*:\s*Date\s*(?:\|\s*null)?/;

interface Finding {
    file: string;
    fn: string;
    text: string;
}

function scan(): { resolvers: number; findings: Finding[] } {
    const files = collectSourceFiles({ roots: ['src'], extensions: ['.ts', '.tsx'], floor: 500 });
    const findings: Finding[] = [];
    let resolvers = 0;

    for (const abs of files) {
        const raw = readFileSync(abs, 'utf8');
        if (!raw.includes('Date | null') && !raw.includes('Date|null')) continue;
        // Blanked: this file's own docblock quotes the defective line, and
        // the guard it describes would otherwise report itself (#1774).
        const code = blankNonCode(raw);
        const rel = abs.slice(REPO_ROOT.length + 1);

        const signatures = [...code.matchAll(/function\s+(\w+)\s*\(([^)]*)\)/g)]
            .filter((m) => NULLABLE_NOW.test(m[2]));
        if (!signatures.length) continue;
        resolvers += signatures.length;

        // Scan the WHOLE file for nil-guard returns rather than a window
        // from each signature.
        //
        // A fixed window was the first attempt and it was wrong, which the
        // mutation proof caught: `blankNonCode` preserves character
        // POSITIONS, so a blanked docblock between the signature and the
        // branch still consumes the budget. Adding the comment that explains
        // this very defect pushed the branch past 1200 characters and the
        // guard went blind on the file it was written for — the
        // `budget-a-window-on-something-the-source-has` failure, committed
        // while guarding against a sibling of it.
        //
        // Attribution to a specific function is not worth that fragility:
        // `if (!now)` is unambiguous enough that the file plus the nearest
        // preceding signature names the site well.
        for (const g of code.matchAll(/if\s*\(\s*!\s*now\s*\)\s*return\s*([^;]{0,200});/g)) {
            if (!REASSURING.test(g[1])) continue;
            const before = signatures.filter((m) => m.index! < g.index!).pop();
            findings.push({
                file: rel,
                fn: before ? before[1] : '(top level)',
                text: g[1].trim().slice(0, 120),
            });
        }
    }
    return { resolvers, findings };
}

describe('an unknown clock is not a compliant one (#2039)', () => {
    const { resolvers, findings } = scan();

    it('ranges over the real population — the denominator', () => {
        console.log(
            `[unknown-clock] ${resolvers} function(s) take a nullable \`now\`; ${findings.length} answer "fine" when it is absent`,
        );
        // If this hits zero the guard has stopped covering anything — the
        // parameter was renamed, or the regex rotted. Either way it should
        // fail rather than pass on an empty scan.
        expect(resolvers).toBeGreaterThan(0);
    });

    it('detects a reassuring nil branch, and accepts an honest one — the control', () => {
        const bad = `function f(ev: any, now: Date | null) {
            if (!now) return { label: t('x'), badge: 'success', icon: '' };
        }`;
        const good = bad.replace("badge: 'success'", "badge: 'neutral'");
        const check = (src: string) => {
            const g = /if\s*\(\s*!\s*now\s*\)\s*return\s*([^;]{0,200});/.exec(src)!;
            return REASSURING.test(g[1]);
        };
        expect(check(bad)).toBe(true);
        expect(check(good)).toBe(false);
    });

    it('no resolver reports compliance from an unknown clock', () => {
        expect(
            findings.map((f) => `  ${f.file}: ${f.fn}() -> ${f.text}`).join('\n'),
        ).toBe('');
    });
});
