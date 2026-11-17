/**
 * The field from what the farmer said, and the tool that asks until the record
 * is complete — agri-saas#3162, owner ruling 2026-11-17.
 */
const listParcelPlaceOptions = jest.fn<Promise<unknown[]>, unknown[]>();
const assertModuleEnabled = jest.fn<Promise<void>, unknown[]>();
jest.mock('@/app-layer/usecases/parcel', () => ({
    ...(jest.requireActual('@/app-layer/usecases/parcel') as object),
    listParcelPlaceOptions: (...a: unknown[]) => listParcelPlaceOptions(...a),
}));
jest.mock('@/app-layer/usecases/modules', () => ({
    ...(jest.requireActual('@/app-layer/usecases/modules') as object),
    assertModuleEnabled: (...a: unknown[]) => assertModuleEnabled(...a),
}));

import { fold, resolveAgainst } from '@/app-layer/ai/assistant/place';
import { runTool } from '@/app-layer/ai/assistant/tools';
import { makeRequestContext } from '../../helpers/make-context';

const P = (id: string, name: string, locationName: string, extra: Record<string, unknown> = {}) => ({
    id, name, cadastralId: null, cropType: null, locationId: `loc_${locationName}`, locationName, ...extra,
});
const FARM = [
    P('p1', 'Парцел 1', 'Север', { cropType: 'Wheat', cadastralId: '12345.67.89' }),
    P('p2', 'Парцел 2', 'Север', { cropType: 'Wheat' }),
    P('p3', 'Парцел 3', 'Юг', { cropType: 'Canola' }),
    P('p4', 'Парцел 4', 'Северозапад', { cropType: 'Sunflower' }),
];

describe('resolveAgainst', () => {
    it('a block by its exact name takes every parcel in it — «блок» and quotes ignored', () => {
        const r = resolveAgainst(FARM as never, { block: 'блок «Север»' });
        expect(r.parcels.map((p) => p.id)).toEqual(['p1', 'p2']);
        expect(r.parcels[0]?.label).toBe('Север · Парцел 1');
        expect(r.unresolved).toEqual([]);
    });

    it('a partial name matching two blocks is a QUESTION with the candidates', () => {
        const farm = [...FARM, P('p5', 'Парцел 5', 'Североизток')];
        const many = resolveAgainst(farm as never, { block: 'северо' });
        expect(many.parcels).toEqual([]);
        expect([...(many.unresolved[0]?.candidates ?? [])].sort()).toEqual(['Северозапад', 'Североизток']);
        // Control: a partial name matching ONE block resolves.
        expect(resolveAgainst(FARM as never, { block: 'северо' }).parcels.map((p) => p.id)).toEqual(['p4']);
        // And an exact name wins over the blocks that merely contain it.
        expect(resolveAgainst(farm as never, { block: 'Север' }).parcels.map((p) => p.id)).toEqual(['p1', 'p2']);
    });

    it('a cadastral number, with or without spaces, is one parcel', () => {
        expect(resolveAgainst(FARM as never, { parcels: ['имот 12345. 67.89'] }).parcels.map((p) => p.id)).toEqual(['p1']);
        expect(resolveAgainst(FARM as never, { parcels: ['Парцел 3'] }).parcels.map((p) => p.id)).toEqual(['p3']);
    });

    it('a number matching nothing is unresolved, never guessed', () => {
        const r = resolveAgainst(FARM as never, { parcels: ['99999.1.1'] });
        expect(r.parcels).toEqual([]);
        expect(r.unresolved).toEqual([{ said: '99999.1.1', candidates: [] }]);
    });

    it('a crop said in Bulgarian finds the parcels stored in English, Canola as рапица', () => {
        expect(resolveAgainst(FARM as never, { crop: 'пшеница' }).parcels.map((p) => p.id)).toEqual(['p1', 'p2']);
        expect(resolveAgainst(FARM as never, { crop: 'рапица' }).parcels.map((p) => p.id)).toEqual(['p3']);
        const none = resolveAgainst(FARM as never, { crop: 'царевица' });
        expect(none.parcels).toEqual([]);
        expect(none.unresolved[0]?.candidates).toEqual(['Wheat', 'Canola', 'Sunflower']);
    });

    it('fold drops the noun, the case and the quotes', () => {
        expect(fold('  Нивата  «До Реката» ')).toBe('до реката');
    });
});

