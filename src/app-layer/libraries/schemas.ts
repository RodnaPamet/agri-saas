/**
 * Framework Library YAML Schema Definitions
 *
 * Defines the canonical schema for YAML-based framework library files.
 * Each YAML file represents one compliance framework (e.g., ISO 27001, NIST CSF, SOC 2).
 *
 * Architecture:
 *   YAML file → StoredLibrary (raw parsed) → LoadedLibrary (runtime-normalized)
 *
 * The two-phase approach ensures:
 * 1. YAML is validated against a strict schema (StoredLibrary)
 * 2. Runtime objects are normalized, indexed, and optimized for lookup (LoadedLibrary)
 */
import { z } from 'zod';

// ─── URN Format ──────────────────────────────────────────────────────
// URNs provide globally unique, stable identifiers for requirements.
// Format: urn:<namespace>:<type>:<framework-key>:<node-id>
// Example: urn:inflect:req:iso27001-2022:a.5.1

const UrnSchema = z.string().regex(
    /^urn:[a-z0-9-]+:[a-z0-9-]+:[a-z0-9._-]+(:[a-z0-9._-]+)*$/i,
    'URN must match format: urn:<namespace>:<type>:<identifier>[:<sub-id>...]'
);

// ─── Framework Kind ──────────────────────────────────────────────────
// Extensible enum for categorizing frameworks by their standards body type.

export const FrameworkKindSchema = z.enum([
    'ISO_STANDARD',
    'NIST_FRAMEWORK',
    'SOC_CRITERIA',
    'EU_DIRECTIVE',
    'REGULATION',
    'INDUSTRY_STANDARD',
    'CUSTOM',
]);

export type FrameworkKind = z.infer<typeof FrameworkKindSchema>;

// ─── Mapping Strength ────────────────────────────────────────────────
// Defines the strength of a mapping between two requirement nodes.

export const MappingStrengthSchema = z.enum([
    'EQUAL',      // Semantically equivalent
    'SUPERSET',   // Source fully covers target
    'SUBSET',     // Source partially covers target
    'INTERSECT',  // Partial overlap
    'RELATED',    // Conceptually related but not equivalent
]);

export type MappingStrength = z.infer<typeof MappingStrengthSchema>;

// ─── Score Definition ────────────────────────────────────────────────
// Optional scoring rubric for maturity/compliance assessments.

export const ScoreDefinitionSchema = z.object({
    score: z.number().int().min(0),
    name: z.string().min(1),
    description: z.string().optional(),
});

export type ScoreDefinition = z.infer<typeof ScoreDefinitionSchema>;

// ─── Requirement Node ────────────────────────────────────────────────
// A single requirement, practice, or criterion within a framework.
// Nodes form a tree via parent_urn references.

export const RequirementNodeSchema = z.object({
    /** Globally unique URN for this requirement node */
    urn: UrnSchema,
    /** Reference ID as defined by the standard (e.g., "A.5.1", "GV.OC-01") */
    ref_id: z.string().min(1),
    /** Human-readable name/title */
    name: z.string().optional(),
    /** Description of the requirement */
    description: z.string().optional(),
    /** Additional guidance, annotations, or examples */
    annotation: z.string().optional(),
    /** URN of the parent node (for hierarchical structure) */
    parent_urn: UrnSchema.optional(),
    /** Depth in the hierarchy (1 = top-level category) */
    depth: z.number().int().min(1).default(1),
    /** Whether this node is directly assessable (leaf) or a grouping node */
    assessable: z.boolean().default(true),
    /** Thematic category for grouping (e.g., "Organizational", "Technological") */
    category: z.string().optional(),
    /** Section identifier for organizational grouping */
    section: z.string().optional(),
    /** Comma-separated list of expected evidence/artifacts for this requirement */
    artifacts: z.string().optional(),
    /** Ordered checklist items for implementing this requirement */
    checklist: z.array(z.string()).optional(),
});

export type RequirementNode = z.infer<typeof RequirementNodeSchema>;

// ─── Cross-Framework Mapping Entry ───────────────────────────────────
// Defines a mapping between requirement nodes across different frameworks.

export const MappingEntrySchema = z.object({
    /** URN of the source requirement */
    source_urn: UrnSchema,
    /** URN of the target requirement */
    target_urn: UrnSchema,
    /** Strength of the mapping relationship */
    strength: MappingStrengthSchema.default('RELATED'),
    /** Explanation of why this mapping exists */
    rationale: z.string().optional(),
});

export type MappingEntry = z.infer<typeof MappingEntrySchema>;

// ─── Framework Metadata ──────────────────────────────────────────────
// Top-level metadata for the framework within the objects block.

export const FrameworkObjectSchema = z.object({
    /** URN for this framework object */
    urn: UrnSchema,
    /** Reference identifier (e.g., "ISO27001-2022", "NIST-CSF-2.0") */
    ref_id: z.string().min(1),
    /** Display name */
    name: z.string().min(1),
    /** Description of the framework */
    description: z.string().optional(),
    /** Minimum assessment score (if scoring is used) */
    min_score: z.number().int().optional(),
    /** Maximum assessment score (if scoring is used) */
    max_score: z.number().int().optional(),
    /** Score level definitions */
    scores_definition: z.array(ScoreDefinitionSchema).optional(),
    /** Ordered list of requirement nodes forming the framework tree */
    requirement_nodes: z.array(RequirementNodeSchema).min(1),
});

export type FrameworkObject = z.infer<typeof FrameworkObjectSchema>;

// ─── Stored Library (Raw YAML root) ──────────────────────────────────
// This is the shape of a single YAML framework library file.
// It maps 1:1 with the file contents after YAML parsing.

export const StoredLibrarySchema = z.object({
    /** Globally unique URN for this library */
    urn: UrnSchema,
    /** ISO 639-1 locale code (e.g., "en") */
    locale: z.string().min(2).max(5).default('en'),
    /** Reference identifier for the standard */
    ref_id: z.string().min(1),
    /** Display name of the library */
    name: z.string().min(1),
    /** Description of what this library covers */
    description: z.string().optional(),
    /** Copyright and licensing information */
    copyright: z.string().optional(),
    /** Monotonically increasing version integer */
    version: z.number().int().min(1),
    /** Date this library version was published (ISO 8601) */
    publication_date: z.string().optional(),
    /** Organization/body that created the standard */
    provider: z.string().optional(),
    /** Organization that packaged the library */
    packager: z.string().optional(),
    /** Kind of framework for categorization */
    kind: FrameworkKindSchema.default('ISO_STANDARD'),
    /** URNs of libraries this one depends on */
    dependencies: z.array(UrnSchema).optional(),
    /** The framework objects contained in this library */
    objects: z.object({
        framework: FrameworkObjectSchema,
        /** Optional cross-framework mappings bundled with this library */
        mappings: z.array(MappingEntrySchema).optional(),
    }),
});

export type StoredLibrary = z.infer<typeof StoredLibrarySchema>;
