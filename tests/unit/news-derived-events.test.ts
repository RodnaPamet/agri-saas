/**
 * Platform-admin review surface for AI news-derived calendar-event
 * proposals (calendar roadmap PR 3 — `NewsDerivedEvent`). Mirrors
 * `tests/unit/agri-events-admin.test.ts`'s mocking shape.
 *
 * Pins: the review queue defaults to PROPOSED, approve/reject are the
 * ONLY two writes and both require a PROPOSED starting state (the
 * state-machine guard), and every transition stamps reviewedAt/reviewedBy.
 */
export {};

const mockNewsDerivedEvent = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
};

jest.mock('@/lib/prisma', () => ({ prisma: { newsDerivedEvent: mockNewsDerivedEvent } }));
jest.mock('@/lib/observability', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
    listNewsDerivedEvents,
    approveNewsDerivedEvent,
    rejectNewsDerivedEvent,
} from '@/app-layer/usecases/news-derived-events';

const actor = { requestId: 'test-req' };

function row(over: Record<string, unknown> = {}) {
    return {
        id: 'nde-1',
        title: 'ДФЗ subsidy window opens',
        kind: 'subsidy-deadline',
        eventDate: new Date('2026-09-15T00:00:00.000Z'),
        confidence: 0.9,
        sourceExcerpt: 'excerpt',
        sourceNewsItemId: 'item-1',
        sourceUrl: 'https://dfz.bg/a1',
        sourceTitle: 'ДФЗ subsidy window',
        status: 'PROPOSED',
        reviewedAt: null,
        reviewedBy: null,
        createdAt: new Date('2026-08-06T00:00:00.000Z'),
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('listNewsDerivedEvents', () => {
    it('defaults to the PROPOSED review inbox', async () => {
        mockNewsDerivedEvent.findMany.mockResolvedValue([row()]);
        const events = await listNewsDerivedEvents();

        expect(mockNewsDerivedEvent.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { status: 'PROPOSED' } }),
        );
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ id: 'nde-1', status: 'PROPOSED', kind: 'subsidy-deadline' });
    });

    it('honors an explicit status filter', async () => {
        mockNewsDerivedEvent.findMany.mockResolvedValue([]);
        await listNewsDerivedEvents({ status: 'APPROVED' });

        expect(mockNewsDerivedEvent.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { status: 'APPROVED' } }),
        );
    });

    it('bounds the page at LIST_LIMIT_MAX regardless of a larger requested limit', async () => {
        mockNewsDerivedEvent.findMany.mockResolvedValue([]);
        await listNewsDerivedEvents({ limit: 10_000 });

        expect(mockNewsDerivedEvent.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ take: 200 }),
        );
    });
});

describe('approveNewsDerivedEvent', () => {
    it('404s on a missing row', async () => {
        mockNewsDerivedEvent.findUnique.mockResolvedValue(null);
        await expect(approveNewsDerivedEvent('nope', actor)).rejects.toThrow(/not found/i);
        expect(mockNewsDerivedEvent.update).not.toHaveBeenCalled();
    });

    it('rejects reviewing an event that is already APPROVED (state-machine guard)', async () => {
        mockNewsDerivedEvent.findUnique.mockResolvedValue(row({ status: 'APPROVED' }));
        await expect(approveNewsDerivedEvent('nde-1', actor)).rejects.toThrow(/already approved/i);
        expect(mockNewsDerivedEvent.update).not.toHaveBeenCalled();
    });

    it('rejects reviewing an event that is already REJECTED', async () => {
        mockNewsDerivedEvent.findUnique.mockResolvedValue(row({ status: 'REJECTED' }));
        await expect(approveNewsDerivedEvent('nde-1', actor)).rejects.toThrow(/already rejected/i);
    });

    it('promotes a PROPOSED row to APPROVED and stamps the reviewer', async () => {
        mockNewsDerivedEvent.findUnique.mockResolvedValue(row());
        mockNewsDerivedEvent.update.mockResolvedValue(
            row({ status: 'APPROVED', reviewedAt: new Date('2026-08-06T12:00:00.000Z'), reviewedBy: actor.requestId }),
        );

        const result = await approveNewsDerivedEvent('nde-1', actor);

        expect(mockNewsDerivedEvent.update).toHaveBeenCalledWith({
            where: { id: 'nde-1' },
            data: expect.objectContaining({ status: 'APPROVED', reviewedBy: actor.requestId }),
        });
        expect(result.status).toBe('APPROVED');
        expect(result.reviewedBy).toBe(actor.requestId);
    });
});

describe('rejectNewsDerivedEvent', () => {
    it('404s on a missing row', async () => {
        mockNewsDerivedEvent.findUnique.mockResolvedValue(null);
        await expect(rejectNewsDerivedEvent('nope', actor)).rejects.toThrow(/not found/i);
        expect(mockNewsDerivedEvent.update).not.toHaveBeenCalled();
    });

    it('demotes a PROPOSED row to REJECTED and stamps the reviewer', async () => {
        mockNewsDerivedEvent.findUnique.mockResolvedValue(row());
        mockNewsDerivedEvent.update.mockResolvedValue(
            row({ status: 'REJECTED', reviewedAt: new Date('2026-08-06T12:00:00.000Z'), reviewedBy: actor.requestId }),
        );

        const result = await rejectNewsDerivedEvent('nde-1', actor);

        expect(mockNewsDerivedEvent.update).toHaveBeenCalledWith({
            where: { id: 'nde-1' },
            data: expect.objectContaining({ status: 'REJECTED', reviewedBy: actor.requestId }),
        });
        expect(result.status).toBe('REJECTED');
    });

    it('never promotes a row to APPROVED via any path other than approveNewsDerivedEvent', async () => {
        // Structural sanity: reject and approve write disjoint status
        // literals — pinned here so a future refactor can't accidentally
        // collapse the two into one shared "review" writer that takes a
        // status param sourced from user input.
        mockNewsDerivedEvent.findUnique.mockResolvedValue(row());
        mockNewsDerivedEvent.update.mockResolvedValue(row({ status: 'REJECTED' }));
        await rejectNewsDerivedEvent('nde-1', actor);
        const data = mockNewsDerivedEvent.update.mock.calls[0][0].data;
        expect(data.status).toBe('REJECTED');
    });
});
