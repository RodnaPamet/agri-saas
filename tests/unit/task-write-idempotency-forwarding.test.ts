/**
 * The `Idempotency-Key` must REACH the usecase on the three task-side writes.
 *
 * Companion to `idempotency-forwarding-enforced.test.ts`, which makes the same
 * argument for the journal, spray and farm-task routes and is worth reading
 * first. The short version of why a file like this has to exist: deleting a
 * forwarding hop is **well-typed**. The key is a trailing optional parameter,
 * so omitting the argument compiles, `noUnusedLocals` is off so the orphaned
 * `const` survives, and a usecase test that passes the key positionally proves
 * only that the usecase dedupes WHEN GIVEN one. Nothing notices the route
 * stopped giving it one.
 *
 * So this drives the real route handlers, twice each, with two independent
 * requests carrying the same key — the sequential replay an outbox actually
 * performs.
 *
 * ── the stateful store is the load-bearing part ──
 *
 * Borrowed deliberately from the companion file, because the two degenerate
 * harnesses both LOOK like coverage:
 *
 *   - a `findFirst` resolving null every time lets the second POST create a
 *     second row, so the test can only pass by asserting the wrong number;
 *   - a `findFirst` resolving a row every time short-circuits the FIRST POST
 *     too, so "one create" holds with the forwarding deleted.
 *
 * Only a store that REMEMBERS what the first call wrote can tell the two
 * worlds apart. The mutation table in the PR records what each case reddens.
 *
 * ── and one case that is not about duplication at all ──
 *
 * `a key alone does not return a row to a caller who could not write one`.
 * The task-scoped weed route authorises inside the transaction (it has to —
 * the verdict needs a database read), so the replay read has to sit AFTER that
 * gate. An earlier draft of the usecase checked the key before entering the
 * transaction, which was correct while the only caller was the parcel route,
 * and became an authorisation hole the moment the task-scoped route landed.
 * That case is the one that would catch it coming back.
 */
import { NextRequest } from 'next/server';
import type { RequestContext } from '@/app-layer/types';
import { makeRequestContext } from '../helpers/make-context';

interface CommentRow {
    id: string;
    taskId: string;
    body: string;
    clientMutationId: string | null;
}
interface WeedRow {
    id: string;
    parcelId: string;
    clientMutationId: string | null;
}

/**
 * Match a stored row against whatever `where` the code actually passed.
 *
 * Generic on purpose. An earlier version hardcoded the two fields it expected,
 * and that made a mutation grade the wrong thing: dropping `taskId` from the
 * real query left `where.taskId` undefined, so the hardcoded double MISSED
 * instead of matching across tasks — the replay then tried to insert, tripped
 * the miniature unique index, and the suite reddened on "two POSTs create ONE
 * comment" rather than on the cross-task case the scoping exists for. Lethal,
 * but aimed one level off.
 *
 * Honouring the supplied `where` means an unscoped query behaves here as it
 * would against Postgres: it matches more rows, not fewer.
 */
function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([field, value]) => {
        // The doubles hold no soft-delete column; `deletedAt: null` is the
        // code asking for live rows, which all of these are.
        if (field === 'deletedAt') return true;
        // `tenantId` is bound by `runInTenantContext` in production and is not
        // modelled on these rows.
        if (field === 'tenantId') return true;
        return row[field] === value;
    });
}

const commentStore: CommentRow[] = [];
const weedStore: WeedRow[] = [];

