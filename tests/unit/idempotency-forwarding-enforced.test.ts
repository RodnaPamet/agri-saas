/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks and Prisma
 * client shims mirror runtime contracts; per-line typing has poor cost/benefit
 * in test files (the codebase's standard file-level disable). */
/**
 * The `Idempotency-Key` header must REACH the usecase — not merely be read.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * The offline outbox replays a queued journal entry or spray job over flaky
 * rural LTE using its item id as the `Idempotency-Key`. Three routes read that
 * header and forward it. **No test in the repo imports any of those three route
 * modules**, so the forwarding hop itself sits at 0% runtime coverage, and both
 * halves around it are tested against themselves:
 *
 *   - `offline-pwa-coverage.test.ts:213` greps `sync.ts` for the header string
 *     — the CLIENT half, by regex, zero runtime coverage.
 *   - `log-entry-idempotency.test.ts` and `field-operation-idempotency.test.ts`
 *     call the usecases with the key as a POSITIONAL ARGUMENT. They prove the
 *     usecase dedupes WHEN GIVEN a key; they are structurally incapable of
 *     noticing that the route stopped giving it one.
 *   - `journal-offline-create.spec.ts` drains the outbox exactly ONCE and
 *     asserts one row — which holds identically with the forwarding deleted.
 *
 * And deleting it does not even fail typecheck: the key is a TRAILING OPTIONAL
 * parameter on both usecases, so omitting the argument is well-typed by
 * definition, and tsconfig sets no `noUnusedLocals` to catch the orphaned const.
 *
 * The failure mode is the exact scenario the whole design exists for: a
 * flaky-LTE retry writing a **duplicated spray or harvest record into the
 * БАБХ regulatory log**.
 *
 * ── What this file drives ──
 *
 * The real route handlers, twice each, with two independent requests carrying
 * the same key — the sequential replay an outbox actually performs. Sequential
 * dedup is resolved entirely by the application-level pre-check
 * (`journal.ts:238`, `field-operation.ts:142`) BEFORE any unique index is
 * consulted, so the logic under test is real TypeScript and needs no database.
 * The DB `@@unique([tenantId, clientMutationId])` index is the CONCURRENT-race
 * backstop only; that path is covered by `tests/integration/`.
 *
 * Note what is NOT asserted here: `journal/[id]/files/route.ts` also forwards
 * the key, but dedup there is CONTENT-ADDRESSED (SHA-256 → FileRecord reuse →
 * `@@unique([logEntryId, fileRecordId])`), and the key is consumed at exactly
 * one place — an audit `detailsJson` field. "Drive twice, assert one row"
 * passes there whether or not the header is forwarded, so writing it that way
 * would look like coverage and prove nothing. It needs a different assertion
 * and lives in its own file.
 */
import { NextRequest } from 'next/server';

// ── shared collaborators ──────────────────────────────────────────

const mockDb: any = {
    location: { findFirst: jest.fn() },
    item: { findFirst: jest.fn() },
    unit: { findUnique: jest.fn() },
    task: { findFirst: jest.fn(), update: jest.fn() },
    operationParcel: { count: jest.fn(), createMany: jest.fn() },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: any, fn: any) => fn(mockDb),
}));

/**
 * STATEFUL journal store. This is the load-bearing part of the harness: a
 * plain `jest.fn()` resolving null on both calls lets the second POST create a
 * second row and the test can only pass by asserting the wrong thing, while a
 * fn resolving a row on EVERY call short-circuits the FIRST POST too, so
 * "one create" holds even with the forwarding deleted. Only a mock that
 * REMEMBERS what the first call wrote can tell forwarded from not-forwarded.
 */
const journalStore: any[] = [];
const JournalRepository = {
    findByClientMutationId: jest.fn(async (_db: any, _ctx: any, key: string) =>
        journalStore.find((e) => e.clientMutationId === key) ?? null),
    createLogEntry: jest.fn(async (_db: any, _ctx: any, input: any) => {
        const row = {
            id: `entry-${journalStore.length + 1}`,
            title: input.title,
            clientMutationId: input.clientMutationId ?? null,
        };
        journalStore.push(row);
        return row;
    }),
    validLocationIds: jest.fn(async () => new Set<string>()),
    validEquipmentIds: jest.fn(async () => new Set<string>()),
};
jest.mock('../../src/app-layer/repositories/JournalRepository', () => ({ JournalRepository }));
jest.mock('../../src/app-layer/repositories/FileRepository', () => ({ FileRepository: {} }));

