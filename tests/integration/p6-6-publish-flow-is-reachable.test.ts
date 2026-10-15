/**
 * The whole publish flow, through the product's own operations only — #1867.
 *
 * ## Why this suite exists
 *
 * Five phases of public-profile work shipped behind a precondition nothing
 * satisfied. Measured on main before the brand editor: `farmBrand.create`,
 * `farmBrand.upsert` and `farmBrand.createMany` appeared NOWHERE in `src/`,
 * `scripts/` or `prisma/`, and `prisma/seed.ts` never mentioned the model. No
 * farm could create a brand row, set a `displayName`, or record consent — so
 * `/f/{handle}` served nobody, the sitemap was correctly empty, and both
 * brand routes refused `FARM_BRAND_NOT_FOUND` on every call.
 *
 * Every suite was green. Each tested its own layer honestly, and each created
 * the row it needed with `prisma.farmBrand.create` — including the one I
 * wrote for the handle claim. The fixtures created exactly what the product
 * could not, so no test ever asked whether a farmer could reach any of it.
 *
 * ## The rule for this file
 *
 * It creates a TENANT and nothing else. Tenants come from onboarding, which
 * is out of scope here. Everything after that must go through an exported
 * usecase — no `prisma.farmBrand.*`, no `prisma.publicFarmProfile.*` writes.
 * If a step in the flow has no implementation, this suite fails where a
 * fixture would have papered over it.
 *
 * That is the whole value, and it is why the assertions look obvious. A test
 * that seeds its own brand row cannot fail for the reason this one exists to
 * catch.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import {
    readFarmBrandDraft,
    updateFarmBrand,
    recordFarmBrandConsent,
    claimFarmBrandHandle,
    setFarmBrandPublication,
    readPublicFarmProfile,
} from '@/app-layer/usecases/public-farm-profile';
import { makeRequestContext } from '../helpers/make-context';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const describeIfDb = DB_AVAILABLE ? describe : describe.skip;

describeIfDb('the publish flow is reachable without fixtures', () => {
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
            // Brands are deleted because the handle namespace is global and
            // @unique — a suite that leaves them behind reserves names for
            // every future run. The tenants stay: `AuditLog` references them
            // ON DELETE RESTRICT and this flow writes audit rows.
            await globalPrisma.farmBrand.deleteMany({ where: { tenantId: { in: tenants } } });
        }
        await globalPrisma.$disconnect();
    });

    /** A tenant and an ADMIN context. The ONLY fixture this file may create. */
    async function aTenant() {
        const tenantId = `rch-${randomUUID().slice(0, 8)}`;
        tenants.push(tenantId);
        await globalPrisma.tenant.create({
            data: { id: tenantId, name: 'Достижимост', slug: tenantId },
        });
        return makeRequestContext('ADMIN', { tenantId, userId: `u-${randomUUID()}` });
    }

    const aHandle = () => `r${randomUUID().slice(0, 8).replace(/-/g, '')}`;

    async function caught(fn: () => Promise<unknown>): Promise<{ code?: string }> {
        try {
            await fn();
        } catch (e) {
            return e as { code?: string };
        }
        throw new Error('expected a refusal, got none');
    }

    it('a farm with nothing can reach a published public page', async () => {
        const ctx = await aTenant();
        const handle = aHandle();
        handles.push(handle);

        // 1. The draft. This CREATES the brand row — the step that did not
        //    exist, and the reason nothing downstream was reachable.
        const saved = await updateFarmBrand(ctx, {
            displayName: 'Стопанство Победа',
            tagline: 'Зърно и слънчоглед от Добруджа',
            about: 'Семейно стопанство, трето поколение.',
            oblast: 'Добрич',
            crops: ['пшеница', 'слънчоглед'],
        });
        expect(saved.created).toBe(true);
        expect(saved.reprojected).toBe(false);

        // 2. The public address.
        const claimed = await claimFarmBrandHandle(ctx, handle);
        expect(claimed.handle).toBe(handle);

        // 3. Consent, which `setFarmBrandPublication` refuses without.
        const consent = await recordFarmBrandConsent(ctx, { textVersion: 'v1' });
        expect(consent.textVersion).toBe('v1');
        expect(consent.consentedAt).toBeInstanceOf(Date);

        // 4. Publish.
        const published = await setFarmBrandPublication(ctx, true);
        expect(published.handle).toBe(handle);

        // 5. The page a stranger loads. This is the assertion the whole
        //    suite is for: an anonymous read, with no context at all.
        const page = await readPublicFarmProfile(handle);
        expect(page).not.toBeNull();
        expect(page?.displayName).toBe('Стопанство Победа');
        expect(page?.oblast).toBe('Добрич');
        expect(page?.crops).toEqual(['пшеница', 'слънчоглед']);
    });

    it('reads the draft back, so an editor can render what already exists', async () => {
        // The four write endpoints shipped without a read (#1884), so nothing
        // could show an owner what they had: the form would open blank over
        // existing content. This asserts the editor's whole view, because a
        // read that returned only the content fields would still leave the
        // handle, the consent record and the publish state invisible.
        const ctx = await aTenant();
        const handle = aHandle();
        handles.push(handle);

        expect(await readFarmBrandDraft(ctx)).toBeNull();

        await updateFarmBrand(ctx, { displayName: 'Стопанство Победа', oblast: 'Добрич', crops: ['пшеница'] });
        await claimFarmBrandHandle(ctx, handle);
        await recordFarmBrandConsent(ctx, { textVersion: 'v1' });
        await setFarmBrandPublication(ctx, true);

        const draft = await readFarmBrandDraft(ctx);
        expect(draft).toMatchObject({
            handle,
            displayName: 'Стопанство Победа',
            oblast: 'Добрич',
            crops: ['пшеница'],
            published: true,
            consentTextVersion: 'v1',
            indexable: false,
        });
        expect(draft?.consentedAt).toBeInstanceOf(Date);
        expect(draft?.publishedAt).toBeInstanceOf(Date);
    });

    it('does not leak the projection writer’s bookkeeping', async () => {
        // `projectedHandle` exists so a rename can remove the stale public
        // row. It is meaningless to an editor and is a record of what the
        // farm used to be called.
        const ctx = await aTenant();
        await updateFarmBrand(ctx, { displayName: 'Име' });
        const draft = await readFarmBrandDraft(ctx);
        expect(draft).not.toBeNull();
        expect(Object.keys(draft!)).not.toContain('projectedHandle');
        expect(Object.keys(draft!)).not.toContain('tenantId');
    });

    it('refuses to publish a draft with no consent, and says which precondition', async () => {
        // The precondition has to be REAL as well as reachable. If consent
        // were silently defaulted, the step above would pass for the wrong
        // reason and nobody would be agreeing to anything.
        const ctx = await aTenant();
        const handle = aHandle();
        await updateFarmBrand(ctx, { displayName: 'Без съгласие' });
        await claimFarmBrandHandle(ctx, handle);

        const err = await caught(() => setFarmBrandPublication(ctx, true));
        expect(err.code).toBe('FARM_BRAND_CONSENT_REQUIRED');
        expect(await readPublicFarmProfile(handle)).toBeNull();
    });

    it('refuses to publish a draft with no name', async () => {
        const ctx = await aTenant();
        const handle = aHandle();
        // A draft with no displayName is legal to SAVE — an owner fills this
        // in over several sittings — and illegal to publish.
        await updateFarmBrand(ctx, { tagline: 'Само заглавие' });
        await claimFarmBrandHandle(ctx, handle);
        await recordFarmBrandConsent(ctx, { textVersion: 'v1' });

        const err = await caught(() => setFarmBrandPublication(ctx, true));
        expect(err.code).toBe('FARM_BRAND_DISPLAY_NAME_REQUIRED');
    });

    it('an edit to a PUBLISHED farm reaches the public page', async () => {
        const ctx = await aTenant();
        const handle = aHandle();
        handles.push(handle);
        await updateFarmBrand(ctx, { displayName: 'Първо име', oblast: 'Добрич' });
        await claimFarmBrandHandle(ctx, handle);
        await recordFarmBrandConsent(ctx, { textVersion: 'v1' });
        await setFarmBrandPublication(ctx, true);

        const edited = await updateFarmBrand(ctx, { displayName: 'Второ име' });
        // Without the re-projection the save would succeed and change nothing
        // a visitor can see — the failure mode an owner reports as "my edit
        // did not work".
        expect(edited.reprojected).toBe(true);
        expect((await readPublicFarmProfile(handle))?.displayName).toBe('Второ име');
    });

    it('leaves absent fields alone and clears explicit nulls', async () => {
        const ctx = await aTenant();
        await updateFarmBrand(ctx, { displayName: 'Име', tagline: 'Заглавие', about: 'Текст' });

        // `tagline` not mentioned — an autosave of one field must not wipe
        // the others, which is the difference between undefined and null.
        await updateFarmBrand(ctx, { about: null });

        const row = await globalPrisma.farmBrand.findFirst({
            where: { tenantId: ctx.tenantId },
            select: { displayName: true, tagline: true, about: true },
        });
        expect(row?.displayName).toBe('Име');
        expect(row?.tagline).toBe('Заглавие');
        expect(row?.about).toBeNull();
    });
});
