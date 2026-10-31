/**
 * «Документи» — the farm document library (#2495, delivery step 2).
 *
 * One library per farm. Everyone in the farm sees and previews it; writers
 * and above upload; the uploader or an admin deletes. MECHANISATOR has no
 * access at all, and that confinement is NOT enforced here — it is
 * `isOperatorAllowedPath`, which does not admit a `documents` prefix. See
 * Decision 1 on the issue for why a general document library is not
 * something the sprayer persona gets: this library is designed to hold lease
 * contracts, and `ParcelLease.lessorName` is in `ENCRYPTED_FIELDS` precisely
 * because it is third-party personal data.
 *
 * ## Ingest and `markStored` live in ONE file deliberately
 *
 * `past-due-capability-coverage` §5 derives its population from who calls
 * `FileRepository.markStored`, and accepts a file that either gates directly
 * or calls `ingestUploadedFile` — which gates internally
 * (`ingest.ts`, `assertTenantNotPastDueRestricted(tenantId, 'upload')`).
 * That check runs PER FILE, so splitting the ingest call away from the
 * `markStored` call would leave this module an ungated upload writer. Keep
 * them together.
 *
 * ## The bytes are written before the scan finishes
 *
 * That is `ingestUploadedFile`'s design, and its soundness argument is that
 * every read goes through a route that asks `isDownloadAllowed` first. For
 * this feature that route is `GET /documents/{id}/content`, served by
 * `downloadFarmDocument` below — which is why that function is registered in
 * `USECASE_SEAMS` in `download-route-gate-reachability`. A download path here
 * with no gate would not just leak one file; it would retroactively remove
 * the reason uploads may hit disk unscanned.
 */
import type { DocumentRetention } from '@prisma/client';

import type { RequestContext } from '../types';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { FileRepository } from '../repositories/FileRepository';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { ingestUploadedFile } from '@/lib/upload/ingest';
import { isDownloadAllowed } from '@/lib/storage/av-scan';
import { assertTenantKey, getStorageProvider } from '@/lib/storage';
import { codedForbidden, codedNotFound } from '@/lib/errors/types';
import { farmToday } from '@/lib/calendar-day-key';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { isUniqueViolation } from '@/lib/errors/prisma';

/**
 * One page of the library. The list is newest-first and the phone does not
 * paginate it, so this is a CAP with a `truncated` flag rather than a cursor
 * — the same shape the issue specifies. `take: CAP + 1` is what makes
 * `truncated` honest; counting separately would be a second query that can
 * disagree with the page.
 */
export const DOCUMENT_PAGE_SIZE = 200;

/** Months per retention period. `NONE` is «Без срок» — no expiry at all. */
const RETENTION_MONTHS: Record<DocumentRetention, number | null> = {
    P3M: 3,
    P6M: 6,
    P1Y: 12,
    P2Y: 24,
    P5Y: 60,
    NONE: null,
};

