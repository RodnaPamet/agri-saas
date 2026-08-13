/**
 * ONE vocabulary for "this number is not what it appears".
 *
 * The calculator spoke four dialects at once: an em-dash plus a
 * server-authored English sentence for a refusal, a badge plus a sentence
 * for an allocation, a count plus an accordion for exclusions, and a
 * header-description takeover for truncation. Each is defensible alone;
 * together they are four languages on one screen, and a reader has to
 * learn each separately.
 *
 * The states below are that vocabulary. The direction matters and is the
 * reason there are two bounded states rather than one: when consumptions
 * could not be priced, `cashCostTotal` is a FLOOR — the cost is AT LEAST
 * X — and since net worth is assets minus cost, the net is AT MOST Y.
 * Labelling a floor "at most" would be plainly wrong, so the cost line and
 * the headline carry opposite bounds from the same cause.
 */
import {
    UNCERTAINTY,
    costIsFloor,
    costUncertainty,
    netWorthUncertainty,
    isKnownRefusalCode,
    explainRefusal,
    NET_WORTH_REFUSAL_CODES,
} from '@/lib/grain/uncertainty';

const exact = {
    unvaluedNoUnitCost: 0,
    unvaluedUnitMismatch: 0,
    payrollAllocated: false,
    netWorth: 18_750 as number | null,
};

describe('costIsFloor', () => {
    it('is false when every consumption was priced', () => {
        expect(costIsFloor(exact)).toBe(false);
    });

    it('is true when a consumption had no unit cost', () => {
        expect(costIsFloor({ ...exact, unvaluedNoUnitCost: 2 })).toBe(true);
    });

    it('is true when a lot’s unit did not match the product’s', () => {
        expect(costIsFloor({ ...exact, unvaluedUnitMismatch: 1 })).toBe(true);
    });
});

describe('netWorthUncertainty', () => {
    it('is EXACT when nothing qualifies the figure', () => {
        expect(netWorthUncertainty(exact)).toBe(UNCERTAINTY.EXACT);
    });

    it('is AT_MOST when the cost underneath it is a floor', () => {
        // THE BUG THIS EXISTS FOR. An unpriced consumption makes cost a
        // floor, so net worth is a MAXIMUM — and the page printed it as a
        // definite figure with the caveat two surfaces away, under a
        // panel's cost line.
        expect(netWorthUncertainty({ ...exact, unvaluedNoUnitCost: 3 })).toBe(
            UNCERTAINTY.AT_MOST,
        );
    });

    it('is REFUSED when the usecase withheld the figure', () => {
        expect(netWorthUncertainty({ ...exact, netWorth: null })).toBe(UNCERTAINTY.REFUSED);
    });

    it('reports REFUSED even when the cost is also a floor', () => {
        // There is no figure to bound. Claiming "at most —" would be noise
        // on top of a refusal.
        expect(
            netWorthUncertainty({ ...exact, netWorth: null, unvaluedNoUnitCost: 3 }),
        ).toBe(UNCERTAINTY.REFUSED);
    });
});

describe('costUncertainty', () => {
    it('is AT_LEAST — the opposite bound to the net it feeds', () => {
        // Same cause, opposite direction. Cost ≥ X ⇒ net ≤ assets − X.
        const row = { ...exact, unvaluedUnitMismatch: 1 };
        expect(costUncertainty(row)).toBe(UNCERTAINTY.AT_LEAST);
        expect(netWorthUncertainty(row)).toBe(UNCERTAINTY.AT_MOST);
    });

    it('is ALLOCATED when payroll was apportioned rather than measured', () => {
        expect(costUncertainty({ ...exact, payrollAllocated: true })).toBe(
            UNCERTAINTY.ALLOCATED,
        );
    });

    it('prefers the BOUND over the allocation when both apply', () => {
        // An apportioned share of a total that is itself incomplete is
        // still, first, incomplete. The allocation is said too — in its
        // own treatment — but the bound is what qualifies the number.
        expect(
            costUncertainty({ ...exact, payrollAllocated: true, unvaluedNoUnitCost: 1 }),
        ).toBe(UNCERTAINTY.AT_LEAST);
    });

    it('is EXACT otherwise', () => {
        expect(costUncertainty(exact)).toBe(UNCERTAINTY.EXACT);
    });
});

describe('explainRefusal — no refusal renders bare', () => {
    const translate = (key: string, values?: Record<string, string>) =>
        `T:${key}${values && Object.keys(values).length ? ` ${JSON.stringify(values)}` : ''}`;

    it('translates a recognised code, passing its parameters through', () => {
        expect(
            explainRefusal('NO_MARKET_PRICE', { commodity: 'maize' }, 'English fallback', translate),
        ).toBe('T:refusal.NO_MARKET_PRICE {"commodity":"maize"}');
    });

    it('falls back to the server English for an UNRECOGNISED code', () => {
        // The property that matters. An older bundle against a newer
        // server meets a code it has never heard of; it must still say
        // WHY the figure is missing rather than show a bare em-dash.
        expect(
            explainRefusal(
                'SOME_FUTURE_REASON',
                { x: '1' },
                'Cash costs were recorded in more than one currency.',
                translate,
            ),
        ).toBe('Cash costs were recorded in more than one currency.');
    });

    it('falls back when the payload carries no code at all', () => {
        expect(explainRefusal(null, null, 'No market price is available.', translate)).toBe(
            'No market price is available.',
        );
    });

    it('never invents an explanation it was not given', () => {
        // Null in, null out — the caller renders nothing rather than a
        // fabricated reason. The usecase contract is what guarantees this
        // case cannot occur alongside a null netWorth.
        expect(explainRefusal(null, null, null, translate)).toBeNull();
    });
});

describe('isKnownRefusalCode', () => {
    it('accepts every code the usecase can emit', () => {
        for (const code of NET_WORTH_REFUSAL_CODES) {
            expect(isKnownRefusalCode(code)).toBe(true);
        }
    });

    it('rejects an unknown code, so the caller falls back to the English', () => {
        // The fallback is the property that matters: a refusal is ALWAYS
        // explained. A code this client has never heard of must not
        // produce a bare em-dash.
        expect(isKnownRefusalCode('SOME_FUTURE_REASON')).toBe(false);
        expect(isKnownRefusalCode(null)).toBe(false);
        expect(isKnownRefusalCode(undefined)).toBe(false);
        expect(isKnownRefusalCode('')).toBe(false);
    });
});
