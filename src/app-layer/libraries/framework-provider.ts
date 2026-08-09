/**
 * Framework Provider — Runtime adapter for YAML-backed framework data.
 *
 * This module replaces direct imports from `@/data/frameworks`, `@/data/clauses`,
 * and `@/data/annex-a` with a unified provider that:
 *
 * 1. Prefers YAML-backed library data (loaded once, cached in-process)
 * 2. Falls back to legacy hardcoded data if YAML libraries aren't available
 * 3. Provides DB-first lookups when a Prisma client is available
 * 4. Exposes framework data in the same shape as legacy consumers expect
 *
 * Rollout Strategy:
 * ─────────────────
 * The provider implements a staged rollout:
 * - Phase 1 (current): YAML-loaded data with hardcoded fallback
 * - Phase 2 (future): DB-first with YAML as seed-source only
 * - Phase 3 (future): Remove hardcoded fallback entirely
 *
 * Cross-Framework Mapping Architecture:
 * ─────────────────────────────────────
 * The provider preserves the existing GuidanceMapping structure (ISO→SOC2/NIS2)
 * while also exposing the new URN-based mapping system for future consumption.
 * Both coexist at runtime until all consumers are migrated to URN-based lookups.
 */
import * as path from 'path';
import { logger } from '@/lib/observability/logger';
import {
    loadAllFromDirectory,
    type LoadedLibrary,
    type LoadedRequirementNode,
} from './index';

// ─── Legacy Interface Compatibility ─────────────────────────────────

/** Shape expected by existing mapping.ts consumer (SOC2/NIS2 requirements). */
export interface FrameworkInfo {
    code: string;
    title: string;
    description: string;
    category: string;
}

/** Shape expected by existing ClauseRepository consumer (ISO 27001 clauses). */
export interface ClauseInfo {
    number: string;
    title: string;
    description: string;
    artifacts: string;
    checklist: string[];
}

/** Shape expected by existing mapping.ts consumer (cross-framework guidance). */
export interface GuidanceMapping {
    isoControlId: string;
    soc2Codes: string[];
    nis2Codes: string[];
    rationale: string;
}

// ─── Internal State ─────────────────────────────────────────────────

const LIBRARIES_DIR = path.resolve(__dirname, '../../data/libraries');
const component = 'framework-provider';

/** In-process cache of loaded libraries (populated on first access). */
let _libraryCache: Map<string, LoadedLibrary> | null = null;
let _loadAttempted = false;

// ─── Library Loader ─────────────────────────────────────────────────

/**
 * Load all YAML libraries into memory (once). Subsequent calls return cached data.
 * Returns an empty map if loading fails (fallback to hardcoded data).
 */
function getLoadedLibraries(): Map<string, LoadedLibrary> {
    if (_libraryCache !== null) return _libraryCache;

    if (_loadAttempted) return new Map();
    _loadAttempted = true;

    try {
        _libraryCache = loadAllFromDirectory(LIBRARIES_DIR);
        logger.info('YAML libraries loaded', {
            component,
            count: _libraryCache.size,
            urns: [..._libraryCache.keys()],
        });
        return _libraryCache;
    } catch (err) {
        logger.warn('Failed to load YAML libraries, using hardcoded fallback', {
            component,
            error: err instanceof Error ? err.message : String(err),
        });
        _libraryCache = new Map();
        return _libraryCache;
    }
}

/**
 * Get a loaded library by its ref_id (framework key).
 */
export function getLibraryByRefId(refId: string): LoadedLibrary | undefined {
    const libs = getLoadedLibraries();
    for (const [, lib] of libs) {
        if (lib.refId === refId) return lib;
    }
    return undefined;
}

/**
 * Get a loaded library by its URN.
 */
export function getLibraryByUrn(urn: string): LoadedLibrary | undefined {
    return getLoadedLibraries().get(urn);
}

/**
 * Get all loaded libraries.
 */
export function getAllLibraries(): LoadedLibrary[] {
    return [...getLoadedLibraries().values()];
}

/**
 * Look up a requirement node by URN across all loaded libraries.
 */
export function findNodeByUrn(urn: string): LoadedRequirementNode | undefined {
    for (const [, lib] of getLoadedLibraries()) {
        const node = lib.framework.nodesByUrn.get(urn);
        if (node) return node;
    }
    return undefined;
}

