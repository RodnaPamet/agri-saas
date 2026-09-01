/**
 * Unit tests for CSP refinement.
 *
 * Tests:
 *  1. CSP header structure and directives
 *  2. Report-only mode toggle
 *  3. Nonce integration
 *  4. unsafe-inline removal verification
 *  5. Directive completeness
 */
import {
    generateNonce,
    buildCspHeader,
    getCspHeaderName,
    isCspReportOnly,
    CSP_HEADER_ENFORCE,
    CSP_HEADER_REPORT_ONLY,
    CSP_REPORT_PATH,
    CSP_REPORT_GROUP,
} from '@/lib/security/csp';

// ─── Nonce Generation ────────────────────────────────────────────────

describe('generateNonce', () => {
    test('generates a non-empty string', () => {
        const nonce = generateNonce();
        expect(nonce).toBeTruthy();
        expect(typeof nonce).toBe('string');
    });

    test('generates unique nonces', () => {
        const nonces = new Set(Array.from({ length: 100 }, () => generateNonce()));
        expect(nonces.size).toBe(100);
    });

    test('nonce is base64-encoded', () => {
        const nonce = generateNonce();
        // Base64 characters only
        expect(nonce).toMatch(/^[A-Za-z0-9+/=]+$/);
    });
});

// ─── Report-Only Mode Toggle ─────────────────────────────────────────

describe('isCspReportOnly', () => {
    test('returns false for undefined', () => {
        expect(isCspReportOnly(undefined)).toBe(false);
    });

    test('returns false for empty string', () => {
        expect(isCspReportOnly('')).toBe(false);
    });

    test('returns false for "false"', () => {
        expect(isCspReportOnly('false')).toBe(false);
    });

    test('returns false for "0"', () => {
        expect(isCspReportOnly('0')).toBe(false);
    });

    test('returns true for "true"', () => {
        expect(isCspReportOnly('true')).toBe(true);
    });

    test('returns true for "1"', () => {
        expect(isCspReportOnly('1')).toBe(true);
    });

    test('returns true for "yes"', () => {
        expect(isCspReportOnly('yes')).toBe(true);
    });

    test('case insensitive', () => {
        expect(isCspReportOnly('TRUE')).toBe(true);
        expect(isCspReportOnly('Yes')).toBe(true);
    });

    test('trims whitespace', () => {
        expect(isCspReportOnly('  true  ')).toBe(true);
    });
});

describe('getCspHeaderName', () => {
    test('returns enforce header when reportOnly=false', () => {
        expect(getCspHeaderName(false)).toBe(CSP_HEADER_ENFORCE);
        expect(getCspHeaderName(false)).toBe('Content-Security-Policy');
    });

    test('returns report-only header when reportOnly=true', () => {
        expect(getCspHeaderName(true)).toBe(CSP_HEADER_REPORT_ONLY);
        expect(getCspHeaderName(true)).toBe('Content-Security-Policy-Report-Only');
    });
});

// ─── CSP Header Building ────────────────────────────────────────────

