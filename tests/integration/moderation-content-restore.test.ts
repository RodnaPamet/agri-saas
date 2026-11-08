/**
 * A removal can be reversed — #2867.
 *
 * #2865 made `CONTENT_REMOVED` stamp `removedByModerationAt`, nullable
 * precisely so an upheld appeal could clear it. Nothing could: the only route
 * was a DBA running an UPDATE, which is the gap `liftSuspension` closed for the
 * account kinds (#1676) — reversible in the data long before it was reversible
 * through an interface.
 *
 * ## What this suite is for
 *
 * The restore is three outcomes and only one of them writes, so the assertions
 * are mostly about the two that must NOT:
 *
 *   the subject is GONE        refuse, write nothing
 *   it is already visible      succeed, write nothing, queue no statement
 *   it was hidden              clear the column, one action row, one statement
 *
 * Every refusal asserts the ABSENCE of a second `ModerationAction` and of a
 * second `StatementOfReasons`, not merely that the call threw — a transaction
 * that threw after writing would satisfy "it refused" and leave an extra "we
 * have restored it" letter queued to somebody.
 *
 * And every refusal is paired with the same call on something it CAN reverse,
 * because a verb that refused everything would satisfy all of them.
 */
import { randomUUID } from 'crypto';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { actOnNotice, restoreRemovedContent } from '@/app-layer/usecases/moderation';
import { encryptField } from '@/lib/security/encryption';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SFX = randomUUID().slice(0, 8);
const SELLER = `u-rs-seller-${SFX}`;

const reports: string[] = [];
const actions: string[] = [];
const listings: string[] = [];
const statements: string[] = [];

async function makeListing(): Promise<string> {
    const id = `el-rs-${randomUUID()}`;
    await db.$executeRawUnsafe(
        `INSERT INTO "ExchangeListing"
           ("id","sellerTenantId","sellerUserId","side","kind","commodity",
            "quantityTonnes","regionCode","regionName","lat","lon","updatedAt")
         VALUES ($1,$2,$3,'SELL'::"ExchangeSide",'CULTURE'::"ExchangeKind",
                 'wheat',10,'BG-16','Пловдив',42.1,24.7,NOW())`,
        id, `t-rs-${randomUUID()}`, SELLER,
    );
    listings.push(id);
    return id;
}

async function fileNotice(subjectId: string): Promise<string> {
    const id = `cr-rs-${randomUUID()}`;
    await db.$executeRawUnsafe(
        `INSERT INTO "ContentReport"
           ("id","subjectKind","subjectId","reasonCode","status","detail","reporterUserId")
         VALUES ($1,'LISTING',$2,'ILLEGAL_CONTENT'::"ReportReasonCode",
                 'RECEIVED',$3,NULL)`,
        id, subjectId, encryptField('a complaint'),
    );
    reports.push(id);
    return id;
}

/** Remove a listing through the real verb, returning its action id. */
async function removeOne(): Promise<{ listingId: string; actionId: string; reportId: string }> {
    const listingId = await makeListing();
    const reportId = await fileNotice(listingId);
    const { actionId } = await actOnNotice({
        reportId, actionKind: 'CONTENT_REMOVED',
        rationale: 'misleading grade', generation: 'current',
    });
    actions.push(actionId);
    return { listingId, actionId, reportId };
}

async function removedAt(listingId: string): Promise<Date | null> {
    const rows = await db.$queryRawUnsafe<Array<{ t: Date | null }>>(
        `SELECT "removedByModerationAt" AS t FROM "ExchangeListing" WHERE "id" = $1`,
        listingId,
    );
    return rows[0]?.t ?? null;
}

async function actionCount(reportId: string, kind: string): Promise<number> {
    const rows = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n FROM "ModerationAction"
          WHERE "reportId" = $1 AND "actionKind" = $2::"ModerationActionKind"`,
        reportId, kind,
    );
    return Number(rows[0].n);
}

async function statementCount(actionId: string): Promise<number> {
    const rows = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n FROM "StatementOfReasons" WHERE "actionId" = $1`,
        actionId,
    );
    return Number(rows[0].n);
}

async function noticeStatus(reportId: string): Promise<string> {
    const rows = await db.$queryRawUnsafe<Array<{ s: string }>>(
        `SELECT "status"::text AS s FROM "ContentReport" WHERE "id" = $1`, reportId,
    );
    return rows[0].s;
}

