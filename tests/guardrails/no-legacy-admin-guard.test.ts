/**
 * Guardrail — the legacy role-tier admin guard cannot return.
 *
 * Epic C.1 introduced `requirePermission(<key>, …)`; Epic D.3 migrated
 * the last role-tier routes (billing, sso, security) onto it. The
 * 2026-05-21 cleanup then deleted `src/lib/auth/require-admin.ts`
 * entirely — by that point it had zero production call sites.
 * `requirePermission` is now the ONLY admin-authorization guard in the
 * codebase.
 *
 * The legacy helpers (`requireAdminCtx` / `requireWriteCtx` /
 * `requireRoleCtx`) were dangerous to keep within reach because, unlike
 * `requirePermission`, they:
 *   - did NOT write a hash-chained `AUTHZ_DENIED` audit row on denial,
 *     so a privilege-escalation probe left no trail; and
 *   - were invisible to `api-permission-coverage.test.ts`, so a route
 *     that quietly used one would never be flagged for a missing
 *     `ROUTE_PERMISSIONS` entry.
 *
 * This ratchet fails CI if any of those identifiers — or the module
 * that exported them — reappears anywhere under `src/`. It is the
 * "cannot silently return" enforcement for the legacy guard.
 */
import * as fs from 'fs';
import * as path from 'path';

import { collectSourceFiles } from '../helpers/collect-files';

const SRC_DIR = path.resolve(__dirname, '../../src');
const REMOVED_MODULE = path.resolve(SRC_DIR, 'lib/auth/require-admin.ts');

/** Identifiers that must never reappear in production code. */
const BANNED_IDENTIFIERS = [
    'requireAdminCtx',
    'requireWriteCtx',
    'requireRoleCtx',
] as const;

/** The module path that exported them. */
const BANNED_MODULE = '@/lib/auth/require-admin';

/**
 * Strip `//` line comments and block comments so a historical mention
 * of the helper name in a doc comment does not trip the ratchet — only
 * real, executable code counts. The line-comment pattern keeps the
 * character before `//` so `https://` URLs survive intact.
 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Every `.ts`/`.tsx` file under `src/`, as absolute paths (the call site below
 * relativises against SRC_DIR for its report).
 *
 * Collected through `collectSourceFiles` so an EMPTY result fails (#865). This
 * ratchet's only real assertion is `expect(violations).toEqual([])`, which a
 * collector returning nothing satisfies for free — a renamed `src/` or a
 * broken walk would have retired the ban on the legacy admin guard silently.
 * The floor sits well under the 1958 files present today.
 */
function srcFiles(): string[] {
    return collectSourceFiles({ roots: ['src'], floor: 1000 });
}

/** Returns the banned tokens found in real (non-comment) code. */
function scanForLegacyGuard(code: string): string[] {
    const stripped = stripComments(code);
    const hits: string[] = [];
    for (const id of BANNED_IDENTIFIERS) {
        if (new RegExp(`\\b${id}\\b`).test(stripped)) hits.push(id);
    }
    if (stripped.includes(BANNED_MODULE)) hits.push(BANNED_MODULE);
    return hits;
}

describe('No legacy admin guard', () => {
    // ── Controls (#971) ──────────────────────────────────────────────
    // `srcFiles` survived being gutted, even though it routes through
    // `collectSourceFiles({ floor: 1000 })` which throws on an empty
    // selection — gutting replaces the WRAPPER, so the floor one layer down
    // never runs. The scan below then reports no legacy-guard references
    // having read no files.
    test('control: srcFiles returns the real source tree', () => {
        const files = srcFiles();
        expect(files.length).toBeGreaterThan(1000);
        expect(files.every((f) => path.isAbsolute(f))).toBe(true);
    });

    test('control: scanForLegacyGuard detects a banned identifier in real code', () => {
        // Proves the detector half too: the scan is `files x detector`, and
        // either returning nothing yields the same empty violation list.
        const id = BANNED_IDENTIFIERS[0];
        expect(scanForLegacyGuard(`import { ${id} } from 'x';`)).toContain(id);
        // ...and that a commented mention does NOT count, which is the whole
        // reason `stripComments` sits in front of it.
        expect(scanForLegacyGuard(`// ${id} was removed here`)).toEqual([]);
    });

    test('the legacy require-admin module no longer exists', () => {
        expect(fs.existsSync(REMOVED_MODULE)).toBe(false);
    });

    test('no src file references the legacy role-tier guard', () => {
        const violations: string[] = [];
        for (const file of srcFiles()) {
            const hits = scanForLegacyGuard(fs.readFileSync(file, 'utf-8'));
            if (hits.length > 0) {
                violations.push(`${path.relative(SRC_DIR, file)} → ${hits.join(', ')}`);
            }
        }
        expect(violations).toEqual([]);
    });

    // ─── Regression proofs — the detector actually does its job ─────────

    test('detector flags a reintroduced helper call + import', () => {
        const mutated = `
            import { requireAdminCtx } from '@/lib/auth/require-admin';
            export const POST = async () => requireAdminCtx({ tenantSlug: 's' });
        `;
        expect(scanForLegacyGuard(mutated)).toEqual(
            expect.arrayContaining(['requireAdminCtx', BANNED_MODULE]),
        );
    });

    test('detector ignores a comment that merely names the helper', () => {
        const commentOnly = `
            // Historical: this route was migrated off requireAdminCtx in Epic D.3.
            /* requireWriteCtx and requireRoleCtx were also removed. */
            export const GET = requirePermission('admin.members', handler);
        `;
        expect(scanForLegacyGuard(commentOnly)).toEqual([]);
    });
});
