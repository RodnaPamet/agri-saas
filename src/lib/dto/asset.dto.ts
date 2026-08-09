/**
 * Asset DTOs — mirrors shapes returned by AssetRepository.list() and .getById()
 */
import { z } from '@/lib/openapi/zod';
import { UserRefSchema } from './common';

// ─── Asset List Item ───

export const AssetListItemDTOSchema = z.object({
    id: z.string(),
    tenantId: z.string(),
    name: z.string(),
    type: z.string(),
    owner: z.string().nullable().optional(),
    ownerUserId: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    manufacturer: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    serialNumber: z.string().nullable().optional(),
    year: z.number().int().nullable().optional(),
    purchaseDate: z.string().nullable().optional(),
    purchaseCost: z.number().nullable().optional(),
    criticality: z.string().nullable().optional(),
    status: z.string().optional(),
    externalRef: z.string().nullable().optional(),
    tags: z.string().nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    ownerUser: UserRefSchema.nullable().optional(),
    _count: z.object({
        practices: z.number().optional(),
        risks: z.number().optional(),
    }).optional(),
}).passthrough().openapi('AssetListItem', {
    description: 'Agricultural asset (machine, building, equipment) as it appears in list views. Criticality is an explicit LOW/MEDIUM/HIGH field.',
});

export type AssetListItemDTO = z.infer<typeof AssetListItemDTOSchema>;

// ─── Asset Detail ───

export const AssetDetailDTOSchema = AssetListItemDTOSchema.extend({
    practices: z.array(z.object({
        id: z.string(),
        practice: z.object({
            id: z.string(),
            name: z.string(),
            status: z.string(),
        }).passthrough(),
    }).passthrough()).optional(),
    risks: z.array(z.object({
        id: z.string(),
        risk: z.object({
            id: z.string(),
            title: z.string(),
            status: z.string(),
        }).passthrough(),
    }).passthrough()).optional(),
}).openapi('AssetDetail', {
    description: 'Asset with linked practices and risks. Returned by GET /assets/{id}.',
});

export type AssetDetailDTO = z.infer<typeof AssetDetailDTOSchema>;
