/**
 * «Документи» — a farm's document library (#2495 step 2).
 *
 * Three of the feature's six paths. The settings pair and the Drive-copy retry
 * are steps 3 and 4 and are deliberately absent rather than documented ahead
 * of their handlers: a spec that describes a route which 404s is worse than a
 * route the spec does not mention, because a client codes against the former.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { op } from './helpers';

/**
 * Defined locally, as every other paths module does.
 *
 * `helpers.ts` exports no `TenantParams` — importing one from there resolves
 * to `undefined`, and the failure is asymmetric in a way worth recording: the
 * two operations that passed it straight to `params:` generated QUIETLY, with
 * no path parameters documented at all, and only the third one — which called
 * `.extend()` on it — threw. A spec that silently omits `{tenantSlug}` is
 * exactly the kind of thing a green generate would have shipped.
 */
const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});

const DocumentParams = TenantParams.extend({
    id: z.string().openapi({ param: { name: 'id', in: 'path' }, example: 'clz1x2y3z4a5b6c7d8e9f0g1' }),
});

const RETENTION = z
    .enum(['P3M', 'P6M', 'P1Y', 'P2Y', 'P5Y', 'NONE'])
    .openapi({
        description:
            'The retention period AS IT WAS AT UPLOAD, stored per document. A later settings change does not reach back — so two documents in one library can carry different periods, and that is the design rather than drift.',
    });

const DocumentRow = z
    .object({
        id: z.string(),
        name: z.string().nullable().openapi({
            description:
                'The display title. **Null on a DELETED tombstone**, where it is cleared deliberately: a manual delete is very often "this was the wrong file", and the name is the one field encrypted at rest precisely because a filename is routinely «Договор аренда <фамилия>.pdf». An EXPIRED tombstone KEEPS its name — expiry is policy, and the farm’s index of what it held is the point. Render the absence; do not substitute a placeholder, because the client owns that wording.',
        }),
        contentType: z.string().openapi({
            description: 'The RESOLVED type, from the stored bytes — not what the client declared at upload.',
        }),
        sizeBytes: z.number().int(),
        uploadedAt: z.string().openapi({ format: 'date-time' }),
        uploadedBy: z.object({ id: z.string(), name: z.string().nullable() }),
        retention: RETENTION,
        expiresOn: z.string().nullable().openapi({
            description:
                'A CALENDAR DAY KEY, `YYYY-MM-DD`, or null for «Без срок». Not a timestamp: the concept is a date, so an instant would carry information the concept does not have and every reader would then decide which day it meant. Computed in Europe/Sofia with clamped calendar-month arithmetic, so «1 година» lands on the same date next year and 31 January + 3 months is 30 April. A document is kept THROUGH this day.',
            example: '2027-03-14',
        }),
        purgedAt: z.string().nullable().openapi({
            format: 'date-time',
            description:
                'Set once the bytes are gone. ONE field for every tombstone whatever the reason — `purgeReason` carries the distinction, because two fields for one fact is how a client ends up reading whichever is populated.',
        }),
        purgeReason: z.enum(['EXPIRED', 'DELETED']).nullable().openapi({
            description:
                'Why the bytes went. Explicit rather than inferred from which fields are null: «Само в Google Drive», «Изтекъл срок» and «Изтрит от …» read differently to a farmer and so ARE three states.',
        }),
        purgedByUserId: z.string().nullable().openapi({
            description: 'Who deleted it. Null when `purgeReason` is `EXPIRED` — nobody did.',
        }),
        mayDelete: z.boolean().openapi({
            description:
                'Whether THIS caller may delete this row: the uploader, or an admin. The same predicate decides the refusal the server makes, so a rendered button cannot disagree with the result of pressing it.',
        }),
        drive: z.object({
            state: z.enum(['OFF', 'PENDING', 'COPIED', 'FAILED']).openapi({
                description:
                    '`OFF` means sync was not on when this was uploaded — a SETTING, distinct from `FAILED`, which is an error an admin can retry. The copy itself is not implemented yet (step 4), so every row reads `OFF` today.',
            }),
        }),
    })
    .openapi('FarmDocument');

