/**
 * P8.1 (#2795) — direct-message RLS, under `app_user`, in the context the
 * production caller will run in.
 *
 * ## Why the context matters more than the policy
 *
 * These policies key on `app.user_id`, which `runInUserContext` sets.
 * `runInTenantContext` sets `app.actor_user_id` and deliberately not
 * `app.user_id`. Reading the wrong variable does not raise: the unset one
 * yields NULL, the arm matches nothing, and the caller sees zero rows — which
 * is indistinguishable from an empty inbox.
 *
 * #1664 is that failure, paid for in full. `UserBlock`'s SELECT policy keyed on
 * `app.user_id` while the enforcement ran under `app.actor_user_id`, so
 * `personBlockExists` returned false for every pair, always, and two green
 * suites could not see it — one mocked Prisma (its double returns a row when
 * asked, so it cannot express "the policy hides this"), the other asserted the
 * table's policies from the right context (right about its own axis).
 *
 * So this suite runs through `runInUserContext`, the helper P8.2's
 * `/api/social/` routes will use.
 *
 * ## The two refusal shapes, and only one of them raises
 *
 * With no permissive policy for a command, the rows to change are selected by a
 * USING clause that is effectively false: the statement affects ZERO rows and
 * RETURNS NORMALLY. A `WITH CHECK` violation on INSERT raises 42501.
 *
 * Every negative below therefore asserts a row COUNT or an error CODE, never
 * that a call returned. "It did not throw" reads a silent no-op as a working
 * policy.
 *
 * ## And every positive asserts a NON-ZERO
 *
 * A silently unset session variable also produces zero rows, so a suite of
 * only-negatives passes against a connection bound to nothing. Each refusal
 * below is paired with the same operation by somebody entitled to it.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { runInUserContext } from '@/lib/db-context';
import { encryptField } from '@/lib/security/encryption';
import type { UserContext } from '@/app-layer/types';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

// Synthetic person ids. None of these tables has an FK to `User` — every
// person column is a plain string, following `ExchangeBlock` and `UserBlock` —
// so no user fixture is needed, and inventing one would test a constraint that
// does not exist.
const ALICE = `u-p81-alice-${randomUUID()}`;
const BORIS = `u-p81-boris-${randomUUID()}`;
const OUTSIDER = `u-p81-outsider-${randomUUID()}`;

/** ACCEPTED, both parties in, one message from each. */
const CONV_OPEN = `cv-open-${randomUUID()}`;
/** REQUEST with its one message already spent. */
const CONV_REQ_SPENT = `cv-req-spent-${randomUUID()}`;
/** REQUEST with no message yet — the allowance is unspent. */
const CONV_REQ_FRESH = `cv-req-fresh-${randomUUID()}`;
/** ACCEPTED, and the OUTSIDER is not in it. Used for the hidden-row shapes. */
const MSG_ALICE = `dm-alice-${randomUUID()}`;
const MSG_BORIS = `dm-boris-${randomUUID()}`;
const MSG_REQ = `dm-req-${randomUUID()}`;
const REACTION_BORIS = `mr-boris-${randomUUID()}`;

const PART_OPEN_ALICE = `cp-oa-${randomUUID()}`;
const PART_OPEN_BORIS = `cp-ob-${randomUUID()}`;

const BODY_ALICE = 'Имате ли свободен комбайн следващата седмица?';

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

