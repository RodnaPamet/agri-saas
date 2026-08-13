/**
 * Practice DTOs — mirrors the shapes returned by PracticeRepository.list() and .getById()
 */
import { z } from '@/lib/openapi/zod';
import { UserRefSchema, UserRefShortSchema } from './common';
// EvidenceLinkDTO moved to evidence.dto.ts in GRC teardown phase 2
// (it is an evidence shape that merely lived here). This file is
// deleted in T3, so the import back is transitional.
import { EvidenceLinkDTOSchema } from './evidence.dto';

// ─── Practice List Item ───
// Returned by PracticeRepository.list() → includes owner + _count

export const PracticeListItemDTOSchema = z.object({
    id: z.string(),
    tenantId: z.string().nullable(),
    code: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    intent: z.string().nullable().optional(),
    category: z.string().nullable(),
    status: z.string(),
    applicability: z.string(),
    frequency: z.string().nullable(),
    ownerUserId: z.string().nullable(),
    createdByUserId: z.string().nullable().optional(),
    evidenceSource: z.string().nullable().optional(),
    automationKey: z.string().nullable().optional(),
    mitigationType: z.string().nullable().optional(),
    effectiveness: z.number().nullable().optional(),
    isCustom: z.boolean().optional(),
    nextDueAt: z.string().nullable().optional(),
    applicabilityJustification: z.string().nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    owner: UserRefSchema.nullable().optional(),
    _count: z.object({
        evidence: z.number().optional(),
        assets: z.number().optional(),
        practiceTasks: z.number().optional(),
        evidenceLinks: z.number().optional(),
        // #102 item 1 — the practice detail header's tab badge for
        // Mappings reads this count off the page-data payload.
        frameworkMappings: z.number().optional(),
    }).optional(),
}).passthrough().openapi('PracticeListItem', {
    description: 'Practice as it appears in list views — summary fields plus aggregate counts. The detail endpoint returns PracticeDetail with the full include shape.',
});

export type PracticeListItemDTO = z.infer<typeof PracticeListItemDTOSchema>;

// ─── Sub-types for Practice Detail ───

export const PracticeTaskDTOSchema = z.object({
    id: z.string(),
    practiceId: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    dueAt: z.string().nullable(),
    createdAt: z.string().optional(),
    assigneeUserId: z.string().nullable().optional(),
    assignee: UserRefSchema.nullable().optional(),
}).passthrough();
export type PracticeTaskDTO = z.infer<typeof PracticeTaskDTOSchema>;

// EvidenceLinkDTO moved to evidence.dto.ts in GRC teardown phase 2;
// this file is deleted in T3, so the import is transitional.

export const PolicyLinkDTOSchema = z.object({
    id: z.string(),
    policy: z.object({
        id: z.string(),
        title: z.string(),
        status: z.string(),
    }).passthrough(),
}).passthrough();
export type PolicyLinkDTO = z.infer<typeof PolicyLinkDTOSchema>;

export const FrameworkMappingDTOSchema = z.object({
    id: z.string(),
    fromRequirementId: z.string().optional(),
    fromRequirement: z.object({
        id: z.string(),
        code: z.string().nullable().optional(),
        title: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        section: z.string().nullable().optional(),
        category: z.string().nullable().optional(),
        framework: z.object({
            name: z.string(),
        }).optional(),
    }).nullable().optional(),
}).passthrough();
export type FrameworkMappingDTO = z.infer<typeof FrameworkMappingDTOSchema>;

// ─── Practice Detail ───
// Returned by PracticeRepository.getById() — full entity with relations

export const PracticeDetailDTOSchema = PracticeListItemDTOSchema.extend({
    createdBy: UserRefSchema.nullable().optional(),
    applicabilityDecidedBy: UserRefSchema.nullable().optional(),
    practiceTasks: z.array(PracticeTaskDTOSchema).optional(),
    evidenceLinks: z.array(EvidenceLinkDTOSchema).optional(),
    evidence: z.array(z.object({ id: z.string() }).passthrough()).optional(),
    policyLinks: z.array(PolicyLinkDTOSchema).optional(),
    frameworkMappings: z.array(FrameworkMappingDTOSchema).optional(),
}).openapi('PracticeDetail', {
    description: 'Practice with all relations included — tasks, evidence links, mapped policies, and framework requirement mappings. Returned by GET /practices/{id}.',
});
export type PracticeDetailDTO = z.infer<typeof PracticeDetailDTOSchema>;

// ─── Dashboard Metrics ───
// Returned by getPracticeDashboard()

export const PracticeDashboardDTOSchema = z.object({
    totalPractices: z.number(),
    statusDistribution: z.record(z.string(), z.number()),
    applicabilityDistribution: z.object({
        applicable: z.number(),
        notApplicable: z.number(),
    }),
    overdueTasks: z.number(),
    practicesDueSoon: z.number(),
    topOwners: z.array(z.object({
        id: z.string(),
        name: z.string(),
        openTasks: z.number(),
    })),
    implementationProgress: z.number(),
    implementedCount: z.number(),
    applicableCount: z.number(),
}).openapi('PracticeDashboard', {
    description: 'Aggregate metrics for the practice dashboard view — counts, distributions, top-owner leaderboard, and implementation-progress percentage.',
});
export type PracticeDashboardDTO = z.infer<typeof PracticeDashboardDTOSchema>;

// ─── Consistency Check ───

export const ConsistencyCheckDTOSchema = z.object({
    totalPractices: z.number(),
    issues: z.object({
        missingCode: z.array(z.object({ id: z.string(), name: z.string() })),
        duplicateCodes: z.array(z.object({ code: z.string(), practiceIds: z.array(z.string()) })),
        overdueTasks: z.array(z.object({
            practiceId: z.string(),
            practiceCode: z.string().nullable(),
            taskId: z.string(),
            taskTitle: z.string(),
            dueAt: z.string().nullable(),
            status: z.string(),
        })),
    }),
    summary: z.object({
        missingCodeCount: z.number(),
        duplicateCodeCount: z.number(),
        overdueTaskCount: z.number(),
    }),
});
export type ConsistencyCheckDTO = z.infer<typeof ConsistencyCheckDTOSchema>;
