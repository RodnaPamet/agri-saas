/**
 * A ДНЕВНИК leaves out a data section with nothing in it, and keeps the two
 * that arrive blank by design (#2183, owner ruling 2026-10-23).
 *
 * ## Why these tests count PAGES
 *
 * The obvious test — render, then search the buffer for «ПРОВЕДЕНИ ХИМИЧНИ
 * ОБРАБОТКИ» — cannot work, and this suite's sibling already paid for finding
 * out: once a Unicode font is embedded PDFKit writes text as GLYPH INDICES, so
 * a buffer search finds nothing whether the section rendered or not. A version
 * of the `fmtDate` test did exactly that and passed with its guard removed.
 *
 * Each section opens with `doc.addPage(...)`, so `bufferedPageRange().count` is
 * a real observable for "is the section in the document" — and it is also what
 * a farmer sees, because the difference is pages they hold.
 *
 * ## The distinction the ruling turns on
 *
 * Five sections. THREE carry data: observations, chemical treatments,
 * fertilizers. TWO are ruled forms that arrive EMPTY on purpose — the sampling
 * sheet and the ОДБХ inspector result — for completion by hand.
 *
 * "Omit empty sections" applies to the first three only. Dropping the other
 * two because they have no rows would remove the parts of the document that
 * are supposed to be blank, which is the opposite of what the ruling asked
 * for. These tests pin that, because nothing in the phrase "omit empty
 * sections" distinguishes them.
 */
import { createPdfDocument } from '@/lib/pdf/pdfKitFactory';
import {
    renderFarmRecordDiary,
    BG_LABELS,
    isRegisterEmpty,
    type FarmRecordData,
} from '@/app-layer/reports/pdf/farm-record-diary';

function doc() {
    return createPdfDocument({
        tenantName: 'Северна нива',
        reportTitle: 'Дневник',
        generatedAt: new Date(0).toISOString(),
        fontFamily: 'unicode',
    });
}

const PROFILE = {
    producerName: 'ЕТ Иван Иванов',
    egn: null,
    eik: '123456789',
    address: 'ул. Полска 1',
    municipality: 'Луковит',
    settlement: 'Дерманци',
    agricultureDirectorateCity: 'Ловеч',
    registrationPlace: 'Ловеч',
    registrationEkatte: '20688',
    odbhCity: 'Ловеч',
};

const FIELD = {
    parcelId: 'p1',
    fieldNo: '001',
    cadastralId: '20688.1.1',
    landDistrict: 'Дерманци',
    locality: 'ЛЕШНИЦА',
    produceStore: null,
    cropType: 'Пшеница',
    variety: null,
    areaHa: 12.5,
    predecessor: null,
    sowDate: null,
};

const SPRAY = {
    parcelId: 'p1',
    occurredAt: new Date('2026-03-04T00:00:00.000Z'),
    cropType: 'Пшеница',
    treatedAreaHa: 12.5,
    productName: 'Карате Зеон',
    activeIngredient: 'ламбда-цихалотрин',
    doseText: '0.15 л/дка',
    pest: 'Житна пиявица',
    technique: 'ground_boom',
    operatorName: 'Иван',
    operatorCertNo: 'BG-123',
    quarantinePeriodDays: 30,
    phenophase: null,
};

const FERT = {
    occurredAt: new Date('2026-03-05T00:00:00.000Z'),
    cropType: 'Пшеница',
    productName: 'Амониев нитрат',
    doseText: '20 кг/дка',
    areaHa: 12.5,
};

const OBS = {
    occurredAt: new Date('2026-03-02T00:00:00.000Z'),
    cropType: 'Пшеница',
    pest: 'Житна пиявица',
    note: 'Единични екземпляри',
    derived: false,
};

function data(over: Partial<FarmRecordData> = {}): FarmRecordData {
    return {
        locationName: 'Дерманци',
        from: '2026-03-01',
        to: '2026-03-31',
        profile: PROFILE,
        sprayLines: [],
        fertilizeLines: [],
        observations: [],
        fields: [FIELD],
        ...over,
    } as FarmRecordData;
}

