/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/crop-planning.ts` — the
 * integration layer over the pure succession engine.
 *
 * Covers:
 *   - generatePlantings: wires the REAL engine (generateSuccessions)
 *     → UPSERTS Planting rows by the stable (cropPlanId,
 *     successionNumber) identity → fans out field tasks via createTask +
 *     addTaskLink('PLANTING', …); is idempotent + regenerate-safe
 *     (creates missing successions, refreshes still-PLANNED rows,
 *     preserves SOWN+ rows, skips a stage whose task already exists).
 *   - getCropPlanProgress: maps planned dates beside the actuals from
 *     LogPlanting → LogEntry.occurredAt, grouped by stage, in ONE pass.
 *   - read/write authorization gating.
 *
 * The succession engine is NOT mocked — its output is deterministic, so
 * the test asserts the usecase persisted exactly what the engine
 * computes (the integration contract). createTask / addTaskLink ARE
 * mocked (they open their own context + enqueue).
 */

const mockDb = {
    cropPlan: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    planting: {
        deleteMany: jest.fn(),
        createMany: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
    },
    taskLink: { findMany: jest.fn() },
    logPlanting: { findMany: jest.fn() },
    // A recorded yield is ALSO a harvest actual — see the fold in
    // getCropPlanProgress.
    yieldRecord: { findMany: jest.fn() },
    season: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    cropType: { findFirst: jest.fn(), create: jest.fn(), findMany: jest.fn() },
    cropVariety: { findFirst: jest.fn(), create: jest.fn(), findMany: jest.fn() },
    parcel: { findFirst: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => s),
}));

// The catalog list-reads (crop types / varieties) go through the cache
// layer; mock it to run the loader straight through (no Redis) and make
// the version-bump a no-op.
const bumpEntityCacheVersion = jest.fn();
jest.mock('@/lib/cache/list-cache', () => ({
    cachedListRead: jest.fn(async (opts: any) => opts.loader()),
    bumpEntityCacheVersion: (...args: any[]) => bumpEntityCacheVersion(...args),
}));

const createTask = jest.fn();
const addTaskLink = jest.fn();
const listTaskLinks = jest.fn();
jest.mock('@/app-layer/usecases/task', () => ({
    createTask: (...args: any[]) => createTask(...args),
    addTaskLink: (...args: any[]) => addTaskLink(...args),
    listTaskLinks: (...args: any[]) => listTaskLinks(...args),
}));

import { logEvent } from '@/app-layer/events/audit';
import {
    generatePlantings,
    getCropPlanProgress,
    listCropPlans,
    createCropPlan,
    deleteCropPlan,
    advancePlantingStatusForLinks,
    listSeasons,
    createSeason,
    updateSeason,
    listCropTypes,
    createCropType,
    listCropVarieties,
    createCropVariety,
    getCropPlan,
    updateCropPlan,
    listPlantings,
    updatePlanting,
} from '@/app-layer/usecases/crop-planning';
import { generateSuccessions } from '@/lib/planning/succession';
import { summarizePlannedYield } from '@/lib/planning/planned-yield';
import { makeRequestContext } from '../helpers/make-context';

const adminCtx = makeRequestContext('ADMIN', { userId: 'user-admin', tenantId: 'tenant-1' });
const editorCtx = makeRequestContext('EDITOR', { userId: 'user-editor', tenantId: 'tenant-1' });
const readerCtx = makeRequestContext('READER', { tenantId: 'tenant-1' });

/** A lettuce-shaped variety with TRANSPLANT timing + full spacing. */
const lettuceVariety = {
    id: 'var-1',
    name: 'Leaf Lettuce',
    defaultMethod: 'TRANSPLANT',
    daysToTransplant: 28,
    daysToMaturity: 45,
    harvestWindowDays: 14,
    inRowSpacingCm: { toString: () => '25' },
    betweenRowSpacingCm: { toString: () => '30' },
    seedsPerGram: { toString: () => '800' },
    germinationRate: { toString: () => '0.85' },
    seedsPerCell: 1,
};

const basePlan = {
    id: 'plan-1',
    tenantId: 'tenant-1',
    name: 'Summer lettuce',
    method: 'TRANSPLANT' as const,
    firstSowDate: new Date('2026-04-01T00:00:00Z'),
    successions: 3,
    intervalDays: 14,
    plantsPerSuccession: 60,
    bedLengthM: null,
    rowsPerBed: null,
    targetAreaM2: null,
    cropPlanId: undefined,
    cropVarietyId: 'var-1',
    locationId: 'loc-1',
    parcelId: 'parcel-1',
    cropType: { id: 'ct-1', name: 'Lettuce' },
    variety: lettuceVariety,
};

let createdPlantings: any[];
/** Rows the FIRST (existing-state) findMany returns — a fresh plan is []. */
let existingPlantings: any[];

beforeEach(() => {
    jest.clearAllMocks();
    createdPlantings = [];
    existingPlantings = [];
    createTask.mockResolvedValue({ id: 'task-new' });
    addTaskLink.mockResolvedValue({ id: 'link-new' });

    // findFirst returns the plan with its variety joined.
    mockDb.cropPlan.findFirst.mockResolvedValue(basePlan);
    mockDb.planting.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.planting.update.mockResolvedValue({});
    // createMany records what would be persisted; the re-read returns the
    // same rows with synthetic ids so the task fan-out can run.
    mockDb.planting.createMany.mockImplementation(async ({ data }: any) => {
        createdPlantings = data.map((d: any, i: number) => ({ ...d, id: `planting-${i + 1}` }));
        return { count: data.length };
    });
    // Two distinct findMany shapes: the existing-state read (select
    // id/successionNumber/status) → existingPlantings; the re-read for the
    // task fan-out (orderBy, no select) → the created rows.
    mockDb.planting.findMany.mockImplementation(async (args: any) => {
        if (args?.select && 'successionNumber' in args.select) return existingPlantings;
        return createdPlantings;
    });
    // No pre-existing PLANTING task links by default (fresh fan-out).
    mockDb.taskLink.findMany.mockResolvedValue([]);
    mockDb.logPlanting.findMany.mockResolvedValue([]);
    mockDb.yieldRecord.findMany.mockResolvedValue([]);
});

// ─── generatePlantings — engine → plantings → tasks ─────────────────

describe('generatePlantings', () => {
    it('runs the engine and persists exactly the computed plantings', async () => {
        const result = await generatePlantings(editorCtx, 'plan-1');

        // Regenerate only prunes PLANNED rows whose succession is no longer
        // part of the plan (none, for a fresh 3-succession plan). SOWN+ rows
        // are never in scope.
        expect(mockDb.planting.deleteMany).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                cropPlanId: 'plan-1',
                status: 'PLANNED',
                successionNumber: { notIn: [1, 2, 3] },
            },
        });

        // A fresh plan has no existing rows, so all N = successions are created.
        expect(mockDb.planting.createMany).toHaveBeenCalledTimes(1);
        const persisted = mockDb.planting.createMany.mock.calls[0][0].data;
        expect(persisted).toHaveLength(3);

        // And those rows match what the PURE engine computes from the
        // same inputs — the integration contract.
        const expected = generateSuccessions(
            { firstSowDate: basePlan.firstSowDate, successions: 3, intervalDays: 14 },
            { method: 'TRANSPLANT', daysToTransplant: 28, daysToMaturity: 45, harvestWindowDays: 14 },
            { plantsPerSuccession: 60, bedLengthM: null, rowsPerBed: null, areaM2: null },
            {
                inRowSpacingCm: 25,
                betweenRowSpacingCm: 30,
                seedsPerGram: 800,
                germinationRate: 0.85,
                seedsPerCell: 1,
            },
        );
        expect(persisted[0].sowDate).toEqual(expected[0].sowDate);
        expect(persisted[0].harvestStartDate).toEqual(expected[0].harvestStartDate);
        expect(persisted[1].sowDate).toEqual(expected[1].sowDate);
        expect(persisted[0].plantCount).toBe(expected[0].plantCount);
        expect(persisted[0].seedQuantityGrams).toBe(expected[0].seedQuantityGrams);
        // Carries the plan's variety + location + parcel onto each planting.
        expect(persisted[0].cropVarietyId).toBe('var-1');
        expect(persisted[0].locationId).toBe('loc-1');
        expect(persisted[0].parcelId).toBe('parcel-1');

        expect(result.plantingsGenerated).toBe(3);
    });

    it('fans out SOW + TRANSPLANT + HARVEST tasks per planting, linked to PLANTING', async () => {
        const result = await generatePlantings(editorCtx, 'plan-1');

        // TRANSPLANT method ⇒ 3 stages × 3 successions = 9 tasks.
        expect(createTask).toHaveBeenCalledTimes(9);
        expect(addTaskLink).toHaveBeenCalledTimes(9);
        expect(result.tasksCreated).toBe(9);

        // Every link is a PLANTING link to a created planting id.
        for (const call of addTaskLink.mock.calls) {
            expect(call[2]).toBe('PLANTING');
            expect(call[3]).toMatch(/^planting-\d+$/);
        }

        // Tasks carry the FARM_TASK type + the stage tag for idempotency.
        const stages = createTask.mock.calls.map((c) => c[1].metadataJson.plantingStage);
        expect(stages.filter((s) => s === 'SOW')).toHaveLength(3);
        expect(stages.filter((s) => s === 'TRANSPLANT')).toHaveLength(3);
        expect(stages.filter((s) => s === 'HARVEST')).toHaveLength(3);
        expect(createTask.mock.calls[0][1].type).toBe('FARM_TASK');
    });

    it('omits the TRANSPLANT task for a DIRECT_SOW plan', async () => {
        mockDb.cropPlan.findFirst.mockResolvedValue({
            ...basePlan,
            method: 'DIRECT_SOW',
            variety: { ...lettuceVariety, defaultMethod: 'DIRECT_SOW', daysToTransplant: null },
        });

        const result = await generatePlantings(editorCtx, 'plan-1');

        // 2 stages (SOW + HARVEST) × 3 successions = 6 tasks.
        expect(createTask).toHaveBeenCalledTimes(6);
        expect(result.tasksCreated).toBe(6);
        const stages = createTask.mock.calls.map((c) => c[1].metadataJson.plantingStage);
        expect(stages).not.toContain('TRANSPLANT');
        // Direct-sow plantings carry no transplant date.
        const persisted = mockDb.planting.createMany.mock.calls[0][0].data;
        expect(persisted[0].transplantDate).toBeNull();
    });

    it('is idempotent — skips a stage whose PLANTING task already exists', async () => {
        // Pre-existing SOW task on planting-1 (a prior fan-out).
        mockDb.taskLink.findMany.mockResolvedValue([
            { entityId: 'planting-1', task: { metadataJson: { plantingStage: 'SOW' } } },
        ]);

        const result = await generatePlantings(editorCtx, 'plan-1');

        // 9 stages minus the 1 already-present SOW = 8 created.
        expect(createTask).toHaveBeenCalledTimes(8);
        expect(result.tasksCreated).toBe(8);
        // The skipped one is planting-1's SOW.
        const made = createTask.mock.calls.map(
            (c, i) => `${addTaskLink.mock.calls[i][3]}:${c[1].metadataJson.plantingStage}`,
        );
        expect(made).not.toContain('planting-1:SOW');
    });

    it('regenerate PRESERVES a SOWN succession — no re-create, no delete', async () => {
        // Succession 1 has already been sown (has recorded actuals); 2 + 3
        // are still to plant. A re-Generate must keep succession 1 intact.
        existingPlantings = [
            { id: 'planting-sown-1', successionNumber: 1, status: 'SOWN' },
        ];

        await generatePlantings(editorCtx, 'plan-1');

        // Only the MISSING successions (2, 3) are created — succession 1 is
        // never re-created (that would mint a new id + orphan its actuals).
        expect(mockDb.planting.createMany).toHaveBeenCalledTimes(1);
        const created = mockDb.planting.createMany.mock.calls[0][0].data;
        expect(created.map((d: any) => d.successionNumber)).toEqual([2, 3]);

        // The SOWN row is neither updated (it's not PLANNED) nor deleted
        // (its succession is still in the plan).
        expect(mockDb.planting.update).not.toHaveBeenCalled();
        const delWhere = mockDb.planting.deleteMany.mock.calls[0][0].where;
        expect(delWhere.status).toBe('PLANNED');
        expect(delWhere.successionNumber).toEqual({ notIn: [1, 2, 3] });
    });

    it('regenerate REFRESHES a still-PLANNED row in place (update, not re-create)', async () => {
        // Succession 1 already exists but is still PLANNED — a re-Generate
        // updates its dates/allocation in place, preserving its id.
        existingPlantings = [
            { id: 'planting-old-1', successionNumber: 1, status: 'PLANNED' },
        ];

        await generatePlantings(editorCtx, 'plan-1');

        // Succession 1 is UPDATED in place, keyed on its stable id.
        expect(mockDb.planting.update).toHaveBeenCalledTimes(1);
        expect(mockDb.planting.update.mock.calls[0][0].where).toEqual({ id: 'planting-old-1' });
        const updData = mockDb.planting.update.mock.calls[0][0].data;
        expect(updData).not.toHaveProperty('status'); // stays PLANNED
        expect(updData.method).toBe('TRANSPLANT');

        // Only the missing successions (2, 3) are created.
        const created = mockDb.planting.createMany.mock.calls[0][0].data;
        expect(created.map((d: any) => d.successionNumber)).toEqual([2, 3]);
    });

    it('reads the idempotency set in ONE batched taskLink query (no N+1)', async () => {
        await generatePlantings(editorCtx, 'plan-1');
        // The whole idempotency check is a single findMany with an `in`.
        expect(mockDb.taskLink.findMany).toHaveBeenCalledTimes(1);
        const where = mockDb.taskLink.findMany.mock.calls[0][0].where;
        expect(where.entityType).toBe('PLANTING');
        expect(where.entityId.in).toEqual(['planting-1', 'planting-2', 'planting-3']);
    });

    it('writes a generation audit event', async () => {
        await generatePlantings(editorCtx, 'plan-1');
        expect(logEvent).toHaveBeenCalledWith(
            mockDb,
            editorCtx,
            expect.objectContaining({
                action: 'CROP_PLAN_PLANTINGS_GENERATED',
                entityType: 'CropPlan',
                detailsJson: expect.objectContaining({ category: 'entity_lifecycle' }),
            }),
        );
    });

    it('throws if the plan has no maturity-bearing variety', async () => {
        mockDb.cropPlan.findFirst.mockResolvedValue({ ...basePlan, variety: null });
        await expect(generatePlantings(editorCtx, 'plan-1')).rejects.toThrow(/CROP_PLAN_NOT_READY/);
        expect(mockDb.planting.createMany).not.toHaveBeenCalled();
        expect(createTask).not.toHaveBeenCalled();
    });

    it('throws notFound for a missing plan', async () => {
        mockDb.cropPlan.findFirst.mockResolvedValue(null);
        await expect(generatePlantings(editorCtx, 'nope')).rejects.toThrow(/not found/i);
    });

    it('refuses a reader (write gate)', async () => {
        await expect(generatePlantings(readerCtx, 'plan-1')).rejects.toThrow();
        expect(mockDb.cropPlan.findFirst).not.toHaveBeenCalled();
    });
});

// ─── getCropPlanProgress — plan-vs-actual mapping ───────────────────

describe('getCropPlanProgress', () => {
    const plantings = [
        {
            id: 'planting-1',
            successionNumber: 1,
            method: 'TRANSPLANT',
            status: 'SOWN',
            sowDate: new Date('2026-04-01T00:00:00Z'),
            transplantDate: new Date('2026-04-29T00:00:00Z'),
            harvestStartDate: new Date('2026-06-13T00:00:00Z'),
            harvestEndDate: new Date('2026-06-27T00:00:00Z'),
        },
        {
            id: 'planting-2',
            successionNumber: 2,
            method: 'TRANSPLANT',
            status: 'PLANNED',
            sowDate: new Date('2026-04-15T00:00:00Z'),
            transplantDate: new Date('2026-05-13T00:00:00Z'),
            harvestStartDate: new Date('2026-06-27T00:00:00Z'),
            harvestEndDate: new Date('2026-07-11T00:00:00Z'),
        },
    ];

    beforeEach(() => {
        mockDb.cropPlan.findFirst.mockResolvedValue({ id: 'plan-1' });
        mockDb.planting.findMany.mockResolvedValue(plantings);
    });

    it('maps planned dates beside the actuals from LogPlanting (one query)', async () => {
        // planting-1 was actually sown a day late (2026-04-02).
        mockDb.logPlanting.findMany.mockResolvedValue([
            { plantingId: 'planting-1', stage: 'SOW', logEntry: { occurredAt: new Date('2026-04-02T00:00:00Z') } },
        ]);

        const rows = await getCropPlanProgress(readerCtx, 'plan-1');

        // ONE query for all actuals — no N+1.
        expect(mockDb.logPlanting.findMany).toHaveBeenCalledTimes(1);
        expect(mockDb.logPlanting.findMany.mock.calls[0][0].where.plantingId.in).toEqual([
            'planting-1',
            'planting-2',
        ]);

        expect(rows).toHaveLength(2);
        expect(rows[0].planned.sowDate).toBe('2026-04-01T00:00:00.000Z');
        expect(rows[0].actual.SOW).toBe('2026-04-02T00:00:00.000Z');
        // No actual transplant/harvest recorded yet.
        expect(rows[0].actual.TRANSPLANT).toBeNull();
        // planting-2 has no actuals at all.
        expect(rows[1].actual).toEqual({ SOW: null, TRANSPLANT: null, HARVEST: null });
    });

    it('keeps the EARLIEST actual when a stage has multiple log entries', async () => {
        mockDb.logPlanting.findMany.mockResolvedValue([
            { plantingId: 'planting-1', stage: 'HARVEST', logEntry: { occurredAt: new Date('2026-06-20T00:00:00Z') } },
            { plantingId: 'planting-1', stage: 'HARVEST', logEntry: { occurredAt: new Date('2026-06-14T00:00:00Z') } },
        ]);
        const rows = await getCropPlanProgress(readerCtx, 'plan-1');
        expect(rows[0].actual.HARVEST).toBe('2026-06-14T00:00:00.000Z');
    });

    it('throws notFound for a missing plan', async () => {
        mockDb.cropPlan.findFirst.mockResolvedValue(null);
        await expect(getCropPlanProgress(readerCtx, 'nope')).rejects.toThrow(/not found/i);
    });

    // ── a recorded yield IS a harvest actual ──
    //
    // `YieldRecord.plantingId` was written by the yield form and read by
    // nothing, so a farmer who recorded 90 t against a planting still saw an
    // unrealised HARVEST milestone on the board. These cover the fold.

    it('realises the HARVEST milestone from a YieldRecord, not just LogPlanting', async () => {
        mockDb.yieldRecord.findMany.mockResolvedValue([
            { plantingId: 'planting-1', harvestedAt: new Date('2026-06-18T00:00:00Z') },
        ]);

        const rows = await getCropPlanProgress(readerCtx, 'plan-1');

        expect(rows[0].actual.HARVEST).toBe('2026-06-18T00:00:00.000Z');
        // ONE query for every planting's yields — no N+1.
        expect(mockDb.yieldRecord.findMany).toHaveBeenCalledTimes(1);
        expect(mockDb.yieldRecord.findMany.mock.calls[0][0].where.plantingId.in).toEqual([
            'planting-1',
            'planting-2',
        ]);
    });

    it('keeps the earliest actual across BOTH sources', async () => {
        // The journal says the 20th, the yield record says the 14th. A
        // planting harvested via both surfaces must report one date.
        mockDb.logPlanting.findMany.mockResolvedValue([
            { plantingId: 'planting-1', stage: 'HARVEST', logEntry: { occurredAt: new Date('2026-06-20T00:00:00Z') } },
        ]);
        mockDb.yieldRecord.findMany.mockResolvedValue([
            { plantingId: 'planting-1', harvestedAt: new Date('2026-06-14T00:00:00Z') },
        ]);

        const rows = await getCropPlanProgress(readerCtx, 'plan-1');
        expect(rows[0].actual.HARVEST).toBe('2026-06-14T00:00:00.000Z');
    });

    it('ignores a yield record with no harvest date', async () => {
        // harvestedAt is nullable; a record without one says nothing about
        // WHEN the milestone was realised, so it must not fabricate a date.
        mockDb.yieldRecord.findMany.mockResolvedValue([
            { plantingId: 'planting-1', harvestedAt: null },
        ]);
        const rows = await getCropPlanProgress(readerCtx, 'plan-1');
        expect(rows[0].actual.HARVEST).toBeNull();
    });

    it('only reads live yield records with a harvest date', async () => {
        await getCropPlanProgress(readerCtx, 'plan-1');
        const where = mockDb.yieldRecord.findMany.mock.calls[0][0].where;
        expect(where.deletedAt).toBeNull();
        expect(where.harvestedAt).toEqual({ not: null });
        expect(where.tenantId).toBe('tenant-1');
    });

    // ─── plannedYieldKgPerHa: propagates, and null stays null ──────────
    it('propagates plannedYieldKgPerHa as a plain number, unmangled', async () => {
        mockDb.planting.findMany.mockResolvedValue([
            { ...plantings[0], areaM2: { toString: () => '10000' }, plannedYieldKgPerHa: { toString: () => '5000' } },
            { ...plantings[1], areaM2: { toString: () => '10000' }, plannedYieldKgPerHa: null },
        ]);
        const rows = await getCropPlanProgress(readerCtx, 'plan-1');
        expect(rows[0].plannedYieldKgPerHa).toBe(5000);
        expect(rows[0].areaM2).toBe(10000);
        // Unset stays NULL — never coerced to 0 on the way out of the DB.
        expect(rows[1].plannedYieldKgPerHa).toBeNull();
        expect(rows[1].plannedYieldKgPerHa).not.toBe(0);
    });

    it('downstream: summarizePlannedYield excludes the unset planting from the plan total', async () => {
        // planting-1: 1 ha at 5000 kg/ha = 5000 kg. planting-2: no estimate.
        mockDb.planting.findMany.mockResolvedValue([
            { ...plantings[0], areaM2: { toString: () => '10000' }, plannedYieldKgPerHa: { toString: () => '5000' } },
            { ...plantings[1], areaM2: { toString: () => '10000' }, plannedYieldKgPerHa: null },
        ]);
        const rows = await getCropPlanProgress(readerCtx, 'plan-1');
        const summary = summarizePlannedYield(
            rows.map((r) => ({ id: r.plantingId, areaM2: r.areaM2, plannedYieldKgPerHa: r.plannedYieldKgPerHa })),
        );
        expect(summary.totalPlannedYieldKg).toBe(5000);
        expect(summary.includedPlantingIds).toEqual(['planting-1']);
        expect(summary.excludedPlantingIds).toEqual(['planting-2']);
    });
});

// ─── read/write gating on the CRUD surface ──────────────────────────

describe('crop-plan CRUD gating', () => {
    it('listCropPlans is allowed for a reader and forwards filters', async () => {
        mockDb.cropPlan.findMany.mockResolvedValue([{ id: 'plan-1' }]);
        const rows = await listCropPlans(readerCtx, { seasonId: 's-1' });
        expect(rows).toEqual([{ id: 'plan-1' }]);
        const where = mockDb.cropPlan.findMany.mock.calls[0][0].where;
        expect(where.seasonId).toBe('s-1');
        expect(where.tenantId).toBe('tenant-1');
    });

    // `status` is a `multiple: true` facet (CropPlansClient / filter-defs.ts)
    // comma-joined into an array by the route's `csvEnumField`. Regression
    // coverage for the crop-plans 500: a bare string equality on a
    // multi-value status threw PrismaClientValidationError, which the list
    // page rendered as "no crop plans".
    it('listCropPlans queries a multi-value status filter with `in`, not equality', async () => {
        mockDb.cropPlan.findMany.mockResolvedValue([]);
        await listCropPlans(readerCtx, { status: ['DRAFT', 'ACTIVE'] });
        const where = mockDb.cropPlan.findMany.mock.calls[0][0].where;
        expect(where.status).toEqual({ in: ['DRAFT', 'ACTIVE'] });
    });

    it('listCropPlans OMITS the status filter entirely when the facet is cleared (empty array)', async () => {
        mockDb.cropPlan.findMany.mockResolvedValue([]);
        await listCropPlans(readerCtx, { status: [] });
        const where = mockDb.cropPlan.findMany.mock.calls[0][0].where;
        // `{ in: [] }` would match nothing — a cleared facet must show
        // every plan again, not an empty table.
        expect(where.status).toBeUndefined();
    });

    it('createCropPlan refuses a reader', async () => {
        await expect(
            createCropPlan(readerCtx, {
                seasonId: 's-1',
                cropTypeId: 'ct-1',
                name: 'X',
                firstSowDate: '2026-04-01T00:00:00Z',
            }),
        ).rejects.toThrow();
    });

    it('createCropPlan validates the season + crop type belong to the tenant', async () => {
        mockDb.season.findFirst.mockResolvedValue(null);
        await expect(
            createCropPlan(editorCtx, {
                seasonId: 'foreign',
                cropTypeId: 'ct-1',
                name: 'X',
                firstSowDate: '2026-04-01T00:00:00Z',
            }),
        ).rejects.toThrow(/season/i);
    });
});

// ─── deleteCropPlan — soft-delete + admin gate ──────────────────────

describe('deleteCropPlan', () => {
    it('soft-deletes: stamps deletedAt + deletedByUserId (no hard delete)', async () => {
        mockDb.cropPlan.findFirst.mockResolvedValue({ id: 'plan-1', name: 'Summer lettuce' });
        mockDb.cropPlan.update.mockResolvedValue({ id: 'plan-1' });

        const result = await deleteCropPlan(adminCtx, 'plan-1');

        expect(result).toEqual({ success: true });
        const call = mockDb.cropPlan.update.mock.calls[0][0];
        expect(call.where).toEqual({ id: 'plan-1' });
        expect(call.data.deletedAt).toBeInstanceOf(Date);
        expect(call.data.deletedByUserId).toBe('user-admin');
        expect(logEvent).toHaveBeenCalledWith(
            mockDb,
            adminCtx,
            expect.objectContaining({ action: 'SOFT_DELETE', entityType: 'CropPlan' }),
        );
    });

    it('throws notFound for a missing (or already-deleted) plan', async () => {
        mockDb.cropPlan.findFirst.mockResolvedValue(null);
        await expect(deleteCropPlan(adminCtx, 'nope')).rejects.toThrow(/not found/i);
        expect(mockDb.cropPlan.update).not.toHaveBeenCalled();
    });

    it('refuses a non-admin writer (admin gate)', async () => {
        await expect(deleteCropPlan(editorCtx, 'plan-1')).rejects.toThrow();
        expect(mockDb.cropPlan.findFirst).not.toHaveBeenCalled();
    });
});

// ─── advancePlantingStatusForLinks — monotonic-forward status ───────
describe('advancePlantingStatusForLinks', () => {
    it('is a no-op for an empty link set (no DB access)', async () => {
        await advancePlantingStatusForLinks(mockDb, adminCtx, []);
        expect(mockDb.planting.findMany).not.toHaveBeenCalled();
        expect(mockDb.planting.update).not.toHaveBeenCalled();
    });

    it('advances a PLANNED planting forward to the stage implied by the link', async () => {
        mockDb.planting.findMany.mockImplementation(async () => [{ id: 'p1', status: 'PLANNED' }]);
        await advancePlantingStatusForLinks(mockDb, adminCtx, [{ plantingId: 'p1', stage: 'SOW' }]);
        // Query is tenant-scoped + bounded to the ids asked for.
        const findArg = mockDb.planting.findMany.mock.calls[0][0];
        expect(findArg.where).toMatchObject({ tenantId: 'tenant-1', id: { in: ['p1'] } });
        expect(mockDb.planting.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { status: 'SOWN' } });
    });

    it('never moves a planting BACKWARD (already ahead of the link stage)', async () => {
        mockDb.planting.findMany.mockImplementation(async () => [{ id: 'p1', status: 'HARVESTED' }]);
        await advancePlantingStatusForLinks(mockDb, adminCtx, [{ plantingId: 'p1', stage: 'SOW' }]);
        expect(mockDb.planting.update).not.toHaveBeenCalled();
    });

    it('collapses multiple stages for one planting to the HIGHEST implied status', async () => {
        mockDb.planting.findMany.mockImplementation(async () => [{ id: 'p1', status: 'PLANNED' }]);
        await advancePlantingStatusForLinks(mockDb, adminCtx, [
            { plantingId: 'p1', stage: 'SOW' },
            { plantingId: 'p1', stage: 'HARVEST' },
        ]);
        expect(mockDb.planting.update).toHaveBeenCalledTimes(1);
        expect(mockDb.planting.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { status: 'HARVESTED' } });
    });
});

// ─── Season CRUD ─────────────────────────────────────────────────────
describe('season CRUD', () => {
    it('listSeasons: reader allowed, tenant-scoped + bounded', async () => {
        mockDb.season.findMany.mockResolvedValue([{ id: 's-1' }]);
        const rows = await listSeasons(readerCtx);
        expect(rows).toEqual([{ id: 's-1' }]);
        const arg = mockDb.season.findMany.mock.calls[0][0];
        expect(arg.where).toMatchObject({ tenantId: 'tenant-1', deletedAt: null });
        expect(arg.take).toBe(500);
    });

    it('createSeason: writes the row (default status) + emits an audit event', async () => {
        mockDb.season.create.mockResolvedValue({ id: 's-1', name: 'Spring', status: 'PLANNING' });
        const s = await createSeason(editorCtx, { name: 'Spring', startDate: '2026-03-01', endDate: '2026-06-01' });
        expect(s.id).toBe('s-1');
        expect(mockDb.season.create.mock.calls[0][0].data).toMatchObject({
            tenantId: 'tenant-1',
            name: 'Spring',
            status: 'PLANNING',
        });
        expect(logEvent).toHaveBeenCalledTimes(1);
    });

    it('createSeason: refuses a reader (write gate)', async () => {
        await expect(
            createSeason(readerCtx, { name: 'X', startDate: '2026-01-01', endDate: '2026-02-01' }),
        ).rejects.toThrow();
        expect(mockDb.season.create).not.toHaveBeenCalled();
    });

    it('createSeason: rejects an empty name', async () => {
        await expect(
            createSeason(editorCtx, { name: '', startDate: '2026-01-01', endDate: '2026-02-01' }),
        ).rejects.toThrow(/name is required/i);
    });

    it('createSeason: rejects an invalid date', async () => {
        await expect(
            createSeason(editorCtx, { name: 'X', startDate: 'not-a-date', endDate: '2026-02-01' }),
        ).rejects.toThrow(/valid date/i);
    });

    it('createSeason: rejects an end date before the start date', async () => {
        await expect(
            createSeason(editorCtx, { name: 'X', startDate: '2026-06-01', endDate: '2026-03-01' }),
        ).rejects.toThrow(/on or after/i);
    });

    it('updateSeason: patches only the provided fields + emits an audit event', async () => {
        mockDb.season.findFirst.mockResolvedValue({ id: 's-1' });
        mockDb.season.update.mockResolvedValue({ id: 's-1', name: 'Renamed', status: 'ACTIVE' });
        const s = await updateSeason(editorCtx, 's-1', { name: 'Renamed', status: 'ACTIVE' });
        expect(s.name).toBe('Renamed');
        const data = mockDb.season.update.mock.calls[0][0].data;
        expect(data).toMatchObject({ name: 'Renamed', status: 'ACTIVE' });
        expect(data.startDate).toBeUndefined();
        expect(logEvent).toHaveBeenCalledTimes(1);
    });

    it('updateSeason: throws notFound for a missing (or deleted) season', async () => {
        mockDb.season.findFirst.mockResolvedValue(null);
        await expect(updateSeason(editorCtx, 'nope', { name: 'X' })).rejects.toThrow(/not found/i);
        expect(mockDb.season.update).not.toHaveBeenCalled();
    });

    it('updateSeason: rejects an empty name before touching the DB', async () => {
        await expect(updateSeason(editorCtx, 's-1', { name: '' })).rejects.toThrow(/name is required/i);
        expect(mockDb.season.findFirst).not.toHaveBeenCalled();
    });
});

// ─── Catalog: CropType + CropVariety ─────────────────────────────────
describe('catalog CRUD', () => {
    it('listCropTypes: reader allowed, returns the cached loader result', async () => {
        mockDb.cropType.findMany.mockResolvedValue([{ id: 'ct-1', name: 'Tomato' }]);
        const rows = await listCropTypes(readerCtx);
        expect(rows).toEqual([{ id: 'ct-1', name: 'Tomato' }]);
    });

    it('createCropType: writes the row, audits, and bumps the cache version', async () => {
        mockDb.cropType.create.mockResolvedValue({ id: 'ct-1', name: 'Tomato' });
        const ct = await createCropType(editorCtx, { name: 'Tomato', family: 'Solanaceae' });
        expect(ct.id).toBe('ct-1');
        expect(mockDb.cropType.create.mock.calls[0][0].data).toMatchObject({ tenantId: 'tenant-1', name: 'Tomato' });
        expect(logEvent).toHaveBeenCalledTimes(1);
        expect(bumpEntityCacheVersion).toHaveBeenCalledWith(editorCtx, 'crop-type');
    });

    it('createCropType: refuses a reader', async () => {
        await expect(createCropType(readerCtx, { name: 'Tomato' })).rejects.toThrow();
        expect(mockDb.cropType.create).not.toHaveBeenCalled();
    });

    it('listCropVarieties: forwards a cropTypeId filter through the loader', async () => {
        mockDb.cropVariety.findMany.mockResolvedValue([{ id: 'v-1' }]);
        const rows = await listCropVarieties(readerCtx, { cropTypeId: 'ct-1' });
        expect(rows).toEqual([{ id: 'v-1' }]);
        expect(mockDb.cropVariety.findMany.mock.calls[0][0].where).toMatchObject({
            tenantId: 'tenant-1',
            cropTypeId: 'ct-1',
        });
    });

    it('createCropVariety: persists the soil + GDD defaults when supplied', async () => {
        mockDb.cropType.findFirst.mockResolvedValue({ id: 'ct-1' });
        mockDb.cropVariety.create.mockResolvedValue({ id: 'v-1', name: 'Cherry', cropTypeId: 'ct-1' });
        const soil = { phMin: 6, phMax: 6.8, texturePreference: ['Loam'], drainagePreference: 'well' };
        const v = await createCropVariety(editorCtx, {
            cropTypeId: 'ct-1',
            name: 'Cherry',
            gddBaseC: 10,
            gddToMaturity: 700,
            soilDefaultsJson: soil,
        });
        expect(v.id).toBe('v-1');
        const data = mockDb.cropVariety.create.mock.calls[0][0].data;
        expect(data).toMatchObject({ gddBaseC: 10, gddToMaturity: 700, soilDefaultsJson: soil });
        expect(bumpEntityCacheVersion).toHaveBeenCalledWith(editorCtx, 'crop-variety');
    });

    it('createCropVariety: rejects a crop type from another tenant', async () => {
        mockDb.cropType.findFirst.mockResolvedValue(null);
        await expect(
            createCropVariety(editorCtx, { cropTypeId: 'foreign', name: 'Cherry' }),
        ).rejects.toThrow(/INVALID_CROP_TYPE/);
        expect(mockDb.cropVariety.create).not.toHaveBeenCalled();
    });

    it('createCropVariety: omits soilDefaultsJson from the write when not supplied', async () => {
        mockDb.cropType.findFirst.mockResolvedValue({ id: 'ct-1' });
        mockDb.cropVariety.create.mockResolvedValue({ id: 'v-2', name: 'Beefsteak', cropTypeId: 'ct-1' });
        await createCropVariety(editorCtx, { cropTypeId: 'ct-1', name: 'Beefsteak' });
        const data = mockDb.cropVariety.create.mock.calls[0][0].data;
        expect('soilDefaultsJson' in data).toBe(false);
        expect(data.gddBaseC).toBeNull();
    });
});

// ─── CropPlan read + update + listPlantings ──────────────────────────
describe('getCropPlan / updateCropPlan / listPlantings', () => {
    it('getCropPlan: returns the tenant-scoped plan', async () => {
        mockDb.cropPlan.findFirst.mockResolvedValue({ id: 'plan-1', name: 'Summer lettuce' });
        const plan = await getCropPlan(readerCtx, 'plan-1');
        expect(plan.name).toBe('Summer lettuce');
        expect(mockDb.cropPlan.findFirst.mock.calls[0][0].where).toMatchObject({
            id: 'plan-1',
            tenantId: 'tenant-1',
            deletedAt: null,
        });
    });

    it('getCropPlan: throws notFound for a missing plan', async () => {
        mockDb.cropPlan.findFirst.mockResolvedValue(null);
        await expect(getCropPlan(readerCtx, 'nope')).rejects.toThrow(/not found/i);
    });

    it('updateCropPlan: applies a lifecycle status transition + audits it', async () => {
        mockDb.cropPlan.findFirst.mockResolvedValue({ id: 'plan-1' });
        mockDb.cropPlan.update.mockResolvedValue({ id: 'plan-1', name: 'Summer lettuce', status: 'ACTIVE' });
        const plan = await updateCropPlan(editorCtx, 'plan-1', { status: 'ACTIVE' });
        expect(plan.status).toBe('ACTIVE');
        expect(mockDb.cropPlan.update.mock.calls[0][0].data).toMatchObject({ status: 'ACTIVE' });
        expect(logEvent).toHaveBeenCalledTimes(1);
    });

    it('updateCropPlan: throws notFound for a missing plan', async () => {
        mockDb.cropPlan.findFirst.mockResolvedValue(null);
        await expect(updateCropPlan(editorCtx, 'nope', { name: 'X' })).rejects.toThrow(/not found/i);
        expect(mockDb.cropPlan.update).not.toHaveBeenCalled();
    });

    it('updateCropPlan: refuses a reader (write gate)', async () => {
        await expect(updateCropPlan(readerCtx, 'plan-1', { status: 'ACTIVE' })).rejects.toThrow();
        expect(mockDb.cropPlan.findFirst).not.toHaveBeenCalled();
    });

    it('listPlantings: reader allowed, forwards cropPlanId + status filters', async () => {
        mockDb.planting.findMany.mockImplementation(async () => [{ id: 'p-1', successionNumber: 1 }]);
        const rows = await listPlantings(readerCtx, { cropPlanId: 'plan-1', status: 'SOWN' });
        expect(rows).toEqual([{ id: 'p-1', successionNumber: 1 }]);
        expect(mockDb.planting.findMany.mock.calls[0][0].where).toMatchObject({
            tenantId: 'tenant-1',
            cropPlanId: 'plan-1',
            status: 'SOWN',
        });
    });
});

// ─── updatePlanting — plannedYieldKgPerHa, null-is-not-zero ──────────
describe('updatePlanting', () => {
    it('writes plannedYieldKgPerHa and audits it', async () => {
        mockDb.planting.findFirst.mockResolvedValue({ id: 'planting-1' });
        mockDb.planting.update.mockResolvedValue({ id: 'planting-1', plannedYieldKgPerHa: 5000 });
        const planting = await updatePlanting(editorCtx, 'planting-1', { plannedYieldKgPerHa: 5000 });
        expect(planting.plannedYieldKgPerHa).toBe(5000);
        expect(mockDb.planting.update.mock.calls[0][0].data).toMatchObject({ plannedYieldKgPerHa: 5000 });
        expect(logEvent).toHaveBeenCalledTimes(1);
    });

    it('writes an explicit null WITHOUT coercing it to 0 (clearing an estimate)', async () => {
        mockDb.planting.findFirst.mockResolvedValue({ id: 'planting-1' });
        mockDb.planting.update.mockResolvedValue({ id: 'planting-1', plannedYieldKgPerHa: null });
        const planting = await updatePlanting(editorCtx, 'planting-1', { plannedYieldKgPerHa: null });
        // The write itself carries `null`, never `0` — a cleared estimate
        // and a zero estimate are different claims (see the field's schema
        // doc + `summarizePlannedYield`).
        expect(mockDb.planting.update.mock.calls[0][0].data).toMatchObject({ plannedYieldKgPerHa: null });
        expect(mockDb.planting.update.mock.calls[0][0].data.plannedYieldKgPerHa).not.toBe(0);
        expect(planting.plannedYieldKgPerHa).toBeNull();
    });

    it('omits plannedYieldKgPerHa from the update payload when not provided (partial update)', async () => {
        mockDb.planting.findFirst.mockResolvedValue({ id: 'planting-1' });
        mockDb.planting.update.mockResolvedValue({ id: 'planting-1' });
        await updatePlanting(editorCtx, 'planting-1', {});
        expect(mockDb.planting.update.mock.calls[0][0].data).not.toHaveProperty('plannedYieldKgPerHa');
    });

    it('throws notFound for a missing planting', async () => {
        mockDb.planting.findFirst.mockResolvedValue(null);
        await expect(updatePlanting(editorCtx, 'nope', { plannedYieldKgPerHa: 100 })).rejects.toThrow(/not found/i);
        expect(mockDb.planting.update).not.toHaveBeenCalled();
    });

    it('refuses a reader (write gate)', async () => {
        await expect(updatePlanting(readerCtx, 'planting-1', { plannedYieldKgPerHa: 100 })).rejects.toThrow();
        expect(mockDb.planting.findFirst).not.toHaveBeenCalled();
    });
});

// ─── createCropPlan — full validation chain + create ─────────────────
describe('createCropPlan validation chain', () => {
    /** Wire the season/cropType/variety/parcel lookups to all resolve. */
    function wireValidLookups() {
        mockDb.season.findFirst.mockResolvedValue({ id: 's-1' });
        mockDb.cropType.findFirst.mockResolvedValue({ id: 'ct-1' });
        mockDb.cropVariety.findFirst.mockResolvedValue({ id: 'v-1' });
        mockDb.parcel.findFirst.mockResolvedValue({ id: 'parcel-1', locationId: 'loc-1' });
        mockDb.cropPlan.create.mockResolvedValue({ id: 'plan-1', name: 'Summer lettuce', successions: 3, status: 'DRAFT' });
    }

    it('creates the plan after validating season + type + variety + parcel, then audits', async () => {
        wireValidLookups();
        const plan = await createCropPlan(editorCtx, {
            seasonId: 's-1',
            cropTypeId: 'ct-1',
            cropVarietyId: 'v-1',
            locationId: 'loc-1',
            parcelId: 'parcel-1',
            name: 'Summer lettuce',
            firstSowDate: '2026-04-01T00:00:00Z',
            successions: 3,
        });
        expect(plan.id).toBe('plan-1');
        expect(mockDb.cropPlan.create.mock.calls[0][0].data).toMatchObject({
            tenantId: 'tenant-1',
            seasonId: 's-1',
            cropTypeId: 'ct-1',
            name: 'Summer lettuce',
            status: 'DRAFT',
        });
        expect(logEvent).toHaveBeenCalledTimes(1);
    });

    it('rejects an invalid firstSowDate before any lookup', async () => {
        await expect(
            createCropPlan(editorCtx, { seasonId: 's-1', cropTypeId: 'ct-1', name: 'X', firstSowDate: 'nope' }),
        ).rejects.toThrow(/valid date/i);
        expect(mockDb.season.findFirst).not.toHaveBeenCalled();
    });

    it('rejects a variety from another tenant (INVALID_VARIETY)', async () => {
        mockDb.season.findFirst.mockResolvedValue({ id: 's-1' });
        mockDb.cropType.findFirst.mockResolvedValue({ id: 'ct-1' });
        mockDb.cropVariety.findFirst.mockResolvedValue(null);
        await expect(
            createCropPlan(editorCtx, {
                seasonId: 's-1',
                cropTypeId: 'ct-1',
                cropVarietyId: 'foreign',
                name: 'X',
                firstSowDate: '2026-04-01T00:00:00Z',
            }),
        ).rejects.toThrow(/INVALID_VARIETY/);
        expect(mockDb.cropPlan.create).not.toHaveBeenCalled();
    });

    it('rejects a parcel that does not sit within the selected location', async () => {
        mockDb.season.findFirst.mockResolvedValue({ id: 's-1' });
        mockDb.cropType.findFirst.mockResolvedValue({ id: 'ct-1' });
        mockDb.parcel.findFirst.mockResolvedValue({ id: 'parcel-1', locationId: 'other-loc' });
        await expect(
            createCropPlan(editorCtx, {
                seasonId: 's-1',
                cropTypeId: 'ct-1',
                locationId: 'loc-1',
                parcelId: 'parcel-1',
                name: 'X',
                firstSowDate: '2026-04-01T00:00:00Z',
            }),
        ).rejects.toThrow(/PARCEL_LOCATION_MISMATCH/);
    });
});

// ─── updateCropPlan — the guarded relation branches ──────────────────
describe('updateCropPlan relation validation', () => {
    it('rejects an invalid firstSowDate before touching the DB', async () => {
        await expect(updateCropPlan(editorCtx, 'plan-1', { firstSowDate: 'nope' })).rejects.toThrow(/valid date/i);
        expect(mockDb.cropPlan.findFirst).not.toHaveBeenCalled();
    });

    it('rejects a re-pointed variety from another tenant', async () => {
        mockDb.cropPlan.findFirst.mockResolvedValue({ id: 'plan-1' });
        mockDb.cropVariety.findFirst.mockResolvedValue(null);
        await expect(updateCropPlan(editorCtx, 'plan-1', { cropVarietyId: 'foreign' })).rejects.toThrow(/INVALID_VARIETY/);
        expect(mockDb.cropPlan.update).not.toHaveBeenCalled();
    });

    it('rejects a re-pointed parcel from another tenant', async () => {
        mockDb.cropPlan.findFirst.mockResolvedValue({ id: 'plan-1' });
        mockDb.parcel.findFirst.mockResolvedValue(null);
        await expect(updateCropPlan(editorCtx, 'plan-1', { parcelId: 'foreign' })).rejects.toThrow(/INVALID_PARCEL/);
        expect(mockDb.cropPlan.update).not.toHaveBeenCalled();
    });

    it('rejects a re-pointed parcel outside the selected location', async () => {
        mockDb.cropPlan.findFirst.mockResolvedValue({ id: 'plan-1' });
        mockDb.parcel.findFirst.mockResolvedValue({ id: 'parcel-1', locationId: 'other-loc' });
        await expect(
            updateCropPlan(editorCtx, 'plan-1', { parcelId: 'parcel-1', locationId: 'loc-1' }),
        ).rejects.toThrow(/PARCEL_LOCATION_MISMATCH/);
    });

    it('applies a valid firstSowDate + in-location parcel move', async () => {
        mockDb.cropPlan.findFirst.mockResolvedValue({ id: 'plan-1' });
        mockDb.parcel.findFirst.mockResolvedValue({ id: 'parcel-1', locationId: 'loc-1' });
        mockDb.cropPlan.update.mockResolvedValue({ id: 'plan-1', name: 'Summer lettuce', status: 'ACTIVE' });
        await updateCropPlan(editorCtx, 'plan-1', {
            firstSowDate: '2026-05-01T00:00:00Z',
            parcelId: 'parcel-1',
            locationId: 'loc-1',
        });
        const data = mockDb.cropPlan.update.mock.calls[0][0].data;
        expect(data.firstSowDate).toBeInstanceOf(Date);
        expect(logEvent).toHaveBeenCalledTimes(1);
    });
});
