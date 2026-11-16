/**
 * Did the day's cards actually land? (#2944)
 *
 * ## The #781 treatment, tenth instance
 *
 * WATCHED, not gated. This sits OUTSIDE `checks`/`failed` like `basemap`,
 * `email`, `platformConsole`, `featureFlags`, `mailCanary`, `worker` and
 * `documentStorage`, and can never 503 the probe — which matters as much here
 * as for any of them, because `/api/readyz` is the GCP uptime check's target
 * and a quiet news feed must never page anybody. A missing card is a content
 * problem, not an outage of this service.
 *
 * ## Five states, and the probe collapses them to three
 *
 * #2944 asks for `clean` / `missing` / `unaudited`, copying
 * `check-release-sboms.mjs`, and that is the PROBE's contract — three
 * verdicts, exit 0 only on `clean`. This capability reports more than three on
 * purpose, because `mail-canary-capability` already paid for the lesson: the
 * states it folds together are the ones an operator needs separated.
 *
 *   - `ok` — a record inside the window, and no kind is short. Every channel
 *     that was DUE a card got one.
 *   - `cards_missing` — a record inside the window where some kind has
 *     `withContent > created`. Content existed for a channel and no card was
 *     written for it. This is the finding.
 *   - `stale` — the newest record is older than
 *     `CARD_HEALTH_STALE_AFTER_MINUTES`. The job has stopped, or the scheduler
 *     lost the repeatable. Separate from `cards_missing` because "running and
 *     reporting a gap" and "not known to be running" need different actions.
 *   - `never_recorded` — no key at all. The honest answer immediately after
 *     this ships, and it must stay distinguishable from `stale`, which is
 *     exactly why the key carries no TTL.
 *   - `unknown` — Redis is unconfigured, or the read failed. Reported rather
 *     than folded into `stale`, for `featureFlagsCapability`'s reason: during
 *     a Redis incident every probe would otherwise shout about a card problem
 *     that does not exist, and the real signal in that window is
 *     `checks.redis`, which `readyz` already reports.
 *     `a-finding-wants-both-questions` — this guards the false alarm as well
 *     as the miss.
 *
 * ## `dormant` rides along, because a zero needs its denominator
 *
 * P9.4 reports `dormant` beside `created` so that "the rule ran and found
 * nothing" and "the kind cannot fire" are not one ambiguous number — EVENT is
 * dormant today because `AgriEvent` has no producer (#3078). The same applies
 * here one level up: `shortfall: 0` over four dormant kinds is not the same
 * observation as `shortfall: 0` over four live ones, and the probe's
 * `unaudited` verdict is what keeps the empty case from reading as clean.
 *
 * So the capability reports `kindsConsidered` and `kindsDormant` next to the
 * verdict. An empty population produces zero problems, byte-identical to a
 * clean result, and that is the whole reason the third verdict exists.
 *
 * ## Not memoized
 *
 * `platformConsoleCapability`'s reason: the state changes without a restart. A
 * card run moves `cards_missing` → `ok` while the process keeps running, and a
 * cached alarm is the one that teaches people to ignore the report. One `GET`
 * of one small key against a probe every 60s.
 */
import {
    CARD_HEALTH_PERIOD_MINUTES,
    CARD_HEALTH_RECORD_KEY,
    CARD_HEALTH_STALE_AFTER_MINUTES,
    parseCardHealthRecord,
    type CardHealthRecordReader,
} from '@/lib/channels/card-health-record';
import { logger } from '@/lib/observability/logger';

export type CardHealthState =
    | 'ok'
    | 'cards_missing'
    | 'stale'
    | 'never_recorded'
    | 'unknown';

export interface CardHealthCapability {
    readonly state: CardHealthState;
    /** ISO instant of the newest record, when there is one. */
    readonly at?: string;
    /** The Sofia day that record was generating for. */
    readonly day?: string;
    readonly ageMinutes?: number;
    /** How many kinds the record carried — the DENOMINATOR for `shortfall`. */
    readonly kindsConsidered?: number;
    /** Of those, how many cannot fire at all (`eligible === 0`). */
    readonly kindsDormant?: number;
    /** Total `withContent - created` across kinds, floored per kind at zero. */
    readonly shortfall?: number;
    /** The kinds that were short, so the finding names itself. */
    readonly shortKinds?: readonly string[];
    readonly periodMinutes: number;
    readonly staleAfterMinutes: number;
}

export async function cardHealthCapability(
    redis: CardHealthRecordReader | null,
    now: Date = new Date(),
): Promise<CardHealthCapability> {
    const base = {
        periodMinutes: CARD_HEALTH_PERIOD_MINUTES,
        staleAfterMinutes: CARD_HEALTH_STALE_AFTER_MINUTES,
    } as const;

    if (!redis) return { state: 'unknown', ...base };

    let raw: string | null;
    try {
        raw = await redis.get(CARD_HEALTH_RECORD_KEY);
    } catch (err) {
        logger.warn('channel_cards.health_read_failed', {
            component: 'card-health',
            error: err instanceof Error ? err.message : String(err),
        });
        return { state: 'unknown', ...base };
    }

    const record = parseCardHealthRecord(raw);
    if (!record) {
        // An unparseable record is reported as never_recorded rather than
        // unknown: `unknown` means "could not look", and we looked. A record
        // we cannot read is indistinguishable from one that was never written
        // as far as what it tells us about the cards.
        return { state: 'never_recorded', ...base };
    }

    const ageMinutes = Math.max(
        0,
        Math.round((now.getTime() - Date.parse(record.at)) / 60_000),
    );
    const entries = Object.entries(record.byKind);
    const kindsConsidered = entries.length;
    const kindsDormant = entries.filter(([, e]) => e.dormant).length;

    // Floored PER KIND, never summed signed. A kind that produced MORE cards
    // than it had content for would otherwise offset a kind that produced
    // fewer, and one short kind is the finding regardless of its neighbours.
    const shortKinds = entries
        .filter(([, e]) => e.withContent > e.created)
        .map(([kind]) => kind);
    const shortfall = entries.reduce(
        (n, [, e]) => n + Math.max(0, e.withContent - e.created),
        0,
    );

    const detail = {
        at: record.at,
        day: record.day,
        ageMinutes,
        kindsConsidered,
        kindsDormant,
        shortfall,
        shortKinds,
        ...base,
    };

    // Staleness is judged FIRST. A stale record's numbers describe a day that
    // is over, so reporting `ok` from them would assert something about today
    // that nothing measured — the `watcher-exhaustion-asserts-success` shape.
    if (ageMinutes > CARD_HEALTH_STALE_AFTER_MINUTES) {
        return { state: 'stale', ...detail };
    }
    if (shortKinds.length > 0) return { state: 'cards_missing', ...detail };
    return { state: 'ok', ...detail };
}
