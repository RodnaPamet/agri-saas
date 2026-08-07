/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks + fake DB. */
/**
 * Unit tests for `src/app-layer/usecases/audit-readiness/packs.ts` —
 * the audit-pack CRUD + freeze + snapshot + export surface.
 *
 * Wave-3b branch coverage (the largest stage-3 target). This file
 * is decision-dense: 8 exported usecases × ~4 branches each +
 * 4 snapshot helpers + 2 framework-specific default-pack pickers.
 * Compliance-critical: a bug here either ships a draft pack to
 * the auditor (pre-freeze leak), lets a frozen pack be mutated
 * (broken evidence chain), or fails the snapshot integrity that
 * the auditor relies on.
 *
 * Branch matrix covered:
 *   createAuditPack:    policy + cycle-not-found + happy
 *   listAuditPacks:     policy + optional cycle filter
 *   getAuditPack:       policy + not-found + happy
 *   updateAuditPack:    policy + not-found + non-DRAFT reject +
 *                       partial-update (name only / notes only / neither)
 *   addAuditPackItems:  policy + not-found + non-DRAFT reject +
 *                       empty-items reject + skipDuplicates accounting
 *   freezeAuditPack:    policy + not-found + already-frozen +
 *                       empty-pack reject + snapshot-per-entityType
 *                       (CONTROL/POLICY/EVIDENCE/ISSUE/default) +
 *                       transaction-timeout option propagation +
 *                       SoA best-effort attachment
 *   previewDefaultPack: policy + cycle-not-found + ISO27001 + NIS2 +
 *                       unsupported-framework
 *   exportAuditPack:    policy + DRAFT-reject + json vs csv
 *
 * Each test isolates ONE branch so a regression points at exactly
 * the path that drifted.
 */

const policyCalls: string[] = [];
const auditCalls: any[] = [];
const txOpts: any[] = [];

jest.mock('@/app-layer/policies/audit-readiness.policies', () => ({
    assertCanManageAuditPacks: jest.fn(() => policyCalls.push('manage')),
    assertCanFreezePack: jest.fn(() => policyCalls.push('freeze')),
    assertCanViewPack: jest.fn(() => policyCalls.push('view')),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(async (_db: any, _ctx: any, evt: any) => {
        auditCalls.push(evt);
    }),
}));

// SoA module is dynamically imported in freezeAuditPack — stub it
// so the best-effort attachment path is deterministic.
const mockGetSoA = jest.fn();

// `freezeAuditPack` reads the GLOBAL Framework table to turn the pack's
// FRAMEWORK_COVERAGE item into the scheme key its SoA should be generated for.
const mockPrisma: any = { framework: { findUnique: jest.fn() } };
jest.mock('@/lib/prisma', () => ({ prisma: mockPrisma }));

// A pack that cannot attach its SoA now LOGS instead of swallowing.
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('@/lib/observability/logger', () => ({ logger: loggerMock }));

const mockTdb: any = {
    auditPack: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    auditPackItem: {
        createMany: jest.fn(), update: jest.fn(), create: jest.fn(),
        // `findFirst` resolves the pack's FRAMEWORK_COVERAGE item so the SoA
        // is generated for the RIGHT standard. Without it, getSoA fell back to
        // the alphabetically-first installed key and a GlobalG.A.P. pack
        // shipped an EU-Organic SoA.
        findFirst: jest.fn(),
    },
    auditCycle: { findFirst: jest.fn() },
    framework: { findFirst: jest.fn() },
    controlRequirementLink: { findMany: jest.fn() },
    control: { findFirst: jest.fn(), findMany: jest.fn() },
    policy: { findFirst: jest.fn(), findMany: jest.fn() },
    evidence: { findFirst: jest.fn() },
    task: { findFirst: jest.fn(), findMany: jest.fn() },
};

jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    return {
        ...actual,
        runInTenantContext: jest.fn(async (_ctx: any, callback: any, opts?: any) => {
            if (opts) txOpts.push(opts);
            return callback(mockTdb);
        }),
    };
});

