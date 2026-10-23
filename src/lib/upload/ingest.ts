/**
 * The one upload ingest pipeline.
 *
 * ── What this is, and what it deliberately is not ────────────────────
 *
 * It is NOT a generic upload ENDPOINT. A single route that any entity
 * posts to would mint a `FileRecord` with nothing attached to it, and the
 * attach would be a second request — so a dropped connection between the
 * two leaves an orphan file that is stored, scanned, billed and referenced
 * by nothing. Every multipart route in this repo mints its `FileRecord`
 * inside the same transaction as the entity write for that reason, and
 * that part is genuinely per-entity.
 *
 * What was NOT per-entity is everything BEFORE the transaction. This block
 * existed near-verbatim in three usecases and in degraded form in two more:
 *
 *     declared-MIME allowlist  →  size check  →  object key  →  buffer
 *       →  byte sniff + re-check  →  storage write  →  AV scan
 *
 * Five copies means five places to forget a step, and two of them had:
 * the staged-import routes skipped the sniff and the scan entirely. This
 * module is that block, once.
 *
 * ── The order is load-bearing ────────────────────────────────────────
 *
 * The declared MIME check runs FIRST because it is free and rejects the
 * obvious case before any bytes are read. It is not trusted: `file.type`
 * is the client's claim, so after buffering, `reconcileMimeType` reads the
 * signature and the allowlist is applied AGAIN to what the bytes actually
 * are. A `.pdf` full of HTML fails the second check even though it passed
 * the first.
 *
 * The scan runs on the buffer AFTER the write, not before. Writing an
 * infected file and recording it as INFECTED is recoverable — the download
 * gate refuses it and an operator can purge the key. Scanning first and
 * writing second means a crash between the two produces a stored object
 * with no record at all, which nothing will ever look at again.
 *
 * ── The status is returned, never defaulted ──────────────────────────
 *
 * `ingestUploadedFile` returns `scanStatus` and the caller passes it to
 * `FileRepository.markStored`. That argument used to carry a
 * `= 'SKIPPED'` default, and a default meaning "unscanned" is how two
 * upload paths came to skip the scanner without anyone deciding to. The
 * default is gone; a caller that wants to skip has to say so.
 *
 * ── Two shapes, and the second one is why `scanOrRefuse` exists ──────
 *
 * `ingestUploadedFile` above is the RECORD-BACKED shape: the bytes get a
 * `FileRecord`, the record carries a `scanStatus`, and every read of those
 * bytes goes through a download route that asks `isDownloadAllowed` first.
 * That is what makes "write, then scan, then record the verdict" safe —
 * the verdict is consulted on the way back out.
 *
 * That sentence is the soundness argument for this entire design, and it
 * was FALSE for four of the five byte-serving routes until the download
 * gate was closed. Three of them (`/api/t/:slug/files/:name/download`,
 * `/api/t/:slug/files/:name`, `/api/files/:name`) gated on `assertCanRead`
 * alone and were deleted — they had no callers. The fourth
 * (`access-reviews/:id/evidence`) selected neither `status` nor
 * `scanStatus`, so it could not have consulted a verdict it never fetched;
 * it now does. An ungated download route does not merely leak one file: it
 * retroactively removes the reason uploads are allowed to reach disk
 * unscanned. `tests/guards/download-route-gate-reachability.test.ts` is the
 * egress half of this convention and exists so the claim above stays true.
 *
 * Some surfaces store bytes with **no `FileRecord` at all**: a fixed key,
 * one object per subject, streamed straight back by an `<img>` route that
 * has no status to consult (`avatars/<userId>.webp`,
 * `promotions/<id>.webp`). For those, deferring to a download gate is not
 * an option, because there is no download gate — so the gate has to run at
 * INGEST, and the write must not happen until it passes. That is
 * `scanOrRefuse`, and the ordering is the mirror image of the one above
 * for exactly that reason.
 */

import { Readable } from 'node:stream';

