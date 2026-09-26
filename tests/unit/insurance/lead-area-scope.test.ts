/**
 * What the area COVERS, from the request body to the operator's inbox (#1121).
 *
 * "1,240 dca" is ambiguous on its own: one large parcel, or twelve wheat
 * parcels summed by the chip? The operator is being asked to price it, so the
 * answer travels with the figure — and it is DERIVED from the value at send
 * time rather than tracked through UI events, so it cannot drift out of step
 * with the number beside it.
 *
 * Copy is asserted against the real `messages/*.json`, in both languages,
 * because the recipient is an address from configuration whose mail is written
 * in Bulgarian by default.
 */
import { buildInsuranceLeadEmail } from '@/app-layer/notifications/templates';
import { CreateInsuranceLeadSchema } from '@/app-layer/schemas/insurance.schemas';
import en from '../../../messages/en.json';
import bg from '../../../messages/bg.json';

const QUOTE = {
    productKey: 'wheat',
    areaDca: 1240,
    sumInsuredCents: 12_400_000,
    tariffBp: 1000,
    premiumCents: 1_240_000,
    instalmentsCents: [1_240_000],
    premiumPerDcaCents: 1000,
    currencySymbol: '€',
};

const BASE = {
    tenantName: 'Агрент',
    tenantSlug: 'agrent',
    parcelName: '15655-19',
    locationName: 'Polje Sever',
    message: undefined,
};

describe('the area scope reaches the operator email', () => {
    it('names the crop and the parcel count for a crop-wide area, in English', async () => {
        const mail = await buildInsuranceLeadEmail(
            { ...BASE, quote: { ...QUOTE, areaScope: 'crop-at-location', coveredParcelCount: 12 } },
            'en',
        );
        // "1240 dca — all 12 Wheat parcels at Polje Sever". The crop comes from
        // the catalogue, so assert THAT rather than a hardcoded spelling.
        expect(mail.bodyText).toContain(
            `all 12 ${en.insurance.products.wheat.name} parcels at Polje Sever`,
        );
        expect(mail.bodyText).toContain('1240 dca');
    });

    it('does the same in Bulgarian, with the Bulgarian unit', async () => {
        const mail = await buildInsuranceLeadEmail(
            { ...BASE, quote: { ...QUOTE, areaScope: 'crop-at-location', coveredParcelCount: 12 } },
            'bg',
        );
        expect(mail.bodyText).toContain('1240 дка');
        // The crop name is translated too, not the raw product key.
        expect(mail.bodyText).toContain(bg.insurance.products.wheat.name);
        expect(mail.bodyText).toContain('Polje Sever');
        // The English unit must not survive into a Bulgarian mail.
        expect(mail.bodyText).not.toContain('1240 dca');
    });

    it('uses the singular for one covered parcel', async () => {
        const mail = await buildInsuranceLeadEmail(
            { ...BASE, quote: { ...QUOTE, areaScope: 'crop-at-location', coveredParcelCount: 1 } },
            'en',
        );
        expect(mail.bodyText).toContain(`all 1 ${en.insurance.products.wheat.name} parcel at`);
        expect(mail.bodyText).not.toContain('parcels at');
    });

    it('drops the "at …" half rather than dangling it when the location is unknown', async () => {
        const mail = await buildInsuranceLeadEmail(
            {
                ...BASE,
                locationName: null,
                quote: { ...QUOTE, areaScope: 'crop-at-location', coveredParcelCount: 12 },
            },
            'en',
        );
        expect(mail.bodyText).toContain(`all 12 ${en.insurance.products.wheat.name} parcels`);
        expect(mail.bodyText).not.toMatch(/parcels at\s*$/m);
        expect(mail.bodyText).not.toContain('at undefined');
        expect(mail.bodyText).not.toContain('at null');
    });

    it('marks a hand-typed area as such', async () => {
        const mail = await buildInsuranceLeadEmail(
            { ...BASE, quote: { ...QUOTE, areaScope: 'custom' } },
            'en',
        );
        expect(mail.bodyText).toContain(
            en.notificationEmail.insuranceLead.areaScopeCustom.replace('{area}', '1240 dca'),
        );
    });

    it('says nothing extra for a plain per-parcel area', async () => {
        const mail = await buildInsuranceLeadEmail(
            { ...BASE, quote: { ...QUOTE, areaScope: 'parcel' } },
            'en',
        );
        expect(mail.bodyText).toContain('1240 dca');
        expect(mail.bodyText).not.toContain('all ');
        expect(mail.bodyText).not.toContain('entered by hand');
    });

    it('treats a lead written before this field the same as per-parcel', async () => {
        // Every lead before #1121 was per-parcel; an absent scope must not
        // render as a missing translation or an empty clause.
        const mail = await buildInsuranceLeadEmail({ ...BASE, quote: QUOTE }, 'en');
        expect(mail.bodyText).toContain('1240 dca');
        expect(mail.bodyText).not.toContain('undefined');
        expect(mail.bodyText).not.toContain('notificationEmail.');
    });
});

describe('the schema guards the pair', () => {
    const body = (quote: Record<string, unknown>) => ({ parcelId: 'p1', quote });
    const VALID = {
        productKey: 'wheat',
        areaDca: 1240,
        sumInsuredCents: 12_400_000,
        instalments: 1,
    };

    it('rejects a crop-wide area with no parcel count', () => {
        // "1,240 dca" with nothing saying what it covers is the ambiguity this
        // whole field exists to remove, so it is a 400 rather than a default.
        const res = CreateInsuranceLeadSchema.safeParse(
            body({ ...VALID, areaScope: 'crop-at-location' }),
        );
        expect(res.success).toBe(false);
        if (!res.success) {
            expect(res.error.issues[0].path).toEqual(['quote', 'coveredParcelCount']);
        }
    });

    it('accepts a crop-wide area WITH a count', () => {
        expect(
            CreateInsuranceLeadSchema.safeParse(
                body({ ...VALID, areaScope: 'crop-at-location', coveredParcelCount: 12 }),
            ).success,
        ).toBe(true);
    });

    it('accepts the other scopes without a count, and an absent scope', () => {
        for (const areaScope of ['parcel', 'custom'] as const) {
            expect(CreateInsuranceLeadSchema.safeParse(body({ ...VALID, areaScope })).success).toBe(true);
        }
        expect(CreateInsuranceLeadSchema.safeParse(body(VALID)).success).toBe(true);
    });

    it('rejects a nonsense scope and a non-positive count', () => {
        expect(CreateInsuranceLeadSchema.safeParse(body({ ...VALID, areaScope: 'whole-farm' })).success).toBe(false);
        expect(
            CreateInsuranceLeadSchema.safeParse(
                body({ ...VALID, areaScope: 'crop-at-location', coveredParcelCount: 0 }),
            ).success,
        ).toBe(false);
    });
});