function pageCount(d: FarmRecordData): number {
    const pdf = doc();
    renderFarmRecordDiary(pdf, d, BG_LABELS);
    return pdf.bufferedPageRange().count;
}

/**
 * Cover + sampling + ОДБХ. The floor a document never goes below, because the
 * last two are blank BY DESIGN and the cover carries the farm header.
 */
const STRUCTURAL_PAGES = 3;

describe('ДНЕВНИК omits an empty data section (#2183)', () => {
    it('a register with all three data sections is the longest', () => {
        const full = pageCount(
            data({ sprayLines: [SPRAY], fertilizeLines: [FERT], observations: [OBS] } as Partial<FarmRecordData>),
        );
        // cover + observations + one chemical sheet + fertilizers + sampling + ОДБХ
        expect(full).toBe(STRUCTURAL_PAGES + 3);
    });

    it('drops the OBSERVATIONS page when nothing was observed', () => {
        const withObs = pageCount(
            data({ sprayLines: [SPRAY], observations: [OBS] } as Partial<FarmRecordData>),
        );
        const without = pageCount(data({ sprayLines: [SPRAY] } as Partial<FarmRecordData>));
        expect(withObs - without).toBe(1);
    });

    it('drops the FERTILIZER page when nothing was applied', () => {
        const withFert = pageCount(
            data({ sprayLines: [SPRAY], fertilizeLines: [FERT] } as Partial<FarmRecordData>),
        );
        const without = pageCount(data({ sprayLines: [SPRAY] } as Partial<FarmRecordData>));
        expect(withFert - without).toBe(1);
    });

    it('drops every CHEMICAL sheet when nothing was sprayed, rather than filing a blank one', () => {
        // `groupSprayLinesByField` manufactures one blank group for an idle
        // period — its own comment says so — which is exactly the behaviour the
        // ruling reverses. With no spray lines the section must not appear at
        // all, not appear once and empty.
        const sprayed = pageCount(data({ sprayLines: [SPRAY], observations: [OBS] } as Partial<FarmRecordData>));
        const notSprayed = pageCount(data({ observations: [OBS] } as Partial<FarmRecordData>));
        expect(sprayed - notSprayed).toBe(1);
    });

    it('KEEPS the sampling and ОДБХ sheets, which are blank by design', () => {
        // The one case the phrase "omit empty sections" would get wrong. A
        // document with a single observation and nothing else must still carry
        // the two ruled forms an inspector writes on — so cover + observations
        // + those two.
        expect(pageCount(data({ observations: [OBS] } as Partial<FarmRecordData>))).toBe(
            STRUCTURAL_PAGES + 1,
        );
    });

    it('a chemical sheet PER FIELD survives the change', () => {
        // The per-field split is the thing #1740 built and this must not undo:
        // two treated fields are two sheets, not one combined table.
        const second = { ...FIELD, parcelId: 'p2', fieldNo: '002' };
        const twoFields = pageCount(
            data({
                fields: [FIELD, second],
                sprayLines: [SPRAY, { ...SPRAY, parcelId: 'p2' }],
            } as Partial<FarmRecordData>),
        );
        const oneField = pageCount(data({ sprayLines: [SPRAY] } as Partial<FarmRecordData>));
        expect(twoFields - oneField).toBe(1);
    });
});

describe('isRegisterEmpty', () => {
    it('is true when all three data sections are empty', () => {
        expect(isRegisterEmpty(data())).toBe(true);
    });

    it('does NOT count `fields` — a block has parcels whether or not anything happened', () => {
        // The check would be inert otherwise: every block has fields, so
        // counting them would make `isRegisterEmpty` return false always, which
        // is a gate that cannot fail.
        expect(isRegisterEmpty(data({ fields: [FIELD, { ...FIELD, parcelId: 'p2' }] }))).toBe(true);
    });

    it('is false when any ONE data section has a row', () => {
        expect(isRegisterEmpty(data({ sprayLines: [SPRAY] } as Partial<FarmRecordData>))).toBe(false);
        expect(isRegisterEmpty(data({ fertilizeLines: [FERT] } as Partial<FarmRecordData>))).toBe(false);
        expect(isRegisterEmpty(data({ observations: [OBS] } as Partial<FarmRecordData>))).toBe(false);
    });
});
