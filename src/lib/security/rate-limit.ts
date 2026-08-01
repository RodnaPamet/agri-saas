/**
 * In-Memory Rate Limiter
 *
 * Simple sliding-window rate limiter for brute-force protection.
 * Uses a Map to track attempt timestamps per key (IP, userId, etc.).
 *
 * DESIGN: the simple `checkRateLimit` sliding window below is the
 * in-process FALLBACK used when no Upstash env is configured (single-node
 * self-host + tests). The distributed mutation-tier path lives in
 * `@/lib/rate-limit/mutationRateLimit` and delegates here on fallback.
 *
 * The progressive login policy at the bottom (Epic A.3) is likewise
 * distributed-first: it stores its failure timestamps in the shared Upstash
 * client when available (so a rolling deploy / multi-instance fleet enforces
 * one global lockout) and falls back to the process-wide `store` Map when not.
 * See docs/rate-limiting.md "horizontal scale checklist".
 */
import { getUpstashRedis } from '@/lib/rate-limit/upstashClient';
// edgeLogger (not the Node logger): this module is on the Edge import chain via
// apiReadRateLimit.ts → security/rate-limit.ts. edgeLogger runs on both.
import { edgeLogger } from '@/lib/observability/edge-logger';

interface RateLimitEntry {
    timestamps: number[];
}

const store = new Map<string, RateLimitEntry>();

// Clean up stale entries every 5 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanup(windowMs: number) {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of store) {
            entry.timestamps = entry.timestamps.filter(t => now - t < windowMs);
            if (entry.timestamps.length === 0) {
                store.delete(key);
            }
        }
    }, CLEANUP_INTERVAL);
    // Allow Node.js to exit even if timer is running
    if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
        cleanupTimer.unref();
    }
}

export interface RateLimitConfig {
    /** Maximum number of requests allowed in the window */
    maxAttempts: number;
    /** Window duration in milliseconds */
    windowMs: number;
    /** Optional: lockout duration in ms after max attempts exceeded */
    lockoutMs?: number;
}

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    retryAfterMs: number;
}

/**
 * Check if a request is within rate limits.
 *
 * @param key - Unique identifier (e.g., `mfa:${userId}`, `login:${ip}`)
 * @param config - Rate limit configuration
 * @returns Whether the request is allowed and how many attempts remain
 */
export function checkRateLimit(key: string, config: RateLimitConfig): RateLimitResult {
    startCleanup(config.windowMs);

    const now = Date.now();
    const entry = store.get(key) || { timestamps: [] };

    // Remove timestamps outside the window
    const windowStart = now - config.windowMs;
    entry.timestamps = entry.timestamps.filter(t => t > windowStart);

    // Check lockout: if last attempt was within lockout period and at max
    if (config.lockoutMs && entry.timestamps.length >= config.maxAttempts) {
        const lastAttempt = entry.timestamps[entry.timestamps.length - 1];
        const lockoutEnd = lastAttempt + config.lockoutMs;
        if (now < lockoutEnd) {
            return {
                allowed: false,
                remaining: 0,
                retryAfterMs: lockoutEnd - now,
            };
        }
        // Lockout expired, reset
        entry.timestamps = [];
    }

    if (entry.timestamps.length >= config.maxAttempts) {
        store.set(key, entry);
        const oldestInWindow = entry.timestamps[0];
        return {
            allowed: false,
            remaining: 0,
            retryAfterMs: oldestInWindow + config.windowMs - now,
        };
    }

    // Record this attempt
    entry.timestamps.push(now);
    store.set(key, entry);

    return {
        allowed: true,
        remaining: config.maxAttempts - entry.timestamps.length,
        retryAfterMs: 0,
    };
}

/**
 * Reset rate limit for a key (e.g., after successful auth).
 */
export function resetRateLimit(key: string): void {
    store.delete(key);
}

/**
 * For testing: clear all rate limit state.
 */
export function clearAllRateLimits(): void {
    store.clear();
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
}

// ─── Preset Configurations ──────────────────────────────────────────
//
// Each preset encodes a policy choice. The numbers are not arbitrary —
// they balance user ergonomics against abuse resistance. Sizing rule
// of thumb:
//
//   sensitive auth flow   → small window, small budget, lockout
//   normal mutation       → per-minute window, moderate budget
//   highly privileged op  → hour window, tiny budget
//
// When you add a new preset, document the threat model in the JSDoc
// and prefer tighter-than-you-think limits — the middleware returns
// a clean 429 + Retry-After, not an opaque error.

