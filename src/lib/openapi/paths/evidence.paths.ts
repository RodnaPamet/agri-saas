/**
 * The evidence register — the farm's document library (#3080).
 *
 * FOURTEEN operations over ten paths: the tenant-scoped register, and the
 * three UNPREFIXED legacy routes that mirror it. Retention (expiry sweeps,
 * `restore`/`purge`, the per-record retention write) and the byte-handling
 * routes (`uploads`, `imports`, the file download) are deliberately NOT here
 * — they are their own families with their own hazards, and they stay
 * baselined until described rather than being half-covered from this module.
 *
 * Three things are contract rather than formatting.
 *
 * ── `/api/evidence` IS NOT `/api/t/{tenantSlug}/evidence` ──
 *
 * The three unprefixed routes resolve the farm from the session's
 * backward-compat `tenantId` claim, which is **the user's OLDEST membership**
 * — not the farm they are looking at. For anybody in two farms they read and
 * WRITE somewhere other than where the caller thinks. Prefer the slug-ful
 * route for everything; the legacy three are described so a client can
 * recognise them, not so it can use them. See #3277, which is the same
 * scoping reaching the notification bell, where it IS live.
 *
 * ── Two operations carry two permission tiers each ──
 *
 * `POST /{id}/review` needs WRITE to submit and ADMIN to approve or reject,
 * so the same endpoint answers 403 or not depending on the BODY. And
 * `GET /evidence` needs ADMIN once `includeDeleted=true` is sent. Neither is
 * discoverable from the path, which is why both are stated on the operation.
 *
 * ── `APPROVED` is terminal ──
 *
 * The transition table has no entry for it, so every action from APPROVED is
 * a 400. Only the retention sweep moves a record out, by setting
 * `NEEDS_REVIEW`, and from there it can be re-submitted. A client offering an
 * "un-approve" control has nothing to call.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import {
    CreateEvidenceSchema,
    UpdateEvidenceSchema,
    EvidenceReviewSchema,
    BulkDeleteEvidenceSchema,
} from '@/lib/schemas';
import { codedErrorResponses, op } from './helpers';

const TAGS = ['Evidence'];

const EVIDENCE_404 =
    '`EVIDENCE_NOT_FOUND` — no such record on this farm. An id belonging to a '
    + 'DIFFERENT tenant answers identically, so the register cannot be '
    + 'enumerated one id at a time.';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ description: 'The farm whose register this is.' }),
});

const EvidenceParams = TenantParams.extend({
    id: z.string().openapi({ description: 'The evidence record id.' }),
});

const LegacyEvidenceParams = z.object({
    id: z.string().openapi({ description: 'The evidence record id.' }),
});

// ─── Query ───

const EvidenceFilterQuery = z.object({
    type: z.string().optional().openapi({
        description:
            'Comma-separated `EvidenceType` members — `FILE`, `LINK`, `TEXT`. '
            + 'Comma-joined, NOT repeated: `?type=FILE,LINK`. Reading it as a scalar is '
            + 'what once let the literal string `"FILE,LINK"` reach Prisma as an enum '
            + 'equality, where it matched nothing and the library reported itself empty.',
        example: 'FILE,LINK',
    }),
    status: z.string().optional().openapi({
        description:
            'Comma-separated `EvidenceStatus`: `DRAFT`, `SUBMITTED`, `APPROVED`, '
            + '`REJECTED`, `NEEDS_REVIEW`.',
        example: 'SUBMITTED,NEEDS_REVIEW',
    }),
    folder: z.string().optional().openapi({
        description:
            'Exact-match folder label, with ONE sentinel: `__none__` selects records '
            + 'whose folder is null or empty. Omitted means no folder filter at all, '
            + 'which is a third state — do not send `__none__` to mean "any".',
        example: '__none__',
    }),
    q: z.string().optional().openapi({ description: 'Case-insensitive substring search.' }),
    archived: z.enum(['true', 'false']).optional().openapi({
        description:
            'Three states, and the absent one is not `false`: omitted means archived and '
            + 'live records alike, `false` means live only, `true` means archived only.',
    }),
    expiring: z.enum(['true', 'false']).optional().openapi({
        description:
            'Only `true` does anything. `false` and absent are the same request, because '
            + 'the handler reads this as `=== \'true\'` — so there is no way to ask for '
            + '"not expiring".',
    }),
});

const EvidenceListQuery = EvidenceFilterQuery.extend({
    limit: z.coerce.number().int().min(1).max(100).optional().openapi({
        description:
            'Page size. PRESENCE of this or `cursor` switches the response to the '
            + 'paginated envelope. Clamped to 1–100; absent means 20 once paginating.',
    }),
    cursor: z.string().optional().openapi({
        description:
            'Opaque forward cursor from `pageInfo.nextCursor`. A stale or malformed '
            + 'cursor restarts the listing rather than erroring.',
    }),
    includeDeleted: z.enum(['true', 'false']).optional().openapi({
        description:
            'Include soft-deleted rows. **ADMIN**, unlike the rest of this operation, '
            + 'which needs only READ — so a plain READER sending it gets a 403 rather '
            + 'than a narrower list.\n\n'
            + 'An ordinary filter that composes with everything here. It was an early '
            + 'return that discarded every other parameter until #3272, so a client '
            + 'written against the old behaviour may be sending it alone and filtering '
            + 'locally; that still works.',
    }),
});

// ─── Row shapes ───

/**
 * The list row — a DELIBERATELY NARROW projection, not the stored record.
 *
 * `GET /{id}` returns the full row; this is the subset the register table
 * needs. Several fields here were added because they were missing rather than
 * because the table renders them, so do not read the set as "what a list
 * needs" — `content` in particular carries the URL for LINK evidence and was
 * unselected for long enough that the deep link back to a journal entry
 * existed in the database and was unreachable from every list surface.
 */
