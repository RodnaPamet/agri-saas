/**
 * The sitemap lists indexable profiles and nothing else (P6.5, #1814).
 *
 * Driven against a real database, because the property that matters is the
 * FILTER: a sitemap listing every published farm would invite crawlers to
 * index pages whose owners have not been asked, and an indexed page outlives
 * its withdrawal because a cached snapshot is not ours to recall.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import sitemap from '@/app/sitemap';
import { listIndexableFarmHandles, SITEMAP_MAX_ENTRIES } from '@/app-layer/usecases/public-farm-profile';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });

const REQUIRE_DB = process.env.INTEGRATION_REQUIRE_DB === '1';
if (REQUIRE_DB && !DB_AVAILABLE) {
    throw new Error(
        'INTEGRATION_REQUIRE_DB=1 but no database is reachable. This suite proves the '
            + 'sitemap filters on `indexable`; skipping it silently would report a pass for '
            + 'the control that decides what gets crawled.',
    );
}
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const handles: string[] = [];

describeFn('sitemap.xml', () => {
    beforeAll(async () => {
        await globalPrisma.$connect();
    });

    afterAll(async () => {
        if (handles.length > 0) {
            await globalPrisma.publicFarmProfile.deleteMany({ where: { handle: { in: handles } } });
        }
        await globalPrisma.$disconnect();
    });

    /** A projection row directly — no tenant needed, the sitemap reads only this. */
    async function aProfile(indexable: boolean, projectedAt?: Date): Promise<string> {
        const handle = `sm-${randomUUID().slice(0, 12)}`;
        handles.push(handle);
        await globalPrisma.publicFarmProfile.create({
            data: {
                handle,
                displayName: 'Стопанство',
                crops: [],
                indexable,
                ...(projectedAt ? { projectedAt } : {}),
            },
        });
        return handle;
    }

    it('an indexable profile appears; a published-but-not-indexable one does NOT', async () => {
        const indexed = await aProfile(true);
        const notIndexed = await aProfile(false);

        const entries = await sitemap();
        const urls = entries.map((e) => e.url);

        expect(urls.some((u) => u.endsWith(`/f/${indexed}`))).toBe(true);
        // The whole point of the filter. Both rows are PUBLISHED — a row only
        // exists while published — so this is the narrower consent question.
        expect(urls.some((u) => u.endsWith(`/f/${notIndexed}`))).toBe(false);
    });

    it('lastModified is the projection timestamp, not now', async () => {
        const when = new Date('2026-03-01T10:00:00.000Z');
        const handle = await aProfile(true, when);

        const entry = (await sitemap()).find((e) => e.url.endsWith(`/f/${handle}`));

        expect(entry).toBeDefined();
        expect(new Date(entry!.lastModified as Date).toISOString()).toBe(when.toISOString());
        // `new Date()` would claim everything changed on every fetch, which
        // trains a crawler to ignore the field entirely.
    });

    it('urls are absolute, and not double-slashed', async () => {
        await aProfile(true);
        for (const e of await sitemap()) {
            expect(e.url).toMatch(/^https?:\/\//);
            expect(e.url).toMatch(/\/f\/[a-z0-9-]+$/);
            expect(e.url.replace(/^https?:\/\//, '')).not.toContain('//');
        }
    });

    it('the cap is the sitemap protocol limit, not a guess', () => {
        // 50,000 is the per-file maximum. Exceeding it produces a document
        // crawlers reject WHOLESALE rather than truncate, so the number has to
        // be the protocol's.
        expect(SITEMAP_MAX_ENTRIES).toBe(50_000);
    });

    it('control: the reader is what the page uses, and returns rows at all', async () => {
        // Without this, every "not listed" assertion above is satisfied by a
        // reader that returns nothing.
        await aProfile(true);
        const rows = await listIndexableFarmHandles();
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) expect(r.handle).toBeTruthy();
    });
});
