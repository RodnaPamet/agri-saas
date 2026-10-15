/**
 * Every public-profile surface closes when the flag is off — #1886.
 *
 * #1197's standing rule is that a social surface sits behind a runtime flag,
 * default OFF, because these surfaces are public-facing and legally
 * consequential and the only agreed way to switch one off in production is a
 * flag flip. Six of them shipped without a gate, and
 * `social-routes-flag-gated` reported green throughout because its roots are
 * `src/app/api/social/` and `src/app/social/` while the roadmap built at
 * `api/t/{slug}/farm-brand`, `api/public/farms` and `app/f/[handle]`.
 *
 * ## Both halves, in one file, deliberately
 *
 * A suite that only asserted "flagged off → 404" would pass against a surface
 * that 404s unconditionally — which is the same shape of defect, just
 * inverted, and would take the feature down rather than expose it. So every
 * case here checks the ON state too, and the flag is a mutable mock so one
 * file can hold both.
 *
 * ## Three entry points on one route, and why the guard cannot see them
 *
 * `/f/{handle}` is a page, a `generateMetadata` and an `opengraph-image`, and
 * each runs independently. A gate on the page alone would still publish the
 * farm's name as a `<title>` and render a social card — and a card is the one
 * surface that gets scraped and cached somewhere else.
 *
 * `social-routes-flag-gated` checks that a route FILE contains a gate, which
 * is file-granular where Next is entry-point-granular. Measured: deleting the
 * page export's gate while leaving `generateMetadata`'s leaves the guard GREEN
 * — one `isFeatureEnabled` call anywhere in the file satisfies it. Deleting
 * both fails it.
 *
 * So that guard proves a file remembered the flag, and this suite proves each
 * ENTRY POINT honours it. Neither substitutes for the other, and the gap
 * between them is exactly one ungated export.
 */
import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

let flagOn = false;
jest.mock('@/lib/feature-flags', () => {
    const actual = jest.requireActual('@/lib/feature-flags');
    const { notFound } = jest.requireActual('@/lib/errors/types');
    return {
        ...actual,
        isFeatureEnabled: async () => flagOn,
        // Mirrors the real one: 404 rather than 403, so a dark-launched
        // surface is not discoverable by the status code.
        assertFeatureEnabled: async () => {
            if (!flagOn) throw notFound('Not found');
        },
    };
});

import sitemap from '@/app/sitemap';
import PublicFarmProfilePage, { generateMetadata } from '@/app/f/[handle]/page';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const describeIfDb = DB_AVAILABLE ? describe : describe.skip;

