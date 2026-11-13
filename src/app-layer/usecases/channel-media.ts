/**
 * Channel voice notes and photographs — P9.6 (#2940).
 *
 * ## The RECORD-LESS upload class, and why that is forced rather than chosen
 *
 * `FileRecord.tenantId` is NOT NULL and a channel has no tenant. Filing a
 * channel recording under the author's current farm would make it a farm
 * record — and then hide it from members in other tenants, because
 * `FileRecord` is RLS-scoped by tenant. So there is no `FileRecord`, which has
 * two consequences CLAUDE.md's upload convention states as a pair:
 *
 *   * **`scanOrRefuse` runs BEFORE the write.** The record-backed shape is
 *     allowed to store first because the download route asks
 *     `isDownloadAllowed` on the way out; here nothing carries a `scanStatus`
 *     and nothing downstream could consult one, so the scan IS the gate.
 *   * **Egress authorises by MEMBERSHIP.** The DM photo authorises by
 *     participation; the same shape with the channel's own audience.
 *
 * ## «max 2:00» — the BYTE CEILING is the cap, the duration is metadata
 *
 * #2940 asks which measure is authoritative and says a cap the recorder
 * enforces is a suggestion. The answer: the server sees bytes, not seconds, so
 * `VOICE_NOTE_MAX_BYTES` is the enforceable cap and `attachmentDurationMs` is a
 * validated claim stored so the UI can size a scrubber without downloading the
 * file.
 *
 * **What that does and does not bound, stated plainly.** The ceiling bounds
 * STORAGE AND BANDWIDTH exactly. It bounds DURATION only approximately: a
 * caller who encodes speech at 8 kbps can fit far more than two minutes under
 * it, and one who sends 320 kbps stereo will be refused well short of two
 * minutes. Enforcing seconds exactly would mean decoding the container
 * server-side, which this does not do — `mime-sniff` is explicitly "a
 * magic-number check, not a parser", and adding an audio decoder to an upload
 * path is a larger attack surface than the cap is worth.
 *
 * So a declared duration is NOT evidence. It is refused when it is absent,
 * zero, negative or over the cap, which stops a client writing nonsense into a
 * column the UI reads — and nothing more than that is claimed for it.
 *
 * ## What an AV scan of an audio container establishes
 *
 * Less than it sounds, and it is still the right gate. ClamAV matches known
 * signatures; against an m4a or an Ogg page that means **"these bytes are not a
 * known-malicious payload"**, not "this is a valid recording" and not "this
 * audio is safe to decode". The decoder on the far side is the phone's, and
 * the thing the scan protects against is a payload dressed as a recording.
 * Stated here because #2940 asks it to be, and because a PR that implied more
 * would be the kind of claim `a-claim-is-a-liability-for-its-breadth` names.
 *
 * ## AUDIO METADATA IS NOT STRIPPED, and nothing in this repo strips it
 *
 * `stripImageMetadata` handles images and `stripPdfMetadata` PDFs; each returns
 * the other's formats untouched, and neither touches an audio container. An m4a
 * can carry an `©too`/encoder tag and, on some recorders, a location atom.
 *
 * A photograph on this path IS stripped, through the shared helper, because a
 * farm photo carries GPS and a parcel location is exactly what must not
 * travel. A voice note is not, and the honest consequence is that a recording
 * made by an app that writes location into the container would carry it. #3042
 * tracks that; it is a real gap and it is smaller than the photo one, since a
 * voice note is recorded in the app rather than picked from a library.
 */
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import { codedBadRequest, codedForbidden, codedNotFound } from '@/lib/errors/types';
import { runInUserContext } from '@/lib/db-context';
import { prisma } from '@/lib/prisma';
import { getStorageProvider } from '@/lib/storage';
import { stripImageMetadata } from '@/lib/images/strip-metadata';
import { sniffMimeType } from '@/lib/storage/mime-sniff';
import { scanOrRefuse } from '@/lib/upload/ingest';

import type { UserContext } from '../types';
import { assertMayPost } from './channels';

