/**
 * Per-day usage counters — "which clients use which surfaces, how much?"
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT route-outcomes ──
 *
 * `route-outcomes.ts` answers "how did requests to this endpoint END?" and is
 * keyed by status. This answers a different question for a different consumer:
 * OD9 defers the five-tab navigation decision until there are 30 days of usage
 * data, and P10 cannot start without it. Folding a client axis into the outcome
 * counter would multiply its cardinality by the client count to answer a
 * question it was not built for, so this is a sibling rather than a column.
 *
 * It starts a CLOCK. Every day this is not deployed is a day P10 moves right,
 * which is why it ships in P0 rather than next to the thing that reads it.
 *
 * ── SHAPE ──
 *
 *   key    `api:usage:v1:<YYYY-MM-DD>`        one hash per UTC DAY
 *   field  `<client>|<device>|<METHOD> <route>`
 *   value  request count
 *
 * DAILY, not hourly like route-outcomes: the consumer is a 30-day window, so
 * hourly buckets would be 720 keys to answer a question that needs 30, and the
 * hour is not a dimension anyone will group by.
 *
 * ── WHAT IS DELIBERATELY NOT IN A FIELD ──
 *
 * No user id, tenant id, IP, query string, session, or device identifier. Not
 * as a matter of taste: a counter keyed by anything per-person is a behavioural
 * log of a named user, and this exists to decide a tab bar. Each of the three
 * axes is bounded by construction:
 *
 *   client  a fixed enum — `ios/1.0`-shaped, or `other` / `unknown`
 *   device  three values — `mobile`, `desktop`, `unknown`
 *   route   the normalised template, allowlisted, everything else `other`
 *
 * ── CARDINALITY, BOUNDED THREE WAYS ──
 *
 * The allowlist is the primary bound: an un-allowlisted route counts as `other`
 * rather than minting a field, so a new endpoint cannot grow this hash. The
 * field cap is the backstop for a mistake in the allowlist itself. And the TTL
 * means any surprise self-heals in a month rather than growing forever.
 *
 * @module lib/observability/usage-counter
 */
import { getRedis } from '@/lib/redis';
import { logger } from './logger';

/** Key namespace. Bump the suffix if the field encoding changes. */
export const USAGE_PREFIX = 'api:usage:v1';

/** The window P10 consumes. OD9 defers the tab decision until this much exists. */
export const USAGE_WINDOW_DAYS = 30;

/** Two days of slack beyond the window, so the oldest bucket a late run reads is alive. */
export const USAGE_TTL_SECONDS = (USAGE_WINDOW_DAYS + 2) * 24 * 3600;

/**
 * Hard cap on distinct fields in one day's hash.
 *
 * The allowlist should make this unreachable. It exists because an allowlist is
 * a list someone maintains, and the failure mode of getting it wrong is an
 * unbounded hash in a `noeviction` Redis — which fails WRITES, including
 * BullMQ's. The cap turns a bad allowlist into lost counts rather than a
 * stalled queue.
 */
export const USAGE_MAX_FIELDS = 2000;

/** Clients we count by name. Anything else buckets, so this list is not a gate. */
const KNOWN_PLATFORMS = new Set(['ios', 'android', 'web']);

/** `<platform>/<major>.<minor>` — the grammar agreed with the iOS session. */
const CLIENT_RE = /^([a-z]+)\/(\d{1,3})\.(\d{1,3})$/;

/**
 * Longest `X-Agrent-Client` we will even parse.
 *
 * A CPU guard, NOT a correctness one, and the distinction was established by
 * mutation: deleting this constant fails no test, because an over-long value is
 * already rejected by the grammar or the platform allowlist. What it buys is not
 * regex-matching a 10KB header on every request.
 */
const MAX_CLIENT_HEADER_BYTES = 32;

/**
 * Normalise `X-Agrent-Client` into a counter dimension.
 *
 * NEVER throws and never rejects the request — this is telemetry, and a header
 * that could fail a request would mean a server-side change to the accepted set
 * could break an installed mobile build. Absent is `unknown`; anything
 * unparseable or unknown-platform is `other`. Both are real answers.
 *
 * An EMPTY value counts as absent, not malformed. Strictly it is "present but
 * empty", which argues for `other` - but HTTP stacks disagree about whether a
 * missing header reads as `null` or `''`, and a proxy normalising one to the
 * other would relabel all absent traffic as malformed. Conflating them loses
 * the ability to spot a client sending a blank header; the alternative corrupts
 * the main signal.
 */
export function normaliseClient(raw: string | null | undefined): string {
    if (!raw) return 'unknown';
    const value = raw.trim();
    if (value.length === 0 || value.length > MAX_CLIENT_HEADER_BYTES) return 'other';
    const m = CLIENT_RE.exec(value);
    if (!m || !KNOWN_PLATFORMS.has(m[1])) return 'other';
    return `${m[1]}/${m[2]}.${m[3]}`;
}

/**
 * Coarse device class, from the `Sec-CH-UA-Mobile` client hint.
 *
 * A hint rather than a User-Agent parse on purpose: `?0` / `?1` is two values
 * and carries nothing identifying, where a UA string is high-cardinality and is
 * itself close to a fingerprint. Absent (Safari, curl, older browsers) is
 * `unknown` and is expected to be common rather than exceptional.
 */
