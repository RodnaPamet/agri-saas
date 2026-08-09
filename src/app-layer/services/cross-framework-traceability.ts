/**
 * Cross-Framework Traceability & Gap Analysis Service
 *
 * Applies conservative business semantics on top of the raw mapping
 * resolution engine to answer product-level questions:
 *
 * 1. TRACEABILITY — "If I'm compliant with requirement X in framework A,
 *                   what does that imply for framework B?"
 *
 * 2. GAP ANALYSIS — "Given my compliance posture in framework A,
 *                   which requirements in framework B still need attention?"
 *
 * Key design principle: Mappings support traceability and partial reasoning,
 * NOT automatic compliance. This service carefully distinguishes between:
 *   - Strong traceability (EQUAL)       → requirement fully satisfied
 *   - Partial coverage (SUPERSET)       → target likely satisfied, verify scope
 *   - Partial coverage (SUBSET)         → gap remains, source doesn't fully cover target
 *   - Overlap (INTERSECT)               → shared ground, explicit review needed
 *   - Informational (RELATED)           → awareness only, no coverage claim
 *
 * This service does NOT interact with the database directly. It consumes
 * the MappingTraceResult from the resolution engine and applies business
 * interpretation logic. DB-backed usecases wrap this service.
 */

import {
    type MappingStrengthValue,
} from '../domain/requirement-mapping.types';
import type {
    MappingTraceResult,
    MappingPath,
    MappingEdgeLoader,
    TraceabilityQuery,
} from './mapping-resolution';
import { resolveMapping, resolveMappingBatch } from './mapping-resolution';

// ─── Coverage Confidence ─────────────────────────────────────────────

/**
 * Conservative coverage confidence levels derived from mapping strength.
 *
 * These replace raw strength values with product-meaningful interpretations
 * that prevent overclaiming compliance.
 */
export type CoverageConfidence =
    | 'FULL'         // EQUAL: requirement is semantically equivalent
    | 'HIGH'         // SUPERSET: source fully covers target, but verify scope
    | 'PARTIAL'      // SUBSET: source only partially covers target
    | 'OVERLAP'      // INTERSECT: shared ground but neither covers the other
    | 'INFORMATIONAL' // RELATED: conceptually related, no coverage claim
    | 'NONE';        // No mapping exists

/**
 * Map a mapping strength to a conservative coverage confidence level.
 *
 * Business rules:
 * - EQUAL → FULL:          Both requirements express the same obligation.
 *                          Implementing source fully satisfies target.
 * - SUPERSET → HIGH:       Source is broader than target.
 *                          Implementing source likely satisfies target,
 *                          but scope should be verified.
 * - SUBSET → PARTIAL:      Source is narrower than target.
 *                          Implementing source only partially satisfies target.
 *                          Gap remains.
 * - INTERSECT → OVERLAP:   Partial overlap. Neither fully covers the other.
 *                          Explicit review by compliance team needed.
 * - RELATED → INFORMATIONAL: Conceptually related but no direct coverage
 *                          claim can be made. For awareness only.
 */
export function strengthToConfidence(strength: MappingStrengthValue): CoverageConfidence {
    switch (strength) {
        case 'EQUAL':     return 'FULL';
        case 'SUPERSET':  return 'HIGH';
        case 'SUBSET':    return 'PARTIAL';
        case 'INTERSECT': return 'OVERLAP';
        case 'RELATED':   return 'INFORMATIONAL';
        default:          return 'NONE';
    }
}

/**
 * Numeric ranking for coverage confidence (for sorting/filtering).
 * Higher = more confidence.
 */
export const CONFIDENCE_RANK: Record<CoverageConfidence, number> = {
    FULL: 5,
    HIGH: 4,
    PARTIAL: 3,
    OVERLAP: 2,
    INFORMATIONAL: 1,
    NONE: 0,
};

/**
 * Whether a coverage confidence level represents actionable coverage
 * (i.e., some degree of actual compliance contribution, not just awareness).
 *
 * FULL and HIGH = "covered" (strong/likely)
 * PARTIAL and OVERLAP = "partially covered" (work remains)
 * INFORMATIONAL and NONE = "not covered" (no claim)
 */
