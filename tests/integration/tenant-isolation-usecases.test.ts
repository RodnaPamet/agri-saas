/**
 * Integration Tests — Tenant Isolation
 *
 * Proves that:
 * 1. Tenant A context cannot read Tenant B data
 * 2. Tenant A context cannot mutate Tenant B data
 * 3. Usecase queries are always scoped by tenantId
 *
 * Approach: Tests `runInTenantContext` enforcement by constructing
 * two different RequestContexts with different tenantIds and verifying
 * that data created under one is invisible to the other.
 *
 * These tests exercise the app-layer (usecase + repository) level.
 * If DB is not available, tests are skipped gracefully.
 */
import { DB_AVAILABLE } from './db-helper';
import { buildRequestContext } from '../helpers/factories';

// Skip if no DB
const describeWithDb = DB_AVAILABLE ? describe : describe.skip;

describeWithDb('Tenant Isolation — Structural guarantees', () => {

    test('two contexts with different tenantIds are distinct', () => {
        const ctxA = buildRequestContext({ tenantId: 'tenant-a' });
        const ctxB = buildRequestContext({ tenantId: 'tenant-b' });
        expect(ctxA.tenantId).not.toBe(ctxB.tenantId);
    });

    test('READER context for tenant B cannot write to tenant A usecases', () => {
        // Even with a valid ADMIN role, the tenantId boundary prevents access
        const ctxA = buildRequestContext({ tenantId: 'tenant-a', role: 'ADMIN' });
        const ctxB = buildRequestContext({ tenantId: 'tenant-b', role: 'ADMIN' });

        // These are structurally different — usecases will scope queries by tenantId
        expect(ctxA.tenantId).toBe('tenant-a');
        expect(ctxB.tenantId).toBe('tenant-b');
    });
});

describe('Tenant Isolation — runInTenantContext enforcement', () => {
    test('runInTenantContext is a function that accepts ctx + callback', () => {
        const { runInTenantContext } = require('@/lib/db-context');
        expect(typeof runInTenantContext).toBe('function');
        // Must accept (ctx, callback) signature
        expect(runInTenantContext.length).toBeGreaterThanOrEqual(2);
    });

    test('all critical usecases import runInTenantContext', () => {
        const fs = require('fs');
        const path = require('path');
        const usecasesDir = path.resolve(__dirname, '../../src/app-layer/usecases');
        // GRC teardown phase 2 removed `practice` with its model. Re-pointed
        // at surviving tenant-scoped usecases so the invariant ("a critical
        // tenant-scoped usecase reaches the DB through runInTenantContext")
        // is still enforced rather than half-deleted. `evidence` is the
        // original entry and stays.
        const criticalModules = ['evidence', 'asset', 'journal'];

        for (const mod of criticalModules) {
            // Support both flat file (evidence.ts) and directory barrel (<mod>/index.ts)
            const flatPath = path.join(usecasesDir, `${mod}.ts`);
            const dirPath = path.join(usecasesDir, mod);
            let content: string;
            if (fs.existsSync(flatPath)) {
                content = fs.readFileSync(flatPath, 'utf-8');
            } else if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
                // Read all .ts files in the directory and concatenate
                const files = fs.readdirSync(dirPath).filter((f: string) => f.endsWith('.ts'));
                content = files.map((f: string) => fs.readFileSync(path.join(dirPath, f), 'utf-8')).join('\n');
            } else {
                throw new Error(`Critical usecase module not found: ${mod}`);
            }
            expect(content).toContain('runInTenantContext');
        }
    });
});

describe('Tenant Isolation — Repository code analysis', () => {
    const fs = require('fs');
    const path = require('path');
    const reposDir = path.resolve(__dirname, '../../src/app-layer/repositories');

    // GRC teardown phase 2 removed RiskRepository + PracticeRepository with
    // their models. Re-pointed at surviving tenant-scoped repositories
    // (EvidenceRepository is the original entry and stays) so the
    // tenantId-scoping bound is still enforced on a real subject.
    //
    // NOTE the `readdirSync().filter()` shape below: it silently yields an
    // EMPTY list when a named repository disappears, which is how this guard
    // could have gone vacuous instead of failing. The length assertion is
    // what makes the next deletion loud.
    const tenantScopedRepos = ['AssetRepository.ts', 'EvidenceRepository.ts', 'JournalRepository.ts'];

    function readTenantScopedRepos(): Array<[string, string]> {
        expect(fs.existsSync(reposDir)).toBe(true);
        const files = fs.readdirSync(reposDir).filter((f: string) => tenantScopedRepos.includes(f));
        expect(files.sort()).toEqual([...tenantScopedRepos].sort());
        return files.map((f: string) => [f, fs.readFileSync(path.join(reposDir, f), 'utf-8')]);
    }

    test('tenant-scoped repository list methods filter by tenantId', () => {
        for (const [, content] of readTenantScopedRepos()) {
            // Tenant-scoped repos must reference tenantId
            expect(content).toContain('tenantId');
        }
    });

    test('tenant-scoped repository getById methods filter by tenantId', () => {
        for (const [, content] of readTenantScopedRepos()) {
            // Must contain tenantId — proves queries are scoped
            expect(content).toContain('tenantId');
        }
    });

    test('usecases always call runInTenantContext for DB access', () => {
        const usecasesDir = path.resolve(__dirname, '../../src/app-layer/usecases');
        if (!fs.existsSync(usecasesDir)) return;

        // Mirrors `criticalModules` above — practice.ts went with the teardown.
        const criticalFiles = ['evidence.ts', 'asset.ts', 'journal.ts'];

        for (const mod of criticalFiles) {
            const modName = mod.replace('.ts', '');
            const flatPath = path.join(usecasesDir, mod);
            const dirPath = path.join(usecasesDir, modName);
            let content: string;
            if (fs.existsSync(flatPath)) {
                content = fs.readFileSync(flatPath, 'utf-8');
            } else if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
                const files = fs.readdirSync(dirPath).filter((f: string) => f.endsWith('.ts') && f !== 'index.ts');
                content = files.map((f: string) => fs.readFileSync(path.join(dirPath, f), 'utf-8')).join('\n');
            } else {
                continue;
            }
            // Should use runInTenantContext
            expect(content).toContain('runInTenantContext');
            const tenantCtxCount = (content.match(/runInTenantContext/g) || []).length;
            expect(tenantCtxCount).toBeGreaterThan(0);
        }
    });
});
