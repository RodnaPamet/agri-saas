/**
 * P9.10 (#2944) — every removal carries a statement of reasons, DERIVED.
 *
 * ## Why derived, and what went wrong without it
 *
 * `actOnNotice` resolves a recipient and then guards the queue:
 *
 *     if (recipientUserId) { await queueStatementForAction({ … }); }
 *
 * So a subject kind that `resolveContentRecipient` has no arm for resolves to
 * `null`, the statement is skipped, and NOTHING ERRORS. The notice reads
 * ACTIONED, the content is removed, and the author is never told why.
 *
 * That is not hypothetical. `REMOVABLE_SUBJECT_KINDS` gained `CHANNEL_POST` in
 * P9.3c and the matching arm in `statement-queue.ts` was a separate change;
 * between them a channel post could be removed with no Art 17 statement
 * queued, silently. #2955 tracks the structural guard; this is the
 * behavioural half the criterion asks for — "asserted end-to-end, not
 * structurally".
 *
 * It is #2865's shape INVERTED. There the outcome was recorded without being
 * PERFORMED; here it is performed without being EXPLAINED. Both are a
 * statement and a reality that disagree, and the Art 17 duty is breached
 * either way.
 *
 * ## The population is the CONSTANT, not a list written here
 *
 * `REMOVABLE_SUBJECT_KINDS` is imported and iterated. A fourth removable kind
 * therefore fails this file until it has both a fixture and a recipient arm —
 * which is the whole point, because a list retyped here would go stale exactly
 * when it mattered. `FIXTURE_KINDS` is asserted to COVER the constant for the
 * same reason: a kind with no fixture must fail loudly rather than silently
 * contribute no test.
 *
 * ## Every assertion is a COUNT or an id, never "it did not throw"
 *
 * A statement queued for the wrong person is worse than none — it tells
 * somebody their content was removed when it was not. So the recipient is
 * compared, not merely counted. And the paired positive matters as much as the
 * negative: a `queueStatementForAction` that fired for everybody would satisfy
 * "a statement exists" while being a disclosure bug.
 */
import { randomUUID } from 'crypto';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { actOnNotice, REMOVABLE_SUBJECT_KINDS } from '@/app-layer/usecases/moderation';
import { encryptField } from '@/lib/security/encryption';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

/** RAW: a column read is the DATABASE's answer, not the extension's. */
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });

const SFX = randomUUID().slice(0, 8);
const made: Record<string, string[]> = {
    ModerationAction: [], StatementOfReasons: [], ContentReport: [],
    ChannelPost: [], Channel: [], ExchangeMessage: [], ExchangeThread: [], ExchangeListing: [],
};
const track = (table: string, id: string) => { made[table].push(id); return id; };

/** What one removable subject looks like to this test. */
interface Subject {
    readonly subjectId: string;
    /** The person the statement must reach — the content's author/owner. */
    readonly ownerUserId: string;
    /** Where `removedByModerationAt` is stamped. */
    readonly table: string;
}

async function makeListing(): Promise<Subject> {
    const id = track('ExchangeListing', `el-p910-${SFX}-${randomUUID().slice(0, 8)}`);
    const ownerUserId = `u-p910-${SFX}-seller-${randomUUID().slice(0, 8)}`;
    await db.$executeRawUnsafe(
        `INSERT INTO "ExchangeListing"
           ("id","sellerTenantId","sellerUserId","side","kind","commodity",
            "quantityTonnes","regionCode","regionName","lat","lon","updatedAt")
         VALUES ($1,$2,$3,'SELL'::"ExchangeSide",'CULTURE'::"ExchangeKind",
                 'wheat',10,'BG-16','Пловдив',42.1,24.7,NOW())`,
        id, `t-p910-${SFX}-${randomUUID().slice(0, 8)}`, ownerUserId,
    );
    return { subjectId: id, ownerUserId, table: 'ExchangeListing' };
}

async function makeMessage(): Promise<Subject> {
    const listing = await makeListing();
    const threadId = track('ExchangeThread', `et-p910-${SFX}-${randomUUID().slice(0, 8)}`);
    await db.$executeRawUnsafe(
        `INSERT INTO "ExchangeThread"
           ("id","listingId","inquirerTenantId","inquirerUserId","updatedAt")
         VALUES ($1,$2,$3,$4,NOW())`,
        threadId, listing.subjectId,
        `t-p910-${SFX}-i-${randomUUID().slice(0, 8)}`, `u-p910-${SFX}-i-${randomUUID().slice(0, 8)}`,
    );
    const id = track('ExchangeMessage', `em-p910-${SFX}-${randomUUID().slice(0, 8)}`);
    // The SENDER is the recipient of the statement — not the listing's seller.
    // Getting this wrong tells the wrong farm their message was removed.
    const ownerUserId = `u-p910-${SFX}-sender-${randomUUID().slice(0, 8)}`;
    await db.$executeRawUnsafe(
        `INSERT INTO "ExchangeMessage"
           ("id","threadId","senderTenantId","senderUserId","body")
         VALUES ($1,$2,$3,$4,$5)`,
        id, threadId, `t-p910-${SFX}-s-${randomUUID().slice(0, 8)}`, ownerUserId,
        encryptField('нещо нередно'),
    );
    return { subjectId: id, ownerUserId, table: 'ExchangeMessage' };
}

