/**
 * Factory Unit Tests
 *
 * Validates that test data factories produce correct, usable objects.
 * Ensures factories are type-correct and all fields present.
 */
import {
    buildTenant, buildUser, buildMembership, buildRequestContext,
    buildPractice, buildRisk, buildEvidence, buildTask,
    resetFactoryCounter,
} from '../helpers/factories';

beforeEach(() => resetFactoryCounter());

describe('Test Factories', () => {
    test('buildTenant returns valid tenant object', () => {
        const t = buildTenant();
        expect(t.id).toBeDefined();
        expect(t.name).toContain('Test Tenant');
        expect(t.slug).toContain('test-tenant');
        expect(t.createdAt).toBeInstanceOf(Date);
    });

    test('buildTenant accepts overrides', () => {
        const t = buildTenant({ name: 'Custom Corp', slug: 'custom-corp' });
        expect(t.name).toBe('Custom Corp');
        expect(t.slug).toBe('custom-corp');
    });

    test('buildUser returns valid user object', () => {
        const u = buildUser();
        expect(u.id).toBeDefined();
        expect(u.email).toMatch(/@test\.local$/);
        expect(u.name).toContain('Test User');
    });

    test('buildMembership defaults to ADMIN role', () => {
        const m = buildMembership({ tenantId: 'tid', userId: 'uid' });
        expect(m.role).toBe('ADMIN');
        expect(m.tenantId).toBe('tid');
        expect(m.userId).toBe('uid');
    });

    test('buildRequestContext creates valid permissions for ADMIN', () => {
        const ctx = buildRequestContext({ role: 'ADMIN' });
        expect(ctx.permissions.canRead).toBe(true);
        expect(ctx.permissions.canWrite).toBe(true);
        expect(ctx.permissions.canAdmin).toBe(true);
    });

    test('buildRequestContext creates restricted permissions for READER', () => {
        const ctx = buildRequestContext({ role: 'READER' });
        expect(ctx.permissions.canRead).toBe(true);
        expect(ctx.permissions.canWrite).toBe(false);
        expect(ctx.permissions.canAdmin).toBe(false);
    });

    test('buildRequestContext creates correct permissions for AUDITOR', () => {
        const ctx = buildRequestContext({ role: 'AUDITOR' });
        expect(ctx.permissions.canRead).toBe(true);
        expect(ctx.permissions.canWrite).toBe(false);
        expect(ctx.permissions.canAdmin).toBe(false);
        expect(ctx.permissions.canAudit).toBe(true);
    });

    test('buildPractice returns APPLICABLE, NOT_IMPLEMENTED by default', () => {
        const c = buildPractice({ tenantId: 'tid' });
        expect(c.tenantId).toBe('tid');
        expect(c.applicability).toBe('APPLICABLE');
        expect(c.status).toBe('NOT_IMPLEMENTED');
        expect(c.code).toMatch(/^A\.\d+\.\d+$/);
        expect(c.deletedAt).toBeNull();
    });

    test('buildRisk computes correct riskScore', () => {
        const r = buildRisk({ likelihood: 4, impact: 5 });
        expect(r.riskScore).toBe(20);
        expect(r.likelihood).toBe(4);
        expect(r.impact).toBe(5);
    });

    test('buildRisk default score is 3*3=9', () => {
        const r = buildRisk();
        expect(r.riskScore).toBe(9);
    });

    test('buildEvidence defaults to non-archived, no retention', () => {
        const e = buildEvidence();
        expect(e.isArchived).toBe(false);
        expect(e.retentionUntil).toBeNull();
        expect(e.expiredAt).toBeNull();
        expect(e.deletedAt).toBeNull();
    });

    test('buildEvidence can be created as archived', () => {
        const e = buildEvidence({ isArchived: true, expiredAt: new Date() });
        expect(e.isArchived).toBe(true);
        expect(e.expiredAt).toBeInstanceOf(Date);
    });

    test('buildTask defaults to OPEN/MEDIUM', () => {
        const t = buildTask();
        expect(t.status).toBe('OPEN');
        expect(t.priority).toBe('MEDIUM');
        expect(t.type).toBe('TASK');
    });

    test('each call produces unique IDs', () => {
        const ids = new Set(Array.from({ length: 20 }, () => buildTenant().id));
        expect(ids.size).toBe(20);
    });

    test('resetFactoryCounter resets the counter', () => {
        buildTenant(); buildTenant(); buildTenant();
        resetFactoryCounter();
        const t = buildTenant();
        expect(t.name).toContain('Test Tenant 1');
    });
});
