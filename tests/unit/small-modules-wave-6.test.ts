/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * Zero-coverage small modules, wave 6 (part 2).
 *
 * Three short modules that were never imported by a test. Each is small
 * enough to read in one screen and each holds exactly one decision that a
 * reader would plausibly "tidy" the wrong way:
 *
 *   - `require-module` records access telemetry BEFORE the availability
 *     check, on purpose, so *blocked* attempts are counted too. Moving the
 *     call after the gate — the natural tidy — silently deletes the signal
 *     that tells you which module a tenant keeps trying to reach.
 *   - `updateOwnUiLanguage` writes by `userId` alone and is account-level,
 *     not tenant-scoped. Both halves are deliberate.
 *   - the notification usecases gate on `assertCanRead` for a *write*
 *     (mark-as-read), because marking your own notification read is not a
 *     privileged action; the ownership predicate lives in the repository.
 *
 * (`src/lib/dto/pagination.ts` is interface-only — no executable statements
 * — so there is nothing to test there.)
 */

const mockRedirect = jest.fn(() => {
    // next/navigation's redirect throws to unwind the render; mirroring
    // that is what makes "does it stop here?" observable.
    throw new Error('NEXT_REDIRECT');
});
jest.mock('next/navigation', () => ({ redirect: (...a: unknown[]) => mockRedirect(...(a as [])) }));

const mockIsModuleAvailable = jest.fn();
jest.mock('@/app-layer/usecases/modules', () => ({
    isModuleAvailable: (...a: unknown[]) => mockIsModuleAvailable(...a),
}));

const mockRecordModuleAccess = jest.fn();
jest.mock('@/lib/observability/module-metrics', () => ({
    recordModuleAccess: (...a: unknown[]) => mockRecordModuleAccess(...a),
}));

const mockPrisma = { user: { update: jest.fn() } };
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: mockPrisma }));

const mockNotificationRepo = { listMine: jest.fn(), markAsRead: jest.fn() };
jest.mock('@/app-layer/repositories/NotificationRepository', () => ({
    NotificationRepository: mockNotificationRepo,
}));

const mockDb = { notification: {} } as any;
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

import { requireModule } from '@/lib/security/require-module';
import { updateOwnUiLanguage } from '@/lib/account/language';
import { listMyNotifications, markNotificationRead } from '@/app-layer/usecases/notification';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', {
    tenantSlug: 'acme',
    tenantId: 'tenant-1',
    userId: 'user-1',
});

beforeEach(() => {
    jest.clearAllMocks();
    mockRecordModuleAccess.mockResolvedValue(undefined);
    mockPrisma.user.update.mockResolvedValue({});
    mockNotificationRepo.listMine.mockResolvedValue([{ id: 'n1' }]);
    mockNotificationRepo.markAsRead.mockResolvedValue({ count: 1 });
});

// ─── requireModule ───────────────────────────────────────────────────

describe('requireModule', () => {
    it('lets an available module render', async () => {
        mockIsModuleAvailable.mockResolvedValue(true);

        await expect(requireModule(ctx, 'CERTIFICATION' as any)).resolves.toBeUndefined();

        expect(mockRedirect).not.toHaveBeenCalled();
        expect(mockIsModuleAvailable).toHaveBeenCalledWith(ctx, 'CERTIFICATION');
    });

    it('redirects to the tenant dashboard when the module is not available', async () => {
        mockIsModuleAvailable.mockResolvedValue(false);

        await expect(requireModule(ctx, 'CERTIFICATION' as any)).rejects.toThrow('NEXT_REDIRECT');

        expect(mockRedirect).toHaveBeenCalledWith('/t/acme/dashboard');
    });

    it('records telemetry BEFORE the gate, so blocked attempts are counted', async () => {
        // The ordering is the point. Recording after the check would make
        // "which module does this tenant keep bouncing off?" unanswerable —
        // exactly the question the metric exists for.
        mockIsModuleAvailable.mockResolvedValue(false);

        await expect(requireModule(ctx, 'GRAIN' as any)).rejects.toThrow('NEXT_REDIRECT');

        expect(mockRecordModuleAccess).toHaveBeenCalledWith('GRAIN');
        expect(mockRecordModuleAccess.mock.invocationCallOrder[0]).toBeLessThan(
            mockIsModuleAvailable.mock.invocationCallOrder[0],
        );
    });

    it('records access for an allowed module too', async () => {
        mockIsModuleAvailable.mockResolvedValue(true);
        await requireModule(ctx, 'GRAIN' as any);
        expect(mockRecordModuleAccess).toHaveBeenCalledTimes(1);
    });
});

// ─── updateOwnUiLanguage ─────────────────────────────────────────────

describe('updateOwnUiLanguage', () => {
    it('writes the locale against the given user and echoes it back', async () => {
        expect(await updateOwnUiLanguage('user-1', 'bg' as any)).toEqual({ uiLanguage: 'bg' });

        expect(mockPrisma.user.update).toHaveBeenCalledWith({
            where: { id: 'user-1' },
            data: { uiLanguage: 'bg' },
        });
    });

    it('is account-level — the write carries no tenant scope', async () => {
        // Deliberate: the chosen locale follows the user across every
        // tenant they belong to, so a tenantId here would be a bug.
        await updateOwnUiLanguage('user-1', 'en' as any);

        const args = mockPrisma.user.update.mock.calls[0][0];
        expect(args.where).toEqual({ id: 'user-1' });
        expect(JSON.stringify(args)).not.toMatch(/tenant/i);
    });
});

// ─── notification usecases ───────────────────────────────────────────

describe('notification usecases', () => {
    it('lists the caller’s own notifications through the tenant tx', async () => {
        expect(await listMyNotifications(ctx)).toEqual([{ id: 'n1' }]);
        expect(mockNotificationRepo.listMine).toHaveBeenCalledWith(mockDb, ctx);
    });

    it('marks one read and reports success', async () => {
        expect(await markNotificationRead(ctx, 'n1')).toEqual({ success: true });
        expect(mockNotificationRepo.markAsRead).toHaveBeenCalledWith(mockDb, ctx, 'n1');
    });

    it('gates on read, not write — marking your own notification is not privileged', async () => {
        // A READER must be able to clear their own bell. The ownership
        // predicate that makes this safe lives in the repository's
        // updateMany (tenantId + userId), not in a role check here.
        const reader = makeRequestContext('READER', {
            tenantSlug: 'acme',
            tenantId: 'tenant-1',
            userId: 'user-2',
        });

        await expect(markNotificationRead(reader, 'n1')).resolves.toEqual({ success: true });
        await expect(listMyNotifications(reader)).resolves.toBeDefined();
    });

    it('refuses a context that cannot read at all', async () => {
        const noAccess = {
            ...ctx,
            permissions: { ...ctx.permissions, canRead: false },
        } as any;

        await expect(listMyNotifications(noAccess)).rejects.toThrow();
        expect(mockNotificationRepo.listMine).not.toHaveBeenCalled();
    });
});
