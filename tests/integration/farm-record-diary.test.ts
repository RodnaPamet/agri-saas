/**
 * Integration — ДНЕВНИК data gathering prints the right observations.
 *
 * DB-backed proof for the three observation-query rules the
 * farm-record-diary-integrity guardrail locks structurally:
 *   • soft-deleted OBSERVATION entries never reach the printed register;
 *   • entries linked to ANOTHER location are excluded from this field's
 *     register, while unlinked (farm-wide) and this-location entries stay;
 *   • rich-text HTML notes are flattened to plain text in the „Болест"
 *     cell data.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { gatherFarmRecordData } from '@/app-layer/reports/pdf/farm-record-diary';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `frd-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let ownerId = '';
let locationId = '';
let otherLocationId = '';

const ctx = () =>
    makeRequestContext('OWNER', { userId: ownerId, tenantId: TENANT_ID, tenantSlug: TAG });

const FROM = '2026-05-01';
const TO = '2026-05-31';
const IN_PERIOD = new Date('2026-05-10T08:00:00Z');

async function makeObservation(opts: {
    title: string;
    notes?: string | null;
    deletedAt?: Date | null;
    linkLocationId?: string;
}): Promise<string> {
    const entry = await prisma.logEntry.create({
        data: {
            tenantId: TENANT_ID,
            type: 'OBSERVATION',
            status: 'DONE',
            occurredAt: IN_PERIOD,
            title: opts.title,
            notes: opts.notes ?? null,
            deletedAt: opts.deletedAt ?? null,
            createdByUserId: ownerId,
        },
        select: { id: true },
    });
    if (opts.linkLocationId) {
        await prisma.logLocation.create({
            data: {
                tenantId: TENANT_ID,
                logEntryId: entry.id,
                locationId: opts.linkLocationId,
            },
        });
    }
    return entry.id;
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    await prisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: TENANT_ID, slug: TAG },
    });
    const u = await prisma.user.create({
        data: { email: `${TAG}@example.test`, emailHash: hashForLookup(`${TAG}@example.test`) },
    });
    ownerId = u.id;
    await prisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: ownerId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    const loc = await prisma.location.create({
        data: { tenantId: TENANT_ID, name: `Северна нива ${TAG}` },
    });
    locationId = loc.id;
    const other = await prisma.location.create({
        data: { tenantId: TENANT_ID, name: `Южна нива ${TAG}` },
    });
    otherLocationId = other.id;

    await makeObservation({
        title: 'Farm-wide scouting',
        notes: '<p>Брашнеста мана</p><p>по листата &amp; стъблото</p>',
    });
    await makeObservation({
        title: 'Mistaken entry',
        notes: '<p>Погрешно наблюдение</p>',
        deletedAt: new Date(),
    });
    await makeObservation({
        title: 'Other field scouting',
        notes: '<p>Друга нива</p>',
        linkLocationId: otherLocationId,
    });
    await makeObservation({
        title: 'This field scouting',
        notes: '<p>Тази нива</p>',
        linkLocationId: locationId,
    });
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$disconnect();
});

describeFn('ДНЕВНИК observation gathering', () => {
    test('includes live unlinked + this-location entries; excludes soft-deleted and other-location entries', async () => {
        const data = await gatherFarmRecordData(ctx(), locationId, FROM, TO);
        const phenophases = data.observations.map((o) => o.phenophase);
        expect(phenophases).toContain('Farm-wide scouting');
        expect(phenophases).toContain('This field scouting');
        expect(phenophases).not.toContain('Mistaken entry');
        expect(phenophases).not.toContain('Other field scouting');
        expect(data.observations).toHaveLength(2);
    });

    test('flattens rich-text HTML notes to plain text for the „Болест" cell', async () => {
        const data = await gatherFarmRecordData(ctx(), locationId, FROM, TO);
        const farmWide = data.observations.find((o) => o.phenophase === 'Farm-wide scouting');
        expect(farmWide).toBeDefined();
        expect(farmWide!.disease).toBe('Брашнеста мана по листата & стъблото');
        expect(farmWide!.disease).not.toMatch(/<[a-z]/i);
    });

    test('the other field\'s register includes its own linked entry and the farm-wide one', async () => {
        const data = await gatherFarmRecordData(ctx(), otherLocationId, FROM, TO);
        const phenophases = data.observations.map((o) => o.phenophase);
        expect(phenophases).toContain('Other field scouting');
        expect(phenophases).toContain('Farm-wide scouting');
        expect(phenophases).not.toContain('This field scouting');
        expect(phenophases).not.toContain('Mistaken entry');
    });
});

/**
 * «Карантинен срок» comes from the LINE, falling back to the product (#1775).
 *
 * The register's «най-ранна дата за прибиране» is computed from this number,
 * so it has to be the period that applied ON THE DAY. `Item.quarantinePeriodDays`
 * is editable, so reading the product at generation time means a reprint of an
 * already-issued document can silently change — and a farmer who typed a
 * period for a product the farm already had used to have it dropped entirely.
 *
 * Both directions are asserted from ONE generator run, because the fallback is
 * what every line written before the column existed depends on: a fix that
 * preferred the line and lost the fallback would blank the column for the
 * whole existing corpus, which is worse than the drift it replaces.
 */
