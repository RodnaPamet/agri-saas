/**
 * What the day's card run produced — one Redis key, no TTL (#2944).
 *
 * ## The question this answers, and the one it deliberately does not
 *
 * P9.10 asks for "a card-health alert if a commodity channel gets no card in a
 * day". Taken literally that fires for 15 of 15 commodity channels today and
 * 12 of 15 yesterday, measured on production — 15 commodity channels, 4 cards
 * ever, and today's single card is a `LISTING`, which goes to the 28 OBLAST
 * channels. A probe that is never green breaks the issue's own argument for
 * watching it, which is that its issue closing on the next green run means
 * something.
 *
 * Owner ruling 2026-11-16: **alert when a card was DUE and did not appear.**
 *
 * `runChannelCards` already derives that, which is why nothing here
 * re-implements it. Its per-kind reading carries `withContent` — "of the
 * eligible, the ones that had content today" — beside `created`, which is
 * `createMany`'s own count. So the whole property is `withContent > created`,
 * computed once, in the job, from the same pass that wrote the rows.
 *
 * Re-deriving eligibility in a probe was the obvious alternative and is the
 * #1664 shape: two spellings of one rule, where the divergence is silent and
 * the probe is the half nobody checks. The news tag reach alone is uneven
 * enough to make that a real risk — 5 of 10 crop channels have a `CROP_TAGS`
 * entry and all 5 input channels share one TOPIC tag.
 *
 * ## Why no TTL, following `mail-canary-record` rather than `worker-heartbeat`
 *
 * Those two are opposite designs on purpose. `worker-heartbeat` lets the key
 * EXPIRE because absence IS its signal. Here absence means "no card run has
 * recorded anything since this shipped", which is a legitimate state on first
 * deploy and must stay distinguishable from "a run recorded something and it
 * was a long time ago" — the job having stopped is a different fault from the
 * job never having reported. A TTL collapses those two, which is the exact
 * confusion the three-verdict requirement exists to prevent.
 *
 * So: written without expiry, and the READER judges staleness from the stored
 * timestamp.
 *
 * ## Nothing here is a secret
 *
 * `/api/readyz` is the GCP uptime check's target, reachable unauthenticated
 * from six probe regions, so everything written here is effectively public.
 * The record holds four small integers per kind plus an ISO instant and the
 * day — counts of channels and cards. No channel key, no post body, no author:
 * a card's text is machine-written from a source we publish anyway, but there
 * is no reason for the probe body to carry any of it.
 *
 * ## Never throws
 *
 * `mail-canary-record`'s argument verbatim: the cards have already been
 * written by the time this runs, and losing the run's outcome to a monitoring
 * write is not a trade worth making. A failed write costs one record, and the
 * reader tolerates a missed run before it says anything.
 */
import type { ChannelCardKindReading } from '@/app-layer/jobs/channel-cards';
import { logger } from '@/lib/observability/logger';

/** Matches the `agrent:` prefix convention (`agrent:mail-canary:last`). */
export const CARD_HEALTH_RECORD_KEY = 'agrent:channel-cards:last';

/**
 * The daily `channel-cards` cron in `schedules.ts`, in minutes.
 *
 * Spelled out rather than quoted, for `mail-canary-record`'s reason: a cron
 * pattern closes a block comment.
 */
export const CARD_HEALTH_PERIOD_MINUTES = 24 * 60;

/**
 * How old a record may get before the reader calls it stale.
 *
 * Sized for the MISS rather than the interval — `worker-heartbeat`'s
 * reasoning, which tolerates four missed beats so one slow job cannot flap the
 * signal. Two missed days plus three hours of slack: a daily control that
 * shouted on a single skip would shout on every deploy that landed near 03:00
 * UTC, and one missed day of cards is not a fault worth waking anybody for.
 */
export const CARD_HEALTH_STALE_AFTER_MINUTES = 2 * 24 * 60 + 3 * 60;