export function registerDocumentPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/documents',
        operationId: 'listFarmDocuments',
        summary: 'List the farm’s documents, newest first',
        description:
            'One library per farm: every member sees and previews it, READER and AUDITOR included.\n\n'
            + '**MECHANISATOR cannot reach this route at all** — the operator lockdown admits only the field surfaces that persona needs on the job, and a general document library is not one. The refusal is at the Edge, so it is not a 403 from this handler.\n\n'
            + '**Tombstones are rows.** A document whose bytes have gone stays in this list with `purgedAt` set, because dropping it would make "we destroyed this by policy on 14 March" and "this never existed" the same observation — for a compliance register, the worse failure.\n\n'
            + 'Bounded at 200 rows. `truncated` says the farm has more than the page returned; it is reported rather than inferred so a short list is never mistaken for a complete one.\n\n'
            + 'Carries a weak `ETag`; send `If-None-Match` for a 304 and no body.',
        tags: ['Documents'],
        params: TenantParams,
        query: z.object({
            limit: z.coerce.number().int().min(1).max(200).optional().openapi({
                description: 'Page size, 1–200. Defaults to 200.',
            }),
        }),
        success: {
            status: 200,
            description: 'The farm’s documents, newest first.',
            schema: z.object({ rows: z.array(DocumentRow), truncated: z.boolean() }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/documents',
        operationId: 'uploadFarmDocument',
        summary: 'Upload a document',
        description:
            'Writers and above. One part named `file`, through the shared upload pipeline — allowlist, then write, then MIME reconciliation against the bytes, then the virus scan.\n\n'
            + '**`retention` and `expiresOn` are fixed HERE** from the farm’s current setting and stored on the row, so a later settings change cannot reach back and shorten the life of a document already filed.\n\n'
            + '**`Idempotency-Key` is honoured** and is a RETRY handle, not an outbox replay — «Документи» is deliberately not an offline-outbox surface, because a multipart body with bytes is the worst case for a queue that would have to hold and replay it. Send the same key when retrying an upload whose response you lost and the original row comes back instead of a second document. Deduping on the content hash was rejected: a farm legitimately uploads the same scan twice (one lease, two parcels).\n\n'
            + '**Refusal codes.**\n'
            + '- `FILE_TYPE_NOT_ALLOWED` — with `reason: "declared"` when the client’s claimed type is refused, and `reason: "content"` when the bytes contradicted the claim. Two different things to tell a user.\n'
            + '- `FILE_TOO_LARGE`, `FILE_EMPTY` — the shared upload bounds.\n'
            + '- `PAST_DUE_RESTRICTED` — the account’s payment failed and the grace period is over. A statement about standing, not about permission: the remedy is the billing portal, not a plan change.',
        tags: ['Documents'],
        params: TenantParams,
        bodyContentType: 'multipart/form-data',
        body: z.object({ file: z.string().openapi({ format: 'binary' }) }),
        success: {
            status: 201,
            description: 'The stored document. On a replayed `Idempotency-Key`, the ORIGINAL row.',
            schema: DocumentRow,
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/documents/{id}/content',
        operationId: 'getFarmDocumentContent',
        summary: 'Fetch a document’s bytes, for preview',
        description:
            'The bytes, with the type recorded at upload and `Content-Disposition: inline` — this endpoint exists so a phone can render a PDF or an image in place.\n\n'
            + '**No filename is offered.** The document’s `name` is encrypted at rest because it routinely names a third party, and a `Content-Disposition` filename would put that name into every proxy log on the path.\n\n'
            + '**Every read passes the virus gate.** Bytes reach disk before the scan completes, so this route is what stops an infected file being served — the whole ingest design rests on that being true here.\n\n'
            + '**Refusal codes.**\n'
            + '- `DOCUMENT_NOT_FOUND` — no such document in this farm.\n'
            + '- `DOCUMENT_PURGED` — a tombstone: the row is still in the list with its `purgedAt`, and the bytes genuinely are not there.\n'
            + '- `DOCUMENT_NOT_STORED` — the upload did not complete.\n'
            + '- A 403 when the scan verdict refuses it.',
        tags: ['Documents'],
        params: DocumentParams,
        success: {
            status: 200,
            description: 'The document bytes, served `private, no-store`.',
            content: {
                'application/pdf': z.string().openapi({ format: 'binary' }),
                'image/jpeg': z.string().openapi({ format: 'binary' }),
                'image/png': z.string().openapi({ format: 'binary' }),
                'application/octet-stream': z.string().openapi({ format: 'binary' }),
            },
        },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/documents/{id}',
        operationId: 'deleteFarmDocument',
        summary: 'Delete a document',
        description:
            'The uploader or an admin — the same rule the list reports as `mayDelete`.\n\n'
            + '**The bytes go; the row survives** as a tombstone with `purgeReason: "DELETED"`, who deleted it and when, and its `name` CLEARED. The asymmetry with expiry is deliberate: expiry is policy, so the farm keeps its index of what it held; a manual delete is a person’s intent, and keeping the name indefinitely would preserve the one field encrypted because it names third parties.\n\n'
            + 'Idempotent. Deleting an existing tombstone changes nothing and does NOT re-stamp `purgedAt` — that timestamp is what an appeal and a regulator date from.\n\n'
            + '**Refusal codes.**\n'
            + '- `DOCUMENT_NOT_FOUND` — no such document in this farm.\n'
            + '- A 403 when the caller neither uploaded it nor is an admin.',
        tags: ['Documents'],
        params: DocumentParams,
        success: {
            status: 200,
            description: 'The tombstone, so a client can update the row it is showing without a refetch.',
            schema: DocumentRow,
        },
    });
}
