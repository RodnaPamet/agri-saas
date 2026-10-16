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
import sharp from 'sharp';

import { codedBadRequest } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';

/**
 * Cap on the STORED result. A 256×256 webp is ~5–25KB, so 512KB is a
 * generous safety net that still bounds what lands in storage.
 *
 * Since #1903 this is no longer the upload cap: the server re-encodes, so
 * what arrives and what is stored are different sizes. See
 * `AVATAR_UPLOAD_MAX_BYTES`.
 */
export const AVATAR_MAX_BYTES = 512 * 1024;

/**
 * Cap on what a caller may UPLOAD, before re-encoding. Owner ruling
 * 2026-10-16: 4 MB.
 *
 * A photo straight off an iPhone is 1–3 MB, so this clears the honest path
 * with headroom and refuses obvious abuse before any of it reaches a
 * decoder. The phone resizes to `AVATAR_PX` before sending to save the
 * farmer's data allowance, so its uploads are well under this; the cap
 * mainly bounds a web caller picking a full-size camera JPEG.
 */
export const AVATAR_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The stored square. Matches `AVATAR_PX` in
 * `src/app/account/profile/AvatarUploadField.tsx`, so the web canvas and the
 * server produce the same image rather than two conventions.
 */
export const AVATAR_PX = 256;

/**
 * WebP quality for the re-encode, matching the client canvas's 0.85.
 */
const AVATAR_WEBP_QUALITY = 85;

/**
 * Formats a caller may send. Owner ruling 2026-10-16: JPEG and WebP, NOT
 * HEIC.
 *
 * iOS has no WebP encoder — `CGImageDestinationCopyTypeIdentifiers()` does
 * not list `org.webmproject.webp` — so a WebP-only endpoint refuses every
 * photo an iPhone takes (#1903, from agrent-ios #333). iOS CAN encode JPEG
 * natively, so JPEG alone unblocks the phone.
 *
 * HEIC was considered and declined: accepting it would hand
 * attacker-controlled HEIF containers to libheif, which has a worse CVE
 * history than libjpeg, and the AV scan ahead of the decode catches known
 * malware signatures rather than a malformed-container parser exploit. The
 * phone converts HEIC to JPEG on device, which it can already do.
 *
 * PNG is deliberately absent even though the web file input offers it: the
 * client canvas already converts PNG to WebP before upload, so nothing needs
 * the server to decode one.
 */
const ACCEPTED_UPLOAD_TYPES = new Set(['image/webp', 'image/jpeg']);

/** Pixel ceiling for the decode, independent of the byte cap. */
const AVATAR_MAX_INPUT_PIXELS = 50 * 1000 * 1000;

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
 * The accepted upload type these BYTES are, or null.
 *
 * Separate from `isWebp`, which stays exactly as it is: a guard pins its
 * existence (`avatar-renderer-convergence`) and the promotions surface
 * imports it to stay WebP-only. The owner's 2026-10-16 ruling widened
 * AVATARS, not every image endpoint.
 *
 * Checked on the magic number, never on a declared content type the caller
 * controls — the reason the original check was a privacy refusal rather than
 * a format preference, and that reason survives the widening.
 */
export function acceptedAvatarUpload(buf: Buffer): string | null {
    const sniffed = sniffMimeType(buf);
    return sniffed !== null && ACCEPTED_UPLOAD_TYPES.has(sniffed) ? sniffed : null;
}

/**
 * Decode, strip, square and re-encode to WebP.
 *
 * Run on EVERY upload including one that already is a WebP, which is the
 * point: #1903's reason for moving this server-side is that the privacy
 * guarantee should hold for every client rather than resting on the web
 * canvas being the only path that meets it. A WebP from an unknown client can
 * still carry EXIF; re-encoding it costs milliseconds and removes the
 * question.
 *
 * `.rotate()` with no argument applies the EXIF orientation and then drops
 * it. Without it a portrait phone photo stores sideways — and it has to come
 * BEFORE `.resize`, or the square is cropped from the unrotated frame.
 *
 * sharp writes no metadata unless asked (`withMetadata()`), so EXIF, XMP and
 * GPS are gone by construction rather than by a strip step that could be
 * forgotten. `toColourspace('srgb')` makes the ICC answer explicit instead of
 * relying on that default.
 *
 * `limitInputPixels` is a cap the BYTE cap cannot give: 4 MB of JPEG can
 * decode to a far larger bitmap, and the pixel count is what the decoder
 * allocates. 50 Mpx clears any real camera.
 */
