/**
 * A lost hash-chained audit row is REPORTED, in every environment.
 *
 * ## The defect (#1223)
 *
 * The audit extension's catch in `src/lib/prisma.ts` read:
 *
 *     } catch (auditError) {
 *         if (env.NODE_ENV === 'development') {
 *             auditMiddlewareLogger.warn('Failed to write audit log', { … });
 *         }
 *     }
 *
 * So in PRODUCTION the catch was empty. A write whose hash-chained `AuditLog`
 * row could not be written emitted no log, no metric, no error and no trace.
 * Measured at `PG_POOL_MAX` concurrency: 12 writes committed, **0 audit rows,
 * 0 rejections** — `appendAuditEntry` opens its own `$transaction` on the
 * global client, so at pool max it cannot get a connection, and the only
 * witness to the gap was gated off in the one environment that matters.
 *
 * A silent gap is worse than a loud one specifically BECAUSE the trail is
 * hash-chained: the chain's value is that tampering and loss are detectable,
 * and a gap nobody is told about defeats that at the point of loss.
 *
 * ## What this pins, and why it is an executing test
 *
 * The failure is a property of the real extension's catch under a real
 * `NODE_ENV`, so a source scan would prove only that a string appears. This
 * drives the actual client, forces `appendAuditEntry` to throw through the
 * lazy `require` the handler performs, and asserts on the two reporters plus
 * the contract.
 *
 * `NODE_ENV` is `test` under jest — neither `development` nor `production` —
 * which is exactly the discriminator: restoring the old gate makes the first
 * assertion fail here, while a gate on `production` would also fail. Only an
 * ungated report passes.
 */
import { randomUUID } from 'crypto';

const appendAuditEntry = jest.fn();
jest.mock('@/lib/audit/audit-writer', () => ({
    ...jest.requireActual('@/lib/audit/audit-writer'),
    appendAuditEntry: (...a: unknown[]) => appendAuditEntry(...a),
}));

import { runInTenantContext } from '@/lib/db-context';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { logger } from '@/lib/observability/logger';
import * as metrics from '@/lib/observability/metrics';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
const TENANT = `t-auditloud-${randomUUID()}`;

