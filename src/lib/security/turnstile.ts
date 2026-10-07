/**
 * Cloudflare Turnstile verification (P3.5c).
 *
 * ── it is DORMANT until the operator supplies a secret, and that is the point ──
 *
 * P0.7 ticked "Turnstile" on #1191 and nothing was ever built: no code, no env
 * var, no key. So the risk this module has to survive is not a missing
 * feature, it is a feature that LOOKS present and does nothing. Two things
 * keep "dormant" honest here:
 *
 *   1. Absence is ANNOUNCED, not silent. `verifyTurnstile` returns
 *      `skipped: true` and logs a warning the first time it is called with no
 *      secret configured, so an operator reading logs after a deploy can tell
 *      whether the control is live. A control you cannot tell apart from its
 *      own absence is the thing that went wrong last time.
 *   2. The behaviour that matters is the CONFIGURED one, and it is tested by
 *      executing it — a token Cloudflare rejects must make registration
 *      refuse. A guard greps the registration entry points for the call, so a
 *      new entry point cannot quietly skip it.
 *
 * ── the failure policy, which is a real trade and not an oversight ──
 *
 * With a secret configured:
 *
 *   * Cloudflare says the token is BAD           → refuse. Unambiguous.
 *   * Cloudflare is unreachable / times out      → ALLOW, and log loudly.
 *
 * Failing open on a transport error looks like a hole, so here is why it is
 * not the obvious one. An attacker cannot reach that branch at will: a forged
 * or absent token produces an explicit rejection from Cloudflare, which
 * refuses. Reaching the fail-open branch requires making Cloudflare's own
 * siteverify endpoint unreachable from the server, which is not a capability a
 * signup-spammer has. Against that, failing closed would mean a Cloudflare
 * incident stops every new farm from registering — a self-inflicted outage on
 * the product's front door, with three other gates still standing in front of
 * it (`SIGNUP_LIMIT`, the disposable-domain block, and email verification
 * before any farm exists).
 *
 * This matches how the two neighbouring screens behave and say so:
 * `checkPasswordAgainstHIBP` and `isDisposableEmail` both fail open for the
 * same reason — they are gates on an abuse path, not authentication.
 *
 * ── what does NOT go in a log line ──
 *
 * Never the secret, and never the token. A Turnstile token is single-use and
 * short-lived, so it is not much of a credential — but it is still a bearer
 * value from a client, and the habit of not logging those is cheaper to keep
 * than to re-establish. Cloudflare's `error-codes` ARE logged: they name the
 * cause and carry nothing about the person.
 */
import { logger } from '@/lib/observability/logger';

/** Cloudflare's verification endpoint. */
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * How long to wait for Cloudflare before giving up and allowing the request.
 *
 * Three seconds. It sits in front of a human waiting on a signup form, and the
 * fail-open policy above means a slow answer and no answer have the same
 * outcome — so a long timeout buys nothing but a worse experience.
 */
const VERIFY_TIMEOUT_MS = 3_000;

export type TurnstileOutcome =
    /** Configured, Cloudflare accepted the token. */
    | { ok: true; skipped: false }
    /** No secret configured — the control is not active. */
    | { ok: true; skipped: true }
    /** Configured, and the token was refused. `codes` are Cloudflare's. */
    | { ok: false; skipped: false; codes: string[] }
    /** Configured, but Cloudflare could not be reached. Allowed, see docblock. */
    | { ok: true; skipped: false; degraded: true };

/** Has the operator supplied a secret? The single definition of "active". */
export function turnstileConfigured(): boolean {
    return Boolean(process.env.TURNSTILE_SECRET_KEY);
}

/**
 * The public sitekey, for the client widget.
 *
 * Returns null when unset so a caller can render no widget at all rather than
 * an empty one. It is deliberately NOT a `NEXT_PUBLIC_*` value read at build
 * time: that would be inlined by `next build`, so supplying a key would need a
 * rebuild, an image push and a rollout. Read per request, the operator pastes
 * it into the env file and recreates the container. This is the same argument
 * `/api/auth/ui-config` records for its own flags.
 */
export function turnstileSitekey(): string | null {
    return process.env.TURNSTILE_SITEKEY || null;
}

/** So the "not configured" warning is loud once per process, not per signup. */
let warnedNotConfigured = false;

/**
 * Verify a Turnstile token.
 *
 * Never throws: every failure mode is a value in `TurnstileOutcome`, because a
 * throw from here would become a 500 on the signup path and the caller cannot
 * do anything more useful with it than this function already decided.
 */
export async function verifyTurnstile(
    token: string | null | undefined,
    remoteIp?: string | null,
): Promise<TurnstileOutcome> {
    const secret = process.env.TURNSTILE_SECRET_KEY;

    if (!secret) {
        if (!warnedNotConfigured) {
            warnedNotConfigured = true;
            logger.warn('turnstile.not_configured', {
                component: 'security',
                event: 'turnstile_not_configured',
                // Phrased for whoever is reading logs to find out whether the
                // control is on. "Skipped" with no explanation is how P0.7's
                // absence went unnoticed.
                detail:
                    'TURNSTILE_SECRET_KEY is unset, so bot screening on registration is NOT active. Set it (plus TURNSTILE_SITEKEY) in the environment to enable it; no deploy is required.',
            });
        }
        return { ok: true, skipped: true };
    }

    // A configured secret with no token is a refusal, not a skip. This is the
    // branch a forged or stripped submission lands in, and conflating it with
    // "not configured" would turn the whole control off for anyone who simply
    // omits the field.
    if (!token) {
        logger.info('turnstile.missing_token', {
            component: 'security',
            event: 'turnstile_missing_token',
        });
        return { ok: false, skipped: false, codes: ['missing-input-response'] };
    }

    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);

    try {
        const res = await fetch(SITEVERIFY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
            signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
        });

        if (!res.ok) {
            // A 5xx from Cloudflare is a transport problem, not a verdict on
            // the token — same branch as a timeout.
            logger.warn('turnstile.siteverify_http_error', {
                component: 'security',
                event: 'turnstile_degraded',
                status: res.status,
            });
            return { ok: true, skipped: false, degraded: true };
        }

        const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
        const codes = Array.isArray(data['error-codes']) ? data['error-codes'] : [];

        if (data.success === true) {
            return { ok: true, skipped: false };
        }

        logger.info('turnstile.rejected', {
            component: 'security',
            event: 'turnstile_rejected',
            // Cloudflare's own codes: they name the cause (`invalid-input-response`,
            // `timeout-or-duplicate`) and carry nothing about the person. The
            // token itself is never logged.
            codes,
        });
        return { ok: false, skipped: false, codes };
    } catch (err) {
        // Timeout or network failure. ALLOWED, deliberately — see the file
        // docblock for why this is not the hole it resembles.
        logger.warn('turnstile.siteverify_unreachable', {
            component: 'security',
            event: 'turnstile_degraded',
            error: err instanceof Error ? err.message : String(err),
        });
        return { ok: true, skipped: false, degraded: true };
    }
}

/** Reset the once-per-process warning. Test-only seam. */
export function __resetTurnstileWarning(): void {
    warnedNotConfigured = false;
}