async function reencodeToWebp(buf: Buffer): Promise<Buffer> {
    try {
        return await sharp(buf, { limitInputPixels: AVATAR_MAX_INPUT_PIXELS })
            .rotate()
            .resize(AVATAR_PX, AVATAR_PX, { fit: 'cover', position: 'centre' })
            .toColourspace('srgb')
            .webp({ quality: AVATAR_WEBP_QUALITY })
            .toBuffer();
    } catch (err) {
        // The magic number said JPEG or WebP and the decoder disagreed, so
        // the container is truncated or malformed. A coded refusal, because
        // "we could not read your photo" is a different remedy from "wrong
        // format" — retry with a different file, not with the same one
        // re-exported.
        logger.warn('account-avatar.decode_failed', {
            component: 'account-avatar',
            bytes: buf.length,
            error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
        });
        throw codedBadRequest(
            'AVATAR_UNREADABLE',
            'That image could not be read. Try a different photo.',
        );
    }
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
    // Coded, not bare (#1861). `no-server-authored-user-copy` exempts a
    // coded throw, so these lower that ratchet rather than adding to it —
    // and a client can tell "you sent nothing" from "you sent the wrong
    // format" without parsing English, which matters for the one of these
    // that means the canvas step was skipped.
    if (buf.length === 0) {
        throw codedBadRequest('AVATAR_EMPTY', 'Avatar upload was empty.');
    }
    if (buf.length > AVATAR_UPLOAD_MAX_BYTES) {
        throw codedBadRequest(
            'AVATAR_TOO_LARGE',
            'That image is too large — pick a smaller photo.',
        );
    }
    if (acceptedAvatarUpload(buf) === null) {
        // Checked on the magic number. Unprocessed bytes may still carry
        // EXIF including GPS, and the re-encode below is what removes it —
        // so a format this server cannot decode is refused rather than
        // stored as-is.
        throw codedBadRequest(
            'AVATAR_FORMAT_NOT_ALLOWED',
            'Avatar must be a JPEG or WebP image.',
        );
    }

    // Every cheap rejection above runs first, so malformed bytes never
    // occupy the scanner — and the scan runs before the write, so refused
    // bytes never reach the key the serve route reads.
    const scanStatus = await scanOrRefuse(buf, {
        component: 'account-avatar',
        subjectId: userId,
        // Private: the serve route requires a session. An avatar is visible to
        // other members of the tenants a user shares, never to the internet.
        exposure: 'private',
    });

    // AFTER the scan, deliberately. The scanner reads the bytes the caller
    // sent, which is the artefact a signature describes; handing it a
    // re-encoded image would scan something nobody uploaded, and the decode
    // itself is the step most worth having scanned input for.
    const stored = await reencodeToWebp(buf);

    // Belt to the braces: a 256×256 webp is ~5–25KB, so this cannot fire
    // from an honest path. It is here because the STORED cap is now a
    // different number from the upload cap, and a re-encode that somehow
    // produced something enormous should not reach storage unremarked.
    if (stored.length > AVATAR_MAX_BYTES) {
        logger.warn('account-avatar.reencode_too_large', {
            component: 'account-avatar',
            userId,
            bytes: stored.length,
        });
        throw codedBadRequest(
            'AVATAR_TOO_LARGE',
            'That image is too large — pick a smaller photo.',
        );
    }

    await getStorageProvider().write(avatarStorageKey(userId), stored, {
        mimeType: 'image/webp',
        maxSizeBytes: AVATAR_MAX_BYTES,
    });

    logger.info('account-avatar.stored', {
        component: 'account-avatar',
        userId,
        // BOTH numbers: the re-encode makes them different, and a stored size
        // alone cannot answer "was this a 3 MB phone photo or a 20KB canvas
        // round-trip" — which is the question when someone asks whether the
        // native path is being used.
        uploadedBytes: buf.length,
        bytes: stored.length,
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
/**
 * The stored avatar plus a validator for it (#1953).
 *
 * The validator is `size-mtime`, which is what nginx and Apache derive their
 * ETags from, and it costs NOTHING here: `head()` was already being called to
 * decide whether the object exists, and its result was being thrown away.
 *
 * A content hash would be stronger. The upload path knows one —
 * `provider.write()` returns a sha256 — but nothing persists it, and reading
 * the whole object per request to recompute it would defeat the purpose. So
 * the weakness is stated rather than hidden: two DIFFERENT avatars of
 * identical byte length written in the same millisecond would share a
 * validator. Uploads are seconds apart and sizes vary, and the consequence
 * of a collision is a stale picture rather than a wrong one.
 */
export async function getAvatarObject(
    userId: string,
): Promise<{ stream: Readable; etag: string } | null> {
    const provider = getStorageProvider();
    const key = avatarStorageKey(userId);
    let head;
    try {
        head = await provider.head(key);
    } catch {
        return null;
    }
    const etag = `"${head.sizeBytes.toString(16)}-${(head.lastModified?.getTime() ?? 0).toString(16)}"`;
    return { stream: provider.readStream(key), etag };
}

/**
 * The stored avatar's bytes alone.
 *
 * Kept as the thin wrapper it now is: `avatar-renderer-convergence` pins this
 * name, and callers that do not serve HTTP have no use for a validator.
 */
export async function getAvatarStream(
    userId: string,
): Promise<Readable | null> {
    return (await getAvatarObject(userId))?.stream ?? null;
}
