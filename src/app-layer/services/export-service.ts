/**
 * Export Service — Dependency-Aware Domain-Scoped Tenant Data Export
 *
 * Exports a tenant's compliance data as a versioned, self-describing
 * JSON envelope. Uses explicit graph traversal to walk from domain
 * roots through dependent entities, producing complete portable bundles.
 *
 * ARCHITECTURE:
 *   1. Caller specifies tenant + domain(s)
 *   2. Each domain has root entity types
 *   3. Root entities are fetched (tenant-scoped)
 *   4. Graph edges are traversed to collect dependent children
 *   5. All entities are deduplicated by (entityType, id)
 *   6. Relationships are emitted for every traversed edge
 *   7. Everything is wrapped in a versioned ExportEnvelope
 *
 * TRAVERSAL STRATEGY:
 *   - BFS from domain roots following EXPORT_EDGES
 *   - Each edge is a Prisma query: WHERE foreignKey = parentId AND tenantId = ?
 *   - M2M join tables are fetched as-is and emitted as relationship records
 *   - Entity deduplication via Set<string> keyed by "type:id"
 *   - Soft-deleted records excluded by default (deletedAt IS NULL)
 *
 * SECURITY:
 *   - All queries enforced with WHERE tenantId = ?
 *   - Sensitive fields stripped via REDACTED_FIELDS
 *   - Source tenant metadata for audit, not cross-tenant use
 *
 * @module app-layer/services/export-service
 */

import { withTenantDb, type PrismaTx } from '@/lib/db-context';

// Dynamic model access: model names are resolved from ROOT_PRISMA_MODELS / ExportEdge
// at runtime — only findMany is called via these delegates.
interface ReadonlyModelDelegate {
    findMany(args: object): Promise<Record<string, unknown>[]>;
}
import { logger } from '@/lib/observability/logger';
import {
    EXPORT_FORMAT_VERSION,
    APP_IDENTIFIER,
    type ExportDomain,
    type ExportEnvelope,
    type ExportMetadata,
    type ExportEntityRecord,
    type ExportEntityType,
    type ExportRelationship,
} from './export-schemas';
import {
    getEdgesFrom,
    type ExportEdge,
} from './export-graph';

// ─── Types ──────────────────────────────────────────────────────────

export interface ExportRequest {
    /** Tenant to export from. Required. */
    tenantId: string;
    /** Which domain(s) to export. Default: FULL_TENANT. */
    domains?: ExportDomain[];
    /** User who initiated the export. */
    exportedBy?: string;
    /** Optional description. */
    description?: string;
    /** Application version string. */
    appVersion?: string;
}

export interface ExportServiceResult {
    envelope: ExportEnvelope;
    stats: {
        entityCount: number;
        relationshipCount: number;
        domains: ExportDomain[];
        durationMs: number;
    };
}

// ─── Entity Schema Versions ─────────────────────────────────────────

/**
 * Current schema version for each entity type.
 * Bump when the exported shape of an entity changes.
 */
const ENTITY_SCHEMA_VERSIONS: Record<ExportEntityType, string> = {
    practice: '1.0',
    practiceTestPlan: '1.0',
    practiceTestRun: '1.0',
    practiceMapping: '1.0',
    policy: '1.0',
    policyVersion: '1.0',
    risk: '1.0',
    evidence: '1.0',
    task: '1.0',
    taskLink: '1.0',
    vendor: '1.0',
    vendorReview: '1.0',
    vendorSubprocessor: '1.0',
    framework: '1.0',
    frameworkRequirement: '1.0',
};

// ─── Field Redaction ────────────────────────────────────────────────

const REDACTED_FIELDS = new Set([
    'password', 'passwordHash', 'token', 'accessToken',
    'refreshToken', 'secret', 'apiKey', 'encryptedData',
    'nameEncrypted', 'emailEncrypted', 'phoneEncrypted',
]);

function redactSensitiveFields(data: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
        if (REDACTED_FIELDS.has(key)) continue;
        result[key] = value;
    }
    return result;
}

// ─── Domain Root Queries ────────────────────────────────────────────

/**
 * Root entity type for each domain.
 * The traversal starts from these entity types.
 */
const DOMAIN_ROOTS: Record<Exclude<ExportDomain, 'FULL_TENANT'>, ExportEntityType> = {
    CONTROLS: 'practice',
    POLICIES: 'policy',
    RISKS: 'risk',
    EVIDENCE: 'evidence',
    TASKS: 'task',
    VENDORS: 'vendor',
    FRAMEWORKS: 'framework',
};

