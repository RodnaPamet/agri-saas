/**
 * Library Updater — Version-aware update pipeline with migration strategies.
 *
 * When a framework's YAML changes (new version, added/removed requirements),
 * the updater computes a structural diff and applies a migration strategy
 * to decide how to handle the changes safely.
 *
 * Migration Strategies:
 * ─────────────────────
 * 'preserve'     — Default. Keep existing data, add new requirements,
 *                   deprecate removed ones. No tenant data is lost.
 *
 * 'clamp'        — Like preserve, but if a requirement's score is above
 *                   the new framework's max_score, clamp it down.
 *                   (Prevents invalid scores after framework changes)
 *
 * 'reset'        — Clear all tenant assessment data for changed requirements.
 *                   Used when a framework change is so significant that
 *                   existing assessments are no longer valid.
 *
 * 'rule-of-three' — Only apply updates that have been stable across 3+
 *                    consecutive library versions. Prevents premature
 *                    changes from draft standards.
 *                    When version history is available, uses actual
 *                    multi-version stability analysis. Without history,
 *                    falls back to conservatively suppressing all removals.
 *
 * Architecture:
 * ─────────────
 * The updater is a pure-logic module with no Prisma dependency.
 * It computes diffs and applies strategy transformations, but the
 * actual database writes are handled by the importer.
 *
 * This separation enables:
 * - Unit testing without a database
 * - Strategy composition and chaining
 * - Preview/dry-run capabilities
 */
import {
    type FrameworkVersionHistory,
    getStablyRemovedCodes,
    getStablyChangedCodes,
} from '../libraries/version-history';

// ─── Migration Strategies ────────────────────────────────────────────

/**
 * Migration strategies control how framework requirement changes
 * are applied to existing data.
 */
export type MigrationStrategy = 'preserve' | 'clamp' | 'reset' | 'rule-of-three';

// ─── Requirement Diff Types ──────────────────────────────────────────

/** A simplified requirement shape for diffing — framework-agnostic. */
export interface DiffableRequirement {
    code: string;
    title: string;
    description?: string;
    category?: string;
    section?: string;
}

/** A single requirement that was added in the new version. */
export interface AddedRequirement {
    code: string;
    title: string;
    description?: string;
    category?: string;
    section?: string;
}

/** A single requirement that was removed in the new version. */
export interface RemovedRequirement {
    code: string;
    title: string;
    description?: string;
    category?: string;
    section?: string;
}

/** A single requirement that changed between versions. */
export interface ChangedRequirement {
    code: string;
    /** Which fields changed */
    fields: string[];
    /** Old values */
    oldTitle: string;
    oldDescription?: string;
    oldCategory?: string;
    oldSection?: string;
    /** New values */
    newTitle: string;
    newDescription?: string;
    newCategory?: string;
    newSection?: string;
}

/** Complete diff between two sets of requirements. */
export interface RequirementDiff {
    /** Requirements that exist in new but not in old */
    added: AddedRequirement[];
    /** Requirements that exist in old but not in new */
    removed: RemovedRequirement[];
    /** Requirements that exist in both but have changed */
    changed: ChangedRequirement[];
    /** Requirements that are identical in both */
    unchanged: string[];
    /** Whether this diff has any score-impacting changes */
    hasScoreImpact: boolean;
    /** Summary statistics */
    summary: {
        totalOld: number;
        totalNew: number;
        addedCount: number;
        removedCount: number;
        changedCount: number;
        unchangedCount: number;
    };
}

// ─── Strategy Hook Context ───────────────────────────────────────────

/** Context passed to migration strategy hooks for decision-making. */
export interface StrategyContext {
    /** The strategy being applied */
    strategy: MigrationStrategy;
    /** The computed diff */
    diff: RequirementDiff;
    /** Framework key */
    frameworkKey?: string;
    /** Old version number */
    oldVersion?: number;
    /** New version number */
    newVersion?: number;
    /** Version history for rule-of-three decisions (optional) */
    versionHistory?: FrameworkVersionHistory;
}

// ─── Diff Computation ────────────────────────────────────────────────

/**
 * Compute a structural diff between two sets of requirements.
 * Requirements are matched by their `code` field.
 *
 * This is a pure function — no side effects.
 */
export function computeRequirementDiff(
    oldReqs: DiffableRequirement[],
    newReqs: DiffableRequirement[],
): RequirementDiff {
    const oldMap = new Map(oldReqs.map(r => [r.code, r]));
    const newMap = new Map(newReqs.map(r => [r.code, r]));

    const added: AddedRequirement[] = [];
    const removed: RemovedRequirement[] = [];
    const changed: ChangedRequirement[] = [];
    const unchanged: string[] = [];

    // Find added and changed requirements
    for (const [code, newReq] of newMap) {
        const oldReq = oldMap.get(code);
        if (!oldReq) {
            added.push({
                code: newReq.code,
                title: newReq.title,
                description: newReq.description,
                category: newReq.category,
                section: newReq.section,
            });
        } else {
            // Compare fields
            const fields: string[] = [];
            if (oldReq.title !== newReq.title) fields.push('title');
            if (oldReq.description !== newReq.description) fields.push('description');
            if (oldReq.category !== newReq.category) fields.push('category');
            if (oldReq.section !== newReq.section) fields.push('section');

            if (fields.length > 0) {
                changed.push({
                    code,
                    fields,
                    oldTitle: oldReq.title,
                    oldDescription: oldReq.description,
                    oldCategory: oldReq.category,
                    oldSection: oldReq.section,
                    newTitle: newReq.title,
                    newDescription: newReq.description,
                    newCategory: newReq.category,
                    newSection: newReq.section,
                });
            } else {
                unchanged.push(code);
            }
        }
    }

    // Find removed requirements
    for (const [code, oldReq] of oldMap) {
        if (!newMap.has(code)) {
            removed.push({
                code: oldReq.code,
                title: oldReq.title,
                description: oldReq.description,
                category: oldReq.category,
                section: oldReq.section,
            });
        }
    }

    // Score impact: any add/remove/change to requirements affects coverage calculations
    const hasScoreImpact = added.length > 0 || removed.length > 0;

    return {
        added,
        removed,
        changed,
        unchanged,
        hasScoreImpact,
        summary: {
            totalOld: oldReqs.length,
            totalNew: newReqs.length,
            addedCount: added.length,
            removedCount: removed.length,
            changedCount: changed.length,
            unchangedCount: unchanged.length,
        },
    };
}

