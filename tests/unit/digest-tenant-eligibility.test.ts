/**
 * Digest Dispatch — Tenant Notification Eligibility Tests
 *
 * Verifies that:
 * 1. Tenant with isNotificationsEnabled=false does NOT receive digests
 * 2. Tenant with isNotificationsEnabled=true still receives digests
 * 3. Mixed-tenant dispatch only sends for eligible tenants
 * 4. Suppressed items are counted and logged
 * 5. No regression in grouped digest behavior
 */

// ─── Mocks ──────────────────────────────────────────────────────────

const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
};

const mockOutboxCreate = jest.fn();
const mockUserFindMany = jest.fn().mockResolvedValue([]);
const mockMembershipFindMany = jest.fn().mockResolvedValue([]);
const mockTenantFindUnique = jest.fn().mockResolvedValue({ slug: 'acme' });
const mockSettingsFindUnique = jest.fn();

jest.mock('@/lib/observability/logger', () => ({
    logger: mockLogger,
}));

jest.mock('@/lib/prisma', () => ({
    prisma: {
        user: { findMany: (...args: unknown[]) => mockUserFindMany(...args) },
        tenantMembership: { findMany: (...args: unknown[]) => mockMembershipFindMany(...args) },
        tenant: { findUnique: (...args: unknown[]) => mockTenantFindUnique(...args) },
        notificationOutbox: { create: (...args: unknown[]) => mockOutboxCreate(...args) },
        tenantNotificationSettings: {
            findUnique: (...args: unknown[]) => mockSettingsFindUnique(...args),
        },
    },
}));

// ─── Imports ────────────────────────────────────────────────────────

import type { DueItem } from '../../src/app-layer/jobs/types';
import { dispatchDigest } from '../../src/app-layer/notifications/digest-dispatcher';

// ─── Fixtures ───────────────────────────────────────────────────────

function makeDueItem(overrides: Partial<DueItem> = {}): DueItem {
    return {
        entityType: 'TASK',
        entityId: 'task-1',
        tenantId: 'tenant-enabled',
        name: 'Spray north field',
        reason: { key: 'taskOverdue', params: { days: 5 } },
        urgency: 'OVERDUE',
        dueDate: '2026-04-12T00:00:00Z',
        daysRemaining: -5,
        ownerUserId: 'user-1',
        ...overrides,
    };
}

// ─── Setup ──────────────────────────────────────────────────────────

beforeEach(() => {
    jest.clearAllMocks();
    mockOutboxCreate.mockResolvedValue({ id: 'outbox-1' });
    mockTenantFindUnique.mockResolvedValue({ slug: 'acme' });

    // Default: notifications enabled (no settings row = enabled by default)
    mockSettingsFindUnique.mockResolvedValue(null);
});

// ═════════════════════════════════════════════════════════════════════
// 1. Tenant with notifications disabled — digest suppressed
// ═════════════════════════════════════════════════════════════════════