/** MFA verify: 5 attempts per 15 minutes, 5 min lockout after exhaustion */
export const MFA_VERIFY_LIMIT: RateLimitConfig = {
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000,     // 15 minutes
    lockoutMs: 5 * 60 * 1000,     // 5 minute lockout
};

/** MFA enrollment verify: 10 attempts per 15 minutes */
export const MFA_ENROLL_VERIFY_LIMIT: RateLimitConfig = {
    maxAttempts: 10,
    windowMs: 15 * 60 * 1000,
};

/**
 * Login (credentials / SSO callback / password reset):
 *   10 attempts per 15 minutes, 15 min lockout after exhaustion.
 *
 * Threat model: online password brute-force. The lockout doubles as
 * a back-pressure signal — an attacker spraying credentials across
 * thousands of accounts gets degraded throughput per IP even when
 * they rotate usernames, because the middleware keys by IP+userId
 * when available but falls back to IP alone for pre-authentication.
 */
export const LOGIN_LIMIT: RateLimitConfig = {
    maxAttempts: 10,
    windowMs: 15 * 60 * 1000,
    lockoutMs: 15 * 60 * 1000,
};

/**
 * General mutation API: 60 requests per minute per (IP, userId).
 *
 * Threat model: a compromised credential or a runaway client making
 * thousands of writes per second. The limit is intentionally
 * generous — normal interactive use doesn't come close (a user
 * filling a detail form might submit 2-3 writes per minute). Scripts
 * and tests that need higher throughput should use an API key with
 * a dedicated rate plan (future work), not share the interactive
 * budget.
 */
export const API_MUTATION_LIMIT: RateLimitConfig = {
    maxAttempts: 60,
    windowMs: 60 * 1000,
};

/**
 * General read API: 120 requests per minute per (IP, userId, tenantSlug).
 *
 * GAP-17. Applied at the Edge middleware to GET requests on
 * `/api/t/<slug>/...`, excluding health probes (`/api/health`,
 * `/api/livez`, `/api/readyz`) and `/api/docs`.
 *
 * Threat model: scraping / accidental overload — a runaway frontend
 * that fans out many list calls per page load, an abusive script
 * iterating filter combinations, or a compromised credential
 * scraping data. The limit is roughly 2× the mutation budget because
 * reads are cheaper, idempotent, and a normal page load can fan
 * out to 5-10 list endpoints (controls + risks + evidence + counts
 * + traceability + …); 120/min comfortably covers that for a single
 * actor while still tripping a real scraper within seconds.
 *
 * Bucketing: per (IP, userId, tenantSlug) so a single user with a
 * runaway tab in tenant A doesn't burn the budget for the same user
 * in tenant B. The tenantSlug appears as a scope namespace in the
 * key, not as part of the identifier — meaning N users in one
 * tenant each get their own bucket, not a shared tenant pool.
 *
 * The actual enforcement lives in `src/lib/rate-limit/apiReadRateLimit.ts`
 * (Upstash + memory-fallback, mirrors `authRateLimit.ts`). This
 * preset is the single source of truth for the numbers; the
 * enforcement module re-uses them.
 */
export const API_READ_LIMIT: RateLimitConfig = {
    maxAttempts: 120,
    windowMs: 60 * 1000,
};

/**
 * API key creation: 5 per hour per (tenant, creator user).
 *
 * Threat model: post-compromise lateral movement. A user with a
 * stolen session could mint persistent API keys; tight limits slow
 * that chain and leave a denser audit trail. Legitimate churn (a
 * user rotating a handful of keys) is comfortably under 5/hr.
 */
export const API_KEY_CREATE_LIMIT: RateLimitConfig = {
    maxAttempts: 5,
    windowMs: 60 * 60 * 1000,
    lockoutMs: 60 * 60 * 1000,
};

/**
 * Passwordless / magic-link email dispatch: 5 per hour per IP.
 *
 * Threat model: email bomb abuse (attacker pointing the "send link"
 * endpoint at a victim email). This preset is explicitly IP-only
 * even when the endpoint receives a target email — the rate applies
 * to senders, not recipients.
 */