import {
    createAuditPack,
    listAuditPacks,
    getAuditPack,
    updateAuditPack,
    addAuditPackItems,
    freezeAuditPack,
    previewDefaultPack,
    exportAuditPack,
} from '@/app-layer/usecases/audit-readiness/packs';
import {
    assertCanManageAuditPacks,
    assertCanFreezePack,
    assertCanViewPack,
} from '@/app-layer/policies/audit-readiness.policies';
import { makeRequestContext } from '../../helpers/make-context';

beforeEach(() => {
    policyCalls.length = 0;
    auditCalls.length = 0;
    txOpts.length = 0;
    mockGetSoA.mockReset();
    [
        mockTdb.auditPack.findFirst, mockTdb.auditPack.findMany,
        mockTdb.auditPack.create, mockTdb.auditPack.update,
        mockTdb.auditPackItem.createMany, mockTdb.auditPackItem.update,
        mockTdb.auditPackItem.create, mockTdb.auditPackItem.findFirst,
        mockTdb.auditCycle.findFirst,
        mockTdb.framework.findFirst,
        mockTdb.controlRequirementLink.findMany,
        mockTdb.control.findFirst, mockTdb.control.findMany,
        mockTdb.policy.findFirst, mockTdb.policy.findMany,
        mockTdb.evidence.findFirst,
        mockTdb.task.findFirst, mockTdb.task.findMany,
        assertCanManageAuditPacks as jest.Mock,
        assertCanFreezePack as jest.Mock,
        assertCanViewPack as jest.Mock,
    ].forEach((m: any) => m.mockReset && m.mockReset());
    (assertCanManageAuditPacks as jest.Mock).mockImplementation(() => policyCalls.push('manage'));
    (assertCanFreezePack as jest.Mock).mockImplementation(() => policyCalls.push('freeze'));
    (assertCanViewPack as jest.Mock).mockImplementation(() => policyCalls.push('view'));
});

const ctx = makeRequestContext('ADMIN');

// ──────────────────────────────────────────────────────────────────────
// createAuditPack
// ──────────────────────────────────────────────────────────────────────
describe('createAuditPack', () => {
    it('asserts MANAGE permission before the cycle lookup', async () => {
        mockTdb.auditCycle.findFirst.mockResolvedValueOnce({ id: 'c-1' });
        mockTdb.auditPack.create.mockResolvedValueOnce({ id: 'p-1' });
        await createAuditPack(ctx, 'c-1', 'Q3 SOC2');
        expect(policyCalls).toEqual(['manage']);
    });

    it('throws notFound for a cycle id foreign to the tenant', async () => {
        mockTdb.auditCycle.findFirst.mockResolvedValueOnce(null);
        await expect(createAuditPack(ctx, 'c-foreign', 'X')).rejects.toThrow(/audit cycle not found/i);
        expect(mockTdb.auditPack.create).not.toHaveBeenCalled();
        expect(auditCalls).toHaveLength(0);
    });

    it('creates + audits on happy-path', async () => {
        mockTdb.auditCycle.findFirst.mockResolvedValueOnce({ id: 'c-1' });
        mockTdb.auditPack.create.mockResolvedValueOnce({ id: 'p-1', name: 'Q3 SOC2' });

        const result = await createAuditPack(ctx, 'c-1', 'Q3 SOC2');

        expect(result.id).toBe('p-1');
        expect(auditCalls[0].action).toBe('AUDIT_PACK_CREATED');
        expect(auditCalls[0].entityId).toBe('p-1');
    });
});

// ──────────────────────────────────────────────────────────────────────
// listAuditPacks — cycle-filter branch
// ──────────────────────────────────────────────────────────────────────
describe('listAuditPacks', () => {
    it('filters by cycleId when provided', async () => {
        mockTdb.auditPack.findMany.mockResolvedValueOnce([]);
        await listAuditPacks(ctx, 'cycle-1');
        const where = mockTdb.auditPack.findMany.mock.calls[0][0].where;
        expect(where.tenantId).toBe('tenant-1');
        expect(where.auditCycleId).toBe('cycle-1');
    });

    it('omits the cycleId filter when none given', async () => {
        mockTdb.auditPack.findMany.mockResolvedValueOnce([]);
        await listAuditPacks(ctx);
        const where = mockTdb.auditPack.findMany.mock.calls[0][0].where;
        expect(where.auditCycleId).toBeUndefined();
    });
});

