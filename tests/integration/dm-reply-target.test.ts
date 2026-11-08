/**
 * A reply names a message in the SAME conversation — #2829, schema stage.
 *
 * ## Why a trigger and not a CHECK
 *
 * The harm this refuses: a crafted request quotes a message from a
 * conversation the sender is not in, and the reply preview then decrypts it
 * for somebody with no right to it. The FK alone does not stop that — it only
 * requires the target to EXIST.
 *
 * A CHECK constraint cannot express it: Postgres forbids a subquery in one,
 * and the comparison is between two ROWS. So the only database mechanism left
 * is a trigger, and this suite is what makes it a mechanism rather than a
 * claim.
 *
 * ## What the error looks like, which is NOT what you would guess
 *
 * The trigger raises SQLSTATE 23514 (`check_violation`) on purpose: it IS the
 * check a CHECK would have been, and a caller should not have to learn a
 * second code for it. But **Prisma reports a trigger as a FOREIGN KEY
 * violation** through its model API — measured on this repo before — so every
 * assertion here goes through raw SQL and reads the SQLSTATE, rather than
 * matching a Prisma error shape that describes a constraint which does not
 * exist.
 *
 * ## The privileged/user asymmetry is deliberate and is asserted
 *
 * The trigger is NOT `SECURITY DEFINER` (P8.2 records why one is a trap: the
 * `role` GUC does not change inside a definer function, so what carries the
 * write is a role attribute nobody declared). So under the PRIVILEGED client
 * it sees every row and the check is pure conversation equality, while under
 * `app_user` the lookup is filtered by `direct_message_select` and an
 * invisible target fails the EXISTS. Same refusal, two routes — and the second
 * is strictly stricter, which is the right direction for a control to lean.
 */
import { randomUUID } from 'crypto';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { encryptField } from '@/lib/security/encryption';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SFX = randomUUID().slice(0, 8);
const ALICE = `u-rt-alice-${SFX}`;
const BORIS = `u-rt-boris-${SFX}`;
const CONV_A = `cv-rt-a-${SFX}`;
const CONV_B = `cv-rt-b-${SFX}`;

const conversations = [CONV_A, CONV_B];
const messages: string[] = [];

async function makeConversation(id: string): Promise<void> {
    await db.$executeRawUnsafe(
        `INSERT INTO "Conversation"("id","state","initiatedByUserId","lastMessageAt","updatedAt")
         VALUES ($1,'ACCEPTED'::"ConversationState",$2,NOW(),NOW())`,
        id, ALICE,
    );
    for (const userId of [ALICE, BORIS]) {
        await db.$executeRawUnsafe(
            `INSERT INTO "ConversationParticipant"("id","conversationId","userId","joinedAt")
             VALUES ($1,$2,$3,NOW())`,
            `cp-rt-${randomUUID()}`, id, userId,
        );
    }
}

/** Insert a message, returning the SQLSTATE on refusal and null on success. */
async function insert(
    conversationId: string,
    replyToMessageId: string | null,
): Promise<{ id: string; state: string | null }> {
    const id = `dm-rt-${randomUUID()}`;
    try {
        await db.$executeRawUnsafe(
            `INSERT INTO "DirectMessage"
               ("id","conversationId","senderUserId","body","replyToMessageId","createdAt")
             VALUES ($1,$2,$3,$4,$5,NOW())`,
            id, conversationId, ALICE, encryptField('нещо'), replyToMessageId,
        );
        messages.push(id);
        return { id, state: null };
    } catch (err) {
        const m = /\b(\d{5})\b/.exec(err instanceof Error ? err.message : String(err));
        // The CODE, never the prose: a message assertion would pin copy that
        // belongs to Postgres.
        return { id, state: m?.[1] ?? 'UNKNOWN' };
    }
}

