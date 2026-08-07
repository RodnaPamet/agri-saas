/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * Zero-coverage jobs, wave 7: the remaining cron fan-outs plus the two
 * single-target jobs.
 *
 *   risk-snapshot-jobs · risk-appetite-jobs · report-delivery-jobs
 *   embed-chunks · sync-pull
 *
 * The three cron jobs share a shape — iterate tenants, do work, keep
 * going — and the whole value of that shape is in what happens when one
 * iteration goes wrong. A cross-tenant nightly sweep that aborts on the
 * first bad tenant silently stops serving every tenant sorted after it,
 * and nothing in the type system or in a happy-path test notices.
 *
 * `report-delivery` carries the sharpest invariant in the set: the
 * `nextRunAt` advance sits deliberately OUTSIDE the try/catch. A schedule
 * whose generation throws must still move forward, or the cron re-selects
 * it on every tick forever — a poison pill that turns one broken template
 * into a permanent hot loop. Moving that update inside the try, which is
 * what "tidying up the error handling" looks like, creates exactly that.
 */

const mockPrisma = {
    risk: { findMany: jest.fn() },
    riskAppetiteConfig: { findMany: jest.fn() },
    reportSchedule: { findMany: jest.fn(), update: jest.fn() },
    tenantMembership: { findFirst: jest.fn() },
    integrationConnection: { findUnique: jest.fn(), findFirst: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: mockPrisma, prisma: mockPrisma }));

const mockTakeSnapshot = jest.fn();
const mockCleanupSnapshots = jest.fn();
jest.mock('@/app-layer/usecases/risk-snapshot', () => ({
    takeSnapshot: (...a: unknown[]) => mockTakeSnapshot(...a),
    cleanupSnapshots: (...a: unknown[]) => mockCleanupSnapshots(...a),
}));

const mockCheckPortfolioAppetite = jest.fn();
const mockRecordBreaches = jest.fn();
const mockResolveStaleBreaches = jest.fn();
jest.mock('@/app-layer/usecases/risk-appetite', () => ({
    checkPortfolioAppetite: (...a: unknown[]) => mockCheckPortfolioAppetite(...a),
    recordBreaches: (...a: unknown[]) => mockRecordBreaches(...a),
    resolveStaleBreaches: (...a: unknown[]) => mockResolveStaleBreaches(...a),
}));

const mockGenerateReport = jest.fn();
const mockDeliverReportByEmail = jest.fn();
const mockDeliverReportToSharePoint = jest.fn();
const mockComputeNextRun = jest.fn();
jest.mock('@/app-layer/usecases/risk-report', () => ({
    generateReport: (...a: unknown[]) => mockGenerateReport(...a),
    deliverReportByEmail: (...a: unknown[]) => mockDeliverReportByEmail(...a),
    deliverReportToSharePoint: (...a: unknown[]) => mockDeliverReportToSharePoint(...a),
    computeNextRun: (...a: unknown[]) => mockComputeNextRun(...a),
}));

const mockEmbed = jest.fn();
jest.mock('@/app-layer/ai/provider', () => ({ getEmbeddingProvider: () => ({ embed: mockEmbed }) }));

const mockQueryRaw = jest.fn();
const mockExecuteRaw = jest.fn();
const mockDb = { $queryRaw: mockQueryRaw, $executeRaw: mockExecuteRaw } as any;
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/lib/db/embeddings', () => ({
    toVectorLiteral: (v: number[]) => `[${v.join(',')}]`,
}));

const mockDecryptField = jest.fn();
jest.mock('@/lib/security/encryption', () => ({
    decryptField: (...a: unknown[]) => mockDecryptField(...a),
}));