/** A tenant-bound Prisma double that REMEMBERS. */
const mockDb = {
    parcel: {
        findFirst: jest.fn(async () => ({ id: 'p-1', name: 'Нива 1', cropType: 'wheat' })),
    },
    taskComment: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
            const d = args.data;
            const key = (d.clientMutationId as string | null) ?? null;
            // The real unique (tenantId, clientMutationId) index, in miniature.
            if (key !== null && commentStore.some((r) => r.clientMutationId === key)) {
                throw uniqueViolation('TaskComment_tenantId_clientMutationId_key');
            }
            const row: CommentRow = {
                id: `cmt-${commentStore.length + 1}`,
                taskId: d.taskId as string,
                body: d.body as string,
                clientMutationId: key,
            };
            commentStore.push(row);
            return { ...row, createdBy: { id: 'u-1', name: 'A', email: 'a@x.test' } };
        }),
        findFirst: jest.fn(async (args: { where: Record<string, unknown> }) => {
            const hit = commentStore.find((r) =>
                matchesWhere(r as unknown as Record<string, unknown>, args.where),
            );
            return hit ? { ...hit, createdBy: { id: 'u-1', name: 'A', email: 'a@x.test' } } : null;
        }),
    },
    parcelWeedObservation: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
            const d = args.data;
            const key = (d.clientMutationId as string | null) ?? null;
            if (key !== null && weedStore.some((r) => r.clientMutationId === key)) {
                throw uniqueViolation('ParcelWeedObservation_tenantId_clientMutationId_key');
            }
            const row: WeedRow = {
                id: `wo-${weedStore.length + 1}`,
                parcelId: d.parcelId as string,
                clientMutationId: key,
            };
            weedStore.push(row);
            return row;
        }),
        findFirst: jest.fn(async (args: { where: Record<string, unknown> }) => {
            return (
                weedStore.find((r) =>
                    matchesWhere(r as unknown as Record<string, unknown>, args.where),
                ) ?? null
            );
        }),
    },
};

/** A P2002 the real `isUniqueViolation` predicate accepts. */
function uniqueViolation(target: string): Error {
    const { Prisma } = jest.requireActual('@prisma/client');
    return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target },
    });
}

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_c: unknown, fn: (db: unknown) => unknown) => fn(mockDb),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/lib/cache/list-cache', () => ({
    bumpEntityCacheVersion: jest.fn(),
    cachedListRead: jest.fn(),
}));

/** The task the scoped route authorises against. */
const taskRow = { id: 't-1', type: 'FIELD_OPERATION', assigneeUserId: 'u-1' };
const findBareById = jest.fn(async () => taskRow as typeof taskRow | null);
jest.mock('../../src/app-layer/repositories/WorkItemRepository', () => {
    const actual = jest.requireActual('../../src/app-layer/repositories/WorkItemRepository');
    return {
        ...actual,
        WorkItemRepository: { ...actual.WorkItemRepository, findBareById: () => findBareById() },
        // `taskParcelIds` reads BOTH sources. Leaving this one real sent it at
        // the Prisma double, which has no `taskLink` — and the route answered
        // 500, a failure about the harness rather than the forwarding.
        TaskLinkRepository: { ...actual.TaskLinkRepository, listParcelIdsByTask: async () => [] },
    };
});
jest.mock('../../src/app-layer/repositories/ParcelRepository', () => ({
    ParcelRepository: {
        listOperationParcelIdsForTask: jest.fn(async () => ['p-1']),
        listSummariesByIds: jest.fn(async () => []),
    },
}));

let currentCtx: RequestContext = makeRequestContext('EDITOR', { userId: 'u-1' });
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: async () => currentCtx,
}));

// The route modules are REQUIRED, not imported, so they load after the mocks
// above are registered — `import` hoisting would defeat that. (No eslint
// exemption needed: the rule is off for tests, and a disable directive that
// reports nothing is itself a warning, which the lint ceiling counts.)
const commentsRoute = require('../../src/app/api/t/[tenantSlug]/tasks/[taskId]/comments/route');
const taskWeedRoute = require('../../src/app/api/t/[tenantSlug]/tasks/[taskId]/weed-observations/route');
const parcelWeedRoute = require('../../src/app/api/t/[tenantSlug]/agro/parcels/[parcelId]/weed-observations/route');

