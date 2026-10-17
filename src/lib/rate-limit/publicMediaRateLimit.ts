/**
 * Edge rate limit for PUBLIC farm-profile images. P6.3 (#1812).
 *
 * ## Why this is not the public-read tier
 *
 * `publicReadRateLimit` is 60/min/IP and fits what it covers: one request per
 * user action — a directory search, an invite lookup. Images are not that.
 * A farm profile is a logo plus a few photographs (the owner's scope), so one
 * page view is about six requests to `/api/public/media/{hash}`, and a visitor
 * browsing profiles would reach 60 somewhere around the ninth page.
 *
 * The failure would also be invisible. A throttled JSON read returns a 429 a
 * client can show; a throttled image is a broken picture that explains
 * nothing, so a visitor reads it as the product being broken rather than as a
 * limit they tripped.
 *
 * `PUBLIC_READ_PREFIXES` already reasons exactly this way, and that is the
 * sharper argument: `/f/` can sit at 60/min *because* its assets come from
 * `/_next/static/*` and "do not count against the budget". Serving images
 * through an API route makes them count. Putting this prefix in that tier
 * would therefore have retroactively broken the argument that justified `/f/`'s
 * own entry — the two could not both be right.
 *
 * Same shape of reasoning, and the same separation, as `scimRateLimit.ts` and
 * `apiKeyRateLimit.ts`: a distinct population gets a distinct bucket rather
 * than competing for one.
 *
 * ## It is still at the EDGE
 *
 * Which is the half the phase asks for. Refusing here costs a comparison;
 * reaching the handler costs a projection query and a storage read. 300/min
 * refuses a flood cheaply while leaving a real visitor about fifty profiles a
 * minute.
 *
 * ## GET only
 *
 * The route exports only `GET`, so nothing else should reach it — but the
 * predicate says so independently rather than relying on that, because
 * `isPublicPath` opens a prefix for every method and a future mutating export
 * must not silently inherit this budget.
 */
import { NextRequest, NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

import { env } from '@/env';
import { PUBLIC_MEDIA_LIMIT } from '@/lib/security/rate-limit';
import { edgeLogger } from '@/lib/observability/edge-logger';
import {
    type Bucket,
    isRateLimitBypassed,
    getClientIp,
    checkMemoryBucket,
    toBucket,
    rateLimitedResponse,
} from './edge-bucket';

/**
 * The one prefix this tier covers.
 *
 * Trailing slash, matched with `startsWith`, for the reason the public-read
 * tier learned the hard way on `/f`: a bare `/api/public/media` would also
 * claim a future `/api/public/mediaX`. Over-throttling does not leak anything,
 * but it takes the product down — availability and safety are not the same
 * axis, and the slash is what keeps them apart.
 */
const PUBLIC_MEDIA_PREFIX = '/api/public/media/';

/**
 * Which requests this tier claims. The ONE definition — the middleware calls
 * it rather than re-testing the prefix, so the two cannot drift.
 */
export function isPublicMediaRateLimited(method: string, pathname: string): boolean {
    if (method !== 'GET') return false;
    return pathname.startsWith(PUBLIC_MEDIA_PREFIX);
}

const _memoryCache = new Map<string, { count: number; resetAt: number }>();
let _limiter: Ratelimit | null = null;
let _initialized = false;

function init(): void {
    if (_initialized) return;
    _initialized = true;
    if (env.RATE_LIMIT_MODE !== 'upstash') return;
    try {
        _limiter = new Ratelimit({
            redis: Redis.fromEnv(),
            limiter: Ratelimit.slidingWindow(
                PUBLIC_MEDIA_LIMIT.maxAttempts,
                `${PUBLIC_MEDIA_LIMIT.windowMs} ms`,
            ),
            prefix: 'rl:public-media',
        });
    } catch (err) {
        edgeLogger.error('Public media rate limiter init failed; using memory fallback', {
            component: 'rate-limit',
            err: String(err),
        });
    }
}

/** Test seam — the memory fallback is module state. */
export function _clearPublicMediaRateLimitMemory(): void {
    _memoryCache.clear();
}

export interface PublicMediaRateLimitResult {
    ok: boolean;
    /** Pre-built 429 when blocked; absent when allowed. */
    response?: NextResponse;
}

export async function checkPublicMediaRateLimit(
    req: NextRequest,
): Promise<PublicMediaRateLimitResult> {
    if (isRateLimitBypassed()) return { ok: true };
    init();

    const key = `rl:public-media:ip:${getClientIp(req)}`;

    let bucket: Bucket;
    try {
        bucket = _limiter
            ? toBucket(await _limiter.limit(key))
            : checkMemoryBucket(_memoryCache, key, PUBLIC_MEDIA_LIMIT);
    } catch (err) {
        // Fail OPEN, like every sibling tier. A limiter outage must not take
        // the public pages' images down with it.
        edgeLogger.error('Public media rate limit check failed; allowing request', {
            component: 'rate-limit',
            err: String(err),
        });
        return { ok: true };
    }

    if (bucket.ok) return { ok: true };

    // No IP at warn level — it is PII, and here it is the entire key. The
    // request-id on the response ties this back in the logs.
    edgeLogger.warn('Public media rate limit exceeded', {
        component: 'rate-limit',
        scope: 'public-media',
    });
    return { ok: false, response: rateLimitedResponse(bucket) };
}