import { env } from '@/env';
import { codedBadRequest } from '@/lib/errors/types';
import { assertTenantNotPastDueRestricted } from '@/lib/billing/entitlements';
import { logger } from '@/lib/observability';

import {
    isDownloadAllowed,
    scanUploadedBuffer,
    scanUploadedBufferDetailed,
} from '@/lib/storage/av-scan';
import { reconcileMimeType } from '@/lib/storage/mime-sniff';
import { stripImageMetadata } from '@/lib/images/strip-metadata';
import { stripPdfMetadata } from '@/lib/files/strip-pdf-metadata';
// `@/lib/storage` — the same specifier every other consumer uses. This
// module deliberately does NOT live under `src/lib/storage/`: from inside
// that directory the natural import is `./index`, which resolves to a
// DIFFERENT module than `@/lib/storage` (that specifier hits the
// back-compat shim `src/lib/storage.ts`). Every existing test mocks the
// shim, so an ingest pipeline importing `./index` would quietly bypass all
// of them — which is exactly what happened on the first attempt.
import {
    buildTenantObjectKey,
    FILE_MAX_SIZE_BYTES,
    getStorageProvider,
    isAllowedMime,
    isAllowedSize,
} from '@/lib/storage';
import type { StorageDomain } from '@/lib/storage';

/** Everything the caller needs to mint its own `FileRecord`. */
export interface IngestedUpload {
    /** Storage key the bytes were written to. */
    pathKey: string;
    /** The name to display. Never trusted as a path — the key is built. */
    originalName: string;
    /** The RESOLVED type: what the bytes are, not what the client claimed. */
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    /** `'local' | 's3'` — recorded so a later read knows where to look. */
    storageProvider: string;
    bucket: string | null;
    domain: StorageDomain;
    /**
     * A TERMINAL scan outcome. Pass it to `FileRepository.markStored`; do
     * not substitute a guess.
     */
    scanStatus: 'CLEAN' | 'INFECTED' | 'SKIPPED' | 'PENDING';
    /** The buffered bytes, for a caller that needs to parse them (imports). */
    buffer: Buffer;
}

export interface IngestOptions {
    /** Storage domain — decides the key prefix. */
    domain: StorageDomain;
    /** Fallback when the upload carries no filename. */
    fallbackName: string;
    /**
     * Override the shared allowlist for a surface with its own, narrower
     * rule (an importer that takes only `.zip`, say). Returning a message
     * rejects with it; returning `null` accepts.
     *
     * A surface may narrow the shared allowlist. It may NOT widen it —
     * `isAllowedMime` still runs, and this is applied on top.
     */
    /**
     * A domain's extra narrowing of the shared allowlist.
     *
     * Returns a `{ reason, message }` rather than prose (#2059). The prose
     * version was the last thing keeping `FILE_TYPE_NOT_ALLOWED` unentriable:
     * a caller-supplied sentence cannot be translated, so an entry would have
     * replaced "a profile image must be a JPEG, PNG or WebP photograph" with
     * something generic — strictly worse for the one surface that bothered to
     * be specific. A `reason` gets its own line in the variant table instead,
     * and the `message` stays as the English fallback.
     */
    extraCheck?: (args: {
        mimeType: string;
        originalName: string;
    }) => { reason: string; message: string } | null;
    /**
     * Cap smaller than `FILE_MAX_SIZE_BYTES` for this surface, or larger
     * for a staged import that is parsed rather than served.
     */
    maxBytes?: number;
    /** Component name for the mismatch log line. */
    component: string;
    /**
     * Fit an uploaded IMAGE inside this many pixels on its longest edge —
     * P6.3 (#1812). Omit to keep the original dimensions, which is what every
     * record-keeping surface wants.
     *
     * Passed through to `stripImageMetadata`; see its `maxDimension` for why
     * this is opt-in rather than a default.
     */
    maxImageDimension?: number;
}

/**
 * Validate, store and scan one uploaded file.
 *
 * Throws a CODED `badRequest` on any rejection — the caller never has to map
 * error shapes. Returns on success; the caller then writes its own rows.
 */