/** STATEFUL task store — same reasoning as the journal store above. */
const taskStore: any[] = [];
// Rest-args, not `(ctx, input)`: the mock factory below forwards with a spread,
// and TS2556 rejects spreading `any[]` into a fixed-arity signature.
const createTask = jest.fn(async (...args: any[]) => {
    const input = args[1];
    const row = {
        id: `task-${taskStore.length + 1}`,
        key: `TSK-${taskStore.length + 1}`,
        clientMutationId: input?.clientMutationId ?? null,
    };
    taskStore.push(row);
    return row;
});
jest.mock('../../src/app-layer/usecases/task', () => ({ createTask: (...a: any[]) => createTask(...a) }));

jest.mock('../../src/app-layer/policies/common', () => ({
    assertCanRead: jest.fn(), assertCanWrite: jest.fn(), assertCanAdmin: jest.fn(),
}));
jest.mock('../../src/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('../../src/app-layer/automation', () => ({ emitAutomationEvent: jest.fn() }));
jest.mock('../../src/app-layer/usecases/inventory', () => ({ recordHarvestLot: jest.fn() }));
jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: jest.fn() }));
jest.mock('../../src/app-layer/repositories/ParcelRepository', () => ({
    ParcelRepository: {
        validIdsForLocation: jest.fn(async (_d: any, _c: any, _l: any, ids: string[]) => new Set(ids)),
    },
}));
jest.mock('../../src/app-layer/repositories/WorkItemRepository', () => ({
    WorkItemRepository: {},
    TaskLinkRepository: { link: jest.fn() },
}));
jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: (s: string) => s,
    sanitizeRichTextHtml: (s: string) => s,
}));
jest.mock('@/lib/observability', () => ({
    traceAgUsecase: (_n: string, _c: any, fn: any) => fn(),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
// `@opentelemetry/api` is deliberately NOT mocked, unlike the usecase-level
// suites. Two reasons, both learned the hard way here:
//   1. Driving the real route pulls in Sentry and the real
//      `src/lib/observability/{tracing,context}.ts` (errors/api.ts imports the
//      submodules directly, so a barrel mock does not intercept them). A bare
//      `{ trace: { getActiveSpan } }` literal drops `createContextKey` and
//      `getTracer`, which surfaces as "Test suite failed to run".
//   2. Spreading `actual.trace` does not fix it either — `trace` is a
//      singleton whose methods live on its PROTOTYPE, and object spread copies
//      only own enumerable properties.
// The real module is safe here because every call site is optional-chained
// (`trace.getActiveSpan()?.setAttributes(...)`), so no active span is fine.

// The route layer's own collaborators. `assertModuleEnabled` hits the DB
// otherwise, and an unmocked `getTenantCtx` throws without a session — either
// would make the SECOND request fail before the idempotency pre-check, so
// "exactly one row" would hold trivially. Both are neutralised, and every test
// below also asserts BOTH responses are 201 so a silently-failing second
// request cannot masquerade as dedup.
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getTenantCtx: (...a: any[]) => getTenantCtxMock(...a),
}));
jest.mock('@/app-layer/usecases/modules', () => ({
    __esModule: true,
    assertModuleEnabled: jest.fn(),
}));

// KEPT REAL: the route modules, and the usecases whose dedup is under test.
import * as journalRoute from '@/app/api/t/[tenantSlug]/journal/route';
import * as operationsRoute from '@/app/api/t/[tenantSlug]/locations/[id]/operations/route';

const CTX = {
    tenantId: 'tenant-1',
    userId: 'user-1',
    requestId: 'req-1',
    permissions: { canRead: true, canWrite: true, canAdmin: true },
};

const OUTBOX_ID = 'outbox-item-abc';

/**
 * A FRESH request per call. `withValidatedBody` does `await req.json()`, which
 * consumes the body stream — replaying the same NextRequest object returns 400
 * `Invalid JSON payload`, and a test asserting "only one row" would then PASS
 * for entirely the wrong reason, because the second request never reached the
 * usecase at all.
 */
