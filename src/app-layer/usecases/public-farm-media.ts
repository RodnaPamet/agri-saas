/**
 * Resolve a content hash to the bytes a public farm profile publishes.
 * P6.3 (#1812).
 *
 * ## The authorisation question is NOT "does this file exist"
 *
 * A sha256 is unguessable but PERMANENT. So a route that served "any
 * `FileRecord` whose hash matches" would hand out a capability nothing could
 * ever revoke: a farm unpublishes its profile, and every image stays reachable
 * to anyone who ever saw a URL — including a search engine that cached one.
 *
 * The question asked here is instead *"does a PUBLISHED PROJECTION reference
 * this hash?"*. `PublicFarmProfile` rows exist only while a farm is published
 * (`projectFarmBrand` deletes the row on unpublish), so reachability is tied
 * to the same row that publishes everything else. Withdrawing a profile stops
 * its images resolving in the same step, with no separate revocation path to
 * forget.
 *
 * That is also why the projection carries its own `logoMediaHash` /
 * `photoMediaHashes` columns rather than this joining back to `FarmBrand`:
 * the authority has to be the thing whose presence means "published".
 *
 * There is no principal: an anonymous visitor has no tenant. The projection is
 * tenantless by design, so `runWithoutRls({ reason: 'public-projection-read' })`
 * is the established reason for reading it (P6.5).
 *
 * ## THE PRECONDITION THIS DEPENDS ON, stated because it is not enforced here
 *
 * "The row belongs to whichever tenant published that image" is true only if
 * the WRITE path refuses to publish a hash the tenant does not own. Nothing
 * below checks that, and nothing can: by the time a hash is in a projection,
 * the question of who owned the bytes has already been decided.
 *
 * So a writer that let a farm set `photoMediaHashes` to another tenant's hash
 * would make this route serve that tenant's file — the projection would
 * reference it, and the read below would dutifully fetch it. The capability
 * would be cross-tenant, and the fault would be invisible from here.
 *
 * At the time of writing nothing populates these columns at all
 * (`BRAND_FIELD_DECISIONS` marks both brand fields `private`), so there is no
 * live exposure. The surface that populates them MUST verify that each hash
 * resolves to a `FileRecord` in the writing tenant, and must do it under the
 * tenant's own RLS context rather than a bypass.
 *
 * ## Both reads bypass RLS, and must
 *
 * The `FileRecord` read carries its own reason, `public-media-read`: that
 * table IS tenant-scoped, and this reads it with no tenant. The bypass is sound only
 * because the projection lookup has already answered the authorisation
 * question — the hash is one a published farm chose to publish. Reversing the
 * two reads would turn this into a cross-tenant file lookup by hash, which is
 * precisely what it must not be. The order is the safety property, which is
 * why it has its own test.
 */
import { Readable } from 'node:stream';

import { runWithoutRls } from '@/lib/db/rls-middleware';
import { getStorageProvider } from '@/lib/storage';
import { isDownloadAllowed } from '@/lib/storage/av-scan';
import { logger } from '@/lib/observability/logger';

/**
 * A hex sha256 and nothing else.
 *
 * Checked before any database read, so a flood of malformed hashes costs a
 * regex rather than a query. 64 lower-case hex characters is what
 * `StorageProvider.write` returns, and anchoring both ends is what stops a
 * path-ish value reaching the lookup.
 */
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isWellFormedMediaHash(hash: string): boolean {
    return SHA256_HEX.test(hash);
}

export interface PublicMediaObject {
    stream: Readable;
    mimeType: string;
    sizeBytes: number;
    /** The hash itself — see the route for why it is the ETag. */
    hash: string;
}

/**
 * The bytes for a published hash, or `null` when it is not published.
 *
 * `null` for every negative case rather than distinct errors, and that is
 * deliberate: a malformed hash, an unpublished one, an unreferenced one and a
 * quarantined one are indistinguishable to the caller, so the route answers
 * 404 for all of them. Telling them apart would let an anonymous caller use
 * the response to learn which hashes exist.
 */
export async function resolvePublicMedia(hash: string): Promise<PublicMediaObject | null> {
    if (!isWellFormedMediaHash(hash)) return null;

    // 1 — AUTHORISATION. Is this hash published by somebody?
    //
    // `some` over both columns in one query. `logoMediaHash` is scalar and
    // `photoMediaHashes` is a list, so the list arm uses `has`.
    const published = await runWithoutRls({ reason: 'public-projection-read' }, (db) =>
        db.publicFarmProfile.findFirst({
            where: {
                OR: [{ logoMediaHash: hash }, { photoMediaHashes: { has: hash } }],
            },
            select: { handle: true },
        }),
    );
    if (!published) return null;

    // 2 — the bytes. Reached ONLY because step 1 said this hash is published.
    const file = await runWithoutRls({ reason: 'public-media-read' }, (db) =>
        db.fileRecord.findFirst({
            where: { sha256: hash, deletedAt: null, status: 'STORED' },
            select: { pathKey: true, mimeType: true, sizeBytes: true, scanStatus: true },
        }),
    );
    if (!file) {
        // A projection naming a hash with no stored file. Not a 500: the
        // honest answer to the visitor is still "no such image". Logged at
        // WARN because it means a projection outlived its bytes, which no
        // ordinary flow produces.
        logger.warn('public-media.referenced_hash_has_no_file', {
            component: 'public-farm-media',
            handle: published.handle,
        });
        return null;
    }

    // The SAME gate every other download goes through. Not a second opinion:
    // `isDownloadAllowed` is the one place that decides what a scan verdict
    // permits, and an image on an indexable page is the last thing that should
    // get a looser rule than an authenticated download.
    if (!isDownloadAllowed(file.scanStatus)) {
        logger.warn('public-media.refused_by_scan_gate', {
            component: 'public-farm-media',
            scanStatus: file.scanStatus,
        });
        return null;
    }

    return {
        stream: getStorageProvider().readStream(file.pathKey),
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        hash,
    };
}
