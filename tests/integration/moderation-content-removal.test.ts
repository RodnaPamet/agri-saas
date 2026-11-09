/**
 * CONTENT_REMOVED removes the content (#2865).
 *
 * ## What was wrong, and why it read as fine
 *
 * `actOnNotice` branched on `actionKind` exactly once — to suspend an account
 * — so `CONTENT_REMOVED` wrote a `ModerationAction`, set the notice to
 * ACTIONED and performed nothing. `statement-dispatch` then composed an Art 17
 * statement of reasons from that very row and delivered «Премахнахме
 * съдържанието.» while the content stayed live. The queue was clear, the
 * notice read ACTIONED, and the notifier saw the thing they reported still
 * there.
 *
 * That is #1635's shape — a recordable, announced outcome with no enforcement
 * — and P5.9 closed it for the account kinds while the content kinds were left
 * behind. Unlike #1635 this one affects the exchange, which is the surface
 * actually reachable in production.
 *
 * ## The property, stated so the controls are visible
 *
 * The outcome cannot be RECORDED without being PERFORMED. So every refusal
 * below asserts that NOTHING was written — no action row and a notice still
 * RECEIVED — rather than merely that the call threw. A transaction that threw
 * after writing the row would satisfy "it refused" and leave exactly the state
 * this is about.
 *
 * And every refusal is paired with the same call on a subject it CAN act on,
 * because a gate that refuses everything is indistinguishable from one that
 * works, and the first draft of a removal path is exactly where that happens.
 */
import { randomUUID } from 'crypto';

import { PrismaClient, ModerationActionKind } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { actOnNotice } from '@/app-layer/usecases/moderation';
import { MODERATION_ACTION_KINDS } from '@/lib/schemas';
import { encryptField } from '@/lib/security/encryption';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

/**
 * RAW, so a column read is the DATABASE's answer and not the extension's — and
 * the adapter is explicit because this client is built by hand rather than
 * taken from `@/lib/prisma`, which is where the extension lives.
 */
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });

const reports: string[] = [];
const actions: string[] = [];
const listings: string[] = [];
const threads: string[] = [];
const messages: string[] = [];

async function makeListing(): Promise<string> {
    const id = `el-2865-${randomUUID()}`;
    await db.$executeRawUnsafe(
        `INSERT INTO "ExchangeListing"
           ("id","sellerTenantId","sellerUserId","side","kind","commodity",
            "quantityTonnes","regionCode","regionName","lat","lon","updatedAt")
         VALUES ($1,$2,$3,'SELL'::"ExchangeSide",'CULTURE'::"ExchangeKind",
                 'wheat',10,'BG-16','Пловдив',42.1,24.7,NOW())`,
        id, `t-2865-${randomUUID()}`, `u-2865-${randomUUID()}`,
    );
    listings.push(id);
    return id;
}

async function makeMessage(): Promise<string> {
    const listingId = await makeListing();
    const threadId = `et-2865-${randomUUID()}`;
    await db.$executeRawUnsafe(
        `INSERT INTO "ExchangeThread"
           ("id","listingId","inquirerTenantId","inquirerUserId","updatedAt")
         VALUES ($1,$2,$3,$4,NOW())`,
        threadId, listingId, `t-2865-i-${randomUUID()}`, `u-2865-i-${randomUUID()}`,
    );
    threads.push(threadId);
    const id = `em-2865-${randomUUID()}`;
    await db.$executeRawUnsafe(
        `INSERT INTO "ExchangeMessage"
           ("id","threadId","senderTenantId","senderUserId","body")
         VALUES ($1,$2,$3,$4,$5)`,
        id, threadId, `t-2865-s-${randomUUID()}`, `u-2865-s-${randomUUID()}`,
        encryptField('нещо нередно'),
    );
    messages.push(id);
    return id;
}

async function fileNotice(subjectKind: string, subjectId: string): Promise<string> {
    const id = `cr-2865-${randomUUID()}`;
    await db.$executeRawUnsafe(
        `INSERT INTO "ContentReport"
           ("id","subjectKind","subjectId","reasonCode","status","detail","reporterUserId")
         VALUES ($1,$2::"ReportSubjectKind",$3,'ILLEGAL_CONTENT'::"ReportReasonCode",
                 'RECEIVED',$4,NULL)`,
        id, subjectKind, subjectId, encryptField('a complaint'),
    );
    reports.push(id);
    return id;
}

