/**
 * The search-engine toggle, end to end — P6.6 (#1815).
 *
 * `PublicFarmProfile.indexable` existed from P6.1 with no source: every row
 * was `false` and a projection refresh deliberately left the column alone,
 * because `FarmBrand` had nothing to read it from. #1850 shipped the column,
 * v12.34.0 contains it, and the allowlist flip from `private` to `published`
 * is what makes the owner's choice actually reach the page.
 *
 * The case that matters is the third one. While the projection PRESERVED the
 * column instead of reproducing it, an owner's choice survived by accident —
 * nothing wrote it, so nothing could overwrite it. Now the brand is the
 * source of truth, so a refresh reproduces the decision; if that reproduction
 * were wrong, turning indexing OFF and then editing a tagline would turn it
 * back on. No seeded projection row can show that: it needs a real edit after
 * a real toggle.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import {
    updateFarmBrand,
    recordFarmBrandConsent,
    claimFarmBrandHandle,
    setFarmBrandPublication,
    readPublicFarmProfile,
    listIndexableFarmHandles,
} from '@/app-layer/usecases/public-farm-profile';
import { makeRequestContext } from '../helpers/make-context';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const describeIfDb = DB_AVAILABLE ? describe : describe.skip;

describeIfDb('the indexable toggle reaches the public page', () => {
    const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
    const handles: string[] = [];
    const tenants: string[] = [];

    beforeAll(async () => {
        await globalPrisma.$connect();
    });

    afterAll(async () => {
        if (handles.length > 0) {
            await globalPrisma.publicFarmProfile.deleteMany({ where: { handle: { in: handles } } });
        }
        if (tenants.length > 0) {
            await globalPrisma.farmBrand.deleteMany({ where: { tenantId: { in: tenants } } });
        }
        await globalPrisma.$disconnect();
    });

    /** A published farm, built only through the product's own operations. */
    async function aPublishedFarm(indexable?: boolean) {
        const tenantId = `idx-${randomUUID().slice(0, 8)}`;
        tenants.push(tenantId);
        await globalPrisma.tenant.create({
            data: { id: tenantId, name: 'Индексиране', slug: tenantId },
        });
        const ctx = makeRequestContext('ADMIN', { tenantId, userId: `u-${randomUUID()}` });
        const handle = `i${randomUUID().slice(0, 8).replace(/-/g, '')}`;
        handles.push(handle);

        await updateFarmBrand(ctx, {
            displayName: 'Стопанство Победа',
            oblast: 'Добрич',
            ...(indexable === undefined ? {} : { indexable }),
        });
        await claimFarmBrandHandle(ctx, handle);
        await recordFarmBrandConsent(ctx, { textVersion: 'v1' });
        await setFarmBrandPublication(ctx, true);
        return { ctx, handle };
    }

    it('defaults to NOT indexable — publishing is not consent to be searchable', async () => {
        const { handle } = await aPublishedFarm();
        expect((await readPublicFarmProfile(handle))?.indexable).toBe(false);
        expect((await listIndexableFarmHandles()).map((r) => r.handle)).not.toContain(handle);
    });

    it('turning it ON reaches the projection and the sitemap', async () => {
        const { ctx, handle } = await aPublishedFarm();
        await updateFarmBrand(ctx, { indexable: true });

        expect((await readPublicFarmProfile(handle))?.indexable).toBe(true);
        expect((await listIndexableFarmHandles()).map((r) => r.handle)).toContain(handle);
    });

    it('a later content edit does NOT silently re-index a farm that opted out', async () => {
        // The regression the old projection comment feared, and the reason the
        // refresh reproduces the brand rather than preserving the column.
        const { ctx, handle } = await aPublishedFarm(true);
        expect((await readPublicFarmProfile(handle))?.indexable).toBe(true);

        await updateFarmBrand(ctx, { indexable: false });
        expect((await readPublicFarmProfile(handle))?.indexable).toBe(false);

        // An edit that says nothing about indexing must leave it off.
        await updateFarmBrand(ctx, { tagline: 'Ново заглавие' });
        const after = await readPublicFarmProfile(handle);
        expect(after?.tagline).toBe('Ново заглавие');
        expect(after?.indexable).toBe(false);
        expect((await listIndexableFarmHandles()).map((r) => r.handle)).not.toContain(handle);
    });

    it('a refresh REPRODUCES the brand rather than preserving a stale projection', async () => {
        // If the projection column were edited out of band, the brand wins on
        // the next refresh. That is the difference between a source of truth
        // and a cache nobody invalidates.
        const { ctx, handle } = await aPublishedFarm(true);
        await globalPrisma.publicFarmProfile.update({
            where: { handle },
            data: { indexable: false },
        });
        expect((await readPublicFarmProfile(handle))?.indexable).toBe(false);

        await updateFarmBrand(ctx, { tagline: 'Докосване' });
        expect((await readPublicFarmProfile(handle))?.indexable).toBe(true);
    });

    it('withdrawing removes the farm from the sitemap entirely', async () => {
        const { ctx, handle } = await aPublishedFarm(true);
        expect((await listIndexableFarmHandles()).map((r) => r.handle)).toContain(handle);

        await setFarmBrandPublication(ctx, false);
        expect(await readPublicFarmProfile(handle)).toBeNull();
        expect((await listIndexableFarmHandles()).map((r) => r.handle)).not.toContain(handle);
    });
});
