/**
 * Unit tests for src/lib/security/cors.ts
 *
 * Verifies environment-aware CORS policy:
 * - Production/staging: fail-closed, no localhost
 * - Development/test: configured origins + localhost allowed
 */
import { resolveCorsConfig, isOriginAllowed, applyCorsHeaders, CORS_PREFLIGHT_HEADERS } from '@/lib/security/cors';

describe('resolveCorsConfig', () => {
    test('parses comma-separated origins', () => {
        const config = resolveCorsConfig('https://app.example.com, https://staging.example.com', 'production');
        expect(config.allowedOrigins).toEqual(['https://app.example.com', 'https://staging.example.com']);
    });

    test('handles empty string', () => {
        const config = resolveCorsConfig('', 'production');
        expect(config.allowedOrigins).toEqual([]);
    });

    test('handles undefined', () => {
        const config = resolveCorsConfig(undefined, 'production');
        expect(config.allowedOrigins).toEqual([]);
    });

    test('filters empty entries from trailing comma', () => {
        const config = resolveCorsConfig('https://app.example.com,', 'production');
        expect(config.allowedOrigins).toEqual(['https://app.example.com']);
    });

    test('allows localhost in development', () => {
        const config = resolveCorsConfig('', 'development');
        expect(config.allowLocalhost).toBe(true);
    });

    test('allows localhost in test', () => {
        const config = resolveCorsConfig('', 'test');
        expect(config.allowLocalhost).toBe(true);
    });

    test('disallows localhost in production', () => {
        const config = resolveCorsConfig('', 'production');
        expect(config.allowLocalhost).toBe(false);
    });

    test('disallows localhost in staging (non-standard NODE_ENV)', () => {
        const config = resolveCorsConfig('', 'staging');
        expect(config.allowLocalhost).toBe(false);
    });
});

describe('isOriginAllowed', () => {
    describe('production (fail-closed)', () => {
        const config = resolveCorsConfig('https://app.example.com', 'production');

        test('allows configured origin', () => {
            expect(isOriginAllowed('https://app.example.com', config)).toBe(true);
        });

        test('rejects non-configured origin', () => {
            expect(isOriginAllowed('https://evil.com', config)).toBe(false);
        });

        test('rejects localhost:3000', () => {
            expect(isOriginAllowed('http://localhost:3000', config)).toBe(false);
        });

        test('rejects localhost:8080', () => {
            expect(isOriginAllowed('http://localhost:8080', config)).toBe(false);
        });

        test('rejects 127.0.0.1', () => {
            expect(isOriginAllowed('http://127.0.0.1:3000', config)).toBe(false);
        });

        test('rejects empty origin', () => {
            expect(isOriginAllowed('', config)).toBe(false);
        });

        test('rejects wildcard origin', () => {
            expect(isOriginAllowed('*', config)).toBe(false);
        });
    });

    describe('production with no configured origins (maximum lockdown)', () => {
        const config = resolveCorsConfig('', 'production');

        test('rejects everything', () => {
            expect(isOriginAllowed('https://anything.com', config)).toBe(false);
            expect(isOriginAllowed('http://localhost:3000', config)).toBe(false);
        });
    });

    describe('development (localhost allowed)', () => {
        const config = resolveCorsConfig('https://app.example.com', 'development');

        test('allows configured origin', () => {
            expect(isOriginAllowed('https://app.example.com', config)).toBe(true);
        });

        test('allows localhost:3000', () => {
            expect(isOriginAllowed('http://localhost:3000', config)).toBe(true);
        });

        test('allows localhost:4200', () => {
            expect(isOriginAllowed('http://localhost:4200', config)).toBe(true);
        });

        test('allows 127.0.0.1:3000', () => {
            expect(isOriginAllowed('http://127.0.0.1:3000', config)).toBe(true);
        });

        test('rejects https://localhost (HTTPS not matching http: check)', () => {
            // Our implementation only allows http:// localhost, not https://
            expect(isOriginAllowed('https://localhost:3000', config)).toBe(false);
        });

        test('rejects non-configured non-localhost origin', () => {
            expect(isOriginAllowed('https://evil.com', config)).toBe(false);
        });
    });

    describe('test environment', () => {
        const config = resolveCorsConfig('', 'test');

        test('allows localhost even with no configured origins', () => {
            expect(isOriginAllowed('http://localhost:3000', config)).toBe(true);
        });

        test('rejects non-localhost', () => {
            expect(isOriginAllowed('https://evil.com', config)).toBe(false);
        });
    });
});

describe('applyCorsHeaders', () => {
    test('sets Access-Control-Allow-Origin to the specific origin', () => {
        const h = new Headers();
        applyCorsHeaders(h, 'https://app.example.com');

        expect(h.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
        expect(h.get('Access-Control-Allow-Credentials')).toBe('true');
        expect(h.get('Vary')).toContain('Origin');
    });

    test('never sets wildcard origin', () => {
        const h = new Headers();
        applyCorsHeaders(h, 'https://app.example.com');
        expect(h.get('Access-Control-Allow-Origin')).not.toBe('*');
    });
});

describe('CORS_PREFLIGHT_HEADERS', () => {
    test('includes required preflight headers', () => {
        expect(CORS_PREFLIGHT_HEADERS['Access-Control-Allow-Methods']).toContain('GET');
        expect(CORS_PREFLIGHT_HEADERS['Access-Control-Allow-Methods']).toContain('POST');
        expect(CORS_PREFLIGHT_HEADERS['Access-Control-Allow-Methods']).toContain('DELETE');
        expect(CORS_PREFLIGHT_HEADERS['Access-Control-Allow-Headers']).toContain('Content-Type');
        expect(CORS_PREFLIGHT_HEADERS['Access-Control-Allow-Headers']).toContain('Authorization');
        expect(CORS_PREFLIGHT_HEADERS['Access-Control-Max-Age']).toBe('86400');
    });
});
