/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
import { NextRequest } from 'next/server';

// Mock the checkAuthRateLimit to just pass
jest.mock('../../src/lib/rate-limit/authRateLimit', () => ({
    checkAuthRateLimit: jest.fn().mockResolvedValue({ ok: true })
}));

// GAP-04 — v4 migration: middleware now uses `getToken()` directly,
// not the v5 `auth()` async wrapper. Mock `next-auth/jwt` so the
// CORS-only unit test doesn't try to verify a real JWT cookie.
// Returning `null` from getToken is "no auth", which routes through
// the public-path / unauth branches — fine for CORS preflight tests
// which exercise the OPTIONS path before auth runs.
jest.mock('next-auth/jwt', () => ({
    getToken: jest.fn().mockResolvedValue(null),
}));

import middleware from '../../src/middleware';

describe('CORS Middleware Logic', () => {
    let originalCorsEnv: string | undefined;

    beforeAll(() => {
        originalCorsEnv = process.env.CORS_ALLOWED_ORIGINS;
    });

    afterAll(() => {
        process.env.CORS_ALLOWED_ORIGINS = originalCorsEnv;
    });

    function createMockRequest(method: string, pathname: string, origin?: string) {
        const headers = new Headers();
        if (origin) headers.set('origin', origin);

        return new NextRequest(`http://localhost:3000${pathname}`, {
            method,
            headers,
        });
    }

    it('should return CORS preflight headers for allowed origins on OPTIONS request', async () => {
        process.env.CORS_ALLOWED_ORIGINS = 'https://myapp.com,https://staging.myapp.com';

        const req = createMockRequest('OPTIONS', '/api/test', 'https://myapp.com');
        const res = await middleware(req, {} as any);

        expect(res.status).toBe(204);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://myapp.com');
        expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
        expect(res.headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS');
    });

    it('should return default CORS preflight without specific Origin if disallowed', async () => {
        process.env.CORS_ALLOWED_ORIGINS = 'https://myapp.com';

        const req = createMockRequest('OPTIONS', '/api/test', 'https://evilsite.com');
        const res = await middleware(req, {} as any);

        expect(res.status).toBe(204);
        // It does not echo the evil site for allow-origin
        expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    it('should correctly handle localhost dynamically without env var in Dev', async () => {
        process.env.CORS_ALLOWED_ORIGINS = '';

        const req = createMockRequest('OPTIONS', '/api/test', 'http://localhost:3001');
        const res = await middleware(req, {} as any);

        expect(res.status).toBe(204);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3001');
    });

    it('should append Vary and Allow-Origin to normal API GET requests from allowed origin', async () => {
        process.env.CORS_ALLOWED_ORIGINS = 'https://myapp.com';

        const req = createMockRequest('GET', '/api/data', 'https://myapp.com');
        const res = await middleware(req, {} as any);

        // Next.js middleware passes through if auth passes
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://myapp.com');
        expect(res.headers.get('Vary')).toBe('Origin');
        expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    });

    it('should NOT append Allow-Origin to normal API GET responses for disallowed origin', async () => {
        process.env.CORS_ALLOWED_ORIGINS = 'https://myapp.com';

        const req = createMockRequest('GET', '/api/data', 'https://evilsite.com');
        const res = await middleware(req, {} as any);

        expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
});
