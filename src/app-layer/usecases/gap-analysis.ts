/**
 * Cross-Framework Gap Analysis Usecase
 *
 * Product-facing app-layer service that bridges persisted requirement mappings
 * to the resolution engine and traceability/gap-analysis business logic.
 *
 * This is the primary consumer-facing entry point for:
 * 1. "What does requirement X in framework A imply for framework B?"
 * 2. "What's my cross-framework coverage and where are the gaps?"
 * 3. "What mapping sets are available?"
 *
 * Architecture:
 * ─────────────
 *   API Route / Report Generator / Admin UI
 *       │
 *       ▼
 *   gap-analysis usecase (this file)
 *       │
 *       ├── RequirementMappingRepository  (persisted edges)
 *       ├── mapping-resolution.ts         (BFS traversal engine)
 *       └── cross-framework-traceability  (business semantics)
 *
 * Design decisions:
 * - Mappings are GLOBAL reference data (no tenant scoping on mapping reads)
 * - Framework requirement lookups are also global (frameworks are shared)
 * - All output preserves semantic nuance (strength, confidence, rationale)
 * - Output is structured for UI consumption (sorted, explained, summarized)
 * - Conservative: never overclaims compliance from partial mappings
 */

import type { PrismaTx } from '@/lib/db-context';
import { runInGlobalContext } from '@/lib/db-context';
import { RequirementMappingRepository } from '../repositories/RequirementMappingRepository';
import type { ResolvedMappingEdge, MappingStrengthValue } from '../domain/requirement-mapping.types';
import { resolveMapping, type MappingEdgeLoader } from '../services/mapping-resolution';
import {
    buildTraceabilityReport,
    analyzeGaps,
    strengthToConfidence,
    isActionableCoverage,
    type TraceabilityReport,
    type GapAnalysisResult,
    type CoverageConfidence,
} from '../services/cross-framework-traceability';
import { logger } from '@/lib/observability/logger';

// ─── Edge Loader Factory ─────────────────────────────────────────────

/**
 * Create a MappingEdgeLoader backed by the persisted RequirementMapping table.
 *
 * This is the bridge between the database and the resolution engine:
 * - Loads all outgoing edges from a given source requirement
 * - Returns denormalized ResolvedMappingEdge DTOs
 * - The resolution engine uses this to perform BFS traversal
 *
 * NOTE: This is the uncached variant. For batch operations (gap analysis),
 * prefer createCachedDbEdgeLoader() to avoid redundant DB hits when
 * multiple BFS traversals expand the same intermediate nodes.
 */
export function createDbEdgeLoader(db: PrismaTx): MappingEdgeLoader {
    return async (sourceRequirementId: string): Promise<ResolvedMappingEdge[]> => {
        const rawMappings = await RequirementMappingRepository.findBySourceRequirement(db, {
            sourceRequirementId,
        });
        return rawMappings.map(RequirementMappingRepository.resolveEdge);
    };
}

/**
 * Create a REVERSE MappingEdgeLoader backed by persisted data.
 *
 * Instead of loading outgoing edges FROM a source requirement,
 * this loader finds all edges TARGETING a given requirement.
 * The returned edges are flipped (source ↔ target) so the BFS
 * traversal walks the graph in reverse.
 *
 * Strength is preserved but not upgraded — reverse traversal
 * uses the same conservative semantics.
 */
export function createReverseDbEdgeLoader(db: PrismaTx): MappingEdgeLoader {
    return async (targetRequirementId: string): Promise<ResolvedMappingEdge[]> => {
        const rawMappings = await RequirementMappingRepository.findByTargetRequirement(db, {
            targetRequirementId,
        });
        // Flip source ↔ target so BFS sees "outgoing" edges in reverse direction
        return rawMappings.map(raw => {
            const edge = RequirementMappingRepository.resolveEdge(raw);
            return {
                ...edge,
                source: edge.target,
                target: edge.source,
            };
        });
    };
}

/**
 * Create a CACHED REVERSE MappingEdgeLoader for batch operations.
 * Combines reverse-direction loading with in-memory caching.
 */
export function createCachedReverseDbEdgeLoader(db: PrismaTx): MappingEdgeLoader {
    const cache = new Map<string, ResolvedMappingEdge[]>();
    return async (targetRequirementId: string): Promise<ResolvedMappingEdge[]> => {
        const cached = cache.get(targetRequirementId);
        if (cached) return cached;

        const rawMappings = await RequirementMappingRepository.findByTargetRequirement(db, {
            targetRequirementId,
        });
        const edges = rawMappings.map(raw => {
            const edge = RequirementMappingRepository.resolveEdge(raw);
            return {
                ...edge,
                source: edge.target,
                target: edge.source,
            };
        });
        cache.set(targetRequirementId, edges);
        return edges;
    };
}

