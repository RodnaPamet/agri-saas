import { NextRequest, NextResponse } from 'next/server';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import {
    checkReportRateLimit,
    storeViolation,
    recordDropped,
    parseLegacyReport,
    parseModernReports,
    getViolationSummary,
    MAX_REPORT_PAYLOAD_BYTES,
} from '@/lib/security/csp-violations';
import { jsonResponse } from '@/lib/api-response';

/**
 * CSP Violation Report Endpoint
 *
 * POST — receives browser CSP violation reports
 *   Supports:
 *     - Legacy: application/csp-report (single violation)
 *     - Modern: application/reports+json (Reporting API v1, array)
 *     - Fallback: application/json
 *
 * GET — returns recent violation summary (operator debugging)
 *   Protected by `verifyPlatformApiKey` IN THIS HANDLER — see the note on the
 *   GET below. It must not depend on the Edge gate, because the POST sink
 *   beside it is deliberately public there.
 *
 * Security:
 *   - Rate limited: 30 reports/IP/min
 *   - Payload size capped at 16 KB
 *   - No CSRF token required (browser sends reports without credentials) —
 *     which is also why this path sits in `PUBLIC_PATH_PREFIXES`; see #704
 *   - Always returns 204 on POST (never leaks internal state)
 */

// ─── POST: Receive CSP violation reports ─────────────────────────────

export async function POST(request: Request): Promise<NextResponse> {
    try {
        // ── Rate limit by IP ──
        const clientIp = extractClientIp(request);
        if (!checkReportRateLimit(clientIp)) {
            recordDropped();
            return new NextResponse(null, { status: 429 });
        }

        // ── Payload size guard ──
        const contentLength = request.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > MAX_REPORT_PAYLOAD_BYTES) {
            recordDropped();
            return new NextResponse(null, { status: 413 });
        }

        // ── Read body with size limit ──
        const rawBody = await readBodyWithLimit(request, MAX_REPORT_PAYLOAD_BYTES);
        if (rawBody === null) {
            recordDropped();
            return new NextResponse(null, { status: 413 });
        }

        // ── Parse payload ──
        const contentType = request.headers.get('content-type') ?? '';
        const userAgent = request.headers.get('user-agent') ?? '';

        let parsed: ReturnType<typeof JSON.parse>;
        try {
            parsed = JSON.parse(rawBody);
        } catch {
            recordDropped();
            return new NextResponse(null, { status: 204 });
        }

        // ── Legacy format: { "csp-report": { ... } } ──
        if (
            contentType.includes('application/csp-report') ||
            (typeof parsed === 'object' && parsed !== null && 'csp-report' in parsed)
        ) {
            const violation = parseLegacyReport(parsed, clientIp, userAgent);
            if (violation) {
                storeViolation(violation);
            } else {
                recordDropped();
            }
            return new NextResponse(null, { status: 204 });
        }

        // ── Modern format: [{ "type": "csp-violation", "body": { ... } }] ──
        if (
            contentType.includes('application/reports+json') ||
            Array.isArray(parsed)
        ) {
            const violations = parseModernReports(parsed, clientIp, userAgent);
            for (const v of violations) {
                storeViolation(v);
            }
            if (violations.length === 0) recordDropped();
            return new NextResponse(null, { status: 204 });
        }

        // ── Unknown format ──
        recordDropped();
        return new NextResponse(null, { status: 204 });
    } catch {
        // Never leak errors — always 204
        recordDropped();
        return new NextResponse(null, { status: 204 });
    }
}

// ─── GET: Operator summary of recent violations ─────────────────────

/**
 * Platform-admin only, and that is a FIX, not a tightening for its own sake
 * (#704).
 *
 * This used to read, in full:
 *
 *     // NOTE: This route is protected by the middleware auth guard.
 *     // Only authenticated users can access /api/* routes.
 *
 * Two things were wrong with relying on that. First, "any authenticated user"
 * is not a meaningful bar for this payload: `getViolationSummary` returns
 * `recentViolations: CspViolation[]` — the WHOLE objects, including
 * `clientIp` and `userAgent` — from a single GLOBAL 500-entry ring with no
 * tenant scoping. Any logged-in member of any tenant could read every other
 * tenant's reporters.
 *
 * Second, and worse: the POST above is now public at the Edge, because a
 * browser cannot send a session cookie with a violation report. `isPublicPath`
 * matches on PREFIX, so opening the sink opens this method too. The two bugs
 * used to cancel — the POST was 401'd, so the buffer was always empty, so this
 * returned nothing worth having. Fixing the POST is exactly what ARMS this,
 * which is why the gate had to land in the same diff rather than after it.
 *
 * `verifyPlatformApiKey` is the right bar: this is an operator-with-curl
 * endpoint (no UI calls it — verified), matching the nine other platform-admin
 * routes. It also satisfies direction B of
 * `tests/guards/public-routes-self-authenticate.test.ts` without an exemption.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
    try {
        verifyPlatformApiKey(request);
    } catch (err) {
        if (err instanceof PlatformAdminError) {
            return NextResponse.json({ error: err.message }, { status: err.status });
        }
        throw err;
    }

    const summary = getViolationSummary(50);
    return jsonResponse(summary);
}

// ─── Helpers ─────────────────────────────────────────────────────────

function extractClientIp(request: Request): string {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return '127.0.0.1';
}

/**
 * Read request body with a byte limit to prevent memory exhaustion.
 * Returns null if the body exceeds the limit.
 */
async function readBodyWithLimit(request: Request, maxBytes: number): Promise<string | null> {
    const reader = request.body?.getReader();
    if (!reader) return null;

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            totalBytes += value.byteLength;
            if (totalBytes > maxBytes) {
                reader.cancel();
                return null;
            }
            chunks.push(value);
        }

        const merged = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
        }

        return new TextDecoder().decode(merged);
    } catch {
        return null;
    }
}
