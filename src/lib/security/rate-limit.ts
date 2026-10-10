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
 * out to 5-10 list endpoints (practices + risks + evidence + counts
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
 * PUBLIC read API: 60 requests per minute per IP. P1.6.
 *
 * Half the authenticated read budget, and keyed by IP ALONE because there is
 * no user to key on — these are unauthenticated requests that never reach the
 * JWT check. That makes the budget coarser than it looks: carrier-grade NAT
 * puts many subscribers behind one public IPv4, so 60/min is shared by everyone
 * behind a village's cell tower. The figure is a deliberate compromise between
 * that and the thing it defends against — an unauthenticated caller probing
 * invite tokens, where each probe is a database read and a token guess.
 *
 * It applies to a SMALL, named set of paths rather than "everything public":
 * see `isPublicReadRateLimited`, which lists why each of the other public
 * prefixes is excluded.
 */
export const PUBLIC_READ_LIMIT: RateLimitConfig = {
    maxAttempts: 60,
    windowMs: 60 * 1000,
};

/**
 * PUBLIC DSA Art 16 notices: 10 per minute per IP. P5.2 (#1593).
 *
 * `withApiErrorHandling` already defaults every mutation to
 * `API_MUTATION_LIMIT` (60/min), keyed on `(IP, userId)` with the userId NULL
 * for an anonymous caller — so this endpoint was never unprotected and this
 * constant is a TUNING choice, not a missing control. Worth saying because an
 * earlier revision of P5.1's schema docblock claimed both that such a tier
 * existed by name and, correcting itself, that none existed at all. Neither
 * was true; the default is what protects a public POST.
 *
 * 10 rather than 60 because the shapes differ. 60/min is sized for a person
 * filling a form in a tab — several writes a minute is normal there. Filing
 * ten notices in a minute is not normal for anybody acting in good faith, and
 * the thing this defends against is a flood that buries real notices in the
 * triage queue, where the cost is a regulator-visible handling time rather
 * than database load.
 *
 * It does NOT go lower, and carrier-grade NAT is why. `PUBLIC_READ_LIMIT`'s
 * docblock already reasons about it for this user base: many subscribers share
 * one public IPv4, so a village behind one cell tower shares this budget.
 * Below about ten, a genuine burst of notices about the same bad listing —
 * which is what a real incident looks like — would start refusing the
 * neighbours who are reporting it.
 *
 * Per-SUBJECT capping is deliberately not done here. It is the control that
 * would actually catch brigading, and it has the wrong failure mode: the first
 * few notices would suppress later legitimate ones about the same content.
 * P5.2 records a per-subject count without enforcing it, so a threshold can be
 * chosen from data.
 */
export const PUBLIC_NOTICE_LIMIT: RateLimitConfig = {
    maxAttempts: 10,
    windowMs: 60 * 1000,
};

/**
 * SCIM provisioning: 300/min per bearer, 600/min per IP.
 *
 * `/api/scim/` is in `PUBLIC_PATH_PREFIXES`, so these requests are NOT
 * authenticated at the Edge — they cannot be, since a SCIM bearer is an
 * opaque hashed token and the Edge has no database. Authentication happens
 * inside the handler. That makes this the one API surface where an anonymous
 * caller can reach a token comparison, which is exactly the shape a bearer
 * brute-force needs.
 *
 * TWO buckets, because either one alone has a hole:
 *   - Per-BEARER (300/min) is the real budget. A runaway IdP sync exhausts
 *     its own tenant's allowance and nobody else's.
 *   - Per-IP (600/min) is what stops the brute-force, since an attacker
 *     rotating a fresh guess each request would otherwise get a fresh
 *     per-bearer bucket every time and never be limited at all.
 *
 * 600 is double 300 on purpose: Entra egresses several tenants' syncs from a
 * shared Microsoft IP pool, so the ceiling has to fit more than one legitimate
 * sync running at once.
 */
export const SCIM_LIMIT: RateLimitConfig = {
    maxAttempts: 300,
    windowMs: 60 * 1000,
};

/** The per-IP ceiling for {@link SCIM_LIMIT}. See that doc for why both exist. */
export const SCIM_IP_LIMIT: RateLimitConfig = {
    maxAttempts: 600,
    windowMs: 60 * 1000,
};

/**
 * Tenant API keys (`iflk_`) — the same situation as SCIM, one step riskier.
 *
 * The Edge carve-out lets an `iflk_` bearer past `getToken()` unauthenticated
 * (it has to: the key is an opaque token compared against a hash, and the Edge
 * has no database). So an anonymous caller once again reaches a credential
 * comparison — but this time on `/api/t/`, the whole tenant API, rather than a
 * single provisioning prefix.
 *
 * Two buckets for the reasons {@link SCIM_LIMIT} gives: per-bearer alone never
 * binds against an attacker rotating a fresh guess per request, per-IP alone
 * throttles innocent tenants sharing an egress.
 *
 * TIGHTER than SCIM's 300/600, deliberately. SCIM's budget is sized for Entra
 * pushing several tenants' full user directories through one prefix on a
 * schedule. An API key is a customer's own integration making ordinary API
 * calls; 120/min sustained is far more than any such client needs, and the
 * lower the ceiling the smaller the guessing oracle. Raise it when a real
 * integration demonstrates it binds — not in advance.
 */
export const API_KEY_LIMIT: RateLimitConfig = {
    maxAttempts: 120,
    windowMs: 60 * 1000,
};

/**
 * The per-IP ceiling for {@link API_KEY_LIMIT} — the anti-guessing floor.
 *
 * Double the per-bearer budget, same ratio and same reason as SCIM's: one
 * customer may legitimately run several keys (staging and production, or two
 * integrations) from one egress address.
 */
export const API_KEY_IP_LIMIT: RateLimitConfig = {
    maxAttempts: 240,
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
 * Public self-service signup: 15 per hour per IP.
 *
 * Threat model: an unauthenticated caller farming workspaces. Every
 * successful call provisions a Tenant AND generates + wraps a per-tenant
 * DEK, so this is the most expensive unauthenticated write in the product
 * — the generic API_MUTATION_LIMIT (60/min) would permit 3600 tenants an
 * hour from one IP. 15/hour is still useless to a tenant-farming attacker
 * while leaving real headroom for the actual user base.
 *
 * The limiter runs pre-handler and counts ATTEMPTS, not successful
 * workspace creations — a password-policy or HIBP rejection burns budget
 * the same as a real signup. Our users are farmers on rural mobile
 * networks, frequently behind carrier-grade NAT, so a single IP can be
 * shared by many unrelated people signing up independently; 15/hour gives
 * that shared IP room for several distinct signups plus a few fumbled
 * password attempts each, without opening the door to bulk provisioning.
 *
 * Bypassed automatically in tests and under AUTH_TEST_MODE=1, so the E2E
 * per-test isolated-tenant fixture is unaffected.
 */
export const SIGNUP_LIMIT: RateLimitConfig = {
    maxAttempts: 15,
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

/**
 * Exchange messages: 60 per minute per SENDING TENANT — not per caller.
 *
 * Threat model, and it is NOT the one the inquiry limit above guards.
 * `EXCHANGE_INQUIRY_LIMIT` exists to cap an outbound EMAIL fanout. Messaging
 * looks like the same shape and is not: `notifyOtherParty` builds its email
 * dedupe key ending in the UTC DAY, so the second message of a thread sends
 * no mail at all. One email per thread, per recipient, per day, however many
 * messages. Copying the inquiry reasoning here would be citing a threat that
 * this code already closes.
 *
 * What is unbounded is the BELL. `#1102` made that deliberate and correct —
 * one `Notification` row per message with `dedupeKey` NULL, because deduping
 * it like the email meant a live negotiation notified on NO channel from the
 * second message onward. So the flood surface is notification rows plus an
 * SSE publish each, landing on the recipient.
 *
 * The generic `API_MUTATION_LIMIT` cannot bound it: 60/min keyed on
 * `(IP, userId)` means a tenant with ten users can drive 600 rows a minute at
 * one counterparty, and every one of them is a legitimate member of that
 * tenant. The budget has to be SHARED to mean anything, which is what the
 * `bucket` seam is for.
 *
 * Why per TENANT and not per thread. Per-thread was the first design and it
 * fails in a way that is easy to miss: a thread is per (listing, inquirer),
 * so the NUMBER of budgets an abuser gets is chosen by the victim. A seller
 * with ten listings can be written to in ten threads, and a per-thread 30
 * would permit 300/min at one bell — half the exposure rather than a tenth.
 * A ceiling that scales with the target's own catalogue is not a ceiling.
 *
 * Per (sender, recipient) would be tighter still, and is rejected for a
 * different reason: the recipient is only knowable by loading the thread, and
 * this check runs BEFORE the handler precisely so an abusive caller cannot
 * make the server work. The bucket must come from the URL.
 *
 * Why 60. It is the same number as the generic tier and that is not an
 * accident — it is the same number made to mean something. Today 60 is per
 * (IP, userId), so ten users are 600; here it is the tenant's whole outbound
 * budget, so ten users are still 60. The cut is 10x and it does not decay as
 * the sender adds users or the victim adds listings.
 *
 * What it costs: a tenant negotiating several deals at once shares one
 * budget. A message a second sustained across an entire organisation is
 * ample for people typing, and this constant is one line to raise.
 *
 * A BLOCKED sender consumes quota. The limit runs in the wrapper, before the
 * handler reaches `isBlocked`, so the cost of being blocked falls on the
 * blocked party rather than on the person who blocked them.
 */
export const EXCHANGE_MESSAGE_LIMIT: RateLimitConfig = {
    maxAttempts: 60,
    windowMs: 60 * 1000,
};

/**
 * Insurance quote requests: 20 per HOUR per (IP, userId).
 *
 * Threat model: outbound-email amplification, same family as
 * `EXCHANGE_INQUIRY_LIMIT` but with the dedup guard removed. Every lead sends
 * the operator an email, and the `@@unique([parcelId, inquirerTenantId])` that
 * used to cap one ask per parcel was DROPPED on 2026-09-24 so a farmer could
 * re-ask with a corrected land size. The inquiry preset's 10-per-MINUTE window
 * therefore permits up to 600 operator emails an hour from a single account —
 * a per-minute window is the wrong shape once repeat asks are legitimate.
 *
 * 20 per hour is generous for the real behaviour it has to allow: a farmer
 * comparing cover on several parcels, then re-asking on a few after correcting
 * an area. It is not generous for a script.
 *
 * An idempotent REPLAY counts against this. That is deliberate — the limit
 * exists to cap requests reaching the endpoint, and a client retrying in a
 * loop costs the same server work whether or not the row is deduped.
 */
export const INSURANCE_LEAD_LIMIT: RateLimitConfig = {
    maxAttempts: 20,
    windowMs: 60 * 60 * 1000,
};

/**
 * Knowledge-base ask (RAG Q&A): 10 requests per minute per (IP, userId).
 *
 * Threat model: cost + abuse. Every call is an LLM completion over a
 * user-supplied string (`askKnowledgeBase`) — an ungated endpoint turns
 * into a free-form prompt firehose a compromised credential or a script
 * could hammer, running up model spend with no product value. 10/min is
 * generous for a person actually reading answers (each round trip takes
 * several seconds) while blunting a scripted loop. Tighter than the
 * generic API_MUTATION_LIMIT (60/min) for the same reason
 * EXCHANGE_INQUIRY_LIMIT is tighter than the listing limit: this
 * specific action is materially more expensive than an ordinary write.
 */
export const KNOWLEDGE_ASK_LIMIT: RateLimitConfig = {
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
