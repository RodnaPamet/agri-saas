/**
 * Vendor DTOs
 */
import { z } from '@/lib/openapi/zod';

export const VendorListItemDTOSchema = z.object({
    id: z.string(),
    tenantId: z.string(),
    name: z.string(),
    legalName: z.string().nullable().optional(),
    status: z.string(),
    criticality: z.string().nullable().optional(),
    inherentRisk: z.string().nullable().optional(),
    residualRisk: z.string().nullable().optional(),
    dataAccess: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
    ownerUserId: z.string().nullable().optional(),
    isSubprocessor: z.boolean().optional(),
    nextReviewAt: z.string().nullable().optional(),
    contractRenewalAt: z.string().nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
}).passthrough().openapi('VendorListItem', {
    description: 'Vendor as shown in list views. residualRisk is the risk score after practice coverage; null = not yet assessed.',
});

export type VendorListItemDTO = z.infer<typeof VendorListItemDTOSchema>;

export const VendorDocumentDTOSchema = z.object({
    id: z.string(),
    type: z.string(),
    title: z.string().nullable().optional(),
    fileId: z.string().nullable().optional(),
    externalUrl: z.string().nullable().optional(),
    validFrom: z.string().nullable().optional(),
    validTo: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    createdAt: z.string().optional(),
}).passthrough();
export type VendorDocumentDTO = z.infer<typeof VendorDocumentDTOSchema>;

export const VendorDetailDTOSchema = VendorListItemDTOSchema.extend({
    websiteUrl: z.string().nullable().optional(),
    domain: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    documents: z.array(VendorDocumentDTOSchema).optional(),
    assessments: z.array(z.object({ id: z.string() }).passthrough()).optional(),
    links: z.array(z.object({ id: z.string() }).passthrough()).optional(),
}).openapi('VendorDetail', {
    description: 'Vendor with full document set + assessment history + linked entities. Returned by GET /vendors/{id}.',
});

export type VendorDetailDTO = z.infer<typeof VendorDetailDTOSchema>;
