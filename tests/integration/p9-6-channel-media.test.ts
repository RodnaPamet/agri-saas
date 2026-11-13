/**
 * P9.6 — channel voice notes and photographs (#2940).
 *
 * The properties this file exists for, each with the reason it can fail:
 *
 *   · a NON-MEMBER cannot post media and cannot FETCH it, and the two are
 *     different refusals in different places — the post is gated by the
 *     channel's own posting rule, the bytes by a membership read in the egress
 *     usecase. A test that only checked posting would miss that `channel_post_
 *     select` is PUBLIC, so a non-member can see the row and its key;
 *   · a REMOVED post serves nothing, for all three removal columns, because
 *     they mean three different things and any of them must stop the bytes;
 *   · the byte ceiling is the enforceable cap and the DECLARED duration is
 *     validated but never trusted — asserted as two separate refusals, since
 *     conflating them is exactly what #2940 warns about;
 *   · a photograph is STRIPPED and a voice note is NOT, which is a limitation
 *     rather than an oversight and is asserted so nobody "fixes" the test
 *     instead of the gap (#3042).
 *
 * Every refusal is paired with the same call by somebody entitled to make it.
 * P8.1 is why that is a rule here: three refusal cases passed there while
 * nothing could insert at all.
 */
import { randomUUID } from 'crypto';

import sharp from 'sharp';

import { prisma } from '@/lib/prisma';
import { getStorageProvider } from '@/lib/storage';
import {
    postChannelPhoto,
    postChannelVoiceNote,
    readChannelAttachment,
    VOICE_NOTE_MAX_BYTES,
    VOICE_NOTE_MAX_MS,
} from '@/app-layer/usecases/channel-media';
import { joinChannel, readChannelFeed } from '@/app-layer/usecases/channels';
import type { UserContext } from '@/app-layer/types';

import { DB_AVAILABLE } from './db-helper';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = randomUUID().slice(0, 8);
const MEMBER = `u-p96-member-${TAG}`;
const OUTSIDER = `u-p96-outsider-${TAG}`;
const KEY = `crop:p96-${TAG}`;

let channelId = '';

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

/** A real JPEG carrying EXIF, so the stripping assertion has something to remove. */
async function jpegWithExif(): Promise<Buffer> {
    return sharp({
        create: { width: 48, height: 32, channels: 3, background: { r: 20, g: 110, b: 60 } },
    })
        .withMetadata({ exif: { IFD0: { Copyright: 'Rodna Pamet', Software: 'p96-fixture' } } })
        .jpeg()
        .toBuffer();
}

/**
 * A minimal m4a — `ftyp` with the `M4A ` brand, which is what the sniffer
 * keys on.
 *
 * Hand-built rather than encoded: the module under test is a magic-number
 * check and a byte counter, so a real AAC stream would add a dependency and
 * assert nothing extra. The brand is the part that decides, and a fixture that
 * carried `mp42` instead would be REFUSED — which is its own case below.
 */
function m4a(payloadBytes = 2048, brand = 'M4A '): Buffer {
    const head = Buffer.alloc(12);
    head.writeUInt32BE(payloadBytes + 12, 0);
    head.write('ftyp', 4, 'latin1');
    head.write(brand, 8, 'latin1');
    // Deterministic filler: a pattern rather than zeros, so a storage layer
    // that silently truncated a run of nulls would be visible in the digest.
    const body = Buffer.alloc(payloadBytes);
    for (let i = 0; i < payloadBytes; i++) body[i] = (i * 31) % 251;
    return Buffer.concat([head, body]);
}

