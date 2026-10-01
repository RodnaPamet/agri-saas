/**
 * The pg pool `max` must still fit inside pgbouncer's server pool.
 *
 * `src/lib/db/pool-config.ts` derives `PG_POOL_MAX` from three numbers, two of
 * which live in a file it cannot import: pgbouncer's `POOL_MODE` and
 * `DEFAULT_POOL_SIZE` in `deploy/docker-compose.vm.yml`. A comment quoting
 * them is a comment, and quotations rot — the one this replaces would have gone
 * on reading "25" after an operator raised the pool to 50 or dropped it to 10,
 * and the app would have sized its pool against a number that no longer
 * existed.
 *
 * So this re-derives the constant from the compose file every run. Three ways
 * it can fail, each a real way to get this wrong:
 *
 *   1. `DEFAULT_POOL_SIZE` changes and `pool-config.ts` does not follow.
 *   2. A THIRD container starts connecting through pgbouncer (the count comes
 *      from the file, not from the constant), so `2 × max` is no longer the
 *      worst case.
 *   3. `POOL_MODE` stops being `transaction`, which invalidates the whole
 *      derivation: in `session` mode a server connection is held for the life
 *      of the client connection, not the transaction, and the arithmetic
 *      becomes a different one.
 *
 * NOT a directory walk: it reads two named files, so `collectSourceFiles` does
 * not apply and `file-collection-is-not-silently-empty` has nothing to say
 * about it. Both reads are asserted non-empty anyway, because a `readFileSync`
 * of a renamed file throws but a `match` that finds nothing does not.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
    PG_POOL_MAX,
    POOLED_CONTAINERS,
    PGBOUNCER_DEFAULT_POOL_SIZE,
    RESERVED_SERVER_CONNECTIONS,
} from '@/lib/db/pool-config';

const ROOT = path.resolve(__dirname, '../..');
const COMPOSE_PATH = path.join(ROOT, 'deploy/docker-compose.vm.yml');
const PRISMA_PATH = path.join(ROOT, 'src/lib/prisma.ts');

interface ComposeService {
    environment?: Record<string, string | number | null>;
}
interface Compose {
    services?: Record<string, ComposeService>;
}

const compose = yaml.load(fs.readFileSync(COMPOSE_PATH, 'utf8')) as Compose;
const services = compose.services ?? {};

/** The env value as a string, whatever YAML decided its scalar type was. */
const envOf = (service: string, key: string): string | undefined => {
    const raw = services[service]?.environment?.[key];
    return raw === undefined || raw === null ? undefined : String(raw);
};

describe('the production compose file still says what pool-config.ts assumes', () => {
    it('declares a pgbouncer service with an environment block', () => {
        // The population every other assertion here is drawn from. An empty
        // parse would otherwise make each `toBe(undefined)` comparison vacuous.
        expect(Object.keys(services).length).toBeGreaterThan(4);
        expect(services.pgbouncer).toBeDefined();
        expect(Object.keys(services.pgbouncer?.environment ?? {}).length).toBeGreaterThan(0);
    });

    it('runs pgbouncer in TRANSACTION pool mode', () => {
        // Session mode would hold a server connection for the life of a client
        // connection, and `PG_POOL_MAX × containers` would stop being the
        // right worst case.
        expect(envOf('pgbouncer', 'POOL_MODE')).toBe('transaction');
    });

    it('declares the DEFAULT_POOL_SIZE that pool-config.ts divides up', () => {
        expect(envOf('pgbouncer', 'DEFAULT_POOL_SIZE')).toBe(
            String(PGBOUNCER_DEFAULT_POOL_SIZE),
        );
    });

    it('has exactly POOLED_CONTAINERS services connecting through pgbouncer', () => {
        const throughPgbouncer = Object.entries(services)
            .filter(([, svc]) =>
                Object.values(svc.environment ?? {}).some(
                    (v) => typeof v === 'string' && v.includes('@pgbouncer:'),
                ),
            )
            .map(([name]) => name);

        // Named, not just counted — a reader who adds a third pooled container
        // should see which two were assumed.
        expect(throughPgbouncer.sort()).toEqual(['app', 'worker']);
        expect(throughPgbouncer).toHaveLength(POOLED_CONTAINERS);
    });

    it('keeps migrations off the pooled connections', () => {
        // `DIRECT_DATABASE_URL` must bypass pgbouncer, or `prisma migrate` would
        // compete for the same 25 server connections and the reserve would be
        // spent before an operator could use it.
        for (const svc of ['app', 'worker']) {
            const direct = envOf(svc, 'DIRECT_DATABASE_URL');
            expect(direct).toBeDefined();
            expect(direct).not.toContain('@pgbouncer:');
        }
    });
});

describe('the derived pool size fits', () => {
    it('leaves the reserve free in the worst case', () => {
        expect(PG_POOL_MAX * POOLED_CONTAINERS + RESERVED_SERVER_CONNECTIONS).toBeLessThanOrEqual(
            PGBOUNCER_DEFAULT_POOL_SIZE,
        );
    });

    it('is not degenerate', () => {
        // A derivation that collapsed to 1 (or 0) would "fit" perfectly and
        // serialise the whole application. The floor is `pg`'s own default of
        // 10, which is what this replaced: an explicit ceiling that is LOWER
        // than the accidental one it replaces would be a throughput regression
        // dressed as a safety fix.
        expect(PG_POOL_MAX).toBeGreaterThanOrEqual(10);
        expect(Number.isInteger(PG_POOL_MAX)).toBe(true);
    });
});

describe('the Prisma adapter actually uses it', () => {
    const prismaSource = fs.readFileSync(PRISMA_PATH, 'utf8');

    it('reads non-empty source', () => {
        expect(prismaSource.length).toBeGreaterThan(1000);
    });

    it('passes max: PG_POOL_MAX to PrismaPg', () => {
        // Textual, and that limit is stated rather than hidden: nothing short
        // of connecting can observe a pg pool's `max`, and a test that
        // connected would be asserting about the test database's pool, not the
        // production singleton's. What this catches is the constant being
        // computed and then not wired — the shape this whole file is for.
        expect(prismaSource).toMatch(/new PrismaPg\(\{[\s\S]*?max:\s*PG_POOL_MAX/);
        expect(prismaSource).toContain("from './db/pool-config'");
    });
});