const mockCreateOrchestrator = jest.fn();
jest.mock('@/app-layer/integrations/registry', () => ({
    integrationRegistry: { createOrchestrator: (...a: unknown[]) => mockCreateOrchestrator(...a) },
}));
jest.mock('@/app-layer/integrations/prisma-sync-store', () => ({
    PrismaSyncMappingStore: class {},
}));
jest.mock('@/app-layer/integrations/prisma-local-store', () => ({
    PrismaLocalStore: class {},
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { logger } from '@/lib/observability/logger';
import { runRiskSnapshot } from '@/app-layer/jobs/risk-snapshot-jobs';
import { runRiskAppetiteMonitor } from '@/app-layer/jobs/risk-appetite-jobs';
import { runReportDelivery } from '@/app-layer/jobs/report-delivery-jobs';
import { runEmbedChunks } from '@/app-layer/jobs/embed-chunks';
import { runSyncPull } from '@/app-layer/jobs/sync-pull';

beforeEach(() => {
    jest.clearAllMocks();
});

// ─── risk-snapshot ───────────────────────────────────────────────────

describe('runRiskSnapshot', () => {
    beforeEach(() => {
        mockPrisma.risk.findMany.mockResolvedValue([{ tenantId: 't1' }, { tenantId: 't2' }]);
        mockTakeSnapshot.mockResolvedValue({ riskSnapshots: 3 });
        mockCleanupSnapshots.mockResolvedValue(2);
    });

    it('snapshots every tenant with a live risk and aggregates the counters', async () => {
        expect(await runRiskSnapshot({} as any)).toEqual({
            tenants: 2,
            scanned: 2,
            riskSnapshots: 6,
            pruned: 4,
        });
    });

    it('selects DISTINCT tenants from non-deleted risks only', async () => {
        // Soft-deleted risks must not keep a wound-down tenant in the
        // nightly sweep forever.
        await runRiskSnapshot({} as any);

        expect(mockPrisma.risk.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { deletedAt: null },
                distinct: ['tenantId'],
            }),
        );
    });

    it('prunes against the 730-day retention window', async () => {
        await runRiskSnapshot({} as any);
        expect(mockCleanupSnapshots).toHaveBeenCalledWith(expect.anything(), 't1', 730);
    });

    it('isolates a failing tenant so later tenants still run', async () => {
        // The property the whole loop exists for: t2 must still be
        // snapshotted after t1 blows up.
        mockTakeSnapshot
            .mockRejectedValueOnce(new Error('deadlock detected'))
            .mockResolvedValueOnce({ riskSnapshots: 5 });
        mockCleanupSnapshots.mockResolvedValue(1);

        expect(await runRiskSnapshot({} as any)).toEqual({
            tenants: 2,
            scanned: 1, // only t2 completed
            riskSnapshots: 5,
            pruned: 1,
        });
        expect(logger.warn).toHaveBeenCalledWith(
            'risk-snapshot: tenant snapshot failed',
            expect.objectContaining({ tenantId: 't1', error: 'deadlock detected' }),
        );
    });

    it('stringifies a non-Error rejection', async () => {
        mockTakeSnapshot.mockRejectedValue('pg terminated');

        await runRiskSnapshot({} as any);

        expect(logger.warn).toHaveBeenCalledWith(
            'risk-snapshot: tenant snapshot failed',
            expect.objectContaining({ error: 'pg terminated' }),
        );
    });

    it('is a no-op with no tenants', async () => {
        mockPrisma.risk.findMany.mockResolvedValue([]);
        expect(await runRiskSnapshot({} as any)).toEqual({
            tenants: 0,
            scanned: 0,
            riskSnapshots: 0,
            pruned: 0,
        });
    });
});

// ─── risk-appetite monitor ───────────────────────────────────────────

describe('runRiskAppetiteMonitor', () => {
    beforeEach(() => {
        mockPrisma.riskAppetiteConfig.findMany.mockResolvedValue([
            { tenantId: 't1' },
            { tenantId: 't2' },
        ]);
        mockPrisma.tenantMembership.findFirst.mockResolvedValue({ userId: 'u1', role: 'ADMIN' });
        mockCheckPortfolioAppetite.mockResolvedValue({ breaches: [{ riskId: 'r1' }] });
        mockRecordBreaches.mockResolvedValue(1);
        mockResolveStaleBreaches.mockResolvedValue(2);
    });

    it('scans each configured tenant and aggregates breach counts', async () => {
        expect(await runRiskAppetiteMonitor({} as any)).toEqual({
            tenants: 2,
            scanned: 2,
            newBreaches: 2,
            resolved: 4,
        });
    });

    it('builds a risk-read context from the longest-standing admin', async () => {
        await runRiskAppetiteMonitor({} as any);

        expect(mockPrisma.tenantMembership.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId: 't1', status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
                orderBy: { createdAt: 'asc' },
            }),
        );
        const ctx = mockCheckPortfolioAppetite.mock.calls[0][0];
        expect(ctx).toMatchObject({ tenantId: 't1', userId: 'u1', role: 'ADMIN' });
        expect(ctx.permissions.canRead).toBe(true);
    });

    it('skips a tenant with no eligible admin without counting it as scanned', async () => {
        mockPrisma.tenantMembership.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ userId: 'u2', role: 'OWNER' });

        expect(await runRiskAppetiteMonitor({} as any)).toMatchObject({ tenants: 2, scanned: 1 });
        expect(mockCheckPortfolioAppetite).toHaveBeenCalledTimes(1);
    });

    it('isolates a failing tenant scan', async () => {
        mockCheckPortfolioAppetite
            .mockRejectedValueOnce(new Error('appetite config malformed'))
            .mockResolvedValueOnce({ breaches: [] });

        expect(await runRiskAppetiteMonitor({} as any)).toMatchObject({ scanned: 1 });
        expect(logger.warn).toHaveBeenCalledWith(
            'risk-appetite-monitor: tenant scan failed',
            expect.objectContaining({ tenantId: 't1', error: 'appetite config malformed' }),
        );
    });

    it('stringifies a non-Error rejection', async () => {
        mockCheckPortfolioAppetite.mockRejectedValue({ code: 'P2002' });

        await runRiskAppetiteMonitor({} as any);

        expect(logger.warn).toHaveBeenCalledWith(
            'risk-appetite-monitor: tenant scan failed',
            expect.objectContaining({ error: '[object Object]' }),
        );
    });
});

