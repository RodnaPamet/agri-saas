/**
 * The trigram search schema is actually in the database (P6.8, #1817).
 *
 * Schema-only PR, so there is no usecase to exercise — which is exactly why
 * this exists. A migration that declares an extension and two operator-class
 * indexes can fail to deliver any of them and leave nothing red: the column
 * would still be there, `tsc` would still pass, and the first symptom would be
 * a directory search doing sequential scans, which reads as working.
 *
 * ## It also pins the measurement the design rests on
 *
 * The decision to store a Latin form rather than reverse the query rests on
 * two facts, and both are asserted here rather than taken on trust:
 *
 *   - cross-script trigram similarity is ZERO. `similarity('pobeda', 'Победа')`
 *     is 0, so a Latin query cannot match a Cyrillic column no matter what the
 *     threshold is. The Latin column is not an optimisation; it is the only
 *     thing that makes the match possible.
 *   - transliteration is not translation. «АгроТех» yields `AgroTeh`, not
 *     `AgroTech`, so the realistic English-looking query is not an exact match
 *     for anything stored — but the two share almost all their trigrams. That
 *     is the case equality would quietly fail and similarity finds.
 *
 * If either number ever changes, the design needs rereading, and a test is the
 * only thing that would say so.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { transliterate } from '@/lib/bg-transliterate';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });

const REQUIRE_DB = process.env.INTEGRATION_REQUIRE_DB === '1';
if (REQUIRE_DB && !DB_AVAILABLE) {
    throw new Error(
        'INTEGRATION_REQUIRE_DB=1 but no database is reachable. This suite is the only '
            + 'thing that proves the extension and the operator-class indexes exist; skipping '
            + 'it silently would report a pass for a migration that may have delivered none.',
    );
}
const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('P6.8 trigram schema', () => {
    beforeAll(async () => {
        await globalPrisma.$connect();
    });
    afterAll(async () => {
        await globalPrisma.$disconnect();
    });

    it('pg_trgm is installed', async () => {
        const rows = await globalPrisma.$queryRawUnsafe<Array<{ extversion: string }>>(
            `select extversion from pg_extension where extname = 'pg_trgm'`,
        );
        expect(rows).toHaveLength(1);
    });

    it('both name columns carry a gin_trgm_ops index — not a plain GIN', async () => {
        // The operator class is the whole point. A GIN index on text WITHOUT
        // it cannot serve `similarity()` or `%`, so the index would exist, the
        // migration would look applied, and the search would degrade to a
        // sequential scan — slow rather than broken, which is harder to
        // notice.
        const rows = await globalPrisma.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(
            `select indexname, indexdef from pg_indexes where tablename = 'PublicFarmProfile'`,
        );
        const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));

        for (const col of ['displayName', 'displayNameLatin']) {
            const def = byName.get(`PublicFarmProfile_${col}_idx`);
            expect(def).toBeDefined();
            expect(def).toContain('USING gin');
            expect(def).toContain('gin_trgm_ops');
            expect(def).toContain(`"${col}"`);
        }
    });

    it('the Latin column exists and is nullable, which is the phase ordering', async () => {
        const rows = await globalPrisma.$queryRawUnsafe<Array<{ is_nullable: string }>>(
            `select is_nullable from information_schema.columns
             where table_name = 'PublicFarmProfile' and column_name = 'displayNameLatin'`,
        );
        expect(rows).toHaveLength(1);
        // Nullable because the writer populates it a release later. A NOT NULL
        // column here would have failed against any database holding rows.
        expect(rows[0].is_nullable).toBe('YES');
    });

    describe('the measurements the design rests on', () => {
        async function sim(a: string, b: string): Promise<number> {
            const rows = await globalPrisma.$queryRawUnsafe<Array<{ s: number }>>(
                `select similarity($1, $2) as s`,
                a,
                b,
            );
            return Number(rows[0].s);
        }

        it('cross-script similarity is ZERO — so the Latin column is load-bearing', async () => {
            // No threshold can rescue a Latin query against a Cyrillic column.
            // This is the fact that makes a stored Latin form the only design
            // that works, rather than one of two options.
            expect(await sim('pobeda', 'Победа')).toBe(0);
            expect(await sim('Pobeda', 'Победа')).toBe(0);
        });

        it('the same-script match is strong, so the comparison is not broken', async () => {
            // POSITIVE CONTROL for the zero above. Without it, `similarity`
            // returning 0 for everything would satisfy the previous case.
            expect(await sim('pobeda', 'pobeda')).toBeGreaterThan(0.9);
            expect(await sim('Победа', 'Победа')).toBeGreaterThan(0.9);
        });

        it('transliteration is not translation, and similarity covers the gap', async () => {
            // «АгроТех» → `AgroTeh`, because `х → h`. A user typing the
            // English-looking `AgroTech` matches nothing exactly.
            const stored = transliterate('АгроТех');
            expect(stored).toBe('AgroTeh');
            expect(stored).not.toBe('AgroTech');

            // …and yet it is findable, which is the argument for pg_trgm over
            // equality. 0.3 is pg_trgm's default threshold.
            const score = await sim(stored, 'AgroTech');
            expect(score).toBeGreaterThan(0.3);
        });
    });
});
