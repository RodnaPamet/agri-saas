/**
 * Is the mail canary still flying? (#2467)
 *
 * ## The #781 treatment, sixth instance
 *
 * WATCHED, not gated. This sits OUTSIDE `checks`/`failed` like `basemap`,
 * `email`, `platformConsole` and `featureFlags`, and can never 503 the probe —
 * which matters here as much as for any of them, because `/api/readyz` is the
 * GCP uptime check's target and a canary that missed a run must never page
 * anybody. The canary reports on the MAIL path; a gap in it is not an outage
 * of this service.
 *
 * ## Five states, and each exists to stop one confusion
 *
 *   - `ok` — a record inside the window, outcome `SENT`. A real transport
 *     accepted a message recently.
 *   - `not_sending` — a record inside the window whose outcome is NOT `SENT`.
 *     The canary is running and telling us something: no recipient, a console
 *     sink, or a rejection. Separate from `stale` because "running and
 *     reporting a problem" and "not known to be running" need different
 *     actions, and collapsing them is how the log-only version of this signal
 *     became useless.
 *   - `stale` — the newest record is older than
 *     `MAIL_CANARY_STALE_AFTER_MINUTES`. This is #2467's signal: the canary
 *     has stopped, or the scheduler lost the repeatable.
 *   - `never_recorded` — no key at all. The honest answer immediately after
 *     this ships, and it must stay distinguishable from `stale`, which is
 *     exactly why the key carries no TTL.
 *   - `unknown` — Redis is unconfigured, or the read failed. Reported rather
 *     than folded into `stale`, for `featureFlagsCapability`'s reason: during
 *     a Redis incident every probe would otherwise shout about a mail problem
 *     that does not exist, and the real signal in that window is
 *     `checks.redis`, which `readyz` already reports.
 *     `a-finding-wants-both-questions` — this guards the false alarm as well
 *     as the miss.
 *
 * ## Why `MAIL_CANARY_TO` is deliberately NOT read here
 *
 * The tempting shape is to report `unconfigured` when the env var is unset.
 * But the component that KNOWS whether the canary had a recipient is the
 * worker that ran it, and it already says so: `SKIPPED_NO_RECIPIENT` is a
 * recorded outcome. Reading the env a second time, in a different container,
 * would introduce a way for the two answers to disagree — and the one derived
 * from the actual run is the one worth having. Both containers take the same
 * `env_file` today, so the second read would usually agree; "usually agree" is
 * not a property worth adding a second source of truth for.
 *
 * ## Nothing here is a secret, and that is checked rather than assumed
 *
 * This endpoint is reachable unauthenticated from six probe regions, so its
 * body is public. The capability reports an enum, an ISO timestamp, an age in
 * minutes and a provider CLASS name. It never reports `MAIL_CANARY_TO` — a
 * real person's address — and never the provider's error `detail`, which is
 * unbounded text we did not author. `recordMailCanaryRun` does not persist
 * either one, so there is nothing here to leak even by accident.
 *
 * ## Not memoized
 *
 * `platformConsoleCapability`'s reason: the state changes without a restart.
 * A canary run moves `stale` → `ok` while the process keeps running, and a
 * cached `stale` would be the stale alarm that teaches people to ignore the
 * report. One `GET` of one small key against a probe every 60s.
 */
import type { MailCanaryOutcome } from '@/app-layer/jobs/mail-canary';
import {
    MAIL_CANARY_PERIOD_MINUTES,
    MAIL_CANARY_RECORD_KEY,
    MAIL_CANARY_STALE_AFTER_MINUTES,
    parseMailCanaryRecord,
} from '@/lib/email/mail-canary-record';
import { logger } from '@/lib/observability/logger';

/** The one command this needs — see `MailCanaryRecordWriter` for why. */
export interface MailCanaryRecordReader {
    get(key: string): Promise<string | null>;
}

export type MailCanaryState = 'ok' | 'not_sending' | 'stale' | 'never_recorded' | 'unknown';

export interface MailCanaryCapability {
    readonly state: MailCanaryState;
    /** What the last recorded run did. `null` unless a record was read. */
    readonly outcome: MailCanaryOutcome | null;
    /** ISO instant of that run, or `null`. */
    readonly lastRunAt: string | null;
    /** Age of that record in whole minutes, or `null`. */
    readonly ageMinutes: number | null;
    /** The schedule, so `ageMinutes` has a scale without reading the source. */
    readonly expectedEveryMinutes: number;
    /** The age at which `stale` starts, so the reading is self-describing. */
    readonly staleAfterMinutes: number;
}

const BASE = {
    outcome: null,
    lastRunAt: null,
    ageMinutes: null,
    expectedEveryMinutes: MAIL_CANARY_PERIOD_MINUTES,
    staleAfterMinutes: MAIL_CANARY_STALE_AFTER_MINUTES,
} as const;

/**
 * @param connection a Redis client, or `null` when Redis is unconfigured.
 *        Injected rather than imported for `featureFlagsCapability`'s reason —
 *        `readyz` already resolves its own client, and a module-level import
 *        here would widen that route's graph for nothing.
 */
export async function mailCanaryCapability(
    connection: MailCanaryRecordReader | null,
    now: () => Date = () => new Date(),
): Promise<MailCanaryCapability> {
    if (!connection) return { ...BASE, state: 'unknown' };

    let raw: string | null;
    try {
        raw = await connection.get(MAIL_CANARY_RECORD_KEY);
    } catch (err) {
        // `unknown`, never `stale` — see the docblock. An unreadable Redis is a
        // Redis problem, and reporting it as a mail problem sends an operator
        // to the wrong subsystem during an incident.
        logger.warn('mail_canary.capability_read_failed', {
            component: 'mail-canary-capability',
            error: err instanceof Error ? err.message : String(err),
        });
        return { ...BASE, state: 'unknown' };
    }

    const record = parseMailCanaryRecord(raw);
    if (!record) return { ...BASE, state: 'never_recorded' };

    const ageMs = now().getTime() - Date.parse(record.at);
    // A record stamped in the future is a clock problem, not a fresh canary.
    // Clamp rather than report a negative age, and let it read as fresh: the
    // alternative is a mail alarm for an NTP fault.
    const ageMinutes = Math.max(0, Math.floor(ageMs / 60_000));

    const state: MailCanaryState =
        ageMinutes > MAIL_CANARY_STALE_AFTER_MINUTES
            ? 'stale'
            : record.outcome === 'SENT'
              ? 'ok'
              : 'not_sending';

    return {
        ...BASE,
        state,
        outcome: record.outcome,
        lastRunAt: record.at,
        ageMinutes,
    };
}
