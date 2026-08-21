/**
 * Outbound-URL safety (SSRF guard) for server-side fetches of a URL that a
 * tenant or a client supplied.
 *
 * A rule's webhook URL is operator-supplied, so without a guard any tenant
 * admin who can author a rule gets a server-side request-forgery primitive
 * against the host's internal network (cloud metadata, Redis, RFC-1918, …).
 *
 * Policy: https only, and the resolved host must be a public address. That is
 * TWO layers and both are load-bearing — `checkWebhookUrl` is a synchronous
 * structural check on the literal host, and `assertPublicAddress` resolves DNS
 * and re-checks, so a public NAME pointing at private space is also rejected.
 *
 * ## What was wrong here, measured (#696)
 *
 * **1. Hostnames were being classified as IPv6 addresses.** The link-local /
 * ULA test read `h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')`
 * — two of those with no colon and no is-it-an-IP check. So:
 *
 *     isPrivateAddress('fcm.googleapis.com') → true
 *     isPrivateAddress('fc-tractors.bg')     → true
 *
 * `fcm.googleapis.com` is every Chrome/Chromium/Android Web Push endpoint.
 * Reusing this guard for push endpoints verbatim would have blocked that entire
 * browser share while Firefox and Safari worked — and it was ALREADY refusing
 * any automation webhook whose host starts with `fc`/`fd`, with a reason naming
 * a cause that is not true. `net.isIP` now gates every address-shaped test: a
 * NAME is not an ADDRESS, and names are handled by the blocklist and by DNS.
 *
 * **2. The v4-mapped IPv6 HEX form walked straight through.** There was a
 * `::ffff:` branch, but `new URL('https://[::ffff:169.254.169.254]/').hostname`
 * normalises to `[::ffff:a9fe:a9fe]` — the hex form, which that dotted branch
 * never saw. Measured: `checkWebhookUrl('https://[::ffff:169.254.169.254]/')`
 * returned `ok: true`, for the cloud metadata address.
 *
 * **3. A trailing dot defeated both name checks at once.**
 * `metadata.google.internal.` is a legal FQDN that resolves normally;
 * `endsWith('.internal')` is false for it and the `BLOCKED_HOSTNAMES` Set
 * lookup misses. Measured: `ok: true`.
 *
 * Severity, stated so it is not over-read: on the WEBHOOK path the DNS
 * re-check caught 2 and 3 (`lookup('[::ffff:a9fe:a9fe]')` throws ENOTFOUND;
 * the trailing-dot name resolves to 169.254.169.254 and is refused). These
 * were holes in layer 1, not an open SSRF. They matter because anything that
 * reuses layer 1 ALONE — a synchronous zod refinement at write time, say —
 * has no second layer beneath it.
 */
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

const PRIVATE_V4 = [
    /^10\./,
    /^127\./,
    /^0\./,
    /^169\.254\./, // link-local incl. cloud metadata 169.254.169.254
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[0-1])\./, // 172.16/12
    /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./, // CGNAT 100.64/10
];

/**
 * Normalise a host for comparison: lowercase, strip IPv6 brackets, strip a
 * single trailing dot.
 *
 * All three matter. Casing is free. Brackets arrive because `URL.hostname`
 * keeps them for IPv6 literals. The trailing dot is a legal FQDN root that
 * resolves identically and defeats every suffix and set comparison below.
 */
export function normalizeHost(host: string): string {
    return host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

/**
 * Expand a v4-mapped IPv6 address to its dotted-quad form, or null.
 *
 * Handles BOTH spellings, which is the point: `::ffff:169.254.169.254` (what a
 * human types) and `::ffff:a9fe:a9fe` (what `new URL()` normalises it to).
 */
function mappedV4(h: string): string | null {
    if (!h.startsWith('::ffff:')) return null;
    const tail = h.slice(7);
    if (tail.includes('.')) return tail; // already dotted
    const groups = tail.split(':');
    if (groups.length !== 2) return null;
    const [hi, lo] = groups.map((g) => Number.parseInt(g, 16));
    if (!Number.isInteger(hi) || !Number.isInteger(lo)) return null;
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

/**
 * True for a raw IP literal (v4/v6) that is private / loopback / link-local.
 *
 * Returns FALSE for anything that is not an IP literal. That is the fix for
 * #696 defect 1 and it is deliberate: a hostname is not an address, and
 * deciding otherwise on a two-letter prefix match refused `fcm.googleapis.com`.
 * Names are the blocklist's job and DNS's job — see `assertPublicAddress`.
 */
export function isPrivateAddress(host: string): boolean {
    const h = normalizeHost(host);

    const mapped = mappedV4(h);
    if (mapped) return isPrivateAddress(mapped);

    if (isIP(h) === 0) return false; // a NAME, not an address

    if (h === '::1' || h === '::' || h === '0.0.0.0') return true;
    // Link-local + unique-local, now anchored on real v6 syntax rather than a
    // bare two-letter prefix.
    if (/^fe80:/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h)) return true;
    return PRIVATE_V4.some((re) => re.test(h));
}

const BLOCKED_HOSTNAMES = new Set([
    'localhost',
    'metadata',
    'metadata.google.internal',
]);

export interface WebhookUrlVerdict {
    ok: boolean;
    reason?: string;
    /** The NORMALISED host, so a caller's DNS lookup sees the same string. */
    host?: string;
}

/**
 * Synchronous structural check: scheme + literal-host + obvious-name blocks.
 * Returns the host so the caller can DNS-resolve and re-check.
 *
 * This is layer 1 ONLY. It cannot see a public name that resolves into private
 * space; `assertPublicAddress` is the half that can, and every caller that
 * performs a network request must run both.
 */
export function checkWebhookUrl(rawUrl: string): WebhookUrlVerdict {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return { ok: false, reason: 'malformed URL' };
    }
    if (url.protocol !== 'https:') {
        return { ok: false, reason: 'only https webhooks are allowed' };
    }
    const host = normalizeHost(url.hostname);
    if (!host) {
        return { ok: false, reason: 'URL has no host' };
    }
    if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
        return { ok: false, reason: `blocked host ${host}`, host };
    }
    if (isPrivateAddress(host)) {
        return { ok: false, reason: `private address ${host}`, host };
    }
    return { ok: true, host };
}