export function isActionableCoverage(confidence: CoverageConfidence): boolean {
    return confidence === 'FULL' || confidence === 'HIGH';
}

/**
 * Whether a confidence level represents any form of partial or better coverage.
 * Used for "soft" gap analysis that counts partial coverage.
 */
export function hasAnyCoverage(confidence: CoverageConfidence): boolean {
    return confidence !== 'NONE' && confidence !== 'INFORMATIONAL';
}

// ─── Traceability Result Types ───────────────────────────────────────

/** Human-readable explanation of a mapping relationship. */
export interface TraceabilityExplanation {
    /** Short summary, e.g. "Fully equivalent" or "Partial overlap — review needed" */
    readonly summary: string;
    /** Detailed explanation with rationale chain */
    readonly detail: string;
    /** Whether the customer should take action */
    readonly actionRequired: boolean;
    /** Suggested action if any */
    readonly suggestedAction: string | null;
}

/**
 * A single traceability finding — one source requirement mapped to one
 * target requirement with business-interpreted semantics.
 */
export interface TraceabilityFinding {
    /** Source requirement */
    readonly source: {
        readonly requirementId: string;
        readonly requirementCode: string;
        readonly requirementTitle: string;
        readonly frameworkKey: string;
        readonly frameworkName: string;
    };
    /** Target requirement */
    readonly target: {
        readonly requirementId: string;
        readonly requirementCode: string;
        readonly requirementTitle: string;
        readonly frameworkKey: string;
        readonly frameworkName: string;
    };
    /** Raw mapping strength (from resolution engine) */
    readonly mappingStrength: MappingStrengthValue;
    /** Conservative coverage confidence (business interpretation) */
    readonly confidence: CoverageConfidence;
    /** Numeric confidence rank */
    readonly confidenceRank: number;
    /** Whether this represents actionable coverage (FULL or HIGH) */
    readonly isActionable: boolean;
    /** Whether this is a direct or transitive mapping */
    readonly isDirect: boolean;
    /** Traversal depth */
    readonly depth: number;
    /** Human-readable explanation */
    readonly explanation: TraceabilityExplanation;
    /** Full edge chain for auditability */
    readonly edgeChain: readonly {
        readonly fromCode: string;
        readonly fromFramework: string;
        readonly toCode: string;
        readonly toFramework: string;
        readonly strength: MappingStrengthValue;
        readonly rationale: string | null;
    }[];
}

/**
 * Complete traceability report for a source requirement against a
 * target framework.
 */
export interface TraceabilityReport {
    /** Source requirement being analyzed */
    readonly source: {
        readonly requirementId: string;
        readonly requirementCode: string;
        readonly requirementTitle: string;
        readonly frameworkKey: string;
        readonly frameworkName: string;
    };
    /** Target framework key */
    readonly targetFrameworkKey: string;
    /** All findings, ordered by confidence (highest first) */
    readonly findings: readonly TraceabilityFinding[];
    /** Summary statistics */
    readonly summary: {
        readonly totalFindings: number;
        readonly fullCoverage: number;
        readonly highCoverage: number;
        readonly partialCoverage: number;
        readonly overlapCoverage: number;
        readonly informationalOnly: number;
        /** Best coverage confidence found across all findings */
        readonly bestConfidence: CoverageConfidence;
    };
}

// ─── Gap Analysis Types ──────────────────────────────────────────────

/**
 * Gap status for a single target requirement.
 */
export type GapStatus =
    | 'COVERED'           // FULL or HIGH confidence coverage exists
    | 'PARTIALLY_COVERED' // PARTIAL or OVERLAP coverage exists
    | 'NOT_COVERED'       // No applicable mapping or INFORMATIONAL only
    | 'REVIEW_NEEDED';    // Has mappings but they require manual review

/**
 * A single gap analysis entry for one target requirement.
 */
