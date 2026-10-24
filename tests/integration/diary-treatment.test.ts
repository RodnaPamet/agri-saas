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
import {
    recordDiaryTreatment,
    getDiaryTreatment,
    getDiaryTreatmentDefinition,
    correctDiaryTreatment,
} from '@/app-layer/usecases/diary-treatment';

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

/**
 * The read-by-handle, and the three answers a client has to tell apart.
 *
 * It ships with the write because the write REPLAYS a reused key without
 * comparing the body (#1765): a save whose response is lost, then an edit,
 * goes out under a new key and writes a SECOND treatment if the first landed.
 * Asking whether the earlier handle exists is the only way to tell.
 *
 * The case worth the fixture work is the third one — tasks with no lines.
 * Collapsing it fails in both directions, so it is asserted as its own state
 * rather than as "truthy".
 */
describeFn('getDiaryTreatment (DB-backed)', () => {
    it('answers null for a handle nothing was recorded under', async () => {
        await expect(getDiaryTreatment(ctx(), `${TAG}-never-used`)).resolves.toBeNull();
        // Blank is not a lookup, and must not match the first row with a null
        // or empty handle.
        await expect(getDiaryTreatment(ctx(), '   ')).resolves.toBeNull();
    });

    it('reports a recorded treatment as complete, with its day and counts', async () => {
        const key = `${TAG}-read-ok`;
        const written = await recordDiaryTreatment(
            ctx(),
            { ...baseInput(), parcelIds: [parcelA1, parcelB1] },
            key,
        );

        const found = await getDiaryTreatment(ctx(), key);
        expect(found).toMatchObject({
            treatmentGroupId: key,
            parcelCount: 2,
            complete: true,
            // The DAY it was recorded for, read back exactly as written.
            occurredOn: DAY,
        });
        expect(new Set(found!.taskIds)).toEqual(new Set(written.taskIds));
    });

    it('refuses a sample product BEFORE writing anything, leaving no partial', async () => {
        // A sample-archetype product is refused on the way into DONE, which
        // used to mean the blocks and lines were already written and the
        // refusal repeated on every retry — a treatment that could be neither
        // finished nor abandoned, with no delete-by-handle to clear it.
        //
        // The pre-flight makes the refusal mean what a 4xx should: nothing
        // happened. The assertion that matters is the SECOND one.
        const archetype = await globalPrisma.item.create({
            data: {
                tenantId, name: `Sample ${TAG}`, category: 'PESTICIDE',
                defaultUnitId: unitId, isArchetype: true,
            },
        });
        const key = `${TAG}-archetype`;

        await expect(
            recordDiaryTreatment(
                ctx(),
                { ...baseInput(), productItemId: archetype.id, parcelIds: [parcelA1, parcelB1] },
                key,
            ),
        ).rejects.toMatchObject({ code: 'PRODUCT_IS_SAMPLE_ARCHETYPE' });

        // Nothing written. Without the pre-flight this is a treatment with
        // two blocks of unmarked lines and no way out.
        await expect(getDiaryTreatment(ctx(), key)).resolves.toBeNull();
    });

    it('reports an interrupted run as INCOMPLETE, not complete', async () => {
        // The partial state is reachable from any failure DURING marking —
        // a dropped connection, a killed process, a line whose task moved.
        // Since the one input-driven cause is now refused up front, it is
        // built here by reverting a marked line, which is exactly the state
        // an interrupted run leaves: some lines recorded, some not.
        const key = `${TAG}-interrupted`;
        await recordDiaryTreatment(
            ctx(), { ...baseInput(), parcelIds: [parcelA1, parcelA2] }, key,
        );
        const lines = await globalPrisma.operationParcel.findMany({
            where: { tenantId, task: { treatmentGroupId: key } },
            select: { id: true },
            orderBy: { id: 'asc' },
        });
        expect(lines).toHaveLength(2);
        await globalPrisma.operationParcel.update({
            where: { id: lines[0].id },
            data: { status: 'PENDING', completedAt: null },
        });

        const found = await getDiaryTreatment(ctx(), key);
        // Lines exist — a 404 would make the client write a duplicate...
        expect(found!.parcelCount).toBe(2);
        // ...but only one is recorded, so the register does not have this
        // treatment. The old predicate (`parcelCount > 0`) called it complete.
        expect(found!.completedCount).toBe(1);
        expect(found!.complete).toBe(false);
    });

    it('a same-key retry FINISHES a partial treatment instead of replaying a no-op', async () => {
        // The half that matters operationally. Under the old replay arm this
        // returned `replayed: true` having done nothing, so the treatment
        // could never be completed by any number of retries.
        const key = `${TAG}-resume`;
        const input = { ...baseInput(), parcelIds: [parcelA1, parcelA2] };
        await recordDiaryTreatment(ctx(), input, key);

        const lines = await globalPrisma.operationParcel.findMany({
            where: { tenantId, task: { treatmentGroupId: key } },
            select: { id: true },
            orderBy: { id: 'asc' },
        });
        await globalPrisma.operationParcel.update({
            where: { id: lines[0].id },
            data: { status: 'PENDING', completedAt: null },
        });
        expect((await getDiaryTreatment(ctx(), key))!.complete).toBe(false);

        const retry = await recordDiaryTreatment(ctx(), input, key);
        // NOT a replay: this request finished the job.
        expect(retry.replayed).toBe(false);

        const after = await getDiaryTreatment(ctx(), key);
        expect(after!.complete).toBe(true);
        expect(after!.completedCount).toBe(after!.parcelCount);
        expect(after!.occurredOn).toBe(DAY);
        // And it did not duplicate the blocks — the derived per-block key is
        // what makes the retry safe to run.
        expect(after!.parcelCount).toBe(2);
    });

    it('captures the stated quarantine period on every line, for a product the farm ALREADY has', async () => {
        // The original defect: `quarantinePeriodDays` only reached
        // `newProductRegistration`, which is consulted solely when a typed
        // NAME has to create a product. Sent alongside a `productItemId` —
        // which is what the phone sends for a known product — the farmer's
        // number was silently dropped, and the register printed the
        // product's current value instead (#1775).
        const key = `${TAG}-quarantine`;
        await recordDiaryTreatment(
            ctx(),
            { ...baseInput(), parcelIds: [parcelA1, parcelB1], quarantinePeriodDays: 7 },
            key,
        );

        const lines = await globalPrisma.operationParcel.findMany({
            where: { tenantId, task: { treatmentGroupId: key } },
            select: { quarantinePeriodDays: true, status: true },
        });
        expect(lines).toHaveLength(2);
        expect(lines.every((l) => l.status === 'DONE')).toBe(true);
        // Every line, across both blocks — the register reads lines, not the
        // request.
        expect(lines.map((l) => l.quarantinePeriodDays)).toEqual([7, 7]);
    });

    it('leaves the period null when none is stated, rather than defaulting it', async () => {
        // Null means "not captured" and makes the register fall back to the
        // product. A zero here would print «0 дни» — a waiting period the
        // farmer never gave, in a regulatory document.
        const key = `${TAG}-no-quarantine`;
        await recordDiaryTreatment(ctx(), { ...baseInput(), parcelIds: [parcelA2] }, key);
        const lines = await globalPrisma.operationParcel.findMany({
            where: { tenantId, task: { treatmentGroupId: key } },
            select: { quarantinePeriodDays: true },
        });
        expect(lines).toHaveLength(1);
        expect(lines[0].quarantinePeriodDays).toBeNull();
    });

    it('stamps the handle on every journal entry, which is what the Дневник folds on', async () => {
        // The ДНЕВНИК shows ONE row per treatment, and a treatment writes one
        // INPUT_APPLICATION entry per line — so the fold needs the handle on
        // the ENTRY. It is otherwise reachable only as
        // `LogEntry.operationParcelId -> OperationParcel.taskId -> Task`, and
        // folding across that join would mean reimplementing the journal's
        // manual-only WHERE clause in raw SQL — two spellings of a rule that
        // took a DB-backed test to pin down.
        const key = `${TAG}-fold`;
        await recordDiaryTreatment(
            ctx(),
            { ...baseInput(), parcelIds: [parcelA1, parcelA2, parcelB1] },
            key,
        );

        const lines = await globalPrisma.operationParcel.findMany({
            where: { tenantId, task: { treatmentGroupId: key } },
            select: { id: true },
        });
        expect(lines).toHaveLength(3);

        const entries = await globalPrisma.logEntry.findMany({
            where: { tenantId, operationParcelId: { in: lines.map((l) => l.id) } },
            select: { treatmentGroupId: true },
        });
        // Three entries, ONE group — three rows in the register today, one
        // after the fold.
        expect(entries).toHaveLength(3);
        expect(new Set(entries.map((e) => e.treatmentGroupId))).toEqual(new Set([key]));
    });

    it('gives a non-treatment entry its OWN group, so it folds to itself', async () => {
        // NOT NULL with a unique default, and that is load-bearing rather
        // than tidy: `DISTINCT ON` treats all NULLs as ONE value, so a
        // nullable key would collapse every manual entry a farm has ever
        // written into a single ghost row. Measured at 4 null rows -> 1.
        const a = await globalPrisma.logEntry.create({
            data: {
                tenantId, type: 'OBSERVATION', title: `Manual A ${TAG}`,
                occurredAt: new Date(`${DAY}T00:00:00.000Z`), createdByUserId: userId,
            },
            select: { id: true, treatmentGroupId: true },
        });
        const b = await globalPrisma.logEntry.create({
            data: {
                tenantId, type: 'OBSERVATION', title: `Manual B ${TAG}`,
                occurredAt: new Date(`${DAY}T00:00:00.000Z`), createdByUserId: userId,
            },
            select: { id: true, treatmentGroupId: true },
        });

        // Never null...
        expect(a.treatmentGroupId).toBeTruthy();
        expect(b.treatmentGroupId).toBeTruthy();
        // ...and never shared, so two manual entries are two rows.
        expect(a.treatmentGroupId).not.toBe(b.treatmentGroupId);
    });

    it('replays only once every line is recorded', async () => {
        const key = `${TAG}-full-replay`;
        const first = await recordDiaryTreatment(
            ctx(), { ...baseInput(), parcelIds: [parcelA1] }, key,
        );
        expect(first.replayed).toBe(false);
        const again = await recordDiaryTreatment(
            ctx(), { ...baseInput(), parcelIds: [parcelA1] }, key,
        );
        expect(again.replayed).toBe(true);
        expect(again.parcelCount).toBe(1);
    });

    it('does not find another farm\'s treatment under the same handle', async () => {
        const key = `${TAG}-xtenant`;
        await globalPrisma.task.create({
            data: {
                tenantId: otherTenantId,
                title: `Other ${TAG}`,
                type: 'FIELD_OPERATION',
                createdByUserId: userId,
                treatmentGroupId: key,
            },
        });
        // Same handle, different farm: a client holding a guessed or leaked
        // handle learns nothing.
        //
        // WHAT THIS PROVES, AND WHAT IT DOES NOT. The property holds — and
        // it is RLS that enforces it, not the `tenantId` in the `where`.
        // Measured: deleting `tenantId: ctx.tenantId` from the read leaves
        // all 17 cases green, because `runInTenantContext` binds the tenant
        // and the policy hides the other farm's row at the database. So the
        // application-layer filter is the documented second layer here
        // rather than the thing under test, and this assertion cannot tell
        // you it is present. Do not read a green run as having checked it.
        await expect(getDiaryTreatment(ctx(), key)).resolves.toBeNull();
    });

    /**
     * On `assertCanRead`, which this usecase calls and which no test here can
     * falsify.
     *
     * `canRead` is `level >= 1` and the lowest of the six roles — READER and
     * MECHANISATOR — are both level 1, so the call cannot refuse any real
     * role. It can only throw for a synthesized context carrying an explicit
     * `canRead: false`, which is a background job, not a request.
     *
     * So there is deliberately NO test asserting a role is refused a read.
     * Writing one would mean inventing a context no HTTP request produces and
     * would read as coverage of a gate that does not gate. Measured: removing
     * the `assertCanRead` call leaves all 17 cases green. Filed separately,
     * because it is true of all 126 of its call sites and not of this one.
     */
});

