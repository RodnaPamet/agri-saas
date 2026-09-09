import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

/**
 * `.env.e2e.example` and `docker-compose.test.yml` must agree on where the test
 * database is, because nothing at runtime reconciles them.
 *
 * They disagreed long enough for the drift to spread: the example named port
 * 5434 and database `inflect_test`, while the compose file binds 5435 and names
 * it `agri_saas_test` — and `scripts/e2e-local.mjs` had copied the wrong values
 * into its own fallback, so a checkout with no `.env.e2e` inherited them too.
 *
 * The values are not arbitrary. A sibling inflect-compliance stack holds 5434,
 * and distinct database NAMES alone were not enough to keep the two apart; the
 * port has to differ as well (docker-compose.test.yml:26). Pointing the E2E
 * suite at 5434 therefore risks running migrations against the OTHER project's
 * database rather than failing to connect.
 *
 * Derived from the compose file rather than hardcoded, so the guard follows a
 * deliberate port change instead of blocking it.
 */

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

interface ComposeFile {
    services?: Record<string, { ports?: string[]; environment?: Record<string, string> }>;
}

describe('the E2E env example matches the test compose file', () => {
    const compose = yaml.load(read('docker-compose.test.yml')) as ComposeFile;

    // The postgres-ish test service: the one that declares POSTGRES_DB.
    const entry = Object.entries(compose.services ?? {}).find(
        ([, svc]) => svc?.environment?.POSTGRES_DB,
    );

    it('the compose file still has the shape this guard reads', () => {
        // Positive control. Every assertion below compares against values pulled
        // out of this file; if the lookup returned nothing they would compare
        // undefined to undefined and pass while checking nothing.
        expect(entry).toBeDefined();
        const [, svc] = entry!;
        expect(svc.environment?.POSTGRES_DB).toBeTruthy();
        expect(svc.ports?.length ?? 0).toBeGreaterThan(0);
    });

    it('the example points at the compose file port and database', () => {
        const [, svc] = entry!;
        const dbName = svc.environment!.POSTGRES_DB;
        // "5435:5432" -> the published (host) side is what a client connects to.
        const hostPort = String(svc.ports![0]).split(':')[0];

        const example = read('.env.e2e.example');
        const urls = example
            .split('\n')
            .filter((l) => /^DATABASE_URL(_TEST)?=/.test(l));

        expect(urls.length).toBeGreaterThan(0);
        for (const line of urls) {
            expect(line).toContain(`:${hostPort}/`);
            expect(line).toContain(`/${dbName}?`);
        }
    });

    it('the e2e script fallback matches too — half a fix is no fix', () => {
        const [, svc] = entry!;
        const dbName = svc.environment!.POSTGRES_DB;
        const hostPort = String(svc.ports![0]).split(':')[0];
        const script = read('scripts/e2e-local.mjs');

        // The fallback only applies when no .env.e2e exists, which is exactly
        // the first-run case a new machine hits.
        const fallback = script.match(/postgresql:\/\/[^\s'"`]+/g) ?? [];
        expect(fallback.length).toBeGreaterThan(0);
        for (const url of fallback) {
            expect(url).toContain(`:${hostPort}/`);
            expect(url).toContain(`/${dbName}?`);
        }
    });
});
