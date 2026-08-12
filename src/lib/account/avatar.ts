/**
 * Account avatar — upload, removal, and read-back of a user's own
 * profile photo. Avatar roadmap P3.
 *
 * Account-level (session-scoped), NOT tenant-scoped: a user's avatar
 * is theirs across every tenant, so this lives beside the other
 * account-level helpers rather than in `app-layer/usecases` (which
 * are all tenant-RLS-bound).
 *
 * The image is resized + EXIF-stripped + webp-encoded **client-side**
 * — a `<canvas>` round-trip in `<AvatarUploadField>` — before upload.
 * So this layer never runs image processing: it validates the bytes
 * (a magic-number sniff + a hard size cap, defence-in-depth against a
 * client that bypasses the canvas) and persists them through the
 * storage abstraction. The canvas round-trip also strips EXIF before
 * the image ever leaves the browser, so GPS/camera metadata never
 * reaches the server at all.
 *
 * ── Why the AV scan runs HERE, before the write ──────────────────────
 *
 * This path stores no `FileRecord`, so nothing downstream carries a
 * `scanStatus` and the serve route has nothing to consult: it streams
 * `avatars/<userId>.webp` to any authenticated user who asks, and an
 * avatar is rendered to every colleague in every tenant the owner
 * belongs to. That distribution is the reason an unscanned avatar is
 * worse than it looks — and the reason the scan cannot be deferred to a
 * download gate that does not exist. `scanOrRefuse` is that gate, moved
 * to ingest; see `@/lib/upload/ingest` for which verdicts it stores.
 *
 * Until 2026-08-12 this path called no scanner at all. #543 removed the
 * `markStored` default that had left two `FileRecord` paths unscanned;
 * it did not reach this one, because a path with no record has no
 * `markStored` call for that work to have noticed.
 */
import type { Readable } from 'node:stream';

import prisma from '@/lib/prisma';
import { getStorageProvider } from '@/lib/storage';
import { sniffMimeType } from '@/lib/storage/mime-sniff';
import { scanOrRefuse } from '@/lib/upload/ingest';
import { badRequest } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';

/**
 * Hard upload cap. A 256×256 webp off the client canvas is ~5–25KB;
 * 512KB is a generous safety net for the honest path that still
 * bounds what a canvas-bypassing client can store.
 */
export const AVATAR_MAX_BYTES = 512 * 1024;

/** Deterministic storage key — one avatar per user, always webp. */
export function avatarStorageKey(userId: string): string {
    return `avatars/${userId}.webp`;
}

/** The stable in-app URL written to `User.image` for an uploaded avatar. */
export function avatarServeUrl(userId: string): string {
    return `/api/account/avatar/${userId}`;
}

/**
 * True when the BYTES are a webp — what the client declared is never
 * consulted on this path at all.
 *
 * Delegates to the shared signature table rather than re-reading the
 * RIFF header here. It used to carry its own copy of that read, which
 * is a second implementation of a question the codebase already answers
 * (`sniffMimeType` recognises webp, and the upload pipeline's
 * `reconcileMimeType` stands on it) — and two magic-number readers
 * agree only until one of them is corrected.
 */
export function isWebp(buf: Buffer): boolean {
    return sniffMimeType(buf) === 'image/webp';
}

/**
 * Persist the caller's own processed avatar and point `User.image` at
 * the serve route. `userId` is always the authenticated session user
 * — the route layer never lets one user write another's avatar.
 */
export async function uploadOwnAvatar(
    userId: string,
    buf: Buffer,
): Promise<{ imageUrl: string }> {
    if (buf.length === 0) {
        throw badRequest('Avatar upload was empty.');
    }
    if (buf.length > AVATAR_MAX_BYTES) {
        throw badRequest(
            'Processed avatar is too large — re-select a smaller image.',
        );
    }
    if (!isWebp(buf)) {
        // The client canvas emits webp; anything else means the
        // canvas step was bypassed. Reject rather than store
        // unprocessed (possibly EXIF-bearing) bytes.
        throw badRequest('Avatar must be a WebP image.');
    }

    // Every cheap rejection above runs first, so malformed bytes never
    // occupy the scanner — and the scan runs before the write, so refused
    // bytes never reach the key the serve route reads.
    const scanStatus = await scanOrRefuse(buf, {
        component: 'account-avatar',
        subjectId: userId,
    });

    await getStorageProvider().write(avatarStorageKey(userId), buf, {
        mimeType: 'image/webp',
        maxSizeBytes: AVATAR_MAX_BYTES,
    });

    logger.info('account-avatar.stored', {
        component: 'account-avatar',
        userId,
        bytes: buf.length,
        scanStatus,
    });

    const imageUrl = avatarServeUrl(userId);
    await prisma.user.update({
        where: { id: userId },
        data: { image: imageUrl },
    });
    return { imageUrl };
}

/**
 * Remove the caller's uploaded avatar. `User.image` is cleared to
 * null — the surfaces fall back to initials, and a later OAuth
 * sign-in will re-populate the provider image if there is one.
 */
export async function removeOwnAvatar(userId: string): Promise<void> {
    // The storage delete is best-effort: the object may already be
    // gone. Clearing `User.image` is the operation that matters.
    await getStorageProvider()
        .delete(avatarStorageKey(userId))
        .catch(() => undefined);
    await prisma.user.update({
        where: { id: userId },
        data: { image: null },
    });
}

/**
 * Resolve a stored avatar to a readable stream for the serve route,
 * or `null` when the user has no uploaded avatar. The `head` probe
 * turns a missing object into a clean `null` (→ 404) instead of an
 * async stream error.
 */
export async function getAvatarStream(
    userId: string,
): Promise<Readable | null> {
    const provider = getStorageProvider();
    const key = avatarStorageKey(userId);
    try {
        await provider.head(key);
    } catch {
        return null;
    }
    return provider.readStream(key);
}
