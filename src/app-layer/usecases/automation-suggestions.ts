/**
 * AI automation-rule suggestions (Visual Rule Editor VR-9).
 *
 * Surfaces ranked, ready-to-apply automation rules based on the tenant's live
 * compliance posture — designed for the Control page right-rail. The ranking
 * is a deterministic heuristic (no LLM dependency, so it works without AI keys
 * and is fully unit-testable); the pure `rankRuleSuggestions` core is exported
 * for tests.
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

interface Candidate extends Omit<RuleSuggestion, 'rank'> {}

/**
 * Pure ranker. Builds the candidate set, drops any whose trigger event is
 * already covered, scores them (posture-weighted), and assigns 1-based ranks.
 */
export function rankRuleSuggestions(posture: SuggestionPosture): RuleSuggestion[] {
    const { coveredEvents } = posture;

    const candidates: Candidate[] = [
        {
            id: 'control-test-failed-notify',
            title: 'Notify the team when a control test fails',
            rationale:
                'Failing control tests are the earliest signal of a slipping control — route them to an owner the moment they fail.',
            triggerEvent: 'TEST_RUN_FAILED',
            actionType: 'NOTIFY_USER',
            confidenceScore: 0.82,
        },
        {
            id: 'issue-created-task',
            title: 'Turn new issues into tracked tasks',
            rationale:
                'Create a task for each issue so remediation is tracked to closure rather than living in a comment thread.',
            triggerEvent: 'ISSUE_CREATED',
            actionType: 'CREATE_TASK',
            confidenceScore: 0.5,
        },
    ];

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