export async function ingestUploadedFile(
    tenantId: string,
    file: File,
    opts: IngestOptions,
): Promise<IngestedUpload> {
    const declaredMime = file.type || 'application/octet-stream';
    const originalName = file.name || opts.fallbackName;

    // Before any bytes are read or written.
    //
    // This comment used to say one call here "covers evidence, journal
    // attachments, invoices and the importers, because this is the choke point
    // every record-backed upload reaches". It did not. Measured 2026-10-23
    // (#2030): two of six byte-writing paths reached this function, and
    // `assertTenantNotPastDueRestricted` had exactly ONE call site in the
    // repository — this one. Evidence, journal attachments, spatial import and
    // the evidence importer each stored bytes past it.
    //
    // The old comment's own warning was right and arrived too late: "gating the
    // routes instead would be N sites and a new one would escape silently
    // (#1325)". Four had already escaped. The gate now lives at all five
    // sites, and §5 of `past-due-capability-coverage` derives its population
    // from who calls `FileRepository.markStored` — so what stops the next
    // escape is the guard, not this function's position.
    //
    // The MAP is unaffected: the owner's ruling keeps parcels and imagery
    // VISIBLE and stops only new uploads, so nothing here touches reads.
    await assertTenantNotPastDueRestricted(tenantId, 'upload');

    // Cheap rejections first — no bytes read yet.
    if (!isAllowedMime(declaredMime)) {
        throw codedBadRequest('FILE_TYPE_NOT_ALLOWED',
            `MIME type "${declaredMime}" is not allowed`,
            // The client's CLAIM, not the bytes (#2059).
            { reason: 'declared' },
        );
    }
    const cap = opts.maxBytes ?? FILE_MAX_SIZE_BYTES;
    if (opts.maxBytes != null ? file.size > opts.maxBytes : !isAllowedSize(file.size)) {
        // `maxBytes` on the wire, not only inside the sentence (#1918). The
        // catalogue entry names the number — a NUMBER is the one thing
        // `localize.ts`'s rule permits interpolating — and it cannot do that
        // unless the value is a param. Without it the Bulgarian would have to
        // say "too large" and drop the figure an operator needs to act on.
        throw codedBadRequest(
            'FILE_TOO_LARGE',
            `File exceeds the maximum size of ${cap} bytes`,
            { maxBytes: String(cap) },
        );
    }
    if (file.size === 0) {
        throw codedBadRequest('FILE_EMPTY', 'File is empty');
    }

    const storage = getStorageProvider();
    const pathKey = buildTenantObjectKey(tenantId, opts.domain, originalName);
    const buffer = Buffer.from(await file.arrayBuffer());

    // The SIGNATURE beats the claim. A file whose real content is
    // inadmissible is rejected here even though its declared type passed.
    const { resolved: mimeType, detected, corrected } = reconcileMimeType(
        declaredMime,
        buffer,
    );
    if (corrected) {
        if (!isAllowedMime(mimeType)) {
            throw codedBadRequest('FILE_TYPE_NOT_ALLOWED',
                `File content is "${mimeType}", which is not allowed`,
                // The SIGNATURE beat the claim — a different refusal from
                // `declared`, and the one worth telling a user apart (#2059).
                { reason: 'content' },
            );
        }
        logger.warn('upload declared a MIME type its bytes contradict', {
            component: opts.component,
            tenantId,
            declaredMime,
            detected,
        });
    }

    const extraRejection = opts.extraCheck?.({ mimeType, originalName });
    if (extraRejection) {
        throw codedBadRequest('FILE_TYPE_NOT_ALLOWED', extraRejection.message, {
            reason: extraRejection.reason,
        });
    }

    // A TERMINAL scan status before the record is treated as usable.
    //
    // MOVED ahead of the write by #1812, and the reason is the strip below
    // rather than the write. Stripping EXIF means DECODING the caller's bytes
    // with libvips, and a decoder fed attacker-controlled input is the step
    // most worth having a scan in front of — `account/avatar.ts` records the
    // same ordering for the same reason. The verdict returned to the caller is
    // unchanged, so this reorders work without changing what anything decides.
    const scanStatus = await scanUploadedBuffer(buffer);

    // EXIF/GPS stripped before the bytes land anywhere — #1812.
    //
    // The RESOLVED `mimeType` is passed, never `declaredMime`: a caller who
    // could opt out of stripping by lying about the content type would defeat
    // the whole measure, which is why every upload path here sniffs.
    //
    // A non-image passes through untouched and undecoded, so a PDF, a zip or
    // a shapefile reaching this choke point is unaffected.
    const { bytes: imageStripped } = await stripImageMetadata(buffer, mimeType, {
        component: opts.component,
        maxDimension: opts.maxImageDimension,
    });

    // …and document metadata stripped from a PDF — #2035.
    //
    // CHAINED rather than branched, and the two are mutually exclusive by
    // resolved MIME: `stripImageMetadata` returns a PDF untouched and
    // undecoded (it must never reach libvips, which would rasterise away the
    // text layer that for an invoice or a БАБХ form IS the content), and
    // `stripPdfMetadata` returns an image untouched. So each file is rewritten
    // by exactly one of them, and a type neither handles — a zip, a shapefile
    // — passes through both.
    //
    // Unlike the image strip this one can REFUSE: a PDF whose bytes cannot be
    // parsed throws a coded 400 rather than being stored unstripped, because a
    // privacy property that degrades silently to no privacy is not one.
    const { bytes: toStore } = await stripPdfMetadata(imageStripped, mimeType, {
        component: opts.component,
    });

    // `toStore`, not `buffer` — so `writeResult.sha256` is the digest of the
    // STRIPPED bytes. That matters beyond tidiness: `FileRecord.sha256` is
    // what `/api/public/media/[hash]` will resolve, and it has to name the
    // bytes the route actually serves.
    const writeResult = await storage.write(pathKey, Readable.from(toStore), { mimeType });

    return {
        pathKey,
        originalName,
        mimeType,
        sizeBytes: writeResult.sizeBytes,
        sha256: writeResult.sha256,
        storageProvider: storage.name,
        bucket: env.S3_BUCKET || null,
        domain: opts.domain,
        scanStatus,
        buffer,
    };
}

