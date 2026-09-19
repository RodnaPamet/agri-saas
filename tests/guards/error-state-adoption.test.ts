/**
 * Roadmap-11 PR-3 — ErrorState adoption on route-level boundaries.
 *
 * Every Next.js `error.tsx` route file now routes its recovery
 * chrome through the shared `<ErrorState>` primitive. Without this
 * rule, page-level error boundaries silently drift away from the
 * canonical shape — different icons, different button hierarchy,
 * different vocabulary. The `<ErrorState>` primitive enforces the
 * tokens, the layout, and the action shape in one place.
 *
 * The ratchet locks two invariants:
 *
 *   1. `<ErrorState>` primitive in `src/components/ui/error-state.tsx`
 *      stays canonical (alert role, content-error icon tint, retry
 *      button via `onRetry` prop).
 *
 *   2. Every `error.tsx` under `src/app/**` either mounts
 *      `<ErrorState>` OR appears in EXEMPTIONS with a written reason.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Files that intentionally do NOT use `<ErrorState>`. None today.
 * A future global error.tsx that has a completely different shape
 * (e.g. an offline page) could land here with a written reason.
 */
const EXEMPTIONS: Record<string, string> = {};

function walk(dir: string, results: string[] = []): string[] {
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
            walk(full, results);
        } else if (entry.name === 'error.tsx') {
            results.push(full);
        }
    }
    return results;
}

