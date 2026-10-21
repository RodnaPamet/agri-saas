/**
 * low-stock-monitor unit tests.
 *
 * Verifies:
 *   1. An item whose Σ on-hand is below reorderLevel fires a LOW_STOCK
 *      notification to each active OWNER/ADMIN, with a per-(item, user,
 *      day) dedupeKey.
 *   2. An item at/above its reorderLevel is skipped.
 *   3. An alert already sent today is not re-created (dedupe).
 */

export {};

const DAY = new Date('2026-06-14T09:00:00Z');

const mockItemFindMany = jest.fn();
const mockLotGroupBy = jest.fn();
const mockMembershipFindMany = jest.fn();
const mockNotifFindMany = jest.fn();
const mockNotifCreateMany = jest.fn();
const mockPublish = jest.fn();

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(), child: jest.fn().mockReturnThis() };

beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    const client = {
        item: { findMany: (...a: unknown[]) => mockItemFindMany(...a) },
        inventoryLot: { groupBy: (...a: unknown[]) => mockLotGroupBy(...a) },
        tenantMembership: { findMany: (...a: unknown[]) => mockMembershipFindMany(...a) },
        notification: {
            // #2142 read-back. Two DIFFERENT queries now hit
            // `notification.findMany` on this path, and they are told apart by
            // their `select`: the pre-insert existence check asks only for
            // `dedupeKey`, while the id read-back asks for `id` too. Without
            // the branch, a test configuring the existence check to return
            // `[]` also made the read-back resolve nothing, so the publish was
            // skipped and the assertion read zero calls.
            findMany: async (args: any) => {
                if (args?.select?.id) {
                    return (args.where.dedupeKey.in as string[]).map((dedupeKey, i) => ({
                        id: `notif-${i + 1}`,
                        dedupeKey,
                    }));
                }
                return mockNotifFindMany(args);
            },
            createMany: (...a: unknown[]) => mockNotifCreateMany(...a),
        },
    };
    jest.mock('@/lib/prisma', () => ({ __esModule: true, default: client, prisma: client }));
    jest.mock('@/lib/notifications/notification-bus', () => ({
        publishNotificationEvent: (...a: unknown[]) => mockPublish(...a),
    }));
    jest.mock('@/lib/observability/job-runner', () => ({
        runJob: jest.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
    }));
    jest.mock('@/lib/observability/logger', () => ({ logger: mockLogger }));

    // Defaults: one tenant, one OWNER recipient, nothing sent yet.
    mockMembershipFindMany.mockResolvedValue([{ tenantId: 't1', userId: 'u1', tenant: { slug: 'acme' } }]);
    mockNotifFindMany.mockResolvedValue([]);
    mockNotifCreateMany.mockResolvedValue({ count: 1 });
});

async function run(opts: Record<string, unknown> = {}) {
    const { runLowStockMonitor } = await import('@/app-layer/jobs/low-stock-monitor');
    return runLowStockMonitor({ now: DAY, ...opts });
}

describe('runLowStockMonitor', () => {
    test('fires LOW_STOCK when Σ on-hand is below reorderLevel', async () => {
        mockItemFindMany.mockResolvedValue([{ id: 'i1', tenantId: 't1', name: 'Seed', reorderLevel: 100 }]);
        mockLotGroupBy.mockResolvedValue([{ itemId: 'i1', _sum: { quantityOnHand: 30 } }]);

        const { result, lowItems, notified } = await run();

        expect(lowItems).toHaveLength(1);
        expect(notified).toBe(1);
        expect(mockNotifCreateMany).toHaveBeenCalledTimes(1);
        const rows = mockNotifCreateMany.mock.calls[0][0].data;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            tenantId: 't1',
            userId: 'u1',
            type: 'LOW_STOCK',
            dedupeKey: 'low-stock:t1:i1:u1:2026-06-14',
        });
        expect(mockPublish).toHaveBeenCalledTimes(1);
        expect(result.itemsActioned).toBe(1);
    });

    test('skips an item at or above its reorderLevel', async () => {
        mockItemFindMany.mockResolvedValue([{ id: 'i1', tenantId: 't1', name: 'Seed', reorderLevel: 100 }]);
        mockLotGroupBy.mockResolvedValue([{ itemId: 'i1', _sum: { quantityOnHand: 200 } }]);

        const { lowItems, notified } = await run();

        expect(lowItems).toHaveLength(0);
        expect(notified).toBe(0);
        expect(mockNotifCreateMany).not.toHaveBeenCalled();
    });

    test('does not re-create an alert already sent today (dedupe)', async () => {
        mockItemFindMany.mockResolvedValue([{ id: 'i1', tenantId: 't1', name: 'Seed', reorderLevel: 100 }]);
        mockLotGroupBy.mockResolvedValue([{ itemId: 'i1', _sum: { quantityOnHand: 30 } }]);
        mockNotifFindMany.mockResolvedValue([{ dedupeKey: 'low-stock:t1:i1:u1:2026-06-14' }]);

        const { notified } = await run();

        expect(notified).toBe(0);
        expect(mockNotifCreateMany).not.toHaveBeenCalled();
        expect(mockPublish).not.toHaveBeenCalled();
    });
});
