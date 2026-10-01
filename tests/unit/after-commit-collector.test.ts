/**
 * `afterCommit` — the collector's own contract, with no database involved.
 *
 * Every assertion here is about a property that was FALSE in the shape this
 * replaces (`await notifyOtherParty(...)` inside the sender's transaction):
 *
 *   • effects do not run while the transaction is open
 *   • a rollback runs NONE of them
 *   • a nested transaction's effects wait for the OUTERMOST commit, not its own
 *   • a failing effect neither fails the transaction nor stops its siblings
 *   • two concurrent transactions never see each other's queue
 *
 * The last one is why this module uses AsyncLocalStorage and not the
 * module-level stack in `audit-context.ts`: a shared stack hands the "current"
 * queue to whichever request pushed last. The concurrency test below fails
 * against a stack implementation and passes against ALS, which is the only
 * reason to believe the difference matters.
 */
import {
    afterCommit,
    runWithAfterCommit,
    isInsideTransaction,
    pendingAfterCommitCount,
} from '@/lib/db/after-commit';

/** Yield to the macrotask queue, so "did it run yet" is a real question. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('afterCommit: effects fire after the commit, never during', () => {
    it('does not run an effect while the transaction body is still open', async () => {
        const order: string[] = [];

        await runWithAfterCommit(async () => {
            afterCommit('effect', () => {
                order.push('effect');
            });
            // Several turns of the event loop inside the "transaction".
            await tick();
            await tick();
            order.push('still-open');
            expect(pendingAfterCommitCount()).toBe(1);
        });

        expect(order).toEqual(['still-open', 'effect']);
    });

    it('awaits an async effect before the caller resumes', async () => {
        const order: string[] = [];

        await runWithAfterCommit(async () => {
            afterCommit('slow', async () => {
                await tick();
                order.push('slow-effect');
            });
            order.push('body');
        });
        order.push('after-return');

        // The drain is awaited, so a caller that returns 200 has already done
        // the notifying. That is the same latency as the inline version and is
        // what lets the integration tests assert without polling.
        expect(order).toEqual(['body', 'slow-effect', 'after-return']);
    });

    it('runs effects in the order they were queued', async () => {
        const order: number[] = [];
        await runWithAfterCommit(async () => {
            for (const n of [1, 2, 3, 4]) afterCommit(`e${n}`, () => order.push(n));
        });
        expect(order).toEqual([1, 2, 3, 4]);
    });
});

describe('afterCommit: a rollback runs nothing', () => {
    it('discards every queued effect when the body throws', async () => {
        const ran: string[] = [];

        await expect(
            runWithAfterCommit(async () => {
                afterCommit('bell', () => ran.push('bell'));
                afterCommit('publish', () => ran.push('publish'));
                afterCommit('email', () => ran.push('email'));
                throw new Error('simulated ROLLBACK');
            }),
        ).rejects.toThrow('simulated ROLLBACK');

        // Not "fewer than before" — zero. This is the production defect:
        // notifications for a message that does not exist.
        expect(ran).toEqual([]);
    });

    it('re-throws the original error rather than masking it', async () => {
        const boom = new Error('P2002');
        await expect(
            runWithAfterCommit(async () => {
                afterCommit('noop', () => undefined);
                throw boom;
            }),
        ).rejects.toBe(boom);
    });
});

describe('afterCommit: nesting drains at the OUTERMOST boundary', () => {
    it('holds an inner transaction’s effects until the outer one commits', async () => {
        const order: string[] = [];

        await runWithAfterCommit(async () => {
            await runWithAfterCommit(async () => {
                afterCommit('inner', () => order.push('inner-effect'));
                order.push('inner-body');
            });
            // The inner "transaction" has resolved. If it had drained its own
            // queue, 'inner-effect' would be here — and a notification would
            // again be out of the door before the enclosing write committed.
            order.push('between');
            afterCommit('outer', () => order.push('outer-effect'));
            order.push('outer-body');
        });

        expect(order).toEqual([
            'inner-body',
            'between',
            'outer-body',
            'inner-effect',
            'outer-effect',
        ]);
    });

    it('drops an inner transaction’s effects when the OUTER one rolls back', async () => {
        const ran: string[] = [];

        await expect(
            runWithAfterCommit(async () => {
                await runWithAfterCommit(async () => {
                    afterCommit('inner', () => ran.push('inner'));
                });
                throw new Error('outer rollback');
            }),
        ).rejects.toThrow('outer rollback');

        // Deliberately conservative: Prisma does not nest transactions, so the
        // inner one's WRITES survive the outer rollback. Its announcements do
        // not. Skipping a notification is recoverable; sending one about work
        // that was undone is not.
        expect(ran).toEqual([]);
    });

    it('reports transaction depth through isInsideTransaction()', async () => {
        expect(isInsideTransaction()).toBe(false);
        await runWithAfterCommit(async () => {
            expect(isInsideTransaction()).toBe(true);
            await runWithAfterCommit(async () => {
                expect(isInsideTransaction()).toBe(true);
            });
        });
        expect(isInsideTransaction()).toBe(false);
    });
});

describe('afterCommit: a failing effect is contained', () => {
    it('does not fail the transaction and does not skip later effects', async () => {
        const ran: string[] = [];

        const result = await runWithAfterCommit(async () => {
            afterCommit('first', () => ran.push('first'));
            afterCommit('throws', () => {
                throw new Error('mail server down');
            });
            afterCommit('rejects', () => Promise.reject(new Error('redis down')));
            afterCommit('last', () => ran.push('last'));
            return 'committed';
        });

        expect(result).toBe('committed');
        expect(ran).toEqual(['first', 'last']);
    });
});

describe('afterCommit: with no transaction open', () => {
    it('runs the effect immediately rather than dropping it', async () => {
        const ran: string[] = [];
        afterCommit('no-tx', () => ran.push('no-tx'));
        await tick();
        expect(ran).toEqual(['no-tx']);
        expect(pendingAfterCommitCount()).toBe(0);
    });

    it('swallows a rejection from the immediate path (no unhandled rejection)', async () => {
        afterCommit('no-tx-throws', () => Promise.reject(new Error('contained')));
        await tick();
        // Reaching here without the process emitting an unhandled rejection IS
        // the assertion; `expect` keeps the test from reading as empty.
        expect(isInsideTransaction()).toBe(false);
    });
});

describe('afterCommit: concurrent transactions do not share a queue', () => {
    it('keeps each transaction’s effects with its own commit', async () => {
        const ran: string[] = [];

        /** A transaction that interleaves with its sibling on purpose. */
        const tx = async (label: string, delay: number) =>
            runWithAfterCommit(async () => {
                await new Promise<void>((r) => setTimeout(r, delay));
                afterCommit(label, () => ran.push(label));
                expect(pendingAfterCommitCount()).toBe(1);
                await new Promise<void>((r) => setTimeout(r, delay));
            });

        await Promise.all([tx('a', 4), tx('b', 1), tx('c', 2), tx('d', 3)]);

        // Each queue held exactly its own effect (asserted inside), and all
        // four fired exactly once.
        expect(ran.sort()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('does not let a rolled-back sibling cancel a committing one', async () => {
        const ran: string[] = [];

        const ok = runWithAfterCommit(async () => {
            afterCommit('kept', () => ran.push('kept'));
            await new Promise<void>((r) => setTimeout(r, 3));
        });
        const failed = runWithAfterCommit(async () => {
            afterCommit('dropped', () => ran.push('dropped'));
            await new Promise<void>((r) => setTimeout(r, 1));
            throw new Error('sibling rollback');
        });

        await expect(failed).rejects.toThrow('sibling rollback');
        await ok;

        expect(ran).toEqual(['kept']);
    });
});
