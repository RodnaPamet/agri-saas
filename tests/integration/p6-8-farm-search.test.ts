/**
 * The public directory search (P6.8, #1817).
 *
 * Raw SQL against a real database, which is the only place this can be
 * exercised: `similarity()` and `%` are pg_trgm's, so a mocked client would
 * prove nothing about the query that matters.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import {
    searchPublicFarms,
    FARM_SEARCH_MAX_LIMIT,
} from '@/app-layer/usecases/public-farm-profile';
import { transliterate } from '@/lib/bg-transliterate';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });

const REQUIRE_DB = process.env.INTEGRATION_REQUIRE_DB === '1';
if (REQUIRE_DB && !DB_AVAILABLE) {
    throw new Error(
        'INTEGRATION_REQUIRE_DB=1 but no database is reachable. This suite is the only '
            + 'exercise of the trigram SQL; skipping it silently would report a pass for a '
            + 'query that may not even parse.',
    );
}
const describeFn = DB_AVAILABLE ? describe : describe.skip;

/** A prefix unique to this run, so a filter can isolate this suite's rows. */
const RUN = randomUUID().slice(0, 6);
const handles: string[] = [];

async function seed(displayName: string, extra: { oblast?: string; crops?: string[] } = {}) {
    const handle = `srch-${RUN}-${randomUUID().slice(0, 8)}`;
    handles.push(handle);
    await globalPrisma.publicFarmProfile.create({
        data: {
            handle,
            displayName,
            // Populated exactly as the writer does, so the search is tested
            // against the shape production will hold.
            displayNameLatin: transliterate(displayName),
            oblast: extra.oblast ?? null,
            crops: extra.crops ?? [],
            indexable: false,
        },
    });
    return handle;
}

describeFn('searchPublicFarms', () => {
    beforeAll(async () => {
        await globalPrisma.$connect();
    });
    afterAll(async () => {
        if (handles.length > 0) {
            await globalPrisma.publicFarmProfile.deleteMany({ where: { handle: { in: handles } } });
        }
        await globalPrisma.$disconnect();
    });

    // Generic, so the hit type survives the filter. Typed as
    // `Array<{ handle: string }>` first, which compiled at the call sites that
    // only read `handle` and broke the ones reading `score` — tsc caught it
    // where the passing tests had not.
    const mine = <T extends { handle: string }>(hits: T[]): T[] =>
        hits.filter((h) => h.handle.includes(RUN));

    it('a CYRILLIC query finds a Cyrillic name', async () => {
        const h = await seed('Стопанство Победа');
        const hits = mine(await searchPublicFarms({ q: 'Победа' }));
        expect(hits.map((x) => x.handle)).toContain(h);
        expect(hits[0].score).toBeGreaterThan(0);
    });

    it('a LATIN query finds the same farm — the point of the whole design', async () => {
        // Cross-script trigram similarity is ZERO, so this can only work
        // through the stored Latin column. If `displayNameLatin` were empty or
        // the predicate only checked `displayName`, this returns nothing.
        const h = await seed('Стопанство Победа');
        const hits = mine(await searchPublicFarms({ q: 'Pobeda' }));
        expect(hits.map((x) => x.handle)).toContain(h);
    });

    it('`AgroTech` finds «АгроТех», which equality would not', async () => {
        // The realistic query. «АгроТех» transliterates to `AgroTeh` — `х → h`,
        // because transliteration is not translation — so the user's spelling
        // matches nothing exactly and only similarity bridges it.
        const h = await seed('АгроТех');
        expect(transliterate('АгроТех')).toBe('AgroTeh');

        const hits = mine(await searchPublicFarms({ q: 'AgroTech' }));
        expect(hits.map((x) => x.handle)).toContain(h);
    });

    it('a farm that does not match is ABSENT — the control', async () => {
        // Without this, a predicate that matched everything would satisfy
        // every case above.
        await seed('Съвсем Друго Име');
        const hits = mine(await searchPublicFarms({ q: 'Победа' }));
        const names = hits.map((x) => x.displayName);
        expect(names).not.toContain('Съвсем Друго Име');
    });

    describe('filters', () => {
        it('oblast narrows, and is exact', async () => {
            const inDobrich = await seed('Нива Едно', { oblast: 'Добрич' });
            await seed('Нива Две', { oblast: 'Варна' });

            const hits = mine(await searchPublicFarms({ q: 'Нива', oblast: 'Добрич' }));
            expect(hits.map((x) => x.handle)).toContain(inDobrich);
            expect(hits.every((x) => x.oblast === 'Добрич')).toBe(true);
        });

        it('crop narrows by array containment', async () => {
            const wheat = await seed('Житно Поле', { crops: ['пшеница', 'ечемик'] });
            await seed('Слънчево Поле', { crops: ['слънчоглед'] });

            const hits = mine(await searchPublicFarms({ q: 'Поле', crop: 'пшеница' }));
            expect(hits.map((x) => x.handle)).toContain(wheat);
            expect(hits.every((x) => x.crops.includes('пшеница'))).toBe(true);
        });

        it('a filter with no query still works — browse within an oblast', async () => {
            const h = await seed('Само Област', { oblast: 'Русе' });
            const hits = mine(await searchPublicFarms({ oblast: 'Русе' }));
            expect(hits.map((x) => x.handle)).toContain(h);
            // No query means no ranking signal, so every score is 0 rather
            // than a meaningless small number.
            expect(hits.every((x) => x.score === 0)).toBe(true);
        });
    });

    describe('bounds', () => {
        it('the limit is capped, not trusted', async () => {
            for (let i = 0; i < 3; i++) await seed(`Групово ${i}`);
            const hits = await searchPublicFarms({ q: 'Групово', limit: 9999 });
            expect(hits.length).toBeLessThanOrEqual(FARM_SEARCH_MAX_LIMIT);
        });

        it('a limit of 1 returns one', async () => {
            await seed('Единично Едно');
            await seed('Единично Две');
            const hits = await searchPublicFarms({ q: 'Единично', limit: 1 });
            expect(hits).toHaveLength(1);
        });

        it('a zero or negative limit is floored to 1, not treated as unlimited', async () => {
            await seed('Нулево Име');
            // `LIMIT 0` returns nothing and would read as "no matches"; a
            // negative one is a SQL error. Both are caller mistakes that must
            // not become a different answer.
            expect(await searchPublicFarms({ q: 'Нулево', limit: 0 })).toHaveLength(1);
            expect(await searchPublicFarms({ q: 'Нулево', limit: -5 })).toHaveLength(1);
        });
    });

    it('ranks the better match first', async () => {
        const exact = await seed('Победа');
        await seed('Победа Голяма Стопанска Единица');

        const hits = mine(await searchPublicFarms({ q: 'Победа' }));
        // The shorter name shares a greater proportion of its trigrams, so it
        // scores higher. Asserted as an ordering rather than a value, because
        // the exact numbers are pg_trgm's business.
        expect(hits[0].handle).toBe(exact);
        expect(hits[0].score).toBeGreaterThanOrEqual(hits[hits.length - 1].score);
    });

    it('returns projection fields only — no PII, no tenantId', async () => {
        await seed('Проверка Полета');
        const hits = mine(await searchPublicFarms({ q: 'Проверка' }));
        expect(hits.length).toBeGreaterThan(0);
        expect(Object.keys(hits[0]).sort()).toEqual(
            ['crops', 'displayName', 'handle', 'oblast', 'score', 'tagline'].sort(),
        );
    });
});
