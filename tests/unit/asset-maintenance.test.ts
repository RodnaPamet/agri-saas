/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Maintenance-record usecases.
 *
 * The behaviour under test is the STATUS COUPLING, because it is the
 * part a future refactor is most likely to "simplify" into something
 * wrong. Opening a record suggests IN_MAINTENANCE; closing suggests
 * ACTIVE **only when it was the last open record** — a machine with two
 * open repairs is not fixed because one of them finished.
 *
 * Both are advisory: the usecase returns `suggestStatus` and the UI
 * prompts. Nothing here writes the asset's status as a side effect, and
 * these tests pin that too — silently flipping a machine's status
 * because someone logged an oil change would surprise an operator
 * entering history after the fact.
 *
 * Also satisfies the usecase-test-coverage guardrail.
 */

const mockDb = {} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/AssetRepository', () => ({
    AssetRepository: { getById: jest.fn(), update: jest.fn() },
}));

jest.mock('@/app-layer/repositories/AssetMaintenanceRepository', () => ({
    AssetMaintenanceRepository: {
        listForAsset: jest.fn(),
        listOpenForAsset: jest.fn(),
        getById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

import { AssetRepository } from '@/app-layer/repositories/AssetRepository';
import { AssetMaintenanceRepository } from '@/app-layer/repositories/AssetMaintenanceRepository';
import { logEvent } from '@/app-layer/events/audit';
import {
    createAssetMaintenance,
    closeAssetMaintenance,
    listAssetMaintenance,
} from '@/app-layer/usecases/asset-maintenance';
import { makeRequestContext } from '../helpers/make-context';

const ctx = () => makeRequestContext('EDITOR');
const ASSET = { id: 'ast-1', name: 'Tractor', status: 'ACTIVE' };

beforeEach(() => {
    jest.clearAllMocks();
    (AssetRepository.getById as jest.Mock).mockResolvedValue(ASSET);
    (AssetMaintenanceRepository.create as jest.Mock).mockImplementation(
        async (_db: any, _ctx: any, data: any) => ({ id: 'm-1', ...data }),
    );
    (AssetMaintenanceRepository.listOpenForAsset as jest.Mock).mockResolvedValue([]);
});

describe('createAssetMaintenance', () => {
    it('suggests IN_MAINTENANCE when opening a record on an ACTIVE machine', async () => {
        const { suggestStatus } = await createAssetMaintenance(ctx(), 'ast-1', { kind: 'REPAIR' });
        expect(suggestStatus).toBe('IN_MAINTENANCE');
    });

    it('does NOT write the asset status itself — the prompt does', async () => {
        await createAssetMaintenance(ctx(), 'ast-1', { kind: 'REPAIR' });
        expect(AssetRepository.update).not.toHaveBeenCalled();
    });

    it('suggests nothing when the record is already closed (history entry)', async () => {
        // Recording a service you did last month must not propose putting
        // the machine into maintenance today.
        const { suggestStatus } = await createAssetMaintenance(ctx(), 'ast-1', {
            kind: 'SERVICE',
            closedAt: '2026-01-01T00:00:00.000Z',
        });
        expect(suggestStatus).toBeNull();
    });

    it('sanitises the free-text description', async () => {
        await createAssetMaintenance(ctx(), 'ast-1', {
            kind: 'SERVICE',
            description: '<script>alert(1)</script>Oil change',
        });
        const written = (AssetMaintenanceRepository.create as jest.Mock).mock.calls[0][2];
        expect(written.description).not.toContain('<script>');
        expect(written.description).toContain('Oil change');
    });

    it('audits the write', async () => {
        await createAssetMaintenance(ctx(), 'ast-1', { kind: 'BREAKDOWN' });
        expect(logEvent).toHaveBeenCalledTimes(1);
    });

    it('404s for an asset outside the tenant', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(createAssetMaintenance(ctx(), 'nope', { kind: 'SERVICE' })).rejects.toThrow();
        expect(AssetMaintenanceRepository.create).not.toHaveBeenCalled();
    });
});

describe('closeAssetMaintenance', () => {
    beforeEach(() => {
        (AssetMaintenanceRepository.getById as jest.Mock).mockResolvedValue({
            id: 'm-1', assetId: 'ast-1', kind: 'REPAIR', closedAt: null,
        });
        (AssetMaintenanceRepository.update as jest.Mock).mockResolvedValue({
            id: 'm-1', closedAt: new Date(),
        });
    });

    it('suggests ACTIVE when it was the LAST open record', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ ...ASSET, status: 'IN_MAINTENANCE' });
        (AssetMaintenanceRepository.listOpenForAsset as jest.Mock).mockResolvedValue([]);

        const { suggestStatus, openCount } = await closeAssetMaintenance(ctx(), 'ast-1', 'm-1');
        expect(openCount).toBe(0);
        expect(suggestStatus).toBe('ACTIVE');
    });

    it('suggests NOTHING while other records remain open', async () => {
        // The subtle one: a machine with two open repairs is not fixed
        // because one of them finished.
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ ...ASSET, status: 'IN_MAINTENANCE' });
        (AssetMaintenanceRepository.listOpenForAsset as jest.Mock).mockResolvedValue([{ id: 'm-2' }]);

        const { suggestStatus, openCount } = await closeAssetMaintenance(ctx(), 'ast-1', 'm-1');
        expect(openCount).toBe(1);
        expect(suggestStatus).toBeNull();
    });

    it('suggests nothing when the asset was never IN_MAINTENANCE', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ ...ASSET, status: 'ACTIVE' });
        const { suggestStatus } = await closeAssetMaintenance(ctx(), 'ast-1', 'm-1');
        expect(suggestStatus).toBeNull();
    });

    it('rejects closing an already-closed record', async () => {
        (AssetMaintenanceRepository.getById as jest.Mock).mockResolvedValue({
            id: 'm-1', assetId: 'ast-1', kind: 'REPAIR', closedAt: new Date(),
        });
        await expect(closeAssetMaintenance(ctx(), 'ast-1', 'm-1')).rejects.toThrow();
    });

    it('rejects a record belonging to a different asset', async () => {
        // Cross-asset id confusion must 404, not silently close someone
        // else's record.
        (AssetMaintenanceRepository.getById as jest.Mock).mockResolvedValue({
            id: 'm-1', assetId: 'other-asset', kind: 'REPAIR', closedAt: null,
        });
        await expect(closeAssetMaintenance(ctx(), 'ast-1', 'm-1')).rejects.toThrow();
    });
});

describe('listAssetMaintenance', () => {
    it('404s for an asset outside the tenant instead of returning []', async () => {
        // An empty list would read as "this machine has no history",
        // which is a different claim from "no such machine".
        (AssetRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(listAssetMaintenance(ctx(), 'nope')).rejects.toThrow();
    });
});