/**
 * Create a CACHED MappingEdgeLoader for batch operations.
 *
 * During gap analysis, multiple BFS traversals may expand the same
 * intermediate requirement nodes. This loader caches the results of
 * each DB query in memory so the same requirement's edges are only
 * fetched once per analysis run.
 *
 * The cache is scoped to the loader instance — no cross-request leakage.
 */
export function createCachedDbEdgeLoader(db: PrismaTx): MappingEdgeLoader {
    const cache = new Map<string, ResolvedMappingEdge[]>();
    return async (sourceRequirementId: string): Promise<ResolvedMappingEdge[]> => {
        const cached = cache.get(sourceRequirementId);
        if (cached) return cached;

        const rawMappings = await RequirementMappingRepository.findBySourceRequirement(db, {
            sourceRequirementId,
        });
        const edges = rawMappings.map(RequirementMappingRepository.resolveEdge);
        cache.set(sourceRequirementId, edges);
        return edges;
    };
}

// ─── Available Mapping Sets ──────────────────────────────────────────

/**
 * Summary of a mapping set available for gap analysis.
 */
export interface MappingSetSummary {
    readonly id: string;
    readonly name: string;
    readonly description: string | null;
    readonly sourceFramework: {
        readonly id: string;
        readonly key: string;
        readonly name: string;
    };
    readonly targetFramework: {
        readonly id: string;
        readonly key: string;
        readonly name: string;
    };
    readonly mappingCount: number;
    readonly version: number;
}

/**
 * List all available mapping sets with framework info and entry counts.
 * This is the "what's available" query for UI framework-pair selection.
 */
export async function listAvailableMappingSets(
    db?: PrismaTx,
): Promise<MappingSetSummary[]> {
    const run = async (dbCtx: PrismaTx) => {
        const sets = await RequirementMappingRepository.listMappingSets(dbCtx);
        return sets.map(s => ({
            id: s.id,
            name: s.name,
            description: s.description,
            sourceFramework: s.sourceFramework,
            targetFramework: s.targetFramework,
            mappingCount: s._count.mappings,
            version: s.version,
        }));
    };

    return db ? run(db) : runInGlobalContext(run);
}

// ─── Single Requirement Traceability ─────────────────────────────────

/**
 * Input for a single-requirement traceability query.
 */
export interface RequirementTraceabilityInput {
    /** Source requirement ID (FrameworkRequirement.id) */
    readonly sourceRequirementId: string;
    /** Target framework key to analyze against */
    readonly targetFrameworkKey: string;
    /** Maximum traversal depth (default 3, max 10) */
    readonly maxDepth?: number;
}

/**
 * Resolve traceability for a single requirement against a target framework.
 *
 * "If I'm compliant with requirement X in framework A,
 *  what does that imply for framework B?"
 *
 * Returns a fully structured TraceabilityReport with:
 * - Individual findings with confidence levels
 * - Edge chains for auditability
 * - Human-readable explanations
 * - Summary statistics
 */
export async function getRequirementTraceability(
    input: RequirementTraceabilityInput,
    db?: PrismaTx,
): Promise<TraceabilityReport> {
    const component = 'gap-analysis';

    const run = async (dbCtx: PrismaTx) => {
        const loader = createDbEdgeLoader(dbCtx);

        // Use the resolution engine + traceability service
        const trace = await resolveMapping(
            {
                sourceRequirementId: input.sourceRequirementId,
                targetFrameworkKeys: [input.targetFrameworkKey],
                maxDepth: input.maxDepth,
            },
            loader,
        );

        const report = buildTraceabilityReport(trace, input.targetFrameworkKey);

        logger.info('Requirement traceability resolved', {
            component,
            sourceRequirementId: input.sourceRequirementId,
            targetFrameworkKey: input.targetFrameworkKey,
            findings: report.summary.totalFindings,
            bestConfidence: report.summary.bestConfidence,
        });

        return report;
    };

    return db ? run(db) : runInGlobalContext(run);
}

// ─── Framework Pair Mapping List ─────────────────────────────────────

/**
 * A single mapping edge in the framework-pair listing.
 * Structured for direct UI consumption.
 */
export interface MappingEdgeView {
    readonly id: string;
    readonly sourceRequirement: {
        readonly id: string;
        readonly code: string;
        readonly title: string;
    };
    readonly targetRequirement: {
        readonly id: string;
        readonly code: string;
        readonly title: string;
    };
    readonly strength: MappingStrengthValue;
    readonly confidence: CoverageConfidence;
    readonly isActionable: boolean;
    readonly rationale: string | null;
}