/**
 * A photograph takes the SAME ceiling as an avatar and a DM photo.
 *
 * Not a new ruling: the owner set 4 MB for an avatar on 2026-10-16, reasoning
 * that a photo straight off an iPhone is 1–3 MB. A channel photograph is the
 * same artefact from the same camera, so it takes the same number rather than a
 * third one somebody would later have to reconcile.
 */
export const CHANNEL_PHOTO_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The voice note ceiling, DERIVED rather than picked.
 *
 * Two minutes of speech is the phase's cap. AAC-LC mono at 64 kbps — what
 * `AVAudioRecorder` produces by default for voice — is 8 KB/s, so 120 s is
 * ~960 KB. 1.5 MB clears that with room for a VBR peak and a container header,
 * and refuses a stereo 192 kbps recording at about 65 seconds.
 *
 * That asymmetry is the point and is why the docblock above calls this a
 * storage bound rather than a duration one: the number is chosen so an HONEST
 * two-minute recording always fits, not so a dishonest one is caught.
 */
export const VOICE_NOTE_MAX_BYTES = Math.floor(1.5 * 1024 * 1024);

/** «max 2:00» as the phase states it. */
export const VOICE_NOTE_MAX_MS = 120_000;

/** What a channel photograph may be — the DM photo allowlist, unchanged. */
const PHOTO_ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * What a voice note may be.
 *
 * `audio/webm` is deliberately absent: its EBML magic is shared with
 * video/webm and the two cannot be separated without parsing the track list,
 * so accepting it would let a video through a cap written for speech. See
 * `mime-sniff`'s own note — iOS records m4a natively, which is the client this
 * unblocks.
 */
const AUDIO_ACCEPTED = new Set(['audio/mp4', 'audio/ogg']);

const EXTENSION: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'audio/mp4': 'm4a',
    'audio/ogg': 'ogg',
};

function notThere(): never {
    throw codedNotFound('CHANNEL_POST_NOT_FOUND', 'That post does not exist.');
}

function mediaKey(channelId: string, id: string, mime: string): string {
    return `channel/${channelId}/${id}.${EXTENSION[mime] ?? 'bin'}`;
}

export interface PostedMedia {
    readonly postId: string;
    readonly createdAt: Date;
}

/**
 * Shared door: the three refusals every upload on this path gives, in the
 * order that refuses soonest.
 *
 * The SHARED upload codes, not a `CHANNEL_UPLOAD_*` family of my own — the DM
 * photo path records why: a client switching on a refusal should not have to
 * learn that a photograph in a channel reports a size limit differently from
 * every other upload in the product.
 */
function checkBytes(bytes: Buffer, max: number, accepted: Set<string>, what: string): string {
    if (bytes.byteLength === 0) {
        throw codedBadRequest('FILE_EMPTY', 'That file is empty.');
    }
    if (bytes.byteLength > max) {
        throw codedBadRequest('FILE_TOO_LARGE', `That ${what} is too large.`);
    }
    // SNIFFED, not trusted. A declared content-type is the caller's claim; the
    // magic number is the file.
    const sniffed = sniffMimeType(bytes);
    if (!sniffed || !accepted.has(sniffed)) {
        throw codedBadRequest('FILE_TYPE_NOT_ALLOWED', `That is not a ${what} we accept.`);
    }
    return sniffed;
}

/**
 * Post a photograph, with an optional caption.
 *
 * The caption is optional because the CHECK constraint accepts a row with an
 * attachment and no text — a photograph alone is a complete post.
 */