describeIfDb('the public-profile surfaces are flag-gated', () => {
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
    const handle = `g${randomUUID().slice(0, 8).replace(/-/g, '')}`;

    beforeAll(async () => {
        await prisma.$connect();
        // A real, indexable, published projection row — so every assertion
        // below is about the GATE and not about an absent farm. Without this
        // the off-state would be indistinguishable from "no such farm".
        await prisma.publicFarmProfile.create({
            data: {
                handle,
                displayName: 'Стопанство Победа',
                tagline: 'Зърно от Добруджа',
                oblast: 'Добрич',
                crops: ['пшеница'],
                displayNameLatin: 'stopanstvo-pobeda',
                indexable: true,
            },
        });
    });

    afterAll(async () => {
        await prisma.publicFarmProfile.deleteMany({ where: { handle } });
        await prisma.$disconnect();
    });

    beforeEach(() => {
        flagOn = false;
    });

    describe('the page', () => {
        it('404s when the flag is off, for a farm that EXISTS', async () => {
            await expect(
                PublicFarmProfilePage({ params: Promise.resolve({ handle }) }),
            ).rejects.toThrow();
        });

        it('gets PAST the gate when the flag is on', async () => {
            // The control, and it asserts the REASON rather than success,
            // because this page cannot render in a node test at all:
            // `getTranslations` needs a server i18n request context that only
            // a real request provides.
            //
            // So the discriminator is WHICH error. Flagged off it is
            // `notFound()`; flagged on it is the i18n one — different cause,
            // which is exactly the proof that the gate is no longer what
            // stops it. Without this, the assertion above would be satisfied
            // by a page that threw unconditionally.
            const off = await PublicFarmProfilePage({
                params: Promise.resolve({ handle }),
            }).catch((e: Error) => e);
            // Measured, not guessed: this Next version throws
            // `NEXT_HTTP_ERROR_FALLBACK;404` from `notFound()`, where older
            // ones threw `NEXT_NOT_FOUND`. Both are accepted so a Next
            // upgrade does not turn this control into a false failure.
            expect(String(off)).toMatch(/NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK;404/);

            flagOn = true;
            const on = await PublicFarmProfilePage({
                params: Promise.resolve({ handle }),
            }).catch((e: Error) => e);
            expect(String(on)).not.toMatch(/NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK;404/);
            expect(String(on)).toMatch(/getTranslations/);
        });
    });

    describe('generateMetadata — the second entry point on that route', () => {
        it('emits no farm name when the flag is off', async () => {
            const meta = await generateMetadata({ params: Promise.resolve({ handle }) });
            expect(meta.title).toBeUndefined();
            expect(JSON.stringify(meta)).not.toContain('Победа');
            // And it tells crawlers not to index what it will not serve.
            expect(meta.robots).toEqual({ index: false, follow: false });
        });

        it('emits the farm name when the flag is on', async () => {
            flagOn = true;
            const meta = await generateMetadata({ params: Promise.resolve({ handle }) });
            expect(meta.title).toBe('Стопанство Победа');
        });
    });

    describe('the OG image — the third entry point on that route', () => {
        it('refuses when the flag is off, and gets past the gate when on', async () => {
            // Asserted because a social card is the one surface that gets
            // scraped and cached somewhere else: an ungated card would leave a
            // farm's name on other people's servers for a page the flag has
            // switched off, where a 404 cannot reach it.
            //
            // Same WHICH-error discriminator as the page: `ImageResponse` does
            // not render under jest, so success is not available and the proof
            // is that the failure cause changes.
            const Image = require('@/app/f/[handle]/opengraph-image').default;

            const off = await Image({ params: Promise.resolve({ handle }) }).catch(
                (e: Error) => e,
            );
            expect(String(off)).toMatch(/NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK;404/);

            flagOn = true;
            const on = await Image({ params: Promise.resolve({ handle }) }).catch(
                (e: Error) => e,
            );
            expect(String(on)).not.toMatch(/NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK;404/);
        });
    });

    describe('the sitemap', () => {
        it('invites no farm when the flag is off', async () => {
            const entries = await sitemap();
            expect(entries.map((e) => e.url).filter((u) => u.includes(handle))).toEqual([]);
        });

        it('lists the indexable farm when the flag is on', async () => {
            flagOn = true;
            const entries = await sitemap();
            expect(entries.map((e) => e.url).some((u) => u.includes(handle))).toBe(true);
        });

        it('still answers rather than 404ing — a site-level document', async () => {
            // "No farms are indexable" and "there is no sitemap" are different
            // claims, and a crawler reads them differently.
            await expect(sitemap()).resolves.toBeInstanceOf(Array);
        });
    });

    describe('the public search endpoint', () => {
        it('404s when the flag is off, and answers when on', async () => {
            // `require`d rather than imported so the module loads AFTER the
            // flag mock is registered.
            const { GET } = require('@/app/api/public/farms/route');
            const url = 'http://localhost/api/public/farms?q=pobeda';

            // `NextRequest`, not `Request`: `withApiErrorHandling` reads
            // `req.nextUrl.pathname` for its metrics label and a plain
            // Request has no `nextUrl`.
            const off = await GET(new NextRequest(url));
            expect(off.status).toBe(404);

            flagOn = true;
            const on = await GET(new NextRequest(url));
            expect(on.status).toBe(200);
        });
    });
});
