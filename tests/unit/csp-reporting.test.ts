import {
    checkReportRateLimit,
    storeViolation,
    recordDropped,
    parseLegacyReport,
    parseModernReports,
    getViolationSummary,
    _resetForTesting,
    MAX_REPORT_PAYLOAD_BYTES,
} from '../../src/lib/security/csp-violations';

/**
 * Integration tests for the CSP violation store and report parsing.
 * These test the core logic that the /api/security/csp-report endpoint uses.
 */

beforeEach(() => {
    _resetForTesting();
});

// ─── Legacy Report Parsing ───────────────────────────────────────────

describe('parseLegacyReport', () => {
    const LEGACY_PAYLOAD = {
        'csp-report': {
            'document-uri': 'https://app.example.com/dashboard',
            'referrer': '',
            'violated-directive': 'script-src',
            'effective-directive': 'script-src',
            'original-policy': "default-src 'self'; script-src 'self' 'nonce-abc123'",
            'disposition': 'enforce',
            'blocked-uri': 'https://evil.com/tracker.js',
            'line-number': 42,
            'column-number': 8,
            'source-file': 'https://app.example.com/bundle.js',
            'status-code': 200,
        },
    };

    it('parses a valid legacy CSP report', () => {
        const result = parseLegacyReport(LEGACY_PAYLOAD, '1.2.3.4', 'TestBrowser/1.0');
        expect(result).not.toBeNull();
        expect(result!.documentUri).toBe('https://app.example.com/dashboard');
        expect(result!.violatedDirective).toBe('script-src');
        expect(result!.blockedUri).toBe('https://evil.com/tracker.js');
        expect(result!.lineNumber).toBe(42);
        expect(result!.columnNumber).toBe(8);
        expect(result!.sourceFile).toBe('https://app.example.com/bundle.js');
        expect(result!.clientIp).toBe('1.2.3.4');
        expect(result!.disposition).toBe('enforce');
        expect(result!.id).toBeTruthy();
        expect(result!.createdAt).toBeTruthy();
    });

    it('returns null for missing csp-report key', () => {
        const result = parseLegacyReport({}, '1.2.3.4', '');
        expect(result).toBeNull();
    });

    it('returns null for non-object csp-report value', () => {
        const result = parseLegacyReport({ 'csp-report': 'not-an-object' }, '1.2.3.4', '');
        expect(result).toBeNull();
    });

    it('handles missing optional fields gracefully', () => {
        const minimal = {
            'csp-report': {
                'document-uri': 'https://example.com',
                'violated-directive': 'style-src',
            },
        };
        const result = parseLegacyReport(minimal, '127.0.0.1', '');
        expect(result).not.toBeNull();
        expect(result!.blockedUri).toBe('');
        expect(result!.lineNumber).toBe(0);
        expect(result!.sourceFile).toBe('');
    });

    it('sanitizes practice characters in URIs', () => {
        const payload = {
            'csp-report': {
                'document-uri': 'https://example.com/\x00\x01\x02page',
                'violated-directive': 'script-src',
            },
        };
        const result = parseLegacyReport(payload, '127.0.0.1', '');
        expect(result!.documentUri).not.toContain('\x00');
        expect(result!.documentUri).toBe('https://example.com/page');
    });

    it('truncates excessively long URIs', () => {
        const longUri = 'https://example.com/' + 'x'.repeat(5000);
        const payload = {
            'csp-report': {
                'document-uri': longUri,
                'violated-directive': 'script-src',
            },
        };
        const result = parseLegacyReport(payload, '127.0.0.1', '');
        expect(result!.documentUri.length).toBeLessThanOrEqual(2048);
    });
});

// ─── Modern Report Parsing ───────────────────────────────────────────

describe('parseModernReports', () => {
    const MODERN_PAYLOAD = [
        {
            type: 'csp-violation',
            age: 10,
            url: 'https://app.example.com/dashboard',
            user_agent: 'Chrome/120',
            body: {
                documentURL: 'https://app.example.com/dashboard',
                effectiveDirective: 'script-src',
                blockedURL: 'inline',
                originalPolicy: "default-src 'self'",
                sourceFile: 'https://app.example.com/app.js',
                lineNumber: 15,
                columnNumber: 3,
                disposition: 'enforce',
            },
        },
    ];

    it('parses a valid modern Reporting API payload', () => {
        const results = parseModernReports(MODERN_PAYLOAD, '10.0.0.1', 'Chrome/120');
        expect(results).toHaveLength(1);
        expect(results[0].documentUri).toBe('https://app.example.com/dashboard');
        expect(results[0].violatedDirective).toBe('script-src');
        expect(results[0].blockedUri).toBe('inline');
        expect(results[0].lineNumber).toBe(15);
    });

    it('skips non-csp-violation entries', () => {
        const mixed = [
            { type: 'deprecation', body: { id: 'some-api' } },
            ...MODERN_PAYLOAD,
            { type: 'network-error', body: {} },
        ];
        const results = parseModernReports(mixed, '10.0.0.1', '');
        expect(results).toHaveLength(1);
    });

    it('returns empty array for empty input', () => {
        expect(parseModernReports([], '10.0.0.1', '')).toHaveLength(0);
    });

    it('handles null/undefined entries gracefully', () => {
        const results = parseModernReports([null, undefined, 123] as unknown[], '10.0.0.1', '');
        expect(results).toHaveLength(0);
    });
});

