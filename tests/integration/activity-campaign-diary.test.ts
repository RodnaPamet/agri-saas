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
import { farmRecordAbsence } from '@/app-layer/reports/pdf/farm-record-absence';
import { treatmentKindOf } from '@/app-layer/usecases/diary-treatment';
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
    it('Приложение 1 refuses it — a cultivation is not a plant-protection measure', async () => {
        // THE TRIPWIRE FIRED, which is what it was for. This test used to
        // assert `not.toBeNull()` and carried #2697's number, because the
        // register ADMITTED a bare activity: both gatherer branches resolve
        // lines by TASK and `status: 'DONE'` with no product predicate, so a
        // cultivation fell past the single `SEED` skip into the `else` — the
        // ПРОВЕДЕНИ ХИМИЧНИ ОБРАБОТКИ table — and printed as a
        // plant-protection treatment with empty вредител, ПРЗ, доза and
        // карантинен срок columns.
        //
        // #2697 replaced that skip with an ALLOWLIST of what the form has
        // columns for, so the assertion inverts. Kept as one test with its
        // history rather than deleted and rewritten: the previous expectation
        // is the reason this one is worth asserting at all.
        const doc = await generateFarmRecordDiaryPdfScoped(ctx(), {
            kind: 'treatment',
            treatmentGroupId: handle,
        });
        expect(doc).toBeNull();
    });

    it('and says so with NOT_IN_BABH_REGISTER, not TREATMENT_NOT_FOUND', async () => {
        // The second half of #2697, and the one that was lying. `treatmentKindOf`
        // returns the RAW `operationType`, so a cultivation arrived at
        // `farmRecordAbsence` as 'CULTIVATE', missed the `=== 'SEED'` test and
        // fell through to TREATMENT_NOT_FOUND — "No treatment was recorded
        // under that handle", about a record that plainly exists. That is the
        // false statement that function's own docblock was written to avoid,
        // reached by a kind it had not considered.
        const err = await farmRecordAbsence(ctx(), handle);
        expect(err).toMatchObject({ code: 'NOT_IN_BABH_REGISTER' });
        // And it names where the record DOES print, so the refusal is
        // actionable rather than merely correct.
        expect(err.message).toContain('campaign-diary');
    });

    it('a handle that names nothing still answers TREATMENT_NOT_FOUND', async () => {
        // The control for the arm above: widening NOT_IN_BABH_REGISTER to
        // every non-register kind must not swallow the genuine not-found, or a
        // typo'd handle would report "that record is not in this register"
        // about a record that does not exist. `kind !== null` is what keeps
        // them apart.
        const err = await farmRecordAbsence(ctx(), `${TAG}-no-such-handle`);
        expect(err).toMatchObject({ code: 'TREATMENT_NOT_FOUND' });
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


describeFn('#2697 — a row whose operationType PREDATES the column is derived, not reported missing', () => {
    // `treatmentKindOf` ended `return task?.operationType ?? null`, so null
    // meant EITHER "no such handle" OR "a task written before the column
    // existed" — and telling those two apart is the function's entire stated
    // purpose. Its own docblock said "or null when the handle names nothing".
    //
    // The published contract makes the gap reachable rather than theoretical:
    // `kind` on the journal row documents null as "a row whose task predates
    // the column, which the register reads by deriving from the title — treat
    // it as a treatment". A client following that sentence asks for the
    // per-treatment extract and is told the record does not exist, while the
    // register prints the very same row.
    //
    // Both reads now go through `resolveOperationType` — the function
    // `farm-record-diary.ts` already calls on every line — so the register and
    // this route cannot disagree about what a pre-column row is.
    const legacy = `${TAG}-legacy`;

    beforeAll(async () => {
        if (!DB_AVAILABLE) return;
        // `Task.treatmentGroupId` is a plain indexed column with no FK, so
        // these need no TreatmentGroup — fitting, since rows of that era
        // predate the group model as well as the column.
        for (const [suffix, title] of [
            ['spray', 'Spray — Карате Зеон'],
            ['harvest', 'Harvest — пшеница'],
        ] as const) {
            await globalPrisma.task.create({
                data: {
                    tenantId,
                    createdByUserId: userId,
                    type: 'FIELD_OPERATION',
                    title,
                    operationType: null,
                    treatmentGroupId: `${legacy}-${suffix}`,
                },
            });
        }
    });

    it('derives SPRAY from the same title the register derives it from', async () => {
        // THE LOAD-BEARING CONTROL for the assertion below. "A legacy harvest
        // is refused" is satisfied perfectly by a derivation that returns
        // something outside the register for EVERY pre-column row — which
        // would newly refuse every legacy spray in the database and contradict
        // the register, where those rows print. This is the half that fails if
        // the derivation is too broad rather than too narrow.
        expect(await treatmentKindOf(ctx(), `${legacy}-spray`)).toBe('SPRAY');
    });

    it('a legacy harvest answers NOT_IN_BABH_REGISTER, not TREATMENT_NOT_FOUND', async () => {
        // 'OTHER' is what `resolveOperationType` derives from a title it does
        // not recognise, and the register excludes it for the same reason this
        // route refuses it — so the two agree on this row as well.
        expect(await treatmentKindOf(ctx(), `${legacy}-harvest`)).toBe('OTHER');
        const err = await farmRecordAbsence(ctx(), `${legacy}-harvest`);
        expect(err).toMatchObject({ code: 'NOT_IN_BABH_REGISTER' });
        expect(err.message).toContain('campaign-diary');
    });

    it('and null now means exactly one fact — no undeleted task under that handle', async () => {
        // The other half of un-collapsing the `??`. The genuine not-found has
        // to stay reachable, or the fix trades one false statement for another.
        expect(await treatmentKindOf(ctx(), `${legacy}-nope`)).toBeNull();
        await expect(farmRecordAbsence(ctx(), `${legacy}-nope`)).resolves.toMatchObject({
            code: 'TREATMENT_NOT_FOUND',
        });
    });
});
