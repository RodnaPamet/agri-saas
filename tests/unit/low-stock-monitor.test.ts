/**
 * low-stock-monitor unit tests — the EPISODE contract and the recipient's
 * language (#2511).
 *
 * This job wrote one notification per (item, recipient, DAY), so an item left
 * below its minimum alerted every morning for as long as it stayed there.
 * Measured in production 2026-10-30: 9,438 LOW_STOCK rows against 44 of every
 * other kind combined. The phone reads the newest 50 notifications, so a
 * farmer's «Известия» screen was nothing but low stock — in English, because
 * the title and body were hardcoded here.
 *
 * Owner ruling 2026-10-31: once per item, until it is restocked and drops
 * again. `Item.lowStockNotifiedAt` is that episode marker.
 *
 * Four properties are asserted because each has a silent failure mode:
 *
 *   - **An announced episode says nothing further.** The flood.
 *   - **A recovered item is RE-ARMED.** The opposite failure, and the worse
 *     one: a marker never cleared means the next genuine shortage is silent.
 *   - **The row and the marker commit together.** Split, a crash between them
 *     either re-alerts tomorrow (the flood again) or marks without alerting
 *     (silent until recovery).
 *   - **Copy is the RECIPIENT's language**, per recipient in one run.
 *
 * `translateFor` is NOT mocked. It is the subject: a double would return
 * whatever the test wanted and could not report that the catalogue key is
 * missing, which is the failure this change exists to fix.
 */

export {};

const DAY = new Date('2026-06-14T09:00:00Z');
const LATER = new Date('2026-08-02T09:00:00Z');

const mockItemFindMany = jest.fn();
const mockItemUpdateMany = jest.fn();
const mockLotGroupBy = jest.fn();
const mockMembershipFindMany = jest.fn();
const mockNotifCreateMany = jest.fn();
const mockPublish = jest.fn();
const mockTransaction = jest.fn();

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(), child: jest.fn().mockReturnThis() };

beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    const client = {
        item: {
            findMany: (...a: unknown[]) => mockItemFindMany(...a),
            updateMany: (...a: unknown[]) => mockItemUpdateMany(...a),
        },
        inventoryLot: { groupBy: (...a: unknown[]) => mockLotGroupBy(...a) },
        tenantMembership: { findMany: (...a: unknown[]) => mockMembershipFindMany(...a) },
        notification: {
            // The #2142 id read-back, which `publishFreshNotifications` does.
            findMany: async (args: { where: { dedupeKey: { in: string[] } } }) =>
                args.where.dedupeKey.in.map((dedupeKey, i) => ({ id: `notif-${i + 1}`, dedupeKey })),
            createMany: (...a: unknown[]) => mockNotifCreateMany(...a),
        },
        // Prisma's array form resolves the operations it was handed. The job
        // builds them eagerly, so the two mocks above are called as the array
        // is constructed — which is also how the real client behaves.
        $transaction: (ops: unknown[]) => {
            mockTransaction(ops);
            return Promise.all(ops as Promise<unknown>[]);
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

    // One tenant, one Bulgarian OWNER — the production majority (7 of 8 users).
    mockMembershipFindMany.mockResolvedValue([
        { tenantId: 't1', userId: 'u1', tenant: { slug: 'acme' }, user: { uiLanguage: 'bg' } },
    ]);
    mockNotifCreateMany.mockResolvedValue({ count: 1 });
    mockItemUpdateMany.mockResolvedValue({ count: 1 });
});

async function run(now: Date = DAY, opts: Record<string, unknown> = {}) {
    const { runLowStockMonitor } = await import('@/app-layer/jobs/low-stock-monitor');
    return runLowStockMonitor({ now, ...opts });
}

/** An item below its level, with `lowStockNotifiedAt` as given. */
function item(onHand: number, announcedAt: Date | null = null) {
    mockItemFindMany.mockResolvedValue([
        { id: 'i1', tenantId: 't1', name: 'Семена', reorderLevel: 100, lowStockNotifiedAt: announcedAt },
    ]);
    mockLotGroupBy.mockResolvedValue([{ itemId: 'i1', _sum: { quantityOnHand: onHand } }]);
}

