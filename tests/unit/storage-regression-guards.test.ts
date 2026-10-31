/**
 * Storage Regression Guards
 *
 * These tests ensure the cloud storage migration cannot silently regress:
 * 1. No direct fs usage in production upload/download paths
 * 2. All object keys include tenant prefix
 * 3. Production provider must not be local (when STORAGE_PROVIDER=s3)
 * 4. AV scan guard blocks infected files
 * 5. Legacy shim functions are not used in app-layer code
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = REPO_ROOT;

/** Any `fs` import, including the `node:` forms the old pattern missed. */
const FS_IMPORT = /from '(fs|fs\/promises|node:fs|node:fs\/promises)'/;

/**
 * The population, collected once and FLOORED — #2585.
 *
 * ## What this replaces
 *
 * These guards shelled out to `npx rg`, and `rg` is not installed. `npx` with
 * no local binary resolves the name against the registry and EXECUTES what it
 * finds — measured, it printed "README.md already exists. run with -f to
 * overwrite" and exited 0, which is a README generator. So CI fetched and ran
 * an arbitrary package, and the guards read no files at all:
 *
 *     where        npx does   the helper returned   the assertion
 *     under jest   throws     [] via the catch      PASSES
 *     plain node   fetches    the README line       would FAIL
 *
 * Green only while the thing it depended on did not work, and red if it ever
 * started working. The `catch` comment — "rg returns exit 1 when no matches —
 * that's success for our guard" — is a true statement about ripgrep that made
 * a swallowed ENOENT, a failed fetch and a genuine clean result into one
 * observation. Positive control at the time: grepping those two roots directly
 * found 0 violations, so the invariant held and nobody would have noticed.
 *
 * `2>nul` also wrote a file called `nul` into the repo root on every run —
 * the tracked artifact #2567 had just removed.
 *
 * ## Blanking: comments ONLY, and that is forced rather than chosen
 *
 * A module specifier is a STRING (`from 'fs'`), so `{ strings: true }` would
 * blank the very thing being looked for. Comments alone is still the half that
 * matters: a docblock naming `streamWriteFile` is exactly what used to read as
 * a call. The residual risk is a string literal containing a legacy name,
 * which fails LOUD — a false positive someone must look at — rather than
 * silent.
 */
const FILES = collectSourceFiles({
    roots: ['src'],
    extensions: ['.ts', '.tsx'],
    // The helper throws below this, so these guards can no longer range over
    // nothing — which is the state they were in for an unknown period.
    floor: 500,
});

const rel = (abs: string): string => path.relative(ROOT, abs).split(path.sep).join('/');

/** Repo-relative paths whose CODE matches `re`. */
function filesMatching(re: RegExp): string[] {
    return FILES.filter((abs) => re.test(blankNonCode(readFileSync(abs, 'utf8')))).map(rel);
}

// ═══════════════════════════════════════════════════════════════
//  Guard 1: No direct fs usage in app-layer or API routes
// ═══════════════════════════════════════════════════════════════

