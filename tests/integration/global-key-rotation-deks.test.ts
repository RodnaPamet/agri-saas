/**
 * The wrapped tenant DEKs are master-KEK ciphertext too, and leaving them out
 * of the completion signal was a live defect in the first version of this sweep.
 *
 * ── the shape of the bug ──
 *
 * `Tenant.encryptedDek` holds a per-tenant DEK wrapped by `wrapDek`, which is
 * `encryptField` — a `v1:` envelope under the master KEK, unwrapped by
 * `decryptField` with the usual dual-key fallback. But it is in NEITHER
 * encryption manifest, because it is key material rather than a business field.
 *
 * So the sweep's column union never reached it, and
 * `GET /api/admin/key-rotation` would answer `previousKeyRetirable: true` while
 * every DEK was still wrapped under the OLD key. Acting on that signal —
 * removing `DATA_ENCRYPTION_KEY_PREVIOUS` — makes every DEK unwrappable and
 * every `v2:` ciphertext unreadable.
 *
 * It is the same defect this file's sibling exists to fix, one level up: a
 * completion signal that does not cover what the decision depends on.
 *
 * ── the property that makes a re-wrap safe ──
 *
 * The DEK BYTES do not change; only the wrap does. Asserted below by unwrapping
 * before and after and comparing, because "it re-wrapped" and "it re-wrapped
 * the same key" are different claims and only the second one is safe. If the
 * bytes moved, every v2 ciphertext in that tenant would be lost.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID, randomBytes } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { isV1UnderPrimaryKey, _resetKeyCache } from '@/lib/security/encryption';
import { wrapDek, unwrapDek } from '@/lib/security/tenant-keys';
import { rewrapTenantDeks, countUnwrappedDeks } from '@/app-layer/usecases/global-key-rotation';

const raw = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const K_OLD = 'the-outgoing-kek-for-the-dek-test-32+chars'; // pragma: allowlist secret -- test fixture
const K_NEW = 'the-incoming-kek-for-the-dek-test-32+chars'; // pragma: allowlist secret -- test fixture
const K_LOOKUP = 'a-pinned-lookup-key-for-the-dek-test-32++!'; // pragma: allowlist secret -- test fixture

describeFn('the sweep re-wraps tenant DEKs, and the signal counts them', () => {
    const saved = { ...process.env };
    const tenantIds: string[] = [];
    let dekBytes = Buffer.alloc(0);

    function useKeys(primary: string, previous?: string): void {
        process.env.DATA_ENCRYPTION_KEY = primary;
        if (previous === undefined) delete process.env.DATA_ENCRYPTION_KEY_PREVIOUS;
        else process.env.DATA_ENCRYPTION_KEY_PREVIOUS = previous;
        process.env.LOOKUP_HMAC_KEY = K_LOOKUP;
        _resetKeyCache();
    }

    async function dekOf(tenantId: string): Promise<string> {
        const rows = await raw.$queryRawUnsafe<Array<{ encryptedDek: string }>>(
            `SELECT "encryptedDek" FROM "Tenant" WHERE id = $1`,
            tenantId,
        );
        return rows[0].encryptedDek;
    }

    beforeAll(async () => {
        await raw.$connect();
        // A tenant whose DEK is wrapped under the OLD key, as production's are.
        useKeys(K_OLD);
        dekBytes = randomBytes(32);
        const id = `t-dek-${randomUUID()}`;
        await raw.$executeRawUnsafe(
            `INSERT INTO "Tenant"("id","name","slug","encryptedDek","updatedAt")
             VALUES ($1,$2,$3,$4,NOW())`,
            id,
            'DEK rotation subject',
            `t-dek-${randomUUID()}`.slice(0, 40),
            wrapDek(dekBytes),
        );
        tenantIds.push(id);
    });

    afterAll(async () => {
        if (tenantIds.length) {
            await raw.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = ANY($1::text[])`, tenantIds);
        }
        process.env = { ...saved };
        _resetKeyCache();
        await raw.$disconnect();
    });

    it('before the re-wrap, the DEK does not read under the new key', async () => {
        useKeys(K_NEW, K_OLD);
        const wrapped = await dekOf(tenantIds[0]);
        expect(wrapped.startsWith('v1:')).toBe(true);
        expect(isV1UnderPrimaryKey(wrapped)).toBe(false);
        // It still unwraps, via the previous-key fallback — which is what keeps
        // the product working mid-rotation.
        expect(unwrapDek(wrapped).equals(dekBytes)).toBe(true);

        // AND IT IS COUNTED. This is the assertion whose absence was the bug:
        // without it the verdict could say "retirable" with work outstanding.
        expect(await countUnwrappedDeks()).toBeGreaterThanOrEqual(1);
    });

    it('the re-wrap moves it onto the primary key', async () => {
        useKeys(K_NEW, K_OLD);
        const result = await rewrapTenantDeks();
        expect(result.rewrapped).toBeGreaterThanOrEqual(1);
        // NOT `errors === 0`. `rewrapTenantDeks` has no filter — it is the
        // "finish the rotation" pass and in production that is right. Here the
        // shared worker database holds other suites' tenants whose DEKs are
        // wrapped under the DEV FALLBACK key, which cannot be unwrapped under
        // this test's keys. The sweep counting those as errors is CORRECT, and
        // the figure is not about this test. (Same cause as the column sweep's
        // aggregate zeros; I walked into it twice.)
        expect(isV1UnderPrimaryKey(await dekOf(tenantIds[0]))).toBe(true);
    });

    it('THE SAFETY PROPERTY: the DEK bytes are unchanged', async () => {
        useKeys(K_NEW, K_OLD);
        // "it re-wrapped" and "it re-wrapped the SAME key" are different
        // claims, and only the second is safe. If the bytes moved, every v2
        // ciphertext in this tenant would be unreadable — and the wrap would
        // look perfectly healthy.
        expect(unwrapDek(await dekOf(tenantIds[0])).equals(dekBytes)).toBe(true);
    });

    it('DECISIVE: with _PREVIOUS removed the DEK still unwraps', async () => {
        useKeys(K_NEW);
        const wrapped = await dekOf(tenantIds[0]);
        expect(isV1UnderPrimaryKey(wrapped)).toBe(true);
        expect(unwrapDek(wrapped).equals(dekBytes)).toBe(true);
    });

    it('a second re-wrap is a no-op', async () => {
        useKeys(K_NEW, K_OLD);
        const again = await rewrapTenantDeks();
        expect(again.rewrapped).toBe(0);
        expect(again.alreadyPrimary).toBeGreaterThanOrEqual(1);
    });

    it('CONTROL: a DEK the sweep never saw does NOT survive that removal', async () => {
        // Wrapped under the old key and inserted AFTER the re-wrap, standing for
        // a tenant the sweep missed. Without this, every assertion above would
        // also pass on a build where the re-wrap did nothing.
        useKeys(K_OLD);
        const strayBytes = randomBytes(32);
        const id = `t-dek-stray-${randomUUID()}`;
        await raw.$executeRawUnsafe(
            `INSERT INTO "Tenant"("id","name","slug","encryptedDek","updatedAt")
             VALUES ($1,$2,$3,$4,NOW())`,
            id,
            'DEK stray',
            `t-dek-s-${randomUUID()}`.slice(0, 40),
            wrapDek(strayBytes),
        );
        tenantIds.push(id);

        useKeys(K_NEW); // no previous key
        const wrapped = await dekOf(id);
        expect(isV1UnderPrimaryKey(wrapped)).toBe(false);
        expect(() => unwrapDek(wrapped)).toThrow();
        // And the counter SEES it, so the signal is not a constant reading zero.
        expect(await countUnwrappedDeks()).toBeGreaterThanOrEqual(1);
    });
});

describe('the DB gate is visible when it skips', () => {
    it('says so rather than passing silently', () => {
        if (!DB_AVAILABLE) {
            console.warn(
                '[global-key-rotation-deks] SKIPPED — no database. This is the only place the ' +
                    'DEK half of previousKeyRetirable is proved, and it is the half whose ' +
                    'absence would green-light removing the previous key while every DEK still ' +
                    'needed it. INTEGRATION_REQUIRE_DB=1 makes absence a failure.',
            );
        }
        expect(typeof DB_AVAILABLE).toBe('boolean');
    });
});
