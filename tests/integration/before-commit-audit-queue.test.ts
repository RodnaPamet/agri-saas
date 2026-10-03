/**
 * Every audited write gets its row, at `PG_POOL_MAX` concurrency. (#1223)
 *
 * ## The defect
 *
 * `appendAuditEntry` opened its own `$transaction` on the global client, so an
 * audited write needed a SECOND pool connection. At `max` it could not get one
 * and the row was lost while the business write committed. Measured at exactly
 * `max`: **12 writes, 11 audit rows** — every one of them `actorType: SYSTEM`,
 * the rows the Prisma audit EXTENSION writes.
 *
 * #1271 fixed the compliance-critical half via `logEvent`, which already
 * received the caller's transaction. It could not reach the extension: a
 * `$extends({ query })` handler is given `model`, `operation`, `args` and
 * `query` — never the transaction client. So the path that actually lost rows
 * had no way to write on the open transaction.
 *
 * `src/lib/db/before-commit.ts` closes that: the extension enqueues into an
 * ALS-scoped queue and the `db-context.ts` helpers, which hold `tx`, drain it
 * onto that transaction before COMMIT.
 *
 * ## Why the ownership test is here
 *
 * The queue and the drain are ONE function on purpose. Splitting them into
 * "open a scope" and "flush it" makes a specific bug available: a nested
 * helper would drain the OUTER transaction's queued rows onto its own `tx`.
 * `runInTenantContext` IS a `$transaction` and usecases call usecases, so that
 * nesting is ordinary. The second test pins that an inner frame joins without
 * draining.
 */
import { Client } from 'pg';
import { randomUUID } from 'crypto';

import { withTenantDb, runInTenantContext } from '@/lib/db-context';
import { createTenantWithDek, clearTenantDekCache } from '@/lib/security/tenant-key-manager';
import { PG_POOL_MAX } from '@/lib/db/pool-config';
import {
    pendingAuditCount,
    isInsideAuditQueue,
    enqueueAuditEntry,
    runWithAuditQueue,
} from '@/lib/db/before-commit';
import { makeRequestContext } from '../helpers/make-context';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const APP_DB_URL = process.env.DATABASE_URL ?? DB_URL;
const describeFn = DB_AVAILABLE ? describe : describe.skip;
const TENANT = `t-bcq-${randomUUID()}`;