/**
 * Prisma model name for each root entity type.
 */
const ROOT_PRISMA_MODELS: Record<ExportEntityType, string> = {
    practice: 'practice',
    practiceTestPlan: 'practiceTestPlan',
    practiceTestRun: 'practiceTestRun',
    practiceMapping: 'practiceRequirementLink',
    policy: 'policy',
    policyVersion: 'policyVersion',
    risk: 'risk',
    evidence: 'evidence',
    task: 'task',
    taskLink: 'taskLink',
    vendor: 'vendor',
    vendorReview: 'vendorAssessment',
    vendorSubprocessor: 'vendorRelationship',
    framework: 'framework',
    frameworkRequirement: 'frameworkRequirement',
};

// ─── Traversal Engine ───────────────────────────────────────────────

/**
 * Entity collector — accumulates entities and relationships
 * while deduplicating by (entityType, id).
 */
class ExportCollector {
    private seen = new Set<string>();
    private entities: ExportEntityRecord[] = [];
    private relationships: ExportRelationship[] = [];

    private makeKey(entityType: ExportEntityType, id: string): string {
        return `${entityType}:${id}`;
    }

    /**
     * Add an entity. Returns true if it was new, false if duplicate.
     */
    add(entityType: ExportEntityType, record: Record<string, unknown>): boolean {
        const id = record.id as string;
        const key = this.makeKey(entityType, id);
        if (this.seen.has(key)) return false;
        this.seen.add(key);

        this.entities.push({
            entityType,
            id,
            schemaVersion: ENTITY_SCHEMA_VERSIONS[entityType] ?? '1.0',
            data: redactSensitiveFields(record),
        });
        return true;
    }

    addRelationship(rel: ExportRelationship): void {
        this.relationships.push(rel);
    }

    has(entityType: ExportEntityType, id: string): boolean {
        return this.seen.has(this.makeKey(entityType, id));
    }

    getEntities(): ExportEntityRecord[] {
        return this.entities;
    }

    getRelationships(): ExportRelationship[] {
        return this.relationships;
    }

    get entityCount(): number {
        return this.entities.length;
    }

    get relationshipCount(): number {
        return this.relationships.length;
    }
}

/**
 * Fetch root entities for a domain.
 * All queries run inside a tenant-scoped transaction for RLS enforcement.
 */
async function fetchRootEntities(
    db: PrismaTx,
    entityType: ExportEntityType,
    tenantId: string,
): Promise<Record<string, unknown>[]> {
    const modelName = ROOT_PRISMA_MODELS[entityType];
    const model = (db as unknown as Record<string, ReadonlyModelDelegate | undefined>)[modelName];
    if (!model?.findMany) return [];

    // Build WHERE clause — tenant-scoped, exclude soft-deleted
    const where: Record<string, unknown> = {};

    // Framework/FrameworkRequirement don't have tenantId
    if (entityType !== 'framework' && entityType !== 'frameworkRequirement') {
        where.tenantId = tenantId;
    }

    // Soft-delete filter (models with deletedAt)
    if (['practice', 'policy', 'risk', 'evidence', 'task', 'vendor'].includes(entityType)) {
        where.deletedAt = null;
    }

    return model.findMany({ where });
}

/**
 * Traverse an edge: fetch children of a parent entity.
 * All queries run inside a tenant-scoped transaction for RLS enforcement.
 */
async function traverseEdge(
    db: PrismaTx,
    edge: ExportEdge,
    parentId: string,
    tenantId: string,
): Promise<Record<string, unknown>[]> {
    const model = (db as unknown as Record<string, ReadonlyModelDelegate | undefined>)[edge.prismaModel];
    if (!model?.findMany) return [];

    const where: Record<string, unknown> = { [edge.foreignKey]: parentId };

    if (edge.tenantScoped) {
        where.tenantId = tenantId;
    }

    return model.findMany({ where });
}

/**
 * BFS traversal from root entities through export edges.
 * Collects all reachable entities and relationships.
 * All queries run inside a tenant-scoped transaction for RLS enforcement.
 */
