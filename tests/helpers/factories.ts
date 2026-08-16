/**
 * Test Data Factories
 *
 * Provides builder functions for creating test entities.
 * For unit tests: returns plain objects matching expected shapes.
 * For integration tests: creates records via Prisma.
 *
 * Usage:
 *   import { buildTenant, buildUser, buildEvidence, buildTask } from '../helpers/factories';
 *   const tenant = buildTenant();
 *   const user = buildUser({ tenantId: tenant.id });
 */
import { randomUUID } from 'crypto';

// ─── Plain Object Builders (unit tests) ───

let counter = 0;
function nextId() { return `test-${++counter}-${randomUUID().slice(0, 8)}`; }

export function buildTenant(overrides: Record<string, unknown> = {}) {
    return {
        id: nextId(),
        name: `Test Tenant ${counter}`,
        slug: `test-tenant-${counter}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    };
}

export function buildUser(overrides: Record<string, unknown> = {}) {
    return {
        id: nextId(),
        name: `Test User ${counter}`,
        email: `user-${counter}@test.local`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    };
}

export function buildMembership(overrides: Record<string, unknown> = {}) {
    return {
        id: nextId(),
        tenantId: overrides.tenantId ?? nextId(),
        userId: overrides.userId ?? nextId(),
        role: overrides.role ?? 'ADMIN',
        createdAt: new Date(),
        ...overrides,
    };
}

export function buildRequestContext(overrides: Record<string, unknown> = {}) {
    const tenantId = (overrides.tenantId as string) ?? nextId();
    const userId = (overrides.userId as string) ?? nextId();
    const role = (overrides.role as string) ?? 'ADMIN';
    return {
        requestId: (overrides.requestId as string) ?? `req-${nextId()}`,
        tenantId,
        userId,
        role,
        permissions: {
            canRead: true,
            canWrite: ['ADMIN', 'EDITOR'].includes(role),
            canAdmin: role === 'ADMIN',
            canAudit: ['ADMIN', 'AUDITOR'].includes(role),
            canExport: ['ADMIN', 'EDITOR', 'AUDITOR'].includes(role),
        },
        ...overrides,
    };
}

// `buildPractice` / `buildRisk` removed in the GRC teardown — the Practice
// and Risk models no longer exist.

export function buildEvidence(overrides: Record<string, unknown> = {}) {
    return {
        id: nextId(),
        tenantId: overrides.tenantId ?? nextId(),
        title: `Test Evidence ${counter}`,
        type: overrides.type ?? 'DOCUMENT',
        status: overrides.status ?? 'DRAFT',
        isArchived: overrides.isArchived ?? false,
        retentionUntil: overrides.retentionUntil ?? null,
        expiredAt: overrides.expiredAt ?? null,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    };
}

export function buildTask(overrides: Record<string, unknown> = {}) {
    return {
        id: nextId(),
        tenantId: overrides.tenantId ?? nextId(),
        title: `Test Task ${counter}`,
        type: overrides.type ?? 'TASK',
        status: overrides.status ?? 'OPEN',
        priority: overrides.priority ?? 'MEDIUM',
        dueAt: overrides.dueAt ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    };
}

// ─── Ergonomic Compound Factories (unit tests) ───

/**
 * Build a tenant + admin user + membership in one call.
 */
export function createTenantWithAdmin(overrides: Record<string, unknown> = {}) {
    const tenant = buildTenant(overrides);
    const user = buildUser({ name: 'Admin User' });
    const membership = buildMembership({
        tenantId: tenant.id,
        userId: user.id,
        role: 'ADMIN',
    });
    const ctx = buildRequestContext({
        tenantId: tenant.id,
        userId: user.id,
        role: 'ADMIN',
    });
    return { tenant, user, membership, ctx };
}

// `createPracticeWithEvidence` / `createRiskWithScore` removed in the GRC
// teardown — Practice, Risk and `@/lib/risk-scoring` are all gone.

/**
 * Seed a minimal tenant context for integration tests.
 * Returns objects ready to use as test fixtures.
 */
export function seedMinimalTenant(role: string = 'ADMIN') {
    const { tenant, user, membership, ctx } = createTenantWithAdmin();
    const evidence = buildEvidence({ tenantId: tenant.id });
    const ctxWithRole = role === 'ADMIN' ? ctx : buildRequestContext({
        tenantId: tenant.id,
        userId: user.id,
        role,
    });
    return { tenant, user, membership, ctx: ctxWithRole, evidence };
}

// ─── DB Factories (integration tests) ───

import type { PrismaClient } from '@prisma/client';

export async function createTenant(prisma: PrismaClient, overrides: Record<string, unknown> = {}) {
    const data = buildTenant(overrides);
    return prisma.tenant.create({ data: data as any }); // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function createUser(prisma: PrismaClient, overrides: Record<string, unknown> = {}) {
    const data = buildUser(overrides);
    return prisma.user.create({ data: data as any }); // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function createMembership(
    prisma: PrismaClient,
    tenantId: string,
    userId: string,
    role: string = 'ADMIN',
) {
    return prisma.tenantMembership.create({
        data: { tenantId, userId, role } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    });
}

// `createPractice` removed in the GRC teardown — `prisma.practice` no
// longer exists.

// ─── Reset helpers ───

/**
 * Reset the counter for deterministic test IDs.
 * Call in beforeEach if needed.
 */
export function resetFactoryCounter() {
    counter = 0;
}
