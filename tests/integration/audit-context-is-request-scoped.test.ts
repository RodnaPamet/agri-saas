/**
 * The audit context belongs to ONE request, so a row is encrypted under its
 * OWN tenant's DEK.
 *
 * ## The defect (#1259)
 *
 * `audit-context.ts` stored the tenant/actor in a module-level array shared by
 * every in-flight request. `resolveTenantDekPair`
 * (`src/lib/db/encryption-middleware.ts`) reads that context to choose WHICH
 * TENANT'S DEK encrypts a field, and `runWithAuditContext` pushed on entry and
 * popped when the work settled — so another request pushing while this one sat
 * at an `await` made `getAuditContext()` return the wrong tenant.
 *
 * Measured on the stack, 8 concurrent writes across 8 distinct tenants with a
 * cold DEK cache: **1 correct, 7 encrypted under another tenant's DEK**. Those
 * rows are unreadable by the tenant that owns them — their own DEK fails
 * AES-GCM auth — and the per-tenant key boundary Epic B exists to enforce did
 * not hold. Reachable in production: one `app` container, every tenant, one
 * Node process, and the window is widest right after a deploy while the DEK
 * cache is cold.
 *
 * The fix is `AsyncLocalStorage`, which scopes the store to the async subtree
 * that established it. The reason the stack existed — "a Prisma query
 * extension runs detached from ALS" — was a statement about Prisma 5's `$use`,
 * removed in Prisma 7, and `tests/integration/prisma-extension-als-reachability.test.ts`
 * measures that a `$extends` handler does see the store.
 *
 * ## Why the controls carry the weight here
 *
 * "Every row decrypted with its own key" is also what a broken instrument
 * reports: if the keys were indistinguishable, or if `decryptWithKey` threw for
 * everything and the loop fell through, the count would look identical. So the
 * sequential control asserts a row decrypts with its OWN key and FAILS with
 * another tenant's, and the outcome buckets must sum to N so a row that never
 * got written cannot be scored as correct.
 *
 * The DEK cache is cleared deliberately. A warm cache resolves from a `Map`
 * with no await, which narrows the interleaving window — the state in which
 * the original defect is hardest to reproduce. Cold is the honest test.
 */
import { Client } from 'pg';
import { randomUUID } from 'crypto';

import { runInTenantContext } from '@/lib/db-context';
import { runWithAuditContext, getAuditContext } from '@/lib/audit-context';
import {
    createTenantWithDek,
    getTenantDek,
    clearTenantDekCache,
} from '@/lib/security/tenant-key-manager';
import { decryptWithKey, getCiphertextVersion } from '@/lib/security/encryption';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const N = 8;
// The APP's connection, not `DB_URL` — see #1265: they are the same database
// in CI and can differ locally, and a reader built from the wrong one reports
// committed rows as absent.
const APP_DB_URL = process.env.DATABASE_URL ?? DB_URL;

const describeFn = DB_AVAILABLE ? describe : describe.skip;

interface Subject {
    id: string;
    marker: string;
    locId: string;
}

const write = (tenantId: string, locId: string, marker: string, barrier: Promise<void>) =>
    runInTenantContext(
        { requestId: `r-${tenantId}`, userId: 'u', tenantId, role: 'ADMIN' } as never,
        async (db) => {
            // Released together, so every writer is inside its own context
            // while the others are too — which is the condition the shared
            // stack could not survive.
            await barrier;
            return db.location.create({
                data: { id: locId, tenantId, name: 'als-probe', description: marker },
            });
        },
    );

