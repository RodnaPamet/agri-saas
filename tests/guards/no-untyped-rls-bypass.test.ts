/**
 * An RLS bypass must NAME ITS REASON. P1.7.
 *
 * ── what this is really guarding ──
 *
 * `src/lib/db/rls-middleware.ts` has carried `runWithoutRls({ reason })` for a
 * long time: a closed union of reasons, a runtime rejection of anything not in
 * it, and an info-level log with a caller fingerprint so an audit can
 * enumerate every bypass without grepping. It has unit tests and an
 * integration test.
 *
 * Measured 2026-10-02, before P1.7: it had **ZERO production call sites**. All
 * eighteen references outside its own module were tests. Meanwhile four real
 * bypasses went through `runInGlobalContext` next door — no reason, no record,
 * no constraint, and a docblock ("use this SAFELY and specifically for
 * unauthenticated public routes") that described none of the four actual
 * callers.
 *
 * So the control was code-complete, test-green and inert, with the untyped
 * door still open beside it. That is the shape this file exists to prevent
 * recurring, and it is why the second assertion matters as much as the first:
 * a guard that only banned the old name would be perfectly satisfied by a
 * codebase that had deleted both and bypassed RLS some third way.
 */
import fs from 'fs';
import path from 'path';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

/** Mask comments so a name discussed in prose is not counted as a call. */
function codeOf(source: string): string {
    return blankNonCode(source);
}

const FILES = collectSourceFiles({
    roots: ['src'],
    // High enough that a broken collector fails rather than reporting a tidy
    // zero over an empty set.
    floor: 500,
}).map((abs) => ({
    rel: path.relative(REPO_ROOT, abs).split(path.sep).join('/'),
    code: codeOf(fs.readFileSync(abs, 'utf8')),
}));

/** Files that CALL a symbol (not merely mention or re-export it). */
function callersOf(symbol: string): string[] {
    const re = new RegExp('\\b' + symbol + '\\s*\\(');
    return FILES.filter((f) => re.test(f.code)).map((f) => f.rel);
}

describe('the untyped RLS bypass is gone', () => {
    it('reports the population, so a zero would be visible', () => {
        expect(FILES.length).toBeGreaterThan(500);
    });

    it('`runInGlobalContext` appears NOWHERE in src', () => {
        // P1's exit criterion is "0 runInGlobalContext imports". Checked as
        // "no occurrence in code at all", which also catches a re-export or a
        // local re-definition under the same name.
        const offenders = FILES.filter((f) => /\brunInGlobalContext\b/.test(f.code)).map(
            (f) => f.rel,
        );
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} file(s) still reference runInGlobalContext:\n  ` +
                    offenders.join('\n  ') +
                    `\n\nUse runWithoutRls({ reason }) from @/lib/db/rls-middleware. ` +
                    `If no existing reason fits, adding one is a review checkpoint — ` +
                    `which is the entire point of the closed union.`,
            );
        }
    });
});

describe('the typed bypass is actually USED — not a control that only exists', () => {
    it('runWithoutRls has real production call sites', () => {
        // The assertion that would have caught the original defect. Before
        // P1.7 this was ZERO while four bypasses ran next door.
        const callers = callersOf('runWithoutRls').filter(
            (rel) => rel !== 'src/lib/db/rls-middleware.ts',
        );
        expect(callers.length).toBeGreaterThanOrEqual(2);
    });

    it('the bypass sites are RATCHETED, so a new one is a visible diff', () => {
        // Bypasses should not multiply quietly. This is a ceiling on files, not
        // a ban: raising it means saying out loud that another part of the
        // product now reads across tenants.
        const callers = callersOf('runWithoutRls').filter(
            (rel) => rel !== 'src/lib/db/rls-middleware.ts',
        );
        expect(callers.length).toBeLessThanOrEqual(3);
    });

    it('every bypass site names a reason from the union', () => {
        // The compiler already enforces the TYPE. What it cannot enforce is
        // that the call passes a reason at all through an `any`-shaped seam, so
        // the shape is checked textually at each site.
        const reasonless: string[] = [];
        for (const f of FILES) {
            if (f.rel === 'src/lib/db/rls-middleware.ts') continue;
            for (const m of f.code.matchAll(/runWithoutRls\s*\(([^)]{0,80})/g)) {
                if (!/reason\s*:/.test(m[1])) reasonless.push(`${f.rel}: ${m[1].trim()}`);
            }
        }
        expect(reasonless).toEqual([]);
    });
});

describe('the detector has teeth', () => {
    it('sees a call and ignores a mention in prose', () => {
        // Without this, a file that merely discusses the helper in a docblock
        // would register as a caller and the ratchet would count fiction.
        expect(codeOf('const x = runInGlobalContext(fn);')).toContain('runInGlobalContext');
        expect(codeOf('// runInGlobalContext would be wrong here')).not.toContain(
            'runInGlobalContext',
        );
        expect(codeOf('/* uses runInGlobalContext internally */')).not.toContain(
            'runInGlobalContext',
        );
    });

    it('a reasonless call is detected', () => {
        // Proven against a synthetic source rather than against zero real
        // matches — an exemption nothing exercises is one nobody can trust.
        const bad = codeOf('await runWithoutRls(async (db) => db.tenant.findMany());');
        expect(/runWithoutRls\s*\(([^)]{0,80})/.exec(bad)?.[1] ?? '').not.toMatch(/reason\s*:/);
        const good = codeOf("await runWithoutRls({ reason: 'seed' }, async (db) => db.x());");
        expect(/runWithoutRls\s*\(([^)]{0,80})/.exec(good)?.[1] ?? '').toMatch(/reason\s*:/);
    });
});