describeFn('P9.6 — channel media (#2940)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        const c = await prisma.channel.create({
            data: { key: KEY, nameBg: 'Медия', nameEn: 'Media', kind: 'CROP' },
            select: { id: true },
        });
        channelId = c.id;
        await joinChannel(ctxFor(MEMBER), channelId);
    }, 120_000);

    afterAll(async () => {
        const posts = await prisma.channelPost.findMany({
            where: { channelId },
            select: { attachmentKey: true },
        });
        for (const p of posts) {
            if (p.attachmentKey) {
                await getStorageProvider().delete(p.attachmentKey).catch(() => undefined);
            }
        }
        await prisma.channelPost.deleteMany({ where: { channelId } });
        await prisma.channelMembership.deleteMany({ where: { channelId } });
        await prisma.channel.delete({ where: { id: channelId } }).catch(() => undefined);
        await prisma.$disconnect();
    }, 60_000);

    describe('§1 the happy paths, so the refusals below mean something', () => {
        it('a member posts a photograph with no caption, and the feed shows it', async () => {
            const original = await jpegWithExif();
            // The CONTROL for the stripping assertion: the input must actually
            // carry metadata, or "none afterwards" is true of a fixture that
            // never had any.
            expect((await sharp(original).metadata()).exif).toBeDefined();

            const posted = await postChannelPhoto(ctxFor(MEMBER), channelId, { bytes: original });

            const row = await prisma.channelPost.findUniqueOrThrow({
                where: { id: posted.postId },
                select: {
                    body: true,
                    attachmentKey: true,
                    attachmentMime: true,
                    attachmentBytes: true,
                    attachmentSha256: true,
                    attachmentDurationMs: true,
                },
            });
            // A photograph alone is a complete post — the whole reason `body`
            // became nullable.
            expect(row.body).toBeNull();
            expect(row.attachmentMime).toBe('image/jpeg');
            expect(row.attachmentKey).toMatch(/^channel\//);
            expect(row.attachmentBytes).toBeGreaterThan(0);
            expect(row.attachmentSha256).toMatch(/^[0-9a-f]{64}$/);
            // Audio only, enforced by a CHECK constraint as well as here.
            expect(row.attachmentDurationMs).toBeNull();

            const feed = await readChannelFeed(ctxFor(MEMBER), channelId, {});
            const mine = feed.posts.find((p) => p.id === posted.postId);
            expect(mine?.attachment).toMatchObject({ mime: 'image/jpeg', durationMs: null });
            // The view keeps `body` a string for every client.
            expect(mine?.body).toBe('');
            expect(mine?.deleted).toBe(false);
        }, 60_000);

        it('the stored photograph has NO metadata — the strip ran', async () => {
            const original = await jpegWithExif();
            const posted = await postChannelPhoto(ctxFor(MEMBER), channelId, { bytes: original });
            const out = await readChannelAttachment(ctxFor(MEMBER), posted.postId);

            const chunks: Buffer[] = [];
            for await (const c of out.stream) chunks.push(Buffer.from(c));
            const served = Buffer.concat(chunks);

            expect(out.mime).toBe('image/jpeg');
            expect((await sharp(served).metadata()).exif).toBeUndefined();
        }, 60_000);

        it('a member posts a voice note with a caption, and the duration is stored', async () => {
            const posted = await postChannelVoiceNote(ctxFor(MEMBER), channelId, {
                bytes: m4a(),
                durationMs: 42_000,
                body: '  Чуйте това  ',
            });
            const row = await prisma.channelPost.findUniqueOrThrow({
                where: { id: posted.postId },
                select: { body: true, attachmentMime: true, attachmentDurationMs: true },
            });
            expect(row.attachmentMime).toBe('audio/mp4');
            expect(row.attachmentDurationMs).toBe(42_000);
            // Trimmed, like every other stored caption in the product.
            expect(row.body).toBe('Чуйте това');
        }, 60_000);

        it('a voice note is NOT stripped, and that is the known gap (#3042)', async () => {
            /*
             * Asserted so the limitation is visible in a test rather than only
             * in a docblock. `stripImageMetadata` handles images and
             * `stripPdfMetadata` PDFs; neither touches an audio container, so
             * the stored bytes are byte-identical to what arrived.
             *
             * If somebody adds audio stripping, THIS test fails — which is the
             * right failure: it says the gap closed and the claim in
             * `channel-media.ts` needs deleting.
             */
            const original = m4a(4096);
            const posted = await postChannelVoiceNote(ctxFor(MEMBER), channelId, {
                bytes: original,
                durationMs: 1_000,
            });
            const out = await readChannelAttachment(ctxFor(MEMBER), posted.postId);
            const chunks: Buffer[] = [];
            for await (const c of out.stream) chunks.push(Buffer.from(c));
            expect(Buffer.concat(chunks).equals(original)).toBe(true);
        }, 60_000);
    });

    describe('§2 the duration is validated and the BYTES are the cap', () => {
        it('refuses a recording over two minutes by its DECLARED length', async () => {
            await expect(
                postChannelVoiceNote(ctxFor(MEMBER), channelId, {
                    bytes: m4a(),
                    durationMs: VOICE_NOTE_MAX_MS + 1,
                }),
            ).rejects.toMatchObject({ code: 'VOICE_NOTE_TOO_LONG' });
        }, 60_000);

        it('refuses a missing or nonsensical duration', async () => {
            for (const durationMs of [0, -1, 1.5]) {
                await expect(
                    postChannelVoiceNote(ctxFor(MEMBER), channelId, { bytes: m4a(), durationMs }),
                ).rejects.toMatchObject({ code: 'VOICE_NOTE_DURATION_REQUIRED' });
            }
        }, 60_000);

        it('refuses bytes over the ceiling EVEN with an honest duration — the cap', async () => {
            /*
             * The two refusals are separate on purpose. A caller can declare a
             * truthful 30 seconds and still exceed the ceiling by encoding at
             * 320 kbps stereo; the ceiling is what bounds storage, and the
             * duration is what bounds the scrubber. #2940 asks which is
             * authoritative, and this is that answer as an assertion.
             */
            await expect(
                postChannelVoiceNote(ctxFor(MEMBER), channelId, {
                    bytes: m4a(VOICE_NOTE_MAX_BYTES + 1),
                    durationMs: 30_000,
                }),
            ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
        }, 120_000);

        it('refuses an mp4 whose brand is not an audio one', async () => {
            // `mp42` is the generic brand a VIDEO file carries, and the sniffer
            // refuses to call it audio because separating them needs a parser.
            await expect(
                postChannelVoiceNote(ctxFor(MEMBER), channelId, {
                    bytes: m4a(1024, 'mp42'),
                    durationMs: 5_000,
                }),
            ).rejects.toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED' });
        }, 60_000);

        it('refuses a photograph sent down the voice path, and vice versa', async () => {
            const jpeg = await jpegWithExif();
            await expect(
                postChannelVoiceNote(ctxFor(MEMBER), channelId, { bytes: jpeg, durationMs: 1_000 }),
            ).rejects.toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED' });
            await expect(
                postChannelPhoto(ctxFor(MEMBER), channelId, { bytes: m4a() }),
            ).rejects.toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED' });
        }, 60_000);
    });

    describe('§3 membership — posting AND fetching, which are different gates', () => {
        it('an outsider cannot post media', async () => {
            await expect(
                postChannelPhoto(ctxFor(OUTSIDER), channelId, { bytes: await jpegWithExif() }),
            ).rejects.toMatchObject({ code: 'CHANNEL_NOT_A_MEMBER' });
        }, 60_000);

        it('an outsider CAN see the post and CANNOT fetch its bytes', async () => {
            const posted = await postChannelVoiceNote(ctxFor(MEMBER), channelId, {
                bytes: m4a(),
                durationMs: 3_000,
            });

            /*
             * Both halves matter. `channel_post_select` is public by design, so
             * the outsider genuinely sees the post — asserting only the refusal
             * would pass just as well if the whole channel were invisible to
             * them, which is a different feature.
             */
            const feed = await readChannelFeed(ctxFor(OUTSIDER), channelId, {});
            expect(feed.posts.some((p) => p.id === posted.postId)).toBe(true);

            await expect(
                readChannelAttachment(ctxFor(OUTSIDER), posted.postId),
            ).rejects.toMatchObject({ code: 'CHANNEL_POST_NOT_FOUND' });

            // The member can — the positive the refusal rests on.
            await expect(
                readChannelAttachment(ctxFor(MEMBER), posted.postId),
            ).resolves.toMatchObject({ mime: 'audio/mp4' });
        }, 60_000);
    });

    describe('§4 a removed post serves NOTHING, for all three columns', () => {
        it.each(['deletedAt', 'removedByModerationAt', 'autoHiddenAt'] as const)(
            '%s stops the bytes',
            async (column) => {
                const posted = await postChannelPhoto(ctxFor(MEMBER), channelId, {
                    bytes: await jpegWithExif(),
                });
                // Readable first, so the refusal below is caused by the column
                // rather than by a post that never served anything.
                await expect(
                    readChannelAttachment(ctxFor(MEMBER), posted.postId),
                ).resolves.toMatchObject({ mime: 'image/jpeg' });

                await prisma.channelPost.update({
                    where: { id: posted.postId },
                    data: { [column]: new Date() },
                });

                await expect(
                    readChannelAttachment(ctxFor(MEMBER), posted.postId),
                ).rejects.toMatchObject({ code: 'CHANNEL_POST_NOT_FOUND' });

                // And the view drops the attachment, which is the second layer:
                // a removed post must not advertise what it held.
                const feed = await readChannelFeed(ctxFor(MEMBER), channelId, {});
                const hidden = feed.posts.find((p) => p.id === posted.postId);
                if (hidden) {
                    expect(hidden.attachment).toBeNull();
                    expect(hidden.body).toBe('');
                    expect(hidden.deleted).toBe(true);
                }
            },
            120_000,
        );
    });
});