export interface GapAnalysisEntry {
    /** Target requirement that may or may not be covered */
    readonly targetRequirement: {
        readonly requirementId: string;
        readonly requirementCode: string;
        readonly requirementTitle: string;
        readonly frameworkKey: string;
        readonly frameworkName: string;
    };
    /** Gap status determination */
    readonly status: GapStatus;
    /** Best coverage confidence from any source requirement */
    readonly bestConfidence: CoverageConfidence;
    /** Number of source requirements that map to this target */
    readonly sourceCount: number;
    /** The best-coverage source requirement (if any) */
    readonly bestSource: {
        readonly requirementId: string;
        readonly requirementCode: string;
        readonly frameworkKey: string;
        readonly strength: MappingStrengthValue;
        readonly confidence: CoverageConfidence;
        readonly isDirect: boolean;
    } | null;
    /** Human-readable explanation */
    readonly explanation: string;
}

/**
 * Complete gap analysis result comparing source framework coverage
 * against a target framework.
 */
export interface GapAnalysisResult {
    /** Source framework */
    readonly sourceFramework: string;
    /** Target framework */
    readonly targetFramework: string;
    /** All target requirements with gap status */
    readonly entries: readonly GapAnalysisEntry[];
    /** Summary statistics */
    readonly summary: {
        readonly totalTargetRequirements: number;
        readonly covered: number;
        readonly partiallyCovered: number;
        readonly notCovered: number;
        readonly reviewNeeded: number;
        /** Overall coverage percentage (COVERED as percent of total) */
        readonly coveragePercent: number;
        /** Coverage including partial (COVERED + PARTIALLY_COVERED) */
        readonly inclusiveCoveragePercent: number;
    };
}

// ─── Tenant Practice-Implementation Overlay ───────────────────────────
//
// Audit Coherence S9 (2026-05-24).
//
// Mapping rows are global reference data (NIST → SOC2 mappings are
// the same for every tenant). But the gap report is only useful
// when the auditor can see WHICH tenant practices already implement
// the target requirements. Pre-S9, that join had to happen on the
// frontend by re-querying PracticeRequirementLink — and most pages
// just didn't bother.
//
// `enrichWithTenantImplementations` accepts a gap-analysis result
// + a snapshot of the tenant's PracticeRequirementLink rows for the
// target framework and returns the same result with each entry
// carrying an `implementingPractices` array. Pure function; the
// caller owns the DB query.

/** A tenant practice that implements a specific target requirement. */
export interface TenantPracticeImplementation {
    readonly practiceId: string;
    readonly practiceCode: string;
    readonly practiceName: string;
    readonly practiceStatus: string;
    readonly requirementId: string;
}

/** A gap-analysis entry annotated with the tenant's implementing practices. */
export interface GapAnalysisEntryWithImplementations
    extends GapAnalysisEntry {
    readonly implementingPractices: readonly TenantPracticeImplementation[];
}

/** A gap-analysis result annotated with the tenant's implementing practices. */
export interface GapAnalysisResultWithImplementations
    extends Omit<GapAnalysisResult, 'entries'> {
    readonly entries: readonly GapAnalysisEntryWithImplementations[];
}

/**
 * Annotate every gap-analysis entry with the tenant's practices
 * that already implement the target requirement (via
 * PracticeRequirementLink rows).
 *
 * Pure function: the caller queries the link table — typically via
 * `db.practiceRequirementLink.findMany({ where: { tenantId, requirement: { frameworkKey } } })`
 * — and passes the result here.
 */
export function enrichWithTenantImplementations(
    result: GapAnalysisResult,
    implementations: ReadonlyArray<TenantPracticeImplementation>,
): GapAnalysisResultWithImplementations {
    const byReq = new Map<string, TenantPracticeImplementation[]>();
    for (const impl of implementations) {
        const list = byReq.get(impl.requirementId);
        if (list) list.push(impl);
        else byReq.set(impl.requirementId, [impl]);
    }

    return {
        ...result,
        entries: result.entries.map((e) => ({
            ...e,
            implementingPractices:
                byReq.get(e.targetRequirement.requirementId) ?? [],
        })),
    };
}

