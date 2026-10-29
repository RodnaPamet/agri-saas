/**
 * A task row cached by an OLDER projection gets no `mayDelete` (#2406).
 *
 * ## The hazard, and why it needs a mocked cache to reach
 *
 * `cachedListRead`'s key carries the tenant, the filters and a version
 * counter. The counter is INCR'd by WRITES; a deploy bumps nothing. So for up
 * to the remaining TTL after a release, the cache hands new code a payload
 * built by the previous `select` — and `mayDelete` is computed from two
 * columns #2395 had just added to that select.
 *
 * On such a payload both read `undefined`, `undefined === ctx.userId` is false
 * and `undefined === null` is false, so **every arm evaluated to deny, for
 * everyone, administrators included** — and the client contract treats `false`
 * as a hard denial, cached for a session on the phone.
 *
 * It cannot be reached through the repository: a live query always projects
 * the current select. The stale shape only exists INSIDE the cache, so the
 * cache is what these cases substitute. That is also why #2395's two-callers
 * integration test could not have caught it — there is no Redis in the test
 * environment, so every case there runs the uncached path.
 *
 * The fix is to omit rather than deny, which routes the gap through the
 * contract already written for it: both schema descriptions say an absent
 * field means a row cached before the field existed, and that a client must
 * read `mayDelete === false`, never `!mayDelete`.
 */
const cachedListReadMock = jest.fn();

jest.mock('@/lib/cache/list-cache', () => ({
    __esModule: true,
    cachedListRead: (...a: unknown[]) => cachedListReadMock(...a),
    bumpEntityCacheVersion: jest.fn(),
}));
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_c: unknown, fn: (db: unknown) => unknown) => fn({}),
}));

import { listTasks, listTasksPaginated } from '@/app-layer/usecases/task';
import type { RequestContext } from '@/app-layer/types';

/** An ADMIN, so a denial cannot be explained away as a permission. */
const admin = {
    tenantId: 't1',
    userId: 'u-admin',
    permissions: { canRead: true, canWrite: true, canAdmin: true },
} as unknown as RequestContext;

/** A row as the CURRENT projection returns it. */
const fresh = {
    id: 'task-1',
    title: 'Пръскане',
    createdByUserId: 'u-someone-else',
    treatmentGroupId: null,
};

/** The same row as a payload cached by the PREVIOUS projection: no inputs. */
const stale = { id: 'task-1', title: 'Пръскане' };

beforeEach(() => {
    jest.clearAllMocks();
});

describe('a stale cached payload yields NO flag, not a false one (#2406)', () => {
    it('omits mayDelete entirely on a row missing its inputs', async () => {
        cachedListReadMock.mockResolvedValue([stale]);
        const rows = await listTasks(admin);

        // The assertion that matters: ABSENT, not false. `toBeUndefined`
        // alone would pass for `mayDelete: undefined`, which still serialises
        // the key in some shapes, so the key itself is checked.
        expect('mayDelete' in rows[0]).toBe(false);
        expect(rows[0]).toEqual({ id: 'task-1', title: 'Пръскане' });
    });

    it('does not report a denial to an ADMIN on a stale row', async () => {
        // The sharpest form of the bug. Before the fix this was `false` — the
        // strongest possible claim, made from no evidence, to the one caller
        // who can delete anything.
        cachedListReadMock.mockResolvedValue([stale]);
        const rows = await listTasks(admin);
        expect((rows[0] as { mayDelete?: boolean }).mayDelete).not.toBe(false);
    });

    it('still computes the flag when the inputs ARE there', async () => {
        // The control. Without it, a decorator that omitted unconditionally
        // would pass every case above.
        cachedListReadMock.mockResolvedValue([fresh]);
        const rows = await listTasks(admin);
        expect((rows[0] as { mayDelete?: boolean }).mayDelete).toBe(true);
        // And still strips what it computed from.
        expect('createdByUserId' in rows[0]).toBe(false);
        expect('treatmentGroupId' in rows[0]).toBe(false);
    });

    it('treats a NULL treatmentGroupId as present, because null is its real value', async () => {
        // `null` means "not part of a recorded treatment" and is the common
        // case. Testing absence with falsiness rather than `=== undefined`
        // would drop the flag from almost every row.
        cachedListReadMock.mockResolvedValue([{ ...fresh, createdByUserId: 'u-admin' }]);
        const rows = await listTasks(admin);
        expect((rows[0] as { mayDelete?: boolean }).mayDelete).toBe(true);
    });

    it('a treatment share is still a denial, not an omission', async () => {
        // Absence and refusal must stay distinct: this row HAS its inputs and
        // genuinely cannot be deleted individually.
        cachedListReadMock.mockResolvedValue([{ ...fresh, treatmentGroupId: 'tg-1' }]);
        const rows = await listTasks(admin);
        expect((rows[0] as { mayDelete?: boolean }).mayDelete).toBe(false);
    });

    it('the paginated route behaves the same way', async () => {
        // Both list routes carry the flag, so both carry the hazard.
        cachedListReadMock.mockResolvedValue({
            items: [stale],
            pageInfo: { nextCursor: null },
        });
        const page = await listTasksPaginated(admin, {} as never);
        expect('mayDelete' in page.items[0]).toBe(false);
    });
});

describe('both list reads fingerprint their projection (#2406)', () => {
    it('passes the select to the cache, so a changed projection cannot be served', async () => {
        cachedListReadMock.mockResolvedValue([]);
        await listTasks(admin);
        const opts = cachedListReadMock.mock.calls[0][0] as { projection?: unknown };
        expect(opts.projection).toBeDefined();
        // The actual select, not a hand-maintained version number — a
        // `projectionVersion: 3` somebody must remember to bump is the same
        // bug with an extra step.
        expect(opts.projection).toHaveProperty('createdByUserId');
        expect(opts.projection).toHaveProperty('treatmentGroupId');
    });

    it('and so does the paginated one', async () => {
        cachedListReadMock.mockResolvedValue({ items: [], pageInfo: {} });
        await listTasksPaginated(admin, {} as never);
        const opts = cachedListReadMock.mock.calls[0][0] as { projection?: unknown };
        expect(opts.projection).toHaveProperty('createdByUserId');
    });
});
