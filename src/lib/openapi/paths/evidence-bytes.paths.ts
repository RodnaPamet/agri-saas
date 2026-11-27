/**
 * Evidence bytes — the upload, the bulk ZIP import, and the download (#3080).
 *
 * Four paths, its own module, and the separation is about hazard rather than
 * tidiness: everything here either accepts bytes from a caller or serves them
 * back, so the allowlist, the scanner, the metadata strippers and the egress
 * gate all live on these operations and on no others in the evidence family.
 *
 * ── These are the only evidence routes that are NOT JSON ──
 *
 * Both writes are `multipart/form-data`, and the download answers with FILE
 * BYTES — or a 302 to a presigned URL, depending on the storage provider. A
 * client generated from this spec has to special-case all three.
 *
 * ── The error envelope does NOT apply to three of them ──
 *
 * `uploads`, `imports` and `imports/{jobId}` answer their own refusals with a
 * BARE `{"error": "<sentence>"}` — not the `{error: {code, message}}`
 * envelope every other route here uses, and with no `code` to switch on. That
 * is the shape the handlers actually return, so it is what the spec says;
 * `rawErrorResponses` exists for exactly this.
 *
 * ── An upload is rewritten before it is stored ──
 *
 * Not merely scanned: EXIF/GPS is stripped from images and document metadata
 * from PDFs, so the bytes in storage are not the bytes sent. The sha256 is
 * over the STORED bytes for that reason, which means a client cannot
 * pre-compute it from the file it uploaded.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { EvidenceSchema } from './evidence.paths';
import { codedErrorResponses, op, rawErrorResponses } from './helpers';

const TAGS = ['Evidence'];

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ description: 'The farm these bytes belong to.' }),
});

/**
 * The multipart upload body.
 *
 * Every metadata field is read off the form as a STRING — the handler does
 * `formData.get(...)` with no coercion — so a number or a boolean arrives as
 * its text.
 */
const UploadFormSchema = z
    .object({
        file: z.string().openapi({
            type: 'string',
            format: 'binary',
            description:
                'REQUIRED. A missing or non-File value is a 400 in the BARE error shape.',
        }),
        title: z.string().optional().openapi({
            description:
                'Defaults to the uploaded filename when omitted. Sanitised before storage.',
        }),
        taskId: z.string().optional(),
        assetId: z.string().optional().openapi({
            description:
                'Attaching to an asset or a task is what makes the file downloadable by a '
                + 'READER later — see the download operation\'s provenance rule.',
        }),
        category: z.string().optional(),
        folder: z.string().optional().openapi({
            description:
                'Applied to the created record. Rides with the upload so a batch writes the '
                + 'same folder onto every row.',
        }),
        owner: z.string().optional().openapi({ description: 'Free-text keeper.' }),
        reviewCycle: z.string().optional(),
        nextReviewDate: z.string().optional().openapi({
            description: 'ISO 8601. A string on the form, like every field here.',
        }),
    })
    .openapi('EvidenceUploadForm');

const ImportFormSchema = z
    .object({
        file: z.string().openapi({
            type: 'string',
            format: 'binary',
            description:
                'A `.zip` archive. The EXTENSION is checked as well as the MIME type, and '
                + 'both must pass.',
        }),
    })
    .openapi('EvidenceImportForm');

const ImportJobSchema = z
    .object({
        jobId: z.string(),
        state: z.string().openapi({
            description:
                'The BullMQ job state — `waiting`, `active`, `completed`, `failed`, '
                + '`delayed`. A STRING rather than an enum: it is the queue\'s vocabulary, '
                + 'not this API\'s, so a client needs a default arm.',
        }),
        progress: z.unknown().openapi({
            description:
                'Whatever the executor last reported through `updateProgress` — a number or '
                + 'an object of counters, and `0` before it has reported anything. Shape is '
                + 'the executor\'s, so treat it as opaque unless you own that job.',
        }),
        result: z.unknown().nullable().openapi({
            description:
                'BullMQ\'s `returnvalue`: the executor\'s full counters, present only once '
                + '`state` is `completed`. Null otherwise — including while the job is '
                + 'running, so this is not a progress signal.',
        }),
        failedReason: z.string().nullable().openapi({
            description: 'Set when `state` is `failed`. Null otherwise.',
        }),
    })
    .openapi('EvidenceImportJob');

