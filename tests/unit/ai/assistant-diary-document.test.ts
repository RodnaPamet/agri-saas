/**
 * `offer_diary_document` — the assistant OFFERS a ДНЕВНИК PDF, agri-saas#3158.
 *
 * Owner ruling 2026-11-17: a download the person taps, nothing written or
 * generated. What this pins: every id the model sends is resolved by a read
 * under the caller's context before an offer exists; the label is built from
 * that read; the offer reaches the `answer` event; and its label is scanned
 * like any other outgoing text.
 */
const getLocation = jest.fn<Promise<{ id: string; name: string }>, unknown[]>();
const getDiaryTreatment = jest.fn<Promise<Record<string, unknown> | null>, unknown[]>();
const assertModuleEnabled = jest.fn<Promise<void>, unknown[]>();
jest.mock('@/app-layer/usecases/location', () => ({
    ...(jest.requireActual('@/app-layer/usecases/location') as object),
    getLocation: (...a: unknown[]) => getLocation(...a),
}));
jest.mock('@/app-layer/usecases/diary-treatment', () => ({
    ...(jest.requireActual('@/app-layer/usecases/diary-treatment') as object),
    getDiaryTreatment: (...a: unknown[]) => getDiaryTreatment(...a),
}));
jest.mock('@/app-layer/usecases/modules', () => ({
    ...(jest.requireActual('@/app-layer/usecases/modules') as object),
    assertModuleEnabled: (...a: unknown[]) => assertModuleEnabled(...a),
}));

import { buildDiaryOffer, OfferDiaryDocumentArgs } from '@/app-layer/ai/assistant/documents';
import { emitAnswer } from '@/app-layer/ai/assistant/emit-answer';
import { ASSISTANT_TOOLS, runTool } from '@/app-layer/ai/assistant/tools';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('READER');
// Mid-November 2026 on the farm's clock: the 2026–2027 campaign.
const NOW = new Date('2026-11-17T10:00:00Z');

beforeEach(() => {
    getLocation.mockReset();
    getDiaryTreatment.mockReset();
    assertModuleEnabled.mockReset();
    assertModuleEnabled.mockResolvedValue(undefined);
});

describe('buildDiaryOffer', () => {
    it('the farm campaign defaults to the current one, by the farm calendar', async () => {
        const offer = await buildDiaryOffer(ctx, { document: 'farm-campaign' }, NOW);
        expect(offer).toEqual({
            kind: 'farm-campaign',
            label: 'Дневник на стопанството 2026–2027',
            campaign: '2026-2027',
        });
    });

    it('a named campaign is used as given, and a malformed one is refused', async () => {
        await expect(buildDiaryOffer(ctx, { document: 'farm-campaign', campaign: '2024-2025' }, NOW))
            .resolves.toMatchObject({ campaign: '2024-2025', label: 'Дневник на стопанството 2024–2025' });
        await expect(buildDiaryOffer(ctx, { document: 'farm-campaign', campaign: '2024-2026' }, NOW))
            .rejects.toThrow(/consecutive/);
    });

    it('a block register READS the block, and labels it from that read', async () => {
        getLocation.mockResolvedValue({ id: 'loc_1', name: 'Север' });
        const offer = await buildDiaryOffer(ctx, { document: 'block-register', locationId: 'loc_1' }, NOW);
        expect(getLocation).toHaveBeenCalledWith(ctx, 'loc_1');
        expect(offer).toEqual({
            kind: 'block-register',
            label: 'ДНЕВНИК за блок «Север», 01.10.2026 – 30.09.2027',
            locationId: 'loc_1',
            from: '2026-10-01',
            to: '2027-09-30',
        });
    });

    it('a block the caller cannot read is NO offer', async () => {
        getLocation.mockRejectedValue(new Error('Location not found'));
        await expect(buildDiaryOffer(ctx, { document: 'block-register', locationId: 'loc_other' }, NOW))
            .rejects.toThrow(/not found/);
    });

    it('a block register needs its block, and a period that runs forwards', async () => {
        await expect(buildDiaryOffer(ctx, { document: 'block-register' }, NOW)).rejects.toThrow(/locationId/);
        getLocation.mockResolvedValue({ id: 'loc_1', name: 'Север' });
        await expect(buildDiaryOffer(ctx, {
            document: 'block-register', locationId: 'loc_1', from: '2026-05-01', to: '2026-04-01',
        }, NOW)).rejects.toThrow(/after/);
    });

    it('a treatment READS the treatment; an unknown handle is no offer', async () => {
        getDiaryTreatment.mockResolvedValue({ treatmentGroupId: 'tg_1', occurredOn: '2026-04-12' });
        await expect(buildDiaryOffer(ctx, { document: 'treatment', treatmentGroupId: 'tg_1' }, NOW))
            .resolves.toEqual({
                kind: 'treatment',
                label: 'ДНЕВНИК за третирането от 12.04.2026',
                treatmentGroupId: 'tg_1',
            });
        getDiaryTreatment.mockResolvedValue(null);
        await expect(buildDiaryOffer(ctx, { document: 'treatment', treatmentGroupId: 'nope' }, NOW))
            .rejects.toThrow(/No recorded treatment/);
    });

    it('the args refuse an unknown document and an unknown field', () => {
        expect(OfferDiaryDocumentArgs.safeParse({ document: 'everything' }).success).toBe(false);
        expect(OfferDiaryDocumentArgs.safeParse({ document: 'farm-campaign', save: true }).success).toBe(false);
    });
});