/**
 * Result of listing mappings for a framework pair.
 */
export interface FrameworkPairMappings {
    readonly sourceFramework: { readonly key: string; readonly name: string };
    readonly targetFramework: { readonly key: string; readonly name: string };
    readonly mappings: readonly MappingEdgeView[];
    readonly summary: {
        readonly total: number;
        readonly byStrength: Record<MappingStrengthValue, number>;
        readonly actionableCount: number;
    };
}

/**
 * List all mappings between two frameworks with business-semantic annotations.
 *
 * This is the "show me the mapping table" query for browsing all edges
 * between a source and target framework.
 */
export async function getFrameworkPairMappings(
    sourceFrameworkKey: string,
    targetFrameworkKey: string,
    db?: PrismaTx,
): Promise<FrameworkPairMappings | null> {
    const component = 'gap-analysis';

    const run = async (dbCtx: PrismaTx) => {
        // Resolve framework IDs from keys (key has @unique constraint)
        const sourceFw = await dbCtx.framework.findFirst({
            // `findFirst`, not `findUnique`: the single-column unique on
            // `key` was dropped so two revisions of a standard can coexist.
            // Newest version first — a caller that names no version means
            // "the current one".
            where: { key: sourceFrameworkKey },
            orderBy: { version: 'desc' },
            select: { id: true, key: true, name: true },
        });
        const targetFw = await dbCtx.framework.findFirst({
            // `findFirst`, not `findUnique`: the single-column unique on
            // `key` was dropped so two revisions of a standard can coexist.
            // Newest version first — a caller that names no version means
            // "the current one".
            where: { key: targetFrameworkKey },
            orderBy: { version: 'desc' },
            select: { id: true, key: true, name: true },
        });

        if (!sourceFw || !targetFw) {
            logger.warn('Framework pair not found for mapping query', {
                component,
                sourceFrameworkKey,
                targetFrameworkKey,
                sourceFound: !!sourceFw,
                targetFound: !!targetFw,
            });
            return null;
        }

        const rawMappings = await RequirementMappingRepository.findByFrameworkPair(dbCtx, {
            sourceFrameworkId: sourceFw.id,
            targetFrameworkId: targetFw.id,
        });

        const mappings: MappingEdgeView[] = rawMappings.map(raw => {
            const edge = RequirementMappingRepository.resolveEdge(raw);
            const confidence = strengthToConfidence(edge.strength);
            return {
                id: edge.id,
                sourceRequirement: {
                    id: edge.source.requirementId,
                    code: edge.source.requirementCode,
                    title: edge.source.requirementTitle,
                },
                targetRequirement: {
                    id: edge.target.requirementId,
                    code: edge.target.requirementCode,
                    title: edge.target.requirementTitle,
                },
                strength: edge.strength,
                confidence,
                isActionable: isActionableCoverage(confidence),
                rationale: edge.rationale,
            };
        });

        // Compute strength distribution
        const byStrength: Record<MappingStrengthValue, number> = {
            EQUAL: 0, SUPERSET: 0, SUBSET: 0, INTERSECT: 0, RELATED: 0,
        };
        for (const m of mappings) {
            byStrength[m.strength]++;
        }

        logger.info('Framework pair mappings listed', {
            component,
            sourceFrameworkKey,
            targetFrameworkKey,
            total: mappings.length,
        });

        return {
            sourceFramework: { key: sourceFw.key, name: sourceFw.name },
            targetFramework: { key: targetFw.key, name: targetFw.name },
            mappings,
            summary: {
                total: mappings.length,
                byStrength,
                actionableCount: mappings.filter(m => m.isActionable).length,
            },
        };
    };

    return db ? run(db) : runInGlobalContext(run);
}

// ─── Cross-Framework Gap Analysis ────────────────────────────────────

/**
 * Input for a full cross-framework gap analysis.
 */
export interface GapAnalysisInput {
    /** Source framework key (where the customer has compliance posture) */
    readonly sourceFrameworkKey: string;
    /** Target framework key (what coverage is being assessed) */
    readonly targetFrameworkKey: string;
    /** Maximum traversal depth for transitive resolution (default 3) */
    readonly maxDepth?: number;
    /** Pagination: maximum number of target requirements to include in results */
    readonly limit?: number;
    /** Pagination: number of target requirements to skip before results */
    readonly offset?: number;
    /**
     * Include non-assessable requirements (section headers, grouping nodes).
     * Default: false (only assessable leaf requirements are analyzed).
     * Set to true when mapping data references non-assessable parent nodes.
     */
    readonly includeNonAssessable?: boolean;
}

