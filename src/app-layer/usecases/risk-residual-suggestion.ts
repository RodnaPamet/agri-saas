/**
 * RQ2-2 — control-derived residual suggestion (usecase layer).
 *
 * Thin loader over the pure math in `@/lib/risk-residual`:
 *
 *   getResidualSuggestion — resolve each linked control's
 *     effectiveness signal (MEASURED test pass-rate over the rolling
 *     90-day window, falling back to the DECLARED
 *     `Control.effectiveness` field), combine, suggest.
 *     Read-only; recomputed on every call so link/unlink and new
 *     test runs are reflected immediately.
 *
 *   acceptResidualSuggestion — recompute SERVER-SIDE (the client
 *     can never assert the values), persist the decomposed residual
 *     + derived rollup, and append a DERIVED-source RiskScoreEvent.
 *     "Propose, don't overwrite": nothing here runs automatically —
 *     this is the explicit one-click accept.
 *
 * The payload also carries `combinedEffectiveness` for the FAIR
 * Quantification UI to show as a calibration reference next to the
 * `controlStrength` input. Deliberately NOT auto-written: FAIR's
 * controlStrength is relative to threatCapability
 * (vuln = tc/(tc+cs)), so deriving it from an absolute effectiveness
 * percentage would be pseudo-rigor. Reference, not assertion.
 */
import { RequestContext } from '../types';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest } from '@/lib/errors/types';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import { logEvent } from '../events/audit';
import { recordScoreEvent } from './risk-score-events';
import {
    combineEffectiveness,
    suggestResidual,
    describeCombination,
    describeAcceptedResidual,
    type CombinedEffectiveness,
    type ControlEffectivenessInput,
    type ResidualSuggestion,
} from '@/lib/risk-residual';
import type { PrismaTx } from '@/lib/db-context';

/** Mirrors control-test.ts's audit-readiness convention. */
const MEASURED_WINDOW_DAYS = 90;

export interface ResidualSuggestionPayload {
    riskId: string;
    inherent: { likelihood: number; impact: number; score: number };
    current: {
        residualLikelihood: number | null;
        residualImpact: number | null;
        residualScore: number | null;
    };
    /** Null when no linked control carries an effectiveness signal. */
    suggestion: ResidualSuggestion | null;
    combined: CombinedEffectiveness;
    /** Human one-liner, e.g. "3 preventive controls → 74% …". */
    summary: string;
}

/**
 * In-transaction loader — exported for `completePlan`
 * (risk-treatment-plan.ts), which derives the post-plan residual
 * inside its own transaction. Everything else goes through
 * `getResidualSuggestion`.
 */
export async function loadResidualSuggestion(
    db: PrismaTx,
    tenantId: string,
    riskId: string,
): Promise<{
    risk: { likelihood: number; impact: number; score: number; residualLikelihood: number | null; residualImpact: number | null; residualScore: number | null };
    combined: CombinedEffectiveness;
    suggestion: ResidualSuggestion | null;
    maxScale: number;
}> {
    const risk = await db.risk.findFirst({
        where: { id: riskId, tenantId },
        select: {
            likelihood: true,
            impact: true,
            score: true,
            residualLikelihood: true,
            residualImpact: true,
            residualScore: true,
            controls: {
                select: {
                    control: {
                        select: {
                            id: true,
                            code: true,
                            name: true,
                            mitigationType: true,
                            effectiveness: true,
                        },
                    },
                },
            },
        },
    });
    if (!risk) throw notFound('Risk not found');

    const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
    const maxScale = tenant?.maxRiskScale || 5;

    const controls = risk.controls.map((l) => l.control);
    const controlIds = controls.map((c) => c.id);

    // The MEASURED signal came from ControlTestRun pass rates. Test runs
    // were removed with the compliance uproot, so every control now falls
    // through to its DECLARED effectiveness.
    const measured = new Map<string, { passes: number; total: number }>();

    const inputs: ControlEffectivenessInput[] = controls.map((c) => {
        const m = measured.get(c.id);
        if (m && m.total > 0) {
            return {
                controlId: c.id,
                code: c.code,
                name: c.name,
                mitigationType: c.mitigationType,
                effectiveness: Math.round((m.passes / m.total) * 100),
                source: 'MEASURED' as const,
            };
        }
        return {
            controlId: c.id,
            code: c.code,
            name: c.name,
            mitigationType: c.mitigationType,
            effectiveness: c.effectiveness,
            source: c.effectiveness !== null ? ('DECLARED' as const) : null,
        };
    });

    const combined = combineEffectiveness(inputs);
    const suggestion =
        combined.participatingCount > 0
            ? suggestResidual(risk.likelihood, risk.impact, combined, maxScale)
            : null;

    return { risk, combined, suggestion, maxScale };
}

export async function getResidualSuggestion(
    ctx: RequestContext,
    riskId: string,
): Promise<ResidualSuggestionPayload> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const { risk, combined, suggestion } = await loadResidualSuggestion(db, ctx.tenantId, riskId);
        return {
            riskId,
            inherent: { likelihood: risk.likelihood, impact: risk.impact, score: risk.score },
            current: {
                residualLikelihood: risk.residualLikelihood,
                residualImpact: risk.residualImpact,
                residualScore: risk.residualScore,
            },
            suggestion,
            combined,
            summary: describeCombination(combined),
        };
    });
}

export async function acceptResidualSuggestion(
    ctx: RequestContext,
    riskId: string,
    options: { justification?: string | null } = {},
) {
    assertCanWrite(ctx);
    const accepted = await runInTenantContext(ctx, async (db) => {
        // Server-side recompute — the accepted values are whatever the
        // controls justify NOW, never what a client asserted.
        const { combined, suggestion } = await loadResidualSuggestion(db, ctx.tenantId, riskId);
        if (!suggestion) {
            throw badRequest(
                'No derivable residual: none of the linked controls carry an effectiveness signal',
            );
        }

        await db.risk.update({
            where: { id: riskId },
            data: {
                residualLikelihood: suggestion.residualLikelihood,
                residualImpact: suggestion.residualImpact,
                residualScore: suggestion.residualScore,
                residualScoreSetAt: new Date(),
            },
        });

        await recordScoreEvent(db, ctx.tenantId, {
            riskId,
            kind: 'RESIDUAL',
            likelihood: suggestion.residualLikelihood,
            impact: suggestion.residualImpact,
            score: suggestion.residualScore,
            source: 'DERIVED',
            justification:
                options.justification ?? `Accepted control-derived suggestion — ${describeCombination(combined)}`,
            createdByUserId: ctx.userId,
        });

        await logEvent(db, ctx, {
            action: 'RISK_RESIDUAL_DERIVED',
            entityType: 'Risk',
            entityId: riskId,
            details: `Residual accepted from control effectiveness: ${suggestion.residualScore}`,
            detailsJson: {
                category: 'custom',
                event: 'residual_derived',
                residualScore: suggestion.residualScore,
                participatingControls: combined.participatingCount,
            },
        });

        // RQ3-OB-D — compose the toast one-liner SERVER-SIDE from the
        // recomputed values, so the success toast reflects exactly
        // what was persisted (never client state). Spread onto the
        // suggestion so existing callers reading `.residualScore`
        // etc. keep working; `.summary` is the new field.
        return {
            ...suggestion,
            summary: describeAcceptedResidual(suggestion, combined.participatingCount),
        };
    });
    await bumpEntityCacheVersion(ctx, 'risk');
    return accepted;
}