describeFn('ДНЕВНИК quarantine period: the line first, the product as fallback', () => {
    const Q_TAG = `quar-${randomUUID().slice(0, 8)}`;
    /** What the product says TODAY — the value a reprint would wrongly use. */
    const PRODUCT_PERIOD = 30;
    /** What the farmer stated on the day, captured on the line. */
    const LINE_PERIOD = 7;

    beforeAll(async () => {
        if (!DB_AVAILABLE) return;
        const unit = await prisma.unit.create({
            data: { key: `l-ha-${Q_TAG}`, name: 'L/ha', symbol: 'L/ha', measure: 'RATE' },
        });
        const item = await prisma.item.create({
            data: {
                tenantId: TENANT_ID,
                name: `ПРЗ ${Q_TAG}`,
                category: 'PESTICIDE',
                defaultUnitId: unit.id,
                quarantinePeriodDays: PRODUCT_PERIOD,
            },
        });
        const task = await prisma.task.create({
            data: {
                tenantId: TENANT_ID,
                title: `Пръскане ${Q_TAG}`,
                type: 'FIELD_OPERATION',
                operationType: 'SPRAY',
                createdByUserId: ownerId,
            },
        });
        await prisma.taskLink.create({
            data: {
                tenantId: TENANT_ID,
                taskId: task.id,
                entityType: 'LOCATION',
                entityId: locationId,
            },
        });

        const mkLine = async (name: string, quarantinePeriodDays: number | null) => {
            const parcel = await prisma.parcel.create({
                data: { tenantId: TENANT_ID, locationId, name, cropType: 'Wheat', areaHa: 3 },
            });
            await prisma.operationParcel.create({
                data: {
                    tenantId: TENANT_ID,
                    taskId: task.id,
                    parcelId: parcel.id,
                    productItemId: item.id,
                    doseValue: 2,
                    doseUnitId: unit.id,
                    status: 'DONE',
                    completedAt: IN_PERIOD,
                    targetNote: name,
                    quarantinePeriodDays,
                },
            });
        };
        // Captured on the day…
        await mkLine(`${Q_TAG}-captured`, LINE_PERIOD);
        // …and a line from before the column existed.
        await mkLine(`${Q_TAG}-legacy`, null);
    });

    it('prefers the period captured on the line over the product\'s current one', async () => {
        const data = await gatherFarmRecordData(ctx(), locationId, FROM, TO);
        const row = data.sprayLines.find((l) => l.targetNote === `${Q_TAG}-captured`);
        expect(row).toBeDefined();
        // 7, not 30. Editing the product must not rewrite an issued document.
        expect(row!.quarantineDays).toBe(LINE_PERIOD);
    });

    it('falls back to the product for a line written before the column existed', async () => {
        const data = await gatherFarmRecordData(ctx(), locationId, FROM, TO);
        const row = data.sprayLines.find((l) => l.targetNote === `${Q_TAG}-legacy`);
        expect(row).toBeDefined();
        // NULL on the line means "not captured", never zero — so the whole
        // existing corpus keeps the behaviour it was written under.
        expect(row!.quarantineDays).toBe(PRODUCT_PERIOD);
    });
});
