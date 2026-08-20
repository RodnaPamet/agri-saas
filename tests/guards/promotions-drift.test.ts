/**
 * Promotions — structural drift guard (issue #652).
 *
 * `Promotion` and `Company` are GLOBAL rows: no `tenantId`, no RLS. What
 * separates one farm's admin from the shared catalogue is a line of code in
 * each route — `assertPlatformSupport(ctx)` — and what separates an operator
 * from an arbitrary outbound link is a scheme constraint in one schema file.
 * Neither is enforced by a type, so both drift silently.
 *
 * Six behavioural suites already cover the LOGIC (`tests/unit/promotion-*`).
 * This file covers the two enforcement points, which is the gap the
 * 2026-08-19 enforcement-seam audit was about: the mechanism gets a unit
 * suite, the enforcement point gets nothing.
 *
 * ── What this file does NOT claim ───────────────────────────────────
 *
 * The URL half is a NARROWING, not a vulnerability fix, and the difference is
 * worth stating so nobody re-derives it in a panic. `z.string().url()`
 * accepts `javascript:alert(1)` under the installed zod (4.4.3) — measured —
 * but two backstops already stop it reaching an operator:
 *
 *   · React 19 rewrites the attribute. Measured: a `javascript:` href renders
 *     as `javascript:throw new Error('React has blocked a javascript: URL as
 *     a security precaution.')`.
 *   · The CSP carries no `unsafe-inline` in `script-src`
 *     (`src/lib/security/csp.ts`), so a `javascript:` URI is blocked there.
 *
 * What survives both is the plain downgrade — `http://` renders as an
 * ordinary link out of an authenticated HTTPS app, on a phone where nobody
 * checks the scheme — and a field contract of "anything URL-shaped", which is
 * much wider than the one thing these fields are for.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const REPO = path.resolve(__dirname, '..', '..');
const API_DIR = path.resolve(REPO, 'src', 'app', 'api');
const SCHEMA_FILE = path.resolve(
    REPO,
    'src',
    'app-layer',
    'schemas',
    'promotion-admin.schemas.ts',
);

/**
 * Route directories whose every `route.ts` writes to the GLOBAL catalogue.
 * Derived from the filesystem below, so a route added tomorrow is covered
 * the moment it exists — the shape `api-permission-coverage` uses.
 */
const PLATFORM_WRITE_ROOTS = [
    path.join('t', '[tenantSlug]', 'admin', 'promotions'),
    path.join('t', '[tenantSlug]', 'admin', 'companies'),
];

function collectRoutes(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...collectRoutes(full));
        else if (entry.isFile() && entry.name === 'route.ts') out.push(full);
    }
    return out;
}

/**
 * Every URL-shaped property in a schema source, and whether it is
 * scheme-constrained.
 *
 * Parses rather than greps. A property counts as URL-shaped if its name ends
 * in `Url`/`url`, or its initializer mentions `.url(`. It counts as pinned if
 * that initializer routes through the file's `httpsUrl()` helper or spells
 * `z.url({ protocol: ... })` inline.
 */
