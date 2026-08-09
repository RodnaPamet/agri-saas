/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/asset.ts`.
 *
 * Roadmap Q3 — Asset (Edge tier, 37% statements, +23 to floor).
 * Single-file domain; this PR closes the whole domain.
 *
 * Covers:
 *   - listAssets / listAssetsPaginated / getAsset — read paths.
 *   - createAsset — repo delegation, audit shape.
 *   - updateAsset — ownerUserId three-state (undefined = no touch,
 *     '' or null = clear); ASSET_ASSIGNED notification fires ONLY
 *     on owner CHANGE to a real user; fire-and-forget error swallow;
 *     notFound + RBAC.
 *   - deleteAsset / restoreAsset / purgeAsset — admin gate +
 *     delegation + audit + notFound.
 *   - listAssetsWithDeleted — admin gate + withDeleted wrapper.
 *   - getAssetEvidenceTab / linkAssetEvidence / unlinkAssetEvidence —
 *     the asset Evidence-tab path (parallel to Risk/Practice patterns).
 */

const mockDb = {
    asset: { findFirst: jest.fn(), findMany: jest.fn() },
    evidence: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    // B7 — listAssets now folds in WorkItemRepository.countLinkedToEntities
    // (TaskLink count). Default to no links → taskTotal/taskDone = 0.
    taskLink: { findMany: jest.fn().mockResolvedValue([]) },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/AssetRepository', () => ({
    AssetRepository: {
        list: jest.fn(),
        listPaginated: jest.fn(),
        getById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => `SAN::${s}`),
}));

jest.mock('@/lib/cache/list-cache', () => ({
    bumpEntityCacheVersion: jest.fn(),
}));

jest.mock('@/app-layer/notifications/assignment', () => ({
    createAssignmentNotification: jest.fn(),
}));

jest.mock('@/app-layer/usecases/soft-delete-operations', () => ({
    restoreEntity: jest.fn(),
    purgeEntity: jest.fn(),
}));

jest.mock('@/lib/soft-delete', () => ({
    withDeleted: jest.fn((args: any) => ({ ...args, _withDeleted: true })),
}));

jest.mock('@/lib/observability', () => ({
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { AssetRepository } from '@/app-layer/repositories/AssetRepository';
import { logEvent } from '@/app-layer/events/audit';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import { createAssignmentNotification } from '@/app-layer/notifications/assignment';
import { restoreEntity, purgeEntity } from '@/app-layer/usecases/soft-delete-operations';
import {
    listAssets,
    listAssetsPaginated,
    getAsset,
    createAsset,
    updateAsset,
    deleteAsset,
    restoreAsset,
    purgeAsset,
    listAssetsWithDeleted,
    getAssetEvidenceTab,
    linkAssetEvidence,
    unlinkAssetEvidence,
} from '@/app-layer/usecases/asset';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
});

const adminCtx = makeRequestContext('ADMIN', { tenantSlug: 'acme' });
const editorCtx = makeRequestContext('EDITOR', { tenantSlug: 'acme' });
const readerCtx = makeRequestContext('READER', { tenantSlug: 'acme' });
const auditorCtx = makeRequestContext('AUDITOR');

// ─── Reads ─────────────────────────────────────────────────────────

describe('asset reads', () => {
    it('listAssets delegates under read gate', async () => {
        (AssetRepository.list as jest.Mock).mockResolvedValue([{ id: 'a-1' }]);
        const rows = await listAssets(readerCtx);
        // B7 — listAssets folds in linked-task counts (0/0 with no links).
        expect(rows).toEqual([{ id: 'a-1', taskTotal: 0, taskDone: 0 }]);
    });

    it('listAssetsPaginated delegates', async () => {
        (AssetRepository.listPaginated as jest.Mock).mockResolvedValue({ items: [], pageInfo: {} });
        await listAssetsPaginated(readerCtx, { limit: 25 } as any);
        expect(AssetRepository.listPaginated).toHaveBeenCalled();
    });

    it('getAsset returns the row on hit', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1' });
        await expect(getAsset(readerCtx, 'a-1')).resolves.toEqual({ id: 'a-1' });
    });

    it('getAsset throws notFound on miss', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(getAsset(readerCtx, 'missing')).rejects.toThrow(/Asset not found/i);
    });
});

// ─── createAsset ──────────────────────────────────────────────────

describe('createAsset', () => {
    it('delegates to AssetRepository.create and emits CREATE audit', async () => {
        (AssetRepository.create as jest.Mock).mockResolvedValue({ id: 'a-1', name: 'Server' });

        const res = await createAsset(editorCtx, { name: 'Tractor', type: 'TRACTOR' });

        expect(res).toEqual({ id: 'a-1', name: 'Server' });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('CREATE');
        expect(payload.entityType).toBe('Asset');
    });

    it('rejects READER (write gate)', async () => {
        await expect(createAsset(readerCtx, { name: 'X' })).rejects.toBeDefined();
        expect(AssetRepository.create).not.toHaveBeenCalled();
    });

    it('passes ownerUserId to the repository (people-picker owner)', async () => {
        (AssetRepository.create as jest.Mock).mockResolvedValue({ id: 'a-2', name: 'DB' });
        await createAsset(editorCtx, { name: 'Combine', type: 'HARVESTER', ownerUserId: 'u-7' });
        const createArgs = (AssetRepository.create as jest.Mock).mock.calls[0][2];
        expect(createArgs.ownerUserId).toBe('u-7');
    });

    it('coerces an empty ownerUserId to null', async () => {
        (AssetRepository.create as jest.Mock).mockResolvedValue({ id: 'a-3' });
        await createAsset(editorCtx, { name: 'X', type: 'TRACTOR', ownerUserId: '' });
        const createArgs = (AssetRepository.create as jest.Mock).mock.calls[0][2];
        expect(createArgs.ownerUserId).toBeNull();
    });
});

// ─── updateAsset — three-state + notification ──────────────────────

describe('updateAsset — three-state ownerUserId', () => {
    it('leaves ownerUserId untouched when undefined (no key in patch)', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1', ownerUserId: 'u-prev' });
        (AssetRepository.update as jest.Mock).mockResolvedValue({ id: 'a-1', ownerUserId: 'u-prev' });

        await updateAsset(editorCtx, 'a-1', { name: 'New' });

        const updateArgs = (AssetRepository.update as jest.Mock).mock.calls[0][3];
        expect(updateArgs.ownerUserId).toBeUndefined();
    });

    it('clears ownerUserId when explicitly null', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1', ownerUserId: 'u-prev' });
        (AssetRepository.update as jest.Mock).mockResolvedValue({ id: 'a-1', ownerUserId: null });

        await updateAsset(editorCtx, 'a-1', { ownerUserId: null });

        const updateArgs = (AssetRepository.update as jest.Mock).mock.calls[0][3];
        expect(updateArgs.ownerUserId).toBeNull();
    });

    it('clears ownerUserId when empty string (falsy)', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1', ownerUserId: 'u-prev' });
        (AssetRepository.update as jest.Mock).mockResolvedValue({ id: 'a-1', ownerUserId: null });

        await updateAsset(editorCtx, 'a-1', { ownerUserId: '' });

        const updateArgs = (AssetRepository.update as jest.Mock).mock.calls[0][3];
        expect(updateArgs.ownerUserId).toBeNull();
    });

    it('throws notFound when the asset does not exist', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue(null);
        (AssetRepository.update as jest.Mock).mockResolvedValue(null);
        await expect(updateAsset(editorCtx, 'missing', { name: 'X' })).rejects.toThrow(/Asset not found/i);
    });

    it('rejects READER', async () => {
        await expect(updateAsset(readerCtx, 'a-1', { name: 'X' })).rejects.toBeDefined();
    });
});

describe('updateAsset — ASSET_ASSIGNED notification', () => {
    it('fires only on owner change to a real user', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1', ownerUserId: 'u-prev' });
        (AssetRepository.update as jest.Mock).mockResolvedValue({ id: 'a-1', name: 'X', ownerUserId: 'u-new' });

        await updateAsset(editorCtx, 'a-1', { ownerUserId: 'u-new' });

        expect(createAssignmentNotification).toHaveBeenCalledTimes(1);
        const args = (createAssignmentNotification as jest.Mock).mock.calls[0];
        expect(args[1]).toBe('ASSET_ASSIGNED');
        expect(args[2]).toMatchObject({ assigneeUserId: 'u-new', entityId: 'a-1' });
    });

    it('does NOT fire when owner is unchanged', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1', ownerUserId: 'u-same' });
        (AssetRepository.update as jest.Mock).mockResolvedValue({ id: 'a-1', name: 'X', ownerUserId: 'u-same' });

        await updateAsset(editorCtx, 'a-1', { name: 'New' });

        expect(createAssignmentNotification).not.toHaveBeenCalled();
    });

    it('does NOT fire when owner is cleared', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1', ownerUserId: 'u-prev' });
        (AssetRepository.update as jest.Mock).mockResolvedValue({ id: 'a-1', name: 'X', ownerUserId: null });

        await updateAsset(editorCtx, 'a-1', { ownerUserId: null });

        expect(createAssignmentNotification).not.toHaveBeenCalled();
    });

    it('fire-and-forget error swallow on notification failure', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1', ownerUserId: null });
        (AssetRepository.update as jest.Mock).mockResolvedValue({ id: 'a-1', name: 'X', ownerUserId: 'u-new' });
        (createAssignmentNotification as jest.Mock).mockRejectedValue(new Error('Redis down'));

        await expect(updateAsset(editorCtx, 'a-1', { ownerUserId: 'u-new' })).resolves.toMatchObject({ id: 'a-1' });
    });
});

// ─── deleteAsset / restoreAsset / purgeAsset ───────────────────────

describe('deleteAsset', () => {
    it('returns success + SOFT_DELETE audit', async () => {
        (AssetRepository.delete as jest.Mock).mockResolvedValue({ id: 'a-1' });
        const res = await deleteAsset(adminCtx, 'a-1');
        expect(res).toEqual({ success: true });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('SOFT_DELETE');
    });

    it('throws notFound when missing', async () => {
        (AssetRepository.delete as jest.Mock).mockResolvedValue(null);
        await expect(deleteAsset(adminCtx, 'missing')).rejects.toThrow(/Asset not found/i);
    });

    it('rejects EDITOR (admin gate)', async () => {
        await expect(deleteAsset(editorCtx, 'a-1')).rejects.toBeDefined();
    });
});

describe('restoreAsset', () => {
    it('delegates to restoreEntity', async () => {
        (restoreEntity as jest.Mock).mockResolvedValue({ success: true });
        await restoreAsset(adminCtx, 'a-1');
        expect(restoreEntity).toHaveBeenCalledWith(adminCtx, 'Asset', 'a-1');
    });
});

describe('purgeAsset', () => {
    it('delegates to purgeEntity', async () => {
        (purgeEntity as jest.Mock).mockResolvedValue({ success: true });
        await purgeAsset(adminCtx, 'a-1');
        expect(purgeEntity).toHaveBeenCalledWith(adminCtx, 'Asset', 'a-1');
    });
});

describe('listAssetsWithDeleted', () => {
    it('admin-gated + uses withDeleted wrapper', async () => {
        (mockDb.asset.findMany as jest.Mock).mockResolvedValue([{ id: 'a-1' }]);
        await listAssetsWithDeleted(adminCtx);
        const args = (mockDb.asset.findMany as jest.Mock).mock.calls[0][0];
        expect(args._withDeleted).toBe(true);
    });

    it('rejects AUDITOR', async () => {
        await expect(listAssetsWithDeleted(auditorCtx)).rejects.toBeDefined();
    });

    it('rejects READER', async () => {
        await expect(listAssetsWithDeleted(readerCtx)).rejects.toBeDefined();
    });
});

// ─── Evidence-tab paths ────────────────────────────────────────────

describe('getAssetEvidenceTab', () => {
    it('returns { links: [], evidence } shape', async () => {
        (mockDb.asset.findFirst as jest.Mock).mockResolvedValue({ id: 'a-1' });
        (mockDb.evidence.findMany as jest.Mock).mockResolvedValue([{ id: 'e-1' }]);

        const res = await getAssetEvidenceTab(readerCtx, 'a-1');

        expect(res).toEqual({ links: [], evidence: [{ id: 'e-1' }] });
    });

    it('throws notFound when the asset is missing (no evidence query fires)', async () => {
        (mockDb.asset.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(getAssetEvidenceTab(readerCtx, 'missing')).rejects.toThrow(/Asset not found/i);
        expect(mockDb.evidence.findMany).not.toHaveBeenCalled();
    });
});

describe('linkAssetEvidence', () => {
    it('creates a LINK Evidence record + emits ASSET_EVIDENCE_LINKED + bumps cache', async () => {
        (mockDb.asset.findFirst as jest.Mock).mockResolvedValue({ id: 'a-1' });
        (mockDb.evidence.create as jest.Mock).mockResolvedValue({ id: 'e-1' });

        const res = await linkAssetEvidence(editorCtx, 'a-1', { url: 'https://example.com', note: 'doc' });

        expect(res).toEqual({ id: 'e-1' });
        const createArgs = (mockDb.evidence.create as jest.Mock).mock.calls[0][0].data;
        expect(createArgs.type).toBe('LINK');
        expect(createArgs.content).toBe('https://example.com');
        expect(bumpEntityCacheVersion).toHaveBeenCalledWith(editorCtx, 'evidence');
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('ASSET_EVIDENCE_LINKED');
    });

    it('trims the url before persisting', async () => {
        (mockDb.asset.findFirst as jest.Mock).mockResolvedValue({ id: 'a-1' });
        (mockDb.evidence.create as jest.Mock).mockResolvedValue({ id: 'e-1' });

        await linkAssetEvidence(editorCtx, 'a-1', { url: '  https://example.com  ' });

        const createArgs = (mockDb.evidence.create as jest.Mock).mock.calls[0][0].data;
        expect(createArgs.content).toBe('https://example.com');
    });

    it('throws notFound when the asset does not exist', async () => {
        (mockDb.asset.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(linkAssetEvidence(editorCtx, 'missing', { url: 'x' })).rejects.toThrow(/Asset not found/i);
    });

    it('rejects READER', async () => {
        await expect(linkAssetEvidence(readerCtx, 'a-1', { url: 'x' })).rejects.toBeDefined();
    });
});

describe('unlinkAssetEvidence', () => {
    it('clears assetId on the Evidence row + emits unlink audit', async () => {
        (mockDb.evidence.findFirst as jest.Mock).mockResolvedValue({ id: 'e-1' });

        const res = await unlinkAssetEvidence(editorCtx, 'a-1', 'e-1');

        expect(res).toEqual({ success: true });
        const updateArgs = (mockDb.evidence.update as jest.Mock).mock.calls[0][0];
        expect(updateArgs.where.id).toBe('e-1');
        expect(updateArgs.data.assetId).toBeNull();
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('ASSET_EVIDENCE_UNLINKED');
    });

    it('throws notFound when the asset-evidence join row is missing', async () => {
        (mockDb.evidence.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(unlinkAssetEvidence(editorCtx, 'a-1', 'missing')).rejects.toThrow(/Asset evidence not found/i);
        expect(mockDb.evidence.update).not.toHaveBeenCalled();
    });

    it('rejects READER', async () => {
        await expect(unlinkAssetEvidence(readerCtx, 'a-1', 'e-1')).rejects.toBeDefined();
    });
});
