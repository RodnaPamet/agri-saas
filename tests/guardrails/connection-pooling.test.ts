/**
 * Guardrail: Connection Pooling Configuration
 *
 * Structural tests verifying PgBouncer/pooling is wired correctly
 * in docker-compose files, Prisma schema, and env config.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { readPrismaSchema } from '../helpers/prisma-schema';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

interface ComposeFile {
    services?: Record<string, { ports?: string[]; environment?: Record<string, string> }>;
}

describe('Connection Pooling Configuration', () => {

    describe('Prisma schema + config', () => {
        // Prisma 7 — `url` / `directUrl` moved out of `datasource db`
        // and into `prisma.config.ts` (`datasource.url`). Pin both:
        //   - the schema datasource block exists (provider line),
        //   - the config file passes DATABASE_URL through (the runtime
        //     adapter reads it directly so this is also the source of
        //     truth that `prisma migrate / generate` reads).
        const schema = readPrismaSchema();
        const config = read('prisma.config.ts');

        test('datasource block declares postgresql provider', () => {
            expect(schema).toMatch(
                /datasource\s+db\s*\{[\s\S]*?provider\s*=\s*"postgresql"/,
            );
        });

        test('prisma.config.ts wires DATABASE_URL into datasource.url', () => {
            expect(config).toContain('DATABASE_URL');
            expect(config).toMatch(/url:\s*process\.env\./);
        });

        test('prisma.config.ts falls back to DIRECT_DATABASE_URL for migrations', () => {
            // Prisma 7 dropped the `directUrl` field. The CLI uses the
            // single `url` from prisma.config.ts; we point that at
            // DIRECT_DATABASE_URL in non-runtime contexts. Pin the
            // env-name reference so future cleanups can't drop it.
            expect(config).toContain('DIRECT_DATABASE_URL');
        });
    });

    describe('env.ts validation', () => {
        const envTs = read('src/env.ts');

        test('DATABASE_URL is required', () => {
            expect(envTs).toContain('DATABASE_URL: z.string().url()');
        });

        test('DIRECT_DATABASE_URL is defined (optional)', () => {
            expect(envTs).toContain('DIRECT_DATABASE_URL');
        });
    });

    describe('docker-compose.yml (dev)', () => {
        const compose = read('docker-compose.yml');

        test('has pgbouncer service', () => {
            expect(compose).toContain('pgbouncer:');
        });

        test('pgbouncer uses transaction pool mode', () => {
            expect(compose).toContain('POOL_MODE: transaction');
        });

        test('pgbouncer has MAX_CLIENT_CONN >= 200', () => {
            const match = compose.match(/MAX_CLIENT_CONN:\s*"?(\d+)"?/);
            expect(match).toBeTruthy();
            expect(parseInt(match![1])).toBeGreaterThanOrEqual(200);
        });

        test('pgbouncer has health check', () => {
            // The compose file must contain a healthcheck for PgBouncer
            // We verify the overall file has a pg_isready check for PgBouncer
            expect(compose).toContain('pg_isready -h 127.0.0.1');
        });

        test('postgres has health check', () => {
            expect(compose).toContain('pg_isready');
        });

        test('pgbouncer depends on postgres', () => {
            expect(compose).toContain('depends_on:');
        });
    });

    describe('docker-compose.prod.yml', () => {
        const compose = read('docker-compose.prod.yml');

        test('has pgbouncer service', () => {
            expect(compose).toContain('pgbouncer:');
        });

        test('app depends on pgbouncer (not db directly)', () => {
            const appSection = compose.split('# ── Next.js App')[1] || '';
            expect(appSection).toContain('pgbouncer:');
        });

        test('DATABASE_URL points to pgbouncer', () => {
            expect(compose).toContain('@pgbouncer:');
        });

        test('DATABASE_URL includes pgbouncer=true param', () => {
            expect(compose).toContain('pgbouncer=true');
        });

        test('DIRECT_DATABASE_URL points to db (not pgbouncer)', () => {
            expect(compose).toContain('DIRECT_DATABASE_URL');
            // Find the assignment line (not the comment), identified by the colon
            const directLine = compose.split(/\r?\n/).find(l =>
                l.trim().startsWith('DIRECT_DATABASE_URL:'));
            expect(directLine).toBeTruthy();
            expect(directLine).toContain('@db:');
        });

        test('pgbouncer has no ports exposed to host (internal only)', () => {
            // In prod, pgbouncer should not have ports mapped to the host
            // The pgbouncer service section is between '# ── PgBouncer' and '# ── Next.js'
            const pgbouncerSection = compose
                .split('# ── PgBouncer')[1]
                ?.split('# ── Next.js')[0] || '';
            expect(pgbouncerSection).not.toContain('ports:');
        });
    });

    describe('.env.example', () => {
        const envExample = read('.env.example');

        /**
         * Derived from `docker-compose.yml`, not hardcoded.
         *
         * These were pinned to the literals 5433 and 5434 — the ports the
         * sibling inflect-compliance stack binds on the same host. The two
         * files AGREED on them, which is why nothing caught it: `.env.example`
         * was consistent with a compose file that stood up a database named
         * after the other product. Agreement between two wrong files is not a
         * check. Deriving one from the other at least makes them unable to
         * drift, and the identity assertion below is what makes the pair
         * wrong-detectable rather than merely consistent.
         */
        const compose = yaml.load(read('docker-compose.yml')) as ComposeFile;
        const services = Object.entries(compose.services ?? {});
        const postgres = services.find(([, svc]) => svc?.environment?.POSTGRES_DB);
        const pgbouncer = services.find(([, svc]) => svc?.environment?.DB_NAME);
        const published = (svc?: { ports?: string[] }) =>
            (svc?.ports ?? []).map((p) => String(p).split(':')[0]);
        const portOf = (line: RegExp) => envExample.match(line)?.[1];

        test('the compose file still has the shape this guard reads', () => {
            // Positive control: without it, every assertion below would compare
            // undefined to undefined and pass while checking nothing.
            expect(postgres).toBeDefined();
            expect(pgbouncer).toBeDefined();
            expect(published(postgres?.[1])).not.toHaveLength(0);
            expect(published(pgbouncer?.[1])).not.toHaveLength(0);
            expect(portOf(/^DATABASE_URL="[^"]*:(\d+)\//m)).toBeTruthy();
            expect(portOf(/^DIRECT_DATABASE_URL="[^"]*:(\d+)\//m)).toBeTruthy();
        });

        test('DATABASE_URL points at the port pgbouncer publishes', () => {
            expect(published(pgbouncer?.[1])).toContain(portOf(/^DATABASE_URL="[^"]*:(\d+)\//m));
        });

        test('DIRECT_DATABASE_URL points at the port postgres publishes', () => {
            expect(published(postgres?.[1])).toContain(
                portOf(/^DIRECT_DATABASE_URL="[^"]*:(\d+)\//m),
            );
        });

        /**
         * The identity check. The dev stack once stood up a database called
         * `inflect_compliance` — the other product's name — and every file in
         * the repo agreed with it, so a jest run resolved to it and would have
         * migrated it. A database this repo creates has to be recognisably
         * this repo's.
         */
        test('the dev database is named for THIS product, not another', () => {
            expect(postgres?.[1].environment?.POSTGRES_DB).toMatch(/^agri_saas/);
            expect(pgbouncer?.[1].environment?.DB_NAME).toMatch(/^agri_saas/);
            expect(envExample).toMatch(/^DATABASE_URL="[^"]*\/agri_saas[^"]*"/m);
        });

        test('DATABASE_URL includes pgbouncer=true', () => {
            expect(envExample).toContain('pgbouncer=true');
        });
    });
});
