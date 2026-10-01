/**
 * No API route may read `?limit=` in a way that lets NaN through.
 *
 * ## The defect
 *
 * Four routes read it as `limitRaw ? Number(limitRaw) : undefined`, and
 * `Number('abc')` is NaN. Nothing downstream stopped it — `??` catches null
 * and undefined but not NaN, and Math.min / Math.max propagate it — so
 * `take: NaN` reached Prisma and `?limit=abc` was a 500 on a plain list read.
 *
 * ## Why a derived guard rather than a fixed list
 *
 * The fix was four call sites, and the population is the thing that moves: a
 * new list route is written by copying an existing one, which is how all four
 * came to share the expression. So the route set is DERIVED from the
 * filesystem — a new route is covered the moment it exists — and the
 * behaviour of the parser itself is covered by executing tests in
 * `tests/unit/limit-param.test.ts`, not here.
 *
 * Two routes predate `parseLimitParam` and handle NaN themselves. They are
 * exempt BY NAME and the exemption is not a free pass: each is asserted to
 * still contain its own finite check, so an exemption cannot rot into a hole
 * while keeping its reason.
 */
import * as fs from 'fs';
import * as path from 'path';

import { collectSourceFiles } from '../helpers/collect-files';

const ROOT = path.resolve(__dirname, '../..');
const API = path.join(ROOT, 'src/app/api');

/** Routes that do their own NaN-safe parsing, with the reason each is exempt. */
const SELF_GUARDED: Record<string, { reason: string; mustContain: string }> = {
    't/[tenantSlug]/search/route.ts': {
        reason:
            'Local `parseLimit` predates the shared helper and is already NaN-safe. It ' +
            'deliberately FALLS BACK rather than rejecting, which is an established ' +
            'contract for the search box; changing it is a product decision, not a bug fix.',
        mustContain: 'Number.isFinite',
    },
    'org/[orgSlug]/portfolio/route.ts': {
        reason:
            'Inline `Number.isFinite(parsed) && parsed > 0` block in its own param reader. ' +
            'Same fallback contract as search.',
        mustContain: 'Number.isFinite',
    },
};

// The SHARED collector, not a hand-rolled walk: it refuses an empty result,
// which is the whole hazard here — a gutted collector leaves every assertion
// below green. `file-collection-is-not-silently-empty` enforces this, and it
// caught the first draft of this file.
const all = collectSourceFiles({
    roots: ['src/app/api'],
    extensions: ['.ts'],
    exclude: (rel) => !rel.endsWith('route.ts'),
    floor: 200,
});
const readsLimit = all.filter((f) =>
    /searchParams\.get\(\s*['"]limit['"]\s*\)/.test(fs.readFileSync(f, 'utf8')),
);
const rel = (f: string) => path.relative(API, f).split(path.sep).join('/');

describe('?limit= is NaN-safe on every route that reads it', () => {
    // ── Controls ─────────────────────────────────────────────────────
    //
    // The assertion below is "this list is empty", which an empty POPULATION
    // also satisfies. A glob that stops matching would read as a clean pass.

    it('control: the route population is real', () => {
        expect(all.length).toBeGreaterThan(200);
    });

    it('control: routes reading `limit` were actually found', () => {
        expect(readsLimit.length).toBeGreaterThan(3);
        // The two exempt ones must be IN the derived set, or the exemption
        // list is describing files this scan never looks at.
        for (const name of Object.keys(SELF_GUARDED)) {
            expect(readsLimit.map(rel)).toContain(name);
        }
    });

    // ── The rule ─────────────────────────────────────────────────────

    it('every route reading `limit` parses it safely', () => {
        const offenders = readsLimit
            .filter((f) => !(rel(f) in SELF_GUARDED))
            .filter((f) => !fs.readFileSync(f, 'utf8').includes('parseLimitParam'));

        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} route(s) read \`?limit=\` without a NaN-safe parser:\n` +
                    offenders.map((f) => `  ${rel(f)}`).join('\n') +
                    `\n\n\`Number('abc')\` is NaN, \`??\` does not catch NaN, and Math.min/max\n` +
                    `propagate it — so \`take: NaN\` reaches Prisma and the route 500s on\n` +
                    `\`?limit=abc\`. Use \`parseLimitParam\` from @/lib/validation/query-params,\n` +
                    `or add an entry to SELF_GUARDED with a written reason and its own\n` +
                    `finite check.`,
            );
        }
        expect(offenders).toEqual([]);
    });

    it('no banned expression survives anywhere', () => {
        // Belt and braces: catches the shape even in a file that ALSO imports
        // the parser, which the per-file check above would pass.
        const banned = readsLimit.filter((f) =>
            /limit:\s*limitRaw\s*\?\s*Number\(/.test(fs.readFileSync(f, 'utf8')),
        );
        expect(banned.map(rel)).toEqual([]);
    });

    it('each SELF_GUARDED route still carries its own finite check', () => {
        for (const [name, { mustContain }] of Object.entries(SELF_GUARDED)) {
            const f = readsLimit.find((x) => rel(x) === name);
            expect(f).toBeDefined();
            expect(fs.readFileSync(f!, 'utf8')).toContain(mustContain);
        }
    });

    it('SELF_GUARDED only shrinks — no stale entries', () => {
        const stale = Object.keys(SELF_GUARDED).filter((n) => !readsLimit.map(rel).includes(n));
        expect(stale).toEqual([]);
    });

    it('every exemption carries a real reason', () => {
        for (const [, { reason }] of Object.entries(SELF_GUARDED)) {
            expect(reason.length).toBeGreaterThan(60);
        }
    });
});
