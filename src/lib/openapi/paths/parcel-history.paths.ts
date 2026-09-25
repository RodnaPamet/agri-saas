/**
 * Parcel history — the archive of what a parcel grew and what was done to it.
 *
 * Documented because two things about it are not visible from the response
 * shape and would be got wrong by anyone reading only the JSON:
 *
 *  1. `year` is the HARVEST year and is NOT derived from `sownAt`. An
 *     autumn-sown crop is drilled in the preceding calendar year.
 *  2. weeds go up as ONE list and come back as TWO. The server decides which
 *     entries are catalogue binomials; a client cannot choose the column.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';
// The REQUEST bodies come from the schema layer the routes actually validate
// with, not from copies written here. This module used to hand-write them, so
// the documented body and the enforced one were two objects that merely
// happened to agree — and the sync hook could not have caught a drift, because
// it compares the generated file to THIS module rather than to the validator.
import {
    CreateCropSeasonSchema,
    CreateWeedObservationSchema,
} from '@/app-layer/schemas/parcel-history.schemas';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});
const ParcelParams = TenantParams.extend({
    parcelId: z.string().openapi({ param: { name: 'parcelId', in: 'path' } }),
});

const CropSeason = z
    .object({
        id: z.string(),
        year: z.number().int(),
        cropType: z.string(),
        sownAt: z.string().datetime().nullable(),
        harvestedAt: z.string().datetime().nullable(),
        notes: z.string().nullable(),
    })
    .openapi('ParcelCropSeason', {
        description:
            '`year` is the HARVEST year. Do not derive it from `sownAt`: wheat sown in ' +
            'October 2025 is the 2026 harvest, so deriving would misfile most autumn ' +
            'cropping by one year. `sownAt` is optional — a back-filled season is often ' +
            'remembered without the drilling date.',
    });

const HistoryOperation = z
    .object({
        id: z.string(),
        taskId: z.string(),
        operationType: z.string().nullable(),
        /**
         * EMPTY STRING when the source relation is absent, never null.
         *
         * `title`, `productName` and `doseUnit` are read through optional
         * relations and collapsed with `?? ''` at the boundary, so an empty
         * value means "not recorded" and NEVER "unknown". Render nothing
         * rather than a placeholder, and filter empties out of any
         * concatenation — an absent unit otherwise leaves a trailing space
         * that is invisible in a diff and visible in a right-aligned column.
         *
         * No schema can express this: `type: string` is all it can say, which
         * is why it is written here.
         */
        title: z.string(),
        completedAt: z.string().datetime().nullable(),
        productName: z.string(),
        /**
         * What was applied, from the ITEM rather than from the label.
         * `operationType` cannot answer this — caller-settable, four values of
         * which only two carry the derivation, and null on a third of the
         * operation lines in production.
         */
        productCategory: z
            .enum(['SEED', 'PESTICIDE', 'FERTILIZER', 'AMENDMENT', 'FUEL', 'HARVESTED_PRODUCE', 'OTHER'])
            .nullable(),
        doseValue: z.string(),
        doseUnit: z.string(),
        targetNote: z.string().nullable(),
    })
    .openapi('ParcelHistoryOperation', {
        description:
            'A COMPLETED field-operation line for this parcel — the same rows that record ' +
            'a spray or fertiliser application, which is why "linked completed tasks" and ' +
            '"what was applied" are one list and not two. Pending lines are absent: a plan ' +
            'is not history. `doseValue` is a decimal STRING; parsing it as a float rounds ' +
            'the dose.' +
            '\n\n`title`, `productName` and `doseUnit` are EMPTY STRINGS when their source relation is absent, never null — empty means "not recorded", never "unknown". Filter them out of any concatenation rather than rendering a placeholder.',
    });