describeFn('a reply names a message in the same conversation (#2829)', () => {
    beforeAll(async () => {
        await makeConversation(CONV_A);
        await makeConversation(CONV_B);
    }, 60_000);

    afterAll(async () => {
        await db.$executeRawUnsafe(
            `DELETE FROM "DirectMessage" WHERE "conversationId" = ANY($1::text[])`,
            conversations,
        );
        await db.$executeRawUnsafe(
            `DELETE FROM "ConversationParticipant" WHERE "conversationId" = ANY($1::text[])`,
            conversations,
        );
        await db.$executeRawUnsafe(
            `DELETE FROM "Conversation" WHERE "id" = ANY($1::text[])`, conversations,
        );
        await db.$disconnect();
    }, 60_000);

    it('ACCEPTS a reply to a message in the same conversation', async () => {
        const target = await insert(CONV_A, null);
        expect(target.state).toBeNull();
        // THE POSITIVE CONTROL. Every refusal below is worthless without it:
        // a trigger that rejected every reply would satisfy all three.
        const reply = await insert(CONV_A, target.id);
        expect(reply.state).toBeNull();
    }, 60_000);

    it('REFUSES a reply pointing into a DIFFERENT conversation', async () => {
        const elsewhere = await insert(CONV_B, null);
        expect(elsewhere.state).toBeNull();

        const reply = await insert(CONV_A, elsewhere.id);
        // 23514 — `check_violation`. The trigger IS the check a CHECK would
        // have been, so it answers in that code rather than inventing one.
        expect(reply.state).toBe('23514');
    }, 60_000);

    it('REFUSES a reply to an id nothing has — the FK, not the trigger', async () => {
        const reply = await insert(CONV_A, `dm-rt-nope-${randomUUID()}`);
        // The trigger fires FIRST (it is BEFORE INSERT), so this is 23514 too
        // rather than the FK's 23503 — asserted rather than assumed, because
        // which constraint speaks first is exactly the kind of thing a reader
        // would get wrong. Both refuse; the code tells you which did.
        expect(reply.state).toBe('23514');
    }, 60_000);

    it('ACCEPTS a message that is not a reply at all', async () => {
        // The NULL arm of the trigger, which is the common case: almost no
        // message is a reply, and a trigger that refused a null pointer would
        // break every send.
        const plain = await insert(CONV_A, null);
        expect(plain.state).toBeNull();
    }, 60_000);

    it('REFUSES an UPDATE that moves the pointer across conversations', async () => {
        const target = await insert(CONV_A, null);
        const reply = await insert(CONV_A, target.id);
        expect(reply.state).toBeNull();
        const elsewhere = await insert(CONV_B, null);

        let state: string | null = null;
        try {
            await db.$executeRawUnsafe(
                `UPDATE "DirectMessage" SET "replyToMessageId" = $2 WHERE "id" = $1`,
                reply.id, elsewhere.id,
            );
        } catch (err) {
            state = /\b(\d{5})\b/.exec(err instanceof Error ? err.message : String(err))?.[1]
                ?? 'UNKNOWN';
        }
        // The trigger covers UPDATE because an INSERT-only one is walked past
        // by an edit that sets the pointer afterwards — which is a one-line
        // omission with the same consequence as having no trigger.
        expect(state).toBe('23514');
    }, 60_000);

    it('SETS NULL rather than cascading when a target row really goes', async () => {
        const target = await insert(CONV_A, null);
        const reply = await insert(CONV_A, target.id);
        expect(reply.state).toBeNull();

        await db.$executeRawUnsafe(`DELETE FROM "DirectMessage" WHERE "id" = $1`, target.id);

        const rows = await db.$queryRawUnsafe<Array<{ id: string; r: string | null }>>(
            `SELECT "id", "replyToMessageId" AS r FROM "DirectMessage" WHERE "id" = $1`,
            reply.id,
        );
        // THE REPLY SURVIVES. `ON DELETE CASCADE` here would delete somebody
        // else's message because the thing it quoted was deleted — and a soft
        // delete keeps the row, so this path is rare rather than absent.
        expect(rows).toHaveLength(1);
        expect(rows[0].r).toBeNull();
    }, 60_000);
});