const EvidenceListRowSchema = z
    .object({
        id: z.string(),
        title: z.string(),
        fileName: z.string().nullable().openapi({
            description: 'Set for FILE evidence; null for LINK and TEXT.',
        }),
        type: z.enum(['FILE', 'LINK', 'TEXT']),
        status: z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'NEEDS_REVIEW']).openapi({
            description:
                '`NEEDS_REVIEW` is written by the retention sweep, never by a caller — it '
                + 'is how an APPROVED record becomes movable again. See the review '
                + 'operation.',
        }),
        owner: z.string().nullable().openapi({
            description: 'FREE TEXT owner. The structured one is `ownerUserId`.',
        }),
        ownerUserId: z.string().nullable().openapi({
            description:
                'The responsible person, as a `User` id. Review notifications route on '
                + 'THIS and not on `owner`, so a record with only the free-text field '
                + 'notifies nobody.',
        }),
        folder: z.string().nullable().openapi({
            description:
                'An operator-chosen label, flat rather than a path — there is no nesting '
                + 'and no folder entity. Null and empty mean the same thing, which is why '
                + 'the filter needs a `__none__` sentinel.',
        }),
        isArchived: z.boolean().openapi({
            description:
                'Archived is NOT deleted and NOT a status. It is a separate boolean, so an '
                + 'archived record keeps whatever `status` it had.',
        }),
        expiredAt: z.string().datetime().nullable(),
        deletedAt: z.string().datetime().nullable().openapi({
            description:
                'Non-null only on an `includeDeleted=true` read. Soft-deleted records are '
                + 'invisible to every other operation here, `GET /{id}` included.',
        }),
        retentionUntil: z.string().datetime().nullable(),
        dateCollected: z.string().datetime().nullable(),
        content: z.string().nullable().openapi({
            description:
                'For LINK evidence this is the URL. For TEXT it is the body. Null for '
                + 'FILE, where the bytes live behind the download route instead.',
        }),
        category: z.string().nullable(),
        fileRecordId: z.string().nullable(),
        fileRecord: z
            .object({ id: z.string(), mimeType: z.string().nullable() })
            .nullable()
            .openapi({
                description:
                    'Present for FILE evidence. The `mimeType` is the RECONCILED one — the '
                    + 'ingest path checks the declared type against the bytes — so it is '
                    + 'safe to branch rendering on.',
            }),
        createdAt: z.string().datetime().openapi({
            description:
                'Required by the cursor helper rather than by the table, and part of the '
                + 'contract for that reason: it is what the keyset orders on.',
        }),
        updatedAt: z.string().datetime(),
    })
    .openapi('EvidenceListRow');

const EvidenceCappedListSchema = z
    .object({
        rows: z.array(EvidenceListRowSchema),
        truncated: z.boolean().openapi({
            description:
                'TRUE when the register holds more than 5,000 matching records and this '
                + 'response was cut to the first 5,000. A real flag rather than a silent '
                + 'cut, which is what the sibling asset list does NOT have — there the '
                + 'only signal is comparing the array length against a separate count '
                + 'endpoint.',
        }),
    })
    .openapi('EvidenceCappedList');