const WeedObservation = z
    .object({
        id: z.string(),
        observedAt: z.string().datetime(),
        /**
         * CATALOGUE values only — the server matched these against its own
         * vocabulary, so a client may rely on the set and offer it in a picker.
         *
         * The enum is HERE and deliberately NOT on the write field. `weeds` on
         * the request accepts catalogue values AND free text in one array, and
         * the server splits them; constraining that side would forbid the free
         * text the split exists to handle, which is the feature rather than a
         * loophole.
         */
        weedKeys: z.array(
            z.enum([
                'Sorghum halepense',
                'Echinochloa crus-galli',
                'Setaria viridis',
                'Avena fatua',
                'Cynodon dactylon',
                'Cirsium arvense',
                'Convolvulus arvensis',
                'Chenopodium album',
                'Amaranthus retroflexus',
                'Sinapis arvensis',
                'Raphanus raphanistrum',
                'Papaver rhoeas',
                'Galium aparine',
            ]),
        ),
        otherWeeds: z.array(z.string()),
        notes: z.string().nullable(),
    })
    .openapi('ParcelWeedObservation', {
        description:
            '`weedKeys` are catalogue Latin binomials and are the reportable half — group ' +
            'and count on these. `otherWeeds` is free text for a species the catalogue ' +
            'does not carry. Render them together; never merge them in storage.',
    });

const ParcelHistory = z
    .object({
        parcel: z.object({
            id: z.string(),
            name: z.string(),
            cropType: z.string().nullable(),
        }),
        cropSeasons: z.array(CropSeason),
        operations: z.array(HistoryOperation),
        weedObservations: z.array(WeedObservation),
        /**
         * Opaque position of the next OLDER page, PER LIST. Null means that
         * list has nothing older — which is per-list, so two of the three can
         * be null while the third still pages.
         */
        cropSeasonsCursor: z.string().nullable(),
        operationsCursor: z.string().nullable(),
        weedObservationsCursor: z.string().nullable(),
    })
    .openapi('ParcelHistory');

