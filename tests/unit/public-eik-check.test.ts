/**
 * `GET /api/public/eik-check` (P3.7).
 *
 * The endpoint is anonymous and enumerable by construction, so the cases worth
 * writing are about what it REFUSES to disclose, not what it returns.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/security/rate-limit', () => {
    const actual = jest.requireActual('@/lib/security/rate-limit');
    return { ...actual };
});

import { GET } from '@/app/api/public/eik-check/route';
import { setRegistryProvider } from '@/lib/bg-company-registry';

/** A valid 9-digit ЕИК, built from the checksum rather than invented. */
function eik9(prefix8: string): string {
    const d = [...prefix8].map(Number);
    let s = 0;
    for (let i = 0; i < 8; i++) s += d[i] * (i + 1);
    let r = s % 11;
    if (r === 10) {
        s = 0;
        for (let i = 0; i < 8; i++) s += d[i] * (i + 3);
        r = s % 11;
        if (r === 10) r = 0;
    }
    return prefix8 + String(r);
}

/** A valid ЕГН, likewise derived. */
function egn(first9: string): string {
    const w = [2, 4, 8, 5, 10, 9, 7, 3, 6];
    const s = [...first9].map(Number).reduce((a, d, i) => a + d * w[i], 0);
    const r = s % 11;
    return first9 + String(r === 10 ? 0 : r);
}

const call = async (eik: string) => {
    const res = await GET(
        new NextRequest(`https://app.agrent.bg/api/public/eik-check?eik=${encodeURIComponent(eik)}`) as never,
        { params: Promise.resolve({}) } as never,
    );
    return { status: res.status, body: await res.json() };
};

afterEach(() => setRegistryProvider(null));

describe('validity', () => {
    it('accepts a well-formed ЕИК', async () => {
        const { status, body } = await call(eik9('83125426'));
        expect(status).toBe(200);
        expect(body.valid).toBe(true);
    });

    it('refuses a malformed one', async () => {
        const { body } = await call('123456789');
        expect(body.valid).toBe(false);
    });

    it('names an ЕГН rather than calling it an invalid ЕИК', async () => {
        // A sole trader reaching for the number they know. Telling them "that
        // is not an ЕИК" while they look at their own ЕГН is the unhelpful
        // answer the detector exists to avoid.
        const { body } = await call(egn('800101000'));
        expect(body.valid).toBe(false);
        expect(body.looksLikeEgn).toBe(true);
    });

    it('never echoes the submitted value back', async () => {
        // The ЕГН path especially — the value must not travel back out in an
        // error, a message or a field. A boolean is the whole answer.
        const value = egn('800101000');
        const { body } = await call(value);
        expect(JSON.stringify(body)).not.toContain(value);
    });
});

describe('what it refuses to disclose', () => {
    it('returns no registry name when no provider is configured', async () => {
        const { body } = await call(eik9('83125426'));
        expect(body.registryName).toBeNull();
    });

    it('returns a LEGAL ENTITY name when a provider has one', async () => {
        setRegistryProvider({ lookup: async () => ({ name: 'ЗК ПОБЕДА' }) });
        const { body } = await call(eik9('83125426'));
        expect(body.registryName).toBe('ЗК ПОБЕДА');
    });

    it('returns null for a natural person even when the provider knows them', async () => {
        // ADR 0002 OD2: a 9-digit БУЛСТАТ can itself be personal data — over
        // 300,000 self-insured farmers hold one. A public ЕИК→name map would
        // be a walkable index of natural persons, so the provider contract is
        // that it yields `{ name: null }` for them and this must surface as
        // null rather than as anything a caller could tell apart.
        setRegistryProvider({ lookup: async () => ({ name: null }) });
        const { body } = await call(eik9('83125426'));
        expect(body.registryName).toBeNull();
    });

    it('answers identically for "not in the register" and "is a person"', async () => {
        // The two must be indistinguishable. If they differed, the endpoint
        // would confirm which ЕИК belong to natural persons — exactly the
        // population the rule protects.
        setRegistryProvider({ lookup: async () => null });
        const absent = await call(eik9('83125426'));
        setRegistryProvider({ lookup: async () => ({ name: null }) });
        const person = await call(eik9('83125426'));
        expect(absent.body).toEqual(person.body);
    });

    it('exposes only the three agreed fields', async () => {
        // Every extra field is something an anonymous caller can harvest under
        // our rate limit. The register publishes addresses and directors; this
        // is not a proxy for it.
        setRegistryProvider({ lookup: async () => ({ name: 'ЗК ПОБЕДА' }) });
        const { body } = await call(eik9('83125426'));
        expect(Object.keys(body).sort()).toEqual(['looksLikeEgn', 'registryName', 'valid']);
    });
});

describe('the registry is never asked about an impossible number', () => {
    it('does not call the provider for a malformed ЕИК', async () => {
        // Checksum first keeps the expensive path off the keyspace a walker
        // tries first — and it is free, since the caller could compute it too.
        const lookup = jest.fn(async () => ({ name: 'nope' }));
        setRegistryProvider({ lookup });
        await call('123456789');
        expect(lookup).not.toHaveBeenCalled();
    });

    it('…and does call it for a valid one', async () => {
        // The control: without this, "not called" above could mean the
        // provider is never called at all.
        const lookup = jest.fn(async () => ({ name: 'ЗК ПОБЕДА' }));
        setRegistryProvider({ lookup });
        await call(eik9('83125426'));
        expect(lookup).toHaveBeenCalledTimes(1);
    });
});

describe('input handling', () => {
    it('400s on a missing parameter', async () => {
        const res = await GET(
            new NextRequest('https://app.agrent.bg/api/public/eik-check') as never,
            { params: Promise.resolve({}) } as never,
        );
        expect(res.status).toBe(400);
    });

    it('400s on an absurdly long value rather than hashing it', async () => {
        const { status } = await call('9'.repeat(5000));
        expect(status).toBe(400);
    });
});
