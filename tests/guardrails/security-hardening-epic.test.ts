/**
 * Security Hardening Epic — Regression Guards
 *
 * Structural tests that verify all security hardening deliverables remain
 * wired correctly. These tests scan source code and schema to ensure:
 *
 *   1. Security headers module is applied in middleware
 *   2. CORS is locked — no wildcards, no localhost fallback in production
 *   3. OAuth tokens have encrypted columns and PII middleware coverage
 *   4. Fail-closed MFA is configurable per tenant
 *   5. CSP has nonce, report-only toggle, and no unsafe-inline in production
 *   6. Admin routes have Sec-Fetch-Site cross-site protection
 *
 * These are fast, static-analysis tests (no DB, no network).
 */
import * as fs from 'fs';
import * as path from 'path';
import { readPrismaSchema } from '../helpers/prisma-schema';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

// ─── 1. Security Headers ────────────────────────────────────────────

describe('Security Headers', () => {
    const headers = read('src/lib/security/headers.ts');

    const REQUIRED_HEADERS = [
        'Strict-Transport-Security',
        'X-Frame-Options',
        'X-Content-Type-Options',
        'Referrer-Policy',
        'Permissions-Policy',
        'Cross-Origin-Opener-Policy',
        'Cross-Origin-Resource-Policy',
    ];

    for (const header of REQUIRED_HEADERS) {
        test(`${header} is defined`, () => {
            expect(headers).toContain(header);
        });
    }

    test('HSTS is environment-aware (production vs non-production)', () => {
        expect(headers).toContain('isProduction');
        expect(headers).toContain('max-age=31536000');
    });

    test('X-Frame-Options is DENY', () => {
        expect(headers).toContain("'DENY'");
    });
});

// ─── 2. CORS ─────────────────────────────────────────────────────────

describe('CORS Hardening', () => {
    const cors = read('src/lib/security/cors.ts');
    const middleware = read('src/middleware.ts');

    test('CORS module does not have wildcard origin', () => {
        // The CORS module should never allow '*' as an origin
        expect(cors).not.toMatch(/allowedOrigins.*\*/);
    });

    test('middleware uses centralized CORS module', () => {
        expect(middleware).toContain('resolveCorsConfig');
        expect(middleware).toContain('isOriginAllowed');
        expect(middleware).toContain('applyCorsHeaders');
    });

    test('no inline localhost fallback in middleware', () => {
        expect(middleware).not.toContain("origin.startsWith('http://localhost:");
    });

    test('no wildcard Access-Control-Allow-Origin in middleware', () => {
        expect(middleware).not.toContain("'Access-Control-Allow-Origin', '*'");
    });
});

// ─── 3. OAuth Token Encryption ───────────────────────────────────────

describe('OAuth Token Encryption', () => {
    const schema = readPrismaSchema();
    const piiMiddleware = read('src/lib/security/pii-middleware.ts');

    test('Account model has accessTokenEncrypted column', () => {
        expect(schema).toContain('accessTokenEncrypted');
    });

    test('Account model has refreshTokenEncrypted column', () => {
        expect(schema).toContain('refreshTokenEncrypted');
    });

    test('PII middleware covers Account model', () => {
        expect(piiMiddleware).toContain('Account');
    });

    test('PII middleware handles access_token field', () => {
        expect(piiMiddleware).toContain('access_token');
    });

    test('PII middleware handles refresh_token field', () => {
        expect(piiMiddleware).toContain('refresh_token');
    });

    test('PII middleware supports updateMany (token refresh path)', () => {
        expect(piiMiddleware).toContain('updateMany');
    });

    test('backfill script exists', () => {
        expect(fs.existsSync(path.join(ROOT, 'scripts/backfill-token-encryption.ts'))).toBe(true);
    });

    test('backfill script supports dry-run', () => {
        const script = read('scripts/backfill-token-encryption.ts');
        expect(script).toContain('--execute');
        expect(script).toContain('DRY RUN');
    });

    test('backfill script supports roundtrip verification', () => {
        const script = read('scripts/backfill-token-encryption.ts');
        expect(script).toContain('Roundtrip verification');
        expect(script).toContain('decryptField');
    });
});