async function traverseDomain(
    db: PrismaTx,
    rootType: ExportEntityType,
    tenantId: string,
    collector: ExportCollector,
): Promise<void> {
    // Fetch root entities
    const roots = await fetchRootEntities(db, rootType, tenantId);

    // Queue: (entityType, record) pairs to process
    const queue: Array<{ entityType: ExportEntityType; record: Record<string, unknown> }> = [];

    for (const record of roots) {
        if (collector.add(rootType, record)) {
            queue.push({ entityType: rootType, record });
        }
    }

    // BFS through edges
    while (queue.length > 0) {
        const { entityType, record } = queue.shift()!;
        const parentId = record.id as string;
        const edges = getEdgesFrom(entityType);

        for (const edge of edges) {
            const children = await traverseEdge(db, edge, parentId, tenantId);

            for (const child of children) {
                const childId = child.id as string;

                // Add relationship
                collector.addRelationship({
                    fromType: edge.to,
                    fromId: childId,
                    toType: edge.from,
                    toId: parentId,
                    relationship: edge.relationship,
                });

                // Add entity and queue for further traversal
                if (collector.add(edge.to, child)) {
                    queue.push({ entityType: edge.to, record: child });
                }
            }
        }
    }
}

// ─── Main Export Function ───────────────────────────────────────────

/**
 * Export tenant data as a versioned envelope with dependency traversal.
 *
 * @param request - Export request specifying tenant and domains.
 * @returns The export envelope and statistics.
 */
export async function exportTenantData(
    request: ExportRequest,
): Promise<ExportServiceResult> {
    const startMs = performance.now();
    const { tenantId, exportedBy, description } = request;
    const appVersion = request.appVersion ?? '0.0.0';

    // Resolve domains
    let domains = request.domains ?? ['FULL_TENANT' as ExportDomain];
    const isFullTenant = domains.includes('FULL_TENANT');

    if (isFullTenant) {
        domains = ['CONTROLS', 'POLICIES', 'RISKS', 'EVIDENCE', 'TASKS', 'VENDORS', 'FRAMEWORKS'];
    }

    logger.info('starting dependency-aware export', {
        component: 'export-service',
        tenantId,
        domains,
    });

    // Collect entities via graph traversal — inside tenant-scoped transaction
    const collector = new ExportCollector();

    await withTenantDb(tenantId, async (db) => {
        for (const domain of domains) {
            if (domain === 'FULL_TENANT') continue;
            const rootType = DOMAIN_ROOTS[domain];
            if (!rootType) continue;

            await traverseDomain(db, rootType, tenantId, collector);
        }
    });

    // Group entities by type
    const entitiesByType: Partial<Record<ExportEntityType, ExportEntityRecord[]>> = {};
    for (const entity of collector.getEntities()) {
        if (!entitiesByType[entity.entityType]) {
            entitiesByType[entity.entityType] = [];
        }
        entitiesByType[entity.entityType]!.push(entity);
    }

    // Build metadata
    const metadata: ExportMetadata = {
        tenantId,
        exportedAt: new Date().toISOString(),
        domains: isFullTenant ? ['FULL_TENANT'] : domains,
        app: APP_IDENTIFIER,
        appVersion,
        ...(exportedBy ? { exportedBy } : {}),
        ...(description ? { description } : {}),
    };

    // Compute integrity checksum (SHA-256 of entities JSON)
    const entitiesJson = JSON.stringify(entitiesByType);
    const entitiesHash = await computeChecksum(entitiesJson);

    // Build envelope
    const envelope: ExportEnvelope = {
        formatVersion: EXPORT_FORMAT_VERSION,
        metadata,
        entities: entitiesByType,
        relationships: collector.getRelationships(),
        checksum: entitiesHash,
    };

    const durationMs = Math.round(performance.now() - startMs);

    logger.info('export completed', {
        component: 'export-service',
        tenantId,
        domains,
        entityCount: collector.entityCount,
        relationshipCount: collector.relationshipCount,
        durationMs,
    });

    return {
        envelope,
        stats: {
            entityCount: collector.entityCount,
            relationshipCount: collector.relationshipCount,
            domains: isFullTenant ? ['FULL_TENANT'] : domains,
            durationMs,
        },
    };
}

/**
 * Compute SHA-256 checksum of a string.
 * Used for bundle integrity verification.
 */
async function computeChecksum(input: string): Promise<string> {
    // Use Node.js crypto for server-side
    const { createHash } = await import('crypto');
    return createHash('sha256').update(input).digest('hex');
}

/**
 * Re-export graph helpers for composability.
 */
export { getEdgesFrom, getReachableTypes } from './export-graph';