/** Rows VISIBLE to this person, via raw SQL so the ORM cannot be the filter. */
async function visibleCount(userId: string, table: string, where = 'TRUE'): Promise<number> {
    return runInUserContext(ctxFor(userId), async (tx) => {
        const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT COUNT(*)::bigint AS n FROM "${table}" WHERE ${where}`,
        );
        return Number(rows[0].n);
    });
}

/**
 * The POSTGRES SQLSTATE of a refused statement, or null if it was allowed.
 *
 * Prisma does not surface the SQLSTATE as `err.code` for a raw query: it
 * reports its own `P2010` ("Raw query failed") and puts the real code in the
 * MESSAGE — `Raw query failed. Code: \`42501\`.`. Reading `err.code` here
 * returns `P2010` for every cause, which is a shared field that cannot name
 * its source: a `WITH CHECK` violation, a syntax error and a dead connection
 * would all read alike, and a test asserting `P2010` would pass on any of
 * them. So this parses the SQLSTATE out, and falls back to the Prisma code
 * only when there is none to find.
 */
async function sqlStateOf(userId: string, sql: string, params: unknown[]): Promise<string | null> {
    try {
        await runInUserContext(ctxFor(userId), (tx) => tx.$executeRawUnsafe(sql, ...params));
        return null;
    } catch (err) {
        const meta = (err as { meta?: { code?: string } }).meta;
        if (typeof meta?.code === 'string') return meta.code;
        const message = err instanceof Error ? err.message : String(err);
        const sqlstate = /Code:\s*`?([0-9A-Z]{5})`?/.exec(message);
        if (sqlstate) return sqlstate[1];
        return (err as { code?: string }).code ?? 'UNKNOWN';
    }
}

/** Rows a statement actually CHANGED — the only reading that sees a no-op. */
async function rowsAffected(userId: string, sql: string, params: unknown[]): Promise<number> {
    return runInUserContext(ctxFor(userId), (tx) => tx.$executeRawUnsafe(sql, ...params));
}

describeFn('P8.1 — direct-message RLS (#2795)', () => {
    beforeAll(async () => {
        await globalPrisma.$connect();
        // Seeded through the privileged connection, because the production
        // write path for `Conversation` and `ConversationParticipant` IS the
        // privileged one: opening a conversation writes the other person's
        // participant row, which no caller may forge.
        // `lastMessageAt` is what bounds a REQUEST to one message — see the
        // migration: the count-the-messages form is refused by Postgres as
        // infinite policy recursion, so the invariant lives on this column and
        // the sending write stamps it. CONV_REQ_SPENT has spent its allowance;
        // CONV_REQ_FRESH has not.
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "Conversation"("id","updatedAt","state","initiatedByUserId","lastMessageAt")
             VALUES ($1, NOW(), 'ACCEPTED', $2, NOW()),
                    ($3, NOW(), 'REQUEST',  $4, NOW()),
                    ($5, NOW(), 'REQUEST',  $6, NULL)`,
            CONV_OPEN, ALICE, CONV_REQ_SPENT, ALICE, CONV_REQ_FRESH, ALICE,
        );
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "ConversationParticipant"("id","conversationId","userId")
             VALUES ($1,$2,$3), ($4,$5,$6),
                    ($7,$8,$9), ($10,$11,$12),
                    ($13,$14,$15), ($16,$17,$18)`,
            PART_OPEN_ALICE, CONV_OPEN, ALICE,
            PART_OPEN_BORIS, CONV_OPEN, BORIS,
            `cp-${randomUUID()}`, CONV_REQ_SPENT, ALICE,
            `cp-${randomUUID()}`, CONV_REQ_SPENT, BORIS,
            `cp-${randomUUID()}`, CONV_REQ_FRESH, ALICE,
            `cp-${randomUUID()}`, CONV_REQ_FRESH, BORIS,
        );
        // `body` is in ENCRYPTED_FIELDS, so a raw insert must store the
        // envelope the middleware would have written. Plaintext here would make
        // a later ORM read fail to decrypt for a reason unrelated to RLS.
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "DirectMessage"("id","conversationId","senderUserId","body")
             VALUES ($1,$2,$3,$4), ($5,$6,$7,$8), ($9,$10,$11,$12)`,
            MSG_ALICE, CONV_OPEN, ALICE, encryptField(BODY_ALICE),
            MSG_BORIS, CONV_OPEN, BORIS, encryptField('Да, от четвъртък.'),
            MSG_REQ, CONV_REQ_SPENT, ALICE, encryptField('Добър ден.'),
        );
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "MessageReaction"("id","messageId","userId","emoji")
             VALUES ($1,$2,$3,'👍')`,
            REACTION_BORIS, MSG_ALICE, BORIS,
        );
    });

    afterAll(async () => {
        // Cascades take the participants, messages and reactions with them.
        await globalPrisma.$executeRawUnsafe(
            `DELETE FROM "Conversation" WHERE "id" = ANY($1::text[])`,
            [CONV_OPEN, CONV_REQ_SPENT, CONV_REQ_FRESH],
        );
        await globalPrisma.$disconnect();
    });

    describe('reading a conversation', () => {
        it('a participant sees it — the positive control for every zero below', async () => {
            // Non-zero, deliberately. An assertion that a participant sees "no
            // more than their own" would pass on an empty result and prove
            // nothing about the policy.
            await expect(visibleCount(ALICE, 'Conversation', `"id" = '${CONV_OPEN}'`))
                .resolves.toBe(1);
            await expect(visibleCount(BORIS, 'Conversation', `"id" = '${CONV_OPEN}'`))
                .resolves.toBe(1);
        });

        it('an outsider sees ZERO of it', async () => {
            await expect(visibleCount(OUTSIDER, 'Conversation', `"id" = '${CONV_OPEN}'`))
                .resolves.toBe(0);
        });

        it('a participant sees its messages and an outsider sees none', async () => {
            await expect(
                visibleCount(ALICE, 'DirectMessage', `"conversationId" = '${CONV_OPEN}'`),
            ).resolves.toBe(2);
            await expect(
                visibleCount(OUTSIDER, 'DirectMessage', `"conversationId" = '${CONV_OPEN}'`),
            ).resolves.toBe(0);
        });

        it('a participant sees their OWN participant row only', async () => {
            // Two people are in CONV_OPEN and the caller sees one row. That
            // narrowness is deliberate — see the model docblock: a policy
            // admitting every participant of a conversation I am in must ask
            // this same table whether I am in it, which Postgres refuses as
            // infinite recursion.
            await expect(
                visibleCount(ALICE, 'ConversationParticipant', `"conversationId" = '${CONV_OPEN}'`),
            ).resolves.toBe(1);
        });

        it('the counterparty is still knowable — from a message, as on the exchange', async () => {
            // This is what makes the narrow participant policy sufficient, so
            // it is asserted rather than left as an argument in a comment.
            const senders = await runInUserContext(ctxFor(ALICE), async (tx) =>
                tx.$queryRawUnsafe<Array<{ senderUserId: string }>>(
                    `SELECT DISTINCT "senderUserId" FROM "DirectMessage"
                     WHERE "conversationId" = $1`,
                    CONV_OPEN,
                ),
            );
            expect(senders.map((r) => r.senderUserId).sort()).toEqual([ALICE, BORIS].sort());
        });
    });

    describe('the REQUEST rule, in WITH CHECK', () => {
        const insertSql =
            `INSERT INTO "DirectMessage"("id","conversationId","senderUserId","body")
             VALUES ($1,$2,$3,$4)`;

        it('admits the FIRST message into a fresh request — the positive control', async () => {
            // Without this, the refusal below would also pass if inserts never
            // worked at all.
            const id = `dm-fresh-${randomUUID()}`;
            await expect(
                sqlStateOf(ALICE, insertSql, [id, CONV_REQ_FRESH, ALICE, encryptField('Здравейте.')]),
            ).resolves.toBeNull();
            await expect(visibleCount(ALICE, 'DirectMessage', `"id" = '${id}'`)).resolves.toBe(1);
        });

        it('REFUSES a second message while the conversation is still a request', async () => {
            // 42501, raised — the INSERT shape. CONV_REQ_SPENT already holds
            // its one message.
            await expect(
                sqlStateOf(ALICE, insertSql, [
                    `dm-${randomUUID()}`, CONV_REQ_SPENT, ALICE, encryptField('И още нещо...'),
                ]),
            ).resolves.toBe('42501');
        });

        it('admits a second message once the conversation is ACCEPTED', async () => {
            // The same operation, the same people, one column different — so
            // the refusal above is about the request state and not about the
            // insert path.
            await expect(
                sqlStateOf(ALICE, insertSql, [
                    `dm-${randomUUID()}`, CONV_OPEN, ALICE, encryptField('Благодаря!'),
                ]),
            ).resolves.toBeNull();
        });

        it('REFUSES a message that names somebody else as its sender', async () => {
            await expect(
                sqlStateOf(ALICE, insertSql, [
                    `dm-${randomUUID()}`, CONV_OPEN, BORIS, encryptField('подправено'),
                ]),
            ).resolves.toBe('42501');
        });

        it('REFUSES an outsider writing into a conversation they are not in', async () => {
            await expect(
                sqlStateOf(OUTSIDER, insertSql, [
                    `dm-${randomUUID()}`, CONV_OPEN, OUTSIDER, encryptField('намесване'),
                ]),
            ).resolves.toBe('42501');
        });
    });

    describe('the silent shape — a statement aimed at a hidden row', () => {
        it('an outsider DELETE affects ZERO rows and does not raise', async () => {
            // The whole reason the negatives above assert counts and codes.
            // There is no app_user DELETE arm on `DirectMessage`, so this is
            // selected by a false USING clause: zero rows, normal return.
            await expect(
                rowsAffected(OUTSIDER, `DELETE FROM "DirectMessage" WHERE "id" = $1`, [MSG_ALICE]),
            ).resolves.toBe(0);
            // And the row is still there, read privileged.
            const rows = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
                `SELECT COUNT(*)::bigint AS n FROM "DirectMessage" WHERE "id" = $1`, MSG_ALICE,
            );
            expect(Number(rows[0].n)).toBe(1);
        });

        it('a participant cannot edit somebody else’s message — zero rows, no error', async () => {
            await expect(
                rowsAffected(
                    ALICE,
                    `UPDATE "DirectMessage" SET "body" = $1 WHERE "id" = $2`,
                    [encryptField('преправено'), MSG_BORIS],
                ),
            ).resolves.toBe(0);
        });

        it('but CAN edit their own — the control', async () => {
            await expect(
                rowsAffected(
                    ALICE,
                    `UPDATE "DirectMessage" SET "editedAt" = NOW() WHERE "id" = $1`,
                    [MSG_ALICE],
                ),
            ).resolves.toBe(1);
        });

        it('a participant moves their OWN read cursor and not the other’s', async () => {
            await expect(
                rowsAffected(
                    ALICE,
                    `UPDATE "ConversationParticipant" SET "lastReadAt" = NOW() WHERE "id" = $1`,
                    [PART_OPEN_ALICE],
                ),
            ).resolves.toBe(1);
            await expect(
                rowsAffected(
                    ALICE,
                    `UPDATE "ConversationParticipant" SET "lastReadAt" = NOW() WHERE "id" = $1`,
                    [PART_OPEN_BORIS],
                ),
            ).resolves.toBe(0);
        });
    });

    describe('reactions', () => {
        it('are visible to the other participant', async () => {
            await expect(
                visibleCount(ALICE, 'MessageReaction', `"id" = '${REACTION_BORIS}'`),
            ).resolves.toBe(1);
        });

        it('are invisible to an outsider', async () => {
            await expect(
                visibleCount(OUTSIDER, 'MessageReaction', `"id" = '${REACTION_BORIS}'`),
            ).resolves.toBe(0);
        });

        it('cannot be removed by somebody who did not write them — zero rows', async () => {
            // The per-command split exists for exactly this: a participant must
            // SEE a reaction they did not write (asserted above) without being
            // able to DELETE it. One USING clause would govern both.
            await expect(
                rowsAffected(ALICE, `DELETE FROM "MessageReaction" WHERE "id" = $1`, [
                    REACTION_BORIS,
                ]),
            ).resolves.toBe(0);
        });

        it('can be removed by their author — the control', async () => {
            await expect(
                rowsAffected(BORIS, `DELETE FROM "MessageReaction" WHERE "id" = $1`, [
                    REACTION_BORIS,
                ]),
            ).resolves.toBe(1);
        });
    });

    describe('the body at rest', () => {
        it('is ciphertext, read raw through the privileged connection', async () => {
            // P8's own hardening criterion ("raw SQL shows message bodies as
            // ciphertext"), asserted here because this is the PR that declares
            // the field. A plaintext body would mean the declaration never
            // took effect — which fails nothing else.
            const rows = await globalPrisma.$queryRawUnsafe<Array<{ body: string }>>(
                `SELECT "body" FROM "DirectMessage" WHERE "id" = $1`, MSG_ALICE,
            );
            expect(rows).toHaveLength(1);
            expect(rows[0].body).not.toContain('комбайн');
            expect(rows[0].body).toMatch(/^v[12]:/);
        });
    });
});