/**
 * Perform full cross-framework gap analysis.
 *
 * "Given my compliance posture in framework A,
 *  which requirements in framework B still need attention?"
 *
 * Resolves ALL source requirements against ALL target requirements and
 * determines per-requirement gap status with conservative semantics:
 * - COVERED: FULL or HIGH confidence (EQUAL, SUPERSET)
 * - PARTIALLY_COVERED: PARTIAL or OVERLAP (SUBSET, INTERSECT)
 * - REVIEW_NEEDED: INFORMATIONAL only (RELATED)
 * - NOT_COVERED: No applicable mapping
 *
 * Output is structured for direct UI consumption:
 * - Sorted gaps-first (NOT_COVERED at top)
 * - Includes explanations and source/target info
 * - Summary with coverage percentages
 */
export async function performGapAnalysis(
    input: GapAnalysisInput,
    db?: PrismaTx,
): Promise<GapAnalysisResult | null> {
    const component = 'gap-analysis';

    const run = async (dbCtx: PrismaTx) => {
        // 1. Resolve framework IDs (key has @unique constraint)
        const sourceFw = await dbCtx.framework.findFirst({
            // `findFirst`: `key` is no longer singly-unique (two
            // revisions of a standard may coexist). Newest first.
            where: { key: input.sourceFrameworkKey },
            orderBy: { version: 'desc' },
            select: { id: true, key: true, name: true },
        });
        const targetFw = await dbCtx.framework.findFirst({
            // `findFirst`: `key` is no longer singly-unique (two
            // revisions of a standard may coexist). Newest first.
            where: { key: input.targetFrameworkKey },
            orderBy: { version: 'desc' },
            select: { id: true, key: true, name: true },
        });

        if (!sourceFw || !targetFw) {
            logger.warn('Framework pair not found for gap analysis', {
                component,
                sourceFrameworkKey: input.sourceFrameworkKey,
                targetFrameworkKey: input.targetFrameworkKey,
            });
            return null;
        }

        // 2. Load requirements from both frameworks
        // By default, only assessable (leaf) requirements are analyzed.
        // Set includeNonAssessable=true when mapping data references parent nodes.
        const assessableFilter = input.includeNonAssessable ? {} : { assessable: true };

        const sourceReqs = await dbCtx.frameworkRequirement.findMany({
            where: { frameworkId: sourceFw.id, ...assessableFilter },
            select: { id: true, code: true, title: true },
            orderBy: { code: 'asc' },
        });

        let targetReqs = await dbCtx.frameworkRequirement.findMany({
            where: { frameworkId: targetFw.id, ...assessableFilter },
            select: { id: true, code: true, title: true },
            orderBy: { code: 'asc' },
        });

        if (sourceReqs.length === 0 || targetReqs.length === 0) {
            logger.warn('No assessable requirements found for gap analysis', {
                component,
                sourceFrameworkKey: input.sourceFrameworkKey,
                targetFrameworkKey: input.targetFrameworkKey,
                sourceCount: sourceReqs.length,
                targetCount: targetReqs.length,
            });
            return null;
        }

        // 3. Apply pagination if specified
        if (input.offset) {
            targetReqs = targetReqs.slice(input.offset);
        }
        if (input.limit) {
            targetReqs = targetReqs.slice(0, input.limit);
        }

        // 4. Create CACHED DB-backed edge loader for batch efficiency
        // Multiple BFS traversals share intermediate nodes — caching avoids
        // redundant DB hits across source requirement resolutions.
        const loader = createCachedDbEdgeLoader(dbCtx);

        // 5. Run gap analysis through the business logic layer
        const sourceIds = sourceReqs.map(r => r.id);
        const targetReqInputs = targetReqs.map(r => ({
            requirementId: r.id,
            requirementCode: r.code,
            requirementTitle: r.title ?? r.code,
            frameworkKey: targetFw.key,
            frameworkName: targetFw.name,
        }));

        const result = await analyzeGaps(
            sourceIds,
            targetReqInputs,
            sourceFw.key,
            targetFw.key,
            loader,
            { maxDepth: input.maxDepth },
        );

        logger.info('Gap analysis completed', {
            component,
            sourceFrameworkKey: input.sourceFrameworkKey,
            targetFrameworkKey: input.targetFrameworkKey,
            totalTargetRequirements: result.summary.totalTargetRequirements,
            covered: result.summary.covered,
            partiallyCovered: result.summary.partiallyCovered,
            notCovered: result.summary.notCovered,
            coveragePercent: result.summary.coveragePercent,
        });

        return result;
    };

    return db ? run(db) : runInGlobalContext(run);
}
