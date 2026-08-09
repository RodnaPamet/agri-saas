/**
 * Import/Export Tenant Safety — Multi-Tenant Isolation Enforcement
 *
 * Validates that import bundles cannot create cross-tenant references,
 * leak data between tenants, or override tenant boundaries.
 *
 * RULES:
 *   1. TENANT_OVERRIDE: All imported entities must land in the target tenant.
 *      The source tenant metadata is informational only.
 *   2. NO_CROSS_TENANT_FK: No entity in the bundle may reference a tenantId
 *      other than what will be overridden to the target.
 *   3. NO_TENANT_ESCALATION: Import bundles cannot create entities in
 *      tenants other than the explicitly requested target.
 *   4. SELF_REFERENCE_SAFE: If self-referencing models are detected,
 *      they must be handled via topological ordering or two-pass resolution.
 *   5. BUNDLE_INTEGRITY: Every entity in the bundle must have a valid
 *      type, id, and data object.
 *
 * @module app-layer/services/tenant-safety
 */

import type {
    ExportEnvelope,
    ExportEntityRecord,
    ExportEntityType,
    ImportOptions,
} from './export-schemas';

// ─── Validation Results ─────────────────────────────────────────────

export interface TenantSafetyResult {
    safe: boolean;
    violations: TenantSafetyViolation[];
}

export interface TenantSafetyViolation {
    rule: TenantSafetyRule;
    entityType?: ExportEntityType;
    entityId?: string;
    message: string;
    severity: 'ERROR' | 'WARNING';
}

export type TenantSafetyRule =
    | 'TENANT_OVERRIDE'
    | 'NO_CROSS_TENANT_FK'
    | 'SELF_REFERENCE_CYCLE'
    | 'BUNDLE_INTEGRITY'
    | 'ENTITY_ORPHAN'
    | 'DUPLICATE_ID'
    | 'MISSING_RELATIONSHIP_TARGET';

// ─── Self-Reference Detection ───────────────────────────────────────

/**
 * Known self-referencing fields in the data model.
 * If a model has a FK that points to the same model, it's listed here.
 *
 * CURRENT STATE: No self-referencing models exist in the schema.
 * This map is maintained manually as a safety net. If the schema adds
 * a self-referencing FK, it must be registered here so the import
 * service can handle parent-before-child ordering.
 */
export const SELF_REFERENCING_FIELDS: Record<ExportEntityType, string[]> = {
    practice: [],
    practiceTestPlan: [],
    practiceTestRun: [],
    practiceMapping: [],
    policy: [],
    policyVersion: [],
    risk: [],
    evidence: [],
    task: [],
    taskLink: [],
    vendor: [],
    vendorReview: [],
    vendorSubprocessor: [],
    framework: [],
    frameworkRequirement: [],
};

/**
 * Detect self-referencing cycles in an entity set.
 * Returns entities that form a cycle (e.g., A.parentId = B, B.parentId = A).
 */
export function detectSelfReferenceCycles(
    entityType: ExportEntityType,
    records: ExportEntityRecord[],
): string[][] {
    const selfRefFields = SELF_REFERENCING_FIELDS[entityType];
    if (!selfRefFields || selfRefFields.length === 0) return [];

    const cycles: string[][] = [];
    const idSet = new Set(records.map(r => r.id));

    for (const field of selfRefFields) {
        // Build adjacency map: child → parent
        const parentMap = new Map<string, string>();
        for (const record of records) {
            const parentId = (record.data as Record<string, unknown>)[field] as string | undefined;
            if (parentId && idSet.has(parentId)) {
                parentMap.set(record.id, parentId);
            }
        }

        // Detect cycles via visited tracking
        for (const startId of parentMap.keys()) {
            const visited = new Set<string>();
            let current: string | undefined = startId;
            const path: string[] = [];

            while (current && !visited.has(current)) {
                visited.add(current);
                path.push(current);
                current = parentMap.get(current);
            }

            if (current && visited.has(current)) {
                // Found a cycle — extract it
                const cycleStart = path.indexOf(current);
                const cycle = path.slice(cycleStart);
                // Only report each cycle once (by smallest ID)
                const normalizedCycle = [...cycle].sort();
                const key = normalizedCycle.join(',');
                if (!cycles.some(c => [...c].sort().join(',') === key)) {
                    cycles.push(cycle);
                }
            }
        }
    }

    return cycles;
}