export const EMAIL_DISPATCH_LIMIT: RateLimitConfig = {
    maxAttempts: 5,
    windowMs: 60 * 60 * 1000,
};

/**
 * Platform-admin tenant creation: 5 per hour per calling IP.
 *
 * Threat model: a leaked PLATFORM_ADMIN_API_KEY being used to spin up
 * many tenants in rapid succession. 5/hour is comfortable for
 * orchestrator-driven batch provisioning while throttling an attacker
 * who obtained the key. Keyed by IP (the platform key itself is a
 * single shared secret, so per-key bucketing would add no isolation).
 */
export const TENANT_CREATE_LIMIT: RateLimitConfig = {
    maxAttempts: 5,
    windowMs: 60 * 60 * 1000,
    lockoutMs: 60 * 60 * 1000,
};

/**
 * Public self-service signup: 5 per hour per IP.
 *
 * Threat model: an unauthenticated caller farming workspaces. Every
 * successful call provisions a Tenant AND generates + wraps a per-tenant
 * DEK, so this is the most expensive unauthenticated write in the product
 * — the generic API_MUTATION_LIMIT (60/min) would permit 3600 tenants an
 * hour from one IP. 5/hour is far above what a real person needs (they
 * create one workspace) while making bulk provisioning useless.
 *
 * Bypassed automatically in tests and under AUTH_TEST_MODE=1, so the E2E
 * per-test isolated-tenant fixture is unaffected.
 */
export const SIGNUP_LIMIT: RateLimitConfig = {
    maxAttempts: 5,
    windowMs: 60 * 60 * 1000,
};

/**
 * Tenant invite creation: 20 per hour per tenant.
 *
 * Threat model: a compromised ADMIN account flooding the TenantInvite
 * table (storage abuse) or sending phishing invites at scale. 20/hr is
 * comfortable for legitimate batch onboarding while creating a tight
 * audit trail for abuse. Keyed by (tenant, IP) so a multi-browser
 * attacker with one session still burns the same budget.
 */
export const TENANT_INVITE_CREATE_LIMIT: RateLimitConfig = {
    maxAttempts: 20,
    windowMs: 60 * 60 * 1000,
};

/**
 * Invite preview / redemption: 10 per minute per IP.
 *
 * Threat model: token brute-force on the preview/redeem endpoints.
 * The 32-byte base64url token space is 2^256, so enumeration is
 * impossible in practice — this limit adds a defence-in-depth layer
 * and rate-stamps the audit trail so anomalous redemption patterns
 * are visible in logs. 10/min is comfortable for a user tabbing
 * between invite emails.
 */
export const INVITE_REDEEM_LIMIT: RateLimitConfig = {
    maxAttempts: 10,
    windowMs: 60 * 1000,
};

/**
 * Exchange listing creation: 20 per minute per (IP, userId).
 *
 * Threat model: a compromised credential or script flooding the GLOBAL
 * cross-tenant marketplace feed. Tighter than the 60/min default mutation
 * budget because a listing is a public, cross-tenant artefact — 20/min is
 * far above any human posting cadence while blunting bulk spam. The
 * per-tenant ACTIVE-listing QUOTA (entitlements) is the durable cap; this
 * rate limit throttles the burst.
 */
export const EXCHANGE_LISTING_CREATE_LIMIT: RateLimitConfig = {
    maxAttempts: 20,
    windowMs: 60 * 1000,
};

/**
 * Exchange inquiry creation: 10 per minute per (IP, userId).
 *
 * Threat model: repeat-inquiry spam AND amplification — each inquiry triggers
 * a cross-tenant EMAIL fanout to the seller's admins, so an abusive client
 * could turn one endpoint into an email cannon. Tighter than the listing
 * limit for that reason. The @@unique([listingId, inquirerTenantId]) dedup is
 * the correctness guard; this rate limit caps the outbound-email blast.
 */
export const EXCHANGE_INQUIRY_LIMIT: RateLimitConfig = {
    maxAttempts: 10,
    windowMs: 60 * 1000,
};

// ═══════════════════════════════════════════════════════════════════
// Progressive rate limit — Epic A.3 auth brute-force protection
// ═══════════════════════════════════════════════════════════════════
//
// The simple `RateLimitConfig` above is "N attempts per window,
// optional lockout" — a single threshold. Epic A.3 needs graduated
// *punishment*: each failed attempt past a threshold costs the
// attacker more wall-clock time, culminating in a hard lockout.
//
// The primitive is shared (not login-specific) so future flows
// (second-factor, recovery codes) can reuse it with their own policy.

