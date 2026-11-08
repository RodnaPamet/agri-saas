/**
 * #2829 — the reply target's CODE stage: the API half.
 *
 * `tests/integration/dm-reply-target.test.ts` owns the SCHEMA stage (#2880) —
 * the FK, the partial index and the `direct_message_reply_same_conversation`
 * trigger, asserted through raw SQL and read as a SQLSTATE because a trigger's
 * refusal does not arrive through Prisma's model API as anything that names
 * the constraint. That suite proves the database refuses a cross-conversation
 * target whatever writes the row.
 *
 * Measured here, by deleting the usecase check and running case 3: the client
 * then receives **`P2039`** — an unrecognised Prisma error with no mapping in
 * `@/lib/errors`, i.e. a 500. (The repo's other recorded instance of this
 * class, a trigger refusing a DELETE, surfaces instead as an FK violation
 * naming no constraint. Same lesson, different code — measure which.)
 *
 * This one owns what a CLIENT can reach, and the four properties it pins each
 * fail silently in a different direction:
 *
 *   1. the pointer is STORED. A send that parses `replyToMessageId` and drops
 *      it answers 201 and looks right — which is exactly what the route did to
 *      `linkUrl` for the whole of P8.6 (#2890).
 *   2. the preview comes BACK, as an OBJECT. A client given only an id cannot
 *      resolve a target that sits outside the page it holds, and the fix for
 *      that is one request per reply — so a payload carrying the id alone is a
 *      feature that works only for recent replies.
 *   3. a cross-conversation target is REFUSED with a usable code, and with the
 *      SAME answer a nonexistent one gets. Two answers would be an oracle for
 *      message ids.
 *   4. a DELETED target renders as deleted rather than serving its old text,
 *      and `deleted` is what tells it from a photo-only message, which also
 *      has a null body.
 */
import { randomUUID } from 'crypto';

import { prisma } from '@/lib/prisma';
import {
    sendDirectMessage,
    readConversation,
    deleteDirectMessage,
} from '@/app-layer/usecases/direct-messages';
import type { UserContext } from '@/app-layer/types';

import { DB_AVAILABLE } from './db-helper';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SFX = randomUUID().slice(0, 8);
const ALICE = `u-rtc-alice-${SFX}`;
const BORIS = `u-rtc-boris-${SFX}`;
const CARA = `u-rtc-cara-${SFX}`;
const CONV = `cv-rtc-${SFX}`;
const OTHER = `cv-rtc-other-${SFX}`;

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

async function conversation(id: string, a: string, b: string): Promise<void> {
    await prisma.conversation.create({
        data: {
            id,
            state: 'ACCEPTED',
            initiatedByUserId: a,
            lastMessageAt: new Date(),
            participants: {
                create: [
                    { id: `cp-${id}-1`, userId: a },
                    { id: `cp-${id}-2`, userId: b },
                ],
            },
        },
    });
}

/** The message rows of `CONV`, oldest-first, as a client reads them. */
async function timeline(reader: string) {
    const view = await readConversation(ctxFor(reader), CONV, {});
    return view.messages;
}

