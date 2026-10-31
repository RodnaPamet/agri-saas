/**
 * «Документи» persistence (#2495 step 2).
 *
 * Every query filters `tenantId` — the application half of the two-layer
 * isolation, with RLS underneath. `FarmDocument` carries
 * `@@unique([id, tenantId])` specifically so a by-id read can be a COMPOUND
 * lookup rather than a findUnique on `id` followed by a tenant check in
 * application code: the second shape returns the other tenant's row to the
 * caller's memory before anything rejects it.
 */
import { PrismaTx } from '@/lib/db-context';

import { RequestContext } from '../types';

import type { DocumentPurgeReason, DocumentRetention } from '@prisma/client';

/**
 * What a row needs for the list and for the tombstone states.
 *
 * `fileRecord` comes along because `/content`'s gate reads `scanStatus` and
 * `pathKey` from it, and because the list reports `contentType` / `sizeBytes`
 * from the RESOLVED values rather than from what a client claimed at upload.
 */
const ROW_SELECT = {
    id: true,
    name: true,
    retention: true,
    expiresOn: true,
    purgedAt: true,
    purgeReason: true,
    purgedByUserId: true,
    driveState: true,
    createdAt: true,
    uploadedByUserId: true,
    fileRecordId: true,
    fileRecord: {
        select: {
            mimeType: true,
            sizeBytes: true,
            pathKey: true,
            scanStatus: true,
            status: true,
            storageProvider: true,
            bucket: true,
        },
    },
    uploadedBy: { select: { id: true, name: true, email: true } },
} as const;

export class FarmDocumentRepository {
    /**
     * Newest first, bounded.
     *
     * `take: limit + 1` so the caller can report `truncated` without a second
     * COUNT — and the bound is not optional: an unbounded `findMany` in a
     * repository trips the D2 budget, and a farm with a document scanner can
     * produce a lot of rows.
     */
    static async list(db: PrismaTx, ctx: RequestContext, limit: number) {
        return db.farmDocument.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: { createdAt: 'desc' },
            take: limit + 1,
            select: ROW_SELECT,
        });
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.farmDocument.findFirst({
            where: { id, tenantId: ctx.tenantId },
            select: ROW_SELECT,
        });
    }

    static async create(
        db: PrismaTx,
        ctx: RequestContext,
        data: {
            name: string;
            fileRecordId: string;
            retention: DocumentRetention;
            expiresOn: string | null;
            clientMutationId: string | null;
        },
    ) {
        return db.farmDocument.create({
            data: {
                tenantId: ctx.tenantId,
                name: data.name,
                fileRecordId: data.fileRecordId,
                uploadedByUserId: ctx.userId,
                retention: data.retention,
                expiresOn: data.expiresOn,
                clientMutationId: data.clientMutationId,
                // `driveState` is left at its OFF default. The copy is step 4;
                // writing PENDING here would queue work nothing drains and
                // show «Изпраща се…» for ever.
            },
            select: ROW_SELECT,
        });
    }

    /**
     * Stamp a tombstone.
     *
     * ONE `purgedAt` whatever the reason, with `purgeReason` carrying the
     * distinction — two fields for one fact is how a client ends up reading
     * whichever is populated. `name` is cleared for DELETED and kept for
     * EXPIRED (owner ruling): expiry is policy and the farm's index of what it
     * held is the point, while a manual delete is a person's intent and very
     * often "this was the wrong file".
     */
    static async markPurged(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        reason: DocumentPurgeReason,
    ) {
        return db.farmDocument.update({
            where: { id },
            data: {
                purgedAt: new Date(),
                purgeReason: reason,
                purgedByUserId: reason === 'DELETED' ? ctx.userId : null,
                ...(reason === 'DELETED' ? { name: null } : {}),
            },
            select: ROW_SELECT,
        });
    }

    /**
     * The row a previous attempt with this key already filed, or null.
     *
     * Scoped to the tenant as well as the key, matching the
     * `@@unique([tenantId, clientMutationId])` shape: the key is a client's
     * own id and only has to be unique within the farm.
     */
    static async findByClientMutationId(
        db: PrismaTx,
        ctx: RequestContext,
        clientMutationId: string,
    ) {
        return db.farmDocument.findFirst({
            where: { tenantId: ctx.tenantId, clientMutationId },
            select: ROW_SELECT,
        });
    }

    /**
     * The tenant's settings row, or null.
     *
     * Null is not an error and must NOT be created here: this is read on a
     * GET, and a read that writes a row is a surprise in a request the caller
     * believes is idempotent. The caller applies the schema's own defaults —
     * see `DEFAULT_DOCUMENT_SETTINGS`.
     */
    static async settings(db: PrismaTx, ctx: RequestContext) {
        return db.tenantDocumentSettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: { retention: true, driveSync: true },
        });
    }
}
