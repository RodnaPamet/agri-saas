/**
 * #2833 — a direct message is reportable, and only by a PARTICIPANT.
 *
 * Before this, `captureSnapshot` resolved `MESSAGE` against `exchangeMessage`
 * alone, so a notice about a DM filed with `SUBJECT_NOT_FOUND` evidence. The
 * reporter gets `{ id, status }` by design, disclosing nothing about the
 * subject — so a successful report and an evidence-less one were identical from
 * their side, and the moderator opened a queue item with nothing in it. That is
 * worse than not offering the control, which is why P8.4 shipped the DM view
 * with block and without report.
 *
 * ## The property that needs a test, and it is not "the body is captured"
 *
 * `captureSnapshot` runs on the PRIVILEGED client. Every other subject kind is
 * something the reporter could see anyway — a listing is public, an exchange
 * message is in a thread they are party to. A direct message is not. So a
 * crafted id would capture two strangers' private conversation into the
 * moderation queue, and because the response is uniform the reporter would
 * never know it had worked. The notice form becomes a read oracle whose answer
 * is delivered to a moderator.
 *
 * Hence the shape of this suite: every refusal is asserted as a COMPARISON
 * against the same call made by somebody entitled to it, because "it was
 * refused" is not the property — "it is indistinguishable" is.
 */
import { randomUUID } from 'crypto';

import { prisma } from '@/lib/prisma';
import { fileNotice } from '@/app-layer/usecases/trust-safety';
import { sendDirectMessage } from '@/app-layer/usecases/direct-messages';
import type { UserContext } from '@/app-layer/types';

import { DB_AVAILABLE } from './db-helper';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SFX = randomUUID().slice(0, 8);
const ALICE = `u-p87r-alice-${SFX}`;
const BORIS = `u-p87r-boris-${SFX}`;
const STRANGER = `u-p87r-stranger-${SFX}`;
const CONV = `cv-p87r-${SFX}`;

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

async function snapshotFor(reportId: string) {
    return prisma.reportSnapshot.findFirstOrThrow({
        where: { reportId },
        select: { body: true, captureError: true, subjectKind: true, subjectId: true },
    });
}

