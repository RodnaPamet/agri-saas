/**
 * Row/summary shapes shared by the automation rule-builder components.
 *
 * These two interfaces used to be declared inside the `/processes` PAGE
 * (`ProcessesClient.tsx` and `RulesTab.tsx`) and imported back out of it by
 * five components under `src/components/processes/`. That direction is
 * backwards — a page is a leaf, not a module other code depends on — and it
 * meant the GRC teardown could not delete the `/processes` page chrome
 * without breaking the rule builder, which is Epic 60 automation and stays.
 *
 * The process-map MODELS are KEEP (they moved to `automation.prisma` in
 * teardown phase 1); only the page chrome around them goes. See
 * `docs/implementation-notes/2026-08-12-grc-teardown-plan.md` §1d.
 */
import type { RULE_ACTION_LABELS, RULE_STATUS_LABELS } from './automation-filter-defs';

/** One process map, as listed by `GET /api/t/:slug/processes`. */
export interface ProcessMapSummary {
    id: string;
    name: string;
    description: string | null;
    status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
    version: number;
    createdAt: string | Date;
    updatedAt: string | Date;
    nodeCount: number;
    edgeCount: number;
    /** VR-2 — DOCUMENT (process map) vs AUTOMATION (visual rule editor). */
    canvasMode?: 'DOCUMENT' | 'AUTOMATION';
}

/** One automation rule, as rendered by the rules table and detail sheet. */
export interface AutomationRuleRow {
    id: string;
    name: string;
    triggerEvent: string;
    actionType: keyof typeof RULE_ACTION_LABELS;
    status: keyof typeof RULE_STATUS_LABELS;
    priority: number;
    executionCount: number;
    lastTriggeredAt: string | Date | null;
}
