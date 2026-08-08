/**
 * Test Data Factories
 *
 * Provides builder functions for creating test entities.
 * For unit tests: returns plain objects matching expected shapes.
 * For integration tests: creates records via Prisma.
 *
 * Usage:
 *   import { buildTenant, buildUser, buildControl, buildRisk } from '../helpers/factories';
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

export function buildControl(overrides: Record<string, unknown> = {}) {
    return {
        id: nextId(),
        tenantId: overrides.tenantId ?? nextId(),
        code: `A.${Math.floor(Math.random() * 99)}.${Math.floor(Math.random() * 9)}`,
        name: `Test Control ${counter}`,
        description: 'Test control description',
        status: 'NOT_IMPLEMENTED',
        applicability: 'APPLICABLE',
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        ...overrides,
    };
}

export function buildRisk(overrides: Record<string, unknown> = {}) {
    return {
        id: nextId(),
        tenantId: overrides.tenantId ?? nextId(),
        name: `Test Risk ${counter}`,
        description: 'Test risk description',
        likelihood: overrides.likelihood ?? 3,
        impact: overrides.impact ?? 3,
        riskScore: ((overrides.likelihood ?? 3) as number) * ((overrides.impact ?? 3) as number),
        category: overrides.category ?? 'OPERATIONAL',
        status: overrides.status ?? 'IDENTIFIED',
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        ...overrides,
    };
}

export function buildEvidence(overrides: Record<string, unknown> = {}) {
    return {
        id: nextId(),
        tenantId: overrides.tenantId ?? nextId(),
        title: `Test Evidence ${counter}`,
        type: overrides.type ?? 'DOCUMENT',
        status: overrides.status ?? 'DRAFT',
        controlId: overrides.controlId ?? null,
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
        controlId: overrides.controlId ?? null,
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

/**
 * Build a control with linked evidence.
 */
export function createControlWithEvidence(tenantId?: string, overrides: Record<string, unknown> = {}) {
    const tid = tenantId ?? buildTenant().id;
    const control = buildControl({ tenantId: tid, ...overrides });
    const evidence = buildEvidence({
        tenantId: tid,
        controlId: control.id,
        title: `Evidence for ${control.name}`,
    });
    return { control, evidence, tenantId: tid };
}

/**
 * Build a risk with computed score.
 */
export function createRiskWithScore(
    likelihood: number,
    impact: number,
    overrides: Record<string, unknown> = {},
) {
    const { calculateRiskScore } = require('@/lib/risk-scoring');
    const score = calculateRiskScore(likelihood, impact);
    return buildRisk({
        likelihood,
        impact,
        riskScore: score,
        ...overrides,
    });
}

/**
 * Seed a minimal tenant context for integration tests.
 * Returns objects ready to use as test fixtures.
 */
export function seedMinimalTenant(role: string = 'ADMIN') {
    const { tenant, user, membership, ctx } = createTenantWithAdmin();
    const control = buildControl({ tenantId: tenant.id, code: 'A.5.1', name: 'Access Control Policy' });
    const risk = createRiskWithScore(3, 4, { tenantId: tenant.id, name: 'Data Breach Risk' });
    const evidence = buildEvidence({ tenantId: tenant.id, controlId: control.id });
    const ctxWithRole = role === 'ADMIN' ? ctx : buildRequestContext({
        tenantId: tenant.id,
        userId: user.id,
        role,
    });
    return { tenant, user, membership, ctx: ctxWithRole, control, risk, evidence };
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

export async function createControl(prisma: PrismaClient, tenantId: string, overrides: Record<string, unknown> = {}) {
    const data = buildControl({ tenantId, ...overrides });
    return prisma.control.create({ data: data as any }); // eslint-disable-line @typescript-eslint/no-explicit-any
}

// ─── Reset helpers ───

/**
 * Reset the counter for deterministic test IDs.
 * Call in beforeEach if needed.
 */
export function resetFactoryCounter() {
    counter = 0;
}