// ─── report delivery ─────────────────────────────────────────────────

describe('runReportDelivery', () => {
    const schedule = (over: Record<string, unknown> = {}) => ({
        id: 's1',
        tenantId: 't1',
        templateId: 'tpl-1',
        format: 'PDF',
        cadence: 'WEEKLY',
        parametersJson: { from: '2026-01-01' },
        recipientsJson: ['ops@example.com'],
        sharePointDriveId: null,
        sharePointFolderId: null,
        template: { name: 'Quarterly risk' },
        ...over,
    });

    beforeEach(() => {
        mockPrisma.reportSchedule.findMany.mockResolvedValue([schedule()]);
        mockPrisma.reportSchedule.update.mockResolvedValue({});
        mockPrisma.tenantMembership.findFirst.mockResolvedValue({ userId: 'u1', role: 'ADMIN' });
        mockGenerateReport.mockResolvedValue({ id: 'run-1' });
        mockDeliverReportByEmail.mockResolvedValue(1);
        mockDeliverReportToSharePoint.mockResolvedValue(null);
        mockComputeNextRun.mockReturnValue(new Date('2026-08-03T00:00:00Z'));
    });

    it('generates, emails and advances the schedule', async () => {
        expect(await runReportDelivery({} as any)).toEqual({
            due: 1,
            generated: 1,
            delivered: 1,
            pushed: 0,
            failed: 0,
        });

        expect(mockGenerateReport).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 't1' }),
            'tpl-1',
            { from: '2026-01-01' },
            'PDF',
        );
        expect(mockPrisma.reportSchedule.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 's1' } }),
        );
    });

    it('only selects active schedules that are actually due', async () => {
        await runReportDelivery({} as any);

        const where = mockPrisma.reportSchedule.findMany.mock.calls[0][0].where;
        expect(where.isActive).toBe(true);
        expect(where.nextRunAt.lte).toBeInstanceOf(Date);
    });

    it('ADVANCES nextRunAt even when generation throws — no poison pill', async () => {
        // The invariant. The update lives outside the try/catch on purpose:
        // a schedule whose template is broken must still move forward, or
        // the cron re-selects it on every tick forever. Moving this update
        // inside the try — what "tidying the error handling" looks like —
        // creates a permanent hot loop.
        mockGenerateReport.mockRejectedValue(new Error('template renderer crashed'));

        expect(await runReportDelivery({} as any)).toEqual({
            due: 1,
            generated: 0,
            delivered: 0,
            pushed: 0,
            failed: 1,
        });

        expect(mockPrisma.reportSchedule.update).toHaveBeenCalledTimes(1);
        expect(mockPrisma.reportSchedule.update.mock.calls[0][0].data.nextRunAt).toEqual(
            new Date('2026-08-03T00:00:00Z'),
        );
        expect(logger.warn).toHaveBeenCalledWith(
            'report-delivery: scheduled generation failed',
            expect.objectContaining({ scheduleId: 's1', error: 'template renderer crashed' }),
        );
    });

    it('stringifies a non-Error generation failure', async () => {
        mockGenerateReport.mockRejectedValue('renderer OOM');

        expect(await runReportDelivery({} as any)).toMatchObject({ failed: 1 });
        expect(logger.warn).toHaveBeenCalledWith(
            'report-delivery: scheduled generation failed',
            expect.objectContaining({ error: 'renderer OOM' }),
        );
        // Still advances — same poison-pill rule.
        expect(mockPrisma.reportSchedule.update).toHaveBeenCalledTimes(1);
    });

    it('does NOT advance a schedule whose tenant has no admin', async () => {
        // Documenting real behaviour rather than asserting it is ideal: the
        // `continue` fires before the update, so a tenant that loses its
        // last admin keeps its schedule pinned as due. That is arguably
        // right (don't silently skip a cycle for a misconfigured tenant),
        // but it does mean the row is re-selected every tick — worth
        // knowing before anyone debugs a busy cron.
        mockPrisma.tenantMembership.findFirst.mockResolvedValue(null);

        expect(await runReportDelivery({} as any)).toMatchObject({ due: 1, generated: 0 });
        expect(mockPrisma.reportSchedule.update).not.toHaveBeenCalled();
    });

    it('counts a delivery only when at least one recipient was emailed', async () => {
        mockDeliverReportByEmail.mockResolvedValue(0);

        expect(await runReportDelivery({} as any)).toMatchObject({ generated: 1, delivered: 0 });
    });

    it('counts a SharePoint push only when an item id comes back', async () => {
        mockDeliverReportToSharePoint.mockResolvedValue('sp-item-9');

        expect(await runReportDelivery({} as any)).toMatchObject({ pushed: 1 });
        expect(logger.info).toHaveBeenCalledWith(
            'report-delivery: generated + delivered scheduled report',
            expect.objectContaining({ sharePoint: 'pushed' }),
        );
    });

    it.each([
        ['a non-array', { nope: true }, []],
        ['null', null, []],
        ['mixed junk', ['a@b.c', 42, null, 'd@e.f'], ['a@b.c', 'd@e.f']],
    ])('coerces %s recipientsJson safely', async (_label, recipientsJson, expected) => {
        // recipientsJson is untyped JSON; a stray number would otherwise
        // reach the mail transport as an address.
        mockPrisma.reportSchedule.findMany.mockResolvedValue([schedule({ recipientsJson })]);

        await runReportDelivery({} as any);

        expect(mockDeliverReportByEmail).toHaveBeenCalledWith(expect.anything(), expected, expect.any(String));
    });

    it('falls back to defaults for a schedule with no format, params or template name', async () => {
        mockPrisma.reportSchedule.findMany.mockResolvedValue([
            schedule({ format: null, parametersJson: null, template: null }),
        ]);

        await runReportDelivery({} as any);

        expect(mockGenerateReport).toHaveBeenCalledWith(expect.anything(), 'tpl-1', {}, 'PDF');
        expect(mockDeliverReportByEmail).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'Risk report');
    });
});