// ─── Explanation Generator ───────────────────────────────────────────

/**
 * Generate a human-readable explanation for a mapping path.
 */
export function generateExplanation(path: MappingPath): TraceabilityExplanation {
    const strength = path.effectiveStrength;
    const confidence = strengthToConfidence(strength);
    const isTransitive = !path.isDirect;
    const depth = path.depth;

    const transitiveNote = isTransitive
        ? ` (via ${depth}-hop transitive mapping)`
        : '';

    switch (confidence) {
        case 'FULL':
            return {
                summary: `Fully equivalent${transitiveNote}`,
                detail: `These requirements express the same obligation. ` +
                    `Implementing the source requirement fully satisfies the target.${transitiveNote}`,
                actionRequired: false,
                suggestedAction: null,
            };
        case 'HIGH':
            return {
                summary: `Strong coverage — verify scope${transitiveNote}`,
                detail: `The source requirement is broader than the target. ` +
                    `Implementing the source likely satisfies the target, ` +
                    `but the scope should be verified.${transitiveNote}`,
                actionRequired: true,
                suggestedAction: 'Verify that the source requirement scope fully covers the target context.',
            };
        case 'PARTIAL':
            return {
                summary: `Partial coverage — gap remains${transitiveNote}`,
                detail: `The source requirement is narrower than the target. ` +
                    `Implementing the source only partially satisfies the target. ` +
                    `Additional practices or evidence may be needed.${transitiveNote}`,
                actionRequired: true,
                suggestedAction: 'Identify and address the gaps not covered by the source requirement.',
            };
        case 'OVERLAP':
            return {
                summary: `Overlap — explicit review needed${transitiveNote}`,
                detail: `The source and target requirements share common ground ` +
                    `but neither fully covers the other. ` +
                    `A compliance team review is recommended.${transitiveNote}`,
                actionRequired: true,
                suggestedAction: 'Review the overlapping areas and identify any uncovered obligations.',
            };
        case 'INFORMATIONAL':
            return {
                summary: `Informational relationship only${transitiveNote}`,
                detail: `The source and target requirements are conceptually related ` +
                    `but no direct coverage claim can be made. ` +
                    `This relationship is for awareness and planning purposes.${transitiveNote}`,
                actionRequired: false,
                suggestedAction: null,
            };
        default:
            return {
                summary: 'No relationship',
                detail: 'No mapping exists between these requirements.',
                actionRequired: false,
                suggestedAction: null,
            };
    }
}

// ─── Traceability Service ────────────────────────────────────────────

/**
 * Build a traceability report from a raw MappingTraceResult.
 *
 * Applies conservative business semantics to each mapping path,
 * generating findings with coverage confidence and explanations.
 */
export function buildTraceabilityReport(
    trace: MappingTraceResult,
    targetFrameworkKey: string,
): TraceabilityReport {
    const findings: TraceabilityFinding[] = [];

    for (const path of trace.paths) {
        // Only include paths targeting the specified framework
        if (path.target.frameworkKey !== targetFrameworkKey) continue;

        const confidence = strengthToConfidence(path.effectiveStrength);

        findings.push({
            source: trace.source,
            target: path.target,
            mappingStrength: path.effectiveStrength,
            confidence,
            confidenceRank: CONFIDENCE_RANK[confidence],
            isActionable: isActionableCoverage(confidence),
            isDirect: path.isDirect,
            depth: path.depth,
            explanation: generateExplanation(path),
            edgeChain: path.edges.map(e => ({
                fromCode: e.source.requirementCode,
                fromFramework: e.source.frameworkKey,
                toCode: e.target.requirementCode,
                toFramework: e.target.frameworkKey,
                strength: e.strength,
                rationale: e.rationale,
            })),
        });
    }

    // Sort by confidence rank descending (best coverage first)
    findings.sort((a, b) => {
        if (a.confidenceRank !== b.confidenceRank) return b.confidenceRank - a.confidenceRank;
        return a.target.requirementCode.localeCompare(b.target.requirementCode);
    });

    // Compute summary
    const fullCoverage = findings.filter(f => f.confidence === 'FULL').length;
    const highCoverage = findings.filter(f => f.confidence === 'HIGH').length;
    const partialCoverage = findings.filter(f => f.confidence === 'PARTIAL').length;
    const overlapCoverage = findings.filter(f => f.confidence === 'OVERLAP').length;
    const informationalOnly = findings.filter(f => f.confidence === 'INFORMATIONAL').length;

    const bestConfidence = findings.length > 0
        ? findings[0].confidence
        : 'NONE' as CoverageConfidence;

    return {
        source: trace.source,
        targetFrameworkKey,
        findings,
        summary: {
            totalFindings: findings.length,
            fullCoverage,
            highCoverage,
            partialCoverage,
            overlapCoverage,
            informationalOnly,
            bestConfidence,
        },
    };
}