describeFn('audit rows survive PG_POOL_MAX concurrency (#1223)', () => {
    let client: Client;

    beforeAll(async () => {
        client = new Client({ connectionString: APP_DB_URL });
        await client.connect();
        await createTenantWithDek({ id: TENANT, name: 'bcq', slug: TENANT });
    });

    afterAll(async () => {
        await client.query('DELETE FROM "Location" WHERE "tenantId" = $1', [TENANT]).catch(() => undefined);
        await client.end();
    });

    const systemRows = async (): Promise<number> => {
        const r = await client.query(
            `SELECT count(*)::int AS n FROM "AuditLog"
             WHERE "tenantId" = $1 AND "entity" = 'Location' AND "actorType" = 'SYSTEM'`,
            [TENANT],
        );
        return r.rows[0].n as number;
    };

    it('control: there is no queue outside a transaction helper', () => {
        // If a scope leaked module-wide, the concurrency result below would be
        // about a different mechanism than the one under test.
        expect(isInsideAuditQueue()).toBe(false);
        expect(pendingAuditCount()).toBe(0);
    });

    it('control: inside a helper there IS a queue, and the extension fills it', async () => {
        // Without this, "all the rows arrived" is also what a build that never
        // queued anything and fell back to its own transaction produces — which
        // is the pre-#1223 behaviour this test exists to distinguish from.
        let insideScope = false;
        let queuedDuringBody = 0;
        await withTenantDb(TENANT, async (db) => {
            insideScope = isInsideAuditQueue();
            await db.location.create({
                data: { id: `loc-${randomUUID()}`, tenantId: TENANT, name: 'queue-probe' },
            });
            // The extension has queued its SYSTEM row and nothing has drained
            // it yet, because the drain runs after this body returns.
            queuedDuringBody = pendingAuditCount();
        });
        expect(insideScope).toBe(true);
        expect(queuedDuringBody).toBeGreaterThanOrEqual(1);
        // ...and it is drained by the time the helper resolves.
        expect(pendingAuditCount()).toBe(0);
    });

    it('a NESTED helper joins the scope and does not drain early', async () => {
        // The bug that unifying scope-and-drain exists to prevent: an inner
        // frame draining the outer transaction's rows onto its own `tx`.
        let outerQueuedAfterInner = 0;
        await withTenantDb(TENANT, async (db) => {
            await db.location.create({
                data: { id: `loc-outer-${randomUUID()}`, tenantId: TENANT, name: 'outer' },
            });
            const queuedBefore = pendingAuditCount();
            expect(queuedBefore).toBeGreaterThanOrEqual(1);

            // A nested helper. It must NOT drain what the outer frame queued.
            await runInTenantContext(
                makeRequestContext('ADMIN', { tenantId: TENANT, userId: 'u-bcq' }) as never,
                async (inner) => {
                    await (inner as never as typeof db).location.create({
                        data: { id: `loc-inner-${randomUUID()}`, tenantId: TENANT, name: 'inner' },
                    });
                },
            );

            outerQueuedAfterInner = pendingAuditCount();
        });
        // The outer frame's row was still pending after the inner returned —
        // i.e. the inner joined rather than draining.
        expect(outerQueuedAfterInner).toBeGreaterThanOrEqual(2);
        expect(pendingAuditCount()).toBe(0);
    });

    it(`${PG_POOL_MAX} concurrent audited writes all get their audit row`, async () => {
        // THE REGRESSION TEST. Before: 12 writes, 11 rows. Cold DEK cache and a
        // barrier, because a harness that never achieved concurrency produces a
        // green result too.
        clearTenantDekCache();
        const before = await systemRows();

        let release!: () => void;
        const barrier = new Promise<void>((r) => { release = r as () => void; });
        const runs = Array.from({ length: PG_POOL_MAX }, (_, i) =>
            withTenantDb(TENANT, async (db) => {
                await barrier;
                return db.location.create({
                    data: { id: `loc-c${i}-${randomUUID()}`, tenantId: TENANT, name: `conc-${i}` },
                });
            }),
        );
        release();
        const settled = await Promise.allSettled(runs);

        const rejected = settled.filter((s) => s.status === 'rejected');
        if (rejected.length > 0) {
            throw new Error(
                `${rejected.length}/${PG_POOL_MAX} transactions failed: ` +
                    rejected
                        .map((r) => String((r as PromiseRejectedResult).reason).slice(0, 120))
                        .join(' | '),
            );
        }

        const rows = await client.query(
            `SELECT count(*)::int AS n FROM "Location" WHERE "tenantId" = $1 AND name LIKE 'conc-%'`,
            [TENANT],
        );
        // Both halves, which #1223 showed coming apart: every write committed
        // AND every audit row is there.
        expect(rows.rows[0].n).toBe(PG_POOL_MAX);
        expect(await systemRows()).toBe(before + PG_POOL_MAX);
    }, 90_000);
});

/**
 * The writer is INJECTED, and these are the tests that would have caught it
 * not being.
 *
 * The first revision resolved `appendAuditEntry` inside `drain` with
 * `require('../audit/audit-writer')`. Every test in the block above passed.
 * The production webpack build returned that module WITHOUT the export —
 * `audit-writer` statically imports `@/lib/prisma`, which reaches this module,
 * and requiring it from this side crosses the cycle in the direction nothing
 * had proven. Result: `e is not a function` on every drained row, 274 of them
 * in one E2E shard, and tenant creation plus invite creation both 500ing
 * because the fail-closed tier rethrows.
 *
 * None of that is reproducible under jest, which resolves the require fine.
 * So these tests pin the two things that ARE checkable here: the drain calls
 * the writer it was HANDED (so nothing can quietly go back to resolving one),
 * and a writer that is not callable is refused at enqueue instead of becoming
 * a queue of rows nothing can write. They need no database — the injected
 * writer is a spy and never touches the transaction.
 */
