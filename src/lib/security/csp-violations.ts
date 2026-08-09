/**
 * CSP Violation Store — in-memory ring buffer for recent violations.
 *
 * Architecture:
 *   Browser → POST /api/security/csp-report → parse → store + log
 *   Admin  → GET  /api/security/csp-report  → read recent violations
 *
 * Storage strategy:
 *   - Ring buffer of MAX_VIOLATIONS entries (default 500)
 *   - Oldest entries are evicted when the buffer is full
 *   - Violations are also emitted as structured console.warn for SIEM ingestion
 *   - No database table needed — violations are ephemeral operational data
 *   - For durable storage, pipe console output to your log aggregator
 *
 * Rate limiting:
 *   - 30 reports per IP per 60-second window (in-memory)
 *   - Excess reports return 429 silently
 */

// ─── Types ───────────────────────────────────────────────────────────

import { logger } from '@/lib/observability/logger';

/**
 * Normalized CSP violation record.
 * Sourced from either legacy `csp-report` or modern `Report-To` payloads.
 */
export interface CspViolation {
    /** Unique ID for this violation */
    id: string;
    /** Page URL where the violation occurred */
    documentUri: string;
    /** CSP directive that was violated (e.g. "script-src") */
    violatedDirective: string;
    /** The blocked resource URI */
    blockedUri: string;
    /** Original CSP policy that was enforced */
    originalPolicy: string;
    /** Source file that triggered the violation */
    sourceFile: string;
    /** Line number in the source file */
    lineNumber: number;
    /** Column number in the source file */
    columnNumber: number;
    /** Browser User-Agent */
    userAgent: string;
    /** Client IP (first hop) */
    clientIp: string;
    /** Whether this is from report-only mode */
    disposition: 'enforce' | 'report';
    /** When the violation was received */
    createdAt: string;
}

/**
 * Summary statistics for the admin API.
 */
export interface CspViolationSummary {
    totalReceived: number;
    totalDropped: number;
    bufferSize: number;
    oldestEntry: string | null;
    newestEntry: string | null;
    byDirective: Record<string, number>;
    byBlockedUri: Record<string, number>;
    recentViolations: CspViolation[];
}

// ─── Configuration ───────────────────────────────────────────────────

/** Max violations to keep in memory */
const MAX_VIOLATIONS = 500;

/** Max payload size in bytes (16 KB) */
export const MAX_REPORT_PAYLOAD_BYTES = 16_384;

/** Rate limit: max reports per IP per window */
const RATE_LIMIT_MAX = 30;

/** Rate limit window in ms (60 seconds) */
const RATE_LIMIT_WINDOW_MS = 60_000;

// ─── State ───────────────────────────────────────────────────────────

const violations: CspViolation[] = [];
let totalReceived = 0;
let totalDropped = 0;

// Simple sliding-window rate limiter (IP → { count, resetAt })
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

// ─── Rate Limiting ───────────────────────────────────────────────────

/**
 * Check if this IP has exceeded the CSP report rate limit.
 * Returns true if the request is allowed, false if rate limited.
 */
export function checkReportRateLimit(clientIp: string): boolean {
    const now = Date.now();
    let entry = rateLimitMap.get(clientIp);

    if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    }

    entry.count++;
    rateLimitMap.set(clientIp, entry);

    // Periodic cleanup — prevent memory leak from abandoned IPs
    if (rateLimitMap.size > 10_000) {
        for (const [ip, rec] of rateLimitMap) {
            if (now > rec.resetAt) rateLimitMap.delete(ip);
        }
    }

    return entry.count <= RATE_LIMIT_MAX;
}

// ─── Storage ─────────────────────────────────────────────────────────

/**
 * Store a CSP violation in the ring buffer and emit a structured log.
 */
export function storeViolation(violation: CspViolation): void {
    totalReceived++;

    // Ring buffer eviction
    if (violations.length >= MAX_VIOLATIONS) {
        violations.shift();
    }

    violations.push(violation);

    // Structured log for SIEM / log aggregator ingestion
    logger.warn('CSP violation', {
        component: 'csp',
        documentUri: violation.documentUri,
        violatedDirective: violation.violatedDirective,
        blockedUri: violation.blockedUri,
        sourceFile: violation.sourceFile,
        lineNumber: violation.lineNumber,
        disposition: violation.disposition,
    });
}

/**
 * Record a dropped report (rate-limited or malformed).
 */
export function recordDropped(): void {
    totalDropped++;
}

// ─── Query ───────────────────────────────────────────────────────────