/**
 * Topologically sort self-referencing entities so parents come before children.
 * Returns entities in safe import order.
 * Throws if a cycle is detected.
 */
export function topologicalSortSelfRefs(
    entityType: ExportEntityType,
    records: ExportEntityRecord[],
): ExportEntityRecord[] {
    const selfRefFields = SELF_REFERENCING_FIELDS[entityType];
    if (!selfRefFields || selfRefFields.length === 0) return records;

    // For each self-ref field, sort parents before children
    const idToRecord = new Map(records.map(r => [r.id, r]));
    const idSet = new Set(records.map(r => r.id));

    // Build child → parent edges
    const parentMap = new Map<string, string>();
    for (const field of selfRefFields) {
        for (const record of records) {
            const parentId = (record.data as Record<string, unknown>)[field] as string | undefined;
            if (parentId && idSet.has(parentId) && parentId !== record.id) {
                parentMap.set(record.id, parentId);
            }
        }
    }

    // Kahn's algorithm for topological sort
    const inDegree = new Map<string, number>();
    const children = new Map<string, string[]>();

    for (const id of idSet) {
        inDegree.set(id, 0);
        children.set(id, []);
    }

    for (const [childId, parentId] of parentMap) {
        inDegree.set(childId, (inDegree.get(childId) ?? 0) + 1);
        const parentChildren = children.get(parentId) ?? [];
        parentChildren.push(childId);
        children.set(parentId, parentChildren);
    }

    // Start with roots (no parent)
    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
        if (degree === 0) queue.push(id);
    }

    const sorted: ExportEntityRecord[] = [];
    while (queue.length > 0) {
        const id = queue.shift()!;
        const record = idToRecord.get(id);
        if (record) sorted.push(record);

        for (const childId of (children.get(id) ?? [])) {
            const newDegree = (inDegree.get(childId) ?? 1) - 1;
            inDegree.set(childId, newDegree);
            if (newDegree === 0) queue.push(childId);
        }
    }

    // If not all records are sorted, there's a cycle
    if (sorted.length < records.length) {
        const unsorted = records.filter(r => !sorted.includes(r)).map(r => r.id);
        throw new Error(
            `Cycle detected in ${entityType} self-references. ` +
            `Entities involved: ${unsorted.join(', ')}`,
        );
    }

    return sorted;
}

// ─── Tenant Safety Validation ───────────────────────────────────────

/**
 * Validate an import bundle for tenant safety.
 *
 * Checks:
 *   1. All entities have valid structure
 *   2. No cross-tenant FK references smuggled in entity data
 *   3. No self-referencing cycles
 *   4. No duplicate IDs within the same entity type
 *   5. Relationship targets exist in the bundle
 */