/**
 * The TreatmentGroup row, and the two decisions its migration rests on (#2172).
 *
 * Owner ruling 2026-10-24: the treatment gets a row, so a correction has a unit
 * to commit in and somewhere to keep a version that survives a correction
 * ADDING or DROPPING a parcel.
 *
 * Both assertions below are about the BACKFILL statement rather than the table
 * shape, because the backfill is where this could silently do the wrong thing:
 * it ran against a tree with zero treatments, where `0 rows created from 0
 * source rows` is a count that cannot fail. So the statement is re-executed
 * here against seeded data, including the case that decided the primary key.
 */
describeFn('TreatmentGroup backfill (DB-backed, #2172)', () => {
    /** The migration's backfill, verbatim. */
    const BACKFILL = `
        INSERT INTO "TreatmentGroup" ("id", "tenantId", "createdAt", "updatedAt")
        SELECT DISTINCT t."treatmentGroupId", t."tenantId", MIN(t."createdAt"), MAX(t."updatedAt")
          FROM "Task" t
         WHERE t."treatmentGroupId" IS NOT NULL
         GROUP BY t."treatmentGroupId", t."tenantId"
        ON CONFLICT ("tenantId", "id") DO NOTHING`;

    it('creates ONE row per (handle, tenant) — a handle shared by two farms is two groups', async () => {
        // The case that made the primary key `(tenantId, id)` rather than `id`.
        // `Task.treatmentGroupId` can be the request's Idempotency-Key, which is
        // scoped per tenant, so two farms can legitimately carry the same
        // handle — and the test above (`does not find another farm's treatment
        // under the same handle`) already relies on exactly that. A global
        // primary key would make this INSERT violate itself on real data.
        const shared = `${TAG}-shared-handle`;
        for (const t of [tenantId, otherTenantId]) {
            await globalPrisma.task.create({
                data: {
                    tenantId: t,
                    title: `Shared ${TAG}`,
                    type: 'FIELD_OPERATION',
                    createdByUserId: userId,
                    treatmentGroupId: shared,
                },
            });
        }

        await globalPrisma.$executeRawUnsafe(BACKFILL);

        const groups = await globalPrisma.treatmentGroup.findMany({
            where: { id: shared },
            orderBy: { tenantId: 'asc' },
        });
        expect(groups).toHaveLength(2);
        expect(groups.map((g: { tenantId: string }) => g.tenantId).sort()).toEqual(
            [tenantId, otherTenantId].sort(),
        );
        // Both carry the SAME handle, which is the whole point.
        expect(new Set(groups.map((g: { id: string }) => g.id))).toEqual(new Set([shared]));
        // Version starts at 0: nothing has corrected these, and a backfilled row
        // claiming a version it never served would be a lie a client could act on.
        expect(groups.every((g: { version: number }) => g.version === 0)).toBe(true);
    });

    it('does NOT create a group for a manual journal entry', async () => {
        // The backfill reads `Task`, not `LogEntry`, and this is why.
        // `LogEntry.treatmentGroupId` is NOT NULL and an entry belonging to no
        // treatment gets its OWN unique value so it folds to itself — a
        // nullable key would collapse every manual entry into one ghost row via
        // `DISTINCT ON`. So most LogEntry handles name no treatment, and
        // backfilling from there would create one group per manual entry a farm
        // has ever written.
        const entry = await globalPrisma.logEntry.create({
            data: {
                tenantId,
                createdByUserId: userId,
                // An OBSERVATION, which is the manual kind — a treatment writes
                // INPUT_APPLICATION entries from a completed task line.
                type: 'OBSERVATION',
                title: `Manual ${TAG}`,
                occurredAt: new Date(),
            },
        });
        // It has a handle — that is the schema's design, not an accident.
        expect(entry.treatmentGroupId).toBeTruthy();

        await globalPrisma.$executeRawUnsafe(BACKFILL);

        const group = await globalPrisma.treatmentGroup.findFirst({
            where: { tenantId, id: entry.treatmentGroupId },
        });
        expect(group).toBeNull();
    });

    it('a correction cannot point at another farm\'s treatment — the FK carries the tenant', async () => {
        // The composite FK is what makes this structural rather than left to
        // the RLS policy alone: a (tenantId, groupId) pair that does not match
        // a real group has no referent.
        const mine = `${TAG}-fk-mine`;
        await globalPrisma.task.create({
            data: {
                tenantId,
                title: `FK ${TAG}`,
                type: 'FIELD_OPERATION',
                createdByUserId: userId,
                treatmentGroupId: mine,
            },
        });
        await globalPrisma.$executeRawUnsafe(BACKFILL);

        // The control: it inserts fine for the OWNING tenant, so the refusal
        // below is about the tenant and not about the row being malformed.
        await expect(
            globalPrisma.treatmentCorrection.create({
                data: { tenantId, groupId: mine, previous: {}, changedFields: ['doseValue'] },
            }),
        ).resolves.toBeTruthy();

        await expect(
            globalPrisma.treatmentCorrection.create({
                data: { tenantId: otherTenantId, groupId: mine, previous: {}, changedFields: [] },
            }),
        ).rejects.toThrow();
    });
});

