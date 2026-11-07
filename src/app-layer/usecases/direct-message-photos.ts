/**
 * Photographs in a direct conversation — P8.6's code stage (#2800).
 *
 * ## This is the RECORD-LESS upload class, and the schema stage decided that
 *
 * `LogEntryFile`, the in-repo attachment precedent, links to `FileRecord` —
 * whose `tenantId` is NOT NULL. A direct message has no tenant, and inventing
 * one (the sender's current farm) would file a person-scoped photograph as a
 * farm record and then hide it from a recipient in a different tenant, because
 * `FileRecord` is RLS-scoped by tenant.
 *
 * So there is no `FileRecord`, no `markStored`, and no `scanStatus` argument
 * whose default could go wrong. Which means the ordering is the mirror image
 * of the record-backed path:
 *
 *   * **`scanOrRefuse` runs BEFORE the write**, because there is no download
 *     gate to defer to. `isDownloadAllowed('SKIPPED')` is true in every
 *     `AV_SCAN_MODE`, so a path that stored first and gated later would be
 *     gating on nothing.
 *   * **The egress gate is PARTICIPATION**, and it is RLS rather than a hand-
 *     written check — see `readDirectPhoto`.
 *
 * ## Metadata is stripped by the SHARED helper
 *
 * `stripImageMetadata` from `@/lib/images/strip-metadata`, not a second
 * stripper. #2800 warns about this by name: grepping `src/lib/upload` for
 * `sharp(` comes back empty and the capability is there. A farm photograph
 * carries GPS, and a parcel location is the thing this is for —
 * `uploads-strip-image-metadata` derives its population from the filesystem,
 * so this file is in it the moment it exists.
 *
 * ## The bytes are stored BEFORE the row, deliberately
 *
 * A failed insert then leaves an object nothing references, which is garbage
 * rather than a leak: `readDirectPhoto` resolves a key only through a message
 * row the caller can see, so an unreferenced object is unreachable. The other
 * order — row first, then bytes — leaves a message pointing at nothing, which
 * a reader experiences as a broken photograph in a conversation that looks
 * fine. Same reasoning as `PublicFarmProfile` being the AUTHORITY for public
 * media rather than a copy of it.
 */
import { randomUUID } from 'crypto';
import type { Readable } from 'node:stream';

import prisma from '@/lib/prisma';
import { codedBadRequest, codedNotFound } from '@/lib/errors/types';
import { stripImageMetadata } from '@/lib/images/strip-metadata';
import { logger } from '@/lib/observability/logger';
import { getStorageProvider } from '@/lib/storage';
import { sniffMimeType } from '@/lib/storage/mime-sniff';
import { scanOrRefuse } from '@/lib/upload/ingest';
import { runInUserContext } from '@/lib/db-context';
import { publishPersonEvent } from '@/lib/notifications/notification-bus';
import type { UserContext } from '@/app-layer/types';

/**
 * Cap on what a caller may upload, mirroring `AVATAR_UPLOAD_MAX_BYTES`.
 *
 * Not a new ruling: the owner set 4 MB for an avatar on 2026-10-16 with the
 * reasoning that a photo straight off an iPhone is 1–3 MB, so the cap clears
 * the honest path and bounds a web caller picking a full-size camera JPEG. A
 * DM photograph is the same artefact from the same camera, so it takes the
 * same number rather than a second one somebody would later have to reconcile.
 */
export const DM_PHOTO_MAX_BYTES = 4 * 1024 * 1024;

/** What a conversation photograph may be. */
const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp']);

function notThere(): never {
    throw codedNotFound('CONVERSATION_NOT_FOUND', 'Not found.');
}

/** The stored extension for each type we accept. */
const EXTENSION: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
};

function photoKey(conversationId: string, id: string, mime: string): string {
    return `dm/${conversationId}/${id}.${EXTENSION[mime] ?? 'bin'}`;
}

export interface SentPhoto {
    readonly messageId: string;
    readonly createdAt: Date;
}

