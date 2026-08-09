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

const mockCheckPortfolioAppetite = jest.fn();
const mockRecordBreaches = jest.fn();
const mockResolveStaleBreaches = jest.fn();

const mockGenerateReport = jest.fn();
const mockDeliverReportByEmail = jest.fn();
const mockDeliverReportToSharePoint = jest.fn();
const mockComputeNextRun = jest.fn();

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
import { runEmbedChunks } from '@/app-layer/jobs/embed-chunks';
import { runSyncPull } from '@/app-layer/jobs/sync-pull';

beforeEach(() => {
    jest.clearAllMocks();
});



// ─── risk-appetite monitor ───────────────────────────────────────────


// ─── report delivery ─────────────────────────────────────────────────


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
