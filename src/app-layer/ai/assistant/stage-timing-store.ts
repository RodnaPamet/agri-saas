import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';

/**
 * Persist one `assistant.stage_timing` row per answered question — #2751.
 *
 * ## Why a table when the log line already exists
 *
 * It has been emitted since #2670 and read by nobody. `docker logs` holds only
 * the CURRENT container's output and Watchtower prunes the old one on every
 * deploy, so measured on production 2026-11-06 there were **zero rows
 * available** — against ~20 answered questions all-time. The figures #2751
 * needs in order to decide which model each round should run on were being
 * destroyed faster than they accumulated, which is why "gather them first" was
 * not a plan.
 *
 * Persisted rather than exported because this deployment runs no Prometheus
 * collector: `recordJobMetrics` and the OTel reporters emit into nothing, the
 * same reason `AuditRowLost` is a declared alerting rule that fires for
 * nobody.
 *
 * ## BEST EFFORT, and that is the load-bearing property
 *
 * This runs on the path that answers a farmer's question. A telemetry write
 * must never be the reason an answer fails, so the insert is wrapped and
 * swallowed — the #1269 convention the audit extension uses for the same
 * reason. The cost is the one that convention always carries: a silent
 * failure here looks exactly like a quiet period, which is why the catch
 * LOGS rather than merely returning.
 *
 * ## Why it is not folded into `AiUsageEvent`
 *
 * Granularity, not tidiness. That table is written per PROVIDER CALL inside
 * `completeWithRouting`, and one answered question makes two or more — the
 * `providerCalls` field below is that count. A timing column there would
 * record the whole question's total against each individual call, so every
 * row would overstate it.
 */

export interface StageTiming {
    readonly totalMs: number;
    readonly providerMs: number;
    readonly providerCalls: number;
    readonly toolSelectMs: number;
    readonly answerMs: number;
    readonly toolPhaseMs: number;
    readonly otherMs: number;
    readonly toolCallsMade: number;
    readonly halt: string | null;
}

/**
 * Write the row. Never throws.
 *
 * Takes `tenantId` explicitly rather than reading a context, so the caller
 * cannot accidentally attribute one farm's timing to another — and so this is
 * callable from the tool loop, which already holds it.
 */
export async function recordStageTiming(
    tenantId: string,
    timing: StageTiming,
): Promise<void> {
    try {
        await prisma.assistantStageTiming.create({
            data: { tenantId, ...timing },
            select: { id: true },
        });
    } catch (err) {
        /*
         * Swallowed, and reported. The business outcome — the answer — has
         * already been produced by the time this runs, so failing it
         * afterwards would be strictly worse than losing the measurement.
         *
         * The log line is what stops "the assistant is quiet" and "the
         * telemetry is broken" being the same observation, which is the
         * failure mode #1269 measured at 275 of 275 swallowed audit writes
         * with no signal of any kind.
         */
        logger.warn('assistant.stage_timing_write_failed', {
            component: 'assistant',
            tenantId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
