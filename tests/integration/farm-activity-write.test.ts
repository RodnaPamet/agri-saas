/**
 * «Нов запис» for a bare activity, end to end — #2316 / agrent-ios #439.
 *
 * DB-backed because the things worth proving are not in the Prisma schema: the
 * all-or-nothing CHECK, the partial unique index, and whether the completion
 * marks suppress the stock deduction as #1740 ruled.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { recordFarmActivity } from '@/app-layer/usecases/farm-activity';
import { listLogEntries } from '@/app-layer/usecases/journal';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `fa-${randomUUID().slice(0, 8)}`;
let userId = '';
let kgUnitId = '';
let tenantId = '';
let locA = '';
let locB = '';
let parcelA1 = '';
let parcelA2 = '';
let parcelB1 = '';

const ctx = () => makeRequestContext('OWNER', { userId, tenantId, tenantSlug: `${TAG}-t` });

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await globalPrisma.$connect();
    const email = `${TAG}@ag.test`;
    const user = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email), name: 'Activity User' },
    });
    userId = user.id;
    // `Unit.key` is globally unique, so reuse the catalogue row if it exists.
    kgUnitId =
        (await globalPrisma.unit.findFirst({ where: { key: 'kg' }, select: { id: true } }))?.id ??
        (await globalPrisma.unit.create({
            data: { key: 'kg', name: 'Kilogram', symbol: 'kg', measure: 'WEIGHT' },
            select: { id: true },
        })).id;
    const tenant = await globalPrisma.tenant.create({ data: { name: `T ${TAG}`, slug: `${TAG}-t` } });
    tenantId = tenant.id;
    await globalPrisma.tenantMembership.create({
        data: { tenantId, userId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    const a = await globalPrisma.location.create({ data: { tenantId, name: `Block A ${TAG}` } });
    const b = await globalPrisma.location.create({ data: { tenantId, name: `Block B ${TAG}` } });
    locA = a.id;
    locB = b.id;
    parcelA1 = (await globalPrisma.parcel.create({ data: { tenantId, locationId: locA, name: `A1 ${TAG}`, areaHa: 8 } })).id;
    parcelA2 = (await globalPrisma.parcel.create({ data: { tenantId, locationId: locA, name: `A2 ${TAG}`, areaHa: 4 } })).id;
    parcelB1 = (await globalPrisma.parcel.create({ data: { tenantId, locationId: locB, name: `B1 ${TAG}`, areaHa: 5 } })).id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        for (const t of ['LogQuantity', 'LogEntry', 'OperationParcel', 'TaskLink', 'Task', 'TreatmentGroup', 'Parcel', 'Location', 'TenantMembership']) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        }
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId);
    } catch (e) {
        console.warn('[farm-activity-write] cleanup error:', e);
    }
    await globalPrisma.$disconnect();
});

const yesterday = () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
};

describeFn('recordFarmActivity (#2316)', () => {
    it('writes one task PER BLOCK and completes every line', async () => {
        const r = await recordFarmActivity(
            ctx(),
            { kind: 'PRUNE', occurredOn: yesterday(), parcelIds: [parcelA1, parcelA2, parcelB1] },
            `${TAG}-prune`,
        );
        // Two blocks, three parcels. One task per BLOCK is the whole reason the
        // grouping exists: the ДНЕВНИК resolves a block through the task's
        // location link.
        expect({ tasks: r.tasks, lines: r.lines }).toEqual({ tasks: 2, lines: 3 });
        expect(r.treatmentGroupId).toBe(`${TAG}-prune`);

        const lines = await globalPrisma.operationParcel.findMany({
            where: { tenantId, task: { treatmentGroupId: r.treatmentGroupId } },
            select: { status: true, productItemId: true, doseValue: true, doseUnitId: true },
        });
        expect(lines).toHaveLength(3);
        for (const l of lines) {
            expect(l.status).toBe('DONE');
            expect({ p: l.productItemId, v: l.doseValue, u: l.doseUnitId }).toEqual({ p: null, v: null, u: null });
        }
    });

    it('moves NO stock — the #1740 ruling, not an accident', async () => {
        // The completion marks pass `recordedInDiary`, which suppresses the
        // deduction. Asserted because it is a ruling rather than a side effect:
        // a future change that stopped passing the flag would start moving
        // stock for an activity that consumed nothing.
        const moved = await globalPrisma.stockTransaction.count({ where: { tenantId } });
        expect(moved).toBe(0);
    });

    it('a replay with the same key adds nothing', async () => {
        const again = await recordFarmActivity(
            ctx(),
            { kind: 'PRUNE', occurredOn: yesterday(), parcelIds: [parcelA1, parcelA2, parcelB1] },
            `${TAG}-prune`,
        );
        expect(again.treatmentGroupId).toBe(`${TAG}-prune`);
        // Already DONE, so nothing remained PENDING to mark.
        expect(again.lines).toBe(0);
        const total = await globalPrisma.operationParcel.count({
            where: { tenantId, task: { treatmentGroupId: `${TAG}-prune` } },
        });
        expect(total).toBe(3);
    });

    it('a harvest writes ONE labelled LogQuantity in kg, not one per parcel', async () => {
        const r = await recordFarmActivity(
            ctx(),
            { kind: 'HARVEST', occurredOn: yesterday(), parcelIds: [parcelA1, parcelA2], harvestKg: 12400 },
            `${TAG}-harvest`,
        );
        expect(r.lines).toBe(2);
        expect(r.harvestQuantityId).not.toBeNull();

        const qs = await globalPrisma.logQuantity.findMany({
            where: { tenantId, logEntry: { operationParcel: { task: { treatmentGroupId: `${TAG}-harvest` } } } },
            select: { value: true, unitId: true, measure: true, label: true },
        });
        // ONE row for two parcels — the owner's ruling. Apportioning would have
        // written figures nobody measured into a signed document.
        expect(qs).toHaveLength(1);
        expect(Number(qs[0].value)).toBe(12400);
        expect(qs[0].unitId).toBe(kgUnitId);
        expect(qs[0].measure).toBe('WEIGHT');
        // The label is the only thing stopping a reader taking this for that
        // one parcel's yield.
        expect(qs[0].label).toBe('Общо за мероприятието');
    });

    it('a harvest with no quantity records none, and says so', async () => {
        const r = await recordFarmActivity(
            ctx(),
            { kind: 'HARVEST', occurredOn: yesterday(), parcelIds: [parcelB1] },
            `${TAG}-harvest-noqty`,
        );
        expect(r.harvestQuantityId).toBeNull();
        const n = await globalPrisma.logQuantity.count({
            where: { tenantId, logEntry: { operationParcel: { task: { treatmentGroupId: `${TAG}-harvest-noqty` } } } },
        });
        expect(n).toBe(0);
    });

    it('the activity APPEARS in «Дневник» — the assertion whose absence let #2354 through', async () => {
        // Read through the real journal path, not by querying LogEntry: the
        // defect was that the READ showed nothing while every row the write
        // produced was correct. #2344's five cases asserted the OperationParcel
        // row exhaustively and never asked whether a farmer could see it, which
        // is the only thing the feature exists for.
        const entries = await listLogEntries(ctx());
        const mine = entries.filter(
            (e: { operationParcelId?: string | null; title?: string }) => e.operationParcelId != null,
        );
        // Three prunings + two harvest lines + one no-qty harvest + two
        // cultivations = eight completed lines over the suite so far.
        expect(mine.length).toBeGreaterThanOrEqual(3);

        const pruneRows = await globalPrisma.logEntry.findMany({
            where: { tenantId, operationParcel: { task: { treatmentGroupId: `${TAG}-prune` } } },
            select: { type: true, titleKey: true, title: true, recordedInDiary: true },
        });
        expect(pruneRows).toHaveLength(3);
        for (const r of pruneRows) {
            // ACTIVITY, not INPUT_APPLICATION — nothing was applied.
            expect(r.type).toBe('ACTIVITY');
            // Server-composed, so `isAutoGeneratedTitle` reports it correctly
            // and a reader is not shown a title a person never wrote.
            expect(r.titleKey).toBe('journal.autoTitle.farmActivity');
            expect(r.title).toContain('Резитба');
            // Visible in the manual-only list, which is where «Нов запис»
            // entries belong.
            expect(r.recordedInDiary).toBe(true);
        }

        const harvestRows = await globalPrisma.logEntry.findMany({
            where: { tenantId, operationParcel: { task: { treatmentGroupId: `${TAG}-harvest` } } },
            select: { type: true },
        });
        expect(harvestRows).toHaveLength(2);
        // HARVEST has its own LogEntryType, so the journal can tell a harvest
        // from a pruning without reading the task.
        for (const r of harvestRows) expect(r.type).toBe('HARVEST');
    });

    it('refuses a future day', async () => {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() + 3);
        await expect(
            recordFarmActivity(
                ctx(),
                { kind: 'CULTIVATE', occurredOn: d.toISOString().slice(0, 10), parcelIds: [parcelA1] },
                `${TAG}-future`,
            ),
        ).rejects.toThrow(/TREATMENT_DATE_IN_FUTURE|future date/i);
    });

    it('refuses an area larger than the parcel', async () => {
        await expect(
            recordFarmActivity(
                ctx(),
                {
                    kind: 'CULTIVATE',
                    occurredOn: yesterday(),
                    parcelIds: [parcelA2],
                    parcels: [{ parcelId: parcelA2, treatedAreaHa: 9 }], // parcel is 4 ha
                },
                `${TAG}-toobig`,
            ),
        ).rejects.toThrow(/TREATMENT_AREA_EXCEEDS_PARCEL|cannot exceed/i);
    });

    it('records a partial area on the line it belongs to', async () => {
        const r = await recordFarmActivity(
            ctx(),
            {
                kind: 'CULTIVATE',
                occurredOn: yesterday(),
                parcelIds: [parcelA1, parcelA2],
                parcels: [{ parcelId: parcelA1, treatedAreaHa: 3 }],
            },
            `${TAG}-partial`,
        );
        expect(r.lines).toBe(2);
        const lines = await globalPrisma.operationParcel.findMany({
            where: { tenantId, task: { treatmentGroupId: `${TAG}-partial` } },
            select: { parcelId: true, treatedAreaHa: true },
        });
        const byId = new Map(lines.map((l) => [l.parcelId, l.treatedAreaHa]));
        expect(Number(byId.get(parcelA1))).toBe(3);
        // NULL means the whole parcel, which is what the register has always
        // printed for a line with no stated area.
        expect(byId.get(parcelA2)).toBeNull();
    });
});
