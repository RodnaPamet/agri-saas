/**
 * P8.6 (#2800) — the SCHEMA stage for direct-message photos and link cards.
 *
 * P8's rule ships tables one release before the code that writes them, so
 * there is no route, usecase, UI or flag yet. What there IS to verify is the
 * three properties the migration claims, each of which fails silently if wrong:
 *
 *   1. `body` is genuinely nullable AND the encryption middleware tolerates
 *      that. A cipher fed a null is the kind of thing that works in a unit
 *      test with a stubbed client and throws against Postgres.
 *   2. The CHECK still admits every shape the product needs — a photo-only
 *      message, a text-only message, a retracted one — and refuses a row that
 *      says nothing.
 *   3. The manifest decision holds AT REST: `linkTitle` / `linkDescription`
 *      are ciphertext in the column and plaintext through the ORM, while
 *      `attachmentKey` is verbatim. A manifest entry is a claim about bytes on
 *      disk, and the only way to read it is to look.
 *
 * Every refusal is paired with the same operation in a shape that must be
 * allowed — P8.1's rule, because a connection bound to nothing also produces
 * zero rows, and a suite of only-negatives passes against it.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { runInUserContext } from '@/lib/db-context';
import { prisma } from '@/lib/prisma';
import { ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';
import type { UserContext } from '@/app-layer/types';

import { DB_URL, DB_AVAILABLE } from './db-helper';

/**
 * TWO clients, and the split is the whole point of this suite.
 *
 * `prisma` is the EXTENDED client — it carries the `$extends({ query })`
 * encryption layer, so it is what production writes through and the only way
 * a declared field becomes ciphertext. `rawPrisma` is a bare client used ONLY
 * to read columns back, because the extension would decrypt them on the way
 * out and every at-rest assertion would read its own plaintext.
 *
 * The first draft wrote through the bare client and asserted ciphertext. It
 * got the plaintext it had itself stored — the manifest was never consulted,
 * and the failure looked like a broken manifest rather than a broken fixture.
 */
const rawPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const ALICE = `u-p86-alice-${randomUUID()}`;
const BORIS = `u-p86-boris-${randomUUID()}`;
const CONV = `cv-p86-${randomUUID()}`;

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

/** The RAW column value, bypassing the client extension that decrypts. */
async function rawColumn(messageId: string, column: string): Promise<string | null> {
    const rows = await rawPrisma.$queryRawUnsafe<Array<Record<string, string | null>>>(
        `SELECT "${column}" AS v FROM "DirectMessage" WHERE "id" = $1`,
        messageId,
    );
    return rows[0]?.v ?? null;
}

/** The SQLSTATE of a refused insert, or null when it was allowed. */
async function insertState(data: Record<string, unknown>): Promise<string | null> {
    try {
        await prisma.directMessage.create({ data: data as never });
        return null;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const m = /Code:\s*`?([0-9A-Z]{5})`?/.exec(message);
        if (m) return m[1];
        // A CHECK violation reaches Prisma's model API as P2010 only for raw
        // queries; through `create` it surfaces as a known request error whose
        // code is what we fall back to. Returning the message would make every
        // assertion below a substring match on prose.
        return (err as { code?: string }).code ?? 'UNKNOWN';
    }
}