describe('ErrorState adoption (R11-PR3)', () => {
    // ── Controls (#971) ──────────────────────────────────────────────
    //
    // `selector-teeth` gutted `walk` and NOT ONE test failed. Its only
    // call site is the `for (const file of walk(...))` loop below, so
    // every EMPTY-ITERABLE gut — `[]`, `''`, `new Set()`, `new Map()` —
    // runs that loop zero times: `offenders` stays empty, the
    // `offenders.length > 0` throw never fires, green. (The five
    // non-iterable guts — `0` / `null` / `undefined` / `false` / `{}` —
    // throw at the for-of, so the hole is exactly the direction the tool
    // reaches.) Worse, that test ends with NO `expect` at all: its only
    // assertion is the conditional throw, so "two boundaries checked"
    // and "no file was ever opened" are the same result.
    //
    // The `fs.existsSync` floor INSIDE `walk` (#875) does not cover it —
    // gutting replaces the whole function, so that check never runs. A
    // floor one layer down cannot protect a caller that stops calling
    // it, which is why it is asserted explicitly below.
    //
    // The sibling test ('the shared ErrorState primitive ...') reads
    // error-state.tsx directly and never touches `walk`.

    const APP_ROOT = path.resolve(ROOT, 'src/app');

    it('control: walk collects the real error.tsx population, recursively', () => {
        const files = walk(APP_ROOT);
        // Kills `''` / `new Set()` / `new Map()` at the seam instead of
        // letting them read as a zero-length scan.
        expect(Array.isArray(files)).toBe(true);

        const fromScanRoot = files.map((f) =>
            path.relative(APP_ROOT, f).split(path.sep).join('/'),
        );
        // Measured 2026-09-19: exactly TWO `error.tsx` files under
        // `src/app`, out of 588 files in that tree. The population is
        // small BY CONSTRUCTION — Next mints one boundary per route
        // segment that wants one — so both are NAMED rather than covered
        // by a floor far below reality. An empty scan and a half-scan
        // both fail here.
        expect(fromScanRoot).toContain('error.tsx');
        // RECURSION is the one behaviour a constant return cannot
        // express: this boundary sits three directories down, so reaching
        // it means `walk` descended rather than read one directory.
        expect(fromScanRoot).toContain('t/[tenantSlug]/(app)/error.tsx');
        expect(files.length).toBeGreaterThanOrEqual(2);

        // Its ONE filter is the exact filename, and it must BITE.
        // `src/app/global-error.tsx` is a live near-miss from real
        // product source that an `endsWith('error.tsx')` scan would
        // collect — and it mounts no <ErrorState>, so collecting it would
        // turn this ratchet red on a file it never meant to police.
        expect(fs.existsSync(path.join(APP_ROOT, 'global-error.tsx'))).toBe(
            true,
        );
        expect(fromScanRoot).not.toContain('global-error.tsx');
        expect(files.every((f) => path.basename(f) === 'error.tsx')).toBe(true);

        // EXEMPTIONS is `{}` today, so this is vacuous NOW and becomes a
        // no-stale check the moment an entry lands: a carve-out naming a
        // path `walk` cannot reach would silence nothing and hide that.
        const fromRepoRoot = files.map((f) =>
            path.relative(ROOT, f).split(path.sep).join('/'),
        );
        expect(
            Object.keys(EXEMPTIONS).filter((rel) => !fromRepoRoot.includes(rel)),
        ).toEqual([]);
    });

    it('control: walk refuses a scan root that does not exist (#875)', () => {
        // That floor lives INSIDE `walk`, so it is dropped silently by
        // anything that replaces the body. Asserted here, at the level
        // that survives, it is what keeps a renamed root from reading as
        // "zero offenders".
        const missing = path.resolve(ROOT, 'src/app-this-path-does-not-exist');
        expect(fs.existsSync(missing)).toBe(false);
        expect(() => walk(missing)).toThrow(/scan root does not exist/);
    });

    it('control: the adoption check separates a compliant boundary from a stripped one', () => {
        // No live offender exists by construction — both boundaries
        // comply and EXEMPTIONS is empty — so the positive is
        // MANUFACTURED from real product source: a real `error.tsx` with
        // its import, then its mount, removed. Derived from the file's
        // own bytes, so it cannot go stale.
        const importRe = /from\s+['"]@\/components\/ui\/error-state['"]/;
        const mountRe = /<ErrorState\b/;

        const real = fs.readFileSync(path.join(APP_ROOT, 'error.tsx'), 'utf-8');
        // Clean negative: the shipped file satisfies BOTH halves.
        expect(importRe.test(real)).toBe(true);
        expect(mountRe.test(real)).toBe(true);

        // Planted positives, one half at a time. The check below is
        // `if (!imports || !mounts)`, so EITHER miss is an offence and
        // both must flip — and each mutation must leave the other half
        // intact, or it proves nothing about which half was detected.
        const noImport = real.replace(
            importRe,
            "from '@/components/ui/empty-state'",
        );
        expect(importRe.test(noImport)).toBe(false);
        expect(mountRe.test(noImport)).toBe(true);

        const noMount = real.replace(/<ErrorState\b/g, '<EmptyState');
        expect(mountRe.test(noMount)).toBe(false);
        expect(importRe.test(noMount)).toBe(true);

        // The denominator beside the answer: the main test's silent "no
        // offenders" is a fact about EVERY walked file, not about an
        // empty list. Measured 2026-09-19: 2 of 2 comply.
        const scanned = walk(APP_ROOT);
        const compliant = scanned.filter((f) => {
            const src = fs.readFileSync(f, 'utf-8');
            return importRe.test(src) && mountRe.test(src);
        });
        expect(scanned.length).toBeGreaterThanOrEqual(2);
        expect(compliant).toHaveLength(scanned.length);
    });
    test('the shared ErrorState primitive preserves its canonical shape', () => {
        const src = fs.readFileSync(
            path.resolve(ROOT, 'src/components/ui/error-state.tsx'),
            'utf-8',
        );
        // alert role for accessibility
        expect(src).toMatch(/role="alert"/);
        // content-error tint on the icon
        expect(src).toMatch(/text-content-error/);
        // bg-bg-error wrap on the icon
        expect(src).toMatch(/bg-bg-error/);
        // onRetry → primary button labelled retryLabel (default 'Try again')
        expect(src).toMatch(/onRetry/);
        expect(src).toMatch(/retryLabel/);
    });

    test('every error.tsx route file imports + mounts <ErrorState>', () => {
        const offenders: string[] = [];
        for (const file of walk(path.resolve(ROOT, 'src/app'))) {
            const rel = path.relative(ROOT, file);
            if (EXEMPTIONS[rel]) continue;
            const src = fs.readFileSync(file, 'utf-8');
            const imports = /from\s+['"]@\/components\/ui\/error-state['"]/.test(src);
            const mounts = /<ErrorState\b/.test(src);
            if (!imports || !mounts) {
                offenders.push(rel);
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} error.tsx file(s) don't route through <ErrorState>:\n  ` +
                    offenders.join('\n  ') +
                    '\n\nFix: import ErrorState from `@/components/ui/error-state` and mount it inside the error boundary. The primitive owns the alert role, icon tint, retry button shape, and secondary action.\n' +
                    'OR add the file path to EXEMPTIONS with a reason if the boundary intentionally renders a different surface.',
            );
        }
    });
});
