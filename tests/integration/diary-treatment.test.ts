/**
 * Record a done treatment across blocks (DB-backed) — #1740 gap (2).
 *
 * The write behind the two-step diary entry. It composes existing machinery,
 * so what is worth asserting here is the composition rather than the parts:
 * the parts have their own suites.
 *
 * The properties, each a decision recorded elsewhere on #1740:
 *
 *   1. N blocks become N TASKS, each linking only its own block. The register
 *      joins Location -> taskLink -> DONE operationParcel, so a task spanning
 *      blocks would print a parcel's treatment under a block it was never on.
 *   2. Every task carries the same HANDLE, and the handle is the request's
 *      Idempotency-Key when one is sent.
 *   3. A replay returns the same handle and count and writes nothing new.
 *   4. The entries are flagged diary-recorded, so the manual-only list shows
 *      them, and dated by the treatment's own DAY rather than the save time.
 *   5. No stock deduction (owner ruling 2026-10-13).
 *   6. No assignment notification, because the assignee is the recorder.
 *   7. A parcel the tenant does not own is refused with the shared
 *      cross-tenant code, as a 400 rather than a 404.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { recordDiaryTreatment } from '@/app-layer/usecases/diary-treatment';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
const TAG = `dtreat-${randomUUID().slice(0, 8)}`;
/** Fixed, and firmly past, so the date assertions cannot drift into passing. */
const DAY = '2026-03-04';

let userId = '';
let unitId = '';
let tenantId = '';
let blockA = '';
let blockB = '';
let parcelA1 = '';
let parcelA2 = '';
let parcelB1 = '';
let itemId = '';
let otherTenantParcel = '';
let otherTenantId = '';

const ctx = () => makeRequestContext('OWNER', { userId, tenantId, tenantSlug: `${TAG}-t` });

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await globalPrisma.$connect();
    const email = `${TAG}@ag.test`;
    userId = (await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email), name: 'Diary Treat User' },
    })).id;
    unitId = (await globalPrisma.unit.create({
        data: { key: `l-ha-${TAG}`, name: 'L/ha', symbol: 'L/ha', measure: 'RATE' },
    })).id;
    const tenant = await globalPrisma.tenant.create({ data: { name: `T ${TAG}`, slug: `${TAG}-t` } });
    tenantId = tenant.id;
    await globalPrisma.tenantMembership.create({
        data: { tenantId, userId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });

    blockA = (await globalPrisma.location.create({ data: { tenantId, name: `Block A ${TAG}` } })).id;
    blockB = (await globalPrisma.location.create({ data: { tenantId, name: `Block B ${TAG}` } })).id;
    const mkParcel = async (locationId: string, name: string) =>
        (await globalPrisma.parcel.create({
            data: { tenantId, locationId, name, cropType: 'Wheat', areaHa: 10 },
        })).id;
    parcelA1 = await mkParcel(blockA, `A1 ${TAG}`);
    parcelA2 = await mkParcel(blockA, `A2 ${TAG}`);
    parcelB1 = await mkParcel(blockB, `B1 ${TAG}`);

    itemId = (await globalPrisma.item.create({
        data: { tenantId, name: `Prod ${TAG}`, category: 'PESTICIDE', defaultUnitId: unitId },
    })).id;
    // A lot, so a deduction is POSSIBLE and its absence is a suppression
    // rather than an empty shelf.
    await globalPrisma.inventoryLot.create({
        data: { tenantId, itemId, quantityOnHand: 500, unitId, lotCode: `LOT-${TAG}` },
    });

    // A second farm, for the cross-tenant refusal.
    const other = await globalPrisma.tenant.create({ data: { name: `O ${TAG}`, slug: `${TAG}-o` } });
    otherTenantId = other.id;
    const otherBlock = await globalPrisma.location.create({
        data: { tenantId: otherTenantId, name: `Other ${TAG}` },
    });
    otherTenantParcel = (await globalPrisma.parcel.create({
        data: { tenantId: otherTenantId, locationId: otherBlock.id, name: `X ${TAG}`, areaHa: 5 },
    })).id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        for (const t of [tenantId, otherTenantId]) {
            if (!t) continue;
            for (const tbl of ['StockTransaction', 'InventoryLot', 'LogQuantity', 'LogEntry', 'Notification', 'EmailOutbox', 'OperationParcel', 'TaskLink', 'Task', 'Item', 'Parcel', 'Location', 'AuditLog', 'AutomationExecution', 'TenantMembership']) {
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "${tbl}" WHERE "tenantId" = $1`, t).catch(() => {});
            }
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, t).catch(() => {});
        }
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Unit" WHERE "id" = $1`, unitId).catch(() => {});
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId).catch(() => {});
    } catch { /* best-effort */ }
    await globalPrisma.$disconnect();
});

