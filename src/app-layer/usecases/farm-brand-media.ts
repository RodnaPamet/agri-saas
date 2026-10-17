/**
 * Images a farm may publish on its profile — P6.3 (#1812).
 *
 * Two things live here: the upload, and the check that decides which hashes
 * `updateFarmBrand` is allowed to put on `FarmBrand`.
 *
 * ## The check is what makes the public route safe
 *
 * `/api/public/media/{hash}` serves any hash a published `PublicFarmProfile`
 * references, and its safety argument is that the file belongs to whichever
 * tenant published it. The read path cannot establish that — by the time a
 * hash is in a projection, who owned the bytes has been decided. So it is
 * established HERE, and `public-farm-media.ts` records the dependency in
 * terms.
 *
 * Two conditions, and the second is the one that is easy to miss.
 *
 * **The tenant must own the file.** Enforced by RLS rather than by comparing
 * ids: the lookup runs inside `runInTenantContext`, so a `FileRecord` from
 * another tenant is not visible and the hash comes back unmatched. That is
 * the stronger form — an explicit `tenantId === ctx.tenantId` could be
 * removed by someone refactoring, where removing the tenant context breaks
 * every query in the function.
 *
 * **The file must be in the `farm-media` domain.** Ownership alone is not
 * enough, and this is the part worth stating: every `FileRecord` a tenant owns
 * has a hash. Without the domain condition a farm could publish the hash of an
 * evidence photo of something private, or of a supplier invoice PDF, and the
 * public route would serve it on an indexable page with that file's own
 * `Content-Type`. The domain makes "uploaded in order to be published" a
 * property of the row instead of a promise about which screen was used.
 *
 * ## The cap is here, not in the schema
 *
 * A `max()` on the array would reject the request with a validation error
 * naming an index, which tells an owner nothing they can act on. A coded
 * refusal naming the limit does.
 */
import type { RequestContext } from '../types';
import { FileRepository } from '../repositories/FileRepository';
import { ingestUploadedFile } from '@/lib/upload/ingest';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { codedBadRequest } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { assertCanAdmin } from '../policies/common';
import { logger } from '@/lib/observability/logger';

/** The domain that marks a file as uploaded FOR publication. */
export const FARM_MEDIA_DOMAIN = 'farm-media' as const;

/**
 * How many gallery photographs a farm may publish.
 *
 * The owner's scope is "logo plus a few photos" (2026-10-16). Six is a few —
 * enough for a field, a barn, a crop and a machine, and few enough that the
 * public page stays a page rather than an album. The logo is separate and
 * does not count against it.
 */
export const FARM_BRAND_MAX_PHOTOS = 6;

/**
 * Longest edge of a stored profile image, in pixels.
 *
 * Derived from the page rather than chosen round: `/f/{handle}` renders inside
 * `max-w-2xl`, which is 672 CSS pixels, so 1600 covers that at better than 2x
 * device pixel ratio with room for a wider layout later.
 *
 * It matters more here than it looks. `lighthouserc.json` carries an LCP gate
 * for `/f/.*`, and that entry's own measurement notes the current LCP element
 * is the ABOUT PARAGRAPH — text. Put a photograph on the page and the image
 * becomes the LCP element; at 4000px off a phone camera it would be the worst
 * possible one. The pipeline strips metadata but does not resize on its own
 * (deliberately — an evidence photo is a record), so this surface asks.
 */
export const FARM_MEDIA_MAX_DIMENSION = 1600;

