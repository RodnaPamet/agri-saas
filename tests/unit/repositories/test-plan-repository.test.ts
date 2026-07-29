/**
 * Coverage wave 22 — `TestPlanRepository`.
 *
 * 6 uncovered functions at 0% (5.55% lines, 36 uncovered branches) —
 * almost all of those branches are the sparse-patch builder in `update`,
 * which is the part most likely to be "simplified" into a bug.
 *
 * A note on the isolation shape, because it is NOT uniform here and a
 * reader should not mistake that for an oversight:
 *
 *   - `listByControl` / `getById` filter on `tenantId` themselves;
 *   - `update` / `updateNextDueAt` address the row by primary key ALONE.
 *     Both are reached only after `control-test.ts` has resolved the plan
 *     through the tenant-scoped `getById`, and both run inside
 *     `runInTenantContext`, so PostgreSQL RLS is the enforcing layer.
 *
 * The tests below pin that split explicitly. If a future refactor calls
 * `update` without the preceding tenant-scoped read, or moves it outside
 * a tenant-bound transaction, the comment here is the record of what was
 * being relied on.
 */
import { TestPlanRepository } from '@/app-layer/repositories/TestPlanRepository';
import { makeRequestContext } from '../../helpers/make-context';
import type { PrismaTx } from '@/lib/db-context';

const ctx = makeRequestContext('ADMIN'); // tenantId: 'tenant-1', userId: 'user-1'
const OTHER_TENANT = makeRequestContext('ADMIN', { tenantId: 'tenant-2' });

function makeDb() {
    const model = () => ({
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'plan-1' }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({ id: 'plan-1' }),
    });
    return { controlTestPlan: model(), controlTestStep: model() };
}

type FakeDb = ReturnType<typeof makeDb>;
const asTx = (db: FakeDb) => db as unknown as PrismaTx;

const argOf = (fn: jest.Mock) => fn.mock.calls[0][0];
const whereOf = (fn: jest.Mock) => fn.mock.calls[0][0].where;
const dataOf = (fn: jest.Mock) => fn.mock.calls[0][0].data;

let db: FakeDb;
beforeEach(() => {
    db = makeDb();
});

describe('TestPlanRepository — reads', () => {
    it('scopes a control’s test plans to the calling tenant', async () => {
        // Break: filtering on `controlId` alone. Control ids are in the
        // URL, so an unscoped read exposes another tenant's test
        // procedures — which describe exactly how their controls are
        // verified, and where they are weak.
        await TestPlanRepository.listByControl(asTx(db), ctx, 'c-1');

        expect(whereOf(db.controlTestPlan.findMany)).toEqual({
            tenantId: 'tenant-1',
            controlId: 'c-1',
        });
        expect(argOf(db.controlTestPlan.findMany).orderBy).toEqual({ createdAt: 'desc' });
    });

    it('follows the caller when a different tenant asks', async () => {
        await TestPlanRepository.listByControl(asTx(db), OTHER_TENANT, 'c-1');

        expect(whereOf(db.controlTestPlan.findMany).tenantId).toBe('tenant-2');
    });

    it('requires id AND tenant to open a plan', async () => {
        // This is the read every mutation in `control-test.ts` gates on,
        // so it is the load-bearing tenant check for the whole file.
        await TestPlanRepository.getById(asTx(db), ctx, 'plan-1');

        expect(whereOf(db.controlTestPlan.findFirst)).toEqual({
            id: 'plan-1',
            tenantId: 'tenant-1',
        });
    });

    it('bounds the run history it eager-loads with the plan', async () => {
        // Break: dropping `take: 10` from the nested `runs`. A plan tested
        // daily for two years drags 700 run rows (each with its evidence
        // count) into the detail payload on every page open.
        await TestPlanRepository.getById(asTx(db), ctx, 'plan-1');

        const include = argOf(db.controlTestPlan.findFirst).include;
        expect(include.runs.take).toBe(10);
        expect(include.runs.orderBy).toEqual({ createdAt: 'desc' });
        expect(include.steps.orderBy).toEqual({ sortOrder: 'asc' });
    });
});

