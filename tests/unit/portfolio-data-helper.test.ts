/**
 * Epic E.3 — getPortfolioData request-scoped cache contract.
 *
 * Spies on the repository methods so we can count fetches per call
 * site. The shared cache lives on the AsyncLocalStorage RequestContext
 * via a WeakMap; tests run inside `runWithRequestContext` to exercise
 * the cached path, and outside it to confirm the unmemoised
 * fall-through still works for background / scripts.
 */

import {
    getPortfolioData,
    _peekRequestCache,
} from '@/app-layer/usecases/portfolio-data';
import { PortfolioRepository } from '@/app-layer/repositories/PortfolioRepository';
import { runWithRequestContext } from '@/lib/observability/context';

const tenantsFixture = [
    { id: 't1', slug: 'alpha', name: 'Alpha Co' },
    { id: 't2', slug: 'beta', name: 'Beta Co' },
];

function makeSnapshot(tenantId: string) {
    // Minimum viable ComplianceSnapshot — only the fields the helper
    // exposes via `snapshotsByTenant.get(...)`. The repository spy
    // returns whatever shape we feed it, so we satisfy the type via
    // `as never`-style casting at the spy boundary.
    return {
        id: `snap-${tenantId}`,
        tenantId,
        snapshotDate: new Date('2026-04-29'),
    };
}

function ctxScope<T>(fn: () => Promise<T>): Promise<T> {
    return runWithRequestContext(
        {
            requestId: 'req-test',
            startTime: 0,
        },
        fn,
    );
}

describe('Epic E.3 — getPortfolioData request-scoped memoisation', () => {
    let tenantsSpy: jest.SpyInstance;
    let snapshotsSpy: jest.SpyInstance;

    beforeEach(() => {
        tenantsSpy = jest
            .spyOn(PortfolioRepository, 'getOrgTenantIds')
            .mockResolvedValue(tenantsFixture);
        snapshotsSpy = jest
            .spyOn(PortfolioRepository, 'getLatestSnapshots')
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .mockImplementation(async (ids: string[]): Promise<any> =>
                ids.map(makeSnapshot),
            );
    });

    afterEach(() => {
        tenantsSpy.mockRestore();
        snapshotsSpy.mockRestore();
    });

    // ── Happy-path memoisation ───────────────────────────────────────

    it('inside one request scope, repeated calls fire the repo ONCE', async () => {
        await ctxScope(async () => {
            await getPortfolioData('org-1');
            await getPortfolioData('org-1');
            await getPortfolioData('org-1');
        });
        expect(tenantsSpy).toHaveBeenCalledTimes(1);
        expect(snapshotsSpy).toHaveBeenCalledTimes(1);
    });

    it('CSV-export-shaped composition (5 sequential callers) fires repo ONCE', async () => {
        // Mirrors the production CSV export route: summary + health +
        // 3 drill-downs all run in the same request.
        await ctxScope(async () => {
            await getPortfolioData('org-1');                           // summary
            await getPortfolioData('org-1');                           // health
            await getPortfolioData('org-1', { includeSnapshots: false }); // practices drill-down
            await getPortfolioData('org-1', { includeSnapshots: false }); // risks drill-down
            await getPortfolioData('org-1', { includeSnapshots: false }); // evidence drill-down
        });
        expect(tenantsSpy).toHaveBeenCalledTimes(1);
        expect(snapshotsSpy).toHaveBeenCalledTimes(1);
    });

    it('concurrent callers in one scope share the in-flight tenants promise', async () => {
        // Two parallel calls should resolve to the same fetch — the
        // promise is memoised the moment the first call enters the
        // helper, so the second await never re-fires.
        await ctxScope(async () => {
            await Promise.all([
                getPortfolioData('org-1'),
                getPortfolioData('org-1'),
                getPortfolioData('org-1'),
            ]);
        });
        expect(tenantsSpy).toHaveBeenCalledTimes(1);
        expect(snapshotsSpy).toHaveBeenCalledTimes(1);
    });

    it('drill-down-only callers (includeSnapshots: false) skip the snapshots fetch', async () => {
        await ctxScope(async () => {
            await getPortfolioData('org-1', { includeSnapshots: false });
            await getPortfolioData('org-1', { includeSnapshots: false });
        });
        expect(tenantsSpy).toHaveBeenCalledTimes(1);
        expect(snapshotsSpy).not.toHaveBeenCalled();
    });

    it('a snapshots-needing caller after a snapshots-skipping one promotes the cache entry', async () => {
        // Drill-down call first (no snapshots), then summary call
        // (needs snapshots). Tenants stays at 1; snapshots fires once.
        await ctxScope(async () => {
            const a = await getPortfolioData('org-1', { includeSnapshots: false });
            expect(a.snapshots).toEqual([]);
            const b = await getPortfolioData('org-1');
            expect(b.snapshots).toHaveLength(2);
        });
        expect(tenantsSpy).toHaveBeenCalledTimes(1);
        expect(snapshotsSpy).toHaveBeenCalledTimes(1);
    });

    // ── Cache scoping invariants ─────────────────────────────────────

    it('different request scopes do NOT share the cache', async () => {
        await ctxScope(async () => {
            await getPortfolioData('org-1');
        });
        await ctxScope(async () => {
            await getPortfolioData('org-1');
        });
        expect(tenantsSpy).toHaveBeenCalledTimes(2);
        expect(snapshotsSpy).toHaveBeenCalledTimes(2);
    });

    it('different orgIds in the same scope bypass the cache', async () => {
        await ctxScope(async () => {
            await getPortfolioData('org-1');
            await getPortfolioData('org-2');
        });
        expect(tenantsSpy).toHaveBeenCalledTimes(2);
        expect(snapshotsSpy).toHaveBeenCalledTimes(2);
    });

    it('outside a request scope, every call fires fresh (no cache)', async () => {
        await getPortfolioData('org-1');
        await getPortfolioData('org-1');
        expect(tenantsSpy).toHaveBeenCalledTimes(2);
        expect(snapshotsSpy).toHaveBeenCalledTimes(2);
    });

    // ── _peekRequestCache surface ───────────────────────────────────

    it('_peekRequestCache reports null outside a request scope', () => {
        expect(_peekRequestCache()).toBeNull();
    });

    it('_peekRequestCache reports orgId + hasSnapshots after a fetch', async () => {
        const peek = await ctxScope(async () => {
            await getPortfolioData('org-1', { includeSnapshots: false });
            return _peekRequestCache();
        });
        expect(peek).toEqual({ orgId: 'org-1', hasSnapshots: false });

        const peekAfterFull = await ctxScope(async () => {
            await getPortfolioData('org-1');
            return _peekRequestCache();
        });
        expect(peekAfterFull).toEqual({ orgId: 'org-1', hasSnapshots: true });
    });

    // ── Result shape ────────────────────────────────────────────────

    it('returns tenants + snapshots + a populated snapshotsByTenant map', async () => {
        const data = await ctxScope(() => getPortfolioData('org-1'));
        expect(data.tenants).toEqual(tenantsFixture);
        expect(data.snapshots).toHaveLength(2);
        expect(data.snapshotsByTenant.size).toBe(2);
        expect(data.snapshotsByTenant.get('t1')?.id).toBe('snap-t1');
    });

    it('returns empty snapshots + empty map when includeSnapshots is false', async () => {
        const data = await ctxScope(() =>
            getPortfolioData('org-1', { includeSnapshots: false }),
        );
        expect(data.tenants).toEqual(tenantsFixture);
        expect(data.snapshots).toEqual([]);
        expect(data.snapshotsByTenant.size).toBe(0);
    });
});
