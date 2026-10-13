/**
 * Epic E — API Contract Completeness guardrail.
 *
 * Enforces that EVERY route handler under `src/app/api/**\/route.ts`
 * either:
 *   (a) imports + uses `withApiErrorHandling` (the canonical path), OR
 *   (b) appears in `BARE_ROUTE_EXEMPTIONS` with a written reason.
 *
 * Three failure modes the guard catches:
 *
 *   1. **Coverage gap** — a new bare route landed without a written
 *      exemption. Fail with the route path + a pointer to the
 *      exemption file.
 *
 *   2. **Stale exemption (route now wrapped)** — a route was wrapped
 *      but its exemption entry wasn't removed. Dead taxonomy.
 *
 *   3. **Stale exemption (file gone)** — the route file was deleted
 *      without removing its exemption. Garbage collection.
 *
 * The guard also runs an in-memory mutation regression: stripping
 * `withApiErrorHandling` from a known-wrapped route MUST trip the
 * detector. This proves the detector isn't vacuously passing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BARE_ROUTE_EXEMPTIONS } from '@/lib/errors/route-exemptions';
import { blankNonCode } from '../helpers/blank-non-code';

const REPO_ROOT = path.resolve(__dirname, '../..');
const API_ROOT = path.join(REPO_ROOT, 'src/app/api');

const WRAPPER_TOKEN = 'withApiErrorHandling';

function listAllRoutes(): string[] {
    const out: string[] = [];
    function walk(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(abs);
            } else if (entry.name === 'route.ts') {
                out.push(abs);
            }
        }
    }
    walk(API_ROOT);
    return out.sort();
}

function relPath(absPath: string): string {
    return path.relative(API_ROOT, absPath);
}

/**
 * The token is looked for in CODE, with comments and strings blanked.
 *
 * ## Why this is not a loosening
 *
 * The last case in this file already knew the hazard — "a route that mentions
 * `withApiErrorHandling` only in a comment / string would pass the
 * wrapped-check but actually be bare" — and answered it by failing such a
 * route for not importing the wrapper. That catches the route, and it leaves a
 * hole one step earlier: a bare route whose docblock merely NAMES the wrapper
 * reads as wrapped, so `every bare route is in BARE_ROUTE_EXEMPTIONS` skips it
 * entirely and it never needs a written reason.
 *
 * Blanking first closes that hole. The route is then classified by its CODE,
 * the exemption registry sees it, and the import check keeps its teeth for the
 * case it was written for — a route that really does call the wrapper without
 * importing it.
 *
 * Measured before changing: across 388 route files, exactly ONE is classified
 * differently (`webhooks/resend/route.ts`, whose docblock explains why it is
 * deliberately bare). So this is not a quiet re-grading of the surface.
 *
 * ## `blankNonCode`, not a local stripper
 *
 * My first version was `.replace(BLOCK_RE, '').replace(LINE_RE, '')` — blocks
 * before lines, which is exactly the defect
 * `tests/guards/comment-stripper-order.test.ts` exists to forbid, on a ratchet
 * whose effective cap for a TypeScript stripper is 0. A line comment naming a
 * glob such as `/api/auth/` + star opens a block as far as that regex is
 * concerned and eats every real line to the next close marker; measured there
 * at 511 lines lost across nine files. `blankNonCode` is state-aware, cannot
 * be fooled by either nesting, and blanks character-for-character so
 * positions hold.
 *
 * `{ strings: true }` because this guard's subject is a CALL, not message
 * text — the helper's own docblock draws that line, and a token inside a
 * string literal is no more a call than one inside a comment.
 */
function isWrapped(content: string): boolean {
    return blankNonCode(content, { strings: true }).includes(WRAPPER_TOKEN);
}

