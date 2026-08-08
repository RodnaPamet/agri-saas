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
    /** Risks in an active state (OPEN / MITIGATING). */
    activeRiskCount: number;
    /** Trigger events already covered by an ENABLED rule — excluded. */
    coveredEvents: ReadonlySet<string>;
}

interface Candidate extends Omit<RuleSuggestion, 'rank'> {}

/**
 * Pure ranker. Builds the candidate set, drops any whose trigger event is
 * already covered, scores them (posture-weighted), and assigns 1-based ranks.
 */
export function rankRuleSuggestions(posture: SuggestionPosture): RuleSuggestion[] {
    const { activeRiskCount, coveredEvents } = posture;
    // Posture weight: more open risk → higher confidence in the risk-driven
    // automations. Bounded to [0, 0.3] so a quiet tenant still sees base priors.
    const riskWeight = Math.min(activeRiskCount, 30) / 100;

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
            id: 'risk-created-task',
            title: 'Open a remediation task for every new risk',
            rationale:
                activeRiskCount > 0
                    ? `${activeRiskCount} risk${activeRiskCount === 1 ? '' : 's'} are active — auto-create a remediation task so none sits unowned.`
                    : 'Auto-create a remediation task whenever a risk is logged so nothing sits unowned.',
            triggerEvent: 'RISK_CREATED',
            actionType: 'CREATE_TASK',
            confidenceScore: 0.6 + riskWeight,
        },
        {
            id: 'risk-status-critical-notify',
            title: 'Alert when a risk escalates',
            rationale:
                'A risk moving to a higher severity warrants an immediate heads-up to the risk owner.',
            triggerEvent: 'RISK_STATUS_CHANGED',
            actionType: 'NOTIFY_USER',
            confidenceScore: 0.55 + riskWeight,
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
        // `activeRiskCount` fed a risk-register-driven ranking signal. The
        // register was removed with the compliance uproot; the remaining
        // signal is which trigger events are already covered by a rule.
        const activeRiskCount = 0;
        const [enabledRules] = await Promise.all([
            db.automationRule.findMany({
                where: { tenantId: ctx.tenantId, status: 'ENABLED', deletedAt: null },
                select: { triggerEvent: true },
                take: 500,
            }),
        ]);
        const coveredEvents = new Set(enabledRules.map((r) => r.triggerEvent));
        return {
            suggestions: rankRuleSuggestions({ activeRiskCount, coveredEvents }),
            generatedAt: new Date().toISOString(),
        };
    });
}
