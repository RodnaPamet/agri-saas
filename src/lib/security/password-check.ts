/**
 * Epic A.3 — Breached-password screening via HaveIBeenPwned.
 *
 * Uses the HIBP Pwned Passwords range API with k-anonymity: we send
 * only the first 5 hex chars of the SHA-1 hash, HIBP returns the
 * list of hash suffixes matching that prefix, and we check locally.
 * The full password — and the full hash — never leaves this process.
 *
 * Reference: https://haveibeenpwned.com/API/v3#PwnedPasswords
 *
 * ## What we DON'T do
 *   - Block the caller on network errors. A HIBP outage should not
 *     brick signup. We fail open and log a warning.
 *   - Log the password. Not even truncated. Not even its hash.
 *   - Retry. The caller will retry naturally on the next attempt.
 *   - Cache. The breach set evolves; a short-lived outage is cheaper
 *     than a stale cache.
 *
 * ## Tuning
 *   - 2s timeout: HIBP typically responds in <200ms; 2s is long
 *     enough that transient latency doesn't matter but short enough
 *     that a dead endpoint doesn't hold a user at the signup form.
 *   - Minimum threshold: the default is "any breach count > 0 is a
 *     rejection". Callers can pass `minOccurrences` to raise the
 *     bar if a flow wants to tolerate low-risk matches.
 */

import { logger } from '@/lib/observability/logger';
import { env } from '@/env';

export interface BreachedPasswordCheckOptions {
    /**
     * Override the endpoint — useful in tests. Defaults to the real
     * HIBP range API. Must return text/plain in the HIBP format
     * (`<SHA1_SUFFIX>:<COUNT>` per line, CRLF-separated).
     */
    endpoint?: string;
    /** Network timeout in milliseconds. Defaults to 2000. */
    timeoutMs?: number;
    /**
     * Minimum breach count below which we treat the password as
     * acceptable. Defaults to 1 (any appearance is a reject). Raise
     * to tolerate rare collisions (e.g. 10 to only reject widely-
     * breached passwords).
     */
    minOccurrences?: number;
    /**
     * Injected fetch — for tests. Defaults to global `fetch`.
     * The signature matches the DOM `fetch`.
     */
    fetchImpl?: typeof fetch;
}

export type BreachedPasswordCheckResult =
    | {
          /** Reject this password. */
          breached: true;
          /** HIBP-reported appearance count. */
          occurrences: number;
      }
    | {
          /** Password was not found in the breach list. */
          breached: false;
      }
    | {
          /**
           * Check could not complete (network error, timeout, HIBP
           * rate-limited us, etc.). Caller should treat as
           * NOT-breached (fail open) but may choose to log / alert.
           */
          breached: false;
          skipped: true;
          reason: 'timeout' | 'network' | 'upstream_error' | 'parse_error';
      };

const DEFAULT_ENDPOINT = 'https://api.pwnedpasswords.com/range';
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Compute the hex-uppercase SHA-1 of the input. HIBP returns hashes
 * in uppercase; we keep the same case so the suffix compare is a
 * direct string match without a lowercase pass.
 *
 * Uses `crypto.subtle.digest` so the implementation runs in both
 * Node (18+) and Edge runtimes without a polyfill.
 */
async function sha1Hex(input: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const buf = await crypto.subtle.digest('SHA-1', data);
    return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase();
}

/**
 * Check a plaintext password against HIBP's breached-password corpus.
 *
 * Never throws. Network / parse failures return `skipped: true` so
 * the caller knows the rejection decision is "fail open, not a
 * real pass".
 *
 * @example
 *   const r = await checkPasswordAgainstHIBP('hunter2');
 *   if (r.breached) return { error: 'Please choose a different password' };
 */
/**
 * Offline stand-in for the HIBP range API, used when `E2E_HIBP_FIXTURE=1`.
 *
 * Substitutes the TRANSPORT and nothing else. The caller still hashes the
 * password, splits prefix/suffix, parses the response body line by line and
 * compares counts against `minOccurrences` — so the code under test is the
 * real code, with the network hop removed.
 *
 * It deliberately does NOT short-circuit to `{ breached: false }`. That would
 * be the failure mode `basemap-fixture-tile.ts` names: a fixture that makes
 * the test pass by removing the thing the test exercises. A caller asking
 * "does this password get rejected" would then be asserting over a code path
 * that no longer runs.
 *
 * The canonical weak password stays BREACHED so the rejection path is still
 * reachable offline; every other password answers not-breached. That is more
 * permissive than the real API, which is the safe direction: a fixture cannot
 * newly reject a password an existing test relies on.
 */
