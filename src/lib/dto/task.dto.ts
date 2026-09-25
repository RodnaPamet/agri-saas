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

/**
 * A task comment, as both the list and the create return it.
 *
 * Read off the repository's own `include` rather than guessed: every scalar of
 * `TaskComment` plus `createdBy` narrowed to `{id, name, email}`, which is
 * exactly `UserRef`. `tenantId` is on the wire — it is the caller's own tenant,
 * so it discloses nothing, but it is documented rather than hidden because a
 * client will see it.
 *
 * Comments are PLAIN TEXT. The usecase strips HTML before persistence so a
 * future renderer change cannot re-enable a stored XSS vector, which means a
 * client must not treat the body as markup either.
 */
export const TaskCommentDTOSchema = z
    .object({
        id: z.string(),
        tenantId: z.string(),
        taskId: z.string(),
        body: z.string(),
        createdByUserId: z.string(),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
        createdBy: UserRefSchema.nullable().optional(),
    })
    .passthrough()
    .openapi('TaskComment');
