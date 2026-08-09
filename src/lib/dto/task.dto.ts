/**
 * Task (Work Item) DTOs
 */
import { z } from '@/lib/openapi/zod';
import { UserRefSchema } from './common';

export const TaskDTOSchema = z.object({
    id: z.string(),
    tenantId: z.string(),
    title: z.string(),
    type: z.string(),
    description: z.string().nullable().optional(),
    status: z.string(),
    severity: z.string().nullable().optional(),
    priority: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    dueAt: z.string().nullable().optional(),
    resolvedAt: z.string().nullable().optional(),
    resolution: z.string().nullable().optional(),
    practiceId: z.string().nullable().optional(),
    assigneeUserId: z.string().nullable().optional(),
    reviewerUserId: z.string().nullable().optional(),
    createdByUserId: z.string().nullable().optional(),
    metadataJson: z.unknown().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    assignee: UserRefSchema.nullable().optional(),
    reviewer: UserRefSchema.nullable().optional(),
    createdBy: UserRefSchema.nullable().optional(),
}).passthrough().openapi('Task', {
    description: 'Unified work-item record covering audit findings, practice gaps, incidents, improvements, and ad-hoc tasks. The type field discriminates which UI surfaces this row appears in.',
});

export type TaskDTO = z.infer<typeof TaskDTOSchema>;