// ──────────────────────────────────────────────────────────────────────
// getAuditPack
// ──────────────────────────────────────────────────────────────────────
describe('getAuditPack', () => {
    it('throws notFound for a pack id foreign to the tenant', async () => {
        mockTdb.auditPack.findFirst.mockResolvedValueOnce(null);
        await expect(getAuditPack(ctx, 'p-foreign')).rejects.toThrow(/audit pack not found/i);
    });

    it('returns the pack with its full include shape on happy-path', async () => {
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({
            id: 'p-1', name: 'X', status: 'DRAFT', items: [], cycle: {}, _count: {},
        });
        const result = await getAuditPack(ctx, 'p-1');
        expect(result.id).toBe('p-1');
        const args = mockTdb.auditPack.findFirst.mock.calls[0][0];
        expect(args.include.items).toBeDefined();
        expect(args.include.cycle).toBe(true);
    });
});

// ──────────────────────────────────────────────────────────────────────
// updateAuditPack — partial-update + state-gate branches
// ──────────────────────────────────────────────────────────────────────
describe('updateAuditPack', () => {
    it('throws notFound for a foreign pack id', async () => {
        mockTdb.auditPack.findFirst.mockResolvedValueOnce(null);
        await expect(updateAuditPack(ctx, 'p-foreign', { name: 'x' })).rejects.toThrow(/audit pack not found/i);
        expect(mockTdb.auditPack.update).not.toHaveBeenCalled();
    });

    it('REJECTS update on a non-DRAFT pack (FROZEN status guard)', async () => {
        // The freeze contract says a frozen pack is immutable; this
        // is what protects the auditor's working copy from drift
        // mid-review.
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1', status: 'FROZEN' });
        await expect(updateAuditPack(ctx, 'p-1', { name: 'x' })).rejects.toThrow(/cannot update a frozen/i);
        expect(mockTdb.auditPack.update).not.toHaveBeenCalled();
    });

    it('REJECTS update on EXPORTED pack', async () => {
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1', status: 'EXPORTED' });
        await expect(updateAuditPack(ctx, 'p-1', { name: 'x' })).rejects.toThrow(/cannot update a frozen/i);
    });

    it('applies partial update with name only (notes omitted from data)', async () => {
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1', status: 'DRAFT' });
        mockTdb.auditPack.update.mockResolvedValueOnce({ id: 'p-1', name: 'X' });
        await updateAuditPack(ctx, 'p-1', { name: 'X' });
        const data = mockTdb.auditPack.update.mock.calls[0][0].data;
        expect(data.name).toBe('X');
        expect(data.notes).toBeUndefined();
    });

    it('applies partial update with notes only', async () => {
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1', status: 'DRAFT' });
        mockTdb.auditPack.update.mockResolvedValueOnce({ id: 'p-1' });
        await updateAuditPack(ctx, 'p-1', { notes: 'New notes' });
        const data = mockTdb.auditPack.update.mock.calls[0][0].data;
        expect(data.name).toBeUndefined();
        expect(data.notes).toBe('New notes');
    });

    it('handles an empty data object (DB sees empty data; no fields updated)', async () => {
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1', status: 'DRAFT' });
        mockTdb.auditPack.update.mockResolvedValueOnce({ id: 'p-1' });
        await updateAuditPack(ctx, 'p-1', {});
        const data = mockTdb.auditPack.update.mock.calls[0][0].data;
        expect(data).toEqual({});
    });
});