export function findUnpinnedUrlFields(
    displayPath: string,
    source: string,
): { fields: string[]; unpinned: string[] } {
    const sf = ts.createSourceFile(displayPath, source, ts.ScriptTarget.Latest, true);
    const fields: string[] = [];
    const unpinned: string[] = [];

    const visit = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node) && node.name && ts.isIdentifier(node.name)) {
            const name = node.name.text;
            const init = node.initializer.getText(sf);
            const looksUrl = /url$/i.test(name) || init.includes('.url(');
            if (looksUrl) {
                fields.push(name);
                const pinned = init.includes('httpsUrl(') || /z\.url\(\s*\{/.test(init);
                if (!pinned) {
                    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
                    unpinned.push(`${displayPath}:${line} — ${name} accepts any URL scheme`);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return { fields, unpinned };
}

describe('promotions — structural drift guard', () => {
    // ── 1. Every global-catalogue write route self-gates ──

    test('every admin promotions/companies route calls assertPlatformSupport', () => {
        const routes = PLATFORM_WRITE_ROOTS.flatMap((root) =>
            collectRoutes(path.join(API_DIR, root)),
        );

        // Resolving power: if the derivation stopped finding routes, an empty
        // `missing` would be green for the wrong reason.
        expect(routes.length).toBeGreaterThanOrEqual(4);

        const missing = routes
            .filter((f) => !fs.readFileSync(f, 'utf-8').includes('assertPlatformSupport'))
            .map((f) => path.relative(REPO, f));

        expect(missing).toEqual([]);
    });

    test('the route derivation is from the filesystem, not a hand-kept list', () => {
        // A new route under either root must be picked up with no edit here.
        // Asserted by construction: `collectRoutes` walks the tree, and the
        // roots are directories rather than file names.
        for (const root of PLATFORM_WRITE_ROOTS) {
            expect(fs.existsSync(path.join(API_DIR, root))).toBe(true);
        }
    });

    // ── 2. Outbound links are scheme-pinned ──

    test('every URL field in promotion-admin.schemas.ts pins the scheme', () => {
        const src = fs.readFileSync(SCHEMA_FILE, 'utf-8');
        const { fields, unpinned } = findUnpinnedUrlFields(
            path.relative(REPO, SCHEMA_FILE),
            src,
        );

        // Same resolving-power floor: three URL fields today (ctaUrl x2,
        // websiteUrl). A parser that stopped finding them would report clean.
        expect(fields.length).toBeGreaterThanOrEqual(3);
        expect(unpinned).toEqual([]);
    });

    // ── 3. The detector's own tests ──

    describe('findUnpinnedUrlFields — mutation proofs', () => {
        const PINNED = `
import { z } from 'zod';
const httpsUrl = () => z.url({ protocol: /^https$/ }).max(2000);
export const S = z.object({
    ctaUrl: httpsUrl().nullable().optional(),
});
`;

        it('accepts a pinned field', () => {
            expect(findUnpinnedUrlFields('probe.ts', PINNED).unpinned).toEqual([]);
        });

        it('rejects a field reverted to z.string().url()', () => {
            const src = PINNED.replace(
                'ctaUrl: httpsUrl().nullable().optional(),',
                'ctaUrl: z.string().url().max(2000).nullable().optional(),',
            );
            const out = findUnpinnedUrlFields('probe.ts', src);
            expect(out.unpinned).toHaveLength(1);
            expect(out.unpinned[0]).toContain('ctaUrl');
        });

        it('rejects a NEW url field added unpinned', () => {
            // The drift this guard exists for — nobody reverts `ctaUrl`, they
            // add `bannerUrl` next to it and copy the wrong neighbour.
            const src = PINNED.replace(
                '    ctaUrl: httpsUrl().nullable().optional(),',
                '    ctaUrl: httpsUrl().nullable().optional(),\n    bannerUrl: z.string().url().optional(),',
            );
            const out = findUnpinnedUrlFields('probe.ts', src);
            expect(out.unpinned).toHaveLength(1);
            expect(out.unpinned[0]).toContain('bannerUrl');
        });

        it('accepts an inline z.url({ protocol }) without the helper', () => {
            const src = PINNED.replace(
                'ctaUrl: httpsUrl().nullable().optional(),',
                'ctaUrl: z.url({ protocol: /^https$/ }).optional(),',
            );
            expect(findUnpinnedUrlFields('probe.ts', src).unpinned).toEqual([]);
        });

        it('ignores a non-URL field', () => {
            const src = PINNED.replace(
                'ctaUrl: httpsUrl().nullable().optional(),',
                'title: z.string().max(300),',
            );
            expect(findUnpinnedUrlFields('probe.ts', src).fields).toEqual([]);
        });
    });

    // ── 4. The claim the docblock rests on, executed ──

    describe('the installed zod really is that permissive', () => {
        it('z.string().url() accepts http, ftp and javascript', async () => {
            const { z } = await import('zod');
            const loose = z.string().url();
            expect(loose.safeParse('http://example.com').success).toBe(true);
            expect(loose.safeParse('ftp://example.com').success).toBe(true);
            expect(loose.safeParse('javascript:alert(1)').success).toBe(true);
        });

        it('the pinned form refuses all three, and still accepts https', async () => {
            const { z } = await import('zod');
            const pinned = z.url({ protocol: /^https$/ }).max(2000);
            expect(pinned.safeParse('https://example.com').success).toBe(true);
            expect(pinned.safeParse('http://example.com').success).toBe(false);
            expect(pinned.safeParse('ftp://example.com').success).toBe(false);
            expect(pinned.safeParse('javascript:alert(1)').success).toBe(false);
            expect(pinned.safeParse('data:text/html,x').success).toBe(false);
        });
    });
});