describe('TestPlanRepository.create', () => {
    it('stamps the tenant, the control and the author', async () => {
        await TestPlanRepository.create(asTx(db), ctx, 'c-1', { name: 'Quarterly access review' });

        expect(dataOf(db.controlTestPlan.create)).toMatchObject({
            tenantId: 'tenant-1',
            controlId: 'c-1',
            name: 'Quarterly access review',
            createdByUserId: 'user-1',
        });
    });

    it('defaults method to MANUAL and frequency to AD_HOC', async () => {
        // Break: forwarding the raw undefined. Both are non-nullable enum
        // columns, so an undefined would either fall through to a schema
        // default nobody reviewed or be rejected outright.
        await TestPlanRepository.create(asTx(db), ctx, 'c-1', { name: 'P' });

        expect(dataOf(db.controlTestPlan.create)).toMatchObject({
            method: 'MANUAL',
            frequency: 'AD_HOC',
            description: null,
            ownerUserId: null,
        });
    });

    it('honours an explicit method and frequency', async () => {
        await TestPlanRepository.create(asTx(db), ctx, 'c-1', {
            name: 'P',
            method: 'AUTOMATED',
            frequency: 'QUARTERLY',
            ownerUserId: 'user-9',
            description: 'Pull the IAM report',
        });

        expect(dataOf(db.controlTestPlan.create)).toMatchObject({
            method: 'AUTOMATED',
            frequency: 'QUARTERLY',
            ownerUserId: 'user-9',
            description: 'Pull the IAM report',
        });
    });

    it('leaves expectedEvidence undefined when none is given', async () => {
        // Break: `JSON.parse(JSON.stringify(undefined))` throws. The
        // ternary is what keeps a plan created without expected evidence
        // — the common case — from 500ing.
        await TestPlanRepository.create(asTx(db), ctx, 'c-1', { name: 'P' });

        expect(dataOf(db.controlTestPlan.create).expectedEvidence).toBeUndefined();
    });

    it('deep-clones expectedEvidence so a Prisma JSON column accepts it', async () => {
        await TestPlanRepository.create(asTx(db), ctx, 'c-1', {
            name: 'P',
            expectedEvidence: { artefacts: ['screenshot', 'export'] },
        });

        expect(dataOf(db.controlTestPlan.create).expectedEvidence).toEqual({
            artefacts: ['screenshot', 'export'],
        });
    });

    it('numbers the steps from zero and stamps each with the tenant', async () => {
        // Break: using a 1-based index, or omitting `sortOrder` entirely.
        // Steps are rendered `orderBy: sortOrder asc` (see getById), so a
        // missing index scrambles the order a tester is meant to follow.
        await TestPlanRepository.create(asTx(db), ctx, 'c-1', {
            name: 'P',
            steps: [
                { instruction: 'Open the IAM console' },
                { instruction: 'Export the role list', expectedOutput: 'CSV with 3 columns' },
            ],
        });

        expect(dataOf(db.controlTestStep.createMany)).toEqual([
            {
                tenantId: 'tenant-1',
                testPlanId: 'plan-1',
                sortOrder: 0,
                instruction: 'Open the IAM console',
                expectedOutput: null,
            },
            {
                tenantId: 'tenant-1',
                testPlanId: 'plan-1',
                sortOrder: 1,
                instruction: 'Export the role list',
                expectedOutput: 'CSV with 3 columns',
            },
        ]);
    });

    it('issues no step write for a plan with no steps', async () => {
        await TestPlanRepository.create(asTx(db), ctx, 'c-1', { name: 'P', steps: [] });

        expect(db.controlTestStep.createMany).not.toHaveBeenCalled();
    });

    it('returns the plan row, not the step result', async () => {
        const res = await TestPlanRepository.create(asTx(db), ctx, 'c-1', {
            name: 'P',
            steps: [{ instruction: 'x' }],
        });

        expect(res).toEqual({ id: 'plan-1' });
    });
});

describe('TestPlanRepository.update', () => {
    it('writes only the keys present in the patch', async () => {
        // Break: `data: patch`. Every field absent from a partial PATCH
        // would be written as `undefined`; Prisma ignores undefined, but
        // the moment someone "fixes" that by spreading defaults, renaming
        // a plan would null its owner and reset its frequency.
        await TestPlanRepository.update(asTx(db), ctx, 'plan-1', { name: 'Renamed' });

        expect(argOf(db.controlTestPlan.update)).toEqual({
            where: { id: 'plan-1' },
            data: { name: 'Renamed' },
        });
    });

    it('treats an explicit null as a value to write, not as an omission', async () => {
        // Break: a truthiness guard instead of `!== undefined`. Clearing
        // a plan's owner or description would silently do nothing.
        await TestPlanRepository.update(asTx(db), ctx, 'plan-1', {
            description: null,
            ownerUserId: null,
        });

        expect(dataOf(db.controlTestPlan.update)).toEqual({
            description: null,
            ownerUserId: null,
        });
    });

    it('carries every supported field through when all are supplied', async () => {
        await TestPlanRepository.update(asTx(db), ctx, 'plan-1', {
            name: 'N',
            description: 'D',
            method: 'AUTOMATED',
            frequency: 'MONTHLY',
            ownerUserId: 'user-9',
            status: 'PAUSED',
            expectedEvidence: { artefacts: ['log'] },
        });

        expect(dataOf(db.controlTestPlan.update)).toEqual({
            name: 'N',
            description: 'D',
            method: 'AUTOMATED',
            frequency: 'MONTHLY',
            ownerUserId: 'user-9',
            status: 'PAUSED',
            expectedEvidence: { artefacts: ['log'] },
        });
    });

    it('issues an empty-data update for an empty patch rather than throwing', async () => {
        await TestPlanRepository.update(asTx(db), ctx, 'plan-1', {});

        expect(dataOf(db.controlTestPlan.update)).toEqual({});
    });

    it('addresses the row by primary key alone — the tenant gate is upstream', async () => {
        // Pinned deliberately. `control-test.ts::updateTestPlan` resolves
        // the plan through the tenant-scoped `getById` first, and the call
        // runs inside `runInTenantContext` so RLS binds the tenant at the
        // DB. Any new caller that skips BOTH of those turns this into a
        // cross-tenant write.
        await TestPlanRepository.update(asTx(db), ctx, 'plan-1', { name: 'N' });

        expect(whereOf(db.controlTestPlan.update)).toEqual({ id: 'plan-1' });
    });
});

describe('TestPlanRepository.updateNextDueAt', () => {
    it('writes the recomputed due date', async () => {
        const due = new Date('2026-04-01T00:00:00.000Z');

        await TestPlanRepository.updateNextDueAt(asTx(db), ctx, 'plan-1', due);

        expect(argOf(db.controlTestPlan.update)).toEqual({
            where: { id: 'plan-1' },
            data: { nextDueAt: due },
        });
    });

    it('clears the due date for an ad-hoc plan', async () => {
        // Break: skipping the write when the value is null. Switching a
        // QUARTERLY plan to AD_HOC would leave the old due date in place,
        // so the plan stays permanently overdue on the dashboard.
        await TestPlanRepository.updateNextDueAt(asTx(db), ctx, 'plan-1', null);

        expect(dataOf(db.controlTestPlan.update)).toEqual({ nextDueAt: null });
    });
});
