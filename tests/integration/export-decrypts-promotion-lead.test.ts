/**
 * Does the Art 15 export hand a person their own `requestMessage`, or its
 * ciphertext envelope?
 *
 * `personal-data-export.ts` runs PRIVILEGED — deliberately, because no session
 * context can read the whole set (its docblock argues this at length, and the
 * argument is sound). It therefore binds no tenant. `PromotionLead` is
 * tenantless, `requestMessage` is in `ENCRYPTED_FIELDS`, and `PromotionLead`
 * is NOT in `GLOBAL_KEK_MODELS` — so that column is encrypted under a
 * PER-TENANT DEK that a tenantless read cannot resolve.
 *
 * The failure mode is silent: `resolveTenantDekPair` cannot find a pair, and
 * the extension passes the `v2:` envelope through with no error and no log.
 * So the only way to tell a working export from a broken one is to look at the
 * bytes.
 *
 * THE IN-CONTEXT READ IS THE POSITIVE CONTROL, and it is the half that makes
 * the other assertion mean anything: if the write never encrypted, both reads
 * would return plaintext and a "no envelope" assertion would pass while
 * proving nothing about the key.
 */
import { randomUUID } from 'crypto';
import { DB_AVAILABLE } from './db-helper';
import { prisma } from '@/lib/prisma';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';
import { companyNameKey } from '@/app-layer/usecases/promotions';
import { exportPersonalData } from '@/app-layer/usecases/personal-data-export';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
const TAG = `pl-${randomUUID().slice(0, 8)}`;
const SECRET = `Искам оферта за ${TAG} — моля, обадете се.`;

let tenantId = '';
let userId = '';
let leadId = '';

const ctx = () => makeRequestContext('OWNER', { userId, tenantId, tenantSlug: `${TAG}-t` });

describeFn('the Art 15 export and the per-tenant DEK', () => {
    beforeAll(async () => {
        if (!DB_AVAILABLE) return;
        const email = `${TAG}@ag.test`;
        userId = (await prisma.user.create({
            data: { email, emailHash: hashForLookup(email), name: 'Lead Person' },
        })).id;
        tenantId = (await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `${TAG}-t` } })).id;
        await prisma.tenantMembership.create({
            data: { tenantId, userId, role: 'OWNER', status: 'ACTIVE' },
        });
        const companyName = `Co ${TAG}`;
        const companyId = (await prisma.company.create({
            data: { name: companyName, nameKey: companyNameKey(companyName) },
        })).id;
        const promotionId = (await prisma.promotion.create({
            data: { companyId, title: `Promo ${TAG}`, category: 'fertilizer' },
        })).id;

        // Written through a TENANT context, which is how the real enquiry path
        // writes it — so the row carries a per-tenant `v2:` envelope.
        leadId = await runInTenantContext(ctx(), async (db) => {
            const row = await db.promotionLead.create({
                data: {
                    promotionId,
                    inquirerTenantId: tenantId,
                    inquirerUserId: userId,
                    requestMessage: SECRET,
                    consentedAt: new Date(),
                },
            });
            return row.id;
        });
    });

    afterAll(async () => {
        if (!DB_AVAILABLE) return;
        for (const sql of [
            `DELETE FROM "PromotionLead" WHERE "inquirerUserId" = $1`,
        ]) await prisma.$executeRawUnsafe(sql, userId).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "Promotion" WHERE "title" = $1`, `Promo ${TAG}`).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "Company" WHERE "name" = $1`, `Co ${TAG}`).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId).catch(() => {});
    });

    it('POSITIVE CONTROL — a tenant-bound read returns the plaintext', async () => {
        const row = await runInTenantContext(ctx(), (db) =>
            db.promotionLead.findUnique({
                where: { id: leadId },
                select: { requestMessage: true },
            }),
        );
        expect(row?.requestMessage).toBe(SECRET);
    });

    it('the UNBOUND read is the mechanism, and it still returns an envelope', async () => {
        /*
         * This assertion is deliberately the OPPOSITE way round from how this
         * test was first written, and the reason is worth keeping.
         *
         * The original reproduced the export's read SHAPE inline — the global
         * client, `where: { inquirerUserId }`, selecting `requestMessage` —
         * and required plaintext. That test could never go green: an unbound
         * read returning the envelope is not the defect, it is the RULE
         * (`resolveTenantDekPair` takes the farm from the audit context, so
         * with none it resolves `NO_DEK_PAIR`). Fixing the export cannot
         * change what a bare unbound read does, so the test was pinned to a
         * mechanism the fix leaves alone.
         *
         * So it is now the NEGATIVE control: it documents the mechanism, and
         * it is what makes the next test mean something — without it, a
         * passing export assertion could be an export that never encrypted.
         */
        const rows = await prisma.promotionLead.findMany({
            where: { inquirerUserId: userId },
            select: { id: true, requestMessage: true },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].requestMessage).toMatch(/^v2:/);
    });

    it('the Art 15 EXPORT returns the plaintext the person wrote', async () => {
        // The subject, not a reproduction of it. Red before #2724's fix
        // (`v2:…` in the exported field), green after.
        const out = await exportPersonalData(userId);
        const leads = out.promotionLeads.rows;
        expect(leads).toHaveLength(1);
        const message = leads[0].requestMessage;
        expect(message).not.toMatch(/^v[12]:/);
        expect(message).toBe(SECRET);
    });
});
