/**
 * What happens when the input is hostile (#1122).
 *
 * Two separate defences, and they are asserted separately because each fails
 * differently:
 *
 *  • **The client cannot name its own price.** `.strip()` on the quote object
 *    drops anything that is not one of the four inputs, and the server
 *    recomputes. A client sending `premiumCents: 1` must not get insured for a
 *    penny.
 *  • **Text a farmer typed is neutralised twice.** `sanitizePlainText` on the
 *    way into the row, and `escapeHtml` at every render site in the mail. The
 *    second matters even if the first is perfect, because the operator's mail
 *    client is the thing executing the HTML.
 *
 * The real `sanitizePlainText` runs here — mocking it to identity, as the
 * operator-email suite does, would make this file prove nothing.
 */
const enqueueEmail = jest.fn(async () => ({ id: 'n1', dedupeKey: 'k' }));
jest.mock('../../../src/app-layer/notifications/enqueue', () => ({
    enqueueEmail: (...a: unknown[]) => enqueueEmail(...(a as [])),
}));

const mockDb = {
    insuranceLead: { create: jest.fn(), findFirst: jest.fn() },
    tenant: { findUnique: jest.fn() },
    parcel: { findFirst: jest.fn() },
    notification: { create: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_c: unknown, fn: (db: unknown) => unknown) => fn(mockDb),
}));
jest.mock('../../../src/app-layer/policies/common', () => ({
    assertCanRead: jest.fn(),
    assertCanWrite: jest.fn(),
}));
jest.mock('../../../src/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/env', () => ({ env: { INSURANCE_LEAD_NOTIFY_EMAIL: 'ops@example.test' } }));

import { createInsuranceLead } from '@/app-layer/usecases/insurance';
import { buildInsuranceLeadEmail } from '@/app-layer/notifications/templates';
import { CreateInsuranceLeadSchema } from '@/app-layer/schemas/insurance.schemas';
import { makeRequestContext } from '../../helpers/make-context';

const CTX = makeRequestContext('EDITOR', { tenantId: 't1', userId: 'u1' });
const XSS = '<script>alert(document.cookie)</script>';

function storedRow(): Record<string, unknown> {
    const call = mockDb.insuranceLead.create.mock.calls.at(-1)?.[0] as { data?: Record<string, unknown> };
    expect(call?.data).toBeDefined();
    return call!.data!;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.insuranceLead.create.mockResolvedValue({ id: 'lead-1' });
    mockDb.tenant.findUnique.mockResolvedValue({ name: 'T', slug: 't', currencySymbol: '€' });
    mockDb.parcel.findFirst.mockResolvedValue({ name: 'p', cropType: 'wheat', areaHa: 1, location: null });
});

describe('a client cannot name its own price', () => {
    it('strips a premium, tariff and schedule from the body and recomputes', async () => {
        const parsed = CreateInsuranceLeadSchema.parse({
            parcelId: 'p1',
            quote: {
                productKey: 'wheat',
                areaDca: 1000,
                sumInsuredCents: 10_000_000,
                instalments: 1,
                // All three are fabrications a client has no business sending.
                premiumCents: 1,
                tariffBp: 1,
                instalmentsCents: [1],
            },
        });

        // The schema drops them before the usecase ever sees them.
        expect(parsed.quote).not.toHaveProperty('premiumCents');
        expect(parsed.quote).not.toHaveProperty('tariffBp');
        expect(parsed.quote).not.toHaveProperty('instalmentsCents');

        await createInsuranceLead(CTX, parsed);
        const quoteJson = storedRow().quoteJson as Record<string, unknown>;
        // €100,000 at the wheat tariff is €10,000.00 — the server's figure.
        expect(quoteJson.premiumCents).toBe(1_000_000);
        expect(quoteJson.tariffBp).toBe(1000);
        expect(quoteJson.instalmentsCents).toEqual([1_000_000]);
    });
});

describe('hostile text is neutralised on the way in', () => {
    it('sanitises a script tag out of the stored note', async () => {
        await createInsuranceLead(CTX, {
            parcelId: 'p1',
            message: `${XSS}I need hail cover`,
            quote: { productKey: 'wheat', areaDca: 1000, sumInsuredCents: 10_000_000, instalments: 1 },
        });
        const message = storedRow().message as string;
        expect(message).not.toContain('<script');
        expect(message).not.toContain('</script>');
        // …and the farmer's actual words survive; sanitising is not deleting.
        expect(message).toContain('I need hail cover');
    });
});

describe('the mail escapes everything it renders', () => {
    const BASE = {
        tenantName: 'T',
        tenantSlug: 't',
        parcelName: 'p',
        locationName: 'L',
        quote: {
            productKey: 'wheat',
            areaDca: 1000,
            sumInsuredCents: 10_000_000,
            tariffBp: 1000,
            premiumCents: 1_000_000,
            instalmentsCents: [1_000_000],
            premiumPerDcaCents: 1000,
            currencySymbol: '€',
        },
    };

    it('escapes a script tag in the note rather than emitting it', async () => {
        const mail = await buildInsuranceLeadEmail({ ...BASE, message: XSS }, 'en');
        expect(mail.bodyHtml).not.toContain('<script>');
        expect(mail.bodyHtml).toContain('&lt;script&gt;');
    });

    it('escapes the product name too — defence in depth', async () => {
        // The catalogue is trusted, so this can only happen via a bad key. The
        // template must still not be the thing that executes it: an unresolved
        // key comes back as its own path, and that path is attacker-shaped here.
        const mail = await buildInsuranceLeadEmail(
            {
                ...BASE,
                message: 'hello',
                quote: { ...BASE.quote, productKey: '<img src=x onerror=alert(1)>' },
            },
            'en',
        );
        expect(mail.bodyHtml).not.toContain('<img src=x');
        expect(mail.bodyHtml).toContain('&lt;img');
    });

    it('escapes the parcel and location names, which are farmer-typed', async () => {
        const mail = await buildInsuranceLeadEmail(
            { ...BASE, message: 'hello', parcelName: XSS, locationName: XSS },
            'en',
        );
        expect(mail.bodyHtml).not.toContain('<script>');
        expect(mail.bodyHtml).toContain('&lt;script&gt;');
    });

    it('leaves the plain-text body unescaped, which is correct for text/plain', async () => {
        // The text part is not HTML, so escaping it would show entities to the
        // operator. Asserting it PINS the split rather than leaving it ambiguous.
        const mail = await buildInsuranceLeadEmail({ ...BASE, message: XSS }, 'en');
        expect(mail.bodyText).toContain(XSS);
        expect(mail.bodyText).not.toContain('&lt;script&gt;');
    });
});
