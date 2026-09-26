/**
 * Journal — the БАБХ ДНЕВНИК entries, and the first surface a native client
 * consumes.
 *
 * Documented first for that reason: a second client is being written against
 * these routes now, and the four things most likely to be reproduced as bugs
 * are all here — the `Idempotency-Key` contract (#924), the `If-Match`
 * optimistic lock (#919/#920), the 409 body's nesting, and the fact that a
 * 409 is a conflict to resolve rather than a success (#921/#922).
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { CreateLogEntrySchema, UpdateLogEntrySchema } from '@/lib/schemas';
import { ApiErrorResponseSchema } from '@/lib/dto/common';
import { op } from './helpers';

// ZodObjects, because that is what the generator reads to build inline
// parameters — see the note on OperationInput.params.
const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});
const EntryParams = TenantParams.extend({
    id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
});

/**
 * The success shape is deliberately loose (`passthrough`) rather than absent.
 *
 * There is no LogEntry response DTO yet — only the two request components — so
 * a precise schema would have to be invented here, away from the usecase that
 * owns the shape, and would drift the moment a field changed. An honest
 * "an object with these known fields, plus more" beats either a lie or a
 * blank, and tightening it later is additive.
 */
const LogEntryLike = z
    .object({
        id: z.string(),
        type: z.string(),
        status: z.string(),
        title: z.string().nullable().optional(),
        occurredAt: z.string().nullable().optional(),
        version: z.number().int().optional(),
    })
    .passthrough()
    .openapi('LogEntry');

const StaleDataError = ApiErrorResponseSchema.openapi('StaleDataError', {
    description:
        'A 409 from the optimistic lock. `error.details.currentVersion` carries the version ' +
        'the server holds — read it from `error.details`, NOT from the body root. A client ' +
        'that treats this as success loses the operator’s edit (#921/#922).',
});

