/**
 * Policy DTOs — mirrors shapes returned by PolicyRepository.list() and .getById()
 */
import { z } from '@/lib/openapi/zod';
import { UserRefSchema, UserRefShortSchema } from './common';

// ─── Policy Version sub-shape ───

export const PolicyVersionDTOSchema = z.object({
    id: z.string(),
    policyId: z.string(),
    versionNumber: z.number(),
    contentType: z.string(),
    contentText: z.string().nullable().optional(),
    externalUrl: z.string().nullable().optional(),
    changeSummary: z.string().nullable().optional(),
    createdAt: z.string(),
    createdBy: UserRefShortSchema.nullable().optional(),
    approvals: z.array(z.object({
        id: z.string(),
        status: z.string(),
        policyVersionId: z.string().optional(),
        requestedBy: UserRefShortSchema.nullable().optional(),
        approvedBy: UserRefShortSchema.nullable().optional(),
        decidedAt: z.string().nullable().optional(),
        comment: z.string().nullable().optional(),
    }).passthrough()).optional(),
}).passthrough();
export type PolicyVersionDTO = z.infer<typeof PolicyVersionDTOSchema>;

// ─── Policy Control Link ───

export const PolicyControlLinkDTOSchema = z.object({
    id: z.string(),
    control: z.object({
        id: z.string(),
        name: z.string(),
        code: z.string().nullable().optional(),
    }).passthrough(),
}).passthrough();
export type PolicyControlLinkDTO = z.infer<typeof PolicyControlLinkDTOSchema>;

// ─── Policy List Item ───
// Returned by PolicyRepository.list()

export const PolicyListItemDTOSchema = z.object({
    id: z.string(),
    tenantId: z.string(),
    slug: z.string(),
    title: z.string(),
    description: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    status: z.string(),
    ownerUserId: z.string().nullable().optional(),
    language: z.string().nullable().optional(),
    reviewFrequencyDays: z.number().nullable().optional(),
    nextReviewAt: z.string().nullable().optional(),
    currentVersionId: z.string().nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    currentVersion: PolicyVersionDTOSchema.nullable().optional(),
    owner: UserRefSchema.nullable().optional(),
    _count: z.object({
        versions: z.number().optional(),
        controlLinks: z.number().optional(),
        approvals: z.number().optional(),
    }).optional(),
}).passthrough().openapi('PolicyListItem', {
    description: 'Policy as it appears in list views — includes the currently published version, owner, and aggregate counts. The detail endpoint adds full version history + control links.',
});

export type PolicyListItemDTO = z.infer<typeof PolicyListItemDTOSchema>;

// ─── Policy Detail ───
// Returned by PolicyRepository.getById()

export const PolicyDetailDTOSchema = PolicyListItemDTOSchema.extend({
    versions: z.array(PolicyVersionDTOSchema).optional(),
    controlLinks: z.array(PolicyControlLinkDTOSchema).optional(),
    approvals: z.array(z.object({
        id: z.string(),
        status: z.string(),
        policyVersionId: z.string().optional(),
        policyId: z.string().optional(),
        requestedBy: UserRefShortSchema.nullable().optional(),
        approvedBy: UserRefShortSchema.nullable().optional(),
        decidedAt: z.string().nullable().optional(),
    }).passthrough()).optional(),
}).openapi('PolicyDetail', {
    description: 'Policy with full version history, control links, and approval audit trail. Returned by GET /policies/{id}.',
});

export type PolicyDetailDTO = z.infer<typeof PolicyDetailDTOSchema>;