const baseInput = () => ({
    kind: 'SPRAY' as const,
    occurredOn: DAY,
    parcelIds: [parcelA1, parcelA2, parcelB1],
    productItemId: itemId,
    doseValue: 2,
    doseUnitId: unitId,
    targetNote: 'Septoria',
    applicationTechnique: 'boom-sprayer',
});

describeFn('recordDiaryTreatment (DB-backed)', () => {
    const KEY = `idem-${TAG}`;
    let first: Awaited<ReturnType<typeof recordDiaryTreatment>>;

    it('becomes one task per block, each linking only its own', async () => {
        first = await recordDiaryTreatment(ctx(), baseInput(), KEY);

        expect(first.replayed).toBe(false);
        expect(first.parcelCount).toBe(3);
        expect(first.taskIds).toHaveLength(2);

        // The property the register depends on: each task links exactly ONE
        // block, and it is the block its own parcels sit in.
        for (const taskId of first.taskIds) {
            const links = await globalPrisma.taskLink.findMany({
                where: { tenantId, taskId, entityType: 'LOCATION' },
                select: { entityId: true },
            });
            expect(links).toHaveLength(1);

            const lines = await globalPrisma.operationParcel.findMany({
                where: { tenantId, taskId },
                select: { parcel: { select: { locationId: true } } },
            });
            expect(lines.length).toBeGreaterThan(0);
            for (const l of lines) {
                expect(l.parcel.locationId).toBe(links[0].entityId);
            }
        }
        // And between them they cover both blocks, so this is a cross-block
        // treatment rather than two parcels that happened to share one.
        const linked = await globalPrisma.taskLink.findMany({
            where: { tenantId, taskId: { in: first.taskIds }, entityType: 'LOCATION' },
            select: { entityId: true },
        });
        expect(new Set(linked.map((l) => l.entityId))).toEqual(new Set([blockA, blockB]));
    });

    it('stamps the same handle on every task, and it is the idempotency key', async () => {
        const tasks = await globalPrisma.task.findMany({
            where: { tenantId, id: { in: first.taskIds } },
            select: { treatmentGroupId: true },
        });
        expect(tasks).toHaveLength(2);
        expect(new Set(tasks.map((t) => t.treatmentGroupId))).toEqual(new Set([KEY]));
        // Returned too, so a client that lost the 200 can still address it.
        expect(first.treatmentGroupId).toBe(KEY);
    });

    it('completes every line and flags its entry as diary-recorded', async () => {
        const lines = await globalPrisma.operationParcel.findMany({
            where: { tenantId, taskId: { in: first.taskIds } },
            select: { id: true, status: true, completedAt: true },
        });
        expect(lines).toHaveLength(3);
        expect(lines.every((l) => l.status === 'DONE')).toBe(true);

        const entries = await globalPrisma.logEntry.findMany({
            where: { tenantId, operationParcelId: { in: lines.map((l) => l.id) } },
            select: { recordedInDiary: true, occurredAt: true },
        });
        expect(entries).toHaveLength(3);
        expect(entries.every((e) => e.recordedInDiary)).toBe(true);

        // Dated by the treatment's DAY, not the save time — both the entries
        // and the lines, because the register joins the two.
        const expected = new Date(`${DAY}T00:00:00.000Z`).toISOString();
        expect(entries.map((e) => e.occurredAt.toISOString())).toEqual([expected, expected, expected]);
        expect(lines.map((l) => l.completedAt?.toISOString())).toEqual([expected, expected, expected]);
    });

    it('deducts no stock, though a lot was available to deduct from', async () => {
        const tx = await globalPrisma.stockTransaction.findMany({
            where: { tenantId, type: 'CONSUMPTION' },
            select: { id: true },
        });
        expect(tx).toEqual([]);
    });

    it('sends no assignment notification, because the assignee is the recorder', async () => {
        // The reason the suppression exists: this write requires an assignee,
        // so the only honest one is the person typing — who must not be
        // emailed about work they just finished recording. See #1755 for the
        // general self-assignment case.
        const bells = await globalPrisma.notification.findMany({
            where: { tenantId, type: 'TASK_ASSIGNED' },
            select: { id: true },
        });
        expect(bells).toEqual([]);
    });

    it('a replay with the same key returns the same handle and writes nothing new', async () => {
        const before = await globalPrisma.task.count({ where: { tenantId } });

        const again = await recordDiaryTreatment(ctx(), baseInput(), KEY);

        expect(again.replayed).toBe(true);
        expect(again.treatmentGroupId).toBe(KEY);
        // The count has to be truthful on a replay, or the saved screen lies.
        expect(again.parcelCount).toBe(3);
        expect(new Set(again.taskIds)).toEqual(new Set(first.taskIds));
        expect(await globalPrisma.task.count({ where: { tenantId } })).toBe(before);
    });

    it('mints a handle of its own when no key is sent', async () => {
        const noKey = await recordDiaryTreatment(
            ctx(),
            { ...baseInput(), parcelIds: [parcelA1] },
            null,
        );
        expect(noKey.treatmentGroupId).toMatch(/^[0-9a-f-]{36}$/);
        expect(noKey.treatmentGroupId).not.toBe(KEY);
    });

    it('refuses a parcel from another farm as a 400, not a 404', async () => {
        await expect(
            recordDiaryTreatment(
                ctx(),
                { ...baseInput(), parcelIds: [parcelA1, otherTenantParcel] },
                `${KEY}-cross`,
            ),
        ).rejects.toMatchObject({ code: 'REFERENCE_NOT_IN_TENANT' });
    });

    it('refuses a future date, and a day that does not exist', async () => {
        await expect(
            recordDiaryTreatment(ctx(), { ...baseInput(), occurredOn: '2099-01-01' }, `${KEY}-fut`),
        ).rejects.toMatchObject({ code: 'TREATMENT_DATE_IN_FUTURE' });

        // 31 February would silently become 3 March through Date.UTC, so the
        // parser round-trips rather than trusting it.
        await expect(
            recordDiaryTreatment(ctx(), { ...baseInput(), occurredOn: '2026-02-31' }, `${KEY}-bad`),
        ).rejects.toMatchObject({ code: 'TREATMENT_DATE_INVALID' });
    });

    it('refuses an empty parcel list', async () => {
        await expect(
            recordDiaryTreatment(ctx(), { ...baseInput(), parcelIds: [] }, `${KEY}-none`),
        ).rejects.toMatchObject({ code: 'TREATMENT_NO_PARCELS' });
    });
});