export function registerJournalPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/journal',
        operationId: 'listJournalEntries',
        summary: 'List journal entries',
        description:
            'Returns a FLAT array by default. With `limit` or `cursor` it returns ' +
            '`{ rows, nextCursor }` and carries a weak ETag (honours `If-None-Match` with 304). ' +
            'With `deleted=true` it returns `{ entries }` and escalates to an admin check. ' +
            'Three bodies on one operation — a client must branch on the query it sent.',
        tags: ['Journal'],
        params: TenantParams,
        success: {
            status: 200,
            description:
                'Entries, in one of THREE shapes — the query decides which, and a client that ' +
                'assumes one reads an absent key from another as an empty list rather than as ' +
                'an error.',
            schema: z.union([
                // `?deleted=…` — the recycle-bin view.
                z.object({ entries: z.array(LogEntryLike) }),
                // paged
                z.object({ rows: z.array(LogEntryLike), nextCursor: z.string().nullable() }),
                // the default: a bare array, ETagged
                z.array(LogEntryLike),
            ]),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/journal',
        operationId: 'createJournalEntry',
        summary: 'Create a journal entry',
        description:
            'Send `Idempotency-Key` ALWAYS, minted BEFORE the first attempt and reused on every ' +
            'retry of the same logical write. The server maps it to `clientMutationId` under a ' +
            'unique index and returns the ORIGINAL entry on a replay. Minting a fresh key on ' +
            'retry means a response lost after the server committed creates a SECOND record (#924).',
        tags: ['Journal'],
        params: TenantParams,
        body: CreateLogEntrySchema,
        success: { status: 201, description: 'The created entry, or the original one on a replay.', schema: LogEntryLike },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/journal/{id}',
        operationId: 'getJournalEntry',
        summary: 'Get one journal entry',
        tags: ['Journal'],
        params: EntryParams,
        success: {
            status: 200,
            description: 'The entry, plus a resolved `fieldOperation` link that is not on the bare model.',
            schema: LogEntryLike,
        },
    });

    for (const method of ['put', 'patch'] as const) {
        op(registry, {
            method,
            path: '/api/t/{tenantSlug}/journal/{id}',
            operationId: method === 'put' ? 'replaceJournalEntry' : 'updateJournalEntry',
            summary: method === 'put' ? 'Replace a journal entry' : 'Update a journal entry',
            description:
                'Send `If-Match: <version>` (digits only) AND `Idempotency-Key`. The version ' +
                'increment sits INSIDE the If-Match guard, so an unguarded write changes content ' +
                'without moving `version` and corrupts every later lock — treat If-Match as ' +
                'mandatory. `Idempotency-Key` also drives own-replay detection: a replay carrying ' +
                'the key of the write that already landed returns the existing entry instead of ' +
                'a 409 against your own success. ' +
                'PATCH and PUT are the SAME handler (`export const PATCH = PUT`).',
            tags: ['Journal'],
            params: EntryParams,
            body: UpdateLogEntrySchema,
            success: { status: 200, description: 'The updated entry.', schema: z.object({ success: z.literal(true), entry: LogEntryLike }) },
            extraResponses: {
                409: {
                    description: 'Optimistic-lock conflict — the entry moved on. Resolve it; do not treat it as success.',
                    content: { 'application/json': { schema: StaleDataError } },
                },
            },
        });
    }

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/journal/{id}',
        operationId: 'deleteJournalEntry',
        summary: 'Soft-delete a journal entry',
        description: 'Soft delete — the row survives and an admin can restore it via `restoreLogEntry`.',
        tags: ['Journal'],
        params: EntryParams,
        success: { status: 200, description: 'Deleted.', schema: z.object({ success: z.literal(true) }) },
    });

    // ── The entry's files, and its soft-delete lifecycle ──
    //
    // Three routes that complete the ДНЕВНИК surface. The register is a
    // LEGALLY FILED record, which is why delete is soft and purge is a separate,
    // explicit act rather than a harder DELETE on the same path.

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/journal/{id}/files',
        operationId: 'addJournalEntryFile',
        summary: 'Attach a photo or document to an entry',
        description:
            'ONE route, TWO request content types, and which one you send decides what happens:' +
            '\n\n**`multipart/form-data`** uploads the file, mints the FileRecord through the shared storage pipeline and links it — this is the photo-logging path from the field.' +
            '\n\n**`application/json`** attaches an ALREADY-uploaded FileRecord by id (`{ fileRecordId, caption? }`). Upload first, here or via `/evidence/uploads`, then reference the id.' +
            '\n\nRe-attaching a file that is already linked returns the EXISTING link rather than creating a second one, so a retry after a dropped connection does not double-attach a photo.',
        tags: ['Journal'],
        params: EntryParams,
        bodyContentType: 'multipart/form-data',
        body: z
            .object({
                file: z.string().openapi({ format: 'binary' }),
                caption: z.string().optional(),
            })
            .openapi('JournalFileUpload', {
                description:
                    'The multipart form. Send `application/json` with `{ fileRecordId, caption? }` instead to attach an already-stored file.',
            }),
        success: {
            status: 201,
            description: 'The link between the entry and the file.',
            schema: z
                .object({
                    id: z.string(),
                    tenantId: z.string(),
                    logEntryId: z.string(),
                    fileRecordId: z.string(),
                    caption: z.string().nullable(),
                    createdAt: z.string().datetime(),
                })
                .passthrough()
                .openapi('JournalFileLink', {
                    description:
                        'The LINK, not the file. An already-linked file returns its existing link, so this is idempotent per (entry, file).',
                }),
        },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/journal/{id}/files',
        operationId: 'removeJournalEntryFile',
        summary: 'Detach a file from an entry',
        description:
            'Takes `fileRecordId` as a QUERY parameter, not a path segment — the link is identified by the pair, and the file may be attached to more than one entry.' +
            '\n\n**The FileRecord SURVIVES.** Detaching unlinks; it does not delete. A photo taken in a field and attached to a legally-filed record is evidence, and removing it from one entry is not a reason to destroy it.',
        tags: ['Journal'],
        params: EntryParams,
        query: z.object({
            fileRecordId: z.string().openapi({ description: 'The file to unlink from this entry.' }),
        }),
        success: {
            status: 200,
            description: 'Detached. The file itself still exists.',
            schema: z.object({ success: z.boolean() }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/journal/{id}/restore',
        operationId: 'restoreJournalEntry',
        summary: 'Restore a soft-deleted entry',
        description:
            'Brings a soft-deleted entry back into the register. DELETE on an entry is soft precisely so this exists: the ДНЕВНИК is a filed record, and an operator deleting the wrong row must not be a permanent loss.',
        tags: ['Journal'],
        params: EntryParams,
        success: {
            status: 200,
            description: 'The restored entry.',
            schema: z.object({ id: z.string() }).passthrough().openapi('RestoredLogEntry', {
                description: 'The entry as it is once restored.',
            }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/journal/{id}/purge',
        operationId: 'purgeJournalEntry',
        summary: 'Permanently destroy a soft-deleted entry',
        description:
            'IRREVERSIBLE. This is the one that actually removes the row, and it is a SEPARATE route from DELETE on purpose — a register that can be emptied by the same verb that hides a row is not a register.' +
            '\n\nThere is no restore after this. A client should treat it as a distinct, confirmed action rather than as the second half of a delete flow.',
        tags: ['Journal'],
        params: EntryParams,
        success: {
            status: 200,
            description: 'Purged. Nothing to restore.',
            schema: z.object({ success: z.boolean(), purged: z.boolean() }),
        },
    });
}