/**
 * `getDiaryTreatmentDefinition` — the correction prefill (#2172).
 *
 * The property that matters is RE-SUBMITTABILITY: a correction replaces the
 * definition, so anything the prefill cannot express is a field a correction
 * would silently drop. So the first test asserts the whole shape against the
 * input it was recorded from rather than spot-checking fields.
 */
describeFn('getDiaryTreatmentDefinition (DB-backed, #2172)', () => {
    const KEY = `def-${TAG}`;

    it('returns the definition it was recorded from, field for field', async () => {
        const input = baseInput();
        const rec = await recordDiaryTreatment(ctx(), input, KEY);

        const def = await getDiaryTreatmentDefinition(ctx(), rec.treatmentGroupId);

        // Every scalar the create accepted comes back as it went in.
        expect(def).toMatchObject({
            treatmentGroupId: rec.treatmentGroupId,
            kind: input.kind,
            occurredOn: input.occurredOn,
            productItemId: input.productItemId,
            doseValue: input.doseValue,
            doseUnitId: input.doseUnitId,
            targetNote: input.targetNote,
            applicationTechnique: input.applicationTechnique,
        });
        // And every parcel, which is what `getDiaryTreatment` cannot give: it
        // reads the lines with `take: 1`.
        expect(def.lines.map((l) => l.parcelId).sort()).toEqual([...input.parcelIds].sort());
        expect(def.lines.every((l) => l.parcelName.length > 0)).toBe(true);
    });

    it('carries the GROUP version, and recordDiaryTreatment created the row', async () => {
        // The gap this closes: #2279 added the table and backfilled EXISTING
        // groups. Without this, a treatment recorded afterwards would have no
        // group row and the prefill would report a version it never served.
        const rec = await recordDiaryTreatment(ctx(), baseInput(), `${KEY}-ver`);

        const row = await globalPrisma.treatmentGroup.findUnique({
            where: { tenantId_id: { tenantId, id: rec.treatmentGroupId } },
        });
        expect(row).not.toBeNull();
        expect(row!.version).toBe(0);

        const def = await getDiaryTreatmentDefinition(ctx(), rec.treatmentGroupId);
        expect(def.version).toBe(0);
    });

    it('a PARTIAL retry finishes the job without bumping the version', async () => {
        // The retry that actually reaches the group upsert. A COMPLETE replay
        // returns early (`if (prior.complete)`) and never gets there, so
        // asserting the version on one proves nothing — the first draft of this
        // test did exactly that and a mutation making the update branch
        // `increment: 1` left it green.
        //
        // A partial retry falls through the whole body, so its update branch
        // runs. Finishing the remaining lines has not changed the definition,
        // so it must not invalidate an `If-Match` a client is holding.
        const key = `${KEY}-partial`;
        const input = { ...baseInput(), parcelIds: [parcelA1, parcelA2] };
        await recordDiaryTreatment(ctx(), input, key);

        const lines = await globalPrisma.operationParcel.findMany({
            where: { tenantId, task: { treatmentGroupId: key } },
            select: { id: true },
            orderBy: { id: 'asc' },
        });
        await globalPrisma.operationParcel.update({
            where: { id: lines[0].id },
            data: { status: 'PENDING', completedAt: null },
        });

        const retry = await recordDiaryTreatment(ctx(), input, key);
        // NOT a replay: this request finished the job, which is what makes it
        // reach the upsert.
        expect(retry.replayed).toBe(false);

        const row = await globalPrisma.treatmentGroup.findUnique({
            where: { tenantId_id: { tenantId, id: key } },
        });
        expect(row!.version).toBe(0);
    });

    it('leaves treatedAreaHa NULL, because null means the WHOLE parcel', async () => {
        // The prefill must not substitute `parcel.areaHa`: the register prints
        // `treatedAreaHa ?? parcel.areaHa`, so filling it in would turn an
        // absence into a claim — and a correction round-tripping this prefill
        // would then persist a number nobody typed.
        const rec = await recordDiaryTreatment(ctx(), baseInput(), `${KEY}-area`);

        const def = await getDiaryTreatmentDefinition(ctx(), rec.treatmentGroupId);

        // The base input sets no per-parcel areas, so every line is whole-parcel.
        expect(def.lines.every((l) => l.treatedAreaHa === null)).toBe(true);
    });

    it('refuses MIXED AUTHORSHIP, which binds admins too', async () => {
        // The same 409 the withdrawal raises: a handle carrying tasks written by
        // more than one person has no single creator for the permission rule to
        // admit, so there is no safe answer to "may you correct this".
        const rec = await recordDiaryTreatment(ctx(), baseInput(), `${KEY}-mixed`);
        const other = await globalPrisma.user.create({
            data: {
                email: `${TAG}-second@ag.test`,
                emailHash: hashForLookup(`${TAG}-second@ag.test`),
                name: 'Second Author',
            },
        });
        await globalPrisma.task.create({
            data: {
                tenantId,
                title: `Interloper ${TAG}`,
                type: 'FIELD_OPERATION',
                createdByUserId: other.id,
                treatmentGroupId: rec.treatmentGroupId,
            },
        });

        // An OWNER — canAdmin — is still refused.
        await expect(
            getDiaryTreatmentDefinition(ctx(), rec.treatmentGroupId),
        ).rejects.toMatchObject({ code: 'TREATMENT_MIXED_AUTHORSHIP' });
    });

    it('refuses a writer who did not record it, and admits an admin who did not', async () => {
        const rec = await recordDiaryTreatment(ctx(), baseInput(), `${KEY}-perm`);
        const stranger = await globalPrisma.user.create({
            data: {
                email: `${TAG}-stranger@ag.test`,
                emailHash: hashForLookup(`${TAG}-stranger@ag.test`),
                name: 'Stranger',
            },
        });

        // An EDITOR who is not the creator: refused.
        await expect(
            getDiaryTreatmentDefinition(
                makeRequestContext('EDITOR', {
                    userId: stranger.id,
                    tenantId,
                    tenantSlug: `${TAG}-t`,
                }),
                rec.treatmentGroupId,
            ),
        ).rejects.toMatchObject({ code: 'TREATMENT_EDIT_NOT_PERMITTED' });

        // An OWNER who is not the creator: admitted. The control, so the
        // refusal above is about authorship rather than about the handle.
        await expect(
            getDiaryTreatmentDefinition(
                makeRequestContext('OWNER', {
                    userId: stranger.id,
                    tenantId,
                    tenantSlug: `${TAG}-t`,
                }),
                rec.treatmentGroupId,
            ),
        ).resolves.toMatchObject({ treatmentGroupId: rec.treatmentGroupId });
    });

    it('404s a handle whose tasks exist with NO lines — the stranded shape', async () => {
        // A partial write that failed before any line landed. There is no
        // definition to correct, and saying so beats returning a shell the form
        // would fill with defaults and save as if it were the record.
        const handle = `${TAG}-stranded`;
        await globalPrisma.task.create({
            data: {
                tenantId,
                title: `Stranded ${TAG}`,
                type: 'FIELD_OPERATION',
                createdByUserId: userId,
                treatmentGroupId: handle,
            },
        });

        await expect(getDiaryTreatmentDefinition(ctx(), handle)).rejects.toMatchObject({
            code: 'TREATMENT_NOT_FOUND',
        });
    });

    it('404s an unknown handle rather than leaking that it is unknown differently', async () => {
        await expect(
            getDiaryTreatmentDefinition(ctx(), `${TAG}-nope`),
        ).rejects.toMatchObject({ code: 'TREATMENT_NOT_FOUND' });
    });
});