describe('through runTool', () => {
    it('lifts the offer onto the outcome, behind the JOURNAL module', async () => {
        getLocation.mockResolvedValue({ id: 'loc_1', name: 'Север' });
        const out = await runTool(ctx, 'offer_diary_document',
            JSON.stringify({ document: 'block-register', locationId: 'loc_1', from: '2026-03-01', to: '2026-06-30' }));
        expect(out.ok).toBe(true);
        expect(assertModuleEnabled).toHaveBeenCalledWith(ctx, 'JOURNAL');
        expect(out.document).toEqual({
            kind: 'block-register',
            label: 'ДНЕВНИК за блок «Север», 01.03.2026 – 30.06.2026',
            locationId: 'loc_1',
            from: '2026-03-01',
            to: '2026-06-30',
        });
        expect(out.proposal).toBeNull();
    });

    it('a refused read is a FAILED tool with no offer', async () => {
        getLocation.mockRejectedValue(new Error('Location not found'));
        const out = await runTool(ctx, 'offer_diary_document',
            JSON.stringify({ document: 'block-register', locationId: 'loc_other' }));
        expect(out.ok).toBe(false);
        expect(out.document).toBeUndefined();
    });

    it('a journal module switched off is a failed tool, before any read', async () => {
        assertModuleEnabled.mockRejectedValue(new Error('MODULE_DISABLED'));
        const out = await runTool(ctx, 'offer_diary_document', JSON.stringify({ document: 'treatment', treatmentGroupId: 'tg_1' }));
        expect(out.ok).toBe(false);
        expect(getDiaryTreatment).not.toHaveBeenCalled();
    });

    it('only the offer tool can put a document on an outcome (control)', () => {
        const offering = Object.entries(ASSISTANT_TOOLS).filter(([, t]) => t.offersDocument).map(([n]) => n);
        expect(offering).toEqual(['offer_diary_document']);
    });
});

describe('on the answer event', () => {
    const collect = () => {
        const sent: string[] = [];
        return { sent, send: (c: string) => sent.push(c) };
    };
    const parse = (c: string) => JSON.parse(c.replace(/^data: /, '').trim()) as Record<string, unknown>;

    it('the offer rides the answer, and is absent when there is none', async () => {
        const offer = { kind: 'farm-campaign' as const, label: 'Дневник на стопанството 2026–2027', campaign: '2026-2027' };
        const a = collect();
        await emitAnswer(a.send, 'Ето дневника.', { tenantId: 't1', document: offer });
        expect(parse(a.sent[0] as string)).toMatchObject({ type: 'answer', document: offer });
        const b = collect();
        await emitAnswer(b.send, 'Няма какво да предложа.', { tenantId: 't1' });
        expect(parse(b.sent[0] as string)).not.toHaveProperty('document');
    });

    it('a secret-shaped LABEL discards the whole answer', async () => {
        // The label names a block from the farm's own data — outgoing text.
        const key = 'AKIAIOSFODNN7EXAMPLE'; // pragma: allowlist secret -- AWS's published example
        const { sent, send } = collect();
        const out = await emitAnswer(send, 'Ето дневника.', {
            tenantId: 't1',
            document: { kind: 'block-register', label: `ДНЕВНИК за блок «${key}»`, locationId: 'l', from: '2026-01-01', to: '2026-02-01' },
        });
        expect(out.sent).toBe(false);
        expect(sent.join('')).not.toContain(key);
    });
});
