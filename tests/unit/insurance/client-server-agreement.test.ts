/**
 * The browser and the server must reach the SAME figure.
 *
 * The wizard shows a live premium as the farmer types; the server recomputes it
 * and that recomputation is what gets stored and emailed. If the two ever
 * disagree, the farmer is shown one price and the operator quotes another — and
 * nothing in the system would report it, because each side is internally
 * consistent.
 *
 * The flow is split the way production splits it:
 *
 *   CLIENT  raw text -> parseAreaDca / parseMoneyToCents -> quotePremium
 *   SERVER  parsed numbers over the wire -> createInsuranceLead -> quoteJson
 *
 * So the parse step is asserted too: the wire carries NUMBERS, so a parser that
 * read "12,345" as twelve thousand would agree with the server perfectly and
 * still be wrong. Both halves are pinned.
 *
 * Case C is the one that matters most: €37,500.55 at 10 % lands exactly on
 * 375,005.5 cents, so it exercises round-half-up, and 375,006 over four
 * instalments leaves TWO cents that both go on the first.
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
jest.mock('@/lib/security/sanitize', () => ({ sanitizePlainText: (v: string) => v }));
jest.mock('@/env', () => ({ env: {} }));

import {
    formatCents,
    getProduct,
    parseAreaDca,
    parseMoneyToCents,
    quotePremium,
    type InstalmentCount,
} from '@/lib/insurance';
import { createInsuranceLead } from '@/app-layer/usecases/insurance';
import { makeRequestContext } from '../../helpers/make-context';

const CTX = makeRequestContext('EDITOR', { tenantId: 't1', userId: 'u1' });

interface Reference {
    label: string;
    areaRaw: string;
    sumRaw: string;
    instalments: InstalmentCount;
    /** What the farmer's typing MEANS, asserted so the parsers are pinned too. */
    areaDca: number;
    sumInsuredCents: number;
    premium: string;
    perDca: string;
    schedule: string[];
}

const CASES: Reference[] = [
    {
        label: 'A — the round case',
        areaRaw: '1000',
        sumRaw: '100 000',
        instalments: 3,
        areaDca: 1000,
        sumInsuredCents: 10_000_000,
        premium: '€10,000.00',
        perDca: '€10.00',
        schedule: ['€3,333.34', '€3,333.33', '€3,333.33'],
    },
    {
        label: 'B — a fractional AREA, where "," is a decimal point',
        areaRaw: '12,345',
        sumRaw: '3 000',
        instalments: 2,
        // 12.345 dca, NOT twelve thousand. The asymmetry is deliberate: for
        // MONEY a single separator with three digits means thousands, for AREA
        // both "," and "." are always decimal.
        areaDca: 12.345,
        sumInsuredCents: 300_000,
        premium: '€300.00',
        perDca: '€24.30',
        schedule: ['€150.00', '€150.00'],
    },
    {
        label: 'C — round-half-up, and two leftover cents',
        areaRaw: '250',
        sumRaw: '37 500,55',
        instalments: 4,
        // Space for thousands AND comma for decimals, in one figure.
        areaDca: 250,
        sumInsuredCents: 3_750_055,
        premium: '€3,750.06',
        perDca: '€15.00',
        schedule: ['€937.53', '€937.51', '€937.51', '€937.51'],
    },
];

/** Exactly what `useInsuranceQuote` does, in the same order. */
function clientPath(c: Reference) {
    const areaDca = parseAreaDca(c.areaRaw);
    const sumInsuredCents = parseMoneyToCents(c.sumRaw);
    const product = getProduct('wheat');
    expect(areaDca).not.toBeNull();
    expect(sumInsuredCents).not.toBeNull();
    expect(product).toBeDefined();
    const q = quotePremium({
        areaDca: areaDca!,
        sumInsuredCents: sumInsuredCents!,
        tariffBp: product!.tariffBp,
        instalments: c.instalments,
    });
    if (!q.ok) throw new Error(`client refused: ${q.reason}`);
    return { areaDca: areaDca!, sumInsuredCents: sumInsuredCents!, quote: q };
}

/** The server's own recomputation, read back off the stored snapshot. */
async function serverPath(c: Reference, areaDca: number, sumInsuredCents: number) {
    mockDb.insuranceLead.create.mockResolvedValue({ id: 'lead-1' });
    mockDb.tenant.findUnique.mockResolvedValue({ name: 'T', slug: 't', currencySymbol: '€' });
    mockDb.parcel.findFirst.mockResolvedValue({ name: 'p', cropType: 'wheat', areaHa: 1, location: null });

    await createInsuranceLead(CTX, {
        parcelId: 'p1',
        quote: {
            productKey: 'wheat',
            areaDca,
            sumInsuredCents,
            instalments: c.instalments,
        },
    });

    const arg = mockDb.insuranceLead.create.mock.calls.at(-1)?.[0] as
        | { data?: { quoteJson?: Record<string, unknown> } }
        | undefined;
    const stored = arg?.data?.quoteJson;
    expect(stored).toBeDefined();
    return stored as Record<string, number | number[]>;
}

describe('the browser preview and the stored figure agree', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it.each(CASES.map((c) => [c.label, c] as const))('%s', async (_label, c) => {
        const client = clientPath(c);

        // 1. The parsers read the farmer's typing the way the reference says.
        expect(client.areaDca).toBe(c.areaDca);
        expect(client.sumInsuredCents).toBe(c.sumInsuredCents);

        // 2. The client's own figures are the reference figures — as STRINGS,
        //    because a farmer reads the rendered amount, not the integer.
        expect(formatCents(client.quote.premiumCents)).toBe(c.premium);
        expect(formatCents(client.quote.premiumPerDcaCents)).toBe(c.perDca);
        expect(client.quote.instalmentsCents.map((n) => formatCents(n))).toEqual(c.schedule);

        // 3. The server, given the same parsed inputs, records the same thing.
        const stored = await serverPath(c, client.areaDca, client.sumInsuredCents);
        expect(stored.premiumCents).toBe(client.quote.premiumCents);
        expect(stored.premiumPerDcaCents).toBe(client.quote.premiumPerDcaCents);
        expect(stored.tariffBp).toBe(client.quote.tariffBp);
        expect(stored.instalmentsCents).toEqual(client.quote.instalmentsCents);
        expect(stored.areaDca).toBe(client.areaDca);
        expect(stored.sumInsuredCents).toBe(client.sumInsuredCents);

        // …and the strings the operator reads match the farmer's screen.
        expect(formatCents(stored.premiumCents as number)).toBe(c.premium);
        expect((stored.instalmentsCents as number[]).map((n) => formatCents(n))).toEqual(c.schedule);
    });

    it('the instalments always sum back to the premium exactly', () => {
        // The property behind the leftover cents: parts must reconstruct the
        // total, or the farmer pays a different amount than they were quoted.
        for (const c of CASES) {
            const { quote } = clientPath(c);
            const sum = quote.instalmentsCents.reduce((a, b) => a + b, 0);
            expect(sum).toBe(quote.premiumCents);
        }
    });
});