describe('Epic E — API error-handler coverage guardrail', () => {
    const allRoutes = listAllRoutes();
    const exemptionPaths = new Set(BARE_ROUTE_EXEMPTIONS.map((e) => e.file));

    it('discovers a meaningful number of routes (sanity)', () => {
        // If the API surface drops below this floor we want to know
        // — the detector can't be silently neutered by `find`-rotting
        // its way to zero results. The current API has 270+ routes;
        // 100 is a generous lower bound.
        expect(allRoutes.length).toBeGreaterThan(100);
    });

    it('every bare route is in BARE_ROUTE_EXEMPTIONS', () => {
        const violations: string[] = [];
        for (const abs of allRoutes) {
            const content = fs.readFileSync(abs, 'utf8');
            if (isWrapped(content)) continue;
            const rel = relPath(abs);
            if (!exemptionPaths.has(rel)) {
                violations.push(rel);
            }
        }

        if (violations.length > 0) {
            throw new Error(
                [
                    'API routes missing withApiErrorHandling and not in the exemption registry:',
                    ...violations.map((v) => `  - ${v}`),
                    '',
                    'Fix one of two ways:',
                    '  (a) Wrap the handler with `withApiErrorHandling(...)` from @/lib/errors/api',
                    '      to inherit the standardized ApiErrorResponse contract.',
                    '  (b) If the route legitimately needs a different contract',
                    '      (k8s probe, redirect-only, anti-enumeration, webhook),',
                    '      add an entry to BARE_ROUTE_EXEMPTIONS in',
                    '      src/lib/errors/route-exemptions.ts with a written reason.',
                ].join('\n'),
            );
        }
        expect(violations).toEqual([]);
    });

    it('every exemption file actually exists on disk', () => {
        const missing: string[] = [];
        for (const entry of BARE_ROUTE_EXEMPTIONS) {
            const abs = path.join(API_ROOT, entry.file);
            if (!fs.existsSync(abs)) {
                missing.push(entry.file);
            }
        }
        if (missing.length > 0) {
            throw new Error(
                [
                    'BARE_ROUTE_EXEMPTIONS references files that no longer exist:',
                    ...missing.map((v) => `  - ${v}`),
                    '',
                    'Remove these entries from src/lib/errors/route-exemptions.ts.',
                ].join('\n'),
            );
        }
    });

    it('no exemption is dead (file exists but is now wrapped)', () => {
        const dead: string[] = [];
        for (const entry of BARE_ROUTE_EXEMPTIONS) {
            const abs = path.join(API_ROOT, entry.file);
            if (!fs.existsSync(abs)) continue; // covered by previous test
            const content = fs.readFileSync(abs, 'utf8');
            if (isWrapped(content)) {
                dead.push(entry.file);
            }
        }
        if (dead.length > 0) {
            throw new Error(
                [
                    'BARE_ROUTE_EXEMPTIONS contains entries for routes that ARE wrapped:',
                    ...dead.map((v) => `  - ${v}`),
                    '',
                    'Either remove the exemption (the route is now in canonical contract),',
                    'or remove the wrapper if the bypass is intentional.',
                ].join('\n'),
            );
        }
    });

    it('every exemption carries a non-trivial reason', () => {
        for (const entry of BARE_ROUTE_EXEMPTIONS) {
            // Reason must be substantive — a one-word "TODO" or empty
            // string slipping through review is exactly what this is
            // protecting against.
            expect(entry.reason.length).toBeGreaterThanOrEqual(40);
            expect(entry.category).toBeTruthy();
        }
    });

    it('mutation regression — stripping the wrapper from a known route trips the guard', () => {
        // Pick the smallest known-wrapped route. We don't write to
        // disk; the mutation is in-memory. If the detector still
        // reports "wrapped" on the broken variant, the regex itself
        // is meaningless.
        const target = path.join(API_ROOT, 'auth/ui-config/route.ts');
        const original = fs.readFileSync(target, 'utf8');
        expect(isWrapped(original)).toBe(true);

        const broken = original.replace(/withApiErrorHandling/g, 'noopWrapper');
        expect(isWrapped(broken)).toBe(false);
    });

    it('a token in PROSE does not make a bare route read as wrapped', () => {
        // The other direction, and the one that was wrong: a docblock
        // explaining why a route is deliberately unwrapped must not classify
        // it as wrapped — that skipped it past the exemption registry, where
        // the written reason is supposed to live.
        const proseOnly = [
            '/**',
            ' * A bare POST, outside withApiErrorHandling, because the wrapper',
            ' * applies the mutation rate limiter.',
            ' */',
            "const NOTE = 'see withApiErrorHandling for the contract';",
            'export async function POST() { return new Response(NOTE); }',
        ].join('\n');

        expect(isWrapped(proseOnly)).toBe(false);
    });

    it('the strip does not blind the detector to real code', () => {
        // The control for the case above. A strip aggressive enough to remove
        // the call itself would make every route read as bare, which this
        // file's own coverage check would then report as 300+ violations —
        // loud, but only after someone wondered why.
        const realCode = [
            "import { withApiErrorHandling } from '@/lib/errors/api';",
            'export const GET = withApiErrorHandling(async () => new Response());',
        ].join('\n');

        expect(isWrapped(realCode)).toBe(true);
        // And with the import line commented out, the CALL still counts.
        expect(isWrapped('export const GET = withApiErrorHandling(async () => {});')).toBe(true);
    });

    it('every wrapped route imports the wrapper from @/lib/errors/api', () => {
        // A route that mentions `withApiErrorHandling` only in a
        // comment / string would pass the wrapped-check but actually
        // be bare. Confirm the wrapper is reached through a real
        // import. Allow either single- or double-quoted form.
        const wrappedNoImport: string[] = [];
        for (const abs of allRoutes) {
            const content = fs.readFileSync(abs, 'utf8');
            if (!isWrapped(content)) continue;
            const hasImport =
                /from\s+['"]@\/lib\/errors\/api['"]/.test(content);
            if (!hasImport) wrappedNoImport.push(relPath(abs));
        }
        if (wrappedNoImport.length > 0) {
            throw new Error(
                [
                    'Routes mention withApiErrorHandling but do not import it from @/lib/errors/api:',
                    ...wrappedNoImport.map((v) => `  - ${v}`),
                ].join('\n'),
            );
        }
    });
});