describeFn('#2829 — a reply target, end to end', () => {
    let target = '';

    beforeAll(async () => {
        await conversation(CONV, ALICE, BORIS);
        await conversation(OTHER, ALICE, CARA);
        const first = await sendDirectMessage(ctxFor(ALICE), {
            conversationId: CONV,
            body: 'Колко искате за пшеницата?',
        });
        target = first.messageId;
    }, 60_000);

    afterAll(async () => {
        for (const id of [CONV, OTHER]) {
            await prisma.directMessage.deleteMany({ where: { conversationId: id } });
            await prisma.conversationParticipant.deleteMany({ where: { conversationId: id } });
            await prisma.conversation.deleteMany({ where: { id } });
        }
    }, 60_000);

    it('stores the pointer and returns the quoted message as an OBJECT', async () => {
        const sent = await sendDirectMessage(ctxFor(BORIS), {
            conversationId: CONV,
            body: '480 €/t',
            replyToMessageId: target,
        });

        // The COLUMN, read back directly. A send that parses the field and
        // drops it answers exactly like this one, which is how `linkUrl` was
        // unreachable over HTTP for the whole of P8.6 (#2890).
        const stored = await prisma.directMessage.findUniqueOrThrow({
            where: { id: sent.messageId },
            select: { replyToMessageId: true },
        });
        expect(stored.replyToMessageId).toBe(target);

        // The PAYLOAD, which is what a client has. An id alone would not be
        // enough: the target may sit outside the page being held.
        const rows = await timeline(BORIS);
        const reply = rows.find((m) => m.id === sent.messageId)!;
        expect(reply.replyTo).toEqual({
            id: target,
            senderUserId: ALICE,
            body: 'Колко искате за пшеницата?',
            deleted: false,
        });

        // The control: a message that is NOT a reply carries null rather than
        // an object with empty fields, so "is this a reply" is one null check.
        const plain = rows.find((m) => m.id === target)!;
        expect(plain.replyTo).toBeNull();
    });

    it('refuses a target in ANOTHER conversation, with the same answer a nonexistent one gets', async () => {
        const elsewhere = await sendDirectMessage(ctxFor(ALICE), {
            conversationId: OTHER,
            body: 'друг разговор',
        });

        const capture = async (replyToMessageId: string) =>
            sendDirectMessage(ctxFor(BORIS), {
                conversationId: CONV,
                body: 'quoting',
                replyToMessageId,
            }).then(
                () => null,
                (e: unknown) => e as { code?: string; status?: number; message?: string },
            );

        const crossConversation = await capture(elsewhere.messageId);
        const doesNotExist = await capture(`dm-${randomUUID()}`);

        // ONE code, and the whole observable has to match — a status or a
        // message that differed would tell a sender that a guessed id names a
        // real message somewhere, which is the enumeration this field must not
        // become. Compared as objects for that reason rather than asserted
        // separately.
        expect(crossConversation?.code).toBe('DM_REPLY_TARGET_NOT_FOUND');
        expect({
            code: crossConversation?.code,
            status: crossConversation?.status,
            message: crossConversation?.message,
        }).toEqual({
            code: doesNotExist?.code,
            status: doesNotExist?.status,
            message: doesNotExist?.message,
        });

        // And nothing was written. A refusal that still stored the message
        // without its pointer would be worse than either outcome: the reply
        // would appear in the conversation quoting nothing.
        const rows = await timeline(BORIS);
        expect(rows.some((m) => m.body === 'quoting')).toBe(false);
    });

    it('a DELETED target quotes as deleted, not as its old text', async () => {
        const doomed = await sendDirectMessage(ctxFor(ALICE), {
            conversationId: CONV,
            body: 'ще изтрия това',
        });
        const reply = await sendDirectMessage(ctxFor(BORIS), {
            conversationId: CONV,
            body: 'отговор',
            replyToMessageId: doomed.messageId,
        });

        // Before: the quote carries the text, which is the control. Without it
        // a mapping that returned `body: null` unconditionally would pass the
        // after-assertion perfectly.
        const before = (await timeline(BORIS)).find((m) => m.id === reply.messageId)!;
        expect(before.replyTo).toMatchObject({ body: 'ще изтрия това', deleted: false });

        await deleteDirectMessage(ctxFor(ALICE), doomed.messageId);

        const after = (await timeline(BORIS)).find((m) => m.id === reply.messageId)!;
        // The REPLY survives its target's retraction — the common case, and
        // why `deleted` is a field rather than inferred from a null body.
        expect(after.replyTo).toEqual({
            id: doomed.messageId,
            senderUserId: ALICE,
            body: null,
            deleted: true,
        });
        expect(after.body).toBe('отговор');
    });

    it('ACCEPTS a deleted target on a NEW reply rather than refusing the send', async () => {
        // Refusing would make a composer fail because the other party
        // retracted something a moment earlier, which reads as broken. The
        // row survives a soft delete, so the FK and the trigger both hold.
        const doomed = await sendDirectMessage(ctxFor(ALICE), {
            conversationId: CONV,
            body: 'изтрито преди отговора',
        });
        await deleteDirectMessage(ctxFor(ALICE), doomed.messageId);

        const late = await sendDirectMessage(ctxFor(BORIS), {
            conversationId: CONV,
            body: 'късен отговор',
            replyToMessageId: doomed.messageId,
        });
        const row = (await timeline(BORIS)).find((m) => m.id === late.messageId)!;
        expect(row.replyTo).toMatchObject({ deleted: true, body: null });
    });

    it('the counterparty sees the same quote — the preview is not sender-only', async () => {
        // `readConversation` runs in USER context, so `direct_message_select`
        // governs the nested read as well. The target is in the same
        // conversation by construction, so the policy admits it for both
        // parties — asserted rather than assumed, because a policy that hid it
        // would make the quote silently empty for one reader and nothing else
        // in this suite would notice.
        const sent = await sendDirectMessage(ctxFor(ALICE), {
            conversationId: CONV,
            body: 'питам пак',
            replyToMessageId: target,
        });
        const asBoris = (await timeline(BORIS)).find((m) => m.id === sent.messageId)!;
        const asAlice = (await timeline(ALICE)).find((m) => m.id === sent.messageId)!;
        expect(asBoris.replyTo).toEqual(asAlice.replyTo);
        expect(asAlice.replyTo?.body).toBe('Колко искате за пшеницата?');
    });

    it('an outsider sees neither the reply nor its quote', async () => {
        // The disclosure control. CARA is a participant of OTHER and not of
        // CONV, so the whole conversation is a not-found for her — and if it
        // somehow were not, the quote would carry a message she has no right
        // to, which is the harm the trigger exists for.
        await expect(readConversation(ctxFor(CARA), CONV, {})).rejects.toMatchObject({
            code: 'CONVERSATION_NOT_FOUND',
        });
    });
});