describeFn('a content removal can be reversed (#2867)', () => {
    beforeAll(async () => {
        const email = `rs-${SFX}@example.test`;
        await db.$executeRawUnsafe(
            `INSERT INTO "User"("id","emailEncrypted","emailHash","updatedAt","uiLanguage")
             VALUES ($1,$2,$3,NOW(),'bg')`,
            SELLER, encryptField(email), `h-${SFX}`,
        );
    }, 60_000);

    afterAll(async () => {
        const del = async (t: string, c: string, ids: string[]) => {
            if (ids.length) {
                await db.$executeRawUnsafe(
                    `DELETE FROM "${t}" WHERE "${c}" = ANY($1::text[])`, ids);
            }
        };
        await del('StatementOfReasons', 'id', statements);
        if (reports.length) {
            await db.$executeRawUnsafe(
                `DELETE FROM "StatementOfReasons" WHERE "actionId" IN
                   (SELECT "id" FROM "ModerationAction" WHERE "reportId" = ANY($1::text[]))`,
                reports,
            );
            await db.$executeRawUnsafe(
                `DELETE FROM "ModerationAction" WHERE "reportId" = ANY($1::text[])`, reports);
        }
        await del('ContentReport', 'id', reports);
        await del('ExchangeListing', 'id', listings);
        await db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, SELLER);
        await db.$disconnect();
    }, 60_000);

    describe('it restores', () => {
        it('clears the column, records a SECOND action, and queues the follow-up', async () => {
            const { listingId, actionId, reportId } = await removeOne();
            // CONTROL: it was hidden to begin with, so "visible afterwards" is
            // a change rather than the state it started in.
            expect(await removedAt(listingId)).not.toBeNull();

            const out = await restoreRemovedContent({
                actionId, rationale: 'appeal upheld — the grade was right',
                generation: 'current',
            });
            expect(out.restored).toBe(true);
            expect(out.restoreActionId).not.toBeNull();
            actions.push(out.restoreActionId!);

            // THE PROPERTY.
            expect(await removedAt(listingId)).toBeNull();
            // A SECOND row, not a mutation of the first: #1619 appends a chain
            // entry per action, so rewriting the original's kind would leave
            // the chain asserting a decision the table no longer holds.
            expect(await actionCount(reportId, 'CONTENT_REMOVED')).toBe(1);
            expect(await actionCount(reportId, 'CONTENT_RESTORED')).toBe(1);
            // The Art 17 FOLLOW-UP: the person was told we removed it, so they
            // are owed the correction.
            expect(await statementCount(out.restoreActionId!)).toBe(1);
        }, 60_000);

        it('leaves the notice ACTIONED — it WAS acted on', async () => {
            const { actionId, reportId } = await removeOne();
            const out = await restoreRemovedContent({
                actionId, rationale: 'appeal upheld', generation: 'current',
            });
            actions.push(out.restoreActionId!);
            // Moving it back to RECEIVED would put a decided notice into the
            // triage queue and ask a moderator to decide it again. The
            // reversal is recorded by the second action row, not by rewinding
            // the notice.
            expect(await noticeStatus(reportId)).toBe('ACTIONED');
        }, 60_000);

        it('is IDEMPOTENT and writes NOTHING the second time', async () => {
            const { listingId, actionId, reportId } = await removeOne();
            const first = await restoreRemovedContent({
                actionId, rationale: 'appeal upheld', generation: 'current',
            });
            actions.push(first.restoreActionId!);

            const second = await restoreRemovedContent({
                actionId, rationale: 'appeal upheld again', generation: 'current',
            });
            // SUCCEEDS — a moderator closing a second appeal has done nothing
            // wrong — and says nothing changed.
            expect(second.restored).toBe(false);
            expect(second.restoreActionId).toBeNull();
            expect(await removedAt(listingId)).toBeNull();
            // ONE action and ONE statement. A row per call would put an
            // unbounded number of identical "we have restored it" letters in
            // front of one person. This is NOT the #2865 case, where two
            // notices about one listing are two genuine decisions and both get
            // their row.
            expect(await actionCount(reportId, 'CONTENT_RESTORED')).toBe(1);
            expect(await statementCount(first.restoreActionId!)).toBe(1);
        }, 60_000);
    });

    describe('it refuses what it cannot reverse, and writes NOTHING', () => {
        it('refuses an action that is not a removal', async () => {
            const listingId = await makeListing();
            const reportId = await fileNotice(listingId);
            const { actionId } = await actOnNotice({
                reportId, actionKind: 'NONE',
                rationale: 'looked, did nothing', generation: 'current',
            });
            actions.push(actionId);

            await expect(restoreRemovedContent({
                actionId, rationale: 'r', generation: 'current',
            })).rejects.toMatchObject({ code: 'MODERATION_ACTION_NOT_REVERSIBLE' });

            // `NONE` removed nothing, so a restore would be a reversal of
            // nothing — announced to somebody by an Art 17 statement.
            expect(await actionCount(reportId, 'CONTENT_RESTORED')).toBe(0);
        }, 60_000);

        it('refuses an action id nothing has', async () => {
            await expect(restoreRemovedContent({
                actionId: `ma-nope-${randomUUID()}`, rationale: 'r', generation: 'current',
            })).rejects.toMatchObject({ code: 'MODERATION_ACTION_NOT_FOUND' });
        }, 60_000);

        it('refuses when the subject is GONE, and the action stands', async () => {
            const { listingId, actionId, reportId } = await removeOne();
            await db.$executeRawUnsafe(
                `DELETE FROM "ExchangeListing" WHERE "id" = $1`, listingId);

            await expect(restoreRemovedContent({
                actionId, rationale: 'appeal upheld', generation: 'current',
            })).rejects.toMatchObject({ code: 'MODERATION_SUBJECT_GONE' });

            // Nothing written. A restore recorded against content that no
            // longer exists would send "we have restored it" about a listing
            // nobody can see.
            expect(await actionCount(reportId, 'CONTENT_RESTORED')).toBe(0);
            // And the removal's own row is untouched — this verb never mutates
            // the action it reverses, including on a refusal.
            expect(await actionCount(reportId, 'CONTENT_REMOVED')).toBe(1);
        }, 60_000);

        it('CONTROL — the same call still restores something it can', async () => {
            // Without this, all three refusals above are satisfied by a verb
            // that refuses everything, and an appeal process that can never
            // succeed is worse than the gap #2867 was filed for.
            const { listingId, actionId } = await removeOne();
            const out = await restoreRemovedContent({
                actionId, rationale: 'appeal upheld', generation: 'current',
            });
            actions.push(out.restoreActionId!);
            expect(out.restored).toBe(true);
            expect(await removedAt(listingId)).toBeNull();
        }, 60_000);
    });
});
