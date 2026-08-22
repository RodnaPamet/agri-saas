/**
 * Outbound `fetch` that keeps its SSRF policy across REDIRECTS (#708).
 *
 * ## Why the Web Push fix does not transfer here
 *
 * #707 closed the Web Push SSRF with a host check performed before the send,
 * and that was sufficient there for a reason specific to the library:
 * `web-push` uses raw `https.request` and treats any non-2xx as an error
 * (`web-push-lib.js:377`), so there is no `Location` handling to abuse. A
 * pre-flight check is the whole journey.
 *
 * `fetch` is different, and I measured it rather than assuming. Against a local
 * server returning `302 Location: http://127.0.0.1:9/blocked`:
 *
 * ```
 * redirect:follow   -> THREW TypeError: fetch failed     ← it FOLLOWED; port 9 refused
 * redirect:manual   -> status 302 location=http://127.0.0.1:9/blocked
 * ```
 *
 * The default followed the redirect into loopback and failed only because
 * nothing was listening. A host check before the call is therefore worth
 * nothing on its own: the responder chooses where the request actually lands.
 *
 * So the policy has to be applied per HOP, which means taking the redirect
 * loop back from `fetch` — `redirect: 'manual'`, inspect, re-check, repeat.
 *
 * ## What it does NOT close
 *
 * DNS rebinding. Each hop resolves, is checked, and is then re-resolved by the
 * HTTP client; the answer can change in between. The per-hop timeout bounds the
 * window. Closing it properly needs an agent that pins the resolved address,
 * which is a different piece of work.
 *
 * @module lib/security/safe-fetch
 */
import {
    checkWebhookUrl,
    assertPublicAddress,
} from '@/app-layer/automation/webhook-safety';

/** Refusal by the SSRF policy — distinct from a transport or HTTP error. */
export class BlockedRequestError extends Error {
    constructor(reason: string) {
        super(`blocked: ${reason}`);
        this.name = 'BlockedRequestError';
    }
}

export interface SafeFetchOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    /** Per-hop budget. */
    timeoutMs?: number;
    /**
     * Redirects to follow, each re-checked. **Zero means a redirect is a
     * refusal**, which is the right answer for any request whose BODY carries
     * a credential — see `exchangeCodeForTokens`.
     */
    maxRedirects?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * `fetch`, with the two-layer host policy re-applied at every hop.
 *
 * Throws {@link BlockedRequestError} when a hop is refused, so a caller can
 * tell "we would not go there" apart from "the server misbehaved".
 */
export async function fetchPublicUrl(
    rawUrl: string,
    opts: SafeFetchOptions = {},
): Promise<Response> {
    const { method = 'GET', headers, body, timeoutMs = 10_000, maxRedirects = 3 } = opts;

    let url = rawUrl;
    for (let hop = 0; ; hop++) {
        // Layer 1: scheme + literal host.
        const structural = checkWebhookUrl(url);
        if (!structural.ok) throw new BlockedRequestError(structural.reason ?? 'refused');
        // Layer 2: what the name actually resolves to.
        const resolved = await assertPublicAddress(structural.host!);
        if (!resolved.ok) throw new BlockedRequestError(resolved.reason ?? 'refused');

        const res = await fetch(url, {
            method,
            headers,
            body,
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs),
        });

        if (!REDIRECT_STATUSES.has(res.status)) return res;

        const location = res.headers.get('location');
        if (!location) return res; // a 3xx with no target is the server's problem, not a hop

        if (hop >= maxRedirects) {
            throw new BlockedRequestError(
                maxRedirects === 0
                    ? `refused to follow a redirect from ${structural.host}`
                    : `too many redirects (> ${maxRedirects})`,
            );
        }
        // Relative Locations are legal and common; resolve against the hop we
        // are on, not against the original URL.
        url = new URL(location, url).toString();
    }
}