export function registerParcelHistoryPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/agro/parcels/{parcelId}/history',
        operationId: 'getParcelHistory',
        summary: 'What a parcel has grown, and what was done to it',
        description:
            'One request for the whole archive: authored crop seasons, COMPLETED field ' +
            'operations, and weed observations, each newest-first.\n\n' +
            '`parcel.cropType` is the CURRENT crop and is a single overwritten field — it ' +
            'carries no year and no history, which is the reason `cropSeasons` exists. Do ' +
            'not infer this year from it and the rest from the archive; the archive is the ' +
            'record.\n\n' +
            'ETagged: a parcel grows one crop a season but the screen is revisited often. ' +
            'The tag is derived from the BODY, so each page validates separately and a ' +
            'cached first page is never served for a second.\n\n' +
            '**Three lists, three cursors.** The sections have three different sort keys — ' +
            'harvest YEAR, completion date, observation date — so there is no single ' +
            'position to page from. Each list carries its own `…Cursor`, null when that ' +
            'list has no older rows, and you page each independently: a parcel with 200 ' +
            'operations and 3 crop seasons returns a cursor for the operations only.\n\n' +
            '**Each list defaults to 100 rows** and `limit` applies PER LIST, so a client ' +
            'knows whether a first page can even be partial before it decides to offer a ' +
            '"load older" control at all.\n\n' +
            '**A stale or malformed cursor RESTARTS that list — and it does so with a 200.** ' +
            'That is deliberate server-side: a 400 over yesterday\'s cursor would strand a ' +
            'screen for no gain. But it means the failure arrives as a VALID BODY holding the ' +
            'NEWEST rows, so a client that appends a page blindly gets an infinite list with ' +
            'nothing erroring — page one arrives, its cursor goes back, page one arrives — and ' +
            'a farmer sees one spray recorded forty times and concludes the app is lying about ' +
            'his own field. Deduplicate each append by `id`, and treat a page that adds nothing ' +
            'new as the end of that list. The same rule covers a genuinely empty page, which is ' +
            'why a client does not need to tell the two apart.\n\n' +
            '**A cursor is not a "has more" flag.** It names the last row of the page just sent, ' +
            'so a list whose length divides exactly by the page size returns a cursor for a page ' +
            'that turns out empty. Decide "exhausted" from what ARRIVED, never from the presence ' +
            'of a cursor.\n\n' +
            '**Cursors are opaque: pass them back verbatim and do not parse them.** They ' +
            'happen to be base64url of `<sortKey>|<rowId>`, which is stated so nobody ' +
            'believes a cursor keeps ids out of the URL — it does not, it encodes one. But ' +
            'the encoding is not a contract: `cropSeasonsCursor` keys on an integer YEAR ' +
            'while the other two key on timestamps, and a client that parsed and rebuilt ' +
            'one would paginate on a value the ORDER BY does not use. That skips rows ' +
            'silently, which reads as a short archive rather than an error — and a short ' +
            'archive looks exactly like a young farm.',
        tags: ['Parcel history'],
        params: ParcelParams,
        query: z.object({
            limit: z.coerce.number().int().min(1).max(100).optional().openapi({
                param: { name: 'limit', in: 'query' },
                description: 'Page size PER LIST, 1-100. Above the cap it is clamped, not rejected.',
            }),
            seasonsBefore: z.string().optional().openapi({
                param: { name: 'seasonsBefore', in: 'query' },
                description: 'From a previous response\'s `cropSeasonsCursor`.',
            }),
            operationsBefore: z.string().optional().openapi({
                param: { name: 'operationsBefore', in: 'query' },
                description: 'From a previous response\'s `operationsCursor`.',
            }),
            weedsBefore: z.string().optional().openapi({
                param: { name: 'weedsBefore', in: 'query' },
                description: 'From a previous response\'s `weedObservationsCursor`. A stale or ' +
                    'malformed cursor RESTARTS that list rather than erroring.',
            }),
        }),
        success: { status: 200, description: 'The parcel archive.', schema: ParcelHistory },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/agro/parcels/{parcelId}/crop-seasons',
        operationId: 'createParcelCropSeason',
        summary: 'Record what this parcel grew in a harvest year',
        description:
            'Back-fillable on purpose — years long before the farm started using this ' +
            'system are accepted, because an archive whose earliest entry is today is not ' +
            'an archive.\n\n' +
            '`cropType` is NOT validated against the crop catalogue. Live data already ' +
            'holds values outside it, and refusing them would make the farm\'s own history ' +
            'un-recordable. Offer the catalogue in the picker; accept what they grew.\n\n' +
            'A parcel may hold more than one season in a year — a catch crop after an early ' +
            'harvest is ordinary practice, so this is not refused as a duplicate.',
        tags: ['Parcel history'],
        params: ParcelParams,
        body: CreateCropSeasonSchema,
        success: {
            status: 201,
            description: 'Recorded.',
            schema: z.object({ id: z.string() }),
        },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/agro/parcels/{parcelId}/crop-seasons/{seasonId}',
        operationId: 'deleteParcelCropSeason',
        summary: 'Remove a crop season',
        description:
            'Soft delete — the row is retained like every other agronomic record, so ids ' +
            'are never reused.\n\n' +
            'Deleting one that is ALREADY gone returns **404 `CROP_SEASON_NOT_FOUND`**, not a quiet ' +
            'success. A retried delete is therefore a 404, and a client should treat that ' +
            'as the end state it wanted rather than as an error.',
        tags: ['Parcel history'],
        params: ParcelParams.extend({
            seasonId: z.string().openapi({ param: { name: 'seasonId', in: 'path' } }),
        }),
        success: { status: 200, description: 'Removed.', schema: z.object({ ok: z.boolean() }) },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/agro/parcels/{parcelId}/weed-observations',
        operationId: 'createParcelWeedObservation',
        summary: 'Record which weeds were identified in this parcel',
        description:
            'Send ONE `weeds` list mixing catalogue binomials and free text. The SERVER ' +
            'splits it — entries matching the weed catalogue become `weedKeys`, the rest ' +
            'become `otherWeeds`. A client cannot choose which column a value lands in, ' +
            'which is what keeps `weedKeys` reportable across years.\n\n' +
            'Duplicates collapse. An observation resolving to nothing is refused.',
        tags: ['Parcel history'],
        params: ParcelParams,
        body: CreateWeedObservationSchema,
        success: {
            status: 201,
            description: 'Recorded.',
            schema: z.object({ id: z.string() }),
        },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/agro/parcels/{parcelId}/weed-observations/{observationId}',
        operationId: 'deleteParcelWeedObservation',
        summary: 'Remove a weed observation',
        description:
            'Soft delete — the row is retained, so ids are never reused.\n\n' +
            'Deleting one that is ALREADY gone returns **404 `WEED_OBSERVATION_NOT_FOUND`**, ' +
            'not a quiet success. A retried delete is therefore a 404, and a client should ' +
            'treat that as the end state it wanted rather than as an error.',
        tags: ['Parcel history'],
        params: ParcelParams.extend({
            observationId: z.string().openapi({ param: { name: 'observationId', in: 'path' } }),
        }),
        success: { status: 200, description: 'Removed.', schema: z.object({ ok: z.boolean() }) },
    });
}
