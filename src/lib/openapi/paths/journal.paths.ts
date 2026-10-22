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
import {
    CreateLogEntrySchema,
    UpdateLogEntrySchema,
    RecordDiaryTreatmentSchema,
} from '@/lib/schemas';
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
/**
 * The fields shared by the plain row and the folded one, as a SHAPE rather
 * than a schema.
 *
 * Two schemas are built from this literal instead of one extending the other,
 * and that is forced by what `.extend()` on a REGISTERED schema emits:
 * `allOf: [{ $ref: LogEntry }, { treatment }]`. A reader that does not resolve
 * `allOf` then sees a row with no `id`, `type` or `status` at all — the
 * repo's own breaking-change gate reported exactly that, 38 properties
 * "removed" across the shapes, and a client codegen would make the same
 * mistake. Sharing the shape keeps both schemas flat and self-contained while
 * still having one place to change a field.
 */
const logEntryShape = {
    id: z.string(),
    type: z.string(),
    status: z.string(),
    title: z.string().nullable().optional(),
    occurredAt: z.string().datetime().nullable().optional(),
    version: z.number().int().optional(),
};

const LogEntryLike = z.object(logEntryShape).passthrough().openapi('LogEntry');

/**
 * The folded treatment a ДНЕВНИК row stands for (#1740, documented by #1832).
 *
 * ## Why this was missing, and what it cost
 *
 * `LogEntry` published six properties and the fold shipped without following.
 * Two clients read this object anyway — the web's «Изтегли дневник (PDF)»
 * button and agrent-ios #321's entry screen both take `treatmentGroupId` from
 * the row — so they agreed with the server by having read its source, not its
 * spec. A reader of `LogEntry` would have concluded the fold was not shipped.
 *
 * Declared flat rather than as `LogEntry` plus this field: see the note on
 * `logEntryShape` for why a `$ref` inside `allOf` is the wrong shape here.
 *
 * ## Which response carries it
 *
 * ONLY the paged `{ rows, nextCursor }` shape. `JournalRepository.listPaginated`
 * is the single method that attaches it; the bare-array default
 * (`listLogEntries`) and the `?deleted=` trash view (`listDeletedLogEntries`)
 * do not. That is why this extends the row type for one branch of the union
 * rather than being added to `LogEntry` itself — on the other two shapes the
 * field genuinely is not there, and declaring it would be the same kind of lie
 * in the other direction.
 *
 * ## Always present, including on a manual entry
 *
 * `parcelCount: 0` is how a free-hand entry reads, NOT an absent object. A
 * client testing the object's truthiness therefore treats every row as a
 * treatment; `parcelCount > 0` is the discriminator, and it is what the web
 * gates the PDF button on, because the per-treatment PDF route answers 404
 * `TREATMENT_NOT_FOUND` for a treatment with no lines.
 *
 * `completedCount` and `complete` are deliberately NOT here: they belong to
 * `GET /journal/treatments/{treatmentGroupId}`, and documenting them on the
 * row would invite a client to look for fields it will never receive.
 */
const Treatment = z
    .object({
        treatmentGroupId: z.string(),
        occurredOn: z
            .string()
            .openapi({
                description:
                    'The day the work happened as the FARM sees it (`YYYY-MM-DD`, Europe/Sofia), ' +
                    'not a UTC slice of `occurredAt`. For a free-hand entry typed between 00:00 ' +
                    'and 03:00 in Sofia those two differ by a day.',
                example: '2026-03-09',
            }),
        mayDelete: z.boolean().openapi({
            description:
                'Whether THIS caller may withdraw this treatment — computed server-side so a ' +
                'client can offer «Изтрий» only where pressing it would succeed. It is not a ' +
                '`createdByUserId` field, deliberately: the rule is creator-or-admin AND single ' +
                'authorship, and the second arm refuses admins too, so no field on one row can ' +
                'express it. False on an ordinary manual entry, which has no treatment to ' +
                'withdraw. Advisory, not the control: the route re-checks and answers 403 ' +
                '`TREATMENT_DELETE_NOT_PERMITTED` or 409 `TREATMENT_MIXED_AUTHORSHIP`.',
        }),
        kind: z.string().nullable().openapi({ description: '`SPRAY` or `FERTILIZE`.' }),
        productName: z.string().nullable(),
        parcelCount: z.number().int().openapi({
            description: '0 on an ordinary manual entry. The discriminator for "is this a treatment".',
        }),
        totalAreaHa: z.number().openapi({
            description: 'HECTARES, as stored. The web renders decares; the conversion belongs where the number is shown.',
        }),
        blockNames: z.array(z.string()),
        doseValue: z.number().nullable(),
        doseUnit: z.string().nullable().openapi({ description: 'The unit SYMBOL, not its id.' }),
        targetNote: z.string().nullable(),
        applicationTechnique: z.string().nullable(),
        phenophase: z.string().nullable().openapi({
            description:
                'Фенофаза/BBCH as captured on the line (#2072). No product fallback — a growth stage is an observation of the crop on a day, so null means not captured and nothing else can supply it. Not printed in the ХИМИЧНИ ОБРАБОТКИ table, which has no such column.',
        }),
        quarantinePeriodDays: z.number().int().nullable().openapi({
            description: "The line's own period, falling back to the product's.",
        }),
        earliestHarvestOn: z.string().nullable().openapi({
            description:
                'Computed server-side from the period that applied ON THE DAY, so every client ' +
                'shows the same date and it matches the PDF. Null when no period was captured — ' +
                'never the treatment day itself, which would read as "harvest today".',
            example: '2026-03-30',
        }),
        recordedInDiary: z.boolean(),
    })
    .openapi('Treatment');