describeFn('P8.6 schema — photos and link cards (#2800)', () => {
    beforeAll(async () => {
        await prisma.conversation.create({
            data: {
                id: CONV,
                state: 'ACCEPTED',
                initiatedByUserId: ALICE,
                lastMessageAt: new Date(),
                participants: {
                    create: [
                        { id: `cp-a-${randomUUID()}`, userId: ALICE },
                        { id: `cp-b-${randomUUID()}`, userId: BORIS },
                    ],
                },
            },
        });
    });

    afterAll(async () => {
        await prisma.directMessage.deleteMany({ where: { conversationId: CONV } });
        await prisma.conversationParticipant.deleteMany({ where: { conversationId: CONV } });
        await prisma.conversation.deleteMany({ where: { id: CONV } });
        await rawPrisma.$disconnect();
    });

    describe('`body` is nullable, and the cipher tolerates it', () => {
        it('accepts a PHOTO-ONLY message — null body, an attachment', async () => {
            const id = `dm-photo-${randomUUID()}`;
            const state = await insertState({
                id,
                conversationId: CONV,
                senderUserId: ALICE,
                body: null,
                attachmentKey: `dm/${CONV}/${id}.webp`,
                attachmentMime: 'image/webp',
                attachmentBytes: 51_200,
                attachmentSha256: 'a'.repeat(64),
            });
            // The owner ruling, enforced end to end. If the middleware fed the
            // null to the cipher this is where it would throw.
            expect(state).toBeNull();
            expect(await rawColumn(id, 'body')).toBeNull();
        });

        it('accepts a LINK-ONLY message — the CHECK gained its linkUrl arm', async () => {
            // #2800's migration drops and recreates
            // `direct_message_says_something` to add `OR "linkUrl" IS NOT
            // NULL`. Without that arm a message carrying only a shared link is
            // refused by the database, which is the one thing a link card is
            // for. The control is 'REFUSES a message that says nothing at all'
            // below: widening a CHECK is how a CHECK stops checking, and this
            // assertion alone is satisfied by a constraint that accepts
            // everything.
            const state = await insertState({
                id: `dm-linkonly-${randomUUID()}`,
                conversationId: CONV,
                senderUserId: BORIS,
                body: null,
                linkUrl: 'https://agri.example.test/only',
            });
            expect(state).toBeNull();
        });

        it('still accepts a TEXT-ONLY message — the regression control', async () => {
            const id = `dm-text-${randomUUID()}`;
            const state = await insertState({
                id,
                conversationId: CONV,
                senderUserId: BORIS,
                body: 'Имате ли свободен комбайн?',
            });
            expect(state).toBeNull();
            // Widening the column must not have stopped the encryption: a
            // nullable encrypted field whose non-null values went plaintext
            // would pass every other assertion here.
            expect(await rawColumn(id, 'body')).toMatch(/^v[12]:/);
        });

        it('REFUSES a message that says nothing at all', async () => {
            const state = await insertState({
                id: `dm-empty-${randomUUID()}`,
                conversationId: CONV,
                senderUserId: ALICE,
                body: null,
            });
            // 23514 is check_violation. Asserting the CODE rather than that it
            // threw: a dead connection or a typo'd column also throws.
            expect(state).toBe('23514');
        });

        it('admits a RETRACTED message with nothing left — the deletedAt arm', async () => {
            // `deleteDirectMessage` writes `body = ''`, and the code stage must
            // also clear the attachment keys so a deleted photo stops being
            // served. Without this arm the database would refuse that clearing
            // and the DELETION would fail rather than the photo stopping.
            const id = `dm-gone-${randomUUID()}`;
            const state = await insertState({
                id,
                conversationId: CONV,
                senderUserId: ALICE,
                body: null,
                deletedAt: new Date(),
            });
            expect(state).toBeNull();
        });
    });

    describe('the manifest decision, read AT REST', () => {
        it('leaves the storage key VERBATIM — an opaque key is not content', () => {
            // This is the assertion that would catch somebody adding
            // `attachmentKey` to `ENCRYPTED_FIELDS` "for consistency".
            // Encrypting it buys nothing (a key is not content, which is the
            // call `FileRecord.pathKey` already makes) and costs a decrypt on
            // every byte the egress route serves.
            //
            // Asserted on the MANIFEST rather than only at rest, because a
            // round trip through the extension returns the plaintext either
            // way — ciphertext in the column and a correct decrypt are
            // indistinguishable from the ORM, which is the whole reason the
            // at-rest reads below exist.
            // `linkTitle` / `linkDescription` joined the manifest WITH their
            // writer (#2800) — the whole reason the link-card columns did not
            // ship in this stage. `attachmentKey` and `linkUrl` are the two
            // this assertion is actually guarding: a storage key is not
            // content, and `linkUrl` is plaintext by a recorded judgement
            // rather than by omission (see `ENCRYPTED_FIELDS`).
            expect(ENCRYPTED_FIELDS.DirectMessage).toEqual([
                'body',
                'linkTitle',
                'linkDescription',
            ]);
        });

        it('stores the key at rest exactly as written', async () => {
            const id = `dm-key-${randomUUID()}`;
            const key = `dm/${CONV}/${id}.webp`;
            const state = await insertState({
                id,
                conversationId: CONV,
                senderUserId: BORIS,
                body: null,
                attachmentKey: key,
                attachmentMime: 'image/webp',
                attachmentBytes: 2048,
                attachmentSha256: 'b'.repeat(64),
            });
            expect(state).toBeNull();
            expect(await rawColumn(id, 'attachmentKey')).toBe(key);
        });

        it('has exactly the FOUR link-card columns, and no linkImageKey', async () => {
            // This test asserted `[]` through the schema stage, with the
            // reason that declaring `linkTitle` / `linkDescription` encrypted
            // requires sanitising them BY NAME at a write path and a
            // schema-only stage has none. #2800 is that write path, so the
            // assertion inverts rather than being deleted — which is what it
            // was for: it forced the columns, the manifest entry and the
            // sanitiser into one diff.
            //
            // FOUR, not five. A `linkImageKey` was in both earlier drafts with
            // nothing that writes it; storing a preview image is a DECODE of
            // bytes a hostile server chose, so it is the record-less upload
            // shape rather than a column — #2855. Named here so adding the
            // column back without its writer fails in the same place.
            const cols = await rawPrisma.$queryRawUnsafe<Array<{ column_name: string }>>(
                `SELECT column_name FROM information_schema.columns
                  WHERE table_name = 'DirectMessage' AND column_name LIKE 'link%'
                  ORDER BY column_name`,
            );
            expect(cols.map((c) => c.column_name)).toEqual([
                'linkDescription',
                'linkFetchedAt',
                'linkTitle',
                'linkUrl',
            ]);
        });

        it('encrypts the card TEXT at rest and leaves the URL verbatim', async () => {
            const id = `dm-card-${randomUUID()}`;
            const url = 'https://agri.example.test/at-rest';
            const state = await insertState({
                id,
                conversationId: CONV,
                senderUserId: BORIS,
                body: null,
                linkUrl: url,
                linkTitle: 'Заглавие при покой',
                linkDescription: 'Описание при покой',
                linkFetchedAt: new Date(),
            });
            expect(state).toBeNull();

            // The manifest decision, read where the manifest acts. A round
            // trip through the extension returns the plaintext either way, so
            // only the raw column tells a correct decrypt from no encryption
            // at all.
            expect(await rawColumn(id, 'linkTitle')).toMatch(/^v[12]:/);
            expect(await rawColumn(id, 'linkDescription')).toMatch(/^v[12]:/);
            // And the URL is NOT encrypted — the inbox preview and any future
            // unfurl cache read it with no tenant in scope.
            expect(await rawColumn(id, 'linkUrl')).toBe(url);
        });

    });

    describe('the new columns inherit the EXISTING row policies', () => {
        it('hides an attachment key from somebody not in the conversation', async () => {
            const id = `dm-hidden-${randomUUID()}`;
            await prisma.directMessage.create({
                data: {
                    id,
                    conversationId: CONV,
                    senderUserId: ALICE,
                    body: null,
                    attachmentKey: `dm/${CONV}/${id}.webp`,
                    attachmentMime: 'image/webp',
                },
            });

            const outsider = `u-p86-outsider-${randomUUID()}`;
            const seen = await runInUserContext(ctxFor(outsider), async (tx) => {
                const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
                    'SELECT COUNT(*)::bigint AS n FROM "DirectMessage" WHERE "attachmentKey" IS NOT NULL AND "id" = $1',
                    id,
                );
                return Number(rows[0].n);
            });
            expect(seen).toBe(0);

            // The positive control the zero above needs: a participant DOES
            // see it. Postgres RLS is row-level, so a new column is governed by
            // the arms already on the table — but "governed" and "bound to
            // nothing" both read as zero.
            const byParticipant = await runInUserContext(ctxFor(ALICE), async (tx) => {
                const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
                    'SELECT COUNT(*)::bigint AS n FROM "DirectMessage" WHERE "attachmentKey" IS NOT NULL AND "id" = $1',
                    id,
                );
                return Number(rows[0].n);
            });
            expect(byParticipant).toBe(1);
        });
    });
});
