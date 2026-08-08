/**
 * Control DTOs — mirrors the shapes returned by ControlRepository.list() and .getById()
 */
import { z } from '@/lib/openapi/zod';
import { UserRefSchema, UserRefShortSchema } from './common';

// ─── Control List Item ───
// Returned by ControlRepository.list() → includes owner + _count

export const ControlListItemDTOSchema = z.object({
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
        controlTasks: z.number().optional(),
        evidenceLinks: z.number().optional(),
        // #102 item 1 — the control detail header's tab badge for
        // Mappings reads this count off the page-data payload.
        frameworkMappings: z.number().optional(),
    }).optional(),
}).passthrough().openapi('ControlListItem', {
    description: 'Control as it appears in list views — summary fields plus aggregate counts. The detail endpoint returns ControlDetail with the full include shape.',
});

export type ControlListItemDTO = z.infer<typeof ControlListItemDTOSchema>;

// ─── Sub-types for Control Detail ───

export const ControlTaskDTOSchema = z.object({
    id: z.string(),
    controlId: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    dueAt: z.string().nullable(),
    createdAt: z.string().optional(),
    assigneeUserId: z.string().nullable().optional(),
    assignee: UserRefSchema.nullable().optional(),
}).passthrough();
export type ControlTaskDTO = z.infer<typeof ControlTaskDTOSchema>;

export const EvidenceLinkDTOSchema = z.object({
    id: z.string(),
    kind: z.string(),
    fileId: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    createdAt: z.string().optional(),
    createdBy: UserRefShortSchema.nullable().optional(),
}).passthrough();
export type EvidenceLinkDTO = z.infer<typeof EvidenceLinkDTOSchema>;

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

// ─── Control Detail ───
// Returned by ControlRepository.getById() — full entity with relations

export const ControlDetailDTOSchema = ControlListItemDTOSchema.extend({
    createdBy: UserRefSchema.nullable().optional(),
    applicabilityDecidedBy: UserRefSchema.nullable().optional(),
    controlTasks: z.array(ControlTaskDTOSchema).optional(),
    evidenceLinks: z.array(EvidenceLinkDTOSchema).optional(),
    evidence: z.array(z.object({ id: z.string() }).passthrough()).optional(),
    policyLinks: z.array(PolicyLinkDTOSchema).optional(),
    frameworkMappings: z.array(FrameworkMappingDTOSchema).optional(),
}).openapi('ControlDetail', {
    description: 'Control with all relations included — tasks, evidence links, mapped policies, and framework requirement mappings. Returned by GET /controls/{id}.',
});
export type ControlDetailDTO = z.infer<typeof ControlDetailDTOSchema>;

// ─── Dashboard Metrics ───
// Returned by getControlDashboard()

export const ControlDashboardDTOSchema = z.object({
    totalControls: z.number(),
    statusDistribution: z.record(z.string(), z.number()),
    applicabilityDistribution: z.object({
        applicable: z.number(),
        notApplicable: z.number(),
    }),
    overdueTasks: z.number(),
    controlsDueSoon: z.number(),
    topOwners: z.array(z.object({
        id: z.string(),
        name: z.string(),
        openTasks: z.number(),
    })),
    implementationProgress: z.number(),
    implementedCount: z.number(),
    applicableCount: z.number(),
}).openapi('ControlDashboard', {
    description: 'Aggregate metrics for the control dashboard view — counts, distributions, top-owner leaderboard, and implementation-progress percentage.',
});
export type ControlDashboardDTO = z.infer<typeof ControlDashboardDTOSchema>;

// ─── Consistency Check ───

export const ConsistencyCheckDTOSchema = z.object({
    totalControls: z.number(),
    issues: z.object({
        missingCode: z.array(z.object({ id: z.string(), name: z.string() })),
        duplicateCodes: z.array(z.object({ code: z.string(), controlIds: z.array(z.string()) })),
        overdueTasks: z.array(z.object({
            controlId: z.string(),
            controlCode: z.string().nullable(),
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