// ─── 4. Fail-Closed MFA ──────────────────────────────────────────────

describe('Fail-Closed MFA', () => {
    const schema = readPrismaSchema();
    const auth = read('src/auth.ts');

    test('TenantSecuritySettings has mfaFailClosed field', () => {
        expect(schema).toContain('mfaFailClosed');
    });

    test('mfaFailClosed defaults to false', () => {
        expect(schema).toContain('@default(false)');
    });

    test('auth.ts reads mfaFailClosed from security settings', () => {
        expect(auth).toContain('mfaFailClosed');
    });

    test('auth.ts sets MfaDependencyFailure error on fail-closed', () => {
        expect(auth).toContain('MfaDependencyFailure');
    });

    test('auth.ts caches mfaFailClosed in token', () => {
        expect(auth).toContain('token.mfaFailClosed');
    });
});

// ─── 5. CSP ──────────────────────────────────────────────────────────

describe('CSP Hardening', () => {
    const csp = read('src/lib/security/csp.ts');
    const middleware = read('src/middleware.ts');

    test('CSP module has report-only mode toggle', () => {
        expect(csp).toContain('isCspReportOnly');
        expect(csp).toContain('getCspHeaderName');
    });

    test('CSP module uses nonce-based script-src', () => {
        expect(csp).toContain("'nonce-${nonce}'");
        expect(csp).toContain("'strict-dynamic'");
    });

    test('CSP module does NOT have unsafe-inline in production script-src', () => {
        // script-src must never allow 'unsafe-inline' (strict-dynamic +
        // nonce only). style-src intentionally carries 'unsafe-inline'
        // so dynamic SSR style="" attributes render — assert at runtime
        // instead of scanning source, since the csp.ts layout now has
        // an unconditional 'unsafe-inline' in the style-src block.
        const { buildCspHeader, generateNonce } = require('../../src/lib/security/csp');
        const header: string = buildCspHeader(generateNonce(), false);
        const scriptSrc = header.split(';').find((d: string) => d.trim().startsWith('script-src'))!;
        expect(scriptSrc).not.toContain("'unsafe-inline'");
    });

    test('CSP has report-to directive', () => {
        expect(csp).toContain("'report-to'");
        expect(csp).toContain('CSP_REPORT_GROUP');
    });

    test('CSP has worker-src directive', () => {
        expect(csp).toContain("'worker-src'");
    });

    test('CSP has manifest-src directive', () => {
        expect(csp).toContain("'manifest-src'");
    });

    test('middleware uses dynamic CSP header name', () => {
        expect(middleware).toContain('getCspHeaderName');
        expect(middleware).toContain('cspHeaderName');
    });

    test('CSP report endpoint route exists', () => {
        expect(fs.existsSync(
            path.join(ROOT, 'src/app/api/security/csp-report/route.ts')
        )).toBe(true);
    });
});

// ─── 6. Admin Session Guard ──────────────────────────────────────────

describe('Admin Session Guard', () => {
    const guard = read('src/lib/security/admin-session-guard.ts');
    const middleware = read('src/middleware.ts');

    test('admin session guard module exists', () => {
        expect(guard).toContain('shouldBlockAdminRequest');
    });

    test('admin guard checks Sec-Fetch-Site header', () => {
        expect(guard).toContain('same-origin');
        expect(guard).toContain('cross-site');
        expect(guard).toContain('Sec-Fetch-Site');
    });

    test('middleware integrates admin session guard', () => {
        expect(middleware).toContain('shouldBlockAdminRequest');
        expect(middleware).toContain('sec-fetch-site');
    });

    test('middleware blocks cross-site admin requests', () => {
        expect(middleware).toContain('Cross-site admin requests are not allowed');
    });
});
