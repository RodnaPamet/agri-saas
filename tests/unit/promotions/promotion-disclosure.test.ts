/**
 * The ПРЗ withholding, which is the whole compliance control.
 *
 * A unit test rather than an integration one on purpose: `Promotion` is
 * tenantless and has no RLS arm, so there is no policy behaviour a real
 * database would add here. What matters is the DECISION — whether a row is
 * returned at all — and that is pure logic over the configured wording.
 */
const findMany = jest.fn();

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: { promotion: { findMany } } }));

// `env` from @t3-oss/env-nextjs is a PROXY with zero own keys: spreading it
// (`{ ...actual.env, X }`) yields an EMPTY object, so every other variable
// reads `undefined` and unrelated modules break in confusing ways. Wrap and
// forward instead — the documented shape for overriding one key.
let wordingOverride: string | undefined;
jest.mock('@/env', () => {
    const actual = jest.requireActual('@/env');
    return {
        env: new Proxy(actual.env, {
            get: (t, k) => (k === 'PPP_ADVERTISING_SAFETY_BG' ? wordingOverride : Reflect.get(t, k)),
        }),
    };
});

import { promotionDisclosures, isPppDisclosureConfigured } from '@/app-layer/usecases/promotion-disclosure';

const FERTILISER = { id: 'p-fert', pppRegistrationNo: null, company: { name: 'Агро ООД' } };
const PESTICIDE = { id: 'p-ppp', pppRegistrationNo: '01234-ПРЗ', company: { name: 'Химия АД' } };

beforeEach(() => {
    findMany.mockReset();
    wordingOverride = undefined;
});

describe('promotionDisclosures', () => {
    it('WITHHOLDS a ПРЗ promotion when no wording is configured', async () => {
        findMany.mockResolvedValue([FERTILISER, PESTICIDE]);
        const out = await promotionDisclosures(['p-fert', 'p-ppp']);
        // Fewer rows than asked for. The caller must read a missing id as "do
        // not show", never as "show it without the disclosure".
        expect(out.map((r) => r.id)).toEqual(['p-fert']);
        expect(isPppDisclosureConfigured()).toBe(false);
    });

    it('returns the ПРЗ promotion once the wording IS configured', async () => {
        wordingOverride = 'Използвайте продуктите за растителна защита безопасно.';
        findMany.mockResolvedValue([FERTILISER, PESTICIDE]);
        const out = await promotionDisclosures(['p-fert', 'p-ppp']);
        expect(out.map((r) => r.id).sort()).toEqual(['p-fert', 'p-ppp']);
        const ppp = out.find((r) => r.id === 'p-ppp')!;
        expect(ppp.isPpp).toBe(true);
        expect(ppp.safetyWording).toBe('Използвайте продуктите за растителна защита безопасно.');
    });

    it('a non-ПРЗ promotion carries NULL wording, not an empty string', async () => {
        wordingOverride = 'нещо';
        findMany.mockResolvedValue([FERTILISER]);
        const [row] = await promotionDisclosures(['p-fert']);
        // "no wording applies" and "the wording is missing" are different
        // states and only the second is a fault; '' would conflate them.
        expect(row.safetyWording).toBeNull();
        expect(row.isPpp).toBe(false);
    });

    it('a blank or whitespace-only configuration counts as UNSET', async () => {
        findMany.mockResolvedValue([PESTICIDE]);
        for (const blank of ['', '   ', '\n']) {
            wordingOverride = blank;
            expect(await promotionDisclosures(['p-ppp'])).toEqual([]);
            expect(isPppDisclosureConfigured()).toBe(false);
        }
    });

    it('advertiser is the company legal name, verbatim', async () => {
        findMany.mockResolvedValue([FERTILISER]);
        const [row] = await promotionDisclosures(['p-fert']);
        // DSA Art 26's "on whose behalf". Rendered by the client from this
        // field even when the model's prose already named the company.
        expect(row.advertiser).toBe('Агро ООД');
    });

    it('asks the database nothing when given no ids', async () => {
        expect(await promotionDisclosures([])).toEqual([]);
        expect(findMany).not.toHaveBeenCalled();
    });
});