describeFn('correctDiaryTreatment (DB-backed, #2172)', () => {
    const KEY = `corr-${TAG}`;

    /** Record a treatment and hand back its handle, one per test. */
    const recorded = async (suffix: string, over: Record<string, unknown> = {}) => {
        const key = `${KEY}-${suffix}`;
        const rec = await recordDiaryTreatment(ctx(), { ...baseInput(), ...over }, key);
        return rec.treatmentGroupId;
    };

    it('corrects the six fields across every block, and bumps the version once', async () => {
        const handle = await recorded('all');
        const before = await getDiaryTreatmentDefinition(ctx(), handle);
        expect(before.version).toBe(0);

        const out = await correctDiaryTreatment(
            ctx(),
            handle,
            {
                title: 'Коригирана обработка',
                applicationTechnique: 'knapsack',
                targetNote: 'Brown rust',
                quarantinePeriodDays: 21,
                phenophase: 'BBCH 39',
                occurredOn: '2026-03-06',
            },
            before.version,
        );

        expect(out.version).toBe(1);
        expect(out).toMatchObject({
            title: 'Коригирана обработка',
            applicationTechnique: 'knapsack',
            targetNote: 'Brown rust',
            quarantinePeriodDays: 21,
            phenophase: 'BBCH 39',
            occurredOn: '2026-03-06',
        });

        // Re-read rather than trust the returned view: the function assembles
        // its response from what it wrote, so a response-only correctness bug
        // would be invisible to an assertion on the return value alone.
        const after = await getDiaryTreatmentDefinition(ctx(), handle);
        expect(after).toMatchObject({
            version: 1,
            title: 'Коригирана обработка',
            applicationTechnique: 'knapsack',
            targetNote: 'Brown rust',
            quarantinePeriodDays: 21,
            phenophase: 'BBCH 39',
            occurredOn: '2026-03-06',
        });

        // ACROSS BLOCKS: the fixture spans two, and the title lives on `Task`,
        // one row per block. Correcting only the first would leave the second
        // block's rows describing the old treatment — and the register prints
        // per block.
        const tasks = await globalPrisma.task.findMany({
            where: { tenantId, treatmentGroupId: handle, deletedAt: null },
            select: { title: true, applicationTechnique: true },
        });
        expect(tasks.length).toBeGreaterThan(1);
        expect(new Set(tasks.map((t) => t.title))).toEqual(new Set(['Коригирана обработка']));
        expect(new Set(tasks.map((t) => t.applicationTechnique))).toEqual(new Set(['knapsack']));

        // And every LINE, not just the first — `targetNote` is per line.
        const lines = await globalPrisma.operationParcel.findMany({
            where: { tenantId, task: { treatmentGroupId: handle } },
            select: { targetNote: true, phenophase: true, quarantinePeriodDays: true },
        });
        expect(lines.length).toBe(3);
        expect(lines.every((l) => l.targetNote === 'Brown rust')).toBe(true);
        expect(lines.every((l) => l.phenophase === 'BBCH 39')).toBe(true);
        expect(lines.every((l) => l.quarantinePeriodDays === 21)).toBe(true);
    });

    it('files ONE trail row carrying the whole previous definition and the changed names', async () => {
        const handle = await recorded('trail');
        const before = await getDiaryTreatmentDefinition(ctx(), handle);

        await correctDiaryTreatment(
            ctx(),
            handle,
            { targetNote: 'Powdery mildew', phenophase: 'BBCH 31' },
            before.version,
        );

        const trail = await globalPrisma.treatmentCorrection.findMany({
            where: { tenantId, groupId: handle },
        });
        expect(trail.length).toBe(1);
        expect([...trail[0].changedFields].sort()).toEqual(['phenophase', 'targetNote']);
        expect(trail[0].correctedByUserId).toBe(userId);

        // WHOLE previous, not a diff — owner decision 2026-10-24. A diff needs
        // the reader to already hold the state it was a diff against, and the
        // point of the record is that the state is gone.
        const prev = trail[0].previous as Record<string, unknown>;
        expect(prev).toMatchObject({
            treatmentGroupId: handle,
            version: before.version,
            targetNote: before.targetNote,
            doseValue: before.doseValue,
            productItemId: before.productItemId,
            occurredOn: before.occurredOn,
        });
        // Including the parcels, which is the part a field-name diff loses.
        expect(Array.isArray(prev.lines)).toBe(true);
        expect((prev.lines as unknown[]).length).toBe(3);
    });

    it('a correction that changes nothing writes NOTHING', async () => {
        const handle = await recorded('noop');
        const before = await getDiaryTreatmentDefinition(ctx(), handle);

        // The editor's own save with no edits: the WHOLE definition back,
        // including the fields this route refuses to change.
        const out = await correctDiaryTreatment(
            ctx(),
            handle,
            {
                title: before.title ?? undefined,
                applicationTechnique: before.applicationTechnique,
                targetNote: before.targetNote,
                quarantinePeriodDays: before.quarantinePeriodDays,
                phenophase: before.phenophase,
                occurredOn: before.occurredOn ?? undefined,
                productItemId: before.productItemId,
                doseValue: before.doseValue,
                doseUnitId: before.doseUnitId,
                waterRateValue: before.waterRateValue,
                waterRateUnitId: before.waterRateUnitId,
                parcels: before.lines.map((l) => ({
                    parcelId: l.parcelId,
                    treatedAreaHa: l.treatedAreaHa,
                })),
            },
            before.version,
        );

        // No version burn — every other client's `If-Match` stays valid.
        expect(out.version).toBe(before.version);
        const row = await globalPrisma.treatmentGroup.findUnique({
            where: { tenantId_id: { tenantId, id: handle } },
        });
        expect(row!.version).toBe(before.version);
        // And no row asserting that a farmer altered a regulated record.
        expect(
            await globalPrisma.treatmentCorrection.count({ where: { tenantId, groupId: handle } }),
        ).toBe(0);
    });

    it('refuses a STALE If-Match and leaves the record untouched', async () => {
        const handle = await recorded('stale');
        const before = await getDiaryTreatmentDefinition(ctx(), handle);
        await correctDiaryTreatment(ctx(), handle, { targetNote: 'First' }, before.version);

        // The version the first editor is still holding.
        await expect(
            correctDiaryTreatment(ctx(), handle, { targetNote: 'Second' }, before.version),
        ).rejects.toMatchObject({ code: 'STALE_DATA' });

        const after = await getDiaryTreatmentDefinition(ctx(), handle);
        expect(after.targetNote).toBe('First');
        expect(after.version).toBe(before.version + 1);
        // The refused attempt filed no trail row — the throw happens after the
        // create in source order, so this is what proves the transaction rolled
        // it back rather than the ordering hiding it.
        expect(
            await globalPrisma.treatmentCorrection.count({ where: { tenantId, groupId: handle } }),
        ).toBe(1);
    });

    it('an ABSENT If-Match skips the precondition', async () => {
        const handle = await recorded('nomatch');
        const out = await correctDiaryTreatment(ctx(), handle, { targetNote: 'Unguarded' });
        expect(out.version).toBe(1);
        expect(out.targetNote).toBe('Unguarded');
    });

    it('refuses a CHANGED dose, product or water rate by name', async () => {
        const handle = await recorded('dose');
        const before = await getDiaryTreatmentDefinition(ctx(), handle);

        await expect(
            correctDiaryTreatment(ctx(), handle, { doseValue: before.doseValue + 1 }, before.version),
        ).rejects.toMatchObject({
            code: 'TREATMENT_CORRECTION_FIELD_UNSUPPORTED',
            params: { reference: 'doseValue' },
        });

        await expect(
            correctDiaryTreatment(ctx(), handle, { waterRateValue: 200 }, before.version),
        ).rejects.toMatchObject({
            code: 'TREATMENT_CORRECTION_FIELD_UNSUPPORTED',
            params: { reference: 'waterRateValue' },
        });

        // Nothing was written by either refusal.
        const after = await getDiaryTreatmentDefinition(ctx(), handle);
        expect(after.version).toBe(before.version);
        expect(after.doseValue).toBe(before.doseValue);
    });

    it('ACCEPTS an unchanged dose sent alongside a real correction (#1352)', async () => {
        // The control for the test above, and the reason the refusal compares
        // VALUES rather than noticing a key. #1352: an unconditional `eik`
        // refusal 400'd every farm-profile save from the owner's phone, because
        // the editor PUTs every field on every save. This editor does too.
        const handle = await recorded('unchanged-dose');
        const before = await getDiaryTreatmentDefinition(ctx(), handle);

        const out = await correctDiaryTreatment(
            ctx(),
            handle,
            {
                doseValue: before.doseValue,
                doseUnitId: before.doseUnitId,
                productItemId: before.productItemId,
                targetNote: 'Corrected with the dose echoed back',
            },
            before.version,
        );
        expect(out.version).toBe(1);
        expect(out.targetNote).toBe('Corrected with the dose echoed back');
    });

    it('tells a changed parcel SET apart from a changed treated AREA', async () => {
        const handle = await recorded('parcels');
        const before = await getDiaryTreatmentDefinition(ctx(), handle);

        // Dropping a parcel — the case the TreatmentGroup row was designed for.
        await expect(
            correctDiaryTreatment(
                ctx(),
                handle,
                {
                    parcels: before.lines
                        .slice(1)
                        .map((l) => ({ parcelId: l.parcelId, treatedAreaHa: l.treatedAreaHa })),
                },
                before.version,
            ),
        ).rejects.toMatchObject({
            code: 'TREATMENT_CORRECTION_FIELD_UNSUPPORTED',
            params: { reference: 'parcels' },
        });

        // Same set, one area changed — a different refusal, so a client can
        // tell "not yet" from "not like that".
        await expect(
            correctDiaryTreatment(
                ctx(),
                handle,
                {
                    parcels: before.lines.map((l, i) => ({
                        parcelId: l.parcelId,
                        treatedAreaHa: i === 0 ? 1.5 : l.treatedAreaHa,
                    })),
                },
                before.version,
            ),
        ).rejects.toMatchObject({
            code: 'TREATMENT_CORRECTION_FIELD_UNSUPPORTED',
            params: { reference: 'treatedAreaHa' },
        });
    });

    it('refuses a blank title rather than writing NULL into a NOT NULL column', async () => {
        const handle = await recorded('blank-title');
        const before = await getDiaryTreatmentDefinition(ctx(), handle);
        await expect(
            correctDiaryTreatment(ctx(), handle, { title: '   ' }, before.version),
        ).rejects.toMatchObject({ code: 'TREATMENT_TITLE_REQUIRED' });
    });

    it('moves the journal entries onto the corrected day', async () => {
        const handle = await recorded('day');
        const before = await getDiaryTreatmentDefinition(ctx(), handle);

        const was = await globalPrisma.logEntry.findMany({
            where: { tenantId, treatmentGroupId: handle },
            select: { occurredAt: true },
        });
        expect(was.length).toBeGreaterThan(0);

        await correctDiaryTreatment(ctx(), handle, { occurredOn: '2026-03-09' }, before.version);

        // The journal list sorts and filters on `occurredAt`. Leaving it would
        // put the corrected treatment back on the old day in the list while the
        // register printed the new one — the two surfaces disagreeing about
        // when a regulated event happened.
        const now = await globalPrisma.logEntry.findMany({
            where: { tenantId, treatmentGroupId: handle },
            select: { occurredAt: true },
        });
        expect(now.length).toBe(was.length);
        expect(
            now.every((e) => e.occurredAt.toISOString().slice(0, 10) === '2026-03-09'),
        ).toBe(true);

        // And the lines, which is what the ДНЕВНИК prints.
        const lines = await globalPrisma.operationParcel.findMany({
            where: { tenantId, task: { treatmentGroupId: handle } },
            select: { completedAt: true },
        });
        expect(
            lines.every((l) => l.completedAt?.toISOString().slice(0, 10) === '2026-03-09'),
        ).toBe(true);
    });

    it('correcting the day does NOT complete a line nobody completed', async () => {
        // A treatment can be stranded half-written. Stamping a PENDING line
        // with a corrected date would mark work as done that nobody did — and
        // the register would print a treatment of a parcel that was never
        // treated.
        const handle = await recorded('pending-day');
        const lines = await globalPrisma.operationParcel.findMany({
            where: { tenantId, task: { treatmentGroupId: handle } },
            select: { id: true },
            orderBy: { id: 'asc' },
        });
        await globalPrisma.operationParcel.update({
            where: { id: lines[0].id },
            data: { status: 'PENDING', completedAt: null },
        });

        const before = await getDiaryTreatmentDefinition(ctx(), handle);
        await correctDiaryTreatment(ctx(), handle, { occurredOn: '2026-03-11' }, before.version);

        const reset = await globalPrisma.operationParcel.findUnique({
            where: { id: lines[0].id },
            select: { completedAt: true },
        });
        expect(reset!.completedAt).toBeNull();

        // The completed siblings DID move.
        const others = await globalPrisma.operationParcel.findMany({
            where: { tenantId, task: { treatmentGroupId: handle }, id: { not: lines[0].id } },
            select: { completedAt: true },
        });
        expect(
            others.every((l) => l.completedAt?.toISOString().slice(0, 10) === '2026-03-11'),
        ).toBe(true);
    });

    it('404s an unknown handle without saying whether it exists elsewhere', async () => {
        await expect(
            correctDiaryTreatment(ctx(), `${KEY}-nope`, { targetNote: 'x' }),
        ).rejects.toMatchObject({ code: 'TREATMENT_NOT_FOUND' });
    });
});

