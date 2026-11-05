/**
 * lease-expiry-sweep unit tests.
 *
 * Locks the notification `linkUrl` shape (flag 1) so it can't silently
 * regress back to `/reports`:
 *   1. linkUrl deep-links to /t/{slug}/rent, appending ?locationId=<id> when
 *      the lease's parcel has a location.
 *   2. linkUrl omits the query when the parcel has no locationId.
 *   3. the per-(lease, recipient, endDate) dedupeKey shape holds.
 *
 * The linkUrl assertions are on the notification ROW. They used to be made
 * against the published SSE event too, which carried a copy; the event carries
 * ids only as of #1990, so that half now asserts the id equals the row's
 * dedupeKey instead.
 */
export {};

/**
 * The two shapes `notification.findMany` is called with on this path.
 *
 * Typed rather than `any`: the lint ceiling counts ESLint's SUPPRESSED
 * findings, not just its reported ones, so an `any` inside a file that already
 * carries a blanket `no-explicit-any` disable raises the count by one with
 * nothing new appearing in the diff. That is exactly how this branch went red
 * on a ceiling of 1584 while main sat at 1584.
 */
interface NotificationFindManyArgs {
    where: { dedupeKey: { in: string[] } };
    select?: { id?: boolean; dedupeKey?: boolean };
}

const DAY = new Date('2026-06-14T09:00:00Z');

const mockLeaseFindMany = jest.fn();
const mockMembershipFindMany = jest.fn();
const mockNotifFindMany = jest.fn();
const mockNotifCreateMany = jest.fn();
const mockPublish = jest.fn();

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(), child: jest.fn().mockReturnThis() };

/**
 * Every farm a lessor-name read ran under, in order (#2728).
 *
 * `lessorName` is encrypted under the FARM's DEK and this sweep is
 * cross-tenant by design, so the name is fetched per farm through
 * `withTenantDb` rather than selected on the cross-tenant query — which
 * previously returned the `v2:` envelope and interpolated it into the
 * notification a farmer reads.
 *
 * The seam has to be mocked here because the suite's `prisma` double is a
 * plain object with no `$transaction`, and `withTenantDb` opens one. Recording
 * the farm turns that necessity into the assertion the suite was missing.
 */
const tenantContexts: string[] = [];
const mockLessorFindMany = jest.fn();

beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    const client = {
        parcelLease: { findMany: (...a: unknown[]) => mockLeaseFindMany(...a) },
        tenantMembership: { findMany: (...a: unknown[]) => mockMembershipFindMany(...a) },
        notification: {
            // #2142 read-back. Two DIFFERENT queries now hit
            // `notification.findMany` on this path, and they are told apart by
            // their `select`: the pre-insert existence check asks only for
            // `dedupeKey`, while the id read-back asks for `id` too. Without
            // the branch, a test configuring the existence check to return
            // `[]` also made the read-back resolve nothing, so the publish was
            // skipped and the assertion read zero calls.
            findMany: async (args: NotificationFindManyArgs) => {
                if (args.select?.id) {
                    return args.where.dedupeKey.in.map((dedupeKey, i) => ({
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
    jest.mock('@/lib/db-context', () => ({
        withTenantDb: async (tenantId: string, cb: (db: unknown) => Promise<unknown>) => {
            tenantContexts.push(tenantId);
            return cb({
                parcelLease: { findMany: (...a: unknown[]) => mockLessorFindMany(...a) },
            });
        },
    }));

    mockMembershipFindMany.mockResolvedValue([{ tenantId: 't1', userId: 'u1', tenant: { slug: 'acme' } }]);
    mockNotifFindMany.mockResolvedValue([]);
    mockNotifCreateMany.mockResolvedValue({ count: 1 });
    tenantContexts.length = 0;
    // Default: echo back a readable name for whatever ids are asked for, so
    // every existing test keeps a plaintext lessor without restating it.
    mockLessorFindMany.mockImplementation(
        async (args: { where: { id: { in: string[] } } }) =>
            args.where.id.in.map((id) => ({ id, lessorName: 'Иван Петров' })),
    );
});

async function run(opts: Record<string, unknown> = {}) {
    const { runLeaseExpirySweep } = await import('@/app-layer/jobs/lease-expiry-sweep');
    return runLeaseExpirySweep({ now: DAY, ...opts });
}

/** The single row handed to notification.createMany. */
function createdRow() {
    return mockNotifCreateMany.mock.calls[0][0].data[0];
}

describe('runLeaseExpirySweep — linkUrl', () => {
    test('deep-links to /t/{slug}/rent?locationId=<id> when the parcel has a location', async () => {
        mockLeaseFindMany.mockResolvedValue([
            {
                id: 'l1',
                tenantId: 't1',
                lessorName: 'Иван',
                endDate: new Date('2026-07-01T00:00:00Z'),
                parcel: { name: 'Нива 1', locationId: 'loc-9' },
            },
        ]);

        await run();

        expect(createdRow().linkUrl).toBe('/t/acme/rent?locationId=loc-9');
        // The event carries ids ONLY as of #1990, so it no longer repeats the
        // linkUrl — the client refetches the row over REST.
        //
        // ── this used to assert the dedupeKey (#2142) ──
        //
        // It read `expect(mockPublish).toHaveBeenCalledWith('t1', 'u1', { id:
        // createdRow().dedupeKey })`, under a comment calling that "still
        // worth locking … derived from the row rather than hardcoded so the
        // two cannot drift apart silently". The derivation was careful and the
        // value was wrong: since P7.2 a frame's id is the client's
        // `Last-Event-ID`, which `replayNotificationIdsAfter` resolves as a
        // `Notification.id` — so a dedupeKey meant a reconnect right after a
        // sweep replayed nothing at all.
        //
        // The id is now the ROW id, and the dedupeKey is only how it is found.
        expect(mockPublish).toHaveBeenCalledWith('t1', 'u1', { id: 'notif-1' });
        expect(mockPublish).not.toHaveBeenCalledWith('t1', 'u1', {
            id: createdRow().dedupeKey,
        });
    });

    test('omits ?locationId when the parcel has no locationId', async () => {
        mockLeaseFindMany.mockResolvedValue([
            {
                id: 'l2',
                tenantId: 't1',
                lessorName: 'Петър',
                endDate: new Date('2026-07-01T00:00:00Z'),
                parcel: { name: 'Нива 2', locationId: null },
            },
        ]);

        await run();

        expect(createdRow().linkUrl).toBe('/t/acme/rent');
    });

    test('dedupeKey is per (lease, recipient, endDate)', async () => {
        mockLeaseFindMany.mockResolvedValue([
            {
                id: 'l3',
                tenantId: 't1',
                lessorName: 'Иван',
                endDate: new Date('2026-07-01T00:00:00Z'),
                parcel: { name: 'Нива 3', locationId: 'loc-1' },
            },
        ]);

        await run();

        expect(createdRow().dedupeKey).toBe('lease-expiry:t1:l3:u1:2026-07-01');
    });
});

/**
 * The copy is the RECIPIENT's language — #2511.
 *
 * Written as a COMPARISON of two recipients rather than as an assertion about
 * one string, because every other shape of this test passes on the defect. The
 * sweep hardcoded «Изтичащ договор за наем», and:
 *
 *   · asserting the Bulgarian title passes on the hardcoded version — that IS
 *     the hardcoded version;
 *   · asserting "a title exists" passes on anything;
 *   · asserting the English title for an `en` user passes, but only until
 *     somebody hardcodes English instead, which is the mirror defect and the
 *     one the English-prose guard is already looking for.
 *
 * Two recipients of ONE event, differing only in `uiLanguage`, getting
 * DIFFERENT strings is the property. A producer that hardcodes in either
 * language gives them the same one.
 *
 * Note what the existing tests in this file could not catch: they pass on both
 * the old and new code, because they assert `linkUrl` and `dedupeKey` and
 * never the copy. The real `translateFor` runs here, so these read the
 * catalogue rather than a double — a double would let the test pass while the
 * key was missing from `bg.json`.
 */
describe('runLeaseExpirySweep — the copy follows the recipient (#2511)', () => {
    async function rowsForTwoRecipients() {
        mockLeaseFindMany.mockResolvedValue([
            {
                id: 'l1',
                tenantId: 't1',
                endDate: new Date('2026-07-01T00:00:00Z'),
                lessorName: 'Иван Петров',
                parcel: { name: 'Нива 3', locationId: null },
            },
        ]);
        mockMembershipFindMany.mockResolvedValue([
            { tenantId: 't1', userId: 'u-bg', tenant: { slug: 'acme' }, user: { uiLanguage: 'bg' } },
            { tenantId: 't1', userId: 'u-en', tenant: { slug: 'acme' }, user: { uiLanguage: 'en' } },
        ]);
        mockNotifCreateMany.mockResolvedValue({ count: 2 });
        await run();
        const rows = mockNotifCreateMany.mock.calls[0][0].data as {
            userId: string;
            title: string;
            message: string;
        }[];
        return {
            bg: rows.find((r) => r.userId === 'u-bg')!,
            en: rows.find((r) => r.userId === 'u-en')!,
        };
    }

    test('two recipients of ONE expiry get copy in their OWN languages', async () => {
        const { bg, en } = await rowsForTwoRecipients();

        // The comparison. Equal titles mean the copy is hardcoded, whichever
        // language it happens to be in.
        expect(bg.title).not.toBe(en.title);
        expect(bg.message).not.toBe(en.message);
        // And each is actually in its own language, so "different" cannot be
        // satisfied by two wrong strings.
        expect(bg.title).toMatch(/[Ѐ-ӿ]/);
        expect(en.title).not.toMatch(/[Ѐ-ӿ]/);
    });

    test('the interpolated values survive into both', async () => {
        const { bg, en } = await rowsForTwoRecipients();
        // The parcel name and lessor are DATA, not copy — they are the
        // farmer's own words and are not translated. Asserted in both so a
        // key whose placeholders do not match the call site is caught: a
        // missing `{parcel}` would leave the name out silently.
        for (const row of [bg, en]) {
            expect(row.message).toContain('Нива 3');
            expect(row.message).toContain('Иван Петров');
            expect(row.message).toContain('2026-07-01');
        }
    });
});

describe('runLeaseExpirySweep — the lessor name is per-FARM (#2728)', () => {
    /** A lease as the cross-tenant metadata query returns it: no `lessorName`. */
    const lease = (id: string, tenantId: string) => ({
        id,
        tenantId,
        endDate: new Date('2026-07-01T00:00:00Z'),
        parcel: { name: 'Нива 1', locationId: 'loc-9' },
    });

    test('the cross-tenant query does NOT select lessorName', async () => {
        mockLeaseFindMany.mockResolvedValue([lease('l1', 't1')]);
        await run();
        const args = mockLeaseFindMany.mock.calls[0][0] as { select: Record<string, unknown> };
        /*
         * The whole defect. `lessorName` is encrypted under the FARM's DEK and
         * this query spans farms by construction, so selecting it here returns
         * the `v2:` envelope — with no error and no log — and that envelope
         * was interpolated into the notification a farmer opens.
         */
        expect(args.select).not.toHaveProperty('lessorName');
        expect(args.select).toHaveProperty('tenantId');
    });

    test('one context per FARM, not one per lease', async () => {
        mockLeaseFindMany.mockResolvedValue([
            lease('a1', 't1'),
            lease('a2', 't1'),
            lease('b1', 't2'),
        ]);
        mockMembershipFindMany.mockResolvedValue([
            { tenantId: 't1', userId: 'u1', tenant: { slug: 'acme' } },
            { tenantId: 't2', userId: 'u2', tenant: { slug: 'beta' } },
        ]);
        await run();
        // Two farms, three leases, two contexts. A context per lease would be
        // an N+1 over the larger number; a single context would hand back
        // ciphertext for whichever farm it did not pick.
        expect(tenantContexts).toEqual(['t1', 't2']);
    });

    test('an UNREADABLE name degrades to the placeholder, never to an envelope', async () => {
        mockLeaseFindMany.mockResolvedValue([lease('l1', 't1')]);
        // A farm whose DEK could not be resolved: `resolveTenantDekPair` logs
        // and returns NO_DEK_PAIR, so the extension passes the ciphertext on.
        // `readableOrNull` is what stops it reaching a reader.
        mockLessorFindMany.mockResolvedValue([
            { id: 'l1', lessorName: 'v2:GnxO1vf/3MkC4orNu07tftzwnlxBD99pB5hqmN1pwds' },
        ]);
        await run();
        const rows = (mockNotifCreateMany.mock.calls[0][0] as { data: Array<{ message: string }> }).data;
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            expect(row.message).not.toMatch(/v[12]:/);
            // The catalogue's own placeholder, so the sentence stays one
            // sentence rather than branching the copy.
            expect(row.message).toContain('непосочен');
        }
    });
});
