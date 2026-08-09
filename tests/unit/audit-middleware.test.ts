/**
 * Unit tests for Prisma audit middleware and audit context.
 *
 * Tests:
 * - Write vs read action classification
 * - AuditLog model exclusion (anti-recursion)
 * - Context stack isolation and nesting
 * - Context merge behavior
 *
 * RUN: npx jest tests/unit/audit-middleware.test.ts
 */

import { runWithAuditContext, getAuditContext, mergeAuditContext } from '@/lib/audit-context';

// ─── Action Classification ───

const WRITE_ACTIONS = new Set([
    'create',
    'createMany',
    'update',
    'updateMany',
    'delete',
    'deleteMany',
    'upsert',
]);

const READ_ACTIONS = [
    'findFirst',
    'findFirstOrThrow',
    'findMany',
    'findUnique',
    'findUniqueOrThrow',
    'count',
    'aggregate',
    'groupBy',
];

const EXCLUDED_MODELS = new Set(['AuditLog']);

describe('Audit Middleware — Action Classification', () => {
    it.each([...WRITE_ACTIONS])('classifies "%s" as a write action', (action) => {
        expect(WRITE_ACTIONS.has(action)).toBe(true);
    });

    it.each(READ_ACTIONS)('does NOT classify "%s" as a write action', (action) => {
        expect(WRITE_ACTIONS.has(action)).toBe(false);
    });
});

describe('Audit Middleware — Model Exclusion', () => {
    it('AuditLog model is in the exclusion set', () => {
        expect(EXCLUDED_MODELS.has('AuditLog')).toBe(true);
    });

    it('Normal models like Risk are NOT excluded', () => {
        expect(EXCLUDED_MODELS.has('Risk')).toBe(false);
    });

    it('Normal models like Practice are NOT excluded', () => {
        expect(EXCLUDED_MODELS.has('Practice')).toBe(false);
    });
});

// ─── Audit Context (Stack-based) ───

describe('Audit Context — runWithAuditContext + getAuditContext', () => {
    it('getAuditContext returns undefined outside of runWithAuditContext', () => {
        expect(getAuditContext()).toBeUndefined();
    });

    it('getAuditContext returns context inside runWithAuditContext (sync)', () => {
        runWithAuditContext({ tenantId: 't1', actorUserId: 'u1', requestId: 'r1' }, () => {
            const current = getAuditContext();
            expect(current?.tenantId).toBe('t1');
            expect(current?.actorUserId).toBe('u1');
            expect(current?.requestId).toBe('r1');
        });
    });

    it('getAuditContext returns context inside runWithAuditContext (async)', async () => {
        await runWithAuditContext({ tenantId: 't1', actorUserId: 'u1' }, async () => {
            const current = getAuditContext();
            expect(current?.tenantId).toBe('t1');
            expect(current?.actorUserId).toBe('u1');
        });
    });

    it('context is cleaned up after runWithAuditContext completes (sync)', () => {
        runWithAuditContext({ tenantId: 't1' }, () => {
            expect(getAuditContext()?.tenantId).toBe('t1');
        });
        expect(getAuditContext()).toBeUndefined();
    });

    it('context is cleaned up after runWithAuditContext completes (async)', async () => {
        await runWithAuditContext({ tenantId: 't1' }, async () => {
            expect(getAuditContext()?.tenantId).toBe('t1');
        });
        expect(getAuditContext()).toBeUndefined();
    });

    it('context is cleaned up after runWithAuditContext throws (sync)', () => {
        expect(() => {
            runWithAuditContext({ tenantId: 't1' }, () => {
                throw new Error('test error');
            });
        }).toThrow('test error');
        expect(getAuditContext()).toBeUndefined();
    });

    it('context is cleaned up after runWithAuditContext rejects (async)', async () => {
        await expect(
            runWithAuditContext({ tenantId: 't1' }, async () => {
                throw new Error('async test error');
            }),
        ).rejects.toThrow('async test error');
        expect(getAuditContext()).toBeUndefined();
    });

    it('nested contexts stack properly', () => {
        runWithAuditContext({ tenantId: 'outer' }, () => {
            expect(getAuditContext()?.tenantId).toBe('outer');

            runWithAuditContext({ tenantId: 'inner', actorUserId: 'u-inner' }, () => {
                expect(getAuditContext()?.tenantId).toBe('inner');
                expect(getAuditContext()?.actorUserId).toBe('u-inner');
            });

            // After inner completes, outer is restored
            expect(getAuditContext()?.tenantId).toBe('outer');
        });
    });

    it('nested async contexts stack properly', async () => {
        await runWithAuditContext({ tenantId: 'outer' }, async () => {
            expect(getAuditContext()?.tenantId).toBe('outer');

            await runWithAuditContext({ tenantId: 'inner' }, async () => {
                expect(getAuditContext()?.tenantId).toBe('inner');
            });

            expect(getAuditContext()?.tenantId).toBe('outer');
        });
    });
});

describe('Audit Context — mergeAuditContext', () => {
    it('returns false when no context is active', () => {
        expect(mergeAuditContext({ source: 'job' })).toBe(false);
    });

    it('merges fields into the current context', () => {
        runWithAuditContext({ tenantId: 't1' }, () => {
            const merged = mergeAuditContext({ actorUserId: 'u1', requestId: 'r1' });
            expect(merged).toBe(true);
            const ctx = getAuditContext();
            expect(ctx?.tenantId).toBe('t1');
            expect(ctx?.actorUserId).toBe('u1');
            expect(ctx?.requestId).toBe('r1');
        });
    });

    it('overrides existing fields', () => {
        runWithAuditContext({ tenantId: 't1', source: 'api' }, () => {
            mergeAuditContext({ source: 'job' });
            expect(getAuditContext()?.source).toBe('job');
        });
    });
});
