/**
 * P3.10 — an ЕГН submitted to the public ЕИК check is never persisted.
 *
 * #1194's hardening list asks for exactly this test, and the reason it is
 * worth writing is that this endpoint's whole purpose makes an ЕГН LIKELY, not
 * incidental: `looksLikeEgn` exists because a sole trader reaching for "the
 * number I know" types their personal identity number into the ЕИК box. So on
 * any given call the input may be an ЕГН, and ADR 0002 OD2 records that an ЕИК
 * can itself be personal data — 300,000+ self-insured farmers hold a 9-digit
 * БУЛСТАТ.
 *
 * "Never persisted" is asserted against every store the request can reach:
 *
 *   * the DATABASE — `prisma` is mocked to throw on any access, so a write of
 *     any shape fails the test rather than being checked for by name;
 *   * the LOGS — every logger level is captured and the whole payload searched
 *     for the submitted digits;
 *   * the RESPONSE — the body must not echo it back, because an echo lands in
 *     whatever the client logs.
 *
 * ── the one store this test CANNOT cover, stated rather than implied ──
 *
 * A `GET …?eik=` puts the value in a URL, and iOS CFNetwork logs the full
 * request URL unsuppressably. No server-side test can see that. It is why
 * P3.10 added the POST variant, and why the POST is the path clients are told
 * to use. The server side is clean — `deploy/Caddyfile` carries no `log`
 * directive and `lib/errors/api.ts` logs `req.nextUrl.pathname`, which
 * excludes the query — but "our logs are clean" is a narrower claim than
 * "never persisted", and the gap belongs on the record.
 */
const mockLogs: unknown[][] = [];

jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: {
        info: (...a: unknown[]) => mockLogs.push(a),
        warn: (...a: unknown[]) => mockLogs.push(a),
        error: (...a: unknown[]) => mockLogs.push(a),
        debug: (...a: unknown[]) => mockLogs.push(a),
    },
}));

/**
 * Any database access at all is a failure, not just a write.
 *
 * A Proxy that throws on every property beats enumerating `create`/`update`/
 * `upsert`: it covers the delegate nobody thought of, raw SQL, and a nested
 * write through a relation. The assertion is "this request touched no
 * database", which is stronger and shorter than a list.
 */
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: new Proxy(
        {},
        {
            get(_t, prop) {
                throw new Error(
                    `eik-check touched the database (prisma.${String(prop)}). ` +
                        `This endpoint must persist NOTHING: its input may be an ЕГН.`,
                );
            },
        },
    ),
}));

import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/public/eik-check/route';

/** Checksum-valid and date-decodable, so `classifyEikInput` says LOOKS_LIKE_EGN. */
const EGN = '7523169263';
/** A real ЕИК, for the control. */
const EIK = '831641791';

function getReq(eik: string): NextRequest {
    return new NextRequest(`http://localhost/api/public/eik-check?eik=${encodeURIComponent(eik)}`);
}

function postReq(eik: string): NextRequest {
    return new NextRequest('http://localhost/api/public/eik-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eik }),
    });
}

beforeEach(() => {
    mockLogs.length = 0;
});

describe('an ЕГН reaches no store', () => {
    it.each([
        ['POST (the recommended path)', () => POST(postReq(EGN) as never, {} as never)],
        ['GET (the legacy path)', () => GET(getReq(EGN) as never, {} as never)],
    ])('%s: no database, no log, no echo', async (_label, call) => {
        const res = await call();

        // 200 rather than a 500 from the throwing prisma proxy IS the
        // no-database assertion.
        expect(res.status).toBe(200);

        const body = await res.json();
        // The verdict the form needs, and nothing more.
        expect(body).toEqual({ valid: false, looksLikeEgn: true, registryName: null });

        // Not echoed. An echo would land in whatever the client logs, which is
        // the store this endpoint cannot control.
        expect(JSON.stringify(body)).not.toContain(EGN);

        // Not logged, at any level.
        expect(JSON.stringify(mockLogs)).not.toContain(EGN);
    });

    it('…and not even a FRAGMENT of it is logged', async () => {
        // A partial — first six digits are the date of birth — is still
        // personal data, and a "redacted" log that keeps a prefix is the
        // common way that happens.
        await POST(postReq(EGN) as never, {} as never);
        const logged = JSON.stringify(mockLogs);
        expect(logged).not.toContain(EGN.slice(0, 6));
        expect(logged).not.toContain(EGN.slice(-4));
    });
});

describe('the control: a valid ЕИК behaves the same way', () => {
    it('is answered without touching the database either', async () => {
        // Proves the no-database property is about the ENDPOINT, not about the
        // ЕГН branch returning early. A version that hit the database only on
        // the valid path would pass every assertion above.
        const res = await POST(postReq(EIK) as never, {} as never);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.valid).toBe(true);
        expect(JSON.stringify(mockLogs)).not.toContain(EIK);
    });

    it('CONTROL: the ЕГН fixture really is one', async () => {
        // Without this, the whole file could be passing because the fixture is
        // merely an invalid number taking the same early return — and the
        // ЕГН-specific path would be untested.
        const res = await POST(postReq(EGN) as never, {} as never);
        expect((await res.json()).looksLikeEgn).toBe(true);
    });
});

describe('a malformed body cannot become a store either', () => {
    it.each([
        ['not JSON', 'ht{{'],
        ['missing eik', JSON.stringify({})],
        ['eik too long', JSON.stringify({ eik: '9'.repeat(400) })],
    ])('%s is refused with no database access', async (_label, raw) => {
        const req = new NextRequest('http://localhost/api/public/eik-check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: raw,
        });
        const res = await POST(req as never, {} as never);
        expect(res.status).toBe(400);
        expect(JSON.stringify(mockLogs)).not.toContain('9'.repeat(20));
    });
});
