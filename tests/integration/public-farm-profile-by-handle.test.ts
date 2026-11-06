/**
 * `GET /api/public/farms/{handle}` is reachable THROUGH the Edge (#2774).
 *
 * ## Why this is an HTTP-level test and not a handler unit test
 *
 * The handler is the easy half. The seam that has broken eight times in this
 * repo is the one BETWEEN the Edge and the handler: SCIM, the `iflk_` API key,
 * three signed webhooks, the platform-admin key, the feature-flag console and
 * the Art 16 notice form — which answered 401 for seven weeks while its own
 * guard asserted, correctly, that the handler was anonymous by legal duty. A
 * complete, tested, working mechanism, severed before it ran.
 *
 * `/api/public/farms` was an EXACT entry in `PUBLIC_PATH_EXACT`, so this route
 * was GATED before its prefix was added. Measured, before the route existed:
 *
 *     OPEN   /api/public/farms
 *     GATED  /api/public/farms/pobeda
 *     GATED  /api/public/farmsomething
 *
 * So §1 asserts the predicate directly, including the sibling that must STAY
 * gated — a prefix that opened `farmsomething` would be a real widening, and
 * "the route works" would not have caught it.
 */
import { randomUUID } from 'crypto';
import { DB_AVAILABLE } from './db-helper';
import { prisma } from '@/lib/prisma';
import { isPublicPath } from '@/lib/auth/guard';
import { GET } from '@/app/api/public/farms/[handle]/route';
import { NextRequest } from 'next/server';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
const TAG = `pfh-${randomUUID().slice(0, 8)}`;
const HANDLE = `${TAG}-farm`;

function req(url: string, headers: Record<string, string> = {}) {
    return new NextRequest(`https://app.agrent.bg${url}`, { headers });
}

describe('§1 the Edge admits it, and does NOT admit its siblings', () => {
    it('the handle path is public', () => {
        expect(isPublicPath('/api/public/farms/pobeda')).toBe(true);
    });

    it('the bare list path stays public too', () => {
        // The EXACT entry still carries it. Asserted because the obvious
        // "replace exact with prefix" edit would break the list route, and a
        // trailing-slash prefix does NOT match the bare path.
        expect(isPublicPath('/api/public/farms')).toBe(true);
    });

    it('a SIBLING is still gated — the prefix did not widen past its segment', () => {
        // The resolving-power control. Without this the suite would pass on a
        // predicate that opened everything beginning with the same letters.
        expect(isPublicPath('/api/public/farmsomething')).toBe(false);
        expect(isPublicPath('/api/public/farmsX')).toBe(false);
    });

    it('and an unrelated tenant path is still gated', () => {
        expect(isPublicPath('/api/t/acme/journal')).toBe(false);
    });
});

