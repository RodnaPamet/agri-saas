/**
 * Export Schemas — Versioned Domain-Scoped Data Portability Contracts
 *
 * Defines the typed envelope, entity records, and relationship references
 * used by the export/import services. All exports are:
 *   - tenant-scoped (never cross-tenant)
 *   - domain-scoped (practice bundle, policy bundle, etc.)
 *   - versioned (format version tracked for migration between app versions)
 *
 * VERSIONING STRATEGY:
 *   - EXPORT_FORMAT_VERSION is bumped when the envelope shape changes
 *   - Each domain's entity schema carries its own schemaVersion
 *   - Import service validates both envelope + entity schema versions
 *   - Older versions can be migrated via version-specific upgrade functions
 *
 * ARCHITECTURE (inspired by CISO-Assistant domain-scoped export):
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ ExportEnvelope                                             │
 *   │  ├── formatVersion: '1.0'                                  │
 *   │  ├── metadata: { tenant, exportedAt, domain, appVersion }  │
 *   │  ├── entities: { practices: [...], policies: [...], ... }   │
 *   │  └── relationships: [ { from, to, type } ]                │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * @module app-layer/services/export-schemas
 */

// ─── Constants ──────────────────────────────────────────────────────

/** Envelope format version. Bump when the envelope shape changes. */
export const EXPORT_FORMAT_VERSION = '1.0' as const;

/** Application identifier for provenance tracking. */
export const APP_IDENTIFIER = 'inflect-compliance' as const;

// ─── Export Domain Scoping ──────────────────────────────────────────

/**
 * Domains that can be exported independently.
 * Each domain defines a rooted subgraph of the data model.
 */
export type ExportDomain =
    | 'CONTROLS'        // Practices + test plans + test runs + evidence links
    | 'POLICIES'        // Policies + versions + approvals
    | 'RISKS'           // Risks + risk assessments
    | 'EVIDENCE'        // Evidence items + file metadata + retention
    | 'TASKS'           // Tasks + task links
    | 'VENDORS'         // Vendors + reviews + subprocessors
    | 'FRAMEWORKS'      // Frameworks + requirements + mappings
    | 'FULL_TENANT';    // All domains for full tenant migration

/** Domains included when exporting FULL_TENANT. */
export const FULL_TENANT_DOMAINS: ExportDomain[] = [
    'CONTROLS',
    'POLICIES',
    'RISKS',
    'EVIDENCE',
    'TASKS',
    'VENDORS',
    'FRAMEWORKS',
];

// ─── Entity Types ───────────────────────────────────────────────────

/**
 * All entity types that can appear in an export bundle.
 * Used as keys in the ExportEnvelope.entities map.
 */
export type ExportEntityType =
    | 'practice'
    | 'practiceTestPlan'
    | 'practiceTestRun'
    | 'policy'
    | 'policyVersion'
    | 'risk'
    | 'evidence'
    | 'task'
    | 'taskLink'
    | 'vendor'
    | 'vendorReview'
    | 'vendorSubprocessor'
    | 'framework'
    | 'frameworkRequirement'
    | 'practiceMapping';

// ─── Envelope Types ─────────────────────────────────────────────────

/**
 * Metadata about this export — who, when, what, from where.
 */
export interface ExportMetadata {
    /** Source tenant ID (for validation, NOT for cross-tenant import). */
    tenantId: string;
    /** Human-readable tenant name for display. */
    tenantName?: string;
    /** ISO 8601 timestamp of when the export was created. */
    exportedAt: string;
    /** Which domain(s) are included in this export. */
    domains: ExportDomain[];
    /** Application identifier. */
    app: typeof APP_IDENTIFIER;
    /** Application version at time of export. */
    appVersion: string;
    /** User who initiated the export, if known. */
    exportedBy?: string;
    /** Optional description or notes. */
    description?: string;
}

/**
 * A single exported entity record.
 * Wraps the entity data with type/version metadata.
 */
export interface ExportEntityRecord<T = Record<string, unknown>> {
    /** Entity type (e.g. 'practice', 'policy'). */
    entityType: ExportEntityType;
    /** Original entity ID (used for relationship resolution). */
    id: string;
    /** Schema version for this entity type's data shape. */
    schemaVersion: string;
    /** The actual entity data. Sensitive fields may be redacted. */
    data: T;
}

/**
 * A relationship between two exported entities.
 * Used during import to reconstruct foreign keys.
 */
export interface ExportRelationship {
    /** Source entity type. */
    fromType: ExportEntityType;
    /** Source entity ID. */
    fromId: string;
    /** Target entity type. */
    toType: ExportEntityType;
    /** Target entity ID. */
    toId: string;
    /** Relationship semantics (e.g. 'BELONGS_TO', 'LINKED_TO', 'MAPS_TO'). */
    relationship: ExportRelationshipType;
}