/**
 * The scan gate for bytes that will be stored WITHOUT a `FileRecord`.
 *
 * Returns the verdict when the bytes may be stored, and throws a coded
 * `badRequest` when they may not — `UPLOAD_INFECTED`,
 * `UPLOAD_SCANNER_UNAVAILABLE` or `UPLOAD_UNSCANNED_ON_PUBLIC_SURFACE`.
 * Coded rather than bare because `no-server-authored-user-copy` exempts a
 * coded throw from its ratchet, so these three lower the count instead of
 * raising it — and a client can tell "we refused your file" from "we could
 * not check it" without parsing a sentence.
 *
 * Call it BEFORE the write: a record-less object is served by key, so once
 * the bytes are at that key nothing later in the request can stop them being
 * handed out.
 *
 * ── The policy is the download gate, not a second opinion ────────────
 *
 * Which verdicts are storable here is not a judgement call this module
 * gets to make separately. A record-backed file with verdict V is readable
 * exactly when `isDownloadAllowed(V)`; a record-less file is readable
 * unconditionally. So the honest translation is to run the SAME gate one
 * step earlier and refuse the write when it says no — which lands, for
 * free, on the distinction that matters:
 *
 *   CLEAN     → store. Scanned, nothing found.
 *   SKIPPED   → store. No scanner is deployed (`AV_SCAN_MODE=disabled`, or
 *               no `CLAMAV_HOST`), or one errored under a mode that asked
 *               to fail open. Identical to what every `FileRecord` path in
 *               this repo does today; refusing here would mean an operator
 *               who never deployed ClamAV cannot set a profile photo.
 *   PENDING   → refuse. Only reachable when a scanner IS configured, DID
 *               error, and the mode is `strict` — an operator who asked to
 *               fail closed, with a scanner that broke.
 *   INFECTED  → refuse, always.
 *
 * A second hand-written table of "which statuses are OK" is how the two
 * ideas drift apart; deriving from `isDownloadAllowed` means a future
 * change to the gate reaches this path too.
 */