function post(url: string, body: unknown, key?: string): NextRequest {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (key) headers['Idempotency-Key'] = key;
    return new NextRequest(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

const COMMENT_URL = 'http://x/api/t/acme/tasks/t-1/comments';
const TASK_WEED_URL = 'http://x/api/t/acme/tasks/t-1/weed-observations';
const PARCEL_WEED_URL = 'http://x/api/t/acme/agro/parcels/p-1/weed-observations';

const WEED_BODY = {
    parcelId: 'p-1',
    observedAt: '2026-10-08T08:00:00.000Z',
    weeds: ['паламида'],
};

beforeEach(() => {
    commentStore.length = 0;
    weedStore.length = 0;
    jest.clearAllMocks();
    mockDb.parcel.findFirst.mockResolvedValue({ id: 'p-1', name: 'Нива 1', cropType: 'wheat' });
    findBareById.mockResolvedValue(taskRow);
    currentCtx = makeRequestContext('EDITOR', { userId: 'u-1' });
});

describe('POST /tasks/:id/comments — a replayed comment does not duplicate', () => {
    const params = Promise.resolve({ tenantSlug: 'acme', taskId: 't-1' });

    it('two POSTs with the same Idempotency-Key create ONE comment', async () => {
        const key = 'outbox-item-1';
        const a = await commentsRoute.POST(post(COMMENT_URL, { body: 'първи' }, key), { params });
        const b = await commentsRoute.POST(post(COMMENT_URL, { body: 'първи' }, key), { params });

        expect(a.status).toBe(201);
        expect(b.status).toBe(201);
        expect(commentStore).toHaveLength(1);
        expect((await b.json()).id).toBe((await a.json()).id);
    });

    it('stamps the key, so the NEXT replay can find it', async () => {
        await commentsRoute.POST(post(COMMENT_URL, { body: 'x' }, 'outbox-item-2'), { params });
        expect(commentStore[0].clientMutationId).toBe('outbox-item-2');
    });

    it('two POSTs with NO key create two comments — dedup is not accidental', async () => {
        await commentsRoute.POST(post(COMMENT_URL, { body: 'x' }), { params });
        await commentsRoute.POST(post(COMMENT_URL, { body: 'y' }), { params });
        expect(commentStore).toHaveLength(2);
        expect(commentStore.every((r) => r.clientMutationId === null)).toBe(true);
    });

    it('distinct keys create distinct comments', async () => {
        await commentsRoute.POST(post(COMMENT_URL, { body: 'x' }, 'k-1'), { params });
        await commentsRoute.POST(post(COMMENT_URL, { body: 'y' }, 'k-2'), { params });
        expect(commentStore).toHaveLength(2);
    });

    it('a replay writes no SECOND audit event', async () => {
        // The reason the replay returns before the write rather than merely
        // deduping the row: a deduped row would still have logged twice.
        const { logEvent } = jest.requireMock('@/app-layer/events/audit');
        const key = 'outbox-item-3';
        await commentsRoute.POST(post(COMMENT_URL, { body: 'x' }, key), { params });
        await commentsRoute.POST(post(COMMENT_URL, { body: 'x' }, key), { params });
        expect(logEvent).toHaveBeenCalledTimes(1);
    });

    it('does NOT adopt a comment posted on a DIFFERENT task from the same key', async () => {
        // `clientMutationId` is unique per TENANT. An unscoped read-back would
        // hand this request the comment from task t-1 and the client would mark
        // its outbox item delivered having lost a write. Scoped, the insert
        // trips the index, the task-scoped re-read misses, and the conflict
        // surfaces instead.
        const key = 'reused-across-tasks';
        await commentsRoute.POST(post(COMMENT_URL, { body: 'on t-1' }, key), { params });

        const otherParams = Promise.resolve({ tenantSlug: 'acme', taskId: 't-2' });
        const res = await commentsRoute.POST(post(COMMENT_URL, { body: 'on t-2' }, key), {
            params: otherParams,
        });

        // `withApiErrorHandling` turns the rethrown P2002 into a response, so
        // the assertion is on the STATUS, not on a throw. What matters is that
        // it is not a 2xx carrying the other task's comment.
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(commentStore).toHaveLength(1);
        expect(commentStore[0].taskId).toBe('t-1');
    });
});

describe('POST /tasks/:id/weed-observations — a replayed observation does not duplicate', () => {
    const params = Promise.resolve({ tenantSlug: 'acme', taskId: 't-1' });

    it('two POSTs with the same Idempotency-Key file ONE observation', async () => {
        const key = 'outbox-weed-1';
        const a = await taskWeedRoute.POST(post(TASK_WEED_URL, WEED_BODY, key), { params });
        const b = await taskWeedRoute.POST(post(TASK_WEED_URL, WEED_BODY, key), { params });

        expect(a.status).toBe(201);
        expect(b.status).toBe(201);
        expect(weedStore).toHaveLength(1);
        expect((await b.json()).id).toBe((await a.json()).id);
    });

    it('two POSTs with NO key file two observations — dedup is not accidental', async () => {
        await taskWeedRoute.POST(post(TASK_WEED_URL, WEED_BODY), { params });
        await taskWeedRoute.POST(post(TASK_WEED_URL, WEED_BODY), { params });
        expect(weedStore).toHaveLength(2);
    });

    it('a key alone does not return a row to a caller who could not write one', async () => {
        // The authorisation case, and the reason the replay read lives INSIDE
        // the transaction rather than ahead of it. This caller is neither a
        // writer nor the assignee, so the scoped gate refuses — and it must
        // refuse BEFORE the key is looked up, or a key would be a read
        // capability for anyone holding it.
        const key = 'outbox-weed-2';
        await taskWeedRoute.POST(post(TASK_WEED_URL, WEED_BODY, key), { params });
        expect(weedStore).toHaveLength(1);

        currentCtx = makeRequestContext('MECHANISATOR', { userId: 'u-stranger' });
        jest.clearAllMocks();
        mockDb.parcel.findFirst.mockResolvedValue({ id: 'p-1', name: 'Нива 1', cropType: 'wheat' });
        findBareById.mockResolvedValue(taskRow);

        const res = await taskWeedRoute.POST(post(TASK_WEED_URL, WEED_BODY, key), { params });
        expect(res.status).toBe(403);
        expect(weedStore).toHaveLength(1);
        expect(mockDb.parcelWeedObservation.findFirst).not.toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ clientMutationId: key }),
            }),
        );
    });
});