describeFn('the audit context is request-scoped (#1259)', () => {
    let client: Client;
    const subjects: Subject[] = [];

    beforeAll(async () => {
        client = new Client({ connectionString: APP_DB_URL });
        await client.connect();
        for (let i = 0; i < N; i++) {
            const id = `t-als-${randomUUID()}`;
            await createTenantWithDek({ id, name: id, slug: id });
            subjects.push({
                id,
                marker: `ALS_MARKER_${i}_${randomUUID().slice(0, 8)}`,
                locId: `loc-${randomUUID()}`,
            });
        }
    });

    afterAll(async () => {
        for (const s of subjects) {
            await client.query('DELETE FROM "Location" WHERE "tenantId" = $1', [s.id]).catch(() => undefined);
            await client.query('DELETE FROM "Tenant" WHERE id = $1', [s.id]).catch(() => undefined);
        }
        await client.end();
    });

    it('control: concurrent contexts do not alias — each branch sees its OWN', async () => {
        // The mechanism, with no database in the way. On the module-level
        // stack the second `run` became the top and the first branch read it
        // after its await; under ALS each subtree keeps its own store.
        const seen: string[] = [];
        const hold = (tag: string) =>
            runWithAuditContext({ tenantId: tag }, async () => {
                await new Promise((r) => setImmediate(r));
                seen.push(`${tag}->${getAuditContext()?.tenantId}`);
            });
        await Promise.all([hold('alpha'), hold('beta'), hold('gamma')]);
        expect(seen.sort()).toEqual(['alpha->alpha', 'beta->beta', 'gamma->gamma']);
        // ...and nothing leaks once the subtree is done.
        expect(getAuditContext()).toBeUndefined();
    });

    it('control: a LAZY thenable still executes INSIDE the context', async () => {
        // The subtle half, pinned on purpose. A `PrismaPromise` starts no query
        // until something calls `.then()` on it, and several call sites pass a
        // non-async callback that hands one straight back:
        //
        //     runWithAuditContext(ctx, () => appPrisma.asset.create({ … }))
        //
        // If `runWithAuditContext` returns that object out of `als.run`, the
        // caller's `await` subscribes OUTSIDE the scope, the query runs with no
        // store, and the audit extension takes its `if (!tenantId)` fast path —
        // writing no audit row, with nothing failing. That silently cost all 7
        // assertions in `audit-middleware.test.ts` on the first attempt at this
        // migration, which is why it is a named control and not a comment.
        //
        // Stands in for Prisma with a hand-rolled lazy thenable so the property
        // is tested without a database in the way.
        let seenWhenSubscribed: string | undefined;
        const lazy = {
            then(resolve: (v: unknown) => void) {
                seenWhenSubscribed = getAuditContext()?.tenantId;
                resolve('done');
            },
        };

        await runWithAuditContext({ tenantId: 'lazy-tenant' }, () => lazy as never);

        expect(seenWhenSubscribed).toBe('lazy-tenant');
    });

    it('control: a nested context shadows, and the outer one survives it', async () => {
        await runWithAuditContext({ tenantId: 'outer' }, async () => {
            expect(getAuditContext()?.tenantId).toBe('outer');
            await runWithAuditContext({ tenantId: 'inner' }, async () => {
                await new Promise((r) => setImmediate(r));
                expect(getAuditContext()?.tenantId).toBe('inner');
            });
            // The stack got this right by popping; ALS gets it right by scope.
            expect(getAuditContext()?.tenantId).toBe('outer');
        });
    });

    it('control: a sequential write decrypts with its OWN key and not another', async () => {
        // Without this, the measurement below cannot mean anything: if the
        // keys were indistinguishable, or decryption threw for everything,
        // "all correct" and "all wrong" would look the same.
        const s = subjects[0];
        const seqId = `loc-seq-${randomUUID()}`;
        clearTenantDekCache();
        await write(s.id, seqId, s.marker, Promise.resolve());

        const r = await client.query('SELECT description FROM "Location" WHERE id = $1', [seqId]);
        const ct = r.rows[0].description as string;
        expect(getCiphertextVersion(ct)).toBe('v2');

        const own = await getTenantDek(s.id);
        const other = await getTenantDek(subjects[1].id);
        expect(decryptWithKey(own, ct)).toBe(s.marker);
        expect(() => decryptWithKey(other, ct)).toThrow();

        await client.query('DELETE FROM "Location" WHERE id = $1', [seqId]);
    });

    it(`${N} concurrent writes are each encrypted under their OWN tenant's DEK`, async () => {
        // THE REGRESSION TEST. On the module-level stack: 1 correct, 7 under
        // another tenant's key.
        clearTenantDekCache();
        let release!: () => void;
        const barrier = new Promise<void>((r) => { release = r as () => void; });
        const runs = subjects.map((s) => write(s.id, s.locId, s.marker, barrier));
        release();
        await Promise.all(runs);

        const deks = new Map<string, Buffer>();
        for (const s of subjects) deks.set(s.id, await getTenantDek(s.id));

        let correct = 0;
        let wrongTenant = 0;
        let globalKek = 0;
        let undecryptable = 0;
        const detail: string[] = [];

        for (const s of subjects) {
            const r = await client.query('SELECT description FROM "Location" WHERE id = $1', [s.locId]);
            const ct = r.rows[0]?.description as string | undefined;
            if (!ct) { detail.push(`${s.marker}: NO ROW`); undecryptable++; continue; }
            if (getCiphertextVersion(ct) === 'v1') {
                globalKek++;
                detail.push(`${s.marker}: v1 global-KEK fallback (no context resolved)`);
                continue;
            }
            let owner: string | null = null;
            for (const [tid, key] of deks) {
                try { if (decryptWithKey(key, ct) === s.marker) { owner = tid; break; } } catch { /* next */ }
            }
            if (owner === s.id) correct++;
            else if (owner) {
                wrongTenant++;
                detail.push(`${s.marker}: owner ${s.id.slice(0, 12)}… but encrypted under ${owner.slice(0, 12)}…`);
            } else {
                undecryptable++;
                detail.push(`${s.marker}: decrypts with NO tenant DEK`);
            }
        }

        if (wrongTenant > 0 || globalKek > 0 || undecryptable > 0) {
            throw new Error(
                `DEK misattribution over ${N} concurrent writes — ` +
                    `correct=${correct} wrongTenant=${wrongTenant} globalKek=${globalKek} ` +
                    `undecryptable=${undecryptable}\n` + detail.map((d) => `  - ${d}`).join('\n'),
            );
        }

        // The buckets must account for every subject, so a row that was never
        // written cannot be counted as a success.
        expect(correct + wrongTenant + globalKek + undecryptable).toBe(N);
        expect(correct).toBe(N);
    }, 60_000);
});