export async function scanOrRefuse(
    buffer: Buffer,
    opts: {
        /** Component name for the refusal log line. */
        component: string;
        /** Subject the bytes belong to (userId, promotionId) — logged. */
        subjectId?: string;
        /**
         * Who will be able to read these bytes. REQUIRED, and deliberately
         * without a default — #1811.
         *
         * `public` means an unauthenticated reader can fetch them. Storing
         * unscanned bytes there is a different proposition from storing them
         * behind a session: the audience is everyone, and the operator who
         * never deployed a scanner is not the one who bears it.
         *
         * No default, because the forcing function IS the absence of one. The
         * first public upload surface someone adds will not compile until it
         * says which it is, and the default that looks harmless (`private`)
         * is exactly the one that would let unscanned bytes onto a public
         * surface silently. Same shape as `BRAND_FIELD_DECISIONS` being
         * `Record<keyof FarmBrand, …>`, which caught `FarmBrand.indexable`
         * within minutes of the column existing.
         *
         * Note what this is NOT, today: there is no public upload surface in
         * the product. `/f/[handle]` serves text only — neither `FarmBrand`
         * nor `PublicFarmProfile` has an image column, and P6.5's OG image is
         * RENDERED from those fields rather than uploaded. Both current
         * callers are private. So the `public` branch has no caller and this
         * is a gate waiting for one, which is the honest description.
         */
        exposure: 'public' | 'private';
    },
): Promise<'CLEAN' | 'SKIPPED' | 'PENDING'> {
    const outcome = await scanUploadedBufferDetailed(buffer);
    const verdict = outcome.status;

    // INFECTED is checked ahead of the gate deliberately. `isDownloadAllowed`
    // short-circuits on `AV_SCAN_MODE=disabled` BEFORE reaching its own
    // infected rule, and a scanner that positively identified malware must
    // not have that finding discarded by a mode flag. (In practice a
    // disabled mode never runs a scanner, so this is belt to the gate's
    // braces — but the belt is one line.)
    if (verdict === 'INFECTED') {
        logger.warn('upload refused: scanner reported an infection', {
            component: opts.component,
            subjectId: opts.subjectId,
            verdict,
        });
        throw codedBadRequest(
            'UPLOAD_INFECTED',
            'This image was rejected by the malware scanner.',
        );
    }

    if (!isDownloadAllowed(verdict)) {
        logger.warn('upload refused: no usable scan verdict', {
            component: opts.component,
            subjectId: opts.subjectId,
            verdict,
            reason: 'reason' in outcome ? outcome.reason : undefined,
        });
        throw codedBadRequest(
            'UPLOAD_SCANNER_UNAVAILABLE',
            'The malware scanner is unavailable, so the image was not stored. Try again shortly.',
        );
    }

    // Unscanned bytes do not go on a public surface. `isDownloadAllowed`
    // permits SKIPPED in every mode — correctly, for a private file behind a
    // session — and this is the one place that is not good enough.
    //
    // The reason is logged rather than folded into the message, because the
    // three are different operator problems and only one of them is a fault:
    // `scanning-disabled` and `no-scanner-configured` mean nobody deployed a
    // scanner, `scanner-error-failed-open` means one broke. The uploader sees
    // the same sentence either way, since none of it is their doing.
    if (verdict === 'SKIPPED' && opts.exposure === 'public') {
        logger.warn('upload refused: unscanned bytes on a public surface', {
            component: opts.component,
            subjectId: opts.subjectId,
            verdict,
            reason: outcome.status === 'SKIPPED' ? outcome.reason : undefined,
            exposure: opts.exposure,
        });
        throw codedBadRequest(
            'UPLOAD_UNSCANNED_ON_PUBLIC_SURFACE',
            'This image cannot be published because the malware scanner is unavailable.',
        );
    }

    return verdict;
}