export function normaliseDevice(secChUaMobile: string | null | undefined): string {
    if (secChUaMobile === '?1') return 'mobile';
    if (secChUaMobile === '?0') return 'desktop';
    return 'unknown';
}

/**
 * The product SURFACE a normalised route belongs to — `journal`, `exchange`,
 * `admin` — or `other`.
 *
 * A DEVIATION from the plan's wording, stated rather than quietly taken. P0.5
 * says "an allowlist of route templates"; this derives a surface instead, for
 * two reasons:
 *
 *   · a hand-maintained list of ~369 route templates drifts, and the drift is
 *     invisible — a new route silently stops being counted, which is the same
 *     failure as not counting at all;
 *   · the question this data answers is OD9's, "which five tabs", and a TAB maps
 *     to a surface, not to a route. Counting `/journal` and `/journal/:id`
 *     separately splits one answer across two fields.
 *
 * Cardinality is still bounded, and more tightly: the number of distinct first
 * segments under `/api` is the number of surface groups (tens), not the number
 * of routes (hundreds). The shape check is the allowlist — anything that is not
 * a plain short segment is `other`, so a malformed or injected path cannot mint
 * a field.
 *
 * Method is kept separately in the field, because reading a surface and writing
 * to it are different signals for a navigation decision.
 */
export function usageSurface(normalisedRoute: string): string {
    // `/api/t/:tenantSlug/journal/:id` -> `journal/:id` -> `journal`
    let rest = normalisedRoute.replace(/^\/api\//, '');
    rest = rest.replace(/^t\/:tenantSlug\//, '');
    const first = rest.split('/')[0] ?? '';
    // The bound: a plain short segment, or nothing.
    return /^[a-z0-9-]{1,24}$/.test(first) ? first : 'other';
}

/** The Redis hash key for the UTC day `at` falls in. */
export function usageBucketKey(at: Date): string {
    // `2026-10-01T18:41:03.123Z`.slice(0, 10) → `2026-10-01`
    return `${USAGE_PREFIX}:${at.toISOString().slice(0, 10)}`;
}

/** `<client>|<device>|<METHOD> <route>`. Client leads, so parsing splits on the first two `|`. */
export function usageField(client: string, device: string, method: string, route: string): string {
    return `${client}|${device}|${method.toUpperCase()} ${route}`;
}

/** One field decoded back into its parts, or null if it is not ours. */
export function parseUsageField(
    field: string,
): { client: string; device: string; method: string; route: string } | null {
    const first = field.indexOf('|');
    if (first <= 0) return null;
    const second = field.indexOf('|', first + 1);
    if (second <= first + 1) return null;
    const rest = field.slice(second + 1);
    const space = rest.indexOf(' ');
    if (space <= 0) return null;
    return {
        client: field.slice(0, first),
        device: field.slice(first + 1, second),
        method: rest.slice(0, space),
        route: rest.slice(space + 1),
    };
}

let _warnedOnce = false;
let _cappedOnce = false;

/** Test seam — the warn-once latches would otherwise leak between cases. */
export function __resetUsageWarningsForTests(): void {
    _warnedOnce = false;
    _cappedOnce = false;
}

/**
 * Count one request. Fire-and-forget; never throws, never awaited by a handler.
 *
 * `route` must already be allowlist-resolved by the caller — this module does
 * not own the allowlist, because the list is about product surfaces and lives
 * next to them.
 */
export function recordUsage(attrs: {
    client: string;
    device: string;
    method: string;
    route: string;
}): void {
    try {
        const redis = getRedis();
        if (!redis) return;
        // Feature-detect rather than assume: route unit tests stub `@/lib/redis`
        // with partial doubles, which is the ordinary case and not an error.
        if (typeof redis.pipeline !== 'function' || typeof redis.hlen !== 'function') return;

        const key = usageBucketKey(new Date());
        const field = usageField(attrs.client, attrs.device, attrs.method, attrs.route);

        void (async () => {
            try {
                // The backstop. Checked BEFORE the write so a runaway allowlist
                // costs counts rather than memory in a noeviction Redis.
                const size = await redis.hlen(key);
                if (size >= USAGE_MAX_FIELDS) {
                    if (!_cappedOnce) {
                        _cappedOnce = true;
                        logger.warn('usage-counter.field_cap_reached', {
                            component: 'usage-counter',
                            key,
                            cap: USAGE_MAX_FIELDS,
                        });
                    }
                    return;
                }
                await redis.pipeline().hincrby(key, field, 1).expire(key, USAGE_TTL_SECONDS).exec();
            } catch (err) {
                if (!_warnedOnce) {
                    _warnedOnce = true;
                    logger.warn('usage-counter.write_failed', {
                        component: 'usage-counter',
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }
        })();
    } catch {
        // A telemetry counter must never surface into a request.
    }
}

/** The bucket keys covering the last `days` days, newest first. */
export function usageBucketKeys(days: number, now: Date): string[] {
    const out: string[] = [];
    for (let i = 0; i < days; i++) {
        out.push(usageBucketKey(new Date(now.getTime() - i * 24 * 3600 * 1000)));
    }
    return out;
}