/**
 * Send a photograph, optionally with a caption.
 *
 * The caption is OPTIONAL because the owner ruled a photo alone is a complete
 * message (2026-11-07), which is why `DirectMessage.body` is nullable and the
 * CHECK constraint accepts a row with an attachment and no text.
 */
export async function sendDirectPhoto(
    ctx: UserContext,
    input: { conversationId: string; bytes: Buffer; body?: string | null },
): Promise<SentPhoto> {
    // The SHARED upload codes — `FILE_EMPTY`, `FILE_TOO_LARGE`,
    // `FILE_TYPE_NOT_ALLOWED` — the same three `@/lib/upload/ingest` throws,
    // not an `UPLOAD_*` family of my own.
    //
    // The first draft coined three synonyms, and `a-new-code-ships-with-its-entry`
    // refused them: a new code needs a Bulgarian entry, and the honest way to
    // get one here is to not be new. A client switching on the refusal should
    // not have to learn that a photograph in a conversation reports a size
    // limit differently from every other upload in the product — that is the
    // nav-vocabulary argument applied to error codes.
    if (input.bytes.byteLength === 0) {
        throw codedBadRequest('FILE_EMPTY', 'That file is empty.');
    }
    if (input.bytes.byteLength > DM_PHOTO_MAX_BYTES) {
        throw codedBadRequest('FILE_TOO_LARGE', 'That photograph is too large.');
    }

    // SNIFFED, not trusted. A declared content-type is the caller's claim; the
    // magic number is the file. The allowlist is checked against the sniff for
    // that reason.
    const sniffed = sniffMimeType(input.bytes);
    if (!sniffed || !ACCEPTED.has(sniffed)) {
        throw codedBadRequest('FILE_TYPE_NOT_ALLOWED', 'That is not a photograph we accept.');
    }

    // Participation BEFORE any work: refusing early means an outsider cannot
    // make the server decode an image, and the refusal is the same not-found
    // every other DM path answers.
    const conversation = await runInUserContext(ctx, async (db) => {
        const row = await db.conversation.findUnique({
            where: { id: input.conversationId },
            select: { id: true, state: true },
        });
        return row;
    });
    if (!conversation) notThere();
    if (conversation.state !== 'ACCEPTED') {
        // A photograph is not the one message a stranger gets. The request
        // rule admits text so somebody can say who they are; an unsolicited
        // image from an unknown person is the thing a request state exists to
        // hold back.
        throw codedBadRequest('DM_PHOTO_NEEDS_ACCEPTED', 'Not accepted yet.');
    }

    // SCAN FIRST, on the ORIGINAL bytes — the order is the whole safety
    // argument and I had it backwards in the first draft.
    //
    // `uploads-strip-image-metadata` states the reason: stripping DECODES
    // caller bytes with libvips, so the scan must precede it. The exposure is
    // not "what the scanner sees" but the decoder itself — feeding unscanned
    // caller bytes to libvips is the attack surface, and re-encoding before
    // scanning would hand it every file.
    //
    // This path also has no download gate to defer to — there is no
    // `FileRecord`, so nothing carries a `scanStatus` and nothing downstream
    // could consult one. `scanOrRefuse` IS the gate, moved to ingest.
    await scanOrRefuse(input.bytes, {
        component: 'direct-message-photos',
        subjectId: input.conversationId,
        // `exposure` is REQUIRED without a default by design (#1811): the
        // forcing function is the absence of one, so a new upload surface does
        // not compile until it says who can read the bytes. A conversation
        // photograph is readable by its participants and nobody else.
        exposure: 'private',
    });

    // THEN strip, through the SHARED helper — a farm photograph carries GPS,
    // and a parcel location is exactly what must not travel.
    //
    // It PRESERVES THE FORMAT. It re-encodes to drop metadata, not to convert:
    // `STRIPPABLE` maps each mime to its own encoder, and `StripResult` is
    // `{ bytes, stripped }` with no output type because there is nothing to
    // report. The first draft of this file assumed a WebP conversion and
    // stored `image/webp` for every photograph — so a JPEG was served with a
    // WebP content type and, behind the `nosniff` header the egress route
    // sets, would simply have failed to render. The test caught it.
    const stripped = await stripImageMetadata(input.bytes, sniffed, {
        component: 'direct-message-photos',
    });

    const id = randomUUID();
    const key = photoKey(input.conversationId, id, sniffed);
    const written = await getStorageProvider().write(key, stripped.bytes, {
        mimeType: sniffed,
        // Enforced again at the stream, after the re-encode: `stripImageMetadata`
        // returns a NEW buffer, so the size checked at the door is not the size
        // being stored.
        maxSizeBytes: DM_PHOTO_MAX_BYTES,
    });

    const message = await prisma.$transaction(async (tx) => {
        const created = await tx.directMessage.create({
            data: {
                conversationId: input.conversationId,
                senderUserId: ctx.userId,
                body: input.body?.trim() ? input.body.trim() : null,
                attachmentKey: key,
                // The SNIFFED type, which is what the bytes are after
                // stripping — the helper preserves format.
                attachmentMime: sniffed,
                attachmentBytes: written.sizeBytes,
                attachmentSha256: written.sha256,
            },
            select: { id: true, createdAt: true },
        });
        // Atomic with the insert, for the reason `sendDirectMessage` gives:
        // the request rule reads this column, and a stamp outside the
        // transaction leaves a crash window.
        await tx.conversation.update({
            where: { id: input.conversationId },
            data: { lastMessageAt: created.createdAt },
        });
        return created;
    });

    // After the transaction and directly, not through `afterCommit` — a bare
    // `$transaction` opens no db-context scope (#1619).
    for (const userId of await otherParticipantIds(input.conversationId, ctx.userId)) {
        publishPersonEvent(userId, { id: input.conversationId });
    }

    logger.info('dm.photo_sent', {
        component: 'direct-message-photos',
        conversationId: input.conversationId,
        bytes: written.sizeBytes,
        stripped: stripped.stripped,
    });

    return { messageId: message.id, createdAt: message.createdAt };
}

