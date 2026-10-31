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
        uploadedAt: z.string().datetime().openapi({ description: 'ISO 8601 instant.' }),
        uploadedBy: UserRefSchema,
        expiresOn: z.string().nullable().openapi({
            format: 'date',
            description:
                'The expiry as a calendar DAY KEY (`YYYY-MM-DD`), or null for «Без срок». A day key rather than a timestamp because the concept is a calendar date: lexicographic order is calendar order, and there is no timezone for a reader to get wrong. Computed in Europe/Sofia and fixed at upload from the retention period in force then, so a later settings change never moves it. Named `expiresOn`, not `expiresAt`, because `uploadedAt` and `purgedAt` beside it are INSTANTS and this is a day — one `…At` meaning something different is an exception every client has to remember.',
        }),
        retention: z.enum(['P3M', 'P6M', 'P1Y', 'P2Y', 'P5Y', 'NONE']).openapi({
            description:
                'The retention period AS IT WAS AT UPLOAD, so a client can say «Пази се 1 година, до …». `expiresOn` alone loses WHY that date was given, and cannot tell a 1-year document from a 2-year one uploaded a year earlier.',
        }),
        purgedAt: z.string().datetime().nullable().openapi({
            description:
                'Set when the bytes were deleted, by expiry or by a person. The ROW SURVIVES: dropping it would make "destroyed by policy on 14 March" and "this never existed" the same observation, which for a compliance register is the worse failure. `/content` answers 404 once this is set.',
        }),
        purgeReason: z.enum(['EXPIRED', 'DELETED']).nullable().openapi({
            description:
                'Why the bytes went. EXPLICIT rather than inferable: a client should not have to work out which state a tombstone is in from which fields happen to be null. `name` is dropped on a DELETED tombstone and kept on an EXPIRED one, so null-ness nearly works — and would fail on any row that ever has a null name for another reason.',
        }),
        purgedBy: UserRefSchema.nullable().openapi({
            description:
                'Who deleted it, for «Изтрит на … от <име>». Null when nobody did: an expiry has no actor, which is the other half of telling the two tombstones apart.',
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
        name: z.string().optional().openapi({
            description:
                "The farmer's own title for the document. Send this rather than relying on the file part's filename: a Cyrillic name in a multipart part header depends on every parser agreeing about the encoding, while a text field does not. Falls back to the filename when absent or blank, so a web form that sends only `file` keeps working.",
        }),
    })
    .openapi('FarmDocumentUpload');

const DocumentSettingsSchema = z
    .object({
        retention: z.enum(['P3M', 'P6M', 'P1Y', 'P2Y', 'P5Y', 'NONE']).openapi({
            description:
                'The retention period applied to NEW uploads. Changing it never moves an existing document\'s expiry — every document carries the period it was uploaded under.',
        }),
        driveSync: z.boolean().openapi({
            description:
                'Whether new uploads are copied into the farm’s «Agrent» Drive folder. Turning it OFF stops new copies; it does not revoke the Google connection, which the ДНЕВНИК export still uses, and it does not remove copies already made.',
        }),
        usedBytes: z.number().int().openapi({
            description:
                'Bytes this farm currently holds in the library. The EXACT figure, unlike the bucketed band on `/api/readyz` — this route is authenticated and scoped to the farm that owns the bytes, so a farm learning its own total is not a disclosure. Purged documents stop counting as soon as their bytes go, which is what makes deleting a document free space.',
        }),
        limitBytes: z.number().int().openapi({
            description:
                'The per-tenant ceiling, ALWAYS present — there is no absent-means-unlimited case for a client to handle. Read from an env var rather than the plan: `STRIPE_SECRET_KEY` is absent on this deployment, so every tenant resolves to ENTERPRISE and every ENTERPRISE plan limit is null, meaning a plan-based cap would enforce nothing.',
        }),
        mayEdit: z.boolean().openapi({
            description: 'Whether THIS caller may change these settings (admin). Readable by every member.',
        }),
        google: z
            .object({
                connected: z.boolean().openapi({
                    description:
                        'True only when an ENABLED Google connection exists whose granted products include Drive. A calendar-only grant reports false, because it cannot copy a document and offering the toggle would promise a copy that never happens. No account email is reported: the connection record carries granted products and scopes, not an address, and storing one would be a personal-data decision rather than a lookup.',
                }),
            })
            .openapi('FarmDocumentGoogleState'),
    })
    .openapi('FarmDocumentSettings');