/**
 * A row of the PAGED journal list: an entry plus its folded treatment.
 *
 * Separate from `LogEntry` because only this branch of the union carries
 * `treatment` — see the note on `Treatment`.
 */
const JournalFoldedRow = z
    .object({ ...logEntryShape, treatment: Treatment })
    .passthrough()
    .openapi('JournalFoldedRow');

const StaleDataError = ApiErrorResponseSchema.openapi('StaleDataError', {
    description:
        'A 409 `STALE_DATA` from the optimistic lock. `error.details.currentVersion` carries ' +
        'the version the server holds — read it from `error.details`, NOT from the body root. ' +
        'A client that treats this as success loses the operator’s edit (#921/#922).' +
        '\n\nThe code is named here because this response had the only 409 in the spec that ' +
        'did not name one (#1391). It explained the semantics and the field to read, and never ' +
        'wrote the literal a client switches on — so the only `code` value visible was this ' +
        'schema\'s inherited `example: "NOT_FOUND"`, which is a plausible thing to code against ' +
        'and wrong. Four sibling 409s already name theirs in prose exactly like this: see ' +
        '`FarmProfileStaleDataError`, `OperationParcelStaleDataError` and `ItemNameConflictError`.',
});

/**
 * The journal list's query contract, mirroring `JournalQuerySchema` in
 * `src/app/api/t/[tenantSlug]/journal/route.ts`.
 *
 * It was undocumented: the operation published only `tenantSlug`, so a client
 * reading the spec saw a list endpoint with no way to filter it, while eleven
 * parameters were live. That is the direction that costs a client release —
 * agrent-ios had to read the route source to find `locationId`.
 *
 * Kept as prose descriptions rather than a shared schema import because the
 * route's object is `.strip()`ed and carries coercions (`z.coerce.number`,
 * `csvEnumField`) whose INPUT shape is a string — documenting the parsed type
 * would describe what the handler receives, not what a client sends.
 */
const JournalListQuery = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional().openapi({
        param: { name: 'limit', in: 'query' },
        description:
            'Page size, 1-100. Sending EITHER `limit` or `cursor` switches the response from a ' +
            'flat array to `{ rows, nextCursor }` — see the operation description.',
    }),
    cursor: z.string().optional().openapi({
        param: { name: 'cursor', in: 'query' },
        description:
            'Opaque keyset cursor from a previous `nextCursor`. A position, not a timestamp to ' +
            'parse or construct: a client that builds its own has coupled itself to the sort key.',
    }),
    type: z.string().optional().openapi({
        param: { name: 'type', in: 'query' },
        description:
            'Comma-separated `LogEntryType` members, e.g. `INPUT_APPLICATION,HARVEST`. An ' +
            'invalid member is a 400 rather than a silent drop. Omit the parameter to clear the ' +
            'facet — an empty value matches nothing.',
    }),
    status: z.string().optional().openapi({
        param: { name: 'status', in: 'query' },
        description: 'Comma-separated `LogEntryStatus` members. Same rules as `type`.',
    }),
    q: z.string().optional().openapi({
        param: { name: 'q', in: 'query' },
        description: 'Case-insensitive substring search over `title` and `notes`.',
    }),
    occurredFrom: z.string().optional().openapi({
        param: { name: 'occurredFrom', in: 'query' },
        description: 'Inclusive lower bound on `occurredAt`. Either bound may be sent alone.',
    }),
    occurredTo: z.string().optional().openapi({
        param: { name: 'occurredTo', in: 'query' },
        description: 'Inclusive upper bound on `occurredAt`.',
    }),
    deleted: z.enum(['true', 'false']).optional().openapi({
        param: { name: 'deleted', in: 'query' },
        description:
            'The recycle bin — soft-deleted entries ONLY, never mixed with live ones. Escalates ' +
            'to an admin check and returns `{ entries }`, a third response shape.',
    }),
    crop: z.string().optional().openapi({
        param: { name: 'crop', in: 'query' },
        description:
            'Comma-separated `Parcel.cropType` values. Matches through the entry\'s operation ' +
            'LINE, so a free-hand entry with no line never matches — the intended ' +
            'agronomic-only scope, not an omission.',
    }),
    locationId: z.string().optional().openapi({
        param: { name: 'locationId', in: 'query' },
        description:
            'A «блок» — the `Location` a shapefile import creates. Matches an entry reached by ' +
            'EITHER path: one a person linked to the block explicitly, or one whose operation ' +
            'line sits on a parcel belonging to it. The second path is where the bulk of a ' +
            'ДНЕВНИК lives, because the spray flow writes an operation line and no location ' +
            'link; the second path was added for #1544, before which automatic spray records were ' +
            'absent from a block-filtered journal with nothing to say so.',
    }),
    cropPlanId: z.string().optional().openapi({
        param: { name: 'cropPlanId', in: 'query' },
        description: 'Entries linked to a planting of this crop plan, for the plan-detail tab.',
    }),
});

