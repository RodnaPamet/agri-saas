/**
 * AI automation-rule suggestions (Visual Rule Editor VR-9).
 *
 * Surfaces ranked, ready-to-apply automation rules based on the tenant's live
 * compliance posture — designed for the Practice page right-rail. The ranking
 * is a deterministic heuristic (no LLM dependency, so it works without AI keys
 * and is fully unit-testable); the pure `rankRuleSuggestions` core is exported
 * for tests, and takes its candidate list as an injectable parameter so the
 * ranking is testable independently of whatever the catalogue contains.
 *
 * The candidates are DERIVED from `AUTOMATION_TEMPLATES` (owner ruling,
 * 2026-10-10, #1525) rather than hand-authored here. The rail and the template
 * library were two surfaces recommending the same thing, and only the library
 * had content — so this was the empty one, not the authoritative one. One
 * source of product content means a new template appears in both places
 * without being written twice, which is the duplicate-declaration problem
 * #1555 is about, one layer up.
 *
 * Each suggestion excludes any trigger event already covered by an ENABLED
 * rule, so the rail never proposes a duplicate of an automation the tenant
 * already runs.
 */
import { RequestContext } from '../types';
import { assertCanReadAutomation } from '../automation';
import { runInTenantContext } from '@/lib/db-context';
import { AUTOMATION_TEMPLATES } from '@/data/automation-templates';

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

/** Action types the rail can offer. Narrower than Prisma's `AutomationActionType`. */
const SUGGESTABLE_ACTIONS: ReadonlySet<string> = new Set<SuggestionActionType>([
    'NOTIFY_USER',
    'CREATE_TASK',
]);

/**
 * Catalogue priority expressed as the 0–1 score the ranking function consumes.
 *
 * `AUTOMATION_TEMPLATES` is an ORDERED list — the authors' preference order —
 * and it carries no confidence figure, because nothing measured one. So this
 * is a PROXY: position 0 scores highest and each later entry a step lower.
 *
 * Two properties are deliberate. It never reaches 1.0, because a derived
 * ordering is not evidence of certainty and the confidence bar should not
 * claim it is. And every entry gets a DISTINCT score, so the descending sort
 * has a total order — equal scores would leave `rankRuleSuggestions`'s strict
 * comparison to break ties arbitrarily, which is the "collapse-to-one needs a
 * total order" trap.
 */
const CATALOGUE_TOP_CONFIDENCE = 0.8;
const CATALOGUE_CONFIDENCE_STEP = 0.05;
const CATALOGUE_MIN_CONFIDENCE = 0.1;

/**
 * The suggestions this product offers — derived from the template catalogue.
 *
 * It used to hold one hand-written candidate triggering on `ISSUE_CREATED`,
 * which lost its only producer when `/issues/**` was retired (#1479). A
 * suggestion naming a dead event leads a tenant to build a rule that can never
 * fire — the defect CLAUDE.md records against `TEST_PLAN_*`.
 *
 * Deriving from the catalogue closes that by construction rather than by
 * vigilance: `tests/guards/automation-template-triggers-are-live.test.ts`
 * asserts every template's trigger is in `AUTOMATION_EVENTS`, and
 * `automation-catalog-emitter-coverage` already asserts every catalogue event
 * has an in-repo emitter (its `EXTERNALLY_EMITTED` exemption list is empty).
 * So "this suggestion's event has a producer" is now transitive, where the old
 * docblock asked for it to be checked by hand.
 *
 * Templates whose action the rail cannot offer are filtered out rather than
 * coerced — `SuggestionActionType` is two of Prisma's action types, and a
 * template using a third is a template, not a suggestion.
 */
export const RULE_SUGGESTION_CANDIDATES: readonly Candidate[] = AUTOMATION_TEMPLATES.filter(
    (t) => SUGGESTABLE_ACTIONS.has(t.actionType),
).map((t, index) => ({
    id: t.id,
    title: t.name,
    rationale: t.description,
    triggerEvent: t.trigger,
    actionType: t.actionType as SuggestionActionType,
    confidenceScore: Math.max(
        CATALOGUE_MIN_CONFIDENCE,
        CATALOGUE_TOP_CONFIDENCE - index * CATALOGUE_CONFIDENCE_STEP,
    ),
}));

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