/**
 * Look up a requirement node by refId within a specific framework.
 */
export function findNodeByRefId(frameworkRefId: string, refId: string): LoadedRequirementNode | undefined {
    const lib = getLibraryByRefId(frameworkRefId);
    if (!lib) return undefined;
    return lib.framework.nodesByRefId.get(refId);
}

// ─── Legacy-Compatible Data Providers ───────────────────────────────

/**
 * Get SOC 2 requirements in the legacy FrameworkInfo shape.
 *
 * - Primary: YAML library (SOC2-2017)
 * - Fallback: hardcoded SOC2_REQUIREMENTS from @/data/frameworks
 *
 * @deprecated Use getLibraryByRefId('SOC2-2017') for new code.
 */
export function getSOC2Requirements(): FrameworkInfo[] {
    const lib = getLibraryByRefId('SOC2-2017');
    if (lib) {
        return lib.framework.nodes
            .filter(n => n.assessable)
            .map(n => ({
                code: n.refId,
                title: n.name ?? n.refId,
                description: n.description ?? '',
                category: n.category ?? '',
            }));
    }

    // Fallback to legacy hardcoded data
    const { SOC2_REQUIREMENTS } = require('@/data/frameworks');
    return SOC2_REQUIREMENTS;
}

/**
 * Get NIS2 requirements in the legacy FrameworkInfo shape.
 *
 * - Primary: YAML library (NIS2-2022)
 * - Fallback: hardcoded NIS2_REQUIREMENTS from @/data/frameworks
 *
 * @deprecated Use getLibraryByRefId('NIS2-2022') for new code.
 */
export function getNIS2Requirements(): FrameworkInfo[] {
    const lib = getLibraryByRefId('NIS2-2022');
    if (lib) {
        return lib.framework.nodes
            .filter(n => n.assessable)
            .map(n => ({
                code: n.refId,
                title: n.name ?? n.refId,
                description: n.description ?? '',
                category: n.category ?? '',
            }));
    }

    // Fallback to legacy hardcoded data
    const { NIS2_REQUIREMENTS } = require('@/data/frameworks');
    return NIS2_REQUIREMENTS;
}

/**
 * Get ISO 27001 clauses (4–10) in the legacy ClauseInfo shape.
 *
 * - Primary: YAML library (ISO27001-2022) clause nodes with artifacts/checklist
 * - Fallback: hardcoded CLAUSES from @/data/clauses
 *
 * The YAML nodes now include `artifacts` and `checklist` fields, making
 * this a true YAML-primary function.
 *
 * @deprecated Use getLibraryByRefId('ISO27001-2022') for new code.
 */
export function getISO27001Clauses(): ClauseInfo[] {
    const lib = getLibraryByRefId('ISO27001-2022');
    if (lib) {
        // Extract clause nodes (ref_ids 4-10) — these are the management clauses
        const clauseRefIds = ['4', '5', '6', '7', '8', '9', '10'];
        const clauseNodes = clauseRefIds
            .map(refId => lib.framework.nodesByRefId.get(refId))
            .filter((n): n is NonNullable<typeof n> => n !== undefined);

        // Only use YAML if we found all 7 clauses WITH artifacts/checklist
        const allHaveArtifacts = clauseNodes.every(n => n.artifacts && n.checklist);
        if (clauseNodes.length === 7 && allHaveArtifacts) {
            return clauseNodes.map(n => ({
                number: n.refId,
                title: n.name ?? n.refId,
                description: n.description ?? '',
                artifacts: n.artifacts ?? '',
                checklist: [...(n.checklist ?? [])],
            }));
        }
    }

    // Fallback to legacy hardcoded data (enriched with artifacts/checklist)
    const { CLAUSES } = require('@/data/clauses');
    return CLAUSES;
}

/**
 * Get cross-framework guidance mappings (ISO→SOC2/NIS2).
 *
 * - Primary: YAML mapping data from the ISO 27001 library
 * - Fallback: hardcoded FRAMEWORK_MAPPINGS from @/data/frameworks
 *
 * The YAML mappings use URN-based source/target pairs. This function
 * reconstructs the legacy GuidanceMapping shape by grouping ISO source
 * practices and resolving SOC2/NIS2 target ref_ids from loaded libraries.
 *
 * @deprecated Use YAML LoadedMapping objects for new cross-framework code.
 */