const FIXTURE_BREACHED_PREFIX = '5BAA6';
// SHA-1("password") minus its 5-char prefix. A published, universally-known
// digest of the single most common password — not a credential.
const FIXTURE_BREACHED_SUFFIX = '1E4C9B93F3F0682250B6CF8331B7EE68FD8'; // pragma: allowlist secret

function hibpFixtureFetch(url: string): Promise<Response> {
    const prefix = url.split('/').pop()?.toUpperCase() ?? '';
    // Filler lines so the parser sees a realistic multi-line body rather than
    // a degenerate one-line response it would never meet in production.
    const lines = [
        '0018A45C4D1DEF81644B54AB7F969B88D65:1',
        '00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2',
    ];
    if (prefix === FIXTURE_BREACHED_PREFIX) {
        lines.push(`${FIXTURE_BREACHED_SUFFIX}:9999999`);
    }
    return Promise.resolve(
        new Response(lines.join('\r\n'), { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    );
}

export async function checkPasswordAgainstHIBP(
    plaintext: string,
    options: BreachedPasswordCheckOptions = {},
): Promise<BreachedPasswordCheckResult> {
    const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const minOccurrences = options.minOccurrences ?? 1;
    // An explicit `fetchImpl` always wins — unit tests inject their own.
    // The flag only replaces the DEFAULT transport, and only in test/E2E.
    const defaultFetch = env.E2E_HIBP_FIXTURE === '1' ? hibpFixtureFetch : fetch;
    const fetchImpl = options.fetchImpl ?? (defaultFetch as typeof fetch);

    let hash: string;
    try {
        hash = await sha1Hex(plaintext);
    } catch (err) {
        // If SHA-1 is unavailable at runtime we fail open — the rest
        // of the policy (length check, rate limits) still applies.
        logger.warn('password-check.hash_failed', {
            component: 'password-check',
            error: err instanceof Error ? err.message : 'unknown',
        });
        return { breached: false, skipped: true, reason: 'upstream_error' };
    }

    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let body: string;
    try {
        const res = await fetchImpl(`${endpoint}/${prefix}`, {
            signal: controller.signal,
            headers: {
                // Opt-in to the "pad hash counts" header so response size
                // doesn't leak which prefix we queried. HIBP-recommended
                // for all range queries.
                'Add-Padding': 'true',
                'User-Agent': 'inflect-compliance/1.0',
            },
        });
        if (!res.ok) {
            logger.warn('password-check.upstream_error', {
                component: 'password-check',
                status: res.status,
            });
            return {
                breached: false,
                skipped: true,
                reason: 'upstream_error',
            };
        }
        body = await res.text();
    } catch (err) {
        const reason =
            err instanceof Error && err.name === 'AbortError'
                ? 'timeout'
                : 'network';
        logger.warn(`password-check.${reason}`, {
            component: 'password-check',
        });
        return { breached: false, skipped: true, reason };
    } finally {
        clearTimeout(timer);
    }

    // Response format: one `SUFFIX:COUNT\r\n` line per match. Padded
    // entries have count=0 (the "Add-Padding" decoy rows) and must
    // be ignored.
    try {
        for (const line of body.split(/\r?\n/)) {
            if (!line) continue;
            const colonIdx = line.indexOf(':');
            if (colonIdx === -1) continue;
            const entrySuffix = line.slice(0, colonIdx).trim().toUpperCase();
            if (entrySuffix !== suffix) continue;
            const count = parseInt(line.slice(colonIdx + 1).trim(), 10);
            if (!Number.isFinite(count) || count <= 0) continue;
            if (count >= minOccurrences) {
                return { breached: true, occurrences: count };
            }
        }
        return { breached: false };
    } catch (err) {
        logger.warn('password-check.parse_error', {
            component: 'password-check',
            error: err instanceof Error ? err.message : 'unknown',
        });
        return { breached: false, skipped: true, reason: 'parse_error' };
    }
}
