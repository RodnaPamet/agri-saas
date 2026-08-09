/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Integration Test: API Error Handling Wrapper
 * 
 * Tests the `withApiErrorHandling` HoF to ensure standard JSON shapes
 * are returned from Next.js route handlers.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { unauthorized } from '@/lib/errors/types';
import { ZodError } from 'zod';

// Mock Handlers mapping to HTTP Verbs
const mockGetSuccess = withApiErrorHandling(async (req) => {
    return NextResponse.json({ success: true, fakeId: '123' });
});

const mockZodThrow = withApiErrorHandling(async (req) => {
    throw new ZodError([{ code: 'invalid_type', path: ['name'], expected: 'string', input: 1, message: 'Name must be string' }]);
});

const mockAppThrow = withApiErrorHandling(async (req) => {
    throw unauthorized('Token expired');
});

const mockPrismaThrow = withApiErrorHandling(async (req) => {
    // Simulate Prisma unique constraint error natively bypassing instance types
    const pErr: any = new Error('P2002 Unique Constraint');
    pErr.code = 'P2002';
    pErr.meta = { target: ['username'] };
    throw pErr;
});

const mockFatalThrow = withApiErrorHandling(async (req) => {
    throw new Error('A fatal unhandled exception accessing memory! This should NEVER reach the user.');
});

describe('API Error Handling Integration (withApiErrorHandling)', () => {

    const createReq = (url: string = 'http://localhost/api/test') => new NextRequest(url);

    it('returns successful responses without mutation', async () => {
        const req = createReq();
        const res = await mockGetSuccess(req, {});

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.fakeId).toBe('123');
        expect(res.headers.get('x-request-id')).toBeDefined(); // Wrapper should auto-inject correlation ID
    });

    it('catches and maps ZodErrors to 400 VALIDATION_ERROR shapes', async () => {
        const req = createReq();
        const res = await mockZodThrow(req, {});

        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error.code).toBe('VALIDATION_ERROR');
        expect(data.error.details).toHaveLength(1);
        expect(data.error.details[0].path).toEqual(['name']);
        expect(data.error.requestId).toBeDefined();
        expect(res.headers.get('Cache-Control')).toContain('no-store');
    });

    it('catches and maps AppErrors safely (e.g. 401 UNAUTHORIZED)', async () => {
        const req = createReq();
        const res = await mockAppThrow(req, {});

        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.error.code).toBe('UNAUTHORIZED');
        expect(data.error.message).toBe('Token expired');
    });

    it('identifies Prisma P2002 failures and maps them to 409 CONFLICT safely', async () => {
        const req = createReq();
        const res = await mockPrismaThrow(req, {});

        expect(res.status).toBe(409);
        const data = await res.json();
        expect(data.error.code).toBe('CONFLICT');
        expect(data.error.details).toEqual(['username']);
    });

    it('catches fatal unhandled throws and standardizes as 500 INTERNAL without leaking traces', async () => {
        const req = createReq();
        const res = await mockFatalThrow(req, {});

        expect(res.status).toBe(500);
        const data = await res.json();
        expect(data.error.code).toBe('INTERNAL');
        expect(data.error.message).toBe('An unexpected internal server error occurred');
        expect(data.error.details).toBeUndefined(); // LEAK PREVENTION: Ensuring memory details are omitted
        expect(data.error.requestId).toBeDefined(); // Vital for production correlation to Datadog/Sentry
    });

});