/** Upload one image for later publication, and return its content hash. */
export async function uploadFarmBrandMedia(
    ctx: RequestContext,
    file: File,
): Promise<{ hash: string; mimeType: string; sizeBytes: number; fileRecordId: string }> {
    assertCanAdmin(ctx);

    // Validate → key → buffer → sniff → SCAN → STRIP → write, once, in
    // `@/lib/upload/ingest`. The strip is why this goes through the shared
    // pipeline rather than writing bytes here: EXIF/GPS removal (#1812) is
    // wired into that choke point, and a second upload path would be a second
    // place to forget it.
    const ingested = await ingestUploadedFile(ctx.tenantId, file, {
        domain: FARM_MEDIA_DOMAIN,
        fallbackName: 'photo',
        component: 'farm-brand-media',
        // Fitted inside 1600px on the longest edge, aspect ratio preserved and
        // nothing cropped. See FARM_MEDIA_MAX_DIMENSION for why this surface
        // opts in where the record-keeping surfaces do not.
        maxImageDimension: FARM_MEDIA_MAX_DIMENSION,
        // Narrowing the shared allowlist, which `IngestOptions` permits; it
        // may not be widened. Only the formats the strip pipeline re-encodes
        // can be published, so a PDF cannot enter this domain at all — the
        // domain check downstream then has nothing to let through by mistake.
        extraCheck: ({ mimeType }) =>
            ['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)
                ? null
                : 'A profile image must be a JPEG, PNG or WebP photograph.',
    });

    return runInTenantContext(ctx, async (db) => {
        const fileRecord = await FileRepository.createPending(db, ctx, {
            pathKey: ingested.pathKey,
            originalName: ingested.originalName,
            mimeType: ingested.mimeType,
            sizeBytes: ingested.sizeBytes,
            sha256: ingested.sha256,
            storageProvider: ingested.storageProvider,
            bucket: ingested.bucket,
            domain: ingested.domain,
        });
        await FileRepository.markStored(db, ctx, fileRecord.id, ingested.scanStatus);

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'FileRecord',
            entityId: fileRecord.id,
            details: 'Uploaded a profile image',
            detailsJson: { category: 'content', entityName: 'FarmBrandMedia' },
        });

        logger.info('farm-brand-media.stored', {
            component: 'farm-brand-media',
            tenantId: ctx.tenantId,
            // BOTH sizes: the strip re-encodes, so a stored size alone cannot
            // answer "was this a 3 MB phone photo or an already-small image".
            uploadedBytes: file.size,
            bytes: ingested.sizeBytes,
            scanStatus: ingested.scanStatus,
        });

        return {
            hash: ingested.sha256,
            mimeType: ingested.mimeType,
            sizeBytes: ingested.sizeBytes,
            fileRecordId: fileRecord.id,
        };
    });
}

/**
 * Refuse any hash this tenant may not publish. Call INSIDE the tenant context.
 *
 * `db` is passed rather than taken from `ctx` so this runs in the caller's
 * transaction: the check and the write that depends on it must not be two
 * separate reads with a gap between them.
 */
export async function assertPublishableMediaHashes(
    db: PrismaTx,
    hashes: readonly string[],
): Promise<void> {
    if (hashes.length === 0) return;

    // De-duplicated for the query, but the caller's array keeps its order and
    // its duplicates — the cap and the ordering are its business, not this
    // function's.
    const unique = [...new Set(hashes)];

    const found = await db.fileRecord.findMany({
        where: {
            sha256: { in: unique },
            // RLS scopes this to the caller's tenant. There is deliberately no
            // `tenantId` term: see the docblock.
            domain: FARM_MEDIA_DOMAIN,
            deletedAt: null,
            status: 'STORED',
        },
        select: { sha256: true },
    });

    const publishable = new Set(found.map((f) => f.sha256));
    const refused = unique.filter((h) => !publishable.has(h));

    if (refused.length > 0) {
        // ONE code for every reason a hash is refused — not this tenant's, not
        // in the media domain, soft-deleted, never finished storing. The owner
        // can act on all of them the same way (re-upload the image), and
        // distinguishing them would tell a caller whether a hash exists
        // somewhere else in the system.
        throw codedBadRequest(
            'FARM_MEDIA_NOT_PUBLISHABLE',
            'One of those images is no longer available. Upload it again.',
        );
    }
}