describe('propose_treatment asks until the record is complete', () => {
    const ctx = makeRequestContext('EDITOR');
    beforeEach(() => {
        listParcelPlaceOptions.mockReset();
        listParcelPlaceOptions.mockResolvedValue(FARM);
        assertModuleEnabled.mockReset();
        assertModuleEnabled.mockResolvedValue(undefined);
    });

    it('an incomplete record proposes NOTHING and names what to ask', async () => {
        const out = await runTool(ctx, 'propose_treatment', JSON.stringify({
            kind: 'SPRAY', productName: 'Децис', blockName: 'Север',
        }));
        expect(out.ok).toBe(true);
        expect(out.proposal).toBeNull();
        const body = JSON.parse(out.content);
        expect(body.prepared).toBe(false);
        expect(body.missing).toEqual(expect.arrayContaining(['dose', 'date']));
        expect(body.understood.fields).toEqual(['Север · Парцел 1', 'Север · Парцел 2']);
    });

    it('an ambiguous field is asked about even when everything else is there', async () => {
        listParcelPlaceOptions.mockResolvedValue([...FARM, P('p5', 'Парцел 5', 'Североизток')]);
        const out = await runTool(ctx, 'propose_treatment', JSON.stringify({
            kind: 'SPRAY', productName: 'Децис', doseValue: 0.05, doseUnit: 'л/дка',
            occurredOn: '2026-11-16', targetNote: 'листни въшки', blockName: 'северо',
        }));
        expect(out.proposal).toBeNull();
        expect(JSON.parse(out.content).unresolved[0].candidates).toHaveLength(2);
    });

    it('a complete record is proposed WHOLE, with the parcels the server resolved', async () => {
        const out = await runTool(ctx, 'propose_treatment', JSON.stringify({
            kind: 'SPRAY', productName: 'Децис', doseValue: 0.05, doseUnit: 'л/дка',
            occurredOn: '2026-11-16', targetNote: 'листни въшки', crop: 'пшеница',
        }));
        expect(out.ok).toBe(true);
        expect(out.proposal).toEqual({
            kind: 'treatment',
            draft: {
                kind: 'SPRAY', productName: 'Децис', doseValue: 0.05, occurredOn: '2026-11-16',
                targetNote: 'листни въшки', doseUnitLabel: 'л/дка',
                chosenParcels: [
                    { id: 'p1', label: 'Север · Парцел 1', crop: 'Wheat' },
                    { id: 'p2', label: 'Север · Парцел 2', crop: 'Wheat' },
                ],
            },
        });
        expect(assertModuleEnabled).toHaveBeenCalledWith(ctx, 'JOURNAL');
    });

    it('a field spanning two crops is asked about — one record is one crop', async () => {
        const out = await runTool(ctx, 'propose_treatment', JSON.stringify({
            kind: 'SPRAY', productName: 'Децис', doseValue: 0.05, doseUnit: 'л/дка',
            occurredOn: '2026-11-16', targetNote: 'листни въшки', parcelNumbers: ['Парцел 1', 'Парцел 3'],
        }));
        expect(out.proposal).toBeNull();
        const asked = JSON.parse(out.content).unresolved;
        expect(asked[0].candidates).toEqual(['Wheat', 'Canola']);
    });

    it('a parcel with no crop recorded is asked about, never proposed', async () => {
        listParcelPlaceOptions.mockResolvedValue([P('p9', 'Парцел 9', 'Изток')]);
        const out = await runTool(ctx, 'propose_treatment', JSON.stringify({
            kind: 'SPRAY', productName: 'Децис', doseValue: 0.05, doseUnit: 'л/дка',
            occurredOn: '2026-11-16', targetNote: 'листни въшки', blockName: 'Изток',
        }));
        expect(out.proposal).toBeNull();
        expect(JSON.parse(out.content).unresolved[0].candidates).toEqual(['Изток · Парцел 9']);
    });

    it('an id from the model is still refused', async () => {
        const out = await runTool(ctx, 'propose_treatment', JSON.stringify({ kind: 'SPRAY', parcelIds: ['p1'] }));
        expect(out.ok).toBe(false);
        expect(listParcelPlaceOptions).not.toHaveBeenCalled();
    });
});