/**
 * Get summary statistics + recent violations for the admin API.
 */
export function getViolationSummary(limit = 50): CspViolationSummary {
    const recent = violations.slice(-limit).reverse();

    // Aggregate by directive
    const byDirective: Record<string, number> = {};
    const byBlockedUri: Record<string, number> = {};

    for (const v of violations) {
        byDirective[v.violatedDirective] = (byDirective[v.violatedDirective] || 0) + 1;

        // Truncate blocked URIs for grouping (scheme + host only)
        let groupUri = v.blockedUri;
        try {
            if (groupUri && groupUri.startsWith('http')) {
                const u = new URL(groupUri);
                groupUri = `${u.protocol}//${u.host}`;
            }
        } catch {
            // Keep original if not a valid URL
        }
        if (groupUri) {
            byBlockedUri[groupUri] = (byBlockedUri[groupUri] || 0) + 1;
        }
    }

    return {
        totalReceived,
        totalDropped,
        bufferSize: violations.length,
        oldestEntry: violations[0]?.createdAt ?? null,
        newestEntry: violations.at(-1)?.createdAt ?? null,
        byDirective,
        byBlockedUri,
        recentViolations: recent,
    };
}

// ─── Parsing ─────────────────────────────────────────────────────────

/**
 * Parse a legacy CSP report payload (application/csp-report).
 *
 * Legacy format:
 * ```json
 * { "csp-report": { "document-uri": "...", "violated-directive": "...", ... } }
 * ```
 */
export function parseLegacyReport(
    body: Record<string, unknown>,
    clientIp: string,
    userAgent: string,
): CspViolation | null {
    const report = body['csp-report'];
    if (!report || typeof report !== 'object') return null;
    const r = report as Record<string, unknown>;

    return {
        id: crypto.randomUUID(),
        documentUri: sanitizeUri(r['document-uri']),
        violatedDirective: sanitizeString(r['violated-directive']),
        blockedUri: sanitizeUri(r['blocked-uri']),
        originalPolicy: sanitizeString(r['original-policy'], 500),
        sourceFile: sanitizeUri(r['source-file']),
        lineNumber: toSafeInt(r['line-number']),
        columnNumber: toSafeInt(r['column-number']),
        userAgent,
        clientIp,
        disposition: r['disposition'] === 'report' ? 'report' : 'enforce',
        createdAt: new Date().toISOString(),
    };
}

/**
 * Parse a modern Reporting API payload (application/reports+json).
 *
 * Modern format (array of report objects):
 * ```json
 * [{ "type": "csp-violation", "body": { "documentURL": "...", ... } }]
 * ```
 */
export function parseModernReports(
    body: unknown[],
    clientIp: string,
    userAgent: string,
): CspViolation[] {
    const results: CspViolation[] = [];

    for (const entry of body) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        if (e.type !== 'csp-violation' || !e.body || typeof e.body !== 'object') continue;

        const b = e.body as Record<string, unknown>;
        results.push({
            id: crypto.randomUUID(),
            documentUri: sanitizeUri(b.documentURL || b.documentUri),
            violatedDirective: sanitizeString(b.effectiveDirective || b.violatedDirective),
            blockedUri: sanitizeUri(b.blockedURL || b.blockedUri),
            originalPolicy: sanitizeString(b.originalPolicy, 500),
            sourceFile: sanitizeUri(b.sourceFile),
            lineNumber: toSafeInt(b.lineNumber),
            columnNumber: toSafeInt(b.columnNumber),
            userAgent,
            clientIp,
            disposition: b.disposition === 'report' ? 'report' : 'enforce',
            createdAt: new Date().toISOString(),
        });
    }

    return results;
}

// ─── Sanitizers ──────────────────────────────────────────────────────

function sanitizeUri(value: unknown): string {
    if (typeof value !== 'string') return '';
    // Truncate long URIs and strip practice characters
    return value.replace(/[\x00-\x1f]/g, '').substring(0, 2048);
}

function sanitizeString(value: unknown, maxLen = 256): string {
    if (typeof value !== 'string') return '';
    return value.replace(/[\x00-\x1f]/g, '').substring(0, maxLen);
}

function toSafeInt(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.floor(value));
    }
    return 0;
}

// ─── Test Helpers ────────────────────────────────────────────────────

/** Reset all state — for testing only */
export function _resetForTesting(): void {
    violations.length = 0;
    totalReceived = 0;
    totalDropped = 0;
    rateLimitMap.clear();
}