/**
 * What a recorded treatment answers with.
 *
 * `treatmentGroupId` is the HANDLE, and it is returned on both a fresh write
 * and a replay — it is how a client addresses the treatment afterwards (the
 * Дневник row, the per-entry PDF), so a client that lost the 200 is not
 * stranded. `replayed` says which of the two happened, because a saved screen
 * claiming "3 parcels recorded" must be true either way.
 */
const TreatmentParams = TenantParams.extend({
    treatmentGroupId: z
        .string()
        .openapi({ param: { name: 'treatmentGroupId', in: 'path' } }),
});

/**
 * A treatment looked up by its handle.
 *
 * `complete` is a THIRD answer rather than a detail, and a client needs all
 * three to act correctly after a save whose response was lost. See the
 * operation description.
 */
/** The ДНЕВНИК as a PDF document. Mirrors `locations.paths.ts`'s own. */
const TreatmentPdfBody = z.string().openapi({
    format: 'binary',
    description: 'The \u0414\u041d\u0415\u0412\u041d\u0418\u041a pages for this treatment, as a PDF document.',
});

const TreatmentSummary = z
    .object({
        treatmentGroupId: z.string(),
        parcelCount: z.number().int().openapi({
            description: 'Lines across every block \u2014 planned, not necessarily recorded.',
        }),
        completedCount: z.number().int().openapi({
            description:
                'Of those, how many are DONE. A line gets its \u0414\u041d\u0415\u0412\u041d\u0418\u041a entry when it is marked DONE, so this is how much of the treatment the register actually has.',
        }),
        taskIds: z.array(z.string()),
        occurredOn: z.string().nullable().openapi({
            description:
                'The calendar DAY the treatment happened, `YYYY-MM-DD`. Null when nothing has been marked yet \u2014 an unmarked line has no date.',
        }),
        complete: z.boolean().openapi({
            description:
                'True only when `completedCount === parcelCount` and at least one line exists. False means partly recorded: retry on the SAME handle and the write finishes the rest.',
        }),
    })
    .openapi('TreatmentSummary');