// ─── embed-chunks ────────────────────────────────────────────────────

describe('runEmbedChunks', () => {
    beforeEach(() => {
        mockQueryRaw.mockResolvedValue([
            { id: 'k1', text: 'wheat agronomy' },
            { id: 'k2', text: 'barley agronomy' },
        ]);
        mockEmbed.mockResolvedValue([{ vector: [0.1, 0.2] }, { vector: [0.3, 0.4] }]);
        mockExecuteRaw.mockResolvedValue(1);
    });

    it('embeds the batch in ONE provider call and writes each vector back', async () => {
        // The N+1 contract: one batched embed for the whole batch, not one
        // call per chunk. Per-row writes are unavoidable — pgvector has no
        // Prisma updateMany-with-vector path.
        expect(await runEmbedChunks({ tenantId: 't1' })).toEqual({
            tenantId: 't1',
            scanned: 2,
            embedded: 2,
        });

        expect(mockEmbed).toHaveBeenCalledTimes(1);
        expect(mockEmbed).toHaveBeenCalledWith({ texts: ['wheat agronomy', 'barley agronomy'] });
        expect(mockExecuteRaw).toHaveBeenCalledTimes(2);
    });

    it('returns early without paying for an empty provider call', async () => {
        mockQueryRaw.mockResolvedValue([]);

        expect(await runEmbedChunks({ tenantId: 't1' })).toEqual({
            tenantId: 't1',
            scanned: 0,
            embedded: 0,
        });
        expect(mockEmbed).not.toHaveBeenCalled();
    });

    it.each([
        ['the default', undefined, 128],
        ['a custom size', 32, 32],
        ['a zero clamped up', 0, 1],
        ['a negative clamped up', -5, 1],
        ['an oversized batch clamped down', 9999, 512],
    ])('bounds the batch — %s', async (_label, batchSize, expected) => {
        // The bound is what makes a huge backlog drain over several runs
        // instead of one unbounded sweep that times out.
        await runEmbedChunks({ tenantId: 't1', batchSize });

        // The tagged template puts the interpolated values after the
        // strings array; LIMIT is the last one.
        const values = mockQueryRaw.mock.calls[0].slice(1);
        expect(values[values.length - 1]).toBe(expected);
    });

    it('carries the tenantId in both the read and every write', async () => {
        // Defence in depth beside RLS — and the explicit filter is also
        // what excludes the GLOBAL (tenantId NULL) catalogue rows, which
        // are embedded by the ingestion script instead.
        await runEmbedChunks({ tenantId: 't1' });

        expect(mockQueryRaw.mock.calls[0].slice(1)).toContain('t1');
        for (const call of mockExecuteRaw.mock.calls) {
            expect(call.slice(1)).toContain('t1');
        }
    });
});

