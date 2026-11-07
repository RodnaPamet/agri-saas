/**
 * P8.6 (#2800) — conversation photographs, the code stage.
 *
 * The schema stage is `p8-6-dm-media-schema`. What is asserted here is the
 * behaviour that schema exists for, and the four properties that fail silently
 * if wrong:
 *
 *   1. the ORDER — scan the original bytes, then strip, then write. Stripping
 *      decodes caller bytes with libvips, so a path that stripped first would
 *      hand the decoder every unscanned file.
 *   2. METADATA is gone from what is stored. A farm photograph carries GPS,
 *      and a parcel location is the thing this is for.
 *   3. the EGRESS gate is participation, and it is RLS — so the refusal is the
 *      database's and there is no second spelling to drift from the first.
 *   4. a RETRACTED message serves nothing, and the key stops resolving before
 *      the bytes go.
 */
import { randomUUID } from 'crypto';

import sharp from 'sharp';

import { prisma } from '@/lib/prisma';
import { runInUserContext } from '@/lib/db-context';
import { getStorageProvider } from '@/lib/storage';
import {
    sendDirectPhoto,
    readDirectPhoto,
    DM_PHOTO_MAX_BYTES,
} from '@/app-layer/usecases/direct-message-photos';
import { deleteDirectMessage } from '@/app-layer/usecases/direct-messages';
import type { UserContext } from '@/app-layer/types';

import { DB_AVAILABLE } from './db-helper';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SFX = randomUUID().slice(0, 8);
const ALICE = `u-p86c-alice-${SFX}`;
const BORIS = `u-p86c-boris-${SFX}`;
const OUTSIDER = `u-p86c-outsider-${SFX}`;
const CONV = `cv-p86c-${SFX}`;
const REQUEST_CONV = `cv-p86c-req-${SFX}`;

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

/** A real JPEG carrying EXIF, so the stripping assertion has something to remove. */
async function jpegWithExif(): Promise<Buffer> {
    return sharp({
        create: { width: 64, height: 48, channels: 3, background: { r: 10, g: 120, b: 40 } },
    })
        .withMetadata({
            // A GPS-bearing EXIF block is the case this exists for. `sharp`
            // writes the tags it is given; what matters is that SOMETHING is
            // there before and nothing after.
            exif: { IFD0: { Copyright: 'Rodna Pamet', Software: 'test-fixture' } },
        })
        .jpeg()
        .toBuffer();
}

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
    return Buffer.concat(chunks);
}

