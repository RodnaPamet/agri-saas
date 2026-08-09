/**
 * Due-Item Ownership Resolution
 *
 * Centralized domain function for resolving the owner of a DueItem.
 * Every entity type that can generate a DueItem has an explicit rule here.
 *
 * OWNERSHIP RULES:
 *   - CONTROL   → ownerUserId
 *   - EVIDENCE  → ownerUserId (added 2026-04-17, was previously unlinked)
 *   - POLICY    → ownerUserId
 *   - VENDOR    → ownerUserId
 *   - TASK      → assigneeUserId (not ownerUserId — tasks use assignee)
 *   - RISK      → ownerUserId
 *   - TEST_PLAN → ownerUserId
 *
 * FALLBACK:
 *   When the resolved owner is null/undefined, the DueItem has no owner.
 *   The digest-dispatcher routes ownerless items to tenant admins.
 *   This is INTENTIONAL for legitimately unassigned entities.
 *   It is NOT intentional for entities that have an owner but fail to wire it.
 *
 * HOW TO ADD A NEW ENTITY TYPE:
 *   1. Add the entity to MonitoredEntityType in types.ts
 *   2. Add a rule to OWNERSHIP_RULES below
 *   3. Ensure the scanner selects the owner field
 *   4. Call resolveDueItemOwner() in the DueItem construction
 *   5. The regression test in due-item-ownership-guard.test.ts will
 *      catch missing rules
 *
 * @module app-layer/domain/due-item-ownership
 */

import type { MonitoredEntityType } from '../jobs/types';

/**
 * Per-entity-type ownership field mapping.
 * Each entry documents which database field provides the owner for that entity type.
 */
export const OWNERSHIP_RULES: Record<MonitoredEntityType, {
    /** Name of the database field that provides the owner user ID */
    ownerField: string;
    /** Whether admin fallback is intentional when no owner exists */
    adminFallbackIntended: boolean;
    /** Human-readable description for documentation/logging */
    description: string;
}> = {
    CONTROL: {
        ownerField: 'ownerUserId',
        adminFallbackIntended: true,
        description: 'Practice owner (assigned via practice management)',
    },
    EVIDENCE: {
        ownerField: 'ownerUserId',
        adminFallbackIntended: true,
        description: 'Evidence owner (real user FK, replaces legacy free-text)',
    },
    POLICY: {
        ownerField: 'ownerUserId',
        adminFallbackIntended: true,
        description: 'Policy owner (assigned via policy management)',
    },
    VENDOR: {
        ownerField: 'ownerUserId',
        adminFallbackIntended: true,
        description: 'Vendor owner (assigned via vendor management)',
    },
    TASK: {
        ownerField: 'assigneeUserId',
        adminFallbackIntended: true,
        description: 'Task assignee (uses assignee, not owner)',
    },
    RISK: {
        ownerField: 'ownerUserId',
        adminFallbackIntended: true,
        description: 'Risk owner (assigned via risk register)',
    },
    TEST_PLAN: {
        ownerField: 'ownerUserId',
        adminFallbackIntended: true,
        description: 'Test plan owner (assigned via test management)',
    },
    TREATMENT_PLAN: {
        ownerField: 'ownerUserId',
        adminFallbackIntended: true,
        description: 'Risk treatment plan owner (assigned at plan creation)',
    },
    TREATMENT_MILESTONE: {
        // Milestones inherit ownership from their parent plan; the
        // deadline-monitor scanner already populates DueItem.ownerUserId
        // from `treatmentPlan.ownerUserId`. The "field" here is a
        // synthetic reference for documentation only.
        ownerField: 'treatmentPlan.ownerUserId',
        adminFallbackIntended: true,
        description: 'Treatment milestone — inherits owner from parent plan',
    },
};

/**
 * Resolve the ownerUserId for a DueItem from an entity record.
 *
 * @param entityType  The type of entity generating the DueItem
 * @param record      The entity record from the database (must include the owner field)
 * @returns The owner user ID, or undefined if no owner is set
 *
 * @example
 *   const ownerUserId = resolveDueItemOwner('CONTROL', practice);
 *   // Uses practice.ownerUserId
 *
 * @example
 *   const ownerUserId = resolveDueItemOwner('TASK', task);
 *   // Uses task.assigneeUserId
 */
export function resolveDueItemOwner(
    entityType: MonitoredEntityType,
    record: Record<string, unknown>,
): string | undefined {
    const rule = OWNERSHIP_RULES[entityType];
    if (!rule) {
        // Unknown entity type — fail open but this should never happen
        // The regression test catches missing rules
        return undefined;
    }

    const value = record[rule.ownerField];
    if (typeof value === 'string' && value.length > 0) {
        return value;
    }
    return undefined;
}

/**
 * Get the list of all entity types that have ownership rules configured.
 * Used by regression tests to verify completeness.
 */
export function getConfiguredEntityTypes(): MonitoredEntityType[] {
    return Object.keys(OWNERSHIP_RULES) as MonitoredEntityType[];
}