export interface ProgressiveRateLimitTier {
    /** Apply this delay when cumulative failures >= this count. */
    atFailures: number;
    /** Milliseconds to delay the CURRENT attempt before verifying. */
    delayMs: number;
}

export interface ProgressiveRateLimitPolicy {
    /**
     * Tiers sorted ascending by `atFailures`. The highest-matching
     * tier's `delayMs` is applied; tiers do not sum. Failures below
     * the first tier's threshold incur no delay.
     */
    tiers: readonly ProgressiveRateLimitTier[];
    /** Failure count that flips the account into lockout. */
    lockoutAtFailures: number;
    /** Duration of the lockout once triggered. */
    lockoutMs: number;
    /**
     * Rolling window over which failures accumulate. A single entry
     * older than `windowMs` stops contributing to the count. Sized
     * generously — lockouts are meant to feel real, not rotate out.
     */
    windowMs: number;
}

/**
 * Epic A.3 login policy.
 *
 *   attempts 1-2  → no delay (typo allowance)
 *   attempts 3-4  → 5s delay (mild friction)
 *   attempts 5-9  → 30s delay (significant friction)
 *   attempt 10+   → 15 min lockout (attack territory)
 *
 * Window is 1 hour: a legitimate user who typed their password
 * wrong ten times in a day isn't locked out in perpetuity; an
 * attacker who managed to sustain 10 failures/hour stays locked
 * for the full window.
 */
export const LOGIN_PROGRESSIVE_POLICY: ProgressiveRateLimitPolicy = {
    tiers: [
        { atFailures: 3, delayMs: 5_000 },
        { atFailures: 5, delayMs: 30_000 },
    ],
    lockoutAtFailures: 10,
    lockoutMs: 15 * 60 * 1000,
    windowMs: 60 * 60 * 1000,
};

export interface ProgressiveRateLimitDecision {
    /**
     * `false` when the identifier is in lockout and no further
     * verify should be attempted. The caller returns 429/"too many
     * requests" to the client.
     */
    allowed: boolean;
    /**
     * Delay (ms) the caller SHOULD sleep before proceeding with the
     * expensive verify. `0` when under the first tier. The caller
     * is responsible for actually sleeping — this function returns
     * synchronously so it can be used inside timing-sensitive
     * branches (e.g. a dummyVerify needs to happen even on lockout).
     */
    delayMs: number;
    /**
     * Only populated when `allowed === false`. Seconds until the
     * lockout expires (always ≥ 1).
     */
    retryAfterSeconds: number;
    /** Failures currently counted against this identifier. */
    failureCount: number;
}

function pickDelayMs(
    count: number,
    tiers: readonly ProgressiveRateLimitTier[],
): number {
    let delay = 0;
    for (const tier of tiers) {
        if (count >= tier.atFailures) delay = tier.delayMs;
    }
    return delay;
}

const PROGRESSIVE_KEY_PREFIX = 'rl:prog';

/**
 * Pure decision from a list of in-or-out-of-window failure timestamps.
 * Shared by the Redis and in-memory paths so the two backends can NEVER
 * drift in lockout / tier semantics. Returns `clear: true` on the
 * lockout-expiry edge, signalling the caller to wipe the counter (a
 * legitimate user returning after the lockout should not immediately eat
 * another delay).
 */
function computeProgressive(
    timestamps: number[],
    policy: ProgressiveRateLimitPolicy,
    now: number,
): { decision: ProgressiveRateLimitDecision; clear: boolean } {
    const windowStart = now - policy.windowMs;
    const inWindow = timestamps.filter((t) => t > windowStart);
    const failureCount = inWindow.length;

    if (failureCount >= policy.lockoutAtFailures) {
        const lastFailure = inWindow[inWindow.length - 1];
        const lockoutEnd = lastFailure + policy.lockoutMs;
        if (now < lockoutEnd) {
            return {
                decision: {
                    allowed: false,
                    delayMs: 0,
                    retryAfterSeconds: Math.max(1, Math.ceil((lockoutEnd - now) / 1000)),
                    failureCount,
                },
                clear: false,
            };
        }
        // Lockout expired — reset.
        return {
            decision: { allowed: true, delayMs: 0, retryAfterSeconds: 0, failureCount: 0 },
            clear: true,
        };
    }

    return {
        decision: {
            allowed: true,
            delayMs: pickDelayMs(failureCount, policy.tiers),
            retryAfterSeconds: 0,
            failureCount,
        },
        clear: false,
    };
}