/**
 * Additional rule for a WEB PUSH endpoint: reject a single-label host.
 *
 * Not cosmetic. Inside the production compose network `redis`, `db`,
 * `pgbouncer` and `caddy` all resolve to 172.18.0.x, and `https://redis/`
 * passes `checkWebhookUrl` — a single-label name is neither an IP literal nor
 * a blocked name nor a `.internal` suffix. It also closes the host-less form
 * `https:///wpush/v2/abc`, which `URL` parses with hostname `wpush`.
 *
 * Every real push service endpoint is an FQDN (`fcm.googleapis.com`,
 * `updates.push.services.mozilla.com`, `web.push.apple.com`,
 * `*.notify.windows.com`), so the rule costs nothing legitimate.
 */
export function checkPushEndpoint(rawUrl: string): WebhookUrlVerdict {
    const verdict = checkWebhookUrl(rawUrl);
    if (!verdict.ok) return verdict;
    const host = verdict.host!;
    if (isIP(host) === 0 && !host.includes('.')) {
        return { ok: false, reason: `single-label host ${host}`, host };
    }
    return verdict;
}

/** How long a resolved verdict stays cached, and how many hosts we keep. */
const DNS_CACHE_TTL_MS = 5 * 60_000;
const DNS_CACHE_MAX = 256;
const DNS_TIMEOUT_MS = 2_000;

const dnsVerdictCache = new Map<string, { verdict: WebhookUrlVerdict; expiresAt: number }>();

/**
 * Layer 2: resolve `host` and refuse if ANY returned address is private.
 *
 * The symbol this module's docblock has named since the guard was written, and
 * which did not exist — the DNS re-check lived only as six inline lines inside
 * `fireWebhook`, so a second consumer would have inherited the weaker half.
 *
 * Three deliberate choices:
 *
 *   - `{ all: true }`. A host with several A records must not pass because the
 *     first one happened to be public.
 *   - A timeout. `dns.lookup` has none of its own and this runs inside an HTTP
 *     request on some paths, so a hanging resolver would hang the request.
 *   - Failure to resolve is a REFUSAL, not a pass. An unresolvable host cannot
 *     be a legitimate target, and failing open here would undo layer 1.
 *
 * What it does NOT close: DNS rebinding. The address is checked, then the HTTP
 * client resolves again, and the answer can change in between. Bounding that
 * window is the caller's socket timeout, not this function's job.
 */
export async function assertPublicAddress(host: string): Promise<WebhookUrlVerdict> {
    const h = normalizeHost(host);
    const cached = dnsVerdictCache.get(h);
    if (cached && cached.expiresAt > Date.now()) return cached.verdict;

    let verdict: WebhookUrlVerdict;
    try {
        const results = await Promise.race([
            lookup(h, { all: true }),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('dns timeout')), DNS_TIMEOUT_MS),
            ),
        ]);
        const bad = results.find((r) => isPrivateAddress(r.address));
        verdict = bad
            ? { ok: false, reason: `${h} resolves to private ${bad.address}`, host: h }
            : { ok: true, host: h };
    } catch {
        verdict = { ok: false, reason: `cannot resolve ${h}`, host: h };
    }

    if (dnsVerdictCache.size >= DNS_CACHE_MAX) {
        dnsVerdictCache.delete(dnsVerdictCache.keys().next().value as string);
    }
    dnsVerdictCache.set(h, { verdict, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
    return verdict;
}

/** Test seam — the cache is module-scoped and would leak across cases. */
export function _resetDnsVerdictCache(): void {
    dnsVerdictCache.clear();
}
