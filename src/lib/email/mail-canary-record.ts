/**
 * The canary's durable record — one Redis key, no TTL (#2467).
 *
 * ## The gap this closes, and it is not the one the issue describes
 *
 * #2467 says the canary writes "no durable records — no row, no Redis key".
 * The first half is right and the conclusion needs sharpening: BullMQ DOES
 * retain the canary's outcome, because the executor returns it inside
 * `makeResult` and completed jobs are kept in Redis, which outlives the
 * container. That is how #2121's question was answered at all — four canary
 * runs read back out of `inflect-jobs`, every one `itemsActioned: 1`.
 *
 * The real problem is that the retention is a per-queue COUNT, not a period,
 * and the count is consumed by unrelated work:
 *
 *   | | |
 *   | --- | --- |
 *   | `removeOnComplete` on `inflect-jobs` | 500 |
 *   | scheduled completions per day (31 repeatables) | ~1711 |
 *   | ...per hour | ~71 |
 *   | **eviction window** | **~7.0 hours** |
 *   | `mail-canary` period | **6.0 hours** |
 *
 * `health-check` alone is 720 runs/day on that queue. So the canary's record
 * outlives one interval by about an hour, and any ad-hoc job volume pushes the
 * window under six hours — at which point the previous run is evicted before
 * the next one lands and the history is unobservable again, in Redis this time
 * rather than in the log. A 17% margin against the thing being recorded is a
 * race, not a record.
 *
 * Hence one key that nothing else writes and nothing evicts.
 *
 * ## Why no TTL, when its sibling is all TTL
 *
 * `worker-heartbeat` is the opposite design on purpose. There, absence IS the
 * signal — nothing deletes the key, it expires, and `EXISTS` going to 0 is how
 * a wedged worker is detected, so there is no cleanup path to forget.
 *
 * Here absence means "no canary has run since this shipped", which is a
 * legitimate state on first deploy and must stay distinguishable from "a
 * canary ran and it was a long time ago". A TTL collapses those two into one
 * observation, which is the exact confusion #2467 is about. So the key is
 * written without expiry and the READER judges staleness from the stored
 * timestamp. One key, a few dozen bytes, overwritten four times a day.
 *
 * ## It records every outcome, not just SENT
 *
 * `SKIPPED_NO_RECIPIENT` and `NOT_CONFIGURED` are the outcomes whose erasure
 * is most dangerous — the job's own docblock says a silent skip is
 * indistinguishable from a passing canary — so recording only successes would
 * rebuild the defect one level up. A canary that has been skipping for a week
 * must read differently from one that has been flying.
 *
 * ## Never throws
 *
 * `worker-heartbeat`'s argument verbatim: the send has already happened by the
 * time this runs, and losing that outcome to a monitoring write is not a trade
 * worth making. A failed write costs one record; the reader tolerates one
 * missed run before it reports anything.
 */
import type { MailCanaryOutcome, MailCanaryResult } from '@/app-layer/jobs/mail-canary';
import { logger } from '@/lib/observability/logger';

/** Matches the `agrent:` prefix convention (`agrent:worker:heartbeat`). */
export const MAIL_CANARY_RECORD_KEY = 'agrent:mail-canary:last';

/** The six-hourly `mail-canary` cron in `schedules.ts`, in minutes.
 * (Spelled out rather than quoted: a cron pattern closes a block comment.) */
export const MAIL_CANARY_PERIOD_MINUTES = 6 * 60;

/**
 * How old a record may get before the reader calls it stale.
 *
 * Two missed runs plus an hour of slack, sized for the MISS rather than the
 * interval — `worker-heartbeat`'s reasoning, which tolerates four missed beats
 * so one slow job or a scheduler restart cannot flap the signal. One missed
 * canary is therefore invisible here, deliberately: a 6-hourly control that
 * shouted on a single skip would shout on every deploy that happened to land
 * on the hour.
 */
export const MAIL_CANARY_STALE_AFTER_MINUTES = 13 * 60;

/**
 * The one command this needs, so a caller can pass anything that has it —
 * `featureFlagsCapability`'s `FeatureFlagKeyReader` pattern. A real `Redis`
 * satisfies it structurally, and a test double satisfies it without a cast,
 * which is the point: casting a double to `Redis` costs an `eslint-disable`
 * per call site, and the Lint gate prices a suppression exactly like the
 * warning it hides.
 */
export interface MailCanaryRecordWriter {
    set(key: string, value: string): Promise<unknown>;
}

export interface MailCanaryRecord {
    /** ISO-8601 instant the run finished. */
    readonly at: string;
    readonly outcome: MailCanaryOutcome;
    /** Provider CLASS name (`ResendProvider`). Never a key, never an address. */
    readonly provider: string;
}

/**
 * Persist the outcome of one canary run. Never throws — see the docblock.
 *
 * Deliberately stores no recipient and no error `detail`. `/api/readyz` is the
 * GCP uptime check's target and is reachable unauthenticated from six regions,
 * so everything written here is effectively public: `MAIL_CANARY_TO` is a real
 * person's address, and a provider error body is unbounded text we did not
 * author. The outcome enum is the whole signal, and the log already carries the
 * detail for whoever has log access.
 */
export async function recordMailCanaryRun(
    connection: MailCanaryRecordWriter,
    result: MailCanaryResult,
    now: () => Date = () => new Date(),
): Promise<void> {
    const record: MailCanaryRecord = {
        at: now().toISOString(),
        outcome: result.outcome,
        provider: result.provider,
    };
    try {
        // No `EX`: absence must keep meaning "never ran". See the docblock.
        await connection.set(MAIL_CANARY_RECORD_KEY, JSON.stringify(record));
    } catch (err) {
        logger.warn('mail_canary.record_write_failed', {
            component: 'mail-canary-record',
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

const OUTCOMES: readonly MailCanaryOutcome[] = [
    'SENT',
    'SKIPPED_NO_RECIPIENT',
    'NOT_CONFIGURED',
    'FAILED',
];

/**
 * Parse a stored record, or `null` if it is absent or unreadable.
 *
 * A malformed value reads as `null` — the same as absent — rather than
 * throwing into a probe that must never throw. It is validated field by field
 * because this value survives deploys: a record written by an older image must
 * not be able to put an arbitrary string into a public response body.
 */
export function parseMailCanaryRecord(raw: string | null): MailCanaryRecord | null {
    if (!raw) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { at, outcome, provider } = parsed as Record<string, unknown>;
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
    if (typeof outcome !== 'string' || !OUTCOMES.includes(outcome as MailCanaryOutcome)) return null;
    if (typeof provider !== 'string') return null;
    return { at, outcome: outcome as MailCanaryOutcome, provider };
}