/**
 * The one command the writer needs, so a caller can pass anything that has it
 * — `MailCanaryRecordWriter`'s pattern. A real `Redis` satisfies it
 * structurally and a test double satisfies it without a cast, which is the
 * point: casting a double to `Redis` costs an `eslint-disable` per call site,
 * and the Lint gate prices a suppression exactly like the warning it hides.
 */
export interface CardHealthRecordWriter {
    set(key: string, value: string): Promise<unknown>;
}

/** The one command the reader needs. */
export interface CardHealthRecordReader {
    get(key: string): Promise<string | null>;
}

/** Per kind, the two numbers the verdict is computed from, plus context. */
export interface CardHealthKindEntry {
    readonly channels: number;
    readonly eligible: number;
    /** Of the eligible, the ones that HAD CONTENT — i.e. were DUE a card. */
    readonly withContent: number;
    /** Rows actually inserted. */
    readonly created: number;
    readonly dormant: boolean;
}

export interface CardHealthRecord {
    /** ISO-8601 instant the run finished. */
    readonly at: string;
    /** The Sofia calendar day the run was generating for, `YYYY-MM-DD`. */
    readonly day: string;
    readonly byKind: Readonly<Record<string, CardHealthKindEntry>>;
}

/**
 * Persist one card run's reading. Never throws — see the docblock.
 */
export async function recordCardHealth(
    redis: CardHealthRecordWriter | null,
    at: Date,
    day: string,
    byKind: Record<string, ChannelCardKindReading>,
): Promise<void> {
    if (!redis) return;
    const record: CardHealthRecord = {
        at: at.toISOString(),
        day,
        byKind: Object.fromEntries(
            Object.entries(byKind).map(([kind, r]) => [
                kind,
                {
                    channels: r.channels,
                    eligible: r.eligible,
                    withContent: r.withContent,
                    created: r.created,
                    dormant: r.dormant,
                },
            ]),
        ),
    };
    try {
        await redis.set(CARD_HEALTH_RECORD_KEY, JSON.stringify(record));
    } catch (err) {
        logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'channel_cards.health_record_failed',
        );
    }
}

/**
 * Parse a stored record, or null.
 *
 * Validates the SHAPE rather than trusting it, because a record written by an
 * older or newer deploy is a real possibility on one shared Redis and a
 * half-parsed record would produce a confident verdict from missing numbers.
 * A non-finite or negative count is refused for the same reason: the verdict
 * is an inequality, and `undefined > undefined` is `false`, which would read
 * as clean.
 */
export function parseCardHealthRecord(raw: string | null): CardHealthRecord | null {
    if (!raw) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const r = parsed as Partial<CardHealthRecord>;
    if (typeof r.at !== 'string' || !r.at) return null;
    if (typeof r.day !== 'string' || !r.day) return null;
    if (Number.isNaN(Date.parse(r.at))) return null;
    if (!r.byKind || typeof r.byKind !== 'object') return null;

    const byKind: Record<string, CardHealthKindEntry> = {};
    for (const [kind, value] of Object.entries(r.byKind)) {
        if (!value || typeof value !== 'object') return null;
        const e = value as Partial<CardHealthKindEntry>;
        const nums = [e.channels, e.eligible, e.withContent, e.created];
        if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) return null;
        if (typeof e.dormant !== 'boolean') return null;
        byKind[kind] = {
            channels: e.channels as number,
            eligible: e.eligible as number,
            withContent: e.withContent as number,
            created: e.created as number,
            dormant: e.dormant as boolean,
        };
    }
    // An empty `byKind` is refused: the run reports four kinds, so zero of them
    // means the reading was not produced by a run we understand — and an empty
    // object would otherwise satisfy every "no kind is short" loop below.
    if (Object.keys(byKind).length === 0) return null;
    return { at: r.at, day: r.day, byKind };
}
