/**
 * The extraction sweep (#2671) — and what it does NOT stamp.
 *
 * Almost every assertion here is about `extractedAt`, because the queue IS the
 * unstamped set and so every decision about stamping is a decision about
 * whether work is lost or repeated:
 *
 *   · stamped too early  → the conversation is lost on any later failure;
 *   · stamped when skipped → turning the flag on, or paying for budget,
 *     silently skips every conversation that happened first;
 *   · never stamped      → the queue never drains and each run re-spends.
 *
 * None of those three throws, and all three look like a working job.
 */
const mockQueryRaw = jest.fn();
const mockConvUpdate = jest.fn();
const mockFactFindMany = jest.fn();
const mockFactCreate = jest.fn();
const mockFactUpdate = jest.fn();
const mockTurnFindMany = jest.fn();
const mockTransaction = jest.fn();

jest.mock('@/lib/prisma', () => {
    const client = {
        $queryRaw: (...a: unknown[]) => mockQueryRaw(...a),
        $transaction: (...a: unknown[]) => mockTransaction(...a),
        assistantConversation: { update: (...a: unknown[]) => mockConvUpdate(...a) },
        assistantMemoryFact: {
            findMany: (...a: unknown[]) => mockFactFindMany(...a),
            create: (...a: unknown[]) => mockFactCreate(...a),
            update: (...a: unknown[]) => mockFactUpdate(...a),
        },
    };
    return { __esModule: true, default: client, prisma: client };
});

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, cb: (db: unknown) => unknown) =>
        cb({ assistantTurn: { findMany: (...a: unknown[]) => mockTurnFindMany(...a) } }),
}));

const mockIsFeatureEnabled = jest.fn();
jest.mock('@/lib/feature-flags', () => ({
    isFeatureEnabled: (...a: unknown[]) => mockIsFeatureEnabled(...a),
}));

const mockExtract = jest.fn();
jest.mock('@/app-layer/ai/memory-extractor', () => ({
    extractMemoryPoints: (...a: unknown[]) => mockExtract(...a),
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { runMemoryExtract, DEFAULT_IDLE_MINUTES } from '@/app-layer/jobs/memory-extract';
import { codedForbidden } from '@/lib/errors/types';

const CONV = { id: 'c1', tenantId: 't1', userId: 'u1' };

/** Capture what the transaction callback did, in order. */
function captureTx(): string[] {
    const order: string[] = [];
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
        await cb({
            assistantMemoryFact: {
                create: (...a: unknown[]) => {
                    order.push('fact.create');
                    return mockFactCreate(...a);
                },
                update: (...a: unknown[]) => {
                    order.push('fact.update');
                    return mockFactUpdate(...a);
                },
            },
            assistantConversation: {
                update: (...a: unknown[]) => {
                    order.push('conversation.update');
                    return mockConvUpdate(...a);
                },
            },
        });
    });
    return order;
}

beforeEach(() => {
    [mockQueryRaw, mockConvUpdate, mockFactFindMany, mockFactCreate, mockFactUpdate,
     mockTurnFindMany, mockTransaction, mockIsFeatureEnabled, mockExtract]
        .forEach((m) => m.mockReset());

    mockQueryRaw.mockResolvedValue([CONV]);
    mockIsFeatureEnabled.mockResolvedValue(true);
    mockFactFindMany.mockResolvedValue([]);
    mockTurnFindMany.mockResolvedValue([
        { content: 'Отглеждам слънчоглед.', createdAt: new Date('2026-11-01T09:00:00Z') },
    ]);
    mockExtract.mockResolvedValue({ points: [], discarded: [] });
    mockFactCreate.mockResolvedValue({});
    mockFactUpdate.mockResolvedValue({});
    mockConvUpdate.mockResolvedValue({});
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) =>
        cb({
            assistantMemoryFact: { create: mockFactCreate, update: mockFactUpdate },
            assistantConversation: { update: mockConvUpdate },
        }),
    );
});

describe('the queue', () => {
    it('reads only unstamped conversations past the idle cutoff, oldest first', async () => {
        await runMemoryExtract();
        const sql = String(mockQueryRaw.mock.calls[0][0]);
        expect(sql).toMatch(/"extractedAt" IS NULL/);
        expect(sql).toMatch(/ORDER BY "lastTurnAt" ASC/);
        // Prisma's tagged template hands the static parts as an array, so a
        // join puts a comma exactly where each value is BOUND. Asserting the
        // comma is therefore asserting the cutoff and the limit are
        // parameterised rather than interpolated into the SQL text.
        expect(sql).toMatch(/"lastTurnAt" <\s*,/);
        expect(sql).toMatch(/LIMIT\s*,/);
    });

    it('is CROSS-tenant — no tenant filter, because the sweep must find every farm’s', async () => {
        await runMemoryExtract();
        const sql = String(mockQueryRaw.mock.calls[0][0]);
        expect(sql).not.toMatch(/"tenantId"\s*=/);
    });

    it('honours an overridden idle threshold', async () => {
        await runMemoryExtract({ idleMinutes: 1 });
        const cutoff = mockQueryRaw.mock.calls[0][1] as Date;
        const minutesAgo = (Date.now() - cutoff.getTime()) / 60_000;
        expect(minutesAgo).toBeGreaterThanOrEqual(0.9);
        expect(minutesAgo).toBeLessThan(DEFAULT_IDLE_MINUTES);
    });
});