const EvidencePageSchema = z
    .object({
        items: z.array(EvidenceListRowSchema),
        pageInfo: z
            .object({
                nextCursor: z.string().nullable(),
                hasNextPage: z.boolean(),
            })
            .openapi('EvidencePageInfo'),
    })
    .openapi('EvidencePage');

/**
 * The stored record, as `GET /{id}` returns it.
 *
 * Declared as the list row plus the fields the narrow projection drops, so
 * the two cannot drift into describing different columns.
 */
const EvidenceSchema = EvidenceListRowSchema.extend({
    tenantId: z.string(),
    description: z.string().nullable(),
    reviewCycle: z.string().nullable().openapi({
        description:
            'A cadence label. It had NO reader anywhere for a while — setting "review '
            + 'quarterly" scheduled nothing — and the reader is now the APPROVED '
            + 'transition, which is what advances `nextReviewDate` from it.',
    }),
    nextReviewDate: z.string().datetime().nullable().openapi({
        description:
            'Advanced by an APPROVED review, from `reviewCycle`. Approving is the event '
            + 'that means a person looked, which is what the interval measures from; '
            + 'nothing else moves it, so a record with no cadence keeps whatever date it '
            + 'was given.',
    }),
    taskId: z.string().nullable(),
    assetId: z.string().nullable(),
}).openapi('Evidence');

const EvidenceReviewRecordSchema = z
    .object({
        id: z.string(),
        evidenceId: z.string(),
        status: z.enum(['SUBMITTED', 'APPROVED', 'REJECTED']),
        comment: z.string().nullable(),
        createdAt: z.string().datetime(),
    })
    .openapi('EvidenceReviewRecord');

const EvidenceMetricsSchema = z
    .object({
        totalEvidence: z.number().int().openapi({
            description: 'Live records — soft-deleted ones are excluded.',
        }),
        fileEvidence: z.number().int().openapi({ description: 'Of those, type FILE.' }),
        storedFileCount: z.number().int().openapi({
            description:
                'FileRecords in `STORED` state, which is NOT the same number as '
                + '`fileEvidence`: a record whose upload failed or is still scanning has '
                + 'evidence and no stored file, and the two counts drifting apart is the '
                + 'signal this endpoint exists to show.',
        }),
        totalBytesStored: z.number().int().openapi({
            description: 'Sum of `sizeBytes` over STORED files. Use this one.',
        }),
        totalBytesFormatted: z.string().openapi({
            description:
                'A server-composed ENGLISH string — `"1.5 MB"`, or KB under a megabyte, '
                + 'one decimal place. It is not localised and does not honour the '
                + 'reader\'s language, so **prefer `totalBytesStored` and format it '
                + 'client-side**; a Bulgarian UI rendering this shows English units. It '
                + 'is documented rather than quietly omitted because it exists and '
                + 'something may already read it.',
        }),
    })
    .openapi('EvidenceMetrics');

const EvidenceUpdateResultSchema = z
    .object({ success: z.literal(true), evidence: EvidenceSchema })
    .openapi('EvidenceUpdateResult');

const EvidenceBulkDeleteResultSchema = z
    .object({
        deleted: z.number().int().openapi({
            description:
                'How many records this call soft-deleted. May be LOWER than the ids sent — '
                + 'ids that do not exist, belong to another farm, or were already deleted '
                + 'are skipped rather than refused. Zero is a successful no-op.',
        }),
    })
    .openapi('EvidenceBulkDeleteResult');

const REVIEW_DESCRIPTION =
    'Moves a record through its lifecycle. ONE endpoint, TWO permission tiers: '
    + '`SUBMITTED` needs WRITE, while `APPROVED` and `REJECTED` need ADMIN — so '
    + 'whether this operation answers 403 depends on the BODY, not the path.\n\n'
    + '**The legal transitions are a closed table, checked before any write:**\n\n'
    + '- `DRAFT` → `SUBMITTED`\n'
    + '- `REJECTED` → `SUBMITTED`\n'
    + '- `NEEDS_REVIEW` → `SUBMITTED`\n'
    + '- `SUBMITTED` → `APPROVED` or `REJECTED`\n\n'
    + '**`APPROVED` is TERMINAL.** It has no row in that table, so every action from '
    + 'it is a 400. A record leaves APPROVED only when the retention sweep sets '
    + '`NEEDS_REVIEW`, and from there it can be re-submitted. A client offering an '
    + '"un-approve" control has nothing to call.\n\n'
    + 'An illegal transition is a 400 whose message NAMES the legal next states, and '
    + 'it is uncoded — there is no `error.code` to switch on, so read the status and '
    + 'the current record rather than parsing the sentence.\n\n'
    + 'An APPROVED review also advances `nextReviewDate` from `reviewCycle`, because '
    + 'approving is the event that means a person looked.';

