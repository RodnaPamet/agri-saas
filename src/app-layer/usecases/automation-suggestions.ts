/**
 * AI automation-rule suggestions (Visual Rule Editor VR-9).
 *
 * Surfaces ranked, ready-to-apply automation rules based on the tenant's live
 * compliance posture — designed for the Practice page right-rail. The ranking
 * is a deterministic heuristic (no LLM dependency, so it works without AI keys
 * and is fully unit-testable); the pure `rankRuleSuggestions` core is exported
 * for tests, and takes its candidate list as an injectable parameter so the
 * ranking is testable even while `RULE_SUGGESTION_CANDIDATES` is empty.
 *
 * Each suggestion excludes any trigger event already covered by an ENABLED
 * rule, so the rail never proposes a duplicate of an automation the tenant
 * already runs.
 */
import { RequestContext } from '../types';
import { assertCanReadAutomation } from '../automation';
import { runInTenantContext } from '@/lib/db-context';

export type SuggestionActionType = 'NOTIFY_USER' | 'CREATE_TASK';

export interface RuleSuggestion {
    /** Stable id so the client can dismiss / de-dup. */
    id: string;
    rank: number;
    title: string;
    rationale: string;
    triggerEvent: string;
    actionType: SuggestionActionType;
    /** 0–1; drives the confidence bar + the rank order. */
    confidenceScore: number;
}

export interface SuggestionPosture {
    /** Trigger events already covered by an ENABLED rule — excluded. */
    coveredEvents: ReadonlySet<string>;
}

export interface Candidate extends Omit<RuleSuggestion, 'rank'> {}

/**
 * The suggestions this product offers. EMPTY as of #1479.
 *
 * It held exactly one candidate, triggering on `ISSUE_CREATED`. That event
 * lost its only producer when the `/issues/**` surface was retired, so the
 * suggestion would have led a tenant to build a rule that could never fire —
 * the defect CLAUDE.md records against `TEST_PLAN_*`, where the rule builder
 * went on offering triggers for deleted models.
 *
 * A new entry must trigger on an event in `AUTOMATION_EVENTS` that has a live
 * PRODUCER. `tests/guards/automation-catalog-emitter-coverage.test.ts` holds
 * that property for the catalogue; it cannot see a suggestion naming a dead
 * one, so check it here by hand.
 *
 * Lifted out of `rankRuleSuggestions` for #1525 so the ranking below is
 * testable independently of what this list happens to contain. While it is
 * empty the ranking is unreachable through the default path, and a list that
 * decides whether logic can be tested at all should not be a local const
 * inside the function it disables.
 */
export const RULE_SUGGESTION_CANDIDATES: readonly Candidate[] = [];

/**
 * Pure ranker. Drops any candidate whose trigger event is already covered,
 * scores them (posture-weighted), and assigns 1-based ranks.
 *
 * `candidates` is injectable and defaults to the real list, so every
 * production call site is unchanged and a test can exercise the ordering,
 * the exclusion and the re-ranking without depending on the catalogue being
 * non-empty. Before #1525 those three properties had no subject: the list was
 * a local const, and with it empty the only honest assertion left was that
 * the result is `[]` — which says nothing about whether the sort or the
 * filter work.
 */
export function rankRuleSuggestions(
    posture: SuggestionPosture,
    candidates: readonly Candidate[] = RULE_SUGGESTION_CANDIDATES,
): RuleSuggestion[] {
    const { coveredEvents } = posture;

    return candidates
        .filter((c) => !coveredEvents.has(c.triggerEvent))
        .sort((a, b) => b.confidenceScore - a.confidenceScore)
        .map((c, i) => ({ ...c, rank: i + 1, confidenceScore: Math.min(c.confidenceScore, 1) }));
}

/**
 * Usecase — gather posture + rank. Read-only; gated on automation read.
 */
export async function getAutomationSuggestions(
    ctx: RequestContext,
): Promise<{ suggestions: RuleSuggestion[]; generatedAt: string }> {
    assertCanReadAutomation(ctx);
    return runInTenantContext(ctx, async (db) => {
        // The register-driven `activeRiskCount` posture signal went with
        // the risk register; what remains is which trigger events an
        // ENABLED rule already covers.
        const enabledRules = await db.automationRule.findMany({
            where: { tenantId: ctx.tenantId, status: 'ENABLED', deletedAt: null },
            select: { triggerEvent: true },
            take: 500,
        });
        const coveredEvents = new Set(enabledRules.map((r) => r.triggerEvent));
        return {
            suggestions: rankRuleSuggestions({ coveredEvents }),
            generatedAt: new Date().toISOString(),
        };
    });
}