export function registerEvidenceBytesPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/evidence/uploads',
        operationId: 'uploadEvidenceFile',
        summary: 'Upload a file as evidence',
        description:
            'The ONLY way to create `type: FILE` evidence. `POST /evidence` creates LINK '
            + 'and TEXT records and would leave a FILE record with no bytes behind it.\n\n'
            + '**The stored bytes are not the bytes you sent, and the pipeline is worth '
            + 'knowing in order:**\n\n'
            + '1. The declared `Content-Type` is checked against the allowlist → '
            + '`FILE_TYPE_NOT_ALLOWED`.\n'
            + '2. The BYTES are sniffed and the resolved type is checked again, so a caller '
            + 'that mislabels a file is refused on content rather than on its claim — the '
            + 'same code with `reason: "content"`. A mismatch that is still allowed is '
            + 'logged and proceeds.\n'
            + '3. The buffer is **AV-scanned before** the record is marked stored, and '
            + 'ahead of the strippers below — a decoder fed caller-controlled bytes wants a '
            + 'scan in front of it.\n'
            + '4. **EXIF/GPS is stripped from images.** This is the live case, not a '
            + 'hypothetical: a farmer photographs a field from the field, and the GPS tag in '
            + 'that photo is the parcel\'s location.\n'
            + '5. **Document metadata is stripped from PDFs**, and this step can REFUSE: a '
            + 'PDF whose bytes cannot be parsed is a 400 rather than being stored '
            + 'unstripped, because a privacy property that degrades silently to no privacy '
            + 'is not one. The two strippers are mutually exclusive by resolved type and an '
            + 'archive passes through both untouched.\n\n'
            + 'So the `sha256` on the record digests the STORED bytes. A client cannot '
            + 'pre-compute it from the file it uploaded, and for an image or a PDF it will '
            + 'not match.\n\n'
            + '**Identical bytes are DEDUPLICATED.** If a STORED file with the same sha256 '
            + 'already exists for this farm, the new object is deleted and the existing '
            + '`FileRecord` is reused — so two evidence records can share one file, and '
            + 'uploading the same document twice costs one copy. Note the dedup is on the '
            + 'bytes AFTER stripping, so two photos differing only in EXIF dedupe to one.\n\n'
            + 'Gated on the `upload` capability, so a past-due tenant is refused here '
            + 'rather than at a shared choke point — this route was one of four that did '
            + 'not reach the gate everything was assumed to pass through.',
        tags: TAGS,
        params: TenantParams,
        body: UploadFormSchema,
        bodyContentType: 'multipart/form-data',
        success: {
            status: 201,
            description: 'The created evidence record.',
            // The SAME schema `GET /evidence/{id}` returns, imported rather
            // than mirrored: `openapi-response-shapes-ratchet` holds the count
            // of operations with no 2xx shape at zero, and its message is
            // explicit that a hand-written copy is the wrong way to satisfy it.
            schema: EvidenceSchema,
        },
        extraResponses: {
            ...rawErrorResponses({
                400: 'The BARE `{"error": "..."}` shape, NOT the envelope: `file` was '
                    + 'missing from the form or was not a File.',
            }),
            ...codedErrorResponses({
                403: '`PAST_DUE_RESTRICTED` — the farm owes payment and the `upload` '
                    + 'capability is withheld. Read-only members are refused with the '
                    + 'ordinary permission code.',
            }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/evidence/imports',
        operationId: 'importEvidenceArchive',
        summary: 'Stage a ZIP of evidence for background extraction',
        description:
            'Accepts the archive, stages it, enqueues a job, and returns — it does NOT '
            + 'extract anything. A ZIP can hold hundreds of files and decompressing it '
            + 'inside the request would stall the runtime for minutes, so the contract here '
            + 'is "accept, stage, enqueue" and the worker does the work. Poll '
            + '`GET /evidence/imports/{jobId}`.\n\n'
            + 'Needs the `evidence.upload` **capability**, not a role tier — and that check '
            + 'answers in the BARE error shape.\n\n'
            + 'Four cheap refusals run before a byte is written, each with its own status '
            + 'so the caller learns something more useful than "rejected":\n\n'
            + '- an empty archive → **400**\n'
            + '- over the **100 MB** cap → **413**\n'
            + '- a filename not ending `.zip` → **415**\n'
            + '- a MIME outside `application/zip`, `application/x-zip-compressed` and '
            + '`application/octet-stream` → **415**. The third is admitted because some '
            + 'browsers label a `.zip` that way, which is why the extension is checked too.\n\n'
            + 'The past-due gate runs AFTER those and before the write: a 415 for a file '
            + 'that would be refused anyway costs the caller nothing and tells them more '
            + 'than a billing error would.\n\n'
            + 'The worker re-asserts the permission when it builds its own context, so a '
            + 'revocation between accepting and running still bounces the import.',
        tags: TAGS,
        params: TenantParams,
        body: ImportFormSchema,
        bodyContentType: 'multipart/form-data',
        success: {
            status: 202,
            description: 'Accepted and enqueued. Poll the job for progress.',
            schema: z
                .object({ jobId: z.string() })
                .openapi('EvidenceImportAccepted', {
                    description:
                        'The queue id to poll. Nothing has been extracted yet when this '
                        + 'returns.',
                }),
        },
        extraResponses: rawErrorResponses({
            400: 'The BARE `{"error": "..."}` shape throughout this route: `file` missing '
                + 'or not a File, or the archive is empty.',
            403: '`evidence.upload` capability required — bare shape, no code.',
            413: 'The archive exceeds the 100 MB cap. Bare shape.',
            415: 'Not a `.zip` by extension, or a MIME type outside the accepted three. '
                + 'Bare shape.',
        }),
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/evidence/imports/{jobId}',
        operationId: 'getEvidenceImportJob',
        summary: 'Poll a staged import',
        description:
            'Built to be polled by the upload dialog so an operator can watch progress '
            + 'without waiting for completion.\n\n'
            + '**A job belonging to another farm answers the SAME 404 as one that does not '
            + 'exist.** The handler compares the job payload\'s `tenantId` against the '
            + 'request context and refuses on mismatch with an identical body, so job ids '
            + 'cannot be probed across tenants — the queue is global and its ids are not '
            + 'secret.\n\n'
            + 'Errors here are the BARE `{"error": "..."}` shape, including the 404, so '
            + 'there is no code distinguishing "wrong farm" from "no such job". That is '
            + 'the point.',
        tags: TAGS,
        params: TenantParams.extend({
            jobId: z.string().openapi({ description: 'From the import response.' }),
        }),
        success: {
            status: 200,
            description: 'The job\'s state, progress and — once completed — its counters.',
            schema: ImportJobSchema,
        },
        extraResponses: rawErrorResponses({
            403: '`evidence.upload` capability required. Bare shape.',
            404: 'No such job, OR the job belongs to another farm. Deliberately '
                + 'indistinguishable, and bare.',
        }),
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/evidence/files/{fileId}/download',
        operationId: 'downloadEvidenceFile',
        summary: 'Download an evidence file',
        description:
            'Serves the bytes — and **answers in one of two entirely different ways '
            + 'depending on the storage provider**, which a client must handle:\n\n'
            + '- **S3**: a **302** to a presigned URL. No body.\n'
            + '- **Local disk**: a **200** streaming the file, with `Content-Type`, '
            + '`Content-Length` and `Content-Disposition`.\n\n'
            + 'Both carry `X-Content-SHA256` — the digest of the STORED bytes, which for an '
            + 'image or a PDF is not the digest of what was uploaded, because the strippers '
            + 'rewrote it. Both are `Cache-Control: private`; the redirect adds `no-store` '
            + 'because a presigned URL is a bearer credential in a query string.\n\n'
            + '`Content-Disposition` keeps the real filename in RFC 6266 `filename*` with a '
            + 'TRANSLITERATED ASCII fallback. The sanitiser it replaced mapped every '
            + 'non-ASCII character to `_`, so «Фактура-2026.pdf» downloaded as '
            + '`_______-2026.pdf` and two invoices with different Cyrillic names downloaded '
            + 'under the SAME name.\n\n'
            + '**Three gates, and the second and third are evidence-specific:**\n\n'
            + '1. The file must be `STORED` — `FILE_NOT_DOWNLOADABLE` otherwise, which also '
            + 'covers a record whose upload never completed.\n'
            + '2. The AV verdict. `INFECTED` is always refused; `PENDING` is refused only '
            + 'in strict mode. This is a SECOND, inline implementation of the policy rather '
            + 'than the shared `isDownloadAllowed`, and both agree today — they refuse '
            + 'INFECTED and admit SKIPPED.\n'
            + '3. **Provenance.** A caller WITHOUT write permission may only download '
            + 'evidence attached to an asset or a task; unattached evidence is refused with '
            + 'a sentence telling them to ask an administrator to attach it. A writer skips '
            + 'this gate entirely.\n\n'
            + 'A soft-deleted evidence row answers `EVIDENCE_DELETED` even though the FILE '
            + 'is still stored — the record\'s state governs, not the object\'s.\n\n'
            + 'Every success writes an `EVIDENCE_DOWNLOADED` audit entry.',
        tags: TAGS,
        params: TenantParams.extend({
            fileId: z.string().openapi({
                description: 'A `FileRecord` id — `fileRecordId` on the evidence row, NOT the evidence id.',
            }),
        }),
        success: {
            status: 200,
            description:
                'The file bytes (local provider). An S3-backed deployment answers 302 '
                + 'instead, with no body.',
            content: {
                'application/octet-stream': z.string().openapi({
                    type: 'string',
                    format: 'binary',
                    description:
                        'The stored bytes. The real `Content-Type` is the file\'s own, not '
                        + 'this one — this media type is the spec\'s way of saying "opaque '
                        + 'bytes of whatever type the record carries".',
                }),
            },
        },
        extraResponses: {
            // Declared BY HAND, not through `codedErrorResponses`, which
            // attaches the JSON error envelope. A 302 carries no body — the
            // information is in `Location` — so a description-only entry is
            // the accurate one here. `helpers.ts` warns that a bodyless entry
            // tells a client nothing, and that warning is about ERROR statuses
            // whose codes a caller switches on; for a redirect, "no content"
            // is the contract.
            //
            // It is listed at all because `op()` describes a single success
            // status and this is the other half of the same operation: which
            // one you get depends on the deployment's storage provider, not
            // on anything the caller did.
            302: {
                description:
                    'S3 deployments only: a redirect to a presigned URL, with no body. '
                    + 'Carries `X-Content-SHA256` and `Cache-Control: private, no-cache, '
                    + 'no-store` — `no-store` because a presigned URL is a bearer '
                    + 'credential in a query string.',
            },
            ...codedErrorResponses({
            403: '`INFECTED` by the scanner; or `PENDING` under strict scanning; or the '
                + 'provenance rule above refused a non-writer. Three different sentences, '
                + 'all 403.',
            404: '`FILE_NOT_FOUND`, `FILE_NOT_DOWNLOADABLE` (not in STORED state) or '
                + '`EVIDENCE_DELETED` (the record was soft-deleted while the object '
                + 'remains).',
            }),
        },
    });
}
