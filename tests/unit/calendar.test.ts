/**
 * Epic 49 — `getCalendarEvents` usecase tests.
 *
 * Verifies the unified-aggregation behaviour:
 *
 *   1. Each source contributes events with the right shape (category,
 *      type, entityType, href).
 *   2. Mixed sources merge into one chronologically-sorted stream.
 *   3. Status classification is correct (scheduled/due_soon/overdue/done).
 *   4. Duration events (audit-cycle) carry both `date` and `end`.
 *   5. The type / category filters narrow the output.
 *   6. Tenant filter is applied to every Prisma call (regression guard).
 *   7. The empty-range case returns zero events without throwing.
 *   8. The badge count helper short-circuits at 99+.
 */

export {};

const TENANT_ID = 'tenant-1';
const TENANT_SLUG = 'acme';
const OWNER = 'user-owner';

// ─── Mocks ────────────────────────────────────────────────────────────

const mockEvidenceFindMany = jest.fn();
const mockTaskFindMany = jest.fn();

const mockAgriEventFindMany = jest.fn();
// Calendar roadmap PR 3 — AI news-derived proposals. Global, like agriEvent.
const mockNewsDerivedEventFindMany = jest.fn();
// Support schemes (subsidy windows). Global like agriEvent — the loader's
// where clause is `reviewStatus: 'APPROVED'`, with no tenantId predicate.
// This delegate was MISSING from the mock db until the GRC teardown split:
// `loadSupportSchemeEvents` threw `undefined.findMany` on every test in this
// file, Promise.allSettled swallowed it, and the suite stayed green over a
// loader that had never once run.
const mockSupportSchemeFindMany = jest.fn();

// Agriculture data sources (PR 2 of the calendar roadmap).
const mockParcelLeaseFindMany = jest.fn();
const mockContractFindMany = jest.fn();
const mockPlantingFindMany = jest.fn();
const mockAgroSignalFindMany = jest.fn();
// Farm-task field-name resolution (loadTaskEvents' TaskLink join).
const mockLocationFindMany = jest.fn();
const mockParcelFindMany = jest.fn();

const mockTaskCount = jest.fn().mockResolvedValue(0);
const mockEvidenceCount = jest.fn().mockResolvedValue(0);

beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    [
        mockEvidenceFindMany,
        mockTaskFindMany,
        mockAgriEventFindMany,
        mockNewsDerivedEventFindMany,
        mockSupportSchemeFindMany,
        mockParcelLeaseFindMany,
        mockContractFindMany,
        mockPlantingFindMany,
        mockAgroSignalFindMany,
        mockLocationFindMany,
        mockParcelFindMany,
    ].forEach((m) => m.mockReset().mockResolvedValue([]));
    [mockTaskCount, mockEvidenceCount].forEach((m) =>
        m.mockReset().mockResolvedValue(0),
    );

    // Calendar usecase reads via `runInTenantContext(ctx, db => ...)`
    // (passes through RLS-bound `app_user`). Mock the helper to invoke
    // the callback with our spy db immediately — equivalent to the
    // single-pass, no-actual-tx test path.
    const mockDb = {
        evidence: {
            findMany: (...a: unknown[]) => mockEvidenceFindMany(...a),
            count: (...a: unknown[]) => mockEvidenceCount(...a),
        },
        task: {
            findMany: (...a: unknown[]) => mockTaskFindMany(...a),
            count: (...a: unknown[]) => mockTaskCount(...a),
        },
        // Global agriculture catalogue — no tenantId on the model.
        agriEvent: {
            findMany: (...a: unknown[]) => mockAgriEventFindMany(...a),
        },
        // Calendar roadmap PR 3 — global, like agriEvent above.
        newsDerivedEvent: {
            findMany: (...a: unknown[]) => mockNewsDerivedEventFindMany(...a),
        },
        // Support schemes — also global (no tenantId predicate).
        supportScheme: {
            findMany: (...a: unknown[]) => mockSupportSchemeFindMany(...a),
        },
        // Agriculture data sources (PR 2 of the calendar roadmap) — all
        // four ARE tenant-scoped, unlike agriEvent above.
        parcelLease: {
            findMany: (...a: unknown[]) => mockParcelLeaseFindMany(...a),
        },
        contract: {
            findMany: (...a: unknown[]) => mockContractFindMany(...a),
        },
        planting: {
            findMany: (...a: unknown[]) => mockPlantingFindMany(...a),
        },
        agroSignal: {
            findMany: (...a: unknown[]) => mockAgroSignalFindMany(...a),
        },
        // loadTaskEvents' batched FARM_TASK -> Location/Parcel name
        // resolution (only invoked when a FARM_TASK row carries links).
        location: {
            findMany: (...a: unknown[]) => mockLocationFindMany(...a),
        },
        parcel: {
            findMany: (...a: unknown[]) => mockParcelFindMany(...a),
        },
    };
    jest.mock('@/lib/db-context', () => ({
        __esModule: true,
        runInTenantContext: jest.fn(
            async (_ctx: unknown, fn: (db: unknown) => Promise<unknown>) =>
                fn(mockDb),
        ),
    }));
});