export async function postChannelPhoto(
    ctx: UserContext,
    channelId: string,
    input: { bytes: Buffer; body?: string | null },
): Promise<PostedMedia> {
    const sniffed = checkBytes(input.bytes, CHANNEL_PHOTO_MAX_BYTES, PHOTO_ACCEPTED, 'photograph');

    // MEMBERSHIP BEFORE ANY WORK. Refusing early means a non-member cannot
    // make the server decode an image, which is the cheap-work-for-an-outsider
    // shape the rate limiter cannot help with.
    await assertPostable(ctx, channelId);

    // SCAN FIRST, on the ORIGINAL bytes. `uploads-strip-image-metadata` gives
    // the reason: stripping DECODES caller bytes with libvips, so the scan must
    // precede it. The exposure is the decoder itself, not what the scanner
    // sees.
    await scanOrRefuse(input.bytes, {
        component: 'channel-media',
        subjectId: channelId,
        // REQUIRED without a default (#1811) so a new upload surface does not
        // compile until it says who can read the bytes. A channel attachment is
        // readable by that channel's members.
        exposure: 'private',
    });

    // THEN strip — a farm photograph carries GPS, and a parcel location is
    // exactly what must not travel. The helper PRESERVES the format; the DM
    // path records what assuming a WebP conversion cost.
    const stripped = await stripImageMetadata(input.bytes, sniffed, { component: 'channel-media' });

    return writePost(ctx, channelId, {
        bytes: stripped.bytes,
        mime: sniffed,
        body: input.body ?? null,
        durationMs: null,
    });
}

/**
 * Post a voice note. The duration is the client's claim, validated.
 */
export async function postChannelVoiceNote(
    ctx: UserContext,
    channelId: string,
    input: { bytes: Buffer; durationMs: number; body?: string | null },
): Promise<PostedMedia> {
    const sniffed = checkBytes(input.bytes, VOICE_NOTE_MAX_BYTES, AUDIO_ACCEPTED, 'recording');

    /*
     * The duration is checked even though it is not the cap, because the UI
     * reads it: a zero, a negative or a 40-minute claim would render a scrubber
     * nobody can use. `VOICE_NOTE_TOO_LONG` is its own code rather than
     * `FILE_TOO_LARGE`, because the two refusals have different remedies — one
     * says record less, the other says the file is too big, and a client that
     * showed "too large" for a 2:01 recording would send somebody looking for a
     * compression setting.
     */
    if (!Number.isInteger(input.durationMs) || input.durationMs <= 0) {
        throw codedBadRequest('VOICE_NOTE_DURATION_REQUIRED', 'That recording has no length.');
    }
    if (input.durationMs > VOICE_NOTE_MAX_MS) {
        throw codedBadRequest('VOICE_NOTE_TOO_LONG', 'That recording is longer than two minutes.');
    }

    await assertPostable(ctx, channelId);

    // The scan, on bytes nothing has re-encoded. What it establishes for an
    // audio container is in this module's header: not a known-malicious
    // payload, which is less than it sounds and is still the right gate.
    await scanOrRefuse(input.bytes, {
        component: 'channel-media',
        subjectId: channelId,
        exposure: 'private',
    });

    // NO metadata strip — nothing in this repo strips an audio container, and
    // the header says so rather than letting the image path imply coverage.
    return writePost(ctx, channelId, {
        bytes: input.bytes,
        mime: sniffed,
        body: input.body ?? null,
        durationMs: input.durationMs,
    });
}

/**
 * The channel's own refusals, through the ONE gate `channels.ts` owns.
 *
 * Read in its own short transaction so the storage write below is not holding
 * one: a write to object storage can take as long as the network does, and
 * holding a pool connection across it is how `PG_POOL_MAX` is exhausted by
 * something that is not a query.
 */
async function assertPostable(ctx: UserContext, channelId: string): Promise<void> {
    await runInUserContext(ctx, async (tx) => {
        const channel = await tx.channel.findUnique({
            where: { id: channelId },
            select: { id: true, archivedAt: true, slowModeSeconds: true },
        });
        if (!channel) throw codedNotFound('CHANNEL_NOT_FOUND', 'That channel does not exist.');
        if (channel.archivedAt) throw codedBadRequest('CHANNEL_ARCHIVED', 'That channel is closed.');
        await assertMayPost(tx, channelId, ctx.userId, channel.slowModeSeconds);
    });
}

/**
 * Store the bytes, then insert the post.
 *
 * The insert runs as the CALLER so `channel_post_insert`'s WITH CHECK enforces
 * the access rules — a privileged insert here would be the
 * `SECURITY DEFINER` trap P8.2 records, where the write crosses RLS on a role
 * attribute nobody declared.
 *
 * An orphaned object is the accepted failure: if the insert fails after the
 * write, the bytes sit unreferenced rather than a post existing with no media.
 * The other order — insert, then write — would leave a post whose attachment
 * 404s, which is visible to every reader instead of to nobody.
 */