export type ExportRelationshipType =
    | 'BELONGS_TO'      // Child → parent (e.g. testPlan → practice)
    | 'LINKED_TO'       // Soft link (e.g. taskLink → evidence)
    | 'MAPS_TO'         // Mapping (e.g. practice → requirement)
    | 'VERSION_OF'      // Version chain (e.g. policyVersion → policy)
    | 'REVIEWS';        // Review relationship (e.g. vendorReview → vendor)

/**
 * The top-level export envelope.
 * This is the complete, self-describing export bundle.
 */
export interface ExportEnvelope {
    /** Envelope format version. Used for forward/backward compat. */
    formatVersion: typeof EXPORT_FORMAT_VERSION;
    /** Export metadata. */
    metadata: ExportMetadata;
    /** Exported entities, grouped by type. */
    entities: Partial<Record<ExportEntityType, ExportEntityRecord[]>>;
    /** Relationships between entities (for dependency-aware import). */
    relationships: ExportRelationship[];
    /** Integrity checksum (SHA-256 of entities JSON, optional). */
    checksum?: string;
}

// ─── Import Types ───────────────────────────────────────────────────

/**
 * Options for an import operation.
 */
export interface ImportOptions {
    /** Target tenant ID. Required. */
    targetTenantId: string;
    /** How to handle ID conflicts with existing entities. */
    conflictStrategy: ImportConflictStrategy;
    /** If true, validate only — do not persist. */
    dryRun?: boolean;
    /** Specific entity types to import (default: all in envelope). */
    includeEntityTypes?: ExportEntityType[];
    /** Entity types to exclude from import. */
    excludeEntityTypes?: ExportEntityType[];
}

export type ImportConflictStrategy =
    | 'SKIP'            // Skip entities that already exist
    | 'OVERWRITE'       // Overwrite existing entities
    | 'RENAME'          // Create with new IDs (always safe)
    | 'FAIL';           // Abort on any conflict

/**
 * Result of an import operation.
 */
export interface ImportResult {
    /** Whether the import succeeded overall. */
    success: boolean;
    /** Number of entities imported, by type. */
    imported: Partial<Record<ExportEntityType, number>>;
    /** Number of entities skipped, by type. */
    skipped: Partial<Record<ExportEntityType, number>>;
    /** Number of entities that had conflicts, by type. */
    conflicts: Partial<Record<ExportEntityType, number>>;
    /** Errors encountered during import. */
    errors: ImportError[];
    /** Total duration in milliseconds. */
    durationMs: number;
    /** Whether this was a dry run. */
    dryRun: boolean;
}

export interface ImportError {
    entityType: ExportEntityType;
    entityId: string;
    message: string;
    /** Original error code if from Prisma/DB. */
    code?: string;
}

// ─── Validation ─────────────────────────────────────────────────────

/** All valid export domain values. */
const VALID_DOMAINS: Set<string> = new Set([
    'CONTROLS', 'POLICIES', 'RISKS', 'EVIDENCE',
    'TASKS', 'VENDORS', 'FRAMEWORKS', 'FULL_TENANT',
]);

/** All valid entity type values. */
const VALID_ENTITY_TYPES: Set<string> = new Set([
    'practice', 'practiceTestPlan', 'practiceTestRun',
    'policy', 'policyVersion',
    'risk',
    'evidence',
    'task', 'taskLink',
    'vendor', 'vendorReview', 'vendorSubprocessor',
    'framework', 'frameworkRequirement', 'practiceMapping',
]);

/** All valid relationship types. */
const VALID_RELATIONSHIP_TYPES: Set<string> = new Set([
    'BELONGS_TO', 'LINKED_TO', 'MAPS_TO', 'VERSION_OF', 'REVIEWS',
]);

/** All valid conflict strategies. */
const VALID_CONFLICT_STRATEGIES: Set<string> = new Set([
    'SKIP', 'OVERWRITE', 'RENAME', 'FAIL',
]);

export interface ValidationResult {
    valid: boolean;
    errors: string[];
}

/**
 * Validate an export envelope structure.
 * Checks format version, metadata, entity types, and relationships.
 * Does NOT validate individual entity data shapes.
 */
