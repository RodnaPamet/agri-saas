/**
 * Evidence DTOs — mirrors shapes returned by EvidenceRepository
 */
import { z } from '@/lib/openapi/zod';
import { UserRefShortSchema } from './common';

// ─── Evidence Review sub-shape ───

export const EvidenceReviewDTOSchema = z.object({
    id: z.string(),
    evidenceId: z.string(),
    reviewerId: z.string(),
    action: z.string(),
    comment: z.string().nullable().optional(),
    createdAt: z.string(),
    reviewer: UserRefShortSchema.nullable().optional(),
}).passthrough().openapi('EvidenceReview', {
    description: 'A single evidence-review event (submission/approval/rejection) — append-only audit row attached to the evidence record.',
});

export type EvidenceReviewDTO = z.infer<typeof EvidenceReviewDTOSchema>;

// ─── Evidence List Item ───

export const EvidenceListItemDTOSchema = z.object({
    id: z.string(),
    tenantId: z.string(),
    practiceId: z.string().nullable().optional(),
    type: z.string(),
    title: z.string(),
    content: z.string().nullable().optional(),
    fileName: z.string().nullable().optional(),
    fileSize: z.number().nullable().optional(),
    category: z.string().nullable().optional(),
    dateCollected: z.string().optional(),
    owner: z.string().nullable().optional(),
    reviewCycle: z.string().nullable().optional(),
    nextReviewDate: z.string().nullable().optional(),
    status: z.string(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    practice: z.object({
        id: z.string(),
        name: z.string(),
        code: z.string().nullable().optional(),
    }).passthrough().nullable().optional(),
}).passthrough().openapi('EvidenceListItem', {
    description: 'Evidence record as shown in list views. content is encrypted at rest for TEXT type and decrypted transparently on read by the field-encryption middleware.',
});

export type EvidenceListItemDTO = z.infer<typeof EvidenceListItemDTOSchema>;

// ─── Evidence Detail ───

export const EvidenceDetailDTOSchema = EvidenceListItemDTOSchema.extend({
    reviews: z.array(EvidenceReviewDTOSchema).optional(),
}).passthrough().openapi('EvidenceDetail', {
    description: 'Evidence record with the full review history attached. Returned by GET /evidence/{id}.',
});

export type EvidenceDetailDTO = z.infer<typeof EvidenceDetailDTOSchema>;
