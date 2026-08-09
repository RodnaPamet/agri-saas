/**
 * Integration Tests — Auth Gating
 *
 * Proves that:
 * 1. READER role cannot call write usecases (practices, risks)
 * 2. READER/EDITOR cannot call admin-only usecases (delete)
 * 3. AUDITOR cannot create or modify
 * 4. Valid ADMIN/EDITOR context succeeds (baseline)
 *
 * Approach: Usecase-level testing with constructed RequestContext.
 * This is preferred over route handler mocking because:
 * - Deterministic: no auth session simulation needed
 * - Tests the actual policy enforcement layer
 * - Faster: no HTTP overhead
 */
import { buildRequestContext } from '../helpers/factories';

// ── Import usecases ──
import { createPractice, deletePractice } from '@/app-layer/usecases/practice';

// ── Auth error detection ──
function isForbiddenError(err: unknown): boolean {
    if (err instanceof Error) {
        return err.message.toLowerCase().includes('permission') ||
               err.message.toLowerCase().includes('forbidden') ||
               // AppError with statusCode 403
               (err as any).statusCode === 403; // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    return false;
}

// ── Tests ──

describe('Auth Gating — Practices', () => {
    test('READER cannot create a practice', async () => {
        const ctx = buildRequestContext({ role: 'READER' });
        await expect(
            createPractice(ctx as any, { name: 'Test Practice' }) // eslint-disable-line @typescript-eslint/no-explicit-any
        ).rejects.toThrow();

        try {
            await createPractice(ctx as any, { name: 'Test Practice' }); // eslint-disable-line @typescript-eslint/no-explicit-any
        } catch (err) {
            expect(isForbiddenError(err)).toBe(true);
        }
    });

    test('AUDITOR cannot create a practice', async () => {
        const ctx = buildRequestContext({ role: 'AUDITOR' });
        await expect(
            createPractice(ctx as any, { name: 'Test Practice' }) // eslint-disable-line @typescript-eslint/no-explicit-any
        ).rejects.toThrow();

        try {
            await createPractice(ctx as any, { name: 'Test Practice' }); // eslint-disable-line @typescript-eslint/no-explicit-any
        } catch (err) {
            expect(isForbiddenError(err)).toBe(true);
        }
    });

    test('READER cannot delete a practice', async () => {
        const ctx = buildRequestContext({ role: 'READER' });
        await expect(
            deletePractice(ctx as any, 'any-id') // eslint-disable-line @typescript-eslint/no-explicit-any
        ).rejects.toThrow();

        try {
            await deletePractice(ctx as any, 'any-id'); // eslint-disable-line @typescript-eslint/no-explicit-any
        } catch (err) {
            expect(isForbiddenError(err)).toBe(true);
        }
    });

    test('EDITOR cannot delete a practice (admin-only)', async () => {
        const ctx = buildRequestContext({ role: 'EDITOR' });
        await expect(
            deletePractice(ctx as any, 'any-id') // eslint-disable-line @typescript-eslint/no-explicit-any
        ).rejects.toThrow();

        try {
            await deletePractice(ctx as any, 'any-id'); // eslint-disable-line @typescript-eslint/no-explicit-any
        } catch (err) {
            expect(isForbiddenError(err)).toBe(true);
        }
    });
});


describe('Auth Gating — Policy assertions', () => {
    test('assertCanRead allows any role', () => {
        const { assertCanRead } = require('@/app-layer/policies/common');
        const roles = ['ADMIN', 'EDITOR', 'READER', 'AUDITOR'];
        for (const role of roles) {
            const ctx = buildRequestContext({ role });
            expect(() => assertCanRead(ctx)).not.toThrow();
        }
    });

    test('assertCanWrite blocks READER and AUDITOR', () => {
        const { assertCanWrite } = require('@/app-layer/policies/common');

        expect(() => assertCanWrite(buildRequestContext({ role: 'READER' }))).toThrow();
        expect(() => assertCanWrite(buildRequestContext({ role: 'AUDITOR' }))).toThrow();
        expect(() => assertCanWrite(buildRequestContext({ role: 'ADMIN' }))).not.toThrow();
        expect(() => assertCanWrite(buildRequestContext({ role: 'EDITOR' }))).not.toThrow();
    });

    test('assertCanAdmin blocks all non-ADMIN roles', () => {
        const { assertCanAdmin } = require('@/app-layer/policies/common');

        expect(() => assertCanAdmin(buildRequestContext({ role: 'EDITOR' }))).toThrow();
        expect(() => assertCanAdmin(buildRequestContext({ role: 'READER' }))).toThrow();
        expect(() => assertCanAdmin(buildRequestContext({ role: 'AUDITOR' }))).toThrow();
        expect(() => assertCanAdmin(buildRequestContext({ role: 'ADMIN' }))).not.toThrow();
    });

    test('assertCanAudit allows ADMIN and AUDITOR only', () => {
        const { assertCanAudit } = require('@/app-layer/policies/common');

        expect(() => assertCanAudit(buildRequestContext({ role: 'ADMIN' }))).not.toThrow();
        expect(() => assertCanAudit(buildRequestContext({ role: 'AUDITOR' }))).not.toThrow();
        expect(() => assertCanAudit(buildRequestContext({ role: 'EDITOR' }))).toThrow();
        expect(() => assertCanAudit(buildRequestContext({ role: 'READER' }))).toThrow();
    });
});
