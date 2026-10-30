/**
 * «Документи» — the farm document library (#2495, delivery step 2).
 *
 * Its own module rather than appended to `farm-profile.paths.ts`, for the
 * reason `farm-brand.paths.ts` gives about itself: this library is designed
 * to hold LEASE CONTRACTS, which name third parties, and filing it under the
 * farm's own identity would put a surface full of other people's personal
 * data beside the farm's. The two being easy to confuse is the risk.
 *
 * Four operations, and the one worth reading the description of is
 * `/content`: it is the AV egress gate, so its 403 is part of the contract
 * rather than an edge case.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ description: 'The farm whose library this is.' }),
});

const DocumentParams = TenantParams.extend({
    documentId: z.string().openapi({ description: 'The document.' }),
});

const UserRefSchema = z
    .object({
        id: z.string(),
        name: z.string().nullable(),
    })
    .openapi('FarmDocumentUploader');

const FarmDocumentRowSchema = z
    .object({
        id: z.string(),
        name: z.string().nullable().openapi({
            description:
                'The document title. NULL on a tombstone whose bytes were deleted by a person — the name is dropped on a manual delete and KEPT on expiry, because an expiry is the platform acting on a policy and the title is what makes that tombstone readable. Encrypted at rest: a title is routinely «Договор аренда <фамилия>.pdf».',
        }),
        contentType: z.string().openapi({
            description: 'The RESOLVED media type — what the bytes are, not what the upload claimed.',
        }),
        sizeBytes: z.number().int(),
        uploadedAt: z.string().openapi({ description: 'ISO 8601.' }),
        uploadedBy: UserRefSchema,
        expiresAt: z.string().nullable().openapi({
            description:
                'The expiry as a calendar DAY KEY (`YYYY-MM-DD`), or null for «Без срок». A day key rather than a timestamp because the concept is a calendar date: lexicographic order is calendar order, and there is no timezone for a reader to get wrong. Fixed at upload from the retention period in force then, so a later settings change never moves it.',
        }),
        purgedAt: z.string().nullable().openapi({
            description:
                'Set when the bytes were deleted, by expiry or by a person. The ROW SURVIVES: dropping it would make "destroyed by policy on 14 March" and "this never existed" the same observation, which for a compliance register is the worse failure. `/content` answers 404 once this is set.',
        }),
        mayDelete: z.boolean().openapi({
            description:
                'Whether THIS caller may delete this document — the uploader, or an administrator. Computed per row and per caller, because a role flag cannot express "may delete their own".',
        }),
        drive: z
            .object({
                state: z.enum(['OFF', 'PENDING', 'COPIED', 'FAILED']).openapi({
                    description:
                        'The one-way copy into the farm’s «Agrent» Drive folder. `OFF` means sync was not on when this was uploaded — a SETTING — which is deliberately distinct from `FAILED`, an error an admin can retry. Always `OFF` until the copy job ships.',
                }),
            })
            .openapi('FarmDocumentDriveState'),
    })
    .openapi('FarmDocumentRow');

const DocumentListSchema = z
    .object({
        rows: z.array(FarmDocumentRowSchema),
        truncated: z.boolean().openapi({
            description:
                'True when the library holds more than one page. The list is newest-first and capped rather than cursor-paginated, and this flag is derived by taking one row more than the cap — not from a separate count, which could disagree with the page it describes.',
        }),
    })
    .openapi('FarmDocumentList');

const UploadBodySchema = z
    .object({
        file: z.string().openapi({ type: 'string', format: 'binary' }),
    })
    .openapi('FarmDocumentUpload');

export function registerDocumentPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/documents',
        operationId: 'listFarmDocuments',
        summary: 'List the farm document library',
        description:
            'Newest first, tombstones included. Every member of the farm may read it; the machine-operator persona (MECHANISATOR) cannot reach this path at all. Carries a weak ETag, so a relaunch revalidates to 304 instead of re-sending the page.',
        tags: ['Documents'],
        params: TenantParams,
        success: { status: 200, description: 'The library.', schema: DocumentListSchema },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/documents',
        operationId: 'uploadFarmDocument',
        summary: 'Upload a document',
        description:
            'Multipart, through the shared upload pipeline and its scan and refusal codes. Writers and above. Send an `Idempotency-Key`: a retry under the same key answers from the document the first attempt created rather than creating a second one, which matters because a multipart body over a rural connection is the write most likely to be retried. This is deliberately NOT an offline-outbox surface — a queue cannot replay a body it is unable to hold — so a visible failure plus a retry is the whole recovery story.',
        tags: ['Documents'],
        params: TenantParams,
        headers: z.object({
            'Idempotency-Key': z.string().optional().openapi({
                description: 'Dedup key. Omitted means no deduplication: two deliberate uploads of the same file are two documents.',
            }),
        }),
        body: UploadBodySchema,
        bodyContentType: 'multipart/form-data',
        success: { status: 201, description: 'The stored document.', schema: FarmDocumentRowSchema },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/documents/{documentId}/content',
        operationId: 'readFarmDocumentContent',
        summary: 'Open a document for preview',
        description:
            'The bytes, with their resolved `Content-Type` and `Content-Disposition: inline`. THIS IS THE ANTIVIRUS EGRESS GATE: bytes are written before the scan resolves, so this route is what stops an unscanned or infected file being served. A 403 therefore means the scan refused it — infected, or still pending under a strict scan mode — and is part of the contract, not an edge case. A 404 means either no such document or a tombstone whose bytes are gone.',
        tags: ['Documents'],
        params: DocumentParams,
        success: {
            status: 200,
            description: 'The document bytes.',
            content: { 'application/octet-stream': z.string().openapi({ type: 'string', format: 'binary' }) },
        },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/documents/{documentId}',
        operationId: 'deleteFarmDocument',
        summary: 'Delete a document',
        description:
            'The uploader or an administrator, matching `mayDelete` on the row. The bytes go; the ROW SURVIVES as a tombstone recording who deleted it and when, with the title dropped. Idempotent: a second call on an existing tombstone does not move `purgedAt`, because that timestamp is what an audit dates from. Any Google Drive copy STAYS — it lives in the farm’s own Drive and this product does not reach back into it.',
        tags: ['Documents'],
        params: DocumentParams,
        success: {
            status: 200,
            description: 'Deleted; the tombstone remains in the list.',
            schema: z.object({ ok: z.boolean() }).openapi('FarmDocumentDeleteResult'),
        },
    });
}