describe('what is NOT stamped — the three silent failures', () => {
    it('a person whose flag is OFF leaves the conversation QUEUED', async () => {
        mockIsFeatureEnabled.mockResolvedValue(false);
        const res = await runMemoryExtract();
        expect(mockConvUpdate).not.toHaveBeenCalled();
        expect(mockExtract).not.toHaveBeenCalled();
        expect(res.result.itemsSkipped).toBe(1);
        // Stamping here would mean enabling the flag silently skips every
        // conversation that happened while it was off.
    });

    it('a farm over its AI ceiling leaves the conversation QUEUED', async () => {
        // The gate lives inside `extractMemoryPoints` now, so the refusal
        // arrives from there. What matters to this job is unchanged: the row
        // is not stamped.
        mockExtract.mockRejectedValue(
            codedForbidden('AI_BUDGET_EXCEEDED', 'Monthly AI budget exhausted.'),
        );
        const res = await runMemoryExtract();
        expect(mockConvUpdate).not.toHaveBeenCalled();
        expect(res.result.itemsSkipped).toBe(1);
    });

    it('does NOT re-ask an exhausted tenant for every later conversation in the run', async () => {
        mockQueryRaw.mockResolvedValue([
            { id: 'c1', tenantId: 't1', userId: 'u1' },
            { id: 'c2', tenantId: 't1', userId: 'u2' },
            { id: 'c3', tenantId: 't1', userId: 'u3' },
        ]);
        mockExtract.mockRejectedValue(
            codedForbidden('AI_BUDGET_EXCEEDED', 'Monthly AI budget exhausted.'),
        );
        const res = await runMemoryExtract();
        // Attempted ONCE for the tenant, not once per conversation. The memo is
        // what stops two further extractor calls — each of which would reach
        // the gate and pay a usage aggregate for an answer that cannot change
        // inside one run.
        expect(mockExtract).toHaveBeenCalledTimes(1);
        expect(res.result.itemsSkipped).toBe(3);
    });

    it('but a DIFFERENT tenant in the same run is still attempted', async () => {
        mockQueryRaw.mockResolvedValue([
            { id: 'c1', tenantId: 't1', userId: 'u1' },
            { id: 'c2', tenantId: 't2', userId: 'u2' },
        ]);
        mockExtract
            .mockRejectedValueOnce(codedForbidden('AI_BUDGET_EXCEEDED', 'exhausted'))
            .mockResolvedValueOnce({ points: [], discarded: [] });
        const res = await runMemoryExtract();
        expect(mockExtract).toHaveBeenCalledTimes(2);
        expect(res.result.itemsActioned).toBe(1);
    });
});

describe('what IS stamped', () => {
    it('a conversation with no user turns — "looked and learned nothing" must drain', async () => {
        mockTurnFindMany.mockResolvedValue([]);
        const res = await runMemoryExtract();
        expect(mockConvUpdate).toHaveBeenCalledTimes(1);
        expect(mockExtract).not.toHaveBeenCalled();
        expect(res.result.itemsActioned).toBe(1);
    });

    it('a conversation that yielded no points — same reason', async () => {
        mockExtract.mockResolvedValue({ points: [], discarded: [] });
        const res = await runMemoryExtract();
        expect(mockConvUpdate).toHaveBeenCalledTimes(1);
        expect(res.result.itemsActioned).toBe(1);
    });
});