describeFn('#2833 — reporting a DIRECT message', () => {
    let messageId = '';

    beforeAll(async () => {
        await prisma.conversation.create({
            data: {
                id: CONV,
                state: 'ACCEPTED',
                initiatedByUserId: ALICE,
                lastMessageAt: new Date(),
                participants: {
                    create: [
                        { id: `cp-ra-${SFX}`, userId: ALICE },
                        { id: `cp-rb-${SFX}`, userId: BORIS },
                    ],
                },
            },
        });
        const sent = await sendDirectMessage(ctxFor(ALICE), {
            conversationId: CONV,
            body: 'Ще ти счупя главата, ако не платиш.',
        });
        messageId = sent.messageId;
    }, 60_000);

    afterAll(async () => {
        const ids = (
            await prisma.contentReport.findMany({
                where: { subjectId: messageId },
                select: { id: true },
            })
        ).map((r) => r.id);
        await prisma.reportSnapshot.deleteMany({ where: { reportId: { in: ids } } });
        await prisma.contentReport.deleteMany({ where: { id: { in: ids } } });
        await prisma.directMessage.deleteMany({ where: { conversationId: CONV } });
        await prisma.conversationParticipant.deleteMany({ where: { conversationId: CONV } });
        await prisma.conversation.deleteMany({ where: { id: CONV } });
    }, 60_000);

    it('a PARTICIPANT captures the message body as evidence — the positive control', async () => {
        // Without this the refusals below all pass over a resolver that
        // captures nothing for anybody, which is the state #2833 describes.
        const filed = await fileNotice(
            { subjectKind: 'DIRECT_MESSAGE', subjectId: messageId, reasonCode: 'HARASSMENT_OR_HATE' },
            BORIS,
        );
        const snap = await snapshotFor(filed.id);

        expect(snap.captureError).toBeNull();
        expect(snap.body).toContain('Ще ти счупя главата');
        expect(snap.body).toContain(`sender: ${ALICE}`);
        // PLAINTEXT, not `v2:…`. The capture goes through the Prisma client
        // extension; a raw read would store a confident snapshot of ciphertext
        // (the P8.5 lesson).
        expect(snap.body).not.toMatch(/^v[12]:/);
        expect(snap.subjectKind).toBe('DIRECT_MESSAGE');
    }, 60_000);

    it('a STRANGER captures NOTHING, and cannot tell that from success', async () => {
        const mine = await fileNotice(
            { subjectKind: 'DIRECT_MESSAGE', subjectId: messageId, reasonCode: 'HARASSMENT_OR_HATE' },
            BORIS,
        );
        const theirs = await fileNotice(
            { subjectKind: 'DIRECT_MESSAGE', subjectId: messageId, reasonCode: 'HARASSMENT_OR_HATE' },
            STRANGER,
        );

        // THE RESPONSE IS THE PROPERTY. Compared field by field rather than
        // asserted to be "a success", because a difference anywhere here is the
        // oracle — and the status is what a caller would diff first.
        expect(Object.keys(theirs).sort()).toEqual(Object.keys(mine).sort());
        expect(theirs.status).toBe(mine.status);
        expect(theirs.id).not.toBe(mine.id);

        // And the evidence is where the difference lives, visible only to a
        // moderator.
        const strangerSnap = await snapshotFor(theirs.id);
        expect(strangerSnap.captureError).toBe('SUBJECT_NOT_VISIBLE_TO_REPORTER');
        expect(strangerSnap.body).toBe('');
        expect(strangerSnap.body).not.toContain('главата');
    }, 60_000);

    it('an ANONYMOUS notice captures nothing — there is no principal to check', async () => {
        // The route refuses this kind outright; this is the usecase's own
        // backstop, asserted separately so that removing the route check
        // downgrades the evidence rather than capturing a stranger's message.
        const filed = await fileNotice(
            { subjectKind: 'DIRECT_MESSAGE', subjectId: messageId, reasonCode: 'HARASSMENT_OR_HATE' },
            null,
        );
        const snap = await snapshotFor(filed.id);
        expect(snap.captureError).toBe('SUBJECT_REQUIRES_A_REPORTER');
        expect(snap.body).toBe('');
    }, 60_000);

    it('a DELETED message is not captured, even for a participant', async () => {
        const sent = await sendDirectMessage(ctxFor(ALICE), {
            conversationId: CONV,
            body: 'ще бъде изтрито',
        });
        await prisma.directMessage.update({
            where: { id: sent.messageId },
            data: { deletedAt: new Date() },
        });

        const filed = await fileNotice(
            { subjectKind: 'DIRECT_MESSAGE', subjectId: sent.messageId, reasonCode: 'HARASSMENT_OR_HATE' },
            BORIS,
        );
        const snap = await snapshotFor(filed.id);
        // P5.3's rule. The row still HOLDS the plaintext until a retraction
        // overwrites it, so this is a refusal to look rather than an absence of
        // anything to see — and `SUBJECT_DELETED` says which.
        expect(snap.captureError).toBe('SUBJECT_DELETED');
        expect(snap.body).toBe('');

        await prisma.reportSnapshot.deleteMany({ where: { reportId: filed.id } });
        await prisma.contentReport.deleteMany({ where: { id: filed.id } });
    }, 60_000);

    it('an id that is not a direct message at all is SUBJECT_NOT_FOUND', async () => {
        const filed = await fileNotice(
            { subjectKind: 'DIRECT_MESSAGE', subjectId: `dm-nope-${SFX}`, reasonCode: 'SPAM' },
            BORIS,
        );
        const snap = await snapshotFor(filed.id);
        expect(snap.captureError).toBe('SUBJECT_NOT_FOUND');

        await prisma.reportSnapshot.deleteMany({ where: { reportId: filed.id } });
        await prisma.contentReport.deleteMany({ where: { id: filed.id } });
    }, 60_000);

    it('the snapshot is CIPHERTEXT at rest, with the row count beside it', async () => {
        const filed = await fileNotice(
            { subjectKind: 'DIRECT_MESSAGE', subjectId: messageId, reasonCode: 'HARASSMENT_OR_HATE' },
            BORIS,
        );
        const raw = await prisma.$queryRawUnsafe<Array<{ body: string }>>(
            'SELECT body FROM "ReportSnapshot" WHERE "reportId" = $1',
            filed.id,
        );
        // The count is asserted because "zero plaintext rows" over an empty set
        // is zero and passes vacuously.
        expect(raw).toHaveLength(1);
        expect(raw[0].body).toMatch(/^v[12]:/);
        expect(raw[0].body).not.toContain('главата');
    }, 60_000);
});
