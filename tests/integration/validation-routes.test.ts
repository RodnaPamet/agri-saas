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

import { POST as PoliciesPost } from '@/app/api/t/[tenantSlug]/policies/route';

// Mock getTenantCtx to avoid real DB lookups
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: jest.fn().mockRejectedValue(new Error('Not reached - validation should fail first')),
}));

import { POST as EvidencePost } from '@/app/api/evidence/route';