describeFn('parcels[] reaches the line it belongs to (DB-backed, #2072 part B)', () => {
    /**
     * The storage half of the per-parcel treated area, which nothing covered.
     *
     * Found while answering a different question. #2284 says the journal
     * quantity ignores `treatedAreaHa`; the production census for it returned
     * ZERO rows carrying one — out of 19 lines, 15 journal entries and 2
     * treatments — even though the iPhone has sent `parcels[].treatedAreaHa`
     * since 20 October. An empty population is consistent with two different
     * worlds: no farmer has recorded a partly-treated parcel, or the payload
     * never reaches the column. Only the second is a bug, and nothing in the
     * suite told them apart.
     *
     * It is the first: the area does land. These tests are what says so, and
     * what would catch it stopping.
     */
    it('stores the treated area on the NAMED parcel and leaves the others NULL', async () => {
        const rec = await recordDiaryTreatment(
            ctx(),
            { ...baseInput(), parcels: [{ parcelId: parcelA1, treatedAreaHa: 2 }] },
            `parcels-one-${TAG}`,
        );

        const lines = await globalPrisma.operationParcel.findMany({
            where: { tenantId, task: { treatmentGroupId: rec.treatmentGroupId } },
            select: { parcelId: true, treatedAreaHa: true },
        });
        expect(lines).toHaveLength(3);
        const area = new Map(lines.map((l) => [l.parcelId, l.treatedAreaHa]));
        expect(Number(area.get(parcelA1))).toBe(2);
        // NULL, not the parcel's own 10 — null MEANS the whole parcel, and
        // filling it in would turn an unstated area into a stated one.
        expect(area.get(parcelA2)).toBeNull();
        expect(area.get(parcelB1)).toBeNull();
    });

    it('lands on a parcel in the SECOND block too', async () => {
        // The treatment fans out to one `Task` per block and applies the areas
        // in a loop over each task's lines. A per-block regression — the map
        // consumed by the first task, or keyed per task rather than per parcel —
        // would leave the second block's area null while the first one's landed,
        // and the test above would not notice.
        const rec = await recordDiaryTreatment(
            ctx(),
            {
                ...baseInput(),
                parcels: [
                    { parcelId: parcelA1, treatedAreaHa: 1.5 },
                    { parcelId: parcelB1, treatedAreaHa: 4.25 },
                ],
            },
            `parcels-blocks-${TAG}`,
        );

        const lines = await globalPrisma.operationParcel.findMany({
            where: { tenantId, task: { treatmentGroupId: rec.treatmentGroupId } },
            select: { parcelId: true, treatedAreaHa: true, taskId: true },
        });
        const area = new Map(lines.map((l) => [l.parcelId, l.treatedAreaHa]));
        expect(Number(area.get(parcelA1))).toBe(1.5);
        expect(Number(area.get(parcelB1))).toBe(4.25);
        expect(area.get(parcelA2)).toBeNull();
        // And the two really are on different TASKS, or "spans blocks" is not
        // what this test measured. The fan-out writes one task per block, so
        // distinct task ids is the fan-out having happened — `Task` carries no
        // `locationId` of its own, the block link is a `TaskLink` row.
        expect(new Set(lines.map((l) => l.taskId)).size).toBe(2);
        expect(new Set([area.get(parcelA1), area.get(parcelB1)]).size).toBe(2);
    });

    it('refuses an area larger than the parcel', async () => {
        // The fixture's parcels are 10 ha. Asserted here because the storage
        // tests above would happily persist 999 and the register would print a
        // treated area bigger than the field it was applied to.
        await expect(
            recordDiaryTreatment(
                ctx(),
                { ...baseInput(), parcels: [{ parcelId: parcelA1, treatedAreaHa: 999 }] },
                `parcels-over-${TAG}`,
            ),
        ).rejects.toMatchObject({ code: 'TREATMENT_AREA_EXCEEDS_PARCEL' });
    });
});