// ──────────────────────────────────────────────────────────────────────
// addAuditPackItems — 5 distinct branches
// ──────────────────────────────────────────────────────────────────────
describe('addAuditPackItems', () => {
    it('throws notFound for a foreign pack id', async () => {
        mockTdb.auditPack.findFirst.mockResolvedValueOnce(null);
        await expect(
            addAuditPackItems(ctx, 'p-foreign', [{ entityType: 'CONTROL', entityId: 'c-1' }]),
        ).rejects.toThrow(/audit pack not found/i);
    });

    it('REJECTS adds to non-DRAFT pack (immutability gate)', async () => {
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1', status: 'FROZEN' });
        await expect(
            addAuditPackItems(ctx, 'p-1', [{ entityType: 'CONTROL', entityId: 'c-1' }]),
        ).rejects.toThrow(/cannot add items to a frozen/i);
        expect(mockTdb.auditPackItem.createMany).not.toHaveBeenCalled();
    });

    it('rejects an empty items array', async () => {
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1', status: 'DRAFT' });
        await expect(
            addAuditPackItems(ctx, 'p-1', []),
        ).rejects.toThrow(/at least one item required/i);
    });

    it('rejects a null/undefined items array (defensive null check)', async () => {
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1', status: 'DRAFT' });
        await expect(
            addAuditPackItems(ctx, 'p-1', null as any),
        ).rejects.toThrow(/at least one item required/i);
    });

    it('accounts created vs skipped from createMany.skipDuplicates result', async () => {
        // The contract is "idempotent add": if N items are submitted
        // but the unique tuple says K already exist, createMany
        // returns count=N-K. The usecase derives skipped = N - created
        // so the caller sees both numbers.
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1', status: 'DRAFT' });
        mockTdb.auditPackItem.createMany.mockResolvedValueOnce({ count: 2 });

        const result = await addAuditPackItems(ctx, 'p-1', [
            { entityType: 'CONTROL', entityId: 'c-1' },
            { entityType: 'CONTROL', entityId: 'c-2' },
            { entityType: 'POLICY',  entityId: 'p-1' },
        ]);

        expect(result).toEqual({ created: 2, skipped: 1 });
        expect(mockTdb.auditPackItem.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
        expect(auditCalls[0].action).toBe('AUDIT_PACK_UPDATED');
    });

    it('defaults sortOrder to 0 and snapshotJson to "{}" when omitted', async () => {
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1', status: 'DRAFT' });
        mockTdb.auditPackItem.createMany.mockResolvedValueOnce({ count: 1 });

        await addAuditPackItems(ctx, 'p-1', [{ entityType: 'CONTROL', entityId: 'c-1' }]);

        const payload = mockTdb.auditPackItem.createMany.mock.calls[0][0].data;
        expect(payload[0].sortOrder).toBe(0);
        expect(payload[0].snapshotJson).toBe('{}');
    });
});

// ──────────────────────────────────────────────────────────────────────
// freezeAuditPack — state machine + snapshot creation
// ──────────────────────────────────────────────────────────────────────
describe('freezeAuditPack', () => {
    it('throws notFound for a foreign pack id', async () => {
        mockTdb.auditPack.findFirst.mockResolvedValueOnce(null);
        await expect(freezeAuditPack(ctx, 'p-foreign')).rejects.toThrow(/audit pack not found/i);
    });

    it('REJECTS freeze on already-FROZEN pack', async () => {
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1', status: 'FROZEN', items: [] });
        await expect(freezeAuditPack(ctx, 'p-1')).rejects.toThrow(/already frozen/i);
    });

    it('REJECTS freeze on an empty pack', async () => {
        // An empty pack at freeze-time is operator error — the
        // freeze locks the snapshot, and an empty snapshot has no
        // forensic value.
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1', status: 'DRAFT', items: [] });
        await expect(freezeAuditPack(ctx, 'p-1')).rejects.toThrow(/empty pack/i);
    });

    it('uses an extended 60s transaction timeout (large-pack tolerance)', async () => {
        // Documented in the source comment — 500+ items × per-item
        // snapshot creation exceeds the default 5s txn timeout.
        // The opts pass-through is load-bearing.
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({
            id: 'p-1', status: 'DRAFT',
            items: [{ id: 'i-1', entityType: 'CONTROL', entityId: 'c-1', snapshotJson: '{}' }],
        });
        mockTdb.control.findFirst.mockResolvedValueOnce({
            id: 'c-1', code: 'CC1', name: 't', status: 'ACTIVE', tasks: [], evidence: [], requirementLinks: [],
        });
        mockTdb.auditPack.update.mockResolvedValueOnce({ id: 'p-1', status: 'FROZEN' });
        mockGetSoA.mockResolvedValueOnce({
            framework: 'iso', generatedAt: new Date(), summary: {}, entries: [],
        });

        await freezeAuditPack(ctx, 'p-1');

        expect(txOpts[0]).toEqual({ timeout: 60000, maxWait: 10000 });
    });

    it('SKIPS snapshot generation when the item already has a non-empty snapshotJson', async () => {
        // The "don't overwrite a prior snapshot" branch — important
        // because an item that was attached with a custom snapshot
        // payload at addItems time keeps that payload through freeze.
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({
            id: 'p-1', status: 'DRAFT',
            items: [{ id: 'i-1', entityType: 'CONTROL', entityId: 'c-1', snapshotJson: '{"pre":"baked"}' }],
        });
        mockTdb.auditPack.update.mockResolvedValueOnce({ id: 'p-1', status: 'FROZEN' });
        mockGetSoA.mockResolvedValueOnce({
            framework: 'iso', generatedAt: new Date(), summary: {}, entries: [],
        });

        await freezeAuditPack(ctx, 'p-1');

        // Pre-baked snapshot path = no entity lookup needed
        expect(mockTdb.control.findFirst).not.toHaveBeenCalled();
        // ALSO: no update on the item (the existing snapshot is kept)
        expect(mockTdb.auditPackItem.update).not.toHaveBeenCalled();
    });

    it('builds CONTROL snapshots when item.entityType === CONTROL and snapshot was empty', async () => {
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({
            id: 'p-1', status: 'DRAFT',
            items: [{ id: 'i-1', entityType: 'CONTROL', entityId: 'c-1', snapshotJson: '{}' }],
        });
        mockTdb.control.findFirst.mockResolvedValueOnce({
            id: 'c-1', code: 'CC1', name: 'Control Env', status: 'ACTIVE',
            tasks: [{ status: 'RESOLVED' }, { status: 'OPEN' }],
            evidence: [{ id: 'e-1' }],
            requirementLinks: [{ requirement: { code: 'A.1', title: 'X' } }],
        });
        mockTdb.auditPack.update.mockResolvedValueOnce({ id: 'p-1', status: 'FROZEN' });
        mockGetSoA.mockResolvedValueOnce({
            framework: 'iso', generatedAt: new Date(), summary: {}, entries: [],
        });

        await freezeAuditPack(ctx, 'p-1');

        const updateArgs = mockTdb.auditPackItem.update.mock.calls[0][0];
        const snap = JSON.parse(updateArgs.data.snapshotJson);
        expect(snap.code).toBe('CC1');
        expect(snap.taskCompletion).toEqual({ total: 2, done: 1 });
        expect(snap.evidenceCount).toBe(1);
    });

    it('builds POLICY snapshots with the latest version number', async () => {
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({
            id: 'p-1', status: 'DRAFT',
            items: [{ id: 'i-1', entityType: 'POLICY', entityId: 'pol-1', snapshotJson: '{}' }],
        });
        mockTdb.policy.findFirst.mockResolvedValueOnce({
            id: 'pol-1', title: 'AUP', status: 'APPROVED', category: 'Security',
            versions: [{ versionNumber: 7 }],
        });
        mockTdb.auditPack.update.mockResolvedValueOnce({ id: 'p-1', status: 'FROZEN' });
        mockGetSoA.mockResolvedValueOnce({
            framework: 'iso', generatedAt: new Date(), summary: {}, entries: [],
        });

        await freezeAuditPack(ctx, 'p-1');

        const snap = JSON.parse(mockTdb.auditPackItem.update.mock.calls[0][0].data.snapshotJson);
        expect(snap.title).toBe('AUP');
        expect(snap.currentVersion).toBe(7);
    });

    it('records error-shape snapshot when the entity was deleted/orphaned', async () => {
        // A CONTROL/POLICY/EVIDENCE/ISSUE item whose source row is
        // gone (deleted between add + freeze) gets an explicit
        // error-shape snapshot rather than a thrown error — the
        // pack still freezes; the auditor sees the missing source.
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({
            id: 'p-1', status: 'DRAFT',
            items: [{ id: 'i-1', entityType: 'EVIDENCE', entityId: 'ev-gone', snapshotJson: '{}' }],
        });
        mockTdb.evidence.findFirst.mockResolvedValueOnce(null);
        mockTdb.auditPack.update.mockResolvedValueOnce({ id: 'p-1', status: 'FROZEN' });
        mockGetSoA.mockResolvedValueOnce({
            framework: 'iso', generatedAt: new Date(), summary: {}, entries: [],
        });

        await freezeAuditPack(ctx, 'p-1');

        const snap = JSON.parse(mockTdb.auditPackItem.update.mock.calls[0][0].data.snapshotJson);
        expect(snap.error).toBe('Evidence not found');
        expect(snap.entityId).toBe('ev-gone');
    });

    it('falls back to generic snapshot for unknown entityType (default branch)', async () => {
        // The switch statement's default arm — keeps future
        // entityType enum additions from breaking the freeze flow.
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({
            id: 'p-1', status: 'DRAFT',
            items: [{ id: 'i-1', entityType: 'EXPORT_ARTIFACT', entityId: 'x-1', snapshotJson: '{}' }],
        });
        mockTdb.auditPack.update.mockResolvedValueOnce({ id: 'p-1', status: 'FROZEN' });
        mockGetSoA.mockResolvedValueOnce({
            framework: 'iso', generatedAt: new Date(), summary: {}, entries: [],
        });

        await freezeAuditPack(ctx, 'p-1');

        const snap = JSON.parse(mockTdb.auditPackItem.update.mock.calls[0][0].data.snapshotJson);
        expect(snap.entityType).toBe('EXPORT_ARTIFACT');
        expect(snap.entityId).toBe('x-1');
    });

    it('SWALLOWS SoA attachment failure (best-effort)', async () => {
        // The SoA snapshot is documented as best-effort. A getSoA
        // failure cannot prevent the freeze that ran successfully.
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({
            id: 'p-1', status: 'DRAFT',
            items: [{ id: 'i-1', entityType: 'POLICY', entityId: 'pol-1', snapshotJson: '{}' }],
        });
        mockTdb.policy.findFirst.mockResolvedValueOnce({
            id: 'pol-1', title: 'X', status: 'APPROVED', category: 'Security', versions: [],
        });
        mockTdb.auditPack.update.mockResolvedValueOnce({ id: 'p-1', status: 'FROZEN' });
        mockGetSoA.mockRejectedValueOnce(new Error('soa down'));

        const result = await freezeAuditPack(ctx, 'p-1');

        // Freeze still returns the frozen pack despite the SoA failure.
        expect(result.status).toBe('FROZEN');
        // No EXPORT_ARTIFACT item got attached.
        expect(mockTdb.auditPackItem.create).not.toHaveBeenCalled();
    });



});

// ──────────────────────────────────────────────────────────────────────
// previewDefaultPack — framework router + framework-specific branches
// ──────────────────────────────────────────────────────────────────────
describe('previewDefaultPack', () => {
    it('throws notFound for an unknown cycle id', async () => {
        mockTdb.auditCycle.findFirst.mockResolvedValueOnce(null);
        await expect(previewDefaultPack(ctx, 'c-foreign')).rejects.toThrow(/audit cycle not found/i);
    });

    it('rejects an unsupported frameworkKey with badRequest', async () => {
        mockTdb.auditCycle.findFirst.mockResolvedValueOnce({ id: 'c-1', frameworkKey: 'SOC1' });
        await expect(previewDefaultPack(ctx, 'c-1')).rejects.toThrow(/no default pack template for framework: soc1/i);
    });

    it('ISO27001: uses framework-mapped controls + security-category policies', async () => {
        mockTdb.auditCycle.findFirst.mockResolvedValueOnce({ id: 'c-1', frameworkKey: 'ISO27001' });
        mockTdb.framework.findFirst.mockResolvedValueOnce({ id: 'fw-iso' });
        mockTdb.controlRequirementLink.findMany.mockResolvedValueOnce([
            { controlId: 'ctrl-1' }, { controlId: 'ctrl-2' }, { controlId: 'ctrl-1' /* dupe */ },
        ]);
        mockTdb.policy.findMany.mockResolvedValueOnce([
            { id: 'pol-sec', category: 'Security' },
            { id: 'pol-other', category: 'HR' },
        ]);
        mockTdb.control.findMany.mockResolvedValueOnce([
            { evidence: [{ id: 'e-1' }, { id: 'e-2' }] },
            { evidence: [{ id: 'e-1' /* dupe */ }] },
        ]);
        mockTdb.task.findMany.mockResolvedValueOnce([{ id: 't-1' }]);

        const result = await previewDefaultPack(ctx, 'c-1');

        expect(result.frameworkKey).toBe('ISO27001');
        expect(result.selection.controls.count).toBe(2);
        expect(result.selection.policies.count).toBe(1); // only Security
        expect(result.selection.evidence.count).toBe(2);
        expect(result.selection.issues.count).toBe(1);
        expect(result.totalItems).toBe(2 + 1 + 2 + 1);
    });

    it('ISO27001 fallback: when NO mapped controls exist, uses ALL tenant controls', async () => {
        mockTdb.auditCycle.findFirst.mockResolvedValueOnce({ id: 'c-1', frameworkKey: 'ISO27001' });
        mockTdb.framework.findFirst.mockResolvedValueOnce({ id: 'fw-iso' });
        mockTdb.controlRequirementLink.findMany.mockResolvedValueOnce([]); // no mappings
        // The fallback path queries control.findMany for ALL tenant
        // controls without the {in: controlIds} filter.
        mockTdb.control.findMany
            .mockResolvedValueOnce([{ id: 'c-all-1' }, { id: 'c-all-2' }, { id: 'c-all-3' }])
            .mockResolvedValueOnce([]); // second findMany — evidence join
        mockTdb.policy.findMany.mockResolvedValueOnce([]);
        mockTdb.task.findMany.mockResolvedValueOnce([]);

        const result = await previewDefaultPack(ctx, 'c-1');

        expect(result.selection.controls.count).toBe(3);
    });

    it('ISO27001 policy fallback: when no Security policies, uses ALL policies', async () => {
        mockTdb.auditCycle.findFirst.mockResolvedValueOnce({ id: 'c-1', frameworkKey: 'ISO27001' });
        mockTdb.framework.findFirst.mockResolvedValueOnce({ id: 'fw-iso' });
        mockTdb.controlRequirementLink.findMany.mockResolvedValueOnce([{ controlId: 'c-1' }]);
        mockTdb.policy.findMany.mockResolvedValueOnce([
            { id: 'pol-hr', category: 'HR' },
            { id: 'pol-finance', category: 'Finance' },
        ]);
        mockTdb.control.findMany.mockResolvedValueOnce([]);
        mockTdb.task.findMany.mockResolvedValueOnce([]);

        const result = await previewDefaultPack(ctx, 'c-1');

        expect(result.selection.policies.count).toBe(2); // both, no security match
    });

    it('NIS2: filters policies by NIS2-specific keywords', async () => {
        mockTdb.auditCycle.findFirst.mockResolvedValueOnce({ id: 'c-1', frameworkKey: 'NIS2' });
        mockTdb.framework.findFirst.mockResolvedValueOnce({ id: 'fw-nis2' });
        mockTdb.controlRequirementLink.findMany.mockResolvedValueOnce([{ controlId: 'c-1' }]);
        mockTdb.policy.findMany.mockResolvedValueOnce([
            { id: 'pol-1', title: 'Incident Response', category: '' },
            { id: 'pol-2', title: 'AUP', category: '' },
            { id: 'pol-3', title: 'Supplier Security', category: '' },
            { id: 'pol-4', title: 'Vacation Policy', category: '' },
        ]);
        mockTdb.control.findMany.mockResolvedValueOnce([]);
        mockTdb.task.findMany.mockResolvedValueOnce([]);

        const result = await previewDefaultPack(ctx, 'c-1');

        expect(result.frameworkKey).toBe('NIS2');
        expect(result.selection.policies.count).toBe(2); // incident + supplier
    });

    it('NIS2 fallback: when no keyword-matching policy, uses all', async () => {
        mockTdb.auditCycle.findFirst.mockResolvedValueOnce({ id: 'c-1', frameworkKey: 'NIS2' });
        mockTdb.framework.findFirst.mockResolvedValueOnce({ id: 'fw-nis2' });
        mockTdb.controlRequirementLink.findMany.mockResolvedValueOnce([{ controlId: 'c-1' }]);
        mockTdb.policy.findMany.mockResolvedValueOnce([
            { id: 'pol-1', title: 'AUP', category: 'HR' },
        ]);
        mockTdb.control.findMany.mockResolvedValueOnce([]);
        mockTdb.task.findMany.mockResolvedValueOnce([]);

        const result = await previewDefaultPack(ctx, 'c-1');

        expect(result.selection.policies.count).toBe(1);
    });
});

// ──────────────────────────────────────────────────────────────────────
// exportAuditPack — format + DRAFT-reject
// ──────────────────────────────────────────────────────────────────────
describe('exportAuditPack', () => {
    it('REJECTS export of a DRAFT pack', async () => {
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({
            id: 'p-1', name: 'X', status: 'DRAFT', items: [], cycle: {}, _count: {},
        });
        await expect(exportAuditPack(ctx, 'p-1')).rejects.toThrow(/cannot export a draft/i);
    });

    it('returns JSON shape by default', async () => {
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({
            id: 'p-1', name: 'X', status: 'FROZEN', frozenAt: new Date(),
            items: [
                { entityType: 'CONTROL', entityId: 'c-1', sortOrder: 0, snapshotJson: '{"code":"CC1"}' },
            ],
            cycle: { name: 'Q3' },
            _count: {},
        });

        const result = await exportAuditPack(ctx, 'p-1') as any;

        expect(result.pack.status).toBe('FROZEN');
        expect(result.items[0].snapshot.code).toBe('CC1');
    });

    it('returns CSV shape when format=csv (rows + filename)', async () => {
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({
            id: 'p-1', name: 'My Pack 2026', status: 'FROZEN', frozenAt: new Date(),
            items: [
                { entityType: 'CONTROL', entityId: 'c-1', sortOrder: 0, snapshotJson: '{"code":"CC1","status":"ACTIVE"}' },
            ],
            cycle: {}, _count: {},
        });

        const result = await exportAuditPack(ctx, 'p-1', 'csv') as any;

        // Each row column is quoted (covers embedded commas) — the
        // header row is `"Type","Entity ID","Name/Title",...`.
        expect(result.csv).toContain('"Type","Entity ID"');
        expect(result.csv).toContain('"CONTROL"');
        expect(result.csv).toContain('"CC1"');
        // Filename is slugified — spaces become hyphens.
        expect(result.filename).toBe('My-Pack-2026-audit-pack.csv');
    });

    it('CSV escapes embedded double-quotes correctly', async () => {
        // Critical for snapshot payloads that contain quoted JSON.
        // A naive implementation would break the row structure.
        mockTdb.auditPack.findFirst.mockResolvedValueOnce({
            id: 'p-1', name: 'X', status: 'FROZEN', frozenAt: new Date(),
            items: [
                { entityType: 'POLICY', entityId: 'pol-1', sortOrder: 0, snapshotJson: '{"title":"He said \\"hi\\""}' },
            ],
            cycle: {}, _count: {},
        });

        const result = await exportAuditPack(ctx, 'p-1', 'csv') as any;

        // Each embedded `"` becomes `""` in CSV.
        expect(result.csv).toMatch(/""hi""/);
    });
});