describe('the write', () => {
    it('stamps LAST, inside the same transaction as the facts', async () => {
        const order = captureTx();
        mockExtract.mockResolvedValue({
            points: [{ text: 'Отглежда слънчоглед', sourceQuote: 'Отглеждам слънчоглед' }],
            discarded: [],
        });
        await runMemoryExtract();
        // Stamping first loses the conversation on any failure in between.
        expect(order).toEqual(['fact.create', 'conversation.update']);
    });

    it('a supersede sets supersededAt — NOT deletedAt, which is the person’s column', async () => {
        captureTx();
        mockExtract.mockResolvedValue({
            points: [
                { text: 'Отглежда пшеница', sourceQuote: 'Отглеждам слънчоглед', supersedesId: 'f-old' },
            ],
            discarded: [],
        });
        await runMemoryExtract();
        const args = mockFactUpdate.mock.calls[0][0] as { where: unknown; data: Record<string, unknown> };
        expect(args.where).toEqual({ id: 'f-old' });
        expect(args.data.supersededAt).toBeInstanceOf(Date);
        // Writing `deletedAt` would make the extractor's bookkeeping
        // indistinguishable from «Изтрий», which carries rule 5's promise.
        expect(args.data).not.toHaveProperty('deletedAt');
    });

    it('writes the quote as evidence and never marks the point person-edited', async () => {
        captureTx();
        mockExtract.mockResolvedValue({
            points: [{ text: 'Отглежда слънчоглед', sourceQuote: 'Отглеждам слънчоглед' }],
            discarded: [],
        });
        await runMemoryExtract();
        const data = (mockFactCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
        expect(data.sourceQuote).toBe('Отглеждам слънчоглед');  // rule 7
        expect(data.editedByPerson).toBe(false);                 // rule 6
        expect(data.userId).toBe('u1');
    });
});

describe('what reaches the model', () => {
    it('passes a ctx carrying the QUEUE ROW’s tenant, never a payload value', async () => {
        await runMemoryExtract();
        const ctx = mockExtract.mock.calls[0][0] as { tenantId: string };
        // The spend gate reads this, so the wrong tenant would charge the wrong
        // farm — and the payload deliberately has no tenantId at all, which is
        // why `MemoryExtractPayload` is on the tenant-isolation exemption list.
        expect(ctx.tenantId).toBe('t1');
    });

    it('reads ONLY the person’s own turns — never the assistant’s', async () => {
        await runMemoryExtract();
        const args = mockTurnFindMany.mock.calls[0][0] as { where: Record<string, unknown> };
        // An assistant turn can quote tool output, and rule 1 forbids a farm's
        // records entering a profile read across farms.
        expect(args.where.role).toBe('user');
        expect(args.where.conversationId).toBe('c1');
    });

    it('passes tombstoned and superseded points too, or rules 4/5/6 cannot apply', async () => {
        mockFactFindMany.mockResolvedValue([
            { id: 'a', text: 'gone', editedByPerson: false, deletedAt: new Date(), supersededAt: null, sourceQuote: 'q1' },
            { id: 'b', text: 'old', editedByPerson: false, deletedAt: null, supersededAt: new Date(), sourceQuote: 'q2' },
        ]);
        await runMemoryExtract();
        const where = (mockFactFindMany.mock.calls[0][0] as { where: unknown }).where;
        // No deletedAt filter: the extractor needs them ALL.
        expect(where).toEqual({ userId: 'u1' });

        const existing = mockExtract.mock.calls[0][2] as Array<{ id: string; refused: boolean }>;
        // `refused` is rule 5 — the PERSON's deletion only. A supersede is the
        // extractor's own bookkeeping and must not read as somebody's wish.
        expect(existing.find((e) => e.id === 'a')?.refused).toBe(true);
        expect(existing.find((e) => e.id === 'b')?.refused).toBe(false);
    });

    it('bounds the turns by CHARACTERS as well as count', async () => {
        mockTurnFindMany.mockResolvedValue([
            { content: 'я'.repeat(11_000), createdAt: new Date('2026-11-01T09:00:00Z') },
            { content: 'я'.repeat(11_000), createdAt: new Date('2026-11-01T09:01:00Z') },
        ]);
        await runMemoryExtract();
        const turns = mockExtract.mock.calls[0][1] as Array<{ content: string }>;
        // One fits, the second would breach the ceiling. A count-only bound
        // cannot express this: 2 turns is under any count limit.
        expect(turns).toHaveLength(1);
    });
});

describe('isolation', () => {
    it('one failing conversation does not stop the batch', async () => {
        mockQueryRaw.mockResolvedValue([
            { id: 'c1', tenantId: 't1', userId: 'u1' },
            { id: 'c2', tenantId: 't2', userId: 'u2' },
        ]);
        mockExtract.mockRejectedValueOnce(new Error('provider exploded')).mockResolvedValue({ points: [], discarded: [] });
        const res = await runMemoryExtract();
        expect(res.result.itemsScanned).toBe(2);
        expect(res.result.itemsActioned).toBe(1);
        expect(res.result.itemsSkipped).toBe(1);
        expect(res.result.success).toBe(true);
    });

    it('reports success WITH skips, and says how many stayed queued', async () => {
        mockIsFeatureEnabled.mockResolvedValue(false);
        const res = await runMemoryExtract();
        expect(res.result.success).toBe(true);
        expect(res.result.details).toMatchObject({ conversationsLeftQueued: 1 });
    });
});
