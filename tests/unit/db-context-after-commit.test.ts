/**
 * The WIRING, not the collector: `withTenantDb` and `runInTenantContext` must
 * each own an after-commit scope.
 *
 * `tests/unit/after-commit-collector.test.ts` proves the collector's contract
 * in isolation. That is not the same claim as "the transaction helpers use it"
 * — and the whole mechanism is inert if either helper loses its wrapper. A
 * source grep would notice the wrapper disappearing from `db-context.ts` and
 * would not notice it being wrapped in the wrong PLACE (inside `$transaction`
 * rather than around it), which drains before the commit and is the defect
 * wearing the fix's clothes.
 *
 * So this executes both helpers against an injected fake client whose
 * `$transaction` records when it resolves. No database: the only thing under
 * test is the ORDER of (callback returns) → (transaction resolves) → (effects
 * run), and whether a rejecting transaction runs any.
 *
 * Both helpers accept a client by argument (`customPrisma`), which is what
 * makes this testable without touching the singleton pool.
 */
import type { PrismaClient } from '@prisma/client';
import { withTenantDb, runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { afterCommit } from '@/lib/db/after-commit';
import { makeRequestContext } from '../helpers/make-context';

/**
 * A `$transaction` that behaves like Prisma's: it runs the callback, then
 * resolves (COMMIT) or rejects (ROLLBACK) a turn later. `$executeRaw` is
 * invoked as a tagged template by both helpers, so it must be callable with
 * `(strings, ...values)`.
 */
function makeFakeClient(log: string[], options: { fail?: boolean } = {}) {
    const tx = {
        $executeRaw: () => Promise.resolve(0),
    } as unknown as PrismaTx;

    const client = {
        $transaction: async (fn: (t: PrismaTx) => Promise<unknown>) => {
            log.push('BEGIN');
            const result = await fn(tx);
            // A real COMMIT is not synchronous with the callback returning.
            await new Promise<void>((r) => setTimeout(r, 0));
            if (options.fail) {
                log.push('ROLLBACK');
                throw new Error('simulated rollback at COMMIT');
            }
            log.push('COMMIT');
            return result;
        },
    } as unknown as PrismaClient;

    return { client, tx };
}

const ctx = makeRequestContext('ADMIN', { tenantId: 'tenant-after-commit' });

describe('runInTenantContext owns an after-commit scope', () => {
    it('runs a queued effect AFTER the commit, not after the callback', async () => {
        const log: string[] = [];
        const { client } = makeFakeClient(log);

        const result = await runInTenantContext(
            ctx,
            async () => {
                afterCommit('effect', () => {
                    log.push('EFFECT');
                });
                log.push('callback-returned');
                return 'ok';
            },
            { customPrisma: client },
        );

        expect(result).toBe('ok');
        expect(log).toEqual(['BEGIN', 'callback-returned', 'COMMIT', 'EFFECT']);
    });

    it('runs NO effect when the transaction rolls back', async () => {
        const log: string[] = [];
        const { client } = makeFakeClient(log, { fail: true });

        await expect(
            runInTenantContext(
                ctx,
                async () => {
                    afterCommit('effect', () => log.push('EFFECT'));
                    return 'unreachable';
                },
                { customPrisma: client },
            ),
        ).rejects.toThrow('simulated rollback at COMMIT');

        expect(log).toEqual(['BEGIN', 'ROLLBACK']);
        expect(log).not.toContain('EFFECT');
    });
});

describe('withTenantDb owns an after-commit scope', () => {
    it('runs a queued effect AFTER the commit', async () => {
        const log: string[] = [];
        const { client } = makeFakeClient(log);

        await withTenantDb(
            'tenant-after-commit',
            async () => {
                afterCommit('effect', () => log.push('EFFECT'));
                return null;
            },
            client,
        );

        expect(log).toEqual(['BEGIN', 'COMMIT', 'EFFECT']);
    });

    it('runs NO effect when the transaction rolls back', async () => {
        const log: string[] = [];
        const { client } = makeFakeClient(log, { fail: true });

        await expect(
            withTenantDb(
                'tenant-after-commit',
                async () => {
                    afterCommit('effect', () => log.push('EFFECT'));
                    return null;
                },
                client,
            ),
        ).rejects.toThrow('simulated rollback at COMMIT');

        expect(log).not.toContain('EFFECT');
    });
});

describe('a nested transaction defers to the OUTERMOST commit', () => {
    it('holds the inner helper’s effect until the outer helper commits', async () => {
        const log: string[] = [];
        const { client } = makeFakeClient(log);

        await runInTenantContext(
            ctx,
            async () => {
                // This is the exact shape the Exchange notify had: a second
                // tenant's transaction opened from inside the first. Prisma
                // does not nest, so the inner one commits independently — and
                // its ANNOUNCEMENTS must still wait for the outer one.
                await withTenantDb(
                    'other-tenant',
                    async () => {
                        afterCommit('inner-effect', () => log.push('INNER-EFFECT'));
                        return null;
                    },
                    client,
                );
                log.push('outer-callback-returned');
                return null;
            },
            { customPrisma: client },
        );

        expect(log).toEqual([
            'BEGIN',
            'BEGIN',
            'COMMIT',
            'outer-callback-returned',
            'COMMIT',
            'INNER-EFFECT',
        ]);
    });
});