export function validateTenantSafety(
    envelope: ExportEnvelope,
    options: ImportOptions,
): TenantSafetyResult {
    const violations: TenantSafetyViolation[] = [];

    // ── Rule 1: Bundle integrity ────────────────────────────────────
    for (const [typeName, records] of Object.entries(envelope.entities)) {
        const entityType = typeName as ExportEntityType;
        if (!records) continue;

        for (const record of records) {
            if (!record.id || typeof record.id !== 'string') {
                violations.push({
                    rule: 'BUNDLE_INTEGRITY',
                    entityType,
                    message: `Entity missing valid id`,
                    severity: 'ERROR',
                });
            }
            if (!record.data || typeof record.data !== 'object') {
                violations.push({
                    rule: 'BUNDLE_INTEGRITY',
                    entityType,
                    entityId: record.id,
                    message: `Entity missing valid data object`,
                    severity: 'ERROR',
                });
            }
        }
    }

    // ── Rule 2: No cross-tenant FK in entity data ───────────────────
    // Check if any entity's data contains a tenantId that differs from
    // both the source tenant and is not the target tenant.
    // This catches crafted payloads trying to write to other tenants.
    const sourceTenantId = envelope.metadata.tenantId;
    const targetTenantId = options.targetTenantId;

    for (const [typeName, records] of Object.entries(envelope.entities)) {
        const entityType = typeName as ExportEntityType;
        if (!records) continue;

        for (const record of records) {
            const data = record.data as Record<string, unknown>;
            const entityTenantId = data.tenantId as string | undefined;

            if (entityTenantId &&
                entityTenantId !== sourceTenantId &&
                entityTenantId !== targetTenantId) {
                violations.push({
                    rule: 'NO_CROSS_TENANT_FK',
                    entityType,
                    entityId: record.id,
                    message: `Entity contains tenantId '${entityTenantId}' which differs from ` +
                        `source '${sourceTenantId}' and target '${targetTenantId}'. ` +
                        `This may be a cross-tenant reference injection.`,
                    severity: 'ERROR',
                });
            }
        }
    }

    // ── Rule 3: No self-referencing cycles ──────────────────────────
    for (const [typeName, records] of Object.entries(envelope.entities)) {
        const entityType = typeName as ExportEntityType;
        if (!records) continue;

        const cycles = detectSelfReferenceCycles(entityType, records);
        for (const cycle of cycles) {
            violations.push({
                rule: 'SELF_REFERENCE_CYCLE',
                entityType,
                message: `Self-referencing cycle detected: ${cycle.join(' → ')}`,
                severity: 'ERROR',
            });
        }
    }

    // ── Rule 4: No duplicate IDs ────────────────────────────────────
    for (const [typeName, records] of Object.entries(envelope.entities)) {
        const entityType = typeName as ExportEntityType;
        if (!records) continue;

        const seen = new Set<string>();
        for (const record of records) {
            if (seen.has(record.id)) {
                violations.push({
                    rule: 'DUPLICATE_ID',
                    entityType,
                    entityId: record.id,
                    message: `Duplicate entity ID '${record.id}' in ${entityType}`,
                    severity: 'ERROR',
                });
            }
            seen.add(record.id);
        }
    }

    // ── Rule 5: Relationship targets exist in bundle ────────────────
    const allEntityIds = new Map<string, Set<string>>();
    for (const [typeName, records] of Object.entries(envelope.entities)) {
        const ids = new Set((records ?? []).map(r => r.id));
        allEntityIds.set(typeName, ids);
    }

    for (const rel of envelope.relationships) {
        const fromIds = allEntityIds.get(rel.fromType);
        const toIds = allEntityIds.get(rel.toType);

        if (fromIds && !fromIds.has(rel.fromId)) {
            violations.push({
                rule: 'MISSING_RELATIONSHIP_TARGET',
                entityType: rel.fromType,
                entityId: rel.fromId,
                message: `Relationship references missing entity: ` +
                    `${rel.fromType}:${rel.fromId} (fromId not in bundle)`,
                severity: 'WARNING',
            });
        }

        if (toIds && !toIds.has(rel.toId)) {
            violations.push({
                rule: 'MISSING_RELATIONSHIP_TARGET',
                entityType: rel.toType,
                entityId: rel.toId,
                message: `Relationship references missing entity: ` +
                    `${rel.toType}:${rel.toId} (toId not in bundle)`,
                severity: 'WARNING',
            });
        }
    }

    return {
        safe: violations.filter(v => v.severity === 'ERROR').length === 0,
        violations,
    };
}