function normalizeTimestamps(raw: unknown): number[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((t): t is number => typeof t === 'number');
}

/**
 * Evaluate the current state WITHOUT recording a new attempt. Call this
 * BEFORE verifying the password so the caller knows how long to delay (and
 * whether to short-circuit with a lockout response).
 *
 * Distributed-first: reads the failure-timestamp blob from the shared Upstash
 * client (so every instance sees the same lockout), falling back to the
 * process-wide Map when no Upstash env is configured. A Redis error fails
 * over to the Map rather than fail-open — a login limiter that still counts
 * locally beats none.
 *
 * Timing note (Epic A.3): both the lockout and non-lockout branches issue the
 * same single read, so the added Redis latency is equal on every path and
 * cannot become a timing oracle. The caller equalises the verify cost via
 * `dummyVerify` as before.
 */
export async function evaluateProgressiveRateLimit(
    key: string,
    policy: ProgressiveRateLimitPolicy,
): Promise<ProgressiveRateLimitDecision> {
    const now = Date.now();
    const redis = getUpstashRedis();

    if (redis) {
        try {
            const raw = await redis.get(`${PROGRESSIVE_KEY_PREFIX}:${key}`);
            const { decision, clear } = computeProgressive(normalizeTimestamps(raw), policy, now);
            if (clear) {
                await redis.del(`${PROGRESSIVE_KEY_PREFIX}:${key}`);
            }
            return decision;
        } catch (err) {
            edgeLogger.warn('rate-limit.progressive_redis_error_fallback_memory', {
                component: 'rate-limit',
                err: String(err),
            });
            // fall through to in-memory
        }
    }

    startCleanup(policy.windowMs);
    const entry = store.get(key) || { timestamps: [] };
    const windowStart = now - policy.windowMs;
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
    const { decision, clear } = computeProgressive(entry.timestamps, policy, now);
    if (clear) entry.timestamps = [];
    store.set(key, entry);
    return decision;
}

/**
 * Record a failure for this identifier. Call AFTER a verify has returned
 * `false`. Returns the post-increment decision so the caller can surface the
 * new lockout state to logging / audit.
 */
export async function recordProgressiveFailure(
    key: string,
    policy: ProgressiveRateLimitPolicy,
): Promise<ProgressiveRateLimitDecision> {
    const now = Date.now();
    const windowStart = now - policy.windowMs;
    const redis = getUpstashRedis();

    if (redis) {
        try {
            const raw = await redis.get(`${PROGRESSIVE_KEY_PREFIX}:${key}`);
            const timestamps = normalizeTimestamps(raw).filter((t) => t > windowStart);
            timestamps.push(now);
            // TTL == window so the key self-expires once every failure ages out.
            await redis.set(`${PROGRESSIVE_KEY_PREFIX}:${key}`, timestamps, {
                px: policy.windowMs,
            });
            return computeProgressive(timestamps, policy, now).decision;
        } catch (err) {
            edgeLogger.warn('rate-limit.progressive_redis_error_fallback_memory', {
                component: 'rate-limit',
                err: String(err),
            });
            // fall through to in-memory
        }
    }

    startCleanup(policy.windowMs);
    const entry = store.get(key) || { timestamps: [] };
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
    entry.timestamps.push(now);
    store.set(key, entry);
    return computeProgressive(entry.timestamps, policy, now).decision;
}

/**
 * Clear the failure list. Call after a SUCCESSFUL verify so a legitimate user
 * who typo'd a few times isn't still throttled on the next login.
 */
export async function resetProgressiveFailures(key: string): Promise<void> {
    store.delete(key);
    const redis = getUpstashRedis();
    if (!redis) return;
    try {
        await redis.del(`${PROGRESSIVE_KEY_PREFIX}:${key}`);
    } catch (err) {
        edgeLogger.warn('rate-limit.progressive_reset_del_failed', {
            component: 'rate-limit',
            err: String(err),
        });
    }
}