// ─── Migration Strategy Application ─────────────────────────────────

/**
 * Apply a migration strategy to a RequirementDiff.
 *
 * Strategies modify the diff to control what actually gets applied:
 * - 'preserve': pass-through (no modifications to the diff)
 * - 'clamp': pass-through (clamping is applied at score level, not diff level)
 * - 'reset': pass-through (reset is applied at tenant data level)
 * - 'rule-of-three': filters out changes that haven't been stable for 3 versions
 *
 * Returns a new RequirementDiff with strategy-specific modifications applied.
 */
export function applyMigrationStrategy(
    diff: RequirementDiff,
    strategy: MigrationStrategy,
    versionHistory?: FrameworkVersionHistory,
): RequirementDiff {
    switch (strategy) {
        case 'preserve':
            // Default: apply all changes as-is
            return diff;

        case 'clamp':
            // Clamp strategy: same structural changes as preserve.
            // Score clamping is handled separately at the assessment level
            // when scores are recalculated after the update.
            return {
                ...diff,
                // Mark diff as having score impact so callers know to recalculate
                hasScoreImpact: true,
            };

        case 'reset':
            // Reset strategy: structural changes are the same, but callers
            // should clear existing assessment data for changed requirements.
            // We flag this via hasScoreImpact.
            return {
                ...diff,
                hasScoreImpact: true,
            };

        case 'rule-of-three':
            return applyRuleOfThree(diff, versionHistory);

        default:
            return diff;
    }
}

/**
 * Apply the rule-of-three strategy with version-history awareness.
 *
 * When version history is available (≥3 entries), uses actual stability
 * analysis to determine which removals and changes are safe to apply.
 *
 * When history is insufficient (<3 entries), falls back to the
 * conservative behavior: suppress all removals, allow additions.
 */
function applyRuleOfThree(
    diff: RequirementDiff,
    history?: FrameworkVersionHistory,
): RequirementDiff {
    // Fallback: no history or insufficient history — suppress all removals
    if (!history || history.entries.length < 3) {
        return {
            ...diff,
            removed: [], // Don't remove until we have enough history
            summary: {
                ...diff.summary,
                removedCount: 0,
            },
            hasScoreImpact: diff.added.length > 0,
        };
    }

    // History-aware: only allow removals that have been stable across 3+ versions
    const stablyRemoved = getStablyRemovedCodes(history, 3);
    const stablyChanged = getStablyChangedCodes(
        history,
        diff.changed.map(c => c.code),
        3,
    );

    // Filter removals: only keep those that are stably absent
    const allowedRemovals = diff.removed.filter(r => stablyRemoved.has(r.code));
    const suppressedRemovals = diff.removed.filter(r => !stablyRemoved.has(r.code));

    // Filter changes: only keep those that are stably changed
    // Unstable changes are treated as unchanged (suppressed)
    const allowedChanges = diff.changed.filter(c => stablyChanged.has(c.code));
    const suppressedChanges = diff.changed.filter(c => !stablyChanged.has(c.code));

    return {
        ...diff,
        removed: allowedRemovals,
        changed: allowedChanges,
        unchanged: [
            ...diff.unchanged,
            ...suppressedRemovals.map(r => r.code),
            ...suppressedChanges.map(c => c.code),
        ],
        summary: {
            ...diff.summary,
            removedCount: allowedRemovals.length,
            changedCount: allowedChanges.length,
            unchangedCount: diff.unchanged.length + suppressedRemovals.length + suppressedChanges.length,
        },
        hasScoreImpact: diff.added.length > 0 || allowedRemovals.length > 0,
    };
}

/**
 * Determine if a diff requires administrator review before applying.
 * High-impact changes (removals, score-affecting changes) should be reviewed.
 */
export function requiresReview(diff: RequirementDiff): boolean {
    // Removals always require review (may break existing practice mappings)
    if (diff.removed.length > 0) return true;
    // Large additions might warrant review
    if (diff.added.length > 10) return true;
    // Score-impacting changes require review
    if (diff.hasScoreImpact) return true;
    return false;
}

/**
 * Generate a human-readable summary of a requirement diff.
 */
export function summarizeDiff(diff: RequirementDiff): string {
    const parts: string[] = [];
    if (diff.added.length > 0) parts.push(`+${diff.added.length} added`);
    if (diff.removed.length > 0) parts.push(`-${diff.removed.length} removed`);
    if (diff.changed.length > 0) parts.push(`~${diff.changed.length} changed`);
    if (diff.unchanged.length > 0) parts.push(`=${diff.unchanged.length} unchanged`);
    if (parts.length === 0) return 'No changes';
    return parts.join(', ');
}