describe('Guard: No direct fs in production paths', () => {
    /**
     * Exempt by repo-relative PATH, each with a written reason — #2585.
     *
     * It was a list of BASENAMES matched with `f.endsWith(a)`, and `'index.ts'`
     * was on it. That exempts every `index.ts` under `src/`, not the storage
     * factory — the `[[a-needle-loses-the-thread-at-a-rename]]` failure with
     * the key too short rather than too long. Measured: of the 8 files under
     * `src/` that import `fs`, the basename list exempted 2, and `types.ts` and
     * `index.ts` exempted nothing at all — stale cover for whatever landed at
     * those names next.
     *
     * Paths, so an exemption covers the file somebody decided about. The
     * no-stale-entries test below removes the cover as soon as a path stops
     * existing.
     */
    const ALLOWED_FS_FILES: Record<string, string> = {
        'src/lib/storage.ts':
            'the legacy shim — re-exports only, and the module-specifier guard pins it',
        'src/lib/storage/local-provider.ts':
            'the local provider IS the filesystem implementation',
        // Both of these were invisible until #2585 made the guard read files.
        // Neither touches tenant uploads, which is what this guard is about.
        'src/app-layer/ai/vision/onnx-provider.ts':
            'reads the ONNX MODEL off disk at startup — a build artifact shipped in the image, not tenant content',
        'src/app/api/docs/assets/[asset]/route.ts':
            'serves the API-docs static assets, which are repo files rather than uploads. Newly in scope because the pattern now also matches the `node:fs` forms the old one missed',
    };
    const isAllowed = (f: string): boolean => Object.hasOwn(ALLOWED_FS_FILES, f);

    it('app-layer usecases do not import fs directly', () => {
        const matches = filesMatching(FS_IMPORT)
            .filter(f => f.includes('app-layer'))
            .filter(f => !isAllowed(f));

        expect(matches).toEqual([]);
    });

    it('every fs exemption still names a file that exists, with a reason', () => {
        const stale = Object.keys(ALLOWED_FS_FILES).filter(
            (f) => !existsSync(path.join(ROOT, f)),
        );
        expect(stale).toEqual([]);
        for (const [f, why] of Object.entries(ALLOWED_FS_FILES)) {
            expect(why.length).toBeGreaterThan(20);
            // And each one must actually import fs — an exemption for a file
            // that no longer does is cover nobody asked for.
            expect(FS_IMPORT.test(blankNonCode(readFileSync(path.join(ROOT, f), 'utf8')))).toBe(
                true,
            );
        }
        console.log(
            `[storage-guards] ${FILES.length} src file(s) scanned; `
                + `${filesMatching(FS_IMPORT).length} import fs; `
                + `${Object.keys(ALLOWED_FS_FILES).length} exempt by path`,
        );
    });

    it('API routes do not import fs directly', () => {
        const matches = filesMatching(FS_IMPORT)
            .filter(f => f.includes('app/api'))
            .filter(f => !isAllowed(f));

        expect(matches).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════
//  Guard 2: No legacy shim functions in app-layer code
// ═══════════════════════════════════════════════════════════════

describe('Guard: Legacy shim functions not used in production code', () => {
    const LEGACY_FUNCTIONS = [
        'streamWriteFile',
        'streamReadFile',
        'deleteStoredFile',
        'getFile',
    ];

    // `\\b`, not `\b`. Inside a TEMPLATE LITERAL `\b` is the backspace
    // character U+0008, so `new RegExp(`\b${fn}\b`)` builds
    // /<BS>streamWriteFile<BS>/ and matches nothing — these eight assertions
    // would have gone on passing over nothing after #2585 supposedly fixed
    // them. Caught only by planting a real violation and watching it stay
    // green, which is the whole reason a mutation proof is not optional here.
    for (const fn of LEGACY_FUNCTIONS) {
        it(`${fn} is not imported in app-layer usecases`, () => {
            const matches = filesMatching(new RegExp(`\\b${fn}\\b`))
                .filter(f => f.includes('app-layer') && f.includes('usecases'))
                // Allow the storage shim itself
                .filter(f => !f.endsWith('storage.ts'));

            expect(matches).toEqual([]);
        });

        it(`${fn} is not imported in API routes`, () => {
            const matches = filesMatching(new RegExp(`\\b${fn}\\b`))
                .filter(f => f.includes('app/api') && f.endsWith('route.ts'));

            expect(matches).toEqual([]);
        });
    }
});

// ═══════════════════════════════════════════════════════════════
//  Guard 3: Object keys include tenant prefix
// ═══════════════════════════════════════════════════════════════

describe('Guard: Tenant-scoped object keys', () => {
    // Import directly to avoid mock conflicts
    const { buildTenantObjectKey, assertTenantKey } = jest.requireActual('@/lib/storage/index');

    it('buildTenantObjectKey always starts with tenants/<id>/', () => {
        const key = buildTenantObjectKey('tenant-abc', 'evidence', 'report.pdf');
        expect(key).toMatch(/^tenants\/tenant-abc\/evidence\//);
    });

    it('buildTenantObjectKey includes date partitioning', () => {
        const key = buildTenantObjectKey('t1', 'reports', 'doc.pdf');
        expect(key).toMatch(/^tenants\/t1\/reports\/\d{4}\/\d{2}\//);
    });

    it('assertTenantKey blocks cross-tenant access', () => {
        const key = buildTenantObjectKey('tenant-1', 'evidence', 'file.pdf');
        expect(() => assertTenantKey(key, 'tenant-1')).not.toThrow();
        expect(() => assertTenantKey(key, 'tenant-2')).toThrow('Tenant isolation');
    });

    it('assertTenantKey blocks path traversal', () => {
        expect(() => assertTenantKey('tenants/../other/file.pdf', 'other')).toThrow();
    });

    it('buildTenantObjectKey sanitizes filename', () => {
        const key = buildTenantObjectKey('t1', 'evidence', '../../../etc/passwd');
        expect(key).not.toContain('..');
        expect(key).toMatch(/^tenants\/t1\/evidence\//);
    });
});

// ═══════════════════════════════════════════════════════════════
//  Guard 4: REMOVED — it tested a local copy, not the real policy (#2585)
// ═══════════════════════════════════════════════════════════════
//
// It declared its own `canDownload(scanStatus, mode)` and asserted against
// THAT. A reimplementation cannot fail when production changes, so it was
// green by construction — and the real function has a documented history of
// exactly the bug a copy cannot catch: `isDownloadAllowed` in
// `src/lib/storage/av-scan.ts` had `if (mode === 'disabled') return true;`
// AHEAD of the INFECTED check, while the comment under it claimed INFECTED was
// refused "regardless of mode". The live agrent stack sets
// `AV_SCAN_MODE: disabled`, so the invariant the function documented was not
// the one it implemented in production. The local copy here happened to order
// the two rules CORRECTLY, so it would have stayed green through all of it.
//
// `tests/unit/av-scan.test.ts` imports the real `isDownloadAllowed` and
// covers INFECTED / PENDING / CLEAN / SKIPPED / null across the modes. So the
// right move is deletion, not conversion: converting would add a second copy
// of a test that already exists, and the thing being removed is the false
// assurance that this file tested AV enforcement at all.
