/**
 * RQ2-8 / RQ3-7 — staleness report (thin loader over
 * `@/lib/risk-staleness`).
 *
 * One pass, bounded queries, zero per-risk loops:
 *   1. live risks (id/title/nextReviewAt/residualScoreSetAt);
 *   2. newest score event per risk (groupBy _max);
 *   3. risk ↔ control links;
 *   4. newest COMPLETED test run per linked control (groupBy _max);
 *   5. RQ3-7 — newest currently-RED KRI reading per linked KRI,
 *      mapped back to its risk (the SIGNAL_MOVED signal).
 * The pure detector compares timestamps in memory. Read-only;
 * recomputed per call.
 */
import { RequestContext } from '../types';
import { assertCanRead } from '../policies/common';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import {
    assessStaleness,
    describeStaleness,
    MAX_ASSESSMENT_AGE_DAYS,
    type StalenessReason,
} from '@/lib/risk-staleness';

export interface StaleRiskRow {
    riskId: string;
    title: string;
    reasons: StalenessReason[];
    assessmentAgeDays: number | null;
    /** Plain-language reason line for the widget. */
    description: string;
}

export interface StalenessReport {
    staleRisks: StaleRiskRow[];
    staleCount: number;
    totalCount: number;
    maxAssessmentAgeDays: number;
}

/**
 * RQ3-7 — newest currently-RED KRI reading per risk (the SIGNAL_MOVED
 * source). A KRI is "breached" when its MOST RECENT reading sits in
 * the RED band; the breach timestamp is that reading's `recordedAt`.
 * A later non-RED reading (recovery) flips the latest reading to
 * GREEN/AMBER, so the risk drops out of the map — un-breaching clears
 * the signal with no extra bookkeeping. Two bounded reads + in-memory
 * folds, no per-risk query.
 */
async function loadLatestKriBreaches(
    db: PrismaTx,
    tenantId: string,
    riskIds: string[],
): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    const kris = await db.keyRiskIndicator.findMany({
        where: { tenantId, riskId: { in: riskIds }, isActive: true },
        select: { id: true, riskId: true },
    });
    const kriIds = kris.map((k) => k.id);
    if (kriIds.length === 0) return out;

    // ── All bounded reads happen up-front (no read inside a loop) ──
    // 1. newest reading TIMESTAMP per KRI (groupBy _max);
    // 2. then a single narrow read of every (kriId, recordedAt) pair
    //    in that set to learn each newest row's RAG band — groupBy
    //    can't return the band of the max row, and a per-KRI read
    //    would be the N+1 this loader exists to avoid.
    const newest = await db.kriReading.groupBy({
        by: ['kriId'],
        where: { tenantId, kriId: { in: kriIds } },
        _max: { recordedAt: true },
    });
    // Build the (kriId → newest timestamp) map + the timestamp set
    // with array methods (no `for` loop between the two reads).
    const newestAtByKri = new Map<string, Date>(
        newest
            .filter((n) => n._max.recordedAt !== null)
            .map((n) => [n.kriId, n._max.recordedAt as Date]),
    );
    const latestReadings = await db.kriReading.findMany({
        where: { tenantId, kriId: { in: kriIds }, recordedAt: { in: [...newestAtByKri.values()] } },
        select: { kriId: true, ragStatus: true, recordedAt: true },
    });

    // ── All assembly is in-memory from here ──
    const riskByKri = new Map(kris.map((k) => [k.id, k.riskId]));
    for (const reading of latestReadings) {
        if (newestAtByKri.get(reading.kriId)?.getTime() !== reading.recordedAt.getTime()) continue;
        if (reading.ragStatus !== 'RED') continue;
        const riskId = riskByKri.get(reading.kriId);
        if (!riskId) continue;
        const cur = out.get(riskId);
        if (!cur || reading.recordedAt > cur) out.set(riskId, reading.recordedAt);
    }
    return out;
}

export async function getRiskStaleness(
    ctx: RequestContext,
): Promise<StalenessReport> {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        const risks = await db.risk.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: null },
            select: {
                id: true,
                title: true,
                nextReviewAt: true,
                residualScoreSetAt: true,
            },
            // guardrail-allow: unbounded — staleness scans the whole
            // register; truncating would hide exactly the rows that
            // rot quietly at the bottom.
        });
        if (risks.length === 0) {
            return {
                staleRisks: [],
                staleCount: 0,
                totalCount: 0,
                maxAssessmentAgeDays: MAX_ASSESSMENT_AGE_DAYS,
            };
        }
        const riskIds = risks.map((r) => r.id);

        const [lastEvents, links] = await Promise.all([
            db.riskScoreEvent.groupBy({
                by: ['riskId'],
                where: { tenantId: ctx.tenantId, riskId: { in: riskIds } },
                _max: { createdAt: true },
            }),
            db.riskControl.findMany({
                where: { tenantId: ctx.tenantId, riskId: { in: riskIds } },
                select: { riskId: true, controlId: true },
                // guardrail-allow: unbounded — link rows for the same
                // bounded register scan above.
            }),
        ]);
        const lastAssessedByRisk = new Map(
            lastEvents.map((e) => [e.riskId, e._max.createdAt]),
        );

        // RQ3-7 — the KRI breach signal, computed in a self-contained
        // helper so all of ITS awaited reads happen before any
        // in-memory assembly loop (the helper returns a ready map).
        const latestKriBreachByRisk = await loadLatestKriBreaches(db, ctx.tenantId, riskIds);

        // Control test runs were removed with the compliance uproot, so a
        // risk's staleness no longer factors in "when was the mitigating
        // control last tested".
        const latestTestByControl = new Map<string, Date>();
        const latestTestByRisk = new Map<string, Date>();
        for (const l of links) {
            const t = latestTestByControl.get(l.controlId);
            if (!t) continue;
            const cur = latestTestByRisk.get(l.riskId);
            if (!cur || t > cur) latestTestByRisk.set(l.riskId, t);
        }

        const now = new Date();
        const staleRisks: StaleRiskRow[] = [];
        for (const r of risks) {
            const verdict = assessStaleness(
                {
                    nextReviewAt: r.nextReviewAt,
                    lastAssessedAt: lastAssessedByRisk.get(r.id) ?? null,
                    lastResidualAt: r.residualScoreSetAt,
                    latestControlTestAt: latestTestByRisk.get(r.id) ?? null,
                    latestKriBreachAt: latestKriBreachByRisk.get(r.id) ?? null,
                },
                now,
            );
            if (verdict.stale) {
                staleRisks.push({
                    riskId: r.id,
                    title: r.title,
                    reasons: verdict.reasons,
                    assessmentAgeDays: verdict.assessmentAgeDays,
                    description: describeStaleness(verdict) ?? '',
                });
            }
        }

        // Most reasons first, then oldest assessment first — the
        // rottenest rows top the widget.
        staleRisks.sort(
            (a, b) =>
                b.reasons.length - a.reasons.length ||
                (b.assessmentAgeDays ?? 0) - (a.assessmentAgeDays ?? 0),
        );

        return {
            staleRisks,
            staleCount: staleRisks.length,
            totalCount: risks.length,
            maxAssessmentAgeDays: MAX_ASSESSMENT_AGE_DAYS,
        };
    });
}