export function validateExportEnvelope(input: unknown): ValidationResult {
    const errors: string[] = [];

    if (!input || typeof input !== 'object') {
        return { valid: false, errors: ['Input is not an object'] };
    }

    const envelope = input as Record<string, unknown>;

    // Format version
    if (!envelope.formatVersion) {
        errors.push('Missing formatVersion');
    } else if (typeof envelope.formatVersion !== 'string') {
        errors.push('formatVersion must be a string');
    }

    // Metadata
    if (!envelope.metadata || typeof envelope.metadata !== 'object') {
        errors.push('Missing or invalid metadata');
    } else {
        const meta = envelope.metadata as Record<string, unknown>;
        if (!meta.tenantId || typeof meta.tenantId !== 'string') {
            errors.push('metadata.tenantId is required and must be a string');
        }
        if (!meta.exportedAt || typeof meta.exportedAt !== 'string') {
            errors.push('metadata.exportedAt is required and must be an ISO 8601 string');
        }
        if (!meta.app || typeof meta.app !== 'string') {
            errors.push('metadata.app is required');
        }
        if (!meta.appVersion || typeof meta.appVersion !== 'string') {
            errors.push('metadata.appVersion is required');
        }
        if (!Array.isArray(meta.domains) || meta.domains.length === 0) {
            errors.push('metadata.domains must be a non-empty array');
        } else {
            for (const d of meta.domains as string[]) {
                if (!VALID_DOMAINS.has(d)) {
                    errors.push(`Invalid domain: '${d}'`);
                }
            }
        }
    }

    // Entities
    if (!envelope.entities || typeof envelope.entities !== 'object') {
        errors.push('Missing or invalid entities');
    } else {
        const entities = envelope.entities as Record<string, unknown>;
        for (const [key, records] of Object.entries(entities)) {
            if (!VALID_ENTITY_TYPES.has(key)) {
                errors.push(`Unknown entity type: '${key}'`);
            }
            if (!Array.isArray(records)) {
                errors.push(`entities.${key} must be an array`);
            } else {
                for (let i = 0; i < records.length; i++) {
                    const rec = records[i] as Record<string, unknown>;
                    if (!rec.id || typeof rec.id !== 'string') {
                        errors.push(`entities.${key}[${i}].id is required`);
                    }
                    if (!rec.entityType || rec.entityType !== key) {
                        errors.push(`entities.${key}[${i}].entityType must be '${key}'`);
                    }
                    if (!rec.schemaVersion || typeof rec.schemaVersion !== 'string') {
                        errors.push(`entities.${key}[${i}].schemaVersion is required`);
                    }
                    if (!rec.data || typeof rec.data !== 'object') {
                        errors.push(`entities.${key}[${i}].data is required and must be an object`);
                    }
                }
            }
        }
    }

    // Relationships
    if (!Array.isArray(envelope.relationships)) {
        errors.push('relationships must be an array');
    } else {
        for (let i = 0; i < envelope.relationships.length; i++) {
            const rel = (envelope.relationships as Record<string, unknown>[])[i];
            if (!VALID_ENTITY_TYPES.has(rel.fromType as string)) {
                errors.push(`relationships[${i}].fromType is invalid: '${rel.fromType}'`);
            }
            if (!VALID_ENTITY_TYPES.has(rel.toType as string)) {
                errors.push(`relationships[${i}].toType is invalid: '${rel.toType}'`);
            }
            if (!VALID_RELATIONSHIP_TYPES.has(rel.relationship as string)) {
                errors.push(`relationships[${i}].relationship is invalid: '${rel.relationship}'`);
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Validate import options.
 */
export function validateImportOptions(input: unknown): ValidationResult {
    const errors: string[] = [];

    if (!input || typeof input !== 'object') {
        return { valid: false, errors: ['Input is not an object'] };
    }

    const opts = input as Record<string, unknown>;

    if (!opts.targetTenantId || typeof opts.targetTenantId !== 'string') {
        errors.push('targetTenantId is required and must be a string');
    }

    if (!opts.conflictStrategy || !VALID_CONFLICT_STRATEGIES.has(opts.conflictStrategy as string)) {
        errors.push(`conflictStrategy must be one of: ${[...VALID_CONFLICT_STRATEGIES].join(', ')}`);
    }

    if (opts.includeEntityTypes !== undefined) {
        if (!Array.isArray(opts.includeEntityTypes)) {
            errors.push('includeEntityTypes must be an array');
        } else {
            for (const t of opts.includeEntityTypes as string[]) {
                if (!VALID_ENTITY_TYPES.has(t)) {
                    errors.push(`Invalid includeEntityType: '${t}'`);
                }
            }
        }
    }

    if (opts.excludeEntityTypes !== undefined) {
        if (!Array.isArray(opts.excludeEntityTypes)) {
            errors.push('excludeEntityTypes must be an array');
        } else {
            for (const t of opts.excludeEntityTypes as string[]) {
                if (!VALID_ENTITY_TYPES.has(t)) {
                    errors.push(`Invalid excludeEntityType: '${t}'`);
                }
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Parse a format version string into major.minor components.
 * Accepts 'major.minor' format (e.g., '1.0', '2.3').
 *
 * @returns Parsed version or null if invalid
 */
export function parseFormatVersion(version: string): { major: number; minor: number } | null {
    if (typeof version !== 'string') return null;
    const match = version.match(/^(\d+)\.(\d+)$/);
    if (!match) return null;
    return { major: parseInt(match[1], 10), minor: parseInt(match[2], 10) };
}

/** Current app's format version, parsed. */
const CURRENT_VERSION = parseFormatVersion(EXPORT_FORMAT_VERSION)!;

/**
 * Version compatibility level returned by checkVersionCompatibility.
 *
 * - EXACT:        Same major.minor — fully compatible
 * - COMPATIBLE:   Same major, different minor — safe to import
 *                 (e.g., app v1.2 importing bundle v1.0)
 * - INCOMPATIBLE: Different major — breaking changes, reject
 * - INVALID:      Cannot parse version string
 */
export type VersionCompatibility = 'EXACT' | 'COMPATIBLE' | 'INCOMPATIBLE' | 'INVALID';

/**
 * Check detailed version compatibility between a bundle and the current app.
 *
 * Rules:
 *   - Same major.minor → EXACT (fully compatible)
 *   - Same major, different minor → COMPATIBLE (safe to import)
 *   - Different major → INCOMPATIBLE (reject)
 *   - Unparseable → INVALID (reject)
 *
 * @param bundleVersion - The format version from the import bundle
 * @returns Compatibility assessment with diagnostic details
 */
export function checkVersionCompatibility(bundleVersion: string): {
    level: VersionCompatibility;
    bundleVersion: string;
    appVersion: string;
    message: string;
} {
    const appVersion = EXPORT_FORMAT_VERSION;
    const parsed = parseFormatVersion(bundleVersion);

    if (!parsed) {
        return {
            level: 'INVALID',
            bundleVersion,
            appVersion,
            message: `Invalid format version '${bundleVersion}' — expected 'major.minor' (e.g., '1.0')`,
        };
    }

    if (parsed.major === CURRENT_VERSION.major && parsed.minor === CURRENT_VERSION.minor) {
        return {
            level: 'EXACT',
            bundleVersion,
            appVersion,
            message: `Exact match: bundle v${bundleVersion} matches app v${appVersion}`,
        };
    }

    if (parsed.major === CURRENT_VERSION.major) {
        return {
            level: 'COMPATIBLE',
            bundleVersion,
            appVersion,
            message: `Compatible: bundle v${bundleVersion} shares major version with app v${appVersion}`,
        };
    }

    return {
        level: 'INCOMPATIBLE',
        bundleVersion,
        appVersion,
        message: `Incompatible: bundle v${bundleVersion} has different major version than app v${appVersion}`,
    };
}

/**
 * Check if a format version is compatible with this app version.
 *
 * Accepts any version with the same major version (semver-compatible).
 * Rejects different majors (breaking changes) and invalid strings.
 *
 * @param version - Bundle format version string
 * @returns true if the version is importable
 */
export function isFormatVersionSupported(version: string): boolean {
    const compat = checkVersionCompatibility(version);
    return compat.level === 'EXACT' || compat.level === 'COMPATIBLE';
}

/**
 * Domain → entity type mapping.
 * Defines which entity types belong to each export domain.
 */
export const DOMAIN_ENTITY_MAP: Record<ExportDomain, ExportEntityType[]> = {
    CONTROLS: ['practice', 'practiceTestPlan', 'practiceTestRun', 'practiceMapping'],
    POLICIES: ['policy', 'policyVersion'],
    RISKS: ['risk'],
    EVIDENCE: ['evidence'],
    TASKS: ['task', 'taskLink'],
    VENDORS: ['vendor', 'vendorReview', 'vendorSubprocessor'],
    FRAMEWORKS: ['framework', 'frameworkRequirement'],
    FULL_TENANT: [
        'practice', 'practiceTestPlan', 'practiceTestRun', 'practiceMapping',
        'policy', 'policyVersion',
        'risk',
        'evidence',
        'task', 'taskLink',
        'vendor', 'vendorReview', 'vendorSubprocessor',
        'framework', 'frameworkRequirement',
    ],
};

/**
 * Import ordering — entity types sorted by dependency.
 * Parents must be imported before children.
 * Used by the import service for topological ordering.
 */
export const IMPORT_ORDER: ExportEntityType[] = [
    // 1. Independent root entities (no FK dependencies on other exported types)
    'framework',
    'frameworkRequirement',
    // 2. Core compliance entities
    'practice',
    'policy',
    'risk',
    'evidence',
    'vendor',
    // 3. Child entities (depend on parents above)
    'practiceTestPlan',
    'practiceTestRun',
    'practiceMapping',
    'policyVersion',
    'vendorReview',
    'vendorSubprocessor',
    'task',
    'taskLink',
];