const RecordedTreatment = z
    .object({
        treatmentGroupId: z.string().openapi({
            description:
                'The treatment handle. Equals the `Idempotency-Key` you sent; a UUID minted by the server when you sent none.',
        }),
        parcelCount: z.number().int().openapi({
            description: 'Lines written across every block — the number to show the farmer.',
        }),
        taskIds: z.array(z.string()).openapi({
            description:
                'One per BLOCK, not per parcel. The register joins a block through the task\u2019s location link, so a treatment spanning three blocks is three tasks.',
        }),
        replayed: z.boolean().openapi({
            description: 'True when this request resolved onto an existing treatment and wrote nothing.',
        }),
    })
    .openapi('RecordedTreatment');

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
            'Three bodies on one operation — a client must branch on the query it sent.\n\n' +
            '**The PAGINATED branch is the \u0414\u041d\u0415\u0412\u041d\u0418\u041a and folds one row per ' +
            'treatment (#1740).** A treatment writes one `INPUT_APPLICATION` entry per line \u2014 twelve ' +
            'parcels in three blocks is twelve entries \u2014 and the register shows ONE row. Each row ' +
            'stays ENTRY-SHAPED, carrying `id`, `type` and `status` at the top level with the ' +
            'treatment detail in an added `treatment` object, so a client that decodes rows as ' +
            'entries keeps working and ignores the extra key. The `id` is a real entry id that ' +
            '`GET /journal/{id}` answers.\n\n' +
            '`treatment` carries `treatmentGroupId` (the handle), `occurredOn` as a DAY, `kind`, ' +
            '`productName`, `parcelCount`, `totalAreaHa`, `blockNames`, `doseValue` + `doseUnit`, ' +
            '`targetNote`, `applicationTechnique`, `quarantinePeriodDays` and a server-computed ' +
            '`earliestHarvestOn`. An entry belonging to no treatment folds to ITSELF and its ' +
            '`treatment.parcelCount` is 0 \u2014 one list, both kinds.\n\n' +
            '`earliestHarvestOn` is computed from the period captured ON THE DAY (#1775), falling ' +
            'back to the product for lines written before that was stored. Same resolution the ' +
            '\u0414\u041d\u0415\u0412\u041d\u0418\u041a PDF uses, so the list and the document cannot ' +
            'disagree about the same number. Null when no period was captured \u2014 never the ' +
            'treatment day, which would read as \u201charvest today\u201d.\n\n' +
            '**Ordered by `occurredAt` \u2014 the day the work HAPPENED \u2014 newest first, not by the ' +
            'day the row was typed** (owner ruling 2026-10-14; see #1771). So a back-dated ' +
            'treatment sorts to its own date rather than to the top. The `cursor` for this branch ' +
            'is opaque and encodes `(occurredAt, treatmentGroupId)`: a cursor naming a ROW cannot ' +
            'skip a folded treatment, and one that tried returned 3 treatments as 6 rows. Treat ' +
            'it as opaque and send back exactly what `nextCursor` gave you; a malformed cursor ' +
            'returns the FIRST page rather than a 400, so a stale bookmark is recoverable.',
        tags: ['Journal'],
        params: TenantParams,
        query: JournalListQuery,
        success: {
            status: 200,
            description:
                'Entries, in one of THREE shapes — the query decides which, and a client that ' +
                'assumes one reads an absent key from another as an empty list rather than as ' +
                'an error.\n\n' +
                '**Ordering, both branches: `occurredAt` descending — the day the work ' +
                'HAPPENED — with a tiebreak, so the order is TOTAL** (#1771). The paged branch ' +
                'pairs it with `treatmentGroupId` because it folds treatments; the flat branches ' +
                'pair it with `id` because they return rows. `occurredAt` on a diary entry is a ' +
                'DAY, so entries for the same day tie, and the flat read is capped at 200 — ' +
                'without a tiebreak an entry near that cap could appear in one read and not the ' +
                'next with nothing changed.\n\n' +
                '**Only the paged `{ rows, nextCursor }` shape carries `treatment`** — the ' +
                'folded ДНЕВНИК aggregate (#1832). The bare-array default and the `?deleted=` ' +
                'trash view return rows WITHOUT it, so a client that reads `treatment` must ' +
                'send `limit` to get the paged branch. On that branch the object is ALWAYS ' +
                'present, with `parcelCount: 0` on an ordinary manual entry rather than being ' +
                'absent, so `parcelCount > 0` is the discriminator for "this row stands for a ' +
                'treatment".',
            schema: z.union([
                // `?deleted=…` — the recycle-bin view. NO `treatment`:
                // `listDeletedLogEntries` does not fold.
                z.object({ entries: z.array(LogEntryLike) }),
                // Paged — the ONLY shape carrying `treatment`, because
                // `JournalRepository.listPaginated` is the only method that
                // attaches it (#1832).
                z.object({ rows: z.array(JournalFoldedRow), nextCursor: z.string().nullable() }),
                // The default: a bare array, ETagged. NO `treatment` —
                // `listLogEntries` does not fold either.
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
        method: 'post',
        path: '/api/t/{tenantSlug}/journal/treatments',
        operationId: 'recordDiaryTreatment',
        summary: 'Record a treatment already carried out',
        description:
            'The two-step \u00abНов запис\u00bb: pick a crop, tick parcels, describe one treatment. ' +
            'Recorded as DONE and dated by `occurredOn` \u2014 handing work to an operator stays in ' +
            '\u0417\u0430\u0434\u0430\u0447\u0438.\n\n' +
            'Send `Idempotency-Key` ALWAYS, minted BEFORE the first attempt and reused on every retry. ' +
            'Here it is also the TREATMENT HANDLE, returned as `treatmentGroupId`: the per-block writes ' +
            'derive their own keys from it, so a replay resolves on the handle rather than on any one of ' +
            'them, and the handle is what later addresses this treatment.\n\n' +
            '**A reused key RESUMES an unfinished treatment and REPLAYS a finished one.** A replay ' +
            '(`replayed: true`) happens only when every line is already DONE. If the treatment is ' +
            'partly recorded \u2014 any failure during marking leaves it so \u2014 this request finishes the ' +
            'remaining blocks and lines and answers `replayed: false`. It is safe to re-send: each ' +
            'block carries a derived idempotency key, so an existing block is replayed rather than ' +
            'duplicated, and only lines still pending are marked.\n\n' +
            '**A reused key is never REFUSED, and the body is not compared** (owner ruling ' +
            '2026-10-14). Reusing a key whose body differs returns the ORIGINAL treatment with ' +
            '`replayed: true` and writes nothing \u2014 the edit is silently not applied. So mint a NEW ' +
            'key the moment a field or the parcel set changes; the server cannot detect that you did ' +
            'not. This matches every other idempotent write in this API (journal entries, the cost ' +
            'batch, exchange messages), none of which compares a body, and it is stated here because ' +
            'the alternative \u2014 refusing the reuse \u2014 is what a client would reasonably assume.' +
            '\n\n' +
            '**The one key that IS refused: an ABANDONED handle, with 410 `TREATMENT_ABANDONED`.** ' +
            'An administrator can abandon a treatment that cannot be finished ' +
            '(`DELETE /journal/treatments/{treatmentGroupId}`, #1777). Its rows are soft-deleted but ' +
            'keep the handle, so this route can tell — and refuses, because a client still retrying a ' +
            'short 201 would otherwise sail past the replay, reach the create path and write the WHOLE ' +
            'treatment again under the same handle, undoing the abandon with nobody seeing it. Found by ' +
            'the agrent-ios session, whose outbox resends such a treatment on every launch. 410 rather ' +
            'than 404 so a client can tell "never landed, write afresh" from "do not send this again"; ' +
            'record the work under a NEW key if it still needs a register entry.' +
            '\n\n' +
            '`parcelIds` is ONE flat list that may span blocks \u2014 the server groups it and writes one ' +
            'field operation per block, because the register resolves a block through the task\u2019s ' +
            'location link.\n\n' +
            'No stock is deducted. A treatment is a RECORD of what was applied, and deducting from a lot ' +
            'the farmer may never have tracked would make the inventory wrong in the name of making the ' +
            'diary right (owner ruling 2026-10-13).\n\n' +
            'Refusals, each a 400 carrying `error.code`: `TREATMENT_DATE_INVALID` (a day that does not ' +
            'exist \u2014 2026-02-31 is refused, never rolled forward to 3 March), ' +
            '`TREATMENT_DATE_IN_FUTURE` (you cannot have sprayed tomorrow), `TREATMENT_NO_PARCELS` (an ' +
            'empty `parcelIds`), and `REFERENCE_NOT_IN_TENANT` with `params.reference` naming which list ' +
            'held the stranger \u2014 a 400 rather than a 404 so the refusal does not confirm the row ' +
            'exists on some other farm. `params.reference` is `parcels` and nothing else on this ' +
            'route.\n\n' +
            'A treatment day is the FARM\u2019s day (Europe/Sofia), not the server\u2019s UTC day, so ' +
            'recording today keeps working after local midnight.\n\n' +
            '`PRODUCT_IS_SAMPLE_ARCHETYPE` \u2014 the chosen `productItemId` or `fertilizerItemId` is a ' +
            'SAMPLE product, not a registered one, and the farm record needs a trade name. Refused ' +
            'BEFORE anything is written, so nothing is left behind: the underlying operation write ' +
            'refuses a sample only on the way to DONE, which would leave a partial treatment whose ' +
            'cause repeats on every retry \u2014 unfinishable and, with no delete-by-handle yet, ' +
            'unabandonable. Reachable only by id; a typed product NAME never resolves to a sample.\n\n' +
            'Inherited from the operation write underneath, all 400: `OPERATION_INPUT_AMBIGUOUS` (not ' +
            'exactly one input kind, or an id AND a name for the same kind), `PRODUCT_DOSE_REQUIRED` / ' +
            '`FERTILIZER_DOSE_REQUIRED`, `PRODUCT_NOT_FOUND` / `FERTILIZER_NOT_FOUND`, ' +
            '`PRODUCT_NAME_REQUIRED` (a name empty once trimmed), `FERTILIZER_EXPECTED` (the fertiliser ' +
            'field was given an item that is not a `FERTILIZER`; **the converse is deliberately NOT ' +
            'enforced** \u2014 a liquid fertiliser through a sprayer is a legitimate SPRAY, so the ' +
            'product field accepts any category), `PESTICIDE_REGULATORY_FIELDS_REQUIRED` (a typed name ' +
            'has to CREATE a plant protection product and the \u0417\u0417\u0420 registration number ' +
            'or quarantine period is missing \u2014 `params.missing` names which), and ' +
            '`DOSE_UNIT_HAS_NO_BASE` (a typed name has to create a product but the dose unit is not a ' +
            '`<base>-per-<area>` rate, so no stock unit can be derived \u2014 create the product from ' +
            'the catalogue instead).\n\n' +
            'Recording a treatment needs WRITE. The restricted machine-operator persona ' +
            '(`MECHANISATOR`) does not have it and is refused 403 \u2014 by design: completing work ' +
            'handed to an operator stays in \u0417\u0430\u0434\u0430\u0447\u0438, and filling in ' +
            'the register is not an operator action.',
        tags: ['Journal'],
        params: TenantParams,
        body: RecordDiaryTreatmentSchema,
        success: {
            status: 201,
            description: 'The handle, the counts, and whether this was a replay.',
            schema: RecordedTreatment,
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/journal/treatments/{treatmentGroupId}',
        operationId: 'getDiaryTreatment',
        summary: 'Look a recorded treatment up by its handle',
        description:
            'Answers whether a treatment was recorded under this handle, and in what state.\n\n' +
            '**This exists because the write replays a reused key without comparing the body.** A save ' +
            'whose response is lost, followed by an edit, goes out under a NEW key and writes a SECOND ' +
            'treatment if the first had landed. Asking whether the earlier handle exists is the only ' +
            'way a client can tell, so read this before re-sending an edited treatment under a fresh ' +
            'key.\n\n' +
            'Three answers, and a client needs all three:\n\n' +
            '| answer | meaning | what to do |\n' +
            '| --- | --- | --- |\n' +
            '| `404` `TREATMENT_NOT_FOUND` | nothing landed | write afresh |\n' +
            '| `200` `complete: true` | fully recorded | do not write again |\n' +
            '| `200` `complete: false` | PARTLY recorded \u2014 see `completedCount` | retry on the SAME handle; the write finishes the rest |\n\n' +
            '**`complete` counts DONE lines, not lines.** A line is created pending and marked DONE ' +
            'afterwards, and the mark is what writes the \u0414\u041d\u0415\u0412\u041d\u0418\u041a entry \u2014 so a treatment ' +
            'whose lines all exist but are unmarked is in the register nowhere. Any failure during ' +
            'marking leaves earlier blocks recorded and later ones not, which is the partial state ' +
            'this answer exists for.\n\n' +
            'Treating it as a 404 writes a duplicate treatment; treating it as an ordinary 200 ' +
            'reports a compliance record the register does not have.\n\n' +
            'The handle is a PATH segment and not a query parameter on purpose: iOS writes the full ' +
            'URL including the query string to the device log, unsuppressably.',
        tags: ['Journal'],
        params: TreatmentParams,
        success: {
            status: 200,
            description: 'The treatment, including whether it is complete.',
            schema: TreatmentSummary,
        },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/journal/treatments/{treatmentGroupId}',
        operationId: 'deleteDiaryTreatment',
        summary: 'Withdraw a recorded treatment',
        description:
            'Removes a treatment as a whole — its tasks, its ДНЕВНИК entries and the register ' +
            'rows they print (#1777, widened by #2175).\n\n' +
            'It serves two cases. A treatment that cannot be FINISHED: the write is resumable ' +
            'rather than atomic, so re-sending the same handle completes a partly-recorded one — ' +
            'and if the cause of the failure REPEATS, every retry fails identically and the ' +
            'farmer is left with a treatment that will neither complete nor go away. And a ' +
            'treatment recorded in ERROR, complete or not.\n\n' +
            '**It soft-deletes the WHOLE treatment, including register entries already ' +
            'written** for the lines that did complete. Those entries record applications that ' +
            'really happened, so a 2026-10-15 ruling made this route ADMIN-only and ' +
            'INCOMPLETE-only; a 2026-10-22 ruling reversed BOTH. What makes the wider door ' +
            'defensible is that the delete is soft (every row stays on disk), audited as one ' +
            'event naming the counts, and RESTORABLE through `POST .../restore` by the same ' +
            'people.\n\n' +
            '| answer | meaning |\n' +
            '| --- | --- |\n' +
            '| `200` | withdrawn — the body reports how many tasks, entries and lines it touched |\n' +
            '| `404` `TREATMENT_NOT_FOUND` | no treatment under that handle, or it was already withdrawn |\n' +
            '| `403` `TREATMENT_DELETE_NOT_PERMITTED` | not the treatment\'s creator and not a farm admin |\n' +
            '| `409` `TREATMENT_MIXED_AUTHORSHIP` | recorded by more than one person, so it cannot be removed as a whole |\n\n' +
            'Afterwards the handle stops resolving — this `GET` and `.../farm-record` both ' +
            'answer `404` — and the treatment appears in `GET .../journal/treatments/deleted` ' +
            'until it is restored.\n\n' +
            '**The handle is RELEASED only for an INCOMPLETE treatment**, so a dead-end key can ' +
            'be re-sent and mints a new treatment. A COMPLETE one KEEPS its `clientMutationId`, ' +
            'because that column is the only record of it and releasing it would make the ' +
            'restore silently lossy.\n\n' +
            'Unfinished lines move to `SKIPPED` rather than being deleted, because ' +
            '`OperationParcel` has no soft-delete column and the completion pass already ' +
            'refuses to touch that state.',
        tags: ['Journal'],
        params: TreatmentParams,
        success: {
            status: 200,
            description: 'Withdrawn, with what it touched.',
            schema: z
                .object({
                    treatmentGroupId: z.string(),
                    tasks: z.number().int().openapi({ description: 'Tasks soft-deleted — one per block.' }),
                    entries: z.number().int().openapi({ description: 'ДНЕВНИК entries withdrawn.' }),
                    lines: z.number().int().openapi({ description: 'Unfinished lines moved to SKIPPED.' }),
                })
                .openapi('AbandonedTreatment'),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/journal/treatments/{treatmentGroupId}/farm-record',
        operationId: 'getTreatmentFarmRecord',
        summary: 'The \u0414\u041d\u0415\u0412\u041d\u0418\u041a pages for one treatment',
        description:
            'The \u041f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u0435 1 document limited to ONE treatment, across every block it ' +
            'touched: the farm header, a field header strip for each TREATED parcel, and only ' +
            'this treatment\u2019s rows. Produced by the same gatherer and the same renderer as the ' +
            'per-block register, so the layout is identical and the document can be certified.\n\n' +
            '**Bytes inline.** 200 `application/pdf` with a `Content-Disposition` filename \u2014 no ' +
            'job, no URL to poll, nothing persisted. Check for `%PDF` and open it.\n\n' +
            'A GET where its per-block sibling is a POST, because the handle is this document\u2019s ' +
            'only input and there is nothing to send. The handle is a PATH segment rather than a ' +
            'query parameter: iOS writes the full URL including the query string to the device ' +
            'log, unsuppressably.\n\n' +
            'The farm header\u2019s block line is EMPTY, deliberately. A treatment spans blocks, so ' +
            'there is no one block to head the document with, and each field strip names its own ' +
            '\u2014 which is where the paper form puts it. Printing the first of several would be ' +
            'wrong and would look right.\n\n' +
            'The observations section prints BLANK: the issue asks for only this entry\u2019s rows, ' +
            'and an observation is a different entry.\n\n' +
            '`404` `TREATMENT_NOT_FOUND` when the handle has no recorded lines \u2014 not an empty ' +
            'register, which is indistinguishable from a real document whose treatment recorded ' +
            'nothing, and a farmer cannot tell which they are holding.\n\n' +
            'Node runtime, 60s budget.',
        tags: ['Journal', 'Farm records'],
        params: TreatmentParams,
        success: {
            status: 200,
            description: 'The treatment\u2019s \u0414\u041d\u0415\u0412\u041d\u0418\u041a pages as PDF bytes.',
            content: { 'application/pdf': TreatmentPdfBody },
        },
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
                    description: '`STALE_DATA` — optimistic-lock conflict: the entry moved on. Resolve it; do not treat it as success. `details` carries `currentVersion` and `expectedVersion`.',
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
            '\n\nRe-attaching a file that is already linked returns the EXISTING link rather than creating a second one, so a retry after a dropped connection does not double-attach a photo.' +
            '\n\n**An uploaded image is re-encoded before it is stored** (#1812). EXIF, XMP and GPS are dropped, which on this route is the point rather than a side effect: a journal attachment is a photo taken at the operation it records, so its GPS tag is by construction the parcel being worked. The format is preserved — a JPEG is stored as a JPEG — and the pixels are unchanged; only the metadata goes. Orientation is baked in first, so a portrait photo from a phone is stored upright rather than relying on a tag that is about to be removed.' +
            '\n\n**Refusal codes.** This route validates the upload itself rather than going through `ingestUploadedFile`, so these are the ones it raises:\n'
            + '- `IMAGE_UNREADABLE` — the magic number said this was an image and the decoder disagreed, so the container is truncated or malformed. A different photo, not the same one re-exported. Raised in place of storing the bytes unstripped, because a file that cannot be decoded is also one no viewer in the product could render.\n'
            + '- `FILE_TYPE_NOT_ALLOWED` — the type is outside the shared allowlist. Checked on the DECLARED type first and again on the sniffed one, so bytes whose real content is inadmissible are refused even when the claim passed.\n'
            + '- `FILE_TOO_LARGE` — over the shared maximum. The limit is on the wire as `maxBytes` rather than only in the sentence, so a translated message can still name the figure.\n'
            + '- `INVALID_FILE` — the `multipart/form-data` body carried no usable file part.\n\n'
            + 'Note what this route does NOT raise: `UPLOAD_INFECTED` and `UPLOAD_SCANNER_UNAVAILABLE` are thrown by `scanOrRefuse`, and this path uses `scanUploadedBuffer`, which RETURNS a verdict instead. An infected attachment is therefore stored with `scanStatus: INFECTED` and refused by the download gate rather than refused at upload.',
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

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/journal/treatments/{treatmentGroupId}/restore',
        operationId: 'restoreTreatment',
        summary: 'Put a withdrawn treatment back',
        description:
            'The other half of the delete (#2175): a withdrawn treatment is gone from the '
            + 'register as if it had never been recorded, AND it can be restored from '
            + '\u00ab\u041a\u043e\u0448\u0447\u0435\u00bb. Without this the delete would be destruction with extra steps.\n\n'
            + 'POST rather than PUT or a flag on DELETE, matching the journal\u2019s own '
            + '`/journal/{id}/restore`. A client that reads one of these and guesses the other '
            + 'is how #1087 happened.\n\n'
            + 'Clearing the soft-delete is enough to bring back everything a reader sees: the '
            + 'journal list filters that column and the register filters `task.deletedAt` on the '
            + 'lines it prints. The `OperationParcel` rows were never touched, so the lines and '
            + 'their per-line snapshots \u2014 quarantine period, phenophase, treated area \u2014 return '
            + 'exactly as recorded rather than being rebuilt.\n\n'
            + '**Two things do not come back.** `clientMutationId`, if the treatment was '
            + 'INCOMPLETE when deleted \u2014 that path releases the key so a dead-end handle can be '
            + 're-sent, and the value is stored nowhere, so a restored incomplete treatment is no '
            + 'longer resumable BY HANDLE. And the `SKIPPED` status on lines that never completed, '
            + 'because `SKIPPED` is the honest record of an abandoned line and guessing which had '
            + 'been `PENDING` would invent a state nobody observed. A COMPLETE treatment keeps its '
            + 'key and restores exactly.\n\n'
            + 'Audited as its own event, never as an undo: a register withdrawn and reinstated has '
            + 'two facts in its history, not zero.\n\n'
            + '| status | code | when |\n|---|---|---|\n'
            + '| `403` | `TREATMENT_DELETE_NOT_PERMITTED` | not the treatment\u2019s creator and not a farm admin \u2014 the SAME gate as the delete, so whoever could withdraw it can put it back |\n'
            + '| `404` | `TREATMENT_NOT_FOUND` | no WITHDRAWN treatment under that handle. A live one answers this too: the lookup is the inverse of the delete\u2019s, so a restore of something never deleted is a not-found rather than a no-op reporting success |\n'
            + '| `409` | `TREATMENT_MIXED_AUTHORSHIP` | tasks recorded by more than one person, so \u201cwho may restore this\u201d has no single answer |\n',
        tags: ['Journal'],
        params: TreatmentParams,
        success: {
            status: 200,
            description: 'Restored. The counts are rows actually changed.',
            schema: z.object({
                treatmentGroupId: z.string(),
                tasks: z.number().int(),
                entries: z.number().int(),
            }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/journal/treatments/deleted',
        operationId: 'listDeletedTreatments',
        summary: 'Withdrawn treatments that can be put back',
        description:
            'The \u00ab\u041a\u043e\u0448\u0447\u0435\u00bb listing (#2175).\n\n'
            + 'Folded on `treatmentGroupId` rather than returned as tasks: a treatment over three '
            + 'blocks is three tasks, and a trash view listing it three times would invite three '
            + 'restores of one thing. `taskCount` says how many it folded.\n\n'
            + 'Ordered by when it was withdrawn, newest first \u2014 the thing somebody wants back is '
            + 'almost always the thing they just removed.\n\n'
            + '`deleted` is a STATIC segment beside the dynamic `{treatmentGroupId}` sibling, which '
            + 'Next resolves first. The ambiguity is theoretical: a handle is a server-minted UUID '
            + 'or a client `Idempotency-Key`, never the word `deleted`.\n\n'
            + 'Each row carries the treatment SUMMARY — `kind`, `productName`, `blockNames`, '
            + '`parcelCount`, `totalAreaHa` — because a withdrawn handle stops resolving: this '
            + 'listing\'s `{treatmentGroupId}` sibling answers `404` for every row here, so a '
            + 'client cannot fetch per row to label it. A trash can of bare dates would not tell '
            + 'a farmer which spraying they are restoring.\n\n'
            + '`mayRestore` says whether THIS caller may put the row back, under the same two '
            + 'arms the restore applies: mixed authorship refuses admins too, so it is false for '
            + 'a reused handle whatever the role. Offer the control only where it is true — an '
            + 'offered restore that 403s is worse than an absent one.\n\n'
            + 'Bounded at 200 and NOT paged, newest-withdrawn first. A restore screen exists to '
            + 'undo a recent mistake; a farm with more withdrawn treatments than that has a '
            + 'different problem from the one this screen solves.\n\n'
            + 'Read-gated. Beyond the user ids that recorded and withdrew it, it names nothing a '
            + 'journal reader could not already see — these are rows that WERE in the register.',
        tags: ['Journal'],
        params: TenantParams,
        success: {
            status: 200,
            description: 'One entry per withdrawn treatment, newest first.',
            schema: z.object({
                treatments: z.array(
                    z.object({
                        treatmentGroupId: z.string(),
                        deletedAt: z.string(),
                        deletedByUserId: z.string().nullable(),
                        taskCount: z.number().int(),
                        occurredOn: z.string().nullable(),
                        kind: z.string().nullable(),
                        productName: z.string().nullable(),
                        blockNames: z.array(z.string()),
                        parcelCount: z.number().int(),
                        totalAreaHa: z.number(),
                        mayRestore: z.boolean(),
                    }),
                ),
            }),
        },
    });
}