describe('the queue never resolves its own writer (#1223)', () => {
    const fakeTx = {
        $executeRawUnsafe: jest.fn().mockResolvedValue(0),
        $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    };

    beforeEach(() => {
        fakeTx.$executeRawUnsafe.mockClear();
        fakeTx.$queryRawUnsafe.mockClear();
    });

    it('drains through the INJECTED writer, with the caller transaction', async () => {
        const write = jest.fn().mockResolvedValue(undefined);

        await runWithAuditQueue(fakeTx as never, async () => {
            const queued = enqueueAuditEntry({
                input: { tenantId: 'T', requestId: 'R', action: 'CREATE' },
                failClosed: false,
                model: 'Location',
                operation: 'create',
                write,
            });
            expect(queued).toBe(true);
            // Still queued, not yet written — the drain happens on the way out.
            expect(write).not.toHaveBeenCalled();
            expect(pendingAuditCount()).toBe(1);
        });

        expect(write).toHaveBeenCalledTimes(1);
        const [input, client, opts] = write.mock.calls[0];
        expect(input).toMatchObject({ tenantId: 'T' });
        // The CALLER's transaction, which is the whole point of the queue.
        expect(client).toBe(fakeTx);
        expect(opts).toEqual({ onCallerTransaction: true, isolateFailure: true });
    });

    it('a fail-closed entry asks the writer NOT to isolate its failure', async () => {
        const write = jest.fn().mockResolvedValue(undefined);
        await runWithAuditQueue(fakeTx as never, async () => {
            enqueueAuditEntry({
                input: { tenantId: 'T' },
                failClosed: true,
                model: 'TenantInvite',
                operation: 'create',
                write,
            });
        });
        // `isolateFailure: false` is what makes a failed append abort the
        // caller's write, which is the tier's reason to exist. The E2E 500s
        // were this arm working correctly on a writer that could not run.
        expect(write.mock.calls[0][2]).toEqual({
            onCallerTransaction: true,
            isolateFailure: false,
        });
    });

    it('refuses a writer that is not callable, rather than queueing it', async () => {
        // THE REGRESSION TEST. `undefined` is exactly what the production build
        // handed the old self-resolving drain. Refusing returns false, which
        // routes the row to the caller's own fallback — so it is still WRITTEN.
        await runWithAuditQueue(fakeTx as never, async () => {
            const queued = enqueueAuditEntry({
                input: { tenantId: 'T' },
                failClosed: false,
                model: 'Location',
                operation: 'create',
                write: undefined as never,
            });
            expect(queued).toBe(false);
            // and nothing is sitting in the queue waiting for a writer.
            expect(pendingAuditCount()).toBe(0);
        });
    });

    it('resolves no module at runtime — the cycle edge is gone', () => {
        // Structural, and deliberately so: the defect was invisible to every
        // behavioural test in this file because jest's resolution differs from
        // webpack's. What is checkable is that this module asks for nothing.
        const fs = require('fs') as typeof import('fs');
        const path = require('path') as typeof import('path');
        const src = fs.readFileSync(
            path.resolve(__dirname, '../../src/lib/db/before-commit.ts'),
            'utf8',
        );
        // Positive control: the file was found and is the one we mean.
        expect(src).toContain('export function enqueueAuditEntry');
        expect(src).toContain('entry.write(');
        // The teeth. Narrow to the RESOLUTION forms on purpose: the docblock
        // above names `audit-writer` in prose to explain why it is absent, and
        // an assertion that banned the word would fail on its own explanation.
        expect(src).not.toMatch(/\brequire\s*\(/);
        expect(src).not.toMatch(/^\s*import[^;]*audit-writer/m);
    });
});
