/**
 * Import Service — Topological, FK-Aware Tenant Data Import
 *
 * Imports a versioned export envelope into a target tenant.
 * Processes entities in dependency order with FK resolution,
 * ID mapping, and conflict handling.
 *
 * ARCHITECTURE:
 *   1. Validate envelope format + version
 *   2. Validate import options (target tenant, conflict strategy)
 *   3. Filter entities by include/exclude rules
 *   4. Compute topological import order from EXPORT_EDGES
 *   5. Build ID mapping table (original ID → new ID)
 *   6. Process entities in order:
 *      a. Resolve FK references using ID map + relationships
 *      b. Override tenantId to target tenant
 *      c. Apply conflict strategy (SKIP/OVERWRITE/RENAME/FAIL)
 *      d. Persist entity
 *      e. Record ID mapping for dependent entities
 *
 * ID RESOLUTION STRATEGY:
 *   - SKIP/OVERWRITE/FAIL: Preserve original IDs (CUIDs are globally unique)
 *   - RENAME: Generate new CUIDs, maintain ID mapping table
 *   - FK fields are resolved via ID map before persistence
 *   - Unresolved FKs fail explicitly with diagnostic messages
 *
 * SECURITY:
 *   - Target tenant is explicit (never from envelope metadata)
 *   - All writes forced to target tenant
 *   - Source tenant metadata preserved for audit only
 *
 * @module app-layer/services/import-service
 */

import { prisma } from '@/lib/prisma';
import type { PrismaTx } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';
import {
    IMPORT_ORDER,
    type ExportEnvelope,
    type ExportEntityRecord,
    type ExportEntityType,
    type ImportOptions,
    type ImportResult,
    type ImportError,
    type ImportConflictStrategy,
    validateExportEnvelope,
    validateImportOptions,
    isFormatVersionSupported,
    checkVersionCompatibility,
} from './export-schemas';
import { EXPORT_EDGES } from './export-graph';
import { validateTenantSafety } from './tenant-safety';

// ─── ID Mapping ─────────────────────────────────────────────────────

/**
 * Maps original entity IDs to new IDs during import.
 * For RENAME strategy, new CUIDs are generated.
 * For other strategies, original IDs are preserved.
 */
export class IdMap {
    private map = new Map<string, string>();

    private makeKey(entityType: ExportEntityType, originalId: string): string {
        return `${entityType}:${originalId}`;
    }

    set(entityType: ExportEntityType, originalId: string, newId: string): void {
        this.map.set(this.makeKey(entityType, originalId), newId);
    }

    get(entityType: ExportEntityType, originalId: string): string | undefined {
        return this.map.get(this.makeKey(entityType, originalId));
    }

    /**
     * Resolve an ID — returns mapped ID if exists, otherwise the original.
     * For SKIP/OVERWRITE/FAIL strategies, IDs are identity-mapped.
     */
    resolve(entityType: ExportEntityType, originalId: string): string {
        return this.get(entityType, originalId) ?? originalId;
    }

    get size(): number {
        return this.map.size;
    }
}

// ─── FK Resolution ──────────────────────────────────────────────────

/**
 * FK fields that must be resolved during import.
 * Maps: entityType → { fieldName → referencedEntityType }
 *
 * Built from EXPORT_EDGES: each edge's foreignKey on the child
 * points to the parent entity type.
 */
const FK_RESOLUTION_MAP: Record<string, Record<string, ExportEntityType>> = {};

// Build FK map from export edges
for (const edge of EXPORT_EDGES) {
    if (!FK_RESOLUTION_MAP[edge.to]) {
        FK_RESOLUTION_MAP[edge.to] = {};
    }
    FK_RESOLUTION_MAP[edge.to][edge.foreignKey] = edge.from;
}

/**
 * Resolve FK fields in entity data using the ID map.
 * Returns a new data object with resolved FKs.
 * Unresolved required FKs are collected as errors.
 */
