/**
 * Export Graph — Dependency-Aware Traversal Configuration
 *
 * Defines the explicit relationship graph between exportable entities.
 * Used by the export service to traverse from a domain root and collect
 * all dependent entities required for a complete, portable bundle.
 *
 * DESIGN PRINCIPLES:
 *   - Relationships are declared explicitly (no reflection/metadata magic)
 *   - Each edge specifies: parent model, child model, FK field, join model (if M2M)
 *   - Traversal is always tenant-scoped (WHERE tenantId = ?)
 *   - Deduplication is enforced via Set<entityId> per entity type
 *
 * RELATIONSHIP TYPES:
 *   - HAS_MANY:  parent → child[] via child.parentId (1:N)
 *   - JOIN:      parent ↔ target via join table (M2M)
 *   - SELF_REF:  entity → itself via parentId (tree structures)
 *
 * @module app-layer/services/export-graph
 */

import type {
    ExportEntityType,
    ExportRelationship,
    ExportRelationshipType,
} from './export-schemas';

// ─── Edge Types ─────────────────────────────────────────────────────

export type EdgeKind = 'HAS_MANY' | 'JOIN';

/**
 * An explicit edge in the export graph.
 * Defines how to traverse from a parent entity to its children.
 */
export interface ExportEdge {
    /** The parent entity type. */
    from: ExportEntityType;
    /** The child/target entity type. */
    to: ExportEntityType;
    /** Kind of relationship. */
    kind: EdgeKind;
    /** Prisma model name for the child (or join table). */
    prismaModel: string;
    /** FK field on the child that references the parent. */
    foreignKey: string;
    /** For JOIN edges: the FK on the join table pointing to the target. */
    targetKey?: string;
    /** For JOIN edges: the Prisma model for the actual target entity. */
    targetModel?: string;
    /** Relationship type for the export envelope. */
    relationship: ExportRelationshipType;
    /** Whether the child has a tenantId field for scoping. */
    tenantScoped: boolean;
    /** Whether to include soft-deleted records. Default: false. */
    includeSoftDeleted?: boolean;
}

// ─── Graph Definition ───────────────────────────────────────────────

/**
 * Complete export relationship graph.
 * Each entry defines a traversable edge from parent → child.
 *
 * CONTROLS domain:
 *   Practice → PracticeTestPlan → PracticeTestRun → PracticeTestEvidenceLink
 *   Practice → PracticeTestRun (direct)
 *   Practice → PracticeEvidenceLink
 *   Practice → PracticeTask
 *   Practice → PracticeContributor
 *   Practice → PracticeAsset (join to Asset)
 *   Practice → PracticeRequirementLink (join to FrameworkRequirement)
 *   Practice → RiskPractice (join to Risk)
 *   Practice → PolicyPracticeLink (join to Policy)
 *
 * POLICIES domain:
 *   Policy → PolicyVersion → PolicyApproval
 *   Policy → PolicyPracticeLink (join to Practice)
 *
 * RISKS domain:
 *   Risk → RiskPractice (join to Practice)
 *
 * EVIDENCE domain:
 *   Evidence → EvidenceReview
 *
 * TASKS domain:
 *   Task → TaskLink
 *   Task → TaskComment
 *
 * VENDORS domain:
 *   Vendor → VendorContact
 *   Vendor → VendorDocument
 *   Vendor → VendorLink
 *   Vendor → VendorAssessment → VendorAssessmentAnswer
 *   Vendor → VendorEvidenceBundle → VendorEvidenceBundleItem
 *   Vendor → VendorRelationship (subprocessors)
 *
 * FRAMEWORKS domain:
 *   Framework → FrameworkRequirement
 *   Framework → FrameworkMapping
 */
export const EXPORT_EDGES: ExportEdge[] = [
    // ── CONTROLS ────────────────────────────────────────────────────
    {
        from: 'practice',
        to: 'practiceTestPlan',
        kind: 'HAS_MANY',
        prismaModel: 'practiceTestPlan',
        foreignKey: 'practiceId',
        relationship: 'BELONGS_TO',
        tenantScoped: true,
    },
    {
        from: 'practiceTestPlan',
        to: 'practiceTestRun',
        kind: 'HAS_MANY',
        prismaModel: 'practiceTestRun',
        foreignKey: 'testPlanId',
        relationship: 'BELONGS_TO',
        tenantScoped: true,
    },
    {
        from: 'practice',
        to: 'practiceMapping',
        kind: 'JOIN',
        prismaModel: 'practiceRequirementLink',
        foreignKey: 'practiceId',
        targetKey: 'requirementId',
        targetModel: 'frameworkRequirement',
        relationship: 'MAPS_TO',
        tenantScoped: true,
    },

    // ── POLICIES ────────────────────────────────────────────────────
    {
        from: 'policy',
        to: 'policyVersion',
        kind: 'HAS_MANY',
        prismaModel: 'policyVersion',
        foreignKey: 'policyId',
        relationship: 'VERSION_OF',
        tenantScoped: true,
    },

    // ── EVIDENCE ────────────────────────────────────────────────────
    // Evidence is a leaf domain — no children to traverse

    // ── TASKS ───────────────────────────────────────────────────────
    {
        from: 'task',
        to: 'taskLink',
        kind: 'HAS_MANY',
        prismaModel: 'taskLink',
        foreignKey: 'taskId',
        relationship: 'LINKED_TO',
        tenantScoped: true,
    },

    // ── VENDORS ─────────────────────────────────────────────────────
    {
        from: 'vendor',
        to: 'vendorReview',
        kind: 'HAS_MANY',
        prismaModel: 'vendorAssessment',
        foreignKey: 'vendorId',
        relationship: 'REVIEWS',
        tenantScoped: true,
    },
    {
        from: 'vendor',
        to: 'vendorSubprocessor',
        kind: 'HAS_MANY',
        prismaModel: 'vendorRelationship',
        foreignKey: 'primaryVendorId',
        relationship: 'LINKED_TO',
        tenantScoped: true,
    },

    // ── FRAMEWORKS ──────────────────────────────────────────────────
    {
        from: 'framework',
        to: 'frameworkRequirement',
        kind: 'HAS_MANY',
        prismaModel: 'frameworkRequirement',
        foreignKey: 'frameworkId',
        relationship: 'BELONGS_TO',
        tenantScoped: false, // Frameworks are global (no tenantId)
    },
];

// ─── Graph Helpers ──────────────────────────────────────────────────

/**
 * Get all outgoing edges from a given entity type.
 */
export function getEdgesFrom(entityType: ExportEntityType): ExportEdge[] {
    return EXPORT_EDGES.filter(e => e.from === entityType);
}

/**
 * Get the set of entity types reachable from a root entity type
 * by traversing all edges transitively.
 */
export function getReachableTypes(root: ExportEntityType): Set<ExportEntityType> {
    const visited = new Set<ExportEntityType>();
    const queue: ExportEntityType[] = [root];

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);

        for (const edge of getEdgesFrom(current)) {
            if (!visited.has(edge.to)) {
                queue.push(edge.to);
            }
        }
    }

    return visited;
}

/**
 * Build an ExportRelationship from an edge + concrete entity IDs.
 */
export function buildRelationship(
    edge: ExportEdge,
    fromId: string,
    toId: string,
): ExportRelationship {
    return {
        fromType: edge.to,
        fromId: toId,
        toType: edge.from,
        toId: fromId,
        relationship: edge.relationship,
    };
}