describeFn('§2 the handler, anonymous and with a bearer', () => {
    let flagExisted = false;

    beforeAll(async () => {
        if (!DB_AVAILABLE) return;
        // The REAL flag row, not a mocked module.
        //
        // `assertFeatureEnabled` 404s when the flag is off, and the test
        // database ships no `FeatureFlag` rows — so without this every case
        // below answers 404 and the three NEGATIVE assertions pass for entirely
        // the wrong reason. That is the shape of a suite that cannot express
        // its own failure, and it is why the 200 case is load-bearing: it is
        // the positive control for the 404s beside it. If the gate were shut,
        // the first test fails rather than the suite going quietly green.
        //
        // `.env.test` sets no `REDIS_URL`, so the 30s flag cache is a no-op
        // here and the row is read per request — no invalidation needed.
        const existing = await prisma.featureFlag.findUnique({ where: { key: 'social.public-profile' } });
        flagExisted = existing !== null;
        await prisma.featureFlag.upsert({
            where: { key: 'social.public-profile' },
            update: { enabled: true, cohorts: [] },
            create: { key: 'social.public-profile', enabled: true, cohorts: [] },
        });

        await prisma.publicFarmProfile.create({
            data: {
                handle: HANDLE,
                displayName: `Стопанство ${TAG}`,
                tagline: null,
                about: null,
                oblast: 'Пловдив',
                crops: ['wheat'],
                indexable: true,
                logoMediaHash: null,
                photoMediaHashes: [],
            },
        });
    });

    afterAll(async () => {
        if (!DB_AVAILABLE) return;
        await prisma.$executeRawUnsafe(`DELETE FROM "PublicFarmProfile" WHERE handle = $1`, HANDLE).catch(() => {});
        // Leave the flag table as it was found. The row is GLOBAL — no
        // tenantId — so a suite that enabled it and walked away would change
        // the answer for every other suite sharing this database.
        if (!flagExisted) {
            await prisma.featureFlag.delete({ where: { key: 'social.public-profile' } }).catch(() => {});
        }
    });

    it('answers a published profile to an ANONYMOUS caller', async () => {
        const res = await GET(req(`/api/public/farms/${HANDLE}`), {
            params: Promise.resolve({ handle: HANDLE }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.handle).toBe(HANDLE);
        expect(body.oblast).toBe('Пловдив');
        expect(body.crops).toEqual(['wheat']);
    });

    it('answers the SAME to a caller holding a bearer token', async () => {
        // The phone calls this signed in or not (#2774). A surface that only
        // works unauthenticated is as broken as one that only works
        // authenticated — and `auth()` tries the cookie then falls back to a
        // bearer, so a stray credential must not change the answer.
        const anon = await GET(req(`/api/public/farms/${HANDLE}`), {
            params: Promise.resolve({ handle: HANDLE }),
        });
        const bearer = await GET(
            req(`/api/public/farms/${HANDLE}`, { authorization: 'Bearer not-a-real-token' }),
            { params: Promise.resolve({ handle: HANDLE }) },
        );
        expect(bearer.status).toBe(anon.status);
        expect(await bearer.json()).toEqual(await anon.json());
    });

    it('exposes URLs and NOT hashes, and withholds indexable/projectedAt', async () => {
        const res = await GET(req(`/api/public/farms/${HANDLE}`), {
            params: Promise.resolve({ handle: HANDLE }),
        });
        const body = await res.json();
        expect(Object.keys(body).sort()).toEqual(
            ['about', 'crops', 'displayName', 'handle', 'logoUrl', 'oblast', 'photoUrls', 'tagline'],
        );
        // An exact key set, so adding a field is a visible diff. The two
        // omissions are deliberate and the two spellings are not both present.
        expect(body).not.toHaveProperty('logoMediaHash');
        expect(body).not.toHaveProperty('photoMediaHashes');
        expect(body).not.toHaveProperty('indexable');
        expect(body).not.toHaveProperty('projectedAt');
    });

    it('carries a weak ETag and honours If-None-Match with a 304', async () => {
        const first = await GET(req(`/api/public/farms/${HANDLE}`), {
            params: Promise.resolve({ handle: HANDLE }),
        });
        const etag = first.headers.get('etag');
        expect(etag).toBeTruthy();
        const second = await GET(
            req(`/api/public/farms/${HANDLE}`, { 'if-none-match': etag as string }),
            { params: Promise.resolve({ handle: HANDLE }) },
        );
        expect(second.status).toBe(304);
    });

    it('a MISSING handle and a MALFORMED one answer the identical 404', async () => {
        // The disclosure property, asserted as a COMPARISON rather than as two
        // separate 404 checks: "it was refused" is not the property — "the two
        // refusals are indistinguishable" is. A row exists only while the farm
        // is published, so withdrawal and never-existed are one absence.
        const missing = await GET(req('/api/public/farms/no-such-farm-xyz'), {
            params: Promise.resolve({ handle: 'no-such-farm-xyz' }),
        });
        const malformed = await GET(req('/api/public/farms/%20%20'), {
            params: Promise.resolve({ handle: '   ' }),
        });
        // Each body read ONCE into a variable. A Response body is a stream and
        // the second `.json()` on the same object throws "Body is unusable",
        // which is what the first version of this test did — and the failure
        // reads like a disclosure bug rather than a double read.
        const missingBody = await missing.json();
        const malformedBody = await malformed.json();

        expect(missing.status).toBe(404);
        expect(malformed.status).toBe(missing.status);
        expect(malformedBody).toEqual(missingBody);
        expect(missingBody).toEqual({ error: 'NOT_FOUND' });
    });

    it('a trailing space does not read as a missing farm', async () => {
        const res = await GET(req(`/api/public/farms/${HANDLE}%20`), {
            params: Promise.resolve({ handle: `${HANDLE} ` }),
        });
        expect(res.status).toBe(200);
    });
});