export function getFrameworkMappings(): GuidanceMapping[] {
    const isoLib = getLibraryByRefId('ISO27001-2022');
    if (isoLib && isoLib.mappings.length > 0) {
        // Load target frameworks for ref_id resolution
        const soc2Lib = getLibraryByRefId('SOC2-2017');
        const nis2Lib = getLibraryByRefId('NIS2-2022');

        // Group YAML mappings by source URN (ISO practice)
        const bySourceUrn = new Map<string, Array<{ targetUrn: string; rationale?: string }>>();
        for (const m of isoLib.mappings) {
            const entries = bySourceUrn.get(m.sourceUrn) ?? [];
            entries.push({ targetUrn: m.targetUrn, rationale: m.rationale });
            bySourceUrn.set(m.sourceUrn, entries);
        }

        // Reconstruct legacy GuidanceMapping shape
        const result: GuidanceMapping[] = [];
        for (const [sourceUrn, targets] of bySourceUrn) {
            // Resolve ISO practice ref_id from source URN
            const isoNode = isoLib.framework.nodesByUrn.get(sourceUrn);
            if (!isoNode) continue;

            const soc2Codes: string[] = [];
            const nis2Codes: string[] = [];
            let rationale = '';

            for (const t of targets) {
                // Resolve target ref_id from SOC2 or NIS2 library
                const soc2Node = soc2Lib?.framework.nodesByUrn.get(t.targetUrn);
                const nis2Node = nis2Lib?.framework.nodesByUrn.get(t.targetUrn);

                if (soc2Node && !soc2Codes.includes(soc2Node.refId)) {
                    soc2Codes.push(soc2Node.refId);
                }
                if (nis2Node && !nis2Codes.includes(nis2Node.refId)) {
                    nis2Codes.push(nis2Node.refId);
                }
                // Use last non-empty rationale
                if (t.rationale) rationale = t.rationale;
            }

            result.push({
                isoControlId: isoNode.refId,
                soc2Codes,
                nis2Codes,
                rationale,
            });
        }

        return result;
    }

    // Fallback to legacy hardcoded data
    const { FRAMEWORK_MAPPINGS } = require('@/data/frameworks');
    return FRAMEWORK_MAPPINGS;
}

// ─── Framework-Enriched Lookups ─────────────────────────────────────

/**
 * Get all assessable requirement nodes from a loaded library.
 * Returns the YAML-backed nodes if available, otherwise returns undefined.
 */
export function getAssessableNodes(frameworkRefId: string): LoadedRequirementNode[] | undefined {
    const lib = getLibraryByRefId(frameworkRefId);
    if (!lib) return undefined;
    return lib.framework.nodes.filter(n => n.assessable);
}

/**
 * Get the node hierarchy (tree structure) for a framework.
 * Returns root nodes with child URN references for tree rendering.
 */
export function getFrameworkTree(frameworkRefId: string): LoadedRequirementNode[] | undefined {
    const lib = getLibraryByRefId(frameworkRefId);
    if (!lib) return undefined;
    return [...lib.framework.rootNodes];
}

/**
 * List all available framework ref IDs from loaded YAML libraries.
 */
export function listAvailableFrameworks(): Array<{
    refId: string;
    name: string;
    kind: string;
    version: number;
    nodeCount: number;
}> {
    return getAllLibraries().map(lib => ({
        refId: lib.refId,
        name: lib.name,
        kind: lib.kind,
        version: lib.version,
        nodeCount: lib.framework.nodes.length,
    }));
}

// ─── Cache Management ───────────────────────────────────────────────

/**
 * Force reload all libraries from disk.
 * Useful after a library import/update cycle.
 */
export function reloadLibraries(): void {
    _libraryCache = null;
    _loadAttempted = false;
    logger.info('Library cache invalidated', { component });
}

/**
 * Check if YAML libraries are loaded and available.
 */
export function isYamlBackedAvailable(): boolean {
    return getLoadedLibraries().size > 0;
}