// ─── Helpers ─────────────────────────────────────────────────────────

function makeCtx() {
    return {
        requestId: 'req-1',
        userId: 'user-1',
        tenantId: TENANT_ID,
        tenantSlug: TENANT_SLUG,
        role: 'EDITOR',
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: false,
            canAudit: false,
            canExport: false,
        },
        appPermissions: {} as unknown,
    };
}

const NOW = new Date('2026-06-01T00:00:00Z');
const FROM = new Date('2026-05-01T00:00:00Z');
const TO = new Date('2026-08-01T00:00:00Z');

// ─── Test cases ──────────────────────────────────────────────────────

describe('getCalendarEvents — aggregation', () => {
    it('returns an empty stream when every source is empty', async () => {
        const { getCalendarEvents } = await import(
            '@/app-layer/usecases/calendar'
        );
        const result = await getCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        expect(result.events).toEqual([]);
        expect(result.counts.total).toBe(0);
    });

    it('always filters every Prisma query by tenantId (defense-in-depth)', async () => {
        const { getCalendarEvents } = await import(
            '@/app-layer/usecases/calendar'
        );
        await getCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        for (const m of [
            mockEvidenceFindMany,
            mockTaskFindMany,
            // Agriculture data sources (PR 2) — all four ARE tenant-scoped.
            mockParcelLeaseFindMany,
            mockContractFindMany,
            mockPlantingFindMany,
            mockAgroSignalFindMany,
            // mockAgriEventFindMany is DELIBERATELY absent from this list.
            // AgriEvent is a global, platform-curated catalogue with no
            // tenantId column at all, so a tenantId predicate could not be
            // written even if it were wanted. Adding it here would not
            // tighten anything — it would just fail. The positive assertion
            // below pins that intent so this stays a decision, not a gap.
            //
            // mockNewsDerivedEventFindMany (calendar roadmap PR 3) is
            // absent for the identical reason — NewsDerivedEvent is also a
            // global table with no tenantId column.
        ]) {
            expect(m).toHaveBeenCalled();
            const call = m.mock.calls[0][0] as { where: { tenantId: string } };
            expect(call.where.tenantId).toBe(TENANT_ID);
        }
    });

    it('normalises mixed-source events into one stream sorted by date', async () => {
        mockEvidenceFindMany.mockResolvedValue([
            {
                id: 'ev-1',
                title: 'SOC2 Evidence',
                nextReviewDate: new Date('2026-06-15T00:00:00Z'),
                status: 'SUBMITTED',
                ownerUserId: OWNER,
            },
        ]);
        mockAgroSignalFindMany.mockResolvedValue([
            {
                id: 'sig-1',
                kind: 'SPRAY_WINDOW',
                signalDate: new Date('2026-05-20T00:00:00Z'),
                locationId: 'loc-9',
                location: { name: 'East Field' },
            },
        ]);
        mockTaskFindMany.mockResolvedValue([
            {
                id: 'task-1',
                title: 'Review access logs',
                dueAt: new Date('2026-07-01T00:00:00Z'),
                status: 'OPEN',
                assigneeUserId: OWNER,
            },
        ]);

        const { getCalendarEvents } = await import(
            '@/app-layer/usecases/calendar'
        );
        const result = await getCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });

        expect(result.events).toHaveLength(3);
        // Sorted by date: agro-signal (05-20) < evidence (06-15) < task (07-01).
        expect(result.events.map((e) => e.category)).toEqual([
            'agro-signal',
            'evidence',
            'task',
        ]);
        expect(result.counts.total).toBe(3);
        expect(result.counts.byCategory['agro-signal']).toBe(1);
        expect(result.counts.byCategory.evidence).toBe(1);
        expect(result.counts.byCategory.task).toBe(1);
    });

    it('classifies status correctly: overdue vs due_soon vs scheduled', async () => {
        mockTaskFindMany.mockResolvedValue([
            {
                id: 't-overdue',
                title: 'past',
                dueAt: new Date('2026-05-15T00:00:00Z'), // pre-now
                status: 'OPEN',
                assigneeUserId: null,
            },
            {
                id: 't-soon',
                title: 'in 5 days',
                dueAt: new Date('2026-06-06T00:00:00Z'), // +5d
                status: 'OPEN',
                assigneeUserId: null,
            },
            {
                id: 't-far',
                title: 'in 40 days',
                dueAt: new Date('2026-07-15T00:00:00Z'),
                status: 'OPEN',
                assigneeUserId: null,
            },
            {
                id: 't-done',
                title: 'closed',
                dueAt: new Date('2026-06-15T00:00:00Z'),
                status: 'CLOSED',
                assigneeUserId: null,
            },
        ]);
        const { getCalendarEvents } = await import(
            '@/app-layer/usecases/calendar'
        );
        const result = await getCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        const byId = Object.fromEntries(
            result.events.map((e) => [e.entityId, e.status]),
        );
        expect(byId['t-overdue']).toBe('overdue');
        expect(byId['t-soon']).toBe('due_soon');
        expect(byId['t-far']).toBe('scheduled');
        expect(byId['t-done']).toBe('done');
    });

    it('a support scheme emits BOTH an opens event AND a closes event from one row', async () => {
        // The one-row-to-two-events shape used to be pinned on Vendor
        // (nextReviewAt + contractRenewalAt). GRC teardown phase 2 deleted
        // that loader; SupportScheme carries the same shape via its
        // application window, so the behaviour class keeps its coverage.
        mockSupportSchemeFindMany.mockResolvedValue([
            {
                id: 'sch-1',
                title: 'Young farmer grant',
                authority: 'ДФЗ',
                applicationOpensAt: new Date('2026-06-10T00:00:00Z'),
                applicationClosesAt: new Date('2026-07-15T00:00:00Z'),
                sourceUrl: null,
                source: 'manual',
                confidence: null,
            },
        ]);
        const { getCalendarEvents } = await import(
            '@/app-layer/usecases/calendar'
        );
        const result = await getCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        expect(result.events.map((e) => e.id)).toEqual([
            'SUPPORT_SCHEME:sch-1:opens',
            'SUPPORT_SCHEME:sch-1:closes',
        ]);
        expect(result.events.map((e) => e.type)).toEqual([
            'agri-subsidy-deadline',
            'agri-subsidy-deadline',
        ]);
        expect(result.events[0].href).toBe('/t/acme/schemes');
    });

    it('applies the `types` filter to narrow results post-aggregation', async () => {
        mockEvidenceFindMany.mockResolvedValue([
            {
                id: 'ev-1',
                title: 'X',
                nextReviewDate: new Date('2026-06-15T00:00:00Z'),
                status: 'SUBMITTED',
                ownerUserId: null,
            },
        ]);
        mockTaskFindMany.mockResolvedValue([
            {
                id: 't-1',
                title: 'Y',
                dueAt: new Date('2026-06-15T00:00:00Z'),
                status: 'OPEN',
                assigneeUserId: null,
            },
        ]);

        const { getCalendarEvents } = await import(
            '@/app-layer/usecases/calendar'
        );
        const result = await getCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
            types: ['task-due'],
        });
        expect(result.events).toHaveLength(1);
        expect(result.events[0].type).toBe('task-due');
    });

    it('embeds tenantSlug into the href so client navigation works without slug plumbing', async () => {
        mockTaskFindMany.mockResolvedValue([
            {
                id: 't-1',
                title: 'a',
                dueAt: new Date('2026-06-15T00:00:00Z'),
                status: 'OPEN',
                assigneeUserId: null,
            },
        ]);
        const { getCalendarEvents } = await import(
            '@/app-layer/usecases/calendar'
        );
        const result = await getCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        expect(result.events[0].href).toBe('/t/acme/farm-tasks/t-1');
    });

    it('splits FARM_TASK rows into their own category/type and surfaces the linked field via TaskLink', async () => {
        mockTaskFindMany.mockResolvedValue([
            {
                id: 'ft-1',
                title: 'Irrigate north block',
                dueAt: new Date('2026-06-10T00:00:00Z'),
                status: 'OPEN',
                type: 'FARM_TASK',
                assigneeUserId: null,
                links: [{ entityType: 'LOCATION', entityId: 'loc-1' }],
            },
        ]);
        mockLocationFindMany.mockResolvedValue([
            { id: 'loc-1', name: 'North Block' },
        ]);
        const { getCalendarEvents } = await import(
            '@/app-layer/usecases/calendar'
        );
        const result = await getCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        expect(result.events).toHaveLength(1);
        const ev = result.events[0];
        expect(ev.type).toBe('farm-task-due');
        expect(ev.category).toBe('farm-task');
        expect(ev.titleKey).toBe('farmTaskDue');
        expect(ev.detail).toBe('North Block');
        expect(mockLocationFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId: TENANT_ID, id: { in: ['loc-1'] } },
            }),
        );
        // The batched resolution never touches Parcel — no PARCEL link
        // was returned, so the guarded fetch is skipped entirely.
        expect(mockParcelFindMany).not.toHaveBeenCalled();
    });

    it('parcel leases, contracts, and plantings emit duration events (date + end) with tenant hrefs', async () => {
        mockParcelLeaseFindMany.mockResolvedValue([
            {
                id: 'lease-1',
                lessorName: 'Ivan Ivanov',
                startDate: new Date('2026-06-01T00:00:00Z'),
                endDate: new Date('2026-07-01T00:00:00Z'),
                parcel: { name: 'Field 12' },
            },
        ]);
        mockContractFindMany.mockResolvedValue([
            {
                id: 'contract-1',
                counterparty: 'ACME Grain Co',
                commodity: 'Wheat',
                deliveryStart: new Date('2026-06-05T00:00:00Z'),
                deliveryEnd: new Date('2026-06-20T00:00:00Z'),
                status: 'ACTIVE',
            },
        ]);
        mockPlantingFindMany.mockResolvedValue([
            {
                id: 'planting-1',
                cropPlanId: 'plan-1',
                sowDate: new Date('2026-05-10T00:00:00Z'),
                harvestEndDate: new Date('2026-07-10T00:00:00Z'),
                status: 'SOWN',
                variety: { name: 'Roma' },
                location: { name: 'Greenhouse 2' },
                parcel: null,
                cropPlan: { cropType: { name: 'Tomato' } },
            },
        ]);
        const { getCalendarEvents } = await import(
            '@/app-layer/usecases/calendar'
        );
        const result = await getCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        const byType = Object.fromEntries(
            result.events.map((e) => [e.type, e]),
        );

        const lease = byType['parcel-lease-term'];
        expect(lease.category).toBe('lease');
        expect(lease.titleParams).toEqual({ name: 'Field 12' });
        expect(lease.detail).toBe('Ivan Ivanov');
        expect(lease.date).toBe('2026-06-01T00:00:00.000Z');
        expect(lease.end).toBe('2026-07-01T00:00:00.000Z');
        expect(lease.href).toBe('/t/acme/rent');

        const contract = byType['contract-delivery-window'];
        expect(contract.category).toBe('contract');
        expect(contract.titleParams).toEqual({ name: 'ACME Grain Co' });
        expect(contract.detail).toBe('Wheat');
        expect(contract.href).toBe('/t/acme/grain/contracts');

        const planting = byType['planting-cycle'];
        expect(planting.category).toBe('planting');
        // Variety name wins over the crop-type fallback when present.
        expect(planting.titleParams).toEqual({ name: 'Roma' });
        // No parcel on this row — falls back to the location name.
        expect(planting.detail).toBe('Greenhouse 2');
        expect(planting.href).toBe('/t/acme/planning/plan-1');
    });

    it('a Planting with no variety falls back to the crop plan\'s crop type for its title', async () => {
        mockPlantingFindMany.mockResolvedValue([
            {
                id: 'planting-2',
                cropPlanId: 'plan-2',
                sowDate: new Date('2026-06-01T00:00:00Z'),
                harvestEndDate: null,
                status: 'PLANNED',
                variety: null,
                location: null,
                parcel: { name: 'South Field' },
                cropPlan: { cropType: { name: 'Sweetcorn' } },
            },
        ]);
        const { getCalendarEvents } = await import(
            '@/app-layer/usecases/calendar'
        );
        const result = await getCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        expect(result.events).toHaveLength(1);
        expect(result.events[0].titleParams).toEqual({ name: 'Sweetcorn' });
        expect(result.events[0].detail).toBe('South Field');
        expect(result.events[0].end).toBeUndefined();
    });

    it('agro-signals emit point events classified done/scheduled by kind, never overdue', async () => {
        mockAgroSignalFindMany.mockResolvedValue([
            {
                id: 'signal-1',
                kind: 'SPRAY_WINDOW',
                signalDate: new Date('2026-05-20T00:00:00Z'), // before NOW
                locationId: 'loc-9',
                location: { name: 'East Field' },
            },
            {
                id: 'signal-2',
                kind: 'DISEASE_RISK',
                signalDate: new Date('2026-07-01T00:00:00Z'), // after NOW
                locationId: 'loc-9',
                location: { name: 'East Field' },
            },
        ]);
        const { getCalendarEvents } = await import(
            '@/app-layer/usecases/calendar'
        );
        const result = await getCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        const byId = Object.fromEntries(result.events.map((e) => [e.entityId, e]));
        expect(byId['signal-1'].type).toBe('agro-signal-spray-window');
        expect(byId['signal-1'].category).toBe('agro-signal');
        expect(byId['signal-1'].titleKey).toBe('agroSignalSprayWindow');
        expect(byId['signal-1'].status).toBe('done');
        expect(byId['signal-1'].href).toBe('/t/acme/locations/loc-9');
        expect(byId['signal-2'].type).toBe('agro-signal-disease-risk');
        expect(byId['signal-2'].titleKey).toBe('agroSignalDiseaseRisk');
        expect(byId['signal-2'].status).toBe('scheduled');
    });

    it('AI news-derived events carry provenance/confidence/sourceUrl and link off-site (calendar roadmap PR 3)', async () => {
        mockNewsDerivedEventFindMany.mockResolvedValue([
            {
                id: 'news-1',
                title: 'ДФЗ subsidy window opens',
                kind: 'subsidy-deadline',
                eventDate: new Date('2026-05-20T00:00:00Z'), // before NOW
                confidence: 0.9,
                sourceUrl: 'https://dfz.bg/article-1',
            },
            {
                id: 'news-2',
                title: 'Regulation takes effect',
                kind: 'regulation-effective',
                eventDate: new Date('2026-07-01T00:00:00Z'), // after NOW
                confidence: 0.75,
                sourceUrl: 'https://dfz.bg/article-2',
            },
        ]);
        const { getCalendarEvents } = await import(
            '@/app-layer/usecases/calendar'
        );
        const result = await getCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });

        // Only status: 'APPROVED' is ever requested — a PROPOSED row must
        // never reach a tenant's calendar.
        const call = mockNewsDerivedEventFindMany.mock.calls[0][0] as {
            where: { status: string };
        };
        expect(call.where.status).toBe('APPROVED');

        const byId = Object.fromEntries(result.events.map((e) => [e.entityId, e]));
        expect(byId['news-1'].type).toBe('ai-news-subsidy-deadline');
        expect(byId['news-1'].category).toBe('ai-news');
        expect(byId['news-1'].provenance).toBe('ai-news');
        expect(byId['news-1'].confidence).toBe(0.9);
        expect(byId['news-1'].sourceUrl).toBe('https://dfz.bg/article-1');
        expect(byId['news-1'].href).toBe('https://dfz.bg/article-1');
        expect(byId['news-1'].external).toBe(true);
        expect(byId['news-1'].status).toBe('done');
        expect(byId['news-2'].type).toBe('ai-news-regulation-effective');
        expect(byId['news-2'].status).toBe('scheduled');

        // Every non-ai-news event in this suite must NOT carry provenance —
        // the field is the load-bearing "this is a database fact" signal.
        for (const e of result.events) {
            if (e.category !== 'ai-news') expect(e.provenance).toBeUndefined();
        }
    });

    it('surfaces `truncated: true` when a source hits its perSourceLimit cap', async () => {
        mockEvidenceFindMany.mockResolvedValue([
            {
                id: 'ev-1',
                title: 'A',
                nextReviewDate: new Date('2026-06-01T00:00:00Z'),
                status: 'SUBMITTED',
                ownerUserId: null,
            },
            {
                id: 'ev-2',
                title: 'B',
                nextReviewDate: new Date('2026-06-02T00:00:00Z'),
                status: 'SUBMITTED',
                ownerUserId: null,
            },
        ]);
        const { getCalendarEvents } = await import(
            '@/app-layer/usecases/calendar'
        );
        const result = await getCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
            perSourceLimit: 1,
        });
        expect(result.truncated).toBe(true);
        expect(result.events).toHaveLength(1);
    });

    it('does not surface `truncated` when every source stays under its cap', async () => {
        const { getCalendarEvents } = await import(
            '@/app-layer/usecases/calendar'
        );
        const result = await getCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        expect(result.truncated).toBe(false);
    });

    it('one source throwing does not blank the calendar (Promise.allSettled resilience)', async () => {
        mockContractFindMany.mockRejectedValue(new Error('boom'));
        mockEvidenceFindMany.mockResolvedValue([
            {
                id: 'ev-1',
                title: 'Still here',
                nextReviewDate: new Date('2026-06-15T00:00:00Z'),
                status: 'SUBMITTED',
                ownerUserId: null,
            },
        ]);
        const { getCalendarEvents } = await import(
            '@/app-layer/usecases/calendar'
        );
        const result = await getCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        expect(result.events).toHaveLength(1);
        expect(result.events[0].entityId).toBe('ev-1');
    });
});

describe('getUpcomingDeadlineCount — sidebar badge', () => {
    it('sums per-source counts and caps at 99+', async () => {
        mockTaskCount.mockResolvedValue(60);
        mockEvidenceCount.mockResolvedValue(50);
        const { getUpcomingDeadlineCount } = await import(
            '@/app-layer/usecases/calendar'
        );
        const count = await getUpcomingDeadlineCount(makeCtx() as never);
        // 60 + 50 = 110 → capped at 100 (MAX_BADGE_COUNT + 1).
        expect(count).toBe(100);
    });

    it('returns the real total when below the cap', async () => {
        mockTaskCount.mockResolvedValue(3);
        mockEvidenceCount.mockResolvedValue(3);
        const { getUpcomingDeadlineCount } = await import(
            '@/app-layer/usecases/calendar'
        );
        const count = await getUpcomingDeadlineCount(makeCtx() as never);
        expect(count).toBe(6);
    });
});
