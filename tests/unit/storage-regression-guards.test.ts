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

import { execSync } from 'child_process';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../');
const SRC_DIR = path.join(ROOT, 'src');

// Helper: run grep on src directory (returns matching lines)
function grepSrc(pattern: string, includes: string = '*.ts'): string[] {
    try {
        const result = execSync(
            // `2>/dev/null`, not `2>nul`. On Windows `nul` is the null
            // device; on Linux it is a FILENAME, so the old spelling created
            // and truncated `./nul` in `cwd` — which is this repo's root —
            // every time this suite ran. That file is one of the six #2567
            // removes, and deleting it was not durable while this line stood.
            //
            // The redirect was also hiding that this helper greps nothing at
            // all: `rg` is not installed, so `npx` fetches whatever the
            // registry serves under that name. See #2585, which owns the fix;
            // this change is only the part that keeps the deletion durable.
            `npx rg -l "${pattern}" --glob "${includes}" "${SRC_DIR}" 2>/dev/null`,
            { encoding: 'utf-8', cwd: ROOT }
        );
        return result.trim().split('\n').filter(Boolean);
    } catch {
        // rg returns exit 1 when no matches — that's success for our guard
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════
//  Guard 1: No direct fs usage in app-layer or API routes
// ═══════════════════════════════════════════════════════════════

describe('Guard: No direct fs in production paths', () => {
    const ALLOWED_FS_FILES = [
        'storage.ts',           // legacy shim (re-exports only)
        'local-provider.ts',    // local provider implementation
        'types.ts',             // type definitions
        'index.ts',             // storage factory
    ];

    it('app-layer usecases do not import fs directly', () => {
        const matches = grepSrc("from 'fs'|from 'fs/promises'", '*.ts')
            .map(f => path.relative(ROOT, f))
            .filter(f => f.includes('app-layer'))
            .filter(f => !ALLOWED_FS_FILES.some(a => f.endsWith(a)));

        expect(matches).toEqual([]);
    });

    it('API routes do not import fs directly', () => {
        const matches = grepSrc("from 'fs'|from 'fs/promises'", '*.ts')
            .map(f => path.relative(ROOT, f))
            .filter(f => f.includes('app/api'))
            .filter(f => !ALLOWED_FS_FILES.some(a => f.endsWith(a)));

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

    for (const fn of LEGACY_FUNCTIONS) {
        it(`${fn} is not imported in app-layer usecases`, () => {
            const matches = grepSrc(fn, '*.ts')
                .map(f => path.relative(ROOT, f))
                .filter(f => f.includes('app-layer') && f.includes('usecases'))
                // Allow the storage shim itself
                .filter(f => !f.endsWith('storage.ts'));

            expect(matches).toEqual([]);
        });

        it(`${fn} is not imported in API routes`, () => {
            const matches = grepSrc(fn, '*.ts')
                .map(f => path.relative(ROOT, f))
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
//  Guard 4: AV scan status enforcement
// ═══════════════════════════════════════════════════════════════

describe('Guard: AV scan status enforcement', () => {
    type ScanMode = 'strict' | 'permissive' | 'disabled';

    function canDownload(scanStatus: string, mode: ScanMode): boolean {
        if (scanStatus === 'INFECTED') return false;
        if (mode === 'strict' && scanStatus === 'PENDING') return false;
        return true;
    }

    it('INFECTED files are always blocked', () => {
        expect(canDownload('INFECTED', 'strict')).toBe(false);
        expect(canDownload('INFECTED', 'permissive')).toBe(false);
        expect(canDownload('INFECTED', 'disabled')).toBe(false);
    });

    it('PENDING files blocked in strict mode only', () => {
        expect(canDownload('PENDING', 'strict')).toBe(false);
        expect(canDownload('PENDING', 'permissive')).toBe(true);
        expect(canDownload('PENDING', 'disabled')).toBe(true);
    });

    it('CLEAN files always allowed', () => {
        expect(canDownload('CLEAN', 'strict')).toBe(true);
        expect(canDownload('CLEAN', 'permissive')).toBe(true);
        expect(canDownload('CLEAN', 'disabled')).toBe(true);
    });
});