// ─── sync-pull ───────────────────────────────────────────────────────

describe('runSyncPull', () => {
    const payload = (over: Record<string, unknown> = {}) =>
        ({
            ctx: { tenantId: 't1', userId: 'u1' },
            mappingKey: {
                tenantId: 't1',
                provider: 'github',
                remoteEntityType: 'issue',
                remoteEntityId: '42',
            },
            remoteData: { title: 'x' },
            remoteUpdatedAtIso: '2026-07-01T00:00:00Z',
            ...over,
        }) as any;

    const orchestrator = () => ({
        pull: jest.fn().mockResolvedValue({ success: true, action: 'updated' }),
    });

    beforeEach(() => {
        mockPrisma.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn-1',
            configJson: { baseUrl: 'https://api.github.com' },
            secretEncrypted: null,
        });
        mockCreateOrchestrator.mockReturnValue(orchestrator());
    });

    it('resolves the connection by id when the mapping key carries one', async () => {
        mockPrisma.integrationConnection.findUnique.mockResolvedValue({
            id: 'conn-9',
            configJson: {},
            secretEncrypted: null,
        });

        await runSyncPull(payload({ mappingKey: { tenantId: 't1', provider: 'github', connectionId: 'conn-9' } }));

        expect(mockPrisma.integrationConnection.findUnique).toHaveBeenCalledWith({
            where: { id: 'conn-9' },
        });
        expect(mockPrisma.integrationConnection.findFirst).not.toHaveBeenCalled();
    });

    it('falls back to the first enabled connection for the provider', async () => {
        await runSyncPull(payload());

        expect(mockPrisma.integrationConnection.findFirst).toHaveBeenCalledWith({
            where: { tenantId: 't1', provider: 'github', isEnabled: true },
        });
    });

    it('warns and returns — does not throw — when no connection exists', async () => {
        // A webhook can outlive the connection that created it. Throwing
        // would put the job into a retry storm over something no retry fixes.
        mockPrisma.integrationConnection.findFirst.mockResolvedValue(null);

        await expect(runSyncPull(payload())).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalledWith(
            'No active connection found for sync-pull sync',
            expect.objectContaining({ provider: 'github' }),
        );
        expect(mockCreateOrchestrator).not.toHaveBeenCalled();
    });

    it('merges decrypted secrets over the stored config', async () => {
        mockPrisma.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn-1',
            configJson: { baseUrl: 'https://api.github.com', token: 'placeholder' },
            secretEncrypted: 'cipher',
        });
        mockDecryptField.mockReturnValue(JSON.stringify({ token: 'real-secret' }));

        await runSyncPull(payload());

        const opts = mockCreateOrchestrator.mock.calls[0][1];
        expect(opts.config).toEqual({ baseUrl: 'https://api.github.com', token: 'real-secret' });
    });

    it('throws a generic message when the secrets cannot be decrypted', async () => {
        // Deliberately generic — the decrypt failure detail is logged, not
        // surfaced into a job error message that may reach a UI.
        mockPrisma.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn-1',
            configJson: {},
            secretEncrypted: 'corrupt',
        });
        mockDecryptField.mockImplementation(() => {
            throw new Error('auth tag mismatch');
        });

        await expect(runSyncPull(payload())).rejects.toThrow('Connection secrets could not be decrypted');
        expect(logger.error).toHaveBeenCalled();
    });

    it('warns and returns when the provider has no orchestrator', async () => {
        mockCreateOrchestrator.mockReturnValue(null);

        await expect(runSyncPull(payload())).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalledWith(
            'Orchestrator could not be instantiated for provider',
            expect.objectContaining({ provider: 'github' }),
        );
    });

    it('passes a real Date to pull, parsed from the ISO payload', async () => {
        const o = orchestrator();
        mockCreateOrchestrator.mockReturnValue(o);

        await runSyncPull(payload());

        const arg = o.pull.mock.calls[0][0];
        expect(arg.remoteUpdatedAt).toEqual(new Date('2026-07-01T00:00:00Z'));
        expect(arg.remoteData).toEqual({ title: 'x' });
    });

    it('throws on an unsuccessful pull so BullMQ retries it', async () => {
        const o = {
            pull: jest.fn().mockResolvedValue({ success: false, errorMessage: 'remote 409 conflict' }),
        };
        mockCreateOrchestrator.mockReturnValue(o);

        await expect(runSyncPull(payload())).rejects.toThrow('remote 409 conflict');
    });

    it('falls back to a generic failure message when the pull gives none', async () => {
        mockCreateOrchestrator.mockReturnValue({
            pull: jest.fn().mockResolvedValue({ success: false }),
        });

        await expect(runSyncPull(payload())).rejects.toThrow('Sync pull failed');
    });

    it('forwards orchestrator sync events into the structured logger', async () => {
        await runSyncPull(payload());

        const opts = mockCreateOrchestrator.mock.calls[0][1];
        opts.logger.log({ kind: 'mapped', id: 'm1' });

        expect(logger.info).toHaveBeenCalledWith(
            'Sync event from sync-pull',
            expect.objectContaining({ syncEvent: { kind: 'mapped', id: 'm1' } }),
        );
    });
});
