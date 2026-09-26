/**
 * Adversarial pass over `POST /t/{slug}/insurance/leads` (#1122).
 *
 * The property throughout is **400, never 500**. A malformed body is the
 * client's fault and must come back as a refusal it can act on; a 500 would
 * mean the server tried to compute money out of nonsense and fell over. The
 * native clients render the raw envelope, so the difference is what a farmer
 * actually sees.
 *
 * Coverage note — these were already pinned by earlier steps and are NOT
 * duplicated here:
 *   • replay returns the original lead, and two tenants' identical keys stay
 *     separate  → tests/integration/insurance-lead-quote.test.ts
 *   • offline disables Send, a failed send keeps every input, and the client
 *     sends no price at all  → tests/rendered/insurance-quote-wizard.test.tsx
 */
import { NextRequest } from 'next/server';

const getTenantCtxMock = jest.fn();
const createLeadMock = jest.fn();

jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));
jest.mock('@/app-layer/usecases/insurance', () => ({
    __esModule: true,
    createInsuranceLead: (...a: unknown[]) => createLeadMock(...a),
    listInquiredParcelIds: jest.fn(),
}));

import { POST } from '@/app/api/t/[tenantSlug]/insurance/leads/route';
import { isOperatorAllowedPath } from '@/lib/auth/guard';

const VALID_QUOTE = {
    productKey: 'wheat',
    areaDca: 1000,
    sumInsuredCents: 10_000_000,
    instalments: 1,
};

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const req = new NextRequest('http://localhost/api/t/acme/insurance/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
    return POST(req, { params: Promise.resolve({ tenantSlug: 'acme' }) } as never) as Promise<Response>;
}

beforeEach(() => {
    jest.clearAllMocks();
    getTenantCtxMock.mockResolvedValue({ tenantId: 't1', userId: 'u1', requestId: 'r1', role: 'OWNER' });
    createLeadMock.mockResolvedValue({ id: 'lead-1', status: 'PENDING' });
});

describe('a malformed quote is a 400, never a 500', () => {
    // Each of these reaches money arithmetic if it gets through. `1e12` is over
    // both caps; `"12"` is the shape a form sends when a field is not coerced.
    const BAD_AREAS: Array<[string, unknown]> = [
        ['zero', 0],
        ['negative', -1],
        ['absurdly large', 1e12],
        ['null', null],
        ['a numeric STRING', '12'],
    ];

    it.each(BAD_AREAS)('areaDca %s → 400', async (_label, areaDca) => {
        const res = await post({ parcelId: 'p1', quote: { ...VALID_QUOTE, areaDca } });
        expect(res.status).toBe(400);
    });

    it.each([
        ['fractional cents', 1.5],
        ['over the cap', 1e12],
        ['zero', 0],
    ])('sumInsuredCents %s → 400', async (_label, sumInsuredCents) => {
        const res = await post({ parcelId: 'p1', quote: { ...VALID_QUOTE, sumInsuredCents } });
        expect(res.status).toBe(400);
    });

    it.each([['5', 5], ['0', 0], ['fractional', 2.5]])(
        'instalments %s → 400',
        async (_label, instalments) => {
            const res = await post({ parcelId: 'p1', quote: { ...VALID_QUOTE, instalments } });
            expect(res.status).toBe(400);
        },
    );

    it('an unknown product key → 400', async () => {
        const res = await post({ parcelId: 'p1', quote: { ...VALID_QUOTE, productKey: 'avocado' } });
        expect(res.status).toBe(400);
    });

    it('never reaches the usecase for any of them', async () => {
        // The point of validating at the edge: nothing malformed gets as far as
        // the code that multiplies cents by basis points.
        await post({ parcelId: 'p1', quote: { ...VALID_QUOTE, areaDca: -1 } });
        await post({ parcelId: 'p1', quote: { ...VALID_QUOTE, sumInsuredCents: 1.5 } });
        expect(createLeadMock).not.toHaveBeenCalled();
    });

    it('a body with neither a message nor a quote → 400', async () => {
        expect((await post({ parcelId: 'p1' })).status).toBe(400);
    });
});

describe('the Idempotency-Key is bounded before it reaches a WHERE clause', () => {
    it('accepts a normal UUID', async () => {
        const res = await post(
            { parcelId: 'p1', quote: VALID_QUOTE },
            { 'Idempotency-Key': '7f1d3c2e-9b40-4a5e-8f61-2c9d0e5a7b31' },
        );
        expect(res.status).toBe(201);
        expect(createLeadMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            '7f1d3c2e-9b40-4a5e-8f61-2c9d0e5a7b31',
        );
    });

    it('rejects 129 characters — one past the cap', async () => {
        const res = await post({ parcelId: 'p1', quote: VALID_QUOTE }, { 'Idempotency-Key': 'a'.repeat(129) });
        expect(res.status).toBe(400);
        expect(createLeadMock).not.toHaveBeenCalled();
    });

    it('accepts exactly 128 — the boundary is inclusive', async () => {
        const res = await post({ parcelId: 'p1', quote: VALID_QUOTE }, { 'Idempotency-Key': 'a'.repeat(128) });
        expect(res.status).toBe(201);
    });

    it.each([
        ['a space', 'key with space'],
        ['a quote character', "key'or'1'='1"],
        ['a percent sign', 'key%25'],
        ['empty', ''],
    ])('rejects %s', async (_label, key) => {
        const res = await post({ parcelId: 'p1', quote: VALID_QUOTE }, { 'Idempotency-Key': key });
        expect(res.status).toBe(400);
        expect(createLeadMock).not.toHaveBeenCalled();
    });

    it('treats an absent header as "no key" rather than an error', async () => {
        const res = await post({ parcelId: 'p1', quote: VALID_QUOTE });
        expect(res.status).toBe(201);
        expect(createLeadMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), null);
    });
});

describe('the MECHANISATOR lockdown is unchanged', () => {
    // The calculator lives on Farm risk, which the sprayer must not reach. The
    // allowlist is an inclusion list, so this stays true by omission — and this
    // test is what makes ADDING it a failure rather than a silent widening.
    it('cannot open the Farm risk page', () => {
        expect(isOperatorAllowedPath('/t/acme/farm-risk', 'acme')).toBe(false);
    });

    it('cannot call the insurance API', () => {
        expect(isOperatorAllowedPath('/api/t/acme/insurance/leads', 'acme')).toBe(false);
        expect(isOperatorAllowedPath('/api/t/acme/insurance/leads?x=1', 'acme')).toBe(false);
    });

    it('is not vacuous — the paths a sprayer DOES need still pass', () => {
        // Without this, a guard that returned false for everything would look
        // just as green.
        expect(isOperatorAllowedPath('/t/acme/my-work', 'acme')).toBe(true);
        expect(isOperatorAllowedPath('/api/t/acme/locations/l1/parcels', 'acme')).toBe(true);
    });
});