// ─── Rate Limiting ───────────────────────────────────────────────────

describe('checkReportRateLimit', () => {
    it('allows requests under the limit', () => {
        for (let i = 0; i < 30; i++) {
            expect(checkReportRateLimit('192.168.1.1')).toBe(true);
        }
    });

    it('blocks requests over the limit', () => {
        for (let i = 0; i < 30; i++) {
            checkReportRateLimit('192.168.1.2');
        }
        expect(checkReportRateLimit('192.168.1.2')).toBe(false);
    });

    it('isolates rate limits per IP', () => {
        // Exhaust one IP
        for (let i = 0; i < 31; i++) {
            checkReportRateLimit('10.0.0.1');
        }
        // Different IP should still be allowed
        expect(checkReportRateLimit('10.0.0.2')).toBe(true);
    });
});

// ─── Violation Store ─────────────────────────────────────────────────

describe('CspViolationStore', () => {
    it('stores and retrieves violations', () => {
        const violation = parseLegacyReport(
            {
                'csp-report': {
                    'document-uri': 'https://example.com',
                    'violated-directive': 'script-src',
                    'blocked-uri': 'inline',
                },
            },
            '127.0.0.1',
            'TestBot'
        );

        storeViolation(violation!);

        const summary = getViolationSummary();
        expect(summary.totalReceived).toBe(1);
        expect(summary.bufferSize).toBe(1);
        expect(summary.recentViolations).toHaveLength(1);
        expect(summary.recentViolations[0].violatedDirective).toBe('script-src');
    });

    it('aggregates by directive', () => {
        for (let i = 0; i < 5; i++) {
            storeViolation(parseLegacyReport(
                { 'csp-report': { 'document-uri': 'https://example.com', 'violated-directive': 'script-src', 'blocked-uri': 'x' } },
                '127.0.0.1', ''
            )!);
        }
        for (let i = 0; i < 3; i++) {
            storeViolation(parseLegacyReport(
                { 'csp-report': { 'document-uri': 'https://example.com', 'violated-directive': 'style-src', 'blocked-uri': 'x' } },
                '127.0.0.1', ''
            )!);
        }

        const summary = getViolationSummary();
        expect(summary.byDirective['script-src']).toBe(5);
        expect(summary.byDirective['style-src']).toBe(3);
    });

    it('tracks dropped reports', () => {
        recordDropped();
        recordDropped();
        const summary = getViolationSummary();
        expect(summary.totalDropped).toBe(2);
    });

    it('returns most recent violations first in summary', () => {
        storeViolation(parseLegacyReport(
            { 'csp-report': { 'document-uri': 'https://first.com', 'violated-directive': 'a' } },
            '127.0.0.1', ''
        )!);
        storeViolation(parseLegacyReport(
            { 'csp-report': { 'document-uri': 'https://second.com', 'violated-directive': 'b' } },
            '127.0.0.1', ''
        )!);

        const summary = getViolationSummary();
        // Most recent first
        expect(summary.recentViolations[0].documentUri).toBe('https://second.com');
        expect(summary.recentViolations[1].documentUri).toBe('https://first.com');
    });
});

// ─── Payload Size ────────────────────────────────────────────────────

describe('MAX_REPORT_PAYLOAD_BYTES', () => {
    it('is 16 KB', () => {
        expect(MAX_REPORT_PAYLOAD_BYTES).toBe(16_384);
    });
});

// ─── CSP Header Reporting Directives ─────────────────────────────────

describe('CSP Header Reporting', () => {
    it('production CSP includes report-uri directive', () => {
        const { buildCspHeader, generateNonce } = require('../../src/lib/security/csp');
        const csp: string = buildCspHeader(generateNonce(), false);
        expect(csp).toContain('report-uri');
        expect(csp).toContain('/api/security/csp-report');
    });

    it('CSP_REPORT_PATH points to the security endpoint', () => {
        const { CSP_REPORT_PATH } = require('../../src/lib/security/csp');
        expect(CSP_REPORT_PATH).toBe('/api/security/csp-report');
    });

    it('CSP_REPORT_GROUP is defined for Report-To header', () => {
        const { CSP_REPORT_GROUP } = require('../../src/lib/security/csp');
        expect(CSP_REPORT_GROUP).toBe('csp-endpoint');
    });
});