/**
 * Resolve traceability for a single source requirement against a target framework.
 *
 * This is the primary product-facing API:
 * "If I'm compliant with requirement X, what does that mean for framework B?"
 */
export async function resolveTraceability(
    sourceRequirementId: string,
    targetFrameworkKey: string,
    loadEdges: MappingEdgeLoader,
    options: { maxDepth?: number } = {},
): Promise<TraceabilityReport> {
    const trace = await resolveMapping(
        {
            sourceRequirementId,
            targetFrameworkKeys: [targetFrameworkKey],
            maxDepth: options.maxDepth,
        },
        loadEdges,
    );

    return buildTraceabilityReport(trace, targetFrameworkKey);
}

// ─── Gap Analysis Service ────────────────────────────────────────────

/**
 * Determine the gap status for a target requirement based on its
 * best mapping from any source.
 */
export function determineGapStatus(bestConfidence: CoverageConfidence): GapStatus {
    switch (bestConfidence) {
        case 'FULL':
        case 'HIGH':
            return 'COVERED';
        case 'PARTIAL':
        case 'OVERLAP':
            return 'PARTIALLY_COVERED';
        case 'INFORMATIONAL':
            return 'REVIEW_NEEDED';
        case 'NONE':
        default:
            return 'NOT_COVERED';
    }
}

/**
 * Generate a human-readable explanation for a gap status.
 */
function gapStatusExplanation(status: GapStatus, bestConfidence: CoverageConfidence, sourceCount: number): string {
    switch (status) {
        case 'COVERED':
            return bestConfidence === 'FULL'
                ? `Fully covered by ${sourceCount} equivalent requirement(s).`
                : `Likely covered by ${sourceCount} source requirement(s) — verify scope.`;
        case 'PARTIALLY_COVERED':
            return `Partially covered by ${sourceCount} source requirement(s) — additional work may be needed.`;
        case 'REVIEW_NEEDED':
            return `${sourceCount} related requirement(s) found — requires manual compliance review.`;
        case 'NOT_COVERED':
            return 'No applicable mapping found. This requirement needs independent attention.';
    }
}

/**
 * Perform cross-framework gap analysis.
 *
 * For each target requirement, resolves all mappings from the source
 * framework and determines whether the target requirement is covered,
 * partially covered, or uncovered.
 *
 * @param sourceRequirementIds - All requirement IDs from the source framework
 * @param targetRequirements - All requirements from the target framework
 * @param sourceFrameworkKey - Source framework key (for reporting)
 * @param targetFrameworkKey - Target framework key (for filtering)
 * @param loadEdges - Edge loader function
 * @param options - Optional configuration
 * @returns Gap analysis result with per-requirement status
 */
