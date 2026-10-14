/**
 * `projectFarmBrand` keeps the public projection in agreement with the brand
 * (P6.1, #1810).
 *
 * Driven against a real database, because the two properties that matter are
 * both about rows: that a withdrawal REMOVES one, and that a rename does not
 * leave an orphan answering at the old address. Neither is observable from a
 * mocked client.
 *
 * Run with `INTEGRATION_REQUIRE_DB=1` so a skipped run is red rather than
 * silently green.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { projectFarmBrand } from '@/app-layer/usecases/public-farm-profile';
import { makeRequestContext } from '../helpers/make-context';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });

const REQUIRE_DB = process.env.INTEGRATION_REQUIRE_DB === '1';
if (REQUIRE_DB && !DB_AVAILABLE) {
    throw new Error(
        'INTEGRATION_REQUIRE_DB=1 but no database is reachable. This suite is the proof '
            + 'that a withdrawal removes the public row; skipping it silently would report a '
            + 'pass for the control that matters most.',
    );
}
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const createdTenants: string[] = [];
const createdHandles: string[] = [];

const handle = (): string => {
    const h = `farm-${randomUUID().slice(0, 12)}`;
    createdHandles.push(h);
    return h;
};

describeFn('projectFarmBrand', () => {
    beforeAll(async () => {
        await globalPrisma.$connect();
    });

    afterAll(async () => {
        if (createdHandles.length > 0) {
            await globalPrisma.publicFarmProfile.deleteMany({
                where: { handle: { in: createdHandles } },
            });
        }
        // Tenants STAY: the audit log is immutable by trigger and
        // `AuditLog_tenantId_fkey` is ON DELETE RESTRICT, so a suite that
        // writes through `withTenantDb` cannot delete its own. Ids are
        // per-run UUID fragments.
        void createdTenants;
        await globalPrisma.$disconnect();
    });

    /** A farm with a brand, ready to publish unless told otherwise. */
    async function aFarm(
        brand: Partial<{
            handle: string | null;
            displayName: string | null;
            published: boolean;
            consentedAt: Date | null;
            tagline: string | null;
            about: string | null;
            oblast: string | null;
            crops: string[];
        }> = {},
    ) {
        const tenantId = `pfp-${randomUUID().slice(0, 8)}`;
        createdTenants.push(tenantId);
        await globalPrisma.tenant.create({
            data: { id: tenantId, name: 'Проекция', slug: tenantId },
        });
        const h = brand.handle === undefined ? handle() : brand.handle;
        if (h) createdHandles.push(h);
        await globalPrisma.farmBrand.create({
            data: {
                id: `fb-${randomUUID()}`,
                tenantId,
                handle: h,
                displayName: brand.displayName === undefined ? 'Стопанство Победа' : brand.displayName,
                tagline: brand.tagline ?? 'Зърно и слънчоглед',
                about: brand.about ?? 'Семейно стопанство в Добруджа.',
                oblast: brand.oblast ?? 'Добрич',
                crops: brand.crops ?? ['пшеница', 'слънчоглед'],
                published: brand.published ?? true,
                consentedAt: brand.consentedAt === undefined ? new Date() : brand.consentedAt,
                consentTextVersion: 'v1',
            },
        });
        // ADMIN, because publishing is gated on `assertCanAdmin`.
        return { tenantId, handle: h, ctx: makeRequestContext('ADMIN', { tenantId, userId: `u-${randomUUID()}` }) };
    }

    async function caught(fn: () => Promise<unknown>): Promise<{ code?: string }> {
        try {
            await fn();
        } catch (e) {
            return e as { code?: string };
        }
        throw new Error('expected a refusal, got none');
    }

    it('publishing writes the allowlisted fields, and ONLY those', async () => {
        const farm = await aFarm();

        const result = await projectFarmBrand(farm.ctx);
        expect(result.handle).toBe(farm.handle);
        expect(result.withdrawn).toBe(false);

        const row = await globalPrisma.publicFarmProfile.findUnique({
            where: { handle: farm.handle as string },
        });
        expect(row).not.toBeNull();
        expect(row?.displayName).toBe('Стопанство Победа');
        expect(row?.oblast).toBe('Добрич');
        expect(row?.crops).toEqual(['пшеница', 'слънчоглед']);

        // The columns the row HAS, asserted as a set. A new projection column
        // that nothing populates would show up here rather than being
        // discovered when a page renders `undefined`.
        expect(Object.keys(row as object).sort()).toEqual(
            ['about', 'crops', 'displayName', 'handle', 'indexable', 'oblast', 'projectedAt', 'tagline'].sort(),
        );
    });

    it('indexable stays FALSE on publish — nothing is opted into search by default', async () => {
        const farm = await aFarm();
        await projectFarmBrand(farm.ctx);

        const row = await globalPrisma.publicFarmProfile.findUnique({
            where: { handle: farm.handle as string },
        });
        expect(row?.indexable).toBe(false);
    });

    it('a REFRESH does not reset indexable — the upsert omits it on both branches', async () => {
        // The case that proves the omission in the upsert is deliberate. Once
        // P6.6 can set this, a routine republish must not silently de-index a
        // farm that opted in — and `update: { ...payload }` with `indexable`
        // in the payload would do exactly that.
        const farm = await aFarm();
        await projectFarmBrand(farm.ctx);
        await globalPrisma.publicFarmProfile.update({
            where: { handle: farm.handle as string },
            data: { indexable: true },
        });

        await projectFarmBrand(farm.ctx);

        const row = await globalPrisma.publicFarmProfile.findUnique({
            where: { handle: farm.handle as string },
        });
        expect(row?.indexable).toBe(true);
    });

    it('is idempotent — twice in a row leaves one row', async () => {
        const farm = await aFarm();
        await projectFarmBrand(farm.ctx);
        await projectFarmBrand(farm.ctx);

        const rows = await globalPrisma.publicFarmProfile.findMany({
            where: { handle: farm.handle as string },
        });
        expect(rows).toHaveLength(1);
    });

    it('unpublishing REMOVES the row, which is the 60s claim in P6.10', async () => {
        const farm = await aFarm();
        await projectFarmBrand(farm.ctx);
        expect(
            await globalPrisma.publicFarmProfile.findUnique({ where: { handle: farm.handle as string } }),
        ).not.toBeNull();

        await globalPrisma.farmBrand.updateMany({
            where: { tenantId: farm.tenantId },
            data: { published: false },
        });
        const result = await projectFarmBrand(farm.ctx);

        expect(result.handle).toBeNull();
        expect(result.withdrawn).toBe(true);
        expect(result.removedHandle).toBe(farm.handle);
        expect(
            await globalPrisma.publicFarmProfile.findUnique({ where: { handle: farm.handle as string } }),
        ).toBeNull();
        // The bookkeeping cleared too, so a later republish does not try to
        // delete a row that is already gone and report a removal.
        const brand = await globalPrisma.farmBrand.findFirst({ where: { tenantId: farm.tenantId } });
        expect(brand?.projectedHandle).toBeNull();
    });

    it('a RENAME leaves no orphan answering at the old address', async () => {
        // The defect `projectedHandle` exists to prevent. Without it the old
        // row stays and `/f/[old-handle]` keeps serving a page the farm
        // believes it has moved away from — and P6.7 prints these on paper.
        const farm = await aFarm();
        await projectFarmBrand(farm.ctx);
        const oldHandle = farm.handle as string;

        const newHandle = handle();
        await globalPrisma.farmBrand.updateMany({
            where: { tenantId: farm.tenantId },
            data: { handle: newHandle },
        });
        const result = await projectFarmBrand(farm.ctx);

        expect(result.handle).toBe(newHandle);
        expect(result.removedHandle).toBe(oldHandle);
        expect(await globalPrisma.publicFarmProfile.findUnique({ where: { handle: oldHandle } })).toBeNull();
        expect(await globalPrisma.publicFarmProfile.findUnique({ where: { handle: newHandle } })).not.toBeNull();
    });

    describe('publishing is fail-closed on three preconditions', () => {
        it('no handle', async () => {
            const farm = await aFarm({ handle: null });
            expect((await caught(() => projectFarmBrand(farm.ctx))).code).toBe(
                'FARM_BRAND_HANDLE_REQUIRED',
            );
        });

        it('no display name — the projection column is NOT NULL', async () => {
            const farm = await aFarm({ displayName: null });
            expect((await caught(() => projectFarmBrand(farm.ctx))).code).toBe(
                'FARM_BRAND_DISPLAY_NAME_REQUIRED',
            );
        });

        it('no recorded consent', async () => {
            const farm = await aFarm({ consentedAt: null });
            expect((await caught(() => projectFarmBrand(farm.ctx))).code).toBe(
                'FARM_BRAND_CONSENT_REQUIRED',
            );
        });

        it('POSITIVE CONTROL: a complete brand publishes, so the three above are about their field', async () => {
            // Without this, a writer that refused everything would satisfy all
            // three cases. Measured on #1823's sibling suite: a blanket
            // refusal is indistinguishable from a correct one.
            const farm = await aFarm();
            const result = await projectFarmBrand(farm.ctx);
            expect(result.handle).toBe(farm.handle);
        });

        it('a farm with no brand row at all is a 404, not a 400', async () => {
            const tenantId = `pfp-none-${randomUUID().slice(0, 8)}`;
            createdTenants.push(tenantId);
            await globalPrisma.tenant.create({
                data: { id: tenantId, name: 'Без бранд', slug: tenantId },
            });
            const ctx = makeRequestContext('ADMIN', { tenantId, userId: `u-${randomUUID()}` });

            expect((await caught(() => projectFarmBrand(ctx))).code).toBe('FARM_BRAND_NOT_FOUND');
        });
    });

    it('a non-admin cannot publish', async () => {
        const farm = await aFarm();
        const editor = makeRequestContext('EDITOR', {
            tenantId: farm.tenantId,
            userId: `u-${randomUUID()}`,
        });

        // Publishing makes a farm visible to strangers, so it sits behind
        // `assertCanAdmin` rather than the everyday write gate.
        await expect(projectFarmBrand(editor)).rejects.toThrow();
        expect(
            await globalPrisma.publicFarmProfile.findUnique({ where: { handle: farm.handle as string } }),
        ).toBeNull();
    });
});