describe('Digest dispatch: tenant notification eligibility', () => {
    test('tenant with isNotificationsEnabled=false does NOT receive digest', async () => {
        // Settings row: disabled
        mockSettingsFindUnique.mockResolvedValue({ enabled: false });

        mockUserFindMany.mockResolvedValue([
            { id: 'user-1', email: 'alice@acme.com', name: 'Alice' },
        ]);

        const items: DueItem[] = [
            makeDueItem({ tenantId: 'tenant-disabled', ownerUserId: 'user-1' }),
        ];

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        // No email enqueued
        expect(result.enqueued).toBe(0);
        // Item was suppressed, not just skipped
        expect(result.suppressed).toBe(1);
        // Outbox never called
        expect(mockOutboxCreate).not.toHaveBeenCalled();
    });

    test('tenant with isNotificationsEnabled=true still receives digest', async () => {
        // Settings row: enabled
        mockSettingsFindUnique.mockResolvedValue({ enabled: true });

        mockUserFindMany.mockResolvedValue([
            { id: 'user-1', email: 'alice@acme.com', name: 'Alice' },
        ]);

        const items: DueItem[] = [
            makeDueItem({ tenantId: 'tenant-enabled', ownerUserId: 'user-1' }),
        ];

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        expect(result.enqueued).toBe(1);
        expect(result.suppressed).toBe(0);
        expect(mockOutboxCreate).toHaveBeenCalledTimes(1);
    });

    test('tenant with no settings row defaults to enabled', async () => {
        // No settings row = enabled by default
        mockSettingsFindUnique.mockResolvedValue(null);

        mockUserFindMany.mockResolvedValue([
            { id: 'user-1', email: 'alice@acme.com', name: 'Alice' },
        ]);

        const items: DueItem[] = [
            makeDueItem({ tenantId: 'tenant-new', ownerUserId: 'user-1' }),
        ];

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        expect(result.enqueued).toBe(1);
        expect(result.suppressed).toBe(0);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Mixed-tenant: only eligible tenants receive digests
// ═════════════════════════════════════════════════════════════════════

describe('Digest dispatch: mixed-tenant eligibility', () => {
    test('mixed tenants: only eligible tenant receives digest', async () => {
        // Tenant A: enabled, Tenant B: disabled
        mockSettingsFindUnique.mockImplementation((args: { where: { tenantId: string } }) => {
            if (args.where.tenantId === 'tenant-a') return Promise.resolve({ enabled: true });
            if (args.where.tenantId === 'tenant-b') return Promise.resolve({ enabled: false });
            return Promise.resolve(null); // default enabled
        });

        mockUserFindMany.mockResolvedValue([
            { id: 'user-a', email: 'alice@a.com', name: 'Alice' },
            { id: 'user-b', email: 'bob@b.com', name: 'Bob' },
        ]);

        const items: DueItem[] = [
            makeDueItem({ tenantId: 'tenant-a', ownerUserId: 'user-a', entityId: 'ctrl-1' }),
            makeDueItem({ tenantId: 'tenant-a', ownerUserId: 'user-a', entityId: 'ctrl-2' }),
            makeDueItem({ tenantId: 'tenant-b', ownerUserId: 'user-b', entityId: 'ctrl-3' }),
        ];

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        // Tenant A: 1 digest (2 items grouped)
        expect(result.enqueued).toBe(1);
        // Tenant B: 1 item suppressed
        expect(result.suppressed).toBe(1);

        // Only tenant A's email was enqueued
        expect(mockOutboxCreate).toHaveBeenCalledTimes(1);
        const call = mockOutboxCreate.mock.calls[0][0];
        expect(call.data.toEmail).toBe('alice@a.com');
        expect(call.data.tenantId).toBe('tenant-a');
    });

    test('per-tenant breakdown shows suppressed status', async () => {
        mockSettingsFindUnique.mockImplementation((args: { where: { tenantId: string } }) => {
            if (args.where.tenantId === 'tenant-off') return Promise.resolve({ enabled: false });
            return Promise.resolve(null);
        });

        mockUserFindMany.mockResolvedValue([
            { id: 'user-1', email: 'user@on.com', name: 'User' },
        ]);

        const items: DueItem[] = [
            makeDueItem({ tenantId: 'tenant-on', ownerUserId: 'user-1' }),
            makeDueItem({ tenantId: 'tenant-off', ownerUserId: 'user-2', entityId: 'ctrl-2' }),
        ];

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        expect(result.tenants['tenant-off']?.suppressed).toBe(true);
        expect(result.tenants['tenant-on']?.suppressed).toBeUndefined();
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. Unowned items also respect tenant eligibility
// ═════════════════════════════════════════════════════════════════════

describe('Digest dispatch: unowned items respect tenant eligibility', () => {
    test('unowned items for disabled tenant are suppressed', async () => {
        mockSettingsFindUnique.mockResolvedValue({ enabled: false });

        const items: DueItem[] = [
            makeDueItem({ tenantId: 'tenant-off', ownerUserId: undefined }),
        ];

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        expect(result.enqueued).toBe(0);
        expect(result.suppressed).toBe(1);
        // Admin resolution should not happen — skipped before that
        expect(mockMembershipFindMany).not.toHaveBeenCalled();
    });

    test('unowned items for enabled tenant still go to admins', async () => {
        mockSettingsFindUnique.mockResolvedValue({ enabled: true });

        mockMembershipFindMany.mockResolvedValue([
            { user: { id: 'admin-1', email: 'admin@acme.com', name: 'Admin' } },
        ]);

        const items: DueItem[] = [
            makeDueItem({ tenantId: 'tenant-on', ownerUserId: undefined }),
        ];

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        expect(result.enqueued).toBe(1);
        expect(result.suppressed).toBe(0);
        expect(mockOutboxCreate).toHaveBeenCalledTimes(1);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. Structured logging for suppressed digests
// ═════════════════════════════════════════════════════════════════════

describe('Digest dispatch: suppression logging', () => {
    test('logs suppression event with tenant and item count', async () => {
        mockSettingsFindUnique.mockResolvedValue({ enabled: false });

        const items: DueItem[] = [
            makeDueItem({ tenantId: 'tenant-muted', entityId: 'c1' }),
            makeDueItem({ tenantId: 'tenant-muted', entityId: 'c2' }),
        ];

        await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        const suppressionLogs = mockLogger.info.mock.calls.filter(
            c => c[0]?.includes?.('suppressed') || c[0]?.includes?.('disabled'),
        );

        expect(suppressionLogs.length).toBeGreaterThanOrEqual(1);
        const logMeta = suppressionLogs[0][1];
        expect(logMeta.tenantId).toBe('tenant-muted');
        expect(logMeta.itemCount).toBe(2);
    });

    test('final dispatch log includes suppressed count', async () => {
        mockSettingsFindUnique.mockResolvedValue({ enabled: false });

        await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items: [makeDueItem({ tenantId: 'tenant-x' })],
        });

        const completedLogs = mockLogger.info.mock.calls.filter(
            c => c[0]?.includes?.('completed'),
        );

        expect(completedLogs.length).toBeGreaterThanOrEqual(1);
        const logMeta = completedLogs[0][1];
        expect(logMeta.suppressed).toBe(1);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 5. Structural: digest-dispatcher imports isNotificationsEnabled
// ═════════════════════════════════════════════════════════════════════

describe('Structural: digest-dispatcher uses notification settings', () => {
    const { readFileSync } = require('fs');
    const { resolve } = require('path');

    test('digest-dispatcher imports isNotificationsEnabled', () => {
        const source = readFileSync(
            resolve(__dirname, '../../src/app-layer/notifications/digest-dispatcher.ts'),
            'utf8',
        );
        expect(source).toContain("import { isNotificationsEnabled } from './settings'");
    });

    test('digest-dispatcher calls isNotificationsEnabled before dispatch', () => {
        const source = readFileSync(
            resolve(__dirname, '../../src/app-layer/notifications/digest-dispatcher.ts'),
            'utf8',
        );
        expect(source).toContain('isNotificationsEnabled(prisma, tenantId)');
    });

    test('both owned and unowned loops check eligibility', () => {
        const source = readFileSync(
            resolve(__dirname, '../../src/app-layer/notifications/digest-dispatcher.ts'),
            'utf8',
        );
        const eligibleChecks = (source.match(/eligibleTenants\.has\(tenantId\)/g) || []).length;
        expect(eligibleChecks).toBeGreaterThanOrEqual(2); // owned + unowned loops
    });
});