const UpdateDocumentSettingsSchema = z
    .object({
        retention: z.enum(['P3M', 'P6M', 'P1Y', 'P2Y', 'P5Y', 'NONE']).optional(),
        driveSync: z.boolean().optional(),
    })
    .openapi('UpdateFarmDocumentSettings');

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
            'Multipart, through the shared upload pipeline and its scan and refusal codes. Writers and above. Send an `Idempotency-Key`: a retry under the same key answers from the document the first attempt created rather than creating a second one, which matters because a multipart body over a rural connection is the write most likely to be retried. This is deliberately NOT an offline-outbox surface — a queue cannot replay a body it is unable to hold — so a visible failure plus a retry is the whole recovery story.\n\nTWO 403 codes, and they are different questions with different remedies. `PAST_DUE_RESTRICTED` is about the STANDING of the account — a payment failed and the grace period is over — and sends the operator to the billing portal. `DOCUMENT_STORAGE_FULL` is about the DISK: the library has a per-tenant byte ceiling and this upload would cross it. It carries `usedBytes`, `limitBytes` and `incomingBytes` as params so a client can render «1,9 GB от 2 GB» itself rather than being handed a sentence, and the remedy is to delete documents — a plan change buys nothing, because the ceiling is not a plan limit. Checked BEFORE the bytes are stored, so a refusal means nothing was written.',
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
            'The bytes, with their resolved `Content-Type` and `Content-Disposition: inline`. THIS IS THE ANTIVIRUS EGRESS GATE: bytes are written before the scan resolves, so this route is what stops an unscanned or infected file being served, and its 403 is part of the contract rather than an edge case.\n\nTWO distinct 403 codes, because they mean opposite things to the person reading the screen: `FILE_SCAN_PENDING` is "wait and try again" (the scan has not finished, under a strict scan mode), and `FILE_SCAN_REJECTED` is "this file is not coming" (antivirus flagged it). One code for both would leave a client unable to say which happened, so it would have to say neither.\n\nA 404 is `DOCUMENT_NOT_FOUND` for no such document, `DOCUMENT_PURGED` for a tombstone whose bytes are gone (the row is still in the list), or `DOCUMENT_NOT_DOWNLOADABLE` when the upload never reached a stored state — a `FileRecord` left PENDING or FAILED, which is a different thing from a document that has been deleted.',
        tags: ['Documents'],
        params: DocumentParams,
        success: {
            status: 200,
            description: 'The document bytes.',
            content: { 'application/octet-stream': z.string().openapi({ type: 'string', format: 'binary' }) },
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/documents/settings',
        operationId: 'getFarmDocumentSettings',
        summary: 'Read the farm document settings and its storage usage',
        description:
            'Readable by every member of the farm — the page shows the retention period in force and how full the library is. `usedBytes` and `limitBytes` are both always present.',
        tags: ['Documents'],
        params: TenantParams,
        success: { status: 200, description: 'The settings.', schema: DocumentSettingsSchema },
    });

    op(registry, {
        method: 'put',
        path: '/api/t/{tenantSlug}/documents/settings',
        operationId: 'updateFarmDocumentSettings',
        summary: 'Change the farm document settings',
        description:
            'Administrators only; `mayEdit` on the GET reports whether this caller qualifies. Both fields are optional, so a client may send either alone. A retention change applies to NEW uploads only. Refuses with 400 `DOCUMENT_RETENTION_INVALID` or `DOCUMENT_DRIVE_SYNC_INVALID` on a value outside the contract, rather than coercing it.',
        tags: ['Documents'],
        params: TenantParams,
        body: UpdateDocumentSettingsSchema,
        success: { status: 200, description: 'The settings after the change.', schema: DocumentSettingsSchema },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/documents/{documentId}',
        operationId: 'deleteFarmDocument',
        summary: 'Delete a document',
        description:
            'The uploader or an administrator, matching `mayDelete` on the row; anyone else gets 403 `DOCUMENT_DELETE_NOT_ALLOWED`, which a client will normally only see from a STALE list. The bytes go; the ROW SURVIVES as a tombstone carrying `purgeReason: DELETED`, `purgedBy` and `purgedAt`, with the title dropped — the title is KEPT on an expiry, because that is the platform acting on a policy rather than a person asking. Idempotent: a second call on an existing tombstone does not move `purgedAt`, because that timestamp is what an audit dates from. Any Google Drive copy STAYS — it lives in the farm’s own Drive and this product does not reach back into it.',
        tags: ['Documents'],
        params: DocumentParams,
        success: {
            status: 200,
            description: 'Deleted; the tombstone remains in the list.',
            schema: z.object({ ok: z.boolean() }).openapi('FarmDocumentDeleteResult'),
        },
    });
}
