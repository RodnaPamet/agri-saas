/**
 * Branch coverage for the audit hash-chain verifier.
 *
 * `verifyTenantChain` / `verifyAllTenants` are integrity-critical —
 * they are how the platform proves the immutable audit trail has
 * not been tampered with. The branch surface:
 *
 *   - clean chain → valid
 *   - first-row previousHash ≠ null → chain_discontinuity
 *   - mid-row previousHash break → chain_discontinuity
 *   - recomputed hash ≠ stored → hash_mismatch
 *   - unhashed rows excluded from the chain walk
 *   - maxBreaks cap stops the walk early
 *   - range-filtered (`from`) chains accept a non-null first hash
 *   - verifyAllTenants aggregation across mixed tenants
 *
 * The verifier reads via `$queryRawUnsafe`; the `opts.client`
 * injection point lets the test feed deterministic rows without a
 * database. Hashes are computed with the SAME `computeEntryHash` the
 * verifier uses, so a "clean" fixture is genuinely clean.
 */
import { verifyTenantChain, verifyAllTenants } from '@/lib/audit/verify';
import { computeEntryHash } from '@/lib/audit/canonical-hash';

interface SeedRow {
    id: string;
    tenantId: string;
    userId: string | null;
    actorType: string;
    entity: string;
    entityId: string;
    action: string;
    detailsJson: unknown;
    previousHash: string | null;
    entryHash: string | null;
    version: number;
    createdAtIso: string;
}

/**
 * Build a clean, correctly-linked chain of `n` hashed rows for a
 * tenant. Each row's `entryHash` is the real canonical hash and
 * `previousHash` links to the prior row.
 */
function buildChain(tenantId: string, n: number): SeedRow[] {
    const rows: SeedRow[] = [];
    let previousHash: string | null = null;
    for (let i = 0; i < n; i++) {
        const createdAtIso = `2026-03-0${i + 1}T00:00:00.000Z`;
        const base = {
            tenantId,
            actorType: 'USER',
            actorUserId: `user-${i}`,
            eventType: 'CONTROL_UPDATED',
            entityType: 'Practice',
            entityId: `ctrl-${i}`,
            occurredAt: createdAtIso,
            detailsJson: { operation: 'updated', index: i },
            previousHash,
            version: 1,
        };
        const entryHash = computeEntryHash(base);
        rows.push({
            id: `row-${tenantId}-${i}`,
            tenantId,
            userId: `user-${i}`,
            actorType: 'USER',
            entity: 'Practice',
            entityId: `ctrl-${i}`,
            action: 'CONTROL_UPDATED',
            detailsJson: { operation: 'updated', index: i },
            previousHash,
            entryHash,
            version: 1,
            createdAtIso,
        });
        previousHash = entryHash;
    }
    return rows;
}

/**
 * Fake Prisma client whose `$queryRawUnsafe` dispatches on the SQL
 * text: a `FROM "AuditLog"` query returns the seeded rows for the
 * tenant in `$1`; a `FROM "Tenant"` query returns the tenant list.
 */
function fakeClient(opts: {
    auditRows: SeedRow[];
    tenants?: Array<{ id: string; name: string }>;
}) {
    return {
        $queryRawUnsafe: jest.fn(
            async (sql: string, ...params: unknown[]) => {
                if (sql.includes('FROM "Tenant"')) {
                    return opts.tenants ?? [];
                }
                // AuditLog query — $1 is the tenantId.
                const tenantId = params[0] as string;
                return opts.auditRows.filter(
                    (r) => r.tenantId === tenantId,
                );
            },
        ),
    } as never;
}

