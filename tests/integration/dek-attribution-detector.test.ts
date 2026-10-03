/**
 * The #1274 detector is proven against rows whose correct answer is known.
 *
 * ## Why this test is the point
 *
 * `scripts/audit-dek-attribution.mjs` re-implements the app's key derivation
 * and AES-GCM decrypt, because it has to run in the production container, which
 * ships no `tsx` and no `scripts/` tree. A re-implementation that is subtly
 * wrong — wrong salt, wrong info string, wrong IV length — reports **every row
 * as undecryptable**, which is indistinguishable from the defect it hunts.
 *
 * So the detector is never trusted on its own output. This test builds rows
 * whose answer is known in advance and asserts two separate things:
 *
 *   1. **Agreement.** The detector's `unwrapDek` produces the same bytes as the
 *      app's own `getTenantDek`, and its `gcmDecrypt` recovers what the app's
 *      `encryptWithKey` produced. If the re-implementation drifts from the real
 *      one, this fails rather than the production sweep reading clean.
 *   2. **Discrimination.** It separates `ok` from `wrong-tenant` from `orphan`.
 *      A detector that returned one verdict for everything would satisfy any
 *      single-case test; these three cases cannot all pass unless it is
 *      actually comparing keys.
 *
 * A production run of that script is only meaningful with this test passing on
 * the same commit.
 */
import { Client } from 'pg';
import { randomBytes, randomUUID } from 'crypto';

import { runInTenantContext } from '@/lib/db-context';
import { createTenantWithDek, getTenantDek } from '@/lib/security/tenant-key-manager';
import { encryptWithKey } from '@/lib/security/encryption';
import { DEV_FALLBACK_DATA_ENCRYPTION_KEY } from '@/lib/security/encryption-constants';

import {
    classify,
    unwrapDek,
    gcmDecrypt,
    masterKeyFromEnv,
} from '../../scripts/audit-dek-attribution.js';

import { DB_URL, DB_AVAILABLE } from './db-helper';

// The app's own connection (#1265): `DB_URL` and `process.env.DATABASE_URL` are
// the same database in CI and can differ locally.
const APP_DB_URL = process.env.DATABASE_URL ?? DB_URL;
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const A = `t-det-a-${randomUUID()}`;
const B = `t-det-b-${randomUUID()}`;

describeFn('#1274 DEK-attribution detector', () => {
    let client: Client;
    let dekA: Buffer;
    let dekB: Buffer;
    let masterKey: Buffer;
    const locCorrect = `loc-ok-${randomUUID()}`;
    const locWrong = `loc-wrong-${randomUUID()}`;
    const locOrphan = `loc-orphan-${randomUUID()}`;
    const MARKER = `DETECTOR_${randomUUID().slice(0, 8)}`;

    beforeAll(async () => {
        client = new Client({ connectionString: APP_DB_URL });
        await client.connect();
        await createTenantWithDek({ id: A, name: A, slug: A });
        await createTenantWithDek({ id: B, name: B, slug: B });
        dekA = await getTenantDek(A);
        dekB = await getTenantDek(B);
        // The SCRIPT derives this, not the test. When the test passed the
        // `info` string itself, the script's own `ENCRYPT_INFO` was dead code
        // and a mutation of it passed every assertion — a wrong info string
        // would have reported all of production as orphaned rows.
        masterKey = masterKeyFromEnv(process.env, DEV_FALLBACK_DATA_ENCRYPTION_KEY);

        // (1) a CORRECT row, through the app path so the real extension encrypts it
        await runInTenantContext(
            { requestId: 'det', userId: 'u', tenantId: A, role: 'ADMIN' } as never,
            async (db) => db.location.create({ data: { id: locCorrect, tenantId: A, name: 'ok', description: MARKER } }),
        );
        // (2) a MISATTRIBUTED row: tenant A's row, encrypted with tenant B's DEK,
        //     inserted raw so no extension re-encrypts it. This is the #1259
        //     outcome, manufactured on purpose.
        // `updatedAt` is Prisma's `@updatedAt` — applied by the client, not a
        // database default — so a raw insert has to supply it.
        const rawInsert = `INSERT INTO "Location" (id, "tenantId", name, description, "createdAt", "updatedAt")
                           VALUES ($1,$2,$3,$4, now(), now())`;
        await client.query(rawInsert, [locWrong, A, 'wrong', encryptWithKey(dekB, MARKER)]);
        // (3) an ORPHAN: encrypted under a key no tenant holds.
        await client.query(rawInsert, [locOrphan, A, 'orphan', encryptWithKey(randomBytes(32), MARKER)]);
    });

    afterAll(async () => {
        for (const t of [A, B]) {
            await client.query('DELETE FROM "Location" WHERE "tenantId" = $1', [t]).catch(() => undefined);
            await client.query('DELETE FROM "Tenant" WHERE id = $1', [t]).catch(() => undefined);
        }
        await client.end();
    });

    it('AGREEMENT: the detector unwraps the same DEK bytes the app resolves', async () => {
        // If the salt, info string or envelope handling drifted, these differ
        // and every production row would read as undecryptable.
        const row = await client.query('SELECT "encryptedDek" FROM "Tenant" WHERE id = $1', [A]);
        const mine = unwrapDek(masterKey, row.rows[0].encryptedDek as string);
        expect(Buffer.isBuffer(mine)).toBe(true);
        expect(mine.length).toBe(32);
        expect(mine.equals(dekA)).toBe(true);
    });

    it('AGREEMENT: the detector decrypts what the app encrypted', () => {
        const ct = encryptWithKey(dekA, MARKER);
        expect(ct.startsWith('v2:')).toBe(true);
        expect(gcmDecrypt(dekA, ct.slice(3))).toBe(MARKER);
        // ...and refuses another tenant's key, or it could not discriminate.
        expect(() => gcmDecrypt(dekB, ct.slice(3))).toThrow();
    });

    it('DISCRIMINATION: ok / wrong-tenant / orphan are three different answers', async () => {
        const deks = new Map<string, Buffer>([[A, dekA], [B, dekB]]);
        const read = async (id: string) => {
            const r = await client.query('SELECT "tenantId", description FROM "Location" WHERE id = $1', [id]);
            return { tenantId: r.rows[0].tenantId as string, v: r.rows[0].description as string };
        };

        const good = await read(locCorrect);
        expect(classify(good.v, good.tenantId, deks)).toEqual({ state: 'ok', owner: A });

        const bad = await read(locWrong);
        // The headline capability: it names the tenant whose key opens the row.
        expect(classify(bad.v, bad.tenantId, deks)).toEqual({ state: 'wrong-tenant', owner: B });

        const orphan = await read(locOrphan);
        expect(classify(orphan.v, orphan.tenantId, deks)).toEqual({ state: 'orphan', owner: null });
    });

    it('DISCRIMINATION: v1 and plaintext are not reported as misattribution', () => {
        const deks = new Map<string, Buffer>([[A, dekA]]);
        // A global-KEK envelope is readable and is NOT this defect — scoring it
        // as an offender would inflate the production figure with healthy rows.
        expect(classify('v1:AAAA', A, deks)).toEqual({ state: 'v1', owner: null });
        expect(classify('just text', A, deks)).toEqual({ state: 'plaintext', owner: null });
        expect(classify(null as never, A, deks)).toEqual({ state: 'null', owner: null });
    });
});
