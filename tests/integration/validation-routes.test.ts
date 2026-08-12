/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
import { NextRequest } from 'next/server';

// Mock auth to avoid importing next-auth (which causes ESM Jest parsing errors)
jest.mock('@/lib/auth', () => ({
    getSessionOrThrow: jest.fn().mockImplementation(() => {
        throw new Error('Not reached - validation should fail first');
    }),
    requireRole: jest.fn(),
}));

// Mock getTenantCtx to avoid real DB lookups
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: jest.fn().mockRejectedValue(new Error('Not reached - validation should fail first')),
}));

import { POST as EvidencePost } from '@/app/api/evidence/route';

describe('Validation Layer Integration', () => {
    describe('JSON Body Validation — Evidence', () => {
        it('POST /api/evidence returns 400 when required fields are missing', async () => {
            const req = new NextRequest('http://localhost/api/evidence', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'FILE' }),
                // Missing 'title' which is strictly required by CreateEvidenceSchema
            });
            const res = await EvidencePost(req, { params: {} } as any);

            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error.code).toBe('VALIDATION_ERROR');
            expect(data.error.details.some((issue: any) => issue.path.includes('title'))).toBe(true);
        });
    });
});
