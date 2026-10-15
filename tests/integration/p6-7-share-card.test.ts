/**
 * The share card is reachable, and refuses to put a dead address on paper —
 * P6.7 (#1816).
 *
 * ## The rule this file inherits
 *
 * It creates a TENANT and nothing else, and every step after that goes
 * through an exported usecase. No `prisma.farmBrand.*` writes.
 *
 * That rule is the whole value, and `p6-6-publish-flow-is-reachable.test.ts`
 * records why: five phases of public-profile work shipped behind a
 * precondition nothing satisfied, and every suite was green because each
 * created the row it needed with `prisma.farmBrand.create`. The fixtures
 * created exactly what the product could not.
 *
 * P6 has now hit that same shape three times — a writer with no caller
 * (#1867), a usecase with no UI (#1884), a write with no read (#1891) — so a
 * new operation gets this treatment rather than a fixture.
 *
 * ## Why the refusals are the bulk of it
 *
 * The happy path is one assertion. The refusals are four, because this is the
 * first operation in the product whose output cannot be withdrawn: a card
 * printed from an incomplete draft points at a 404 for as long as the sheet
 * exists.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import zlib from 'node:zlib';

import {
    buildFarmShareCard,
    updateFarmBrand,
    claimFarmBrandHandle,
    recordFarmBrandConsent,
    setFarmBrandPublication,
} from '@/app-layer/usecases/public-farm-profile';
import { generateFarmShareCardPdf } from '@/app-layer/reports/pdf/farm-share-card';
import { qrMatrix } from '@/lib/qr/matrix';
import { makeRequestContext } from '../helpers/make-context';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const describeIfDb = DB_AVAILABLE ? describe : describe.skip;
const MM = 72 / 25.4;

describeIfDb('the A6 share card, through the product’s own operations', () => {
    const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
    const handles: string[] = [];
    const tenants: string[] = [];

    beforeAll(async () => {
        await globalPrisma.$connect();
    });

    afterAll(async () => {
        // Handles live in a GLOBAL unique namespace, so a suite that leaves
        // brands behind reserves names for every future run — which is how a
        // fixture passes exactly once. Tenants stay: `AuditLog` references
        // them ON DELETE RESTRICT and this flow writes audit rows.
        if (handles.length > 0) {
            await globalPrisma.publicFarmProfile.deleteMany({ where: { handle: { in: handles } } });
        }
        if (tenants.length > 0) {
            await globalPrisma.farmBrand.deleteMany({ where: { tenantId: { in: tenants } } });
        }
        await globalPrisma.$disconnect();
    });

    /** A tenant and an ADMIN context. The ONLY fixture this file may create. */
    async function aTenant() {
        const tenantId = `shc-${randomUUID().slice(0, 8)}`;
        tenants.push(tenantId);
        await globalPrisma.tenant.create({
            data: { id: tenantId, name: 'Визитка', slug: tenantId },
        });
        return makeRequestContext('ADMIN', { tenantId, userId: `u-${randomUUID()}` });
    }

    /** Per-run, because the namespace is global and the rows persist. */
    const aHandle = () => `s${randomUUID().slice(0, 8).replace(/-/g, '')}`;

    async function refusal(fn: () => Promise<unknown>): Promise<string | undefined> {
        try {
            await fn();
        } catch (e) {
            return (e as { code?: string }).code;
        }
        throw new Error('expected a refusal, got none');
    }

    it('a published farm can print a card that points at its own page', async () => {
        const ctx = await aTenant();
        const handle = aHandle();
        handles.push(handle);

        await updateFarmBrand(ctx, {
            displayName: 'Зеленчукова градина „Победа“',
            tagline: 'Домати и краставици от Пловдивско',
        });
        await claimFarmBrandHandle(ctx, handle);
        await recordFarmBrandConsent(ctx, { textVersion: 'v1' });
        await setFarmBrandPublication(ctx, true);

        const card = await buildFarmShareCard(ctx);
        expect(card.handle).toBe(handle);
        expect(card.displayName).toBe('Зеленчукова градина „Победа“');
        // The url ENDS with the handle on the `/f/` path — the one scheme the
        // #1623 rulings left standing, and the same builder every other share
        // surface uses.
        expect(card.url).toMatch(new RegExp(`/f/${handle}$`));

        // And it renders. Doing this here rather than only in the unit suite
        // is the point of the file: the data comes from the database through
        // the real usecase, so a column that is nullable in practice but not
        // in the generator's type would fail here.
        const doc = generateFarmShareCardPdf(card);
        const bytes = await new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            doc.on('data', (c: Buffer) => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);
            doc.end();
        });
        const raw = bytes.toString('latin1');
        expect(raw).toContain(`/MediaBox [0 0 ${(105 * MM).toFixed(2)} ${(148 * MM).toFixed(2)}]`);
        expect((raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(1);

        // The QR encodes the url this farm actually got, counted off the
        // drawn rectangles rather than trusted.
        let content = '';
        for (let i = 0; ; ) {
            const s = bytes.indexOf('stream', i);
            if (s === -1) break;
            let start = s + 6;
            if (bytes[start] === 0x0d) start++;
            if (bytes[start] === 0x0a) start++;
            const e = bytes.indexOf('endstream', start);
            if (e === -1) break;
            try {
                content += zlib.inflateSync(bytes.subarray(start, e)).toString('latin1');
            } catch {
                /* a raw font program — skip */
            }
            i = e + 9;
        }
        expect((content.match(/\bre\b/g) ?? []).length).toBe(qrMatrix(card.url).runs.length + 1);
    });

    it('refuses a farm that has no public profile at all', async () => {
        const ctx = await aTenant();
        expect(await refusal(() => buildFarmShareCard(ctx))).toBe('FARM_BRAND_NOT_FOUND');
    });

    it('refuses before an address has been chosen — there is nothing to encode', async () => {
        const ctx = await aTenant();
        // A draft with content but no handle. `updateFarmBrand` is what
        // creates the row, which is the layer #1867 was missing.
        await updateFarmBrand(ctx, { tagline: 'Само лозунг' });
        expect(await refusal(() => buildFarmShareCard(ctx))).toBe('FARM_BRAND_HANDLE_REQUIRED');
    });

    it('refuses before a public name — the card would be a QR and nothing else', async () => {
        const ctx = await aTenant();
        const handle = aHandle();
        await updateFarmBrand(ctx, { tagline: 'Без име' });
        await claimFarmBrandHandle(ctx, handle);
        expect(await refusal(() => buildFarmShareCard(ctx))).toBe(
            'FARM_BRAND_DISPLAY_NAME_REQUIRED',
        );
    });

    it('refuses an unpublished farm, because paper outlives state', async () => {
        const ctx = await aTenant();
        const handle = aHandle();
        await updateFarmBrand(ctx, { displayName: 'Непубликувано' });
        await claimFarmBrandHandle(ctx, handle);
        // Everything a card needs EXCEPT publication — so this is the refusal
        // that is specific to printing. `/f/{handle}` does not answer yet, and
        // a printed sheet cannot be withdrawn when it turns out not to.
        expect(await refusal(() => buildFarmShareCard(ctx))).toBe('FARM_BRAND_NOT_PUBLISHED');
    });

    it('refuses again once a farm withdraws its page', async () => {
        const ctx = await aTenant();
        const handle = aHandle();
        handles.push(handle);
        await updateFarmBrand(ctx, { displayName: 'Оттеглено' });
        await claimFarmBrandHandle(ctx, handle);
        await recordFarmBrandConsent(ctx, { textVersion: 'v1' });
        await setFarmBrandPublication(ctx, true);
        expect((await buildFarmShareCard(ctx)).handle).toBe(handle);

        // The direction that matters more than the first refusal: a farm that
        // takes its page down must stop being printable. A precondition read
        // only at the moment of first publishing would keep serving cards.
        await setFarmBrandPublication(ctx, false);
        expect(await refusal(() => buildFarmShareCard(ctx))).toBe('FARM_BRAND_NOT_PUBLISHED');
    });
});
