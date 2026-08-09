/**
 * Unit tests for src/app-layer/usecases/practice/page-data.ts
 *
 * The page-data orchestrator collapses the previous practice + sync
 * waterfall into one server-side aggregation. The load-bearing
 * assertions:
 *
 *   1. When the practice has no `automationKey`, sync lookup is
 *      skipped — the orchestrator returns `syncStatus: null` without
 *      touching the sync-mapping store.
 *   2. When the practice has an `automationKey`, the sync-mapping
 *      store is consulted and its result is mapped into the
 *      `SyncStatusPayload` shape.
 *   3. A failing sync lookup degrades to `syncStatus: null` rather
 *      than failing the whole call (the conflict badge is
 *      informational; the page must still load).
 *   4. `getPracticeHeader` errors propagate (not-found stays
 *      not-found).
 *
 * #102 item 1: the orchestrator reads `getPracticeHeader` (header
 * scalars + `_count`), not the full `getPractice`.
 */

jest.mock('../../../src/app-layer/usecases/practice/queries', () => ({
    getPracticeHeader: jest.fn(),
}));

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx, fn) => fn({})),
}));

const mockFindByLocalEntity = jest.fn();
jest.mock('@/app-layer/integrations/prisma-sync-store', () => ({
    PrismaSyncMappingStore: jest.fn().mockImplementation(() => ({
        findByLocalEntity: mockFindByLocalEntity,
    })),
}));

import { getPracticePageData } from '@/app-layer/usecases/practice/page-data';
import { getPracticeHeader } from '@/app-layer/usecases/practice/queries';
import { makeRequestContext } from '../../helpers/make-context';

const mockGetPracticeHeader = getPracticeHeader as jest.MockedFunction<
    typeof getPracticeHeader
>;

beforeEach(() => {
    jest.clearAllMocks();
});

const ctx = () => makeRequestContext('READER');

const ctrl = (overrides: Partial<{ id: string; automationKey: string | null }> = {}) =>
    ({
        id: 'ctrl-1',
        name: 'Sample',
        automationKey: null,
        ...overrides,
    }) as unknown as Awaited<ReturnType<typeof getPracticeHeader>>;

describe('getPracticePageData — no automationKey', () => {
    it('returns syncStatus: null and skips the sync store entirely', async () => {
        mockGetPracticeHeader.mockResolvedValue(ctrl({ automationKey: null }));

        const out = await getPracticePageData(ctx(), 'ctrl-1');

        expect(out.practice).toBeDefined();
        expect(out.syncStatus).toBeNull();
        expect(mockFindByLocalEntity).not.toHaveBeenCalled();
    });

    it('treats undefined automationKey the same as null', async () => {
        mockGetPracticeHeader.mockResolvedValue(
            ctrl({ automationKey: undefined as unknown as string | null }),
        );
        const out = await getPracticePageData(ctx(), 'ctrl-1');
        expect(out.syncStatus).toBeNull();
        expect(mockFindByLocalEntity).not.toHaveBeenCalled();
    });
});

describe('getPracticePageData — with automationKey', () => {
    it('looks up the sync mapping and maps it into SyncStatusPayload', async () => {
        mockGetPracticeHeader.mockResolvedValue(ctrl({ automationKey: 'jira.ABC-123' }));
        mockFindByLocalEntity.mockResolvedValue({
            syncStatus: 'IN_SYNC',
            lastSyncedAt: new Date('2026-01-01T00:00:00Z'),
            lastSyncDirection: 'PULL',
            errorMessage: null,
        });

        const out = await getPracticePageData(ctx(), 'ctrl-1');

        expect(mockFindByLocalEntity).toHaveBeenCalledWith(
            ctx().tenantId,
            'jira',
            'practice',
            'ctrl-1',
        );
        expect(out.syncStatus).toEqual({
            syncStatus: 'IN_SYNC',
            lastSyncedAt: new Date('2026-01-01T00:00:00Z'),
            lastSyncDirection: 'PULL',
            errorMessage: null,
            provider: 'jira',
        });
    });

    it('returns null sync fields when no mapping exists', async () => {
        mockGetPracticeHeader.mockResolvedValue(ctrl({ automationKey: 'jira.X' }));
        mockFindByLocalEntity.mockResolvedValue(null);

        const out = await getPracticePageData(ctx(), 'ctrl-1');

        expect(out.syncStatus).toEqual({
            syncStatus: null,
            lastSyncedAt: null,
            lastSyncDirection: null,
            errorMessage: null,
            provider: 'jira',
        });
    });
});

describe('getPracticePageData — degradation', () => {
    it('returns syncStatus: null when the sync lookup throws (does not fail the page)', async () => {
        mockGetPracticeHeader.mockResolvedValue(ctrl({ automationKey: 'jira.X' }));
        mockFindByLocalEntity.mockRejectedValue(new Error('store down'));

        const out = await getPracticePageData(ctx(), 'ctrl-1');

        expect(out.practice).toBeDefined();
        expect(out.syncStatus).toBeNull();
    });

    it('propagates getPracticeHeader errors (not-found stays not-found)', async () => {
        const err = Object.assign(new Error('Practice not found'), { code: 'NOT_FOUND' });
        mockGetPracticeHeader.mockRejectedValue(err);

        await expect(getPracticePageData(ctx(), 'ctrl-missing')).rejects.toThrow(
            'Practice not found',
        );
        expect(mockFindByLocalEntity).not.toHaveBeenCalled();
    });
});