describe('verifyTenantChain', () => {
    it('reports a clean chain as valid with zero breaks', async () => {
        const rows = buildChain('t1', 4);
        const result = await verifyTenantChain('t1', {
            client: fakeClient({ auditRows: rows }),
        });

        expect(result.valid).toBe(true);
        expect(result.breaks).toHaveLength(0);
        expect(result.totalEntries).toBe(4);
        expect(result.hashedEntries).toBe(4);
        expect(result.unhashedEntries).toBe(0);
        expect(result.tenantId).toBe('t1');
    });

    it('counts unhashed rows separately and excludes them from the walk', async () => {
        const rows = buildChain('t1', 3);
        // Append an unhashed row — should not break the chain.
        rows.push({
            ...rows[2],
            id: 'row-unhashed',
            entryHash: null,
            previousHash: null,
        });

        const result = await verifyTenantChain('t1', {
            client: fakeClient({ auditRows: rows }),
        });

        expect(result.totalEntries).toBe(4);
        expect(result.hashedEntries).toBe(3);
        expect(result.unhashedEntries).toBe(1);
        expect(result.valid).toBe(true);
    });

    it('flags a non-null previousHash on the first row as chain_discontinuity', async () => {
        const rows = buildChain('t1', 2);
        rows[0].previousHash = 'unexpected-prior-hash';

        const result = await verifyTenantChain('t1', {
            client: fakeClient({ auditRows: rows }),
        });

        expect(result.valid).toBe(false);
        const firstBreak = result.breaks.find((b) => b.position === 0);
        expect(firstBreak?.breakType).toBe('chain_discontinuity');
        expect(firstBreak?.actualPreviousHash).toBe('unexpected-prior-hash');
        expect(firstBreak?.expectedPreviousHash).toBeNull();
    });

    it('flags a broken mid-chain link as chain_discontinuity', async () => {
        const rows = buildChain('t1', 3);
        // Snap the link between row 1 and row 2.
        rows[2].previousHash = 'tampered-link';

        const result = await verifyTenantChain('t1', {
            client: fakeClient({ auditRows: rows }),
        });

        expect(result.valid).toBe(false);
        const brk = result.breaks.find(
            (b) => b.breakType === 'chain_discontinuity',
        );
        expect(brk?.position).toBe(2);
        expect(brk?.actualPreviousHash).toBe('tampered-link');
        expect(brk?.expectedPreviousHash).toBe(rows[1].entryHash);
    });

    it('flags a tampered payload as hash_mismatch', async () => {
        const rows = buildChain('t1', 2);
        // Mutate the stored detailsJson without recomputing entryHash —
        // exactly what a tamper looks like.
        rows[1].detailsJson = { operation: 'DELETED', injected: true };

        const result = await verifyTenantChain('t1', {
            client: fakeClient({ auditRows: rows }),
        });

        expect(result.valid).toBe(false);
        const mismatch = result.breaks.find(
            (b) => b.breakType === 'hash_mismatch',
        );
        expect(mismatch).toBeDefined();
        expect(mismatch?.storedHash).toBe(rows[1].entryHash);
        expect(mismatch?.recomputedHash).not.toBe(rows[1].entryHash);
    });

    it('stops collecting breaks once maxBreaks is reached', async () => {
        // Build a chain where every row's hash is wrong.
        const rows = buildChain('t1', 8);
        for (const r of rows) r.entryHash = 'all-wrong';
        // previousHash links now also all point at real hashes that
        // don't match 'all-wrong' — so each row trips both a
        // discontinuity AND a mismatch; the cap must still hold.

        const result = await verifyTenantChain('t1', {
            client: fakeClient({ auditRows: rows }),
            maxBreaks: 3,
        });

        expect(result.valid).toBe(false);
        expect(result.breaks.length).toBeLessThanOrEqual(3);
    });

    it('accepts a non-null first-row hash when range-filtered with `from`', async () => {
        const rows = buildChain('t1', 2);
        // A range-filtered window legitimately starts mid-chain, so
        // its first row carries a previousHash — must NOT be flagged.
        rows[0].previousHash = 'prior-window-hash';

        const result = await verifyTenantChain('t1', {
            client: fakeClient({ auditRows: rows }),
            from: new Date('2026-03-01T00:00:00.000Z'),
        });

        // Row 0's non-null previousHash is accepted; row 1 still links
        // correctly to row 0, so the chain is clean within the window.
        const firstRowDiscontinuity = result.breaks.find(
            (b) => b.position === 0 && b.breakType === 'chain_discontinuity',
        );
        expect(firstRowDiscontinuity).toBeUndefined();
    });

    it('passes `from` and `to` filters into the SQL parameter list', async () => {
        const rows = buildChain('t1', 1);
        const client = fakeClient({ auditRows: rows });
        const from = new Date('2026-01-01T00:00:00.000Z');
        const to = new Date('2026-12-31T00:00:00.000Z');

        await verifyTenantChain('t1', { client, from, to });

        const call = (client as unknown as {
            $queryRawUnsafe: jest.Mock;
        }).$queryRawUnsafe.mock.calls[0];
        const [sql, ...params] = call;
        expect(sql).toContain('"createdAt" >=');
        expect(sql).toContain('"createdAt" <=');
        expect(params).toEqual(['t1', from, to]);
    });

    it('handles an empty audit log gracefully', async () => {
        const result = await verifyTenantChain('empty-tenant', {
            client: fakeClient({ auditRows: [] }),
        });

        expect(result.totalEntries).toBe(0);
        expect(result.hashedEntries).toBe(0);
        expect(result.valid).toBe(true);
        expect(result.breaks).toHaveLength(0);
    });
});

describe('verifyAllTenants', () => {
    it('aggregates a clean multi-tenant report', async () => {
        const t1 = buildChain('t1', 3);
        const t2 = buildChain('t2', 2);

        const report = await verifyAllTenants({
            client: fakeClient({
                auditRows: [...t1, ...t2],
                tenants: [
                    { id: 't1', name: 'Alpha' },
                    { id: 't2', name: 'Bravo' },
                ],
            }),
        });

        expect(report.allValid).toBe(true);
        expect(report.tenantsVerified).toBe(2);
        expect(report.tenantsWithBreaks).toBe(0);
        expect(report.totalEntriesVerified).toBe(5);
        expect(report.totalBreaks).toBe(0);
        expect(report.results.map((r) => r.tenantName)).toEqual([
            'Alpha',
            'Bravo',
        ]);
    });

    it('counts the tenant with a broken chain', async () => {
        const t1 = buildChain('t1', 2);
        const t2 = buildChain('t2', 2);
        t2[1].entryHash = 'corrupted';

        const report = await verifyAllTenants({
            client: fakeClient({
                auditRows: [...t1, ...t2],
                tenants: [
                    { id: 't1', name: 'Alpha' },
                    { id: 't2', name: 'Bravo' },
                ],
            }),
        });

        expect(report.allValid).toBe(false);
        expect(report.tenantsWithBreaks).toBe(1);
        expect(report.totalBreaks).toBeGreaterThan(0);
    });

    it('reports zero tenants when none exist', async () => {
        const report = await verifyAllTenants({
            client: fakeClient({ auditRows: [], tenants: [] }),
        });

        expect(report.tenantsVerified).toBe(0);
        expect(report.allValid).toBe(true);
    });
});
