/**
 * RQ2-2 — control-effectiveness → suggested residual (pure math).
 *
 * Replaces the divisor-era residual formula (MITIGATE → score/5,
 * TRANSFER → score/10) with a derivation grounded in the risk's
 * actually-linked controls:
 *
 *   combined = 1 − ∏(1 − eᵢ)          (independent layered controls)
 *
 * routed by the control's `mitigationType` — the same split the
 * RQ-7 bow-tie uses for its barrier sides:
 *
 *   PREVENTIVE / DETERRENT                  → reduce LIKELIHOOD
 *   DETECTIVE / CORRECTIVE / COMPENSATING   → reduce IMPACT
 *
 * Reductions cap at MAX_REDUCTION (0.8): no control stack eliminates
 * a risk dimension entirely — the floor keeps residual ≥ 1 on a live
 * scale, and the cap keeps the suggestion conservative when many
 * strong controls compound.
 *
 * Controls participate only when they carry an effectiveness signal:
 *   MEASURED — test pass-rate over the rolling window (preferred;
 *              data-driven, from control-test.ts).
 *   DECLARED — the static `Control.effectiveness` field (0–100).
 * Controls with neither, or with no `mitigationType`, are EXCLUDED
 * from the math but reported in the breakdown so the gap is visible
 * (data-quality nudge, not silent omission).
 *
 * This module is pure — no DB, no ctx — so the formula is unit-
 * testable in isolation and the usecase layer stays a thin loader.
 */

import { calculateRiskScore } from '@/lib/risk-scoring';
import type { ControlMitigationType } from '@prisma/client';

/** No control stack eliminates a dimension — cap combined reduction. */
export const MAX_REDUCTION = 0.8;

export type EffectivenessSource = 'MEASURED' | 'DECLARED';

export interface ControlEffectivenessInput {
    controlId: string;
    code: string | null;
    name: string;
    mitigationType: ControlMitigationType | null;
    /** 0–100. Callers resolve MEASURED-over-DECLARED before calling. */
    effectiveness: number | null;
    source: EffectivenessSource | null;
}

export interface ControlContribution {
    controlId: string;
    code: string | null;
    name: string;
    mitigationType: ControlMitigationType | null;
    effectiveness: number | null;
    source: EffectivenessSource | null;
    /** Which dimension this control reduced — null when excluded. */
    affects: 'LIKELIHOOD' | 'IMPACT' | null;
    /** Why an excluded control didn't participate. */
    excludedReason: 'NO_EFFECTIVENESS' | 'NO_MITIGATION_TYPE' | null;
}

export interface CombinedEffectiveness {
    /** 0..MAX_REDUCTION — applied to the likelihood dimension. */
    likelihoodReduction: number;
    /** 0..MAX_REDUCTION — applied to the impact dimension. */
    impactReduction: number;
    contributions: ControlContribution[];
    /** Count of controls that actually participated in the math. */
    participatingCount: number;
}

const LIKELIHOOD_TYPES: ReadonlySet<ControlMitigationType> = new Set([
    'PREVENTIVE',
    'DETERRENT',
]);
const IMPACT_TYPES: ReadonlySet<ControlMitigationType> = new Set([
    'DETECTIVE',
    'CORRECTIVE',
    'COMPENSATING',
]);

/**
 * Layered-control combination: 1 − ∏(1 − eᵢ) per dimension, capped.
 */
export function combineEffectiveness(
    controls: ControlEffectivenessInput[],
): CombinedEffectiveness {
    let likelihoodSurvival = 1;
    let impactSurvival = 1;
    let participatingCount = 0;

    const contributions: ControlContribution[] = controls.map((c) => {
        const base = {
            controlId: c.controlId,
            code: c.code,
            name: c.name,
            mitigationType: c.mitigationType,
            effectiveness: c.effectiveness,
            source: c.source,
        };
        if (c.effectiveness === null || c.effectiveness <= 0) {
            return { ...base, affects: null, excludedReason: 'NO_EFFECTIVENESS' as const };
        }
        if (!c.mitigationType) {
            return { ...base, affects: null, excludedReason: 'NO_MITIGATION_TYPE' as const };
        }
        const e = Math.min(Math.max(c.effectiveness, 0), 100) / 100;
        if (LIKELIHOOD_TYPES.has(c.mitigationType)) {
            likelihoodSurvival *= 1 - e;
            participatingCount += 1;
            return { ...base, affects: 'LIKELIHOOD' as const, excludedReason: null };
        }
        if (IMPACT_TYPES.has(c.mitigationType)) {
            impactSurvival *= 1 - e;
            participatingCount += 1;
            return { ...base, affects: 'IMPACT' as const, excludedReason: null };
        }
        // Exhaustive over the enum today; future enum members land
        // here and are visibly excluded rather than silently routed.
        return { ...base, affects: null, excludedReason: 'NO_MITIGATION_TYPE' as const };
    });

    return {
        likelihoodReduction: Math.min(1 - likelihoodSurvival, MAX_REDUCTION),
        impactReduction: Math.min(1 - impactSurvival, MAX_REDUCTION),
        contributions,
        participatingCount,
    };
}

