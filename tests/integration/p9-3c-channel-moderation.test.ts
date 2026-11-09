/**
 * P9.3c — moderating a channel post, end to end (#2937).
 *
 * File a notice → act on it → the post is actually removed → the Art 17
 * statement is queued → #2867's restore puts it back.
 *
 * ## The chain is asserted END TO END because each link has failed alone
 *
 *   * **#2833** — `captureSnapshot` had no arm for a new kind, so a notice
 *     filed with `SUBJECT_NOT_FOUND` evidence. The response discloses nothing
 *     about the subject by design, so the reporter could not tell that from
 *     success.
 *   * **#2865** — `CONTENT_REMOVED` wrote the action row, moved the notice to
 *     ACTIONED, and `statement-dispatch` delivered «Премахнахме съдържанието.»
 *     while the content stayed live and visible. The outcome was recorded
 *     without being performed.
 *   * **#2868** — `CONTENT_DEMOTED` was a published outcome nothing could
 *     perform at all.
 *
 * So the cases below assert the SUBJECT, not merely the action row: that the
 * post's `removedByModerationAt` is set, and that the feed stops serving its
 * body. An action row plus an ACTIONED notice is exactly what #2865 produced
 * while nothing happened.
 *
 * ## A channel post is PUBLIC, which is the departure from a direct message
 *
 * `DIRECT_MESSAGE` capture asserts the reporter is a PARTICIPANT, because a
 * private message is not publicly accessible content and the capture runs
 * privileged — a crafted id would otherwise pull two strangers' conversation
 * into the queue. A channel post needs no such check: `channel_post_select`
 * admits any authenticated caller, so the reporter could already read every
 * word. Asserted below with a reporter who is NOT a member.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { joinChannel, postToChannel, readChannelFeed } from '@/app-layer/usecases/channels';
import { fileNotice } from '@/app-layer/usecases/trust-safety';
import { actOnNotice, restoreRemovedContent } from '@/app-layer/usecases/moderation';
import type { UserContext } from '@/app-layer/types';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const AUTHOR = `u-p93c-author-${randomUUID()}`;
const OUTSIDER = `u-p93c-reporter-${randomUUID()}`;
let channelId = '';

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

async function aPost(body = 'нещо неприемливо'): Promise<string> {
    const res = await postToChannel(ctxFor(AUTHOR), channelId, { body });
    return res.postId;
}

describeFn('P9.3c — channel post moderation (#2937)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        const c = await prisma.channel.create({
            data: { key: `crop:p93c-${randomUUID()}`, nameBg: 'Пшеница', nameEn: 'W', kind: 'CROP' },
            select: { id: true },
        });
        channelId = c.id;
        await joinChannel(ctxFor(AUTHOR), channelId);
    });

    afterAll(async () => {
        // The notices and actions are tenantless, so they are deleted BY the
        // subject ids this suite created rather than by a tenant cascade.
        const posts = await prisma.channelPost.findMany({
            where: { channelId }, select: { id: true },
        });
        const ids = posts.map((p) => p.id);
        // Statements hang off ACTIONS, so they are collected through them —
        // there is no `subjectId` on a statement to delete by.
        const actions = await prisma.moderationAction.findMany({
            where: { subjectId: { in: ids } }, select: { id: true },
        });
        await prisma.statementOfReasons.deleteMany({
            where: { actionId: { in: actions.map((a) => a.id) } },
        });
        await prisma.moderationAction.deleteMany({ where: { subjectId: { in: ids } } });
        await prisma.contentReport.deleteMany({ where: { subjectId: { in: ids } } });
        await prisma.channel.deleteMany({ where: { id: channelId } });
        await prisma.$disconnect();
    });

    it('a NON-MEMBER can file a notice, and the snapshot carries the words', async () => {
        // The public-content shape. A membership check here would refuse a
        // notice about a post the reporter can read, which is the opposite of
        // what Art 16 asks for.
        const postId = await aPost('това е спам, купете при мен');
        const notice = await fileNotice({ subjectKind: 'CHANNEL_POST', subjectId: postId, reasonCode: 'SPAM' }, OUTSIDER);
        expect(notice.status).toBe('RECEIVED');

        // THE EVIDENCE, which is what #2833 was about: a kind with no capture
        // arm files with SUBJECT_NOT_FOUND and the reporter cannot tell.
        // Read through the APP'S EXTENDED CLIENT, not the raw one this suite
        // uses elsewhere. `ReportSnapshot.body` is in `ENCRYPTED_FIELDS`, and a
        // bare `new PrismaClient()` carries no `$extends` encryption layer — so
        // the raw read returns the `v1:`/`v2:` envelope and an assertion on the
        // plaintext fails for a reason that has nothing to do with the capture.
        // That is P8.6's fixture trap, where a raw write made nothing encrypted
        // and the failure read as a broken MANIFEST.
        //
        // The field is `body`, not `bodyRendered` — that one is on
        // `StatementOfReasons`. My first version used it, TYPECHECKED CLEAN,
        // and failed at runtime as a `PrismaClientValidationError`: the #1597
        // lesson that `tsc` does not validate a Prisma key against the DMMF.
        const { prisma: appPrisma } = await import('@/lib/prisma');
        const snap = await appPrisma.reportSnapshot.findFirst({
            where: { reportId: notice.id },
            select: { body: true, captureError: true },
        });
        expect(snap).not.toBeNull();
        expect(snap!.captureError).toBeNull();
        expect(snap!.body).toContain('това е спам');
        // And the channel is named, so a moderator knows where it was said.
        expect(snap!.body).toContain('Пшеница');
    }, 60_000);

    it('CONTENT_REMOVED actually REMOVES it — the #2865 property', async () => {
        const postId = await aPost('ще бъде премахнато');
        const notice = await fileNotice({ subjectKind: 'CHANNEL_POST', subjectId: postId, reasonCode: 'SPAM' }, OUTSIDER);

        const acted = await actOnNotice({
            reportId: notice.id,
            actionKind: 'CONTENT_REMOVED',
            rationale: 'реклама в канал',
            generation: 'current',
        });
        expect(acted.status).toBe('ACTIONED');

        // THE SUBJECT, not the action row. #2865 wrote the row and moved the
        // notice while the content stayed live — an ACTIONED notice beside an
        // action row is exactly what that defect produced.
        const row = await prisma.channelPost.findUniqueOrThrow({
            where: { id: postId },
            select: { removedByModerationAt: true, body: true, deletedAt: true },
        });
        expect(row.removedByModerationAt).not.toBeNull();
        // The body SURVIVES in the database, so the restore has something to
        // restore; hiding is a read-time decision.
        expect(row.body).toBe('ще бъде премахнато');
        // And it is NOT the author's retraction — three columns, three facts.
        expect(row.deletedAt).toBeNull();

        // The FEED stops serving it, which is what a reader experiences.
        const feed = await readChannelFeed(ctxFor(AUTHOR), channelId, { limit: 100 });
        const seen = feed.posts.find((p) => p.id === postId);
        expect(seen).toBeDefined();
        expect(seen!.deleted).toBe(true);
        expect(seen!.body).toBe('');
    }, 60_000);

    it('queues an Art 17 statement for the AUTHOR', async () => {
        const postId = await aPost('и това');
        const notice = await fileNotice({ subjectKind: 'CHANNEL_POST', subjectId: postId, reasonCode: 'SPAM' }, OUTSIDER);
        const acted = await actOnNotice({
            reportId: notice.id,
            actionKind: 'CONTENT_REMOVED',
            rationale: 'реклама',
            generation: 'current',
        });

        // Linked by ACTION, not by subject: `StatementOfReasons` carries
        // `actionId`, never a `subjectId`. That is deliberate — the subject is
        // denormalised onto `ModerationAction` so an action cannot be recorded
        // against content it was not about, and the statement hangs off the
        // decision rather than off the content.
        const statement = await prisma.statementOfReasons.findFirst({
            where: { actionId: acted.actionId },
            select: { recipientUserId: true, deliveredAt: true },
        });
        expect(statement).not.toBeNull();
        // The AUTHOR, not the reporter: Art 17 explains a decision to the
        // person it was taken about.
        expect(statement!.recipientUserId).toBe(AUTHOR);
        // UNDELIVERED — `statement-dispatch` composes the body at send time in
        // the recipient's language and stamps this then. A statement marked
        // delivered here would hide a compliance gap from the one view that
        // shows it.
        expect(statement!.deliveredAt).toBeNull();
    }, 60_000);

    it('#2867 RESTORES it, and restoring twice writes nothing', async () => {
        const postId = await aPost('ще се върне');
        const notice = await fileNotice({ subjectKind: 'CHANNEL_POST', subjectId: postId, reasonCode: 'SPAM' }, OUTSIDER);
        const acted = await actOnNotice({
            reportId: notice.id,
            actionKind: 'CONTENT_REMOVED',
            rationale: 'грешка',
            generation: 'current',
        });

        const first = await restoreRemovedContent({
            actionId: acted.actionId,
            rationale: 'жалбата е основателна',
            generation: 'current',
        });
        expect(first.restored).toBe(true);

        const row = await prisma.channelPost.findUniqueOrThrow({
            where: { id: postId }, select: { removedByModerationAt: true },
        });
        expect(row.removedByModerationAt).toBeNull();

        // The feed serves it again — the property a reader would notice.
        const feed = await readChannelFeed(ctxFor(AUTHOR), channelId, { limit: 100 });
        const seen = feed.posts.find((p) => p.id === postId);
        expect(seen!.deleted).toBe(false);
        expect(seen!.body).toBe('ще се върне');

        // Twice is `restored: false` and writes nothing — an appeal upheld
        // twice is one appeal, which is #2867's rule.
        const second = await restoreRemovedContent({
            actionId: acted.actionId,
            rationale: 'отново',
            generation: 'current',
        });
        expect(second.restored).toBe(false);
    }, 60_000);

    it('a restore does NOT clear the AUTHOR’s own retraction', async () => {
        // Three removal columns, three facts. A moderator undoing a
        // `deletedAt` would republish something its writer took down.
        const postId = await aPost('авторът го изтри');
        const notice = await fileNotice({ subjectKind: 'CHANNEL_POST', subjectId: postId, reasonCode: 'SPAM' }, OUTSIDER);
        const acted = await actOnNotice({
            reportId: notice.id,
            actionKind: 'CONTENT_REMOVED',
            rationale: 'r',
            generation: 'current',
        });
        await prisma.channelPost.update({
            where: { id: postId }, data: { deletedAt: new Date() },
        });

        await restoreRemovedContent({
            actionId: acted.actionId, rationale: 'r2', generation: 'current',
        });

        const row = await prisma.channelPost.findUniqueOrThrow({
            where: { id: postId },
            select: { removedByModerationAt: true, deletedAt: true },
        });
        expect(row.removedByModerationAt).toBeNull();
        expect(row.deletedAt).not.toBeNull();

        // So the reader still sees it as gone, by the author's choice.
        const feed = await readChannelFeed(ctxFor(AUTHOR), channelId, { limit: 100 });
        expect(feed.posts.find((p) => p.id === postId)!.deleted).toBe(true);
    }, 60_000);
});