async function noticeStatus(id: string): Promise<string> {
    const rows = await db.$queryRawUnsafe<Array<{ s: string }>>(
        `SELECT "status"::text AS s FROM "ContentReport" WHERE "id" = $1`, id,
    );
    return rows[0].s;
}

async function actionCount(reportId: string): Promise<number> {
    const rows = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n FROM "ModerationAction" WHERE "reportId" = $1`, reportId,
    );
    return Number(rows[0].n);
}

async function removedAt(table: string, id: string): Promise<Date | null> {
    const rows = await db.$queryRawUnsafe<Array<{ t: Date | null }>>(
        `SELECT "removedByModerationAt" AS t FROM "${table}" WHERE "id" = $1`, id,
    );
    return rows[0]?.t ?? null;
}

describeFn('CONTENT_REMOVED removes the content (#2865)', () => {
    afterAll(async () => {
        const del = async (t: string, c: string, ids: string[]) => {
            if (ids.length) {
                await db.$executeRawUnsafe(
                    `DELETE FROM "${t}" WHERE "${c}" = ANY($1::text[])`, ids);
            }
        };
        await del('ModerationAction', 'id', actions);
        await del('ContentReport', 'id', reports);
        await del('ExchangeMessage', 'id', messages);
        await del('ExchangeThread', 'id', threads);
        await del('ExchangeListing', 'id', listings);
        await db.$disconnect();
    }, 60_000);

    describe('it performs', () => {
        it('stamps the listing it names, in the same transaction as the decision', async () => {
            const listingId = await makeListing();
            const reportId = await fileNotice('LISTING', listingId);
            // CONTROL: nothing is removed before the decision.
            expect(await removedAt('ExchangeListing', listingId)).toBeNull();

            const { actionId, status } = await actOnNotice({
                reportId, actionKind: 'CONTENT_REMOVED',
                rationale: 'misleading grade', generation: 'current',
            });
            actions.push(actionId);

            expect(status).toBe('ACTIONED');
            // THE PROPERTY. Before #2865 this was null and the statement still
            // said we had removed it.
            expect(await removedAt('ExchangeListing', listingId)).not.toBeNull();
        }, 60_000);

        it('stamps the exchange message it names', async () => {
            const messageId = await makeMessage();
            const reportId = await fileNotice('MESSAGE', messageId);
            expect(await removedAt('ExchangeMessage', messageId)).toBeNull();

            const { actionId } = await actOnNotice({
                reportId, actionKind: 'CONTENT_REMOVED',
                rationale: 'abuse', generation: 'current',
            });
            actions.push(actionId);
            expect(await removedAt('ExchangeMessage', messageId)).not.toBeNull();
        }, 60_000);

        it('leaves `deletedAt` alone — ours is not the sender retracting theirs', async () => {
            const messageId = await makeMessage();
            const reportId = await fileNotice('MESSAGE', messageId);
            const { actionId } = await actOnNotice({
                reportId, actionKind: 'CONTENT_REMOVED',
                rationale: 'abuse', generation: 'current',
            });
            actions.push(actionId);

            const rows = await db.$queryRawUnsafe<Array<{ d: Date | null }>>(
                `SELECT "deletedAt" AS d FROM "ExchangeMessage" WHERE "id" = $1`, messageId,
            );
            // Two columns, two decisions. Collapsing them would make a platform
            // removal indistinguishable from a retraction in the row the Art 17
            // statement is about — and would let a later self-delete overwrite
            // the moderation record.
            expect(rows[0].d).toBeNull();
        }, 60_000);

        it('is IDEMPOTENT — two notices about one listing both close', async () => {
            const listingId = await makeListing();
            const first = await fileNotice('LISTING', listingId);
            const second = await fileNotice('LISTING', listingId);

            const a = await actOnNotice({
                reportId: first, actionKind: 'CONTENT_REMOVED',
                rationale: 'one', generation: 'current',
            });
            actions.push(a.actionId);
            // Two notices about one listing is the ORDINARY case, so the second
            // moderator must be able to close theirs. Refusing an
            // already-removed subject would leave a notice unanswerable.
            const b = await actOnNotice({
                reportId: second, actionKind: 'CONTENT_REMOVED',
                rationale: 'two', generation: 'current',
            });
            actions.push(b.actionId);
            expect(b.status).toBe('ACTIONED');
        }, 60_000);
    });

    describe('it refuses what it cannot perform, and writes NOTHING', () => {
        it('cannot even be asked for CONTENT_DEMOTED — the value is gone', async () => {
            // #2868 DELETED the value (owner decision 2026-11-09), so the
            // refusal moved OUT of `assertPerformable` and into the schema one
            // layer up. This case is kept rather than deleted because the
            // PROPERTY it protects is unchanged: a demotion must never be
            // recorded, since there is no ranking to demote within and the row
            // would announce a sanction that does not exist.
            //
            // It is asserted at both layers it now lives at, because the TS
            // union makes the old call un-writable here — passing the string
            // would not compile, which is a real part of the protection and
            // exactly why it cannot be the whole of it: `tsc` says nothing
            // about a value arriving over HTTP.
            expect(MODERATION_ACTION_KINDS as readonly string[])
                .not.toContain('CONTENT_DEMOTED');
            expect(Object.keys(ModerationActionKind))
                .not.toContain('CONTENT_DEMOTED');

            // And the control, so this is not satisfied by an empty or broken
            // import: the value that REPLACED it as the performable outcome is
            // present in both.
            expect(MODERATION_ACTION_KINDS as readonly string[])
                .toContain('CONTENT_REMOVED');
            expect(Object.keys(ModerationActionKind)).toContain('CONTENT_REMOVED');
        }, 60_000);

        it('refuses CONTENT_REMOVED on a THREAD — nothing here can remove a collection', async () => {
            const reportId = await fileNotice('THREAD', `et-nope-${randomUUID()}`);

            await expect(actOnNotice({
                reportId, actionKind: 'CONTENT_REMOVED',
                rationale: 'r', generation: 'current',
            })).rejects.toMatchObject({ code: 'MODERATION_ACTION_NOT_PERFORMABLE' });
            expect(await actionCount(reportId)).toBe(0);
            expect(await noticeStatus(reportId)).toBe('RECEIVED');
        }, 60_000);

        it('refuses CONTENT_REMOVED on a DIRECT_MESSAGE — owner ruling 2026-11-08', async () => {
            // #2833 made a direct message REPORTABLE and deliberately not
            // REMOVABLE. Owner ruling: suspension is the remedy this release.
            //
            // The enforcement is an ABSENCE — `DIRECT_MESSAGE` is simply not in
            // `REMOVABLE_SUBJECT_KINDS` — which is why this test exists. An
            // absence has no code to read, so nothing else in the repo states
            // that the ruling is in force, and adding the kind to that list
            // would silently make removal available with no arm to perform it.
            // `DirectMessage` has no `removedByModerationAt` column, so there
            // is nothing a removal could even write.
            const reportId = await fileNotice('DIRECT_MESSAGE', `dm-ruled-${randomUUID()}`);

            await expect(actOnNotice({
                reportId, actionKind: 'CONTENT_REMOVED',
                rationale: 'r', generation: 'current',
            })).rejects.toMatchObject({ code: 'MODERATION_ACTION_NOT_PERFORMABLE' });

            expect(await actionCount(reportId)).toBe(0);
            expect(await noticeStatus(reportId)).toBe('RECEIVED');
        }, 60_000);

        it('refuses a subject that is NOT THERE — a statement about content we never had', async () => {
            const reportId = await fileNotice('LISTING', `el-gone-${randomUUID()}`);

            await expect(actOnNotice({
                reportId, actionKind: 'CONTENT_REMOVED',
                rationale: 'r', generation: 'current',
            })).rejects.toMatchObject({ code: 'MODERATION_SUBJECT_GONE' });
            // The notice stays open, which is the right place for it: a
            // moderator can still answer it with NONE, which is what "looked
            // and there was nothing there" means.
            expect(await actionCount(reportId)).toBe(0);
            expect(await noticeStatus(reportId)).toBe('RECEIVED');
        }, 60_000);

        it('still accepts NONE on a notice whose subject is gone — the escape', async () => {
            // THE CONTROL for all three refusals above. Without it, "the gate
            // refuses" is satisfied by a gate that refuses every outcome, and
            // a notice about vanished content would be unanswerable — which
            // would be a worse compliance position than the defect.
            const reportId = await fileNotice('LISTING', `el-gone-${randomUUID()}`);
            const { actionId, status } = await actOnNotice({
                reportId, actionKind: 'NONE',
                rationale: 'nothing there to act on', generation: 'current',
            });
            actions.push(actionId);
            expect(status).toBe('REJECTED');
            expect(await actionCount(reportId)).toBe(1);
        }, 60_000);
    });
});
