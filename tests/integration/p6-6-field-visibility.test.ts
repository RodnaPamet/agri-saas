/**
 * Hiding a field changes what a VISITOR sees — P6.6 (#1815).
 *
 * The unit test proves `projectionPayload` omits a withheld field. This proves
 * the whole path: the owner sets a flag through the product's own write, the
 * projection refreshes, and `readPublicFarmProfile` — the function the
 * anonymous page calls — stops returning it.
 *
 * Without this, the flag could be stored, the projection never refreshed, and
 * every test still green: the public row would keep serving the old text and
 * the only observer would be a visitor.
 *
 * ## The rule for this file
 *
 * One TENANT and nothing else. Everything after that goes through an exported
 * usecase — no `prisma.farmBrand.*` or `prisma.publicFarmProfile.*` writes. P6
 * has shipped a layer whose caller did not exist four times (#1867, #1884,
 * #1891, #1908).
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import {
    updateFarmBrand,
    claimFarmBrandHandle,
    recordFarmBrandConsent,
    setFarmBrandPublication,
    readPublicFarmProfile,
    readFarmBrandDraft,
} from '@/app-layer/usecases/public-farm-profile';
import { makeRequestContext } from '../helpers/make-context';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const describeIfDb = DB_AVAILABLE ? describe : describe.skip;

describeIfDb('per-field visibility, end to end', () => {
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
    const tenants: string[] = [];
    const handles: string[] = [];

    beforeAll(async () => {
        await prisma.$connect();
    });

    afterAll(async () => {
        if (handles.length > 0) {
            await prisma.publicFarmProfile.deleteMany({ where: { handle: { in: handles } } });
        }
        if (tenants.length > 0) {
            await prisma.farmBrand.deleteMany({ where: { tenantId: { in: tenants } } });
        }
        await prisma.$disconnect();
    });

    async function aPublishedFarm() {
        const tenantId = `vis-${randomUUID().slice(0, 8)}`;
        tenants.push(tenantId);
        await prisma.tenant.create({ data: { id: tenantId, name: 'Видимост', slug: tenantId } });
        const ctx = makeRequestContext('ADMIN', { tenantId, userId: `u-${randomUUID()}` });

        const handle = `v${randomUUID().slice(0, 8).replace(/-/g, '')}`;
        handles.push(handle);
        await updateFarmBrand(ctx, {
            displayName: 'Стопанство Победа',
            tagline: 'Зърно от Добруджа',
            about: 'Семейно стопанство.',
            oblast: 'Добрич',
            crops: ['пшеница'],
        });
        await claimFarmBrandHandle(ctx, handle);
        await recordFarmBrandConsent(ctx, { textVersion: 'v2' });
        await setFarmBrandPublication(ctx, true);
        return { ctx, handle };
    }

    it('withholds a field from the public page, and gives it back', async () => {
        const { ctx, handle } = await aPublishedFarm();

        const before = await readPublicFarmProfile(handle);
        expect(before?.about).toBe('Семейно стопанство.');
        expect(before?.tagline).toBe('Зърно от Добруджа');

        // ── hide it, through the product's own write ──
        await updateFarmBrand(ctx, { hideAbout: true });

        const hidden = await readPublicFarmProfile(handle);
        // Absent in the shape an UNSET field has, so a visitor cannot tell a
        // hidden field from one that was never filled in.
        expect(hidden?.about).toBeNull();
        // And only that field.
        expect(hidden?.tagline).toBe('Зърно от Добруджа');
        expect(hidden?.oblast).toBe('Добрич');
        expect(hidden?.crops).toEqual(['пшеница']);

        // ── the text SURVIVED, which is the whole ruling ──
        const draft = await readFarmBrandDraft(ctx);
        expect(draft?.about).toBe('Семейно стопанство.');
        expect(draft?.hideAbout).toBe(true);

        // ── and showing it again needs no retyping ──
        await updateFarmBrand(ctx, { hideAbout: false });
        const shown = await readPublicFarmProfile(handle);
        expect(shown?.about).toBe('Семейно стопанство.');
    });

    it('hides the crop list as an empty list, not as a null', async () => {
        // `crops` has no null form — an empty array IS its cleared state, and
        // the projection column is `String[]` NOT NULL.
        const { ctx, handle } = await aPublishedFarm();
        await updateFarmBrand(ctx, { hideCrops: true });

        const seen = await readPublicFarmProfile(handle);
        expect(seen?.crops).toEqual([]);
        expect((await readFarmBrandDraft(ctx))?.crops).toEqual(['пшеница']);
    });

    it('leaves the flags untouched when a save does not mention them', async () => {
        // The three-state contract. An autosaving editor sends only what is
        // being edited, so saving a tagline must not un-hide a paragraph.
        const { ctx, handle } = await aPublishedFarm();
        await updateFarmBrand(ctx, { hideAbout: true, hideOblast: true });

        await updateFarmBrand(ctx, { tagline: 'Ново лозунгче' });

        const draft = await readFarmBrandDraft(ctx);
        expect(draft?.hideAbout).toBe(true);
        expect(draft?.hideOblast).toBe(true);
        const seen = await readPublicFarmProfile(handle);
        expect(seen?.tagline).toBe('Ново лозунгче');
        expect(seen?.about).toBeNull();
        expect(seen?.oblast).toBeNull();
    });
});
