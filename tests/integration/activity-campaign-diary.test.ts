/**
 * One activity's page of «Дневник на стопанството», against a real database
 * (#2696).
 *
 * The owner could not print «Обработка на почвата». This file proves the two
 * halves of why: that Приложение 1 genuinely has nothing to print for a bare
 * activity, and that the campaign register does — so the fix is a scope on an
 * existing document rather than a new one.
 *
 * DB-backed because the aggregation is the product: «Обработка на почвата –
 * 12,40 ха» is ONE row summed across the blocks actually worked, and no
 * source scan can tell that from three rows of one parcel each.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { recordFarmActivity } from '@/app-layer/usecases/farm-activity';
import { gatherCampaignDiary } from '@/app-layer/reports/campaign-diary/gather';
import { generateFarmRecordDiaryPdfScoped } from '@/app-layer/reports/pdf/farm-record-diary';
import { currentCampaignLabel } from '@/lib/reports/campaign-window';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `acd-${randomUUID().slice(0, 8)}`;
let userId = '';
let tenantId = '';
let parcelA1 = '';
let parcelB1 = '';
let handle = '';
const occurredOn = new Date(Date.now() - 86_400_000);

const ctx = () => makeRequestContext('OWNER', { userId, tenantId, tenantSlug: `${TAG}-t` });

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await globalPrisma.$connect();
    const email = `${TAG}@ag.test`;
    userId = (await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email), name: 'Diary User' },
    })).id;
    tenantId = (await globalPrisma.tenant.create({ data: { name: `T ${TAG}`, slug: `${TAG}-t` } })).id;
    await globalPrisma.tenantMembership.create({
        data: { tenantId, userId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    const locA = (await globalPrisma.location.create({ data: { tenantId, name: `Block A ${TAG}` } })).id;
    const locB = (await globalPrisma.location.create({ data: { tenantId, name: `Block B ${TAG}` } })).id;
    // 8.0 + 4.4 = 12.4 ha across two blocks, so the summed row is a figure
    // neither parcel carries on its own.
    parcelA1 = (await globalPrisma.parcel.create({
        data: { tenantId, locationId: locA, name: `A1 ${TAG}`, areaHa: 8 },
    })).id;
    parcelB1 = (await globalPrisma.parcel.create({
        data: { tenantId, locationId: locB, name: `B1 ${TAG}`, areaHa: 4.4 },
    })).id;

    const rec = await recordFarmActivity(
        ctx(),
        {
            kind: 'CULTIVATE',
            occurredOn: occurredOn.toISOString().slice(0, 10),
            parcelIds: [parcelA1, parcelB1],
        },
        `${TAG}-cultivate`,
    );
    handle = rec.treatmentGroupId;
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        for (const t of ['LogQuantity', 'LogEntry', 'OperationParcel', 'TaskLink', 'Task', 'TreatmentGroup', 'Parcel', 'Location', 'Notification', 'AuditLog']) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        }
        // See the sibling suite: `LAST_OWNER_GUARD` refuses to remove the only
        // active OWNER, and the FK then restricts the tenant. Tolerated
        // narrowly; anything else propagates.
        try {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, tenantId);
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId);
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId);
        } catch (err) {
            if (!String((err as { message?: string }).message ?? err).includes('LAST_OWNER_GUARD')) throw err;
        }
    } finally {
        await globalPrisma.$disconnect();
    }
});

describeFn('#2696 — an activity prints as a page of «Дневник на стопанството»', () => {
    it('Приложение 1 WRONGLY admits it today — #2697, and this test is its tripwire', async () => {
        // This assertion is the opposite of what I wrote first, and the
        // correction is the reason the route exists at all.
        //
        // I expected null: a cultivation has no spray and no fertiliser lines,
        // and `farm-record-diary.ts` states that "the bare activity kinds
        // (PRUNE/CULTIVATE/HARVEST) never reach this function at all — they
        // have no product, and the gatherer selects on lines that have one."
        // The second clause is FALSE. Both gatherer branches resolve lines by
        // TASK and `status: 'DONE'` with no product predicate, so the
        // cultivation's line IS selected and falls through the SEED guard into
        // the `else` — which is the ПРОВЕДЕНИ ХИМИЧНИ ОБРАБОТКИ table.
        //
        // A non-null document proves it, because the only null path is
        // `sprayLines.length === 0 && fertilizeLines.length === 0` and the
        // cultivation's is the only line under this handle.
        //
        // So the owner's "this can not be printed" was never a 404 from this
        // register — it was the absence of a print button on an activity
        // entry. The register's own answer is worse than a refusal: a
        // cultivation filed as a plant-protection treatment with empty
        // вредител, ПРЗ, доза and карантинен срок columns.
        //
        // PINNED AS-IS so #2697's fix has to come past this test rather than
        // appear to break something. When `CULTIVATE` joins `SEED` in the skip,
        // this becomes `toBeNull()` and the route below becomes the only way
        // to print the record — which is what the treatment route's spec has
        // said all along.
        const doc = await generateFarmRecordDiaryPdfScoped(ctx(), {
            kind: 'treatment',
            treatmentGroupId: handle,
        });
        expect(doc).not.toBeNull();
    });

    it('the campaign register aggregates it into ONE row across both blocks', async () => {
        const data = await gatherCampaignDiary(ctx(), { kind: 'activity', treatmentGroupId: handle });
        // One activity, two blocks, two tasks, two lines — and ONE row. That
        // collapse is the document's whole reason for existing next to
        // Приложение 1, where a row is one line on one parcel.
        expect(data.rows).toHaveLength(1);
        expect(data.rows[0].activity).toContain('Обработка на почвата');
        // 8 + 4.4, formatted the Bulgarian way. `treatedAreaHa` is null on
        // both lines, which the row builder reads as THE WHOLE PARCEL — not
        // zero — so the figure comes from the parcel areas.
        expect(data.rows[0].activity).toContain('12,40');
        expect(data.skippedIncomplete).toBe(0);
    });

    it('prints the campaign the work FALLS IN, derived from its own date', async () => {
        const data = await gatherCampaignDiary(ctx(), { kind: 'activity', treatmentGroupId: handle });
        // An activity carries no campaign label of its own; a blank header
        // cell on a filed document is worse than a derived one.
        expect(data.campaignLabel).toBe(currentCampaignLabel(occurredOn));
    });

    it('a handle naming nothing is ACTIVITY_NOT_FOUND, not an empty page', async () => {
        await expect(
            gatherCampaignDiary(ctx(), { kind: 'activity', treatmentGroupId: `${TAG}-nope` }),
        ).rejects.toMatchObject({ code: 'ACTIVITY_NOT_FOUND' });
    });

    it('still serves a whole CAMPAIGN — the arm that already existed', async () => {
        // Regression guard for the signature change: the campaign route is the
        // only other caller, and a union that broke it would have shipped a
        // 500 on a document the owner already uses.
        const data = await gatherCampaignDiary(ctx(), {
            kind: 'campaign',
            campaignLabel: currentCampaignLabel(occurredOn),
        });
        expect(data.rows.length).toBeGreaterThanOrEqual(1);
        expect(data.campaignLabel).toBe(currentCampaignLabel(occurredOn));
    });

    it('refuses a malformed campaign label, and only on that arm', async () => {
        // `campaignWindow` throws `InvalidCampaignError`, which the campaign
        // ROUTE maps to a 400. The activity arm never parses a label, so a
        // handle shaped like a bad label cannot reach that code path — it
        // answers ACTIVITY_NOT_FOUND like any other unknown handle.
        await expect(
            gatherCampaignDiary(ctx(), { kind: 'campaign', campaignLabel: 'not-a-campaign' }),
        ).rejects.toThrow();
        await expect(
            gatherCampaignDiary(ctx(), { kind: 'activity', treatmentGroupId: 'not-a-campaign' }),
        ).rejects.toMatchObject({ code: 'ACTIVITY_NOT_FOUND' });
    });
});
