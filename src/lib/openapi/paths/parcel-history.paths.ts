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
        sownAt: z.string().nullable(),
        harvestedAt: z.string().nullable(),
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
        title: z.string(),
        completedAt: z.string().nullable(),
        productName: z.string(),
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
            'the dose.',
    });

const WeedObservation = z
    .object({
        id: z.string(),
        observedAt: z.string(),
        weedKeys: z.array(z.string()),
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
            'ETagged: a parcel grows one crop a season but the screen is revisited often.',
        tags: ['Parcel history'],
        params: ParcelParams,
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
        body: z
            .object({
                year: z.number().int().openapi({ example: 2024 }),
                cropType: z.string().min(1).openapi({ example: 'Wheat' }),
                sownAt: z.string().datetime().nullable().optional(),
                harvestedAt: z.string().datetime().nullable().optional(),
                notes: z.string().nullable().optional(),
            })
            .openapi('CreateParcelCropSeason'),
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
        description: 'Soft delete — the row is retained like every other agronomic record.',
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
        body: z
            .object({
                observedAt: z.string().datetime(),
                weeds: z
                    .array(z.string())
                    .min(1)
                    .openapi({ example: ['Sorghum halepense', 'някакъв друг плевел'] }),
                notes: z.string().nullable().optional(),
            })
            .openapi('CreateParcelWeedObservation'),
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
        description: 'Soft delete.',
        tags: ['Parcel history'],
        params: ParcelParams.extend({
            observationId: z.string().openapi({ param: { name: 'observationId', in: 'path' } }),
        }),
        success: { status: 200, description: 'Removed.', schema: z.object({ ok: z.boolean() }) },
    });
}