/**
 * The future guard, in the hours where the farm's day and UTC's disagree.
 *
 * This is the defect the iOS client found by reading the code against the
 * contract. The guard compared the submitted day against the end of the
 * SERVER's UTC day, so between local midnight and 03:00 (02:00 in winter) a
 * farmer recording what they had just sprayed TODAY was refused
 * `TREATMENT_DATE_IN_FUTURE` — while the screen beside them, rendered in the
 * same Europe/Sofia zone, showed that day as today.
 *
 * Only `Date` is faked. Prisma's pool and Jest's own scheduling need real
 * timers, and faking them deadlocks the suite rather than failing it.
 */
describeFn('the future guard uses the farm day, not the server day (DB-backed)', () => {
    // 21:30 UTC on 13 October IS 00:30 on 14 October in Sofia. So the farm's
    // today is the 14th and UTC's is still the 13th — the exact window.
    const SOFIA_MIDNIGHT_PLUS_30 = new Date('2026-10-13T21:30:00.000Z');

    beforeEach(() => {
        jest.useFakeTimers({
            now: SOFIA_MIDNIGHT_PLUS_30,
            doNotFake: [
                'nextTick',
                'setImmediate',
                'setTimeout',
                'setInterval',
                'clearTimeout',
                'clearInterval',
                'queueMicrotask',
                'performance',
            ],
        });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("accepts the farm's today while UTC is still on yesterday", async () => {
        // The load-bearing case. Under the old UTC comparison this threw
        // TREATMENT_DATE_IN_FUTURE, which is the one day the guard most has
        // to allow: it is what a farmer finishing late at night records.
        const res = await recordDiaryTreatment(
            ctx(),
            { ...baseInput(), occurredOn: '2026-10-14', parcelIds: [parcelA1] },
            `${TAG}-sofia-today`,
        );

        expect(res.replayed).toBe(false);
        expect(res.parcelCount).toBe(1);

        // And it is DATED the farm's day, not the server's — otherwise the
        // entry would be accepted and then filed under the 13th.
        const entries = await globalPrisma.logEntry.findMany({
            where: { tenantId, recordedInDiary: true },
            select: { occurredAt: true },
        });
        const stamped = entries.map((e) => e.occurredAt.toISOString());
        expect(stamped).toContain('2026-10-14T00:00:00.000Z');
    });

    it("still refuses the farm's tomorrow in that same window", async () => {
        // The control. A guard that accepted everything would satisfy the
        // case above, so the boundary has to be shown to still exist — one
        // day later, same clock.
        await expect(
            recordDiaryTreatment(
                ctx(),
                { ...baseInput(), occurredOn: '2026-10-15', parcelIds: [parcelA1] },
                `${TAG}-sofia-tomorrow`,
            ),
        ).rejects.toMatchObject({ code: 'TREATMENT_DATE_IN_FUTURE' });
    });

    it('refuses a day that does not exist, with the clock wherever it is', async () => {
        await expect(
            recordDiaryTreatment(
                ctx(),
                { ...baseInput(), occurredOn: '2026-02-31', parcelIds: [parcelA1] },
                `${TAG}-sofia-bad`,
            ),
        ).rejects.toMatchObject({ code: 'TREATMENT_DATE_INVALID' });
    });
});
