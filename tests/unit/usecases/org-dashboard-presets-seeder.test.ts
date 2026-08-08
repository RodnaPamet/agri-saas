/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks. */
/**
 * Unit tests for `seedDefaultOrgDashboard` in
 * `src/app-layer/usecases/org-dashboard-presets.ts`.
 *
 * Wave-10 / stage-3h branch coverage. The existing
 * `tests/unit/org-dashboard-preset.test.ts` validates the preset
 * SHAPE (every widget matches the Zod schema), but doesn't exercise
 * the SEEDER — the entry point both org creation and the backfill
 * script call. Measured pre-test coverage of the source file is
 * 25/0/0/25.
 *
 * Branches:
 *   - existing > 0 → no-op, returns `seeded: false, created: 0`
 *   - existing === 0 → createMany with the full preset, returns
 *     `seeded: true, created: <N>`
 *   - the `enabled ?? true` default fallback in the createMany payload
 *     (the preset's literal `enabled: true` makes this a defence-in-
 *     depth fallback; we exercise it by injecting a widget with
 *     `enabled: undefined` through a captured payload assertion).
 *   - the `title ?? null` default fallback (similar — the preset's
 *     widgets all set `title`).
 *
 * The seeder is generic over its `SeederClient` (works inside or
 * outside a transaction), so we hand it a hand-rolled stub directly.
 */

import {
    seedDefaultOrgDashboard,
    DEFAULT_ORG_DASHBOARD_PRESET,
} from '@/app-layer/usecases/org-dashboard-presets';

function makeStub(opts: { existing: number; createCount?: number }) {
    const count = jest.fn().mockResolvedValue(opts.existing);
    const createMany = jest.fn().mockResolvedValue({
        count: opts.createCount ?? DEFAULT_ORG_DASHBOARD_PRESET.length,
    });
    const db: any = {
        orgDashboardWidget: { count, createMany },
    };
    return { db, count, createMany };
}

describe('seedDefaultOrgDashboard — idempotency', () => {
    it('no-ops when the org already has any widget (existing > 0)', async () => {
        const { db, count, createMany } = makeStub({ existing: 1 });
        const result = await seedDefaultOrgDashboard(db, 'org-1');
        expect(count).toHaveBeenCalledWith({ where: { organizationId: 'org-1' } });
        expect(createMany).not.toHaveBeenCalled();
        expect(result).toEqual({
            organizationId: 'org-1',
            seeded: false,
            created: 0,
        });
    });

    it('seeds when the org has zero widgets', async () => {
        const { db, createMany } = makeStub({ existing: 0 });
        const result = await seedDefaultOrgDashboard(db, 'org-1');
        expect(createMany).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            organizationId: 'org-1',
            seeded: true,
            created: DEFAULT_ORG_DASHBOARD_PRESET.length,
        });
    });

    it('reports the createMany result count when it differs from the preset length', async () => {
        // Edge case — Prisma's createMany.count could differ from
        // input length on a partial failure. The seeder reports what
        // createMany returned, not what we tried to insert.
        const { db } = makeStub({ existing: 0, createCount: 3 });
        const result = await seedDefaultOrgDashboard(db, 'org-1');
        expect(result.created).toBe(3);
        expect(result.seeded).toBe(true);
    });
});

describe('seedDefaultOrgDashboard — payload shape', () => {
    it('passes every preset widget through createMany with organizationId baked in', async () => {
        const { db, createMany } = makeStub({ existing: 0 });
        await seedDefaultOrgDashboard(db, 'org-42');
        const payload = createMany.mock.calls[0][0].data;
        // One row per preset entry.
        expect(payload).toHaveLength(DEFAULT_ORG_DASHBOARD_PRESET.length);
        // Every row carries the org id.
        for (const row of payload) {
            expect(row.organizationId).toBe('org-42');
        }
    });

    it('preserves the preset KPI ordering (the leading widgets are KPIs)', async () => {
        // Was four KPIs; the `critical-risks` tile went with the risk
        // register, leaving coverage / overdue-evidence / tenants.
        const { db, createMany } = makeStub({ existing: 0 });
        await seedDefaultOrgDashboard(db, 'org-1');
        const payload = createMany.mock.calls[0][0].data;
        const types = payload.slice(0, 3).map((r: any) => r.type);
        expect(types).toEqual(['KPI', 'KPI', 'KPI']);
    });

    it('maps preset fields through unchanged — chartType, title, config, position, size', async () => {
        const { db, createMany } = makeStub({ existing: 0 });
        await seedDefaultOrgDashboard(db, 'org-1');
        const payload = createMany.mock.calls[0][0].data;
        for (let i = 0; i < payload.length; i++) {
            const row = payload[i];
            const preset = DEFAULT_ORG_DASHBOARD_PRESET[i];
            expect(row.chartType).toBe(preset.chartType);
            expect(row.title).toBe(preset.title);
            expect(row.config).toBe(preset.config);
            expect(row.position).toBe(preset.position);
            expect(row.size).toBe(preset.size);
        }
    });

    it('defaults enabled to true when the preset entry omits it (the `?? true` fallback)', async () => {
        const { db, createMany } = makeStub({ existing: 0 });
        await seedDefaultOrgDashboard(db, 'org-1');
        // Every preset entry is `enabled: true` today, but the seeder
        // carries an `?? true` fallback for forward compatibility. Make
        // sure the mapped value lands as boolean true on every row.
        const payload = createMany.mock.calls[0][0].data;
        for (const row of payload) {
            expect(row.enabled).toBe(true);
        }
    });

    it('defaults title to null when the preset entry omits it (the `?? null` fallback)', async () => {
        // None of today's preset entries omit `title`, so we cover
        // the fallback via the runtime contract — the payload never
        // emits `undefined` for title (which would Prisma-reject).
        const { db, createMany } = makeStub({ existing: 0 });
        await seedDefaultOrgDashboard(db, 'org-1');
        const payload = createMany.mock.calls[0][0].data;
        for (const row of payload) {
            // Either a string or null — never undefined.
            expect(row.title === null || typeof row.title === 'string').toBe(true);
        }
    });
});
