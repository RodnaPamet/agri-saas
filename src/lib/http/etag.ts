/**
 * Roadmap-6 P3 — conditional-revalidation (ETag / 304) helper.
 *
 * The single, reusable seam every hot list-read GET opts into to make
 * cold-start + focus revalidation cheap on rural LTE. Instead of every
 * revalidation re-downloading the full JSON list, the server returns a
 * **weak ETag** (a content hash of the exact response bytes); the
 * browser stores it and, on the next fetch, sends `If-None-Match`.
 * When the payload is unchanged we answer `304 Not Modified` with an
 * empty body — the browser serves the cached body and the wire carries
 * a few dozen bytes instead of tens of kilobytes of nested rows.
 *
 * Why a WEAK ETag: the tag asserts *semantic* equivalence, not
 * byte-for-byte octet equality. That is exactly right for a JSON list —
 * we hash the serialized body, and two responses with the same hash are
 * interchangeable for the client. Weak tags also free us from promising
 * that transfer-encoding / compression won't touch the bytes.
 *
 * Contract for callers:
 *
 *   export const GET = withApiErrorHandling(async (req, ctx) => {
 *       const rows = await listThings(...);
 *       return jsonWithETag(req, rows);          // ← the only change
 *   });
 *
 * `jsonWithETag` serializes ONCE, hashes those exact bytes, compares
 * against the request's `If-None-Match`, and returns either a 304 (no
 * body) or a 200 whose body is the very bytes that were hashed — so the
 * ETag the client caches always matches the body it holds.
 *
 * `Cache-Control: private, no-cache` is deliberate: `no-cache` means
 * "you may store this, but you MUST revalidate before reuse" — which is
 * precisely the ETag round-trip we want (always ask the server, but let
 * a 304 short-circuit the payload). `private` keeps per-tenant data out
 * of shared/proxy caches.
 *
 * The helper is transport-only. It performs NO auth, NO tenant scoping,
 * NO rate limiting — those already ran inside `withApiErrorHandling` /
 * `getTenantCtx` by the time a handler builds its payload. Never reach
 * for it before the authorization gate.
 */
import { NextRequest, NextResponse } from 'next/server';

/**
 * cyrb53 — a fast, well-distributed 53-bit string hash (public domain).
 * Not cryptographic; we only need change-detection with a low collision
 * rate over JSON bodies, and this runs synchronously in both the Node
 * and Edge runtimes with zero dependencies. Returns an unsigned hex
 * string.
 */
function cyrb53(str: string, seed = 0): string {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return combined.toString(16);
}

/**
 * Compute a weak ETag for a response body string.
 *
 * Format: `W/"<hash>-<byteLength>"`. Mixing in the length makes the
 * (already unlikely) hash collision essentially impossible for two
 * bodies of differing size, at no cost. Deterministic — the same input
 * always yields the same tag, which is what makes `If-None-Match`
 * comparisons stable across requests.
 */
export function computeWeakETag(body: string): string {
    // Byte length (UTF-8), not code-unit length, so multi-byte content
    // widths are reflected accurately.
    const byteLength =
        typeof Buffer !== 'undefined'
            ? Buffer.byteLength(body, 'utf8')
            : // Edge/browser fallback.
              new TextEncoder().encode(body).length;
    return `W/"${cyrb53(body)}-${byteLength}"`;
}

/**
 * Normalize a single ETag token for comparison: drop an optional weak
 * (`W/`) prefix and surrounding whitespace. We always emit weak tags,
 * so the comparison is a weak comparison (the opaque-tag values match
 * regardless of the weakness flag).
 */
function normalizeTag(tag: string): string {
    const trimmed = tag.trim();
    return trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed;
}

/**
 * Does the request's `If-None-Match` header match the freshly computed
 * ETag? Handles the wildcard (`*`), comma-separated lists, and weak/
 * strong prefix differences.
 */
export function ifNoneMatchSatisfied(
    ifNoneMatch: string | null | undefined,
    etag: string,
): boolean {
    if (!ifNoneMatch) return false;
    const header = ifNoneMatch.trim();
    if (header === '*') return true;
    const wanted = normalizeTag(etag);
    return header
        .split(',')
        .map(normalizeTag)
        .some((candidate) => candidate === wanted);
}

export interface JsonWithETagInit extends ResponseInit {
    /**
     * Extra `Cache-Control` directive. Defaults to
     * `private, no-cache` — store-but-always-revalidate, which is what
     * makes the 304 round-trip work. Pass a custom value only if a
     * specific route wants a different freshness policy.
     */
    cacheControl?: string;
}

const DEFAULT_CACHE_CONTROL = 'private, no-cache';

/**
 * Serialize `payload` to JSON, attach a weak ETag, and honor
 * `If-None-Match` by returning a bodyless `304 Not Modified` when the
 * client already holds the current representation. Otherwise returns a
 * `200` (or the provided status) whose body is the exact serialized
 * bytes that were hashed.
 *
 * Drop-in replacement for `jsonResponse(payload)` on cacheable GETs.
 */
export function jsonWithETag<T>(
    req: NextRequest | Request,
    payload: T,
    init: JsonWithETagInit = {},
): NextResponse {
    const { cacheControl, headers: extraHeaders, ...rest } = init;
    const body = JSON.stringify(payload ?? null);
    const etag = computeWeakETag(body);
    const ifNoneMatch = req.headers.get('if-none-match');

    const baseHeaders = new Headers(extraHeaders);
    baseHeaders.set('ETag', etag);
    baseHeaders.set('Cache-Control', cacheControl ?? DEFAULT_CACHE_CONTROL);

    if (ifNoneMatchSatisfied(ifNoneMatch, etag)) {
        // 304 MUST carry no body but SHOULD echo the validators the
        // client used. Content-Type is intentionally omitted (no body).
        return new NextResponse(null, {
            ...rest,
            status: 304,
            headers: baseHeaders,
        });
    }

    baseHeaders.set('Content-Type', 'application/json');
    return new NextResponse(body, {
        ...rest,
        status: rest.status ?? 200,
        headers: baseHeaders,
    });
}