/** Days in a Gregorian month, so a 31st can be clamped into a 30-day month. */
function daysInMonth(year: number, month1: number): number {
    // month1 is 1-12. Day 0 of the NEXT month is the last day of this one,
    // and `Date.UTC` normalises the rollover at December for us.
    return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * The expiry DAY KEY for a document uploaded today, or null for «Без срок».
 *
 * Integer month arithmetic on a `YYYY-MM-DD` string, with month-end
 * clamping — never `Date` arithmetic. The schema docblock states the rule:
 * the concept is a calendar date, lexicographic order IS calendar order, and
 * there is no DST boundary to get wrong. A 31 January upload with a 1-month
 * period expires on 28 (or 29) February, not on 3 March.
 *
 * Computed in `FARM_TIME_ZONE` via `farmToday`, never `NOTIFICATIONS_TZ`,
 * which defaults to Europe/London and would roll the day over an hour early
 * for part of the year.
 */
export function documentExpiryDayKey(
    retention: DocumentRetention,
    now: Date = new Date(),
): string | null {
    const months = RETENTION_MONTHS[retention];
    if (months == null) return null;

    const [y, m, d] = farmToday(now).split('-').map(Number);
    const zeroBased = m - 1 + months;
    const year = y + Math.floor(zeroBased / 12);
    const month1 = (zeroBased % 12) + 1;
    const day = Math.min(d, daysInMonth(year, month1));

    return `${year}-${String(month1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface FarmDocumentRow {
    id: string;
    name: string | null;
    contentType: string;
    sizeBytes: number;
    uploadedAt: string;
    uploadedBy: { id: string; name: string | null };
    /**
     * Day key, or null for «Без срок».
     *
     * Named `expiresOn`, not `expiresAt`, and the two sibling timestamps are
     * why: `uploadedAt` and `purgedAt` are instants, this is a calendar DAY.
     * One `…At` among them that means something different is a field every
     * client has to remember an exception for. It also matches the column.
     * #2495's Routes section writes `expiresAt`; this deviates from that text
     * deliberately — see the note on the issue.
     */
    expiresOn: string | null;
    /**
     * The retention period AS IT WAS AT UPLOAD, so a client can say «Пази се
     * 1 година, до …». `expiresOn` alone loses WHY that date was given, and
     * cannot tell a 1-year document from a 2-year one uploaded a year
     * earlier.
     */
    retention: string;
    purgedAt: string | null;
    /**
     * Why the bytes went, when they did. EXPLICIT rather than inferable:
     * a client should not have to work out which of two states it is in from
     * which fields happen to be null — `name` is dropped on a manual delete
     * and kept on expiry, so null-ness nearly works and would fail on any
     * row that ever has a null name for another reason.
     */
    purgeReason: 'EXPIRED' | 'DELETED' | null;
    /** Who deleted it. Null when nobody did — an expiry has no actor. */
    purgedBy: { id: string; name: string | null } | null;
    mayDelete: boolean;
    drive: { state: string };
}

/** `true` when this caller may delete this row — mirrors `mayDelete`. */
function mayDelete(ctx: RequestContext, uploadedByUserId: string): boolean {
    return uploadedByUserId === ctx.userId || ctx.permissions.canAdmin;
}

const ROW_SELECT = {
    id: true,
    name: true,
    retention: true,
    expiresOn: true,
    purgedAt: true,
    purgeReason: true,
    driveState: true,
    createdAt: true,
    uploadedByUserId: true,
    uploadedBy: { select: { id: true, name: true } },
    purgedBy: { select: { id: true, name: true } },
    fileRecord: { select: { mimeType: true, sizeBytes: true } },
} as const;

type RowShape = {
    id: string;
    name: string | null;
    retention: string;
    expiresOn: string | null;
    purgedAt: Date | null;
    purgeReason: string | null;
    driveState: string;
    createdAt: Date;
    uploadedByUserId: string;
    uploadedBy: { id: string; name: string | null } | null;
    purgedBy: { id: string; name: string | null } | null;
    fileRecord: { mimeType: string | null; sizeBytes: number | null } | null;
};

function toRow(ctx: RequestContext, r: RowShape): FarmDocumentRow {
    return {
        id: r.id,
        name: r.name,
        contentType: r.fileRecord?.mimeType ?? 'application/octet-stream',
        sizeBytes: r.fileRecord?.sizeBytes ?? 0,
        uploadedAt: r.createdAt.toISOString(),
        uploadedBy: { id: r.uploadedBy?.id ?? r.uploadedByUserId, name: r.uploadedBy?.name ?? null },
        expiresOn: r.expiresOn,
        retention: r.retention,
        purgedAt: r.purgedAt ? r.purgedAt.toISOString() : null,
        purgeReason: (r.purgeReason as 'EXPIRED' | 'DELETED' | null) ?? null,
        purgedBy: r.purgedBy ? { id: r.purgedBy.id, name: r.purgedBy.name } : null,
        mayDelete: mayDelete(ctx, r.uploadedByUserId),
        drive: { state: r.driveState },
    };
}

/**
 * The library, newest first. Tombstones are INCLUDED — a purged row is the
 * only record that a document ever existed, and dropping it would make
 * "destroyed by policy on 14 March" and "never existed" the same
 * observation (Decision 2).
 */
export async function listFarmDocuments(
    ctx: RequestContext,
): Promise<{ rows: FarmDocumentRow[]; truncated: boolean }> {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        const found = (await db.farmDocument.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: { createdAt: 'desc' },
            take: DOCUMENT_PAGE_SIZE + 1,
            select: ROW_SELECT,
        })) as unknown as RowShape[];

        const truncated = found.length > DOCUMENT_PAGE_SIZE;
        const page = truncated ? found.slice(0, DOCUMENT_PAGE_SIZE) : found;
        return { rows: page.map((r) => toRow(ctx, r)), truncated };
    });
}

/**
 * Accept one uploaded file into the library.
 *
 * `ingestUploadedFile` runs OUTSIDE the transaction, on purpose: it writes
 * bytes and runs the AV scan, and holding a pool connection across that
 * would be an interactive transaction waiting on a network service. It also
 * carries the `'upload'` past-due gate for this module — see the docblock.
 *
 * The retention period is stamped AS IT WAS AT UPLOAD and never re-read, so
 * a later settings change cannot move an existing document's expiry. That is
 * what makes `retention` a column rather than a lookup.
 */
export async function uploadFarmDocument(
    ctx: RequestContext,
    file: File,
    opts: { idempotencyKey?: string | null; title?: string | null } = {},
    now: Date = new Date(),
): Promise<FarmDocumentRow> {
    const idempotencyKey = opts.idempotencyKey;
    try {
        return await uploadFarmDocumentImpl(ctx, file, opts, now);
    } catch (err) {
        // Race backstop. The pre-check below is not a lock, so two retries
        // arriving together can both pass it; the PARTIAL unique index is
        // what actually serialises them, and the loser re-reads the winner's
        // row rather than surfacing a 500 for a write that did succeed.
        if (idempotencyKey && isUniqueViolation(err)) {
            const existing = await findByIdempotencyKey(ctx, idempotencyKey);
            if (existing) return existing;
        }
        throw err;
    }
}

async function uploadFarmDocumentImpl(
    ctx: RequestContext,
    file: File,
    opts: { idempotencyKey?: string | null; title?: string | null },
    now: Date,
): Promise<FarmDocumentRow> {
    const { idempotencyKey } = opts;
    assertCanWrite(ctx);

    // Answer a replay BEFORE spending the bytes. An upload is the one write
    // where a retry is most likely — a multipart body over a rural
    // connection — and this is deliberately not an outbox surface, so a
    // client retry under the same key is the whole recovery story.
    if (idempotencyKey) {
        const existing = await findByIdempotencyKey(ctx, idempotencyKey);
        if (existing) return existing;
    }

    const ingested = await ingestUploadedFile(ctx.tenantId, file, {
        domain: 'documents',
        fallbackName: 'document',
        component: 'farm-documents',
    });

    return runInTenantContext(ctx, async (db) => {
        const settings = await db.tenantDocumentSettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: { retention: true },
        });
        // No settings row yet means nobody has opened the settings screen —
        // the schema default is the answer, not an error. Step 3 adds the
        // routes that create this row.
        const retention: DocumentRetention = settings?.retention ?? 'P1Y';

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
        // The TERMINAL outcome ingest reported. Never a default — a default
        // meaning "unscanned" also means "downloadable", because
        // `isDownloadAllowed('SKIPPED')` is true in every scan mode.
        await FileRepository.markStored(db, ctx, fileRecord.id, ingested.scanStatus);

        const created = (await db.farmDocument.create({
            data: {
                tenantId: ctx.tenantId,
                // The farmer's own title when the upload supplied one,
                // falling back to the filename.
                //
                // This is NOT cosmetic. A native client cannot put a
                // Cyrillic title in a multipart part header and expect every
                // parser to agree on the encoding, so it sends an ASCII
                // filename plus a `name` TEXT field. Reading only the file
                // part would title every document from the phone
                // «document.pdf».
                //
                // Sanitised because it is user-supplied free text going into
                // a stored field (Epic C.5, at the usecase layer).
                // `sanitizePlainText` trims since #1825, so a
                // whitespace-only title falls through to the filename rather
                // than storing blanks.
                //
                // Encrypted at rest — `FarmDocument` is in
                // `ENCRYPTED_FIELDS` because a title is routinely
                // «Договор аренда <фамилия>.pdf».
                name: sanitizePlainText(opts.title) || ingested.originalName,
                fileRecordId: fileRecord.id,
                uploadedByUserId: ctx.userId,
                retention,
                expiresOn: documentExpiryDayKey(retention, now),
                idempotencyKey: idempotencyKey || null,
                // Always OFF at this step. The Drive copy job is delivery
                // step 4; setting PENDING before anything drains it would
                // leave rows claiming a copy is on its way when nothing is
                // enqueued — the state `OFF` vs `FAILED` split exists to keep
                // "a setting" and "an error" distinguishable.
                driveState: 'OFF',
            },
            select: ROW_SELECT,
        })) as unknown as RowShape;

        await logEvent(db, ctx, {
            action: 'FARM_DOCUMENT_UPLOADED',
            entityType: 'FarmDocument',
            entityId: created.id,
            // No filename here: `details` is not an encrypted column and the
            // name is third-party personal data. The row carries it.
            details: 'Document uploaded to the farm library',
            detailsJson: {
                retention,
                expiresOn: created.expiresOn,
                sizeBytes: ingested.sizeBytes,
                contentType: ingested.mimeType,
                scanStatus: ingested.scanStatus,
            },
        });

        return toRow(ctx, created);
    });
}

/**
 * The document a previous attempt under this key already created, or null.
 *
 * Returned through `toRow` so the replay answer is shape-identical to the
 * create answer — a dedupe that returns a different payload gives the caller
 * an odd shape on exactly the path that only runs when the connection is bad,
 * which is where it is least likely to have been tested.
 */
async function findByIdempotencyKey(
    ctx: RequestContext,
    idempotencyKey: string,
): Promise<FarmDocumentRow | null> {
    return runInTenantContext(ctx, async (db) => {
        const found = (await db.farmDocument.findFirst({
            where: { tenantId: ctx.tenantId, idempotencyKey },
            select: ROW_SELECT,
        })) as unknown as RowShape | null;
        return found ? toRow(ctx, found) : null;
    });
}

/**
 * Open the bytes for preview.
 *
 * THIS IS THE AV EGRESS GATE for the library, and it is registered in
 * `USECASE_SEAMS` in `download-route-gate-reachability` for that reason.
 * `ingestUploadedFile` writes bytes before the scan resolves; the argument
 * that makes that safe is this function asking `isDownloadAllowed` first.
 */
export async function downloadFarmDocument(ctx: RequestContext, documentId: string) {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        const doc = await db.farmDocument.findFirst({
            where: { id: documentId, tenantId: ctx.tenantId },
            select: { id: true, name: true, purgedAt: true, fileRecordId: true },
        });
        if (!doc) throw codedNotFound('DOCUMENT_NOT_FOUND', 'That document was not found.');
        // A tombstone has no bytes. The row stays visible in the list — that
        // is the point of Decision 2 — but `/content` is a 404.
        if (doc.purgedAt) {
            throw codedNotFound('DOCUMENT_PURGED', 'That document has been deleted.');
        }

        const fileRecord = await FileRepository.getByIdForTenant(db, ctx.tenantId, doc.fileRecordId);
        if (!fileRecord) throw codedNotFound('DOCUMENT_NOT_FOUND', 'That document was not found.');
        if (fileRecord.status !== 'STORED') {
            throw codedNotFound('DOCUMENT_NOT_DOWNLOADABLE', 'That document is not available yet.');
        }

        // Cross-tenant key guard, on the RESOLVED key rather than the id.
        assertTenantKey(fileRecord.pathKey, ctx.tenantId);

        // INFECTED is checked AHEAD of the gate deliberately, the same way
        // `ingest.ts` does it: the gate answers "may this be served", and an
        // infected file deserves its own refusal rather than the generic one.
        if (fileRecord.scanStatus === 'INFECTED') {
            throw codedForbidden(
                'FILE_SCAN_REJECTED',
                'That document was flagged by antivirus scanning and cannot be opened.',
            );
        }
        // NO DEFAULT on this argument. `isDownloadAllowed('SKIPPED')` is true
        // in every `AV_SCAN_MODE`, so `?? 'SKIPPED'` would turn "we never
        // scanned this" into "serve it".
        if (!isDownloadAllowed(fileRecord.scanStatus)) {
            // A SEPARATE code from the rejection above, because the two mean
            // opposite things to the person holding the phone: one is "wait
            // and try again", the other is "this file is not coming". One
            // code for both would be the uniform-failure-shape defect — the
            // client cannot say which happened, so it has to say neither.
            throw codedForbidden(
                'FILE_SCAN_PENDING',
                'That document is still being scanned. Please try again shortly.',
            );
        }

        return {
            stream: getStorageProvider().readStream(fileRecord.pathKey),
            contentType: fileRecord.mimeType ?? 'application/octet-stream',
            sizeBytes: fileRecord.sizeBytes ?? null,
            name: doc.name,
        };
    });
}

/**
 * Delete a document's bytes and leave a tombstone.
 *
 * The row SURVIVES with `purgedAt`, `purgeReason: 'DELETED'` and
 * `purgedByUserId` — who and when, per the owner's ruling. The NAME is
 * dropped here and KEPT on expiry: a person deleting a document is asking
 * for it to go, while an expiry is the platform acting on a policy and the
 * title is what makes the tombstone readable.
 *
 * The Drive copy, if any, STAYS. Same as expiry: the copy lives in the
 * farm's own Drive and this product does not reach back into it.
 */
export async function deleteFarmDocument(ctx: RequestContext, documentId: string): Promise<void> {
    assertCanWrite(ctx);

    const pathKey = await runInTenantContext(ctx, async (db) => {
        const doc = await db.farmDocument.findFirst({
            where: { id: documentId, tenantId: ctx.tenantId },
            select: { id: true, uploadedByUserId: true, purgedAt: true, fileRecordId: true },
        });
        if (!doc) throw codedNotFound('DOCUMENT_NOT_FOUND', 'That document was not found.');
        if (!mayDelete(ctx, doc.uploadedByUserId)) {
            // Coded, even though `mayDelete` tells the client in advance:
            // the case this fires in is a STALE list — an admin revoked, or
            // the row belongs to somebody else and the page is old — and that
            // is exactly when a client needs to say something specific rather
            // than render an English sentence it cannot translate.
            throw codedForbidden(
                'DOCUMENT_DELETE_NOT_ALLOWED',
                'Only the person who uploaded this document, or an administrator, may delete it.',
            );
        }
        // Already a tombstone — idempotent, so a double tap does not rewrite
        // `purgedAt` and move the date an audit reads.
        if (doc.purgedAt) return null;

        const fileRecord = await FileRepository.getByIdForTenant(db, ctx.tenantId, doc.fileRecordId);
        if (fileRecord) assertTenantKey(fileRecord.pathKey, ctx.tenantId);

        await db.farmDocument.update({
            where: { id: doc.id },
            data: {
                name: null,
                purgedAt: new Date(),
                purgeReason: 'DELETED',
                purgedByUserId: ctx.userId,
            },
        });
        await FileRepository.markDeleted(db, ctx, doc.fileRecordId);

        await logEvent(db, ctx, {
            action: 'FARM_DOCUMENT_DELETED',
            entityType: 'FarmDocument',
            entityId: doc.id,
            details: 'Document deleted from the farm library',
            detailsJson: { purgeReason: 'DELETED' },
        });

        return fileRecord?.pathKey ?? null;
    });

    // Bytes go AFTER the commit. A storage delete cannot be rolled back, so
    // doing it inside the transaction would destroy the object and then —
    // on any later failure in the same transaction — leave a row pointing at
    // nothing with no tombstone saying why.
    if (pathKey) {
        await getStorageProvider().delete(pathKey);
    }
}