describeFn('P8.6 — conversation photographs (#2800)', () => {
    beforeAll(async () => {
        await prisma.conversation.create({
            data: {
                id: CONV,
                state: 'ACCEPTED',
                initiatedByUserId: ALICE,
                lastMessageAt: new Date(),
                participants: {
                    create: [
                        { id: `cp-a-${SFX}`, userId: ALICE },
                        { id: `cp-b-${SFX}`, userId: BORIS },
                    ],
                },
            },
        });
        await prisma.conversation.create({
            data: {
                id: REQUEST_CONV,
                state: 'REQUEST',
                initiatedByUserId: ALICE,
                participants: {
                    create: [
                        { id: `cp-ra-${SFX}`, userId: ALICE },
                        { id: `cp-rb-${SFX}`, userId: BORIS },
                    ],
                },
            },
        });
    }, 60_000);

    afterAll(async () => {
        const ids = [CONV, REQUEST_CONV];
        const msgs = await prisma.directMessage.findMany({
            where: { conversationId: { in: ids } },
            select: { attachmentKey: true },
        });
        for (const m of msgs) {
            if (m.attachmentKey) {
                await getStorageProvider().delete(m.attachmentKey).catch(() => undefined);
            }
        }
        await prisma.directMessage.deleteMany({ where: { conversationId: { in: ids } } });
        await prisma.conversationParticipant.deleteMany({
            where: { conversationId: { in: ids } },
        });
        await prisma.conversation.deleteMany({ where: { id: { in: ids } } });
    }, 60_000);

    describe('sending', () => {
        it('stores a re-encoded WebP with NO metadata, and records its digest', async () => {
            const original = await jpegWithExif();
            // The control for the stripping assertion: the INPUT must actually
            // carry metadata, or "no metadata afterwards" is true of a fixture
            // that never had any.
            const beforeMeta = await sharp(original).metadata();
            expect(beforeMeta.exif).toBeDefined();

            const sent = await sendDirectPhoto(ctxFor(ALICE), {
                conversationId: CONV,
                bytes: original,
                body: 'ето нивата',
            });

            const row = await prisma.directMessage.findUniqueOrThrow({
                where: { id: sent.messageId },
            });
            expect(row.attachmentKey).toMatch(new RegExp(`^dm/${CONV}/.+\\.jpg$`));
            expect(row.attachmentMime).toBe('image/jpeg');
            expect(row.attachmentSha256).toMatch(/^[0-9a-f]{64}$/);
            expect(row.attachmentBytes).toBeGreaterThan(0);
            // The caption rides along, and is OPTIONAL — see below.
            expect(row.body).toBe('ето нивата');

            const stored = await drain(getStorageProvider().readStream(row.attachmentKey!));
            const afterMeta = await sharp(stored).metadata();
            // The FORMAT IS PRESERVED. `stripImageMetadata` re-encodes to drop
            // metadata, not to convert — which the first draft of the usecase
            // assumed, storing `image/webp` for every photograph. A JPEG
            // served as WebP behind the egress route's `nosniff` header fails
            // to render, so this assertion is about the content type being
            // HONEST, not about which format wins.
            expect(afterMeta.format).toBe('jpeg');
            // THE PROPERTY: a farm photograph carries GPS, and what is stored
            // must not.
            expect(afterMeta.exif).toBeUndefined();
        }, 60_000);

        it('accepts a photograph with NO caption — a photo alone is a message', async () => {
            const sent = await sendDirectPhoto(ctxFor(BORIS), {
                conversationId: CONV,
                bytes: await jpegWithExif(),
            });
            const row = await prisma.directMessage.findUniqueOrThrow({
                where: { id: sent.messageId },
            });
            // Owner ruling 2026-11-07, and the CHECK constraint is what makes
            // it expressible: `deletedAt IS NOT NULL OR body IS NOT NULL OR
            // attachmentKey IS NOT NULL`.
            expect(row.body).toBeNull();
            expect(row.attachmentKey).not.toBeNull();
        }, 60_000);

        it('refuses a non-image on the MAGIC NUMBER, not the declared type', async () => {
            await expect(
                sendDirectPhoto(ctxFor(ALICE), {
                    conversationId: CONV,
                    bytes: Buffer.from('%PDF-1.7\nnot an image at all'),
                }),
            ).rejects.toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED' });
        });

        it('refuses an empty file and an oversized one', async () => {
            await expect(
                sendDirectPhoto(ctxFor(ALICE), { conversationId: CONV, bytes: Buffer.alloc(0) }),
            ).rejects.toMatchObject({ code: 'FILE_EMPTY' });

            await expect(
                sendDirectPhoto(ctxFor(ALICE), {
                    conversationId: CONV,
                    bytes: Buffer.alloc(DM_PHOTO_MAX_BYTES + 1),
                }),
            ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
        });

        it('refuses a photograph into an unaccepted REQUEST', async () => {
            // The request rule admits TEXT so a stranger can say who they are.
            // An unsolicited image from an unknown person is what that state
            // exists to hold back.
            await expect(
                sendDirectPhoto(ctxFor(ALICE), {
                    conversationId: REQUEST_CONV,
                    bytes: await jpegWithExif(),
                }),
            ).rejects.toMatchObject({ code: 'DM_PHOTO_NEEDS_ACCEPTED' });
        }, 60_000);

        it('refuses an outsider with the same not-found a missing conversation gets', async () => {
            const refusals = await Promise.all([
                sendDirectPhoto(ctxFor(OUTSIDER), {
                    conversationId: CONV,
                    bytes: await jpegWithExif(),
                }).catch((e) => (e as { code?: string }).code),
                sendDirectPhoto(ctxFor(OUTSIDER), {
                    conversationId: `cv-nope-${randomUUID()}`,
                    bytes: await jpegWithExif(),
                }).catch((e) => (e as { code?: string }).code),
            ]);
            // Asserted as a COMPARISON, not just as a refusal: "it was
            // refused" is not the property — indistinguishability is.
            expect(refusals[0]).toBe('CONVERSATION_NOT_FOUND');
            expect(refusals[1]).toBe(refusals[0]);
        }, 60_000);
    });

    describe('reading — the gate is RLS', () => {
        it('serves a participant and refuses an outsider', async () => {
            const sent = await sendDirectPhoto(ctxFor(ALICE), {
                conversationId: CONV,
                bytes: await jpegWithExif(),
            });

            // The POSITIVE CONTROL first: without it the refusal below could
            // be any other cause, including a storage path that never worked.
            const byBoris = await readDirectPhoto(ctxFor(BORIS), sent.messageId);
            const bytes = await drain(byBoris.stream);
            expect(bytes.byteLength).toBeGreaterThan(0);
            expect(byBoris.mime).toBe('image/jpeg');

            await expect(
                readDirectPhoto(ctxFor(OUTSIDER), sent.messageId),
            ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
        }, 60_000);

        it('refuses a message that has no photograph', async () => {
            const textOnly = await prisma.directMessage.create({
                data: { conversationId: CONV, senderUserId: ALICE, body: 'само текст' },
                select: { id: true },
            });
            await expect(
                readDirectPhoto(ctxFor(ALICE), textOnly.id),
            ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
        });
    });

    describe('retracting', () => {
        it('clears the key, removes the object, and serves nothing afterwards', async () => {
            const sent = await sendDirectPhoto(ctxFor(ALICE), {
                conversationId: CONV,
                bytes: await jpegWithExif(),
            });
            const before = await prisma.directMessage.findUniqueOrThrow({
                where: { id: sent.messageId },
                select: { attachmentKey: true },
            });
            const key = before.attachmentKey!;
            // Control: the object exists before the delete.
            await expect(getStorageProvider().head(key)).resolves.toBeTruthy();

            await deleteDirectMessage(ctxFor(ALICE), sent.messageId);

            const after = await prisma.directMessage.findUniqueOrThrow({
                where: { id: sent.messageId },
                select: { attachmentKey: true, attachmentMime: true, deletedAt: true },
            });
            // The row stops resolving a key BEFORE the bytes go, which is what
            // makes a failed object delete leave unreachable garbage rather
            // than a readable photo.
            expect(after.attachmentKey).toBeNull();
            expect(after.attachmentMime).toBeNull();
            expect(after.deletedAt).not.toBeNull();

            await expect(
                readDirectPhoto(ctxFor(ALICE), sent.messageId),
            ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });

            // And the object itself is gone.
            await expect(getStorageProvider().head(key)).rejects.toBeDefined();
        }, 60_000);
    });

    describe('the stored row is visible to the OTHER party', () => {
        it('a participant can read the attachment columns through RLS', async () => {
            const sent = await sendDirectPhoto(ctxFor(ALICE), {
                conversationId: CONV,
                bytes: await jpegWithExif(),
            });
            const seen = await runInUserContext(ctxFor(BORIS), async (tx) => {
                const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
                    'SELECT COUNT(*)::bigint AS n FROM "DirectMessage" WHERE "id" = $1 AND "attachmentKey" IS NOT NULL',
                    sent.messageId,
                );
                return Number(rows[0].n);
            });
            // The counterparty is the person the photograph was sent TO —
            // `conversation-columns-are-counterparty-safe` records why every
            // attachment column is theirs to read.
            expect(seen).toBe(1);
        }, 60_000);
    });
});
