/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock
 * pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Keeping derived evidence truthful.
 *
 * Auto-evidence is a CLAIM about a farm record: "this control point is met,
 * and here is the spray record that proves it". Both ways the source record
 * can move used to leave the claim behind:
 *
 *   - Edit the entry's title and the evidence kept the old one, so the same
 *     record appeared under two names with nothing to say which was current.
 *   - Soft-delete the entry and the evidence stayed, so the control kept
 *     reporting itself backed by a record the operator had just removed, deep-
 *     linking to a page that now 404s.
 */

const mockDb = { evidence: { updateMany: jest.fn() } } as any;

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => `SAN::${s}`),
    sanitizeRichTextHtml: jest.fn((s: string) => s),
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

import {
    syncDerivedEvidenceTitle,
    setDerivedEvidenceWithdrawn,
} from '@/app-layer/usecases/auto-evidence';
import { AUTO_FARM_RECORD_CATEGORY } from '@/lib/evidence/auto-evidence-constants';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('EDITOR');

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.evidence.updateMany.mockResolvedValue({ count: 2 });
});

describe('syncDerivedEvidenceTitle', () => {
    it('re-titles every derived row for the entry', async () => {
        const res = await syncDerivedEvidenceTitle(mockDb, ctx, 'log-1', 'New title');
        expect(res).toEqual({ updated: 2 });
        expect(mockDb.evidence.updateMany).toHaveBeenCalledWith({
            where: {
                tenantId: ctx.tenantId,
                sourceLogEntryId: 'log-1',
                category: AUTO_FARM_RECORD_CATEGORY,
            },
            data: { title: 'SAN::New title' },
        });
    });

    it('sanitises the new title — it is user text arriving from the entry', async () => {
        await syncDerivedEvidenceTitle(mockDb, ctx, 'log-1', '<script>x</script>');
        expect(mockDb.evidence.updateMany.mock.calls[0][0].data.title).toMatch(/^SAN::/);
    });

    it('only touches rows this job wrote', async () => {
        // Hand-filed evidence that happens to reference the same entry is not
        // ours to rewrite.
        await syncDerivedEvidenceTitle(mockDb, ctx, 'log-1', 'x');
        expect(mockDb.evidence.updateMany.mock.calls[0][0].where.category)
            .toBe(AUTO_FARM_RECORD_CATEGORY);
    });
});

describe('setDerivedEvidenceWithdrawn', () => {
    it('withdraws by setting deletedAt', async () => {
        const res = await setDerivedEvidenceWithdrawn(mockDb, ctx, 'log-1', true);
        expect(res).toEqual({ affected: 2 });
        const call = mockDb.evidence.updateMany.mock.calls[0][0];
        expect(call.data.deletedAt).toBeInstanceOf(Date);
    });

    it('only withdraws rows that are currently live', async () => {
        // Without this the count would report work it did not do, and a
        // restore would resurrect evidence someone deleted on its own merits.
        await setDerivedEvidenceWithdrawn(mockDb, ctx, 'log-1', true);
        expect(mockDb.evidence.updateMany.mock.calls[0][0].where.deletedAt).toBeNull();
    });

    it('reinstates by clearing deletedAt, and only for withdrawn rows', async () => {
        await setDerivedEvidenceWithdrawn(mockDb, ctx, 'log-1', false);
        const call = mockDb.evidence.updateMany.mock.calls[0][0];
        expect(call.data.deletedAt).toBeNull();
        expect(call.where.deletedAt).toEqual({ not: null });
    });

    it('scopes to the tenant and to derived rows', async () => {
        await setDerivedEvidenceWithdrawn(mockDb, ctx, 'log-1', true);
        const where = mockDb.evidence.updateMany.mock.calls[0][0].where;
        expect(where.tenantId).toBe(ctx.tenantId);
        expect(where.sourceLogEntryId).toBe('log-1');
        expect(where.category).toBe(AUTO_FARM_RECORD_CATEGORY);
    });

    it('withdraw then reinstate are exact inverses in their filters', async () => {
        await setDerivedEvidenceWithdrawn(mockDb, ctx, 'log-1', true);
        await setDerivedEvidenceWithdrawn(mockDb, ctx, 'log-1', false);
        const [withdraw, reinstate] = mockDb.evidence.updateMany.mock.calls.map((c: any) => c[0]);
        expect(withdraw.where.deletedAt).toBeNull();
        expect(reinstate.where.deletedAt).toEqual({ not: null });
    });
});