async function makeChannelPost(): Promise<Subject> {
    const channelId = track('Channel', `ch-p910-${SFX}-${randomUUID().slice(0, 8)}`);
    await db.$executeRawUnsafe(
        `INSERT INTO "Channel"("id","key","nameBg","nameEn","kind","updatedAt")
         VALUES ($1,$2,'Пшеница','Wheat','CROP',NOW())`,
        channelId, `crop:p910-${SFX}-${randomUUID().slice(0, 8)}`,
    );
    const id = track('ChannelPost', `cp-p910-${SFX}-${randomUUID().slice(0, 8)}`);
    const ownerUserId = `u-p910-${SFX}-author-${randomUUID().slice(0, 8)}`;
    await db.$executeRawUnsafe(
        `INSERT INTO "ChannelPost"("id","channelId","authorUserId","body","updatedAt")
         VALUES ($1,$2,$3,'добра реколта',NOW())`,
        id, channelId, ownerUserId,
    );
    return { subjectId: id, ownerUserId, table: 'ChannelPost' };
}

const FIXTURES: Record<string, () => Promise<Subject>> = {
    LISTING: makeListing,
    MESSAGE: makeMessage,
    CHANNEL_POST: makeChannelPost,
};

async function fileNotice(subjectKind: string, subjectId: string): Promise<string> {
    const id = track('ContentReport', `cr-p910-${SFX}-${randomUUID().slice(0, 8)}`);
    await db.$executeRawUnsafe(
        `INSERT INTO "ContentReport"
           ("id","subjectKind","subjectId","reasonCode","status","detail","reporterUserId")
         VALUES ($1,$2::"ReportSubjectKind",$3,'ILLEGAL_CONTENT'::"ReportReasonCode",
                 'RECEIVED',$4,NULL)`,
        id, subjectKind, subjectId, encryptField('a complaint'),
    );
    return id;
}

async function statementsFor(reportId: string): Promise<Array<{ recipientUserId: string; id: string }>> {
    return db.$queryRawUnsafe(
        `SELECT s."id", s."recipientUserId"
           FROM "StatementOfReasons" s
           JOIN "ModerationAction" a ON a."id" = s."actionId"
          WHERE a."reportId" = $1`,
        reportId,
    );
}

describeFn('P9.10 — every removal carries a statement of reasons (#2944)', () => {
    afterAll(async () => {
        // FK order, and `StatementOfReasons` before `ModerationAction`.
        for (const table of [
            'StatementOfReasons', 'ModerationAction', 'ContentReport',
            'ChannelPost', 'Channel', 'ExchangeMessage', 'ExchangeThread', 'ExchangeListing',
        ]) {
            const ids = made[table];
            if (table === 'StatementOfReasons' || table === 'ModerationAction') {
                await db.$executeRawUnsafe(
                    `DELETE FROM "${table}" WHERE "id" LIKE $1`, `%-p910-${SFX}-%`);
                continue;
            }
            if (ids.length) {
                await db.$executeRawUnsafe(
                    `DELETE FROM "${table}" WHERE "id" = ANY($1::text[])`, ids);
            }
        }
        await db.$disconnect();
    }, 60_000);

    it('THE DERIVATION — every removable kind has a fixture here', () => {
        // Without this a kind added to the constant contributes NO test and
        // the file still passes, which is the failure mode the derivation
        // exists to prevent. A fourth kind fails here first, with a message
        // that names it.
        const covered = Object.keys(FIXTURES).sort();
        expect(covered).toEqual([...REMOVABLE_SUBJECT_KINDS].sort());
        // And the population is non-empty, so the `it.each` below is not
        // ranging over nothing — an empty population passes every assertion
        // it contains.
        expect(REMOVABLE_SUBJECT_KINDS.length).toBeGreaterThan(0);
    });

    it.each([...REMOVABLE_SUBJECT_KINDS])(
        '%s — removing it queues a statement, to the content OWNER',
        async (kind) => {
            const subject = await FIXTURES[kind]();
            const reportId = await fileNotice(kind, subject.subjectId);

            const result = await actOnNotice({
                reportId,
                actionKind: 'CONTENT_REMOVED',
                rationale: 'нарушава правилата',
                actor: { kind: 'platform-key', generation: 'current' },
            });
            expect(result).toBeTruthy();

            // (a) PERFORMED — #2865's half. A statement about a removal that
            // did not happen is the defect this criterion's sibling closed.
            const removed = await db.$queryRawUnsafe<Array<{ t: Date | null }>>(
                `SELECT "removedByModerationAt" AS t FROM "${subject.table}" WHERE "id" = $1`,
                subject.subjectId,
            );
            expect(removed[0]?.t).toBeInstanceOf(Date);

            // (b) EXPLAINED — this criterion's half.
            const statements = await statementsFor(reportId);
            expect(statements).toHaveLength(1);
            // NAMED, not just counted: a statement to the wrong person tells
            // somebody their content was removed when it was not.
            expect(statements[0].recipientUserId).toBe(subject.ownerUserId);
        },
        120_000,
    );

    it('a REJECTED notice (actionKind NONE) queues NO statement — the control', async () => {
        // Without this, a `queueStatementForAction` that fired unconditionally
        // would satisfy every assertion above while telling people their
        // content was removed when a moderator looked and did nothing.
        const subject = await makeListing();
        const reportId = await fileNotice('LISTING', subject.subjectId);

        await actOnNotice({
            reportId,
            actionKind: 'NONE',
            rationale: 'разгледано, няма нарушение',
            actor: { kind: 'platform-key', generation: 'current' },
        });

        expect(await statementsFor(reportId)).toHaveLength(0);
        // And the content is untouched — "looked and did nothing" must not
        // remove anything.
        const removed = await db.$queryRawUnsafe<Array<{ t: Date | null }>>(
            `SELECT "removedByModerationAt" AS t FROM "ExchangeListing" WHERE "id" = $1`,
            subject.subjectId,
        );
        expect(removed[0]?.t).toBeNull();
    }, 120_000);
});