describe('runLowStockMonitor — the episode', () => {
    test('alerts on a NEW episode and stamps the marker in the same transaction', async () => {
        item(30, null);

        const { lowItems, notified, result } = await run();

        expect(lowItems).toHaveLength(1);
        expect(notified).toBe(1);
        expect(result.itemsActioned).toBe(1);

        // One transaction carrying BOTH operations — not two round trips.
        expect(mockTransaction).toHaveBeenCalledTimes(1);
        expect(mockTransaction.mock.calls[0][0]).toHaveLength(2);
        expect(mockNotifCreateMany).toHaveBeenCalledTimes(1);

        // The marker is stamped with the episode instant.
        const stamp = mockItemUpdateMany.mock.calls.find(
            (c) => c[0]?.data?.lowStockNotifiedAt instanceof Date,
        );
        expect(stamp).toBeDefined();
        expect(stamp![0].data.lowStockNotifiedAt).toEqual(DAY);
        expect(stamp![0].where.id.in).toEqual(['i1']);

        expect(mockPublish).toHaveBeenCalledTimes(1);
    });

    test('says NOTHING further while the episode is already announced', async () => {
        // Still below the level, marker already set — the flood case.
        item(30, DAY);

        const { lowItems, notified } = await run(LATER);

        // It is still a low item, and reported as one…
        expect(lowItems).toHaveLength(1);
        // …but nothing is written and nobody is told again.
        expect(notified).toBe(0);
        expect(mockNotifCreateMany).not.toHaveBeenCalled();
        expect(mockPublish).not.toHaveBeenCalled();
        expect(mockTransaction).not.toHaveBeenCalled();
    });

    test('RE-ARMS a recovered item by clearing the marker', async () => {
        // Back above the level with a marker set from the previous episode.
        item(200, DAY);

        const { lowItems, notified } = await run(LATER);

        expect(lowItems).toHaveLength(0);
        expect(notified).toBe(0);
        expect(mockNotifCreateMany).not.toHaveBeenCalled();

        // The clear is what makes the NEXT shortage audible. Without it a
        // marker outlives its episode and the item is silent for ever.
        expect(mockItemUpdateMany).toHaveBeenCalledWith({
            where: { id: { in: ['i1'] } },
            data: { lowStockNotifiedAt: null },
        });
    });

    test('does not clear a marker that is already null', async () => {
        // A healthy item with no marker needs no write at all — otherwise the
        // sweep issues an UPDATE across every item on the platform every run.
        item(200, null);

        await run();

        expect(mockItemUpdateMany).not.toHaveBeenCalled();
    });

    test('a later episode gets a DIFFERENT dedupeKey, because the column is @unique', async () => {
        item(30, null);
        await run(DAY);
        const first = mockNotifCreateMany.mock.calls[0][0].data[0].dedupeKey;

        jest.clearAllMocks();
        mockMembershipFindMany.mockResolvedValue([
            { tenantId: 't1', userId: 'u1', tenant: { slug: 'acme' }, user: { uiLanguage: 'bg' } },
        ]);
        mockNotifCreateMany.mockResolvedValue({ count: 1 });
        mockItemUpdateMany.mockResolvedValue({ count: 1 });
        item(30, null);
        await run(LATER);
        const second = mockNotifCreateMany.mock.calls[0][0].data[0].dedupeKey;

        // `Notification.dedupeKey` is @unique, so a key stable across episodes
        // would make the second drop a duplicate of the first and drop it
        // silently — for ever, since the key never changes again.
        expect(first).not.toBe(second);
        expect(first).toContain('2026-06-14');
        expect(second).toContain('2026-08-02');
    });
});

describe('runLowStockMonitor — the recipient language', () => {
    test('writes Bulgarian to a Bulgarian recipient, with the figures interpolated', async () => {
        item(30, null);

        await run();

        const row = mockNotifCreateMany.mock.calls[0][0].data[0];
        // Cyrillic, and NOT the catalogue key — `translateFor` returns the key
        // itself on a miss, which would ship "notifications.lowStock.title" as
        // a push title.
        expect(row.title).toMatch(/[Ѐ-ӿ]/);
        expect(row.title).not.toContain('notifications.');
        expect(row.message).toMatch(/[Ѐ-ӿ]/);
        expect(row.message).not.toContain('notifications.');
        // The item name and both figures reach the body.
        expect(row.message).toContain('Семена');
        expect(row.message).toContain('30');
        expect(row.message).toContain('100');
        // No leftover placeholder.
        expect(row.message).not.toMatch(/\{(name|onHand|reorderLevel)\}/);
    });

    test('writes each recipient their OWN language in one run', async () => {
        mockMembershipFindMany.mockResolvedValue([
            { tenantId: 't1', userId: 'u-bg', tenant: { slug: 'acme' }, user: { uiLanguage: 'bg' } },
            { tenantId: 't1', userId: 'u-en', tenant: { slug: 'acme' }, user: { uiLanguage: 'en' } },
        ]);
        mockNotifCreateMany.mockResolvedValue({ count: 2 });
        item(30, null);

        await run();

        const rows = mockNotifCreateMany.mock.calls[0][0].data;
        expect(rows).toHaveLength(2);
        const bg = rows.find((r: { userId: string }) => r.userId === 'u-bg');
        const en = rows.find((r: { userId: string }) => r.userId === 'u-en');
        expect(bg.title).toMatch(/[Ѐ-ӿ]/);
        expect(en.title).not.toMatch(/[Ѐ-ӿ]/);
        // The whole point: one sweep, two languages. A single hardcoded string
        // cannot satisfy both, which is why this was the defect.
        expect(bg.title).not.toBe(en.title);
    });

    test('a recipient with no language set gets Bulgarian, not English', async () => {
        // `RECIPIENT_FALLBACK_LOCALE` is bg, deliberately NOT `DEFAULT_LOCALE`
        // (en, for unauthenticated surfaces). A notification recipient is a
        // known user whose column default is bg.
        mockMembershipFindMany.mockResolvedValue([
            { tenantId: 't1', userId: 'u1', tenant: { slug: 'acme' }, user: { uiLanguage: null } },
        ]);
        item(30, null);

        await run();

        expect(mockNotifCreateMany.mock.calls[0][0].data[0].title).toMatch(/[Ѐ-ӿ]/);
    });
});
