/**
 * Crop-plan lifecycle + fresh-tenant bootstrap — DB-backed integration test.
 *
 * Proves the surfaces this change wired up actually work end to end:
 *   1. seedDefaultSeason gives a fresh tenant a selectable season
 *      (idempotent — a second call adds nothing), closing the cold-start
 *      that left the create-plan modal on a dead `noSeasons` placeholder.
 *   2. A plan moves through its lifecycle via updateCropPlan
 *      (DRAFT → ACTIVE → COMPLETED) — the transitions the detail-page
 *      status practice drives, and which make the COMPLETED/CANCELLED
 *      filter options reachable.
 *   3. updateSeason edits a season (the newly-wired PATCH path).
 *   4. deleteCropPlan soft-deletes — the plan drops out of listCropPlans /
 *      getCropPlan while its row survives (deletedAt stamped, not a
 *      cascading hard delete).
 *
 * Skipped when DB is unavailable.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { seedDefaultSeason } from '@/app-layer/usecases/planning-defaults';
import {
    createCropPlan,
    updateCropPlan,
    updateSeason,
    deleteCropPlan,
    listCropPlans,
    getCropPlan,
    listSeasons,
} from '@/app-layer/usecases/crop-planning';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `cplife-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let USER_ID = '';
let CROP_TYPE_ID = '';

function ctx() {
    return makeRequestContext(Role.ADMIN, { userId: USER_ID, tenantId: TENANT_ID, tenantSlug: TAG });
}

async function seed() {
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG },
    });
    const email = `${TAG}@example.test`;
    const user = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    USER_ID = user.id;
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: USER_ID, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
    });
    const cropType = await globalPrisma.cropType.create({ data: { tenantId: TENANT_ID, name: 'Radish' } });
    CROP_TYPE_ID = cropType.id;
}

async function teardown() {
    await globalPrisma.planting.deleteMany({ where: { tenantId: TENANT_ID } });
    await globalPrisma.cropPlan.deleteMany({ where: { tenantId: TENANT_ID } });
    await globalPrisma.cropType.deleteMany({ where: { tenantId: TENANT_ID } });
    await globalPrisma.season.deleteMany({ where: { tenantId: TENANT_ID } });
    await globalPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT_ID);
    });
    await globalPrisma.tenantMembership.deleteMany({ where: { tenantId: TENANT_ID } });
    if (USER_ID) await globalPrisma.user.deleteMany({ where: { id: USER_ID } });
    await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

describeFn('crop-plan lifecycle + fresh-tenant bootstrap (DB)', () => {
    beforeAll(async () => {
        await globalPrisma.$connect();
        await seed();
    });
    afterAll(async () => {
        await teardown();
        await globalPrisma.$disconnect();
    });

    it('seedDefaultSeason gives a fresh tenant exactly one season (idempotent)', async () => {
        const first = await seedDefaultSeason(globalPrisma, TENANT_ID);
        const second = await seedDefaultSeason(globalPrisma, TENANT_ID);
        expect(second).toBe(first); // same season id — no duplicate

        const seasons = await listSeasons(ctx());
        expect(seasons.filter((s) => s.key === 'default-season')).toHaveLength(1);
    });

    it('moves a plan through its lifecycle and soft-deletes it', async () => {
        const seasonId = await seedDefaultSeason(globalPrisma, TENANT_ID);

        // Create — starts DRAFT.
        const plan = await createCropPlan(ctx(), {
            seasonId,
            cropTypeId: CROP_TYPE_ID,
            name: 'Lifecycle plan',
            method: 'DIRECT_SOW',
            firstSowDate: '2026-04-01T00:00:00Z',
            successions: 1,
        });
        expect(plan.status).toBe('DRAFT');

        // DRAFT → ACTIVE → COMPLETED (the detail-page status transitions).
        const activated = await updateCropPlan(ctx(), plan.id, { status: 'ACTIVE' });
        expect(activated.status).toBe('ACTIVE');
        const completed = await updateCropPlan(ctx(), plan.id, { status: 'COMPLETED' });
        expect(completed.status).toBe('COMPLETED');

        // Edit a season (the newly-wired updateSeason PATCH path).
        const editedSeason = await updateSeason(ctx(), seasonId, { status: 'CLOSED', name: 'Renamed season' });
        expect(editedSeason.status).toBe('CLOSED');
        expect(editedSeason.name).toBe('Renamed season');

        // Delete — soft-delete: gone from reads, row survives.
        const res = await deleteCropPlan(ctx(), plan.id);
        expect(res).toEqual({ success: true });

        const listed = await listCropPlans(ctx());
        expect(listed.find((p) => p.id === plan.id)).toBeUndefined();
        await expect(getCropPlan(ctx(), plan.id)).rejects.toThrow(/not found/i);

        // The row is still there, just stamped deletedAt (not hard-deleted).
        const raw = await globalPrisma.cropPlan.findUnique({ where: { id: plan.id }, select: { deletedAt: true } });
        expect(raw?.deletedAt).not.toBeNull();
    });
    // ── #1826: updateSeason's window check ────────────────────────────
    //
    // Here and not in tests/unit/crop-planning-refusals-are-coded.test.ts
    // because the check needs the STORED date: a PATCH of `endDate` alone
    // cannot be judged from the request, which is the whole reason
    // createSeason's version did not transfer unchanged. That suite has no
    // database (its own positive control says so), so it covers the
    // parseability half and this covers the window.
    describe('updateSeason refuses an inverted window (#1826)', () => {
        async function freshSeason() {
            const id = randomUUID();
            await globalPrisma.season.create({
                data: {
                    id,
                    tenantId: TENANT_ID,
                    key: `w-${id.slice(0, 8)}`,
                    name: 'Window season',
                    year: 2026,
                    startDate: new Date('2026-03-01T00:00:00Z'),
                    endDate: new Date('2026-09-30T00:00:00Z'),
                },
            });
            return id;
        }

        it('endDate ALONE, moved before the stored startDate — the case with reach', async () => {
            // Needs no malformed input: both values are valid dates and only
            // their relationship is wrong. Comparing only what the request
            // carried would accept this, and the season would then span
            // negative time for every report, diary view and GDD sum.
            const id = await freshSeason();
            await expect(
                updateSeason(ctx(), id, { endDate: '2026-01-15T00:00:00Z' }),
            ).rejects.toThrow(/cannot end before it starts/i);

            // And the row is UNCHANGED — a refusal that had already written
            // would be worse than the gap.
            const row = await globalPrisma.season.findUnique({
                where: { id },
                select: { endDate: true },
            });
            expect(row?.endDate?.toISOString()).toBe('2026-09-30T00:00:00.000Z');
        });

        it('startDate ALONE, moved after the stored endDate', async () => {
            // The mirror. A check that only looked at `endDate` would miss it.
            const id = await freshSeason();
            await expect(
                updateSeason(ctx(), id, { startDate: '2026-12-01T00:00:00Z' }),
            ).rejects.toThrow(/cannot end before it starts/i);
        });

        it('BOTH supplied and inverted', async () => {
            const id = await freshSeason();
            await expect(
                updateSeason(ctx(), id, {
                    startDate: '2026-09-01T00:00:00Z',
                    endDate: '2026-04-01T00:00:00Z',
                }),
            ).rejects.toThrow(/cannot end before it starts/i);
        });

        it('EQUAL dates are accepted — `<`, not `<=`, matching create', async () => {
            // A single-day season is a legal thing to record, and create
            // already allows it. An off-by-one here would refuse it on
            // update only, which is the asymmetry this change exists to
            // remove rather than to invert.
            const id = await freshSeason();
            const out = await updateSeason(ctx(), id, {
                startDate: '2026-05-05T00:00:00Z',
                endDate: '2026-05-05T00:00:00Z',
            });
            expect(out.startDate?.toISOString()).toBe('2026-05-05T00:00:00.000Z');
            expect(out.endDate?.toISOString()).toBe('2026-05-05T00:00:00.000Z');
        });

        it('POSITIVE CONTROL: a legitimate widening still succeeds', async () => {
            // Without this, a check that refused unconditionally would
            // satisfy every case above.
            const id = await freshSeason();
            const out = await updateSeason(ctx(), id, { endDate: '2026-11-30T00:00:00Z' });
            expect(out.endDate?.toISOString()).toBe('2026-11-30T00:00:00.000Z');
        });

        it('a row ALREADY inverted stays readable — refused on write only', async () => {
            // The deliberate limit. Rows in that state are left alone: a
            // migration rewriting somebody's recorded dates to satisfy a new
            // check would be a worse act than the gap. They are still
            // listable, and an update that does not touch the dates is still
            // accepted.
            const id = randomUUID();
            await globalPrisma.season.create({
                data: {
                    id,
                    tenantId: TENANT_ID,
                    key: `inv-${id.slice(0, 8)}`,
                    name: 'Already inverted',
                    year: 2026,
                    startDate: new Date('2026-09-01T00:00:00Z'),
                    endDate: new Date('2026-04-01T00:00:00Z'),
                },
            });

            const listed = await listSeasons(ctx());
            expect(listed.find((x) => x.id === id)).toBeDefined();

            // Touching only the name is NOT refused, even though the stored
            // window is backwards — the check guards the window this request
            // would produce, and this request does not change it.
            //
            // That is a deliberate choice and the alternative is worse:
            // refusing every edit to such a row would leave the operator
            // unable to correct its NAME without first fixing dates they may
            // not know are wrong.
            const renamed = await updateSeason(ctx(), id, { name: 'Still inverted' });
            expect(renamed.name).toBe('Still inverted');

            // But a date edit that leaves it STILL inverted is refused, even
            // though it is an improvement (Apr -> Jun, against a stored
            // start of Sep). The RESULT is judged, not the direction of
            // travel — so correcting such a row means sending a window that
            // is actually valid, in one request or by fixing the start
            // first.
            await expect(
                updateSeason(ctx(), id, { endDate: '2026-06-01T00:00:00Z' }),
            ).rejects.toThrow(/cannot end before it starts/i);

            // And one request that fixes BOTH is accepted, which is the way
            // out.
            const fixed = await updateSeason(ctx(), id, {
                startDate: '2026-03-01T00:00:00Z',
                endDate: '2026-06-01T00:00:00Z',
            });
            expect(fixed.startDate?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
        });
    });
});