function post(url: string, body: unknown, key?: string): NextRequest {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (key) headers['Idempotency-Key'] = key;
    return new NextRequest(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

const JOURNAL_URL = 'http://localhost/api/t/acme/journal';
const JOURNAL_BODY = { type: 'OBSERVATION', title: 'Scouted aphids on block A', status: 'DONE' };
const journalArgs = { params: Promise.resolve({ tenantSlug: 'acme' }) } as any;

const OPS_URL = 'http://localhost/api/t/acme/locations/loc-1/operations';
const OPS_BODY = {
    assigneeUserId: 'user-9',
    parcelIds: ['parcel-a', 'parcel-b'],
    productItemId: 'item-1',
    doseValue: 2,
    doseUnitId: 'unit-1',
};
const opsArgs = () => ({ params: Promise.resolve({ tenantSlug: 'acme', id: 'loc-1' }) }) as any;

beforeEach(() => {
    jest.clearAllMocks();
    journalStore.length = 0;
    taskStore.length = 0;
    getTenantCtxMock.mockResolvedValue(CTX);

    // Field-operation happy-path validation.
    mockDb.location.findFirst.mockResolvedValue({ id: 'loc-1', name: 'North Field' });
    mockDb.item.findFirst.mockResolvedValue({ id: 'item-1' });
    mockDb.unit.findUnique.mockResolvedValue({ id: 'unit-1' });
    mockDb.task.update.mockResolvedValue({});
    mockDb.operationParcel.createMany.mockResolvedValue({ count: 2 });
    mockDb.operationParcel.count.mockResolvedValue(2);
    // Stateful lookup, mirroring `where: { tenantId, clientMutationId, type }`.
    mockDb.task.findFirst.mockImplementation(async (args: any) => {
        const key = args?.where?.clientMutationId;
        if (!key) return null;
        return taskStore.find((t) => t.clientMutationId === key) ?? null;
    });
});

describe('POST /journal — a replayed outbox entry does not duplicate', () => {
    it('two POSTs with the same Idempotency-Key create ONE entry', async () => {
        const first = await journalRoute.POST(post(JOURNAL_URL, JOURNAL_BODY, OUTBOX_ID), journalArgs);
        const second = await journalRoute.POST(post(JOURNAL_URL, JOURNAL_BODY, OUTBOX_ID), journalArgs);

        // Both must genuinely succeed. Without this, a second request that
        // failed for an unrelated reason (403 module gate, 429 rate limit,
        // 400 consumed body) would satisfy "one row" while proving nothing.
        expect(first.status).toBe(201);
        expect(second.status).toBe(201);

        // THE load-bearing assertion. The response ids matching is not enough
        // on its own — a stateful store returning a constant id would satisfy
        // that with the forwarding deleted.
        expect(JournalRepository.createLogEntry).toHaveBeenCalledTimes(1);
        expect(journalStore).toHaveLength(1);

        expect((await second.json()).id).toBe((await first.json()).id);
    });

    it('stamps the key so the NEXT replay can find it', async () => {
        // `clientMutationId` is what the pre-check reads. Persisting it is a
        // separate line from forwarding it, and deleting it silently breaks
        // dedup with no error anywhere.
        await journalRoute.POST(post(JOURNAL_URL, JOURNAL_BODY, OUTBOX_ID), journalArgs);

        expect(JournalRepository.createLogEntry).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ clientMutationId: OUTBOX_ID }),
        );
    });

    it('two POSTs with NO key create two entries — dedup is not accidental', async () => {
        // The control. An online double-submit is genuinely two entries; if
        // this collapsed to one, the "one row" assertion above would be
        // measuring something other than the key.
        const first = await journalRoute.POST(post(JOURNAL_URL, JOURNAL_BODY), journalArgs);
        const second = await journalRoute.POST(post(JOURNAL_URL, JOURNAL_BODY), journalArgs);

        expect(first.status).toBe(201);
        expect(second.status).toBe(201);
        expect(JournalRepository.createLogEntry).toHaveBeenCalledTimes(2);
    });

    it('distinct keys create distinct entries', async () => {
        await journalRoute.POST(post(JOURNAL_URL, JOURNAL_BODY, 'outbox-1'), journalArgs);
        await journalRoute.POST(post(JOURNAL_URL, JOURNAL_BODY, 'outbox-2'), journalArgs);

        expect(JournalRepository.createLogEntry).toHaveBeenCalledTimes(2);
    });
});

describe('POST /locations/:id/operations — a replayed spray does not duplicate', () => {
    it('two POSTs with the same Idempotency-Key create ONE task', async () => {
        // This is the БАБХ path: a duplicate here is a duplicated spray record
        // in a regulatory log.
        const first = await operationsRoute.POST(post(OPS_URL, OPS_BODY, OUTBOX_ID), opsArgs());
        const second = await operationsRoute.POST(post(OPS_URL, OPS_BODY, OUTBOX_ID), opsArgs());

        expect(first.status).toBe(201);
        expect(second.status).toBe(201);

        expect(createTask).toHaveBeenCalledTimes(1);
        expect(taskStore).toHaveLength(1);
    });

    it('stamps the key on the created task', async () => {
        await operationsRoute.POST(post(OPS_URL, OPS_BODY, OUTBOX_ID), opsArgs());

        expect(createTask).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ clientMutationId: OUTBOX_ID }),
        );
    });

    it('two POSTs with NO key create two tasks — dedup is not accidental', async () => {
        const first = await operationsRoute.POST(post(OPS_URL, OPS_BODY), opsArgs());
        const second = await operationsRoute.POST(post(OPS_URL, OPS_BODY), opsArgs());

        expect(first.status).toBe(201);
        expect(second.status).toBe(201);
        expect(createTask).toHaveBeenCalledTimes(2);
    });
});