describeFn('a lost audit row is reported in every environment (#1223)', () => {
    let errorSpy: jest.SpyInstance;
    let metricSpy: jest.SpyInstance;
    let bare: typeof import('@prisma/client').PrismaClient.prototype;
    /**
     * The delegates these cleanups reach for, named rather than cast to `any`.
     *
     * `bare` is typed as `PrismaClient.prototype`, which does not expose the
     * model delegates, so every call below needed an escape. `as any` was that
     * escape and it cost a lint warning each — five in this file, and the
     * ceiling has no headroom left to pay for them (#1247 banked 25 and
     * warnings have since grown past it).
     *
     * A named shape is the better escape anyway: it says WHICH delegates the
     * test touches, so a model rename breaks here loudly instead of surviving
     * as `any` and failing at runtime.
     */
    type CleanupDelegates = {
        location: {
            deleteMany(args: unknown): Promise<unknown>;
            findUnique(args: unknown): Promise<unknown>;
        };
        auditLog: { deleteMany(args: unknown): Promise<{ count: number }> };
        tenant: { deleteMany(args: unknown): Promise<unknown> };
        $disconnect(): Promise<void>;
    };
    const raw = (): CleanupDelegates => bare as unknown as CleanupDelegates;


    beforeAll(async () => {
        const { PrismaClient } = require('@prisma/client');
        const { PrismaPg } = require('@prisma/adapter-pg');
        // The APP's own connection, not `DB_URL`. Those are the SAME database
        // in CI and can be DIFFERENT ones locally (#1265): `getBaseTestDatabaseUrl`
        // applies the per-checkout slot while `jest.setup.js` resolves
        // `DATABASE_URL` without it. A verifier built from `DB_URL` reads a
        // database the app never wrote to and reports the row as absent — which
        // is exactly how this test failed first time round.
        bare = new PrismaClient({
            adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? DB_URL }),
        });
        await createTenantWithDek({ id: TENANT, name: 'auditloud', slug: TENANT });
    });

    afterAll(async () => {
        await raw().location.deleteMany({ where: { tenantId: TENANT } });
        await raw().auditLog.deleteMany({ where: { tenantId: TENANT } }).catch(() => ({ count: 0 }));
        await raw().tenant.deleteMany({ where: { id: TENANT } });
        await raw().$disconnect();
    });

    beforeEach(() => {
        appendAuditEntry.mockReset();
        errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
        metricSpy = jest.spyOn(metrics, 'recordAuditWriteFailure').mockImplementation(() => undefined);
    });

    afterEach(() => {
        errorSpy.mockRestore();
        metricSpy.mockRestore();
    });

    const write = () =>
        runInTenantContext(
            { requestId: 'req-auditloud', userId: 'u-auditloud', tenantId: TENANT, role: 'ADMIN' } as never,
            async (db) =>
                db.location.create({
                    data: { id: `loc-${randomUUID()}`, tenantId: TENANT, name: 'auditloud' },
                }),
        );

    it('control: NODE_ENV is neither development nor production here', () => {
        // The whole point of the change is that the report is UNGATED. If this
        // environment happened to be `development`, the old code would also
        // pass and this file would prove nothing.
        expect(process.env.NODE_ENV).toBe('test');
    });

    it('control: the audit path is REACHED — the mock is actually called', async () => {
        appendAuditEntry.mockResolvedValue({ id: 'a', entryHash: 'h', previousHash: null });
        await write();
        // Without this, every assertion below would also pass if the extension
        // never ran at all (no audit context, a skipped model, a changed API).
        expect(appendAuditEntry).toHaveBeenCalled();
    });

    it('a FAILED audit write logs at error and increments the counter', async () => {
        // THE REGRESSION TEST.
        appendAuditEntry.mockRejectedValue(new Error('Timed out fetching a new connection from the pool'));

        await write();

        const audit = errorSpy.mock.calls.filter((c) => c[0] === 'audit.write_failed');
        expect(audit.length).toBeGreaterThanOrEqual(1);
        const fields = audit[0][1] as Record<string, unknown>;
        expect(fields.component).toBe('audit-middleware');
        expect(fields.tenantId).toBe(TENANT);
        expect(fields.model).toBe('Location');
        expect(String(fields.error)).toMatch(/connection from the pool/);

        expect(metricSpy).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'Location', action: 'CREATE' }),
        );
    });

    it('the business write still SUCCEEDS — the contract is unchanged', async () => {
        // `appendAuditEntry` runs after `query(args)` has resolved, so the row
        // is already committed. This change makes the loss visible; it must not
        // make the loss fatal. That decision is tracked separately.
        appendAuditEntry.mockRejectedValue(new Error('pool exhausted'));

        const created = await write();

        expect((created as { id: string }).id).toBeTruthy();
        const found = await raw().location.findUnique({
            where: { id: (created as { id: string }).id },
        });
        expect(found).not.toBeNull();
    });

    it('a SUCCEEDING audit write reports nothing — the reporters are conditional', async () => {
        // Negative control. Without it, a reporter fired unconditionally would
        // satisfy the regression test above and alert on every healthy write.
        appendAuditEntry.mockResolvedValue({ id: 'a', entryHash: 'h', previousHash: null });

        await write();

        expect(errorSpy.mock.calls.filter((c) => c[0] === 'audit.write_failed')).toHaveLength(0);
        expect(metricSpy).not.toHaveBeenCalled();
    });

    it('neither reporter can turn a lost row into a failed write', async () => {
        // Both are wrapped, because a committed write must not be reported as
        // failed just because the telemetry for its missing audit row broke.
        appendAuditEntry.mockRejectedValue(new Error('pool exhausted'));
        errorSpy.mockImplementation(() => { throw new Error('logger is down'); });
        metricSpy.mockImplementation(() => { throw new Error('meter is down'); });

        await expect(write()).resolves.toBeTruthy();
    });
});