export async function analyzeGaps(
    sourceRequirementIds: readonly string[],
    targetRequirements: ReadonlyArray<{
        requirementId: string;
        requirementCode: string;
        requirementTitle: string;
        frameworkKey: string;
        frameworkName: string;
    }>,
    sourceFrameworkKey: string,
    targetFrameworkKey: string,
    loadEdges: MappingEdgeLoader,
    options: { maxDepth?: number } = {},
): Promise<GapAnalysisResult> {
    // Resolve all mappings from source requirements
    const queries: TraceabilityQuery[] = sourceRequirementIds.map(id => ({
        sourceRequirementId: id,
        targetFrameworkKeys: [targetFrameworkKey],
        maxDepth: options.maxDepth,
    }));

    const traces = await resolveMappingBatch(queries, loadEdges);

    // Build a map: targetRequirementId → best coverage info
    const targetCoverage = new Map<string, {
        bestConfidence: CoverageConfidence;
        bestStrength: MappingStrengthValue;
        bestSource: TraceabilityFinding['source'] | null;
        isDirect: boolean;
        sourceCount: number;
    }>();

    for (const trace of traces) {
        for (const path of trace.paths) {
            if (path.target.frameworkKey !== targetFrameworkKey) continue;

            const targetReqId = path.target.requirementId;
            const confidence = strengthToConfidence(path.effectiveStrength);
            const existing = targetCoverage.get(targetReqId);

            if (!existing || CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[existing.bestConfidence]) {
                targetCoverage.set(targetReqId, {
                    bestConfidence: confidence,
                    bestStrength: path.effectiveStrength,
                    bestSource: trace.source,
                    isDirect: path.isDirect,
                    sourceCount: (existing?.sourceCount ?? 0) + 1,
                });
            } else {
                targetCoverage.set(targetReqId, {
                    ...existing,
                    sourceCount: existing.sourceCount + 1,
                });
            }
        }
    }

    // Build gap analysis entries for each target requirement
    const entries: GapAnalysisEntry[] = targetRequirements.map(target => {
        const coverage = targetCoverage.get(target.requirementId);

        if (!coverage) {
            return {
                targetRequirement: target,
                status: 'NOT_COVERED' as GapStatus,
                bestConfidence: 'NONE' as CoverageConfidence,
                sourceCount: 0,
                bestSource: null,
                explanation: gapStatusExplanation('NOT_COVERED', 'NONE', 0),
            };
        }

        const status = determineGapStatus(coverage.bestConfidence);

        return {
            targetRequirement: target,
            status,
            bestConfidence: coverage.bestConfidence,
            sourceCount: coverage.sourceCount,
            bestSource: coverage.bestSource ? {
                requirementId: coverage.bestSource.requirementId,
                requirementCode: coverage.bestSource.requirementCode,
                frameworkKey: coverage.bestSource.frameworkKey,
                strength: coverage.bestStrength,
                confidence: coverage.bestConfidence,
                isDirect: coverage.isDirect,
            } : null,
            explanation: gapStatusExplanation(status, coverage.bestConfidence, coverage.sourceCount),
        };
    });

    // Sort: NOT_COVERED first, then PARTIALLY_COVERED, etc. (gaps first)
    entries.sort((a, b) => {
        const statusOrder: Record<GapStatus, number> = {
            NOT_COVERED: 0,
            REVIEW_NEEDED: 1,
            PARTIALLY_COVERED: 2,
            COVERED: 3,
        };
        const statusDiff = statusOrder[a.status] - statusOrder[b.status];
        if (statusDiff !== 0) return statusDiff;
        return a.targetRequirement.requirementCode.localeCompare(b.targetRequirement.requirementCode);
    });

    // Summary
    const covered = entries.filter(e => e.status === 'COVERED').length;
    const partiallyCovered = entries.filter(e => e.status === 'PARTIALLY_COVERED').length;
    const notCovered = entries.filter(e => e.status === 'NOT_COVERED').length;
    const reviewNeeded = entries.filter(e => e.status === 'REVIEW_NEEDED').length;
    const total = entries.length;

    return {
        sourceFramework: sourceFrameworkKey,
        targetFramework: targetFrameworkKey,
        entries,
        summary: {
            totalTargetRequirements: total,
            covered,
            partiallyCovered,
            notCovered,
            reviewNeeded,
            coveragePercent: total > 0 ? Math.round((covered / total) * 100) : 0,
            inclusiveCoveragePercent: total > 0 ? Math.round(((covered + partiallyCovered) / total) * 100) : 0,
        },
    };
}