async function writePost(
    ctx: UserContext,
    channelId: string,
    media: { bytes: Buffer; mime: string; body: string | null; durationMs: number | null },
): Promise<PostedMedia> {
    const id = randomUUID();
    const key = mediaKey(channelId, id, media.mime);
    const written = await getStorageProvider().write(key, media.bytes, {
        mimeType: media.mime,
        // Enforced AGAIN at the stream: `stripImageMetadata` returns a NEW
        // buffer, so the size checked at the door is not the size being stored.
        maxSizeBytes: media.mime.startsWith('audio/')
            ? VOICE_NOTE_MAX_BYTES
            : CHANNEL_PHOTO_MAX_BYTES,
    });

    const body = media.body?.trim() ? media.body.trim() : null;

    return runInUserContext(ctx, async (tx) => {
        const post = await tx.channelPost.create({
            data: {
                channelId,
                authorUserId: ctx.userId,
                body,
                attachmentKey: key,
                attachmentMime: media.mime,
                attachmentBytes: written.sizeBytes,
                attachmentSha256: written.sha256,
                ...(media.durationMs !== null ? { attachmentDurationMs: media.durationMs } : {}),
            },
            select: { id: true, createdAt: true },
        });
        return { postId: post.id, createdAt: post.createdAt };
    });
}

/**
 * Serve a post's attachment — MEMBERSHIP, and the three removal columns.
 *
 * ## Why membership, when the POST is readable by any authenticated caller
 *
 * `channel_post_select` is deliberately public (P9.1: nobody joins a channel
 * they cannot look into first), so the row — including `attachmentKey` — is
 * readable by anybody signed in. The BYTES are narrower, and the reason is the
 * voice note rather than the photograph: a recording carries the speaker's
 * VOICE, which is a different class of personal data from their words, and
 * membership is the narrowest audience that still lets the feature work.
 *
 * The key being world-readable costs nothing, because it authenticates
 * nothing — this function is the authority, not possession of the string.
 *
 * ## A removed post serves NOTHING
 *
 * All three removal columns are checked, because they mean three different
 * things and any of them should stop the bytes: `deletedAt` is the author's
 * retraction, `removedByModerationAt` a moderator's decision, `autoHiddenAt`
 * P9.3d's threshold. The row-level check is belt and braces — the code that
 * removes a post also clears the key — but a clearing that fails leaves the
 * key in place, and then this is the only thing between a removed recording
 * and anybody who still has its post id.
 */
export async function readChannelAttachment(
    ctx: UserContext,
    postId: string,
): Promise<{ stream: Readable; mime: string; sha256: string | null }> {
    const post = await runInUserContext(ctx, async (tx) => {
        const row = await tx.channelPost.findUnique({
            where: { id: postId },
            select: {
                channelId: true,
                attachmentKey: true,
                attachmentMime: true,
                attachmentSha256: true,
                deletedAt: true,
                removedByModerationAt: true,
                autoHiddenAt: true,
            },
        });
        if (!row) return null;
        if (row.deletedAt || row.removedByModerationAt || row.autoHiddenAt) return null;
        if (!row.attachmentKey || !row.attachmentMime) return null;

        // The membership read, in the SAME user context — the only row
        // `channel_membership_select` admits is the caller's own, which is
        // exactly the one being asked about.
        const membership = await tx.channelMembership.findUnique({
            where: { channelId_userId: { channelId: row.channelId, userId: ctx.userId } },
            select: { bannedAt: true },
        });
        if (!membership) {
            // The SAME not-found a missing post gives. A distinct refusal would
            // tell a non-member that a post with that id exists and carries
            // media, which is more than the feature needs to say.
            return null;
        }
        return row;
    });
    if (!post || !post.attachmentKey || !post.attachmentMime) notThere();

    // `readStream`, the same call the DM photo egress uses — synchronous and
    // lazy, so a key that no longer exists surfaces as a stream error rather
    // than as a rejected promise here.
    return {
        stream: getStorageProvider().readStream(post.attachmentKey),
        mime: post.attachmentMime,
        sha256: post.attachmentSha256,
    };
}
