/**
 * Notification Dispatch — Unit Tests
 *
 * Tests the digest notification pipeline:
 *   1. Digest templates — content rendering, urgency markers
 *   2. Digest dispatcher — grouping, deduplication, tenant isolation
 *   3. Notification dispatch job — end-to-end pipeline
 *   4. Executor registry — new registrations
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

jest.mock('@/lib/observability/logger', () => ({
    logger: mockLogger,
}));

jest.mock('@/lib/observability/job-runner', () => ({
    runJob: jest.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
}));

// Mock prisma for dispatcher tests
const mockOutboxCreate = jest.fn();
const mockUserFindMany = jest.fn().mockResolvedValue([]);
const mockMembershipFindMany = jest.fn().mockResolvedValue([]);
const mockTenantFindUnique = jest.fn().mockResolvedValue({ slug: 'acme' });

jest.mock('@/lib/prisma', () => ({
    prisma: {
        user: { findMany: (...args: unknown[]) => mockUserFindMany(...args) },
        tenantMembership: { findMany: (...args: unknown[]) => mockMembershipFindMany(...args) },
        tenant: { findUnique: (...args: unknown[]) => mockTenantFindUnique(...args) },
        notificationOutbox: { create: (...args: unknown[]) => mockOutboxCreate(...args) },
        tenantNotificationSettings: { findUnique: jest.fn().mockResolvedValue(null) },
        practice: { findMany: jest.fn().mockResolvedValue([]) },
        policy: { findMany: jest.fn().mockResolvedValue([]) },
        task: { findMany: jest.fn().mockResolvedValue([]) },
        risk: { findMany: jest.fn().mockResolvedValue([]) },
        practiceTestPlan: { findMany: jest.fn().mockResolvedValue([]) },
        evidence: { findMany: jest.fn().mockResolvedValue([]) },
    },
}));

// ─── Imports ────────────────────────────────────────────────────────

import type { DueItem } from '../../src/app-layer/jobs/types';
import {
    buildDeadlineDigestEmail,
    buildEvidenceExpiryDigestEmail,
    buildVendorRenewalDigestEmail,
} from '../../src/app-layer/notifications/digest-templates';
import {
    dispatchDigest,
    buildDigestDedupeKey,
} from '../../src/app-layer/notifications/digest-dispatcher';

// ─── Test Fixtures ──────────────────────────────────────────────────

function makeDueItem(overrides: Partial<DueItem> = {}): DueItem {
    return {
        entityType: 'PRACTICE',
        entityId: 'ctrl-1',
        tenantId: 'tenant-1',
        name: 'Firewall Review',
        reason: 'Practice testing overdue by 5 day(s)',
        urgency: 'OVERDUE',
        dueDate: '2026-04-12T00:00:00Z',
        daysRemaining: -5,
        ownerUserId: 'user-1',
        ...overrides,
    };
}

// ═════════════════════════════════════════════════════════════════════
// 1. Digest Template Tests
// ═════════════════════════════════════════════════════════════════════

describe('Digest Templates', () => {
    describe('buildDeadlineDigestEmail', () => {
        test('renders subject with item count', () => {
            const result = buildDeadlineDigestEmail({
                recipientName: 'Alice',
                tenantSlug: 'acme',
                items: [makeDueItem(), makeDueItem({ entityId: 'ctrl-2', name: 'Access Control' })],
            });

            expect(result.subject).toContain('2 item(s)');
            expect(result.subject).toContain('Compliance Deadline Digest');
        });

        test('includes urgency marker when overdue items exist', () => {
            const result = buildDeadlineDigestEmail({
                recipientName: 'Alice',
                tenantSlug: 'acme',
                items: [makeDueItem({ urgency: 'OVERDUE' })],
            });

            expect(result.subject).toContain('🔴');
        });

        test('no urgency marker when only upcoming items', () => {
            const result = buildDeadlineDigestEmail({
                recipientName: 'Alice',
                tenantSlug: 'acme',
                items: [makeDueItem({ urgency: 'UPCOMING', reason: 'due in 20 days' })],
            });

            expect(result.subject).not.toContain('🔴');
        });

        test('bodyText contains recipient name', () => {
            const result = buildDeadlineDigestEmail({
                recipientName: 'Bob',
                tenantSlug: 'acme',
                items: [makeDueItem()],
            });

            expect(result.bodyText).toContain('Hi Bob');
        });

        test('bodyHtml contains tenant-scoped links', () => {
            const result = buildDeadlineDigestEmail({
                recipientName: 'Alice',
                tenantSlug: 'acme-corp',
                items: [makeDueItem()],
            });

            expect(result.bodyHtml).toContain('/t/acme-corp/');
        });

        test('bodyHtml escapes HTML in item names', () => {
            const result = buildDeadlineDigestEmail({
                recipientName: 'Alice',
                tenantSlug: 'acme',
                items: [makeDueItem({ name: '<script>alert("xss")</script>' })],
            });

            expect(result.bodyHtml).not.toContain('<script>');
            expect(result.bodyHtml).toContain('&lt;script&gt;');
        });
    });

    describe('buildEvidenceExpiryDigestEmail', () => {
        test('renders subject with item count', () => {
            const result = buildEvidenceExpiryDigestEmail({
                recipientName: 'Alice',
                tenantSlug: 'acme',
                items: [makeDueItem({ entityType: 'EVIDENCE' })],
            });

            expect(result.subject).toContain('1 item(s)');
            expect(result.subject).toContain('Evidence Expiry');
        });

        test('includes warning for expired items', () => {
            const result = buildEvidenceExpiryDigestEmail({
                recipientName: 'Alice',
                tenantSlug: 'acme',
                items: [makeDueItem({ entityType: 'EVIDENCE', urgency: 'OVERDUE' })],
            });

            expect(result.subject).toContain('⚠️');
        });
    });

    describe('buildVendorRenewalDigestEmail', () => {
        test('renders subject with vendor count', () => {
            const result = buildVendorRenewalDigestEmail({
                recipientName: 'Alice',
                tenantSlug: 'acme',
                items: [
                    makeDueItem({ entityType: 'VENDOR', name: 'CloudCorp' }),
                    makeDueItem({ entityType: 'VENDOR', name: 'SecureInc', entityId: 'v-2' }),
                ],
            });

            expect(result.subject).toContain('2 vendor(s)');
        });
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Dedupe Key Tests
// ═════════════════════════════════════════════════════════════════════

describe('buildDigestDedupeKey', () => {
    test('includes tenant, category, email, and date', () => {
        const key = buildDigestDedupeKey(
            'tenant-1',
            'DEADLINE_DIGEST',
            'alice@example.com',
            new Date('2026-04-17T08:00:00Z'),
        );

        expect(key).toBe('tenant-1:DEADLINE_DIGEST:alice@example.com:digest:2026-04-17');
    });

    test('same inputs produce same key (idempotent)', () => {
        const date = new Date('2026-04-17T08:00:00Z');
        const key1 = buildDigestDedupeKey('t', 'DEADLINE_DIGEST', 'a@b.com', date);
        const key2 = buildDigestDedupeKey('t', 'DEADLINE_DIGEST', 'a@b.com', date);
        expect(key1).toBe(key2);
    });

    test('different dates produce different keys', () => {
        const key1 = buildDigestDedupeKey('t', 'DEADLINE_DIGEST', 'a@b.com', new Date('2026-04-17T00:00:00Z'));
        const key2 = buildDigestDedupeKey('t', 'DEADLINE_DIGEST', 'a@b.com', new Date('2026-04-18T00:00:00Z'));
        expect(key1).not.toBe(key2);
    });

    test('different categories produce different keys', () => {
        const date = new Date('2026-04-17T00:00:00Z');
        const key1 = buildDigestDedupeKey('t', 'DEADLINE_DIGEST', 'a@b.com', date);
        const key2 = buildDigestDedupeKey('t', 'EVIDENCE_EXPIRY_DIGEST', 'a@b.com', date);
        expect(key1).not.toBe(key2);
    });

    test('different tenants produce different keys', () => {
        const date = new Date('2026-04-17T00:00:00Z');
        const key1 = buildDigestDedupeKey('tenant-1', 'DEADLINE_DIGEST', 'a@b.com', date);
        const key2 = buildDigestDedupeKey('tenant-2', 'DEADLINE_DIGEST', 'a@b.com', date);
        expect(key1).not.toBe(key2);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. Digest Dispatcher Tests
// ═════════════════════════════════════════════════════════════════════

describe('Digest Dispatcher', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockOutboxCreate.mockResolvedValue({ id: 'outbox-1' });
        mockUserFindMany.mockResolvedValue([]);
        mockMembershipFindMany.mockResolvedValue([]);
        mockTenantFindUnique.mockResolvedValue({ slug: 'acme' });
    });

    test('returns empty result when no items', async () => {
        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items: [],
        });

        expect(result.enqueued).toBe(0);
        expect(result.skipped).toBe(0);
        expect(result.totalItems).toBe(0);
    });

    test('groups multiple items for same owner into one digest', async () => {
        // Two items, same owner
        const items: DueItem[] = [
            makeDueItem({ entityId: 'ctrl-1', ownerUserId: 'user-1' }),
            makeDueItem({ entityId: 'ctrl-2', ownerUserId: 'user-1', name: 'Access Control' }),
        ];

        mockUserFindMany.mockResolvedValue([
            { id: 'user-1', email: 'alice@acme.com', name: 'Alice' },
        ]);

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        // Should produce ONE email, not two
        expect(result.enqueued).toBe(1);
        expect(mockOutboxCreate).toHaveBeenCalledTimes(1);

        // The email should be to Alice
        const createCall = mockOutboxCreate.mock.calls[0][0];
        expect(createCall.data.toEmail).toBe('alice@acme.com');
        expect(createCall.data.type).toBe('DEADLINE_DIGEST');
    });

    test('creates separate digests for different owners', async () => {
        const items: DueItem[] = [
            makeDueItem({ entityId: 'ctrl-1', ownerUserId: 'user-1' }),
            makeDueItem({ entityId: 'ctrl-2', ownerUserId: 'user-2' }),
        ];

        mockUserFindMany.mockResolvedValue([
            { id: 'user-1', email: 'alice@acme.com', name: 'Alice' },
            { id: 'user-2', email: 'bob@acme.com', name: 'Bob' },
        ]);

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        expect(result.enqueued).toBe(2);
        expect(mockOutboxCreate).toHaveBeenCalledTimes(2);
    });

    test('routes unowned items to tenant admins', async () => {
        const items: DueItem[] = [
            makeDueItem({ ownerUserId: undefined }), // no owner
        ];

        mockMembershipFindMany.mockResolvedValue([
            { user: { id: 'admin-1', email: 'admin@acme.com', name: 'Admin' } },
        ]);

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        expect(result.enqueued).toBe(1);
        const createCall = mockOutboxCreate.mock.calls[0][0];
        expect(createCall.data.toEmail).toBe('admin@acme.com');
    });

    test('tracks unroutable items when no admin exists', async () => {
        const items: DueItem[] = [
            makeDueItem({ ownerUserId: undefined }),
        ];

        mockMembershipFindMany.mockResolvedValue([]); // no admins

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        expect(result.enqueued).toBe(0);
        expect(result.unroutable).toBe(1);
    });

    test('deduplication: skips silently on P2002 unique constraint error', async () => {
        const items: DueItem[] = [
            makeDueItem({ ownerUserId: 'user-1' }),
        ];

        mockUserFindMany.mockResolvedValue([
            { id: 'user-1', email: 'alice@acme.com', name: 'Alice' },
        ]);

        // First call succeeds, simulating previous enqueue
        mockOutboxCreate.mockRejectedValue({ code: 'P2002', message: 'Unique constraint' });

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        // Should be skipped, not throw
        expect(result.skipped).toBe(1);
        expect(result.enqueued).toBe(0);
    });

    test('tenant isolation: items from different tenants stay separate', async () => {
        const items: DueItem[] = [
            makeDueItem({ tenantId: 'tenant-1', ownerUserId: 'user-1' }),
            makeDueItem({ tenantId: 'tenant-2', ownerUserId: 'user-2', entityId: 'ctrl-2' }),
        ];

        mockUserFindMany.mockResolvedValue([
            { id: 'user-1', email: 'alice@acme.com', name: 'Alice' },
            { id: 'user-2', email: 'bob@beta.com', name: 'Bob' },
        ]);

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        expect(result.enqueued).toBe(2);

        // Each email should have the correct tenantId
        const call1 = mockOutboxCreate.mock.calls[0][0];
        const call2 = mockOutboxCreate.mock.calls[1][0];
        const tenantIds = [call1.data.tenantId, call2.data.tenantId].sort();
        expect(tenantIds).toEqual(['tenant-1', 'tenant-2']);
    });

    test('selects correct template by category', async () => {
        const items: DueItem[] = [
            makeDueItem({ entityType: 'VENDOR', ownerUserId: 'user-1' }),
        ];

        mockUserFindMany.mockResolvedValue([
            { id: 'user-1', email: 'alice@acme.com', name: 'Alice' },
        ]);

        await dispatchDigest({
            category: 'VENDOR_RENEWAL_DIGEST',
            items,
        });

        const createCall = mockOutboxCreate.mock.calls[0][0];
        expect(createCall.data.type).toBe('VENDOR_RENEWAL_DIGEST');
        expect(createCall.data.subject).toContain('Vendor Renewal');
    });

    test('per-tenant breakdown is tracked', async () => {
        const items: DueItem[] = [
            makeDueItem({ tenantId: 'tenant-1', ownerUserId: 'user-1' }),
            makeDueItem({ tenantId: 'tenant-1', ownerUserId: 'user-1', entityId: 'ctrl-2' }),
            makeDueItem({ tenantId: 'tenant-2', ownerUserId: 'user-2', entityId: 'ctrl-3' }),
        ];

        mockUserFindMany.mockResolvedValue([
            { id: 'user-1', email: 'alice@acme.com', name: 'Alice' },
            { id: 'user-2', email: 'bob@beta.com', name: 'Bob' },
        ]);

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        expect(result.tenants['tenant-1']?.enqueued).toBe(1);
        expect(result.tenants['tenant-2']?.enqueued).toBe(1);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. Executor Registry — New Registrations
// ═════════════════════════════════════════════════════════════════════

describe('Notification dispatch executor registration', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.mock('@/lib/observability/logger', () => ({ logger: mockLogger }));
        jest.mock('@/lib/observability/job-runner', () => ({
            runJob: jest.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
        }));
    });

    test('notification-dispatch is registered in executor registry', async () => {
        const { executorRegistry } = await import('../../src/app-layer/jobs/executor-registry');
        expect(executorRegistry.has('notification-dispatch')).toBe(true);
    });

    test('all scheduled jobs have registered executors', async () => {
        const { executorRegistry } = await import('../../src/app-layer/jobs/executor-registry');
        const { SCHEDULED_JOBS } = await import('../../src/app-layer/jobs/schedules');

        for (const schedule of SCHEDULED_JOBS) {
            expect(executorRegistry.has(schedule.name)).toBe(true);
        }
    });
});