describe('POST /agro/parcels/:id/weed-observations — the parcel-scoped sibling', () => {
    const params = Promise.resolve({ tenantSlug: 'acme', parcelId: 'p-1' });
    const body = { observedAt: WEED_BODY.observedAt, weeds: WEED_BODY.weeds };

    it('two POSTs with the same Idempotency-Key file ONE observation', async () => {
        const key = 'outbox-weed-3';
        const a = await parcelWeedRoute.POST(post(PARCEL_WEED_URL, body, key), { params });
        const b = await parcelWeedRoute.POST(post(PARCEL_WEED_URL, body, key), { params });

        expect(a.status).toBe(201);
        expect(b.status).toBe(201);
        expect(weedStore).toHaveLength(1);
        expect((await b.json()).id).toBe((await a.json()).id);
    });

    it('does NOT adopt an observation filed against a DIFFERENT parcel', async () => {
        // The weed half of the scoping argument. This case was MISSING until a
        // mutation found it: dropping `parcelId` from the read-back left every
        // test green, so the claim that reusing a key across parcels is an
        // error rather than a silent mis-delivery was asserted nowhere. For a
        // ДНЕВНИК record the silent version is the bad one — the client marks
        // its outbox item delivered and the observation is simply gone.
        const key = 'reused-across-parcels';
        await parcelWeedRoute.POST(post(PARCEL_WEED_URL, body, key), { params });
        expect(weedStore).toHaveLength(1);

        mockDb.parcel.findFirst.mockResolvedValue({ id: 'p-2', name: 'Нива 2', cropType: 'maize' });
        const res = await parcelWeedRoute.POST(post(PARCEL_WEED_URL, body, key), {
            params: Promise.resolve({ tenantSlug: 'acme', parcelId: 'p-2' }),
        });

        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(weedStore).toHaveLength(1);
        expect(weedStore[0].parcelId).toBe('p-1');
    });

    it('one outbox item replayed against EITHER route lands once', async () => {
        // The two routes write the same row through the same usecase, so a
        // client that posted via the task and retried via the parcel (or the
        // reverse) must not double-file. This is why both forward the same
        // header into the same handle rather than each minting its own.
        const key = 'outbox-weed-4';
        await taskWeedRoute.POST(post(TASK_WEED_URL, WEED_BODY, key), {
            params: Promise.resolve({ tenantSlug: 'acme', taskId: 't-1' }),
        });
        await parcelWeedRoute.POST(post(PARCEL_WEED_URL, body, key), { params });
        expect(weedStore).toHaveLength(1);
    });
});