describe('buildCspHeader', () => {
    const nonce = 'dGVzdC1ub25jZQ==';

    describe('production mode (isDev=false)', () => {
        const header = buildCspHeader(nonce, false);

        test('includes default-src self', () => {
            expect(header).toContain("default-src 'self'");
        });

        test('includes nonce in script-src', () => {
            expect(header).toContain(`'nonce-${nonce}'`);
        });

        test('includes strict-dynamic in script-src', () => {
            expect(header).toContain("'strict-dynamic'");
        });

        test('does NOT include unsafe-inline in script-src', () => {
            const scriptSrc = header.split(';')
                .find(d => d.trim().startsWith('script-src'))!;
            expect(scriptSrc).not.toContain("'unsafe-inline'");
        });

        test('does NOT include unsafe-eval in production', () => {
            expect(header).not.toContain("'unsafe-eval'");
        });

        test('DOES include unsafe-inline in style-src (production)', () => {
            // Style attributes can't be covered by nonce/hash per CSP L3;
            // 'unsafe-inline' is the only way to allow dynamic progress
            // bars etc. without a hash-per-value listing. <style> tags
            // stay nonce-gated because nonces take precedence there.
            const styleSrc = header.split(';')
                .find(d => d.trim().startsWith('style-src'))!;
            expect(styleSrc).toContain("'unsafe-inline'");
        });

        test('does NOT include nonce in style-src', () => {
            // Nonce would invalidate 'unsafe-inline' per CSP L3 and
            // break every `style=""` attribute in SSR output.
            const styleSrc = header.split(';')
                .find(d => d.trim().startsWith('style-src'))!;
            expect(styleSrc).not.toContain(`'nonce-${nonce}'`);
        });

        test('includes NO Google Fonts origin — self-hosted since #779', () => {
            expect(header).not.toContain('https://fonts.googleapis.com');
            expect(header).not.toContain('https://fonts.gstatic.com');
        });

        test('includes object-src none', () => {
            expect(header).toContain("object-src 'none'");
        });

        test('includes frame-ancestors none', () => {
            expect(header).toContain("frame-ancestors 'none'");
        });

        test('includes form-action self', () => {
            expect(header).toContain("form-action 'self'");
        });

        test('includes base-uri self', () => {
            expect(header).toContain("base-uri 'self'");
        });

        test('includes upgrade-insecure-requests', () => {
            expect(header).toContain('upgrade-insecure-requests');
        });

        test('includes report-uri', () => {
            expect(header).toContain(`report-uri ${CSP_REPORT_PATH}`);
        });

        test('includes report-to directive', () => {
            expect(header).toContain(`report-to ${CSP_REPORT_GROUP}`);
        });

        test('includes worker-src', () => {
            expect(header).toContain("worker-src 'self' blob:");
        });

        test('includes manifest-src', () => {
            expect(header).toContain("manifest-src 'self'");
        });
    });

    describe('development mode (isDev=true)', () => {
        const header = buildCspHeader(nonce, true);

        test('includes unsafe-eval for HMR', () => {
            expect(header).toContain("'unsafe-eval'");
        });

        test('includes unsafe-inline in style-src for HMR', () => {
            const styleSrc = header.split(';')
                .find(d => d.trim().startsWith('style-src'))!;
            expect(styleSrc).toContain("'unsafe-inline'");
        });

        test('includes WebSocket for HMR', () => {
            expect(header).toContain('ws://localhost:*');
            expect(header).toContain('ws://127.0.0.1:*');
        });

        test('does NOT include upgrade-insecure-requests', () => {
            expect(header).not.toContain('upgrade-insecure-requests');
        });
    });
});

// ─── CSP Completeness Guardrails ─────────────────────────────────────

describe('CSP completeness guardrails', () => {
    const header = buildCspHeader('test-nonce', false);

    const REQUIRED_DIRECTIVES = [
        'default-src',
        'script-src',
        'style-src',
        'img-src',
        'font-src',
        'connect-src',
        'object-src',
        'base-uri',
        'frame-ancestors',
        'form-action',
        'worker-src',
        'manifest-src',
        'report-uri',
        'report-to',
    ];

    for (const directive of REQUIRED_DIRECTIVES) {
        test(`includes ${directive} directive`, () => {
            const directives = header.split(';').map(d => d.trim().split(' ')[0]);
            expect(directives).toContain(directive);
        });
    }

    test('no wildcard in script-src', () => {
        const scriptSrc = header.split(';')
            .find(d => d.trim().startsWith('script-src'))!;
        // Wildcards (* without quotes) would be dangerous
        expect(scriptSrc).not.toMatch(/\s\*(\s|$)/);
    });

    test('no unsafe-inline in production script-src', () => {
        const scriptSrc = header.split(';')
            .find(d => d.trim().startsWith('script-src'))!;
        expect(scriptSrc).not.toContain("'unsafe-inline'");
    });

    test('production style-src allows unsafe-inline', () => {
        // Nonces/hashes don't match `style=""` attributes per CSP L3;
        // the app uses dynamic inline styles (progress-bar widths,
        // colour-coded badges) so 'unsafe-inline' is required.
        const styleSrc = header.split(';')
            .find(d => d.trim().startsWith('style-src'))!;
        expect(styleSrc).toContain("'unsafe-inline'");
    });
});