export interface ResidualSuggestion {
    residualLikelihood: number;
    residualImpact: number;
    residualScore: number;
    likelihoodReduction: number;
    impactReduction: number;
}

/**
 * Apply combined reductions to the inherent dimensions.
 *
 * `ceil` keeps the suggestion conservative (a 5 → 2.2 reduction
 * suggests 3, not 2) and the clamp keeps both dimensions on the live
 * scale (≥ 1 — "the risk still exists"). The rollup is DERIVED via
 * the same `calculateRiskScore` the rest of the product uses.
 */
export function suggestResidual(
    inherentLikelihood: number,
    inherentImpact: number,
    combined: Pick<CombinedEffectiveness, 'likelihoodReduction' | 'impactReduction'>,
    maxScale: number = 5,
): ResidualSuggestion {
    const residualLikelihood = Math.min(
        maxScale,
        Math.max(1, Math.ceil(inherentLikelihood * (1 - combined.likelihoodReduction))),
    );
    const residualImpact = Math.min(
        maxScale,
        Math.max(1, Math.ceil(inherentImpact * (1 - combined.impactReduction))),
    );
    return {
        residualLikelihood,
        residualImpact,
        residualScore: calculateRiskScore(residualLikelihood, residualImpact, maxScale),
        likelihoodReduction: combined.likelihoodReduction,
        impactReduction: combined.impactReduction,
    };
}

/**
 * One-sentence human rendering of the derivation — the breakdown
 * line the suggestion card and the RQ2-3 explainer both show.
 * e.g. "3 preventive controls → 74% combined likelihood reduction;
 * 1 corrective control → 60% impact reduction".
 */
export function describeCombination(combined: CombinedEffectiveness): string {
    const byDim = (affects: 'LIKELIHOOD' | 'IMPACT') =>
        combined.contributions.filter((c) => c.affects === affects);
    const parts: string[] = [];
    const lik = byDim('LIKELIHOOD');
    if (lik.length > 0) {
        parts.push(
            `${lik.length} likelihood-reducing control${lik.length > 1 ? 's' : ''} → ${Math.round(combined.likelihoodReduction * 100)}% combined likelihood reduction`,
        );
    }
    const imp = byDim('IMPACT');
    if (imp.length > 0) {
        parts.push(
            `${imp.length} impact-reducing control${imp.length > 1 ? 's' : ''} → ${Math.round(combined.impactReduction * 100)}% combined impact reduction`,
        );
    }
    if (parts.length === 0) return 'No linked controls carry an effectiveness signal yet';
    return parts.join('; ');
}

/**
 * RQ3-OB-D — compact one-liner for the accept-suggestion success
 * toast, e.g. "Residual 8 — 2 controls, 60% likelihood / 30% impact".
 *
 * Distinct from `describeCombination` (which splits likelihood vs
 * impact into two clauses for the breakdown card): the toast wants
 * a single denser line that leads with the resulting residual score
 * — the number the user just committed to. Composed SERVER-SIDE so
 * the toast content derives from the accept response, never from
 * client state that could disagree with what was persisted.
 */
export function describeAcceptedResidual(
    suggestion: Pick<ResidualSuggestion, 'residualScore' | 'likelihoodReduction' | 'impactReduction'>,
    participatingCount: number,
): string {
    const controls = `${participatingCount} control${participatingCount === 1 ? '' : 's'}`;
    const lik = Math.round(suggestion.likelihoodReduction * 100);
    const imp = Math.round(suggestion.impactReduction * 100);
    return `Residual ${suggestion.residualScore} — ${controls}, ${lik}% likelihood / ${imp}% impact`;
}
