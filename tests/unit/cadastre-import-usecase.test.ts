/**
 * Unit tests for the КАИС cadastre-import STAGING usecase
 * (`stageLocationCadastreImport` + `isCadastreImportEnabled`).
 *
 * The staging boundary is the request-side logic: feature gate, identifier
 * validate/normalize/de-dup, cap, location existence, enqueue. The heavy
 * off-thread work is covered by the job integration test; this pins the
 * cheap synchronous contract with all IO mocked.
 */
import { makeRequestContext } from '../helpers/make-context';

// ── Mocks (declared before the usecase import) ──
const mockEnqueue = jest.fn(async (..._args: unknown[]) => ({ id: 'job-123' }));
jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: (...args: unknown[]) => mockEnqueue(...args),
}));

// assertCanWrite is a no-op by default; overridden per-test to assert it runs.
const mockAssertCanWrite = jest.fn();
jest.mock('@/app-layer/policies/common', () => ({
    assertCanWrite: (...args: unknown[]) => mockAssertCanWrite(...args),
}));

// runInTenantContext hands the callback a db whose location lookup is
// practicelable (returns a row by default → "location found").
let mockLocationRow: { id: string } | null = { id: 'loc-1' };
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: unknown, cb: (db: unknown) => unknown) =>
            cb({
                location: {
                    findFirst: jest.fn(async () => mockLocationRow),
                },
            }),
    ),
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Env flag is toggled per-test.
let mockOpenDataUrl: string | undefined = 'https://kais.cadastre.bg';
jest.mock('@/env', () => ({
    get env() {
        return { CADASTRE_OPENDATA_INDEX_URL: mockOpenDataUrl };
    },
}));

import {
    stageLocationCadastreImport,
    isCadastreImportEnabled,
    MAX_CADASTRE_IDENTIFIERS,
} from '@/app-layer/usecases/cadastre-import';

describe('cadastre-import staging usecase', () => {
    const ctx = makeRequestContext();

    beforeEach(() => {
        jest.clearAllMocks();
        mockOpenDataUrl = 'https://kais.cadastre.bg';
        mockLocationRow = { id: 'loc-1' };
    });

    it('MAX_CADASTRE_IDENTIFIERS is the documented cap', () => {
        expect(MAX_CADASTRE_IDENTIFIERS).toBe(500);
    });

    it('isCadastreImportEnabled reflects the env flag', () => {
        mockOpenDataUrl = 'https://kais.cadastre.bg';
        expect(isCadastreImportEnabled()).toBe(true);
        mockOpenDataUrl = undefined;
        expect(isCadastreImportEnabled()).toBe(false);
    });

    it('rejects when the feature is disabled (env unset)', async () => {
        mockOpenDataUrl = undefined;
        await expect(
            stageLocationCadastreImport(ctx, 'loc-1', { identifiers: ['68134.8360.729'] }),
        ).rejects.toThrow(/not enabled/i);
        expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('asserts write permission before staging', async () => {
        await stageLocationCadastreImport(ctx, 'loc-1', { identifiers: ['68134.8360.729'] });
        expect(mockAssertCanWrite).toHaveBeenCalledWith(ctx);
    });

    it('rejects when no valid identifier remains', async () => {
        await expect(
            stageLocationCadastreImport(ctx, 'loc-1', { identifiers: ['garbage', 'also-bad'] }),
        ).rejects.toThrow(/no valid/i);
        expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('validates, de-duplicates, and enqueues the accepted identifiers', async () => {
        const res = await stageLocationCadastreImport(ctx, 'loc-1', {
            identifiers: [
                '68134.8360.729',
                '68134.8360.729', // duplicate → collapsed
                '00123.10.5', // leading-zero ЕКАТТЕ preserved
                'not-an-id', // → invalid, echoed back
            ],
        });
        expect(res.accepted).toBe(2);
        expect(res.invalid).toContain('not-an-id');
        expect(res.jobId).toBe('job-123');
        expect(mockEnqueue).toHaveBeenCalledTimes(1);
        const [jobName, payload] = mockEnqueue.mock.calls[0] as unknown as [string, { identifiers: string[] }];
        expect(jobName).toBe('cadastre-import');
        expect(payload.identifiers).toEqual(['68134.8360.729', '00123.10.5']);
    });

    it('rejects when the target location does not exist (tenant-scoped)', async () => {
        mockLocationRow = null;
        await expect(
            stageLocationCadastreImport(ctx, 'missing', { identifiers: ['68134.8360.729'] }),
        ).rejects.toThrow(/not found/i);
        expect(mockEnqueue).not.toHaveBeenCalled();
    });
});