export function registerEvidencePaths(registry: OpenAPIRegistry): void {
    // ── The register ──

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/evidence',
        operationId: 'listEvidence',
        summary: 'List the evidence register',
        description:
            'The farm\'s document library.\n\n'
            + '**Two envelopes over one row shape**, chosen by whether pagination '
            + 'parameters are present:\n\n'
            + '1. **No `limit` and no `cursor`** → `EvidenceCappedList` '
            + '(`{rows, truncated}`), newest first, cut at 5,000 with `truncated: true` '
            + 'saying so.\n\n'
            + '2. **`limit` or `cursor` present** → `EvidencePage` '
            + '(`{items, pageInfo}`) over the same row.\n\n'
            + 'Note neither is a bare array, which the sibling asset list does return — '
            + 'do not assume one shape across the two registers.\n\n'
            + 'This operation carries TWO permission tiers: READ, and **ADMIN** as soon '
            + 'as `includeDeleted=true` is sent.',
        tags: TAGS,
        params: TenantParams,
        query: EvidenceListQuery,
        success: {
            status: 200,
            description:
                '`EvidenceCappedList` with no pagination parameters, `EvidencePage` with '
                + 'them.',
            schema: z.union([EvidenceCappedListSchema, EvidencePageSchema]),
        },
        extraResponses: codedErrorResponses({
            400: 'A facet carried a member that is not in its enum, or `limit` is out of '
                + 'range.',
            403: 'Not permitted to read this farm — or `includeDeleted=true` was sent by a '
                + 'non-ADMIN member, which is the same status for a different reason.',
        }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/evidence',
        operationId: 'createEvidence',
        summary: 'Add a record to the register',
        description:
            'Creates a LINK or TEXT record. **FILE evidence does not come through here** '
            + '— bytes go to the multipart `/evidence/uploads` route, which allowlists, '
            + 'stores and SCANS them. A record created here with `type: FILE` would have '
            + 'no stored file behind it.',
        tags: TAGS,
        params: TenantParams,
        body: CreateEvidenceSchema,
        success: { status: 201, description: 'Created.', schema: EvidenceSchema },
        extraResponses: codedErrorResponses({
            400: 'Missing a required field, or an unknown `type` / `status`.',
            403: 'Read-only on this farm.',
        }),
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/evidence/metrics',
        operationId: 'getEvidenceMetrics',
        summary: 'Register and storage counts',
        description:
            'ADMIN only. Counts over the WHOLE register, unfiltered — this takes none of '
            + 'the list facets, so it cannot describe a filtered view the way the asset '
            + 'KPI endpoint can.\n\n'
            + 'Read `storedFileCount` against `fileEvidence`: they are different '
            + 'questions and a gap between them means uploads that never landed.',
        tags: TAGS,
        params: TenantParams,
        success: { status: 200, description: 'The counts.', schema: EvidenceMetricsSchema },
        extraResponses: codedErrorResponses({ 403: 'Not an administrator of this farm.' }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/evidence/bulk/delete',
        operationId: 'bulkDeleteEvidence',
        summary: 'Soft-delete up to 100 records',
        description:
            'ADMIN. SOFT delete, so the rows survive and stay reachable through '
            + '`?includeDeleted=true`.\n\n'
            + 'PARTIAL SUCCESS is normal and not an error: ids that do not exist, belong '
            + 'to another farm, or were already deleted are skipped, and `deleted` is how '
            + 'many rows actually moved. The response does not NAME the skipped ids, '
            + 'deliberately — naming one as absent would answer a question about another '
            + 'farm\'s register.',
        tags: TAGS,
        params: TenantParams,
        body: BulkDeleteEvidenceSchema,
        success: {
            status: 200,
            description: 'The number soft-deleted. Zero is a successful no-op.',
            schema: EvidenceBulkDeleteResultSchema,
        },
        extraResponses: codedErrorResponses({
            400: '`evidenceIds` was empty, missing, or longer than 100.',
            403: 'Not an administrator of this farm.',
        }),
    });

    // ── One record ──

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/evidence/{id}',
        operationId: 'getEvidence',
        summary: 'Read one record',
        description:
            'The FULL stored record, wider than the list projection. Soft-deleted '
            + 'records are NOT visible here — a deleted id answers 404 exactly as a '
            + 'nonexistent one does.',
        tags: TAGS,
        params: EvidenceParams,
        success: { status: 200, description: 'The record.', schema: EvidenceSchema },
        extraResponses: codedErrorResponses({ 404: EVIDENCE_404 }),
    });

    op(registry, {
        method: 'put',
        path: '/api/t/{tenantSlug}/evidence/{id}',
        operationId: 'updateEvidence',
        summary: 'Update a record',
        description:
            'Despite the verb this is a PARTIAL update: every field in the body is '
            + 'optional and only the fields present are written, so a `PUT` with a short '
            + 'body does NOT clear the rest.\n\n'
            + '`folder` is three-state and the distinction is load-bearing: omit it to '
            + 'leave the folder alone, send `null` to clear it, send a string to set it. '
            + 'There is no PATCH on this path.',
        tags: TAGS,
        params: EvidenceParams,
        body: UpdateEvidenceSchema,
        success: {
            status: 200,
            description: 'Updated. `evidence` is the stored record after the write.',
            schema: EvidenceUpdateResultSchema,
        },
        extraResponses: codedErrorResponses({
            400: 'An unknown enum member, or a malformed date.',
            404: EVIDENCE_404,
        }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/evidence/{id}/review',
        operationId: 'reviewEvidence',
        summary: 'Submit, approve or reject a record',
        description: REVIEW_DESCRIPTION,
        tags: TAGS,
        params: EvidenceParams,
        body: EvidenceReviewSchema,
        success: {
            status: 200,
            description: 'The review that was recorded.',
            schema: EvidenceReviewRecordSchema,
        },
        extraResponses: codedErrorResponses({
            400: 'An unknown `action`, or an ILLEGAL transition from the record\'s '
                + 'current status. Uncoded: the message names the legal next states.',
            403: 'WRITE is required to submit and ADMIN to approve or reject, so this '
                + 'depends on the body as well as the role.',
            404: EVIDENCE_404,
        }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/evidence/{id}/archive',
        operationId: 'archiveEvidence',
        summary: 'Archive a record',
        description:
            'Sets `isArchived`. Archiving is NOT deleting and NOT a status change — the '
            + 'record keeps whatever `status` it had, and an archived record is still '
            + 'readable, still counted by `/metrics`, and still returned by the list '
            + 'unless `archived=false` is sent.\n\n'
            + '**IDEMPOTENT**: archiving an already-archived record is a 200 returning '
            + 'the row unchanged, not a 409. So a client may retry without checking '
            + 'first, and cannot tell from the response whether it was the one that '
            + 'archived it.',
        tags: TAGS,
        params: EvidenceParams,
        success: {
            status: 200,
            description: 'The record, archived.',
            schema: EvidenceSchema,
        },
        extraResponses: codedErrorResponses({
            403: 'Read-only on this farm.',
            404: EVIDENCE_404,
        }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/evidence/{id}/unarchive',
        operationId: 'unarchiveEvidence',
        summary: 'Return a record from the archive',
        description:
            'Clears `isArchived`, and is idempotent in the same way its sibling is: '
            + 'unarchiving a live record is a 200 returning the row unchanged.',
        tags: TAGS,
        params: EvidenceParams,
        success: {
            status: 200,
            description: 'The record, unarchived.',
            schema: EvidenceSchema,
        },
        extraResponses: codedErrorResponses({
            403: 'Read-only on this farm.',
            404: EVIDENCE_404,
        }),
    });

    // ── The legacy, slug-less surface ──

    /**
     * Described so a client can RECOGNISE these, not so it can use them.
     */
    const LEGACY_WARNING =
        '**PREFER `/api/t/{tenantSlug}/evidence…`.** This route takes no farm and '
        + 'resolves one from the session\'s backward-compat `tenantId` claim, which is '
        + 'the caller\'s **OLDEST membership** by `createdAt` — not the farm they are '
        + 'looking at, and not a farm they chose. For anybody who belongs to two farms '
        + 'it therefore reads, and on the write operations WRITES, somewhere other than '
        + 'where the caller means.\n\n'
        + 'It is not dead code and not unguarded: the resolver carries the MFA '
        + 'second-factor check and refuses the MECHANISATOR persona, both added because '
        + 'slug-less routes escape the Edge gates that key on the slug. The farm '
        + 'SELECTION is the part nobody revisited. #3277 tracks the same scoping where '
        + 'it is live — the notification bell.';

    op(registry, {
        method: 'get',
        path: '/api/evidence',
        operationId: 'listEvidenceLegacy',
        summary: 'List the register (legacy, no farm in the path)',
        description:
            LEGACY_WARNING
            + '\n\nIt also takes NO query parameters — no filters, no search, no '
            + 'pagination — and returns a BARE ARRAY rather than either envelope the '
            + 'tenant-scoped route serves. Three response shapes across two routes for '
            + 'one register.',
        tags: TAGS,
        success: {
            status: 200,
            description: 'A bare array of list rows, newest first.',
            schema: z.array(EvidenceListRowSchema),
        },
        extraResponses: codedErrorResponses({
            403: '`OPERATOR_SCOPE` — a machine operator may not use the slug-less '
                + 'routes at all, because the persona\'s confinement lives at the Edge '
                + 'and keys on a slug this path does not have.',
        }),
    });

    op(registry, {
        method: 'post',
        path: '/api/evidence',
        operationId: 'createEvidenceLegacy',
        summary: 'Add a record (legacy, no farm in the path)',
        description:
            LEGACY_WARNING
            + '\n\nThis is the one to avoid most firmly: it FILES A RECORD against the '
            + 'oldest farm, and a compliance document in the wrong farm\'s register is '
            + 'not a wrong answer a user can see.',
        tags: TAGS,
        body: CreateEvidenceSchema,
        success: { status: 201, description: 'Created.', schema: EvidenceSchema },
        extraResponses: codedErrorResponses({
            400: 'Missing a required field, or an unknown enum member.',
            403: 'Read-only on the resolved farm, or `OPERATOR_SCOPE`.',
        }),
    });

    op(registry, {
        method: 'get',
        path: '/api/evidence/{id}',
        operationId: 'getEvidenceLegacy',
        summary: 'Read one record (legacy, no farm in the path)',
        description:
            LEGACY_WARNING
            + '\n\nThe id is looked up WITHIN the resolved farm, so the same id answers '
            + '404 here and 200 on the slug-ful route when the caller\'s oldest '
            + 'membership is not the farm holding it.',
        tags: TAGS,
        params: LegacyEvidenceParams,
        success: { status: 200, description: 'The record.', schema: EvidenceSchema },
        extraResponses: codedErrorResponses({
            403: '`OPERATOR_SCOPE`.',
            404: EVIDENCE_404,
        }),
    });

    op(registry, {
        method: 'put',
        path: '/api/evidence/{id}',
        operationId: 'updateEvidenceLegacy',
        summary: 'Update a record (legacy, no farm in the path)',
        description: LEGACY_WARNING + '\n\nPartial-update semantics, as on the slug-ful route.',
        tags: TAGS,
        params: LegacyEvidenceParams,
        body: UpdateEvidenceSchema,
        success: {
            status: 200,
            description: 'Updated.',
            schema: EvidenceUpdateResultSchema,
        },
        extraResponses: codedErrorResponses({
            400: 'An unknown enum member, or a malformed date.',
            403: 'Read-only on the resolved farm, or `OPERATOR_SCOPE`.',
            404: EVIDENCE_404,
        }),
    });

    op(registry, {
        method: 'post',
        path: '/api/evidence/{id}/review',
        operationId: 'reviewEvidenceLegacy',
        summary: 'Submit, approve or reject (legacy, no farm in the path)',
        description:
            LEGACY_WARNING
            + '\n\nSame state machine and the same two permission tiers as the slug-ful '
            + 'route, with one difference in the response: this one answers **201**, '
            + 'where its tenant-scoped twin answers 200. Same work, two statuses.\n\n'
            + REVIEW_DESCRIPTION,
        tags: TAGS,
        params: LegacyEvidenceParams,
        body: EvidenceReviewSchema,
        success: {
            status: 201,
            description: 'The review that was recorded. Note 201, not 200.',
            schema: EvidenceReviewRecordSchema,
        },
        extraResponses: codedErrorResponses({
            400: 'An unknown `action`, or an illegal transition. Uncoded.',
            403: 'WRITE to submit, ADMIN to approve or reject — or `OPERATOR_SCOPE`.',
            404: EVIDENCE_404,
        }),
    });
}
