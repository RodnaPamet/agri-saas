/**
 * The #1222 pre-flight counter actually sees `v2:` rows.
 *
 * ## Why this test exists rather than a hand-run script
 *
 * `scripts/count-fanout-encrypted.ts` reports how many rows the `'*'` fan-out
 * has encrypted per (model, field). Narrowing the fan-out stops the middleware
 * DECRYPTING those columns too, so a row already holding `v2:` becomes
 * unreadable to everyone with no error and no log — which makes this counter
 * the only thing standing between the narrowing and a silent orphan.
 *
 * A counter like that is worthless unless something proves it can see a row.
 * "TOTAL v2 = 0" is the output both for a clean database and for a counter
 * pointed at the wrong one, and those are indistinguishable from the text.
 *
 * **They were not hypothetically indistinguishable.** Writing this, the first
 * control ran the script externally against `agri_saas_test` while the seeded
 * row went to `agri_saas_test_c<hash>_w1` — the per-checkout, per-worker slot
 * that `tests/helpers/db.ts` creates for a run and drops afterwards. The
 * script reported `Location.description 4 0 0` and `TOTAL v2 = 0` while a raw
 * query against the slot showed the row. The row totals disagreeing is what
 * exposed it; the `v2` column alone looked like a clean pass.
 *
 * So the control cannot live outside the suite: the database it must read
 * exists only while a run is in progress.
 */
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { runInTenantContext } from '@/lib/db-context';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { affectedPairs, countAffected } from '../../scripts/count-fanout-encrypted';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const bare = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
const TENANT = `t-preflight-${randomUUID()}`;
const LOC_ID = `loc-${randomUUID()}`;

describeFn('#1222 pre-flight: the fan-out v2 counter', () => {
    let client: Client;

    beforeAll(async () => {
        client = new Client({ connectionString: DB_URL });
        await client.connect();
        await createTenantWithDek({ id: TENANT, name: 'preflight', slug: TENANT });
    });

    afterAll(async () => {
        await bare.location.deleteMany({ where: { tenantId: TENANT } });
        await bare.tenant.deleteMany({ where: { id: TENANT } });
        await client.end();
        await bare.$disconnect();
    });

    it('control: the pair set is DERIVED, and shrinks as models are declared', () => {
        const pairs = affectedPairs();
        const has = (m: string, f: string) => pairs.some((p) => p.model === m && p.field === f);

        // Derived from the manifest + schema at RUN TIME, which is the whole
        // point — and this assertion has now gone stale twice inside one
        // issue, which is the evidence that a hardcoded list would have been
        // wrong rather than merely brittle. It was 19 before #1248 moved
        // `ExchangeMessage` into the manifest, 18 after, and 8 once this
        // change declared ten more. A floor, never an equality.
        expect(pairs.length).toBeGreaterThanOrEqual(5);

        // Still at risk: carries a manifest field NAME, deliberately plaintext.
        expect(has('ExchangeListing', 'description')).toBe(true);

        // Declared, so no longer reachable by the fan-out. `Location` moved
        // across in this change; `ExchangeMessage` in #1248. A model appearing
        // here after being declared would mean the derivation is reading a
        // stale manifest.
        expect(has('Location', 'description')).toBe(false);
        expect(has('LogEntry', 'notes')).toBe(false);
        expect(pairs.some((p) => p.model === 'ExchangeMessage')).toBe(false);
    });

    it('reads ZERO before anything encrypted is written', async () => {
        const before = await countAffected(client, [
            { model: 'Location', field: 'description', tenantScoped: true },
        ]);
        expect(before[0].error).toBeUndefined();
        expect(before[0].v2).toBe(0);
    });

    it('sees the row once one is written through the app path', async () => {
        // THE POSITIVE CONTROL. `runInTenantContext` + the extended client is
        // the path that encrypts; a raw insert would store plaintext and prove
        // nothing (which is how production's one `ExchangeListing` row came to
        // be plaintext and send two sessions chasing a phantom escape).
        await runInTenantContext(
            { requestId: 'preflight', userId: 'u-preflight', tenantId: TENANT, role: 'ADMIN' } as never,
            async (db) =>
                db.location.create({
                    data: { id: LOC_ID, tenantId: TENANT, name: 'preflight', description: 'PREFLIGHT_ROW' },
                }),
        );

        const after = await countAffected(client, [
            { model: 'Location', field: 'description', tenantScoped: true },
        ]);
        expect(after[0].error).toBeUndefined();
        expect(after[0].v2).toBeGreaterThanOrEqual(1);
        expect(after[0].rows).toBeGreaterThanOrEqual(1);
    });

    it('a table it cannot read is reported as an ERROR, never as zero', async () => {
        // The distinction the whole counter rests on. `FeatureFlag` was a live
        // instance on first run: it landed in #1233 and the test database had
        // not been migrated, so a counter that scored a missing relation as 0
        // would have reported that field clean.
        const [bogus] = await countAffected(client, [
            { model: 'NoSuchModel', field: 'description', tenantScoped: false },
        ]);
        expect(bogus.error).toBeDefined();
        expect(bogus.v2).toBe(0); // the value is meaningless, which is why `error` exists
    });
});