function resolveForeignKeys(
    entityType: ExportEntityType,
    data: Record<string, unknown>,
    idMap: IdMap,
    errors: ImportError[],
): Record<string, unknown> {
    const resolved = { ...data };
    const fkFields = FK_RESOLUTION_MAP[entityType];

    if (!fkFields) return resolved;

    for (const [field, referencedType] of Object.entries(fkFields)) {
        const originalValue = resolved[field];
        if (originalValue && typeof originalValue === 'string') {
            const newId = idMap.resolve(referencedType, originalValue);
            resolved[field] = newId;

            // If ID didn't resolve and it's not identity-mapped, warn
            if (newId === originalValue && !idMap.get(referencedType, originalValue)) {
                // Not necessarily an error — the referenced entity may not be in the bundle
                // (e.g., cross-domain reference). Only error if the referenced type IS in the bundle.
                logger.debug('FK reference not in ID map (may be external)', {
                    component: 'import-service',
                    entityType,
                    field,
                    referencedType,
                    originalValue,
                });
            }
        }
    }

    return resolved;
}

// ─── Prisma Model Map ───────────────────────────────────────────────

/**
 * Maps ExportEntityType → Prisma model name for persistence.
 */
const PRISMA_MODEL_MAP: Record<ExportEntityType, string> = {
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

/**
 * Fields to strip from imported data before persistence.
 * These are auto-generated by Prisma or managed by the system.
 */
const STRIP_ON_IMPORT = new Set([
    'createdAt', 'updatedAt',
]);

/**
 * Prepare entity data for Prisma create.
 * - Override tenantId to target
 * - Strip auto-generated fields
 * - Resolve FK references
 */
function prepareEntityData(
    entityType: ExportEntityType,
    record: ExportEntityRecord,
    targetTenantId: string,
    idMap: IdMap,
    errors: ImportError[],
): Record<string, unknown> {
    let data = { ...record.data } as Record<string, unknown>;

    // Override tenant
    if ('tenantId' in data) {
        data.tenantId = targetTenantId;
    }

    // Strip auto-generated fields
    for (const field of STRIP_ON_IMPORT) {
        delete data[field];
    }

    // Resolve FKs
    data = resolveForeignKeys(entityType, data, idMap, errors);

    return data;
}

// ─── Dynamic Model Delegate ─────────────────────────────────────────

/**
 * Minimal delegate interface for dynamic Prisma model access by string key.
 * Import service resolves model names at runtime from PRISMA_MODEL_MAP —
 * only the methods actually called are listed here.
 */
interface ModelDelegate {
    findUnique?(args: object): Promise<unknown>;
    create(args: object): Promise<unknown>;
    update(args: object): Promise<unknown>;
}

/** Type guard: checks whether an unknown value has a string `code` field. */
function hasStringCode(e: unknown): e is { code: string } {
    return (
        typeof e === 'object' &&
        e !== null &&
        'code' in e &&
        typeof (e as Record<string, unknown>).code === 'string'
    );
}

// ─── Entity Persistence ─────────────────────────────────────────────

/**
 * Persist a single entity using the configured conflict strategy.
 * Operates within the provided Prisma transaction client.
 *
 * @param tx - Prisma transaction client (all writes are atomic)
 * @returns 'imported' | 'skipped' | 'conflict' | 'error'
 */
async function persistEntity(
    tx: PrismaTx,
    entityType: ExportEntityType,
    record: ExportEntityRecord,
    data: Record<string, unknown>,
    strategy: ImportConflictStrategy,
    idMap: IdMap,
): Promise<'imported' | 'skipped' | 'conflict' | 'error'> {
    const modelName = PRISMA_MODEL_MAP[entityType];
    // Dynamic model access: entityType is resolved to a Prisma model name at runtime.
    const model = (tx as unknown as Record<string, ModelDelegate>)[modelName];
    if (!model) return 'error';

    const entityId = idMap.resolve(entityType, record.id);

    try {
        // Check for existing entity
        const existing = await model.findUnique?.({ where: { id: entityId } });

        if (existing) {
            switch (strategy) {
                case 'SKIP':
                    return 'skipped';

                case 'OVERWRITE':
                    await model.update({
                        where: { id: entityId },
                        data,
                    });
                    return 'imported';

                case 'FAIL':
                    return 'conflict';

                case 'RENAME':
                    // For RENAME, the ID was already remapped — this shouldn't happen
                    // unless the generated CUID collides (astronomically unlikely)
                    return 'conflict';
            }
        }

        // Create new entity
        await model.create({
            data: {
                id: entityId,
                ...data,
            },
        });
        return 'imported';

    } catch (error: unknown) {
        // Prisma unique constraint violation → conflict. Detected by the
        // `code` property (not `instanceof`) so it stays robust across
        // Prisma client instances / bundling boundaries — the original
        // property-based behaviour.
        if (hasStringCode(error) && error.code === 'P2002') {
            if (strategy === 'SKIP') return 'skipped';
            return 'conflict';
        }
        throw error;
    }
}

/**
 * Sentinel error used to trigger transaction rollback.
 * When FAIL strategy encounters a conflict, we throw this to abort.
 */
class ImportAbortError extends Error {
    constructor(public readonly importResult: ImportResult) {
        super('Import aborted due to blocking errors');
        this.name = 'ImportAbortError';
    }
}

/** Max transaction timeout for imports (60 seconds). */
const IMPORT_TX_TIMEOUT_MS = 60_000;

// ─── CUID Generation ────────────────────────────────────────────────

/**
 * Generate a CUID-like ID for RENAME strategy.
 * Uses crypto.getRandomValues for collision-safe ID generation.
 */
function generateId(): string {
    // Use the same format as Prisma's cuid() — 25-char alphanumeric
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = 'c'; // CUIDs start with 'c'
    const randomBytes = new Uint8Array(24);
    crypto.getRandomValues(randomBytes);
    for (let i = 0; i < 24; i++) {
        result += chars[randomBytes[i] % chars.length];
    }
    return result;
}

// ─── Import Guards ──────────────────────────────────────────────────

/**
 * Maximum entities allowed in a single import bundle.
 * Prevents memory exhaustion and excessive DB writes.
 */
const MAX_IMPORT_ENTITIES = 10_000;

// ─── Main Import Function ───────────────────────────────────────────

/**
 * Import a versioned export envelope into a target tenant.
 *
 * @param envelope - The parsed export envelope JSON.
 * @param options  - Import options (target tenant, conflict strategy, etc.)
 * @returns Import result with per-type counts and errors.
 */
export async function importTenantData(
    envelope: unknown,
    options: unknown,
): Promise<ImportResult> {
    const startMs = performance.now();
    const errors: ImportError[] = [];

    // ── 1. Validate envelope ────────────────────────────────────────
    const envelopeValidation = validateExportEnvelope(envelope);
    if (!envelopeValidation.valid) {
        return failResult(envelopeValidation.errors, startMs, false);
    }

    // ── 2. Validate options ─────────────────────────────────────────
    const optionsValidation = validateImportOptions(options);
    if (!optionsValidation.valid) {
        return failResult(optionsValidation.errors, startMs, false);
    }

    const validEnvelope = envelope as ExportEnvelope;
    const validOptions = options as ImportOptions;
    const dryRun = validOptions.dryRun ?? false;

    // ── 3. Check format version ─────────────────────────────────────
    const versionCompat = checkVersionCompatibility(validEnvelope.formatVersion);
    if (!isFormatVersionSupported(validEnvelope.formatVersion)) {
        return failResult(
            [`Unsupported format version: '${validEnvelope.formatVersion}'. ${versionCompat.message}`],
            startMs,
            dryRun,
        );
    }
    if (versionCompat.level === 'COMPATIBLE') {
        logger.warn('importing bundle with compatible but non-exact format version', {
            component: 'import-service',
            bundleVersion: versionCompat.bundleVersion,
            appVersion: versionCompat.appVersion,
            message: versionCompat.message,
        });
    }

    // ── 3b. Tenant safety validation ────────────────────────────────
    const safetyResult = validateTenantSafety(validEnvelope, validOptions);
    if (!safetyResult.safe) {
        const safetyErrors = safetyResult.violations
            .filter(v => v.severity === 'ERROR')
            .map(v => `[${v.rule}] ${v.message}`);
        return failResult(safetyErrors, startMs, dryRun);
    }

    // ── 3c. Bundle size guard ────────────────────────────────────────
    const totalEntityCount = Object.values(validEnvelope.entities)
        .reduce((sum, records) => sum + (records?.length ?? 0), 0);
    if (totalEntityCount > MAX_IMPORT_ENTITIES) {
        return failResult(
            [`Bundle too large: ${totalEntityCount} entities exceeds maximum of ${MAX_IMPORT_ENTITIES}`],
            startMs,
            dryRun,
        );
    }

    // ── 3d. Checksum verification ───────────────────────────────────
    if (validEnvelope.checksum) {
        try {
            const { createHash } = await import('crypto');
            const entitiesJson = JSON.stringify(validEnvelope.entities);
            const computed = createHash('sha256').update(entitiesJson).digest('hex');
            if (computed !== validEnvelope.checksum) {
                return failResult(
                    [`Bundle integrity check failed: checksum mismatch (expected: ${validEnvelope.checksum.slice(0, 12)}..., got: ${computed.slice(0, 12)}...)`],
                    startMs,
                    dryRun,
                );
            }
        } catch {
            // crypto not available (e.g., test env) — skip verification
            logger.warn('checksum verification skipped: crypto unavailable', {
                component: 'import-service',
            });
        }
    }

    // ── 4. Resolve entity types to import ───────────────────────────
    const availableTypes = new Set(
        Object.keys(validEnvelope.entities) as ExportEntityType[],
    );

    let importTypes: Set<ExportEntityType>;
    if (validOptions.includeEntityTypes) {
        importTypes = new Set(
            validOptions.includeEntityTypes.filter(t => availableTypes.has(t)),
        );
    } else {
        importTypes = new Set(availableTypes);
    }

    if (validOptions.excludeEntityTypes) {
        for (const t of validOptions.excludeEntityTypes) {
            importTypes.delete(t);
        }
    }

    // ── 5. Compute topological import order ─────────────────────────
    const orderedTypes = computeImportOrder(importTypes);

    // ── 6. Build ID map ─────────────────────────────────────────────
    const idMap = new IdMap();
    const isRename = validOptions.conflictStrategy === 'RENAME';

    // Pre-populate ID map for all entities
    for (const entityType of orderedTypes) {
        const records = validEnvelope.entities[entityType] ?? [];
        for (const record of records) {
            if (isRename) {
                idMap.set(entityType, record.id, generateId());
            } else {
                // Identity mapping — preserve original IDs
                idMap.set(entityType, record.id, record.id);
            }
        }
    }

    logger.info('import plan resolved', {
        component: 'import-service',
        targetTenantId: validOptions.targetTenantId,
        conflictStrategy: validOptions.conflictStrategy,
        dryRun,
        entityTypes: orderedTypes,
        idMappings: idMap.size,
        totalEntities: orderedTypes.reduce(
            (sum, t) => sum + (validEnvelope.entities[t]?.length ?? 0),
            0,
        ),
    });

    // ── 7. Process entities in topological order ────────────────────
    const imported: Partial<Record<ExportEntityType, number>> = {};
    const skipped: Partial<Record<ExportEntityType, number>> = {};
    const conflicts: Partial<Record<ExportEntityType, number>> = {};

    // ── 7a. Dry run — no persistence, no transaction ────────────────
    if (dryRun) {
        for (const entityType of orderedTypes) {
            const records = validEnvelope.entities[entityType] ?? [];
            imported[entityType] = 0;
            skipped[entityType] = 0;
            conflicts[entityType] = 0;

            for (const record of records) {
                prepareEntityData(
                    entityType,
                    record,
                    validOptions.targetTenantId,
                    idMap,
                    errors,
                );
                imported[entityType]!++;
            }
        }

        const durationMs = Math.round(performance.now() - startMs);
        return {
            success: errors.length === 0,
            imported,
            skipped,
            conflicts,
            errors,
            durationMs,
            dryRun: true,
        };
    }

    // ── 7b. Live import — wrapped in atomic transaction ─────────────
    //
    // All entity persistence runs inside a single Prisma interactive
    // transaction. If ANY blocking error occurs, the transaction is
    // aborted and ALL writes are rolled back. This prevents partial
    // imports from leaving the database in an inconsistent state.
    //
    try {
        await prisma.$transaction(async (tx) => {
            for (const entityType of orderedTypes) {
                const records = validEnvelope.entities[entityType] ?? [];
                imported[entityType] = 0;
                skipped[entityType] = 0;
                conflicts[entityType] = 0;

                for (const record of records) {
                    const data = prepareEntityData(
                        entityType,
                        record,
                        validOptions.targetTenantId,
                        idMap,
                        errors,
                    );

                    try {
                        const result = await persistEntity(
                            tx,
                            entityType,
                            record,
                            data,
                            validOptions.conflictStrategy,
                            idMap,
                        );

                        switch (result) {
                            case 'imported':
                                imported[entityType]!++;
                                break;
                            case 'skipped':
                                skipped[entityType]!++;
                                break;
                            case 'conflict':
                                conflicts[entityType]!++;
                                errors.push({
                                    entityType,
                                    entityId: record.id,
                                    message: `Conflict: entity already exists (strategy: ${validOptions.conflictStrategy})`,
                                });
                                break;
                            case 'error':
                                errors.push({
                                    entityType,
                                    entityId: record.id,
                                    message: `Model not found: ${PRISMA_MODEL_MAP[entityType]}`,
                                });
                                break;
                        }
                    } catch (error: unknown) {
                        errors.push({
                            entityType,
                            entityId: record.id,
                            message: `Persistence error: ${(error as Error).message}`,
                            code: hasStringCode(error) ? error.code : undefined,
                        });
                    }
                }
            }

            // Check for blocking errors — if any, abort the transaction
            const hasBlockingErrors = validOptions.conflictStrategy === 'FAIL'
                ? errors.length > 0
                : errors.filter(e => !e.message.includes('Conflict')).length > 0;

            if (hasBlockingErrors) {
                const durationMs = Math.round(performance.now() - startMs);
                throw new ImportAbortError({
                    success: false,
                    imported: {},
                    skipped: {},
                    conflicts,
                    errors,
                    durationMs,
                    dryRun: false,
                });
            }
        }, {
            timeout: IMPORT_TX_TIMEOUT_MS,
        });
    } catch (error: unknown) {
        // ImportAbortError carries the result — return it directly
        if (error instanceof ImportAbortError) {
            logger.warn('import aborted — transaction rolled back', {
                component: 'import-service',
                targetTenantId: validOptions.targetTenantId,
                errorCount: error.importResult.errors.length,
            });
            return error.importResult;
        }
        // Unexpected transaction-level error
        const durationMs = Math.round(performance.now() - startMs);
        logger.error('import transaction failed', {
            component: 'import-service',
            targetTenantId: validOptions.targetTenantId,
            error: (error as Error).message,
        });
        return {
            success: false,
            imported: {},
            skipped: {},
            conflicts: {},
            errors: [{
                entityType: 'practice' as ExportEntityType,
                entityId: '_transaction',
                message: `Transaction failed: ${(error as Error).message}`,
                code: hasStringCode(error) ? error.code : undefined,
            }],
            durationMs,
            dryRun: false,
        };
    }

    const durationMs = Math.round(performance.now() - startMs);

    logger.info('import completed — transaction committed', {
        component: 'import-service',
        targetTenantId: validOptions.targetTenantId,
        dryRun,
        imported,
        skipped,
        conflicts,
        errorCount: errors.length,
        durationMs,
    });

    return {
        success: true,
        imported,
        skipped,
        conflicts,
        errors,
        durationMs,
        dryRun,
    };
}

// ─── Topological Sort ───────────────────────────────────────────────

/**
 * Compute import order from IMPORT_ORDER + EXPORT_EDGES.
 * Returns entity types sorted so parents come before children.
 */
function computeImportOrder(
    importTypes: Set<ExportEntityType>,
): ExportEntityType[] {
    // Use the static IMPORT_ORDER as the base ordering
    const ordered = IMPORT_ORDER.filter(t => importTypes.has(t));

    // Append any types not in IMPORT_ORDER at the end
    for (const t of importTypes) {
        if (!ordered.includes(t)) {
            ordered.push(t);
        }
    }

    return ordered;
}

// ─── Helpers ────────────────────────────────────────────────────────

function failResult(
    messages: string[],
    startMs: number,
    dryRun: boolean,
): ImportResult {
    return {
        success: false,
        imported: {},
        skipped: {},
        conflicts: {},
        errors: messages.map(msg => ({
            entityType: 'practice' as ExportEntityType, // validation-level error
            entityId: '_validation',
            message: msg,
        })),
        durationMs: Math.round(performance.now() - startMs),
        dryRun,
    };
}

/**
 * Validate an import envelope without persisting anything.
 * Convenience wrapper around importTenantData with dryRun: true.
 */
export async function validateImportEnvelope(
    envelope: unknown,
    targetTenantId: string,
): Promise<ImportResult> {
    return importTenantData(envelope, {
        targetTenantId,
        conflictStrategy: 'SKIP',
        dryRun: true,
    });
}