/**
 * Read one photograph back.
 *
 * ## RLS is the participation gate, not a hand-written check
 *
 * The lookup runs under `runInUserContext`, where `direct_message_select`
 * admits a participant's rows and nobody else's — so a non-participant's query
 * returns nothing and the empty result becomes the not-found. The refusal is
 * the database's, which is the property P8.2 relies on for every other DM
 * read, and it means there is no second spelling of "may this person see it"
 * to drift from the first.
 *
 * It also makes an ORPHANED object unreachable: a key is resolved only through
 * a row, so bytes written by a transaction that then failed can never be
 * served.
 */
export async function readDirectPhoto(
    ctx: UserContext,
    messageId: string,
): Promise<{ stream: Readable; mime: string; sha256: string | null }> {
    const row = await runInUserContext(ctx, async (db) =>
        db.directMessage.findUnique({
            where: { id: messageId },
            select: {
                attachmentKey: true,
                attachmentMime: true,
                attachmentSha256: true,
                deletedAt: true,
            },
        }),
    );

    // Four causes, one answer: no such message, not a participant, no
    // photograph on it, or retracted. Telling them apart would disclose which.
    if (!row || !row.attachmentKey || row.deletedAt) notThere();

    return {
        stream: getStorageProvider().readStream(row.attachmentKey),
        // Stored per message rather than assumed, because the stripper
        // preserves the input format — a conversation can hold a JPEG and a
        // PNG, and serving both as one type is how `nosniff` turns into a
        // broken image.
        mime: row.attachmentMime ?? 'application/octet-stream',
        sha256: row.attachmentSha256,
    };
}

/**
 * Everybody in the conversation except the caller.
 *
 * Duplicated from `direct-messages.ts` rather than exported from it, because
 * exporting would make a privileged participant read part of that module's
 * public surface — and `no-direct-prisma` allowlists these two files
 * individually. Both copies return IDS ONLY and both are bounded.
 */
async function otherParticipantIds(conversationId: string, selfUserId: string): Promise<string[]> {
    const rows = await prisma.conversationParticipant.findMany({
        where: { conversationId, userId: { not: selfUserId }, leftAt: null },
        select: { userId: true },
        take: 10,
    });
    return rows.map((r) => r.userId);
}
